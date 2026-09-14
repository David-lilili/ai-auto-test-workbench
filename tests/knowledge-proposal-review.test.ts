import assert from "node:assert/strict";
import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { listKnowledgeProposals, readKnowledgeProposalDetail, reviewKnowledgeProposal } from "../src/workbench/knowledge-proposal-review.js";

let sandbox: string;

beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "proposal-review-"));
});

afterEach(async () => {
  await fs.remove(sandbox);
});

async function writeProposal(proposalId: string, overrides: Record<string, unknown> = {}): Promise<void> {
  const dir = path.join(sandbox, "storage", "proposals", "pending");
  await fs.ensureDir(dir);
  await fs.writeJson(path.join(dir, `${proposalId}.json`), {
    schemaVersion: "knowledge-update-proposal.v1",
    proposalId,
    status: "pending_review",
    createdAt: "2026-08-31T00:00:00.000Z",
    project: "demo",
    env: "test",
    proposalType: "assertion_observable_update",
    writeBackPolicy: "proposal_only_no_auto_store_write",
    reason: "unit test reason",
    ...overrides
  });
}

test("lists pending proposals with project filter and type distribution", async () => {
  await writeProposal("p-one");
  await writeProposal("p-two", { project: "other-project" });
  await writeProposal("p-three", { proposalType: "element_locator_update" });
  const response = await listKnowledgeProposals(sandbox, { project: "demo", scope: "pending" });
  assert.equal(response.total, 2);
  assert.deepEqual(response.typeDistribution, { assertion_observable_update: 1, element_locator_update: 1 });
  assert.ok(response.proposals.every((item) => item.project === "demo"));
});

test("scope=all and unconfigured project degrade to empty lists", async () => {
  const empty = await listKnowledgeProposals(sandbox, { project: "not-configured", scope: "all" });
  assert.equal(empty.total, 0);
  assert.deepEqual(empty.proposals, []);
});

test("approve moves proposal to approved dir, stamps review fields and appends audit log", async () => {
  await writeProposal("p-approve");
  const result = await reviewKnowledgeProposal(sandbox, { proposalId: "p-approve", action: "approve", reviewedBy: "tester", note: "ok" });
  assert.equal(result.newStatus, "approved");
  assert.equal(result.writeBack.applied, false);
  assert.ok(result.movedTo.includes("approved"));
  assert.ok(!(await fs.pathExists(path.join(sandbox, "storage", "proposals", "pending", "p-approve.json"))));
  const approved = await fs.readJson(path.join(sandbox, "storage", "proposals", "approved", "p-approve.json"));
  assert.equal(approved.status, "approved");
  assert.equal(approved.reviewedBy, "tester");
  assert.equal(approved.reviewNote, "ok");
  const log = await fs.readJson(path.join(sandbox, "storage", "proposals", "review-log.json"));
  assert.equal(log.totalDecisions, 1);
  assert.equal(log.entries[0].proposalId, "p-approve");
  assert.equal(log.entries[0].action, "approve");
  const detail = await readKnowledgeProposalDetail(sandbox, "p-approve");
  assert.equal(detail?.proposal.status, "approved");
  assert.equal((detail?.reviewLog as Record<string, unknown>)?.action, "approve");
});

test("reject moves proposal to rejected dir and keeps audit trail", async () => {
  await writeProposal("p-reject");
  const result = await reviewKnowledgeProposal(sandbox, { proposalId: "p-reject", action: "reject", note: "not applicable" });
  assert.equal(result.newStatus, "rejected");
  const rejected = await fs.readJson(path.join(sandbox, "storage", "proposals", "rejected", "p-reject.json"));
  assert.equal(rejected.status, "rejected");
  const log = await fs.readJson(path.join(sandbox, "storage", "proposals", "review-log.json"));
  assert.equal(log.entries[0].action, "reject");
  assert.equal(log.entries[0].note, "not applicable");
});

test("reviewing an already-reviewed proposal fails with explicit error", async () => {
  await writeProposal("p-dup");
  await reviewKnowledgeProposal(sandbox, { proposalId: "p-dup", action: "approve" });
  await assert.rejects(
    () => reviewKnowledgeProposal(sandbox, { proposalId: "p-dup", action: "approve" }),
    /Pending proposal not found/
  );
});

test("proposal ids with path separators are rejected", async () => {
  await assert.rejects(
    () => reviewKnowledgeProposal(sandbox, { proposalId: "../evil", action: "approve" }),
    /Pending proposal not found/
  );
});
