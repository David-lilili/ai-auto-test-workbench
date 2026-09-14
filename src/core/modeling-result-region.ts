/**
 * P8.12/P8.13：ResultRegion 正式进入 Page Model + 受控 writeback。
 *
 * P8.12：resultRegions[] 最小字段：resultRegionId / type / regionLocator / columns /
 * rowLocator / emptyState / pagination / status / evidence / verificationHistory。
 * emptyState 是 region 子属性，不是单独 type。
 *
 * P8.13：写回必须走 proposal → controlled writeback；允许 candidate/dom_verified，
 * 禁止 execution_verified（除非真实 DSL execution）。重复 scanner 不得重复写相同 region。
 * 生成 resultRegionSemanticKey（pageId + type + 列签名 + emptyState 签名）做幂等。
 *
 * 铁律：只读结构建模，不推断业务正确性。
 */

export type ResultRegionKind = "TABLE" | "GRID" | "LIST" | "CARD_LIST";

export interface ResultRegionModel {
  resultRegionId: string;
  type: ResultRegionKind;
  regionLocator?: string;
  columns: Array<{ semanticName: string; targetField?: string }>;
  rowLocator?: string;
  emptyState?: string[];
  pagination?: string[];
  status: "candidate" | "dom_verified" | "execution_verified";
  evidence: string[];
  verificationHistory?: Array<Record<string, unknown>>;
}

export const RESULT_REGION_VERSION = "result-region.v1";

/** P8.12：从 scanner 结果归一化为正式模型（emptyState 是子属性）。 */
export function toResultRegionModel(
  input: { resultRegionId: string; type: string; columns?: string[]; rowLocator?: string; emptyState?: string[]; pagination?: string[]; evidence?: string[] }
): ResultRegionModel {
  const type = mapRegionKind(input.type);
  return {
    resultRegionId: input.resultRegionId,
    type,
    regionLocator: input.rowLocator ? `[role='${input.rowLocator.replace(/[^a-z0-9]/gi, "")}']` : undefined,
    columns: (input.columns ?? []).map((c) => ({ semanticName: c })),
    rowLocator: input.rowLocator,
    emptyState: input.emptyState?.length ? input.emptyState : undefined,
    pagination: input.pagination?.length ? input.pagination : undefined,
    status: "dom_verified",
    evidence: input.evidence ?? []
  };
}

function mapRegionKind(type: string): ResultRegionKind {
  switch (String(type ?? "").toLowerCase()) {
    case "table": return "TABLE";
    case "grid": return "GRID";
    case "list": return "LIST";
    case "card_list": return "CARD_LIST";
    case "empty_state": return "LIST"; // empty_state 不再是独立 type → 归 LIST，emptyState 记录文本
    default: return "LIST";
  }
}

/** P8.13：幂等语义键（同 page + 同 type + 同列签名 + 同空状态签名 → 同一 region）。 */
export function buildResultRegionSemanticKey(pageId: string, region: ResultRegionModel): string {
  const cols = (region.columns ?? []).map((c) => c.semanticName).join(",");
  const empty = (region.emptyState ?? []).join(",");
  return `${pageId}|${region.type}|${cols}|${empty}`;
}

/** P8.13：判断已存在的 regions 是否已覆盖该 region（幂等）。 */
export function isResultRegionAlreadyModeled(pageId: string, region: ResultRegionModel, existing: ResultRegionModel[]): boolean {
  const key = buildResultRegionSemanticKey(pageId, region);
  return existing.some((r) => buildResultRegionSemanticKey(pageId, r) === key);
}

/** 受控写回结果（proposal → 不 direct-write 的模拟）。 */
export interface ResultRegionWritebackResult {
  action: "append" | "skip_duplicate" | "rejected";
  resultRegionId?: string;
  reason: string;
  backupPath?: string;
}

/**
 * P8.13：受控写回。返回 append（新增）/ skip_duplicate（幂等跳过）/ rejected（状态越界）。
 * 不直接修改 store——返回 proposal，由调用方（review lifecycle / orchestrator）落库并备份。
 */
export function planResultRegionWriteback(
  pageId: string,
  region: ResultRegionModel,
  existing: ResultRegionModel[],
  options?: { allowExecutionVerified?: boolean }
): ResultRegionWritebackResult {
  if (region.status === "execution_verified" && !options?.allowExecutionVerified) {
    return { action: "rejected", reason: "execution_verified 禁止自动写回（需真实 DSL execution）" };
  }  if (isResultRegionAlreadyModeled(pageId, region, existing)) {
    return { action: "skip_duplicate", reason: "resultRegionSemanticKey 已存在，幂等跳过" };
  }
  return { action: "append", resultRegionId: region.resultRegionId, reason: "candidate/dom_verified 受控写回" };
}
