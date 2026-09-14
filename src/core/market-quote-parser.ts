/**
 * Market Quote Dynamic Value Parser（P16.6）——只影响 FUTURE capture/writeback 表示。
 *
 * 行情元素落库时，把 "BTC 比特币 79,588.00 -1.40%" 表达为稳定身份 + 动态值：
 *   semanticName: "BTC 比特币"（稳定，价格/涨跌幅不入 identity）
 *   dynamicValue: { price: "79,588.00", changePercent: "-1.40%" }
 *
 * 显式 opt-in gate（与 locator-identity-normalizer 的 identity 剥离同语义）：
 * 仅当文本同时含 涨跌幅 token + 价格 token + 可识别名称（CJK 或 Latin ticker）才拆分。
 * 业务数字（最低 0.01 BTC / 费率 0.1% / 收益率 3.5% / 30 天 / 步骤 1）缺其一 → 返回 null，
 * 保持原文 semanticName，绝不拆成动态值。
 *
 * 本模块只解析文本，不修改任何存储 / evidence / locator。
 */

/** 涨跌幅 token：[+-]?数字(含小数)%（-1.40%、+0.85%、3.5%）。 */
const QUOTE_PERCENT_RE = /[+-]?\d+(?:\.\d+)?%/g;

/** 价格 token：千分位价格（79,588.00 / 2,450.33）或两位小数价格（95.75 / 0.01）。 */
const QUOTE_PRICE_RE = /\d{1,3}(?:,\d{3})+\.\d{2}|\d+\.\d{2}/;

/** 名称判定：CJK 词（比特币/以太坊）或 Latin ticker 词（BTC/ETH/XAG/XAU/INTC）。 */
const NAME_CJK_RE = /[\u4e00-\u9fff]/;
const NAME_TICKER_RE = /[A-Za-z]{2,}/;

export interface MarketQuoteDynamicValue {
  /** 稳定语义名（ticker/name），不含价格/涨跌幅。 */
  stableName: string;
  /** 观察到的价格（原始文本，如 79,588.00）。 */
  price: string;
  /** 观察到的涨跌幅（原始文本，如 -1.40%）。 */
  changePercent: string;
}

/**
 * 尝试把行情观察文本拆成稳定语义名 + 动态值。
 * 不满足 opt-in gate（缺涨跌幅 / 缺价格 / 无可识别名称）返回 null，调用方保持原文。
 */
export function parseMarketQuote(observedText: string): MarketQuoteDynamicValue | null {
  const text = String(observedText ?? "");
  if (!text.trim()) return null;

  // gate 1：必须含涨跌幅 token。
  const percents = text.match(QUOTE_PERCENT_RE);
  if (!percents || percents.length === 0) return null;

  // gate 2：剔除涨跌幅后必须还有价格 token（费率 0.1% → 剔除后无价格 → null）。
  const withoutPercent = text.replace(QUOTE_PERCENT_RE, " ");
  const priceMatch = withoutPercent.match(QUOTE_PRICE_RE);
  if (!priceMatch) return null;

  // gate 3：剔除价格/涨跌幅后必须剩下可识别名称（ticker/name）。
  const stableName = withoutPercent.replace(QUOTE_PRICE_RE, " ").replace(/\s+/g, " ").trim();
  if (!stableName) return null;
  if (!NAME_CJK_RE.test(stableName) && !NAME_TICKER_RE.test(stableName)) return null;

  return { stableName, price: priceMatch[0], changePercent: percents[0] };
}
