/**
 * P8.1 / P8.7：Assertion Noise Audit + Option Semantic Corruption Audit（分类器）。
 *
 * P8.1：把 AUTO assertion 分类为：
 *   A. TRUE_BUSINESS_ASSERTION
 *   B. SITE_NAV_NOISE
 *   C. HEADER_NOISE
 *   D. FOOTER_NOISE
 *   E. UTILITY_CONTROL_STATE
 *   F. DUPLICATE
 *   G. MISCLASSIFIED
 *   H. VALID_BUT_NOT_GOLD
 *   I. UNKNOWN
 *
 * P8.7：把 option 污染来源分类为：
 *   A. parent accessible name 污染
 *   B. current selected value 污染
 *   C. sibling option text 混合
 *   D. group label 混入
 *   E. portal container 文本污染
 *   F. duplicate option
 *   G. hidden option
 *   H. loading/error option
 *
 * 全部 deterministic，无 LLM。
 */

import { isSiteNavNoise } from "./modeling-semantic-match.js";
import { normalizeAssertionSemantics } from "./modeling-assertion-quality.js";
import { normalizeOptionText } from "./modeling-option-identity.js";

// ============ P8.1 assertion 分类 ============

export type AssertionAuditCategory =
  | "TRUE_BUSINESS_ASSERTION"
  | "SITE_NAV_NOISE"
  | "HEADER_NOISE"
  | "FOOTER_NOISE"
  | "UTILITY_CONTROL_STATE"
  | "DUPLICATE"
  | "MISCLASSIFIED"
  | "VALID_BUT_NOT_GOLD"
  | "UNKNOWN";

export interface AssertionAuditItem {
  assertionId?: string;
  semanticName: string;
  category: AssertionAuditCategory;
  reason: string;
}

/** 从 assertion 特征确定性分类。 */
export function classifyAutoAssertion(input: { semanticName: string; canonicalKind?: string; source?: string; assertionId?: string; inNav?: boolean; inHeader?: boolean; inFooter?: boolean; goldMatch?: boolean; seenBefore?: boolean }): AssertionAuditCategory {
  const name = String(input.semanticName ?? "");
  const source = String(input.source ?? "");
  const kind = String(input.canonicalKind ?? "");

  // 去重
  if (input.seenBefore) return "DUPLICATE";

  // nav/header/footer 噪音（名称特征）
  if (isSiteNavNoise({ semanticName: name })) return "SITE_NAV_NOISE";
  if (input.inHeader) return "HEADER_NOISE";
  if (input.inFooter) return "FOOTER_NOISE";

  // "可点击" 且非业务按钮词 → nav/utility 噪音
  if (/可点击/.test(name)) {
    const businessButton = /查询|搜索|重置|提交|保存|确认|下载|导出|筛选|删除|绑定|验证|充值|提现|购买/.test(name);
    if (!businessButton) return "UTILITY_CONTROL_STATE";
  }

  // 明确的业务断言（result/empty/column/record）
  if (/结果|列表|空状态|记录|列存在|筛选后|存在|可见文本|无数据/.test(name) && /result_table|result_region|structure_scan/.test(source)) {
    return "TRUE_BUSINESS_ASSERTION";
  }
  if (/element_enabled|element_disabled/.test(kind) && /查询|重置|搜索|提交|下载|导出|筛选/.test(name)) {
    return "TRUE_BUSINESS_ASSERTION";
  }

  // 有效但非 gold（页面模型有但 gold projection 未包含——跨模块/历史项）
  if (input.goldMatch === false) return "VALID_BUT_NOT_GOLD";

  // 分类错误（source 或 kind 与语义名不符）
  if (/clickable|nav|menu|header|footer/.test(source) && !/result|empty|record/.test(name)) return "MISCLASSIFIED";

  return "UNKNOWN";
}

/** 批量分类 + 占比统计。 */
export function auditAssertionCandidates(
  candidates: Array<{ semanticName: string; canonicalKind?: string; source?: string; assertionId?: string; inNav?: boolean; inHeader?: boolean; inFooter?: boolean }>,
  goldAssertionKeys?: Set<string>
): { items: AssertionAuditItem[]; counts: Record<AssertionAuditCategory, number>; proportions: Record<string, number> } {
  const seen = new Set<string>();
  const items: AssertionAuditItem[] = [];
  const counts: Record<AssertionAuditCategory, number> = {
    TRUE_BUSINESS_ASSERTION: 0, SITE_NAV_NOISE: 0, HEADER_NOISE: 0, FOOTER_NOISE: 0,
    UTILITY_CONTROL_STATE: 0, DUPLICATE: 0, MISCLASSIFIED: 0, VALID_BUT_NOT_GOLD: 0, UNKNOWN: 0
  };
  for (const c of candidates) {
    const norm = normalizeAssertionSemantics(c.semanticName);
    const seenBefore = seen.has(norm);
    if (!seenBefore) seen.add(norm);
    const goldMatch = goldAssertionKeys ? goldAssertionKeys.has(norm) : undefined;
    const category = classifyAutoAssertion({ ...c, goldMatch, seenBefore });
    counts[category] += 1;
    items.push({ assertionId: c.assertionId, semanticName: c.semanticName, category, reason: "" });
  }
  const total = items.length || 1;
  const proportions: Record<string, number> = {};
  for (const [k, v] of Object.entries(counts)) proportions[k] = Math.round((v / total) * 1000) / 1000;
  return { items, counts, proportions };
}

// ============ P8.7 option 污染分类 ============

export type OptionCorruptionCategory =
  | "PARENT_ACCESSIBLE_NAME_POLLUTION"
  | "CURRENT_SELECTED_VALUE_POLLUTION"
  | "SIBLING_OPTION_TEXT_MIX"
  | "GROUP_LABEL_MIXED"
  | "PORTAL_CONTAINER_TEXT_POLLUTION"
  | "DUPLICATE_OPTION"
  | "HIDDEN_OPTION"
  | "LOADING_ERROR_OPTION"
  | "CLEAN";

export interface OptionAuditItem {
  optionValue?: string;
  semanticName?: string;
  category: OptionCorruptionCategory;
  reason: string;
}

export function classifyOptionCorruption(input: {
  semanticName?: string;
  optionValue?: string;
  parentSemanticName?: string;
  triggerDisplayText?: string;
  siblingTexts?: string[];
  seenBefore?: boolean;
}): OptionCorruptionCategory {
  const name = String(input.semanticName ?? "");
  const value = String(input.optionValue ?? "");
  const parent = String(input.parentSemanticName ?? "");
  const trigger = String(input.triggerDisplayText ?? "");

  // 去重
  if (input.seenBefore) return "DUPLICATE_OPTION";

  // loading/error
  if (/加载|loading|错误|error|异常|暂无可选|网络异常|请稍后/.test(`${name} ${value}`)) return "LOADING_ERROR_OPTION";

  // 当前选中值污染：value 与 trigger 相同 / 语义名含 trigger 前缀
  if (trigger && (value === trigger || name.includes(trigger))) return "CURRENT_SELECTED_VALUE_POLLUTION";

  // parent accessible name 污染：语义名以"父名选项："开头或含父名（非干净 `<visibleText> 选项`）
  if (parent && (name.startsWith(`${parent}选项`) || name.includes(parent))) {
    // 若语义名是 `<value> 选项` 但 value 内含父名 → 仍污染
    return "PARENT_ACCESSIBLE_NAME_POLLUTION";
  }

  // 当前值 + 值 混在语义名（"AVAX Avalanche选项：ZEC暂停提币"）
  if (/选项：|选项:/ .test(name)) return "PARENT_ACCESSIBLE_NAME_POLLUTION";

  // group label 混入：语义名含 组/Group/分类 且长度异常
  if (/组|group|分类|全部/.test(name) && name.length > 20) return "GROUP_LABEL_MIXED";

  // portal container 文本污染：语义名包含触发控件文本之外的大段文案（>40 字符或含 ≈ $）
  if (name.length > 40 || /\$\d|≈/.test(name)) return "PORTAL_CONTAINER_TEXT_POLLUTION";

  // sibling 文本混合：value 内含相邻 option 文本（多个币种拼接）
  if (input.siblingTexts && input.siblingTexts.some((s) => s && s !== value && normalizeOptionText(value).includes(normalizeOptionText(s).slice(0, 3)) && normalizeOptionText(s).length > 2)) {
    return "SIBLING_OPTION_TEXT_MIX";
  }

  // 隐藏 option：value 为空但语义名非空 / 无语义 token
  if (!value || normalizeOptionText(value).length === 0) return "HIDDEN_OPTION";

  return "CLEAN";
}

/** 批量 option 污染审计。 */
export function auditOptions(
  options: Array<{ semanticName?: string; optionValue?: string; parentSemanticName?: string; triggerDisplayText?: string; siblingTexts?: string[] }>
): { items: OptionAuditItem[]; counts: Record<OptionCorruptionCategory, number>; proportions: Record<string, number> } {
  const seen = new Set<string>();
  const items: OptionAuditItem[] = [];
  const counts: Record<OptionCorruptionCategory, number> = {
    PARENT_ACCESSIBLE_NAME_POLLUTION: 0, CURRENT_SELECTED_VALUE_POLLUTION: 0, SIBLING_OPTION_TEXT_MIX: 0,
    GROUP_LABEL_MIXED: 0, PORTAL_CONTAINER_TEXT_POLLUTION: 0, DUPLICATE_OPTION: 0, HIDDEN_OPTION: 0, LOADING_ERROR_OPTION: 0, CLEAN: 0
  };
  for (const o of options) {
    const norm = normalizeOptionText(o.optionValue ?? o.semanticName ?? "");
    const seenBefore = seen.has(norm);
    if (!seenBefore) seen.add(norm);
    const category = classifyOptionCorruption({ ...o, seenBefore });
    counts[category] += 1;
    items.push({ optionValue: o.optionValue, semanticName: o.semanticName, category, reason: "" });
  }
  const total = items.length || 1;
  const proportions: Record<string, number> = {};
  for (const [k, v] of Object.entries(counts)) proportions[k] = Math.round((v / total) * 1000) / 1000;
  return { items, counts, proportions };
}
