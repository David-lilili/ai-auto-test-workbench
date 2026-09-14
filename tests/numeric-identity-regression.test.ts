import assert from "node:assert/strict";
import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { applyPageModelWriteBack } from "../src/workbench/page-model-writeback.js";

/**
 * Numeric Semantic Identity Regression。
 *
 * 验证 normalizeSemanticIdentity 只把「动态行情数值」归一化，
 * 绝不把「业务数字 token」（步骤号/等级/天数）错误合并：
 * 1. 动态价格（BTC 79,588.00 → 80,123.00）→ SAME semantic identity
 * 2. 步骤 1 / 步骤 2 → MUST NOT MERGE
 * 3. 等级 1 / 等级 2 → MUST NOT MERGE
 * 4. 30 天 / 90 天 → MUST NOT MERGE
 * 5. 24h 涨幅榜 / 24h 跌幅榜 → 保持不同语义
 */

const PAGE_ID = "demo.market.modeling_candidate";
const PROJECT = "demo";

let sandbox: string;

beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "numeric-identity-regression-"));
});

afterEach(async () => {
  await fs.remove(sandbox);
});

function proposal(runId: string, elements: Array<{ semanticName: string; role: string }>): Record<string, unknown> {
  return {
    proposalId: `p-${runId}`,
    proposalType: "page_model_ingest",
    captureIngest: {
      runId,
      pageModel: {
        pageId: PAGE_ID,
        pageName: "行情",
        project: PROJECT,
        platform: "web",
        locale: "zh-hans",
        module: "market",
        action: "open",
        url: "https://example.com/zh-hans/market",
        title: "行情"
      },
      elements: elements.map((e) => ({ semanticName: e.semanticName, role: e.role, locatorCandidates: [], confidence: 0.5 })),
      assertionModels: [],
      identityVerdict: { verdict: "SAME_PAGE", candidatePageIds: [PAGE_ID], score: 0.9 }
    }
  };
}

async function applyOnce(runId: string, elements: Array<{ semanticName: string; role: string }>): Promise<void> {
  await applyPageModelWriteBack(sandbox, PROJECT, proposal(runId, elements), { reviewedBy: "numeric-identity-regression-test" });
}

async function elementCount(): Promise<number> {
  const storePath = path.join(sandbox, "storage", "page-models", `${PROJECT}.json`);
  if (!(await fs.pathExists(storePath))) return 0;
  const store = await fs.readJson(storePath) as { models: Array<{ pageId: string; elements: unknown[] }> };
  return store.models.find((m) => m.pageId === PAGE_ID)?.elements.length ?? 0;
}

test("1: dynamic prices (BTC 79,588.00 / 80,123.00) share one semantic identity", async () => {
  await applyOnce("run-1", [{ semanticName: "BTC比特币79,588.00-1.40%", role: "button" }]);
  await applyOnce("run-2", [{ semanticName: "BTC比特币80,123.00+0.50%", role: "button" }]);
  assert.equal(await elementCount(), 1, "价格变化必须归一化为同一元素");
});

test("2: 步骤 1 vs 步骤 2 are distinct business steps", async () => {
  await applyOnce("run-1", [{ semanticName: "步骤 1", role: "button" }]);
  await applyOnce("run-2", [{ semanticName: "步骤 2", role: "button" }]);
  assert.equal(await elementCount(), 2, "步骤 1 与步骤 2 不得合并");
});

test("3: 等级 1 vs 等级 2 are distinct levels", async () => {
  await applyOnce("run-1", [{ semanticName: "等级 1", role: "button" }]);
  await applyOnce("run-2", [{ semanticName: "等级 2", role: "button" }]);
  assert.equal(await elementCount(), 2, "等级 1 与等级 2 不得合并");
});

test("4: 30 天 vs 90 天 are distinct business options", async () => {
  await applyOnce("run-1", [{ semanticName: "30 天", role: "button" }]);
  await applyOnce("run-2", [{ semanticName: "90 天", role: "button" }]);
  assert.equal(await elementCount(), 2, "30 天与 90 天不得合并");
});

test("5: 24h 涨幅榜 vs 24h 跌幅榜 stay distinct", async () => {
  await applyOnce("run-1", [{ semanticName: "24h 涨幅榜", role: "tab" }]);
  await applyOnce("run-2", [{ semanticName: "24h 跌幅榜", role: "tab" }]);
  assert.equal(await elementCount(), 2, "涨幅榜与跌幅榜语义不同，不得合并");
});

test("6: spacing variant of the same business element still merges (步骤1 / 步骤 1)", async () => {
  await applyOnce("run-1", [{ semanticName: "步骤1", role: "button" }]);
  await applyOnce("run-2", [{ semanticName: "步骤 1", role: "button" }]);
  assert.equal(await elementCount(), 1, "同一业务元素的不同间距形态应合并为同一元素");
});
