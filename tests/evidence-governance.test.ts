import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "fs-extra";
import { recordKnowledgeEvidence, loadAllKnowledgeEvidence, deriveStableEvidenceId } from "../src/core/knowledge-evidence-sink.js";
import { aggregateEvidence, buildKnowledgeKey } from "../src/core/knowledge-promotion-policy.js";
import { invalidateKnowledgeEvidence, isProtectedEvidencePath, assertProtectedPathAllowed, EVIDENCE_ROOT, evidenceContentHash, EVIDENCE_STATUS_VALUES } from "../src/core/evidence-immutability-guard.js";

/**
 * Evidence Immutability Guard 定向测试（sandbox）。
 * 验证：canonical evidence 写入后不可删除/覆盖；失效只能通过状态标记；
 *      受保护路径对 delete/overwrite 拒绝；失效证据不参与聚合。
 */

function makeRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "eig-test-"));
}

function baseInput(overrides: Record<string, unknown> = {}): Parameters<typeof recordKnowledgeEvidence>[1] {
  return {
    project: "testproj",
    knowledgeType: "LOCATOR",
    pageId: "demo.test.page",
    targetId: "test.element",
    sourceType: "SELF_HEALING",
    sourceRunId: "run-123",
    observation: { locator: "[data-test=abc]" },
    confidence: "HIGH",
    observedValue: "[data-test=abc]",
    outcome: "success",
    ...overrides
  } as Parameters<typeof recordKnowledgeEvidence>[1];
}

test("EIG: invalidate marks status without touching content fields", async () => {
  const root = makeRoot();
  const first = await recordKnowledgeEvidence(root, baseInput());
  const loaded = await loadAllKnowledgeEvidence(root, "testproj");
  assert.equal(loaded.length, 1);

  const result = await invalidateKnowledgeEvidence(root, "testproj", {
    evidenceId: first.evidenceId,
    status: "INVALIDATED",
    reason: "目标元素不复存在"
  });
  assert.equal(result.ok, true);
  assert.equal(result.alreadyMarked, false);

  const after = await loadAllKnowledgeEvidence(root, "testproj");
  assert.equal(after.length, 1, "记录必须保留，不得删除");
  const entry = after[0];
  assert.equal(entry.status, "INVALIDATED");
  assert.equal(entry.statusReason, "目标元素不复存在");
  assert.ok(entry.statusAt);
  assert.equal(entry.observedValue, "[data-test=abc]", "内容字段不得被改动");
  assert.equal(entry.outcome, "success");
  assert.equal(entry.confidence, "HIGH");
  assert.equal(entry.observation.locator, "[data-test=abc]");
});

test("EIG: same-status invalidation is idempotent", async () => {
  const root = makeRoot();
  const first = await recordKnowledgeEvidence(root, baseInput());
  await invalidateKnowledgeEvidence(root, "testproj", { evidenceId: first.evidenceId, status: "REJECTED", reason: "r1" });
  const again = await invalidateKnowledgeEvidence(root, "testproj", { evidenceId: first.evidenceId, status: "REJECTED", reason: "r2" });
  assert.equal(again.alreadyMarked, true);
  const entry = (await loadAllKnowledgeEvidence(root, "testproj"))[0];
  assert.equal(entry.statusReason, "r1", "幂等命中不得改写既有状态字段");
});

test("EIG: invalidate unknown evidenceId throws — never creates", async () => {
  const root = makeRoot();
  await assert.rejects(
    () => invalidateKnowledgeEvidence(root, "testproj", { evidenceId: "ev_deadbeef00000000", status: "INVALIDATED", reason: "x" }),
    /not found/
  );
  assert.equal((await loadAllKnowledgeEvidence(root, "testproj")).length, 0);
});

test("EIG: SUPERSEDED carries supersededBy", async () => {
  const root = makeRoot();
  const old = await recordKnowledgeEvidence(root, baseInput());
  const fresh = await recordKnowledgeEvidence(root, baseInput({ observedValue: "[data-test=new]" }));
  await invalidateKnowledgeEvidence(root, "testproj", { evidenceId: old.evidenceId, status: "SUPERSEDED", reason: "locator 更新", supersededBy: fresh.evidenceId });
  const entry = (await loadAllKnowledgeEvidence(root, "testproj")).find((e) => e.evidenceId === old.evidenceId)!;
  assert.equal(entry.status, "SUPERSEDED");
  assert.equal(entry.supersededBy, fresh.evidenceId);
});

test("EIG: dedup never overwrites — same id, different content keeps existing record", async () => {
  const root = makeRoot();
  const first = await recordKnowledgeEvidence(root, baseInput());
  // 同 evidenceId（同 run/key/value/outcome）但 observation 不同 → 拒绝覆盖，返回既有条目。
  const second = await recordKnowledgeEvidence(root, baseInput({ observation: { locator: "[data-test=HACKED]" } }));
  assert.equal(second.evidenceId, first.evidenceId);
  assert.equal(second.deduplicated, true);
  const entry = (await loadAllKnowledgeEvidence(root, "testproj"))[0];
  assert.equal(entry.observation.locator, "[data-test=abc]", "既有内容必须保持，不得被覆盖");
  assert.equal((await loadAllKnowledgeEvidence(root, "testproj")).length, 1);
});

test("EIG: invalidated evidence excluded from aggregation", async () => {
  const root = makeRoot();
  await recordKnowledgeEvidence(root, baseInput());
  const other = await recordKnowledgeEvidence(root, baseInput({ targetId: "test.element.2", observedValue: "[data-test=def]" }));
  const before = aggregateEvidence(await loadAllKnowledgeEvidence(root, "testproj"));
  assert.equal([...before.values()].reduce((n, c) => n + c.successCount, 0), 2);

  await invalidateKnowledgeEvidence(root, "testproj", { evidenceId: other.evidenceId, status: "INVALIDATED", reason: "取消" });
  const after = aggregateEvidence(await loadAllKnowledgeEvidence(root, "testproj"));
  const success = [...after.values()].reduce((n, c) => n + c.successCount, 0);
  assert.equal(success, 1, "失效证据不得参与聚合");
});

test("EIG: protected path guard blocks delete/overwrite, allows read/append", () => {
  const target = `${EVIDENCE_ROOT}/demo/INTERACTION/abc.json`;
  assert.equal(isProtectedEvidencePath(target), true);
  assert.equal(isProtectedEvidencePath(`${EVIDENCE_ROOT}`), true);
  assert.equal(isProtectedEvidencePath(`${EVIDENCE_ROOT}-backup`), false);
  assert.equal(isProtectedEvidencePath("storage/page-models/demo.json"), false);

  assert.throws(() => assertProtectedPathAllowed("delete", target), /EVIDENCE_IMMUTABILITY/);
  assert.throws(() => assertProtectedPathAllowed("overwrite", target), /EVIDENCE_IMMUTABILITY/);
  assert.doesNotThrow(() => assertProtectedPathAllowed("read", target));
  assert.doesNotThrow(() => assertProtectedPathAllowed("append", target));
  assert.doesNotThrow(() => assertProtectedPathAllowed("delete", "storage/tmp/scratch.json"));
});

test("EIG: stable id derivation is deterministic and status fields do not change content hash", async () => {
  const root = makeRoot();
  const first = await recordKnowledgeEvidence(root, baseInput());
  const derived = deriveStableEvidenceId("run-123", buildKnowledgeKey("LOCATOR", "demo.test.page", "test.element", "[data-test=abc]"), "[data-test=abc]", "success");
  assert.equal(derived, first.evidenceId);

  const entry = (await loadAllKnowledgeEvidence(root, "testproj"))[0];
  const hashBefore = evidenceContentHash(entry);
  await invalidateKnowledgeEvidence(root, "testproj", { evidenceId: first.evidenceId, status: "INVALIDATED", reason: "x" });
  const entryAfter = (await loadAllKnowledgeEvidence(root, "testproj"))[0];
  assert.equal(evidenceContentHash(entryAfter), hashBefore, "状态字段不得改变内容哈希");
  assert.deepEqual(EVIDENCE_STATUS_VALUES, ["ACTIVE", "INVALIDATED", "REJECTED", "SUPERSEDED"]);
});
