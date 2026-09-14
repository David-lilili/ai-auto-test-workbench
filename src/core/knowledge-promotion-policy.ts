import crypto from "node:crypto";
import { resolveTargetIdsSafe, type InvalidAliasBlockedEvidence } from "./element-alias-wiring.js";
import type { PageModelWithAliases } from "./page-model-types.js";

/**
 * Knowledge Promotion Pipeline（P4-B）：统一证据模型 + 分级晋升策略。
 *
 * 核心回答：「什么证据达到什么条件以后，可以晋升为什么等级的知识」。
 *
 * 铁律：
 * - AI 推测永远不能直接变 execution_verified（promotion 完全 deterministic，无 AI 参与）；
 * - 出现 contradiction 一律禁止 AUTO_PROMOTE；
 * - Page Model 是最终执行事实源；写回走 atomic + diff + rollback + verificationHistory。
 */

// ============ P4-B1：统一 Evidence Model ============

export type EvidenceSourceType =
  | "CAPTURE"
  | "DOM_OBSERVATION"
  | "CONTROLLED_EXPLORATION"
  | "DSL_EXECUTION"
  | "SELF_HEALING"
  | "FAILURE_DIAGNOSIS"
  | "NORMALIZATION"
  | "MANUAL";

export interface KnowledgeEvidence {
  evidenceId: string;
  knowledgeType: KnowledgeType;
  pageId: string;
  targetId: string;
  sourceType: EvidenceSourceType;
  sourceRunId?: string;
  sourceGapId?: string;
  heuristicId?: string;
  heuristicVersion?: number;
  observation: Record<string, unknown>;
  confidence: "HIGH" | "MEDIUM" | "LOW";
  timestamp: string;
  pageSignature?: string;
  environment?: string;
  /** 该证据支持的知识值（locator 字符串 / controlType / 断言文本等）。 */
  observedValue: string;
  /** 证据方向：支持（success）或反驳（contradiction）。 */
  outcome: "success" | "failure" | "contradiction";
  /**
   * 证据生命周期状态（Evidence Immutability Guard）。
   * canonical evidence 一旦写入禁止物理删除/覆盖；无效证据保留原记录，仅标记状态：
   *   - INVALIDATED：已失效（如依赖的页面结构不复存在）
   *   - REJECTED：被判定不可信（如与显式断言冲突）
   *   - SUPERSEDED：已被更新证据取代（supersededBy 指向新 evidenceId）
   * 未设置视为 ACTIVE。内容字段（observation/observedValue/outcome 等）永不改动。
   */
  status?: "ACTIVE" | "INVALIDATED" | "REJECTED" | "SUPERSEDED";
  statusReason?: string;
  statusAt?: string;
  supersededBy?: string;
}

// ============ P4-B2：知识类型分级 ============

export type KnowledgeType =
  | "LOCATOR"
  | "CONTROL_TYPE"
  | "INTERACTION"
  | "ASSERTION"
  | "STATE"
  | "DEPENDENCY"
  | "BUSINESS_RULE"
  | "SECURITY_REQUIREMENT";

/** proposalType → knowledgeType 映射（消费现有 backlog）。 */
export const PROPOSAL_TYPE_TO_KNOWLEDGE: Record<string, KnowledgeType> = {
  element_locator_update: "LOCATOR",
  assertion_observable_update: "ASSERTION",
  assertion_contract_or_observable_update: "ASSERTION",
  page_state_or_navigation_update: "STATE",
  provider_flow_model_update: "SECURITY_REQUIREMENT",
  intent_boundary_update: "BUSINESS_RULE",
  intent_hierarchy_update: "BUSINESS_RULE",
  execution_diagnostic_review: "STATE",
  environment_preflight_gap: "STATE",
  page_model_ingest: "CONTROL_TYPE",
  page_identity_conflict: "STATE"
};

// ============ P4-B3：Promotion Policy Registry ============

export type PromotionDecisionType = "AUTO_PROMOTE" | "REVIEW" | "KEEP_PENDING" | "REJECT" | "CONFLICT";
export type Freshness = "FRESH" | "STALE" | "INVALIDATED";

export interface PromotionPolicy {
  policyId: string;
  policyVersion: number;
  knowledgeType: KnowledgeType;
  /** AUTO_PROMOTE 的全部条件（AND 语义）。 */
  autoPromoteConditions: string[];
  reviewConditions: string[];
  rejectConditions: string[];
  targetStatus: string;
  requiredEvidenceTypes: EvidenceSourceType[];
  minEvidenceCount: number;
  contradictionPolicy: "BLOCK_AUTO" | "REVIEW";
  freshnessPolicy: { freshWindowDays: number; invalidatedOnSignatureChange: boolean };
  rollbackPolicy: "keep_old_value_plus_new_candidate" | "revert_to_backup";
  riskClass: "LOW" | "MEDIUM" | "HIGH";
}

export const PROMOTION_POLICIES: Record<KnowledgeType, PromotionPolicy> = {
  LOCATOR: {
    policyId: "locator.v1",
    policyVersion: 1,
    knowledgeType: "LOCATOR",
    autoPromoteConditions: [
      "原有 locator 失败（存在 failure 证据）",
      "新 locator 在同一 semantic target 上成功 ≥ 2 次（DSL_EXECUTION 或 CONTROLLED_EXPLORATION 或 SELF_HEALING）",
      "page signature 兼容（无 INVALIDATED）",
      "无 contradictory locator evidence",
      "targetElementId 未发生语义冲突"
    ],
    reviewConditions: ["成功次数 < 2", "仅单 source 类型证据"],
    rejectConditions: ["semantic target 已不存在", "所有证据均 failure"],
    targetStatus: "candidate_locator_appended",
    requiredEvidenceTypes: ["DSL_EXECUTION", "CONTROLLED_EXPLORATION", "SELF_HEALING"],
    minEvidenceCount: 2,
    contradictionPolicy: "BLOCK_AUTO",
    freshnessPolicy: { freshWindowDays: 30, invalidatedOnSignatureChange: true },
    rollbackPolicy: "keep_old_value_plus_new_candidate",
    riskClass: "LOW"
  },
  CONTROL_TYPE: {
    policyId: "control_type.v1",
    policyVersion: 1,
    knowledgeType: "CONTROL_TYPE",
    autoPromoteConditions: [
      "P4-A normalization HIGH confidence",
      "证据来自 role/tag/component metadata（强结构证据）",
      "无矛盾 controlType 证据"
    ],
    reviewConditions: ["MEDIUM confidence（多条弱证据一致）"],
    rejectConditions: ["LOW confidence 单条文本推断"],
    targetStatus: "dom_verified",
    requiredEvidenceTypes: ["NORMALIZATION"],
    minEvidenceCount: 1,
    contradictionPolicy: "BLOCK_AUTO",
    freshnessPolicy: { freshWindowDays: 90, invalidatedOnSignatureChange: false },
    rollbackPolicy: "revert_to_backup",
    riskClass: "LOW"
  },
  INTERACTION: {
    policyId: "interaction.v1",
    policyVersion: 1,
    knowledgeType: "INTERACTION",
    autoPromoteConditions: ["真实执行成功 ≥ 2 次（controlled exploration 或 DSL execution）"],
    reviewConditions: ["单次执行成功", "只有 DOM 观察证据"],
    rejectConditions: [],
    targetStatus: "execution_observed",
    requiredEvidenceTypes: ["CONTROLLED_EXPLORATION", "DSL_EXECUTION"],
    minEvidenceCount: 2,
    contradictionPolicy: "BLOCK_AUTO",
    freshnessPolicy: { freshWindowDays: 30, invalidatedOnSignatureChange: true },
    rollbackPolicy: "revert_to_backup",
    riskClass: "LOW"
  },
  ASSERTION: {
    policyId: "assertion.v1",
    policyVersion: 1,
    knowledgeType: "ASSERTION",
    // 保守：第一版一律 REVIEW（任务书：不自动晋升 assertion）
    autoPromoteConditions: [],
    reviewConditions: ["所有 assertion 知识默认人工 review（文本相似不构成自动晋升依据）"],
    rejectConditions: ["证据与用户显式断言冲突"],
    targetStatus: "candidate",
    requiredEvidenceTypes: ["DSL_EXECUTION", "CONTROLLED_EXPLORATION", "DOM_OBSERVATION"],
    minEvidenceCount: Number.MAX_SAFE_INTEGER,
    contradictionPolicy: "BLOCK_AUTO",
    freshnessPolicy: { freshWindowDays: 30, invalidatedOnSignatureChange: true },
    rollbackPolicy: "revert_to_backup",
    riskClass: "MEDIUM"
  },
  STATE: {
    policyId: "state.v1",
    policyVersion: 1,
    knowledgeType: "STATE",
    autoPromoteConditions: ["before/after observation 完整", "restore 成功", "重复 ≥ 2 次"],
    reviewConditions: ["单次观察", "restore PARTIAL"],
    rejectConditions: [],
    targetStatus: "dom_verified",
    requiredEvidenceTypes: ["CONTROLLED_EXPLORATION", "DSL_EXECUTION"],
    minEvidenceCount: 2,
    contradictionPolicy: "BLOCK_AUTO",
    freshnessPolicy: { freshWindowDays: 30, invalidatedOnSignatureChange: true },
    rollbackPolicy: "revert_to_backup",
    riskClass: "MEDIUM"
  },
  DEPENDENCY: {
    policyId: "dependency.v1",
    policyVersion: 1,
    knowledgeType: "DEPENDENCY",
    autoPromoteConditions: [], // 默认 REVIEW（before/action/after 三段证据齐也不自动）
    reviewConditions: ["before evidence + action + after evidence + restore result 全齐后人工 review"],
    rejectConditions: [],
    targetStatus: "candidate",
    requiredEvidenceTypes: ["CONTROLLED_EXPLORATION"],
    minEvidenceCount: 1,
    contradictionPolicy: "BLOCK_AUTO",
    freshnessPolicy: { freshWindowDays: 30, invalidatedOnSignatureChange: true },
    rollbackPolicy: "revert_to_backup",
    riskClass: "MEDIUM"
  },
  BUSINESS_RULE: {
    policyId: "business_rule.v1",
    policyVersion: 1,
    knowledgeType: "BUSINESS_RULE",
    autoPromoteConditions: [], // 单次 API/DOM 观察不足以 execution_verified
    reviewConditions: ["重复观察 ≥ 2 次后人工 review"],
    rejectConditions: [],
    targetStatus: "candidate",
    requiredEvidenceTypes: ["DSL_EXECUTION", "DOM_OBSERVATION"],
    minEvidenceCount: 2,
    contradictionPolicy: "BLOCK_AUTO",
    freshnessPolicy: { freshWindowDays: 90, invalidatedOnSignatureChange: false },
    rollbackPolicy: "revert_to_backup",
    riskClass: "MEDIUM"
  },
  SECURITY_REQUIREMENT: {
    policyId: "security_requirement.v1",
    policyVersion: 1,
    knowledgeType: "SECURITY_REQUIREMENT",
    autoPromoteConditions: [], // 永远人工 review
    reviewConditions: ["KYC/GA/2FA 类安全要求一律人工 review，禁止 auto promote"],
    rejectConditions: [],
    targetStatus: "review_only",
    requiredEvidenceTypes: [],
    minEvidenceCount: Number.MAX_SAFE_INTEGER,
    contradictionPolicy: "BLOCK_AUTO",
    freshnessPolicy: { freshWindowDays: 365, invalidatedOnSignatureChange: false },
    rollbackPolicy: "revert_to_backup",
    riskClass: "HIGH"
  }
};

// ============ P4-B5：Evidence Aggregation ============

export interface KnowledgeCandidate {
  knowledgeKey: string;
  knowledgeType: KnowledgeType;
  pageId: string;
  /** 原始 targetId（聚合时的首个 source，provenance 用，永不被 alias 改写）。 */
  targetId: string;
  /** alias-aware 解析后的收敛 id（aggregateEvidence 提供 pageModels 时才有）。 */
  canonicalTargetId?: string;
  normalizedValue: string;
  evidence: KnowledgeEvidence[];
  successCount: number;
  failureCount: number;
  contradictionCount: number;
  firstObservedAt: string;
  lastObservedAt: string;
  pageSignatures: string[];
  freshness: Freshness;
  evidenceConfidence: "HIGH" | "MEDIUM" | "LOW" | "CONFLICTED";
}

/** 稳定 knowledgeKey：knowledgeType + pageId + targetId + normalizedValue。 */
export function buildKnowledgeKey(knowledgeType: KnowledgeType, pageId: string, targetId: string, normalizedValue: string): string {
  return crypto.createHash("sha256").update(`${knowledgeType}|${pageId}|${targetId}|${normalizedValue}`).digest("hex").slice(0, 24);
}

export function aggregateEvidence(
  evidenceList: KnowledgeEvidence[],
  pageModels?: Map<string, PageModelWithAliases>,
  /**
   * fail-closed 诊断收集（P16.7 Phase 2）：invalid alias 证据被拒入聚合时追加审计条目，
   * 调用方据此知晓该证据为何未进入正常候选；不传则不收集（聚合行为不变）。
   */
  invalidAliasBlocked?: InvalidAliasBlockedEvidence[]
): Map<string, KnowledgeCandidate> {
  const candidates = new Map<string, KnowledgeCandidate>();
  for (const evidence of evidenceList) {
    // 已失效证据（INVALIDATED/REJECTED/SUPERSEDED）保留原记录但不参与聚合。
    if (evidence.status && evidence.status !== "ACTIVE") continue;
    // alias-aware 聚合：pageModels 提供时按 canonical targetId 分组。旧证据的存储 key 含 old id，
    // 不能只 resolve 查询 id 重建单一 canonical key——必须对整批证据统一解析后归组。
    // P16.7 Phase 2 fail-closed：invalid alias（环 / self alias / canonical 缺失 / 链断裂）
    // 证据不得以 sourceTargetId 作为伪 canonical 参与聚合——直接拒入并留下确定性诊断。
    let canonicalTargetId: string | undefined;
    if (pageModels) {
      const resolved = resolveTargetIdsSafe(pageModels.get(evidence.pageId), evidence.targetId);
      if (!resolved.resolved) {
        invalidAliasBlocked?.push({
          evidenceId: evidence.evidenceId,
          knowledgeType: evidence.knowledgeType,
          pageId: evidence.pageId,
          targetId: evidence.targetId,
          reason: "INVALID_ALIAS",
          resolutionIssue: resolved.resolutionIssue ?? "invalid alias"
        });
        continue;
      }
      canonicalTargetId = resolved.canonicalTargetId;
    }
    const groupTargetId = canonicalTargetId ?? evidence.targetId;
    const key = buildKnowledgeKey(evidence.knowledgeType, evidence.pageId, groupTargetId, evidence.observedValue);
    let candidate = candidates.get(key);
    if (!candidate) {
      candidate = {
        knowledgeKey: key,
        knowledgeType: evidence.knowledgeType,
        pageId: evidence.pageId,
        targetId: evidence.targetId,
        canonicalTargetId,
        normalizedValue: evidence.observedValue,
        evidence: [],
        successCount: 0,
        failureCount: 0,
        contradictionCount: 0,
        firstObservedAt: evidence.timestamp,
        lastObservedAt: evidence.timestamp,
        pageSignatures: [],
        freshness: "FRESH",
        evidenceConfidence: "LOW"
      };
      candidates.set(key, candidate);
    }
    candidate.evidence.push(evidence);
    if (evidence.outcome === "success") candidate.successCount++;
    else if (evidence.outcome === "failure") candidate.failureCount++;
    else candidate.contradictionCount++;
    if (evidence.timestamp < candidate.firstObservedAt) candidate.firstObservedAt = evidence.timestamp;
    if (evidence.timestamp > candidate.lastObservedAt) candidate.lastObservedAt = evidence.timestamp;
    if (evidence.pageSignature && !candidate.pageSignatures.includes(evidence.pageSignature)) {
      candidate.pageSignatures.push(evidence.pageSignature);
    }
  }
  // P4-B7 freshness + P4-B12 evidenceConfidence
  for (const candidate of candidates.values()) {
    candidate.freshness = computeFreshness(candidate);
    candidate.evidenceConfidence = computeEvidenceConfidence(candidate);
  }
  return candidates;
}

function computeFreshness(candidate: KnowledgeCandidate): Freshness {
  const policy = PROMOTION_POLICIES[candidate.knowledgeType];
  const ageDays = (Date.now() - new Date(candidate.lastObservedAt).getTime()) / 86400000;
  if (policy.freshnessPolicy.invalidatedOnSignatureChange && candidate.pageSignatures.length > 2) {
    return "INVALIDATED";
  }
  if (ageDays > policy.freshnessPolicy.freshWindowDays * 2) return "INVALIDATED";
  if (ageDays > policy.freshnessPolicy.freshWindowDays) return "STALE";
  return "FRESH";
}

function computeEvidenceConfidence(candidate: KnowledgeCandidate): KnowledgeCandidate["evidenceConfidence"] {
  if (candidate.contradictionCount > 0) return "CONFLICTED";
  if (candidate.successCount >= 3) return "HIGH";
  if (candidate.successCount >= 2) return "MEDIUM";
  return "LOW";
}

// ============ P4-B4/B6：Promotion Decision ============

export interface PromotionDecision {
  decision: PromotionDecisionType;
  targetStatus: string;
  reasons: string[];
  evidenceIds: string[];
  missingEvidence: string[];
  contradictions: string[];
  policyId: string;
  policyVersion: number;
}

export function decidePromotion(candidate: KnowledgeCandidate): PromotionDecision {
  const policy = PROMOTION_POLICIES[candidate.knowledgeType];
  const reasons: string[] = [];
  const missing: string[] = [];
  const contradictions: string[] = [];
  const evidenceIds = candidate.evidence.map((item) => item.evidenceId);

  // P4-B6：contradiction 一律禁止 AUTO
  if (candidate.contradictionCount > 0) {
    const conflicting = candidate.evidence.filter((item) => item.outcome === "contradiction");
    contradictions.push(...conflicting.map((item) => `${item.evidenceId}: ${JSON.stringify(item.observation).slice(0, 80)}`));
    return {
      decision: "CONFLICT",
      targetStatus: "pending_conflict_resolution",
      reasons: [`存在 ${candidate.contradictionCount} 条矛盾证据，禁止自动晋升`],
      evidenceIds,
      missingEvidence: [],
      contradictions,
      policyId: policy.policyId,
      policyVersion: policy.policyVersion
    };
  }

  // freshness gate
  if (candidate.freshness === "INVALIDATED") {
    reasons.push("页面签名显著变化（INVALIDATED），需要重新观察");
    return {
      decision: "KEEP_PENDING",
      targetStatus: "pending_refresh",
      reasons,
      evidenceIds,
      missingEvidence: ["重新采集的 FRESH 证据"],
      contradictions,
      policyId: policy.policyId,
      policyVersion: policy.policyVersion
    };
  }

  // 安全类/断言类/依赖类/业务规则：policy 无 auto 条件 → 恒 REVIEW
  if (policy.autoPromoteConditions.length === 0) {
    return {
      decision: "REVIEW",
      targetStatus: policy.targetStatus,
      reasons: [`${candidate.knowledgeType} policy 规定一律人工 review：${policy.reviewConditions[0]}`],
      evidenceIds,
      missingEvidence: [],
      contradictions,
      policyId: policy.policyId,
      policyVersion: policy.policyVersion
    };
  }

  // reject 条件
  if (policy.rejectConditions.length && candidate.successCount === 0 && candidate.failureCount > 0) {
    return {
      decision: "REJECT",
      targetStatus: "rejected",
      reasons: ["全部证据均为 failure"],
      evidenceIds,
      missingEvidence: [],
      contradictions,
      policyId: policy.policyId,
      policyVersion: policy.policyVersion
    };
  }

  // auto 条件评估
  const sourceTypes = new Set(candidate.evidence.map((item) => item.sourceType));
  const hasRequiredSource = policy.requiredEvidenceTypes.some((type) => sourceTypes.has(type));
  if (!hasRequiredSource && policy.requiredEvidenceTypes.length) {
    missing.push(`需要 ${policy.requiredEvidenceTypes.join(" 或 ")} 类型证据`);
  }
  const successEvidence = candidate.evidence.filter((item) => item.outcome === "success");
  if (successEvidence.length < policy.minEvidenceCount) {
    missing.push(`成功证据 ${successEvidence.length}/${policy.minEvidenceCount}`);
  }

  // LOCATOR 特有：需要原 locator 失败证据（failure outcome 的存在）
  if (candidate.knowledgeType === "LOCATOR") {
    const hasFailureEvidence = candidate.evidence.some((item) => item.outcome === "failure");
    if (!hasFailureEvidence) {
      // 无失败证据的 locator 候选：可能是纯新增——降为 REVIEW
      reasons.push("无原 locator 失败证据（非修复型候选）");
      return {
        decision: "REVIEW",
        targetStatus: policy.targetStatus,
        reasons: [...reasons, "locator 自动晋升仅适用于修复型（原 locator 失败 + 新 locator 成功）"],
        evidenceIds,
        missingEvidence: missing,
        contradictions,
        policyId: policy.policyId,
        policyVersion: policy.policyVersion
      };
    }
  }

  // CONTROL_TYPE 特有：confidence 门禁（HIGH 结构证据才 auto）
  if (candidate.knowledgeType === "CONTROL_TYPE") {
    const highConfidence = candidate.evidence.some((item) => item.confidence === "HIGH");
    if (!highConfidence) {
      return {
        decision: "REVIEW",
        targetStatus: policy.targetStatus,
        reasons: ["非 HIGH confidence 结构证据（MEDIUM/LOW 走人工 review）"],
        evidenceIds,
        missingEvidence: [],
        contradictions,
        policyId: policy.policyId,
        policyVersion: policy.policyVersion
      };
    }
  }

  if (missing.length) {
    return {
      decision: "REVIEW",
      targetStatus: policy.targetStatus,
      reasons: [...reasons, "证据不满足 auto 条件，转人工 review"],
      evidenceIds,
      missingEvidence: missing,
      contradictions,
      policyId: policy.policyId,
      policyVersion: policy.policyVersion
    };
  }

  return {
    decision: "AUTO_PROMOTE",
    targetStatus: policy.targetStatus,
    reasons: [...reasons, `满足 ${policy.policyId} 全部 auto 条件：成功证据 ${successEvidence.length} ≥ ${policy.minEvidenceCount}，无矛盾，freshness=${candidate.freshness}`],
    evidenceIds,
    missingEvidence: [],
    contradictions,
    policyId: policy.policyId,
    policyVersion: policy.policyVersion
  };
}
