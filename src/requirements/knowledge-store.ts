/**
 * P10.5-4/7/8/9/14/15/17：Business Knowledge Store + Merge + Versioning + Review Queue。
 *
 * - storage/business-knowledge/：rules/constraints/dependencies/states/security/capabilities
 * - semanticKey 去重：SAME → 追加 provenance；NEW → 创建；CONFLICT → review；POSSIBLE → 不自动 merge
 * - versioning：KB v1 → SUPERSEDED → v2（不 overwrite）
 * - supersession propagation：Requirement V2 diff 只影响变化的 fact（不全量失效）
 * - scoped exception：GENERAL + SCOPED_EXCEPTION 可 reconcile，不误删 general rule
 * - review queue：NEW_RULE / RULE_UPDATE / SCOPED_EXCEPTION / CONFLICT / SECURITY / AI_INFERENCE
 */

import fs from "fs-extra";
import path from "node:path";
import crypto from "node:crypto";
import type { BusinessKnowledge, FactEligibility, KnowledgeStatus } from "./knowledge-activation.js";
import { authorityFor, businessKnowledgeSemanticKey, matchKnowledgeIdentity, type ApprovedRequirementFact } from "./knowledge-activation.js";

export interface KnowledgeStoreFile {
  version: string;
  knowledge: BusinessKnowledge[];
  reviewQueue: Array<{
    queueId: string;
    category: "NEW_RULE" | "RULE_UPDATE" | "SCOPED_EXCEPTION" | "CONFLICT" | "SECURITY" | "AI_INFERENCE";
    knowledgeId?: string;
    factId?: string;
    requirementId: string;
    reason: string;
    status: "PENDING" | "RESOLVED";
    createdAt: string;
    resolvedAt?: string;
  }>;
  reviews: Array<{ reviewId: string; knowledgeId: string; decision: string; reason: string; reviewer: string; timestamp: string; before?: unknown; after?: unknown }>;
}

export function knowledgeStorePath(rootDir: string): string {
  return path.join(rootDir, "storage/business-knowledge/store.json");
}

export async function loadKnowledgeStore(rootDir: string): Promise<KnowledgeStoreFile> {
  const p = knowledgeStorePath(rootDir);
  if (!(await fs.pathExists(p))) return { version: "1.0", knowledge: [], reviewQueue: [], reviews: [] };
  return fs.readJson(p) as Promise<KnowledgeStoreFile>;
}

export async function saveKnowledgeStore(rootDir: string, store: KnowledgeStoreFile, reason: string): Promise<void> {
  const p = knowledgeStorePath(rootDir);
  await fs.ensureDir(path.dirname(p));
  // audit backup（可回滚，不静默覆盖）
  const backupDir = path.join(rootDir, "storage/business-knowledge/backups");
  await fs.ensureDir(backupDir);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  await fs.writeJson(path.join(backupDir, `kb-${stamp}-${reason}.json`), store, { spaces: 2 });
  await fs.writeJson(p, store, { spaces: 2 });
}

// ============ P10.5-2/3：fact → eligibility ============

export function eligibilityForFact(fact: ApprovedRequirementFact, conflict: boolean, humanConfirmed: boolean): FactEligibility {
  // security 必须人工确认（即使 EXPLICIT）
  if (fact.isSecurity && fact.reviewStatus !== "APPROVED" && fact.reviewStatus !== "EDIT_APPROVED") return "HUMAN_REVIEW_REQUIRED";
  if (fact.origin === "AI_INFERENCE" && fact.reviewStatus !== "APPROVED" && fact.reviewStatus !== "EDIT_APPROVED") return "REVIEW_REQUIRED";
  if (fact.reviewStatus === "REJECTED") return "REJECT";
  if (conflict) return "BLOCKED";
  if (fact.reviewStatus === "APPROVED" || fact.reviewStatus === "EDIT_APPROVED" || humanConfirmed) return "ELIGIBLE";
  return "REVIEW_REQUIRED";
}

// ============ P10.5-7：promote fact → knowledge（merge / new / conflict） ============

export interface PromotionOutcome {
  outcome: "promoted" | "merged" | "conflict_blocked" | "ineligible" | "possible_same_no_auto_merge";
  knowledgeId?: string;
  reason: string;
  conflictExistingKey?: string;
}

export function promoteFactToKnowledge(rootDir: string, store: KnowledgeStoreFile, fact: ApprovedRequirementFact, input: {
  scope: BusinessKnowledge["scope"];
  relation?: BusinessKnowledge["relation"];
  sourceConcept?: string;
  targetConcept?: string;
  condition?: string;
  effect?: string;
  humanConfirmed: boolean;
  reviewer?: string;
}): PromotionOutcome {
  const eligibility = eligibilityForFact(fact, false, input.humanConfirmed);
  // 无 condition/effect 的 fact（如 AC）用 canonicalStatement 保证 semanticKey 唯一
  const effCondition = input.condition || (fact.factType === "ACCEPTANCE_CRITERION" ? fact.canonicalStatement : undefined);
  const effEffect = input.effect || (fact.factType === "ACCEPTANCE_CRITERION" ? fact.canonicalStatement : undefined);
  const semKey = businessKnowledgeSemanticKey({ scope: input.scope, relation: input.relation, condition: effCondition, effect: effEffect, sourceConcept: input.sourceConcept, targetConcept: input.targetConcept });
  const match = matchKnowledgeIdentity({ scope: input.scope, relation: input.relation, condition: effCondition, effect: effEffect }, store.knowledge);

  if (match.match === "CONFLICT") {
    store.reviewQueue.push({ queueId: `q_${crypto.randomUUID().slice(0, 8)}`, category: "CONFLICT", factId: fact.factId, requirementId: fact.requirementId, reason: `与 ${match.existingKey} 冲突`, status: "PENDING", createdAt: new Date().toISOString() });
    return { outcome: "conflict_blocked", reason: `CONFLICT vs ${match.existingKey}`, conflictExistingKey: match.existingKey };
  }

  // P10.5-13/30/31：security / inference 未确认 → 创建 REVIEW 状态 knowledge（不静默丢弃，approve 后 ACTIVE）
  if (eligibility !== "ELIGIBLE") {
    const reviewStatus: KnowledgeStatus = "REVIEW";
    const knowledgeId = newKnowledgeId(store, fact);
    const knowledge: BusinessKnowledge = {
      knowledgeId,
      canonicalConcept: fact.canonicalStatement.slice(0, 60),
      knowledgeType: fact.factType,
      scope: input.scope,
      structuredValue: { condition: effCondition, effect: effEffect, relation: input.relation },
      relation: input.relation,
      status: reviewStatus,
      authority: authorityFor({ origin: fact.origin, humanConfirmed: input.humanConfirmed }),
      provenance: [{ sourceId: fact.provenance.sourceId, sourceAnchor: fact.provenance.sourceAnchor, requirementVersion: fact.requirementVersion, origin: fact.origin }],
      requirementRefs: [fact.requirementId],
      verificationHistory: [{ action: "proposal", timestamp: new Date().toISOString(), detail: `proposed (review required): ${eligibility}` }],
      version: "v1",
      semanticKey: semKey,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    store.knowledge.push(knowledge);
    const category = fact.isSecurity ? "SECURITY" : fact.origin === "AI_INFERENCE" ? "AI_INFERENCE" : "NEW_RULE";
    store.reviewQueue.push({ queueId: `q_${crypto.randomUUID().slice(0, 8)}`, category, knowledgeId, factId: fact.factId, requirementId: fact.requirementId, reason: `${category} fact ${fact.factId} 需人工 review（eligibility=${eligibility}）`, status: "PENDING", createdAt: new Date().toISOString() });
    return { outcome: "ineligible", knowledgeId, reason: `eligibility=${eligibility}（REVIEW 待人工）` };
  }

  if (match.match === "SAME_KNOWLEDGE" && match.existing) {
    // merge：追加 provenance + requirementRef + reviewEvidence，不重复创建
    match.existing.provenance.push({ sourceId: fact.provenance.sourceId, sourceAnchor: fact.provenance.sourceAnchor, requirementVersion: fact.requirementVersion, origin: fact.origin });
    match.existing.requirementRefs = [...new Set([...match.existing.requirementRefs, fact.requirementId])];
    match.existing.updatedAt = new Date().toISOString();
    return { outcome: "merged", knowledgeId: match.existing.knowledgeId, reason: "semanticKey SAME → 追加 provenance" };
  }

  if (match.match === "POSSIBLE_SAME") {
    store.reviewQueue.push({ queueId: `q_${crypto.randomUUID().slice(0, 8)}`, category: "RULE_UPDATE", factId: fact.factId, requirementId: fact.requirementId, reason: `POSSIBLE_SAME 不自动 merge（vs ${match.existingKey}）`, status: "PENDING", createdAt: new Date().toISOString() });
    return { outcome: "possible_same_no_auto_merge", reason: `POSSIBLE_SAME vs ${match.existingKey}` };
  }

  // NEW → 创建 knowledge
  const knowledgeId = newKnowledgeId(store, fact);
  const knowledge: BusinessKnowledge = {
    knowledgeId,
    canonicalConcept: fact.canonicalStatement.slice(0, 60),
    knowledgeType: fact.factType,
    scope: input.scope,
    structuredValue: { condition: effCondition, effect: effEffect, relation: input.relation, sourceConcept: input.sourceConcept, targetConcept: input.targetConcept },
    relation: input.relation,
    status: fact.isSecurity ? "REVIEW" : "ACTIVE",
    authority: authorityFor({ origin: fact.origin, humanConfirmed: input.humanConfirmed }),
    provenance: [{ sourceId: fact.provenance.sourceId, sourceAnchor: fact.provenance.sourceAnchor, requirementVersion: fact.requirementVersion, origin: fact.origin }],
    requirementRefs: [fact.requirementId],
    verificationHistory: [{ action: "promotion", timestamp: new Date().toISOString(), detail: `promoted from ${fact.factId}` }],
    version: "v1",
    semanticKey: semKey,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  store.knowledge.push(knowledge);
  if (fact.isSecurity) {
    store.reviewQueue.push({ queueId: `q_${crypto.randomUUID().slice(0, 8)}`, category: "SECURITY", knowledgeId, factId: fact.factId, requirementId: fact.requirementId, reason: "security knowledge 需人工 review", status: "PENDING", createdAt: new Date().toISOString() });
  }
  return { outcome: "promoted", knowledgeId, reason: "NEW → created" };
}

/** 生成稳定 knowledgeId（按类型前缀 + 序号）。 */
function newKnowledgeId(store: KnowledgeStoreFile, fact: ApprovedRequirementFact): string {
  const prefix = fact.factType === "SECURITY_REQUIREMENT" ? "SEC" : fact.factType === "BUSINESS_RULE" ? "RULE" : fact.factType === "ACCEPTANCE_CRITERION" ? "ACC" : fact.factType.slice(0, 3);
  // 用 max 现有序号 +1（避免 startsWith 前缀 bug 导致重复 id）
  let max = 0;
  for (const k of store.knowledge) {
    if (!k.knowledgeId.startsWith(`KB-${prefix}-`)) continue;
    const num = parseInt(k.knowledgeId.slice(`KB-${prefix}-`.length), 10);
    if (!Number.isNaN(num) && num > max) max = num;
  }
  return `KB-${prefix}-${String(max + 1).padStart(3, "0")}`;
}

// ============ P10.5-8/9：versioning + supersession ============

export function supersedeKnowledge(rootDir: string, store: KnowledgeStoreFile, knowledgeId: string, reason: string): { newKnowledgeId: string } | undefined {
  const idx = store.knowledge.findIndex((k) => k.knowledgeId === knowledgeId && k.status === "ACTIVE");
  if (idx < 0) return undefined;
  const old = store.knowledge[idx];
  old.status = "SUPERSEDED";
  old.supersededBy = `${old.knowledgeId}-v2`;
  old.updatedAt = new Date().toISOString();
  // 新版本（copy，version bump）
  const v2: BusinessKnowledge = { ...old, knowledgeId: `${old.knowledgeId}-v2`, version: "v2", status: "ACTIVE", supersedes: old.knowledgeId, supersededBy: undefined, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), verificationHistory: [...old.verificationHistory, { action: "supersede", timestamp: new Date().toISOString(), detail: reason }] };
  store.knowledge.push(v2);
  return { newKnowledgeId: v2.knowledgeId };
}

/** P10.5-9：Requirement V2 只失效 diff 确认变化的 fact（不全量）。 */
export function applyRequirementVersionChange(rootDir: string, store: KnowledgeStoreFile, changedFactIds: string[]): void {
  // 迭代快照，避免 supersede 新增元素导致无限循环
  const snapshot = [...store.knowledge];
  for (const k of snapshot) {
    if (k.status !== "ACTIVE") continue;
    if (changedFactIds.some((fid) => k.requirementRefs.some((r) => r.includes(fid)) || k.provenance.some((p) => p.sourceAnchor.includes(fid) || p.sourceId.includes(fid)))) {
      supersedeKnowledge(rootDir, store, k.knowledgeId, `Requirement 变更影响 ${k.knowledgeId}`);
    }
  }
}

// ============ P10.5-14：scoped exception ============

export interface ScopedExceptionResult {
  generalRule?: BusinessKnowledge;
  exceptionRule?: BusinessKnowledge;
  reconciled: boolean;
  reason: string;
}

/** GENERAL_RULE + SCOPED_EXCEPTION 可 reconcile：general 保留，新增 exception。 */
export function reconcileScopedException(rootDir: string, store: KnowledgeStoreFile, input: {
  generalCondition: string; generalEffect: string;
  exceptionCondition: string; exceptionEffect: string;
  scope: BusinessKnowledge["scope"];
  sourceRequirementId: string;
}): ScopedExceptionResult {
  const generalKey = businessKnowledgeSemanticKey({ scope: input.scope, relation: "IF_THEN", condition: input.generalCondition, effect: input.generalEffect });
  const general = store.knowledge.find((k) => k.semanticKey === generalKey && k.status === "ACTIVE");
  if (!general) {
    // 无 general rule → 无法 reconcile，进入 review
    store.reviewQueue.push({ queueId: `q_${crypto.randomUUID().slice(0, 8)}`, category: "CONFLICT", requirementId: input.sourceRequirementId, reason: "无 general rule 可 reconcile，需 review", status: "PENDING", createdAt: new Date().toISOString() });
    return { reconciled: false, reason: "no general rule to reconcile" };
  }
  const exception: BusinessKnowledge = {
    ...general,
    knowledgeId: `${general.knowledgeId}-EXC`,
    canonicalConcept: `SCOPED_EXCEPTION: ${input.exceptionCondition} → ${input.exceptionEffect}`,
    structuredValue: { condition: input.exceptionCondition, effect: input.exceptionEffect, relation: "IF_THEN", isScopedException: true },
    scope: { ...input.scope, capability: `${input.scope.capability ?? "default"}_NO_VERIFICATION` },
    status: "ACTIVE",
    authority: "REQUIREMENT_CONFIRMED",
    provenance: [{ sourceId: input.sourceRequirementId, sourceAnchor: input.exceptionCondition, requirementVersion: "1.0", origin: "EXPLICIT_REQUIREMENT" }],
    requirementRefs: [input.sourceRequirementId],
    version: "v1",
    semanticKey: businessKnowledgeSemanticKey({ scope: { ...input.scope, capability: `${input.scope.capability ?? "default"}_NO_VERIFICATION` }, relation: "IF_THEN", condition: input.exceptionCondition, effect: input.exceptionEffect }),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  store.knowledge.push(exception);
  return { generalRule: general, exceptionRule: exception, reconciled: true, reason: "general + scoped exception reconciled" };
}

// ============ P10.5-15：review queue 操作 ============

export function listPendingReviews(store: KnowledgeStoreFile): KnowledgeStoreFile["reviewQueue"] {
  return store.reviewQueue.filter((q) => q.status === "PENDING");
}

export function resolveReview(store: KnowledgeStoreFile, queueId: string, decision: string, reviewer: string): boolean {
  const q = store.reviewQueue.find((x) => x.queueId === queueId);
  if (!q || q.status === "RESOLVED") return false;
  q.status = "RESOLVED";
  q.resolvedAt = new Date().toISOString();
  if (q.knowledgeId && decision === "APPROVE") {
    const k = store.knowledge.find((x) => x.knowledgeId === q.knowledgeId);
    if (k && k.status === "REVIEW") { k.status = "ACTIVE"; k.authority = "HUMAN_CONFIRMED"; k.updatedAt = new Date().toISOString(); }
  }
  store.reviews.push({ reviewId: `rv_${crypto.randomUUID().slice(0, 8)}`, knowledgeId: q.knowledgeId ?? q.factId ?? "", decision, reason: q.reason, reviewer, timestamp: new Date().toISOString() });
  return true;
}

/** P10.5-21：deterministic query。 */
export function findBusinessKnowledge(store: KnowledgeStoreFile, input: { domain?: string; concepts?: string[]; relation?: string; actor?: string; security?: boolean; status?: KnowledgeStatus; capability?: string }): BusinessKnowledge[] {
  return store.knowledge.filter((k) => {
    if (input.status && k.status !== input.status) return false;
    if (input.domain && k.scope.module.toLowerCase() !== input.domain.toLowerCase()) return false;
    if (input.capability && k.scope.capability !== input.capability) return false;
    if (input.actor && k.scope.actor !== input.actor) return false;
    if (input.security !== undefined && input.security && k.knowledgeType !== "SECURITY_REQUIREMENT" && !k.structuredValue.effect?.toString().toLowerCase().includes("2fa") && !k.structuredValue.condition?.toString().toLowerCase().includes("2fa")) return false;
    if (input.relation && k.relation !== input.relation) return false;
    if (input.concepts?.length) {
      const text = `${k.canonicalConcept} ${JSON.stringify(k.structuredValue)} ${k.scope.module} ${k.scope.capability ?? ""}`.toLowerCase();
      if (!input.concepts.some((c) => text.includes(c.toLowerCase()))) return false;
    }
    return true;
  });
}

// ============ P10.5-38/39：snapshot ============

export interface BusinessKnowledgeSnapshot {
  domain: string;
  relevantRules: BusinessKnowledge[];
  constraints: BusinessKnowledge[];
  dependencies: BusinessKnowledge[];
  security: BusinessKnowledge[];
  states: BusinessKnowledge[];
  budget: { total: number; included: number; securityCriticalIncluded: boolean };
}

export function buildBusinessKnowledgeSnapshot(store: KnowledgeStoreFile, input: { domain: string; concepts?: string[]; budgetLimit?: number }): BusinessKnowledgeSnapshot {
  const active = store.knowledge.filter((k) => k.status === "ACTIVE" && k.scope.module.toLowerCase() === input.domain.toLowerCase());
  const security = active.filter((k) => k.knowledgeType === "SECURITY_REQUIREMENT" || /2fa|kyc|security/.test(k.canonicalConcept));
  const rules = active.filter((k) => k.knowledgeType === "BUSINESS_RULE");
  const constraints = active.filter((k) => k.knowledgeType === "CONSTRAINT");
  const dependencies = active.filter((k) => k.knowledgeType === "DEPENDENCY");
  const states = active.filter((k) => k.knowledgeType === "STATE_TRANSITION");
  const budgetLimit = input.budgetLimit ?? 50;
  // 排序：exact concept > security > dependency > related
  const rank = (k: BusinessKnowledge) => {
    const text = `${k.canonicalConcept} ${JSON.stringify(k.structuredValue)}`.toLowerCase();
    const exact = input.concepts?.some((c) => text.includes(c.toLowerCase())) ? 0 : 2;
    const sec = k.knowledgeType === "SECURITY_REQUIREMENT" ? 0 : 1;
    return exact + sec * 3;
  };
  const all = [...rules, ...constraints, ...dependencies, ...states].sort((a, b) => rank(a) - rank(b));
  const included = all.slice(0, budgetLimit);
  const securityCriticalIncluded = security.every((s) => included.some((i) => i.knowledgeId === s.knowledgeId) || included.some((i) => i.knowledgeId === s.knowledgeId || i.semanticKey === s.semanticKey));
  return { domain: input.domain, relevantRules: rules, constraints, dependencies, security, states, budget: { total: all.length, included: included.length, securityCriticalIncluded: securityCriticalIncluded || security.length === 0 } };
}
