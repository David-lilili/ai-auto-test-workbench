/**
 * P12.61：convertCandidateToTestAsset（不能简单 spread）。
 *
 * 流程：validate eligibility → normalize semantic intent → resolve refs →
 * freeze provenance → record review → assign version → contentFingerprint。
 */

import type { TestDesignCandidate } from "../test-design/types.js";
import type { TestAsset, ReviewRecord, TestDataRequirement } from "./types.js";
import { assetContentFingerprint } from "./store.js";

export interface ConvertInput {
  candidate: TestDesignCandidate;
  requirementId: string;
  requirementVersion: string;
  contextFingerprint?: string;
  designerVersion?: string;
  creationMode?: TestAsset["creationMode"];
  reviewer?: string;
  testDataResolver?: (d: string) => boolean;
  pageRefs?: string[];
  pageCapabilities?: string[];
}

/** P12.22：testDataRequirement → TestDataRequirement（resolved 判定）。 */
export function toTestDataRequirements(c: TestDesignCandidate, resolver?: (value: string) => boolean): TestDataRequirement[] {
  const reqs: TestDataRequirement[] = (c.testDataRequirements ?? []).map((d) => ({
    dimension: d.dimension as TestDataRequirement["dimension"],
    value: d.value,
    resolved: resolver ? resolver(d.value) : false,
    note: d.value.includes("NOT_") || d.value.includes("BELOW_") ? undefined : undefined
  }));
  // 常见 unresolved 标记：NOT_ / BELOW_ / ENABLED / LEVEL_2 / NORMAL_USER 等构造值（TEST_DATA_UNRESOLVED）
  return reqs.map((r) => ({ ...r, resolved: r.resolved || !/NOT_|BELOW_|ENABLED|LEVEL_2|NORMAL_USER/.test(r.value) }));
}

/**
 * P12.61 主转换：candidate → 新 TestAsset（v1，IN_REVIEW 或 DRAFT）。
 * 不覆盖已存在 asset（由 review/merge 流程处理，P12.12）。
 */
export function convertCandidateToTestAsset(input: ConvertInput): TestAsset {
  const { candidate: c } = input;
  const now = new Date().toISOString();
  const security = c.reviewStatus === "NEEDS_SECURITY_REVIEW" || c.risk.designPriority === "CRITICAL";
  const asset: TestAsset = {
    testAssetId: "", // 由调用方分配（TA-xxx）
    title: c.title,
    objective: c.objective,
    requirementRefs: [input.requirementId],
    businessRuleRefs: [...(c.coveredBusinessRuleIds ?? [])],
    acceptanceCriterionRefs: [...(c.coveredACIds ?? [])],
    capabilityRefs: [...(c.coveredCapabilityIds ?? [])],
    scenarioType: c.scenarioType,
    preconditions: c.preconditions.map((p) => ({ statement: p.statement, groundingKind: p.grounding.kind, factId: "factId" in p.grounding ? p.grounding.factId : undefined, knowledgeId: "knowledgeId" in p.grounding ? p.grounding.knowledgeId : undefined })),
    semanticActions: c.semanticActions.map((a) => ({ action: a.action, target: a.target ?? "", groundingKind: a.grounding.kind, factId: "factId" in a.grounding ? a.grounding.factId : undefined })),
    expectedOutcomes: c.expectedOutcomes.map((e) => ({ statement: e.statement, groundingKind: e.grounding.kind, factId: "factId" in e.grounding ? e.grounding.factId : undefined, knowledgeId: "knowledgeId" in e.grounding ? e.grounding.knowledgeId : undefined })),
    testDataRequirements: toTestDataRequirements(c, input.testDataResolver),
    accountProfileRequirements: [],
    risk: { ...c.risk },
    manualRuleRefs: [...(c.manualRuleRefs ?? [])],
    knowledgeRefs: [...(c.knowledgeRefs ?? [])],
    coverageObligationRefs: [...(c.coveredObligationIds ?? [])],
    executionPath: {
      status: "UNKNOWN",
      capabilities: input.pageCapabilities ?? [],
      pages: input.pageRefs ?? [],
      semanticActions: c.semanticActions.map((a) => ({ action: a.action, mapping: "UNMAPPED" }))
    },
    status: security ? "IN_REVIEW" : "DRAFT",
    version: "v1",
    createdAt: now,
    updatedAt: now,
    createdFromCandidateId: c.candidateId,
    humanAuthoredFields: [],
    reviewHistory: [],
    provenance: [
      { reason: `candidate ${c.candidateId}`, source: c.candidateId },
      { reason: `requirement ${input.requirementId}@${input.requirementVersion}`, source: input.requirementId },
      ...(c.provenance ?? []).map((p) => ({ reason: p.reason, source: p.source }))
    ],
    creationMode: input.creationMode ?? "SYSTEMATIC_BASELINE",
    contextFingerprint: input.contextFingerprint,
    designerVersion: input.designerVersion,
    contentFingerprint: "",
    assetFreshness: "FRESH",
    executionFreshness: "UNKNOWN"
  };
  asset.contentFingerprint = assetContentFingerprint(asset);
  return asset;
}

/** 分配稳定 assetId。 */
export function nextAssetId(existing: string[], prefix = "TA"): string {
  const nums = existing.map((id) => {
    const m = id.match(/(\d+)$/);
    return m ? Number(m[1]) : 0;
  });
  const next = (nums.length ? Math.max(...nums) : 0) + 1;
  return `${prefix}-${String(next).padStart(3, "0")}`;
}

/** P12.61：记录初次 review（可选）。 */
export function initialReview(asset: TestAsset, decision: ReviewRecord["decision"], reviewer: string, reason: string): TestAsset {
  const record: ReviewRecord = {
    reviewId: `rev_${asset.testAssetId}_${Date.now()}`,
    assetId: asset.testAssetId,
    assetVersion: asset.version,
    decision,
    reviewer,
    timestamp: new Date().toISOString(),
    reason
  };
  return { ...asset, reviewHistory: [...asset.reviewHistory, record] };
}
