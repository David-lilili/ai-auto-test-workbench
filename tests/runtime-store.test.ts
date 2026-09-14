import assert from "node:assert/strict";
import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { RuntimeStore } from "../src/workbench/runtime-store.js";

let sandbox: string;

beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-store-"));
});

afterEach(async () => {
  await fs.remove(sandbox);
});

test("upsert and list proposals with filters", async () => {
  const store = new RuntimeStore(sandbox);
  await store.upsertProposal({
    proposalId: "p1", status: "pending_review", createdAt: "2026-08-31T01:00:00.000Z",
    project: "demo", env: "test", proposalType: "page_model_ingest",
    failureStage: null, reason: "r1", userRequest: null,
    reviewedAt: null, reviewedBy: null, reviewNote: null, sourceFile: "storage/proposals/pending/p1.json"
  });
  await store.upsertProposal({
    proposalId: "p2", status: "approved", createdAt: "2026-08-31T02:00:00.000Z",
    project: "demo", env: "test", proposalType: "assertion_observable_update",
    failureStage: "assert", reason: "r2", userRequest: null,
    reviewedAt: "2026-08-31T02:30:00.000Z", reviewedBy: "tester", reviewNote: "ok", sourceFile: "storage/proposals/approved/p2.json"
  });
  const all = await store.listProposals({ project: "demo" });
  assert.equal(all.length, 2);
  assert.equal(all[0].proposalId, "p2", "按创建时间倒序");
  const pending = await store.listProposals({ project: "demo", status: "pending_review" });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].proposalId, "p1");
  const counts = await store.countProposalsByStatus("demo");
  assert.deepEqual(counts, { pending_review: 1, approved: 1 });
});

test("upsert is idempotent on conflict", async () => {
  const store = new RuntimeStore(sandbox);
  const base = {
    proposalId: "p1", createdAt: "2026-08-31T01:00:00.000Z", project: "demo", env: "test",
    proposalType: "page_model_ingest", failureStage: null, reason: null, userRequest: null, sourceFile: "x"
  };
  await store.upsertProposal({ ...base, status: "pending_review", reviewedAt: null, reviewedBy: null, reviewNote: null });
  await store.upsertProposal({ ...base, status: "approved", reviewedAt: "t", reviewedBy: "u", reviewNote: "n" });
  const rows = await store.listProposals({ project: "demo" });
  assert.equal(rows.length, 1, "同 proposalId 更新而非新增");
  assert.equal(rows[0].status, "approved");
});

test("review log appends and queries by proposal", async () => {
  const store = new RuntimeStore(sandbox);
  await store.appendReviewLog({
    reviewedAt: "2026-08-31T03:00:00.000Z", proposalId: "p9", project: "demo", env: "test",
    proposalType: "page_model_ingest", action: "approve", reviewedBy: "tester",
    note: "first", previousStatus: "pending_review", newStatus: "approved"
  });
  await store.appendReviewLog({
    reviewedAt: "2026-08-31T03:01:00.000Z", proposalId: "p9", project: "demo", env: "test",
    proposalType: "page_model_ingest", action: "reject", reviewedBy: "tester2",
    note: null, previousStatus: "approved", newStatus: "rejected"
  });
  const entries = await store.listReviewLog({ proposalId: "p9" });
  assert.equal(entries.length, 2);
  assert.equal(entries[0].action, "reject", "倒序最新在前");
  assert.equal(entries[1].action, "approve");
});

test("syncProposalsFromFiles mirrors file queue into sqlite", async () => {
  const pendingDir = path.join(sandbox, "storage", "proposals", "pending");
  const approvedDir = path.join(sandbox, "storage", "proposals", "approved");
  await fs.ensureDir(pendingDir);
  await fs.ensureDir(approvedDir);
  await fs.writeJson(path.join(pendingDir, "a.json"), {
    schemaVersion: "knowledge-update-proposal.v1", proposalId: "a", status: "pending_review",
    createdAt: "2026-08-31T01:00:00.000Z", project: "demo", env: "test", proposalType: "page_model_ingest"
  });
  await fs.writeJson(path.join(pendingDir, "b.json"), {
    schemaVersion: "knowledge-update-proposal.v1", proposalId: "b", status: "pending_review",
    createdAt: "2026-08-31T01:01:00.000Z", project: "other", env: "test", proposalType: "assertion_observable_update"
  });
  await fs.writeJson(path.join(approvedDir, "c.json"), {
    schemaVersion: "knowledge-update-proposal.v1", proposalId: "c", status: "approved",
    createdAt: "2026-08-31T01:02:00.000Z", project: "demo", env: "test", proposalType: "page_model_ingest",
    reviewedAt: "2026-08-31T02:00:00.000Z", reviewedBy: "tester"
  });
  const store = new RuntimeStore(sandbox);
  const counts = await store.syncProposalsFromFiles();
  assert.deepEqual(counts, { pending: 2, approved: 1, rejected: 0 });
  assert.deepEqual(await store.countProposalsByStatus("demo"), { pending_review: 1, approved: 1 });
  const rows = await store.listProposals({ project: "other" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].proposalId, "b");
});
