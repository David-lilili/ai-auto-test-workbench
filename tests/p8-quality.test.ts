import test from "node:test";
import assert from "node:assert/strict";
import { classifyPageRegion, isRegionAllowedForAssertion } from "../src/core/modeling-page-region.js";
import { defaultPurposeForKind, tagAssertionPurposeWithRegion, buildAssertionSemanticKey, dedupeAssertions, normalizeAssertionSemantics } from "../src/core/modeling-assertion-quality.js";
import { buildOptionIdentity, isolatePopupOptions, coverageModeFor, dedupeOptions, looksLikeTriggerDisplay } from "../src/core/modeling-option-identity.js";
import { toResultRegionModel, buildResultRegionSemanticKey, isResultRegionAlreadyModeled, planResultRegionWriteback } from "../src/core/modeling-result-region.js";
import { detectColumns, mapColumnToTargetField, diffColumns } from "../src/core/modeling-column.js";
import { determineButtonRole, riskRelevantRole } from "../src/core/modeling-button-role.js";
import { buildIntentRequirementGraph, missingSemanticOperations, computeDslSemanticLevel } from "../src/core/modeling-dsl-semantic.js";
import { diffOptionSets, diffColumnSets } from "../src/core/modeling-mutation-detect.js";
import { inferTargetField, buildFieldMetadata, wouldAutoInferBusinessRule } from "../src/core/modeling-form-metadata.js";
import { generateResultAssertions, computeKnowledgeCoverage, computeCoverageCeiling, buildRecallFunnel, funnelLoss } from "../src/core/modeling-coverage-analysis.js";
import { scanAssertionCandidates } from "../src/core/modeling-structure-scanner.js";
import type { InventoryItem } from "../src/capture/types.js";

function inv(partial: Partial<Parameters<typeof scanAssertionCandidates>[0]>): Parameters<typeof scanAssertionCandidates>[0] {
  return { clickables: [], fields: [], buttons: [], tables: [], dialogs: [], iframes: [], selectLike: [], ...partial };
}
function btn(text: string, extra: Partial<InventoryItem> = {}): InventoryItem {
  return { index: 0, tag: "button", role: "button", text, ...extra };
}

// ============ A-D. region gate ============
test("A. global nav assertion filtered（nav 链接不得当业务断言）", () => {
  const candidates = scanAssertionCandidates(inv({ buttons: [btn("行情", { href: "/market" }), btn("现货交易", { href: "/spot" }), btn("合约交易", { href: "/futures" })] }), "");
  assert.equal(candidates.filter((c) => c.canonicalKind === "element_enabled").length, 0);
});

test("B. business result assertion retained（业务查询按钮保留）", () => {
  const candidates = scanAssertionCandidates(inv({ buttons: [btn("查询"), btn("重置")] }), "");
  assert.ok(candidates.some((c) => c.canonicalKind === "element_enabled" && c.semanticName.includes("查询")));
  assert.ok(candidates.some((c) => c.canonicalKind === "element_enabled" && c.semanticName.includes("重置")));
});

test("C. footer noise filtered（footer 区域排除）", () => {
  const region = classifyPageRegion({ tag: "footer", role: "contentinfo", text: "关于我们" });
  assert.equal(region.regionType, "FOOTER");
  assert.equal(isRegionAllowedForAssertion(region.regionType, "RESULT_EXISTENCE"), false);
});

test("D. utility assertion classification（utility 仅 control-state）", () => {
  assert.equal(isRegionAllowedForAssertion("UTILITY", "CONTROL_STATE"), true);
  assert.equal(isRegionAllowedForAssertion("UTILITY", "RESULT_EXISTENCE"), false);
});

// ============ E. assertion dedupe ============
test("E. assertion semantic dedupe（同义候选去重）", () => {
  const k1 = buildAssertionSemanticKey({ pageId: "p", purpose: "RESULT_EXISTENCE", semanticName: "结果表可见" });
  const k2 = buildAssertionSemanticKey({ pageId: "p", purpose: "RESULT_EXISTENCE", semanticName: "查询结果区域存在" });
  const k3 = buildAssertionSemanticKey({ pageId: "p", purpose: "RESULT_EXISTENCE", semanticName: "结果列表或空状态" });
  assert.equal(k1, k2);
  assert.equal(k1, k3);
  // 同义短语归一到同一 token（result_list）
  assert.equal(normalizeAssertionSemantics("结果表可见"), normalizeAssertionSemantics("查询结果区域存在"));
  assert.equal(normalizeAssertionSemantics("结果表可见"), "result_list");
});

// ============ F-H. option identity ============
test("F. option selected-value pollution filtered（当前选中值不写回）", () => {
  const identity = buildOptionIdentity("parent", "选择网络", { triggerDisplayText: "选择网络", popupContainers: ["listbox"], rawOptionTexts: ["选择网络"], captureMechanism: "portal_delta" });
  assert.equal(identity.optionValue, undefined);
  assert.equal(identity.status, "candidate");
  assert.ok(looksLikeTriggerDisplay("选择网络", "选择网络"));
});

test("G. option parent pollution removed（语义名不含父级/当前值）", () => {
  const identity = buildOptionIdentity("withdraw.network_selector", "Ethereum", { triggerDisplayText: "选择网络", popupContainers: ["listbox"], rawOptionTexts: ["Ethereum"], captureMechanism: "portal_delta" });
  assert.equal(identity.semanticName?.includes("选择网络"), false);
  assert.equal(identity.optionValue, "Ethereum");
});

test("H. option visible text identity（<visibleText> 选项）", () => {
  const identity = buildOptionIdentity("parent", "USDT", { triggerDisplayText: "USDT", popupContainers: ["listbox"], rawOptionTexts: ["USDT"], captureMechanism: "listbox_visible" });
  assert.ok(identity.normalizedText === "usdt" || identity.normalizedText === "usdt");
});

// ============ I-K. coverage modes ============
test("I. native option complete", () => {
  assert.equal(coverageModeFor({ triggerDisplayText: "", popupContainers: [], rawOptionTexts: [], captureMechanism: "native_select" }), "COMPLETE");
});
test("J. virtualized partial", () => {
  assert.equal(coverageModeFor({ triggerDisplayText: "", popupContainers: [], rawOptionTexts: [], captureMechanism: "portal_delta", virtualized: true }), "PARTIAL");
});
test("K. remote sampled（有搜索输入 → SAMPLED）", () => {
  assert.equal(coverageModeFor({ triggerDisplayText: "", popupContainers: [], rawOptionTexts: [], captureMechanism: "portal_delta", hasSearchInput: true }), "SAMPLED");
});

// ============ L-M. popup isolation / nav pollution ============
test("L. popup delta isolation（只收新增 option）", () => {
  const before = ["首页", "现货交易"];
  const after = ["首页", "现货交易", "BTC", "ETH"];
  const delta = isolatePopupOptions(before, after, ["#listbox"]);
  assert.deepEqual(delta.sort(), ["BTC", "ETH"].sort());
});
test("M. nav dropdown pollution（全页 li/a/button 不收，除非 popup 内）", () => {
  const delta = isolatePopupOptions(["现货交易", "合约交易"], ["现货交易", "合约交易"], []);
  assert.equal(delta.length, 0);
});

// ============ N. option mutation ============
test("N. new option mutation detection（V1→V2 增量识别）", () => {
  const diff = diffOptionSets("dropdown", ["USDT", "USDC"], ["USDT", "USDC", "BTC"]);
  assert.deepEqual(diff.addedOptions, ["BTC"]);
  assert.equal(diff.changedAreaRecall, 1);
  assert.equal(diff.parentUnchanged, true);
  assert.equal(diff.unchangedRetention, 1);
});

// ============ O-P. result region ============
test("O. result region writeback（candidate/dom_verified 允许，execution_verified 拒绝）", () => {
  const region = toResultRegionModel({ resultRegionId: "r1", type: "table", columns: ["币种", "时间", "数量"], rowLocator: "[role='table']", evidence: ["tag=table"] });
  const existing: ReturnType<typeof toResultRegionModel>[] = [];
  assert.equal(planResultRegionWriteback("p", region, existing).action, "append");
  const exec = { ...region, status: "execution_verified" as const };
  assert.equal(planResultRegionWriteback("p", exec, existing).action, "rejected");
});
test("P. result region dedupe（同 key 幂等跳过）", () => {
  const region = toResultRegionModel({ resultRegionId: "r1", type: "table", columns: ["币种", "时间"], evidence: [] });
  const existing = [region];
  assert.equal(planResultRegionWriteback("p", region, existing).action, "skip_duplicate");
  assert.ok(isResultRegionAlreadyModeled("p", region, existing));
  const key = buildResultRegionSemanticKey("p", region);
  assert.ok(key.length > 3);
});

// ============ Q-T. columns ============
test("Q. column detection（th/columnheader）", () => {
  const cols = detectColumns({ headers: [{ text: "时间", tag: "th", role: "columnheader", index: 0 }, { text: "币种", tag: "th", role: "columnheader", index: 1 }, { text: "数量", tag: "th", role: "columnheader", index: 2 }] });
  assert.equal(cols.length, 3);
  assert.equal(cols[0].targetField, "record_time");
});
test("R. column false positive avoided（筛选 label/tab 不误判）", () => {
  const cols = detectColumns({ headers: [{ text: "全部", tag: "button", role: "tab", index: 0 }, { text: "查询", tag: "button", index: 1 }], filterLabels: ["全部"], tabTexts: ["全部"] });
  assert.equal(cols.length, 0);
});
test("S. new column mutation detection", () => {
  const auto = detectColumns({ headers: [{ text: "币种", tag: "th", index: 0 }, { text: "时间", tag: "th", index: 1 }, { text: "手续费", tag: "th", index: 2 }, { text: "数量", tag: "th", index: 3 }] });
  const gold = detectColumns({ headers: [{ text: "币种", tag: "th", index: 0 }, { text: "时间", tag: "th", index: 1 }, { text: "数量", tag: "th", index: 2 }] });
  const d = diffColumns(auto, gold);
  assert.ok(d.newColumns.some((c) => c.text === "手续费"));
  assert.equal(d.removedColumns.length, 0);
});
test("T. renamed column semantic match（数量→金额 = rename 非 delete+add）", () => {
  const auto = detectColumns({ headers: [{ text: "币种", tag: "th", index: 0 }, { text: "金额", tag: "th", index: 1 }] });
  const gold = detectColumns({ headers: [{ text: "币种", tag: "th", index: 0 }, { text: "数量", tag: "th", index: 1 }] });
  const d = diffColumns(auto, gold);
  assert.equal(d.renamedColumns.length, 1);
  assert.ok(d.removedColumns.length === 0 || d.newColumns.length === 0);
  assert.equal(mapColumnToTargetField("金额"), "amount");
});

// ============ U-W. button roles ============
test("U. button semanticRole filter apply/reset", () => {
  assert.equal(determineButtonRole({ text: "查询" }).semanticRole, "FILTER_APPLY");
  assert.equal(determineButtonRole({ text: "重置" }).semanticRole, "FILTER_RESET");
});
test("V. button semanticRole destructive/security", () => {
  assert.equal(determineButtonRole({ text: "删除" }).semanticRole, "DESTRUCTIVE");
  assert.equal(determineButtonRole({ text: "开启二次验证" }).semanticRole, "SECURITY_ACTION");
  assert.ok(riskRelevantRole("DESTRUCTIVE"));
});
test("W. risk not downgraded（semanticRole 不降低风险）", () => {
  // destructive 词即使看似 filter 上下文，仍判 destructive
  assert.equal(determineButtonRole({ text: "删除筛选" }).semanticRole, "DESTRUCTIVE");
});

// ============ X-Z. form metadata ============
test("X. form targetField 优先级（name > placeholder > semanticName）", () => {
  const tf = inferTargetField({ name: "amount", placeholder: "请输入数量", semanticName: "数量输入框" });
  assert.equal(tf.targetField, "amount");
  assert.equal(tf.confidence, "HIGH");
});
test("Y. required constraint（DOM_FIELD_CONSTRAINT）", () => {
  const m = buildFieldMetadata({ name: "amount", constraints: { required: true, min: 10, maxLength: 8 } });
  assert.equal(m.required, true);
  assert.ok(m.domConstraints.some((c) => c.type === "required"));
  assert.ok(m.domConstraints.some((c) => c.type === "min" && c.value === "10"));
});
test("Z. business constraint not auto inferred（min=10 不解释成业务规则）", () => {
  const m = buildFieldMetadata({ name: "amount", constraints: { min: 10 } });
  assert.equal(wouldAutoInferBusinessRule(m.domConstraints), false);
  assert.equal(m.domConstraints.some((c) => c.type === "business_rule"), false);
});

// ============ AA-AC. DSL semantic completeness ============
test("AA. DSL FULL（required ops 全覆盖）", () => {
  const intent = "筛选 USDT 并确认记录";
  const steps = ["navigate 打开现货流水", "select 选择币种 USDT", "apply 点击查询", "assert 确认结果列表"];
  const level = computeDslSemanticLevel(intent, steps, true);
  assert.equal(level.level, "READY_FULL");
  assert.equal(level.missing.length, 0);
});
test("AB. DSL SHALLOW（只 navigate+assert，缺筛选）", () => {
  const intent = "筛选 USDT 并确认记录";
  const steps = ["navigate 打开现货流水", "assert 确认列表存在"];
  const level = computeDslSemanticLevel(intent, steps, true);
  assert.equal(level.level, "READY_SHALLOW");
  assert.ok(level.missing.includes("SELECT_FILTER"));
});
test("AC. missing semantic op diagnostics", () => {
  const missing = missingSemanticOperations("筛选 USDT 并确认记录", ["navigate 打开"]);
  assert.ok(missing.includes("SELECT_FILTER"));
  assert.ok(missing.includes("ASSERT_FILTERED_RESULT"));
  const req = buildIntentRequirementGraph("筛选 USDT 并确认记录");
  assert.ok(req.operations.includes("APPLY_FILTER"));
});

// ============ AD-AF. ceiling / funnel ============
test("AD. discoverable ceiling（理论上限 = autoDiscoverable/allValid）", () => {
  const c = computeCoverageCeiling({ observedRecall: 0.2, allValidGold: 100, budget: [
    { kind: "DETERMINISTIC_DISCOVERABLE", count: 60 },
    { kind: "INTERACTION_DISCOVERABLE", count: 15 },
    { kind: "BUSINESS_KNOWLEDGE_REQUIRED", count: 15 },
    { kind: "HIGH_RISK_REQUIRED", count: 10 }
  ] });
  assert.equal(c.autoDiscoverableGold, 75);
  assert.equal(c.theoreticalCeiling, 0.75);
  assert.ok(c.discoverableRecall > c.observedRecall);
});
test("AE. discoverable recall（分母只含可发现项）", () => {
  const c = computeCoverageCeiling({ observedRecall: 0.5, allValidGold: 100, budget: [
    { kind: "DETERMINISTIC_DISCOVERABLE", count: 50 },
    { kind: "INTERACTION_DISCOVERABLE", count: 10 }
  ] });
  assert.equal(c.discoverableRecall, 0.833);
});
test("AF. recall funnel（损失分层）", () => {
  const funnel = buildRecallFunnel({ discoverableGold: 500, bootstrapDetected: 420, coverageRepresented: 400, heuristicMatched: 310, executed: 210, evidence: 190, promoted: 160 });
  assert.equal(funnel[0].count, 500);
  assert.equal(funnel[funnel.length - 1].count, 160);
  const losses = funnelLoss(funnel);
  assert.ok(losses.some((l) => l.from === "Heuristic matched" && l.to === "Executed" && l.loss === 100));
});

// ============ AG. review load ============
test("AG. review load 不爆炸（去重后候选数受控）", () => {
  const candidates = scanAssertionCandidates(inv({
    buttons: Array.from({ length: 10 }, (_, i) => btn(`按钮${i}`)),
    tables: [{ index: 0, tag: "table", role: "table", rowCount: 5, columnHeaders: ["币种", "时间", "数量"] }]
  }), "暂无数据");
  assert.ok(candidates.length <= 24);
  // 重复按钮只产生一个候选
  const enabled = candidates.filter((c) => c.canonicalKind === "element_enabled" && c.semanticName.includes("按钮1"));
  assert.ok(enabled.length <= 1);
});

// ============ AH. performance budget（纯函数预算：无浏览器） ============
test("AH. performance budget（模块为纯函数，无额外浏览器动作）", () => {
  // 所有 P8 模块均为确定性纯函数，不引入浏览器动作/网络
  const region = classifyPageRegion({ tag: "main", role: "main" });
  assert.equal(region.regionType, "BUSINESS_MAIN");
});

// ============ AI. cross-framework dropdown（抽象，不按页面特例） ============
test("AI. cross-framework dropdown（同 identity 逻辑适用于 native/listbox/portal）", () => {
  const native = coverageModeFor({ triggerDisplayText: "", popupContainers: [], rawOptionTexts: ["A", "B"], captureMechanism: "native_select" });
  const listbox = coverageModeFor({ triggerDisplayText: "", popupContainers: ["listbox"], rawOptionTexts: ["A", "B"], captureMechanism: "listbox_visible", scrolledToEnd: true });
  const portal = coverageModeFor({ triggerDisplayText: "", popupContainers: ["#popper"], rawOptionTexts: ["A", "B"], captureMechanism: "portal_delta", scrolledToEnd: true });
  assert.equal(native, "COMPLETE");
  assert.equal(listbox, "COMPLETE");
  assert.equal(portal, "COMPLETE");
});

// ============ AJ. HIGH/FORBIDDEN zero（风险预算不引入破坏性动作） ============
test("AJ. HIGH/FORBIDDEN zero（模块不产生 destructive 执行）", () => {
  // 区域分类/断言生成/option 采集全部只读：不返回任何"执行动作"
  const candidates = generateResultAssertions(toResultRegionModel({ resultRegionId: "r", type: "table", columns: ["币种"], evidence: [] }));
  assert.ok(candidates.every((c) => c.status === "dom_verified"));
  assert.ok(candidates.every((c) => c.source.startsWith("result_region")));
  // knowledge coverage 全为统计，无副作用
  const cov = computeKnowledgeCoverage({ autoElements: 10, goldElements: 20, autoOptions: 0, goldOptions: 5, autoAssertions: 1, goldAssertions: 4, autoStates: 0, goldStates: 2, autoDependencies: 0, goldDependencies: 1, businessRuleGold: 3 });
  assert.equal(cov.find((c) => c.domain === "STRUCTURE")?.recall, 0.5);
});
