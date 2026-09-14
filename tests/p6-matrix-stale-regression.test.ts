import assert from "node:assert/strict";
import { test } from "node:test";
import { heuristicActionsExecutable } from "../src/core/interaction-matrix.js";
import { getHeuristic } from "../src/core/exploration-heuristics.js";
import { matchHeuristicsForGap } from "../src/core/exploration-planner.js";

/**
 * P6.0 回归：Post-P5 Audit 确认的两个 mapping 缺口。
 *   A. button/link 的 capture_enabled_state / open_modal 动作声明
 *   B. candidate_stale 监听（观察类 heuristic，不新增规则）
 * 核心保证：只让 heuristic 能生成「观察计划」，绝不放开自动 click。
 */

test("P6.0-A: button 的 capture_enabled_state 现为 APPLICABLE（可观察不点击）", () => {
  const check = heuristicActionsExecutable("button", ["capture_enabled_state"]);
  assert.ok(check.executable.includes("capture_enabled_state"));
  assert.equal(check.notApplicable.length, 0);
});

test("P6.0-A: button 的 open_modal 为 CONDITIONAL（弹窗触发观察），click 风险不被放大", () => {
  const check = heuristicActionsExecutable("button", ["open_modal"]);
  assert.ok(check.conditional.some((item) => item.action === "open_modal"));
  assert.equal(check.executable.length, 0);
  // click 仍是 APPLICABLE，但 plan 层由 risk gate 决定；matrix 本身不增加新 click 语义
  const clickCheck = heuristicActionsExecutable("button", ["click"]);
  assert.ok(clickCheck.executable.includes("click"));
});

test("P6.0-A: link 的 open_modal 为 CONDITIONAL", () => {
  const check = heuristicActionsExecutable("link", ["open_modal"]);
  assert.ok(check.conditional.some((item) => item.action === "open_modal"));
});

test("P6.0-A: button.enabled_state_observation 对 button gap 现在 MATCHED（之前 NO_MATCH）", () => {
  const result = matchHeuristicsForGap({
    gapId: "gap:p:element:b1",
    pageId: "p",
    dimension: "element",
    target: "b1",
    source: "element_unverified",
    controlType: "button",
    hasElementLocator: true
  });
  assert.notEqual(result.verdict, "NO_MATCH");
  assert.ok(result.matched.some((m) => m.heuristicId === "button.enabled_state_observation"));
});

test("P6.0-A: modal.open_close 对 link gap 现在 MATCHED（之前被 matrix 过滤）", () => {
  const result = matchHeuristicsForGap({
    gapId: "gap:p:element:l1",
    pageId: "p",
    dimension: "element",
    target: "l1",
    source: "element_unverified",
    controlType: "link",
    hasElementLocator: true
  });
  assert.ok(result.matched.some((m) => m.heuristicId === "modal.open_close"), "modal.open_close 应匹配 link");
});

test("P6.0-B: candidate_stale 的 button 现在被 button.enabled_state_observation 监听", () => {
  const heuristic = getHeuristic("button.enabled_state_observation")!;
  assert.ok(heuristic.triggerGapSources.includes("candidate_stale"));
  const result = matchHeuristicsForGap({
    gapId: "gap:p:element:b_stale",
    pageId: "p",
    dimension: "element",
    target: "b_stale",
    source: "candidate_stale",
    controlType: "button",
    hasElementLocator: true
  });
  assert.ok(result.matched.some((m) => m.heuristicId === "button.enabled_state_observation"));
});

test("P6.0-B: candidate_stale 的 input 现在被 input.basic_observation 监听", () => {
  const heuristic = getHeuristic("input.basic_observation")!;
  assert.ok(heuristic.triggerGapSources.includes("candidate_stale"));
  const result = matchHeuristicsForGap({
    gapId: "gap:p:element:i_stale",
    pageId: "p",
    dimension: "element",
    target: "i_stale",
    source: "candidate_stale",
    controlType: "input",
    hasElementLocator: true
  });
  assert.ok(result.matched.some((m) => m.heuristicId === "input.basic_observation"));
});

test("P6.0-B: 依赖/阻断类 heuristic 不监听 candidate_stale（语义不一致，保留 NO_MATCH）", () => {
  const dependency = getHeuristic("select.dependency_observation")!;
  assert.ok(!dependency.triggerGapSources.includes("candidate_stale"));
  const blocked = getHeuristic("blocked_state_observation")!;
  assert.ok(!blocked.triggerGapSources.includes("candidate_stale"));
});
