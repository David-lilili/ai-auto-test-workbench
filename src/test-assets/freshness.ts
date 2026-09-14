/**
 * P12.37/38：Asset Freshness vs Execution Freshness 分离。
 *
 * - 业务测试仍然正确但页面 locator 全改 → TestAsset: FRESH，ExecutionPath: STALE。
 * - Requirement / Knowledge / Manual 变化 → 影响 Asset Freshness。
 * - Page 变化 → 最多 EXECUTION_PATH_STALE，不污染 Test Intent。
 */

import type { TestAsset, AssetFreshness, ExecutionFreshness } from "./types.js";

export interface FreshnessContext {
  /** requirementId → 是否已变更（V2 或 superseded）。 */
  requirementChanges: Set<string>;
  /** knowledgeId → 是否已 superseded/stale。 */
  knowledgeChanges: Set<string>;
  /** manualId → 版本变化。 */
  manualChanges: Record<string, string>;
  /** 当前 manual 版本。 */
  currentManualVersions?: Record<string, string>;
}

export function computeAssetFreshness(asset: TestAsset, ctx: FreshnessContext): AssetFreshness {
  // INVALID：引用的 requirement 不存在/被完全废弃且无替代
  if (asset.requirementRefs.length === 0) return "INVALID";
  // STALE：KB 事实 superseded 或 manual 大版本变化
  const knowledgeStale = asset.knowledgeRefs.some((k) => ctx.knowledgeChanges.has(k));
  const manualStale = asset.manualRuleRefs.some((r) => {
    const manualId = r.split(".").slice(0, 2).join(".");
    return ctx.manualChanges[manualId] !== undefined;
  });
  if (knowledgeStale || manualStale) return "STALE";
  // POSSIBLY_STALE：requirement 变更但未确认影响
  if (asset.requirementRefs.some((r) => ctx.requirementChanges.has(r))) return "POSSIBLY_STALE";
  return "FRESH";
}

/** P12.38：Page/执行路径变化 → 只影响 execution freshness。 */
export function computeExecutionFreshness(asset: TestAsset, pageChanged: boolean, pathKnown: boolean): ExecutionFreshness {
  if (pageChanged) return "STALE";
  if (!pathKnown) return "UNKNOWN";
  return "FRESH";
}

/** P12.35：KB superseded → 引用资产标记 KNOWLEDGE_STALE（不是删除）。 */
export function markKnowledgeStaleAssets(store: TestAsset[], supersededKnowledgeIds: string[]): TestAsset[] {
  const set = new Set(supersededKnowledgeIds);
  return store.map((a) => {
    if (a.knowledgeRefs.some((k) => set.has(k))) {
      return { ...a, assetFreshness: "STALE" as AssetFreshness };
    }
    return a;
  });
}

/** P12.36：Requirement V2 按 fact diff 判断影响（不统一废弃）。 */
export function affectedRefsByFactDiff(assetRefs: string[], changedFactIds: string[]): string[] {
  return assetRefs.filter((r) => changedFactIds.includes(r));
}
