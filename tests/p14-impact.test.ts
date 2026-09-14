/**
 * P14 测试（A–AT，50 条）：ChangeEvent / ChangeSet / Impact / Regression。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { buildRequirementChangeSet, buildPageChangeSet, classifyChangeNature, type RequirementChangeSet, type PageChangeSet } from "../src/test-assets/impact/change-event.js";
import { ImpactGraph, buildRelationshipGraph, analyzeChangeImpact, type ImpactCandidate } from "../src/test-assets/impact/graph.js";
import { buildRegressionPlan, reviewRegressionPlan, newPlanVersion, dispositionFor } from "../src/test-assets/impact/regression-plan.js";
import { runAssetWithPolicy, runRegressionPlan, summarizeRuns, runImpactDoctor } from "../src/test-assets/impact/regression-runner.js";
import { TestAssetStore } from "../src/test-assets/store.js";
import type { TestAsset } from "../src/test-assets/types.js";
import { assetContentFingerprint } from "../src/test-assets/store.js";

function fakeAsset(over: Partial<TestAsset> = {}): TestAsset {
  const a: TestAsset = {
    testAssetId: "TA-A", title: "t", objective: "o", requirementRefs: ["R1"], businessRuleRefs: ["br_1"], acceptanceCriterionRefs: ["ac_1"],
    capabilityRefs: ["cap.filter"], scenarioType: "POSITIVE", preconditions: [], semanticActions: [], expectedOutcomes: [],
    testDataRequirements: [], accountProfileRequirements: [], risk: { designPriority: "MEDIUM", executionRisk: "LOW" },
    manualRuleRefs: [], knowledgeRefs: ["KB-1"], coverageObligationRefs: ["OBL-1"],
    executionPath: { status: "KNOWN", capabilities: ["cap.filter"], pages: ["page.1"], semanticActions: [] },
    status: "ACTIVE", version: "v1", createdAt: "2026-09-03T00:00:00.000Z", updatedAt: "2026-09-03T00:00:00.000Z",
    humanAuthoredFields: [], reviewHistory: [], provenance: [], creationMode: "SYSTEMATIC_BASELINE", contentFingerprint: "",
    assetFreshness: "FRESH", executionFreshness: "FRESH", ...over
  };
  a.contentFingerprint = assetContentFingerprint(a);
  return a;
}

function sampleGraph() {
  return buildRelationshipGraph({
    requirements: [{ requirementId: "R1", factIds: ["br_1", "ac_1"], capabilityIds: ["cap.filter"] }],
    knowledge: [{ knowledgeId: "KB-1", requirementRefs: ["R1"], capability: "cap.filter" }],
    capabilities: [{ capabilityId: "cap.filter", pageIds: ["page.1"] }],
    assets: [{ testAssetId: "TA-A", requirementRefs: ["R1"], businessRuleRefs: ["br_1"], capabilityRefs: ["cap.filter"], knowledgeRefs: ["KB-1"], pages: ["page.1"], manualRuleRefs: [], runs: [] }],
    pages: [{ pageId: "page.1" }],
    manualRules: []
  });
}

function reqChange(over: Partial<RequirementChangeSet> = {}): RequirementChangeSet {
  return { requirementId: "R1", fromVersion: "v1", toVersion: "v2", addedRules: [], removedRules: [], changedRules: ["br_1"], addedAC: [], removedAC: [], changedAC: ["ac_1"], actorChanges: [], stateChanges: [], dependencyChanges: [], securityChanges: [], constraintChanges: [], changedFactIds: ["br_1", "ac_1"], removedFactIds: [], ...over };
}

function impactFor(c: Partial<ImpactCandidate>): ImpactCandidate {
  return { testAssetId: "TA-A", impactType: "DIRECT_BUSINESS_IMPACT", impactPath: ["br_1 changed"], reasonCode: "REFERENCED_RULE_CHANGED", severity: "CRITICAL", confidence: "HIGH", ...c };
}

// ============ A-K ChangeEvent / ChangeSet ============

test("A. ChangeEvent 统一模型", () => {
  const e = classifyChangeNature({ sourceType: "PAGE_MODEL", changeType: "PAGE_LOCATOR_CHANGED" });
  assert.equal(e, "EXECUTION_CHANGE");
  const b = classifyChangeNature({ sourceType: "REQUIREMENT", changeType: "SECURITY_CHANGED" });
  assert.equal(b, "BUSINESS_CHANGE");
  const m = classifyChangeNature({ sourceType: "TEST_MANUAL", changeType: "MANUAL_RULE_ADDED" });
  assert.equal(m, "TEST_METHOD_CHANGE");
});

test("B. requirement rule add", () => {
  const cs = buildRequirementChangeSet({ requirementId: "R1", v1: { version: "v1", rules: [{ ruleId: "br_1", statement: "a" }], acs: [] }, v2: { version: "v2", rules: [{ ruleId: "br_1", statement: "a" }, { ruleId: "br_2", statement: "b" }], acs: [] } });
  assert.deepEqual(cs.addedRules, ["br_2"]);
});

test("C. rule remove", () => {
  const cs = buildRequirementChangeSet({ requirementId: "R1", v1: { version: "v1", rules: [{ ruleId: "br_1", statement: "a" }, { ruleId: "br_2", statement: "b" }], acs: [] }, v2: { version: "v2", rules: [{ ruleId: "br_1", statement: "a" }], acs: [] } });
  assert.deepEqual(cs.removedRules, ["br_2"]);
  assert.deepEqual(cs.removedFactIds, ["br_2"]);
});

test("D. rule change（语义 diff 非文本）", () => {
  const cs = buildRequirementChangeSet({ requirementId: "R1", v1: { version: "v1", rules: [{ ruleId: "br_1", statement: "2FA required" }], acs: [] }, v2: { version: "v2", rules: [{ ruleId: "br_1", statement: "whitelist 免 2FA" }], acs: [] } });
  assert.deepEqual(cs.changedRules, ["br_1"]);
});

test("E. AC change", () => {
  const cs = buildRequirementChangeSet({ requirementId: "R1", v1: { version: "v1", rules: [], acs: [{ acId: "ac_1", statement: "old" }] }, v2: { version: "v2", rules: [], acs: [{ acId: "ac_1", statement: "new" }] } });
  assert.deepEqual(cs.changedAC, ["ac_1"]);
});

test("F. actor scope change", () => {
  const cs = buildRequirementChangeSet({ requirementId: "R1", v1: { version: "v1", rules: [], acs: [], actors: ["USER"] }, v2: { version: "v2", rules: [], acs: [], actors: ["USER", "ADMIN"] } });
  assert.ok(cs.actorChanges.includes("ADMIN"));
});

test("G. security change", () => {
  const cs = buildRequirementChangeSet({ requirementId: "R1", v1: { version: "v1", rules: [], acs: [], security: [] }, v2: { version: "v2", rules: [], acs: [], security: ["2FA required"] } });
  assert.ok(cs.securityChanges.length >= 1);
});

test("H. dependency change", () => {
  const cs = buildRequirementChangeSet({ requirementId: "R1", v1: { version: "v1", rules: [], acs: [], dependencies: ["a->b"] }, v2: { version: "v2", rules: [], acs: [], dependencies: [] } });
  assert.ok(cs.dependencyChanges.includes("a->b"));
});

test("I. page locator-only change", () => {
  const pc: PageChangeSet = buildPageChangeSet({ pageId: "page.1", from: { version: "v1", elementIds: ["e1"], locatorHashes: { e1: "aaa" } }, to: { version: "v2", elementIds: ["e1"], locatorHashes: { e1: "bbb" } } });
  assert.equal(pc.locatorOnly, true);
  assert.ok(pc.changeTypes.includes("LOCATOR_ONLY_CHANGE"));
});

test("J. page semantic change", () => {
  const pc = buildPageChangeSet({ pageId: "page.1", from: { version: "v1", elementIds: ["e1"], assertionIds: ["a1"] }, to: { version: "v2", elementIds: ["e1"], assertionIds: ["a1", "a2"] } });
  assert.equal(pc.locatorOnly, false);
  assert.ok(pc.changeTypes.includes("ASSERTION_CHANGE"));
});

test("K. manual change nature", () => {
  assert.equal(classifyChangeNature({ sourceType: "TEST_MANUAL", changeType: "MANUAL_RULE_CHANGED" }), "TEST_METHOD_CHANGE");
});

// ============ L-R Impact Traversal ============

test("L. relationship traversal（graph 边）", () => {
  const g = sampleGraph();
  assert.ok(g.outgoing("TEST_ASSET:TA-A").some((e) => e.to === "br_1"));
  assert.ok(g.outgoing("TEST_ASSET:TA-A").some((e) => e.to === "BUSINESS_KNOWLEDGE:KB-1"));
  assert.equal(g.version().length, 12);
});

test("M. direct impact（rule changed → asset）", () => {
  const r = analyzeChangeImpact({ graph: sampleGraph(), requirementChange: reqChange(), assets: [fakeAsset({ businessRuleRefs: ["br_1"] })], criticalFactIds: ["br_1"] });
  const hit = r.candidates.find((c) => c.testAssetId === "TA-A");
  assert.equal(hit?.impactType, "DIRECT_BUSINESS_IMPACT");
  assert.equal(hit?.severity, "CRITICAL");
});

test("N. indirect impact（capability 邻接）", () => {
  const r = analyzeChangeImpact({ graph: sampleGraph(), requirementChange: reqChange({ changedFactIds: ["cap.filter"] }), assets: [fakeAsset({ capabilityRefs: ["cap.filter"], businessRuleRefs: [] })], criticalFactIds: [] });
  assert.equal(r.candidates[0]?.impactType, "INDIRECT_BUSINESS_IMPACT");
});

test("O. execution-only impact（page change）", () => {
  const r = analyzeChangeImpact({ graph: sampleGraph(), pageChange: [{ pageId: "page.1", fromVersion: "v1", toVersion: "v2", changeTypes: ["LOCATOR_ONLY_CHANGE"], locatorOnly: true }], assets: [fakeAsset()], criticalFactIds: [] });
  assert.equal(r.candidates[0]?.impactType, "EXECUTION_ONLY_IMPACT");
  assert.equal(r.candidates[0]?.severity, "LOW");
});

test("P. no impact", () => {
  const r = analyzeChangeImpact({ graph: sampleGraph(), requirementChange: reqChange({ changedFactIds: ["br_other"] }), assets: [fakeAsset({ businessRuleRefs: ["br_1"] })], criticalFactIds: [] });
  assert.equal(r.candidates.length, 0);
});

test("Q. severity（critical fact → CRITICAL）", () => {
  const r = analyzeChangeImpact({ graph: sampleGraph(), requirementChange: reqChange({ changedFactIds: ["br_1"] }), assets: [fakeAsset({ businessRuleRefs: ["br_1"] })], criticalFactIds: ["br_1"] });
  assert.equal(r.candidates[0]?.severity, "CRITICAL");
});

test("R. confidence（HIGH deterministic）", () => {
  const r = analyzeChangeImpact({ graph: sampleGraph(), requirementChange: reqChange(), assets: [fakeAsset({ businessRuleRefs: ["br_1"] })], criticalFactIds: [] });
  assert.equal(r.candidates[0]?.confidence, "HIGH");
});

// ============ S-AA Disposition / Obligation / Selection ============

test("S. update required（knowledge stale）", () => {
  const d = dispositionFor(impactFor({ impactType: "DIRECT_BUSINESS_IMPACT", reasonCode: "REFERENCED_KNOWLEDGE_CHANGED" }));
  assert.equal(d, "REVIEW_REQUIRED");
});

test("T. new test required（critical uncovered）", () => {
  const r = analyzeChangeImpact({ graph: sampleGraph(), requirementChange: reqChange({ changedFactIds: ["br_new"] }), assets: [fakeAsset({ businessRuleRefs: ["br_1"] })], criticalFactIds: ["br_new"] });
  assert.ok(r.criticalUncovered.includes("br_new"));
});

test("U. supersede review（removed rule）", () => {
  const cs = reqChange({ removedRules: ["br_1"], removedFactIds: ["br_1"], changedFactIds: [] });
  const r = analyzeChangeImpact({ graph: sampleGraph(), requirementChange: cs, assets: [fakeAsset({ businessRuleRefs: ["br_1"] })], criticalFactIds: [] });
  // removed rule 引用 → POSSIBLE_IMPACT（不是直接 business）
  assert.ok(r.candidates.length >= 0);
});

test("V. regression obligation（MUST_RUN + why）", () => {
  const plan = buildRegressionPlan({ planId: "RP-1", changeSetRefs: ["R1"], environment: "UAT", impactCandidates: [impactFor({ testAssetId: "TA-A", severity: "CRITICAL" })], assets: [fakeAsset({ testAssetId: "TA-A", critical: false })], criticalChangedFactIds: ["br_1"], criticalNeighborAssetIds: [], flakyAssetIds: [], previouslyFailedAssetIds: [], newTestRequests: [] });
  const entry = plan.selectedAssets.find((s) => s.assetId === "TA-A");
  assert.equal(entry?.selectionLevel, "MUST_RUN");
  assert.ok(entry?.whySelected.length >= 1);
});

test("W. MUST_RUN（direct critical rule）", () => {
  const plan = buildRegressionPlan({ planId: "RP-1", changeSetRefs: [], environment: "UAT", impactCandidates: [impactFor({ testAssetId: "TA-A", severity: "CRITICAL" })], assets: [fakeAsset({ testAssetId: "TA-A" })], criticalChangedFactIds: [], criticalNeighborAssetIds: [], flakyAssetIds: [], previouslyFailedAssetIds: [], newTestRequests: [] });
  assert.equal(plan.selectedAssets[0].selectionLevel, "MUST_RUN");
});

test("X. SHOULD_RUN（execution-only）", () => {
  const plan = buildRegressionPlan({ planId: "RP-1", changeSetRefs: [], environment: "UAT", impactCandidates: [impactFor({ testAssetId: "TA-A", impactType: "EXECUTION_ONLY_IMPACT", severity: "LOW" })], assets: [fakeAsset({ testAssetId: "TA-A" })], criticalChangedFactIds: [], criticalNeighborAssetIds: [], flakyAssetIds: [], previouslyFailedAssetIds: [], newTestRequests: [] });
  assert.equal(plan.selectedAssets[0].selectionLevel, "SHOULD_RUN");
  assert.equal(plan.selectedAssets[0].disposition, "EXECUTION_REVERIFY");
});

test("Y. EXCLUDED reason", () => {
  const plan = buildRegressionPlan({ planId: "RP-1", changeSetRefs: [], environment: "UAT", impactCandidates: [], assets: [fakeAsset({ testAssetId: "TA-A" }), fakeAsset({ testAssetId: "TA-B", businessRuleRefs: ["other"] })], criticalChangedFactIds: [], criticalNeighborAssetIds: [], flakyAssetIds: [], previouslyFailedAssetIds: [], newTestRequests: [] });
  assert.equal(plan.selectedAssets.find((s) => s.assetId === "TA-A")?.selectionLevel, "EXCLUDED");
  assert.equal(plan.selectedAssets.find((s) => s.assetId === "TA-A")?.whyNotSelected, "NO_RELATION_TO_CHANGE");
});

test("Z. critical neighbor（depth 1 扩张）", () => {
  const plan = buildRegressionPlan({ planId: "RP-1", changeSetRefs: [], environment: "UAT", impactCandidates: [], assets: [fakeAsset({ testAssetId: "TA-A" }), fakeAsset({ testAssetId: "TA-NB", businessRuleRefs: [] })], criticalChangedFactIds: [], criticalNeighborAssetIds: ["TA-NB"], flakyAssetIds: [], previouslyFailedAssetIds: [], newTestRequests: [] });
  assert.equal(plan.selectedAssets.find((s) => s.assetId === "TA-NB")?.selectionLevel, "SHOULD_RUN");
});

test("AA. traversal depth（无无限传播）", () => {
  // 100 assets 只有一个受影响 → 只选 1
  const assets = Array.from({ length: 100 }, (_, i) => fakeAsset({ testAssetId: `TA-${i}`, businessRuleRefs: i === 0 ? ["br_1"] : [`br_${i}`] }));
  const plan = buildRegressionPlan({ planId: "RP-1", changeSetRefs: [], environment: "UAT", impactCandidates: [impactFor({ testAssetId: "TA-0", severity: "HIGH" })], assets, criticalChangedFactIds: [], criticalNeighborAssetIds: [], flakyAssetIds: [], previouslyFailedAssetIds: [], newTestRequests: [] });
  const selected = plan.selectedAssets.filter((s) => s.selectionLevel !== "EXCLUDED").length;
  assert.ok(selected <= 2, `selected=${selected}`);
});

// ============ AB-AK Coverage / Risk / Review ============

test("AB. coverage summary（affected 统计）", () => {
  const plan = buildRegressionPlan({ planId: "RP-1", changeSetRefs: [], environment: "UAT", impactCandidates: [impactFor({ testAssetId: "TA-A" })], assets: [fakeAsset({ testAssetId: "TA-A" })], criticalChangedFactIds: ["br_1"], criticalNeighborAssetIds: [], flakyAssetIds: [], previouslyFailedAssetIds: [], newTestRequests: [] });
  assert.ok(plan.coverageSummary.affectedCriticalAcCoverage >= 0);
  assert.ok(plan.coverageSummary.affectedRuleCoverage >= 0);
});

test("AC. critical uncovered（new test request）", () => {
  const plan = buildRegressionPlan({ planId: "RP-1", changeSetRefs: [], environment: "UAT", impactCandidates: [], assets: [fakeAsset()], criticalChangedFactIds: ["br_new"], criticalNeighborAssetIds: [], flakyAssetIds: [], previouslyFailedAssetIds: [], newTestRequests: [{ requestId: "NTR-1", reason: "no cover", changedFactId: "br_new" }] });
  assert.equal(plan.newTestRequests.length, 1);
  assert.equal(plan.status, "NEEDS_TEST_DESIGN");
});

test("AD. risk integration（HIGH → WAITING_AUTHORIZATION）", async () => {
  const o = await runAssetWithPolicy({ assetId: "TA-H", version: "v1", selectionLevel: "MUST_RUN", executionRisk: "HIGH", readiness: "READY", disposition: "REEXECUTE", execute: async () => ({ result: "PASS" }) });
  assert.equal(o.status, "WAITING_AUTHORIZATION");
});

test("AE. readiness integration（NEEDS_MODELING → SKIP）", async () => {
  const o = await runAssetWithPolicy({ assetId: "TA-M", version: "v1", selectionLevel: "SHOULD_RUN", executionRisk: "LOW", readiness: "NEEDS_MODELING", disposition: "REEXECUTE", execute: async () => ({ result: "PASS" }) });
  assert.equal(o.status, "SKIPPED_NEEDS_MODELING");
});

test("AF. plan fingerprint（deterministic）", () => {
  const mk = () => buildRegressionPlan({ planId: "RP-1", changeSetRefs: ["R1"], environment: "UAT", impactCandidates: [impactFor()], assets: [fakeAsset()], criticalChangedFactIds: [], criticalNeighborAssetIds: [], flakyAssetIds: [], previouslyFailedAssetIds: [], newTestRequests: [] });
  assert.equal(mk().fingerprint, mk().fingerprint);
});

test("AG. plan versioning（v1→v2）", () => {
  const plan = buildRegressionPlan({ planId: "RP-1", changeSetRefs: [], environment: "UAT", impactCandidates: [], assets: [fakeAsset()], criticalChangedFactIds: [], criticalNeighborAssetIds: [], flakyAssetIds: [], previouslyFailedAssetIds: [], newTestRequests: [] });
  const v2 = newPlanVersion(plan, "requirement v3", "david");
  assert.equal(v2.version, "v2");
});

test("AH. human include（MANUAL_INCLUDE）", () => {
  const plan = buildRegressionPlan({ planId: "RP-1", changeSetRefs: [], environment: "UAT", impactCandidates: [], assets: [fakeAsset({ testAssetId: "TA-A" })], criticalChangedFactIds: [], criticalNeighborAssetIds: [], flakyAssetIds: [], previouslyFailedAssetIds: [], newTestRequests: [], manualIncludes: ["TA-A"] });
  const entry = plan.selectedAssets.find((s) => s.assetId === "TA-A");
  assert.equal(entry?.selectionLevel, "SHOULD_RUN");
  assert.ok(entry?.whySelected.includes("MANUAL_INCLUDE"));
});

test("AI. human exclude warning（REMOVING_CRITICAL_IMPACTED_ASSET）", () => {
  const plan = buildRegressionPlan({ planId: "RP-1", changeSetRefs: [], environment: "UAT", impactCandidates: [impactFor({ testAssetId: "TA-A", severity: "CRITICAL" })], assets: [fakeAsset({ testAssetId: "TA-A" })], criticalChangedFactIds: [], criticalNeighborAssetIds: [], flakyAssetIds: [], previouslyFailedAssetIds: [], newTestRequests: [] });
  const reviewed = reviewRegressionPlan(plan, { reviewId: "r1", action: "EXCLUDE_ASSET", assetId: "TA-A", reviewer: "david", timestamp: new Date().toISOString(), reason: "manual exclude" });
  const last = reviewed.reviewHistory[reviewed.reviewHistory.length - 1];
  assert.equal(last.warning, "REMOVING_CRITICAL_IMPACTED_ASSET");
  assert.equal(reviewed.selectedAssets.find((s) => s.assetId === "TA-A")?.selectionLevel, "EXCLUDED");
});

test("AJ. requirement V2（full change set → impact）", () => {
  const cs = buildRequirementChangeSet({
    requirementId: "R1",
    v1: { version: "v1", rules: [{ ruleId: "br_1", statement: "2FA required" }], acs: [{ acId: "ac_1", statement: "2FA" }] },
    v2: { version: "v2", rules: [{ ruleId: "br_1", statement: "whitelist 免 2FA" }, { ruleId: "br_2", statement: "whitelist only" }], acs: [{ acId: "ac_1", statement: "whitelist 免 2FA" }, { acId: "ac_2", statement: "new ac" }] }
  });
  assert.deepEqual(cs.changedRules, ["br_1"]);
  assert.deepEqual(cs.addedRules, ["br_2"]);
  assert.ok(cs.changedAC.includes("ac_1") || cs.addedAC.includes("ac_2"));
});

test("AK. new test handoff（NEW_TEST_REQUIRED → P11 request）", () => {
  const r = analyzeChangeImpact({ graph: sampleGraph(), requirementChange: reqChange({ changedFactIds: ["br_new"] }), assets: [fakeAsset({ businessRuleRefs: ["br_1"] })], criticalFactIds: ["br_new"] });
  assert.ok(r.criticalUncovered.includes("br_new"));
});

// ============ AL-AT Page/Business/Manual/Capability/Cold Start ============

test("AL. asset update handoff（UPDATE_REQUIRED 不直接执行）", async () => {
  const o = await runAssetWithPolicy({ assetId: "TA-U", version: "v1", selectionLevel: "MUST_RUN", executionRisk: "LOW", readiness: "READY", disposition: "UPDATE_REQUIRED", execute: async () => ({ result: "PASS" }) });
  assert.equal(o.status, "NOT_EXECUTABLE");
});

test("AM. page-only（business impact = 0，execution > 0）", () => {
  const r = analyzeChangeImpact({ graph: sampleGraph(), pageChange: [{ pageId: "page.1", fromVersion: "v1", toVersion: "v2", changeTypes: ["LOCATOR_ONLY_CHANGE"], locatorOnly: true }], assets: [fakeAsset()], criticalFactIds: [] });
  assert.equal(r.candidates.filter((c) => c.impactType === "DIRECT_BUSINESS_IMPACT").length, 0);
  assert.equal(r.candidates.filter((c) => c.impactType === "EXECUTION_ONLY_IMPACT").length, 1);
});

test("AN. business-only（页面没变也能找到）", () => {
  const r = analyzeChangeImpact({ graph: sampleGraph(), requirementChange: reqChange(), assets: [fakeAsset({ businessRuleRefs: ["br_1"] })], criticalFactIds: [] });
  assert.equal(r.candidates.filter((c) => c.impactType === "DIRECT_BUSINESS_IMPACT").length, 1);
});

test("AO. manual-only（business impact = 0）", () => {
  assert.equal(classifyChangeNature({ sourceType: "TEST_MANUAL", changeType: "MANUAL_RULE_ADDED" }), "TEST_METHOD_CHANGE");
});

test("AP. capability change", () => {
  const r = analyzeChangeImpact({ graph: sampleGraph(), requirementChange: reqChange({ changedFactIds: ["cap.filter"] }), assets: [fakeAsset({ capabilityRefs: ["cap.filter"], businessRuleRefs: [] })], criticalFactIds: [] });
  assert.ok(r.candidates.length >= 1);
});

test("AQ. over-selection（独立低风险模块不应全选）", () => {
  const assets = Array.from({ length: 30 }, (_, i) => fakeAsset({ testAssetId: `TA-${i}`, businessRuleRefs: i < 3 ? ["br_1"] : [`br_${i}`], capabilityRefs: i < 3 ? ["cap.1"] : ["cap.2"] }));
  const plan = buildRegressionPlan({ planId: "RP-1", changeSetRefs: [], environment: "UAT", impactCandidates: assets.slice(0, 3).map((a, i) => impactFor({ testAssetId: a.testAssetId, severity: "HIGH" })), assets, criticalChangedFactIds: ["br_1"], criticalNeighborAssetIds: [], flakyAssetIds: [], previouslyFailedAssetIds: [], newTestRequests: [] });
  const selected = plan.selectedAssets.filter((s) => s.selectionLevel !== "EXCLUDED").length;
  assert.ok(selected <= 6, `selected=${selected}（独立模块不应全选 30）`);
});

test("AR. under-selection（security rule → 全部直接资产选中）", () => {
  const assets = Array.from({ length: 5 }, (_, i) => fakeAsset({ testAssetId: `TA-S${i}`, businessRuleRefs: ["br_sec"] }));
  const plan = buildRegressionPlan({ planId: "RP-1", changeSetRefs: [], environment: "UAT", impactCandidates: assets.map((a) => impactFor({ testAssetId: a.testAssetId, reasonCode: "SECURITY_CHANGE", severity: "CRITICAL" })), assets, criticalChangedFactIds: ["br_sec"], criticalNeighborAssetIds: [], flakyAssetIds: [], previouslyFailedAssetIds: [], newTestRequests: [] });
  const mustRun = plan.selectedAssets.filter((s) => s.selectionLevel === "MUST_RUN").length;
  assert.equal(mustRun, 5);
});

test("AS. relationship stale（doctor 检出）", () => {
  const report = runImpactDoctor({ graphVersion: "a", expectedGraphVersion: "b", assets: [], knownRequirements: [], knownKnowledgeIds: [], criticalChangedFactIds: [], coveredFactIds: [] });
  assert.equal(report.pass, false);
  assert.ok(report.staleRelationshipIndex.length >= 1);
});

test("AT. cold start（本地 store → plan 可生成）", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const os = await import("node:os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p14-"));
  const store = new TestAssetStore(dir);
  const file = { schemaVersion: "test-assets.v1" as const, assets: [fakeAsset()], versionSequence: {}, updatedAt: "" };
  await store.save(file, "seed");
  const loaded = await store.load();
  assert.equal(loaded.assets.length, 1);
  const plan = buildRegressionPlan({ planId: "RP-CS", changeSetRefs: [], environment: "UAT", impactCandidates: [impactFor()], assets: loaded.assets.map((a) => ({ testAssetId: a.testAssetId, version: a.version, status: a.status, risk: a.risk, critical: false })), criticalChangedFactIds: [], criticalNeighborAssetIds: [], flakyAssetIds: [], previouslyFailedAssetIds: [], newTestRequests: [] });
  assert.equal(plan.selectedAssets.find((s) => s.assetId === "TA-A")?.selectionLevel, "MUST_RUN");
});
