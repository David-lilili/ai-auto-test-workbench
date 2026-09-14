/**
 * P10.5-33/34/35/36/40/41/42：Knowledge Doctor + Traceability + Readiness + TestDesignInput。
 */

import crypto from "node:crypto";
import type { ApprovedRequirementFact, BusinessKnowledge } from "./knowledge-activation.js";
import type { KnowledgeStoreFile } from "./knowledge-store.js";
import type { RequirementModel } from "./types.js";

// ============ P10.5-34：Business Knowledge Doctor ============

export interface KnowledgeDoctorReport {
  pass: boolean;
  issues: string[];
  duplicateSemanticKeys: string[];
  conflicts: string[];
  brokenProvenance: string[];
  versionCycles: string[];
  multipleActiveSameKey: string[];
  securityWithoutReview: string[];
  orphanRequirementRefs: string[];
  supersededButActive: string[];
}

export function runKnowledgeDoctor(store: KnowledgeStoreFile, knownRequirementIds: string[]): KnowledgeDoctorReport {
  const report: KnowledgeDoctorReport = { pass: true, issues: [], duplicateSemanticKeys: [], conflicts: [], brokenProvenance: [], versionCycles: [], multipleActiveSameKey: [], securityWithoutReview: [], orphanRequirementRefs: [], supersededButActive: [] };

  const seen = new Map<string, string[]>();
  for (const k of store.knowledge) {
    if (!k.provenance?.length || k.provenance.some((p) => !p.sourceId || !p.sourceAnchor)) { report.brokenProvenance.push(k.knowledgeId); report.pass = false; }
    if (k.requirementRefs?.some((r) => !knownRequirementIds.includes(r))) { report.orphanRequirementRefs.push(k.knowledgeId); report.pass = false; }
    if (k.status === "SUPERSEDED" && k.supersededBy === undefined) { report.supersededButActive.push(k.knowledgeId); report.pass = false; }
    // duplicate semantic key（ACTIVE 多个同 key）
    const list = seen.get(k.semanticKey) ?? [];
    list.push(k.knowledgeId);
    seen.set(k.semanticKey, list);
    // security without review
    if ((k.knowledgeType === "SECURITY_REQUIREMENT" || /2fa|kyc/i.test(k.canonicalConcept)) && k.status === "ACTIVE" && k.authority === "REQUIREMENT_CONFIRMED") {
      report.securityWithoutReview.push(k.knowledgeId);
      report.pass = false;
    }
  }
  for (const [key, ids] of seen) {
    if (ids.length > 1) {
      const activeCount = ids.filter((id) => store.knowledge.find((k) => k.knowledgeId === id)?.status === "ACTIVE").length;
      report.duplicateSemanticKeys.push(key);
      if (activeCount > 1) { report.multipleActiveSameKey.push(key); report.pass = false; }
    }
  }
  // version cycle（v1→v2→v1）
  for (const k of store.knowledge) {
    let cur = k.supersededBy;
    let depth = 0;
    while (cur && depth < 10) {
      if (cur === k.knowledgeId) { report.versionCycles.push(k.knowledgeId); report.pass = false; break; }
      const next = store.knowledge.find((x) => x.knowledgeId === cur);
      cur = next?.supersededBy;
      depth += 1;
    }
  }
  report.issues = [...report.brokenProvenance, ...report.orphanRequirementRefs, ...report.multipleActiveSameKey, ...report.versionCycles, ...report.securityWithoutReview];
  return report;
}

// ============ P10.5-33：Requirement Doctor 增强 ============

export function requirementKnowledgeDoctor(store: KnowledgeStoreFile, requirements: RequirementModel[]): { issues: string[]; pass: boolean } {
  const issues: string[] = [];
  const approvedReqIds = new Set(requirements.filter((m) => m.status === "APPROVED").map((m) => m.requirementId));
  for (const id of approvedReqIds) {
    // approved requirement 但无 promoted eligible facts
    const promoted = store.knowledge.filter((k) => k.requirementRefs.includes(id) && k.status === "ACTIVE");
    if (promoted.length === 0) issues.push(`approved requirement ${id} 但无 promoted eligible facts`);
  }
  // orphan knowledge proposal（knowledge 引用不存在的 requirement）
  for (const k of store.knowledge) {
    for (const ref of k.requirementRefs) {
      if (!requirements.some((m) => m.requirementId === ref)) issues.push(`knowledge ${k.knowledgeId} 引用不存在的 requirement ${ref}`);
    }
  }
  return { issues, pass: issues.length === 0 };
}

// ============ P10.5-36：Traceability ============

export interface Traceability {
  requirement: { requirementId: string; factIds: string[]; knowledgeIds: string[] };
  knowledgeReverse: { knowledgeId: string; requirementIds: string[]; factIds: string[] };
}

export function traceForward(requirementId: string, store: KnowledgeStoreFile): string[] {
  return store.knowledge.filter((k) => k.requirementRefs.includes(requirementId)).map((k) => k.knowledgeId);
}

export function traceReverse(knowledgeId: string, store: KnowledgeStoreFile): { knowledgeId: string; requirementIds: string[] } {
  const k = store.knowledge.find((x) => x.knowledgeId === knowledgeId);
  return { knowledgeId, requirementIds: k?.requirementRefs ?? [] };
}

// ============ P10.5-41：Business Knowledge Readiness ============

export function businessKnowledgeReady(store: KnowledgeStoreFile, requirement: RequirementModel): { ready: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const factsForReq = store.knowledge.filter((k) => k.requirementRefs.includes(requirement.requirementId));
  // critical explicit facts reviewed
  const explicitRules = requirement.businessRules.filter((r) => r.origin === "EXPLICIT_REQUIREMENT");
  for (const r of explicitRules) {
    const promoted = factsForReq.some((k) => k.provenance.some((p) => p.sourceAnchor.includes(r.statement.slice(0, 20)) || r.statement.includes(p.sourceAnchor.slice(0, 20))));
    if (!promoted) reasons.push(`explicit rule ${r.ruleId} 未 promotion`);
  }
  // security reviewed
  const sec = factsForReq.filter((k) => k.knowledgeType === "SECURITY_REQUIREMENT");
  if (sec.some((k) => k.status === "REVIEW")) reasons.push("security knowledge 未全部 review");
  // blocking conflicts resolved
  const pendingConflicts = store.reviewQueue.filter((q) => q.status === "PENDING" && q.category === "CONFLICT" && q.requirementId === requirement.requirementId);
  if (pendingConflicts.length) reasons.push(`存在 ${pendingConflicts.length} 个未解决冲突`);
  // eligible facts promoted
  const pendingSecurityOrInference = store.reviewQueue.filter((q) => q.status === "PENDING" && (q.category === "SECURITY" || q.category === "AI_INFERENCE") && q.requirementId === requirement.requirementId);
  if (pendingSecurityOrInference.length) reasons.push(`存在 ${pendingSecurityOrInference.length} 个待 review 的 security/inference 事实`);
  return { ready: reasons.length === 0, reasons };
}

// ============ P10.5-42：TestDesignInput ============

export interface TestDesignInput {
  requirementId: string;
  requirementVersion: string;
  approvedFacts: ApprovedRequirementFact[];
  businessKnowledgeRefs: string[];
  capabilities: string[];
  ambiguitiesResolved: string[];
  remainingNonBlockingUnknowns: string[];
  risks: Array<{ domain: string; level: string }>;
  contextFingerprint: string;
  knowledgeReady: boolean;
  readinessReasons: string[];
}

export function buildTestDesignInput(input: {
  requirement: RequirementModel;
  approvedFacts: ApprovedRequirementFact[];
  knowledgeRefs: string[];
  contextFingerprint: string;
  store: KnowledgeStoreFile;
}): TestDesignInput {
  const readiness = businessKnowledgeReady(input.store, input.requirement);
  return {
    requirementId: input.requirement.requirementId,
    requirementVersion: input.requirement.version,
    approvedFacts: input.approvedFacts,
    businessKnowledgeRefs: input.knowledgeRefs,
    capabilities: input.requirement.affectedCapabilities.filter((c) => c.match !== "NEW_CAPABILITY").map((c) => c.capabilityId),
    ambiguitiesResolved: input.requirement.ambiguities.filter((a) => a.status === "RESOLVED").map((a) => a.ambiguityId),
    remainingNonBlockingUnknowns: input.requirement.openQuestions.filter((q) => q.priority !== "BLOCKING").map((q) => q.questionId),
    risks: input.requirement.risks.map((r) => ({ domain: r.domain, level: r.level })),
    contextFingerprint: input.contextFingerprint,
    knowledgeReady: readiness.ready,
    readinessReasons: readiness.reasons
  };
}

// ============ P10.5-37：fingerprint change ============

export function knowledgeFingerprint(store: KnowledgeStoreFile): string {
  const active = store.knowledge.filter((k) => k.status === "ACTIVE").map((k) => `${k.knowledgeId}:${k.version}:${k.semanticKey}`).sort().join("|");
  return crypto.createHash("sha256").update(active).digest("hex").slice(0, 12);
}
