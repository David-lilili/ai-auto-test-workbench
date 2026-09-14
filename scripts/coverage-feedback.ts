import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { parseArgs } from "node:util";
import { buildCoverageSnapshot, type CoverageSnapshot, type CoverageStatus } from "../src/core/exploration-coverage.js";
import { buildExplorationGaps } from "../src/core/exploration-gaps.js";

/**
 * P5.12：knowledge:coverage-feedback —— 写回后 Coverage 反馈闭环（只读）。
 *
 * 对比「写回前备份」与「当前 Page Model」两套 coverage：
 *   - 元素状态分布变化（UNCERTAIN/UNEXPLORED → KNOWN/OBSERVED/VERIFIED）
 *   - controlType 归一化覆盖（unknown → 已解析）
 *   - Exploration Gaps 减少（gap 是确定性推导，写回后应为 0 变化或下降）
 *   - 交互/依赖覆盖变化
 *
 * 用法:
 *   npx tsx scripts/coverage-feedback.ts [--project demo] [--before-backup <path>] [--out reports]
 *   --before-backup 缺省时自动取 storage/page-models/backup-*-pre-locator-promotion-*.json 最新一个
 */

const options = parseArgs({
  args: process.argv.slice(2),
  options: {
    project: { type: "string", default: "demo" },
    "before-backup": { type: "string" },
    out: { type: "string", default: "reports" }
  }
});

const rootDir = path.resolve(".");
const project = options.values.project;

async function pickBeforeBackup(): Promise<string | undefined> {
  if (options.values["before-backup"]) {
    const p = path.resolve(options.values["before-backup"]);
    return fs.pathExistsSync(p) ? p : undefined;
  }
  const backupDir = path.join(rootDir, "storage", "page-models");
  if (!fs.pathExistsSync(backupDir)) return undefined;
  const candidates = (await fs.readdir(backupDir))
    .filter((f) => f.startsWith(`backup-${project}-`) && f.endsWith(".json"))
    .sort();
  // 取最近一个 pre-locator-promotion（即最近一次 writeback 批次的写回前状态）
  const preLocator = [...candidates].reverse().find((f) => f.includes("pre-locator-promotion"));
  return preLocator ? path.join(backupDir, preLocator) : undefined;
}

/** 在独立临时目录构建「备份版」project store，避免动真实 store。 */
async function snapshotFromBackup(backupPath: string): Promise<CoverageSnapshot | undefined> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cov-before-"));
  const storeDir = path.join(tmp, "storage", "page-models");
  await fs.ensureDir(storeDir);
  await fs.copyFile(backupPath, path.join(storeDir, `${project}.json`));
  try {
    return await buildCoverageSnapshot(tmp, project);
  } catch (error) {
    console.warn(`备份快照失败: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

function statusDistribution(snapshot: CoverageSnapshot): Record<CoverageStatus, number> {
  return snapshot.projectSummary.elementsByStatus as Record<CoverageStatus, number>;
}

function countUnknownControlType(snapshot: CoverageSnapshot): number {
  let unknown = 0;
  for (const page of snapshot.pages) {
    for (const element of page.elements) {
      if (!element.controlType || element.controlType === "unknown") unknown++;
    }
  }
  return unknown;
}

async function main(): Promise<void> {
  const beforeBackup = await pickBeforeBackup();
  const after = await buildCoverageSnapshot(rootDir, project);
  const afterGaps = await buildExplorationGaps(rootDir, project, after);

  if (!beforeBackup) {
    console.log("未找到写回前备份，仅输出当前 coverage。");
    console.log(`当前元素状态: ${JSON.stringify(statusDistribution(after))}`);
    console.log(`当前 gaps: ${afterGaps.totalGaps}`);
    return;
  }
  const before = await snapshotFromBackup(beforeBackup);
  if (!before) {
    console.log("备份快照不可用，仅输出当前 coverage。");
    console.log(`当前元素状态: ${JSON.stringify(statusDistribution(after))}`);
    return;
  }
  const beforeGaps = await buildExplorationGaps(rootDir, project, before);

  const beforeDist = statusDistribution(before);
  const afterDist = statusDistribution(after);
  const statuses = Object.keys({ ...beforeDist, ...afterDist }) as CoverageStatus[];
  const delta: Record<string, number> = {};
  let totalDelta = 0;
  for (const status of statuses) {
    const d = (afterDist[status] ?? 0) - (beforeDist[status] ?? 0);
    delta[status] = d;
    totalDelta += d;
  }

  const beforeUnknown = countUnknownControlType(before);
  const afterUnknown = countUnknownControlType(after);
  const controlTypeFilled = beforeUnknown - afterUnknown;

  const gapDelta = afterGaps.totalGaps - beforeGaps.totalGaps;
  const verifiedDelta = afterDist.VERIFIED - beforeDist.VERIFIED;
  const observedDelta = afterDist.OBSERVED - beforeDist.OBSERVED;
  const knownDelta = afterDist.KNOWN - beforeDist.KNOWN;

  const lines = [
    "# Knowledge Flywheel Coverage Feedback",
    "",
    `- project: ${project}`,
    `- before backup: ${path.relative(rootDir, beforeBackup).replace(/\\/g, "/")}`,
    `- generatedAt: ${new Date().toISOString()}`,
    "",
    "## 元素状态分布（before → after → delta）",
    "",
    "| status | before | after | delta |",
    "| --- | --- | --- | --- |",
    ...statuses.map((s) => `| ${s} | ${beforeDist[s] ?? 0} | ${afterDist[s] ?? 0} | ${(afterDist[s] ?? 0) - (beforeDist[s] ?? 0)} |`),
    "",
    `- controlType unknown: ${beforeUnknown} → ${afterUnknown}（补标 ${controlTypeFilled}）`,
    `- Exploration Gaps: ${beforeGaps.totalGaps} → ${afterGaps.totalGaps}（delta ${gapDelta >= 0 ? "+" : ""}${gapDelta}）`,
    "",
    "## 结论",
    "",
    ...buildConclusion({ controlTypeFilled, gapDelta, verifiedDelta, observedDelta, knownDelta }),
    ""
  ];

  await fs.ensureDir(path.join(rootDir, options.values.out));
  await fs.writeFile(path.join(rootDir, options.values.out, "coverage-feedback.md"), lines.join("\n"), "utf8");
  await fs.writeJson(path.join(rootDir, options.values.out, "coverage-feedback.json"), {
    project,
    beforeBackup: path.relative(rootDir, beforeBackup).replace(/\\/g, "/"),
    before: { elementsByStatus: beforeDist, unknownControlType: beforeUnknown, gaps: beforeGaps.totalGaps },
    after: { elementsByStatus: afterDist, unknownControlType: afterUnknown, gaps: afterGaps.totalGaps },
    delta: { ...delta, controlTypeFilled, gapDelta, verifiedDelta, observedDelta, knownDelta }
  }, { spaces: 2 });

  console.log(lines.join("\n"));
  console.log(`报告: ${options.values.out}/coverage-feedback.md / .json`);
}

function buildConclusion(input: { controlTypeFilled: number; gapDelta: number; verifiedDelta: number; observedDelta: number; knownDelta: number }): string[] {
  const lines: string[] = [];
  if (input.controlTypeFilled > 0) lines.push(`- ✓ 归一化写回补标 ${input.controlTypeFilled} 个元素 controlType，缩小 unknown 面。`);
  if (input.gapDelta < 0) lines.push(`- ✓ Exploration Gaps 减少 ${-input.gapDelta} 个（更少不确定性待探索）。`);
  else if (input.gapDelta === 0) lines.push(`- · Exploration Gaps 无变化（写回未新增待探索项，符合预期）。`);
  else lines.push(`- ⚠ Exploration Gaps 增加 ${input.gapDelta} 个——检查是否引入了新的不确定项。`);
  if (input.verifiedDelta > 0) lines.push(`- ✓ VERIFIED 增加 ${input.verifiedDelta}（执行验证证据沉淀）。`);
  if (input.observedDelta > 0) lines.push(`- ✓ OBSERVED 增加 ${input.observedDelta}（观察证据沉淀）。`);
  if (input.knownDelta > 0) lines.push(`- ✓ KNOWN 增加 ${input.knownDelta}（建模完备度提升）。`);
  return lines;
}

await main();
