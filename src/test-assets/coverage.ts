/**
 * P12.39/40/41：Coverage 持久化 + Critical Gap 预警 + Review 前后预览。
 */

import type { TestAsset, TestAssetStoreFile } from "./types.js";

export interface CoverageEntry {
  factId: string;
  assetRefs: string[];
}

export function computeAssetCoverage(store: TestAssetStoreFile): CoverageEntry[] {
  const map = new Map<string, string[]>();
  for (const a of store.assets) {
    if (a.status === "REJECTED" || a.status === "DEPRECATED") continue;
    for (const ref of a.coverageObligationRefs) {
      const list = map.get(ref) ?? [];
      list.push(`${a.testAssetId}@${a.version}`);
      map.set(ref, list);
    }
  }
  return [...map.entries()].map(([factId, assetRefs]) => ({ factId, assetRefs }));
}

/** P12.40：reject 一个 candidate 后是否出现 CRITICAL 缺口。 */
export function criticalCoverageGapAfterReject(store: TestAssetStoreFile, rejectedAssetId: string, criticalObligationRefs: string[]): string[] {
  const remaining = new Set<string>();
  for (const a of store.assets) {
    if (a.testAssetId === rejectedAssetId) continue;
    if (a.status === "REJECTED" || a.status === "DEPRECATED") continue;
    for (const ref of a.coverageObligationRefs) remaining.add(ref);
  }
  return criticalObligationRefs.filter((ref) => !remaining.has(ref));
}

/** P12.41：批准/拒绝前后 coverage 预览。 */
export function reviewCoveragePreview(store: TestAssetStoreFile, pendingAssetIds: string[], criticalObligationRefs: string[]): {
  before: { criticalCovered: number; criticalTotal: number; ratio: number };
  afterApproveAll: { criticalCovered: number; criticalTotal: number; ratio: number };
  ifRejectOne: (assetId: string) => { criticalCovered: number; criticalTotal: number; ratio: number };
} {
  const count = (exclude: string[]) => {
    const covered = new Set<string>();
    for (const a of store.assets) {
      if (exclude.includes(a.testAssetId)) continue;
      if (a.status === "REJECTED" || a.status === "DEPRECATED") continue;
      for (const ref of a.coverageObligationRefs) covered.add(ref);
    }
    const criticalCovered = criticalObligationRefs.filter((r) => covered.has(r)).length;
    return { criticalCovered, criticalTotal: criticalObligationRefs.length, ratio: criticalObligationRefs.length ? criticalCovered / criticalObligationRefs.length : 1 };
  };
  return {
    // before：pending 资产尚未批准（排除全部 pending）
    before: count(pendingAssetIds),
    // afterApproveAll：全部 pending 批准
    afterApproveAll: count([]),
    ifRejectOne: (assetId) => count([assetId])
  };
}
