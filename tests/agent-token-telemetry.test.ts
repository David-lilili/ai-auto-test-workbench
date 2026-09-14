/**
 * Development Agent token telemetry 测试（agent-token-telemetry）。
 * 覆盖：默认不存 prompt 内容 / TOKEN_DEBUG_FULL_RETENTION 开启后保存 / JSONL append / summarize。
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DevAgentTelemetry, fullRetentionEnabled, promptHashFor } from "../src/core/agent-token-telemetry.js";

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tel-"));
}

const baseRecord = {
  taskId: "T-1",
  phase: "P17",
  sessionId: "sess-x",
  repoHead: "abc123",
  stepId: "step-1",
  inputTokens: 200_000,
  cacheReadTokens: 190_000,
  nonCachedTokens: 10_000,
  completionTokens: 500,
  attempt: 1,
  reason: "tool_result",
  toolBefore: ["Bash"],
  toolAfter: ["Edit"],
  errorSignature: null
};

test("1. 默认 full retention 关闭（env 未设置）", () => {
  assert.equal(fullRetentionEnabled({}), false);
  assert.equal(fullRetentionEnabled({ TOKEN_DEBUG_FULL_RETENTION: "false" }), false);
  assert.equal(fullRetentionEnabled({ TOKEN_DEBUG_FULL_RETENTION: "true" }), true);
  assert.equal(fullRetentionEnabled({ TOKEN_DEBUG_FULL_RETENTION: "1" }), true);
  assert.equal(fullRetentionEnabled({ TOKEN_DEBUG_FULL_RETENTION: "TRUE" }), true);
});

test("2. 默认记录不含 promptContent，即使传了 promptText", async () => {
  const root = tmpRoot();
  try {
    const telemetry = new DevAgentTelemetry(root);
    const record = await telemetry.record({ ...baseRecord, promptText: "SECRET PROMPT CONTENT" });
    assert.equal(record.promptContent, undefined);
    const records = await telemetry.readAll();
    assert.equal(records.length, 1);
    assert.equal(records[0].promptContent, undefined);
    const text = fs.readFileSync(path.join(root, ".runtime", "agent-state", "telemetry", "calls.jsonl"), "utf8");
    assert.ok(!text.includes("SECRET PROMPT CONTENT"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("3. 开启 TOKEN_DEBUG_FULL_RETENTION 后保存 prompt 内容", async () => {
  const root = tmpRoot();
  try {
    const old = process.env.TOKEN_DEBUG_FULL_RETENTION;
    process.env.TOKEN_DEBUG_FULL_RETENTION = "true";
    try {
      const telemetry = new DevAgentTelemetry(root);
      await telemetry.record({ ...baseRecord, promptText: "FULL PROMPT" });
      const records = await telemetry.readAll();
      assert.equal(records[0].promptContent, "FULL PROMPT");
    } finally {
      if (old === undefined) delete process.env.TOKEN_DEBUG_FULL_RETENTION;
      else process.env.TOKEN_DEBUG_FULL_RETENTION = old;
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("4. promptHash 稳定：同文本同 hash", () => {
  assert.equal(promptHashFor("hello world"), promptHashFor("hello world"));
  assert.notEqual(promptHashFor("hello world"), promptHashFor("hello world!"));
});

test("5. JSONL append：多次 record 追加，summarize 汇总正确", async () => {
  const root = tmpRoot();
  try {
    const telemetry = new DevAgentTelemetry(root);
    await telemetry.record({ ...baseRecord, inputTokens: 100_000, cacheReadTokens: 80_000 });
    await telemetry.record({ ...baseRecord, stepId: "step-2", inputTokens: 300_000, cacheReadTokens: 0 });
    const summary = await telemetry.summarize();
    assert.equal(summary.calls, 2);
    assert.equal(summary.totalPromptTokens, 400_000);
    assert.equal(summary.totalCacheReadTokens, 80_000);
    assert.equal(summary.totalNonCachedTokens, 320_000);
    assert.equal(summary.avgInput, 200_000);
    assert.equal(summary.p95Input, 300_000);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("6. 空 telemetry summarize 返回零值", async () => {
  const root = tmpRoot();
  try {
    const summary = await new DevAgentTelemetry(root).summarize();
    assert.deepEqual(summary, { calls: 0, totalPromptTokens: 0, totalCacheReadTokens: 0, totalNonCachedTokens: 0, avgInput: 0, p95Input: 0, retentionEnabled: false });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
