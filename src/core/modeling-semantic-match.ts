import { normalizeControlType } from "./modeling-quality-metrics.js";

/**
 * P7.2：Semantic Matching Layer（deterministic，无 LLM）。
 *
 * AUTO 与 GOLD 命名口径不同（AUTO 用展示文本，GOLD 用人工业务 semanticName），
 * 不能按 elementId 直接比。本层用多信号打分：
 *
 * 信号（加权）：
 *   1. controlType            （归一化后相等 +0.25）
 *   2. targetField            （相等 +0.15）
 *   3. semanticName token 重叠 （jaccard/包含 +0.25）
 *   4. visible text           （相等/包含 +0.15）
 *   5. role/tag               （归一化后相等 +0.10）
 *   6. locator relation       （shared locator +0.10）
 *   7. parent component       （parentElementId 相等 +0.15）
 *   8. region                 （相等 +0.10）
 *   9. optionValue            （相等 +0.20）
 *  10. elementId token 重叠    （+0.10）
 *
 * 输出：
 *   EXACT_MATCH   score >= 0.80 且无 conflict
 *   STRONG_MATCH  0.55 <= score < 0.80
 *   POSSIBLE_MATCH 0.30 <= score < 0.55
 *   UNMATCHED     score < 0.30
 *
 * 匹配方向：auto element × gold element 取最高分对。
 */

export type MatchVerdict = "EXACT_MATCH" | "STRONG_MATCH" | "POSSIBLE_MATCH" | "UNMATCHED_AUTO" | "UNMATCHED_GOLD";

/** P8.0：semantic matcher 版本标识（冻结/对比 baseline 用）。 */
export const SEMANTIC_MATCHER_VERSION = "semantic-matcher.v1";

export interface MatchResult {
  verdict: MatchVerdict;
  score: number;
  matchedSignals: string[];
  conflicts: string[];
  matchedGoldId?: string;
}

export interface ModelElementLike {
  elementId?: string;
  semanticName?: string;
  controlType?: string;
  targetField?: string;
  optionValue?: string;
  role?: string;
  tag?: string;
  region?: string;
  parentElementId?: string;
  locatorCandidates?: Array<{ value?: string; strategy?: string }>;
  visibleText?: string;
}

function normText(value: string): string {
  return String(value ?? "").replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, "").toLowerCase();
}

/** P7.2/P7.3：site-wide 导航噪音过滤器（gold projection 与 AUTO metric 共用，保证口径一致）。 */
const NAV_NOISE_PATTERNS = [
  /^行情|^现货交易|^合约交易|^理财|^跟单|^活动中心|^公告中心|^福利中心|^卡券中心|^邀请好友|^下载APP|^Notifications|^Open menu|^语言|^Nick\d+/i,
  /coinmy|visa_mastercard|demo_card|hot_|ai_ai|aiba_|^assets$/i
];

export function isSiteNavNoise(element: ModelElementLike | Record<string, unknown>): boolean {
  const name = String((element as Record<string, unknown>).semanticName ?? (element as ModelElementLike).semanticName ?? "");
  const id = String((element as Record<string, unknown>).elementId ?? (element as ModelElementLike).elementId ?? "");
  if (!name && !id) return false;
  return NAV_NOISE_PATTERNS.some((pattern) => pattern.test(`${name} ${id}`));
}

function tokenSet(value: string): Set<string> {
  const text = String(value ?? "").toLowerCase();
  const tokens = new Set<string>();
  for (const token of text.match(/[a-z0-9]{2,}/gi) ?? []) tokens.add(token);
  const chinese = text.replace(/[^\u4e00-\u9fa5]/g, "");
  for (let i = 0; i < chinese.length - 1; i += 1) tokens.add(chinese.slice(i, i + 2));
  return tokens;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 0;
  let intersection = 0;
  for (const item of a) if (b.has(item)) intersection++;
  return intersection / (a.size + b.size - intersection || 1);
}

function containsToken(a: Set<string>, b: Set<string>): boolean {
  for (const item of a) if (b.has(item)) return true;
  return false;
}

/** 单对元素打分（0-1）。 */
export function scoreElementPair(auto: ModelElementLike, gold: ModelElementLike): { score: number; matched: string[]; conflicts: string[] } {
  const matched: string[] = [];
  const conflicts: string[] = [];
  let score = 0;

  // 1. controlType（归一化）
  const autoCtrl = normalizeControlType(auto.controlType ?? "unknown");
  const goldCtrl = normalizeControlType(gold.controlType ?? "unknown");
  if (autoCtrl !== "unknown" && goldCtrl !== "unknown") {
    if (autoCtrl === goldCtrl) { score += 0.25; matched.push(`controlType=${autoCtrl}`); }
    else conflicts.push(`controlType:${autoCtrl}≠${goldCtrl}`);
  }

  // 2. targetField
  if (auto.targetField && gold.targetField) {
    if (normText(auto.targetField) === normText(gold.targetField)) { score += 0.15; matched.push(`targetField=${auto.targetField}`); }
  }

  // 3. semanticName token 重叠
  const autoTokens = tokenSet(auto.semanticName ?? "");
  const goldTokens = tokenSet(gold.semanticName ?? "");
  const autoNameRaw = normText(auto.semanticName ?? "");
  const goldNameRaw = normText(gold.semanticName ?? "");
  const nameJaccard = jaccard(autoTokens, goldTokens);
  if (autoNameRaw && autoNameRaw === goldNameRaw) { score += 0.30; matched.push("semanticName 完全一致"); }
  else if (nameJaccard >= 0.5) { score += 0.25; matched.push(`semanticName jaccard=${nameJaccard.toFixed(2)}`); }
  else if (containsToken(autoTokens, goldTokens) || containsToken(goldTokens, autoTokens)) { score += 0.15; matched.push("semanticName token 包含"); }
  else if (nameJaccard >= 0.2) { score += 0.10; matched.push(`semanticName jaccard=${nameJaccard.toFixed(2)}`); }

  // 4. visible text / optionValue
  const autoVisible = normText(auto.visibleText ?? auto.semanticName ?? "");
  const goldVisible = normText(gold.visibleText ?? gold.semanticName ?? "");
  if (auto.optionValue && gold.optionValue) {
    if (normText(auto.optionValue) === normText(gold.optionValue)) { score += 0.25; matched.push(`optionValue=${auto.optionValue}`); }
  } else if (autoVisible && goldVisible && (autoVisible === goldVisible || autoVisible.includes(goldVisible) || goldVisible.includes(autoVisible))) {
    score += 0.15; matched.push("visible text 匹配");
  }

  // 5. role/tag
  const autoRole = normText(auto.role ?? auto.tag ?? "");
  const goldRole = normText(gold.role ?? gold.tag ?? "");
  if (autoRole && goldRole && autoRole === goldRole) { score += 0.10; matched.push(`role=${autoRole}`); }

  // 6. parent component
  if (auto.parentElementId && gold.parentElementId && normText(auto.parentElementId) === normText(gold.parentElementId)) {
    score += 0.15; matched.push(`parent=${auto.parentElementId}`);
  }

  // 7. region
  if (auto.region && gold.region && normText(auto.region) === normText(gold.region)) { score += 0.10; matched.push(`region=${auto.region}`); }

  // 8. locator relation
  const autoLocators = new Set((auto.locatorCandidates ?? []).map((l) => normText(l.value ?? "")).filter(Boolean));
  const goldLocators = new Set((gold.locatorCandidates ?? []).map((l) => normText(l.value ?? "")).filter(Boolean));
  for (const locator of autoLocators) {
    if (goldLocators.has(locator)) { score += 0.10; matched.push(`locator=${locator.slice(0, 24)}`); break; }
  }

  // 9. elementId token 重叠
  const autoIdTokens = tokenSet(auto.elementId ?? "");
  const goldIdTokens = tokenSet(gold.elementId ?? "");
  if (jaccard(autoIdTokens, goldIdTokens) >= 0.4) { score += 0.10; matched.push("elementId token 重叠"); }

  return { score: Number(Math.min(1, score).toFixed(3)), matched, conflicts };
}

/** verdict 判定。 */
export function verdictForScore(score: number, conflicts: string[]): MatchVerdict {
  if (score >= 0.80 && conflicts.length === 0) return "EXACT_MATCH";
  if (score >= 0.55) return "STRONG_MATCH";
  if (score >= 0.30) return "POSSIBLE_MATCH";
  return "UNMATCHED_AUTO";
}

/** 双向匹配：auto elements vs gold elements，取最优对。 */
export function matchModelElements(auto: ModelElementLike[], gold: ModelElementLike[]): Array<{ auto: ModelElementLike; result: MatchResult }> {
  const results: Array<{ auto: ModelElementLike; result: MatchResult }> = [];
  const usedGold = new Set<string>();
  for (const autoElement of auto) {
    let best: { gold: ModelElementLike; score: number; matched: string[]; conflicts: string[] } | undefined;
    for (const goldElement of gold) {
      const goldId = goldElement.elementId ?? "";
      if (usedGold.has(goldId) && best) continue;
      const pair = scoreElementPair(autoElement, goldElement);
      if (!best || pair.score > best.score) best = { gold: goldElement, ...pair };
    }
    if (!best) {
      results.push({ auto: autoElement, result: { verdict: "UNMATCHED_AUTO", score: 0, matchedSignals: [], conflicts: [] } });
      continue;
    }
    const verdict = verdictForScore(best.score, best.conflicts);
    if (verdict === "EXACT_MATCH" || verdict === "STRONG_MATCH") {
      usedGold.add(best.gold.elementId ?? "");
    }
    results.push({
      auto: autoElement,
      result: {
        verdict,
        score: best.score,
        matchedSignals: best.matched,
        conflicts: best.conflicts,
        matchedGoldId: best.gold.elementId
      }
    });
  }
  return results;
}
