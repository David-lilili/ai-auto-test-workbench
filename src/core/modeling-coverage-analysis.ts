/**
 * P8.17 / P8.34 / P8.36-39：Result Assertion Generation + Knowledge Coverage Classification
 * + Theoretical Ceiling / Discoverable Recall / Recall Funnel。
 *
 * P8.17：ResultRegion 一旦存在，自动产生有限 assertion candidates：
 *   RESULT_REGION_EXISTS / EMPTY_STATE_VISIBLE / COLUMN_EXISTS。
 * 不自动生成 ROW_VALUE_EQUALS / AMOUNT_CORRECT / BUSINESS_RULE_VALID（需 DSL intent / business knowledge）。
 *
 * P8.34：Knowledge Coverage Classification——分 STRUCTURE / OPTION / ASSERTION / STATE /
 * DEPENDENCY / BUSINESS_RULE 报告覆盖，而不是笼统"这个页面建模 70%"。
 *
 * P8.36-37：Theoretical Auto-Coverage Ceiling——autoDiscoverableGold / allValidGold。
 * Discoverable Recall = 分母只含 DETERMINISTIC_DISCOVERABLE + INTERACTION_DISCOVERABLE。
 *
 * P8.38-39：Modeling Recall Funnel——Discoverable Gold → Bootstrap detected → Coverage represented
 * → Heuristic matched → Executed → Evidence → Promoted。知道 recall 丢在哪一层。
 *
 * 铁律：不假装 remote dropdown 已完全建模；业务知识缺口不算 scanner recall 缺陷。
 */

import type { ResultRegionModel } from "./modeling-result-region.js";
import type { AssertionCandidate } from "./modeling-structure-scanner.js";

// ============ P8.17 ============

export type ResultAssertionKind = "RESULT_REGION_EXISTS" | "EMPTY_STATE_VISIBLE" | "COLUMN_EXISTS";

/** P8.17：从 result region 生成有限断言候选（受控、不越界）。 */
export function generateResultAssertions(region: ResultRegionModel): AssertionCandidate[] {
  const candidates: AssertionCandidate[] = [];
  const evidence = [...(region.evidence ?? []), `region=${region.resultRegionId}`];

  candidates.push({
    assertionKind: "record_or_empty_state",
    semanticName: `结果区域存在（${region.type}${region.columns?.length ? `，列: ${region.columns.slice(0, 4).map((c) => c.semanticName).join("/")}` : ""}）`,
    expectedTexts: [...(region.emptyState ?? []), ...(region.columns ?? []).slice(0, 5).map((c) => c.semanticName)],
    status: "dom_verified",
    confidence: 0.7,
    source: "result_region:exists",
    evidence,
    canonicalKind: "record_or_empty_state"
  });

  if (region.emptyState?.length) {
    candidates.push({
      assertionKind: "result_empty",
      semanticName: `空状态可见（${region.emptyState.slice(0, 2).join("/")}）`,
      expectedTexts: region.emptyState.slice(0, 6),
      status: "dom_verified",
      confidence: 0.7,
      source: "result_region:empty_state",
      evidence: [...evidence, ...region.emptyState.map((s) => `empty=${s}`)],
      canonicalKind: "result_empty"
    });
  }

  for (const col of region.columns ?? []) {
    candidates.push({
      assertionKind: "table_column_all_equal",
      semanticName: `列存在（${col.semanticName}）`,
      expectedTexts: [col.semanticName],
      status: "dom_verified",
      confidence: 0.6,
      source: "result_region:column",
      evidence: [...evidence, `column=${col.semanticName}`],
      canonicalKind: "table_column_all_equal"
    });
  }

  return candidates;
}

// ============ P8.34 ============

export type KnowledgeDomain = "STRUCTURE" | "OPTION" | "ASSERTION" | "STATE" | "DEPENDENCY" | "BUSINESS_RULE";

export interface KnowledgeCoverage {
  domain: KnowledgeDomain;
  autoCount: number;
  goldCount: number;
  recall: number;
}

/** P8.34：按知识域分类统计覆盖。 */
export function computeKnowledgeCoverage(input: {
  autoElements: number;
  goldElements: number;
  autoOptions: number;
  goldOptions: number;
  autoAssertions: number;
  goldAssertions: number;
  autoStates: number;
  goldStates: number;
  autoDependencies: number;
  goldDependencies: number;
  businessRuleGold: number;
}): KnowledgeCoverage[] {
  const r = (auto: number, gold: number) => (gold > 0 ? auto / gold : 0);
  return [
    { domain: "STRUCTURE", autoCount: input.autoElements, goldCount: input.goldElements, recall: r(input.autoElements, input.goldElements) },
    { domain: "OPTION", autoCount: input.autoOptions, goldCount: input.goldOptions, recall: r(input.autoOptions, input.goldOptions) },
    { domain: "ASSERTION", autoCount: input.autoAssertions, goldCount: input.goldAssertions, recall: r(input.autoAssertions, input.goldAssertions) },
    { domain: "STATE", autoCount: input.autoStates, goldCount: input.goldStates, recall: r(input.autoStates, input.goldStates) },
    { domain: "DEPENDENCY", autoCount: input.autoDependencies, goldCount: input.goldDependencies, recall: r(input.autoDependencies, input.goldDependencies) },
    { domain: "BUSINESS_RULE", autoCount: 0, goldCount: input.businessRuleGold, recall: 0 }
  ];
}

// ============ P8.35-37 ============

export type GoldKnowledgeKind =
  | "DETERMINISTIC_DISCOVERABLE"
  | "INTERACTION_DISCOVERABLE"
  | "BUSINESS_KNOWLEDGE_REQUIRED"
  | "HIGH_RISK_REQUIRED"
  | "HISTORICAL_NOISE";

export interface GoldKnowledgeBudget {
  kind: GoldKnowledgeKind;
  count: number;
}

export interface CoverageCeilingResult {
  autoDiscoverableGold: number;
  allValidGold: number;
  /** 通用自动建模的理论 recall 上限（DETERMINISTIC + INTERACTION）。 */
  theoreticalCeiling: number;
  observedRecall: number;
  discoverableRecall: number;
  budget: GoldKnowledgeBudget[];
}

/** P8.36-37：计算理论自动覆盖上限 + Discoverable Recall。 */
export function computeCoverageCeiling(input: {
  observedRecall: number;
  allValidGold: number;
  budget: GoldKnowledgeBudget[];
}): CoverageCeilingResult {
  const autoDiscoverable = input.budget
    .filter((b) => b.kind === "DETERMINISTIC_DISCOVERABLE" || b.kind === "INTERACTION_DISCOVERABLE")
    .reduce((s, b) => s + b.count, 0);
  const theoreticalCeiling = input.allValidGold > 0 ? autoDiscoverable / input.allValidGold : 0;
  const discoverableRecall = autoDiscoverable > 0 ? input.observedRecall * input.allValidGold / autoDiscoverable : 0;
  const r = (v: number) => Math.round(v * 1000) / 1000;
  return {
    autoDiscoverableGold: autoDiscoverable,
    allValidGold: input.allValidGold,
    theoreticalCeiling: r(theoreticalCeiling),
    observedRecall: r(input.observedRecall),
    discoverableRecall: r(Math.min(1, discoverableRecall)),
    budget: input.budget
  };
}

// ============ P8.38-39 ============

export interface RecallFunnelStage {
  stage: string;
  count: number;
}

/** P8.38-39：建模召回损失漏斗。 */
export function buildRecallFunnel(input: {
  discoverableGold: number;
  bootstrapDetected: number;
  coverageRepresented: number;
  heuristicMatched: number;
  executed: number;
  evidence: number;
  promoted: number;
}): RecallFunnelStage[] {
  return [
    { stage: "Discoverable Gold", count: input.discoverableGold },
    { stage: "Bootstrap detected", count: input.bootstrapDetected },
    { stage: "Coverage represented", count: input.coverageRepresented },
    { stage: "Heuristic matched", count: input.heuristicMatched },
    { stage: "Executed", count: input.executed },
    { stage: "Evidence", count: input.evidence },
    { stage: "Promoted", count: input.promoted }
  ];
}

/** 每层损失（用于定位 recall 丢在哪）。 */
export function funnelLoss(funnel: RecallFunnelStage[]): Array<{ from: string; to: string; loss: number }> {
  const losses: Array<{ from: string; to: string; loss: number }> = [];
  for (let i = 0; i + 1 < funnel.length; i += 1) {
    losses.push({ from: funnel[i].stage, to: funnel[i + 1].stage, loss: Math.max(0, funnel[i].count - funnel[i + 1].count) });
  }
  return losses;
}
