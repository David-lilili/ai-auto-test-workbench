/**
 * LLM 调用幂等账本测试（agent-invocation-ledger）。
 * 覆盖：key 稳定 / lookup 命中复用 / 不存 prompt / 容量上限 / 持久化。
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { InvocationLedger, llmInvocationKeyString } from "../src/core/agent-invocation-ledger.js";
import type { LlmInvocationKey } from "../src/core/agent-invocation-ledger.js";

function key(over: Partial<LlmInvocationKey> = {}): LlmInvocationKey {
  return {
    taskId: "T-1",
    stepId: "step-3",
    repoHead: "abc123",
    fileDiffHash: "diff-hash-1",
    errorSignature: "sig-1",
    contextPurpose: "fix_typecheck",
    ...over
  };
}

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ledger-"));
}

test("1. key 字符串：相同 key 同 hash；任一字段不同则不同", () => {
  assert.equal(llmInvocationKeyString(key()), llmInvocationKeyString(key()));
  assert.notEqual(llmInvocationKeyString(key()), llmInvocationKeyString(key({ stepId: "step-4" })));
  assert.notEqual(llmInvocationKeyString(key()), llmInvocationKeyString(key({ repoHead: "def456" })));
  assert.notEqual(llmInvocationKeyString(key()), llmInvocationKeyString(key({ errorSignature: "sig-2" })));
  assert.notEqual(llmInvocationKeyString(key()), llmInvocationKeyString(key({ contextPurpose: "other" })));
  assert.notEqual(llmInvocationKeyString(key()), llmInvocationKeyString(key({ fileDiffHash: "diff-2" })));
});

test("2. lookup 未命中返回 null；record 后命中返回 result reference", async () => {
  const root = tmpRoot();
  try {
    const ledger = new InvocationLedger(root);
    assert.equal(await ledger.lookup(key()), null);
    await ledger.record(key(), "artifacts/reasoning/t-1-step-3.md", 120_000);
    const hit = await ledger.lookup(key());
    assert.ok(hit);
    assert.equal(hit!.resultReference, "artifacts/reasoning/t-1-step-3.md");
    assert.equal(hit!.inputTokensSaved, 120_000);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("3. 持久化：新实例读同一 task 的账本", async () => {
  const root = tmpRoot();
  try {
    await new InvocationLedger(root).record(key(), "ref-a");
    const hit = await new InvocationLedger(root).lookup(key());
    assert.ok(hit);
    assert.equal(hit!.resultReference, "ref-a");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("4. 相同 key 重复 record 覆盖旧条目，不重复", async () => {
  const root = tmpRoot();
  try {
    const ledger = new InvocationLedger(root);
    await ledger.record(key(), "ref-1");
    await ledger.record(key(), "ref-2");
    assert.equal(await ledger.size("T-1"), 1);
    assert.equal((await ledger.lookup(key()))!.resultReference, "ref-2");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("5. 容量上限：超出 MAX_ENTRIES 丢弃最旧", async () => {
  const root = tmpRoot();
  try {
    const ledger = new InvocationLedger(root);
    for (let i = 0; i < 505; i += 1) {
      await ledger.record(key({ stepId: `step-${i}` }), `ref-${i}`);
    }
    assert.equal(await ledger.size("T-1"), 500);
    // 最旧的 step-0 ~ step-4 应被丢弃。
    assert.equal(await ledger.lookup(key({ stepId: "step-0" })), null);
    assert.ok(await ledger.lookup(key({ stepId: "step-504" })));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("6. 账本文件不含 prompt 内容（仅 hash + reference）", async () => {
  const root = tmpRoot();
  try {
    const ledger = new InvocationLedger(root);
    await ledger.record(key(), "ref-safe");
    const text = fs.readFileSync(path.join(root, ".runtime", "agent-state", "ledger", "T-1.json"), "utf8");
    assert.ok(!text.includes("prompt"));
    assert.ok(text.includes("keyHash"));
    assert.ok(text.includes("resultReference"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
