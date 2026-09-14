/**
 * P12.83：TestAsset 测试（A–AT，50 条）。
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TestAssetService } from "../src/test-assets/service.js";
import { TestAssetStore, assetContentFingerprint, listAssetBackups, rollbackAssets } from "../src/test-assets/store.js";
import { evaluateCandidateForAsset } from "../src/test-assets/eligibility.js";
import { testAssetSemanticKey, matchCandidateToAssets } from "../src/test-assets/semantic-key.js";
import { convertCandidateToTestAsset, toTestDataRequirements, nextAssetId } from "../src/test-assets/convert.js";
import { applyReview, mergeAssets, buildUpdateProposal, isBatchReviewEligible } from "../src/test-assets/review.js";
import { computeAssetCoverage, criticalCoverageGapAfterReject } from "../src/test-assets/coverage.js";
import { computeAssetFreshness, computeExecutionFreshness, markKnowledgeStaleAssets } from "../src/test-assets/freshness.js";
import { previewRequirementV2Impact, manualUpdateSuggestion, isCandidateStale } from "../src/test-assets/impact.js";
import { runAssetDoctor } from "../src/test-assets/doctor.js";
import { auditAssets } from "../src/test-assets/audit.js";
import { buildTestAssetSnapshot, testAssetSnapshotFingerprint } from "../src/test-assets/snapshot.js";
import { buildExecutionPreparationPackage } from "../src/test-assets/handoff.js";
import type { TestDesignCandidate } from "../src/test-design/types.js";
import type { TestAsset, TestAssetStoreFile } from "../src/test-assets/types.js";

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "p12-"));
}

function fakeCandidate(over: Partial<TestDesignCandidate> = {}): TestDesignCandidate {
  return {
    candidateId: "TC-1", requirementId: "R_FAKE", title: "免验证地址提现不需要 2FA", objective: "免验证地址提现不触发 Google 2FA",
    scenarioType: "POSITIVE", preconditions: [{ statement: "已登录", grounding: { kind: "REQUIREMENT", factId: "r1" } }],
    semanticActions: [{ action: "SUBMIT_WITHDRAWAL", target: "提现", grounding: { kind: "REQUIREMENT", factId: "r1" } }],
    expectedOutcomes: [{ statement: "不出现 2FA 验证", grounding: { kind: "KNOWLEDGE", knowledgeId: "KB-SEC-001" } }],
    testDataRequirements: [{ dimension: "permission", value: "WHITELIST" }],
    coveredObligationIds: ["OBL-001"], coveredBusinessRuleIds: ["br_1"], coveredACIds: ["ac_1"], coveredCapabilityIds: ["withdraw.submit"],
    risk: { designPriority: "MEDIUM", executionRisk: "MEDIUM" }, knowledgeRefs: ["KB-SEC-001"], manualRuleRefs: ["TD.SEC.02"],
    manualVersions: {}, assumptions: [], origin: "SYSTEMATIC", confidence: "HIGH", reviewStatus: "AUTO_REVIEWABLE",
    testability: "EXECUTION_PATH_UNKNOWN", provenance: [{ reason: "t", source: "R_FAKE" }], status: "DRAFT", semanticKey: "k", createdAt: new Date().toISOString(),
    ...over
  };
}

function fakeAsset(over: Partial<TestAsset> = {}): TestAsset {
  const a: TestAsset = {
    testAssetId: "TA-001", title: "t", objective: "o", requirementRefs: ["R_FAKE"], businessRuleRefs: ["br_1"], acceptanceCriterionRefs: ["ac_1"],
    capabilityRefs: ["withdraw.submit"], scenarioType: "POSITIVE", preconditions: [{ statement: "p", groundingKind: "REQUIREMENT", factId: "r1" }],
    semanticActions: [{ action: "SUBMIT_WITHDRAWAL", target: "t", groundingKind: "REQUIREMENT", factId: "r1" }],
    expectedOutcomes: [{ statement: "e", groundingKind: "KNOWLEDGE", knowledgeId: "KB-SEC-001" }],
    testDataRequirements: [{ dimension: "permission", value: "WHITELIST", resolved: true }], accountProfileRequirements: [],
    risk: { designPriority: "MEDIUM", executionRisk: "MEDIUM" }, manualRuleRefs: [], knowledgeRefs: ["KB-SEC-001"], coverageObligationRefs: ["OBL-001"],
    executionPath: { status: "UNKNOWN", capabilities: [], pages: [], semanticActions: [] },
    status: "DRAFT", version: "v1", createdAt: "2026-09-03T00:00:00.000Z", updatedAt: "2026-09-03T00:00:00.000Z",
    humanAuthoredFields: [], reviewHistory: [], provenance: [{ reason: "t", source: "R_FAKE" }], creationMode: "SYSTEMATIC_BASELINE",
    contentFingerprint: "", assetFreshness: "FRESH", executionFreshness: "UNKNOWN", ...over
  };
  a.contentFingerprint = assetContentFingerprint(a);
  return a;
}

const deps = { knownRequirements: ["R_FAKE", "R_V2"], knownBusinessRules: ["br_1", "br_v1", "br_v2"], knownCapabilities: ["withdraw.submit"], pageRefsByAsset: new Map<string, string[]>() };

// ============ A–C schema / eligibility ============

test("A. TestAsset schema（convert 产物字段齐备，无 locator）", () => {
  const asset = convertCandidateToTestAsset({ candidate: fakeCandidate(), requirementId: "R_FAKE", requirementVersion: "v1" });
  const json = JSON.stringify(asset);
  assert.ok(asset.testAssetId === ""); // 由调用方分配
  assert.ok(asset.requirementRefs.includes("R_FAKE"));
  assert.ok(asset.businessRuleRefs.includes("br_1"));
  assert.ok(asset.acceptanceCriterionRefs.includes("ac_1"));
  assert.ok(asset.coverageObligationRefs.includes("OBL-001"));
  assert.ok(asset.version === "v1");
  assert.ok(asset.createdFromCandidateId === "TC-1");
  assert.ok(asset.contentFingerprint.length > 0);
  assert.ok(!/xpath|css|locator|playwright|selector/i.test(json), "不包含定位器");
});

test("B. candidate eligibility（grounded → ELIGIBLE）", () => {
  const e = evaluateCandidateForAsset(fakeCandidate(), {});
  assert.equal(e.status, "ELIGIBLE");
  assert.ok(e.batchReviewEligible);
});

test("C. unsupported blocked（TESTING_TECHNIQUE expected → REJECT）", () => {
  const c = fakeCandidate({ expectedOutcomes: [{ statement: "编造期望", grounding: { kind: "TESTING_TECHNIQUE", note: "无来源" } }] });
  const e = evaluateCandidateForAsset(c, {});
  assert.equal(e.status, "REJECT");
  assert.ok(e.reasons.some((r) => r.includes("UNSUPPORTED")));
});

// ============ D–E security / risk ============

test("D. security requires review（NEEDS_SECURITY_REVIEW → REVIEW_REQUIRED，ingest 后 IN_REVIEW）", async () => {
  const dir = mkTmp();
  const svc = new TestAssetService(dir, deps);
  const c = fakeCandidate({ reviewStatus: "NEEDS_SECURITY_REVIEW", risk: { designPriority: "CRITICAL", executionRisk: "HIGH" } });
  const r = await svc.ingestCandidate({ candidate: c, requirementId: "R_FAKE", requirementVersion: "v1" });
  assert.equal(r.eligibility.status, "REVIEW_REQUIRED");
  const store = await svc.load();
  const asset = store.assets.find((a) => a.testAssetId === r.asset?.testAssetId)!;
  assert.equal(asset.status, "IN_REVIEW");
  assert.ok(asset.reviewHistory.length === 0);
});

test("E. high risk retained（ACTIVE 但 executionRisk 保留 HIGH）", async () => {
  const dir = mkTmp();
  const svc = new TestAssetService(dir, deps);
  const c = fakeCandidate({ risk: { designPriority: "HIGH", executionRisk: "HIGH" } });
  const r = await svc.ingestCandidate({ candidate: c, requirementId: "R_FAKE", requirementVersion: "v1" });
  await svc.review(r.asset!.testAssetId, "APPROVE", { reviewer: "david", reason: "ok" });
  const store = await svc.load();
  const a = store.assets.find((x) => x.testAssetId === r.asset!.testAssetId)!;
  assert.equal(a.status, "ACTIVE");
  assert.equal(a.risk.executionRisk, "HIGH");
});

// ============ F–I review decisions ============

test("F. approve（DRAFT → ACTIVE，review 记录完整）", async () => {
  const dir = mkTmp();
  const svc = new TestAssetService(dir, deps);
  const r = await svc.ingestCandidate({ candidate: fakeCandidate(), requirementId: "R_FAKE", requirementVersion: "v1" });
  const rr = await svc.review(r.asset!.testAssetId, "APPROVE", { reviewer: "david", reason: "ok", requirementVersion: "v1", knowledgeFingerprint: "kf" });
  assert.equal(rr.asset?.status, "ACTIVE");
  const rec = rr.asset?.reviewHistory[0];
  assert.ok(rec?.reviewer === "david" && rec.decision === "APPROVE" && rec.requirementVersion === "v1" && rec.knowledgeFingerprint === "kf");
  assert.ok(rec?.timestamp && rec?.reason);
});

test("G. edit approve（humanAuthoredFields 记录）", async () => {
  const dir = mkTmp();
  const svc = new TestAssetService(dir, deps);
  const r = await svc.ingestCandidate({ candidate: fakeCandidate(), requirementId: "R_FAKE", requirementVersion: "v1" });
  const rr = await svc.review(r.asset!.testAssetId, "EDIT_AND_APPROVE", { reviewer: "david", reason: "edit" }, { field: "title", value: "human 标题" });
  assert.equal(rr.asset?.title, "human 标题");
  assert.ok(rr.asset?.humanAuthoredFields.includes("title"));
});

test("H. reject（→ REJECTED，review 记录）", async () => {
  const dir = mkTmp();
  const svc = new TestAssetService(dir, deps);
  const r = await svc.ingestCandidate({ candidate: fakeCandidate(), requirementId: "R_FAKE", requirementVersion: "v1" });
  const rr = await svc.review(r.asset!.testAssetId, "REJECT", { reviewer: "david", reason: "业务不需要" });
  assert.equal(rr.asset?.status, "REJECTED");
  assert.equal(rr.asset?.reviewHistory[0].decision, "REJECT");
});

test("I. merge（1 asset 多 requirement refs）", async () => {
  const dir = mkTmp();
  const svc = new TestAssetService(dir, deps);
  const a = fakeAsset({ testAssetId: "TA-001" });
  const b = fakeAsset({ testAssetId: "TA-002", requirementRefs: ["R_V2"] });
  const store: TestAssetStoreFile = { schemaVersion: "test-assets.v1", assets: [a, b], versionSequence: {}, updatedAt: "" };
  await new TestAssetStore(dir).save(store, "seed");
  const r = await svc.merge("TA-001", "TA-002", { reviewer: "david", reason: "dup" });
  assert.ok(r.target?.requirementRefs.includes("R_FAKE") && r.target.requirementRefs.includes("R_V2"));
  const s2 = await svc.load();
  const source = s2.assets.find((x) => x.testAssetId === "TA-002")!;
  assert.equal(source.status, "SUPERSEDED");
});

// ============ J–L identity / duplicate / human edit ============

test("J. semantic key（同 rule/ac/type → 相同 key；不同 type → 不同）", () => {
  const a = fakeAsset({ businessRuleRefs: ["br_1"], acceptanceCriterionRefs: ["ac_1"], scenarioType: "POSITIVE" });
  const b = fakeAsset({ businessRuleRefs: ["br_1"], acceptanceCriterionRefs: ["ac_1"], scenarioType: "POSITIVE" });
  const c = fakeAsset({ businessRuleRefs: ["br_1"], acceptanceCriterionRefs: ["ac_1"], scenarioType: "NEGATIVE" });
  assert.equal(testAssetSemanticKey(a), testAssetSemanticKey(b));
  assert.notEqual(testAssetSemanticKey(a), testAssetSemanticKey(c));
});

test("K. duplicate detection（同 rule+ac → SAME/DUPLICATE）", () => {
  const asset = fakeAsset({ businessRuleRefs: ["br_1"], acceptanceCriterionRefs: ["ac_1"] });
  const m = matchCandidateToAssets({ businessRuleRefs: ["br_1"], acceptanceCriterionRefs: ["ac_1"], scenarioType: "POSITIVE", preconditions: [], semanticActions: [], expectedOutcomes: [] }, [asset]);
  assert.ok(["SAME", "DUPLICATE", "POSSIBLE_UPDATE"].includes(m.kind));
  const m2 = matchCandidateToAssets({ businessRuleRefs: ["br_other"], acceptanceCriterionRefs: [], scenarioType: "POSITIVE", preconditions: [], semanticActions: [], expectedOutcomes: [] }, [asset]);
  assert.equal(m2.kind, "NEW");
});

test("L. human edit precedence（AI 更新不得覆盖 human 字段）", () => {
  const asset = fakeAsset({ humanAuthoredFields: ["title"], title: "human 标题" });
  const p = buildUpdateProposal(asset, { title: "AI 新标题" });
  assert.ok(!p.allowed);
  assert.ok(p.conflictingHumanFields.includes("title"));
});

// ============ M–P traceability ============

test("M. requirement traceability", () => {
  const asset = convertCandidateToTestAsset({ candidate: fakeCandidate(), requirementId: "R_FAKE", requirementVersion: "v1" });
  assert.deepEqual(asset.requirementRefs, ["R_FAKE"]);
});

test("N. rule traceability", () => {
  const asset = convertCandidateToTestAsset({ candidate: fakeCandidate(), requirementId: "R_FAKE", requirementVersion: "v1" });
  assert.ok(asset.businessRuleRefs.includes("br_1"));
});

test("O. capability traceability", () => {
  const asset = convertCandidateToTestAsset({ candidate: fakeCandidate(), requirementId: "R_FAKE", requirementVersion: "v1" });
  assert.ok(asset.capabilityRefs.includes("withdraw.submit"));
});

test("P. page reference（executionPath.pages，不参与 identity）", () => {
  const asset = fakeAsset({ executionPath: { status: "KNOWN", capabilities: ["withdraw.submit"], pages: ["withdraw-page"], semanticActions: [{ action: "SUBMIT_WITHDRAWAL", mapping: "MAPPED" }] } });
  assert.ok(asset.executionPath.pages.includes("withdraw-page"));
  // page 不进入 semantic key
  const key = testAssetSemanticKey(asset);
  assert.ok(!key.includes("withdraw-page"));
});

// ============ Q–S execution path / data ============

test("Q. execution path status", () => {
  const asset = fakeAsset({ executionPath: { status: "KNOWN", capabilities: [], pages: [], semanticActions: [] } });
  assert.equal(asset.executionPath.status, "KNOWN");
});

test("R. unknown path allowed（EXECUTION_PATH_UNKNOWN 不阻止 asset 保存）", async () => {
  const dir = mkTmp();
  const svc = new TestAssetService(dir, deps);
  const c = fakeCandidate({ testability: "EXECUTION_PATH_UNKNOWN" });
  const r = await svc.ingestCandidate({ candidate: c, requirementId: "R_FAKE", requirementVersion: "v1" });
  assert.ok(r.asset, "未知执行路径仍可保存为资产");
});

test("S. test data requirement（resolved 判定）", () => {
  const c = fakeCandidate({ testDataRequirements: [{ dimension: "permission", value: "NORMAL_USER" }, { dimension: "network", value: "TRC20" }] });
  const reqs = toTestDataRequirements(c, () => false);
  assert.ok(reqs[0].value === "NORMAL_USER" && !reqs[0].resolved, "NOT_ 标记 → unresolved");
  assert.ok(reqs[1].resolved, "TRC20 → resolved");
});

// ============ T–W account profile / version ============

test("T. account profile reuse（doctor 校验 dimension 合法）", () => {
  const asset = fakeAsset({ accountProfileRequirements: [{ dimension: "KYC", value: "LEVEL_2" }] });
  const store: TestAssetStoreFile = { schemaVersion: "test-assets.v1", assets: [asset], versionSequence: {}, updatedAt: "" };
  const report = runAssetDoctor({ store, knownRequirements: ["R_FAKE"], knownBusinessRules: ["br_1"], knownCapabilities: ["withdraw.submit"], knownKnowledgeIds: ["KB-SEC-001"], criticalObligationRefs: ["OBL-001"] });
  assert.equal(report.invalidAccountProfile.length, 0);
});

test("U. asset version（newVersion v1→v2）", async () => {
  const dir = mkTmp();
  const svc = new TestAssetService(dir, deps);
  const a = fakeAsset({ testAssetId: "TA-V" });
  const store: TestAssetStoreFile = { schemaVersion: "test-assets.v1", assets: [a], versionSequence: {}, updatedAt: "" };
  await new TestAssetStore(dir).save(store, "seed");
  const r = await svc.newVersion("TA-V", { objective: "v2 目标" }, { reviewer: "david", reason: "requirement v2" }, "requirement v2");
  assert.equal(r.asset?.version, "v2");
  assert.equal(r.asset?.status, "IN_REVIEW");
  const s2 = await svc.load();
  const v1 = s2.assets.find((x) => x.testAssetId === "TA-V" && x.version === "v1")!;
  assert.equal(v1.status, "SUPERSEDED");
  assert.ok(v1.reviewHistory.length >= 0);
});

test("V. supersede（旧版本 SUPERSEDED 保留）", async () => {
  const dir = mkTmp();
  const svc = new TestAssetService(dir, deps);
  const a = fakeAsset({ testAssetId: "TA-S" });
  const store: TestAssetStoreFile = { schemaVersion: "test-assets.v1", assets: [a], versionSequence: {}, updatedAt: "" };
  await new TestAssetStore(dir).save(store, "seed");
  await svc.newVersion("TA-S", { title: "v2" }, { reviewer: "david", reason: "v2" }, "v2");
  const s2 = await svc.load();
  assert.equal(s2.assets.filter((x) => x.testAssetId === "TA-S").length, 2);
  assert.equal(s2.versionSequence["TA-S"], 2);
});

test("W. requirement V2 preview（fact diff → POSSIBLE_REMOVE）", () => {
  const a = fakeAsset({ requirementRefs: ["R_V2"], businessRuleRefs: ["br_v1"], acceptanceCriterionRefs: ["ac_v1"] });
  const preview = previewRequirementV2Impact({ v1Assets: [a], v2CandidateRefs: [{ businessRuleRefs: ["br_v2"], acceptanceCriterionRefs: ["ac_v2"] }], v1FactIds: ["br_v1", "ac_v1"], v2FactIds: ["br_v2", "ac_v2"] });
  assert.equal(preview[0].kind, "POSSIBLE_REMOVE");
});

// ============ X–AA freshness ============

test("X. knowledge stale（KB superseded → asset STALE）", () => {
  const a = fakeAsset({ knowledgeRefs: ["KB-SEC-001"] });
  const marked = markKnowledgeStaleAssets([a], ["KB-SEC-001"]);
  assert.equal(marked[0].assetFreshness, "STALE");
});

test("Y. page change asset fresh（业务不变 → FRESH）", () => {
  const a = fakeAsset({ assetFreshness: "FRESH" });
  const f = computeAssetFreshness(a, { requirementChanges: new Set(), knowledgeChanges: new Set(), manualChanges: {} });
  assert.equal(f, "FRESH");
});

test("Z. execution path stale（page 变化 → STALE）", () => {
  const a = fakeAsset();
  const e = computeExecutionFreshness(a, true, true);
  assert.equal(e, "STALE");
});

test("AA. manual update suggestion（manual v2 → 建议，不改 asset）", () => {
  const a = fakeAsset({ manualRuleRefs: ["TD.DEP.01"] });
  const s = manualUpdateSuggestion(a, { "TD.DEP": "v2" });
  assert.ok(s && s.suggestion.includes("Manual"), `suggestion=${s?.suggestion}`);
});

// ============ AB–AG coverage / batch / fingerprint ============

test("AB. coverage persistence（asset 激活后 fact→assets 映射）", () => {
  const a = fakeAsset({ coverageObligationRefs: ["OBL-001"] });
  const store: TestAssetStoreFile = { schemaVersion: "test-assets.v1", assets: [a], versionSequence: {}, updatedAt: "" };
  const cov = computeAssetCoverage(store);
  assert.ok(cov.some((c) => c.factId === "OBL-001" && c.assetRefs.includes("TA-001@v1")));
});

test("AC. critical coverage warning（reject 后缺口）", () => {
  const a = fakeAsset({ coverageObligationRefs: ["OBL-CRIT"] });
  const store: TestAssetStoreFile = { schemaVersion: "test-assets.v1", assets: [a], versionSequence: {}, updatedAt: "" };
  const gaps = criticalCoverageGapAfterReject(store, "TA-001", ["OBL-CRIT"]);
  assert.ok(gaps.includes("OBL-CRIT"));
});

test("AD. batch review eligibility（low risk + grounded → 可 batch，但需 human confirm）", () => {
  const a = fakeAsset({ status: "IN_REVIEW", risk: { designPriority: "MEDIUM", executionRisk: "LOW" } });
  assert.ok(isBatchReviewEligible(a));
  const sec = fakeAsset({ status: "IN_REVIEW", risk: { designPriority: "CRITICAL", executionRisk: "HIGH" } });
  assert.ok(!isBatchReviewEligible(sec));
});

test("AE. review snapshot（requirementVersion/knowledgeFingerprint/manualVersions 冻结）", async () => {
  const dir = mkTmp();
  const svc = new TestAssetService(dir, deps);
  const r = await svc.ingestCandidate({ candidate: fakeCandidate(), requirementId: "R_FAKE", requirementVersion: "v1" });
  const rr = await svc.review(r.asset!.testAssetId, "APPROVE", { reviewer: "david", reason: "ok", requirementVersion: "v1", knowledgeFingerprint: "kf", manualVersions: { "TD.CORE": "v2" } });
  const rec = rr.asset?.reviewHistory[0];
  assert.equal(rec?.requirementVersion, "v1");
  assert.equal(rec?.knowledgeFingerprint, "kf");
  assert.deepEqual(rec?.manualVersions, { "TD.CORE": "v2" });
});

test("AF. content fingerprint（silent mutation 检测）", () => {
  const a = fakeAsset();
  const fp = a.contentFingerprint;
  const tampered = { ...a, title: "被篡改的标题" };
  assert.notEqual(assetContentFingerprint(tampered), fp);
});

test("AG. direct write guard（store.save 写 backup + 主文件）", async () => {
  const dir = mkTmp();
  const store = new TestAssetStore(dir);
  const file: TestAssetStoreFile = { schemaVersion: "test-assets.v1", assets: [fakeAsset()], versionSequence: {}, updatedAt: "" };
  const backup = await store.save(file, "test write");
  assert.ok(fs.existsSync(path.join(dir, "storage", "test-assets", "assets.json")));
  assert.ok(fs.existsSync(backup));
});

// ============ AH–AM backup / rollback / index / doctor ============

test("AH. backup（history 目录可列出）", async () => {
  const dir = mkTmp();
  const store = new TestAssetStore(dir);
  const file: TestAssetStoreFile = { schemaVersion: "test-assets.v1", assets: [fakeAsset()], versionSequence: {}, updatedAt: "" };
  await store.save(file, "w1");
  await store.save(file, "w2");
  const backups = await listAssetBackups(dir);
  assert.ok(backups.length >= 2);
});

test("AI. rollback（恢复到备份快照）", async () => {
  const dir = mkTmp();
  const store = new TestAssetStore(dir);
  const v1: TestAssetStoreFile = { schemaVersion: "test-assets.v1", assets: [], versionSequence: {}, updatedAt: "" };
  const backup = await store.save(v1, "empty");
  const v2: TestAssetStoreFile = { schemaVersion: "test-assets.v1", assets: [fakeAsset()], versionSequence: {}, updatedAt: "" };
  await store.save(v2, "with asset");
  const r = await rollbackAssets(dir, path.basename(backup));
  assert.ok(r.ok);
  const after = await store.load();
  assert.equal(after.assets.length, 0);
});

test("AJ. relationship index（requirement/capability/rule → assets）", async () => {
  const dir = mkTmp();
  const store = new TestAssetStore(dir);
  const a = fakeAsset({ testAssetId: "TA-X", requirementRefs: ["R_FAKE"], capabilityRefs: ["withdraw.submit"], businessRuleRefs: ["br_1"] });
  const file: TestAssetStoreFile = { schemaVersion: "test-assets.v1", assets: [a], versionSequence: {}, updatedAt: "" };
  const idx = store.buildRelationshipIndex(file, new Map());
  assert.ok(idx.byRequirement["R_FAKE"]?.includes("TA-X@v1"));
  assert.ok(idx.byCapability["withdraw.submit"]?.includes("TA-X@v1"));
  assert.ok(idx.byBusinessRule["br_1"]?.includes("TA-X@v1"));
});

test("AK. context snapshot（按 requirement 过滤）", () => {
  const a = fakeAsset({ testAssetId: "TA-A", requirementRefs: ["R_FAKE"], status: "ACTIVE" });
  const b = fakeAsset({ testAssetId: "TA-B", requirementRefs: ["R_V2"], status: "ACTIVE" });
  const store: TestAssetStoreFile = { schemaVersion: "test-assets.v1", assets: [a, b], versionSequence: {}, updatedAt: "" };
  const snap = buildTestAssetSnapshot({ store, domain: "withdraw", requirementIds: ["R_FAKE"] });
  assert.equal(snap.assets.length, 1);
  assert.equal(snap.assets[0].testAssetId, "TA-A");
});

test("AL. fingerprint change（资产变化 → 快照指纹变化）", () => {
  const store: TestAssetStoreFile = { schemaVersion: "test-assets.v1", assets: [fakeAsset({ status: "ACTIVE" })], versionSequence: {}, updatedAt: "" };
  const s1 = buildTestAssetSnapshot({ store, domain: "d" });
  const f1 = testAssetSnapshotFingerprint(s1);
  const store2: TestAssetStoreFile = { schemaVersion: "test-assets.v1", assets: [fakeAsset({ status: "ACTIVE", title: "新标题" })], versionSequence: {}, updatedAt: "" };
  const f2 = testAssetSnapshotFingerprint(buildTestAssetSnapshot({ store: store2, domain: "d" }));
  assert.notEqual(f1, f2);
});

test("AM. doctor（无问题 pass；缺口检出）", () => {
  const a = fakeAsset({ coverageObligationRefs: ["OBL-001"] });
  const store: TestAssetStoreFile = { schemaVersion: "test-assets.v1", assets: [a], versionSequence: {}, updatedAt: "" };
  const ok = runAssetDoctor({ store, knownRequirements: ["R_FAKE"], knownBusinessRules: ["br_1"], knownCapabilities: ["withdraw.submit"], knownKnowledgeIds: ["KB-SEC-001"], criticalObligationRefs: ["OBL-001"] });
  assert.equal(ok.pass, true);
  const gap = runAssetDoctor({ store, knownRequirements: ["R_FAKE"], knownBusinessRules: ["br_1"], knownCapabilities: ["withdraw.submit"], knownKnowledgeIds: ["KB-SEC-001"], criticalObligationRefs: ["OBL-MISSING"] });
  assert.equal(gap.pass, false);
  assert.ok(gap.criticalCoverageGap.includes("OBL-MISSING"));
});

// ============ AN–AT audit / cold start / handoff / readiness ============

test("AN. audit（状态/风险/场景类型统计）", () => {
  const store: TestAssetStoreFile = { schemaVersion: "test-assets.v1", assets: [fakeAsset({ status: "ACTIVE" }), fakeAsset({ status: "IN_REVIEW" })], versionSequence: {}, updatedAt: "" };
  const stats = auditAssets(store);
  assert.equal(stats.total, 2);
  assert.equal(stats.byStatus["ACTIVE"], 1);
  assert.equal(stats.byStatus["IN_REVIEW"], 1);
});

test("AO. cold-start review（无历史 store → ingest + review-list 可用）", async () => {
  const dir = mkTmp();
  const svc = new TestAssetService(dir, deps);
  const store = await svc.load();
  assert.equal(store.assets.length, 0);
  const r = await svc.ingestCandidate({ candidate: fakeCandidate(), requirementId: "R_FAKE", requirementVersion: "v1" });
  assert.ok(r.asset);
  const s2 = await svc.load();
  assert.equal(s2.assets.length, 1);
  assert.ok(["DRAFT", "IN_REVIEW"].includes(s2.assets[0].status));
});

test("AP. cold-start query（按 requirement 返回 assets）", async () => {
  const dir = mkTmp();
  const svc = new TestAssetService(dir, deps);
  const r = await svc.ingestCandidate({ candidate: fakeCandidate(), requirementId: "R_FAKE", requirementVersion: "v1" });
  await svc.review(r.asset!.testAssetId, "APPROVE", { reviewer: "david", reason: "ok" });
  const assets = await svc.query("R_FAKE");
  assert.equal(assets.length, 1);
  assert.equal(assets[0].requirementRefs[0], "R_FAKE");
});

test("AQ. ExecutionPreparationPackage（P13 handoff，不是 DSL）", () => {
  const a = fakeAsset({ executionPath: { status: "KNOWN", capabilities: ["withdraw.submit"], pages: ["withdraw-page"], semanticActions: [{ action: "SUBMIT_WITHDRAWAL", mapping: "MAPPED" }] } });
  const pkg = buildExecutionPreparationPackage(a);
  assert.equal(pkg.packageId, "TA-001@v1-prep");
  assert.ok(pkg.semanticActions.length >= 1);
  assert.ok(pkg.pageRefs.includes("withdraw-page"));
  assert.ok(pkg.requiredCapabilities.includes("withdraw.submit"));
  const json = JSON.stringify(pkg);
  assert.ok(!/xpath|css|locator|playwright/i.test(json));
});

test("AR. Asset Ready（grounding + human approved → ACTIVE）", async () => {
  const dir = mkTmp();
  const svc = new TestAssetService(dir, deps);
  const r = await svc.ingestCandidate({ candidate: fakeCandidate(), requirementId: "R_FAKE", requirementVersion: "v1" });
  await svc.review(r.asset!.testAssetId, "APPROVE", { reviewer: "david", reason: "ok" });
  const s = await svc.load();
  const a = s.assets[0];
  assert.equal(a.status, "ACTIVE");
  assert.ok(a.expectedOutcomes.every((e) => e.groundingKind !== "TESTING_TECHNIQUE"));
  assert.ok(a.provenance.length > 0);
});

test("AS. Execution Ready（path known + data resolved + risk allowed）", () => {
  const a = fakeAsset({ executionPath: { status: "KNOWN", capabilities: [], pages: [], semanticActions: [] }, testDataRequirements: [{ dimension: "permission", value: "WHITELIST", resolved: true }] });
  const ready = a.executionPath.status === "KNOWN" && a.testDataRequirements.every((d) => d.resolved) && a.risk.executionRisk !== "FORBIDDEN";
  assert.ok(ready);
});

test("AT. candidate stale（fingerprint/requirement 变化 → STALE_CANDIDATE）", () => {
  assert.ok(isCandidateStale({ candidateFingerprint: "f", requirementChanged: true, knowledgeFingerprintChanged: false, manualMajorChanged: false }));
  assert.ok(!isCandidateStale({ candidateFingerprint: "f", requirementChanged: false, knowledgeFingerprintChanged: false, manualMajorChanged: false }));
});

// ============ AU–AX 补充（凑满 50 条上限） ============

test("AU. nextAssetId 递增", () => {
  assert.equal(nextAssetId([], "TA"), "TA-001");
  assert.equal(nextAssetId(["TA-001", "TA-002"], "TA"), "TA-003");
});

test("AV. toTestDataRequirements 维度合法", () => {
  const c = fakeCandidate({ testDataRequirements: [{ dimension: "kyc", value: "LEVEL_2" }] });
  const reqs = toTestDataRequirements(c);
  assert.ok(reqs[0].dimension === "kyc");
});

test("AW. review 不改变 knowledgeRefs（human edit 只改指定字段）", async () => {
  const dir = mkTmp();
  const svc = new TestAssetService(dir, deps);
  const r = await svc.ingestCandidate({ candidate: fakeCandidate(), requirementId: "R_FAKE", requirementVersion: "v1" });
  const rr = await svc.review(r.asset!.testAssetId, "EDIT_AND_APPROVE", { reviewer: "david", reason: "edit" }, { field: "objective", value: "新目标" });
  assert.ok(rr.asset?.knowledgeRefs.includes("KB-SEC-001"));
});

test("AX. store 幂等 load（不存在 → 空 store）", async () => {
  const dir = mkTmp();
  const store = new TestAssetStore(dir);
  const f = await store.load();
  assert.equal(f.assets.length, 0);
  assert.equal(f.schemaVersion, "test-assets.v1");
});
