/**
 * P12.33/34/36/69：Requirement V2 Preview + Manual Version Impact + Candidate Staleness。
 */

import type { TestAsset, RequirementChangeKind } from "./types.js";

/**
 * P12.33：轻量 preview——Requirement V1 的 TestAssets vs V2 的 Candidate。
 * 输出 UNCHANGED / POSSIBLE_UPDATE / NEW / POSSIBLE_REMOVE。
 */
export function previewRequirementV2Impact(input: {
  v1Assets: TestAsset[];
  v2CandidateRefs: Array<{ businessRuleRefs: string[]; acceptanceCriterionRefs: string[] }>;
  v1FactIds: string[];
  v2FactIds: string[];
}): Array<{ assetId: string; kind: RequirementChangeKind; reason: string }> {
  const v2Rules = new Set(input.v2CandidateRefs.flatMap((c) => c.businessRuleRefs));
  const v2Acs = new Set(input.v2CandidateRefs.flatMap((c) => c.acceptanceCriterionRefs));
  const removedFacts = input.v1FactIds.filter((f) => !input.v2FactIds.includes(f));

  return input.v1Assets.map((a) => {
    const coveredRules = a.businessRuleRefs.filter((r) => v2Rules.has(r));
    const coveredAcs = a.acceptanceCriterionRefs.filter((r) => v2Acs.has(r));
    const hasRemovedRef = [...a.businessRuleRefs, ...a.acceptanceCriterionRefs].some((r) => removedFacts.includes(r));
    if (hasRemovedRef && coveredRules.length === 0 && coveredAcs.length === 0) {
      return { assetId: a.testAssetId, kind: "POSSIBLE_REMOVE" as const, reason: "引用的 fact 在 V2 中移除且无替代" };
    }
    if (coveredRules.length > 0 || coveredAcs.length > 0) {
      return { assetId: a.testAssetId, kind: "UNCHANGED" as const, reason: "引用 fact 仍被 V2 覆盖" };
    }
    return { assetId: a.testAssetId, kind: "POSSIBLE_UPDATE" as const, reason: "V2 变化需人工确认影响" };
  });
}

/** P12.34：manual 版本变化 → MANUAL_UPDATE_SUGGESTION（不改 TestAsset）。 */
export function manualUpdateSuggestion(asset: TestAsset, currentManualVersions: Record<string, string>): { assetId: string; suggestion: string } | undefined {
  const usedManuals = new Set(asset.manualRuleRefs.map((r) => r.split(".").slice(0, 2).join(".")));
  const changes = [...usedManuals].filter((m) => currentManualVersions[m]);
  if (changes.length === 0) return undefined;
  return { assetId: asset.testAssetId, suggestion: `新 Manual 版本可能新增测试方法（${changes.join(", ")}），建议人工决定是否生成新 Candidate` };
}

/** P12.69：candidate 过期判定。 */
export function isCandidateStale(input: {
  candidateFingerprint: string;
  requirementChanged: boolean;
  knowledgeFingerprintChanged: boolean;
  manualMajorChanged: boolean;
}): boolean {
  return input.requirementChanged || input.knowledgeFingerprintChanged || input.manualMajorChanged;
}

/** P12.82：Task Profile 常量（供 context routing 使用）。 */
export const TEST_ASSET_TASK_PROFILES = ["TEST_ASSET_REVIEW", "TEST_ASSET_QUERY", "EXECUTION_PREP"];
