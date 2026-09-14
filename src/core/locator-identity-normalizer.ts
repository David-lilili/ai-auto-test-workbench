/**
 * Dynamic Locator Identity Guard（P16.5 收敛前置，仅 identity comparison 用）。
 *
 * 行情类元素（BTC/ETH/INTC/XAG/XAU）的 role locator 文本包含动态价格/涨跌幅，
 * 例如 "role=button:BTC 比特币 79,588.00 -1.40%"。
 * 若直接参与语义匹配，下一次快照（如 80,123.00 / -1.32%）会被判 conflict，
 * 持续制造 duplicate（SAME_ELEMENT_DYNAMIC_VALUE 已由 audit 确认）。
 *
 * 本模块只剥离动态数值 token；locatorCandidates 存储值从不修改，
 * 原始文本保持完整 evidence representation。
 *
 * 作用域规则（GLOBAL_DYNAMIC_STRIPPING_TOO_BROAD 修复）：
 * dynamic stripping 是显式 opt-in，不是全局默认。默认比较使用原始文本 identity；
 * 只有调用路径具备显式动态展示证据（Page Model writeback 标记的
 * semanticRole=captured_inventory，或元素上的 dynamicBinding / currentValue，
 * 见 hasExplicitDynamicContext）时，才允许通过 allowDynamicValueStripping=true
 * 剥离动态价格/涨跌幅。
 * 业务数字（最低 0.01 BTC、费率 0.1%、收益率 3.5%、价格精度 0.01、步骤 1、30 天）
 * 一律走默认路径，保持原文比较，绝不合并。
 */

/**
 * 动态数值 token（按优先级）：
 * 1. 涨跌幅百分比：[+-]?数字(含小数)%（-1.40%、+3.21%、-0.63%）
 * 2. 千分位价格：1-3 位数字 + ,NNN 组 + 两位小数（79,588.00、2,450.33、4,437.28），
 *    可选尾随符号（吸收 "79,588.00-" 中价格与百分比之间的连字符）
 * 3. 两位小数价格：如 95.75、66.26，可选尾随符号
 *
 * 业务数字（步骤 1/步骤 2、等级 1/等级 2、30 天/90 天、24h 涨幅榜/跌幅榜）
 * 均为无小数、无千分位、无 % 的整数 token，不会被上述模式命中。
 */
const DYNAMIC_VALUE_TOKEN_RE =
  /[+-]?\d+(?:\.\d+)?%|[+-]?\d{1,3}(?:,\d{3})+\.\d{2}[-+]?|[+-]?\d+\.\d{2}[-+]?/g;

/** 业务数字保护清单（测试断言用）：这些 token 绝不被剥离。 */
export const BUSINESS_NUMERIC_SAFETY = [
  "步骤 1",
  "步骤 2",
  "等级 1",
  "等级 2",
  "30 天",
  "90 天",
  "24h 涨幅榜",
  "24h 跌幅榜"
] as const;

/** 剥离动态价格/涨跌幅 token，返回仅含稳定语义的文本。仅供显式 opt-in 路径使用。 */
export function stripDynamicValueTokens(value: string): string {
  return value.replace(DYNAMIC_VALUE_TOKEN_RE, "");
}

export interface IdentityNormalizeOptions {
  /**
   * 显式 opt-in：仅在调用路径具备动态展示证据（semanticRole=captured_inventory /
   * dynamicBinding / currentValue，见 hasExplicitDynamicContext）时置 true。
   * 默认 false = 原始文本 identity comparison，不剥离任何动态数值。
   */
  allowDynamicValueStripping?: boolean;
}

/**
 * 元素是否具备显式动态展示证据。
 * 依据：Page Model writeback 标记的 semanticRole=captured_inventory（Market 行情
 * 元素即此标记），或元素上的 dynamicBinding / currentValue / dynamicValue 字段。
 * 这是调用点（持有元素记录处）的 opt-in 判定，不是 fuzzyMatch 的全局开关；
 * 业务数字元素（费率/收益率/最低/价格精度等）无这些字段，始终走默认原文比较。
 */
export function hasExplicitDynamicContext(element: Record<string, unknown> | undefined): boolean {
  if (!element) return false;
  if (String(element.semanticRole ?? "") === "captured_inventory") return true;
  if (element.dynamicBinding !== undefined && element.dynamicBinding !== null) return true;
  if (element.currentValue !== undefined && element.currentValue !== null) return true;
  if (element.dynamicValue !== undefined && element.dynamicValue !== null) return true;
  return false;
}

/**
 * identity 比较用的统一归一。默认只剥离空白/括号/交互词（原始文本 identity）；
 * 仅当 options.allowDynamicValueStripping=true 时前置动态数值剥离。
 */
export function normalizeIdentityValue(value: string, options: IdentityNormalizeOptions = {}): string {
  const base = options.allowDynamicValueStripping ? stripDynamicValueTokens(value) : value;
  return base.replace(/[\s（）()点击按钮]/g, "");
}

/**
 * 动态 locator identity 是否指向同一元素。
 * 比较规则：归一后全等，或一方包含另一方核心词（子串包含）。
 * 包含判定带数字边界保护：被包含串若以数字收尾，宿主串紧跟的字符不得再是数字，
 * 反之亦然——避免 "价格精度 0.01" 被 "价格精度 0.001" 错误包含（Precision NOT MERGE）。
 */
export function isSameDynamicLocatorIdentity(
  a: string,
  b: string,
  options: IdentityNormalizeOptions = {}
): boolean {
  const na = normalizeIdentityValue(a, options);
  const nb = normalizeIdentityValue(b, options);
  if (na === nb) return true;
  if (na.length === 0 || nb.length === 0) return false;
  return containsWholeToken(na, nb) || containsWholeToken(nb, na);
}

/** na.includes(nb) 且匹配处前后不跨数字边界（数字 token 视为原子单元）。 */
function containsWholeToken(host: string, token: string): boolean {
  let idx = host.indexOf(token);
  while (idx >= 0) {
    const beforeDigit = idx > 0 && isDigit(host.charCodeAt(idx - 1));
    const end = idx + token.length;
    const afterDigit = end < host.length && isDigit(host.charCodeAt(end));
    if (!beforeDigit && !afterDigit) return true;
    idx = host.indexOf(token, idx + 1);
  }
  return false;
}

function isDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}
