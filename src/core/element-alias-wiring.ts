/**
 * Element Alias Wiring（P16.7）——alias-aware 生产接入层。
 *
 * 职责：把 element-alias-resolver 的纯解析接入证据聚合 / writeback 查询路径。
 * 统一约定：
 *   sourceTargetId   —— 永远保留原始 evidence.targetId（provenance / audit 用）；
 *   canonicalTargetId —— 经 resolveCanonicalElementId 解析后的收敛 id。
 *
 * 规则：
 * - evidence / model / elementId 一律不改写（Evidence Store append-only）；
 * - resolveTargetIds 纯解析，cycle / self alias / canonical 缺失 → 抛 ElementAliasError（拒绝）；
 * - resolveTargetIdsSafe 供批量管线 fail-closed 兜底：异常 alias（环 / self alias /
 *   canonical 缺失 / 链断裂）→ resolved=false + resolutionIssue 诊断，绝不回退 source id，
 *   管线不崩，但该 target 不得进入任何 promotion / writeback；
 * - 无 elementAliases 的旧 model / 无 model → 恒等解析，行为完全不变。
 */
import { ElementAliasError, resolveCanonicalElementId } from "./element-alias-resolver.js";
import type { PageModelWithAliases } from "./page-model-types.js";

export interface ResolvedTargetIds {
  /** 原始 evidence.targetId（字节级不变）。 */
  sourceTargetId: string;
  /** alias 链解析终点；无 alias 时等于 sourceTargetId。 */
  canonicalTargetId: string;
}

/** 批量管线 fail-closed 版解析结果：invalid alias 不携带可继续 promotion 的伪 canonicalTargetId。 */
export interface TargetResolutionResult {
  /** 原始 evidence.targetId（字节级不变）。 */
  sourceTargetId: string;
  /** true = 合法解析（无 alias 恒等 / 合法 alias 链）；false = invalid alias（fail-closed）。 */
  resolved: boolean;
  /** 合法 canonical id；resolved=false 时不存在（禁止回退 source id）。 */
  canonicalTargetId?: string;
  /** resolved=false 时的确定性诊断（ElementAliasError message，可审计）。 */
  resolutionIssue?: string;
}

/** invalid alias 证据被 fail-closed 拒入聚合 / 写回时的审计条目（P16.7 Phase 2）。 */
export interface InvalidAliasBlockedEvidence {
  evidenceId: string;
  knowledgeType: string;
  pageId: string;
  targetId: string;
  reason: "INVALID_ALIAS";
  resolutionIssue: string;
}

/** 统一解析入口：alias → canonical。纯解析，异常 alias 直接抛 ElementAliasError。 */
export function resolveTargetIds(pageModel: PageModelWithAliases | undefined, targetId: string): ResolvedTargetIds {
  const sourceTargetId = String(targetId ?? "");
  if (!pageModel) return { sourceTargetId, canonicalTargetId: sourceTargetId };
  return { sourceTargetId, canonicalTargetId: resolveCanonicalElementId(pageModel, sourceTargetId) };
}

/**
 * 批量管线 fail-closed 兜底版：缺 model / 无 alias → 恒等解析（resolved=true）；
 * 异常 alias（环、self alias、canonical 缺失、链断裂）→ resolved=false + resolutionIssue。
 * 核心语义（P16.7 Phase 2）：invalid alias 绝不返回「伪 canonicalTargetId = sourceTargetId」，
 * 调用方必须按 resolved 分支处理，否则该证据会被拒入聚合 / 写回。
 */
export function resolveTargetIdsSafe(pageModel: PageModelWithAliases | undefined, targetId: string): TargetResolutionResult {
  const sourceTargetId = String(targetId ?? "");
  try {
    const canonicalTargetId = pageModel ? resolveCanonicalElementId(pageModel, sourceTargetId) : sourceTargetId;
    return { sourceTargetId, resolved: true, canonicalTargetId };
  } catch (error) {
    if (error instanceof ElementAliasError) {
      return { sourceTargetId, resolved: false, resolutionIssue: error.message };
    }
    throw error;
  }
}

/**
 * alias-aware 证据聚合（查询 canonical 的入口原语）：
 * 返回 evidenceList 中 resolve(targetId) === canonicalElementId 的全部证据——
 * 包括 alias 源证据（oldA / oldB）与 canonical 本体证据，三组一并聚合。
 */
export function collectEvidenceForCanonical<T extends { targetId: string }>(
  pageModel: PageModelWithAliases | undefined,
  evidenceList: readonly T[],
  canonicalElementId: string
): T[] {
  return evidenceList.filter((evidence) => resolveTargetIds(pageModel, evidence.targetId).canonicalTargetId === canonicalElementId);
}

/** 构建 pageId → model（含 elementAliases 视图）映射，供批量解析。 */
export function pageModelsOf(store: { models?: Array<Record<string, unknown>> }): Map<string, PageModelWithAliases> {
  const map = new Map<string, PageModelWithAliases>();
  for (const model of store.models ?? []) {
    map.set(String(model.pageId ?? ""), model as PageModelWithAliases);
  }
  return map;
}
