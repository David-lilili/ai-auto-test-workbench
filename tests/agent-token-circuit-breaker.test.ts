/**
 * Token / Tool-Loop 熔断器测试（agent-token-circuit-breaker）。
 * 覆盖：task budget warning/critical / 单调用超限 rollover / 连续高相似 short-circuit / tool loop 停循环。
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  TokenCircuitBreaker,
  SimilarityCircuitBreaker,
  ToolLoopBreaker,
  tokenCircuitConfig,
  TOKEN_CIRCUIT_DEFAULTS
} from "../src/core/agent-token-circuit-breaker.js";

test("1. 默认阈值：warning 20M / critical 35M / singleCall 300K / similar 3", () => {
  assert.equal(TOKEN_CIRCUIT_DEFAULTS.warningRawPrompt, 20_000_000);
  assert.equal(TOKEN_CIRCUIT_DEFAULTS.criticalRawPrompt, 35_000_000);
  assert.equal(TOKEN_CIRCUIT_DEFAULTS.singleCallHardInput, 300_000);
  assert.equal(TOKEN_CIRCUIT_DEFAULTS.consecutiveSimilarLimit, 3);
});

test("2. 环境变量可配置预算", () => {
  const config = tokenCircuitConfig({ DEV_AGENT_TASK_BUDGET_WARN: "1000", DEV_AGENT_SINGLE_CALL_HARD: "50000" }, {});
  assert.equal(config.warningRawPrompt, 1000);
  assert.equal(config.singleCallHardInput, 50_000);
});

test("3. task budget：未超 → continue；超 warning → investigate；超 critical → short_circuit", () => {
  const breaker = new TokenCircuitBreaker(tokenCircuitConfig({}, { warningRawPrompt: 1_000, criticalRawPrompt: 2_000 }));
  assert.equal(breaker.addCall({ taskId: "T-1", inputTokens: 400, cacheReadTokens: 300, highSimilar: false }).action, "continue");
  assert.equal(breaker.addCall({ taskId: "T-1", inputTokens: 400, cacheReadTokens: 300, highSimilar: false }).action, "continue");
  const warned = breaker.addCall({ taskId: "T-1", inputTokens: 200, cacheReadTokens: 0, highSimilar: false });
  assert.equal(warned.level, "warning");
  assert.equal(warned.action, "investigate");
  const critical = breaker.addCall({ taskId: "T-1", inputTokens: 1_000, cacheReadTokens: 0, highSimilar: false });
  assert.equal(critical.level, "critical");
  assert.equal(critical.action, "short_circuit");
  assert.ok(critical.signals.some((signal) => signal.includes("critical")));
});

test("4. 单调用 input 超限 → rollover 信号", () => {
  const breaker = new TokenCircuitBreaker();
  assert.equal(breaker.evaluateSingleCall(299_000).action, "continue");
  const signal = breaker.evaluateSingleCall(301_000);
  assert.equal(signal.action, "rollover");
  assert.equal(signal.level, "critical");
});

test("5. 不同 task 预算相互独立", () => {
  const breaker = new TokenCircuitBreaker(tokenCircuitConfig({}, { warningRawPrompt: 1_000, criticalRawPrompt: 2_000 }));
  breaker.addCall({ taskId: "T-A", inputTokens: 1_500, cacheReadTokens: 0, highSimilar: false });
  assert.equal(breaker.status("T-A").level, "warning");
  assert.equal(breaker.status("T-B").level, "ok");
});

test("6. 连续高相似：< limit continue，limit-1 investigate，>= limit short_circuit", () => {
  const breaker = new SimilarityCircuitBreaker(3);
  assert.equal(breaker.add(true).action, "continue");
  assert.equal(breaker.add(true).action, "investigate");
  const blocked = breaker.add(true);
  assert.equal(blocked.action, "short_circuit");
  assert.equal(blocked.consecutiveSimilar, 3);
  // 不同消息重置计数。
  assert.equal(breaker.add(false).action, "continue");
  assert.equal(breaker.add(true).action, "continue");
});

test("7. ToolLoopBreaker：同命令 + 同签名重复 2 次后 STOP LOOP；签名变化重置", () => {
  const breaker = new ToolLoopBreaker();
  assert.equal(breaker.tryRun("npm run typecheck", "sig-1").allowLoop, true);
  assert.equal(breaker.tryRun("npm run typecheck", "sig-1").allowLoop, true);
  const blocked = breaker.tryRun("npm run typecheck", "sig-1");
  assert.equal(blocked.allowLoop, false);
  assert.equal(blocked.repeats, 3);
  // 错误签名变化 → 重置计数。
  assert.equal(breaker.tryRun("npm run typecheck", "sig-2").allowLoop, true);
  // 不同命令互不影响。
  assert.equal(breaker.tryRun("npm test", "sig-1").allowLoop, true);
});
