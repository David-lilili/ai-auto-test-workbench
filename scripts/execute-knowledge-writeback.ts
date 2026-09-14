import fs from "fs-extra";
import path from "node:path";
import { parseArgs } from "node:util";
import { dispatchKnowledgeWritebacks, type WritebackDispatchResult } from "../src/core/knowledge-writeback-dispatcher.js";
import { writeSafeJsonFile, writeSafeTextFile } from "../src/core/safe-file-writer.js";

/**
 * P5.4-P5.6：knowledge:writeback —— 统一 writeback 分发。
 * audit（只读）→ 本命令（按 caps 真实写回）→ verify 校验。
 *
 * 用法:
 *   npx tsx scripts/execute-knowledge-writeback.ts --dry-run        # 只看 plan
 *   npx tsx scripts/execute-knowledge-writeback.ts                  # 真实执行（默认 caps）
 *   npx tsx scripts/execute-knowledge-writeback.ts --cap-locator 2 --cap-control-type 5 --cap-interaction 3
 */

const options = parseArgs({
  args: process.argv.slice(2),
  options: {
    project: { type: "string", default: "demo" },
    "dry-run": { type: "boolean", default: false },
    "cap-locator": { type: "string", default: "5" },
    "cap-control-type": { type: "string", default: "10" },
    "cap-interaction": { type: "string", default: "10" }
  }
});

const rootDir = path.resolve(".");
const project = options.values.project;
const caps = {
  locator: Number(options.values["cap-locator"]),
  controlType: Number(options.values["cap-control-type"]),
  interaction: Number(options.values["cap-interaction"])
};

async function main(): Promise<void> {
  const result = await dispatchKnowledgeWritebacks({ rootDir, project, caps, dryRun: options.values["dry-run"] });

  console.log("=== Knowledge Writeback Dispatch ===\n");
  console.log(`project: ${project} | dryRun: ${result.dryRun}`);
  console.log(`证据来源: sink=${result.collected.sink} proposals=${result.collected.proposals} normalization=${result.collected.normalization} exploration_runs=${result.collected.explorationRuns}`);
  console.log(`UNIQUE CANDIDATES: ${result.uniqueCandidates}`);
  console.log(`DECISIONS: ${JSON.stringify(result.decisions)}`);
  console.log(`CAPS USED: ${JSON.stringify(result.capped)}`);

  console.log("\nLOCATOR 修复型配对（semantic target 粒度）:");
  for (const t of result.locatorTargets) {
    console.log(`  ${t.decision === "AUTO_PROMOTE" ? "✓" : "·"} ${t.targetId} | success=${t.successCount} | new=${t.newLocator} | ${t.reason}`);
  }

  console.log("\nPLANNED ACTIONS:");
  for (const p of result.planned) {
    console.log(`  ${p.knowledgeType.padEnd(14)} ${p.action.padEnd(24)} ${p.pageId} | ${p.targetId} → ${p.observedValue}`);
    if (p.reason) console.log(`      ${p.reason}`);
  }

  if (result.dryRun) {
    console.log("\n[dry-run] 未写回。加 --dry-run 移除（真实执行）前请审阅 plan。");
    await writeSafeJsonFile(path.join(rootDir, "reports/knowledge-writeback-plan.json"), summarize(result));
    await writeSafeTextFile(path.join(rootDir, "reports/knowledge-writeback-plan.md"), renderPlan(result));
    console.log("plan: reports/knowledge-writeback-plan.json / .md");
    return;
  }

  const appliedOk = result.applied.filter((a) => a.action !== "error" && a.action !== "skipped_unmatched");
  const errors = result.applied.filter((a) => a.action === "error" || a.action === "skipped_unmatched");
  console.log(`\nAPPLIED: ${appliedOk.length}/${result.planned.length}`);
  for (const a of result.applied) {
    console.log(`  ${a.action === "error" ? "✗" : "✓"} ${a.knowledgeType} | ${a.elementId} | ${a.action}${a.reason ? ` (${a.reason})` : ""}`);
    if (a.detail?.backupPath) console.log(`      backup: ${a.detail.backupPath}`);
  }
  if (errors.length) {
    console.log("\n错误/跳过明细:");
    errors.forEach((e) => console.log(`  ${e.knowledgeType} | ${e.targetId} | ${e.reason}`));
  }

  await writeSafeJsonFile(path.join(rootDir, "reports/knowledge-writeback-results.json"), summarize(result));
  await writeSafeTextFile(path.join(rootDir, "reports/knowledge-writeback-results.md"), renderResult(result));
  console.log("\n报告: reports/knowledge-writeback-results.json / .md");
}

function summarize(result: WritebackDispatchResult): Record<string, unknown> {
  return {
    project: result.project,
    dryRun: result.dryRun,
    collected: result.collected,
    uniqueCandidates: result.uniqueCandidates,
    decisions: result.decisions,
    locatorTargets: result.locatorTargets,
    capped: result.capped,
    planned: result.planned,
    applied: result.applied,
    generatedAt: new Date().toISOString()
  };
}

function renderPlan(result: WritebackDispatchResult): string {
  return [
    "# Knowledge Writeback Plan (dry-run)",
    "",
    `- project: ${result.project}`,
    `- unique candidates: ${result.uniqueCandidates}`,
    `- decisions: ${JSON.stringify(result.decisions)}`,
    `- caps: ${JSON.stringify(result.capped)}`,
    "",
    "## 计划写回",
    "",
    ...result.planned.map((p) => `- [${p.knowledgeType}] ${p.action}: ${p.pageId} | ${p.targetId} → ${p.observedValue} — ${p.reason}`),
    ""
  ].join("\n");
}

function renderResult(result: WritebackDispatchResult): string {
  return [
    "# Knowledge Writeback Results",
    "",
    `- project: ${result.project}`,
    `- planned: ${result.planned.length}`,
    `- applied: ${result.applied.length}`,
    "",
    "## LOCATOR targets",
    "",
    ...result.locatorTargets.map((t) => `- ${t.decision} ${t.targetId} (success=${t.successCount}) → ${t.newLocator}`),
    "",
    "## Applied",
    "",
    ...result.applied.map((a) => `- ${a.action === "error" ? "ERROR" : "OK"} [${a.knowledgeType}] ${a.elementId} ${a.action} — ${a.reason}${a.detail?.backupPath ? ` (backup: ${a.detail.backupPath})` : ""}`),
    ""
  ].join("\n");
}

await main();
