/**
 * P14.80：Impact / Regression CLI。
 *
 *   npm run impact:analyze -- --requirement R001 --v2 "<文本>"
 *   npm run impact:show -- --requirement R001
 *   npm run impact:doctor
 *   npm run regression:plan -- --requirement R001 [--env UAT]
 *   npm run regression:show -- --plan RP-001
 *   npm run regression:review -- --plan RP-001 --action approve|reject [--asset TA-xxx] [--reviewer david]
 *   npm run regression:execute -- --plan RP-001 [--env UAT]
 *   npm run regression:history
 *   npm run regression:doctor
 */

import fs from "fs-extra";
import path from "node:path";
import { parseArgs } from "node:util";
import { TestAssetStore } from "../src/test-assets/store.js";
import { loadRequirementStore } from "../src/requirements/engine.js";
import { analyzeRequirement } from "../src/requirements/pipeline.js";
import { loadKnowledgeStore } from "../src/requirements/knowledge-store.js";
import { loadCandidateStore } from "../src/test-design/engine.js";
import { buildRequirementChangeSet, buildPageChangeSet, classifyChangeNature } from "../src/test-assets/impact/change-event.js";
import { buildRelationshipGraph, analyzeChangeImpact, type ImpactGraph } from "../src/test-assets/impact/graph.js";
import { buildRegressionPlan, reviewRegressionPlan, newPlanVersion, type RegressionPlan } from "../src/test-assets/impact/regression-plan.js";
import { runRegressionPlan, runImpactDoctor, summarizeRuns } from "../src/test-assets/impact/regression-runner.js";
import { TestAssetExecutionService } from "../src/test-assets/execution-service.js";
import { writeSafeJsonFile } from "../src/core/safe-file-writer.js";

const ROOT = process.cwd();
const REPORT_DIR = "reports/test-assets/impact";
const PLAN_DIR = "storage/test-assets/regression-plans";

const parsed = parseArgs({
  options: {
    requirement: { type: "string" },
    v2: { type: "string" },
    plan: { type: "string" },
    action: { type: "string" },
    asset: { type: "string" },
    reviewer: { type: "string", default: "david" },
    env: { type: "string", default: "UAT" },
    json: { type: "boolean", default: false }
  },
  allowPositionals: true,
  strict: false
});
const opts = parsed.values as Record<string, string | boolean | undefined>;
const command = parsed.positionals[0] ?? "analyze";
const str = (v: string | boolean | undefined): string | undefined => (typeof v === "string" ? v : undefined);

async function loadBaseData() {
  const assetStore = new TestAssetStore(ROOT);
  const assetsFile = await assetStore.load();
  const reqStore = await loadRequirementStore(ROOT);
  const kb = await loadKnowledgeStore(ROOT);
  const candidateStore = await loadCandidateStore(ROOT);
  const assets = assetsFile.assets;
  const criticalFactIds = new Set<string>();
  for (const entry of candidateStore.testDesignInputs) {
    const { buildCoverageObligations } = await import("../src/test-design/obligations.js");
    const obls = buildCoverageObligations(entry.input as never);
    obls.filter((o) => o.criticality === "CRITICAL").forEach((o) => criticalFactIds.add(o.source));
  }
  return { assetStore, assetsFile, assets, reqStore, kb, candidateStore, criticalFactIds: [...criticalFactIds] };
}

function buildGraph(base: Awaited<ReturnType<typeof loadBaseData>>): ImpactGraph {
  const requirements = base.reqStore.models.map((m) => ({
    requirementId: m.requirementId,
    factIds: [...m.businessRules.map((r) => r.ruleId), ...m.acceptanceCriteria.map((a) => a.acId)],
    capabilityIds: m.affectedCapabilities.map((c) => c.capabilityId)
  }));
  const knowledge = base.kb.knowledge.map((k) => ({ knowledgeId: k.knowledgeId, requirementRefs: k.requirementRefs, capability: k.scope?.capability }));
  return buildRelationshipGraph({
    requirements,
    knowledge,
    capabilities: [],
    assets: base.assets.map((a) => ({
      testAssetId: a.testAssetId,
      requirementRefs: a.requirementRefs,
      businessRuleRefs: a.businessRuleRefs,
      capabilityRefs: a.capabilityRefs,
      knowledgeRefs: a.knowledgeRefs,
      pages: a.executionPath.pages,
      manualRuleRefs: a.manualRuleRefs
    })),
    pages: [],
    manualRules: []
  });
}

async function analyze() {
  const reqId = str(opts.requirement);
  const v2Text = str(opts.v2);
  if (!reqId || !v2Text) { console.error("需 --requirement --v2"); process.exit(1); }
  const base = await loadBaseData();
  const model = base.reqStore.models.find((m) => m.requirementId === reqId);
  if (!model) { console.error(`未找到 ${reqId}`); process.exit(1); }
  const v2 = analyzeRequirement({ sourceId: reqId, title: reqId, rawContent: v2Text });
  const changeSet = buildRequirementChangeSet({
    requirementId: reqId,
    v1: {
      version: model.version,
      rules: model.businessRules.map((r) => ({ ruleId: r.ruleId, statement: r.statement, condition: r.condition, effect: r.effect })),
      acs: model.acceptanceCriteria.map((a) => ({ acId: a.acId, statement: a.statement })),
      actors: model.actors.map((a) => a.name),
      states: model.states.map((s) => `${s.entity}:${s.fromState}->${s.toState}`),
      dependencies: model.dependencies.map((d) => `${d.sourceConcept}-${d.relation}-${d.targetConcept}`),
      security: model.securityImplications.map((s) => s.description),
      constraints: model.constraints.map((c) => `${c.field} ${c.operator ?? ""} ${c.value ?? ""}`)
    },
    v2: {
      version: "v2",
      rules: v2.businessRules.map((r) => ({ ruleId: r.ruleId, statement: r.statement, condition: r.condition, effect: r.effect })),
      acs: v2.acceptanceCriteria.map((a) => ({ acId: a.acId, statement: a.statement })),
      actors: v2.actors.map((a) => a.name),
      states: v2.states.map((s) => `${s.entity}:${s.fromState}->${s.toState}`),
      dependencies: v2.dependencies.map((d) => `${d.sourceConcept}-${d.relation}-${d.targetConcept}`),
      security: v2.securityImplications.map((s) => s.description),
      constraints: v2.constraints.map((c) => `${c.field} ${c.operator ?? ""} ${c.value ?? ""}`)
    }
  });
  const graph = buildGraph(base);
  const result = analyzeChangeImpact({
    graph,
    requirementChange: changeSet,
    assets: base.assets.map((a) => ({ testAssetId: a.testAssetId, status: a.status, risk: a.risk, knowledgeRefs: a.knowledgeRefs, businessRuleRefs: a.businessRuleRefs, acceptanceCriterionRefs: a.acceptanceCriterionRefs, capabilityRefs: a.capabilityRefs, pages: a.executionPath.pages, manualRuleRefs: a.manualRuleRefs })),
    criticalFactIds: base.criticalFactIds
  });
  const payload = { changeSet, impact: result, generatedAt: new Date().toISOString() };
  await fs.ensureDir(REPORT_DIR);
  await writeSafeJsonFile(path.join(REPORT_DIR, `${reqId}-impact.json`), payload);
  console.log(JSON.stringify({
    changedRules: changeSet.changedRules,
    addedRules: changeSet.addedRules,
    removedRules: changeSet.removedRules,
    addedAC: changeSet.addedAC,
    securityChanges: changeSet.securityChanges,
    impactedAssets: result.candidates.map((c) => ({ asset: c.testAssetId, type: c.impactType, reason: c.reasonCode, severity: c.severity })),
    criticalUncovered: result.criticalUncovered
  }, null, 2));
}

async function plan() {
  const reqId = str(opts.requirement);
  if (!reqId) { console.error("需 --requirement"); process.exit(1); }
  const base = await loadBaseData();
  const impactFile = path.join(REPORT_DIR, `${reqId}-impact.json`);
  if (!(await fs.pathExists(impactFile))) { console.error("先运行 impact:analyze"); process.exit(1); }
  const impact = (await fs.readJson(impactFile)) as { changeSet: Awaited<ReturnType<typeof buildRequirementChangeSet>>; impact: ReturnType<typeof analyzeChangeImpact> };
  const plan: RegressionPlan = buildRegressionPlan({
    planId: `RP-${reqId}`,
    changeSetRefs: [reqId],
    environment: str(opts.env) ?? "UAT",
    impactCandidates: impact.impact.candidates,
    assets: base.assets.filter((a) => a.status === "ACTIVE").map((a) => ({ testAssetId: a.testAssetId, version: a.version, status: a.status, risk: a.risk, critical: a.risk.designPriority === "CRITICAL" })),
    criticalChangedFactIds: impact.changeSet.changedFactIds,
    criticalNeighborAssetIds: [],
    flakyAssetIds: [],
    previouslyFailedAssetIds: [],
    newTestRequests: impact.impact.criticalUncovered.map((f) => ({ requestId: `NTR-${f}`, reason: `critical fact ${f} 无覆盖`, changedFactId: f }))
  });
  await fs.ensureDir(PLAN_DIR);
  await writeSafeJsonFile(path.join(PLAN_DIR, `${plan.planId}.json`), plan);
  console.log(JSON.stringify({
    planId: plan.planId, version: plan.version, status: plan.status,
    mustRun: plan.selectedAssets.filter((s) => s.selectionLevel === "MUST_RUN").map((s) => s.assetId),
    shouldRun: plan.selectedAssets.filter((s) => s.selectionLevel === "SHOULD_RUN").map((s) => s.assetId),
    updateRequired: plan.updateRequiredAssets,
    newTestRequests: plan.newTestRequests,
    excluded: plan.excludedAssets.length,
    riskSummary: plan.riskSummary
  }, null, 2));
}

async function show() {
  const planId = str(opts.plan);
  if (!planId) { console.error("需 --plan"); process.exit(1); }
  const p = path.join(PLAN_DIR, `${planId}.json`);
  if (!(await fs.pathExists(p))) { console.error("plan 不存在"); process.exit(1); }
  const plan = (await fs.readJson(p)) as RegressionPlan;
  console.log(`## ${plan.planId} ${plan.version} [${plan.status}] env=${plan.environment}`);
  for (const s of plan.selectedAssets) {
    console.log(`  ${s.assetId} [${s.selectionLevel}/${s.disposition}] ${(s.whySelected.join(";") || s.whyNotSelected) ?? ""}`);
  }
  console.log(`  newTestRequests=${plan.newTestRequests.length} reviewRequired=${plan.reviewRequiredAssets.length} updateRequired=${plan.updateRequiredAssets.length}`);
}

async function review() {
  const planId = str(opts.plan);
  const action = str(opts.action);
  if (!planId || !action) { console.error("需 --plan --action"); process.exit(1); }
  const p = path.join(PLAN_DIR, `${planId}.json`);
  const plan = (await fs.readJson(p)) as RegressionPlan;
  const reviewer = str(opts.reviewer) ?? "david";
  const record: import("../src/test-assets/impact/regression-plan.js").PlanReviewRecord = { reviewId: `rev-${Date.now()}`, action: action as never, assetId: str(opts.asset), reviewer, timestamp: new Date().toISOString(), reason: "CLI review" };
  const updated = reviewRegressionPlan(plan, record);
  await writeSafeJsonFile(p, updated);
  const lastReview = updated.reviewHistory[updated.reviewHistory.length - 1];
  console.log(`reviewed ${planId} action=${action} status=${updated.status}${lastReview.warning ? ` WARNING: ${lastReview.warning}` : ""}`);
}

async function execute() {
  const planId = str(opts.plan);
  if (!planId) { console.error("需 --plan"); process.exit(1); }
  const p = path.join(PLAN_DIR, `${planId}.json`);
  const plan = (await fs.readJson(p)) as RegressionPlan;
  const env = str(opts.env) ?? "UAT";
  const base = await loadBaseData();
  const service = new TestAssetExecutionService({ rootDir: ROOT, project: "demo", env: "test", environment: env as never, baseUrl: undefined });
  const run = await runRegressionPlan({
    regressionRunId: `RR-${planId}-${Date.now()}`,
    plan,
    environment: env,
    resolveAsset: (assetId) => {
      const asset = base.assets.find((a) => a.testAssetId === assetId);
      if (!asset) return undefined;
      const entry = plan.selectedAssets.find((s) => s.assetId === assetId);
      return {
        assetId,
        version: asset.version,
        selectionLevel: entry?.selectionLevel ?? "EXCLUDED",
        executionRisk: asset.risk.executionRisk,
        readiness: "READY",
        disposition: entry?.disposition ?? "UNCHANGED",
        execute: async () => {
          const outcome = await service.execute(asset, {
            context: await import("../src/core/config-loader.js").then((m) => m.loadContext({ rootDir: ROOT, project: "demo", env: "test" })),
            options: { project: "demo", env: "test", tags: [], locales: [], dryRun: false, mode: "heal", maxAiCalls: 0, maxDurationMs: 60_000 },
            maxAttempts: 1
          });
          return { result: outcome.result, runId: outcome.runId, error: outcome.detail };
        }
      };
    }
  });
  await fs.ensureDir(REPORT_DIR);
  await writeSafeJsonFile(path.join(REPORT_DIR, `${run.regressionRunId}.json`), run);
  console.log(`## ${run.regressionRunId} [${run.status}]`);
  console.log(JSON.stringify(run.summary, null, 2));
}

async function history() {
  if (!(await fs.pathExists(REPORT_DIR))) { console.log("无 run 历史"); return; }
  const files = (await fs.readdir(REPORT_DIR)).filter((f) => f.startsWith("RR-") && f.endsWith(".json")).sort();
  for (const f of files) {
    const run = (await fs.readJson(path.join(REPORT_DIR, f))) as Awaited<ReturnType<typeof runRegressionPlan>>;
    console.log(`  ${run.regressionRunId} [${run.status}] ${JSON.stringify(run.summary)}`);
  }
}

async function impactDoctor() {
  const base = await loadBaseData();
  const graph = buildGraph(base);
  const report = runImpactDoctor({
    graphVersion: graph.version(),
    expectedGraphVersion: graph.version(),
    assets: base.assets,
    knownRequirements: base.reqStore.models.map((m) => m.requirementId),
    knownKnowledgeIds: base.kb.knowledge.map((k) => k.knowledgeId),
    criticalChangedFactIds: [],
    coveredFactIds: base.assets.flatMap((a) => a.businessRuleRefs)
  });
  console.log(`impact:doctor pass=${report.pass}`);
  report.issues.forEach((i) => console.log(`  - ${i}`));
}

switch (command) {
  case "analyze": await analyze(); break;
  case "show": await show(); break;
  case "plan": await plan(); break;
  case "review": await review(); break;
  case "execute": await execute(); break;
  case "history": await history(); break;
  case "impact-doctor": await impactDoctor(); break;
  default: console.log(`未知命令 ${command}`); break;
}
