/**
 * P13.6/9：ExecutionIntent + Capability→Page 解析。
 *
 * ExecutionIntent 是 TestAsset 与 DSL 之间的稳定桥梁（不拼 DSL JSON）。
 * Capability → Page：当前 registry/routing 才是事实，asset.executionPath.pages 只是 hint。
 */

import type { TestAsset } from "./types.js";
import type { ExecutionIntent, ExecutionIntentOperation } from "./execution-types.js";
import { toIntentOperation } from "./action-registry.js";

export function buildExecutionIntent(asset: TestAsset): ExecutionIntent {
  const operations: ExecutionIntentOperation[] = asset.semanticActions.map((a) => toIntentOperation({ action: a.action, target: a.target }));
  const entities = [...new Set(asset.semanticActions.map((a) => a.target).filter(Boolean))];
  return {
    capabilities: [...asset.capabilityRefs],
    operations,
    entities,
    expectedOutcomes: asset.expectedOutcomes.map((o) => ({ statement: o.statement })),
    preconditions: asset.preconditions.map((p) => ({ statement: p.statement })),
    testDataBindings: asset.testDataRequirements.map((d) => ({ dimension: d.dimension, value: d.value }))
  };
}

export interface PageResolutionResult {
  pages: string[];
  primaryPage?: string;
  unresolvedCapabilities: string[];
  resolutionSource: "ROUTING" | "ASSET_HINT" | "UNRESOLVED";
  /** routing 单独推导的页面（不含 stored hint），用于 PAGE_HINT_STALE 判断。 */
  routingPages: string[];
}

/**
 * P13.9：capability → relevant pages。
 * 优先当前 capability registry/routing（此处接受外部 resolver），
 * 否则 fallback 到 asset.executionPath.pages（只是 hint）。
 */
export function resolvePagesForAsset(
  asset: TestAsset,
  capabilityPageResolver?: (capability: string) => string[] | undefined
): PageResolutionResult {
  const stored = new Set(asset.executionPath.pages ?? []);
  const pages = new Set<string>(stored);
  const routingPages = new Set<string>();
  const unresolvedCapabilities: string[] = [];
  let resolutionSource: PageResolutionResult["resolutionSource"] = stored.size ? "ASSET_HINT" : "UNRESOLVED";
  if (capabilityPageResolver) {
    let usedRouting = false;
    for (const cap of asset.capabilityRefs) {
      const resolved = capabilityPageResolver(cap);
      if (resolved && resolved.length) {
        resolved.forEach((p) => { pages.add(p); routingPages.add(p); });
        usedRouting = true;
      } else {
        unresolvedCapabilities.push(cap);
      }
    }
    if (usedRouting) resolutionSource = "ROUTING";
  }
  const primaryPage = pages.values().next().value;
  return { pages: [...pages], primaryPage, unresolvedCapabilities, resolutionSource, routingPages: [...routingPages] };
}

/** P13.10：Page Model Freshness Check（execution 前）。 */
export function checkPageModelFreshness(input: {
  pages: string[];
  pageModelStatus?: (pageId: string) => { exists: boolean; superseded: boolean; fresh: boolean; hasRequiredElements: boolean } | undefined;
}): { missing: string[]; superseded: string[]; stale: string[]; incomplete: string[]; ok: boolean } {
  const missing: string[] = [];
  const superseded: string[] = [];
  const stale: string[] = [];
  const incomplete: string[] = [];
  for (const page of input.pages) {
    const status = input.pageModelStatus?.(page);
    if (!status?.exists) { missing.push(page); continue; }
    if (status.superseded) superseded.push(page);
    if (!status.fresh) stale.push(page);
    if (!status.hasRequiredElements) incomplete.push(page);
  }
  return { missing, superseded, stale, incomplete, ok: missing.length === 0 && superseded.length === 0 && incomplete.length === 0 };
}
