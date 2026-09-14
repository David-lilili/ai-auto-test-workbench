import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "fs-extra";
import { analyzeAssertionRootCauses } from "../src/core/assertion-root-cause.js";
import { buildReviewProjection, suggestAction } from "../src/core/review-candidate-projection.js";
import type { KnowledgeCandidate, PromotionDecision } from "../src/core/knowledge-promotion-policy.js";

/**
 * P5.9 / P5.8 回归：assertion 根因聚类 + review candidate 投影。
 */

async function seedExecution(rootDir: string, steps: Array<Record<string, unknown>>): Promise<void> {
  await fs.ensureDir(path.join(rootDir, "storage/execution"));
  await fs.writeJson(path.join(rootDir, "storage/execution/demo.json"), {
    steps,
    runs: [{ run_id: "run-001", test_case_id: "demo-case-001" }]
  });
}

function assertStep(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    step_id: "s1",
    run_id: "run-001",
    dsl_step_id: "assert-user_assertion_1",
    action_type: "assert_message",
    status: "failed",
    error_message: "Expected element to be disabled, but no locator matched disabled state.",
    assertion_summary: { type: "element_disabled", target: "确定按钮置灰", diagnostics: { rootCause: "element_enabled" } },
    ...overrides
  };
}

test("analyzeAssertionRootCauses 聚类失败断言并按根因计数", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "arc-"));
  await seedExecution(rootDir, [
    assertStep({}),
    assertStep({ error_message: "None of expected texts became visible: 时间", assertion_summary: { type: "textVisibleAny", target: "列表时间列", diagnostics: {} } }),
    assertStep({ error_message: "Row scoped action was not found.", assertion_summary: { type: "element_enabled", target: "产品行", diagnostics: {} } }),
    assertStep({ step_id: "s-pass", status: "passed", assertion_summary: { type: "textVisibleAny", target: "ok", diagnostics: {} } })
  ]);
  const report = analyzeAssertionRootCauses(rootDir, "demo");
  assert.equal(report.totalFailures, 3);
  assert.equal(report.byRootCause.ELEMENT_STATE_MISMATCH, 1);
  assert.equal(report.byRootCause.EXPECTED_TEXT_NOT_VISIBLE, 1);
  assert.equal(report.byRootCause.ROW_SCOPED_TARGET_MISSING, 1);
  assert.equal(report.items[0].caseId, "demo-case-001");
  assert.ok(report.items.every((item) => item.recommendation.length > 0));
});

test("analyzeAssertionRootCauses 空 store 返回全零", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "arc-empty-"));
  await seedExecution(rootDir, []);
  const report = analyzeAssertionRootCauses(rootDir, "demo");
  assert.equal(report.totalFailures, 0);
  assert.equal(report.byRootCause.OTHER, 0);
});

test("suggestAction 按 decision 给出建议", () => {
  const candidate = {
    knowledgeKey: "k",
    knowledgeType: "LOCATOR",
    pageId: "p",
    targetId: "t",
    normalizedValue: "v",
    evidence: [],
    successCount: 0,
    failureCount: 1,
    contradictionCount: 0,
    firstObservedAt: "2026-01-01T00:00:00Z",
    lastObservedAt: "2026-01-01T00:00:00Z",
    pageSignatures: [],
    freshness: "FRESH",
    evidenceConfidence: "LOW"
  } as unknown as KnowledgeCandidate;

  const conflict = { decision: "CONFLICT", targetStatus: "x", reasons: [], evidenceIds: [], missingEvidence: [], contradictions: ["c"], policyId: "p", policyVersion: 1 } as PromotionDecision;
  const reject = { ...conflict, decision: "REJECT", contradictions: [] } as PromotionDecision;
  const review = { ...conflict, decision: "REVIEW", contradictions: [], missingEvidence: ["需要更多证据"] } as PromotionDecision;
  const reviewOk = { ...conflict, decision: "REVIEW", contradictions: [], missingEvidence: [] } as PromotionDecision;

  assert.equal(suggestAction(candidate, conflict), "needs_conflict_resolution");
  assert.equal(suggestAction(candidate, reject), "reject_candidate");
  assert.equal(suggestAction(candidate, review), "keep_pending_collect_more");
  assert.equal(suggestAction(candidate, reviewOk), "approve_candidate");
});

test("buildReviewProjection 只投影 REVIEW 候选且不写回", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "rp-"));
  // 无任何数据源 → 空投影不抛错
  await fs.ensureDir(path.join(rootDir, "storage"));
  const projection = await buildReviewProjection(rootDir, "demo");
  assert.ok(Array.isArray(projection.items));
  assert.equal(projection.totalCandidates, 0);
  // 确认没有创建写回文件
  assert.equal(fs.pathExistsSync(path.join(rootDir, "storage/page-models/demo.json")), false);
});
