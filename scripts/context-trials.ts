/**
 * P9.37-40：Real Task Trials + Cold-Start Simulation + Drift Trial + Token/Size Analysis。
 *
 * P9.37：5 个真实历史任务——只给 task description，看生成的 Context Pack：
 *   该读的是否都有？危险规则是否漏？无关文档是否太多？
 * P9.38：Cold-Start——只给 repository + 用户任务 + AI_START_HERE，验证 deterministic expected fields。
 * P9.39：Drift——STALE_SUMMARY / STATE_CONFLICT / SOURCE_CONFLICT 检测。
 * P9.40：Token/Size——OLD（全量 docs）vs NEW（pack mandatory/recommended）。
 *
 * 输出：reports/context/trials.json / trials.md
 */

import fs from "fs-extra";
import path from "node:path";
import { loadDocumentRegistry, loadSourceOfTruth } from "../src/context/registry.js";
import { loadTaskProfiles, classifyContextTask } from "../src/context/task-context.js";
import { buildContextPack } from "../src/context/pack.js";
import { runContextDoctor } from "../src/context/benchmark-doctor.js";
import { GOLD_TASK_DATASET, contextRecall, contextPrecision, missingContextSeverities } from "../src/context/quality.js";
import type { DocumentRegistryFile } from "../src/context/types.js";
import { writeSafeJsonFile } from "../src/core/safe-file-writer.js";

const ROOT = process.cwd();
const OUT = "reports/context";

/** P9.37：5 个真实历史任务（只给 task description）。 */
const REAL_TRIALS = [
  { id: "trial_A", description: "修复 dropdown option corruption（withdraw 链选择器 58 个 option 语义名被当前选中链污染）" },
  { id: "trial_B", description: "修复 promotion fan-out（同 sourceRun 重复写 verificationHistory 8 次）" },
  { id: "trial_C", description: "修改 DSL semantic completeness（READY 不等于语义完整，需 Intent Requirement Graph）" },
  { id: "trial_D", description: "修改 Risk Gate（gatePlanRisk 词边界误判 enabled/enable）" },
  { id: "trial_E", description: "修改 benchmark metric（assertion recall 虚高/越界口径）" }
];

/** P9.40：token/size——OLD=全部 active docs，NEW=pack mandatory+recommended。 */
function sizeOf(p: string): number {
  const full = path.join(ROOT, p);
  if (!fs.pathExistsSync(full)) return 0;
  return fs.statSync(full).size;
}

async function main(): Promise<void> {
  await fs.ensureDir(OUT);
  const registry = await loadDocumentRegistry(ROOT);
  const profiles = await loadTaskProfiles(ROOT);
  const sourceOfTruth = await loadSourceOfTruth(ROOT);
  const currentState = fs.pathExistsSync("configs/ai-context/current-state.json") ? fs.readJsonSync("configs/ai-context/current-state.json") : undefined;

  // ---------- P9.37：real task trials ----------
  const trials = [];
  for (const trial of REAL_TRIALS) {
    const task = classifyContextTask({ text: trial.description });
    const pack = buildContextPack({ task, registry, profiles, currentState, sourceOfTruthDomains: sourceOfTruth.entries.map((e) => e.domain), rootDir: ROOT, sourceCommit: "e67a93d", currentPhase: currentState?.currentPhase });
    const gold = GOLD_TASK_DATASET.find((g) => g.taskType === task.primaryTask);
    const recall = gold ? contextRecall(pack, gold) : { recall: 0, misses: [] };
    const precision = gold ? contextPrecision(pack, gold) : { precision: 0, irrelevant: [] };
    const severities = gold ? missingContextSeverities(pack, gold) : [];
    const critical = severities.filter((s) => s.severity === "CRITICAL");
    trials.push({
      id: trial.id,
      description: trial.description,
      classified: task.primaryTask,
      confidence: task.confidence,
      mandatory: pack.mandatorySources,
      recommended: pack.recommendedSources,
      excluded: pack.excludedSources.slice(0, 5),
      contextRecall: gold ? recall.recall : 0,
      contextPrecision: gold ? precision.precision : 0,
      criticalMisses: critical.map((c) => c.documentId),
      warnings: pack.warnings,
      estimatedTokens: pack.budget.estimatedTokens
    });
  }
  const trialPass = trials.every((t) => t.criticalMisses.length === 0);

  // ---------- P9.38：cold-start simulation ----------
  const coldStartTask = classifyContextTask({ text: "修复 dropdown option 建模污染" });
  const coldPack = buildContextPack({ task: coldStartTask, registry, profiles, currentState, sourceOfTruthDomains: sourceOfTruth.entries.map((e) => e.domain), rootDir: ROOT, sourceCommit: "e67a93d", currentPhase: currentState?.currentPhase });
  const coldStartAnswers = {
    currentPhase: coldPack.currentPhase,
    architectureGoal: currentState?.currentGoal,
    sourceOfTruthCount: sourceOfTruth.entries.length,
    doNotTouchCount: (currentState?.doNotTouchWithoutReview ?? []).length,
    mandatorySources: coldPack.mandatorySources,
    latestBenchmark: currentState?.latestBenchmark,
    recommendedCommands: (currentState?.importantCommands ?? []).slice(0, 5),
    fingerprint: coldPack.fingerprint
  };
  const coldStartPass = Boolean(coldStartAnswers.currentPhase && coldStartAnswers.architectureGoal && coldStartAnswers.sourceOfTruthCount > 0 && coldStartAnswers.mandatorySources.length > 0);

  // ---------- P9.39：drift trials ----------
  // (a) STALE_SUMMARY：summary 的 sourceHash 与当前内容不一致
  const driftSummaryPath = "docs/ai-context/benchmark-contract.md";
  const driftSummary = fs.pathExistsSync(driftSummaryPath)
    ? runContextDoctor({ registry, rootDir: ROOT, knownDocumentIds: registry.documents.map((d) => d.documentId), summaryRegistry: [{ path: driftSummaryPath, sourceHash: "stale-hash-0000", sourceVersion: "1" }], benchmarkOk: true })
    : { staleSummaries: [] };
  const staleSummaryDetected = driftSummary.staleSummaries.length > 0;
  // (b) STATE_CONFLICT：CURRENT_STATE 说 P8，HANDOFF 说 P9
  const { detectStateHandoffConflict } = await import("../src/context/conflicts.js");
  const stateConflict = detectStateHandoffConflict("P8", "P9");
  const stateConflictDetected = stateConflict.length > 0;
  // (c) SOURCE_CONFLICT：两个 primary source-of-truth
  const { detectSourceOfTruthConflicts } = await import("../src/context/conflicts.js");
  const conflictReg = { version: "1", documents: [
    { documentId: "X1", path: "docs/x1.md", type: "SCHEMA", version: "1", status: "ACTIVE", priority: 1, scope: ["PAGE_MODELING"], sourceOfTruthFor: ["page_model_schema"] },
    { documentId: "X2", path: "docs/x2.md", type: "POLICY", version: "1", status: "ACTIVE", priority: 1, scope: ["PAGE_MODELING"], sourceOfTruthFor: ["page_model_schema"] }
  ] } as unknown as DocumentRegistryFile;
  const sourceConflict = detectSourceOfTruthConflicts(conflictReg);
  const sourceConflictDetected = sourceConflict.length > 0;

  // ---------- P9.40：token/size analysis ----------
  const activeDocs = registry.documents.filter((d) => d.status === "ACTIVE" || d.status === "REFERENCE");
  const allBytes = activeDocs.reduce((s, d) => s + sizeOf(d.path), 0);
  const packBytesSum = trials.reduce((s, t) => s + t.estimatedTokens * 3.5, 0);
  const packAvgTokens = trials.length ? Math.round(trials.reduce((s, t) => s + t.estimatedTokens, 0) / trials.length) : 0;
  const reduction = allBytes > 0 ? Math.round((1 - packBytesSum / trials.length / allBytes) * 1000) / 1000 : 0;

  const report = {
    generatedAt: new Date().toISOString(),
    p9_37_realTrials: { trials, verdict: trialPass ? "PASS" : "FAIL" },
    p9_38_coldStart: { answers: coldStartAnswers, pass: coldStartPass },
    p9_39_drift: {
      staleSummaryDetected,
      stateConflictDetected,
      sourceConflictDetected,
      allDetected: staleSummaryDetected && stateConflictDetected && sourceConflictDetected
    },
    p9_40_tokenAnalysis: {
      oldAllActiveDocsBytes: allBytes,
      oldAllActiveDocsTokens: Math.round(allBytes / 3.5),
      newAveragePackTokens: packAvgTokens,
      newAveragePackSources: trials.length ? Math.round((trials.reduce((s, t) => s + t.mandatory.length + t.recommended.length, 0) / trials.length) * 100) / 100 : 0,
      tokenReductionRatio: reduction,
      note: "目标不是越小越好；目标是高 Context Recall 同时显著减少无关 context"
    }
  };

  await writeSafeJsonFile(path.join(OUT, "trials.json"), report);

  const md = [
    "# Context Trials（P9.37-40）",
    "",
    `- generatedAt: ${report.generatedAt}`,
    "",
    "## P9.37 Real Task Trials",
    "",
    ...trials.map((t) => [
      `### ${t.id}: ${t.description.slice(0, 40)}...`,
      `- classified: ${t.classified} (conf=${t.confidence})`,
      `- mandatory: ${t.mandatory.join(", ")}`,
      `- recall=${t.contextRecall} precision=${t.contextPrecision} | criticalMisses=${JSON.stringify(t.criticalMisses)}`,
      `- warnings: ${t.warnings.join("; ") || "(none)"}`,
      ""
    ]).flat(),
    `- verdict: ${report.p9_37_realTrials.verdict}`,
    "",
    "## P9.38 Cold-Start Simulation",
    "",
    `- phase: ${coldStartAnswers.currentPhase} | goal: ${String(coldStartAnswers.architectureGoal ?? "").slice(0, 50)}`,
    `- SoT entries: ${coldStartAnswers.sourceOfTruthCount} | doNotTouch: ${coldStartAnswers.doNotTouchCount}`,
    `- mandatory: ${coldStartAnswers.mandatorySources.join(", ")}`,
    `- fingerprint: ${coldStartAnswers.fingerprint}`,
    `- pass: ${coldStartPass}`,
    "",
    "## P9.39 Drift Trials",
    "",
    `- STALE_SUMMARY detected: ${staleSummaryDetected}`,
    `- STATE_CONFLICT detected: ${stateConflictDetected}`,
    `- SOURCE_CONFLICT detected: ${sourceConflictDetected}`,
    `- all detected: ${report.p9_39_drift.allDetected}`,
    "",
    "## P9.40 Token / Size Analysis",
    "",
    `- OLD（全量 active docs）: ${report.p9_40_tokenAnalysis.oldAllActiveDocsBytes} bytes ≈ ${report.p9_40_tokenAnalysis.oldAllActiveDocsTokens} tokens`,
    `- NEW（pack avg）: ${report.p9_40_tokenAnalysis.newAveragePackTokens} tokens / ${report.p9_40_tokenAnalysis.newAveragePackSources} sources`,
    `- token reduction: ${Math.round(report.p9_40_tokenAnalysis.tokenReductionRatio * 100)}%`,
    ""
  ].join("\n");
  await fs.writeFile(path.join(OUT, "trials.md"), md, "utf8");

  console.log(`P9.37 trials verdict: ${report.p9_37_realTrials.verdict}`);
  console.log(`P9.38 cold-start: ${coldStartPass ? "PASS" : "FAIL"}`);
  console.log(`P9.39 drift all detected: ${report.p9_39_drift.allDetected}`);
  console.log(`P9.40 OLD tokens=${report.p9_40_tokenAnalysis.oldAllActiveDocsTokens} NEW=${report.p9_40_tokenAnalysis.newAveragePackTokens} reduction=${Math.round(report.p9_40_tokenAnalysis.tokenReductionRatio * 100)}%`);
  console.log(`输出: ${OUT}/trials.json / trials.md`);
}

await main();
