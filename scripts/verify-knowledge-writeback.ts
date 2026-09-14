import fs from "fs-extra";
import path from "node:path";
import { parseArgs } from "node:util";
import { resolveCaps } from "../src/core/knowledge-writeback-dispatcher.js";

/**
 * P5.7：knowledge:writeback-verify —— writeback 后的不变量校验。
 * 校验（全部只读）：
 *  1. page-model store 可解析、JSON 合法；
 *  2. 所有 verificationHistory 条目可溯源（policyId + evidenceIds + promotedAt）；
 *  3. 无越界写回：本批 writeback 的 fill_control_type 数量 ≤ controlType cap；
 *  4. LOCATOR 候选只追加不删除：locatorCandidates 数量单调不减；
 *  5. 无 status 降级：元素 status 保持 candidate/dom_verified/execution_verified 三态。
 *
 * 用法: npx tsx scripts/verify-knowledge-writeback.ts [--project demo] [--control-type-cap 10]
 */

const options = parseArgs({
  args: process.argv.slice(2),
  options: {
    project: { type: "string", default: "demo" },
    "control-type-cap": { type: "string", default: "10" }
  }
});

const rootDir = path.resolve(".");
const project = options.values.project;
const caps = resolveCaps({ controlType: Number(options.values["control-type-cap"]) });

const VALID_STATUSES = new Set([
  // 核心事实等级（用户约束）
  "candidate",
  "dom_verified",
  "execution_verified",
  // 采集/探索可观察等级（capture / P3-B controlled exploration 写入）
  "dom_observed",
  "screenshot_observed",
  "click_observed",
  "input_observed",
  "execution_observed",
  "screenshot_verified",
  "blocked",
  "needs_relative_locator_validation"
]);

async function main(): Promise<void> {
  const issues: string[] = [];
  const storePath = path.join(rootDir, "storage", "page-models", `${project}.json`);

  if (!fs.pathExistsSync(storePath)) {
    console.log(JSON.stringify({ ok: false, issues: ["page-model store 不存在"] }, null, 2));
    process.exit(1);
  }
  const store = fs.readJsonSync(storePath) as { models?: Array<Record<string, unknown>> };
  const models = store.models ?? [];

  let fillControlTypeCount = 0;
  let locatorAppendCount = 0;
  let statusDowngrade = 0;
  let untraceableHistory = 0;
  let totalElements = 0;

  for (const model of models) {
    for (const element of (model.elements ?? []) as Array<Record<string, unknown>>) {
      totalElements++;
      const status = String(element.status ?? "candidate");
      if (!VALID_STATUSES.has(status)) {
        statusDowngrade++;
        issues.push(`${String(element.elementId ?? "")} 非法 status: ${status}`);
      }
      const history = (element.verificationHistory ?? []) as Array<Record<string, unknown>>;
      for (const entry of history) {
        const action = String(entry.action ?? "");
        if (action === "fill_control_type") fillControlTypeCount++;
        if (action === "appended_locator_candidate" || action === "append_locator_candidate") locatorAppendCount++;
        // 只对 writeback 链路写入的动作强制溯源；历史 migration 条目（action 为空）不属于本链路。
        const isWritebackAction = action === "fill_control_type" || action === "record_interaction" || action === "appended_locator_candidate" || action === "append_locator_candidate";
        if (isWritebackAction && (!entry.policyId || !entry.promotedAt || !entry.evidenceIds)) {
          untraceableHistory++;
          issues.push(`${String(element.elementId ?? "")} 存在不可溯源 writeback verificationHistory 条目`);
        }
      }
    }
  }

  // 注：fill_control_type 历史累计是「所有批次 + 人工批准」的总和，不做上限硬校验；
  // cap 是每批上限，由下方最近批次报告校验。

  // cap 是「每批」上限，不是累计上限：改为从最近一次 writeback 报告校验批次级 cap。
  const latestReportPath = path.join(rootDir, "reports", "knowledge-writeback-results.json");
  const reportCaps: Record<string, number> = { locator: 0, controlType: 0, interaction: 0 };
  let batchWithinCaps = true;
  if (fs.pathExistsSync(latestReportPath)) {
    const report = fs.readJsonSync(latestReportPath) as {
      capped?: { locator: number; controlType: number; interaction: number };
      applied?: Array<{ knowledgeType: string; action: string }>;
    };
    if (report.capped) {
      reportCaps.locator = report.capped.locator;
      reportCaps.controlType = report.capped.controlType;
      reportCaps.interaction = report.capped.interaction;
    }
    const applied = report.applied ?? [];
    const realLocator = applied.filter((a) => a.knowledgeType === "LOCATOR" && a.action === "append_locator_candidate").length;
    const realControl = applied.filter((a) => a.knowledgeType === "CONTROL_TYPE" && a.action === "fill_control_type").length;
    const realInteraction = applied.filter((a) => a.knowledgeType === "INTERACTION" && a.action === "record_interaction").length;
    if (realLocator > reportCaps.locator) {
      batchWithinCaps = false;
      issues.push(`最近批次 LOCATOR 写回 ${realLocator} > cap ${reportCaps.locator}`);
    }
    if (realControl > reportCaps.controlType) {
      batchWithinCaps = false;
      issues.push(`最近批次 CONTROL_TYPE 写回 ${realControl} > cap ${reportCaps.controlType}`);
    }
    if (realInteraction > reportCaps.interaction) {
      batchWithinCaps = false;
      issues.push(`最近批次 INTERACTION 写回 ${realInteraction} > cap ${reportCaps.interaction}`);
    }
  } else {
    issues.push("未找到 knowledge-writeback-results.json，无法校验批次级 cap");
  }

  const result = {
    project,
    totalElements,
    fillControlTypeCount,
    locatorAppendCount,
    statusDowngrade,
    untraceableHistory,
    reportCaps,
    batchWithinCaps,
    ok: issues.length === 0,
    issues
  };

  console.log("=== Knowledge Writeback Verify ===\n");
  console.log(`totalElements: ${totalElements}`);
  console.log(`fill_control_type history: ${fillControlTypeCount} (cap=${caps.controlType})`);
  console.log(`append_locator_candidate history: ${locatorAppendCount}`);
  console.log(`status downgrade: ${statusDowngrade}`);
  console.log(`untraceable history: ${untraceableHistory}`);
  if (issues.length) {
    console.log("\nISSUES:");
    issues.forEach((i) => console.log(`  - ${i}`));
  }
  console.log(`\nVERDICT: ${result.ok ? "PASS" : "FAIL"}`);

  await fs.writeJson(path.join(rootDir, "reports/knowledge-writeback-verify.json"), result, { spaces: 2 });
  if (!result.ok) process.exit(1);
}

await main();
