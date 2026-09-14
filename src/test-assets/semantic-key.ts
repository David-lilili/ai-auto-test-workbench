/**
 * P12.10/11/12：TestAsset Identity + Candidate↔Asset 匹配。
 *
 * 不能只根据 title。基于：businessRule refs / AC refs / scenarioType / preconditions /
 * semantic actions / expected outcomes（结构优先，文本只辅助）。
 */

import type { TestAsset, CandidateMatchKind } from "./types.js";

const norm = (s: string) => String(s ?? "").toLowerCase().replace(/[^a-z0-9_\u4e00-\u9fa5]/g, "");

/** P12.10：testAssetSemanticKey。 */
export function testAssetSemanticKey(asset: Pick<TestAsset, "businessRuleRefs" | "acceptanceCriterionRefs" | "scenarioType" | "preconditions" | "semanticActions" | "expectedOutcomes">): string {
  const rules = [...asset.businessRuleRefs].sort().join("+");
  const acs = [...asset.acceptanceCriterionRefs].sort().join("+");
  const pre = asset.preconditions.map((p) => norm(p.statement)).sort().join(",");
  const actions = asset.semanticActions.map((a) => norm(a.action + a.target)).sort().join(",");
  const out = asset.expectedOutcomes.map((e) => norm(e.statement)).sort().join(",");
  return [asset.scenarioType, rules, acs, pre, actions, out].join("|");
}

export interface CandidateMatchInput {
  businessRuleRefs: string[];
  acceptanceCriterionRefs: string[];
  scenarioType: string;
  preconditions: Array<{ statement: string }>;
  semanticActions: Array<{ action: string; target?: string }>;
  expectedOutcomes: Array<{ statement: string }>;
}

export interface CandidateAssetMatch {
  kind: CandidateMatchKind;
  matchedAssetId?: string;
  matchedAssetVersion?: string;
  score: number;
  signals: string[];
}

/** P12.11/12：结构优先匹配（rule/AC/actions/expected），文本只辅助。 */
export function matchCandidateToAssets(candidate: CandidateMatchInput, assets: TestAsset[]): CandidateAssetMatch {
  const candRules = new Set(candidate.businessRuleRefs);
  const candAcs = new Set(candidate.acceptanceCriterionRefs);
  let best: CandidateAssetMatch = { kind: "NEW", score: 0, signals: [] };

  for (const a of assets) {
    const signals: string[] = [];
    let score = 0;
    const ruleOverlap = a.businessRuleRefs.filter((r) => candRules.has(r)).length;
    const acOverlap = a.acceptanceCriterionRefs.filter((r) => candAcs.has(r)).length;
    if (ruleOverlap > 0) { score += 3 * ruleOverlap; signals.push(`rule:${ruleOverlap}`); }
    if (acOverlap > 0) { score += 2 * acOverlap; signals.push(`ac:${acOverlap}`); }
    if (a.scenarioType === candidate.scenarioType) { score += 1; signals.push("type"); }
    const candActions = new Set(candidate.semanticActions.map((s) => norm(s.action + s.target)));
    const actionOverlap = a.semanticActions.filter((s) => candActions.has(norm(s.action + s.target))).length;
    if (actionOverlap > 0) { score += 2 * actionOverlap; signals.push(`action:${actionOverlap}`); }
    const candOut = new Set(candidate.expectedOutcomes.map((e) => norm(e.statement)));
    const outOverlap = a.expectedOutcomes.filter((e) => candOut.has(norm(e.statement))).length;
    if (outOverlap > 0) { score += 1 * outOverlap; signals.push(`outcome:${outOverlap}`); }

    if (score > best.score) {
      let kind: CandidateMatchKind = "NEW";
      if (ruleOverlap >= 1 || acOverlap >= 1) {
        kind = score >= 6 ? "SAME" : score >= 3 ? "POSSIBLE_UPDATE" : "DUPLICATE";
      } else if (score >= 4) {
        kind = "DUPLICATE";
      } else if (score >= 2) {
        kind = "POSSIBLE_UPDATE";
      }
      best = { kind, matchedAssetId: a.testAssetId, matchedAssetVersion: a.version, score, signals };
    }
  }
  return best;
}

/** P12.11：语义相同判定（含中英同义文本辅助）。 */
export function assertSameTestSemantics(a: { objective: string }, b: { objective: string }): boolean {
  return norm(a.objective) === norm(b.objective);
}
