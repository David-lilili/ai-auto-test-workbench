import assert from "node:assert/strict";
import { test } from "node:test";
import { detectSignals, inferPageType, inferStatus, matchedTermsByRole } from "../src/capture/evidence.js";
import { buildBlockIfNeeded, buildProposal, renderReport } from "../src/capture/proposal.js";
import type { CaptureRunConfig, CaptureTargetResult } from "../src/capture/types.js";

const baseConfig: CaptureRunConfig = {
  runId: "unit-test-run",
  project: "demo-project",
  env: "test",
  platform: "web",
  locale: "zh-hans",
  schemaVersion: "demo.capture-scan.v1",
  entryUrl: "https://demo.example.com/home",
  entryPageId: "demo.home",
  entryLabel: "首页",
  targets: [
    { id: "home", pageId: "demo.home", label: "首页", module: "home", action: "open", kind: "direct_page", url: "https://demo.example.com/home", expectedCapability: "查看首页", riskLevel: "low" }
  ],
  signalGroups: [
    { name: "content", role: "success", terms: ["首页", "欢迎"] },
    { name: "block", role: "block", weight: 2, terms: ["KYC", "锁定"] }
  ],
  dataBindingRules: [{ term: "数量", targetField: "amount", valueType: "amount", sourcePath: "intent.data.amount" }],
  preconditionRules: [{ name: "kyc_or_identity_status", pattern: "KYC|实名" }]
};

function buildFakeCaptureResult(text: string): CaptureTargetResult {
  const signals = detectSignals(text, baseConfig.signalGroups);
  return {
    target: baseConfig.targets[0],
    capture: {
      id: "home",
      pageId: "demo.home",
      label: "首页",
      module: "home",
      action: "open",
      url: "https://demo.example.com/home",
      title: "首页",
      pageType: "page",
      screenshotPath: "artifacts/unit-test-run/home.png",
      domPath: "artifacts/unit-test-run/home.dom.html",
      visibleTextPath: "artifacts/unit-test-run/home.visible-text.txt",
      accessibilityPath: "artifacts/unit-test-run/home.accessibility.json",
      summaryPath: "artifacts/unit-test-run/home.summary.json",
      domHash: "dom-hash",
      visibleTextHash: "text-hash",
      visibleTextSample: text.split("\n").slice(0, 5),
      signals,
      inventory: { clickables: [], fields: [], buttons: [], tables: [], dialogs: [], iframes: [], selectLike: [] },
      status: inferStatus(baseConfig.targets[0], signals, "<html></html>", text),
      confidence: 0.5
    }
  };
}

test("detectSignals groups matched terms by role and computes weighted score", () => {
  const signals = detectSignals("首页 欢迎使用 KYC", baseConfig.signalGroups);
  assert.equal(matchedTermsByRole(signals, "success").sort().join(","), "欢迎,首页");
  assert.equal(matchedTermsByRole(signals, "block").join(","), "KYC");
  assert.equal(signals.score, 4);
});

test("inferStatus marks empty page as blocked and direct page as dom_verified", () => {
  const emptySignals = detectSignals("", baseConfig.signalGroups);
  assert.equal(inferStatus(baseConfig.targets[0], emptySignals, "", ""), "blocked");
  const goodSignals = detectSignals("首页", baseConfig.signalGroups);
  assert.equal(inferStatus(baseConfig.targets[0], goodSignals, "<html>首页</html>", "首页"), "dom_verified");
});

test("inferPageType classifies form vs list pages from inventory and signals", () => {
  const emptyInventory = { clickables: [], fields: [], buttons: [], tables: [], dialogs: [], iframes: [], selectLike: [] };
  const formSignals = detectSignals("数量 地址", baseConfig.signalGroups);
  const listSignals = detectSignals("欢迎", baseConfig.signalGroups);
  assert.equal(inferPageType({ ...emptyInventory, fields: [{ index: 0 }, { index: 1 }] as never }, listSignals), "form_or_filter");
  assert.equal(inferPageType({ ...emptyInventory, tables: [{ index: 0 }] as never }, listSignals), "list_or_dashboard");
  assert.equal(inferPageType(emptyInventory, formSignals), "page");
});

test("buildProposal emits project-neutral proposal ids and honors config boundaries", () => {
  const captures = [buildFakeCaptureResult("首页 欢迎使用")];
  const proposal = buildProposal(baseConfig, { webBaseUrl: "", apiBaseUrl: "" }, captures, "artifacts/unit-test-run");
  assert.equal(proposal.project, "demo-project");
  assert.equal((proposal.proposals.pageModels as Array<Record<string, unknown>>)[0].proposalId, "unit-test-run_page_home");
  assert.equal(proposal.boundaries.wroteMainKnowledge, false);
  assert.equal(proposal.boundaries.generatedDsl, false);
  assert.equal((proposal.proposals.blockPackages as unknown[]).length, 0);
});

test("buildProposal generates block package when block terms are visible", () => {
  const base = buildFakeCaptureResult("首页 KYC 未认证");
  const captures = [{ ...base, block: buildBlockIfNeeded(baseConfig, base.target, base.capture, undefined) }];
  const proposal = buildProposal(baseConfig, { webBaseUrl: "", apiBaseUrl: "" }, captures, "artifacts/unit-test-run");
  const blocks = proposal.proposals.blockPackages as Array<Record<string, unknown>>;
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].blockType, "blocked_by_precondition");
  assert.equal(blocks[0].blockId, "unit-test-run_block_home_precondition");
});

test("renderReport renders markdown summary without embedding raw page text", () => {
  const captures = [buildFakeCaptureResult("首页 欢迎使用")];
  const proposal = buildProposal(baseConfig, { webBaseUrl: "", apiBaseUrl: "" }, captures, "artifacts/unit-test-run");
  const report = renderReport(proposal);
  assert.ok(report.includes("# unit-test-run 建模扫描执行报告"));
  assert.ok(report.includes("扫描目标: 1"));
  assert.ok(report.includes("demo.home"));
  assert.ok(!report.includes("欢迎使用"));
});
