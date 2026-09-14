import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "fs-extra";
import { scanPageStructure, detectResultRegions, scanAssertionCandidates } from "../src/core/modeling-structure-scanner.js";
import { extractOptionsFromRun, isOptionDiscoveryRun, promoteDiscoveredOptions } from "../src/core/modeling-option-promotion.js";
import { applyPageModelWriteBack } from "../src/workbench/page-model-writeback.js";
import type { InventorySummary } from "../src/capture/types.js";
import type { ExplorationRun } from "../src/core/exploration-executor.js";

/**
 * P6.2-14：Assertion Scanner / Option Promotion / 状态门禁 / DSL 物化集成。
 * 覆盖：I/J/K/L/M/N/O/P/Q/R 等关键项。
 */

// ============ 结构扫描器 ============
function inventory(overrides: Partial<InventorySummary> = {}): InventorySummary {
  return {
    clickables: [],
    fields: [],
    buttons: [],
    tables: [
      { index: 0, tag: "table", role: "table", text: "币种 时间 类型 数量 状态 操作 暂无数据", rowCount: 2, columnHeaders: ["币种", "时间", "类型", "数量", "状态", "操作"], firstRowCells: ["币种", "时间", "类型"] }
    ],
    dialogs: [],
    iframes: [],
    selectLike: [],
    emptyStateTexts: ["暂无数据"],
    pagination: [{ index: 0, text: "1 2 3", items: 3 }],
    ...overrides
  };
}

test("I. result table detection：列头 + 行数 + 空状态", () => {
  const regions = detectResultRegions(inventory());
  assert.equal(regions.length, 1);
  assert.equal(regions[0].type, "table");
  assert.deepEqual(regions[0].columns.slice(0, 3), ["币种", "时间", "类型"]);
  assert.equal(regions[0].rowCount, 2);
});

test("J. empty state detection：结构化空状态文本 → result_empty 断言", () => {
  const candidates = scanAssertionCandidates(inventory(), "暂无数据");
  assert.ok(candidates.some((c) => c.canonicalKind === "result_empty"));
  assert.ok(candidates.some((c) => c.canonicalKind === "record_or_empty_state"));
});

test("K. column header → 结果列表或空状态断言（dom_verified）", () => {
  const candidates = scanAssertionCandidates(inventory(), "");
  const recordAssertion = candidates.find((c) => c.canonicalKind === "record_or_empty_state");
  assert.ok(recordAssertion);
  assert.equal(recordAssertion!.status, "dom_verified");
  assert.ok(recordAssertion!.expectedTexts.length >= 2);
});

test("L. button enabled/disabled → 按钮状态断言（dom_verified）", () => {
  const candidates = scanAssertionCandidates(inventory({
    buttons: [
      { index: 0, tag: "button", role: "button", text: "查询", disabled: false },
      { index: 1, tag: "button", role: "button", text: "提交", disabled: true }
    ]
  }), "");
  assert.ok(candidates.some((c) => c.canonicalKind === "element_enabled" && c.semanticName.includes("查询")));
  assert.ok(candidates.some((c) => c.canonicalKind === "element_disabled" && c.semanticName.includes("提交")));
});

test("M. 断言去重：相同 kind+语义名只保留一个", () => {
  const candidates = scanAssertionCandidates(inventory({
    buttons: [
      { index: 0, tag: "button", role: "button", text: "查询", disabled: false },
      { index: 1, tag: "button", role: "button", text: "查询", disabled: false }
    ]
  }), "");
  const enabled = candidates.filter((c) => c.canonicalKind === "element_enabled" && c.semanticName.includes("查询"));
  assert.equal(enabled.length, 1);
});

test("Q. native select option：不产生 160 个独立 gap，一次聚合多个 option", () => {
  const scan = scanPageStructure(inventory({
    selectOptions: [
      { index: 0, id: "asset", name: "asset", options: [{ value: "USDT", text: "USDT" }, { value: "USDC", text: "USDC" }, { value: "BTC", text: "BTC" }] }
    ]
  }), "");
  assert.equal(scan.nativeSelectOptions.length, 1);
  assert.equal(scan.nativeSelectOptions[0].options.length, 3, "一次发现多个 option（聚合）");
});

// ============ Option Promotion ============
function runFor(heuristicId: string, status: string, restoreResult: string, samples: string[]): ExplorationRun {
  return {
    runId: "run-x",
    planId: "plan-x",
    gapId: "gap:...:element:funds.x.asset_filter",
    heuristicId,
    heuristicVersion: 1,
    pageId: "demo.funds.spot_fund_flow",
    before: { visibleTextHash: "a" },
    steps: [],
    observations: [{ optionSamples: samples }],
    after: { visibleTextHash: "a" },
    restoreResult: restoreResult as ExplorationRun["restoreResult"],
    status: status as ExplorationRun["status"],
    evidence: []
  };
}

async function seedStore(rootDir: string): Promise<string> {
  const storePath = path.join(rootDir, "storage/page-models/demo.json");
  await fs.ensureDir(path.dirname(storePath));
  await fs.writeJson(storePath, {
    models: [{
      pageId: "demo.funds.spot_fund_flow",
      pageName: "现货流水",
      elements: [
        { elementId: "funds.spot_fund_flow.asset_filter", semanticName: "币种筛选控件", role: "combobox", controlType: "select", targetField: "asset", status: "dom_verified" }
      ],
      assertions: []
    }]
  });
  return storePath;
}

test("D/E. option 挂 parent control + 一次多 option 聚合", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "p62-opt-"));
  const storePath = await seedStore(rootDir);
  const result = await promoteDiscoveredOptions(rootDir, "demo", {
    pageId: "demo.funds.spot_fund_flow",
    parentElementId: "funds.spot_fund_flow.asset_filter",
    options: ["USDT", "USDC", "BTC"]
  });
  assert.equal(result.action, "appended_options");
  assert.equal(result.addedOptions, 3);
  const store = fs.readJsonSync(storePath);
  const element = store.models[0].elements.find((e: Record<string, unknown>) => e.elementId === "funds.spot_fund_flow.asset_filter");
  assert.ok(element);
  const options = store.models[0].elements.filter((e: Record<string, unknown>) => e.controlType === "dropdown_option");
  assert.equal(options.length, 3);
  assert.ok(options.every((o: Record<string, unknown>) => o.parentElementId === "funds.spot_fund_flow.asset_filter"), "option 挂在 parent 下");
});

test("F. 幂等：同 optionValue 重复 promote 不重复写", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "p62-opt2-"));
  const storePath = await seedStore(rootDir);
  await promoteDiscoveredOptions(rootDir, "demo", { pageId: "demo.funds.spot_fund_flow", parentElementId: "funds.spot_fund_flow.asset_filter", options: ["USDT"] });
  const second = await promoteDiscoveredOptions(rootDir, "demo", { pageId: "demo.funds.spot_fund_flow", parentElementId: "funds.spot_fund_flow.asset_filter", options: ["USDT"] });
  assert.equal(second.action, "noop");
  const store = fs.readJsonSync(storePath);
  assert.equal(store.models[0].elements.filter((e: Record<string, unknown>) => e.controlType === "dropdown_option").length, 1);
});

test("G. restore fail 不晋升：非 COMPLETED_CLEANLY 的 option_discovery 不写回", () => {
  const failRun = runFor("select.option_discovery", "COMPLETED_WITH_RESTORE_FAILURE", "PARTIAL", ["USDT"]);
  assert.equal(isOptionDiscoveryRun(failRun), false);
});

test("H. 多 option 聚合成一次 evidence（extractOptionsFromRun 去重）", () => {
  const run = runFor("select.option_discovery", "COMPLETED_CLEANLY", "SUCCESS", ["USDT", "USDT", "USDC", " BTC "]);
  const options = extractOptionsFromRun(run);
  assert.deepEqual(options, ["USDT", "USDC", "BTC"]);
});

// ============ 状态门禁 ============
test("O/P. writeback 状态门禁：dom_verified 可写，execution_verified 被拒", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "p62-cap-"));
  const storePath = path.join(rootDir, "storage/page-models/demo.json");
  await fs.ensureDir(path.dirname(storePath));
  await fs.writeJson(storePath, { models: [] });
  const proposal = {
    schemaVersion: "knowledge-update-proposal.v1",
    proposalId: "p-cap",
    status: "pending_review",
    createdAt: new Date().toISOString(),
    project: "demo",
    env: "test",
    proposalType: "page_model_ingest",
    captureIngest: {
      runId: "cap",
      sourceReport: "",
      pageModel: { pageId: "demo.demo.page", pageName: "demo", url: "http://x", module: "demo", platform: "web", status: "candidate" },
      identity: { url: "http://x", semanticNames: [] },
      identityVerdict: { verdict: "NEW_PAGE", score: 0, reasons: [], matchedSignals: [], conflictingSignals: [], candidatePageIds: [] },
      elements: [],
      assertionModels: []
    }
  };
  // dom_verified 允许
  const ok = await applyPageModelWriteBack(rootDir, "demo", proposal, { reviewedBy: "test", statusCap: "dom_verified" });
  assert.equal(ok.applied, true);
  // execution_verified 被拒
  await assert.rejects(
    applyPageModelWriteBack(rootDir, "demo", proposal, { reviewedBy: "test", statusCap: "execution_verified" as never }),
    /[P6.2-5]/
  );
});

// ============ DSL 物化集成 ============
test("R. 断言候选 → writeback → dom_verified assertion（可被 DSL contract 消费）", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "p62-dsl-"));
  const storePath = path.join(rootDir, "storage/page-models/demo.json");
  await fs.ensureDir(path.dirname(storePath));
  await fs.writeJson(storePath, { models: [] });
  const scan = scanAssertionCandidates(inventory(), "暂无数据");
  const proposal = {
    schemaVersion: "knowledge-update-proposal.v1",
    proposalId: "p-dsl",
    status: "pending_review",
    createdAt: new Date().toISOString(),
    project: "demo",
    env: "test",
    proposalType: "page_model_ingest",
    captureIngest: {
      runId: "dsl",
      sourceReport: "",
      pageModel: { pageId: "demo.funds.spot_fund_flow", pageName: "现货流水", url: "http://x", module: "funds", platform: "web", status: "candidate" },
      identity: { url: "http://x", semanticNames: [] },
      identityVerdict: { verdict: "NEW_PAGE", score: 0, reasons: [], matchedSignals: [], conflictingSignals: [], candidatePageIds: [] },
      elements: [],
      assertionModels: scan.slice(0, 2).map((c) => ({
        proposalId: "p-dsl",
        assertionKind: c.assertionKind,
        canonicalKind: c.canonicalKind,
        semanticName: c.semanticName,
        candidates: [{ type: "visible_text_any", expected: c.expectedTexts, confidence: c.confidence, source: c.source }],
        status: c.status
      }))
    }
  };
  await applyPageModelWriteBack(rootDir, "demo", proposal, { reviewedBy: "test", statusCap: "dom_verified" });
  const store = fs.readJsonSync(storePath);
  const assertions = (store.models[0].assertions ?? []) as Array<Record<string, unknown>>;
  assert.ok(assertions.length >= 1);
  // 断言语义名包含 canonical kind（record_or_empty_state 等），供 DSL hasVerifiedFundFlowResultAssertion 识别
  const recordAssertion = assertions.find((a) => String(a.canonicalKind) === "record_or_empty_state" || String(a.semanticName).includes("结果列表"));
  assert.ok(recordAssertion, "record_or_empty_state 断言写入");
  assert.equal(String(recordAssertion!.status), "dom_verified", "dom_verified 可被 isVerifiedStatus 消费");
});
