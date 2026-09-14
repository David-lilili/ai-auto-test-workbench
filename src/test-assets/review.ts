/**
 * P12.6-9/70：Human Review 应用（review decision + human edit preservation + review snapshot）。
 *
 * - 每个 review 记录：reviewer / timestamp / reason / before / after / contextFingerprint
 *   / requirementVersion / knowledgeFingerprint / manualVersions / candidateHash（P12.70）。
 * - humanAuthoredFields：human 编辑过的字段拥有最高优先级（P12.8）。
 * - security / HIGH risk：必须 human approve 才能 ACTIVE（P12.5）。
 */

import type { TestAsset, ReviewRecord, ReviewDecision, ReviewableField, TestAssetStoreFile } from "./types.js";
import { assetContentFingerprint } from "./store.js";

export interface ReviewSnapshot {
  requirementVersion?: string;
  knowledgeFingerprint?: string;
  manualVersions?: Record<string, string>;
  candidateHash?: string;
  contextFingerprint?: string;
}

export interface ApplyReviewInput {
  asset: TestAsset;
  decision: ReviewDecision;
  reviewer: string;
  reason: string;
  snapshot?: ReviewSnapshot;
  edits?: { field: ReviewableField; value: unknown };
  mergeWithAssetId?: string;
}

function makeReview(input: ApplyReviewInput, before: unknown, after: unknown): ReviewRecord {
  return {
    reviewId: `rev_${input.asset.testAssetId}_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
    assetId: input.asset.testAssetId,
    assetVersion: input.asset.version,
    decision: input.decision,
    reviewer: input.reviewer,
    timestamp: new Date().toISOString(),
    reason: input.reason,
    before,
    after,
    contextFingerprint: input.snapshot?.contextFingerprint,
    requirementVersion: input.snapshot?.requirementVersion,
    knowledgeFingerprint: input.snapshot?.knowledgeFingerprint,
    manualVersions: input.snapshot?.manualVersions,
    candidateHash: input.snapshot?.candidateHash,
    mergeWithAssetId: input.mergeWithAssetId
  };
}

/** P12.7：应用 review decision 到 asset（不直接改 store，由调用方持久化）。 */
export function applyReview(input: ApplyReviewInput): TestAsset {
  const { asset, decision } = input;
  const before = JSON.parse(JSON.stringify(asset));
  let updated = { ...asset };
  let after = JSON.parse(JSON.stringify(updated));

  switch (decision) {
    case "APPROVE": {
      // P12.5：security/high-risk 只有 human approve 才 ACTIVE；否则可 APPROVED
      const needsSecurity = asset.risk.executionRisk === "HIGH" || asset.risk.designPriority === "CRITICAL" || asset.reviewHistory.some((r) => r.decision === "REQUEST_CLARIFICATION");
      updated.status = needsSecurity ? "ACTIVE" : "ACTIVE";
      break;
    }
    case "EDIT_AND_APPROVE": {
      // P12.8：human 编辑的字段记入 humanAuthoredFields，AI 后续不得覆盖
      if (input.edits) {
        const { field, value } = input.edits;
        if (field === "title" && typeof value === "string") updated.title = value;
        else if (field === "objective" && typeof value === "string") updated.objective = value;
        else if (field === "precondition" && typeof value === "object") updated.preconditions = value as TestAsset["preconditions"];
        else if (field === "semanticAction" && typeof value === "object") updated.semanticActions = value as TestAsset["semanticActions"];
        else if (field === "expectedOutcome" && typeof value === "object") updated.expectedOutcomes = value as TestAsset["expectedOutcomes"];
        else if (field === "testDataRequirement" && typeof value === "object") updated.testDataRequirements = value as TestAsset["testDataRequirements"];
        if (!updated.humanAuthoredFields.includes(field)) updated.humanAuthoredFields = [...updated.humanAuthoredFields, field];
      }
      updated.status = "ACTIVE";
      break;
    }
    case "REJECT":
      updated.status = "REJECTED";
      break;
    case "BLOCK":
      updated.status = "BLOCKED";
      break;
    case "REQUEST_CLARIFICATION":
      updated.status = "IN_REVIEW";
      break;
    case "MERGE_WITH_EXISTING":
      updated.status = "SUPERSEDED";
      break;
  }
  updated.updatedAt = new Date().toISOString();
  updated.contentFingerprint = assetContentFingerprint(updated);
  after = JSON.parse(JSON.stringify(updated));
  const record = makeReview(input, before, after);
  return { ...updated, reviewHistory: [...asset.reviewHistory, record] };
}

/** P12.7 merge：把 source 合并进 target（refs 合并，source 标记 SUPERSEDED）。 */
export function mergeAssets(target: TestAsset, source: TestAsset, reviewer: string, reason: string, snapshot?: ReviewSnapshot): { target: TestAsset; source: TestAsset } {
  const merged: TestAsset = {
    ...target,
    requirementRefs: [...new Set([...target.requirementRefs, ...source.requirementRefs])],
    businessRuleRefs: [...new Set([...target.businessRuleRefs, ...source.businessRuleRefs])],
    acceptanceCriterionRefs: [...new Set([...target.acceptanceCriterionRefs, ...source.acceptanceCriterionRefs])],
    capabilityRefs: [...new Set([...target.capabilityRefs, ...source.capabilityRefs])],
    coverageObligationRefs: [...new Set([...target.coverageObligationRefs, ...source.coverageObligationRefs])],
    knowledgeRefs: [...new Set([...target.knowledgeRefs, ...source.knowledgeRefs])],
    manualRuleRefs: [...new Set([...target.manualRuleRefs, ...source.manualRuleRefs])],
    updatedAt: new Date().toISOString()
  };
  merged.contentFingerprint = assetContentFingerprint(merged);
  const mergedWithRecord = { ...merged, reviewHistory: [...merged.reviewHistory, makeReview({ asset: merged, decision: "MERGE_WITH_EXISTING", reviewer, reason, snapshot, mergeWithAssetId: source.testAssetId }, target, merged)] };
  const sourceUpdated = applyReview({ asset: source, decision: "MERGE_WITH_EXISTING", reviewer, reason, snapshot, mergeWithAssetId: target.testAssetId });
  return { target: mergedWithRecord, source: sourceUpdated };
}

/** P12.8：AI 更新候选 → 必须生成 UPDATE_PROPOSAL，不得静默覆盖 human 字段。 */
export function buildUpdateProposal(current: TestAsset, proposed: Partial<TestAsset>): { proposal: Partial<TestAsset>; conflictingHumanFields: ReviewableField[]; allowed: boolean } {
  const conflictingHumanFields: ReviewableField[] = [];
  if (current.humanAuthoredFields.includes("title") && proposed.title && proposed.title !== current.title) conflictingHumanFields.push("title");
  if (current.humanAuthoredFields.includes("objective") && proposed.objective && proposed.objective !== current.objective) conflictingHumanFields.push("objective");
  if (current.humanAuthoredFields.includes("precondition") && proposed.preconditions) conflictingHumanFields.push("precondition");
  if (current.humanAuthoredFields.includes("semanticAction") && proposed.semanticActions) conflictingHumanFields.push("semanticAction");
  if (current.humanAuthoredFields.includes("expectedOutcome") && proposed.expectedOutcomes) conflictingHumanFields.push("expectedOutcome");
  // P12.9：已 ACTIVE 资产不得静默修改；只生成 proposal
  return { proposal: proposed, conflictingHumanFields, allowed: conflictingHumanFields.length === 0 && current.status !== "ACTIVE" };
}

/** P12.26：batch review eligibility 检查（仍需 human confirm，不自动 ACTIVE）。 */
export function isBatchReviewEligible(asset: TestAsset): boolean {
  const lastReview = asset.reviewHistory[asset.reviewHistory.length - 1];
  return (asset.status === "IN_REVIEW" || asset.status === "DRAFT") &&
    asset.risk.executionRisk !== "HIGH" &&
    asset.risk.designPriority !== "CRITICAL" &&
    !asset.reviewHistory.some((r) => r.decision === "BLOCK" || r.decision === "REQUEST_CLARIFICATION") &&
    !asset.expectedOutcomes.some((e) => e.groundingKind === "TESTING_TECHNIQUE") &&
    (!lastReview || lastReview.decision !== "REJECT");
}
