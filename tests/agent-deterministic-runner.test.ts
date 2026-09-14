/**
 * Deterministic Tool Runner 测试（agent-deterministic-runner）。
 * 覆盖：命令分类 / PASS 链不升级 / 失败分类与升级 / 状态机链执行。
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyDeterministicCommand,
  isDeterministicCommand,
  DeterministicToolRunner,
  classifyToolFailure,
  shouldEscalateToLlm,
  ToolResultStateMachine
} from "../src/core/agent-deterministic-runner.js";
import type { DeterministicRunResult } from "../src/core/agent-deterministic-runner.js";

const okExec = async (): Promise<{ stdout: string; stderr: string; code: number | null }> => ({ stdout: "ok", stderr: "", code: 0 });
const failExec = async (): Promise<{ stdout: string; stderr: string; code: number | null }> => ({ stdout: "", stderr: "error TS2304: Cannot find name 'x'", code: 1 });

test("1. 命令分类：typecheck / test / verify / git / doctor 等为确定性命令", () => {
  assert.equal(classifyDeterministicCommand("npm run typecheck"), "typecheck");
  assert.equal(classifyDeterministicCommand("npx tsc --noEmit"), "typecheck");
  assert.equal(classifyDeterministicCommand("tsx --test tests/foo.test.ts"), "unit_test");
  assert.equal(classifyDeterministicCommand("npm run verify"), "npm_verify");
  assert.equal(classifyDeterministicCommand("git status --porcelain"), "git_status");
  assert.equal(classifyDeterministicCommand("git diff --stat"), "git_diff_summary");
  assert.equal(classifyDeterministicCommand("npm run encoding:check"), "format_check");
  assert.equal(classifyDeterministicCommand("npm run context:doctor"), "doctor");
  assert.equal(classifyDeterministicCommand("npx tsx scripts/run-tests.ts"), "unit_test");
  assert.equal(classifyDeterministicCommand("npm run project-capabilities:validate"), "known_script");
  assert.equal(classifyDeterministicCommand("rm -rf /tmp/x"), "unknown");
  assert.equal(classifyDeterministicCommand(""), "unknown");
});

test("2. isDeterministicCommand 快捷判定", () => {
  assert.equal(isDeterministicCommand("npm run typecheck"), true);
  assert.equal(isDeterministicCommand("some random command"), false);
});

test("3. Runner PASS：status=pass 且 summary 为空（不回 LLM）", async () => {
  const runner = new DeterministicToolRunner({ cwd: process.cwd(), exec: okExec });
  const result = await runner.run("npm run typecheck");
  assert.equal(result.status, "pass");
  assert.equal(result.exitCode, 0);
  assert.equal(result.summary, "");
  assert.equal(result.kind, "typecheck");
});

test("4. Runner FAIL：status=fail 且带压缩摘要", async () => {
  const runner = new DeterministicToolRunner({ cwd: process.cwd(), exec: failExec });
  const result = await runner.run("npm run typecheck");
  assert.equal(result.status, "fail");
  assert.equal(result.exitCode, 1);
  assert.ok(result.summary.includes("KNOWN_TYPE_ERROR"));
  assert.ok(result.summary.includes("TS2304"));
});

test("5. Runner 拒绝非确定性命令（error，不执行）", async () => {
  let executed = false;
  const runner = new DeterministicToolRunner({
    cwd: process.cwd(),
    exec: async () => {
      executed = true;
      return { stdout: "", stderr: "", code: 0 };
    }
  });
  const result = await runner.run("rm -rf /tmp/whatever");
  assert.equal(result.status, "error");
  assert.equal(executed, false);
});

test("6. 失败分类：transient / format / type / assertion / env / unknown", () => {
  assert.equal(classifyToolFailure({ command: "x", exitCode: 1, stdout: "", stderr: "fetch failed: ETIMEDOUT" }), "KNOWN_TRANSIENT");
  assert.equal(classifyToolFailure({ command: "x", exitCode: 1, stdout: "", stderr: "invalid utf8 encoding at line 3" }), "KNOWN_FORMAT_ERROR");
  assert.equal(classifyToolFailure({ command: "x", exitCode: 1, stdout: "", stderr: "error TS2322: Type 'string' is not assignable" }), "KNOWN_TYPE_ERROR");
  assert.equal(classifyToolFailure({ command: "x", exitCode: 1, stdout: "", stderr: "AssertionError: expected 1 to equal 2" }), "KNOWN_TEST_ASSERTION");
  assert.equal(classifyToolFailure({ command: "x", exitCode: 1, stdout: "", stderr: "tsc: command not found" }), "ENVIRONMENT_ERROR");
  assert.equal(classifyToolFailure({ command: "x", exitCode: 1, stdout: "weird output", stderr: "" }), "UNKNOWN");
});

test("7. 升级判定：只有 type / assertion / unknown 触发 LLM", () => {
  assert.equal(shouldEscalateToLlm("KNOWN_TYPE_ERROR"), true);
  assert.equal(shouldEscalateToLlm("KNOWN_TEST_ASSERTION"), true);
  assert.equal(shouldEscalateToLlm("UNKNOWN"), true);
  assert.equal(shouldEscalateToLlm("KNOWN_TRANSIENT"), false);
  assert.equal(shouldEscalateToLlm("KNOWN_FORMAT_ERROR"), false);
  assert.equal(shouldEscalateToLlm("ENVIRONMENT_ERROR"), false);
});

test("8. 状态机：全 PASS → chain_complete_return_to_llm（链内不回 LLM）", async () => {
  const runner = new DeterministicToolRunner({ cwd: process.cwd(), exec: okExec });
  const machine = new ToolResultStateMachine(["typecheck", "unit_test", "doctor"], runner);
  const { results, action, failureKind } = await machine.executeChain({
    typecheck: "npm run typecheck",
    unit_test: "tsx --test tests/x.test.ts",
    doctor: "npm run context:doctor"
  });
  assert.equal(results.length, 3);
  assert.equal(action, "chain_complete_return_to_llm");
  assert.equal(failureKind, null);
});

test("9. 状态机：typecheck FAIL（type error）→ escalate_to_llm，链中断", async () => {
  const runner = new DeterministicToolRunner({ cwd: process.cwd(), exec: failExec });
  const machine = new ToolResultStateMachine(["typecheck", "unit_test"], runner);
  const { results, action, failureKind } = await machine.executeChain({
    typecheck: "npm run typecheck",
    unit_test: "tsx --test tests/x.test.ts"
  });
  assert.equal(results.length, 1);
  assert.equal(action, "escalate_to_llm");
  assert.equal(failureKind, "KNOWN_TYPE_ERROR");
});

test("10. 状态机：transient 失败 → deterministic_retry（不触发 LLM）", async () => {
  const runner = new DeterministicToolRunner({
    cwd: process.cwd(),
    exec: async () => ({ stdout: "", stderr: "connect ETIMEDOUT", code: 1 })
  });
  const machine = new ToolResultStateMachine(["typecheck"], runner);
  const { action, failureKind } = await machine.executeChain({ typecheck: "npm run typecheck" });
  assert.equal(action, "deterministic_retry");
  assert.equal(failureKind, "KNOWN_TRANSIENT");
});

test("11. 类型形状：DeterministicRunResult 字段", () => {
  const result: DeterministicRunResult = {
    kind: "typecheck",
    command: "npm run typecheck",
    exitCode: 0,
    status: "pass",
    summary: "",
    stdoutSummary: "",
    stderrSummary: "",
    elapsedMs: 1
  };
  assert.deepEqual(Object.keys(result).sort(), ["command", "elapsedMs", "exitCode", "kind", "status", "stderrSummary", "stdoutSummary", "summary"]);
});
