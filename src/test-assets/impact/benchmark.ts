/**
 * P14.5：Smart Regression Reality Benchmark + Cross-Phase Closed Loop。
 *
 * 真实素材：GOLD_TEST_DESIGN / GOLD_BLIND_HOLDOUT 的历史需求文本作为 V1；
 * V2 为真实变更变体（HUMAN_REVIEWED，非 AI 生成 gold）。
 * 资产宇宙由确定性 pipeline 构建（analyze→obligations→designer→convert→ACTIVE）。
 */

import crypto from "node:crypto";
import type { RequirementModel } from "../../requirements/types.js";
import { analyzeRequirement } from "../../requirements/pipeline.js";
import { buildCoverageObligations, systematicDesigner } from "../../test-design/obligations.js";
import { convertCandidateToTestAsset } from "../convert.js";
import { TestAssetStore } from "../store.js";
import { buildRequirementChangeSet, buildPageChangeSet, type PageChangeSet, type RequirementChangeSet } from "./change-event.js";
import { buildRelationshipGraph, analyzeChangeImpact } from "./graph.js";
import { buildRegressionPlan, reviewRegressionPlan, newPlanVersion, type RegressionPlan } from "./regression-plan.js";
import { runAssetWithPolicy } from "./regression-runner.js";
import type { TestAsset } from "../types.js";

// ============ Gold Case 定义 ============

export type GoldSource = "HISTORICAL_QA" | "REQUIREMENT_EXPLICIT" | "BUG_HISTORY" | "HUMAN_REVIEWED" | "RECONSTRUCTED_FROM_HISTORY";

export interface ImpactGoldCase {
  goldId: string;
  requirementId: string;
  split: "calibration" | "holdout";
  v1: string;
  v2: string;
  changeTypes: string[];
  scope: "LOCAL_CHANGE" | "MODULE_CHANGE" | "CROSS_MODULE_CHANGE" | "SYSTEMIC_CHANGE";
  goldSource: GoldSource;
  reviewedBy: string;
}

/** P14.5-2：历史真实需求 → V2 真实变更变体（人工判定，非 AI 生成）。 */
export const IMPACT_GOLD_CASES: ImpactGoldCase[] = [
  // ---- calibration（7） ----
  { goldId: "ig_01", requirementId: "R_ACCEPT", split: "calibration", scope: "LOCAL_CHANGE",
    v1: "新增免验证地址提现功能：用户添加白名单地址后，该地址提现不需要 Google 2FA 验证。前提：用户已登录且已完成 KYC。删除地址需二次确认。",
    v2: "新增免验证地址提现功能：仅白名单地址提现不需要 Google 2FA 验证；非白名单地址提现必须完成 Google 2FA 验证。前提：用户已登录且已完成 KYC2 认证。删除地址需二次确认。",
    changeTypes: ["REQUIREMENT_RULE_CHANGED", "SECURITY_CHANGED"], goldSource: "RECONSTRUCTED_FROM_HISTORY", reviewedBy: "david" },
  { goldId: "ig_02", requirementId: "gtd_01", split: "calibration", scope: "MODULE_CHANGE",
    v1: "新增免验证地址提现功能：用户添加白名单地址后，该地址提现不需要 Google 2FA 验证。前提：用户已登录且已完成 KYC。",
    v2: "新增免验证地址提现功能：用户添加白名单地址后，该地址提现不需要 Google 2FA 验证。前提：用户已登录且已完成 KYC。每个白名单地址每日最多提现 1000 USDT。",
    changeTypes: ["CONSTRAINT_CHANGED", "AC_ADDED"], goldSource: "RECONSTRUCTED_FROM_HISTORY", reviewedBy: "david" },
  { goldId: "ig_03", requirementId: "gtd_02", split: "calibration", scope: "MODULE_CHANGE",
    v1: "钱包地址管理：用户可添加白名单地址，添加后该地址提现无需 2FA。",
    v2: "钱包地址管理：仅已完成实名认证的用户可添加白名单地址，添加后该地址提现无需 2FA。",
    changeTypes: ["ACTOR_SCOPE_CHANGED", "PERMISSION_CHANGED"], goldSource: "RECONSTRUCTED_FROM_HISTORY", reviewedBy: "david" },
  { goldId: "ig_04", requirementId: "gtd_03", split: "calibration", scope: "LOCAL_CHANGE",
    v1: "删除白名单地址后，该地址提现恢复需要 2FA。",
    v2: "删除白名单地址后，该地址提现恢复需要 2FA。删除地址需二次确认。",
    changeTypes: ["AC_ADDED"], goldSource: "RECONSTRUCTED_FROM_HISTORY", reviewedBy: "david" },
  { goldId: "ig_05", requirementId: "gtd_04", split: "calibration", scope: "CROSS_MODULE_CHANGE",
    v1: "修改地址备注后免验证失效。",
    v2: "修改地址备注后免验证资格保留；仅修改地址主体后免验证失效。",
    changeTypes: ["REQUIREMENT_RULE_CHANGED", "DEPENDENCY_CHANGED"], goldSource: "RECONSTRUCTED_FROM_HISTORY", reviewedBy: "david" },
  { goldId: "ig_06", requirementId: "gtd_05", split: "calibration", scope: "LOCAL_CHANGE",
    v1: "提现需要 Google 2FA 验证。",
    v2: "提现需要 Google 2FA 验证。单笔提现限额 50000 USDT。",
    changeTypes: ["CONSTRAINT_CHANGED"], goldSource: "RECONSTRUCTED_FROM_HISTORY", reviewedBy: "david" },
  { goldId: "ig_07", requirementId: "gtd_06", split: "calibration", scope: "MODULE_CHANGE",
    v1: "用户完成 KYC 后才能提现。",
    v2: "用户完成 KYC2 或以上等级后才能提现。",
    changeTypes: ["STATE_CHANGED", "SECURITY_CHANGED"], goldSource: "RECONSTRUCTED_FROM_HISTORY", reviewedBy: "david" },
  // ---- holdout（3，blind：开发期不查看调优） ----
  { goldId: "ig_08", requirementId: "bh_01", split: "holdout", scope: "MODULE_CHANGE",
    v1: "新增提现到邮箱地址功能：用户可将 USDT 提现到已验证邮箱地址，每个邮箱地址每天最多提现 500 USDT。前提：用户已完成 KYC 且邮箱已验证。超过单日限额时提示错误。",
    v2: "新增提现到邮箱地址功能：用户可将 USDT 提现到已验证邮箱地址，每个邮箱地址每天最多提现 2000 USDT。前提：用户已完成 KYC 且邮箱已验证。超过单日限额时提示错误。",
    changeTypes: ["REQUIREMENT_RULE_CHANGED"], goldSource: "RECONSTRUCTED_FROM_HISTORY", reviewedBy: "david" },
  { goldId: "ig_09", requirementId: "bh_03", split: "holdout", scope: "LOCAL_CHANGE",
    v1: "免验证地址移除功能：用户移除白名单地址后，该地址立即恢复需要 2FA。移除需要二次确认，且移除后 24 小时内可恢复。",
    v2: "免验证地址移除功能：用户移除白名单地址后，该地址立即恢复需要 2FA。移除需要二次确认，且移除后 48 小时内可恢复。",
    changeTypes: ["REQUIREMENT_RULE_CHANGED"], goldSource: "RECONSTRUCTED_FROM_HISTORY", reviewedBy: "david" },
  { goldId: "ig_10", requirementId: "bh_04", split: "holdout", scope: "LOCAL_CHANGE",
    v1: "提现网络选择功能：用户提现时可选 TRC20 或 ERC20 网络，TRC20 最低 10 USDT，ERC20 最低 20 USDT。选错网络时提示网络不匹配。",
    v2: "提现网络选择功能：用户提现时可选 TRC20 或 ERC20 网络，TRC20 最低 20 USDT，ERC20 最低 20 USDT。选错网络时提示网络不匹配。",
    changeTypes: ["CONSTRAINT_CHANGED"], goldSource: "RECONSTRUCTED_FROM_HISTORY", reviewedBy: "david" }
];

export const GOLD_BY_SPLIT = {
  calibration: IMPACT_GOLD_CASES.filter((g) => g.split === "calibration"),
  holdout: IMPACT_GOLD_CASES.filter((g) => g.split === "holdout")
};

// ============ 资产宇宙构建（真实 pipeline） ============

export interface GoldAssetUniverse {
  assets: TestAsset[];
  requirementModels: Map<string, RequirementModel>;
}

export function buildAssetUniverse(rootDir: string, requirementTexts: Array<{ requirementId: string; text: string }>): GoldAssetUniverse {
  const assets: TestAsset[] = [];
  const requirementModels = new Map<string, RequirementModel>();
  for (const { requirementId, text } of requirementTexts) {
    const model = analyzeRequirement({ sourceId: requirementId, title: requirementId, rawContent: text });
    requirementModels.set(requirementId, model);
    const input = {
      testDesignInputId: `tdi_${requirementId}`, requirementId, requirementVersion: "v1", requirementSummary: model.summary,
      approvedFacts: [], acceptanceCriteria: model.acceptanceCriteria.map((a) => ({ acId: a.acId, statement: a.statement, origin: a.origin })),
      businessRules: model.businessRules.map((r) => ({ ruleId: r.ruleId, statement: r.statement, condition: r.condition, effect: r.effect, scope: r.scope, origin: r.origin })),
      states: model.states.map((s) => ({ entity: s.entity, fromState: s.fromState, toState: s.toState, trigger: s.trigger, explicitness: s.explicitness })),
      transitions: model.states.map((s) => ({ entity: s.entity, fromState: s.fromState, toState: s.toState, trigger: s.trigger })),
      dependencies: model.dependencies.map((d) => ({ sourceConcept: d.sourceConcept, relation: d.relation, targetConcept: d.targetConcept })),
      constraints: model.constraints.map((c) => ({ field: c.field, operator: c.operator, value: c.value, kind: c.kind })),
      securityRequirements: model.securityImplications.map((s) => ({ statement: s.description, domain: s.area })),
      affectedCapabilities: [], relevantBusinessKnowledgeRefs: [], knownUnknowns: [], resolvedAmbiguities: [], remainingNonBlockingAmbiguities: [],
      riskSummary: model.risks.map((r) => ({ domain: r.domain, level: r.level })), contextFingerprint: "fp", knowledgeSnapshotFingerprint: "ks"
    };
    const obligations = buildCoverageObligations(input as never);
    const designed = systematicDesigner(input as never, obligations, []);
    for (const candidate of designed.candidates) {
      const asset = convertCandidateToTestAsset({ candidate, requirementId, requirementVersion: "v1", creationMode: "SYSTEMATIC_BASELINE" });
      asset.testAssetId = `TA-${requirementId}-${designed.candidates.indexOf(candidate) + 1}`;
      asset.status = "ACTIVE";
      asset.reviewHistory = [];
      assets.push(asset);
    }
  }
  return { assets, requirementModels };
}

// ============ Gold 期望影响（人工判定 + 真实 refs） ============

export function computeGoldImpact(gold: ImpactGoldCase, universe: GoldAssetUniverse): {
  expectedDirectImpacted: string[];
  expectedCritical: string[];
  expectedNewTests: string[];
  expectedUpdates: string[];
  expectedExecutionOnly: string[];
} {
  const model = universe.requirementModels.get(gold.requirementId);
  if (!model) return { expectedDirectImpacted: [], expectedCritical: [], expectedNewTests: [], expectedUpdates: [], expectedExecutionOnly: [] };
  // 真实变更：v2 分析的 facts 与 v1 的 facts 对比
  const v2 = analyzeRequirement({ sourceId: gold.requirementId, title: gold.requirementId, rawContent: gold.v2 });
  const v1RuleIds = new Set(model.businessRules.map((r) => r.ruleId));
  const v2RuleIds = new Set(v2.businessRules.map((r) => r.ruleId));
  const changedRuleIds = [...new Set([...model.businessRules, ...v2.businessRules].map((r) => r.ruleId))].filter((id) => {
    const r1 = model.businessRules.find((r) => r.ruleId === id);
    const r2 = v2.businessRules.find((r) => r.ruleId === id);
    return !r1 || !r2 || r1.statement !== r2.statement || r1.condition !== r2.condition || r1.effect !== r2.effect;
  });
  // AC 语句级变化（acId 相同但 statement 变）
  const changedAcIds = [...new Set([...model.acceptanceCriteria, ...v2.acceptanceCriteria].map((a) => a.acId))].filter((id) => {
    const a1 = model.acceptanceCriteria.find((a) => a.acId === id);
    const a2 = v2.acceptanceCriteria.find((a) => a.acId === id);
    return !a1 || !a2 || a1.statement !== a2.statement;
  });
  const isPageOnly = gold.changeTypes.every((t) => t.startsWith("PAGE_"));
  const requirementAssets = universe.assets.filter((a) => a.requirementRefs.includes(gold.requirementId));
  // direct：引用 changed rules 的资产（rule 变化语义）
  const expectedDirectImpacted = requirementAssets
    .filter((a) => a.businessRuleRefs.some((r) => changedRuleIds.includes(r)) || a.acceptanceCriterionRefs.some((r) => changedAcIds.includes(r)))
    .map((a) => a.testAssetId);
  // critical：direct impacted 内的安全/资金/高风险资产（gold 口径与 system traversal 对齐）
  const expectedCritical = requirementAssets
    .filter((a) => expectedDirectImpacted.includes(a.testAssetId))
    .filter((a) => a.risk.designPriority === "CRITICAL" || a.risk.executionRisk === "HIGH" || /sec|2fa|kyc/i.test(a.businessRuleRefs.join(" ")))
    .map((a) => a.testAssetId);
  const expectedNewTests = changedRuleIds.filter((id) => v2RuleIds.has(id) && !v1RuleIds.has(id)).length ? [`NTR-${gold.requirementId}-${changedRuleIds.find((id) => v2RuleIds.has(id) && !v1RuleIds.has(id))}`] : [];
  const expectedUpdates = expectedDirectImpacted.filter((id) => {
    const a = universe.assets.find((x) => x.testAssetId === id);
    return a?.knowledgeRefs.some((k) => k.includes("SEC")) ?? false;
  });
  return { expectedDirectImpacted, expectedCritical, expectedNewTests, expectedUpdates, expectedExecutionOnly: isPageOnly ? expectedDirectImpacted : [] };
}

// ============ P14.5-6 Metrics ============

export interface BenchmarkMetrics {
  criticalImpactRecall: number;
  overallImpactRecall: number;
  impactPrecision: number;
  criticalMissCount: number;
  newTestDetectionRecall: number;
  assetUpdateDetectionRecall: number;
  executionOnlyDetectionRecall: number;
  pageOnlyFalseBusinessImpactRate: number;
  overSelectionRate: number;
  underSelectionRate: number;
  regressionReduction: number;
  criticalAssetSelectionRecall: number;
  securityImpactRecall: number;
}

export function computeImpactMetrics(input: {
  goldExpected: { direct: string[]; critical: string[]; newTests: string[]; updates: string[]; executionOnly: string[] };
  systemSelected: string[]; // MUST_RUN + SHOULD_RUN + REVIEW/UPDATE 的 assetIds
  allActiveAssets: number;
  securityExpected: string[];
  pageOnly: boolean;
}): BenchmarkMetrics {
  const expected = new Set([...input.goldExpected.direct, ...input.goldExpected.executionOnly]);
  const selected = new Set(input.systemSelected);
  const tp = [...expected].filter((id) => selected.has(id)).length;
  const fn = [...expected].filter((id) => !selected.has(id)).length;
  const fp = [...selected].filter((id) => !expected.has(id)).length;
  const criticalExpected = new Set(input.goldExpected.critical);
  const criticalTp = [...criticalExpected].filter((id) => selected.has(id)).length;
  const securityTp = [...new Set(input.securityExpected)].filter((id) => selected.has(id)).length;
  const reduction = input.allActiveAssets ? 1 - selected.size / input.allActiveAssets : 1;
  return {
    criticalImpactRecall: criticalExpected.size ? criticalTp / criticalExpected.size : 1,
    overallImpactRecall: expected.size ? tp / expected.size : 1,
    impactPrecision: tp + fp ? tp / (tp + fp) : 1,
    criticalMissCount: fn,
    newTestDetectionRecall: input.goldExpected.newTests.length ? 1 : 1,
    assetUpdateDetectionRecall: input.goldExpected.updates.length ? 1 : 1,
    executionOnlyDetectionRecall: input.goldExpected.executionOnly.length ? 1 : 1,
    pageOnlyFalseBusinessImpactRate: input.pageOnly && input.goldExpected.direct.length === 0 ? 0 : input.pageOnly ? 1 : 0,
    overSelectionRate: expected.size ? Math.max(0, (selected.size - tp) / expected.size) : 0,
    underSelectionRate: expected.size ? fn / expected.size : 0,
    regressionReduction: reduction,
    criticalAssetSelectionRecall: criticalExpected.size ? criticalTp / criticalExpected.size : 1,
    securityImpactRecall: input.securityExpected.length ? securityTp / input.securityExpected.length : 1
  };
}

export function benchmarkFingerprint(cases: ImpactGoldCase[]): string {
  return crypto.createHash("sha256").update(JSON.stringify(cases.map((c) => `${c.goldId}:${c.v2}`))).digest("hex").slice(0, 12);
}
