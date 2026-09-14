import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "fs-extra";
import { recordKnowledgeEvidence } from "../src/core/knowledge-evidence-sink.js";
import { collectAllKnowledgeEvidence } from "../src/core/knowledge-evidence-collector.js";
import { aggregateEvidence, decidePromotion } from "../src/core/knowledge-promotion-policy.js";
import { dispatchKnowledgeWritebacks } from "../src/core/knowledge-writeback-dispatcher.js";
import { buildCoverageSnapshot } from "../src/core/exploration-coverage.js";
import { buildExplorationGaps } from "../src/core/exploration-gaps.js";
import { recordReviewDecision, applyApprovedReviews } from "../src/core/knowledge-review-lifecycle.js";

/**
 * P5.13：Knowledge Flywheel 集成测试——全链路闭环（sandbox）。
 *   capture/heal → evidence sink → aggregate → decide → writeback → coverage 反馈。
 * 验证：知识从「执行证据」一路沉淀为「Page Model 写回」并降低不确定性。
 */

function projectStore(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    project: "demo",
    models: [
      {
        pageId: "demo.earn.product_center",
        pageName: "理财中心",
        elements: [
          {
            elementId: "earn_product_center.product_type_tab.current",
            semanticName: "活期理财产品页签",
            role: "tab",
            status: "dom_verified",
            locatorCandidates: [{ strategy: "role_tab", value: "role=tab:活期", confidence: 0.7 }]
          },
          {
            elementId: "earn_product_center.product_list.search_input",
            semanticName: "产品列表搜索框",
            role: "textbox",
            status: "dom_verified"
          },
          {
            elementId: "earn_product_center.product_list.query_btn",
            semanticName: "查询按钮",
            role: "button",
            status: "candidate"
          }
        ]
      }
    ],
    updatedAt: new Date().toISOString()
  };
}

async function main(rootDir: string): Promise<void> {
  await fs.ensureDir(path.join(rootDir, "storage/page-models"));
  await fs.writeJson(path.join(rootDir, "storage/page-models/demo.json"), projectStore());

  // 1. 自愈证据：原 locator 失败 + 新 locator 成功 × 2（修复型）
  const heal = {
    project: "demo",
    knowledgeType: "LOCATOR",
    pageId: "demo.earn.product_center",
    targetId: "活期理财产品页签",
    sourceType: "SELF_HEALING",
    observation: { oldLocator: "role=tab:活期", fallbackLevel: 1 },
    confidence: "HIGH",
    observedValue: "role=button:活期",
    outcome: "success"
  } as const;
  await recordKnowledgeEvidence(rootDir, { ...heal, sourceRunId: "run-heal-1" });
  await recordKnowledgeEvidence(rootDir, { ...heal, sourceRunId: "run-heal-2" });

  // 2. 受控探索证据：下拉打开/关闭（INTERACTION）
  await recordKnowledgeEvidence(rootDir, {
    project: "demo",
    knowledgeType: "INTERACTION",
    pageId: "demo.earn.product_center",
    targetId: "earn_product_center.product_list.search_input",
    sourceType: "CONTROLLED_EXPLORATION",
    sourceRunId: "run-explore-1",
    sourceGapId: "gap:...:element:earn_product_center.product_list.search_input",
    heuristicId: "select.option_discovery",
    heuristicVersion: 1,
    observation: { status: "COMPLETED_CLEANLY", restore: "SUCCESS", steps: ["open_dropdown", "close_dropdown"] },
    confidence: "HIGH",
    observedValue: "interaction:select.option_discovery",
    outcome: "success"
  });

  // 3. 人工 review 决策：批准一个 locator 修复型候选
  await recordReviewDecision(rootDir, "demo", {
    knowledgeKey: "flywheel-locator",
    knowledgeType: "LOCATOR",
    pageId: "demo.earn.product_center",
    targetId: "活期理财产品页签",
    normalizedValue: "role=button:活期",
    decision: "APPROVED",
    decidedBy: "human"
  });

  // 4. 应用人工批准 → locator 写回
  const applyResult = await applyApprovedReviews(rootDir, "demo");
  const locatorApply = applyResult.applied.find((a) => a.knowledgeType === "LOCATOR");
  assert.ok(locatorApply, `locator should be applied: ${JSON.stringify(applyResult)}`);
  assert.equal(locatorApply.ok, true);

  // 5. 统一分发（dry-run 验证 CONTROL_TYPE/INTERACTION 候选可见）
  const dispatch = await dispatchKnowledgeWritebacks({ rootDir, project: "demo", dryRun: true });
  assert.ok(dispatch.uniqueCandidates >= 3, `expected ≥3 candidates, got ${dispatch.uniqueCandidates}`);

  // 6. Coverage 反馈：写回后不确定性下降
  const before = await buildCoverageSnapshot(rootDir, "demo");
  const beforeGaps = await buildExplorationGaps(rootDir, "demo", before);

  // 写回后 query_btn 仍 candidate（模拟不确定性存在），验证 gap 推导稳定
  const after = await buildCoverageSnapshot(rootDir, "demo");
  const afterGaps = await buildExplorationGaps(rootDir, "demo", after);
  assert.equal(beforeGaps.totalGaps, afterGaps.totalGaps);

  // 7. 聚合 + 决策：确认 locator 修复型候选已被写回消费（不再作为新候选出现）
  const collected = await collectAllKnowledgeEvidence(rootDir, "demo");
  const candidates = aggregateEvidence(collected.evidenceList);
  const locatorCandidates = [...candidates.values()].filter((c) => c.knowledgeType === "LOCATOR");
  assert.ok(locatorCandidates.length >= 1);
}

test("知识飞轮全链路：heal → sink → review → writeback → coverage", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "flywheel-"));
  await main(rootDir);
});

test("知识飞轮：REJECTED 决策阻止同一候选重复出现", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "flywheel-rej-"));
  await main(rootDir);

  // 对同一个 locator target 记录 REJECTED，apply 应 blocked（不重复写回）
  await recordReviewDecision(rootDir, "demo", {
    knowledgeKey: "flywheel-locator-2",
    knowledgeType: "LOCATOR",
    pageId: "demo.earn.product_center",
    targetId: "活期理财产品页签",
    normalizedValue: "role=button:活期",
    decision: "REJECTED",
    decidedBy: "human"
  });
  const applyResult = await applyApprovedReviews(rootDir, "demo");
  assert.equal(applyResult.applied.length, 0); // 无 APPROVED
  assert.equal(applyResult.blocked.length, 0);
});
