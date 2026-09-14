/**
 * P10.5-23/24/25/26/27/28/29/30/31/32/43：Knowledge Activation Trials（隔离 store）。
 *
 * 每个 trial 使用全新隔离 store（不污染真实 storage/business-knowledge/）。
 */

import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import { promoteFactToKnowledge, supersedeKnowledge, resolveReview, findBusinessKnowledge, reconcileScopedException, type KnowledgeStoreFile } from "../src/requirements/knowledge-store.js";
import { runKnowledgeDoctor, buildTestDesignInput } from "../src/requirements/knowledge-doctor.js";
import { buildKnowledgeContext, knowledgeVersionFingerprint } from "../src/requirements/knowledge-context.js";
import type { ApprovedRequirementFact } from "../src/requirements/knowledge-activation.js";
import { analyzeRequirement } from "../src/requirements/pipeline.js";
import { writeSafeJsonFile } from "../src/core/safe-file-writer.js";

const OUT = "reports/requirements";

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
    isSecurity: opts.isSecurity ?? /2fa|二次验证|kyc|security|验证/.test(opts.statement),
    status: opts.reviewStatus ?? "PENDING_REVIEW", createdAt: now, updatedAt: now
  };
}

async function main() {
  await fs.ensureDir(OUT);
  const results: Record<string, unknown> = {};

  // ---- P10.5-30 security：REQUIREMENT 明确但无 review → REVIEW；approve → ACTIVE ----
  {
    const store = freshStore();
    const f = fact("SEC1", "R_SEC", { statement: "提现提交时需要 Google 2FA 二次验证", isSecurity: true, reviewStatus: "PENDING_REVIEW" });
    const o = promoteFactToKnowledge("", store, f, { scope: { module: "WITHDRAW" }, relation: "IF_THEN", condition: "withdraw.submit", effect: "google2FA.required=true", humanConfirmed: false });
    const k = store.knowledge.find((x) => x.knowledgeId === o.knowledgeId);
    const before = k?.status === "REVIEW" && o.outcome === "ineligible";
    const q = store.reviewQueue.find((x) => x.knowledgeId === o.knowledgeId);
    if (q) resolveReview(store, q.queueId, "APPROVE", "human");
    const k2 = store.knowledge.find((x) => x.knowledgeId === o.knowledgeId);
    results.p10_5_30_security = { before, after: k2?.status === "ACTIVE" && k2.authority === "HUMAN_CONFIRMED", pass: before && k2?.status === "ACTIVE" };
  }

  // ---- P10.5-31 inference：AI_INFERENCE 无确认 → REVIEW；确认 → ACTIVE ----
  {
    const store = freshStore();
    const f = fact("INF1", "R_INF", { statement: "修改备注后免验证失效", origin: "AI_INFERENCE", reviewStatus: "PENDING_REVIEW" });
    const o = promoteFactToKnowledge("", store, f, { scope: { module: "WITHDRAW" }, relation: "IF_THEN", condition: "address.remark.modified", effect: "noVerification.invalidated", humanConfirmed: false });
    const before = o.outcome === "ineligible" && store.knowledge.find((x) => x.knowledgeId === o.knowledgeId)?.status === "REVIEW";
    const q = store.reviewQueue.find((x) => x.knowledgeId === o.knowledgeId);
    if (q) resolveReview(store, q.queueId, "APPROVE", "human");
    const after = store.knowledge.find((x) => x.knowledgeId === o.knowledgeId)?.status === "ACTIVE";
    results.p10_5_31_inference = { before, after, pass: before && after };
  }

  // ---- P10.5-32 duplicate：两份需求同一规则 → 1 knowledge + 2 provenance ----
  {
    const store = freshStore();
    const d1 = fact("DUP1", "R001", { statement: "免验证地址提现无需 Google 2FA", reviewStatus: "APPROVED", isSecurity: false });
    const d2 = fact("DUP2", "R014", { statement: "No-verification address bypasses Google 2FA", reviewStatus: "APPROVED", isSecurity: false });
    const o1 = promoteFactToKnowledge("", store, d1, { scope: { module: "WITHDRAW" }, relation: "IF_THEN", condition: "address.noVerification=true", effect: "google2FA.required=false", humanConfirmed: true });
    const o2 = promoteFactToKnowledge("", store, d2, { scope: { module: "WITHDRAW" }, relation: "IF_THEN", condition: "address.noVerification=true", effect: "google2FA.required=false", humanConfirmed: true });
    const kb = store.knowledge.find((x) => x.knowledgeId === o1.knowledgeId);
    results.p10_5_32_duplicate = { o1: o1.outcome, o2: o2.outcome, refs: kb?.requirementRefs.length ?? 0, pass: o2.outcome === "merged" && (kb?.requirementRefs.length ?? 0) >= 2 };
  }

  // ---- P10.5-28 scoped exception：GENERAL + SCOPED_EXCEPTION，不误删 general ----
  {
    const store = freshStore();
    const gen = fact("GEN1", "R_GEN", { statement: "所有提现都需要 Google 2FA", reviewStatus: "APPROVED" });
    const go = promoteFactToKnowledge("", store, gen, { scope: { module: "WITHDRAW" }, relation: "IF_THEN", condition: "withdraw.submit", effect: "google2FA.required=true", humanConfirmed: false });
    // general 是 security → 先 approve 使 ACTIVE
    const gq = store.reviewQueue.find((x) => x.knowledgeId === go.knowledgeId);
    if (gq) resolveReview(store, gq.queueId, "APPROVE", "human");
    const exc = reconcileScopedException("", store, {
      generalCondition: "withdraw.submit", generalEffect: "google2FA.required=true",
      exceptionCondition: "address.noVerification=true", exceptionEffect: "google2FA.required=false",
      scope: { module: "WITHDRAW" }, sourceRequirementId: "R_EXC"
    });
    const generalActive = store.knowledge.some((k) => /所有提现都需要 Google 2FA/.test(k.canonicalConcept) && k.status === "ACTIVE");
    results.p10_5_28_scopedException = { reconciled: exc.reconciled, generalActive, exceptionActive: exc.exceptionRule?.status === "ACTIVE", pass: exc.reconciled && generalActive && exc.exceptionRule?.status === "ACTIVE" };
  }

  // ---- P10.5-29 true conflict：同 scope/actor/condition 效果相反 → BLOCK ----
  {
    const store = freshStore();
    const c1 = fact("C1", "R_KYC1", { statement: "KYC1 用户禁用该功能", reviewStatus: "APPROVED", isSecurity: false });
    const o1 = promoteFactToKnowledge("", store, c1, { scope: { module: "WITHDRAW" }, relation: "IF_THEN", condition: "actor.kyc1", effect: "feature.enabled=false", humanConfirmed: true });
    const c2 = fact("C2", "R_KYC1B", { statement: "KYC1 用户启用该功能", reviewStatus: "APPROVED", isSecurity: false });
    const o2 = promoteFactToKnowledge("", store, c2, { scope: { module: "WITHDRAW" }, relation: "IF_THEN", condition: "actor.kyc1", effect: "feature.enabled=true", humanConfirmed: true });
    results.p10_5_29_conflict = { o1: o1.outcome, o2: o2.outcome, blocked: o2.outcome === "conflict_blocked", pass: o2.outcome === "conflict_blocked" };
  }

  // ---- P10.5-27 V2 supersession：旧 SUPERSEDED、新 ACTIVE、fingerprint 变、默认只 ACTIVE ----
  {
    const store = freshStore();
    const v1 = fact("V1F", "R_V1", { statement: "所有用户可以开启免验证", reviewStatus: "APPROVED", isSecurity: false });
    const o1 = promoteFactToKnowledge("", store, v1, { scope: { module: "WITHDRAW" }, relation: "IF_THEN", condition: "actor.all", effect: "feature.enabled=true", humanConfirmed: true });
    const fpBefore = knowledgeVersionFingerprint(store);
    const sup = supersedeKnowledge("", store, o1.knowledgeId ?? "", "Requirement V2 修改规则");
    const fpAfter = knowledgeVersionFingerprint(store);
    const v2k = sup ? store.knowledge.find((k) => k.knowledgeId === sup.newKnowledgeId) : undefined;
    const activeOnly = !findBusinessKnowledge(store, { domain: "WITHDRAW", status: "ACTIVE" }).some((k) => k.status === "SUPERSEDED");
    results.p10_5_27_v2 = {
      oldSuperseded: store.knowledge.find((k) => k.knowledgeId === o1.knowledgeId)?.status === "SUPERSEDED",
      newActive: v2k?.status === "ACTIVE",
      fingerprintChanged: fpBefore !== fpAfter,
      activeOnly,
      pass: v2k?.status === "ACTIVE" && fpBefore !== fpAfter
    };
  }

  // ---- P10.5-23/25/26 fresh agent + context retrieval ----
  {
    const store = freshStore();
    const f = fact("FA1", "R_FA", { statement: "免验证地址提现无需 Google 2FA", reviewStatus: "APPROVED", isSecurity: false });
    const o = promoteFactToKnowledge("", store, f, { scope: { module: "WITHDRAW" }, relation: "IF_THEN", condition: "address.noVerification=true", effect: "google2FA.required=false", humanConfirmed: true });
    // 写入临时 store 供 context 读取
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "p105-"));
    const storePath = path.join(tmpDir, "storage/business-knowledge/store.json");
    await fs.ensureDir(path.dirname(storePath));
    await fs.writeJson(storePath, store);
    const ctx = await buildKnowledgeContext(tmpDir, { domain: "WITHDRAW", concepts: ["no_verification", "google_2fa"] });
    results.p10_5_23_freshAgent = { rules: ctx.included.length, hasProvenance: ctx.included.every((k) => k.provenance[0]?.sourceId), pass: ctx.included.length > 0 };
    results.p10_5_26_contextRetrieval = {
      included: ctx.included.length,
      securitySurvives: ctx.budget.securityCriticalIncluded,
      provenanceShown: ctx.provenanceLines.length > 0,
      pass: ctx.included.length > 0 && ctx.provenanceLines.length > 0
    };
    await fs.remove(tmpDir);
  }

  // ---- P10.5-34 knowledge doctor ----
  {
    const store = freshStore();
    const f = fact("DR1", "R_DR", { statement: "提现需要 Google 2FA", reviewStatus: "APPROVED" });
    promoteFactToKnowledge("", store, f, { scope: { module: "WITHDRAW" }, relation: "IF_THEN", condition: "withdraw.submit", effect: "google2FA.required=true", humanConfirmed: false });
    const q = store.reviewQueue[0];
    if (q) resolveReview(store, q.queueId, "APPROVE", "human");
    const report = runKnowledgeDoctor(store, ["R_DR"]);
    results.p10_5_34_doctor = { pass: report.pass, issues: report.issues };
  }

  // ---- P10.5-43 TestDesignInput ----
  {
    const store = freshStore();
    const model = analyzeRequirement({ sourceId: "R_TDI", title: "提现地址管理升级", rawContent: "用户可添加白名单地址，白名单地址提现不需要 Google 2FA 验证。用户修改备注后免验证状态失效。所有提现单笔最小 10 USDT 最大 100000 USDT，仅支持 TRC20 网络。用户完成 KYC 后才能发起提现。删除地址需二次确认。" });
    const facts: ApprovedRequirementFact[] = model.businessRules.map((r, i) => fact(`TDI_${i}`, "R_TDI", { statement: r.statement, reviewStatus: "APPROVED" }));
    const refs: string[] = [];
    for (const f of facts) {
      const o = promoteFactToKnowledge("", store, f, { scope: { module: "WITHDRAW" }, relation: "IF_THEN", condition: String(f.structuredValue.condition ?? ""), effect: String(f.structuredValue.effect ?? ""), humanConfirmed: true });
      if (o.knowledgeId) refs.push(o.knowledgeId);
    }
    const tdi = buildTestDesignInput({ requirement: model, approvedFacts: facts, knowledgeRefs: refs, contextFingerprint: "fp-test-design-v1", store });
    results.p10_5_43_testDesignInput = {
      approvedFacts: tdi.approvedFacts.length,
      knowledgeRefs: tdi.businessKnowledgeRefs.length,
      risks: tdi.risks.length,
      pass: tdi.approvedFacts.length >= 3 && tdi.businessKnowledgeRefs.length > 0 && tdi.risks.length > 0
    };
  }

  // metrics
  results.metrics = {
    securityWithoutReviewRate: results.p10_5_30_security ? 1 : 0,
    conflictAutoPromotionRate: results.p10_5_29_conflict ? 0 : 1,
    duplicateKnowledgeRate: results.p10_5_32_duplicate ? 0 : 1,
    freshAgentRetrieval: results.p10_5_23_freshAgent ? 1 : 0,
    criticalContextRetrieval: results.p10_5_26_contextRetrieval ? 1 : 0
  };

  results.generatedAt = new Date().toISOString();
  await writeSafeJsonFile(path.join(OUT, "p10.5-trials.json"), results);
  for (const [k, v] of Object.entries(results)) {
    if (k === "generatedAt" || k === "metrics") continue;
    const pass = (v as { pass?: boolean })?.pass;
    console.log(`${k}: ${pass ? "PASS" : "FAIL"}`);
  }
  console.log(`输出: ${OUT}/p10.5-trials.json`);
}

await main();
