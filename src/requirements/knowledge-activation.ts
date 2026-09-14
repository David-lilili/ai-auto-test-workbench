/**
 * P10.5：Requirement Knowledge Activation 核心类型。
 *
 * 打通：Requirement Analysis → Human Review → Approved Facts → Knowledge Proposal
 *       → Controlled Promotion → Business Knowledge Store → Context Router → Future Test Designer
 *
 * 铁律（P10.5 总原则）：
 *   - Requirement 原文不可修改；
 *   - AI_INFERENCE 未经人工确认不得成为 authoritative knowledge；
 *   - SECURITY rule 必须人工确认；CONFLICTED 不允许 promotion；
 *   - Requirement APPROVED ≠ 所有子事实自动 approved（fact 粒度治理）；
 *   - Knowledge 保留 Requirement provenance；不直接覆写 Operation Manual；
 *   - 所有 promotion 可审计可回滚。
 */

export type ApprovedFactType =
  | "BUSINESS_RULE"
  | "ACCEPTANCE_CRITERION"
  | "STATE_TRANSITION"
  | "DEPENDENCY"
  | "CONSTRAINT"
  | "SECURITY_REQUIREMENT"
  | "PRECONDITION"
  | "POSTCONDITION"
  | "CAPABILITY_RELATION";

export type FactReviewStatus = "PENDING_REVIEW" | "APPROVED" | "EDIT_APPROVED" | "REJECTED" | "MARKED_AS_EXCEPTION" | "SUPERSEDED";

export type FactEligibility = "ELIGIBLE" | "REVIEW_REQUIRED" | "HUMAN_REVIEW_REQUIRED" | "BLOCKED" | "REJECT";

export type KnowledgeAuthority = "REQUIREMENT_CONFIRMED" | "HUMAN_CONFIRMED" | "EXECUTION_SUPPORTED" | "REFERENCE_ONLY" | "INFERRED";

export type KnowledgeStatus = "ACTIVE" | "REVIEW" | "SUPERSEDED" | "CONFLICTED" | "REJECTED";

export type KnowledgeIdentityMatch = "SAME_KNOWLEDGE" | "POSSIBLE_SAME" | "NEW" | "CONFLICT";

export interface ApprovedRequirementFact {
  factId: string;
  requirementId: string;
  requirementVersion: string;
  factType: ApprovedFactType;
  canonicalStatement: string;
  structuredValue: Record<string, unknown>;
  origin: "EXPLICIT_REQUIREMENT" | "AI_INFERENCE" | "HUMAN_CONFIRMED" | "EXISTING_KNOWLEDGE";
  confidence: "HIGH" | "MEDIUM" | "LOW";
  reviewStatus: FactReviewStatus;
  provenance: { sourceId: string; sourceAnchor: string; requirementVersion: string };
  reviewEvidence?: { reviewer: string; decision: string; timestamp: string; reason?: string };
  status: FactReviewStatus;
  isSecurity: boolean;
  createdAt: string;
  updatedAt: string;
}

/** P10.5-2：事实资格判断（deterministic）。 */
export function evaluateRequirementFactEligibility(input: {
  origin: ApprovedRequirementFact["origin"];
  approved: boolean;          // 该 fact 是否被人工批准
  conflict: boolean;          // 是否 conflict
  isSecurity: boolean;        // 是否安全类
  scopeOverridesGeneral?: boolean; // 是否 scoped exception（可 reconcile）
}): FactEligibility {
  if (input.conflict && !input.scopeOverridesGeneral) return "BLOCKED";
  if (input.conflict && input.scopeOverridesGeneral) return "ELIGIBLE"; // scoped exception 可 reconcile
  if (input.origin === "REJECTED" as never) return "REJECT";
  if (input.isSecurity && !input.approved) return "HUMAN_REVIEW_REQUIRED";
  if (input.origin === "AI_INFERENCE" && !input.approved) return "REVIEW_REQUIRED";
  if (input.origin === "AI_INFERENCE" && input.approved) return "ELIGIBLE";
  if (input.approved) return "ELIGIBLE";
  if (input.origin === "EXPLICIT_REQUIREMENT" && !input.approved) return "REVIEW_REQUIRED";
  return "REVIEW_REQUIRED";
}

// ============ P10.5-6/11：Knowledge Identity + structured rule ============

export interface BusinessKnowledge {
  knowledgeId: string;
  canonicalConcept: string;
  knowledgeType: ApprovedFactType;
  scope: { module: string; capability?: string; actor?: string; network?: string; asset?: string; accountProfile?: string };
  structuredValue: Record<string, unknown>;
  relation?: "IF_THEN" | "REQUIRES" | "INVALIDATES" | "FORBIDS" | "ALLOWS" | "DEFAULTS_TO";
  status: KnowledgeStatus;
  authority: KnowledgeAuthority;
  provenance: Array<{ sourceId: string; sourceAnchor: string; requirementVersion: string; origin: string }>;
  requirementRefs: string[];
  verificationHistory: Array<{ action: string; timestamp: string; detail: string }>;
  version: string;
  supersedes?: string;
  supersededBy?: string;
  semanticKey: string;
  createdAt: string;
  updatedAt: string;
}

/** P10.5-6：businessKnowledgeSemanticKey（scope + relation + concept + condition + effect，固定 6 段）。 */
export function businessKnowledgeSemanticKey(input: {
  scope: BusinessKnowledge["scope"];
  relation?: string;
  sourceConcept?: string;
  targetConcept?: string;
  condition?: string;
  effect?: string;
}): string {
  const norm = (s?: string) => (s ?? "").toLowerCase().replace(/[^a-z0-9_\u4e00-\u9fa5]/g, "_");
  // 固定 6 段（空值用 "_" 占位），保证索引稳定：0=module 1=relation 2=source 3=target 4=condition 5=effect
  return [norm(input.scope.module), norm(input.relation) || "_", norm(input.sourceConcept) || "_", norm(input.targetConcept) || "_", norm(input.condition) || "_", norm(input.effect) || "_"].join("|");
}

/** P10.5-6/14：knowledge identity 匹配（SAME/POSSIBLE/NEW/CONFLICT）。 */
export function matchKnowledgeIdentity(newKey: { scope: BusinessKnowledge["scope"]; relation?: string; condition?: string; effect?: string }, existing: BusinessKnowledge[]): { match: KnowledgeIdentityMatch; existingKey?: string; existing?: BusinessKnowledge } {
  const newSem = businessKnowledgeSemanticKey(newKey);
  const newEff = normalizeValue(newKey.effect);
  const newCond = normalizeValue(newKey.condition);
  const newScope = normalizeValue(newKey.scope?.module);
  // 1. 先查 effect 相反（同 scope + 近似 condition）→ CONFLICT
  for (const ex of existing) {
    if (!ex.semanticKey) continue;
    const parts = ex.semanticKey.split("|");
    if (parts[0] !== newScope) continue;
    const exCond = parts[4] ?? "";
    if (exCond !== newCond && !(exCond && newCond && (exCond.includes(newCond.slice(0, 8)) || newCond.includes(exCond.slice(0, 8))))) continue;
    const exEff = parts[5] ?? "";
    if (newEff && exEff && opposite(newEff, exEff)) {
      return { match: "CONFLICT", existingKey: ex.semanticKey, existing: ex };
    }
  }
  // 2. 完全同语义键 → SAME
  for (const ex of existing) {
    if (ex.semanticKey === newSem && ex.status === "ACTIVE") return { match: "SAME_KNOWLEDGE", existingKey: ex.semanticKey, existing: ex };
  }
  // 3. scope+condition+effect 相同（概念表述不同也同知识）→ SAME
  for (const ex of existing) {
    if (!ex.semanticKey) continue;
    const parts = ex.semanticKey.split("|");
    if (parts[0] === newScope && parts[4] === newCond && parts[5] === newEff) {
      return { match: "SAME_KNOWLEDGE", existingKey: ex.semanticKey, existing: ex };
    }
  }
  // 4. scope+relation+sourceConcept 或 scope+relation+targetConcept 相同 → POSSIBLE_SAME
  for (const ex of existing) {
    if (!ex.semanticKey) continue;
    const exParts = ex.semanticKey.split("|");
    const newParts = newSem.split("|");
    const sameSource = exParts[2] !== "_" && newParts[2] !== "_" && exParts[2] === newParts[2];
    const sameTarget = exParts[3] !== "_" && newParts[3] !== "_" && exParts[3] === newParts[3];
    if (exParts[0] === newParts[0] && exParts[1] === newParts[1] && (sameSource || sameTarget)) {
      return { match: "POSSIBLE_SAME", existingKey: ex.semanticKey, existing: ex };
    }
  }
  return { match: "NEW" };
}

function normalizeValue(v?: string): string { return String(v ?? "").toLowerCase().replace(/[^a-z0-9_\u4e00-\u9fa5]/g, "_"); }
function opposite(a: string, b: string): boolean {
  const neg = (s: string) => s.includes("not") || s.includes("false") || s.includes("不") || s.includes("免") || s.includes("disabled") || s.includes("off");
  // enabled/disabled、require/not-require、2fa on/off 均视为相反
  const boolOpposite = (a.includes("enabled") || a.includes("disabled") || a.includes("true") || a.includes("false") || b.includes("enabled") || b.includes("disabled")) && neg(a) !== neg(b);
  if (boolOpposite) return true;
  return neg(a) !== neg(b) && (a.includes("2fa") || b.includes("2fa") || a.includes("require") || b.includes("require"));
}

// ============ P10.5-12/13：authority ============

export function authorityFor(input: { origin: string; humanConfirmed: boolean; executionSupported?: boolean }): KnowledgeAuthority {
  if (input.executionSupported) return "EXECUTION_SUPPORTED";
  if (input.humanConfirmed) return "HUMAN_CONFIRMED";
  if (input.origin === "EXPLICIT_REQUIREMENT") return "REQUIREMENT_CONFIRMED";
  if (input.origin === "AI_INFERENCE") return "INFERRED";
  return "REFERENCE_ONLY";
}
