/**
 * P14.5-12..17：Cross-Phase Closed Loop。
 *
 * NEW_TEST_REQUIRED → TestDesignChangeRequest → P11 → Candidate → P12 Review → ACTIVE → Plan refresh
 * UPDATE_REQUIRED → P12 newVersion → old SUPERSEDED → new ACTIVE → Plan refresh
 * 幂等：同一 NEW_TEST_REQUIRED / UPDATE_REQUIRED 不重复生成（semantic identity）。
 */

import type { RegressionPlan, PlanAssetEntry } from "./regression-plan.js";
import type { RequirementChangeSet } from "./change-event.js";

export interface TestDesignChangeRequest {
  requestId: string;
  requirementVersion: string;
  newFacts: string[];
  changedFacts: string[];
  removedFacts: string[];
  currentAssets: string[];
  uncoveredObligations: string[];
  impactReason: string;
}

export interface AssetUpdateReviewRequest {
  requestId: string;
  assetId: string;
  candidateId?: string;
  reason: string;
}

export interface CrossPhaseContext {
  resolveTestDesign: (request: TestDesignChangeRequest) => Promise<{ candidateId: string; resolved: boolean }>;
  resolveAssetUpdate: (request: AssetUpdateReviewRequest) => Promise<{ newVersion: string; resolved: boolean }>;
  latestAssets: Array<{ testAssetId: string; version: string; status: string }>;
  resolvedCandidateIds: Set<string>;
  resolvedUpdateKeys: Set<string>;
}

/** P14.5-17：semantic identity——相同请求不重复生成。 */
export function newTestRequestKey(request: TestDesignChangeRequest): string {
  return `NTR:${request.uncoveredObligations.sort().join("+")}:${request.requirementVersion}`;
}

export function assetUpdateRequestKey(request: AssetUpdateReviewRequest): string {
  return `AUR:${request.assetId}:${request.reason}`;
}

export interface PlanRefreshResult {
  plan: RegressionPlan;
  newlyResolvedNewTests: string[];
  newlyResolvedUpdates: string[];
  blockedItems: string[];
}

/** P14.5-15：refreshRegressionPlan——解析后生成新 Plan Version（不手工重建）。 */
export async function refreshRegressionPlan(input: {
  plan: RegressionPlan;
  changeSet: RequirementChangeSet;
  ctx: CrossPhaseContext;
}): Promise<PlanRefreshResult> {
  const newlyResolvedNewTests: string[] = [];
  const newlyResolvedUpdates: string[] = [];
  const blockedItems: string[] = [];

  // 1) resolve new test requests（幂等）
  const remainingNewTests: typeof input.plan.newTestRequests = [];
  for (const ntr of input.plan.newTestRequests) {
    const request: TestDesignChangeRequest = {
      requestId: ntr.requestId,
      requirementVersion: input.changeSet.toVersion,
      newFacts: input.changeSet.addedRules,
      changedFacts: input.changeSet.changedRules,
      removedFacts: input.changeSet.removedRules,
      currentAssets: input.plan.selectedAssets.map((s) => s.assetId),
      uncoveredObligations: [ntr.changedFactId],
      impactReason: ntr.reason
    };
    const key = newTestRequestKey(request);
    if (input.ctx.resolvedCandidateIds.has(key)) {
      newlyResolvedNewTests.push(ntr.requestId);
      continue;
    }
    const outcome = await input.ctx.resolveTestDesign(request);
    if (outcome.resolved) {
      input.ctx.resolvedCandidateIds.add(key);
      newlyResolvedNewTests.push(ntr.requestId);
    } else {
      remainingNewTests.push(ntr);
    }
  }

  // 2) resolve update requests（幂等）
  const remainingUpdates: typeof input.plan.updateRequiredAssets = [];
  for (const assetId of input.plan.updateRequiredAssets) {
    const request: AssetUpdateReviewRequest = { requestId: `AUR-${assetId}`, assetId, reason: "BUSINESS_RULE_CHANGED" };
    const key = assetUpdateRequestKey(request);
    if (input.ctx.resolvedUpdateKeys.has(key)) {
      newlyResolvedUpdates.push(assetId);
      continue;
    }
    const outcome = await input.ctx.resolveAssetUpdate(request);
    if (outcome.resolved) {
      input.ctx.resolvedUpdateKeys.add(key);
      newlyResolvedUpdates.push(assetId);
    } else {
      remainingUpdates.push(assetId);
    }
  }

  // 3) 用 latestAssets 刷新 plan 选择（只保留 ACTIVE 版本；旧版本 SUPERSEDED 不再被选）
  const activeIds = new Set(input.ctx.latestAssets.filter((a) => a.status === "ACTIVE").map((a) => a.testAssetId));
  const selectedAssets: PlanAssetEntry[] = input.plan.selectedAssets
    .filter((s) => activeIds.has(s.assetId) || s.selectionLevel === "EXCLUDED")
    .map((s) => {
      const latest = input.ctx.latestAssets.find((a) => a.testAssetId === s.assetId && a.status === "ACTIVE");
      return latest ? { ...s, assetVersion: latest.version } : s;
    });

  const allResolved = remainingNewTests.length === 0 && remainingUpdates.length === 0;
  if (remainingNewTests.length) blockedItems.push(...remainingNewTests.map((t) => `NEW_TEST:${t.requestId}`));
  if (remainingUpdates.length) blockedItems.push(...remainingUpdates.map((u) => `UPDATE:${u}`));

  const plan: RegressionPlan = {
    ...input.plan,
    version: `v${Number(input.plan.version.replace("v", "")) + 1}`,
    selectedAssets,
    newTestRequests: remainingNewTests,
    updateRequiredAssets: remainingUpdates,
    status: allResolved
      ? (input.plan.selectedAssets.some((s) => s.disposition === "REVIEW_REQUIRED") ? "NEEDS_ASSET_REVIEW" : "READY_FOR_REVIEW")
      : "NEEDS_TEST_DESIGN",
    updatedAt: new Date().toISOString()
  };
  return { plan, newlyResolvedNewTests, newlyResolvedUpdates, blockedItems };
}

/** P14.5-16：只有全部 critical blocking 项 resolve 才 READY_FOR_REVIEW。 */
export function readyForReview(plan: RegressionPlan): boolean {
  return plan.newTestRequests.length === 0 && plan.updateRequiredAssets.length === 0 && plan.status !== "BLOCKED";
}
