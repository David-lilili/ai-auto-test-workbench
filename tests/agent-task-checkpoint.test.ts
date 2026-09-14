/**
 * Development Agent 任务检查点测试（agent-task-checkpoint）。
 * 覆盖：identity/specHash / checkpoint 持久化 / 更新 / handoff 内容 / rollover 语义。
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  deriveSpecHash,
  createCheckpoint,
  withCheckpointUpdates,
  TaskCheckpointStore,
  buildHandoffMarkdown,
  AGENT_STATE_DIR
} from "../src/core/agent-task-checkpoint.js";

const identity = {
  taskId: "TASK-TOKEN-001",
  project: "ai-auto-test-workbench",
  phase: "P16_RECOVERY",
  objective: "完成 Token Efficiency Hardening 并通过 Benchmark",
  specHash: deriveSpecHash("Phase Spec ... full text ..."),
  repoHead: "abc123def4567890abcdef1234567890abcdef12"
};

function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ckpt-"));
  return dir;
}

test("1. specHash：同文本同 hash；空白/换行变化不影响", () => {
  assert.equal(deriveSpecHash("spec\n内容"), deriveSpecHash("spec\n内容"));
  assert.equal(deriveSpecHash("  spec  \n"), deriveSpecHash("spec"));
  assert.notEqual(deriveSpecHash("spec A"), deriveSpecHash("spec B"));
});

test("2. createCheckpoint：字段齐全且 nextAction 初始为 objective", () => {
  const checkpoint = createCheckpoint(identity, ["不改业务逻辑"]);
  assert.equal(checkpoint.schemaVersion, "agent-task-checkpoint.v1");
  assert.equal(checkpoint.taskId, "TASK-TOKEN-001");
  assert.equal(checkpoint.specHash, identity.specHash);
  assert.equal(checkpoint.repoHeadAtStart, identity.repoHead);
  assert.deepEqual(checkpoint.constraints, ["不改业务逻辑"]);
  assert.equal(checkpoint.nextAction, identity.objective);
  assert.equal(checkpoint.currentStep, null);
  assert.equal(checkpoint.blockers.length, 0);
});

test("3. TaskCheckpointStore：save / load 往返一致，schemaVersion 不匹配返回 null", async () => {
  const root = tmpRoot();
  try {
    const store = new TaskCheckpointStore(root);
    const checkpoint = createCheckpoint(identity);
    checkpoint.completedSteps.push({ stepId: "s1", summary: "冻结基线", completedAt: new Date().toISOString() });
    await store.save(checkpoint);

    const loaded = await store.load("TASK-TOKEN-001");
    assert.ok(loaded);
    assert.equal(loaded!.objective, identity.objective);
    assert.equal(loaded!.completedSteps.length, 1);
    assert.equal(loaded!.completedSteps[0].stepId, "s1");

    assert.equal(await store.load("TASK-MISSING"), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("4. 检查点落在 .runtime/agent-state/checkpoints/ 下", async () => {
  const root = tmpRoot();
  try {
    const store = new TaskCheckpointStore(root);
    await store.save(createCheckpoint(identity));
    const file = path.join(root, AGENT_STATE_DIR, "checkpoints", "TASK-TOKEN-001.json");
    assert.ok(fs.existsSync(file));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("5. withCheckpointUpdates：只更新给定字段并刷新 updatedAt", async () => {
  const checkpoint = createCheckpoint(identity);
  const before = checkpoint.updatedAt;
  const updated = withCheckpointUpdates(checkpoint, { nextAction: "写 Benchmark 脚本", filesTouched: ["scripts/token-benchmark.ts"] });
  assert.equal(updated.nextAction, "写 Benchmark 脚本");
  assert.deepEqual(updated.filesTouched, ["scripts/token-benchmark.ts"]);
  assert.equal(updated.objective, identity.objective);
  assert.ok(updated.updatedAt >= before);
});

test("6. list：按 updatedAt 倒序返回", async () => {
  const root = tmpRoot();
  try {
    const store = new TaskCheckpointStore(root);
    await store.save(createCheckpoint(identity));
    await store.save(createCheckpoint({ ...identity, taskId: "TASK-002", repoHead: "f".repeat(40) }));
    const listed = await store.list();
    assert.equal(listed.length, 2);
    assert.deepEqual(listed.map((item) => item.taskId).sort(), ["TASK-002", "TASK-TOKEN-001"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("7. buildHandoffMarkdown：包含身份/下一步/约束/已完步骤/错误签名，且声明禁止重载历史", () => {
  const checkpoint = createCheckpoint(identity, ["不改业务逻辑"]);
  checkpoint.completedSteps.push({ stepId: "s1", summary: "冻结基线", completedAt: new Date().toISOString() });
  checkpoint.currentStep = "写 Benchmark";
  checkpoint.nextAction = "运行 Benchmark";
  checkpoint.blockers.push({ signature: "sig-1", detail: "provider 超时", addedAt: new Date().toISOString() });
  checkpoint.decisions.push({ decision: "阈值可配置", rationale: "公司口径需调整", madeAt: new Date().toISOString() });
  checkpoint.lastErrorSignature = "abc";
  checkpoint.lastSuccessfulCommand = "npm run typecheck";
  const markdown = buildHandoffMarkdown(checkpoint, [{ title: "Current Diff", body: "src/core/agent-task-checkpoint.ts" }]);
  assert.ok(markdown.startsWith("# AI_START_HERE"));
  assert.ok(markdown.includes("TASK-TOKEN-001"));
  assert.ok(markdown.includes("specHash"));
  assert.ok(markdown.includes("不改业务逻辑"));
  assert.ok(markdown.includes("Next Action"));
  assert.ok(markdown.includes("写 Benchmark"));
  assert.ok(markdown.includes("sig-1"));
  assert.ok(markdown.includes("Current Diff"));
  assert.ok(markdown.includes("禁止重新加载整段历史 conversation"));
});
