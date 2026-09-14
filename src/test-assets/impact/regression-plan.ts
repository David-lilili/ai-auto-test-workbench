/**
 * P14.28-48：Regression Obligation / Plan / Selection / Review / Versioning。
 */

import { createHash } from "node:crypto";
import type { ImpactCandidate } from "./graph.js";

export type RegressionReason =
  | "DIRECT_REQUIREMENT_CHANGE" | "BUSINESS_RULE_CHANGE" | "SECURITY_CHANGE" | "DEPENDENCY_CHANGE" | "STATE_CHANGE"
  | "CAPABILITY_CHANGE" | "PAGE_EXECUTION_CHANGE" | "PREVIOUS_FAILURE" | "FLAKY_HISTORY" | "CRITICAL_NEIGHBOR" | "MANUAL_REVERIFY";

export type SelectionLevel = "MUST_RUN" | "SHOULD_RUN" | "OPTIONAL" | "REVIEW_BEFORE_RUN" | "UPDATE_BEFORE_RUN" | "EXCLUDED";

export type AssetDisposition = "UNCHANGED" | "REEXECUTE" | "REVIEW_REQUIRED" | "UPDATE_REQUIRED" | "SUPERSEDE_CANDIDATE" | "NEW_TEST_REQUIRED" | "EXECUTION_REVERIFY" | "POSSIBLE_IMPACT_REVIEW";

export type PlanStatus = "DRAFT" | "NEEDS_TEST_DESIGN" | "NEEDS_ASSET_REVIEW" | "READY_FOR_REVIEW" | "APPROVED" | "PARTIALLY_EXECUTABLE" | "EXECUTABLE" | "BLOCKED";

export interface RegressionObligation {
  obligationId: string;
  assetId: string;
  reason: RegressionReason;
  why: string[];
}

export interface PlanAssetEntry {
  assetId: string;
  assetVersion: string;
  selectionLevel: SelectionLevel;
  disposition: AssetDisposition;
  whySelected: string[];
  whyNotSelected?: string;
  impactPath: string[];
  executionStatus?: "READY" | "NEEDS_MODELING" | "NEEDS_DATA" | "NEEDS_PROFILE" | "RISK_BLOCKED" | "UPDATE_REQUIRED" | "NEEDS_AUTHORIZATION" | "NOT_EXECUTABLE";
  historicalRisk?: boolean;
}

export interface PlanReviewRecord {
  reviewId: string;
  action: "APPROVE_PLAN" | "EXCLUDE_ASSET" | "INCLUDE_ASSET" | "APPROVE_HIGH_RISK_SELECTION" | "REJECT_PLAN";
  assetId?: string;
  reviewer: string;
  timestamp: string;
  reason: string;
  overrideType?: "MANUAL_INCLUDE" | "MANUAL_EXCLUDE";
  warning?: string;
}

export interface RegressionPlan {
  planId: string;
  version: string;
  changeSetRefs: string[];
  selectedAssets: PlanAssetEntry[];
  reviewRequiredAssets: string[];
  updateRequiredAssets: string[];
  newTestRequests: Array<{ requestId: string; reason: string; changedFactId: string }>;
  excludedAssets: Array<{ assetId: string; reason: string }>;
  riskSummary: { needsAuthorization: number; blocked: number };
  environment: string;
  coverageSummary: { affectedCriticalAcCoverage: number; affectedRuleCoverage: number; securityCoverage: number; capabilityCoverage: number };
  estimatedCost: { assetCount: number; executionEstimate: string };
  status: PlanStatus;
  createdAt: string;
  updatedAt: string;
  fingerprint: string;
  reviewHistory: PlanReviewRecord[];
  impactFingerprint: string;
}

// ============ P14.18 Asset Disposition ============

export function dispositionFor(impact: ImpactCandidate): AssetDisposition {
  switch (impact.impactType) {
    case "DIRECT_BUSINESS_IMPACT":
      return impact.reasonCode === "REFERENCED_KNOWLEDGE_CHANGED" ? "REVIEW_REQUIRED" : "REEXECUTE";
    case "INDIRECT_BUSINESS_IMPACT":
      return "POSSIBLE_IMPACT_REVIEW";
    case "EXECUTION_ONLY_IMPACT":
      return "EXECUTION_REVERIFY";
    case "TEST_METHOD_IMPACT":
      return "REVIEW_REQUIRED";
    case "POSSIBLE_IMPACT":
      return "POSSIBLE_IMPACT_REVIEW";
    default:
      return "UNCHANGED";
  }
}

// ============ P14.30-35 Regression Plan Builder ============

export function buildRegressionPlan(input: {
  planId: string;
  changeSetRefs: string[];
  environment: string;
  impactCandidates: ImpactCandidate[];
  assets: Array<{ testAssetId: string; version: string; status: string; risk: { designPriority: string; executionRisk: string }; critical: boolean }>;
  criticalChangedFactIds: string[];
  criticalNeighborAssetIds: string[];
  flakyAssetIds: string[];
  previouslyFailedAssetIds: string[];
  newTestRequests: Array<{ requestId: string; reason: string; changedFactId: string }>;
  manualIncludes?: string[];
  manualExcludes?: string[];
  manualReviewer?: string;
}): RegressionPlan {
  const selected: PlanAssetEntry[] = [];
  const reviewRequired: string[] = [];
  const updateRequired: string[] = [];
  const excluded: Array<{ assetId: string; reason: string }> = [];
  const impactedIds = new Set(input.impactCandidates.map((c) => c.testAssetId));

  // 全部 active assets
  const active = input.assets.filter((a) => a.status === "ACTIVE");
  for (const a of active) {
    const impact = input.impactCandidates.find((c) => c.testAssetId === a.testAssetId);
    const isCritical = a.critical || a.risk.designPriority === "CRITICAL" || a.risk.executionRisk === "HIGH";
    const isFlaky = input.flakyAssetIds.includes(a.testAssetId);
    const prevFailed = input.previouslyFailedAssetIds.includes(a.testAssetId);
    const neighbor = input.criticalNeighborAssetIds.includes(a.testAssetId);
    const manuallyIncluded = input.manualIncludes?.includes(a.testAssetId);
    const manuallyExcluded = input.manualExcludes?.includes(a.testAssetId);

    let level: SelectionLevel;
    let disposition: AssetDisposition;
    let whySelected: string[] = [];
    let whyNotSelected: string | undefined;
    let historicalRisk = false;

    if (manuallyExcluded) {
      level = "EXCLUDED";
      disposition = "UNCHANGED";
      whyNotSelected = "MANUAL_EXCLUDE";
      excluded.push({ assetId: a.testAssetId, reason: "MANUAL_EXCLUDE" });
    } else if (impact) {
      disposition = dispositionFor(impact);
      whySelected = impact.impactPath;
      // P14.32 MUST_RUN：direct critical / security / critical neighbor / prev critical failure
      if (impact.severity === "CRITICAL" || isCritical || neighbor || (prevFailed && isCritical)) {
        level = disposition === "UPDATE_REQUIRED" || disposition === "REVIEW_REQUIRED" ? "REVIEW_BEFORE_RUN" : "MUST_RUN";
        if (disposition === "REVIEW_REQUIRED") { reviewRequired.push(a.testAssetId); }
        if (disposition === "UPDATE_REQUIRED") { updateRequired.push(a.testAssetId); }
      } else if (impact.impactType === "EXECUTION_ONLY_IMPACT") {
        level = "SHOULD_RUN";
      } else {
        level = "SHOULD_RUN";
      }
      if (isFlaky || prevFailed) {
        historicalRisk = true;
        whySelected.push(`HISTORICAL_RISK:${isFlaky ? "FLAKY_HISTORY" : "PREVIOUS_FAILURE"}`);
        if (level === "SHOULD_RUN") level = "MUST_RUN";
      }
    } else if (manuallyIncluded) {
      level = "SHOULD_RUN";
      disposition = "REEXECUTE";
      whySelected = ["MANUAL_INCLUDE"];
    } else if (neighbor) {
      // P14.37：critical neighbor 扩张（depth 1）——无直接 impact 也纳入 SHOULD_RUN
      level = "SHOULD_RUN";
      disposition = "REEXECUTE";
      whySelected = ["CRITICAL_NEIGHBOR"];
    } else {
      level = "EXCLUDED";
      disposition = "UNCHANGED";
      whyNotSelected = "NO_RELATION_TO_CHANGE";
      excluded.push({ assetId: a.testAssetId, reason: "NO_RELATION_TO_CHANGE" });
    }

    selected.push({ assetId: a.testAssetId, assetVersion: a.version, selectionLevel: level, disposition, whySelected, whyNotSelected, impactPath: impact?.impactPath ?? [], historicalRisk });
  }

  const mustRun = selected.filter((s) => s.selectionLevel === "MUST_RUN");
  const security = selected.filter((s) => s.disposition === "EXECUTION_REVERIFY" || s.disposition === "REEXECUTE");
  const coverageSummary = {
    affectedCriticalAcCoverage: mustRun.length ? 1 : 0,
    affectedRuleCoverage: selected.filter((s) => s.selectionLevel !== "EXCLUDED").length ? 1 : 0,
    securityCoverage: security.length ? 1 : 0,
    capabilityCoverage: selected.filter((s) => s.impactPath.some((p) => p.includes("capability"))).length ? 1 : 0
  };
  const needsAuth = selected.filter((s) => s.disposition === "EXECUTION_REVERIFY" && input.assets.find((a) => a.testAssetId === s.assetId)?.risk.executionRisk === "HIGH").length;
  const blocked = selected.filter((s) => s.disposition === "UPDATE_REQUIRED").length;

  const impactFingerprint = createHash("sha256")
    .update(JSON.stringify({ changeSetRefs: input.changeSetRefs, impactedIds: [...impactedIds].sort(), critical: input.criticalChangedFactIds.sort() }))
    .digest("hex").slice(0, 12);
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ impactFingerprint, assets: selected.map((s) => `${s.assetId}@${s.assetVersion}:${s.selectionLevel}`) }))
    .digest("hex").slice(0, 12);

  const now = new Date().toISOString();
  return {
    planId: input.planId,
    version: "v1",
    changeSetRefs: input.changeSetRefs,
    selectedAssets: selected,
    reviewRequiredAssets: reviewRequired,
    updateRequiredAssets: updateRequired,
    newTestRequests: input.newTestRequests,
    excludedAssets: excluded,
    riskSummary: { needsAuthorization: needsAuth, blocked },
    environment: input.environment,
    coverageSummary,
    estimatedCost: { assetCount: selected.filter((s) => s.selectionLevel !== "EXCLUDED").length, executionEstimate: `${mustRun.length} must-run` },
    status: input.newTestRequests.length ? "NEEDS_TEST_DESIGN" : reviewRequired.length || updateRequired.length ? "NEEDS_ASSET_REVIEW" : "READY_FOR_REVIEW",
    createdAt: now,
    updatedAt: now,
    fingerprint,
    reviewHistory: input.manualReviewer ? [{ reviewId: `rev-${now}`, action: "APPROVE_PLAN", reviewer: input.manualReviewer, timestamp: now, reason: "manual review" }] : [],
    impactFingerprint
  };
}

// ============ P14.46/47 Human Review ============

export function reviewRegressionPlan(plan: RegressionPlan, record: PlanReviewRecord): RegressionPlan {
  let updated = { ...plan, reviewHistory: [...plan.reviewHistory, record], updatedAt: new Date().toISOString() };
  if (record.action === "APPROVE_PLAN") {
    updated.status = updated.selectedAssets.some((s) => s.disposition === "UPDATE_REQUIRED")
      ? "NEEDS_ASSET_REVIEW"
      : updated.selectedAssets.some((s) => s.disposition === "EXECUTION_REVERIFY" || s.disposition === "REEXECUTE")
        ? "APPROVED"
        : "APPROVED";
  }
  if (record.action === "REJECT_PLAN") {
    updated.status = "DRAFT";
  }
  if (record.action === "EXCLUDE_ASSET" && record.assetId) {
    const idx = updated.selectedAssets.findIndex((s) => s.assetId === record.assetId);
    if (idx >= 0) {
      const target = updated.selectedAssets[idx];
      if (target.selectionLevel === "MUST_RUN") {
        record = { ...record, warning: "REMOVING_CRITICAL_IMPACTED_ASSET" };
      }
      updated.selectedAssets = updated.selectedAssets.map((s) => s.assetId === record.assetId ? { ...s, selectionLevel: "EXCLUDED", whyNotSelected: "MANUAL_EXCLUDE" } : s);
      updated.reviewHistory = [...updated.reviewHistory, record];
    }
  }
  if (record.action === "INCLUDE_ASSET" && record.assetId) {
    updated.selectedAssets = updated.selectedAssets.map((s) => s.assetId === record.assetId ? { ...s, selectionLevel: "SHOULD_RUN", disposition: "REEXECUTE", whySelected: [...s.whySelected, "MANUAL_INCLUDE"] } : s);
  }
  return updated;
}

// ============ P14.48 Versioning ============

export function newPlanVersion(plan: RegressionPlan, reason: string, reviewer: string): RegressionPlan {
  const num = Number(plan.version.replace("v", "")) + 1;
  return {
    ...plan,
    version: `v${num}`,
    updatedAt: new Date().toISOString(),
    reviewHistory: [...plan.reviewHistory, { reviewId: `rev-${Date.now()}`, action: "APPROVE_PLAN", reviewer, timestamp: new Date().toISOString(), reason }]
  };
}
