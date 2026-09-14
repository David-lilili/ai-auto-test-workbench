/**
 * Development Agent 上下文预算与路由测试（agent-context-budget）。
 * 覆盖：budget 判定 / rollover 触发 / cache-miss 预测 / L0/L1/L2 路由 / 环境变量覆盖。
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  decideContextBudget,
  decideSessionRollover,
  predictsCacheMiss,
  devContextBudget,
  routeDevContext,
  DEV_CONTEXT_DEFAULTS
} from "../src/core/agent-context-budget.js";

test("1. budget：< warning → continue；warning..hard → prepare_checkpoint；>= hard → force_rollover", () => {
  const budget = devContextBudget({}, {});
  assert.equal(decideContextBudget(150_000, budget).action, "continue");
  assert.equal(decideContextBudget(100_000, budget).level, "ok");

  const warn = decideContextBudget(260_000, budget);
  assert.equal(warn.level, "warning");
  assert.equal(warn.action, "prepare_checkpoint");

  const hard = decideContextBudget(320_000, budget);
  assert.equal(hard.level, "hard");
  assert.equal(hard.action, "force_rollover");

  const boundary = decideContextBudget(300_000, budget);
  assert.equal(boundary.level, "hard");
});

test("2. 默认阈值：target 200K / warn 250K / hard 300K", () => {
  assert.equal(DEV_CONTEXT_DEFAULTS.targetInputTokens, 200_000);
  assert.equal(DEV_CONTEXT_DEFAULTS.warningInputTokens, 250_000);
  assert.equal(DEV_CONTEXT_DEFAULTS.hardInputTokens, 300_000);
});

test("3. 环境变量可配置阈值", () => {
  const budget = devContextBudget({ DEV_AGENT_INPUT_HARD: "100000" }, {});
  assert.equal(budget.hardInputTokens, 100_000);
  assert.equal(decideContextBudget(120_000, budget).action, "force_rollover");
});

test("4. rollover：input 超限 / 消息数超限 / phase 边界 / 长 idle 各自触发", () => {
  const budget = devContextBudget({}, {});
  const ok = decideSessionRollover({ inputTokens: 100_000, messageCount: 100, phaseBoundary: false, idleMs: 60_000 }, budget);
  assert.equal(ok.rollover, false);

  const byInput = decideSessionRollover({ inputTokens: 310_000, messageCount: 100, phaseBoundary: false, idleMs: 0 }, budget);
  assert.equal(byInput.rollover, true);
  assert.ok(byInput.reasons.some((reason) => reason.includes("input")));

  const byMessages = decideSessionRollover({ inputTokens: 10_000, messageCount: 501, phaseBoundary: false, idleMs: 0 }, budget);
  assert.equal(byMessages.rollover, true);

  const byPhase = decideSessionRollover({ inputTokens: 10_000, messageCount: 10, phaseBoundary: true, idleMs: 0 }, budget);
  assert.equal(byPhase.rollover, true);

  const byIdle = decideSessionRollover({ inputTokens: 10_000, messageCount: 10, phaseBoundary: false, idleMs: 8 * 3600_000 }, budget);
  assert.equal(byIdle.rollover, true);
  assert.ok(byIdle.reasons.some((reason) => reason.includes("cache miss")));
});

test("5. predictsCacheMiss：idle 超过阈值返回 true（审计：8.3h 间隙后 cacheRead=0）", () => {
  const budget = devContextBudget({}, {});
  assert.equal(predictsCacheMiss(60_000, budget), false);
  assert.equal(predictsCacheMiss(8 * 3600_000, budget), true);
});

test("6. 路由：默认 L0 + minimal L1；L2 仅显式加载", () => {
  const routed = routeDevContext({
    taskIdentity: "taskId: T-1\nphase: P17",
    nextAction: "写 benchmark",
    stepSpecification: "步骤 3：跑脚本",
    changedFiles: ["scripts/token-benchmark.ts"],
    relevantErrors: ["TS2304: Cannot find name"],
    criticalInvariants: ["不改业务逻辑"],
    deepDocs: ["docs/decisions/ADR-1.md"]
  });
  assert.deepEqual(routed.loadedLayers, ["L0", "L1"]);
  assert.ok(routed.content.includes("L0 — Task Identity"));
  assert.ok(routed.content.includes("Step Specification"));
  assert.ok(routed.content.includes("Changed Files"));
  assert.ok(routed.content.includes("TS2304"));
  assert.ok(!routed.content.includes("L2"));
  assert.ok(routed.estimatedInputTokens > 0);

  const withL2 = routeDevContext({
    taskIdentity: "id",
    nextAction: "next",
    deepDocs: ["docs/decisions/ADR-1.md"]
  }, { loadL2: true });
  assert.deepEqual(withL2.loadedLayers, ["L0", "L2"]);
  assert.ok(withL2.content.includes("Deep Documents"));
});

test("7. 只有 L0（无 L1 素材）时不渲染空 L1", () => {
  const routed = routeDevContext({ taskIdentity: "id", nextAction: "next" });
  assert.deepEqual(routed.loadedLayers, ["L0"]);
  assert.ok(!routed.content.includes("L1"));
});
