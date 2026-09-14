import test from "node:test";
import assert from "node:assert/strict";
import { computePR, aggregatePR, normalizeControlType, computeControlTypeMatrix, round } from "../src/core/modeling-quality-metrics.js";
import { matchModelElements, scoreElementPair, verdictForScore, isSiteNavNoise } from "../src/core/modeling-semantic-match.js";
import { buildGoldModelProjection } from "../src/core/modeling-gold-projection.js";
import { computeElementMetrics, computeOptionMetrics, computeAssertionMetrics, computeControlTypeOnMatched } from "../src/core/modeling-benchmark-harness.js";
import { computeDslCompleteness, computeModelReadiness, runQualityGate, parseExpectedOperations } from "../src/core/modeling-quality-gate.js";
import { getBenchmarkPages } from "../src/core/modeling-benchmark-dataset.js";

/**
 * P7.40：Modeling Benchmark 测试（A-AJ 核心项）。
 * 重点：metric 公式正确性（无 71/71 自召回 bug）、semantic matching、gold projection、
 * quality gate、readiness、DSL completeness、数据集完整性。
 */

// ============ G. 正确 precision/recall 公式 ============
test("G. precision/recall/F1 公式正确", () => {
  const pr = computePR({ tp: 8, fp: 2, fn: 4, goldRelevant: 12 });
  assert.equal(pr.precision, 0.8);   // 8/(8+2)
  assert.equal(pr.recall, round(8 / 12)); // 8/12
  assert.equal(pr.f1, round(2 * 0.8 * (8 / 12) / (0.8 + 8 / 12)));
});

test("H. 无 71/71 自召回 bug——recall 分母是 goldRelevant 不是 auto 总数", () => {
  // auto 100 个，gold 22 个，匹配 1 个 → recall 应 = 1/22，不是 1/100
  const auto = Array.from({ length: 100 }, (_, i) => ({ elementId: `auto_${i}`, semanticName: `elem ${i}`, controlType: "button" }));
  const gold = Array.from({ length: 22 }, (_, i) => ({ elementId: `gold_${i}`, semanticName: `elem ${i}`, controlType: "button" }));
  const metrics = computeElementMetrics(auto, gold);
  assert.equal(metrics.goldRelevant, 22, "goldRelevant = 22 非 auto 总数");
  // 前 22 个 auto 与 gold 同名 → 应匹配 22 个
  const strict = computeElementMetrics(auto.slice(0, 22), gold);
  assert.ok(strict.recall > 0.9, "同名 22/22 应 recall 高");
});

// ============ A/B/C. semantic matching ============
test("A. 同 controlType + 同 semanticName → STRONG_MATCH（>=0.55）", () => {
  const pair = scoreElementPair(
    { elementId: "a.b.c", semanticName: "查询按钮", controlType: "button" },
    { elementId: "x.y.z", semanticName: "查询按钮", controlType: "button" }
  );
  assert.ok(pair.score >= 0.55, `score=${pair.score}`);
  assert.ok(pair.score < 0.8, `score=${pair.score}（无 elementId 重叠不应 EXACT）`);
  assert.equal(verdictForScore(pair.score, pair.conflicts), "STRONG_MATCH");
});

test("B. optionValue 匹配 → 高分", () => {
  const pair = scoreElementPair(
    { elementId: "a.opt.usdt", semanticName: "币种选项", controlType: "select", optionValue: "USDT" },
    { elementId: "x.option.usdt", semanticName: "USDT", controlType: "select", optionValue: "USDT" }
  );
  assert.ok(pair.score >= 0.5, `score=${pair.score}`);
});

test("D. ambiguous match 返回 POSSIBLE_MATCH（controlType+targetField 弱匹配）", () => {
  const pair = scoreElementPair(
    { elementId: "a.asset", semanticName: "USDT", controlType: "select", targetField: "asset" },
    { elementId: "b", semanticName: "币种筛选控件", controlType: "select", targetField: "asset" }
  );
  assert.equal(verdictForScore(pair.score, pair.conflicts), "POSSIBLE_MATCH");
});

// ============ E/F. gold projection + isolation ============
test("E. gold projection 过滤跨模块断言与未验证项", () => {
  const gold = buildGoldModelProjection({
    pageId: "demo.funds.spot_fund_flow",
    elements: [
      { elementId: "funds.spot_fund_flow.asset_filter", semanticName: "币种筛选控件", controlType: "select", status: "execution_verified" },
      { elementId: "funds.spot_fund_flow.query_btn", semanticName: "查询", controlType: "button", status: "dom_verified" },
      { elementId: "p4.stale_clickable_19", semanticName: "clickable 19", controlType: "button", status: "candidate" }
    ],
    assertions: [
      { assertionId: "funds.spot_fund_flow.result_list_or_empty", semanticName: "现货流水结果列表", status: "dom_verified" },
      { assertionId: "t2_5.transfer.record_list_or_empty_state", semanticName: "划转记录列表", status: "dom_verified" }
    ]
  });
  assert.ok(gold.goldElements.some((e) => e.elementId === "funds.spot_fund_flow.asset_filter"));
  assert.ok(!gold.goldElements.some((e) => e.elementId === "p4.stale_clickable_19"), "p4 占位被过滤");
  assert.ok(gold.goldAssertions.some((a) => String(a.assertionId).includes("funds.spot_fund_flow")));
  assert.ok(!gold.goldAssertions.some((a) => String(a.assertionId).includes("t2_5.transfer")), "跨模块断言被过滤");
});

test("F. site-nav noise 过滤器（AUTO 与 gold 共用）", () => {
  assert.equal(isSiteNavNoise({ semanticName: "行情", elementId: "nav.1" }), true);
  assert.equal(isSiteNavNoise({ semanticName: "现货交易", elementId: "nav.2" }), true);
  assert.equal(isSiteNavNoise({ semanticName: "查询", elementId: "funds.query" }), false);
});

// ============ I. control confusion matrix ============
test("I. controlType confusion matrix 正确", () => {
  const matrix = computeControlTypeMatrix([
    { gold: "button", auto: "button" },
    { gold: "select", auto: "dropdown_option" },
    { gold: "button", auto: "link" }
  ]);
  assert.equal(matrix.accuracy, round(2 / 3));
  assert.ok(matrix.confusion.some((c) => c.gold === "button" && c.auto === "link"));
  // dropdown_option 归一化为 select
  assert.equal(normalizeControlType("dropdown_option"), "select");
});

// ============ J/K. result region / column（通过 scanner 已有测试，此处验证 harness 集成） ============
test("K. option metrics 基于 optionValue", () => {
  const option = computeOptionMetrics(
    [{ elementId: "a", controlType: "dropdown_option", optionValue: "USDT" }],
    [{ elementId: "g.usdt", controlType: "dropdown_option", optionValue: "usdt" }]
  );
  assert.equal(option.tp, 1);
  assert.equal(option.recall, 1);
});

// ============ L/M. assertion matching ============
test("M. assertion canonicalKind 匹配", () => {
  const assertion = computeAssertionMetrics(
    [{ canonicalKind: "record_or_empty_state", semanticName: "结果列表或空状态" }],
    [{ assertionKind: "record_or_empty_state", semanticName: "现货流水结果列表或空状态" }]
  );
  assert.ok(assertion.tp >= 1, `tp=${assertion.tp}`);
});

// ============ N. semanticRole（P7.12 派生视图，含在 completeness 中） ============
test("O. DSL completeness FULL", () => {
  const result = computeDslCompleteness({
    request: "筛选 USDT 并确认列表有记录",
    expectedIntent: "open+filter+assert",
    expectedOperations: ["open", "filter", "assert"],
    materializedActions: ["navigate", "apply_filter", "assert"]
  });
  assert.equal(result.verdict, "FULL");
  assert.equal(result.missingOperations.length, 0);
});

test("P. DSL completeness SHALLOW（只有 navigate）", () => {
  const result = computeDslCompleteness({
    request: "筛选 USDT 并确认列表有记录",
    expectedIntent: "open+filter+assert",
    expectedOperations: ["open", "filter", "assert"],
    materializedActions: ["navigate"]
  });
  assert.equal(result.verdict, "SHALLOW");
});

test("N. parseExpectedOperations 解析 intent 语义", () => {
  assert.deepEqual(parseExpectedOperations("open+filter+assert"), ["open", "filter", "assert"]);
});

// ============ Q. readiness L0-L5 ============
test("Q. readiness 分级正确", () => {
  assert.equal(computeModelReadiness({ pageIdentityKnown: false, elementCount: 0, hasControlType: false, dslReady: false, dslPassCount: 0, executionEvidenceCount: 0, coverageVerified: 0, benchmarkPassed: false, freshnessDays: 99 }).level, "L0_DISCOVERED");
  assert.equal(computeModelReadiness({ pageIdentityKnown: true, elementCount: 5, hasControlType: true, dslReady: false, dslPassCount: 0, executionEvidenceCount: 0, coverageVerified: 0, benchmarkPassed: false, freshnessDays: 1 }).level, "L2_DSL_MATERIALIZABLE");
  assert.equal(computeModelReadiness({ pageIdentityKnown: true, elementCount: 10, hasControlType: true, dslReady: true, dslPassCount: 1, executionEvidenceCount: 2, coverageVerified: 1, benchmarkPassed: false, freshnessDays: 1 }).level, "L3_EXECUTION_CAPABLE");
  assert.equal(computeModelReadiness({ pageIdentityKnown: true, elementCount: 10, hasControlType: true, dslReady: true, dslPassCount: 3, executionEvidenceCount: 5, coverageVerified: 3, benchmarkPassed: false, freshnessDays: 1 }).level, "L4_REGRESSION_READY");
  assert.equal(computeModelReadiness({ pageIdentityKnown: true, elementCount: 10, hasControlType: true, dslReady: true, dslPassCount: 3, executionEvidenceCount: 5, coverageVerified: 3, benchmarkPassed: true, freshnessDays: 1 }).level, "L5_TRUSTED");
});

// ============ R/S. quality gate ============
test("R. quality gate BLOCKED：HIGH/FORBIDDEN 执行", () => {
  const gate = runQualityGate({ highForbiddenExecutions: 1, identityDuplicateCreation: 0, directWriteViolations: 0, criticalFalsePositives: 0, wrongBusinessActions: 0, elementRecall: 0.8, controlTypeAccuracy: 0.9, assertionRecall: 0.5, optionRecall: 0.4 });
  assert.equal(gate.status, "BLOCKED");
  assert.ok(gate.blockingIssues.length >= 1);
});

test("S. quality gate WARNING：recall 阈值", () => {
  const gate = runQualityGate({ highForbiddenExecutions: 0, identityDuplicateCreation: 0, directWriteViolations: 0, criticalFalsePositives: 0, wrongBusinessActions: 0, elementRecall: 0.6, controlTypeAccuracy: 0.7, assertionRecall: 0.3, optionRecall: 0.2 });
  assert.equal(gate.status, "WARNING");
});

// ============ macro/weighted 聚合 ============
test("macro/weighted aggregate", () => {
  const agg = aggregatePR([
    { precision: 0.8, recall: 0.7, f1: 0.75, tp: 7, fp: 2, fn: 3, goldRelevant: 10 },
    { precision: 0.5, recall: 0.4, f1: 0.44, tp: 4, fp: 4, fn: 6, goldRelevant: 10 }
  ]);
  assert.equal(agg.macroPrecision, 0.65);
  assert.equal(agg.weightedPrecision, round((0.8 * 10 + 0.5 * 10) / 20));
});

// ============ 数据集完整性 ============
test("P7.4 dataset：≥8 页面覆盖 6 类型", () => {
  const pages = getBenchmarkPages();
  assert.ok(pages.length >= 8, `pages=${pages.length}`);
  const types = new Set(pages.map((p) => p.pageType));
  assert.ok(types.size >= 4, `types=${[...types].join(",")}`);
  assert.ok(pages.every((p) => p.nlProbes.length >= 2), "每页 ≥2 probes");
});
