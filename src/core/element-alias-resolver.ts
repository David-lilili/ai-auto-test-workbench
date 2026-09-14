/**
 * Element Alias / Supersession Core（P16.7）——elementId 级重定向解析器。
 *
 * 用途：Evidence Store 是 append-only / immutable，旧 evidence 的 targetId 指向
 * 未来需要收敛的 duplicate elementId，既不能改 evidence.targetId，也不能直接删除
 * 被 evidence 引用的 element。本模块提供持久 alias 机制的解析与校验：
 *
 *   old_element_2 →（alias）→ canonical_element
 *
 * 查询/聚合时经 resolveCanonicalElementId 解析，evidence 文件保持原样。
 *
 * 硬规则：
 * - 链式解析：A → B → C 最终解析为 C；
 * - cycle（A→B→A）、self alias（A→A）、canonical target 缺失 → 抛 ElementAliasError 拒绝；
 * - alias 治理：reason 仅允许 SAME_SEMANTIC_ELEMENT / SUPERSEDED；
 *   STATE_VARIANT / REAL_DISTINCT_ELEMENT / IDENTITY_UNRESOLVED 一律非法；
 * - canonical target 必须真实存在于该 model 的 elements[]；
 * - 无 elementAliases 的旧 model → 返回原 id，行为完全不变。
 *
 * 本模块只读，不修改 model / evidence / 任何存储。
 */
import type { ElementAliasEntry, PageModelWithAliases } from "./page-model-types.js";

/** 合法 alias reason（治理白名单）。 */
export const ALLOWED_ALIAS_REASONS = ["SAME_SEMANTIC_ELEMENT", "SUPERSEDED"] as const;

/** 明确禁止的 reason（这些语义状态不得收敛为 alias）。 */
export const REJECTED_ALIAS_REASONS = ["STATE_VARIANT", "REAL_DISTINCT_ELEMENT", "IDENTITY_UNRESOLVED"] as const;

export class ElementAliasError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ElementAliasError";
  }
}

function aliasMapOf(aliases: ElementAliasEntry[]): Map<string, ElementAliasEntry> {
  const bySource = new Map<string, ElementAliasEntry>();
  for (const entry of aliases) {
    const source = String(entry.aliasElementId ?? "");
    if (!source) throw new ElementAliasError("alias 缺少 aliasElementId");
    if (bySource.has(source)) throw new ElementAliasError(`alias 源重复：${source}`);
    bySource.set(source, entry);
  }
  return bySource;
}

/** 解析链终点：沿 alias 链走到不再有 alias 的 id；遇到环抛错。 */
function traceTerminal(bySource: Map<string, ElementAliasEntry>, start: string): string {
  const visited = new Set<string>();
  let current = start;
  while (true) {
    if (visited.has(current)) throw new ElementAliasError(`alias 环检测：${[...visited, current].join(" → ")}`);
    visited.add(current);
    const entry = bySource.get(current);
    if (!entry) return current;
    const target = String(entry.canonicalElementId ?? "");
    if (!target) throw new ElementAliasError(`alias ${current} 缺少 canonicalElementId`);
    if (target === current) throw new ElementAliasError(`self alias 拒绝：${current} → ${current}`);
    current = target;
  }
}

/**
 * 统一 elementId 解析：alias → canonical。
 * - 无 elementAliases（旧 schema）→ 返回原 id；
 * - 链式解析 A → B → C 返回 C；
 * - cycle / self alias / canonical target 不存在 → 抛 ElementAliasError（拒绝）。
 */
export function resolveCanonicalElementId(pageModel: PageModelWithAliases, elementId: string): string {
  const id = String(elementId ?? "");
  const aliases = Array.isArray(pageModel.elementAliases) ? pageModel.elementAliases : [];
  if (aliases.length === 0) return id;

  const bySource = aliasMapOf(aliases);
  const terminal = traceTerminal(bySource, id);

  const elements = Array.isArray(pageModel.elements) ? pageModel.elements : [];
  const exists = elements.some((el) => String((el as Record<string, unknown>).elementId ?? "") === terminal);
  if (!exists) throw new ElementAliasError(`canonical target 不存在：${terminal}`);
  return terminal;
}

/**
 * Alias 治理校验（建 alias / 加载 model 时调用）：
 * reason 白名单、self alias、alias 源重复、环、canonical target 存在性。
 * 返回 { valid, errors }，不抛错（供审计/拒绝时收集原因）。
 */
export function validateElementAliases(pageModel: PageModelWithAliases): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const aliases = Array.isArray(pageModel.elementAliases) ? pageModel.elementAliases : [];
  if (aliases.length === 0) return { valid: true, errors };

  const elementIds = new Set(
    (Array.isArray(pageModel.elements) ? pageModel.elements : []).map((el) => String((el as Record<string, unknown>).elementId ?? ""))
  );
  const bySource = new Map<string, ElementAliasEntry>();
  for (const entry of aliases) {
    const source = String(entry.aliasElementId ?? "");
    const target = String(entry.canonicalElementId ?? "");
    if (!source) errors.push("alias 缺少 aliasElementId");
    if (!target) errors.push("alias 缺少 canonicalElementId");
    if (source && target && source === target) errors.push(`self alias 拒绝：${source} → ${target}`);
    const reason = String(entry.reason ?? "");
    if (!(ALLOWED_ALIAS_REASONS as readonly string[]).includes(reason)) {
      errors.push(`非法 reason：${reason || "(空)"}（仅允许 ${ALLOWED_ALIAS_REASONS.join(" / ")}；${REJECTED_ALIAS_REASONS.join(" / ")} 等语义状态不得建 alias）`);
    }
    if (source && bySource.has(source)) errors.push(`alias 源重复：${source}`);
    if (source) bySource.set(source, entry);
    if (entry.createdAt === undefined || entry.createdAt === null || String(entry.createdAt) === "") errors.push(`alias ${source || "(无源)"} 缺少 createdAt`);
    if (entry.source === undefined || entry.source === null || String(entry.source) === "") errors.push(`alias ${source || "(无源)"} 缺少 source`);
  }

  // 链完整性：每个 alias 源都必须能解析到存在于 elements[] 的终点。
  for (const entry of aliases) {
    const source = String(entry.aliasElementId ?? "");
    if (!source) continue;
    try {
      const terminal = traceTerminal(bySource, source);
      if (!elementIds.has(terminal)) errors.push(`canonical target 不存在：${terminal}（alias 源 ${source}）`);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  return { valid: errors.length === 0, errors };
}
