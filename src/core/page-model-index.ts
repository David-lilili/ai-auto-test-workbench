import type { PageModelStoreRecord } from "./page-model-types.js";

/**
 * Page Model 索引重建（P2.0）：deterministic 纯函数，从 canonical models 完整重建三个索引。
 *
 * Source-of-truth 原则：models 是唯一事实源；indexes 只是查询加速。
 * byModuleAction 键 = `${module}.${action}`（action 缺失时为 undefined 段，与历史形态兼容）；
 * byCapability 键 = element 前缀中隐含的页面能力段（`${elementId 去掉末段}` 的首个点分段）。
 *
 * 纯函数：不修改入参，返回全新索引对象；无 IO、无 LLM。
 */

export interface PageModelIndexes {
  byPageId: Record<string, number>;
  byModuleAction: Record<string, string[]>;
  byCapability: Record<string, string[]>;
}

/** capability 段提取：elementId 形如 `c2.withdraw.asset_usdt_selector` → `c2.withdraw`。 */
function capabilityKeyOfElement(elementId: string): string | undefined {
  const parts = elementId.split(".").filter(Boolean);
  if (parts.length < 2) return undefined;
  return parts.slice(0, -1).join(".");
}

export function rebuildPageModelIndexes(models: Array<Record<string, unknown>>): PageModelIndexes {
  const byPageId: Record<string, number> = {};
  const byModuleAction = new Map<string, Set<string>>();
  const byCapability = new Map<string, Set<string>>();

  for (let index = 0; index < models.length; index += 1) {
    const model = models[index];
    const pageId = String(model.pageId ?? "");
    if (!pageId) continue;
    byPageId[pageId] = index;

    const module = String(model.module ?? "undefined");
    const action = String(model.action ?? "undefined");
    const moduleActionKey = `${module}.${action}`;
    if (!byModuleAction.has(moduleActionKey)) byModuleAction.set(moduleActionKey, new Set());
    byModuleAction.get(moduleActionKey)!.add(pageId);

    const elements = Array.isArray(model.elements) ? model.elements as Array<Record<string, unknown>> : [];
    for (const element of elements) {
      const elementId = String(element.elementId ?? "");
      if (!elementId) continue;
      const capabilityKey = capabilityKeyOfElement(elementId);
      if (!capabilityKey) continue;
      if (!byCapability.has(capabilityKey)) byCapability.set(capabilityKey, new Set());
      byCapability.get(capabilityKey)!.add(pageId);
    }
  }

  // 排序保证确定性（Map 迭代顺序受插入顺序影响，输出前统一按 key 排序）
  const sortedModuleAction: Record<string, string[]> = {};
  for (const key of [...byModuleAction.keys()].sort()) {
    sortedModuleAction[key] = [...byModuleAction.get(key)!].sort();
  }
  const sortedCapability: Record<string, string[]> = {};
  for (const key of [...byCapability.keys()].sort()) {
    sortedCapability[key] = [...byCapability.get(key)!].sort();
  }

  return { byPageId, byModuleAction: sortedModuleAction, byCapability: sortedCapability };
}

/** 只读审计：报告现有索引与重建结果之间的差异（不修改任何东西）。 */
export function auditPageModelIndexes(store: PageModelStoreRecord): {
  byPageId: { staleEntries: string[]; wrongPositions: string[]; missingEntries: string[] };
  byModuleAction: { staleKeys: string[]; missingKeys: string[]; divergedKeys: Array<{ key: string; expected: string[]; actual: string[] }> };
  byCapability: { staleKeys: string[]; divergedKeys: Array<{ key: string; expected: string[]; actual: string[] }> };
} {
  const rebuilt = rebuildPageModelIndexes(store.models);
  const models = store.models;

  const byPageIdIssues = { staleEntries: [] as string[], wrongPositions: [] as string[], missingEntries: [] as string[] };
  const actualByPageId = (store.indexes as Record<string, unknown> | undefined)?.byPageId as Record<string, number> | undefined ?? {};
  for (const key of Object.keys(actualByPageId)) {
    if (!(key in rebuilt.byPageId)) byPageIdIssues.staleEntries.push(key);
    else if (actualByPageId[key] !== rebuilt.byPageId[key]) byPageIdIssues.wrongPositions.push(key);
  }
  for (const key of Object.keys(rebuilt.byPageId)) {
    if (!(key in actualByPageId)) byPageIdIssues.missingEntries.push(key);
  }

  const byModuleActionIssues = { staleKeys: [] as string[], missingKeys: [] as string[], divergedKeys: [] as Array<{ key: string; expected: string[]; actual: string[] }> };
  const actualBMA = (store.indexes as Record<string, unknown> | undefined)?.byModuleAction as Record<string, string[]> | undefined ?? {};
  for (const key of Object.keys(actualBMA)) {
    if (!(key in rebuilt.byModuleAction)) byModuleActionIssues.staleKeys.push(key);
    else if (JSON.stringify([...actualBMA[key]].sort()) !== JSON.stringify(rebuilt.byModuleAction[key])) {
      byModuleActionIssues.divergedKeys.push({ key, expected: rebuilt.byModuleAction[key], actual: actualBMA[key] });
    }
  }
  for (const key of Object.keys(rebuilt.byModuleAction)) {
    if (!(key in actualBMA)) byModuleActionIssues.missingKeys.push(key);
  }

  const byCapabilityIssues = { staleKeys: [] as string[], divergedKeys: [] as Array<{ key: string; expected: string[]; actual: string[] }> };
  const actualBC = (store.indexes as Record<string, unknown> | undefined)?.byCapability as Record<string, string[]> | undefined ?? {};
  for (const key of Object.keys(actualBC)) {
    if (!(key in rebuilt.byCapability)) byCapabilityIssues.staleKeys.push(key);
    else if (JSON.stringify([...actualBC[key]].sort()) !== JSON.stringify(rebuilt.byCapability[key])) {
      byCapabilityIssues.divergedKeys.push({ key, expected: rebuilt.byCapability[key], actual: actualBC[key] });
    }
  }

  return { byPageId: byPageIdIssues, byModuleAction: byModuleActionIssues, byCapability: byCapabilityIssues };
}
