// Page Model store 的最小类型视图（索引与覆盖共用）

export interface PageModelStoreRecord {
  schemaVersion?: string;
  project?: string;
  models: Array<Record<string, unknown>>;
  indexes?: Record<string, unknown>;
  updatedAt?: string;
}

/**
 * Element Alias / Supersession（P16.7）——elementId 级重定向，支撑 Market 历史
 * duplicate element 的安全收敛。
 *
 * 存放位置：page model 记录上的可选字段 `models[].elementAliases`（与 elements 同层），
 * 不建立第二套 Alias Store。旧 Page Model 无此字段 → 行为完全不变。
 *
 * 语义边界：
 * - alias 只用于已确认 SAME semantic element 或明确 SUPERSEDED 的收敛；
 * - STATE_VARIANT / REAL_DISTINCT_ELEMENT / IDENTITY_UNRESOLVED 不得建 alias；
 * - canonical target 必须真实存在于该 model 的 elements[]；
 * - alias source 可暂时保留在 elements[]，直到后续 reconciliation 再清理；
 * - evidence.targetId 永不改写，查询/聚合时经 resolveCanonicalElementId 解析。
 */
export type ElementAliasReason = "SAME_SEMANTIC_ELEMENT" | "SUPERSEDED";

export interface ElementAliasEntry {
  /** 被收敛的旧 elementId（alias 源）。 */
  aliasElementId: string;
  /** 收敛目标 elementId（必须存在于 elements[]）。 */
  canonicalElementId: string;
  /** 建 alias 的依据：仅 SAME_SEMANTIC_ELEMENT / SUPERSEDED 合法。 */
  reason: ElementAliasReason;
  /** 建 alias 时间（ISO 8601）。 */
  createdAt: string;
  /** 来源（如 audit/ 任务标识），可追溯。 */
  source: string;
}

/** 带 elementAliases 的 page model 视图（resolveCanonicalElementId 的入参形态）。 */
export interface PageModelWithAliases {
  elements?: Array<Record<string, unknown>>;
  elementAliases?: ElementAliasEntry[];
  [key: string]: unknown;
}

