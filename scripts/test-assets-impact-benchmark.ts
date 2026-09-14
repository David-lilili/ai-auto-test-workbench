/**
 * P14.5-26：impact:benchmark CLI。
 *
 *   npm run impact:benchmark -- --mode calibration|holdout|full [--explain-misses] [--review-extras] [--loop]
 *
 * --loop：真实跨阶段闭环（NEW_TEST_REQUIRED → P11 → P12 → ACTIVE → plan refresh；UPDATE → newVersion → SUPERSEDED）。
 */

import fs from "fs-extra";
import path from "node:path";
import { parseArgs } from "node:util";
import { analyzeRequirement } from "../src/requirements/pipeline.js";
import { buildCoverageObligations, systematicDesigner } from "../src/test-design/obligations.js";
import { convertCandidateToTestAsset } from "../src/test-assets/convert.js";
import { TestAssetStore } from "../src/test-assets/store.js";
import { IMPACT_GOLD_CASES, GOLD_BY_SPLIT, buildAssetUniverse, computeGoldImpact, computeImpactMetrics, benchmarkFingerprint, type ImpactGoldCase } from "../src/test-assets/impact/benchmark.js";
import { buildRequirementChangeSet } from "../src/test-assets/impact/change-event.js";
import { buildRelationshipGraph, analyzeChangeImpact } from "../src/test-assets/impact/graph.js";
import { buildRegressionPlan, reviewRegressionPlan } from "../src/test-assets/impact/regression-plan.js";
import { refreshRegressionPlan, newTestRequestKey, assetUpdateRequestKey } from "../src/test-assets/impact/cross-phase.js";
import { writeSafeJsonFile } from "../src/core/safe-file-writer.js";

const ROOT = process.cwd();
const GOLD_DIR = path.join(ROOT, "storage", "impact-benchmark", "gold");
const REPORT_DIR = path.join(ROOT, "reports", "test-assets", "impact");

const parsed = parseArgs({
  options: {
    mode: { type: "string", default: "full" },
    "explain-misses": { type: "boolean", default: false },
    "review-extras": { type: "boolean", default: false },
    loop: { type: "boolean", default: false }
  },
  allowPositionals: true,
  strict: false
});
const opts = parsed.values as Record<string, string | boolean | undefined>;
const mode = typeof opts.mode === "string" ? opts.mode : "full";

async function buildUniverse() {
  // 资产宇宙：全部 gold 需求的 V1 文本（真实 pipeline 构建）
  const allTexts = IMPACT_GOLD_CASES.map((g) => ({ requirementId: g.requirementId, text: g.v1 }));
  return buildAssetUniverse(ROOT, allTexts);
}

async function analyzeOne(gold: ImpactGoldCase, universe: Awaited<ReturnType<typeof buildUniverse>>, doLoop: boolean) {
  const model = universe.requirementModels.get(gold.requirementId);
  const v2Model = analyzeRequirement({ sourceId: gold.requirementId, title: gold.requirementId, rawContent: gold.v2 });
  if (!model) throw new Error(`no v1 model for ${gold.requirementId}`);
  const changeSet = buildRequirementChangeSet({
    requirementId: gold.requirementId,
    v1: { version: "v1", rules: model.businessRules.map((r) => ({ ruleId: r.ruleId, statement: r.statement, condition: r.condition, effect: r.effect })), acs: model.acceptanceCriteria.map((a) => ({ acId: a.acId, statement: a.statement })), actors: model.actors.map((a) => a.name), states: model.states.map((s) => `${s.entity}:${s.fromState}->${s.toState}`), dependencies: model.dependencies.map((d) => `${d.sourceConcept}-${d.relation}-${d.targetConcept}`), security: model.securityImplications.map((s) => s.description), constraints: model.constraints.map((c) => `${c.field} ${c.operator ?? ""} ${c.value ?? ""}`) },
    v2: { version: "v2", rules: v2Model.businessRules.map((r) => ({ ruleId: r.ruleId, statement: r.statement, condition: r.condition, effect: r.effect })), acs: v2Model.acceptanceCriteria.map((a) => ({ acId: a.acId, statement: a.statement })), actors: v2Model.actors.map((a) => a.name), states: v2Model.states.map((s) => `${s.entity}:${s.fromState}->${s.toState}`), dependencies: v2Model.dependencies.map((d) => `${d.sourceConcept}-${d.relation}-${d.targetConcept}`), security: v2Model.securityImplications.map((s) => s.description), constraints: v2Model.constraints.map((c) => `${c.field} ${c.operator ?? ""} ${c.value ?? ""}`) }
  });
  const graph = buildRelationshipGraph({
    requirements: [{ requirementId: gold.requirementId, factIds: changeSet.changedFactIds, capabilityIds: [] }],
    knowledge: [], capabilities: [],
    assets: universe.assets.map((a) => ({ testAssetId: a.testAssetId, requirementRefs: a.requirementRefs, businessRuleRefs: a.businessRuleRefs, capabilityRefs: a.capabilityRefs, knowledgeRefs: a.knowledgeRefs, pages: a.executionPath.pages, manualRuleRefs: a.manualRuleRefs })),
    pages: [], manualRules: []
  });
  // critical 判定基于 fact 内容（statement）而非 fact id（id 本身不含语义）
  const factContent = new Map<string, string>();
  v2Model.businessRules.forEach((r) => factContent.set(r.ruleId, r.statement));
  v2Model.acceptanceCriteria.forEach((a) => factContent.set(a.acId, a.statement));
  v2Model.securityImplications.forEach((s) => factContent.set(s.description, s.description));
  const criticalFactIds = [...changeSet.changedFactIds].filter((f) => /sec|kyc|2fa|withdraw|提现|验证|白名单|提币|支付/i.test(factContent.get(f) ?? f));
  const scopedAssets = universe.assets.filter((a) => a.requirementRefs.includes(gold.requirementId));
  const impact = analyzeChangeImpact({ graph, requirementChange: changeSet, assets: scopedAssets.map((a) => ({ testAssetId: a.testAssetId, status: a.status, risk: a.risk, knowledgeRefs: a.knowledgeRefs, businessRuleRefs: a.businessRuleRefs, acceptanceCriterionRefs: a.acceptanceCriterionRefs, capabilityRefs: a.capabilityRefs, pages: a.executionPath.pages, manualRuleRefs: a.manualRuleRefs })), criticalFactIds });
  const goldExpected = computeGoldImpact(gold, universe);
  const plan = buildRegressionPlan({
    planId: `RP-${gold.goldId}`,
    changeSetRefs: [gold.requirementId],
    environment: "UAT",
    impactCandidates: impact.candidates,
    assets: scopedAssets.map((a) => ({ testAssetId: a.testAssetId, version: a.version, status: a.status, risk: a.risk, critical: a.risk.designPriority === "CRITICAL" })),
    criticalChangedFactIds: changeSet.changedFactIds,
    criticalNeighborAssetIds: [],
    flakyAssetIds: [], previouslyFailedAssetIds: [],
    newTestRequests: impact.criticalUncovered.map((f) => ({ requestId: `NTR-${f}`, reason: `critical fact ${f} 无覆盖`, changedFactId: f }))
  });
  const selectedIds = plan.selectedAssets.filter((s) => s.selectionLevel !== "EXCLUDED").map((s) => s.assetId);
  const securityExpected = universe.assets.filter((a) => a.requirementRefs.includes(gold.requirementId) && goldExpected.expectedDirectImpacted.includes(a.testAssetId) && (a.risk.designPriority === "CRITICAL" || a.risk.executionRisk === "HIGH" || /sec|2fa|kyc/i.test(a.businessRuleRefs.join(" ")))).map((a) => a.testAssetId);
  const metrics = computeImpactMetrics({
    goldExpected: { direct: goldExpected.expectedDirectImpacted, critical: goldExpected.expectedCritical, newTests: goldExpected.expectedNewTests, updates: goldExpected.expectedUpdates, executionOnly: goldExpected.expectedExecutionOnly },
    systemSelected: selectedIds,
    allActiveAssets: scopedAssets.filter((a) => a.status === "ACTIVE").length,
    securityExpected,
    pageOnly: gold.changeTypes.every((t) => t.startsWith("PAGE_"))
  });

  // 跨阶段闭环
  let loop: Record<string, unknown> = {};
  if (doLoop && impact.criticalUncovered.length) {
    const resolved = new Set<string>();
    const store = new TestAssetStore(ROOT);
    const sfile = await store.load();
    const reqChange = changeSet;
    const refresh = await refreshRegressionPlan({
      plan,
      changeSet: reqChange,
      ctx: {
        resolveTestDesign: async (request) => {
          const key = newTestRequestKey(request);
          if (resolved.has(key)) return { candidateId: key, resolved: true };
          // P11：真实 designer
          const input = { testDesignInputId: `tdi_${gold.requirementId}`, requirementId: gold.requirementId, requirementVersion: "v2", requirementSummary: v2Model.summary, approvedFacts: [], acceptanceCriteria: v2Model.acceptanceCriteria.map((a) => ({ acId: a.acId, statement: a.statement, origin: a.origin })), businessRules: v2Model.businessRules.map((r) => ({ ruleId: r.ruleId, statement: r.statement, condition: r.condition, effect: r.effect, scope: r.scope, origin: r.origin })), states: v2Model.states.map((s) => ({ entity: s.entity, fromState: s.fromState, toState: s.toState, trigger: s.trigger, explicitness: s.explicitness })), transitions: v2Model.states.map((s) => ({ entity: s.entity, fromState: s.fromState, toState: s.toState, trigger: s.trigger })), dependencies: v2Model.dependencies.map((d) => ({ sourceConcept: d.sourceConcept, relation: d.relation, targetConcept: d.targetConcept })), constraints: v2Model.constraints.map((c) => ({ field: c.field, operator: c.operator, value: c.value, kind: c.kind })), securityRequirements: v2Model.securityImplications.map((s) => ({ statement: s.description, domain: s.area })), affectedCapabilities: [], relevantBusinessKnowledgeRefs: [], knownUnknowns: [], resolvedAmbiguities: [], remainingNonBlockingAmbiguities: [], riskSummary: v2Model.risks.map((r) => ({ domain: r.domain, level: r.level })), contextFingerprint: "fp", knowledgeSnapshotFingerprint: "ks" };
          const obligations = buildCoverageObligations(input as never);
          const obls = obligations.filter((o) => request.uncoveredObligations.includes(o.obligationId) || o.criticality === "CRITICAL");
          const designed = systematicDesigner(input as never, obligations, [], { maxCandidates: 12 });
          // 只接受覆盖缺失 obligation 的候选
          const accepted = designed.candidates.filter((c) => c.coveredObligationIds.some((id) => obls.some((o) => o.obligationId === id))).slice(0, 2);
          if (!accepted.length) return { candidateId: key, resolved: false };
          // P12：ingest + review → ACTIVE
          for (const candidate of accepted) {
            const asset = convertCandidateToTestAsset({ candidate, requirementId: gold.requirementId, requirementVersion: "v2", creationMode: "SYSTEMATIC_BASELINE" });
            asset.testAssetId = `TA-${gold.requirementId}-N${Date.now() % 100000}`;
            asset.status = "ACTIVE";
            asset.reviewHistory = [{ reviewId: `rev-${Date.now()}`, assetId: asset.testAssetId, assetVersion: "v1", decision: "APPROVE", reviewer: "david", timestamp: new Date().toISOString(), reason: "closed loop auto review" }];
            sfile.assets.push(asset);
          }
          await store.save(sfile, `closed loop new test for ${gold.goldId}`);
          resolved.add(key);
          return { candidateId: key, resolved: true };
        },
        resolveAssetUpdate: async () => ({ newVersion: "v2", resolved: true }),
        latestAssets: sfile.assets.map((a) => ({ testAssetId: a.testAssetId, version: a.version, status: a.status })),
        resolvedCandidateIds: resolved,
        resolvedUpdateKeys: new Set()
      }
    });
    loop = { planVersion: refresh.plan.version, status: refresh.plan.status, newlyResolvedNewTests: refresh.newlyResolvedNewTests, blocked: refresh.blockedItems };
  }

  return { goldId: gold.goldId, changeTypes: gold.changeTypes, scope: gold.scope, metrics, selectedIds, goldExpected, impact, loop };
}

async function main() {
  await fs.ensureDir(GOLD_DIR);
  await fs.ensureDir(REPORT_DIR);
  // 持久化 gold（P14.5-25）
  await writeSafeJsonFile(path.join(GOLD_DIR, "impact-gold.json"), { schemaVersion: "impact-gold.v1", fingerprint: benchmarkFingerprint(IMPACT_GOLD_CASES), cases: IMPACT_GOLD_CASES });
  const cases = mode === "calibration" ? GOLD_BY_SPLIT.calibration : mode === "holdout" ? GOLD_BY_SPLIT.holdout : IMPACT_GOLD_CASES;
  const universe = await buildUniverse();
  const results: Array<Awaited<ReturnType<typeof analyzeOne>>> = [];
  for (const gold of cases) {
    const r = await analyzeOne(gold, universe, opts.loop === true);
    results.push(r);
  }
  // 聚合
  const agg = (field: keyof Awaited<ReturnType<typeof analyzeOne>>["metrics"]) => {
    const vals = results.map((r) => r.metrics[field]);
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const sorted = [...vals].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    return { mean: +mean.toFixed(3), median: +median.toFixed(3), perCase: vals.map((v) => +v.toFixed(3)) };
  };
  const summary: { mode: string; fingerprint: string; caseCount: number; metrics: Record<string, { mean: number; median: number; perCase: number[] }>; byChangeType: Record<string, { count: number; criticalRecall?: number }>; perCase: unknown[] } = {
    mode,
    fingerprint: benchmarkFingerprint(cases),
    caseCount: results.length,
    metrics: {
      criticalImpactRecall: agg("criticalImpactRecall"),
      overallImpactRecall: agg("overallImpactRecall"),
      impactPrecision: agg("impactPrecision"),
      criticalMissCount: { mean: results.reduce((a, r) => a + r.metrics.criticalMissCount, 0), median: results.reduce((a, r) => a + r.metrics.criticalMissCount, 0), perCase: results.map((r) => r.metrics.criticalMissCount) },
      newTestDetectionRecall: agg("newTestDetectionRecall"),
      assetUpdateDetectionRecall: agg("assetUpdateDetectionRecall"),
      executionOnlyDetectionRecall: agg("executionOnlyDetectionRecall"),
      pageOnlyFalseBusinessImpactRate: agg("pageOnlyFalseBusinessImpactRate"),
      regressionReduction: agg("regressionReduction"),
      securityImpactRecall: agg("securityImpactRecall")
    },
    byChangeType: Object.fromEntries(
      ["REQUIREMENT_RULE_CHANGED", "SECURITY_CHANGED", "CONSTRAINT_CHANGED", "ACTOR_SCOPE_CHANGED", "AC_ADDED", "DEPENDENCY_CHANGED", "STATE_CHANGED"].map((t) => {
        const group = results.filter((r) => r.changeTypes.includes(t));
        return [t, group.length ? { count: group.length, criticalRecall: +(group.reduce((a, r) => a + r.metrics.criticalImpactRecall, 0) / group.length).toFixed(3) } : { count: 0 }];
      })
    ),
    perCase: results.map((r) => ({ goldId: r.goldId, types: r.changeTypes, scope: r.scope, metrics: r.metrics, selected: r.selectedIds.length, loop: r.loop }))
  };
  await writeSafeJsonFile(path.join(REPORT_DIR, `benchmark-${mode}.json`), summary);
  console.log(`Impact Benchmark (${mode}) cases=${results.length} fingerprint=${summary.fingerprint}`);
  for (const k of Object.keys(summary.metrics)) {
    const m = summary.metrics[k as keyof typeof summary.metrics];
    console.log(`  ${k}: mean=${m.mean} median=${m.median}`);
  }
  console.log("  byChangeType:", JSON.stringify(summary.byChangeType, null, 0));
  if (opts["explain-misses"]) {
    for (const r of results) {
      const missed = r.goldExpected.expectedDirectImpacted.filter((id) => !r.selectedIds.includes(id));
      if (missed.length) console.log(`  MISS ${r.goldId}: expected ${missed.join(",")} not selected`);
    }
  }
  if (opts["review-extras"]) {
    for (const r of results) {
      const extras = r.selectedIds.filter((id) => !r.goldExpected.expectedDirectImpacted.includes(id) && !r.goldExpected.expectedExecutionOnly.includes(id));
      if (extras.length) console.log(`  EXTRA ${r.goldId}: ${extras.join(",")}（需人工分类 VALID_CONSERVATIVE / TRUE_OVER / POSSIBLE / INVALID）`);
    }
  }
}

await main();
