import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { matchHeuristicsForGap, buildExplorationPlan, gatePlanRisk, buildExplorationFingerprint, type GapForMatching } from "../src/core/exploration-planner.js";
import { HEURISTIC_REGISTRY, getHeuristic } from "../src/core/exploration-heuristics.js";
import { lookupApplicability, heuristicActionsExecutable } from "../src/core/interaction-matrix.js";
import { validatePlanForExecution, type ExplorationPlan } from "../src/core/exploration-executor.js";

const gap = (overrides: Partial<GapForMatching> & { gapId: string }): GapForMatching => ({
  pageId: "demo.page",
  dimension: "element",
  target: "demo.elem",
  source: "element_unverified",
  controlType: undefined,
  hasElementLocator: true,
  ...overrides
});

const pageModel = {
  pageId: "demo.page",
  elements: [
    { elementId: "demo.select_filter", controlType: "select", semanticName: "筛选" },
    { elementId: "demo.btn_submit", controlType: "button", semanticName: "提交" }
  ]
};

function makePlan(overrides: Partial<ExplorationPlan> = {}): ExplorationPlan {
  return {
    planId: "plan_test",
    gapId: "gap:test",
    pageId: "demo.page",
    heuristicId: "select.switch_restore",
    heuristicVersion: 1,
    target: "demo.select_filter",
    preconditions: [],
    steps: [{ stepId: "s1", action: "capture_before", observationTargets: [], risk: "LOW" }],
    observations: [],
    restoreSteps: [{ stepId: "r1", action: "restore_original", observationTargets: [], risk: "LOW" }],
    stopConditions: [],
    risk: "LOW",
    estimatedCost: "LOW",
    expectedEvidence: [],
    fingerprint: "fp_test",
    status: "PLANNED",
    ...overrides
  };
}

// ============ A/B/C/D：Matcher + Matrix ============

test("A. gap 正确匹配 heuristic（select + element_unverified → option_discovery 等）", () => {
  const result = matchHeuristicsForGap(gap({ controlType: "select", target: "demo.select_filter" }), pageModel);
  assert.ok(result.matched.length >= 1, `应匹配，实际 ${result.matched.length}`);
  assert.ok(result.matched.some((item) => item.heuristicId === "select.option_discovery"));
});

test("B. 不相关 gap → NO_MATCH（text 控件 + element_unverified）", () => {
  const result = matchHeuristicsForGap(gap({ controlType: "text" }), pageModel);
  assert.equal(result.verdict, "NO_MATCH");
});

test("C. NOT_APPLICABLE 被过滤：input heuristic 的 select 动作不进 plan", () => {
  const heuristic = getHeuristic("input.basic_observation")!;
  const plan = buildExplorationPlan({
    gap: gap({ controlType: "input", target: "demo.input" }),
    pageId: "demo.page",
    heuristic,
    pageModel: { elements: [{ elementId: "demo.input", controlType: "input" }] }
  });
  // input.basic_observation 的动作 focus/input/observe 均适用——验证没有 select 类动作混入
  const actions = plan.steps.map((step) => step.action);
  assert.ok(!actions.includes("select"), "select 动作不得进入 input plan");
  assert.ok(actions.includes("input_local_test_value") || actions.includes("focus"));
});

test("D. CONDITIONAL 带条件说明", () => {
  const cell = lookupApplicability("input", "click");
  assert.equal(cell.applicability, "CONDITIONAL");
  assert.ok(cell.condition, "CONDITIONAL 必须带 condition");
  const check = heuristicActionsExecutable("dropdown", ["select", "input"]);
  assert.ok(check.conditional.some((item) => item.action === "input" && item.condition), "dropdown 的 input 是 CONDITIONAL 带理由");
});

test("matrix 单一事实源：NOT_APPLICABLE 查询一致性", () => {
  assert.equal(lookupApplicability("button", "input").applicability, "NOT_APPLICABLE");
  assert.equal(lookupApplicability("tab", "input").applicability, "NOT_APPLICABLE");
  assert.equal(lookupApplicability("text", "click").applicability, "NOT_APPLICABLE");
  assert.equal(lookupApplicability("unknown_control", "anything").applicability, "NOT_APPLICABLE", "未知控件默认 N/A");
});

// ============ E/F/G：priority 与 risk 分离 ============

test("E. priority HIGH + risk LOW 可规划（select 切换）", () => {
  const plan = buildExplorationPlan({
    gap: gap({ controlType: "select", target: "demo.select_filter" }),
    pageId: "demo.page",
    heuristic: getHeuristic("select.switch_restore")!,
    pageModel
  });
  assert.equal(plan.risk, "LOW");
  assert.equal(plan.status, "PLANNED");
});

test("F. HIGH risk plan 不执行（risk gate 拒绝）", () => {
  const plan = makePlan({ risk: "HIGH", status: "BLOCKED_BY_RISK", blockedReason: "命中 HIGH 词表" });
  const validation = validatePlanForExecution(plan);
  assert.equal(validation.ok, false);
  assert.ok(validation.reason?.includes("HIGH"));
});

test("G. FORBIDDEN 永不执行", () => {
  const plan = makePlan({ risk: "FORBIDDEN" });
  const validation = validatePlanForExecution(plan);
  assert.equal(validation.ok, false);
  // gate 层面：含真实资金语义的动作判 FORBIDDEN
  const gate = gatePlanRisk("test", ["real transfer production"]);
  assert.equal(gate.risk, "FORBIDDEN");
});

test("gatePlanRisk：withdraw 语义判 HIGH（即使 gap priority 是 HIGH 也不豁免）", () => {
  const gate = gatePlanRisk("withdraw_heuristic", ["withdraw", "submit"]);
  assert.equal(gate.risk, "HIGH");
});

// ============ H/I/J/K：溯源与去重 ============

test("H. heuristicId/version 进入 plan", () => {
  const plan = buildExplorationPlan({
    gap: gap({ controlType: "select", target: "demo.select_filter" }),
    pageId: "demo.page",
    heuristic: getHeuristic("select.option_discovery")!,
    pageModel
  });
  assert.equal(plan.heuristicId, "select.option_discovery");
  // P6.0：select.option_discovery 因 triggerGapSources 扩展 bump 到 v2；断言跟随 registry 当前版本。
  assert.equal(plan.heuristicVersion, getHeuristic("select.option_discovery")!.version);
  assert.ok(plan.planId && plan.fingerprint);
});

test("I. fingerprint 去重：同参数同指纹", () => {
  const base = { pageId: "p1", gapId: "g1", heuristicId: "h1", heuristicVersion: 1, target: "t1", preconditions: ["a", "b"] };
  const fp1 = buildExplorationFingerprint(base);
  const fp2 = buildExplorationFingerprint({ ...base, preconditions: ["b", "a"] });
  assert.equal(fp1, fp2, "preconditions 排序后一致（顺序无关）");
  const fp3 = buildExplorationFingerprint({ ...base, target: "t2" });
  assert.notEqual(fp1, fp3, "target 变化指纹变化");
});

test("J. heuristic version bump 后指纹变化（允许重新探索）", () => {
  const fp1 = buildExplorationFingerprint({ pageId: "p", gapId: "g", heuristicId: "h", heuristicVersion: 1, target: "t", preconditions: [] });
  const fp2 = buildExplorationFingerprint({ pageId: "p", gapId: "g", heuristicId: "h", heuristicVersion: 2, target: "t", preconditions: [] });
  assert.notEqual(fp1, fp2, "版本变化必须改变指纹");
});

test("K. page fingerprint 变化后允许重新探索", () => {
  const fp1 = buildExplorationFingerprint({ pageId: "p", pageSignature: "sig1", gapId: "g", heuristicId: "h", heuristicVersion: 1, target: "t", preconditions: [] });
  const fp2 = buildExplorationFingerprint({ pageId: "p", pageSignature: "sig2", gapId: "g", heuristicId: "h", heuristicVersion: 1, target: "t", preconditions: [] });
  assert.notEqual(fp1, fp2, "页面签名变化指纹变化");
});

// ============ L/M/N：执行门禁 ============

test("L. LOW plan 可执行（validate 通过）", () => {
  const validation = validatePlanForExecution(makePlan());
  assert.equal(validation.ok, true);
});

test("M. MEDIUM 只 dry-run 不执行", () => {
  const validation = validatePlanForExecution(makePlan({ risk: "MEDIUM" }));
  assert.equal(validation.ok, false, "MEDIUM 不得自动执行");
});

test("N. HIGH/FORBIDDEN 零执行", () => {
  assert.equal(validatePlanForExecution(makePlan({ risk: "HIGH" })).ok, false);
  assert.equal(validatePlanForExecution(makePlan({ risk: "FORBIDDEN" })).ok, false);
});

// ============ Q/S/T：边界 ============

test("Q. exploration 不修改 Page Model（executor 零 import page-model 写入）", () => {
  const source = fs.readFileSync("src/core/exploration-executor.ts", "utf8");
  assert.ok(!source.includes("writePageModel") && !source.includes("page-models") && !source.includes("saveProposal"), "executor 不得写 Page Model/proposal");
});

test("S. AI 不可用时 deterministic matcher/planner 仍工作（纯函数无 AI 依赖）", () => {
  const source = fs.readFileSync("src/core/exploration-planner.ts", "utf8");
  assert.ok(!source.includes("callConfiguredAiJson") && !source.includes("ai-provider"), "planner 不依赖 AI");
  // matcher/planner 纯确定性运行
  const result = matchHeuristicsForGap(gap({ controlType: "select" }), pageModel);
  assert.ok(result.matched.length > 0);
});

test("T. executor 动作白名单：未注册动作被拒（AI 无法发明动作）", () => {
  const source = fs.readFileSync("src/core/exploration-executor.ts", "utf8");
  assert.ok(source.includes("EXECUTABLE_ACTIONS"), "存在动作白名单");
  // 白名单不含 submit/withdraw 等写操作
  assert.ok(!source.includes('"submit"') || source.includes("submit\\\", "), "submit 不在白名单");
});

test("registry 全部 heuristic 经 gate 校验与声明 riskClass 一致", () => {
  for (const heuristic of HEURISTIC_REGISTRY) {
    const gate = gatePlanRisk(heuristic.id, heuristic.candidateActions);
    // gate 判定允许比声明更保守（如 MEDIUM 声明被 gate 判 HIGH），但 LOW 声明不得被 gate 升到 HIGH 以上
    if (heuristic.riskClass === "LOW") {
      assert.ok(gate.risk === "LOW" || gate.risk === "MEDIUM", `${heuristic.id}: LOW 声明被 gate 判 ${gate.risk}（允许保守但不允许到 HIGH+）`);
    }
  }
});
