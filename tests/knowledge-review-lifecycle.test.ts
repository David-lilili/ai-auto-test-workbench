import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "fs-extra";
import {
  recordReviewDecision,
  loadReviewDecisions,
  applyApprovedReviews
} from "../src/core/knowledge-review-lifecycle.js";
import { recordKnowledgeEvidence } from "../src/core/knowledge-evidence-sink.js";

/**
 * P5.10-P5.11：candidate lifecycle 回归。
 * 核心保证：
 *   - 决策幂等（同 knowledgeKey 覆盖）；
 *   - 人工 APPROVED 是 REVIEW 候选推进为写回的唯一通道；
 *   - ASSERTION/SECURITY 人工 APPROVED 也绝不写回；
 *   - LOCATOR 人工 APPROVED 走修复型配对；
 *   - 已应用的 APPROVED 从队列移除，REJECTED 保留。
 */

async function seedSink(rootDir: string, project: string, entries: Array<Parameters<typeof recordKnowledgeEvidence>[1]>): Promise<void> {
  for (const entry of entries) {
    await recordKnowledgeEvidence(rootDir, entry);
  }
}

function sinkEntry(overrides: Partial<Parameters<typeof recordKnowledgeEvidence>[1]>): Parameters<typeof recordKnowledgeEvidence>[1] {
  return {
    project: "demo",
    knowledgeType: "LOCATOR",
    pageId: "demo.earn.product_center",
    targetId: "活期理财产品页签",
    sourceType: "SELF_HEALING",
    sourceRunId: "run-1",
    observation: { oldLocator: "role=tab:活期", fallbackLevel: 1 },
    confidence: "HIGH",
    observedValue: "role=button:活期",
    outcome: "success",
    ...overrides
  };
}

test("recordReviewDecision 幂等：同 knowledgeKey 覆盖旧决策", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "lifecycle-"));
  await recordReviewDecision(rootDir, "demo", {
    knowledgeKey: "k1", knowledgeType: "LOCATOR", pageId: "p", targetId: "t", normalizedValue: "v", decision: "APPROVED", decidedBy: "human"
  });
  await recordReviewDecision(rootDir, "demo", {
    knowledgeKey: "k1", knowledgeType: "LOCATOR", pageId: "p", targetId: "t", normalizedValue: "v", decision: "REJECTED", decidedBy: "human", note: "覆盖"
  });
  const decisions = await loadReviewDecisions(rootDir, "demo");
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].decision, "REJECTED");
  assert.equal(decisions[0].note, "覆盖");
});

test("ASSERTION 人工 APPROVED 也绝不写回", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "lifecycle-sec-"));
  await recordReviewDecision(rootDir, "demo", {
    knowledgeKey: "k-sec", knowledgeType: "ASSERTION", pageId: "p", targetId: "t", normalizedValue: "v", decision: "APPROVED", decidedBy: "human"
  });
  const result = await applyApprovedReviews(rootDir, "demo");
  assert.equal(result.applied.length, 0);
  assert.ok(result.blocked.some((b) => b.knowledgeType === "ASSERTION"));
  assert.match(result.blocked[0].reason, /不参与自动 writeback/);
});

test("LOCATOR 人工 APPROVED 走修复型配对写回（需页面已建模）", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "lifecycle-loc-"));
  // 页面模型：目标元素存在
  await fs.ensureDir(path.join(rootDir, "storage/page-models"));
  await fs.writeJson(path.join(rootDir, "storage/page-models/demo.json"), {
    models: [{
      pageId: "demo.earn.product_center",
      elements: [{ elementId: "earn_product_center.product_type_tab.current", semanticName: "活期理财产品页签", role: "tab", locatorCandidates: [{ strategy: "role_tab", value: "role=tab:活期" }] }]
    }]
  });
  // 两条 SELF_HEALING 成功证据（≥2 修复型配对）
  await seedSink(rootDir, "demo", [
    sinkEntry({ sourceRunId: "run-a" }),
    sinkEntry({ sourceRunId: "run-b" })
  ]);
  // 人工 APPROVED 该 target 的 locator 候选
  await recordReviewDecision(rootDir, "demo", {
    knowledgeKey: "k-loc", knowledgeType: "LOCATOR", pageId: "demo.earn.product_center", targetId: "活期理财产品页签", normalizedValue: "role=button:活期", decision: "APPROVED", decidedBy: "human"
  });
  const result = await applyApprovedReviews(rootDir, "demo");
  const loc = result.applied.find((a) => a.knowledgeType === "LOCATOR");
  assert.ok(loc, `expected locator applied, got ${JSON.stringify(result)}`);
  assert.equal(loc.action, "appended_locator_candidate");
  assert.equal(loc.ok, true);
  // 已应用 → 从队列移除
  const remaining = await loadReviewDecisions(rootDir, "demo");
  assert.equal(remaining.filter((d) => d.knowledgeKey === "k-loc").length, 0);
});

test("LOCATOR 人工 APPROVED 但元素未建模 → blocked 不写回", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "lifecycle-nomodel-"));
  await seedSink(rootDir, "demo", [sinkEntry({}), sinkEntry({})]);
  await recordReviewDecision(rootDir, "demo", {
    knowledgeKey: "k-loc2", knowledgeType: "LOCATOR", pageId: "demo.earn.product_center", targetId: "不存在的目标", normalizedValue: "role=button:x", decision: "APPROVED", decidedBy: "human"
  });
  const result = await applyApprovedReviews(rootDir, "demo");
  assert.ok(result.blocked.some((b) => b.knowledgeType === "LOCATOR"));
  assert.equal(result.applied.length, 0);
});
