/**
 * P12.48：Asset Doctor。
 */

import type { TestAsset, TestAssetStoreFile } from "./types.js";
import { testAssetSemanticKey } from "./semantic-key.js";
import { assetContentFingerprint } from "./store.js";
import { computeAssetCoverage } from "./coverage.js";

export interface AssetDoctorReport {
  pass: boolean;
  issues: string[];
  duplicateSemanticKey: string[];
  missingRequirement: string[];
  missingBusinessRule: string[];
  missingCapability: string[];
  brokenProvenance: string[];
  activePointingRejectedKnowledge: string[];
  supersededRequirementStale: string[];
  criticalCoverageGap: string[];
  invalidRisk: string[];
  invalidAccountProfile: string[];
  executionPathBroken: string[];
  versionCycle: string[];
  silentMutation: string[];
}

export function runAssetDoctor(input: {
  store: TestAssetStoreFile;
  knownRequirements: string[];
  knownBusinessRules: string[];
  knownCapabilities: string[];
  knownKnowledgeIds: string[];
  criticalObligationRefs: string[];
}): AssetDoctorReport {
  const report: AssetDoctorReport = {
    pass: true, issues: [], duplicateSemanticKey: [], missingRequirement: [], missingBusinessRule: [], missingCapability: [],
    brokenProvenance: [], activePointingRejectedKnowledge: [], supersededRequirementStale: [], criticalCoverageGap: [],
    invalidRisk: [], invalidAccountProfile: [], executionPathBroken: [], versionCycle: [], silentMutation: []
  };
  const seen = new Map<string, string[]>();
  const relevant = input.store.assets.filter((a) => ["ACTIVE", "APPROVED", "IN_REVIEW", "DRAFT"].includes(a.status));
  for (const a of relevant) {
    const key = testAssetSemanticKey(a);
    const list = seen.get(key) ?? [];
    list.push(`${a.testAssetId}@${a.version}`);
    seen.set(key, list);

    // 完整性指纹（P12.71）
    if (assetContentFingerprint(a) !== a.contentFingerprint) { report.silentMutation.push(`${a.testAssetId}@${a.version}`); report.pass = false; }
    // requirement / rule / capability 引用
    a.requirementRefs.forEach((r) => { if (!input.knownRequirements.includes(r)) { report.missingRequirement.push(`${a.testAssetId}:${r}`); report.pass = false; } });
    a.businessRuleRefs.forEach((r) => { if (!input.knownBusinessRules.includes(r)) { report.missingBusinessRule.push(`${a.testAssetId}:${r}`); report.pass = false; } });
    a.capabilityRefs.forEach((r) => { if (!input.knownCapabilities.includes(r)) { report.missingCapability.push(`${a.testAssetId}:${r}`); report.pass = false; } });
    // provenance
    if (!a.provenance || a.provenance.length === 0) { report.brokenProvenance.push(a.testAssetId); report.pass = false; }
    // ACTIVE asset 指向 rejected knowledge
    if (a.status === "ACTIVE") {
      a.knowledgeRefs.forEach((k) => { if (!input.knownKnowledgeIds.includes(k)) { report.activePointingRejectedKnowledge.push(`${a.testAssetId}:${k}`); report.pass = false; } });
    }
    // risk 合法
    if (!["CRITICAL", "HIGH", "MEDIUM", "LOW"].includes(a.risk.designPriority) || !["HIGH", "MEDIUM", "LOW", "FORBIDDEN"].includes(a.risk.executionRisk)) {
      report.invalidRisk.push(a.testAssetId); report.pass = false;
    }
    // execution path 结构（P12.19：UNKNOWN 路径不视为 broken；只查结构缺失）
    if (!a.executionPath || !Array.isArray(a.executionPath.semanticActions)) {
      report.executionPathBroken.push(a.testAssetId); report.pass = false;
    }
    // account profile dimension 合法
    for (const ap of a.accountProfileRequirements ?? []) {
      if (!["KYC", "balance", "security", "permission", "network", "asset"].includes(ap.dimension)) { report.invalidAccountProfile.push(`${a.testAssetId}:${ap.dimension}`); report.pass = false; }
    }
  }
  for (const [key, ids] of seen) { if (ids.length > 1) { report.duplicateSemanticKey.push(key); report.pass = false; } }
  // critical coverage gap
  const coverage = computeAssetCoverage(input.store);
  const covered = new Set(coverage.map((c) => c.factId));
  const gaps = input.criticalObligationRefs.filter((r) => !covered.has(r));
  if (gaps.length) { report.criticalCoverageGap = gaps; report.pass = false; }
  // superseded requirement 上的 stale asset
  for (const a of input.store.assets) {
    if (a.status === "ACTIVE" && a.assetFreshness === "STALE") report.supersededRequirementStale.push(a.testAssetId);
  }
  report.issues = [...report.duplicateSemanticKey, ...report.missingRequirement, ...report.missingBusinessRule, ...report.missingCapability,
    ...report.brokenProvenance, ...report.activePointingRejectedKnowledge, ...report.supersededRequirementStale,
    ...report.criticalCoverageGap, ...report.invalidRisk, ...report.invalidAccountProfile, ...report.executionPathBroken, ...report.versionCycle, ...report.silentMutation];
  return report;
}
