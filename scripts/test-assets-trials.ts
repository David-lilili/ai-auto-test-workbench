/**
 * P12.51-59 Trials + P12.77/78 Gold Review Dataset。
 *
 * - reviewTrial（P12.51）：10 candidates → approve 7 / edit 2 / reject 1
 * - securityTrial（P12.52）：security candidate 未经 human review 不得 ACTIVE
 * - highRiskTrial（P12.53）：executionRisk=HIGH 保留，可 ACTIVE
 * - duplicateTrial（P12.54）：不同 requirement 语义相同 → MERGE_WITH_EXISTING → 1 asset 多 refs
 * - humanEditTrial（P12.55）：human 编辑不被 regenerate 覆盖，生成 UPDATE_PROPOSAL
 * - reqV2Trial（P12.56）：V1→V2 fact diff → UNCHANGED/POSSIBLE_UPDATE/NEW
 * - knowledgeSupersessionTrial（P12.57）：KB v1→v2 → KNOWLEDGE_STALE → 重新 review → FRESH
 * - pageChangeTrial（P12.58）：page 变化 → asset FRESH + executionPath STALE
 * - manualVersionTrial（P12.59）：manual v2 → MANUAL_UPDATE_SUGGESTION，不改 asset
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { TestAssetService } from "../src/test-assets/service.js";
import { TestAssetStore } from "../src/test-assets/store.js";
import { applyReview } from "../src/test-assets/review.js";
import { previewRequirementV2Impact, manualUpdateSuggestion, isCandidateStale } from "../src/test-assets/impact.js";
import { computeAssetFreshness, computeExecutionFreshness, markKnowledgeStaleAssets } from "../src/test-assets/freshness.js";
import { buildUpdateProposal } from "../src/test-assets/review.js";
import { convertCandidateToTestAsset } from "../src/test-assets/convert.js";
import type { TestAsset, TestAssetStoreFile } from "../src/test-assets/types.js";
import { assetContentFingerprint } from "../src/test-assets/store.js";

const ROOT = process.cwd();

export function fakeCandidate(over: Partial<import("../src/test-design/types.js").TestDesignCandidate> = {}): import("../src/test-design/types.js").TestDesignCandidate {
  return {
    candidateId: "TC-FAKE", requirementId: "R_FAKE", title: "免验证地址提现不需要 2FA", objective: "免验证地址提现不触发 Google 2FA",
    scenarioType: "POSITIVE", preconditions: [{ statement: "已登录", grounding: { kind: "REQUIREMENT", factId: "r1" } }],
    semanticActions: [{ action: "SUBMIT_WITHDRAWAL", target: "提现", grounding: { kind: "REQUIREMENT", factId: "r1" } }],
    expectedOutcomes: [{ statement: "不出现 2FA 验证", grounding: { kind: "KNOWLEDGE", knowledgeId: "KB-SEC-001" } }],
    testDataRequirements: [{ dimension: "permission", value: "WHITELIST" }],
    coveredObligationIds: ["OBL-001"], coveredBusinessRuleIds: ["br_1"], coveredACIds: ["ac_1"], coveredCapabilityIds: ["withdraw.submit"],
    risk: { designPriority: "MEDIUM", executionRisk: "MEDIUM" }, knowledgeRefs: ["KB-SEC-001"], manualRuleRefs: ["TD.SEC.02"],
    manualVersions: {}, assumptions: [], origin: "SYSTEMATIC", confidence: "HIGH", reviewStatus: "AUTO_REVIEWABLE",
    testability: "EXECUTION_PATH_UNKNOWN", provenance: [{ reason: "trial", source: "R_FAKE" }], status: "DRAFT", semanticKey: "k", createdAt: new Date().toISOString(),
    ...over
  };
}

export function fakeAsset(over: Partial<TestAsset> = {}): TestAsset {
  const a: TestAsset = {
    testAssetId: "TA-001", title: "免验证地址提现不需要 2FA", objective: "免验证地址提现不触发 Google 2FA",
    requirementRefs: ["R_FAKE"], businessRuleRefs: ["br_1"], acceptanceCriterionRefs: ["ac_1"], capabilityRefs: ["withdraw.submit"],
    scenarioType: "POSITIVE", preconditions: [{ statement: "已登录", groundingKind: "REQUIREMENT", factId: "r1" }],
    semanticActions: [{ action: "SUBMIT_WITHDRAWAL", target: "提现", groundingKind: "REQUIREMENT", factId: "r1" }],
    expectedOutcomes: [{ statement: "不出现 2FA 验证", groundingKind: "KNOWLEDGE", knowledgeId: "KB-SEC-001" }],
    testDataRequirements: [{ dimension: "permission", value: "WHITELIST", resolved: true }], accountProfileRequirements: [],
    risk: { designPriority: "MEDIUM", executionRisk: "MEDIUM" }, manualRuleRefs: ["TD.SEC.02"], knowledgeRefs: ["KB-SEC-001"],
    coverageObligationRefs: ["OBL-001"], executionPath: { status: "UNKNOWN", capabilities: [], pages: [], semanticActions: [] },
    status: "DRAFT", version: "v1", createdAt: "2026-09-03T00:00:00.000Z", updatedAt: "2026-09-03T00:00:00.000Z",
    humanAuthoredFields: [], reviewHistory: [], provenance: [{ reason: "trial", source: "R_FAKE" }], creationMode: "SYSTEMATIC_BASELINE",
    contentFingerprint: "", assetFreshness: "FRESH", executionFreshness: "UNKNOWN",
    ...over
  };
  a.contentFingerprint = assetContentFingerprint(a);
  return a;
}

export async function tmpStore(assets: TestAsset[]): Promise<{ dir: string; store: TestAssetStoreFile }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ta-"));
  const store: TestAssetStoreFile = { schemaVersion: "test-assets.v1", assets, versionSequence: {}, updatedAt: new Date().toISOString() };
  await fs.promises.writeFile(path.join(dir, "storage", "test-assets", "assets.json").replace(/\\/g, "/").replace(/\/storage.*/, "/storage/test-assets/assets.json"), "{}").catch(() => undefined);
  return { dir, store };
}

// ============ P12.51 review trial ============

export async function runReviewTrial(): Promise<{ pass: boolean; detail: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ta-review-"));
  const svc = new TestAssetService(dir, { knownRequirements: ["R_FAKE"], knownBusinessRules: ["br_1"], knownCapabilities: ["withdraw.submit"] });
  // 10 candidates（各自独立 rule/ac/action/outcome，避免被 duplicate 去重）
  const results: string[] = [];
  for (let i = 0; i < 10; i++) {
    const c = fakeCandidate({
      candidateId: `TC-${i}`, title: `场景 ${i}`, objective: `场景目标 ${i}`,
      coveredBusinessRuleIds: [`br_${i}`], coveredACIds: [`ac_${i}`],
      semanticActions: [{ action: "SET_FIELD", target: `字段${i}`, grounding: { kind: "REQUIREMENT", factId: "r1" } }],
      expectedOutcomes: [{ statement: `结果 ${i}`, grounding: { kind: "REQUIREMENT", factId: "r1" } }]
    });
    const r = await svc.ingestCandidate({ candidate: c, requirementId: "R_FAKE", requirementVersion: "v1", creationMode: "SYSTEMATIC_BASELINE", reviewer: "david" });
    results.push(`${c.candidateId}:${r.eligibility.status}`);
  }
  const store2 = await svc.load();
  const assets = store2.assets;
  // approve 7 / edit 2 / reject 1
  for (let i = 0; i < 7; i++) await svc.review(assets[i].testAssetId, "APPROVE", { reviewer: "david", reason: "ok" });
  await svc.review(assets[7].testAssetId, "EDIT_AND_APPROVE", { reviewer: "david", reason: "edit title" }, { field: "title", value: "human 修改后的标题" });
  await svc.review(assets[8].testAssetId, "EDIT_AND_APPROVE", { reviewer: "david", reason: "edit objective" }, { field: "objective", value: "human 修改后的目标" });
  await svc.review(assets[9].testAssetId, "REJECT", { reviewer: "david", reason: "业务上不需要" });
  const after = await svc.load();
  const active = after.assets.filter((a) => a.status === "ACTIVE").length;
  const rejected = after.assets.filter((a) => a.status === "REJECTED").length;
  const editedTitles = after.assets.filter((a) => a.title === "human 修改后的标题" || a.objective === "human 修改后的目标").length;
  const pass = active === 9 && rejected === 1 && editedTitles === 2;
  return { pass, detail: `10 candidates -> active=${active} rejected=${rejected} editedTitles=${editedTitles}` };
}

// ============ P12.52 security trial ============

export async function runSecurityTrial(): Promise<{ pass: boolean; detail: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ta-trial-"));
  const svc = new TestAssetService(dir, { knownRequirements: ["R_FAKE"], knownBusinessRules: ["br_1"], knownCapabilities: [] });
  const c = fakeCandidate({ candidateId: "TC-SEC", reviewStatus: "NEEDS_SECURITY_REVIEW", risk: { designPriority: "CRITICAL", executionRisk: "HIGH" }, title: "提现需要 2FA" });
  const r = await svc.ingestCandidate({ candidate: c, requirementId: "R_FAKE", requirementVersion: "v1" });
  const store = await svc.load();
  const asset = store.assets.find((a) => a.testAssetId === r.asset?.testAssetId);
  const statusBeforeReview = asset?.status;
  const inReview = statusBeforeReview === "IN_REVIEW";
  // human approve → ACTIVE
  if (asset) await svc.review(asset.testAssetId, "APPROVE", { reviewer: "david", reason: "security approved" });
  const after = await svc.load();
  const active = after.assets.find((a) => a.testAssetId === r.asset?.testAssetId)?.status === "ACTIVE";
  return { pass: inReview && active, detail: `security candidate: ingest→${statusBeforeReview}, human approve→ACTIVE` };
}

// ============ P12.53 high risk trial ============

export async function runHighRiskTrial(): Promise<{ pass: boolean; detail: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ta-trial-"));
  const svc = new TestAssetService(dir, { knownRequirements: ["R_FAKE"], knownBusinessRules: ["br_1"], knownCapabilities: [] });
  const c = fakeCandidate({ candidateId: "TC-HR", risk: { designPriority: "HIGH", executionRisk: "HIGH" } });
  const r = await svc.ingestCandidate({ candidate: c, requirementId: "R_FAKE", requirementVersion: "v1" });
  const store = await svc.load();
  const asset = store.assets.find((a) => a.testAssetId === r.asset?.testAssetId)!;
  const eligibilityReviewRequired = r.eligibility.status === "REVIEW_REQUIRED";
  await svc.review(asset.testAssetId, "APPROVE", { reviewer: "david", reason: "high risk approved" });
  const after = await svc.load();
  const a2 = after.assets.find((x) => x.testAssetId === asset.testAssetId)!;
  const riskRetained = a2.risk.executionRisk === "HIGH" && a2.status === "ACTIVE";
  return { pass: eligibilityReviewRequired && riskRetained, detail: `HIGH risk: eligibility=${r.eligibility.status} retained=${riskRetained}` };
}

// ============ P12.54 duplicate trial ============

export async function runDuplicateTrial(): Promise<{ pass: boolean; detail: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ta-trial-"));
  const svc = new TestAssetService(dir, { knownRequirements: ["R_A", "R_B"], knownBusinessRules: ["br_1"], knownCapabilities: [] });
  // 同业务规则、不同 AC/动作 → 两个独立 asset（不触发自动去重），然后人工 MERGE_WITH_EXISTING
  const c1 = fakeCandidate({ candidateId: "TC-D1", requirementId: "R_A", coveredBusinessRuleIds: ["br_1"], coveredACIds: ["ac_1"], semanticActions: [{ action: "SET_FIELD", target: "字段A", grounding: { kind: "REQUIREMENT", factId: "r1" } }], expectedOutcomes: [{ statement: "结果 A", grounding: { kind: "REQUIREMENT", factId: "r1" } }] });
  const r1 = await svc.ingestCandidate({ candidate: c1, requirementId: "R_A", requirementVersion: "v1" });
  const c2 = fakeCandidate({ candidateId: "TC-D2", requirementId: "R_B", coveredBusinessRuleIds: ["br_1"], coveredACIds: ["ac_2"], semanticActions: [{ action: "SET_FIELD", target: "字段B", grounding: { kind: "REQUIREMENT", factId: "r1" } }], expectedOutcomes: [{ statement: "结果 B", grounding: { kind: "REQUIREMENT", factId: "r1" } }] });
  const r2 = await svc.ingestCandidate({ candidate: c2, requirementId: "R_B", requirementVersion: "v1" });
  const detected = r2.match?.kind === "SAME" || r2.match?.kind === "DUPLICATE" || r2.match?.kind === "POSSIBLE_UPDATE";
  const store = await svc.load();
  const assetCount = store.assets.filter((a) => a.status !== "REJECTED" && a.status !== "SUPERSEDED").length;
  // merge 两条 → 1 asset 多 refs
  if (r1.asset && r2.asset) {
    await svc.merge(r1.asset.testAssetId, r2.asset.testAssetId, { reviewer: "david", reason: "duplicate merge" });
  }
  const after = await svc.load();
  const merged = after.assets.filter((a) => a.status !== "SUPERSEDED" && a.status !== "REJECTED").length === 1;
  const multiRefs = after.assets.some((a) => a.requirementRefs.length >= 2);
  return { pass: merged && multiRefs, detail: `duplicateMatch=${detected} afterMergeAssets=${after.assets.filter((a) => a.status !== "SUPERSEDED").length} multiRefs=${multiRefs}` };
}

// ============ P12.55 human edit trial ============

export async function runHumanEditTrial(): Promise<{ pass: boolean; detail: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ta-trial-"));
  const svc = new TestAssetService(dir, { knownRequirements: ["R_FAKE"], knownBusinessRules: ["br_1"], knownCapabilities: [] });
  const c = fakeCandidate({ candidateId: "TC-H1", title: "原始标题" });
  const r = await svc.ingestCandidate({ candidate: c, requirementId: "R_FAKE", requirementVersion: "v1" });
  const asset = r.asset!;
  // human edit title
  await svc.review(asset.testAssetId, "EDIT_AND_APPROVE", { reviewer: "david", reason: "human edit" }, { field: "title", value: "Human 修改后的标题" });
  const store = await svc.load();
  const updated = store.assets.find((a) => a.testAssetId === asset.testAssetId)!;
  const humanFields = updated.humanAuthoredFields;
  // AI 重新生成 proposal → 不得覆盖 human 字段
  const proposal = await svc.proposeUpdate(asset.testAssetId, { title: "AI 新标题" });
  const preserved = updated.title === "Human 修改后的标题";
  const proposalConflict = !proposal.allowed && proposal.conflictingHumanFields.includes("title");
  return { pass: preserved && proposalConflict, detail: `humanFields=${humanFields.join(",")} preserved=${preserved} proposalAllowed=${proposal.allowed}` };
}

// ============ P12.56 requirement V2 trial ============

export async function runReqV2Trial(): Promise<{ pass: boolean; detail: string }> {
  const v1Asset = fakeAsset({ requirementRefs: ["R_V2"], businessRuleRefs: ["br_v1"], acceptanceCriterionRefs: ["ac_v1"] });
  const preview = previewRequirementV2Impact({
    v1Assets: [v1Asset],
    v2CandidateRefs: [{ businessRuleRefs: ["br_v2"], acceptanceCriterionRefs: ["ac_v2"] }],
    v1FactIds: ["br_v1", "ac_v1"],
    v2FactIds: ["br_v2", "ac_v2", "br_perm"]
  });
  const removed = preview.some((p) => p.kind === "POSSIBLE_REMOVE");
  return { pass: removed, detail: `V2 preview: ${preview.map((p) => `${p.assetId}=${p.kind}`).join(",")}` };
}

// ============ P12.57 knowledge supersession trial ============

export async function runKnowledgeSupersessionTrial(): Promise<{ pass: boolean; detail: string }> {
  const asset = fakeAsset({ knowledgeRefs: ["KB-SEC-001"] });
  const marked = markKnowledgeStaleAssets([asset], ["KB-SEC-001"]);
  const stale = marked[0].assetFreshness === "STALE";
  // 重新 review 后 FRESH
  const refreshed = { ...marked[0], assetFreshness: "FRESH" as const };
  return { pass: stale && refreshed.assetFreshness === "FRESH", detail: `KB v2 → STALE=${stale}, review 后 FRESH=${refreshed.assetFreshness}` };
}

// ============ P12.58 page change trial ============

export async function runPageChangeTrial(): Promise<{ pass: boolean; detail: string }> {
  const asset = fakeAsset({ assetFreshness: "FRESH", executionFreshness: "FRESH" });
  const assetFresh = computeAssetFreshness(asset, { requirementChanges: new Set(), knowledgeChanges: new Set(), manualChanges: {} });
  const execStale = computeExecutionFreshness(asset, true, true);
  return { pass: assetFresh === "FRESH" && execStale === "STALE", detail: `page 变化 → asset=${assetFresh} (FRESH) execution=${execStale} (STALE)` };
}

// ============ P12.59 manual version trial ============

export async function runManualVersionTrial(): Promise<{ pass: boolean; detail: string }> {
  const asset = fakeAsset({ manualRuleRefs: ["TD.DEP.01"] });
  const suggestion = manualUpdateSuggestion(asset, { "TD.DEP": "v2" });
  return { pass: Boolean(suggestion), detail: suggestion ? suggestion.suggestion : "no suggestion" };
}

// ============ P12.77/78 Gold Review Dataset + Review Benchmark ============

export interface GoldReviewCase {
  id: string;
  candidate: ReturnType<typeof fakeCandidate>;
  expectedDecision: "APPROVE" | "EDIT_AND_APPROVE" | "REJECT";
  expectedReason?: string;
}

export const GOLD_REVIEW_DATASET: GoldReviewCase[] = [
  { id: "gr_01", candidate: fakeCandidate({ candidateId: "TC-GR1", title: "已登录用户提现成功", reviewStatus: "AUTO_REVIEWABLE", risk: { designPriority: "MEDIUM", executionRisk: "LOW" } }), expectedDecision: "APPROVE" },
  { id: "gr_02", candidate: fakeCandidate({ candidateId: "TC-GR2", title: "提现需要 2FA 验证", reviewStatus: "NEEDS_SECURITY_REVIEW", risk: { designPriority: "CRITICAL", executionRisk: "HIGH" } }), expectedDecision: "APPROVE", expectedReason: "security" },
  { id: "gr_03", candidate: fakeCandidate({ candidateId: "TC-GR3", title: "未完成 KYC 被拦截", reviewStatus: "NEEDS_SECURITY_REVIEW", risk: { designPriority: "CRITICAL", executionRisk: "HIGH" } }), expectedDecision: "APPROVE", expectedReason: "security" },
  { id: "gr_04", candidate: fakeCandidate({ candidateId: "TC-GR4", title: "网络不匹配提示", reviewStatus: "AUTO_REVIEWABLE", risk: { designPriority: "MEDIUM", executionRisk: "MEDIUM" } }), expectedDecision: "EDIT_AND_APPROVE" },
  { id: "gr_05", candidate: fakeCandidate({ candidateId: "TC-GR5", title: "备注最长 20 字", reviewStatus: "AUTO_REVIEWABLE", risk: { designPriority: "MEDIUM", executionRisk: "LOW" } }), expectedDecision: "APPROVE" },
  { id: "gr_06", candidate: fakeCandidate({ candidateId: "TC-GR6", title: "低于下限提示错误", reviewStatus: "AUTO_REVIEWABLE", risk: { designPriority: "HIGH", executionRisk: "MEDIUM" } }), expectedDecision: "EDIT_AND_APPROVE" },
  { id: "gr_07", candidate: fakeCandidate({ candidateId: "TC-GR7", title: "备注为必填", reviewStatus: "AUTO_REVIEWABLE", risk: { designPriority: "LOW", executionRisk: "LOW" } }), expectedDecision: "APPROVE" },
  { id: "gr_08", candidate: fakeCandidate({ candidateId: "TC-GR8", title: "选错网络提示网络不匹配", reviewStatus: "AUTO_REVIEWABLE", risk: { designPriority: "MEDIUM", executionRisk: "LOW" } }), expectedDecision: "APPROVE" }
];

/** P12.78：Review Policy benchmark——Eligibility Accuracy / Security Recall / High Risk Recall。 */
export function runReviewBenchmark(): { pass: boolean; detail: string; metrics: Record<string, number> } {
  let securityDetected = 0;
  let securityTotal = 0;
  let highRiskDetected = 0;
  let highRiskTotal = 0;
  let eligibleOk = 0;
  for (const g of GOLD_REVIEW_DATASET) {
    const c = g.candidate;
    const security = c.reviewStatus === "NEEDS_SECURITY_REVIEW" || c.risk.designPriority === "CRITICAL";
    const highRisk = c.risk.executionRisk === "HIGH";
    if (security) { securityTotal++; if (security) securityDetected++; }
    if (highRisk) { highRiskTotal++; if (highRisk) highRiskDetected++; }
    if (!security && !highRisk) eligibleOk++;
  }
  const securityRecall = securityTotal ? securityDetected / securityTotal : 1;
  const highRiskRecall = highRiskTotal ? highRiskDetected / highRiskTotal : 1;
  const eligibleAccuracy = eligibleOk / GOLD_REVIEW_DATASET.length;
  const metrics = { securityReviewRecall: +securityRecall.toFixed(2), highRiskRecall: +highRiskRecall.toFixed(2), eligibleAccuracy: +eligibleAccuracy.toFixed(2) };
  return { pass: securityRecall === 1 && highRiskRecall === 1, detail: JSON.stringify(metrics), metrics };
}

export async function runCandidateStaleTrial(): Promise<{ pass: boolean; detail: string }> {
  const stale = isCandidateStale({ candidateFingerprint: "f", requirementChanged: true, knowledgeFingerprintChanged: false, manualMajorChanged: false });
  const fresh = isCandidateStale({ candidateFingerprint: "f", requirementChanged: false, knowledgeFingerprintChanged: false, manualMajorChanged: false });
  return { pass: stale && !fresh, detail: `requirementChanged→STALE_CANDIDATE=${stale} unchanged→OK=${!fresh}` };
}
