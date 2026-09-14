import assert from "node:assert/strict";
import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { applyPageModelWriteBack, buildPageModelWriteBackDiff } from "../src/workbench/page-model-writeback.js";

/**
 * Market Element Identity Dedup Guard 回归测试。
 *
 * 验证未来 writeback 不再制造 semantic duplicate：
 * A. 同一静态元素连续 bootstrap 3 次 → element count 不增长
 * B. BTC 行价格变化 → 不新增 BTC semantic element（价格数字不入 identity）
 * C. 不同 ticker（BTC / ETH）→ 不错误合并
 * D. 不同 controlType → 不错误合并
 * E. 已有 verificationHistory/evidence → 保持原 elementId 且内容不动
 *
 * 附加：定位器语义冲突 → SEMANTIC_IDENTITY_UNRESOLVED（按新元素处理，不错误合并）。
 */

const PAGE_ID = "demo.market.modeling_candidate";
const PROJECT = "demo";

let sandbox: string;

beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "identity-dedup-guard-"));
});

afterEach(async () => {
  await fs.remove(sandbox);
});

interface TestElement {
  semanticName: string;
  role?: string;
  controlType?: string;
  locatorCandidates?: Array<Record<string, unknown>>;
  confidence?: number;
}

function marketProposal(runId: string, elements: TestElement[]): Record<string, unknown> {
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
      elements: elements.map((e) => ({
        semanticName: e.semanticName,
        role: e.role ?? "button",
        ...(e.controlType ? { controlType: e.controlType } : {}),
        locatorCandidates: e.locatorCandidates ?? [],
        confidence: e.confidence ?? 0.5
      })),
      assertionModels: [],
      identityVerdict: { verdict: "SAME_PAGE", candidatePageIds: [PAGE_ID], score: 0.9 }
    }
  };
}

async function readModelElements(): Promise<Array<Record<string, unknown>>> {
  const storePath = path.join(sandbox, "storage", "page-models", `${PROJECT}.json`);
  if (!(await fs.pathExists(storePath))) return [];
  const store = await fs.readJson(storePath) as { models: Array<{ pageId: string; elements: Array<Record<string, unknown>> }> };
  const model = store.models.find((m) => m.pageId === PAGE_ID);
  return model?.elements ?? [];
}

test("A: same static element bootstrapped 3 times does not grow element count", async () => {
  const elements: TestElement[] = [
    { semanticName: "行情 行情", role: "link" },
    { semanticName: "24h 涨幅榜", role: "tab" },
    { semanticName: "搜索币种", role: "textbox", locatorCandidates: [{ strategy: "role", value: "role=textbox:搜索币种" }] }
  ];
  for (let i = 1; i <= 3; i += 1) {
    await applyPageModelWriteBack(sandbox, PROJECT, marketProposal(`run-${i}`, elements), { reviewedBy: "identity-dedup-guard-test" });
  }
  const modelElements = await readModelElements();
  assert.equal(modelElements.length, 3, "3 次 bootstrap 后元素数应保持 3（初始）而非 9");

  const diff = await buildPageModelWriteBackDiff(sandbox, PROJECT, marketProposal("run-4", elements));
  assert.equal(diff.action, "no_op");
  assert.equal(diff.newElements.length, 0);
  assert.equal(diff.matchedExistingElements, 3, "第 4 次 diff 应全部命中既有语义元素");
});

test("B: BTC row price change does not create a new BTC semantic element", async () => {
  await applyPageModelWriteBack(sandbox, PROJECT, marketProposal("run-1", [
    { semanticName: "BTC比特币79,588.00-1.40%", role: "button" }
  ]), { reviewedBy: "identity-dedup-guard-test" });
  const afterFirst = await readModelElements();
  assert.equal(afterFirst.length, 1);
  const firstId = String(afterFirst[0].elementId);
  assert.equal(firstId.includes("79"), false, "价格数字不得进入 elementId");
  assert.equal(firstId.includes("588"), false, "价格数字不得进入 elementId");

  await applyPageModelWriteBack(sandbox, PROJECT, marketProposal("run-2", [
    { semanticName: "BTC比特币80,123.00+0.50%", role: "button" }
  ]), { reviewedBy: "identity-dedup-guard-test" });
  const afterSecond = await readModelElements();
  assert.equal(afterSecond.length, 1, "BTC 价格变化后不应新增 BTC semantic element");
  assert.equal(String(afterSecond[0].elementId), firstId, "应复用原 elementId");

  const diff = await buildPageModelWriteBackDiff(sandbox, PROJECT, marketProposal("run-3", [
    { semanticName: "BTC 比特币 80,123.00 +0.50%", role: "button" }
  ]));
  assert.equal(diff.newElements.length, 0, "空格/价格变体也不应产生新元素");
  assert.equal(diff.matchedExistingElements, 1);
});

test("C: different tickers (BTC vs ETH) are not merged", async () => {
  await applyPageModelWriteBack(sandbox, PROJECT, marketProposal("run-1", [
    { semanticName: "BTC比特币79,588.00-1.40%", role: "button" },
    { semanticName: "ETH以太坊2,450.33-2.19%", role: "button" }
  ]), { reviewedBy: "identity-dedup-guard-test" });
  await applyPageModelWriteBack(sandbox, PROJECT, marketProposal("run-2", [
    { semanticName: "BTC比特币80,123.00+0.50%", role: "button" },
    { semanticName: "ETH以太坊2,510.11-1.08%", role: "button" }
  ]), { reviewedBy: "identity-dedup-guard-test" });
  const modelElements = await readModelElements();
  assert.equal(modelElements.length, 2, "BTC 与 ETH 必须保持为两个独立元素");
});

test("D: same name with different controlType is not merged", async () => {
  await applyPageModelWriteBack(sandbox, PROJECT, marketProposal("run-1", [
    { semanticName: "金额", role: "input" }
  ]), { reviewedBy: "identity-dedup-guard-test" });
  await applyPageModelWriteBack(sandbox, PROJECT, marketProposal("run-2", [
    { semanticName: "金额", role: "button" }
  ]), { reviewedBy: "identity-dedup-guard-test" });
  const modelElements = await readModelElements();
  assert.equal(modelElements.length, 2, "input 与 button 语义不同，不得合并");
  const controlTypes = modelElements.map((e) => String(e.controlType)).sort();
  assert.deepEqual(controlTypes, ["button", "input"]);
});

test("E: existing verificationHistory/evidence keeps original elementId untouched", async () => {
  // 预置一个带 verificationHistory + evidence 的既有元素（模拟已沉淀 evidence 的副本）。
  const storePath = path.join(sandbox, "storage", "page-models", `${PROJECT}.json`);
  await fs.ensureDir(path.dirname(storePath));
  await fs.writeJson(storePath, {
    schemaVersion: "page-model-store.v1",
    project: PROJECT,
    models: [{
      schemaVersion: "page-model.v1",
      pageId: PAGE_ID,
      pageName: "行情",
      project: PROJECT,
      platform: "web",
      locale: "zh-hans",
      module: "market",
      action: "open",
      url: "https://example.com/zh-hans/market",
      status: "candidate",
      confidence: 0.5,
      sourceCaptureRun: "seed",
      elements: [{
        elementId: "market.modeling_candidate.capture.item_1",
        semanticName: "搜索币种",
        controlType: "input",
        semanticRole: "captured_inventory",
        status: "dom_verified",
        confidence: 0.5,
        locatorCandidates: [{ strategy: "role", value: "role=textbox:搜索币种", confidence: 0.5 }],
        verificationHistory: [{
          promotedAt: "2026-09-05T06:50:37.307Z",
          policyId: "interaction.v1",
          policyVersion: 1,
          knowledgeType: "INTERACTION",
          action: "record_interaction",
          evidenceIds: ["ev_bc945bbb964ad65e", "ev_25584b9f97662e6a"],
          interaction: { observedValue: "interaction:market.search_filter", successCount: 2 }
        }]
      }],
      assertions: []
    }],
    indexes: { byPageId: { [PAGE_ID]: 0 } }
  });

  // 相同语义元素再次 bootstrap（同 ID 或带价格变体都不应新增/改写）。
  await applyPageModelWriteBack(sandbox, PROJECT, marketProposal("run-2", [
    { semanticName: "搜索币种", role: "textbox", locatorCandidates: [{ strategy: "role", value: "role=textbox:搜索币种" }] }
  ]), { reviewedBy: "identity-dedup-guard-test" });

  const modelElements = await readModelElements();
  assert.equal(modelElements.length, 1, "既有元素不得被复制");
  const element = modelElements[0];
  assert.equal(String(element.elementId), "market.modeling_candidate.capture.item_1", "elementId 必须保持原样");
  const vh = element.verificationHistory as Array<{ evidenceIds?: string[] }>;
  assert.equal(Array.isArray(vh), true);
  assert.equal(vh[0].evidenceIds?.includes("ev_bc945bbb964ad65e"), true, "verificationHistory/evidence 引用必须原样保留");
  assert.equal(vh[0].evidenceIds?.includes("ev_25584b9f97662e6a"), true, "verificationHistory/evidence 引用必须原样保留");
});

test("unresolved locator semantics are not force-merged", async () => {
  // 同一名字/controlType 但定位器语义冲突（role vs css）→ SEMANTIC_IDENTITY_UNRESOLVED：
  // 保守按新元素处理，绝不错误合并。
  await applyPageModelWriteBack(sandbox, PROJECT, marketProposal("run-1", [
    { semanticName: "搜索币种", role: "textbox", locatorCandidates: [{ strategy: "role", value: "role=textbox:搜索币种" }] }
  ]), { reviewedBy: "identity-dedup-guard-test" });
  await applyPageModelWriteBack(sandbox, PROJECT, marketProposal("run-2", [
    { semanticName: "搜索币种", role: "textbox", locatorCandidates: [{ strategy: "css", value: "css=[name=search]" }] }
  ]), { reviewedBy: "identity-dedup-guard-test" });
  const modelElements = await readModelElements();
  assert.equal(modelElements.length, 2, "定位器语义冲突时不得合并为一个元素");
});
