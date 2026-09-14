/**
 * P10.37：Requirement CLI。
 *
 *   npm run requirement:analyze -- --text "..." [--id R001] [--context-debug] [--json]
 *   npm run requirement:analyze -- --file xxx.md
 *   npm run requirement:show -- --id R001
 *   npm run requirement:review -- --id R001 --decision APPROVE --reviewer user
 *   npm run requirement:diff -- --from v1 --to v2
 *   npm run requirement:doctor
 *   npm run requirement:benchmark
 */

import fs from "fs-extra";
import path from "node:path";
import { parseArgs } from "node:util";
import { analyzeRequirement, REQUIREMENT_ANALYZER_PROMPT_VERSION } from "../src/requirements/pipeline.js";
import { createRequirementSource } from "../src/requirements/analyzer.js";
import { appendRequirementModel, appendRequirementReview, loadRequirementStore, runRequirementDoctor, computeTestDesignReadiness } from "../src/requirements/engine.js";
import { createRequirementReview } from "../src/requirements/knowledge.js";
import { GOLD_REQUIREMENTS, splitGoldRequirements, runRequirementBenchmark } from "../src/requirements/gold.js";
import { writeSafeJsonFile } from "../src/core/safe-file-writer.js";

const ROOT = process.cwd();
const REPORT_DIR = "reports/requirements";

const parsed = parseArgs({
  options: {
    text: { type: "string" },
    file: { type: "string" },
    id: { type: "string" },
    decision: { type: "string" },
    reviewer: { type: "string", default: "cli" },
    "from": { type: "string" },
    to: { type: "string" },
    json: { type: "boolean", default: false },
    "context-debug": { type: "boolean", default: false }
  },
  allowPositionals: true,
  strict: false
});
const opts = parsed.values as Record<string, string | boolean | undefined>;
const command = parsed.positionals[0] ?? "analyze";

function str(v: string | boolean | undefined): string | undefined { return typeof v === "string" ? v : undefined; }

async function loadContextReceipt(taskHint?: string) {
  const currentState = fs.pathExistsSync("configs/ai-context/current-state.json") ? fs.readJsonSync("configs/ai-context/current-state.json") : undefined;
  const registry = fs.pathExistsSync("configs/ai-context/document-registry.yaml") ? "document-registry.yaml" : undefined;
  return {
    taskType: "REQUIREMENT_ANALYSIS",
    contextFingerprint: `req-${currentState?.sourceCommit ?? "unknown"}-${registry ?? "none"}`,
    mandatoryDocs: ["CURRENT_PROJECT_STATE", "PROJECT_ARCHITECTURE", "OPERATION_MANUAL", "KNOWLEDGE_PROMOTION_POLICY", "RISK_POLICY"],
    businessDomains: [taskHint ?? ""].filter(Boolean),
    currentPhase: String(currentState?.currentPhase ?? "P10"),
    riskPolicyVersion: "risk-policy (deterministic)",
    operationManualVersion: "operation-manual-store"
  };
}

async function analyze() {
  let raw = str(opts.text);
  if (!raw && str(opts.file)) {
    raw = await fs.readFile(path.join(ROOT, str(opts.file)!), "utf8");
  }
  if (!raw) { console.error("需 --text 或 --file"); process.exit(1); }
  const id = str(opts.id) ?? `R${Date.now().toString().slice(-6)}`;
  const contextReceipt = await loadContextReceipt();
  const model = analyzeRequirement({
    sourceId: id,
    title: `Requirement ${id}`,
    rawContent: raw,
    requirementId: id,
    contextReceipt
  });
  model.promptVersion = REQUIREMENT_ANALYZER_PROMPT_VERSION;
  await appendRequirementModel(ROOT, model);
  await fs.ensureDir(path.join(REPORT_DIR, id));
  await writeSafeJsonFile(path.join(REPORT_DIR, id, "analysis.json"), model);
  const readiness = computeTestDesignReadiness(model);
  if (opts.json) {
    console.log(JSON.stringify({ model, readiness }, null, 2));
  } else {
    console.log(`Requirement ${id} analyzed (status=${model.status})`);
    console.log(`  changes: ${model.businessChanges.map((c) => c.type).join(", ")}`);
    console.log(`  actors: ${model.actors.map((a) => a.name).join(", ")}`);
    console.log(`  rules: ${model.businessRules.length} | AC: ${model.acceptanceCriteria.length} | ambiguities: ${model.ambiguities.length} | assumptions: ${model.assumptions.length}`);
    console.log(`  risks: ${model.risks.map((r) => `${r.domain}:${r.level}`).join(", ")}`);
    console.log(`  readiness: ${readiness.status} | prompt=${model.promptVersion}`);
    console.log(`  openQuestions: ${model.openQuestions.map((q) => `[${q.priority}] ${q.question}`).join(" | ")}`);
    console.log(`  contextFingerprint: ${contextReceipt.contextFingerprint}`);
    console.log(`  报告: ${REPORT_DIR}/${id}/analysis.json`);
  }
}

async function show() {
  const id = str(opts.id);
  const store = await loadRequirementStore(ROOT);
  const model = store.models.find((m) => m.requirementId === id);
  if (!model) { console.error(`未找到 ${id}`); process.exit(1); }
  console.log(JSON.stringify(model, null, 2));
}

async function review() {
  const id = str(opts.id);
  if (!id) { console.error("需 --id"); process.exit(1); }
  const decision = str(opts.decision) ?? "APPROVE";
  const reviewer = str(opts.reviewer) ?? "cli";
  const store = await loadRequirementStore(ROOT);
  const idx = store.models.findIndex((m) => m.requirementId === id);
  if (idx < 0) { console.error(`未找到 ${id}`); process.exit(1); }
  const model = store.models[idx];
  const review = createRequirementReview({ requirementId: id, reviewer, decision: decision as never, reason: `CLI ${decision}` });
  await appendRequirementReview(ROOT, review);
  // APPROVE → 更新 status + proposals
  if (decision === "APPROVE") {
    model.status = "APPROVED";
    const { generateProposalsForModel } = await import("../src/requirements/knowledge.js");
    const proposals = generateProposalsForModel(model, true);
    await fs.ensureDir(path.join(REPORT_DIR, id));
    await writeSafeJsonFile(path.join(REPORT_DIR, id, "proposals.json"), proposals);
    await appendRequirementModel(ROOT, model);
    console.log(`${id} APPROVED; proposals: ${proposals.length}`);
  } else {
    console.log(`${id} ${decision} recorded`);
  }
}

async function diff() {
  const from = str(opts.from) ?? "1.0";
  const to = str(opts.to) ?? "2.0";
  const store = await loadRequirementStore(ROOT);
  const { diffRequirements } = await import("../src/requirements/engine.js");
  const v1 = store.models.find((m) => m.version === from);
  const v2 = store.models.find((m) => m.version === to);
  if (!v1 || !v2) { console.error("需要 v1/v2 版本 model"); process.exit(1); }
  const d = diffRequirements(v1, v2);
  console.log(JSON.stringify(d, null, 2));
}

async function doctor() {
  const store = await loadRequirementStore(ROOT);
  const report = runRequirementDoctor(store);
  await writeSafeJsonFile(path.join(REPORT_DIR, "doctor.json"), report);
  console.log(`requirement:doctor pass=${report.pass}`);
  report.issues.forEach((i) => console.log(`  - ${i}`));
}

async function benchmark() {
  const { calibration, holdout } = splitGoldRequirements(GOLD_REQUIREMENTS);
  const run = (set: typeof calibration) => runRequirementBenchmark(set.map((g) => ({
    id: g.id,
    gold: g,
    model: analyzeRequirement({ sourceId: g.id, title: g.id, rawContent: g.description })
  })));
  const cal = run(calibration);
  const hold = run(holdout);
  const out = { generatedAt: new Date().toISOString(), calibration: cal, holdout: hold };
  await writeSafeJsonFile(path.join(REPORT_DIR, "benchmark.json"), out);
  console.log(`Requirement Benchmark (${calibration.length} cal / ${holdout.length} hold):`);
  console.log(`  cal  changeRecall=${cal.criticalChangeRecall} ruleRecall=${cal.businessRuleRecall} acRecall=${cal.acceptanceCriteriaRecall} actor=${cal.actorAccuracy} amb=${cal.ambiguityRecall} secMiss=${cal.criticalSecurityMiss} unsupported=${cal.unsupportedInferenceRate}`);
  console.log(`  hold changeRecall=${hold.criticalChangeRecall} ruleRecall=${hold.businessRuleRecall} acRecall=${hold.acceptanceCriteriaRecall} actor=${hold.actorAccuracy} amb=${hold.ambiguityRecall} secMiss=${hold.criticalSecurityMiss} unsupported=${hold.unsupportedInferenceRate}`);
}

switch (command) {
  case "analyze": await analyze(); break;
  case "show": await show(); break;
  case "review": await review(); break;
  case "diff": await diff(); break;
  case "doctor": await doctor(); break;
  case "benchmark": await benchmark(); break;
  default: console.log(`未知命令 ${command}`); break;
}
