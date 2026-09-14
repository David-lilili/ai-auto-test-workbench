/**
 * P8.14/P8.15：Column Model + Deterministic Semantic Mapping。
 *
 * P8.14：columns[] 正式结构，识别 <th> / role=columnheader / grid header / 稳定行对齐。
 * 避免普通文本、筛选 label、导航 tab 被误判 column。
 *
 * P8.15：AUTO column（"时间"）↔ gold（record_time/created_at/transaction_time）不能只按字符串匹配。
 * 优先 targetField → Operation Manual/domain vocabulary → header normalized tokens。
 * 不无限维护中文词典，优先复用 domain vocabulary（operation manual 的 dataBinding 规则）。
 */

export interface ColumnModel {
  columnId: string;
  semanticName: string;
  visibleText: string;
  index: number;
  targetField?: string;
  locator?: string;
  status: "candidate" | "dom_verified";
  evidence: string[];
}

export interface ColumnDetectionInput {
  /** 候选列头文本（去重前）。 */
  headers: Array<{ text: string; tag?: string; role?: string; index: number }>;
  /** 筛选 label / tab 文本（应排除，不误判为 column）。 */
  filterLabels?: string[];
  /** 导航 tab 文本（应排除）。 */
  tabTexts?: string[];
  /** domain vocabulary：{展示文本 → targetField}。 */
  domainVocabulary?: Record<string, string>;
}

/** 排除词：筛选 label、tab、操作按钮等常见非列头文本。 */
const COLUMN_NOISE = new Set([
  "查询", "搜索", "重置", "筛选", "全部", "操作", "更多", "展开", "收起",
  "上一页", "下一页", "第", "页", "共", "条", "确定", "取消", "关闭"
]);

/** 稳定语义映射：中文列头 → 通用 targetField（第一层 fallback，之后查 domain vocabulary）。 */
export const COLUMN_SEMANTIC_ALIASES: Record<string, string[]> = {
  "时间": ["record_time", "created_at", "transaction_time", "time"],
  "币种": ["asset", "coin", "currency", "symbol"],
  "数量": ["amount", "quantity", "count"],
  "金额": ["amount", "value", "money"],
  "状态": ["status", "state"],
  "类型": ["type", "category", "kind"],
  "地址": ["address"],
  "链": ["chain", "network"],
  "网络": ["chain", "network"],
  "手续费": ["fee", "tx_fee", "network_fee"],
  "备注": ["remark", "note", "memo"],
  "哈希": ["hash", "tx_hash", "transaction_hash"],
  "订单号": ["order_id", "order_no"],
  "流水号": ["record_id", "flow_no", "id"],
  "日期": ["record_time", "created_at", "date"],
  "方向": ["direction", "side", "type"]
};

/** P8.14：确定性列检测。 */
export function detectColumns(input: ColumnDetectionInput): ColumnModel[] {
  const filterSet = new Set((input.filterLabels ?? []).map((t) => t.trim().toLowerCase()));
  const tabSet = new Set((input.tabTexts ?? []).map((t) => t.trim().toLowerCase()));
  const columns: ColumnModel[] = [];
  const seen = new Set<string>();

  for (const header of input.headers) {
    const text = header.text.trim();
    const lower = text.toLowerCase();
    if (!text) continue;
    if (COLUMN_NOISE.has(text)) continue;
    if (filterSet.has(lower) || tabSet.has(lower)) continue;
    if (header.role && header.role !== "columnheader") continue;
    if (header.tag && header.tag !== "th" && header.tag !== "td" && header.tag !== "div" && header.tag !== "span") continue;
    if (seen.has(text)) continue;
    seen.add(text);
    const evidence: string[] = [];
    if (header.tag) evidence.push(`tag=${header.tag}`);
    if (header.role) evidence.push(`role=${header.role}`);
    const targetField = mapColumnToTargetField(text, input.domainVocabulary);
    columns.push({
      columnId: `column_${header.index + 1}`,
      semanticName: text,
      visibleText: text,
      index: header.index,
      targetField,
      status: "dom_verified",
      evidence
    });
  }
  return columns;
}

/** P8.15：确定性语义映射——优先 domain vocabulary，再 fallback 通用别名。 */
export function mapColumnToTargetField(visibleText: string, domainVocabulary?: Record<string, string>): string | undefined {
  const text = String(visibleText ?? "").trim();
  if (!text) return undefined;
  if (domainVocabulary && domainVocabulary[text]) return domainVocabulary[text];
  const aliases = COLUMN_SEMANTIC_ALIASES[text];
  if (aliases?.length) return aliases[0];
  // token 匹配（例如 "创建时间" → 时间别名）
  for (const [key, fields] of Object.entries(COLUMN_SEMANTIC_ALIASES)) {
    if (text.includes(key)) return fields[0];
  }
  return undefined;
}

/** 比较 AUTO 列集合与 gold 列集合，识别新增/删除/重命名。 */
export interface ColumnDiffResult {
  newColumns: Array<{ text: string; targetField?: string }>;
  removedColumns: Array<{ text: string }>;
  renamedColumns: Array<{ from: string; to: string; targetField?: string }>;
  unchanged: string[];
}

export function diffColumns(auto: ColumnModel[], gold: ColumnModel[]): ColumnDiffResult {
  const autoMap = new Map(auto.map((c) => [c.semanticName, c]));
  const goldMap = new Map(gold.map((c) => [c.semanticName, c]));
  const newColumns: ColumnDiffResult["newColumns"] = [];
  const removedColumns: ColumnDiffResult["removedColumns"] = [];
  const renamedColumns: ColumnDiffResult["renamedColumns"] = [];
  const unchanged: string[] = [];

  for (const [name, col] of autoMap) {
    if (goldMap.has(name)) { unchanged.push(name); continue; }
    // rename 判断：auto 的 targetField 与某个 gold 列匹配（语义相同但文本不同）
    const renameTarget = [...goldMap.entries()].find(([gName]) => {
      if (autoMap.has(gName)) return false;
      const gField = goldMap.get(gName)?.targetField;
      return col.targetField && gField && col.targetField === gField;
    });
    if (renameTarget) {
      renamedColumns.push({ from: renameTarget[0], to: name, targetField: col.targetField });
    } else {
      newColumns.push({ text: name, targetField: col.targetField });
    }
  }
  for (const [name] of goldMap) {
    if (!autoMap.has(name) && !renamedColumns.some((r) => r.from === name)) {
      removedColumns.push({ text: name });
    }
  }
  return { newColumns, removedColumns, renamedColumns, unchanged };
}
