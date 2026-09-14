/**
 * P12.44/45/46/47：TestAsset Snapshot + Context 集成 + Fingerprint。
 */

import crypto from "node:crypto";
import type { TestAssetStoreFile, TestAsset } from "./types.js";

export interface TestAssetSnapshot {
  domain: string;
  assets: TestAsset[];
  requirementRefs: string[];
  businessRuleRefs: string[];
  capabilities: string[];
  budget: { total: number; included: number };
}

/** P12.46：按 requirement/capability/businessRule 选择相关资产（不把全部塞 Context）。 */
export function buildTestAssetSnapshot(input: {
  store: TestAssetStoreFile;
  domain: string;
  requirementIds?: string[];
  capabilities?: string[];
  businessRules?: string[];
  budgetLimit?: number;
  statuses?: Array<TestAsset["status"]>;
}): TestAssetSnapshot {
  const statuses = input.statuses ?? ["ACTIVE", "APPROVED", "IN_REVIEW"];
  let assets = input.store.assets.filter((a) => statuses.includes(a.status));
  if (input.requirementIds && input.requirementIds.length) assets = assets.filter((a) => a.requirementRefs.some((r) => input.requirementIds!.includes(r)));
  if (input.capabilities && input.capabilities.length) assets = assets.filter((a) => a.capabilityRefs.some((c) => input.capabilities!.includes(c)));
  if (input.businessRules && input.businessRules.length) assets = assets.filter((a) => a.businessRuleRefs.some((r) => input.businessRules!.includes(r)));
  const budget = input.budgetLimit ?? 20;
  const included = assets.slice(0, budget);
  return {
    domain: input.domain,
    assets: included,
    requirementRefs: [...new Set(included.flatMap((a) => a.requirementRefs))],
    businessRuleRefs: [...new Set(included.flatMap((a) => a.businessRuleRefs))],
    capabilities: [...new Set(included.flatMap((a) => a.capabilityRefs))],
    budget: { total: assets.length, included: included.length }
  };
}

/** P12.47：TestAsset 加入后 Context Fingerprint 应变化。 */
export function testAssetSnapshotFingerprint(snapshot: TestAssetSnapshot): string {
  const payload = JSON.stringify({
    assets: snapshot.assets.map((a) => `${a.testAssetId}@${a.version}:${a.contentFingerprint}`).sort(),
    requirementRefs: snapshot.requirementRefs.sort(),
    capabilities: snapshot.capabilities.sort()
  });
  return crypto.createHash("sha256").update(payload).digest("hex").slice(0, 16);
}
