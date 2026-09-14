/**
 * P10.29-31 / P10.57-61：Business Knowledge Proposal + Review + Promotion Policy + Capability Mapping。
 *
 * - Requirement APPROVED 后不直接写 Operation Manual；生成 BusinessKnowledgeProposal 进入 REVIEW；
 * - review 支持 APPROVE/EDIT/REJECT（可作用于 rule/AC/assumption/ambiguity）；
 * - Promotion policy：SOURCE_EXPLICIT+APPROVED → eligible；AI_INFERENCE/SECURITY → HUMAN REVIEW REQUIRED；CONFLICT → BLOCK；
 * - Capability mapping：MATCHED/POSSIBLE/NEW_CAPABILITY（NEW 只生成 proposal，不注册）。
 */

import crypto from "node:crypto";
import type { BusinessKnowledgeProposal, KnowledgeBoundary, RequirementModel, RequirementOrigin, RequirementReview } from "./types.js";
import { boundaryFor } from "./types.js";

export { boundaryFor };

// ============ P10.58：Knowledge Promotion Policy ============

export type PromotionDecision = "ELIGIBLE_FOR_PROPOSAL" | "HUMAN_REVIEW_REQUIRED" | "BLOCK_PROMOTION";

export function decidePromotion(input: { origin: RequirementOrigin; approved: boolean; conflict: boolean; isSecurity: boolean }): PromotionDecision {
  if (input.conflict) return "BLOCK_PROMOTION";
  if (input.origin === "EXPLICIT_REQUIREMENT" && input.approved) return "ELIGIBLE_FOR_PROPOSAL";
  if (input.origin === "EXISTING_KNOWLEDGE" && !input.conflict) return "ELIGIBLE_FOR_PROPOSAL";
  if (input.origin === "AI_INFERENCE") return "HUMAN_REVIEW_REQUIRED";
  if (input.isSecurity) return "HUMAN_REVIEW_REQUIRED";
  if (!input.approved) return "HUMAN_REVIEW_REQUIRED";
  return "HUMAN_REVIEW_REQUIRED";
}

// ============ P10.29：Business Knowledge Proposal ============

export function createBusinessKnowledgeProposal(input: {
  model: RequirementModel;
  ruleIndex?: number;
  acIndex?: number;
  contextFingerprint?: string;
}): BusinessKnowledgeProposal | undefined {
  const model = input.model;
  if (input.ruleIndex !== undefined) {
    const rule = model.businessRules[input.ruleIndex];
    if (!rule) return undefined;
    return {
      proposalId: `bkp_${crypto.randomUUID().slice(0, 8)}`,
      knowledgeType: "BUSINESS_RULE",
      source: model.requirementId,
      rule,
      status: "REVIEW",
      origin: rule.origin,
      contextFingerprint: input.contextFingerprint,
      createdAt: new Date().toISOString()
    };
  }
  if (input.acIndex !== undefined) {
    const ac = model.acceptanceCriteria[input.acIndex];
    if (!ac) return undefined;
    return {
      proposalId: `bkp_${crypto.randomUUID().slice(0, 8)}`,
      knowledgeType: "ACCEPTANCE_CRITERION",
      source: model.requirementId,
      ac,
      status: "REVIEW",
      origin: ac.origin,
      contextFingerprint: input.contextFingerprint,
      createdAt: new Date().toISOString()
    };
  }
  return undefined;
}

/** P10.31：为 model 的所有 candidate 生成 proposal（SOURCE_EXPLICIT + APPROVED → eligible）。 */
export function generateProposalsForModel(model: RequirementModel, approved: boolean, contextFingerprint?: string): BusinessKnowledgeProposal[] {
  const proposals: BusinessKnowledgeProposal[] = [];
  model.businessRules.forEach((_, i) => {
    const decision = decidePromotion({ origin: model.businessRules[i].origin, approved, conflict: model.businessRules[i].status === "CONFLICTED", isSecurity: isSecurityRule(model.businessRules[i]) });
    if (decision !== "BLOCK_PROMOTION") {
      const p = createBusinessKnowledgeProposal({ model, ruleIndex: i, contextFingerprint });
      if (p) proposals.push(p);
    }
  });
  model.acceptanceCriteria.forEach((_, i) => {
    const p = createBusinessKnowledgeProposal({ model, acIndex: i, contextFingerprint });
    if (p) proposals.push(p);
  });
  return proposals;
}

function isSecurityRule(rule: { scope?: string; statement: string }): boolean {
  return /2fa|验证|security|白名单|权限|withdraw|提现/.test(`${rule.scope ?? ""} ${rule.statement}`);
}

// ============ P10.30：Requirement Review ============

export function createRequirementReview(input: {
  requirementId: string;
  reviewer: string;
  decision: RequirementReview["decision"];
  reason: string;
  target?: RequirementReview["target"];
  targetId?: string;
  before?: unknown;
  after?: unknown;
}): RequirementReview {
  return {
    reviewId: `rev_${crypto.randomUUID().slice(0, 8)}`,
    requirementId: input.requirementId,
    reviewer: input.reviewer,
    decision: input.decision,
    reason: input.reason,
    timestamp: new Date().toISOString(),
    target: input.target,
    targetId: input.targetId,
    before: input.before,
    after: input.after
  };
}

/** P10.31：Human Confirmation Flow——确认 ambiguity 后更新 model（人工决定成为 HUMAN_CONFIRMED evidence）。 */
export function confirmAmbiguity(model: RequirementModel, ambiguityId: string, resolution: string, reviewer: string): { model: RequirementModel; review: RequirementReview } {
  const updated = { ...model, ambiguities: model.ambiguities.map((a) => a.ambiguityId === ambiguityId ? { ...a, status: "RESOLVED" as const, resolution, resolvedByReview: reviewer } : a) };
  const review = createRequirementReview({ requirementId: model.requirementId, reviewer, decision: "EDIT", reason: `confirm ambiguity ${ambiguityId}: ${resolution}`, target: "ambiguity", targetId: ambiguityId, before: ambiguityId, after: resolution });
  // 人工决定作为 HUMAN_CONFIRMED evidence
  updated.evidence = [...updated.evidence, { evidenceId: `ev_human_${ambiguityId}`, sourceId: model.sourceId, kind: "human_review", detail: resolution, origin: "HUMAN_CONFIRMED" }];
  return { model: updated, review };
}

export function confirmAssumption(model: RequirementModel, assumptionId: string, confirmed: boolean, reviewer: string): RequirementModel {
  return {
    ...model,
    assumptions: model.assumptions.map((a) => a.assumptionId === assumptionId ? { ...a, status: confirmed ? ("CONFIRMED" as const) : ("REJECTED" as const) } : a),
    evidence: [...model.evidence, { evidenceId: `ev_as_${assumptionId}`, sourceId: model.sourceId, kind: "human_review", detail: `${assumptionId} ${confirmed ? "CONFIRMED" : "REJECTED"} by ${reviewer}`, origin: "HUMAN_CONFIRMED" }]
  };
}

// ============ P10.61：Affected Capability Mapping ============

export interface CapabilityCatalog {
  capabilities: Array<{ capabilityId: string; name: string; domain: string }>;
}

export function mapRequirementToCapabilities(text: string, catalog: CapabilityCatalog): Array<{ capabilityId: string; name: string; match: "MATCHED" | "POSSIBLE" | "NEW_CAPABILITY"; confidence: "HIGH" | "MEDIUM" | "LOW" }> {
  const results: Array<{ capabilityId: string; name: string; match: "MATCHED" | "POSSIBLE" | "NEW_CAPABILITY"; confidence: "HIGH" | "MEDIUM" | "LOW" }> = [];
  const lower = text.toLowerCase();
  for (const cap of catalog.capabilities) {
    if (lower.includes(cap.name.toLowerCase()) || cap.name.toLowerCase().includes(lower.split(" ")[0]?.toLowerCase() ?? "")) {
      results.push({ capabilityId: cap.capabilityId, name: cap.name, match: "MATCHED", confidence: "HIGH" });
    } else if (cap.domain && lower.includes(cap.domain.toLowerCase())) {
      results.push({ capabilityId: cap.capabilityId, name: cap.name, match: "POSSIBLE", confidence: "MEDIUM" });
    }
  }
  // 明确新概念（不在 catalog 中）→ NEW_CAPABILITY（只生成 proposal，不注册）
  const knownNames = new Set(catalog.capabilities.map((c) => c.name.toLowerCase()));
  const newCandidates = [...new Set(text.match(/免验证|白名单|二次验证|网络选择|快捷入口/g) ?? [])].filter((c) => !knownNames.has(c.toLowerCase()));
  for (const c of newCandidates) {
    results.push({ capabilityId: `cap_new_${c}`, name: c, match: "NEW_CAPABILITY", confidence: "MEDIUM" });
  }
  return results;
}

// ============ P10.62：Impact Preview（只读，不修改） ============

export interface RequirementImpactPreview {
  potentialAffectedPages: string[];
  potentialAffectedCapabilities: string[];
  potentialAffectedKnowledge: string[];
  note: string;
}

export function buildRequirementImpactPreview(model: RequirementModel): RequirementImpactPreview {
  const domains = new Set(model.affectedDomains.length ? model.affectedDomains : model.businessRules.map((r) => r.scope ?? "").filter(Boolean));
  return {
    potentialAffectedPages: [...domains].map((d) => `${d.toLowerCase().replace(/\s+/g, "_")}_page`),
    potentialAffectedCapabilities: model.affectedCapabilities.filter((c) => c.match !== "NEW_CAPABILITY").map((c) => c.capabilityId),
    potentialAffectedKnowledge: model.businessRules.filter((r) => r.origin === "EXPLICIT_REQUIREMENT").map((r) => r.ruleId),
    note: "仅 preview，不修改 Page Model / 不运行 Orchestrator / 不生成 case"
  };
}
