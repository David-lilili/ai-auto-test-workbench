import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs-extra";
import path from "node:path";
import { evaluateRequirementFactEligibility, businessKnowledgeSemanticKey, authorityFor, type ApprovedRequirementFact } from "../src/requirements/knowledge-activation.js";
import { promoteFactToKnowledge, supersedeKnowledge, resolveReview, findBusinessKnowledge, reconcileScopedException, listPendingReviews, applyRequirementVersionChange, buildBusinessKnowledgeSnapshot, type KnowledgeStoreFile } from "../src/requirements/knowledge-store.js";
import { runKnowledgeDoctor, requirementKnowledgeDoctor, businessKnowledgeReady, buildTestDesignInput, traceForward, traceReverse } from "../src/requirements/knowledge-doctor.js";
import { buildKnowledgeContextSync, knowledgeVersionFingerprint } from "../src/requirements/knowledge-context.js";
import { analyzeRequirement } from "../src/requirements/pipeline.js";

function freshStore(): KnowledgeStoreFile {
  return { version: "1.0", knowledge: [], reviewQueue: [], reviews: [] };
}

function fact(id: string, reqId: string, opts: Partial<ApprovedRequirementFact> & { statement: string }): ApprovedRequirementFact {
  const now = new Date().toISOString();
  return {
    factId: id, requirementId: reqId, requirementVersion: "1.0",
    factType: "BUSINESS_RULE", canonicalStatement: opts.statement, structuredValue: {},
    origin: opts.origin ?? "EXPLICIT_REQUIREMENT", confidence: "HIGH",
    reviewStatus: opts.reviewStatus ?? "PENDING_REVIEW",
    provenance: { sourceId: reqId, sourceAnchor: opts.statement, requirementVersion: "1.0" },
    isSecurity: opts.isSecurity ?? false, status: opts.reviewStatus ?? "PENDING_REVIEW",
    createdAt: now, updatedAt: now
  };
}

// ============ A-F. eligibility / semantic key ============
test("A. fact eligibility explicit approved -> ELIGIBLE", () => {
  assert.equal(evaluateRequirementFactEligibility({ origin: "EXPLICIT_REQUIREMENT", approved: true, conflict: false, isSecurity: false }), "ELIGIBLE");
});
test("B. inference requires review", () => {
  assert.equal(evaluateRequirementFactEligibility({ origin: "AI_INFERENCE", approved: false, conflict: false, isSecurity: false }), "REVIEW_REQUIRED");
  assert.equal(evaluateRequirementFactEligibility({ origin: "AI_INFERENCE", approved: true, conflict: false, isSecurity: false }), "ELIGIBLE");
});
test("C. security requires review", () => {
  assert.equal(evaluateRequirementFactEligibility({ origin: "EXPLICIT_REQUIREMENT", approved: false, conflict: false, isSecurity: true }), "HUMAN_REVIEW_REQUIRED");
  assert.equal(evaluateRequirementFactEligibility({ origin: "EXPLICIT_REQUIREMENT", approved: true, conflict: false, isSecurity: true }), "ELIGIBLE");
});
test("D. rejected not promoted", () => {
  const store = freshStore();
  const o = promoteFactToKnowledge("", store, fact("R1", "R1", { statement: "x", reviewStatus: "REJECTED" }), { scope: { module: "WITHDRAW" }, relation: "IF_THEN", humanConfirmed: false });
  assert.equal(o.outcome, "ineligible");
});
test("E. conflict blocked", () => {
  const store = freshStore();
  promoteFactToKnowledge("", store, fact("C1", "R1", { statement: "KYC1 禁用该功能", reviewStatus: "APPROVED" }), { scope: { module: "WITHDRAW" }, relation: "IF_THEN", condition: "actor.kyc1", effect: "feature.enabled=false", humanConfirmed: true });
  const o2 = promoteFactToKnowledge("", store, fact("C2", "R2", { statement: "KYC1 启用该功能", reviewStatus: "APPROVED" }), { scope: { module: "WITHDRAW" }, relation: "IF_THEN", condition: "actor.kyc1", effect: "feature.enabled=true", humanConfirmed: true });
  assert.equal(o2.outcome, "conflict_blocked");
});
test("F. semantic key fixed 6 segments", () => {
  const k = businessKnowledgeSemanticKey({ scope: { module: "WITHDRAW" }, relation: "IF_THEN", condition: "address.noVerification=true", effect: "google2FA.required=false" });
  const parts = k.split("|");
  assert.equal(parts.length, 6);
  assert.equal(parts[4], "address_noverification_true");
  assert.equal(parts[5], "google2fa_required_false");
});

// ============ G-I. merge / provenance / scoped exception ============
test("G. duplicate merge SAME", () => {
  const store = freshStore();
  const o1 = promoteFactToKnowledge("", store, fact("D1", "R001", { statement: "免验证地址提现无需 Google 2FA", reviewStatus: "APPROVED" }), { scope: { module: "WITHDRAW" }, relation: "IF_THEN", condition: "address.noVerification=true", effect: "google2FA.required=false", humanConfirmed: true });
  const o2 = promoteFactToKnowledge("", store, fact("D2", "R014", { statement: "No-verification address bypasses Google 2FA", reviewStatus: "APPROVED" }), { scope: { module: "WITHDRAW" }, relation: "IF_THEN", condition: "address.noVerification=true", effect: "google2FA.required=false", humanConfirmed: true });
  assert.equal(o2.outcome, "merged");
  const kb = store.knowledge.find((x) => x.knowledgeId === o1.knowledgeId);
  assert.ok(kb && kb.requirementRefs.length >= 2);
});
test("H. provenance aggregation", () => {
  const store = freshStore();
  promoteFactToKnowledge("", store, fact("H1", "R_A", { statement: "提现需要 Google 2FA", reviewStatus: "APPROVED" }), { scope: { module: "WITHDRAW" }, relation: "IF_THEN", condition: "withdraw.submit", effect: "google2FA.required=true", humanConfirmed: true });
  const o2 = promoteFactToKnowledge("", store, fact("H2", "R_B", { statement: "withdraw requires 2FA", reviewStatus: "APPROVED" }), { scope: { module: "WITHDRAW" }, relation: "IF_THEN", condition: "withdraw.submit", effect: "google2FA.required=true", humanConfirmed: true });
  assert.equal(o2.outcome, "merged");
  assert.equal(store.knowledge[0].provenance.length, 2);
});
test("I. scoped exception general retained", () => {
  const store = freshStore();
  promoteFactToKnowledge("", store, fact("G1", "R_G", { statement: "所有提现都需要 Google 2FA", reviewStatus: "APPROVED" }), { scope: { module: "WITHDRAW" }, relation: "IF_THEN", condition: "withdraw.submit", effect: "google2FA.required=true", humanConfirmed: true });
  const exc = reconcileScopedException("", store, {
    generalCondition: "withdraw.submit", generalEffect: "google2FA.required=true",
    exceptionCondition: "address.noVerification=true", exceptionEffect: "google2FA.required=false",
    scope: { module: "WITHDRAW" }, sourceRequirementId: "R_EXC"
  });
  assert.equal(exc.reconciled, true);
  assert.ok(store.knowledge.some((k) => /所有提现都需要 Google 2FA/.test(k.canonicalConcept) && k.status === "ACTIVE"));
});

// ============ J-L. conflict / version / partial ============
test("J. true conflict", () => {
  const store = freshStore();
  promoteFactToKnowledge("", store, fact("J1", "R1", { statement: "KYC1 禁用该功能", reviewStatus: "APPROVED" }), { scope: { module: "WITHDRAW" }, relation: "IF_THEN", condition: "actor.kyc1", effect: "feature.enabled=false", humanConfirmed: true });
  const o2 = promoteFactToKnowledge("", store, fact("J2", "R2", { statement: "KYC1 启用该功能", reviewStatus: "APPROVED" }), { scope: { module: "WITHDRAW" }, relation: "IF_THEN", condition: "actor.kyc1", effect: "feature.enabled=true", humanConfirmed: true });
  assert.equal(o2.outcome, "conflict_blocked");
});
test("K. version supersede", () => {
  const store = freshStore();
  const o1 = promoteFactToKnowledge("", store, fact("K1", "R_V1", { statement: "所有用户可以开启免验证", reviewStatus: "APPROVED" }), { scope: { module: "WITHDRAW" }, relation: "IF_THEN", condition: "actor.all", effect: "feature.enabled=true", humanConfirmed: true });
  const sup = supersedeKnowledge("", store, o1.knowledgeId ?? "", "V2 修改");
  assert.ok(sup);
  assert.equal(store.knowledge.find((x) => x.knowledgeId === o1.knowledgeId)?.status, "SUPERSEDED");
  assert.equal(store.knowledge.find((x) => x.knowledgeId === sup?.newKnowledgeId)?.status, "ACTIVE");
});
test("L. partial requirement update only changed", () => {
  const store = freshStore();
  promoteFactToKnowledge("", store, fact("L1", "R_A", { statement: "免验证地址提现无需 2FA", reviewStatus: "APPROVED" }), { scope: { module: "WITHDRAW" }, relation: "IF_THEN", condition: "address.noVerification=true", effect: "google2FA.required=false", humanConfirmed: true });
  promoteFactToKnowledge("", store, fact("L2", "R_B", { statement: "提现需要 Google 2FA", reviewStatus: "APPROVED", isSecurity: false }), { scope: { module: "WITHDRAW" }, relation: "IF_THEN", condition: "withdraw.submit", effect: "google2FA.required=true", humanConfirmed: true });
  applyRequirementVersionChange("", store, ["R_A"]);
  assert.ok(store.knowledge.some((k) => /提现需要 Google 2FA/.test(k.canonicalConcept) && k.status === "ACTIVE"));
});

// ============ M-T. query / context ============
test("M. active query only ACTIVE", () => {
  const store = freshStore();
  const o = promoteFactToKnowledge("", store, fact("M1", "R_M", { statement: "免验证地址提现无需 2FA", reviewStatus: "APPROVED" }), { scope: { module: "WITHDRAW" }, relation: "IF_THEN", condition: "address.noVerification=true", effect: "google2FA.required=false", humanConfirmed: true });
  supersedeKnowledge("", store, o.knowledgeId ?? "", "v2");
  const active = findBusinessKnowledge(store, { domain: "WITHDRAW", status: "ACTIVE" });
  assert.ok(active.length >= 1 && active.every((k) => k.status === "ACTIVE"));
});
test("N. historical query SUPERSEDED", () => {
  const store = freshStore();
  const o = promoteFactToKnowledge("", store, fact("N1", "R_N", { statement: "所有用户可以开启免验证", reviewStatus: "APPROVED" }), { scope: { module: "WITHDRAW" }, relation: "IF_THEN", condition: "actor.all", effect: "feature.enabled=true", humanConfirmed: true });
  supersedeKnowledge("", store, o.knowledgeId ?? "", "v2");
  assert.ok(findBusinessKnowledge(store, { domain: "WITHDRAW", status: "SUPERSEDED" }).length >= 1);
});
test("O. domain filter", () => {
  const store = freshStore();
  promoteFactToKnowledge("", store, fact("O1", "R_O", { statement: "免验证地址提现无需 2FA", reviewStatus: "APPROVED" }), { scope: { module: "WITHDRAW" }, relation: "IF_THEN", condition: "a", effect: "b", humanConfirmed: true });
  promoteFactToKnowledge("", store, fact("O2", "R_O2", { statement: "KYC 完成才能提现", reviewStatus: "APPROVED" }), { scope: { module: "KYC" }, relation: "IF_THEN", condition: "c", effect: "d", humanConfirmed: true });
  assert.equal(findBusinessKnowledge(store, { domain: "WITHDRAW" }).length, 1);
  assert.equal(findBusinessKnowledge(store, { domain: "KYC" }).length, 1);
});
test("P. capability filter", () => {
  const store = freshStore();
  promoteFactToKnowledge("", store, fact("P1", "R_P", { statement: "免验证地址提现无需 2FA", reviewStatus: "APPROVED" }), { scope: { module: "WITHDRAW", capability: "NO_VERIFICATION_WITHDRAW" }, relation: "IF_THEN", condition: "a", effect: "b", humanConfirmed: true });
  assert.equal(findBusinessKnowledge(store, { domain: "WITHDRAW", capability: "NO_VERIFICATION_WITHDRAW" }).length, 1);
  assert.equal(findBusinessKnowledge(store, { domain: "WITHDRAW", capability: "OTHER" }).length, 0);
});
test("Q. concept filter", () => {
  const store = freshStore();
  promoteFactToKnowledge("", store, fact("Q1", "R_Q", { statement: "免验证地址提现无需 Google 2FA", reviewStatus: "APPROVED" }), { scope: { module: "WITHDRAW" }, relation: "IF_THEN", condition: "address.noVerification=true", effect: "google2FA.required=false", humanConfirmed: true });
  assert.equal(findBusinessKnowledge(store, { domain: "WITHDRAW", concepts: ["免验证"] }).length, 1);
});
test("R. context integration", () => {
  const tmp = path.join(process.cwd(), "storage/requirements/.test-ctx");
  const store = freshStore();
  promoteFactToKnowledge("", store, fact("R1", "R_CTX", { statement: "免验证地址提现无需 2FA", reviewStatus: "APPROVED" }), { scope: { module: "WITHDRAW" }, relation: "IF_THEN", condition: "address.noVerification=true", effect: "google2FA.required=false", humanConfirmed: true });
  const sp = path.join(tmp, "storage/business-knowledge/store.json");
  fs.ensureDirSync(path.dirname(sp));
  fs.writeJsonSync(sp, store);
  const ctx = buildKnowledgeContextSync(tmp, { domain: "WITHDRAW", concepts: ["免验证"] });
  assert.ok(ctx.included.length >= 1);
  assert.ok(ctx.provenanceLines.length >= 1);
  fs.removeSync(tmp);
});
test("S. snapshot security survives budget", () => {
  const store = freshStore();
  for (let i = 0; i < 12; i++) {
    promoteFactToKnowledge("", store, fact(`S${i}`, `R_S${i}`, { statement: `规则${i} 提现金额限制`, reviewStatus: "APPROVED" }), { scope: { module: "WITHDRAW" }, relation: "IF_THEN", condition: `amount>${i}`, effect: `limit=${i}`, humanConfirmed: true });
  }
  promoteFactToKnowledge("", store, fact("SEC", "R_SEC", { statement: "提现需要 Google 2FA", reviewStatus: "APPROVED", isSecurity: true }), { scope: { module: "WITHDRAW" }, relation: "IF_THEN", condition: "withdraw.submit", effect: "google2FA.required=true", humanConfirmed: false });
  const snap = buildBusinessKnowledgeSnapshot(store, { domain: "WITHDRAW", budgetLimit: 5 });
  assert.equal(snap.budget.securityCriticalIncluded, true);
});
test("T. critical security survives budget", () => {
  const store = freshStore();
  for (let i = 0; i < 10; i++) {
    promoteFactToKnowledge("", store, fact(`T${i}`, `R_T${i}`, { statement: `普通规则${i}`, reviewStatus: "APPROVED" }), { scope: { module: "WITHDRAW" }, relation: "IF_THEN", condition: `c${i}`, effect: `e${i}`, humanConfirmed: true });
  }
  promoteFactToKnowledge("", store, fact("TSEC", "R_TSEC", { statement: "KYC 用户必须 2FA", reviewStatus: "APPROVED", isSecurity: true }), { scope: { module: "WITHDRAW" }, relation: "IF_THEN", condition: "actor.kyc", effect: "google2FA.required=true", humanConfirmed: false });
  const snap = buildBusinessKnowledgeSnapshot(store, { domain: "WITHDRAW", budgetLimit: 5 });
  assert.equal(snap.budget.securityCriticalIncluded, true);
});

// ============ U-Y. doctors / traceability ============
test("U. requirement doctor orphan", () => {
  const store = freshStore();
  const model = analyzeRequirement({ sourceId: "R_ORPHAN", title: "孤儿", rawContent: "新增一个无法识别的功能" });
  const report = requirementKnowledgeDoctor(store, [{ ...model, status: "APPROVED" as const }]);
  assert.ok(report.issues.some((i) => i.includes("无 promoted eligible facts")));
});
test("V. knowledge doctor duplicate key", () => {
  const store = freshStore();
  promoteFactToKnowledge("", store, fact("V1", "R_V1", { statement: "免验证地址提现无需 2FA", reviewStatus: "APPROVED" }), { scope: { module: "WITHDRAW" }, relation: "IF_THEN", condition: "a", effect: "b", humanConfirmed: true });
  store.knowledge.push({ ...store.knowledge[0], knowledgeId: "KB-DUP", provenance: [{ sourceId: "R_X", sourceAnchor: "x", requirementVersion: "1.0", origin: "EXPLICIT_REQUIREMENT" }], requirementRefs: ["R_X"] });
  const report = runKnowledgeDoctor(store, ["R_V1", "R_X"]);
  assert.ok(report.multipleActiveSameKey.length >= 1);
});
test("W. security audit no review", () => {
  const store = freshStore();
  promoteFactToKnowledge("", store, fact("W1", "R_W", { statement: "提现需要 Google 2FA", reviewStatus: "APPROVED", isSecurity: true }), { scope: { module: "WITHDRAW" }, relation: "IF_THEN", condition: "withdraw.submit", effect: "google2FA.required=true", humanConfirmed: false });
  store.knowledge[0].status = "ACTIVE";
  const report = runKnowledgeDoctor(store, ["R_W"]);
  assert.ok(report.securityWithoutReview.length >= 1);
});
test("X. traceability forward", () => {
  const store = freshStore();
  promoteFactToKnowledge("", store, fact("X1", "R_X1", { statement: "免验证地址提现无需 2FA", reviewStatus: "APPROVED" }), { scope: { module: "WITHDRAW" }, relation: "IF_THEN", condition: "a", effect: "b", humanConfirmed: true });
  assert.ok(traceForward("R_X1", store).length >= 1);
});
test("Y. traceability reverse", () => {
  const store = freshStore();
  const o = promoteFactToKnowledge("", store, fact("Y1", "R_Y1", { statement: "免验证地址提现无需 2FA", reviewStatus: "APPROVED" }), { scope: { module: "WITHDRAW" }, relation: "IF_THEN", condition: "a", effect: "b", humanConfirmed: true });
  assert.ok(traceReverse(o.knowledgeId ?? "", store).requirementIds.includes("R_Y1"));
});

// ============ Z-AE. fingerprint / fresh / V2 / TDI ============
test("Z. context fingerprint changes", () => {
  const store = freshStore();
  const fp1 = knowledgeVersionFingerprint(store);
  promoteFactToKnowledge("", store, fact("Z1", "R_Z", { statement: "免验证地址提现无需 2FA", reviewStatus: "APPROVED" }), { scope: { module: "WITHDRAW" }, relation: "IF_THEN", condition: "a", effect: "b", humanConfirmed: true });
  const fp2 = knowledgeVersionFingerprint(store);
  assert.notEqual(fp1, fp2);
});
test("AA. fresh agent knowledge retrieval", () => {
  const tmp = path.join(process.cwd(), "storage/requirements/.test-fa");
  const store = freshStore();
  promoteFactToKnowledge("", store, fact("AA1", "R_AA", { statement: "免验证地址提现无需 2FA", reviewStatus: "APPROVED" }), { scope: { module: "WITHDRAW" }, relation: "IF_THEN", condition: "address.noVerification=true", effect: "google2FA.required=false", humanConfirmed: true });
  const sp = path.join(tmp, "storage/business-knowledge/store.json");
  fs.ensureDirSync(path.dirname(sp));
  fs.writeJsonSync(sp, store);
  const ctx = buildKnowledgeContextSync(tmp, { domain: "WITHDRAW", concepts: ["免验证"] });
  const rule = ctx.included.find((k) => /免验证|no.?verif/.test(k.canonicalConcept));
  assert.ok(rule);
  assert.ok(rule.provenance[0]?.sourceId === "R_AA");
  fs.removeSync(tmp);
});
test("AB. V2 trial", () => {
  const store = freshStore();
  const o1 = promoteFactToKnowledge("", store, fact("AB1", "R_V1", { statement: "所有用户可以开启免验证", reviewStatus: "APPROVED" }), { scope: { module: "WITHDRAW" }, relation: "IF_THEN", condition: "actor.all", effect: "feature.enabled=true", humanConfirmed: true });
  const fp1 = knowledgeVersionFingerprint(store);
  supersedeKnowledge("", store, o1.knowledgeId ?? "", "V2");
  const fp2 = knowledgeVersionFingerprint(store);
  assert.ok(findBusinessKnowledge(store, { domain: "WITHDRAW", status: "ACTIVE" }).length >= 1);
  assert.ok(fp1 !== fp2);
});
test("AC. inference trial", () => {
  const store = freshStore();
  const o = promoteFactToKnowledge("", store, fact("AC1", "R_AC", { statement: "修改备注后免验证失效", origin: "AI_INFERENCE", reviewStatus: "PENDING_REVIEW" }), { scope: { module: "WITHDRAW" }, relation: "IF_THEN", condition: "remark.modified", effect: "noVerification.invalidated", humanConfirmed: false });
  assert.equal(o.outcome, "ineligible");
  const q = store.reviewQueue.find((x) => x.knowledgeId === o.knowledgeId);
  assert.ok(q && q.category === "AI_INFERENCE");
  if (q) resolveReview(store, q.queueId, "APPROVE", "human");
  assert.equal(store.knowledge.find((x) => x.knowledgeId === o.knowledgeId)?.status, "ACTIVE");
});
test("AD. TestDesignInput", () => {
  const store = freshStore();
  const model = analyzeRequirement({ sourceId: "R_TDI", title: "提现地址管理", rawContent: "用户可添加白名单地址，白名单地址提现不需要 Google 2FA。用户修改备注后免验证失效。用户完成 KYC 后才能提现。" });
  const facts: ApprovedRequirementFact[] = model.businessRules.map((r, i) => fact(`TDI${i}`, "R_TDI", { statement: r.statement, reviewStatus: "APPROVED" }));
  const refs: string[] = [];
  for (const f of facts) {
    const o = promoteFactToKnowledge("", store, f, { scope: { module: "WITHDRAW" }, relation: "IF_THEN", condition: String(f.structuredValue.condition ?? ""), effect: String(f.structuredValue.effect ?? ""), humanConfirmed: true });
    if (o.knowledgeId) refs.push(o.knowledgeId);
  }
  const tdi = buildTestDesignInput({ requirement: model, approvedFacts: facts, knowledgeRefs: refs, contextFingerprint: "fp", store });
  assert.ok(tdi.approvedFacts.length >= 2);
  assert.ok(tdi.businessKnowledgeRefs.length >= 1);
});
test("businessKnowledgeReady security not ready", () => {
  const store = freshStore();
  const model = analyzeRequirement({ sourceId: "R_RDY", title: "t", rawContent: "提现需要 Google 2FA" });
  promoteFactToKnowledge("", store, fact("RDY1", "R_RDY", { statement: "提现需要 Google 2FA", reviewStatus: "PENDING_REVIEW", isSecurity: true }), { scope: { module: "WITHDRAW" }, relation: "IF_THEN", condition: "withdraw.submit", effect: "google2FA.required=true", humanConfirmed: false });
  const r = businessKnowledgeReady(store, model);
  assert.equal(r.ready, false);
  assert.ok(r.reasons.some((x) => x.includes("security")));
});
test("review queue categories", () => {
  const store = freshStore();
  promoteFactToKnowledge("", store, fact("Q1", "R_Q", { statement: "提现需要 2FA", reviewStatus: "PENDING_REVIEW", isSecurity: true }), { scope: { module: "WITHDRAW" }, relation: "IF_THEN", condition: "a", effect: "b", humanConfirmed: false });
  promoteFactToKnowledge("", store, fact("Q2", "R_Q2", { statement: "修改备注后失效", reviewStatus: "PENDING_REVIEW", origin: "AI_INFERENCE" }), { scope: { module: "WITHDRAW" }, relation: "IF_THEN", condition: "c", effect: "d", humanConfirmed: false });
  const pending = listPendingReviews(store);
  assert.ok(pending.some((q) => q.category === "SECURITY"));
  assert.ok(pending.some((q) => q.category === "AI_INFERENCE"));
});
test("authority levels", () => {
  assert.equal(authorityFor({ origin: "EXPLICIT_REQUIREMENT", humanConfirmed: false }), "REQUIREMENT_CONFIRMED");
  assert.equal(authorityFor({ origin: "AI_INFERENCE", humanConfirmed: false }), "INFERRED");
  assert.equal(authorityFor({ origin: "AI_INFERENCE", humanConfirmed: true }), "HUMAN_CONFIRMED");
  assert.equal(authorityFor({ origin: "AI_INFERENCE", humanConfirmed: false, executionSupported: true }), "EXECUTION_SUPPORTED");
});
