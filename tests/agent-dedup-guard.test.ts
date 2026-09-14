/**
 * Development Agent 去重守卫测试（tool-error-signature + agent-dedup-guard）。
 * 覆盖：errorSignature 稳定性 / reasoning <= 2 / deterministic command <= 2 / 状态变化重置。
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildErrorSignature,
  normalizeStderr,
  computeRepoState,
  sha256Hex
} from "../src/core/tool-error-signature.js";
import {
  ReasoningDedupGuard,
  DeterministicCommandGuard,
  MAX_REASONING_PER_SIGNATURE,
  MAX_EXECUTIONS_PER_COMMAND_STATE,
  DUPLICATE_REASONING_BLOCKED
} from "../src/core/agent-dedup-guard.js";

function context(over: Partial<Parameters<typeof buildErrorSignature>[0]> = {}) {
  return {
    command: "npx tsx scripts/foo.ts",
    exitCode: 1,
    stderr: "Error: boom",
    repoHead: "abc123def456",
    diffHash: sha256Hex("clean"),
    ...over
  };
}

test("1. errorSignature：相同输入 → 相同签名；任一字段不同 → 不同签名", () => {
  const base = context();
  assert.equal(buildErrorSignature(base), buildErrorSignature(base));
  assert.notEqual(buildErrorSignature(base), buildErrorSignature(context({ command: "npx tsx scripts/bar.ts" })));
  assert.notEqual(buildErrorSignature(base), buildErrorSignature(context({ exitCode: 2 })));
  assert.notEqual(buildErrorSignature(base), buildErrorSignature(context({ stderr: "Error: boom2" })));
  assert.notEqual(buildErrorSignature(base), buildErrorSignature(context({ repoHead: "zzz" })));
  assert.notEqual(buildErrorSignature(base), buildErrorSignature(context({ diffHash: "dirty" })));
});

test("2. stderr 归一化：时间戳 / ANSI / 栈行号差异不改变签名", () => {
  const withNoise = context({
    stderr:
      "\x1b[31mError: boom\x1b[0m\n" +
      "2026-09-05T08:55:23.000Z [error] step failed\n" +
      "14:47:37 retry count=3\n" +
      "    at run (file.ts:12:3)\n" +
      "    at main (index.ts:99:7)\n" +
      "allocated 0x7f9a2c1b4d memory"
  });
  const withClean = context({
    stderr:
      "Error: boom\n" +
      "<ts> [error] step failed\n" +
      "<ts> retry count=3\n" +
      "    at run (file.ts)\n" +
      "    at main (index.ts)\n" +
      "allocated <hex> memory"
  });
  assert.equal(buildErrorSignature(withNoise), buildErrorSignature(withClean));
});

test("3. normalizeStderr：去除空白行与尾部截断", () => {
  const normalized = normalizeStderr("  a  b  \n\n\n   c  \n");
  assert.equal(normalized, "a b\nc");
  const long = normalizeStderr(`${"x".repeat(9000)}\n`);
  assert.ok(long.length <= 8000 + 1 + "<stderr-truncated>".length);
  assert.ok(long.endsWith("<stderr-truncated>"));
});

test("4. computeRepoState：本仓库返回 HEAD 与 64 位 hex diffHash", async () => {
  const state = await computeRepoState(process.cwd());
  assert.match(state.repoHead, /^[0-9a-f]{40}$/);
  assert.match(state.diffHash, /^[0-9a-f]{64}$/);
});

test("5. computeRepoState：非 git 目录返回空指纹", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sig-"));
  try {
    const state = await computeRepoState(tmpDir);
    assert.equal(state.repoHead, "");
    assert.equal(state.diffHash, "");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("6. ReasoningDedupGuard：相同签名最多 2 次 reasoning，第 3 次输出 DUPLICATE_REASONING_BLOCKED", () => {
  const guard = new ReasoningDedupGuard();
  const signature = buildErrorSignature(context());

  const first = guard.tryReason(signature);
  assert.equal(first.allowed, true);
  assert.equal(first.reasoningCount, 1);
  assert.equal(first.blockedOutput, null);

  const second = guard.tryReason(signature);
  assert.equal(second.allowed, true);
  assert.equal(second.reasoningCount, 2);
  assert.equal(second.blockedOutput, null);

  const third = guard.tryReason(signature);
  assert.equal(third.allowed, false);
  assert.equal(third.reasoningCount, MAX_REASONING_PER_SIGNATURE + 1);
  assert.equal(third.blockedOutput, DUPLICATE_REASONING_BLOCKED);

  const fourth = guard.tryReason(signature);
  assert.equal(fourth.allowed, false);
  assert.equal(fourth.blockedOutput, DUPLICATE_REASONING_BLOCKED);

  // 不同签名互不影响。
  const other = guard.tryReason(buildErrorSignature(context({ command: "npx tsx scripts/other.ts" })));
  assert.equal(other.allowed, true);
  assert.equal(other.reasoningCount, 1);
});

test("7. DeterministicCommandGuard：同命令 + 无状态变化最多执行 2 次", () => {
  const guard = new DeterministicCommandGuard();
  const fingerprint = `${"head1"}\n${sha256Hex("clean")}`;

  const first = guard.tryExecute("npm run typecheck", fingerprint);
  assert.equal(first.allowed, true);
  assert.equal(first.executions, 1);

  const second = guard.tryExecute("npm run typecheck", fingerprint);
  assert.equal(second.allowed, true);
  assert.equal(second.executions, 2);

  const third = guard.tryExecute("npm run typecheck", fingerprint);
  assert.equal(third.allowed, false);
  assert.equal(third.executions, MAX_EXECUTIONS_PER_COMMAND_STATE);
});

test("8. DeterministicCommandGuard：状态变化后计数重置，允许再次执行", () => {
  const guard = new DeterministicCommandGuard();
  const before = "head1\n" + sha256Hex("clean");
  const after = "head1\n" + sha256Hex("dirty");

  guard.tryExecute("npm run typecheck", before);
  guard.tryExecute("npm run typecheck", before);
  const blocked = guard.tryExecute("npm run typecheck", before);
  assert.equal(blocked.allowed, false);

  const reset = guard.tryExecute("npm run typecheck", after);
  assert.equal(reset.allowed, true);
  assert.equal(reset.executions, 1);

  // 状态回退到旧指纹同样视为新情形。
  const again = guard.tryExecute("npm run typecheck", before);
  assert.equal(again.allowed, true);
  assert.equal(again.executions, 1);
});

test("9. DeterministicCommandGuard：不同命令互不影响", () => {
  const guard = new DeterministicCommandGuard();
  const fingerprint = "head\n" + sha256Hex("clean");
  guard.tryExecute("cmd-a", fingerprint);
  guard.tryExecute("cmd-a", fingerprint);
  const other = guard.tryExecute("cmd-b", fingerprint);
  assert.equal(other.allowed, true);
  assert.equal(other.executions, 1);
});
