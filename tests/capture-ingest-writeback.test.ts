import assert from "node:assert/strict";
import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { ingestCaptureRunReport } from "../src/workbench/capture-proposal-ingest.js";
import { applyPageModelWriteBack, buildPageModelWriteBackDiff } from "../src/workbench/page-model-writeback.js";
import { reviewKnowledgeProposal } from "../src/workbench/knowledge-proposal-review.js";

let sandbox: string;

beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "capture-ingest-"));
});

afterEach(async () => {
  await fs.remove(sandbox);
});

async function writeScanReport(): Promise<string> {
  const reportPath = path.join(sandbox, "reports", "demo-scan.json");
  await fs.ensureDir(path.dirname(reportPath));
  await fs.writeJson(reportPath, {
    schemaVersion: "demo.capture-scan.v1",
    runId: "demo-run",
    project: "demoproj",
    env: "test",
    proposals: {
      pageModels: [
        { proposalId: "p_page_one", pageId: "demo.page_one", pageName: "演示页", module: "demo", action: "open", url: "https://demo.example.com/one", title: "演示页", pageType: "form_or_filter", status: "dom_verified", confidence: 0.7, expectedCapability: "演示能力" },
        { proposalId: "p_page_two", pageId: "demo.page_two", pageName: "演示页二", module: "demo", action: "open", url: "https://demo.example.com/two", status: "dom_verified", confidence: 0.6 }
      ],
      elementInventories: [
        { proposalId: "e1", pageId: "demo.page_one", semanticName: "确认按钮", role: "button", locatorCandidates: [{ strategy: "text", value: "确认", confidence: 0.58 }], confidence: 0.56 },
        { proposalId: "e2", pageId: "demo.page_one", semanticName: "金额输入", role: "input", locatorCandidates: [{ strategy: "css", value: "[name=amount]", confidence: 0.68 }], confidence: 0.68 },
        { proposalId: "e3", pageId: "demo.page_two", semanticName: "记录表格", role: "table", locatorCandidates: [], confidence: 0.5 }
      ],
      assertionModels: [
        { proposalId: "a1", pageId: "demo.page_one", assertionKind: "success_or_page_state", candidates: [{ type: "visible_text_any", expected: ["提交成功", "处理中"] }] },
        { proposalId: "a2", pageId: "demo.page_one", assertionKind: "failure_or_block_state", candidates: [{ type: "visible_text_any", expected: ["余额不足"] }] },
        { proposalId: "a3", pageId: "demo.page_two", assertionKind: "success_or_page_state", candidates: [] }
      ]
    }
  });
  return path.relative(sandbox, reportPath).replace(/\\/g, "/");
}

async function readIngestProposalByPageId(ingestResult: { proposalIds: string[] }, pageId: string): Promise<Record<string, unknown>> {
  for (const proposalId of ingestResult.proposalIds) {
    const record = await fs.readJson(path.join(sandbox, "storage", "proposals", "pending", `${proposalId}.json`)) as Record<string, unknown>;
    const captureIngest = record.captureIngest as { pageModel?: { pageId?: string } } | undefined;
    if (captureIngest?.pageModel && String(captureIngest.pageModel.pageId ?? "") === pageId) {
      return record;
    }
  }
  throw new Error(`Ingest proposal for ${pageId} not found`);
}

async function ingestProposalIdByPageId(ingestResult: { proposalIds: string[] }, pageId: string): Promise<string> {
  const record = await readIngestProposalByPageId(ingestResult, pageId);
  return String(record.proposalId);
}

test("ingest splits scan report into per-page pending proposals", async () => {
  const reportPath = await writeScanReport();
  const result = await ingestCaptureRunReport(sandbox, { reportPath });
  assert.equal(result.pagesFound, 2);
  assert.equal(result.proposalsCreated, 2);
  const pendingDir = path.join(sandbox, "storage", "proposals", "pending");
  const files = await fs.readdir(pendingDir);
  assert.equal(files.length, 2);
  const first = await readIngestProposalByPageId(result, "demo.page_one");
  assert.equal(first.proposalType, "page_model_ingest");
  assert.equal(first.source, "capture_run_ingest");
  assert.equal((first.captureIngest as { elements: unknown[] }).elements.length, 2);
  assert.equal((first.captureIngest as { assertionModels: unknown[] }).assertionModels.length, 2);
});

test("ingest fails loudly on missing report or empty pageModels", async () => {
  await assert.rejects(
    () => ingestCaptureRunReport(sandbox, { reportPath: "reports/missing.json" }),
    /not found/
  );
  const emptyPath = path.join(sandbox, "reports", "empty.json");
  await fs.ensureDir(path.dirname(emptyPath));
  await fs.writeJson(emptyPath, { project: "demoproj", env: "test", proposals: { pageModels: [] } });
  await assert.rejects(
    () => ingestCaptureRunReport(sandbox, { reportPath: "reports/empty.json" }),
    /no pageModel proposals/
  );
});

test("diff reports add_page for new page and merge for existing", async () => {
  const reportPath = await writeScanReport();
  const ingest = await ingestCaptureRunReport(sandbox, { reportPath });
  const proposal = await readIngestProposalByPageId(ingest, "demo.page_one");
  const diff = await buildPageModelWriteBackDiff(sandbox, "demoproj", proposal);
  assert.equal(diff.action, "add_page");
  assert.equal(diff.newElements.length, 2);
  assert.equal(diff.newAssertions.length, 2);
  assert.equal(diff.statusCap, "candidate");
  assert.equal(diff.newAssertions[0].expectedTexts.includes("提交成功"), true);
});

test("apply writes candidate-only page, preserves existing entries, second apply is append-safe", async () => {
  const reportPath = await writeScanReport();
  const ingest = await ingestCaptureRunReport(sandbox, { reportPath });
  const proposal = await readIngestProposalByPageId(ingest, "demo.page_one");

  // 预置一个已有 execution_verified 元素，写回后必须原样保留。
  const storePath = path.join(sandbox, "storage", "page-models", "demoproj.json");
  await fs.ensureDir(path.dirname(storePath));
  await fs.writeJson(storePath, {
    schemaVersion: "page-model-store.v1",
    project: "demoproj",
    models: [{
      schemaVersion: "page-model.v1",
      pageId: "demo.page_one",
      pageName: "演示页",
      status: "execution_verified",
      elements: [{ elementId: "legacy.element", status: "execution_verified", confidence: 0.9 }],
      assertions: []
    }],
    indexes: { byPageId: { "demo.page_one": 0 } }
  });

  const result = await applyPageModelWriteBack(sandbox, "demoproj", proposal, { reviewedBy: "tester" });
  assert.equal(result.applied, true);
  assert.equal(result.action, "merge_page");
  assert.equal(result.wroteExecutionVerified, false);
  assert.equal(result.modifiedExistingEntries, false);

  const store = await fs.readJson(storePath);
  const model = store.models.find((item) => item.pageId === "demo.page_one");
  assert.equal(model.status, "execution_verified", "既有页面状态不被降级");
  const legacy = model.elements.find((item) => item.elementId === "legacy.element");
  assert.equal(legacy.status, "execution_verified");
  assert.equal(legacy.confidence, 0.9);
  const added = model.elements.filter((item) => item.elementId.startsWith("page_one.capture."));
  assert.equal(added.length, 2);
  assert.ok(added.every((item) => item.status === "candidate"), "新增元素只能是 candidate");
  assert.equal(model.assertions.length, 2);
  assert.ok(model.assertions.every((item) => item.status === "candidate"));

  // 幂等：同样的 proposal 再写一次不重复追加。
  const second = await applyPageModelWriteBack(sandbox, "demoproj", proposal, { reviewedBy: "tester" });
  const storeAgain = await fs.readJson(storePath);
  const modelAgain = storeAgain.models.find((item) => item.pageId === "demo.page_one");
  assert.equal(modelAgain.elements.filter((item) => item.elementId.startsWith("page_one.capture.")).length, 2);
  assert.equal(second.addedElements, 0);
});

test("approve via review service applies write-back and stamps result on proposal", async () => {
  const reportPath = await writeScanReport();
  const ingest = await ingestCaptureRunReport(sandbox, { reportPath });
  const pageTwoProposalId = await ingestProposalIdByPageId(ingest, "demo.page_two");
  const result = await reviewKnowledgeProposal(sandbox, {
    proposalId: pageTwoProposalId,
    action: "approve",
    reviewedBy: "reviewer",
    note: "ok"
  });
  assert.equal(result.newStatus, "approved");
  assert.equal(result.writeBack.applied, true);
  assert.ok(result.writeBack.note.includes("candidate"));
  const storePath = path.join(sandbox, "storage", "page-models", "demoproj.json");
  assert.ok(await fs.pathExists(storePath));
  const store = await fs.readJson(storePath);
  assert.ok(store.models.some((item) => item.pageId === "demo.page_two"));
  const approved = await fs.readJson(path.join(sandbox, "storage", "proposals", "approved", `${pageTwoProposalId}.json`));
  assert.ok(approved.writeBackResult, "审核通过记录写回结果");
});

test("reject keeps store untouched", async () => {
  const reportPath = await writeScanReport();
  const ingest = await ingestCaptureRunReport(sandbox, { reportPath });
  await reviewKnowledgeProposal(sandbox, { proposalId: await ingestProposalIdByPageId(ingest, "demo.page_one"), action: "reject", note: "not wanted" });
  const storePath = path.join(sandbox, "storage", "page-models", "demoproj.json");
  assert.equal(await fs.pathExists(storePath), false, "拒绝不产生 store 写入");
});
