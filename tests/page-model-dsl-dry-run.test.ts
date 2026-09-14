import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPageModelDslDryRun } from "../src/core/page-model-dsl-dry-run.js";
import type { PageModelEvidenceSelection } from "../src/core/page-model-evidence-selector.js";

test("builds non-executable DSL dry-run from selected page model evidence", () => {
  const result = buildPageModelDslDryRun(selectionFixture());

  assert.equal(result.schemaVersion, "page-model-dsl-dry-run.v1");
  assert.equal(result.executable, false);
  assert.equal(result.readiness, "partial");
  assert.equal(result.dsl.schemaVersion, "dsl-draft.v1");
  assert.equal(result.dsl.module, "asset");
  assert.ok(result.dsl.steps.some((step) => step.action === "navigate" && step.pageId === "demo.funds.spot_account"));
  assert.ok(result.dsl.steps.every((step) => step.evidence.length > 0));
  assert.ok(result.gaps.includes("spot_fund_flow_type_filter_option_gift_coin"));
  assert.ok(result.dsl.clarificationQuestions.some((item) => item.includes("spot_fund_flow_type_filter_option_gift_coin")));
});

test("builds executable DSL dry-run when P7 evidence closes spot fund flow gaps", () => {
  const fixture = selectionFixture();
  fixture.readiness = "ready";
  fixture.executable = true;
  fixture.gaps = [];
  fixture.blockingGaps = [];
  fixture.selectedEvidence.push({
    kind: "element",
    id: "p7.spot_fund_flow.gift_coin_option",
    pageId: "demo.funds.spot_fund_flow",
    semanticName: "赠币类型选项",
    status: "click_observed",
    confidence: 0.72,
    reason: "Element matched request terms or required funds-center control.",
    evidence: [{ source: "page_map", id: "p7.spot_fund_flow.gift_coin_option", confidence: 0.72 }]
  });
  fixture.fallbackEvidence.push({
    kind: "assertion",
    id: "p7.spot_fund_flow.result_gift_or_empty",
    pageId: "demo.funds.spot_fund_flow",
    semanticName: "list_or_empty_state",
    status: "dom_verified",
    confidence: 0.7,
    reason: "Assertion candidate can support result or empty-state checking.",
    evidence: [{ source: "page_map", id: "p7.spot_fund_flow.result_gift_or_empty", confidence: 0.7 }]
  });

  const result = buildPageModelDslDryRun(fixture);

  assert.equal(result.executable, true);
  assert.equal(result.gaps.length, 0);
  assert.ok(result.dsl.steps.some((step) => step.elementRef === "p7.spot_fund_flow.gift_coin_option" && step.inputValue === "赠币"));
});

test("withdraw DSL dry-run declares providers but remains non-executable with gaps", () => {
  const fixture = selectionFixture();
  fixture.intent.module = "withdraw";
  fixture.intent.action = "submit_withdraw";
  fixture.intent.operationType = "write";
  fixture.intent.data = { asset: "USDT", network: "BSC" };
  fixture.selectedEvidence = [
    {
      kind: "page",
      id: "demo.funds.withdraw",
      pageId: "demo.funds.withdraw",
      semanticName: "提现",
      status: "dom_verified",
      confidence: 0.8,
      reason: "提现需求需要提现 PageModel。",
      evidence: [{ source: "page_map", id: "demo.funds.withdraw", confidence: 0.75 }]
    }
  ];
  fixture.fallbackEvidence = [];
  fixture.gaps = ["withdraw_verification_provider_state", "withdraw_record_assertion"];
  fixture.blockingGaps = ["withdraw_verification_provider_state", "withdraw_record_assertion"];

  const result = buildPageModelDslDryRun(fixture);

  assert.deepEqual(result.dsl.providerDependencies, ["redis.email_code", "keepassxc.totp"]);
  assert.equal(result.executable, false);
  assert.ok(result.dsl.steps.every((step) => step.sourceProposalId));
});

function selectionFixture(): PageModelEvidenceSelection {
  return {
    schemaVersion: "page-model-evidence-selection.v1",
    request: "登录 Demo test 环境，进入现货账户资金流水页面，通过类型筛选，类型选择“赠币”，断言筛选结果展示赠币类型记录或空状态。",
    intent: {
      project: "demo",
      env: "test",
      module: "asset",
      action: "spot_fund_flow_filter",
      operationType: "read",
      loginRequired: true,
      data: { account: "spot", type: "赠币" },
      intentConfidence: 0.78,
      evidence: ["keyword:现货账户", "keyword:资金流水", "keyword:赠币"]
    },
    selectedEvidence: [
      {
        kind: "page",
        id: "demo.funds.spot_account",
        pageId: "demo.funds.spot_account",
        semanticName: "现货账户",
        status: "dom_verified",
        confidence: 0.8,
        reason: "现货流水筛选需要现货账户 PageModel 作为入口。",
        evidence: [{ source: "page_map", id: "demo.funds.spot_account", confidence: 0.75 }]
      },
      {
        kind: "element",
        id: "spot_fund_flow_entry",
        pageId: "demo.funds.spot_account",
        semanticName: "资金流水入口",
        status: "dom_verified",
        confidence: 0.7,
        reason: "Element matched request terms or required funds-center control.",
        evidence: [{ source: "page_map", id: "spot_fund_flow_entry", confidence: 0.7 }]
      }
    ],
    fallbackEvidence: [
      {
        kind: "assertion",
        id: "fund_flow_page",
        pageId: "demo.funds.fund_flow_entry",
        semanticName: "列表或空状态",
        status: "candidate",
        confidence: 0.5,
        reason: "Assertion candidate can support result or empty-state checking.",
        evidence: [{ source: "page_map", id: "fund_flow_page", confidence: 0.5 }]
      }
    ],
    excludedEvidence: [],
    gaps: ["spot_fund_flow_type_filter_option_gift_coin", "spot_fund_flow_result_assertion"],
    blockingGaps: ["spot_fund_flow_type_filter_option_gift_coin", "spot_fund_flow_result_assertion"],
    readiness: "partial",
    executable: false,
    reason: "Page Model evidence is partial; DSL dry-run must expose gaps instead of forcing execution."
  };
}
