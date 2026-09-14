/**
 * Exploration Risk Policy（P3-A4）：风险分级的唯一实现，供 bootstrap 与 heuristic 共用。
 *
 * A4 纪律：heuristic registry 不得复制 HIGH_RISK_TERMS——风险词表只有这一份。
 * 词表与判定逻辑从 bootstrap-intelligence 原样抽取（行为不变由
 * tests/exploration-risk-policy.test.ts 与既有 bootstrap 测试共同保证）。
 */

export type RiskLevel = "low" | "medium" | "high" | "forbidden";

export const HIGH_RISK_TERMS = [
  "withdraw",
  "withdrawal",
  "payment",
  "pay",
  "delete",
  "transfer",
  "submit order",
  "place order",
  "permission",
  "fund setting",
  "kyc approve"
];

export const MEDIUM_RISK_TERMS = ["submit", "save", "create", "update", "edit", "confirm", "apply", "approve", "enable", "disable"];

/** FORBIDDEN 级：无论上下文如何都不允许自动化执行的动作语义（policy 层独有）。 */
export const FORBIDDEN_RISK_TERMS = [
  "real transfer",
  "real withdrawal",
  "production payment",
  "delete real data",
  "modify security config",
  "bind production authenticator"
];

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** 词边界匹配：避免 "enabled" 被 "enable" 子串命中（观察类 heuristic id 含 enabled/disabled 不应升 MEDIUM）。 */
function hasTerm(text: string, term: string): boolean {
  return new RegExp(`(^|[^\\p{L}\\p{N}])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\p{L}\\p{N}]|$)`, "u").test(text);
}

/**
 * 统一风险分级（bootstrap 原语义 + forbidden 层）。
 * bootstrap-intelligence.classifyBootstrapRisk 委托本函数的 low/medium/high 部分，
 * 保持既有行为完全不变。
 */
export function classifyRisk(value: string): RiskLevel {
  const text = normalize(value);
  if (FORBIDDEN_RISK_TERMS.some((term) => hasTerm(text, term))) return "forbidden";
  if (HIGH_RISK_TERMS.some((term) => hasTerm(text, term))) return "high";
  if (MEDIUM_RISK_TERMS.some((term) => hasTerm(text, term))) return "medium";
  return "low";
}
