/**
 * P12.4/5/25/26：Candidate Eligibility。
 *
 * - 不能因为 coverage 高就自动批准（P12.5）。
 * - Security / HIGH execution risk → 必须 Human review（NEEDS_SECURITY_REVIEW）。
 * - Unsupported candidate → REJECT；BLOCKED_BY_KNOWLEDGE → BLOCKED。
 * - Batch review：仅 AUTO_REVIEWABLE + LOW risk + 无 unsupported + 无 gap。
 */

import type { TestDesignCandidate } from "../test-design/types.js";
import type { CandidateEligibility } from "./types.js";

export function evaluateCandidateForAsset(candidate: TestDesignCandidate, input: {
  unsupportedCount?: number;
  knowledgeGap?: boolean;
  requirementActive?: boolean;
}): CandidateEligibility {
  const reasons: string[] = [];
  let status: CandidateEligibility["status"] = "ELIGIBLE";
  const unsupported = candidate.expectedOutcomes.some((e) => e.grounding.kind === "TESTING_TECHNIQUE") || (input.unsupportedCount ?? 0) > 0;

  // REJECT：unsupported（P12 原则 11）
  if (unsupported) {
    reasons.push("UNSUPPORTED_EXPECTATION: candidate 含 unsupported expected outcome");
    status = "REJECT";
  }
  // BLOCKED：knowledge gap（P12 原则 12）
  if (input.knowledgeGap || candidate.testability === "BLOCKED_BY_KNOWLEDGE") {
    reasons.push("BLOCKED_BY_KNOWLEDGE: candidate 缺业务知识，不得批准");
    status = "BLOCKED";
  }
  // Requirement 非 active → BLOCKED
  if (input.requirementActive === false) {
    reasons.push("REQUIREMENT_INACTIVE: requirement 非 active");
    if (status === "ELIGIBLE") status = "BLOCKED";
  }
  // Security / HIGH risk → REVIEW_REQUIRED（P12.5：即使 coverage 完整也必须 human）
  const securityReviewRequired = candidate.reviewStatus === "NEEDS_SECURITY_REVIEW"
    || candidate.risk.designPriority === "CRITICAL"
    || candidate.coveredObligationIds.some((id) => /sec|security/i.test(id));
  const highRisk = candidate.risk.executionRisk === "HIGH";
  if (securityReviewRequired || highRisk) {
    reasons.push(securityReviewRequired ? "SECURITY_REVIEW_REQUIRED" : "HIGH_EXECUTION_RISK");
    if (status === "ELIGIBLE") status = "REVIEW_REQUIRED";
  }
  // Provenance 缺失 → BLOCKED
  if (!candidate.provenance || candidate.provenance.length === 0) {
    reasons.push("MISSING_PROVENANCE");
    if (status === "ELIGIBLE") status = "BLOCKED";
  }
  // 未覆盖任何 obligation → REJECT
  if (!candidate.coveredObligationIds || candidate.coveredObligationIds.length === 0) {
    reasons.push("NO_COVERED_OBLIGATION");
    status = "REJECT";
  }

  // P12.26：batch review eligibility（仍需 human confirm action，不自动 ACTIVE）
  const batchReviewEligible = status === "ELIGIBLE"
    && candidate.reviewStatus === "AUTO_REVIEWABLE"
    && candidate.risk.executionRisk !== "HIGH"
    && candidate.risk.designPriority !== "CRITICAL"
    && candidate.assumptions.length === 0;

  return { status, reasons, securityReviewRequired, highRisk, batchReviewEligible };
}
