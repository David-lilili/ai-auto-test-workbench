/**
 * P14.5 测试补足：gold loader / split / metrics / closed loop / idempotency / drift。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { IMPACT_GOLD_CASES, GOLD_BY_SPLIT, computeImpactMetrics, benchmarkFingerprint } from "../src/test-assets/impact/benchmark.js";
import { refreshRegressionPlan, newTestRequestKey, assetUpdateRequestKey, readyForReview, type TestDesignChangeRequest, type AssetUpdateReviewRequest } from "../src/test-assets/impact/cross-phase.js";
import { buildRegressionPlan } from "../src/test-assets/impact/regression-plan.js";
import { runAssetWithPolicy, runImpactDoctor } from "../src/test-assets/impact/regression-runner.js";

test("gold loader（>=10 条，7/3 拆分）", () => {
  assert.ok(IMPACT_GOLD_CASES.length >= 10);
  assert.equal(GOLD_BY_SPLIT.calibration.length, 7);
  assert.equal(GOLD_BY_SPLIT.holdout.length, 3);
  assert.ok(GOLD_BY_SPLIT.calibration.every((g) => g.split === "calibration"));
  assert.ok(GOLD_BY_SPLIT.holdout.every((g) => g.split === "holdout"));
});

test("holdout isolation（开发期不可见调优）", () => {
  const holdoutIds = GOLD_BY_SPLIT.holdout.map((g) => g.goldId);
  assert.deepEqual(holdoutIds, ["ig_08", "ig_09", "ig_10"]);
  assert.ok(holdoutIds.every((id) => id.startsWith("ig_")));
  assert.ok(GOLD_BY_SPLIT.holdout.every((g) => g.goldSource === "RECONSTRUCTED_FROM_HISTORY"));
});

test("impact metrics 计算", () => {
  const m = computeImpactMetrics({
    goldExpected: { direct: ["TA-1", "TA-2"], critical: ["TA-1"], newTests: ["NTR-1"], updates: [], executionOnly: [] },
    systemSelected: ["TA-1", "TA-2", "TA-3"],
    allActiveAssets: 10,
    securityExpected: ["TA-1"],
    pageOnly: false
  });
  assert.equal(m.criticalImpactRecall, 1);
  assert.equal(m.overallImpactRecall, 1);
  assert.equal(m.impactPrecision, 2 / 3);
  assert.equal(m.criticalMissCount, 0);
  assert.ok(m.regressionReduction > 0.6);
});

test("precision review 分类（extras 需人工判定，不算自动错）", () => {
  const m = computeImpactMetrics({
    goldExpected: { direct: ["TA-1"], critical: [], newTests: [], updates: [], executionOnly: [] },
    systemSelected: ["TA-1", "TA-2"],
    allActiveAssets: 10,
    securityExpected: [],
    pageOnly: false
  });
  assert.equal(m.impactPrecision, 0.5);
});

test("miss classification（gold 有但未选 → underSelectionRate）", () => {
  const m = computeImpactMetrics({
    goldExpected: { direct: ["TA-1", "TA-2", "TA-3"], critical: ["TA-3"], newTests: [], updates: [], executionOnly: [] },
    systemSelected: ["TA-1"],
    allActiveAssets: 10,
    securityExpected: [],
    pageOnly: false
  });
  assert.equal(m.criticalImpactRecall, 0);
  assert.equal(m.criticalMissCount, 2);
  assert.equal(m.underSelectionRate, 2 / 3);
});

test("new-test detection（criticalUncovered → NTR）", () => {
  const plan = buildRegressionPlan({
    planId: "RP-T", changeSetRefs: ["R1"], environment: "UAT", impactCandidates: [],
    assets: [{ testAssetId: "TA-1", version: "v1", status: "ACTIVE", risk: { designPriority: "MEDIUM", executionRisk: "LOW" }, critical: false }],
    criticalChangedFactIds: ["br_new"], criticalNeighborAssetIds: [], flakyAssetIds: [], previouslyFailedAssetIds: [],
    newTestRequests: [{ requestId: "NTR-br_new", reason: "no cover", changedFactId: "br_new" }]
  });
  assert.equal(plan.newTestRequests.length, 1);
  assert.equal(plan.status, "NEEDS_TEST_DESIGN");
});

test("cross-phase new-test loop（P11→P12→ACTIVE→plan refresh）", async () => {
  const plan = buildRegressionPlan({
    planId: "RP-L", changeSetRefs: ["R1"], environment: "UAT", impactCandidates: [],
    assets: [{ testAssetId: "TA-1", version: "v1", status: "ACTIVE", risk: { designPriority: "MEDIUM", executionRisk: "LOW" }, critical: false }],
    criticalChangedFactIds: ["br_new"], criticalNeighborAssetIds: [], flakyAssetIds: [], previouslyFailedAssetIds: [],
    newTestRequests: [{ requestId: "NTR-1", reason: "no cover", changedFactId: "br_new" }]
  });
  const resolved = new Set<string>();
  const changeSet = { requirementId: "R1", fromVersion: "v1", toVersion: "v2", addedRules: ["br_new"], removedRules: [], changedRules: [], addedAC: [], removedAC: [], changedAC: [], actorChanges: [], stateChanges: [], dependencyChanges: [], securityChanges: [], constraintChanges: [], changedFactIds: ["br_new"], removedFactIds: [] };
  const refresh = await refreshRegressionPlan({
    plan,
    changeSet,
    ctx: {
      resolveTestDesign: async (request) => {
        const key = newTestRequestKey(request);
        if (resolved.has(key)) return { candidateId: key, resolved: true };
        resolved.add(key);
        return { candidateId: "TC-NEW-1", resolved: true };
      },
      resolveAssetUpdate: async () => ({ newVersion: "v2", resolved: true }),
      latestAssets: [{ testAssetId: "TA-1", version: "v1", status: "ACTIVE" }],
      resolvedCandidateIds: resolved,
      resolvedUpdateKeys: new Set()
    }
  });
  assert.ok(refresh.newlyResolvedNewTests.includes("NTR-1"));
  assert.equal(refresh.plan.newTestRequests.length, 0);
  assert.equal(readyForReview(refresh.plan), true);
});

test("cross-phase idempotency（同 NTR 不重复生成）", async () => {
  const plan = buildRegressionPlan({
    planId: "RP-I", changeSetRefs: [], environment: "UAT", impactCandidates: [],
    assets: [], criticalChangedFactIds: [], criticalNeighborAssetIds: [], flakyAssetIds: [], previouslyFailedAssetIds: [],
    newTestRequests: [{ requestId: "NTR-1", reason: "no cover", changedFactId: "br_new" }]
  });
  const changeSet = { requirementId: "R1", fromVersion: "v1", toVersion: "v2", addedRules: [], removedRules: [], changedRules: [], addedAC: [], removedAC: [], changedAC: [], actorChanges: [], stateChanges: [], dependencyChanges: [], securityChanges: [], constraintChanges: [], changedFactIds: [], removedFactIds: [] };
  const resolved = new Set<string>();
  const ctx = {
    resolveTestDesign: async (request: TestDesignChangeRequest) => {
      const key = newTestRequestKey(request);
      if (resolved.has(key)) return { candidateId: key, resolved: true };
      resolved.add(key);
      return { candidateId: "TC-NEW-1", resolved: true };
    },
    resolveAssetUpdate: async () => ({ newVersion: "v2", resolved: true }),
    latestAssets: [],
    resolvedCandidateIds: resolved,
    resolvedUpdateKeys: new Set()
  };
  await refreshRegressionPlan({ plan, changeSet, ctx });
  await refreshRegressionPlan({ plan: { ...plan, version: "v2", newTestRequests: [], status: "READY_FOR_REVIEW" }, changeSet, ctx });
  assert.equal(ctx.resolvedCandidateIds.size, 1);
});

test("asset update closed loop（v2 取代 v1）", async () => {
  const plan = buildRegressionPlan({
    planId: "RP-U", changeSetRefs: [], environment: "UAT", impactCandidates: [],
    assets: [{ testAssetId: "TA-U", version: "v1", status: "ACTIVE", risk: { designPriority: "HIGH", executionRisk: "HIGH" }, critical: true }],
    criticalChangedFactIds: [], criticalNeighborAssetIds: [], flakyAssetIds: [], previouslyFailedAssetIds: [], newTestRequests: []
  });
  const resolved = new Set<string>();
  const changeSet = { requirementId: "R1", fromVersion: "v1", toVersion: "v2", addedRules: [], removedRules: [], changedRules: ["br_1"], addedAC: [], removedAC: [], changedAC: [], actorChanges: [], stateChanges: [], dependencyChanges: [], securityChanges: [], constraintChanges: [], changedFactIds: ["br_1"], removedFactIds: [] };
  const refresh = await refreshRegressionPlan({
    plan: { ...plan, updateRequiredAssets: ["TA-U"] },
    changeSet,
    ctx: {
      resolveTestDesign: async () => ({ candidateId: "x", resolved: true }),
      resolveAssetUpdate: async (request: AssetUpdateReviewRequest) => {
        const key = assetUpdateRequestKey(request);
        if (resolved.has(key)) return { newVersion: "v3", resolved: true };
        resolved.add(key);
        return { newVersion: "v2", resolved: true };
      },
      latestAssets: [{ testAssetId: "TA-U", version: "v2", status: "ACTIVE" }],
      resolvedCandidateIds: new Set(),
      resolvedUpdateKeys: resolved
    }
  });
  assert.equal(refresh.newlyResolvedUpdates.length, 1);
});

test("plan refresh version（v1→v2）", async () => {
  const plan = buildRegressionPlan({
    planId: "RP-V", changeSetRefs: [], environment: "UAT", impactCandidates: [], assets: [],
    criticalChangedFactIds: [], criticalNeighborAssetIds: [], flakyAssetIds: [], previouslyFailedAssetIds: [], newTestRequests: []
  });
  const changeSet = { requirementId: "R1", fromVersion: "v1", toVersion: "v2", addedRules: [], removedRules: [], changedRules: [], addedAC: [], removedAC: [], changedAC: [], actorChanges: [], stateChanges: [], dependencyChanges: [], securityChanges: [], constraintChanges: [], changedFactIds: [], removedFactIds: [] };
  const refresh = await refreshRegressionPlan({
    plan, changeSet,
    ctx: { resolveTestDesign: async () => ({ candidateId: "x", resolved: true }), resolveAssetUpdate: async () => ({ newVersion: "v2", resolved: true }), latestAssets: [], resolvedCandidateIds: new Set(), resolvedUpdateKeys: new Set() }
  });
  assert.equal(refresh.plan.version, "v2");
});

test("relationship drift fail-safe（stale graph → doctor BLOCK）", () => {
  const report = runImpactDoctor({
    graphVersion: "stale-graph",
    expectedGraphVersion: "current-graph",
    assets: [], knownRequirements: [], knownKnowledgeIds: [], criticalChangedFactIds: ["br_crit"], coveredFactIds: []
  });
  assert.equal(report.pass, false);
  assert.ok(report.staleRelationshipIndex.length >= 1);
  assert.ok(report.criticalChangedFactUncovered.includes("br_crit"));
});

test("page-only blind（false business impact = 0）", () => {
  const m = computeImpactMetrics({
    goldExpected: { direct: [], critical: [], newTests: [], updates: [], executionOnly: ["TA-P"] },
    systemSelected: ["TA-P"],
    allActiveAssets: 10,
    securityExpected: [],
    pageOnly: true
  });
  assert.equal(m.pageOnlyFalseBusinessImpactRate, 0);
  assert.equal(m.executionOnlyDetectionRecall, 1);
});

test("security blind（security recall = 1）", () => {
  const m = computeImpactMetrics({
    goldExpected: { direct: ["TA-S1", "TA-S2"], critical: ["TA-S1", "TA-S2"], newTests: [], updates: [], executionOnly: [] },
    systemSelected: ["TA-S1", "TA-S2"],
    allActiveAssets: 10,
    securityExpected: ["TA-S1", "TA-S2"],
    pageOnly: false
  });
  assert.equal(m.securityImpactRecall, 1);
  assert.equal(m.criticalImpactRecall, 1);
});

test("benchmark fingerprint（deterministic）", () => {
  assert.equal(benchmarkFingerprint(GOLD_BY_SPLIT.calibration), benchmarkFingerprint(GOLD_BY_SPLIT.calibration));
});

test("runner risk policy（HIGH → WAITING_AUTHORIZATION）", async () => {
  const o = await runAssetWithPolicy({ assetId: "TA-H", version: "v1", selectionLevel: "MUST_RUN", executionRisk: "HIGH", readiness: "READY", disposition: "REEXECUTE", execute: async () => ({ result: "PASS" }) });
  assert.equal(o.status, "WAITING_AUTHORIZATION");
});

test("runner update-required → NOT_EXECUTABLE", async () => {
  const o = await runAssetWithPolicy({ assetId: "TA-U", version: "v1", selectionLevel: "MUST_RUN", executionRisk: "LOW", readiness: "READY", disposition: "UPDATE_REQUIRED", execute: async () => ({ result: "PASS" }) });
  assert.equal(o.status, "NOT_EXECUTABLE");
});
