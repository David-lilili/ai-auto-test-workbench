/**
 * P12.66：ExecutionPreparationPackage（P13 handoff，不是 DSL）。
 */

import type { TestAsset, ExecutionPreparationPackage } from "./types.js";

export function buildExecutionPreparationPackage(asset: TestAsset): ExecutionPreparationPackage {
  return {
    packageId: `${asset.testAssetId}@${asset.version}-prep`,
    asset,
    semanticActions: asset.semanticActions,
    expectedOutcomes: asset.expectedOutcomes,
    requiredCapabilities: asset.capabilityRefs,
    pageRefs: asset.executionPath.pages,
    testDataRequirements: asset.testDataRequirements,
    accountProfileRequirements: asset.accountProfileRequirements,
    executionRisk: asset.risk.executionRisk,
    knowledgeRefs: asset.knowledgeRefs,
    contextFingerprint: asset.contextFingerprint,
    executionPath: asset.executionPath
  };
}
