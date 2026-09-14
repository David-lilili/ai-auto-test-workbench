import assert from "node:assert/strict";
import { test } from "node:test";
import { buildAutomationCaseFromPageModel } from "../src/core/page-model-dsl-builder.js";
import type { PageModelEvidenceSelection } from "../src/core/page-model-evidence-selector.js";
import { parseUserAssertions } from "../src/core/user-assertion-parser.js";

test("builds evidence-backed AutomationCase for transfer without excluded evidence or temporary selectors", () => {
  const selection = selectionFixture();
  const userAssertions = parseUserAssertions({
    assertions: ["断言划转成功，并在资金流水中出现 USDT 50 现货到合约划转记录"],
    selection
  });
  const result = buildAutomationCaseFromPageModel({ selection, userAssertions, caseId: "transfer_fixture" });

  assert.equal(result.executable, true);
  assert.equal(result.temporarySelectorUsed, false);
  assert.deepEqual(result.excludedEvidenceUsed, []);
  assert.ok(result.case.steps.length >= 4);
  assert.ok(result.case.steps.every((step) => (step as Record<string, unknown>).source === "page_model"));
  assert.ok(result.case.steps.some((step) => (step as Record<string, unknown>).elementId === "t2.transfer.amount_input"));
  assert.ok(result.case.steps.some((step) => (step as Record<string, unknown>).assertionId === "t2_5.transfer.record_50_usdt_spot_to_futures"));
});

test("builds executable click-only steps for spot fund flow type filtering", () => {
  const selection: PageModelEvidenceSelection = {
    schemaVersion: "page-model-evidence-selection.v1",
    request: "spot fund flow filter red packet issued",
    intent: {
      project: "demo",
      env: "test",
      module: "asset",
      action: "spot_fund_flow_filter",
      operationType: "read",
      loginRequired: true,
      data: { account: "spot", type: "红包发放" },
      intentConfidence: 0.9,
      evidence: ["fixture"]
    },
    selectedEvidence: [
      evidence("page", "demo.funds.spot_fund_flow", "demo.funds.spot_fund_flow", "现货资金流水"),
      {
        ...evidence("element", "w3.spot_fund_flow.type_filter", "demo.funds.spot_fund_flow", "类型筛选控件"),
        role: "filter"
      },
      {
        ...evidence("element", "w3.spot_fund_flow.type_filter.option.红包发放", "demo.funds.spot_fund_flow", "类型选项：红包发放"),
        role: "option",
        locatorCandidates: [{ strategy: "text", value: "红包发放" }]
      },
      {
        ...evidence("element", "w3.spot_fund_flow.query_button", "demo.funds.spot_fund_flow", "查询按钮"),
        role: "button",
        locatorCandidates: [{ strategy: "text", value: "查询" }]
      },
      evidence("element", "w3.spot_fund_flow.result_table", "demo.funds.spot_fund_flow", "结果列表")
    ],
    fallbackEvidence: [],
    excludedEvidence: [{ id: "demo.red_packet.create", pageId: "demo.red_packet.create", reason: "unrelated" }],
    gaps: [],
    blockingGaps: [],
    readiness: "ready",
    executable: true,
    reason: "fixture"
  };
  const result = buildAutomationCaseFromPageModel({
    selection,
    userAssertions: parseUserAssertions({ assertions: [], selection }),
    caseId: "spot_fund_flow_red_packet_issued_fixture"
  });

  assert.equal(result.executable, true);
  assert.deepEqual(result.excludedEvidenceUsed, []);
  assert.equal(result.case.steps.filter((step) => step.action === "navigate").length, 1);
  assert.equal(
    (result.case.steps.find((step) => step.action === "navigate") as Record<string, unknown>).primary_locator,
    "http://www.example.com/zh-hans/assets/flows/spot-flow"
  );
  assert.ok(result.case.steps.some((step) => (step as Record<string, unknown>).elementId === "w3.spot_fund_flow.type_filter.option.红包发放"));
  const optionStep = result.case.steps.find((step) => String((step as Record<string, unknown>).elementId).includes("type_filter.option")) as Record<string, unknown>;
  assert.ok(optionStep);
  assert.ok(String(optionStep.primary_locator).startsWith("role=option:"));
  assert.deepEqual((optionStep.scopeGuard as Record<string, unknown>).forbiddenLocatorPatterns, [
    "[aria-label*=\"Demo\"]",
    "[aria-label*=\"User\"]",
    "logo",
    "header",
    "global navigation",
    "record/list/table row scope"
  ]);
  const queryStep = result.case.steps.find((step) => (step as Record<string, unknown>).elementId === "w3.spot_fund_flow.query_button") as Record<string, unknown>;
  assert.ok(String(queryStep.primary_locator).startsWith("role=button:"));
  assert.ok(!result.case.steps.some((step) => ["filter", "select", "inspect", "interact"].includes(String(step.action))));
  assert.ok(!result.case.steps.some((step) => (step as Record<string, unknown>).elementId === "w3.spot_fund_flow.result_table"));
});

test("builds table column assertion from user expectation without changing filter value", () => {
  const selection: PageModelEvidenceSelection = {
    schemaVersion: "page-model-evidence-selection.v1",
    request: "登录demo test环境，进入现货流水页面，通过类型交易进行搜索，期望页面只显示类型为充值的数据",
    intent: {
      project: "demo",
      env: "test",
      module: "asset",
      action: "spot_fund_flow_filter",
      operationType: "read",
      loginRequired: true,
      data: { account: "spot", type: "交易" },
      intentConfidence: 0.9,
      evidence: ["fixture"]
    },
    selectedEvidence: [
      evidence("page", "demo.funds.spot_fund_flow", "demo.funds.spot_fund_flow", "现货资金流水"),
      {
        ...evidence("element", "w3.spot_fund_flow.type_filter", "demo.funds.spot_fund_flow", "类型筛选控件"),
        role: "filter",
        locatorCandidates: [{ strategy: "text", value: "全部类型" }]
      },
      {
        ...evidence("element", "w3.spot_fund_flow.type_filter.option.交易", "demo.funds.spot_fund_flow", "类型筛选选项:交易"),
        role: "option",
        locatorCandidates: [{ strategy: "role_option_name", value: "交易" }]
      },
      {
        ...evidence("element", "w3.spot_fund_flow.query_button", "demo.funds.spot_fund_flow", "查询按钮"),
        role: "button",
        locatorCandidates: [{ strategy: "text", value: "查询" }]
      }
    ],
    fallbackEvidence: [],
    excludedEvidence: [],
    gaps: [],
    blockingGaps: [],
    readiness: "ready",
    executable: true,
    reason: "fixture"
  };
  const userAssertions = parseUserAssertions({ request: selection.request, selection });
  const result = buildAutomationCaseFromPageModel({ selection, userAssertions, caseId: "spot_fund_flow_trade_filter_recharge_assertion" });

  assert.equal(result.executable, true);
  assert.ok(result.case.steps.some((step) => (step as Record<string, unknown>).elementId === "w3.spot_fund_flow.type_filter.option.交易"));
  const assertionStep = result.case.steps.find((step) => step.action === "assert") as Record<string, any>;
  assert.equal(assertionStep.assertion.type, "table_column_all_equal");
  assert.equal(assertionStep.assertion.column, "类型");
  assert.equal(assertionStep.assertion.expected, "充值");
  assert.equal(assertionStep.assertion.intent.field, "类型");
  assert.equal(assertionStep.assertion.intent.expected, "充值");
});

test("builds date range action and table date range assertion for contract fund flow", () => {
  const selection: PageModelEvidenceSelection = {
    schemaVersion: "page-model-evidence-selection.v1",
    request: "进入合约流水页面，选择时间范围 2026-08-01 00:00:00 至 2026-08-07 23:59:59 并查询，期望列表时间列均在该范围内",
    intent: {
      project: "demo",
      env: "test",
      module: "asset",
      action: "contract_fund_flow_filter",
      operationType: "read",
      loginRequired: true,
      data: {
        account: "contract",
        timeRange: { raw: "2026-08-01 00:00:00~2026-08-07 23:59:59", mode: "range", start: "2026-08-01 00:00:00", end: "2026-08-07 23:59:59" }
      },
      intentConfidence: 0.9,
      evidence: ["fixture"]
    },
    selectedEvidence: [
      {
        ...evidence("page", "demo.funds.contract_fund_flow", "demo.funds.contract_fund_flow", "合约流水"),
        url: "http://www.example.com/zh-hans/assets/flows/contract-flow",
        resultTable: { tableId: "contract_fund_flow.result_table" },
        fieldMappings: [{ semanticField: "time_range", filterField: "time_range", resultColumn: "时间", source: "fixture" }]
      },
      {
        ...evidence("element", "funds.contract_fund_flow.time_filter", "demo.funds.contract_fund_flow", "时间筛选控件"),
        role: "combobox",
        controlType: "date_range",
        targetField: "time_range",
        locatorCandidates: [{ strategy: "field_relative", value: "fieldRelative=scope:page|label:时间|role:combobox|relation:following_control" }]
      },
      {
        ...evidence("element", "funds.contract_fund_flow.query_button", "demo.funds.contract_fund_flow", "查询按钮"),
        role: "button",
        controlType: "button",
        locatorCandidates: [{ strategy: "role_button_name", value: "查询" }]
      },
      evidence("assertion", "funds.contract_fund_flow.time_column_between", "demo.funds.contract_fund_flow", "时间列区间断言")
    ],
    fallbackEvidence: [],
    excludedEvidence: [],
    gaps: [],
    blockingGaps: [],
    readiness: "ready",
    executable: true,
    reason: "fixture"
  };
  const userAssertions = parseUserAssertions({
    assertions: ["列表“时间”列均在“2026-08-01 00:00:00”至“2026-08-07 23:59:59”内。"],
    selection
  });
  const result = buildAutomationCaseFromPageModel({ selection, userAssertions, caseId: "contract_fund_flow_date_range_fixture" });
  const dateStep = result.case.steps.find((step) => (step as Record<string, unknown>).elementId === "funds.contract_fund_flow.time_filter") as Record<string, unknown>;
  const assertionStep = result.case.steps.find((step) => step.action === "assert") as Record<string, any>;

  assert.equal(result.executable, true);
  assert.equal(dateStep.action, "setDateRange");
  assert.equal(assertionStep.assertion.type, "table_column_date_between");
  assert.equal(assertionStep.assertion.table, "contract_fund_flow.result_table");
  assert.equal(assertionStep.assertion.column, "时间");
  assert.deepEqual(assertionStep.assertion.expected, { start: "2026-08-01 00:00:00", end: "2026-08-07 23:59:59" });
});

test("does not materialize unrequested spot fund flow filter fields", () => {
  const selection: PageModelEvidenceSelection = {
    schemaVersion: "page-model-evidence-selection.v1",
    request: "\u767b\u5f55demo test\u73af\u5883\uff0c\u8fdb\u5165\u73b0\u8d27\u6d41\u6c34\u9875\u9762\uff0c\u5e01\u79cd\u4e0b\u62c9\u6846\u9009\u62e9\"ETH\"\u8fdb\u884c\u67e5\u8be2\uff0c\u671f\u671b\u5217\u8868\u8fd4\u56de\u7a7a",
    intent: {
      project: "demo",
      env: "test",
      module: "asset",
      action: "spot_fund_flow_filter",
      operationType: "read",
      loginRequired: true,
      data: { account: "spot", asset: "ETH" },
      intentConfidence: 0.9,
      evidence: ["fixture"]
    },
    selectedEvidence: [
      evidence("page", "demo.funds.spot_fund_flow", "demo.funds.spot_fund_flow", "\u73b0\u8d27\u8d44\u91d1\u6d41\u6c34"),
      {
        ...evidence("element", "w3.spot_fund_flow.asset_filter", "demo.funds.spot_fund_flow", "\u5e01\u79cd\u7b5b\u9009\u63a7\u4ef6"),
        role: "filter",
        targetField: "asset"
      },
      {
        ...evidence("element", "w3.spot_fund_flow.asset_filter.option.eth", "demo.funds.spot_fund_flow", "\u5e01\u79cd\u7b5b\u9009\u9009\u9879:ETH"),
        role: "option",
        targetField: "asset",
        optionValue: "ETH",
        locatorCandidates: [{ strategy: "role_option_name", value: "ETH" }]
      },
      {
        ...evidence("element", "w3.spot_fund_flow.type_filter", "demo.funds.spot_fund_flow", "\u7c7b\u578b\u7b5b\u9009\u63a7\u4ef6"),
        role: "filter",
        targetField: "record_type"
      },
      {
        ...evidence("element", "w3.spot_fund_flow.type_filter.option.\u5185\u90e8\u8f6c\u5165", "demo.funds.spot_fund_flow", "\u7c7b\u578b\u7b5b\u9009\u9009\u9879:\u5185\u90e8\u8f6c\u5165"),
        role: "option",
        targetField: "record_type",
        optionValue: "\u5185\u90e8\u8f6c\u5165",
        locatorCandidates: [{ strategy: "role_option_name", value: "\u5185\u90e8\u8f6c\u5165" }]
      },
      {
        ...evidence("element", "w3.spot_fund_flow.query_button", "demo.funds.spot_fund_flow", "\u67e5\u8be2\u6309\u94ae"),
        role: "button",
        locatorCandidates: [{ strategy: "text", value: "\u67e5\u8be2" }]
      }
    ],
    fallbackEvidence: [
      evidence("assertion", "w3.spot_fund_flow.empty_state_visible", "demo.funds.spot_fund_flow", "\u7a7a\u72b6\u6001\u53ef\u89c1")
    ],
    excludedEvidence: [],
    gaps: [],
    blockingGaps: [],
    readiness: "ready",
    executable: true,
    reason: "fixture"
  };
  const userAssertions = parseUserAssertions({ request: selection.request, selection });
  const result = buildAutomationCaseFromPageModel({ selection, userAssertions, caseId: "spot_fund_flow_asset_eth_empty" });

  assert.equal(result.executable, true);
  assert.ok(result.case.steps.some((step) => (step as Record<string, unknown>).elementId === "w3.spot_fund_flow.asset_filter.option.eth"));
  assert.equal(result.case.steps.some((step) => String((step as Record<string, unknown>).elementId).includes("type_filter")), false);
  const assetStep = result.case.steps.find((step) => (step as Record<string, unknown>).elementId === "w3.spot_fund_flow.asset_filter.option.eth") as Record<string, any>;
  assert.equal(assetStep.dataBinding.targetField, "asset");
  assert.equal(assetStep.dataBinding.expectedValue, "ETH");
  const assertionStep = result.case.steps.find((step) => step.action === "assert") as Record<string, any>;
  assert.equal(assertionStep.assertion.type, "result_empty");
});

test("does not materialize legacy transfer-record helpers for ordinary spot fund flow type filtering", () => {
  const selection: PageModelEvidenceSelection = {
    schemaVersion: "page-model-evidence-selection.v1",
    request: "\u767b\u5f55demo test\u73af\u5883\uff0c\u8fdb\u5165\u73b0\u8d27\u6d41\u6c34\u9875\u9762\uff0c\u901a\u8fc7\u7c7b\u578b\u9009\u62e9\u8d60\u5e01\u8fdb\u884c\u641c\u7d22",
    intent: {
      project: "demo",
      env: "test",
      module: "asset",
      action: "spot_fund_flow_filter",
      operationType: "read",
      loginRequired: true,
      data: { account: "spot", type: "\u8d60\u5e01", recordType: "\u8d60\u5e01" },
      intentConfidence: 0.9,
      evidence: ["fixture"]
    },
    selectedEvidence: [
      evidence("page", "demo.funds.spot_fund_flow", "demo.funds.spot_fund_flow", "\u73b0\u8d27\u8d44\u91d1\u6d41\u6c34"),
      {
        ...evidence("element", "t2_5.transfer_record.asset_filter", "demo.funds.spot_fund_flow", "\u5e01\u79cd\u7b5b\u9009\u63a7\u4ef6"),
        role: "filter",
        locatorCandidates: [{ strategy: "text", value: "\u5e01\u79cd / USDT" }]
      },
      {
        ...evidence("element", "t2_5.transfer_record.type_filter", "demo.funds.spot_fund_flow", "\u7c7b\u578b\u7b5b\u9009\u63a7\u4ef6"),
        role: "filter",
        locatorCandidates: [{ strategy: "text", value: "\u7c7b\u578b" }]
      },
      {
        ...evidence("element", "t2_5.transfer_record.transfer_type_option", "demo.funds.spot_fund_flow", "\u5212\u8f6c\u7c7b\u578b\u9009\u9879"),
        role: "option",
        locatorCandidates: [{ strategy: "role_option_name", value: "\u5212\u8f6c" }]
      },
      {
        ...evidence("element", "w3.spot_fund_flow.type_filter", "demo.funds.spot_fund_flow", "\u7c7b\u578b\u7b5b\u9009\u63a7\u4ef6"),
        role: "filter",
        targetField: "record_type",
        locatorCandidates: [{ strategy: "text", value: "\u5168\u90e8\u7c7b\u578b" }]
      },
      {
        ...evidence("element", "w3.spot_fund_flow.type_filter.option.\u8d60\u5e01", "demo.funds.spot_fund_flow", "\u7c7b\u578b\u7b5b\u9009\u9009\u9879:\u8d60\u5e01"),
        role: "option",
        targetField: "record_type",
        optionValue: "\u8d60\u5e01",
        locatorCandidates: [{ strategy: "role_option_name", value: "\u8d60\u5e01" }]
      },
      {
        ...evidence("element", "w3.spot_fund_flow.query_button", "demo.funds.spot_fund_flow", "\u67e5\u8be2\u6309\u94ae"),
        role: "button",
        locatorCandidates: [{ strategy: "role_button_name", value: "\u67e5\u8be2" }]
      }
    ],
    fallbackEvidence: [],
    excludedEvidence: [],
    gaps: [],
    blockingGaps: [],
    readiness: "ready",
    executable: true,
    reason: "fixture"
  };
  const result = buildAutomationCaseFromPageModel({
    selection,
    userAssertions: parseUserAssertions({ assertions: [], selection }),
    caseId: "spot_fund_flow_gift_filter_no_transfer_helpers"
  });

  assert.equal(result.executable, true);
  assert.equal(result.case.steps.some((step) => String((step as Record<string, unknown>).elementId).startsWith("t2_5.transfer_record")), false);
  assert.equal(result.case.steps.some((step) => (step as Record<string, unknown>).elementId === "w3.spot_fund_flow.type_filter.option.\u8d60\u5e01"), true);
});

test("uses direct spot fund flow page without materializing entry-page action buttons", () => {
  const selection: PageModelEvidenceSelection = {
    schemaVersion: "page-model-evidence-selection.v1",
    request: "\u767b\u5f55demo test\u73af\u5883\uff0c\u8fdb\u5165\u73b0\u8d27\u6d41\u6c34\u9875\u9762\uff0c\u7c7b\u578b\u9009\u62e9\u8d60\u5e01\u8fdb\u884c\u641c\u7d22",
    intent: {
      project: "demo",
      env: "test",
      module: "asset",
      action: "spot_fund_flow_filter",
      operationType: "read",
      loginRequired: true,
      data: { account: "spot", type: "\u8d60\u5e01", recordType: "\u8d60\u5e01" },
      intentConfidence: 0.9,
      evidence: ["fixture"]
    },
    selectedEvidence: [
      evidence("page", "demo.funds.spot_account", "demo.funds.spot_account", "\u73b0\u8d27\u8d26\u6237"),
      evidence("element", "p4.spot_account_clickable_37", "demo.funds.spot_account", "\u5145\u503c"),
      evidence("element", "p4.spot_account_clickable_39", "demo.funds.spot_account", "\u63d0\u73b0"),
      evidence("page", "demo.funds.spot_fund_flow", "demo.funds.spot_fund_flow", "\u73b0\u8d27\u8d44\u91d1\u6d41\u6c34"),
      {
        ...evidence("element", "w3.spot_fund_flow.type_filter", "demo.funds.spot_fund_flow", "\u7c7b\u578b\u7b5b\u9009\u63a7\u4ef6"),
        role: "filter",
        targetField: "record_type",
        locatorCandidates: [{ strategy: "text", value: "\u5168\u90e8\u7c7b\u578b" }]
      },
      {
        ...evidence("element", "w3.spot_fund_flow.type_filter.option.\u8d60\u5e01", "demo.funds.spot_fund_flow", "\u7c7b\u578b\u7b5b\u9009\u9009\u9879:\u8d60\u5e01"),
        role: "option",
        targetField: "record_type",
        optionValue: "\u8d60\u5e01",
        locatorCandidates: [{ strategy: "role_option_name", value: "\u8d60\u5e01" }]
      },
      {
        ...evidence("element", "w3.spot_fund_flow.query_button", "demo.funds.spot_fund_flow", "\u67e5\u8be2\u6309\u94ae"),
        role: "button",
        locatorCandidates: [{ strategy: "role_button_name", value: "\u67e5\u8be2" }]
      }
    ],
    fallbackEvidence: [],
    excludedEvidence: [],
    gaps: [],
    blockingGaps: [],
    readiness: "ready",
    executable: true,
    reason: "fixture"
  };
  const result = buildAutomationCaseFromPageModel({
    selection,
    userAssertions: parseUserAssertions({ assertions: [], selection }),
    caseId: "spot_fund_flow_direct_target_no_entry_actions"
  });

  assert.equal(result.executable, true);
  assert.equal(result.case.steps.some((step) => String((step as Record<string, unknown>).elementId).startsWith("p4.spot_account")), false);
  assert.equal(result.case.steps.filter((step) => step.action === "navigate").length, 1);
});

test("carries dropdown option inventory and selected-value signal into select DSL", () => {
  const selection: PageModelEvidenceSelection = {
    schemaVersion: "page-model-evidence-selection.v1",
    request: "进入理财流水，交易类型选择申购进行查询",
    intent: {
      project: "demo",
      env: "test",
      module: "asset",
      action: "earn_fund_flow_filter",
      operationType: "read",
      loginRequired: true,
      data: { account: "earn", recordType: "申购" },
      intentConfidence: 0.9,
      evidence: ["fixture"]
    },
    selectedEvidence: [
      evidence("page", "demo.funds.earn_fund_flow", "demo.funds.earn_fund_flow", "理财流水"),
      {
        ...evidence("element", "funds.earn_fund_flow.transaction_type_filter", "demo.funds.earn_fund_flow", "理财流水类型下拉框"),
        controlType: "dropdown",
        targetField: "record_type",
        locatorCandidates: [
          { strategy: "field_relative_control", value: "fieldRelative=scope:dialog|label:交易类型|role:combobox|relation:following_control" },
          { strategy: "scoped_role_combobox_index", value: "css=main [role=\"combobox\"] >> nth=5" }
        ],
        dropdown: {
          trigger: [{ strategy: "field_relative_control", value: "fieldRelative=scope:dialog|label:交易类型|role:combobox|relation:following_control" }],
          currentValue: "全部类型",
          popupScope: "dropdown_layer",
          optionInventory: ["全部类型", "交易", "申购"],
          selectionAction: "click_option",
          valuePersistenceSignal: "selected value visible in trigger"
        }
      },
      {
        ...evidence("element", "funds.earn_fund_flow.transaction_type_filter.option.申购", "demo.funds.earn_fund_flow", "理财流水类型下拉框选项：申购"),
        controlType: "dropdown_option",
        targetField: "record_type",
        optionValue: "申购",
        parentElementId: "funds.earn_fund_flow.transaction_type_filter"
      },
      {
        ...evidence("element", "funds.earn_fund_flow.query_button", "demo.funds.earn_fund_flow", "查询"),
        role: "button",
        locatorCandidates: [{ strategy: "role_button_name", value: "查询" }]
      }
    ],
    fallbackEvidence: [],
    excludedEvidence: [],
    gaps: [],
    blockingGaps: [],
    readiness: "ready",
    executable: true,
    reason: "fixture"
  };
  const result = buildAutomationCaseFromPageModel({
    selection,
    userAssertions: parseUserAssertions({ assertions: [], selection }),
    caseId: "earn_fund_flow_dropdown_contract_fixture"
  });

  assert.equal(result.executable, true);
  const selectStep = result.case.steps.find((step) => (step as Record<string, unknown>).elementId === "funds.earn_fund_flow.transaction_type_filter") as Record<string, any>;
  assert.equal(selectStep.action, "select");
  assert.equal(selectStep.target, "fieldRelative=scope:dialog|label:交易类型|role:combobox|relation:following_control");
  assert.equal(selectStep.component.optionDiscoveryMode, "static_visible");
  assert.deepEqual(selectStep.component.optionInventory, ["全部类型", "交易", "申购"]);
  assert.deepEqual(selectStep.component.triggerCandidates, [{ strategy: "field_relative_control", value: "fieldRelative=scope:dialog|label:交易类型|role:combobox|relation:following_control" }]);
  assert.equal(selectStep.component.currentValue, "全部类型");
  assert.equal(selectStep.component.valuePersistenceSignal, "selected value visible in trigger");
  assert.equal(selectStep.postconditions[0].expected, "申购");
});

test("materializes demo earn fund flow redeem alias as principal and earnings return option", () => {
  const selection: PageModelEvidenceSelection = {
    schemaVersion: "page-model-evidence-selection.v1",
    request: "进入理财流水，交易类型选择赎回进行查询",
    intent: {
      project: "demo",
      env: "test",
      module: "asset",
      action: "earn_fund_flow_filter",
      operationType: "read",
      loginRequired: true,
      data: { account: "earn", recordType: "赎回" },
      intentConfidence: 0.9,
      evidence: ["fixture"]
    },
    selectedEvidence: [
      evidence("page", "demo.funds.earn_fund_flow", "demo.funds.earn_fund_flow", "理财流水"),
      {
        ...evidence("element", "funds.earn_fund_flow.transaction_type_filter", "demo.funds.earn_fund_flow", "理财流水类型下拉框"),
        controlType: "dropdown",
        targetField: "record_type",
        locatorCandidates: [{ strategy: "scoped_role_combobox_index", value: "css=main [role=\"combobox\"] >> nth=5" }],
        dropdown: {
          trigger: [{ strategy: "scoped_role_combobox_index", value: "css=main [role=\"combobox\"] >> nth=5" }],
          currentValue: "全部类型",
          popupScope: "dropdown_layer",
          optionInventory: ["全部类型", "申购", "本金及收益返还"],
          selectionAction: "click_option",
          valuePersistenceSignal: "selected value visible in trigger"
        }
      },
      {
        ...evidence("element", "funds.earn_fund_flow.transaction_type_filter.option.本金及收益返还", "demo.funds.earn_fund_flow", "理财流水类型下拉框选项：本金及收益返还"),
        controlType: "dropdown_option",
        targetField: "record_type",
        optionValue: "本金及收益返还",
        parentElementId: "funds.earn_fund_flow.transaction_type_filter"
      },
      {
        ...evidence("element", "funds.earn_fund_flow.query_button", "demo.funds.earn_fund_flow", "查询"),
        role: "button",
        locatorCandidates: [{ strategy: "role_button_name", value: "查询" }]
      }
    ],
    fallbackEvidence: [],
    excludedEvidence: [],
    gaps: [],
    blockingGaps: [],
    readiness: "ready",
    executable: true,
    reason: "fixture"
  };
  const result = buildAutomationCaseFromPageModel({
    selection,
    userAssertions: parseUserAssertions({ assertions: [], selection }),
    caseId: "earn_fund_flow_redeem_alias_fixture"
  });
  const selectStep = result.case.steps.find((step) => (step as Record<string, unknown>).elementId === "funds.earn_fund_flow.transaction_type_filter") as Record<string, any>;

  assert.equal(result.executable, true);
  assert.equal(selectStep.value, "本金及收益返还");
  assert.equal(selectStep.dataBinding.expectedValue, "本金及收益返还");
  assert.equal(selectStep.dataBinding.validation, "matched");
  assert.equal(selectStep.postconditions[0].expected, "本金及收益返还");
});

test("blocks executable select DSL when dropdown component contract is incomplete", () => {
  const selection: PageModelEvidenceSelection = {
    schemaVersion: "page-model-evidence-selection.v1",
    request: "进入理财流水，交易类型选择申购进行查询",
    intent: {
      project: "demo",
      env: "test",
      module: "asset",
      action: "earn_fund_flow_filter",
      operationType: "read",
      loginRequired: true,
      data: { account: "earn", recordType: "申购" },
      intentConfidence: 0.9,
      evidence: ["fixture"]
    },
    selectedEvidence: [
      evidence("page", "demo.funds.earn_fund_flow", "demo.funds.earn_fund_flow", "理财流水"),
      {
        ...evidence("element", "funds.earn_fund_flow.transaction_type_filter", "demo.funds.earn_fund_flow", "理财流水类型下拉框"),
        controlType: "dropdown",
        targetField: "record_type",
        locatorCandidates: [{ strategy: "scoped_role_combobox_index", value: "css=main [role=\"combobox\"] >> nth=5" }],
        dropdown: { popupScope: "dropdown_layer" }
      },
      {
        ...evidence("element", "funds.earn_fund_flow.query_button", "demo.funds.earn_fund_flow", "查询"),
        role: "button",
        locatorCandidates: [{ strategy: "role_button_name", value: "查询" }]
      }
    ],
    fallbackEvidence: [],
    excludedEvidence: [],
    gaps: [],
    blockingGaps: [],
    readiness: "ready",
    executable: true,
    reason: "fixture"
  };
  const result = buildAutomationCaseFromPageModel({
    selection,
    userAssertions: parseUserAssertions({ assertions: [], selection }),
    caseId: "earn_fund_flow_dropdown_incomplete_contract_fixture"
  });

  assert.equal(result.executable, false);
  assert.ok(result.gaps.some((gap) => gap.startsWith("dropdown_component_missing_option_discovery:")));
  assert.ok(result.gaps.some((gap) => gap.startsWith("dropdown_component_missing_selected_value_signal:")));
});

test("reports targeted recollection gap when searchable dropdown has not verified requested option", () => {
  const selection: PageModelEvidenceSelection = {
    schemaVersion: "page-model-evidence-selection.v1",
    request: "进入现货流水，币种选择 ETH 查询",
    intent: {
      project: "demo",
      env: "test",
      module: "asset",
      action: "spot_fund_flow_filter",
      operationType: "read",
      loginRequired: true,
      data: { account: "spot", asset: "ETH" },
      intentConfidence: 0.9,
      evidence: ["fixture"]
    },
    selectedEvidence: [
      evidence("page", "demo.funds.spot_fund_flow", "demo.funds.spot_fund_flow", "现货流水"),
      {
        ...evidence("element", "funds.spot_fund_flow.asset_filter", "demo.funds.spot_fund_flow", "现货流水币种下拉框"),
        controlType: "dropdown",
        targetField: "asset",
        locatorCandidates: [{ strategy: "scoped_role_combobox_index", value: "css=main [role=\"combobox\"] >> nth=0" }],
        dropdown: {
          popupScope: "dropdown_layer",
          optionDiscoveryMode: "searchable_local",
          searchInput: "[role='listbox'] input",
          optionInventory: ["USDT", "USDC"],
          sampledOptions: ["USDT", "USDC"],
          verifiedOptions: ["USDT"],
          coverageMode: "sampled",
          selectedValueSignal: "selected value visible in trigger"
        }
      },
      {
        ...evidence("element", "funds.spot_fund_flow.query_button", "demo.funds.spot_fund_flow", "查询"),
        role: "button",
        locatorCandidates: [{ strategy: "role_button_name", value: "查询" }]
      }
    ],
    fallbackEvidence: [],
    excludedEvidence: [],
    gaps: [],
    blockingGaps: [],
    readiness: "ready",
    executable: true,
    reason: "fixture"
  };
  const result = buildAutomationCaseFromPageModel({
    selection,
    userAssertions: parseUserAssertions({ assertions: [], selection }),
    caseId: "spot_fund_flow_asset_eth_targeted_recollection_fixture"
  });

  assert.equal(result.executable, false);
  assert.ok(result.gaps.some((gap) => gap === "dropdown_component_target_option_not_verified:funds.spot_fund_flow.asset_filter:ETH"));
});

test("materializes fund flow reset after query when reset is requested", () => {
  const selection: PageModelEvidenceSelection = {
    schemaVersion: "page-model-evidence-selection.v1",
    request: "进入现货流水页面，类型选择红包发放进行搜索，然后点击重置，期望类型筛选条件被清空",
    intent: {
      project: "demo",
      env: "test",
      module: "asset",
      action: "spot_fund_flow_filter",
      operationType: "read",
      loginRequired: true,
      data: { account: "spot", type: "红包发放", recordType: "红包发放", resetRequested: true },
      intentConfidence: 0.9,
      evidence: ["fixture"]
    },
    selectedEvidence: [
      evidence("page", "demo.funds.spot_fund_flow", "demo.funds.spot_fund_flow", "现货流水"),
      {
        ...evidence("element", "funds.spot_fund_flow.type_filter", "demo.funds.spot_fund_flow", "现货流水类型下拉框"),
        controlType: "dropdown",
        targetField: "record_type",
        locatorCandidates: [{ strategy: "scoped_role_combobox_index", value: "css=main [role=\"combobox\"] >> nth=4" }],
        dropdown: {
          popupScope: "dropdown_layer",
          optionDiscoveryMode: "static_visible",
          optionInventory: ["全部类型", "红包发放"],
          verifiedOptions: ["红包发放"],
          coverageMode: "complete",
          selectedValueSignal: "selected value visible in trigger"
        }
      },
      {
        ...evidence("element", "funds.spot_fund_flow.type_filter.option.红包发放", "demo.funds.spot_fund_flow", "现货流水类型下拉框选项：红包发放"),
        controlType: "dropdown_option",
        targetField: "record_type",
        optionValue: "红包发放",
        locatorCandidates: [{ strategy: "text_exact", value: "textExact=红包发放" }]
      },
      {
        ...evidence("element", "funds.spot_fund_flow.query_button", "demo.funds.spot_fund_flow", "查询"),
        role: "button",
        locatorCandidates: [{ strategy: "role_button_name", value: "role=button:查询" }]
      },
      {
        ...evidence("element", "funds.spot_fund_flow.reset_button", "demo.funds.spot_fund_flow", "重置"),
        role: "button",
        semanticRole: "reset_button",
        targetField: "action",
        locatorCandidates: [{ strategy: "role_button_name", value: "role=button:重置" }]
      }
    ],
    fallbackEvidence: [
      evidence("assertion", "funds.spot_fund_flow.observable.type_filter_selected_value", "demo.funds.spot_fund_flow", "现货流水类型下拉框已选值可观察")
    ],
    excludedEvidence: [],
    gaps: [],
    blockingGaps: [],
    readiness: "ready",
    executable: true,
    reason: "fixture"
  };
  const result = buildAutomationCaseFromPageModel({
    selection,
    userAssertions: parseUserAssertions({ assertions: ["类型筛选条件被清空"], selection }),
    caseId: "spot_fund_flow_reset_filter_fixture"
  });
  const ids = result.case.steps.map((step) => step.id);
  assert.ok(ids.indexOf("click-funds-spot_fund_flow-query_button") < ids.indexOf("click-funds-spot_fund_flow-reset_button"));
  assert.ok(result.case.steps.some((step) => step.id === "click-funds-spot_fund_flow-reset_button"));
  const assertionStep = result.case.steps.find((step) => step.action === "assert");
  assert.equal(assertionStep?.assertion?.type, "textVisibleAny");
  assert.deepEqual(assertionStep?.assertion?.expected, ["全部类型"]);
  assert.equal(result.executable, true);
});

test("materializes explicit page message assertion instead of generic write success assertion", () => {
  const selection: PageModelEvidenceSelection = {
    schemaVersion: "page-model-evidence-selection.v1",
    request: "\u767b\u5f55 demo test \u73af\u5883\uff0c\u8fdb\u5165\u8d44\u4ea7\u4e2d\u5fc3-\u63d0\u73b0-\u5730\u5740\u7ba1\u7406\u9875\u9762\uff0cUID\u8f93\u516514605\uff0c\u70b9\u51fb\u4fdd\u5b58\u5730\u5740\uff0c\u5b8c\u6210\u53cc\u9a8c\u8bc1\u540e\u671f\u671b\u63d0\u793a\"\u64cd\u4f5c\u5931\u8d25\"",
    intent: {
      project: "demo",
      env: "test",
      module: "asset",
      action: "withdraw_address_add_internal",
      operationType: "write",
      loginRequired: true,
      data: { uid: "14605" },
      intentConfidence: 0.9,
      evidence: ["fixture"]
    },
    selectedEvidence: [
      evidence("page", "demo.funds.withdraw.address_management", "demo.funds.withdraw.address_management", "\u63d0\u73b0-\u5730\u5740\u7ba1\u7406"),
      evidence("element", "withdraw.address.add_button", "demo.funds.withdraw.address_management", "\u6dfb\u52a0\u5730\u5740"),
      evidence("element", "withdraw.address.internal_tab", "demo.funds.withdraw.address_management", "\u7ad9\u5185\u5730\u5740"),
      evidence("element", "withdraw.address.uid_input", "demo.funds.withdraw.address_management", "\u6536\u6b3eUID"),
      evidence("element", "withdraw.address.save_button", "demo.funds.withdraw.address_management", "\u4fdd\u5b58\u5730\u5740")
    ],
    fallbackEvidence: [
      evidence("assertion", "withdraw.address.success_toast", "demo.funds.withdraw.address_management", "\u64cd\u4f5c\u6210\u529f\u63d0\u793a")
    ],
    excludedEvidence: [],
    gaps: [],
    blockingGaps: [],
    readiness: "ready",
    executable: true,
    reason: "fixture"
  };
  const userAssertions = parseUserAssertions({ request: selection.request, selection });
  const result = buildAutomationCaseFromPageModel({ selection, userAssertions, caseId: "withdraw_internal_address_message_assertion" });
  const assertSteps = result.case.steps.filter((step) => step.action === "assert") as Array<Record<string, any>>;

  assert.equal(result.executable, true);
  assert.equal(assertSteps.length, 1);
  assert.equal(assertSteps[0].assertion.type, "message_visible_exact");
  assert.equal(assertSteps[0].assertion.expected, "\u64cd\u4f5c\u5931\u8d25");
  assert.equal(assertSteps[0].assertion.observeWindowMs, 3000);
  assert.equal(assertSteps[0].assertion.matchMode, "normalized_exact");
});

test("materializes explicit page message assertion with matching Page Model message signal", () => {
  const selection: PageModelEvidenceSelection = {
    schemaVersion: "page-model-evidence-selection.v1",
    request: "登录 demo test 环境，进入红包页面，红包口令输入 AUTO_TEST_INVALID_20260807_001，点击领取，页面提示红包口令无效或领取失败。",
    intent: {
      project: "demo",
      env: "test",
      module: "red-packet",
      action: "claim_red_packet",
      operationType: "write",
      loginRequired: true,
      data: { passphrase: "AUTO_TEST_INVALID_20260807_001" },
      intentConfidence: 0.9,
      evidence: ["fixture"]
    },
    selectedEvidence: [
      evidence("page", "demo.funds.red_packet", "demo.funds.red_packet", "资产中心-红包"),
      {
        ...evidence("element", "funds.red_packet.claim.passphrase_input", "demo.funds.red_packet", "红包领取口令输入框"),
        controlType: "input",
        targetField: "passphrase",
        locatorCandidates: [{ strategy: "placeholder", value: "输入红包口令" }]
      },
      {
        ...evidence("element", "funds.red_packet.claim.claim_button", "demo.funds.red_packet", "领取红包按钮"),
        controlType: "button",
        targetField: "action",
        locatorCandidates: [{ strategy: "role_button_name", value: "领取" }]
      },
      {
        ...evidence("element", "funds.red_packet.claim.detail_modal.claim_button", "demo.funds.red_packet", "红包详情弹窗领取按钮"),
        controlType: "button",
        targetField: "action",
        locatorCandidates: [{ strategy: "css", value: "button[class*='goldCoin']" }]
      },
      {
        ...evidence("assertion", "funds.red_packet.claim.invalid_passphrase_failure_message", "demo.funds.red_packet", "红包错误口令领取失败提示"),
        assertionType: "message_visible_exact",
        textCandidates: ["红包口令无效或领取失败", "口令错误", "领取失败"]
      }
    ],
    fallbackEvidence: [],
    excludedEvidence: [],
    gaps: [],
    blockingGaps: [],
    readiness: "ready",
    executable: true,
    reason: "fixture"
  };
  const userAssertions = parseUserAssertions({ assertions: ["页面提示红包口令无效或领取失败。"], selection });
  const result = buildAutomationCaseFromPageModel({ selection, userAssertions, caseId: "red_packet_invalid_passphrase_message_assertion" });
  const assertionStep = result.case.steps.find((step) => step.action === "assert") as Record<string, any>;

  assert.equal(result.executable, true);
  assert.equal(result.case.steps.some((step) => (step as Record<string, unknown>).elementId === "funds.red_packet.claim.detail_modal.claim_button"), false);
  assert.equal(assertionStep.assertionId, "funds.red_packet.claim.invalid_passphrase_failure_message");
  assert.equal(assertionStep.assertion.type, "message_visible_exact");
  assert.equal(assertionStep.assertion.expected, "红包口令无效或领取失败");
});

test("does not materialize red packet detail claim button for invalid passphrase failure", () => {
  const selection: PageModelEvidenceSelection = {
    schemaVersion: "page-model-evidence-selection.v1",
    request: "登录 demo test 环境，用例标题：红包-错误口令领取失败。业务步骤：进入红包页面，红包口令输入 AUTO_TEST_INVALID_20260807_001，点击领取。期望断言：页面出现红包错误口令领取失败提示。",
    intent: {
      project: "demo",
      env: "test",
      module: "red-packet",
      action: "claim_red_packet",
      operationType: "write",
      loginRequired: true,
      data: { passphrase: "AUTO_TEST_INVALID_20260807_001" },
      intentConfidence: 0.9,
      evidence: ["fixture"]
    },
    selectedEvidence: [
      evidence("page", "demo.funds.red_packet", "demo.funds.red_packet", "资产中心-红包"),
      {
        ...evidence("element", "funds.red_packet.claim.passphrase_input", "demo.funds.red_packet", "红包领取口令输入框"),
        controlType: "input",
        targetField: "passphrase"
      },
      {
        ...evidence("element", "funds.red_packet.claim.claim_button", "demo.funds.red_packet", "领取红包按钮"),
        controlType: "button",
        targetField: "action"
      },
      {
        ...evidence("element", "funds.red_packet.claim.detail_modal.claim_button", "demo.funds.red_packet", "红包详情弹窗领取按钮"),
        controlType: "button",
        targetField: "action"
      }
    ],
    fallbackEvidence: [
      {
        ...evidence("assertion", "funds.red_packet.claim.nonexistent_passphrase_error_message", "demo.funds.red_packet", "红包口令不存在提示"),
        assertionType: "api_message_exact",
        textCandidates: ["红包口令错误"]
      }
    ],
    excludedEvidence: [],
    gaps: [],
    blockingGaps: [],
    readiness: "ready",
    executable: true,
    reason: "fixture"
  };
  const userAssertions = parseUserAssertions({
    assertions: ["页面出现红包错误口令领取失败提示。"],
    selection
  });
  const result = buildAutomationCaseFromPageModel({ selection, userAssertions, caseId: "red_packet_invalid_passphrase_fixture" });

  assert.equal(result.executable, true);
  assert.ok(result.case.steps.some((step) => (step as Record<string, unknown>).elementId === "funds.red_packet.claim.passphrase_input"));
  assert.ok(result.case.steps.some((step) => (step as Record<string, unknown>).elementId === "funds.red_packet.claim.claim_button"));
  assert.equal(result.case.steps.some((step) => (step as Record<string, unknown>).elementId === "funds.red_packet.claim.detail_modal.claim_button"), false);
  const assertionStep = result.case.steps.find((step) => step.action === "assert") as Record<string, any>;
  assert.equal(assertionStep.assertionId, "funds.red_packet.claim.nonexistent_passphrase_error_message");
  assert.equal(assertionStep.assertion.type, "message_visible_exact");
  assert.equal(assertionStep.assertion.expected, "红包口令错误");
});

test("materializes DeepSeek message assertion without quoted expected text", () => {
  const selection: PageModelEvidenceSelection = {
    schemaVersion: "page-model-evidence-selection.v1",
    request: "\u767b\u5f55 demo test \u73af\u5883\uff0c\u8fdb\u5165\u8d44\u4ea7\u4e2d\u5fc3-\u63d0\u73b0-\u5730\u5740\u7ba1\u7406\u9875\u9762\uff0cUID\u8f93\u516514595\uff0c\u671f\u671b\u63d0\u793a\u8be5\u8d26\u53f7\u5df2\u5b58\u5728",
    intent: {
      project: "demo",
      env: "test",
      module: "asset",
      action: "withdraw_address_add_internal",
      operationType: "write",
      loginRequired: true,
      data: { uid: "14595" },
      intentConfidence: 0.9,
      evidence: ["fixture"]
    },
    selectedEvidence: [
      evidence("page", "demo.funds.withdraw.address_management", "demo.funds.withdraw.address_management", "\u63d0\u73b0-\u5730\u5740\u7ba1\u7406")
    ],
    fallbackEvidence: [],
    excludedEvidence: [],
    gaps: [],
    blockingGaps: [],
    readiness: "ready",
    executable: true,
    reason: "fixture"
  };
  const userAssertions = parseUserAssertions({
    request: selection.request,
    selection,
    deepSeekIntent: {
      assertions: [
        {
          sourceText: "\u671f\u671b\u63d0\u793a\u8be5\u8d26\u53f7\u5df2\u5b58\u5728",
          targetObject: "message",
          operator: "visible_exact",
          expected: "\u8be5\u8d26\u53f7\u5df2\u5b58\u5728",
          confidence: 0.9
        }
      ]
    }
  });
  const result = buildAutomationCaseFromPageModel({ selection, userAssertions, caseId: "withdraw_internal_address_deepseek_message_assertion" });
  const assertionStep = result.case.steps.find((step) => step.action === "assert") as Record<string, any>;

  assert.equal(result.executable, true);
  assert.equal(assertionStep.assertion.type, "message_visible_exact");
  assert.equal(assertionStep.assertion.expected, "\u8be5\u8d26\u53f7\u5df2\u5b58\u5728");
  assert.equal(assertionStep.assertion.intent.source, "deepseek_intent");
});

test("materializes earn redeem with row-scoped locator before amount and confirm", () => {
  const selection: PageModelEvidenceSelection = {
    schemaVersion: "page-model-evidence-selection.v1",
    request: "登录 demo test 环境，进入资产中心-理财账户，赎回5SOL，期望出现弹窗提示赎回成功",
    intent: {
      project: "demo",
      env: "test",
      module: "asset",
      action: "earn_redeem",
      operationType: "write",
      loginRequired: true,
      data: { asset: "SOL", amount: 5 },
      intentConfidence: 0.9,
      evidence: ["fixture"]
    },
    selectedEvidence: [
      {
        ...evidence("page", "demo.funds.finance_account", "demo.funds.finance_account", "资产中心-理财账户"),
        url: "http://www.example.com/zh-hans/assets/earn"
      },
      {
        ...evidence("element", "finance_account.row_action.redeem", "demo.funds.finance_account", "理财账户目标币种行内赎回按钮"),
        role: "button",
        controlType: "button",
        semanticRole: "row_action_button",
        targetField: "action",
        locatorCandidates: [
          { strategy: "xpath", value: "xpath=//tr[contains(normalize-space(.), '{asset}')]//button[normalize-space()='赎回']" },
          { strategy: "text", value: "赎回" }
        ]
      },
      {
        ...evidence("element", "finance_account.redeem.amount_input", "demo.funds.finance_account", "理财赎回数量输入框"),
        role: "textbox",
        controlType: "input",
        semanticRole: "amount_input",
        targetField: "amount",
        locatorCandidates: [{ strategy: "css", value: "[role='dialog'] input[placeholder*='最小赎回']" }]
      },
      {
        ...evidence("element", "finance_account.redeem.confirm_button", "demo.funds.finance_account", "理财赎回弹窗确定按钮"),
        role: "button",
        controlType: "button",
        semanticRole: "submit_or_confirm",
        targetField: "action",
        locatorCandidates: [{ strategy: "role_button_name", value: "确定" }]
      }
    ],
    fallbackEvidence: [
      {
        ...evidence("assertion", "finance_account.redeem.success_message", "demo.funds.finance_account", "理财赎回成功提示"),
        textCandidates: ["赎回成功"]
      }
    ],
    excludedEvidence: [],
    gaps: [],
    blockingGaps: [],
    readiness: "ready",
    executable: true,
    reason: "fixture"
  };
  const userAssertions = parseUserAssertions({ request: selection.request, selection });
  const result = buildAutomationCaseFromPageModel({ selection, userAssertions, caseId: "earn_redeem_sol_fixture" });
  const steps = result.case.steps as Array<Record<string, any>>;

  assert.equal(result.executable, true);
  assert.deepEqual(
    steps.filter((step) => step.action !== "assert").map((step) => step.id),
    [
      "open-demo-funds-finance_account",
      "click-finance_account-row_action-redeem",
      "input-finance_account-redeem-amount_input",
      "click-finance_account-redeem-confirm_button"
    ]
  );
  assert.equal(steps[1].primary_locator, "xpath=//tr[contains(normalize-space(.), 'SOL')]//button[normalize-space()='赎回']");
  assert.equal(steps[1].max_healing_level, 1);
  assert.equal(steps[2].value, 5);
});

test("does not materialize mismatched earn row action for a different requested asset", () => {
  const selection: PageModelEvidenceSelection = {
    schemaVersion: "page-model-evidence-selection.v1",
    request: "进入更多-理财页面，定位 zec 产品行，点击 zec右侧“申购”按钮，申购数量保持为空",
    intent: {
      project: "demo",
      env: "test",
      module: "asset",
      action: "earn_subscribe",
      operationType: "write",
      loginRequired: true,
      data: { asset: "ZEC", amountPolicy: "empty" },
      intentConfidence: 0.9,
      evidence: ["fixture"]
    },
    selectedEvidence: [
      {
        ...evidence("page", "demo.earn.product_center", "demo.earn.product_center", "更多-理财")
      },
      {
        ...evidence("element", "earn_product_center.product_list.sol_row_subscribe_button", "demo.earn.product_center", "SOL 产品行内申购按钮"),
        role: "button",
        controlType: "button",
        semanticRole: "row_action_button",
        targetField: "action",
        rowScope: { value: "SOL", actionText: "申购" },
        locatorCandidates: [{ strategy: "rowScoped", value: "rowScoped=value:SOL|actionText:申购" }],
        entityBindings: { asset: "SOL" }
      },
      {
        ...evidence("element", "earn_product_center.subscribe.amount_input", "demo.earn.product_center", "申购数量输入框"),
        role: "textbox",
        controlType: "input",
        targetField: "amount"
      }
    ],
    fallbackEvidence: [
      {
        ...evidence("assertion", "earn_product_center.subscribe.confirm_disabled", "demo.earn.product_center", "确认按钮置灰"),
        textCandidates: ["确认"]
      }
    ],
    excludedEvidence: [],
    gaps: ["earn_subscribe_row_action_for_asset:ZEC"],
    blockingGaps: ["earn_subscribe_row_action_for_asset:ZEC"],
    readiness: "partial",
    executable: false,
    reason: "fixture"
  };
  const userAssertions = parseUserAssertions({ request: selection.request, selection });
  const result = buildAutomationCaseFromPageModel({ selection, userAssertions, caseId: "earn_subscribe_zec_fixture" });

  assert.equal(result.executable, false);
  assert.equal(result.case.steps.some((step) => (step as Record<string, unknown>).elementId === "earn_product_center.product_list.sol_row_subscribe_button"), false);
});

test("materializes dynamic earn product row action with runtime asset and load-more expansion", () => {
  const selection: PageModelEvidenceSelection = {
    schemaVersion: "page-model-evidence-selection.v1",
    request: "进入更多-理财页面，定位 zec 产品行，点击 zec右侧“申购”按钮，申购数量保持为空，期望确认按钮置灰",
    intent: {
      project: "demo",
      env: "test",
      module: "asset",
      action: "earn_subscribe",
      operationType: "write",
      loginRequired: true,
      data: { asset: "ZEC", amountPolicy: "empty" },
      intentConfidence: 0.9,
      evidence: ["fixture"]
    },
    selectedEvidence: [
      evidence("page", "demo.earn.product_center", "demo.earn.product_center", "更多-理财"),
      {
        ...evidence("element", "earn_product_center.product_list.row_action.subscribe_by_asset", "demo.earn.product_center", "目标产品行内申购按钮"),
        role: "button",
        controlType: "button",
        semanticRole: "row_action_button",
        targetField: "action",
        rowScope: { field: "asset", valueSource: "intent.data.asset", actionText: "申购", expandText: "查看更多" },
        locatorCandidates: [{ strategy: "row_scoped_text", value: "row contains {asset} >> button text 申购" }]
      },
      {
        ...evidence("element", "earn_product_center.subscribe.amount_input", "demo.earn.product_center", "申购数量输入框"),
        role: "textbox",
        controlType: "input",
        targetField: "amount"
      }
    ],
    fallbackEvidence: [
      {
        ...evidence("assertion", "earn_product_center.subscribe.confirm_disabled", "demo.earn.product_center", "确认按钮置灰"),
        textCandidates: ["确认"]
      }
    ],
    excludedEvidence: [],
    gaps: [],
    blockingGaps: [],
    readiness: "ready",
    executable: true,
    reason: "fixture"
  };
  const userAssertions = parseUserAssertions({ request: selection.request, selection });
  const result = buildAutomationCaseFromPageModel({ selection, userAssertions, caseId: "earn_subscribe_zec_dynamic_fixture" });
  const clickStep = result.case.steps.find((step) =>
    (step as Record<string, unknown>).elementId === "earn_product_center.product_list.row_action.subscribe_by_asset" &&
    !(step as Record<string, unknown>).syntheticFromRowScopeExpansion
  ) as Record<string, unknown>;

  assert.equal(result.executable, true);
  assert.equal(clickStep.primary_locator, "rowScoped=asset:ZEC|actionText:申购|expandText:查看更多|match:exact");
});

test("materializes dynamic earn product row action with row conditions and enabled action state", () => {
  const selection: PageModelEvidenceSelection = {
    schemaVersion: "page-model-evidence-selection.v1",
    request: "进入更多-理财页面，点击查看更多，定位币种为 ZEC 且状态为进行中的活期理财产品行，点击右侧“申购”按钮，申购数量保持为空，期望确认按钮置灰",
    intent: {
      project: "demo",
      env: "test",
      module: "asset",
      action: "earn_subscribe",
      operationType: "write",
      loginRequired: true,
      data: { asset: "ZEC", amountPolicy: "empty" },
      intentConfidence: 0.9,
      evidence: ["fixture"]
    },
    selectedEvidence: [
      evidence("page", "demo.earn.product_center", "demo.earn.product_center", "更多-理财"),
      {
        ...evidence("element", "earn_product_center.product_list.row_action.subscribe_by_asset", "demo.earn.product_center", "目标产品行内申购按钮"),
        role: "button",
        controlType: "button",
        semanticRole: "row_action_button",
        targetField: "action",
        rowScope: {
          type: "rowWhere",
          rowWhere: { asset: "{asset}", status: "{status}" },
          actionText: "申购",
          actionState: "enabled",
          expandText: "查看更多",
          match: "exact"
        },
        locatorCandidates: [{ strategy: "rowScoped", value: "rowScoped=asset:{asset}|status:{status}|actionText:申购|actionState:enabled|expandText:查看更多|match:exact" }]
      },
      {
        ...evidence("element", "earn_product_center.subscribe.amount_input", "demo.earn.product_center", "申购数量输入框"),
        role: "textbox",
        controlType: "input",
        targetField: "amount"
      }
    ],
    fallbackEvidence: [
      {
        ...evidence("assertion", "earn_product_center.subscribe.confirm_disabled", "demo.earn.product_center", "确认按钮置灰"),
        textCandidates: ["确认"]
      }
    ],
    excludedEvidence: [],
    gaps: [],
    blockingGaps: [],
    readiness: "ready",
    executable: true,
    reason: "fixture"
  };
  const userAssertions = parseUserAssertions({ request: selection.request, selection });
  const result = buildAutomationCaseFromPageModel({ selection, userAssertions, caseId: "earn_subscribe_zec_row_conditions_fixture" });
  const clickStep = result.case.steps.find((step) =>
    (step as Record<string, unknown>).elementId === "earn_product_center.product_list.row_action.subscribe_by_asset" &&
    !(step as Record<string, unknown>).syntheticFromRowScopeExpansion
  ) as Record<string, unknown>;

  assert.equal(result.executable, true);
  assert.equal(clickStep.primary_locator, "rowScoped=asset:ZEC|status:进行中|actionText:申购|actionState:enabled|expandText:查看更多|match:exact");
});

test("does not click earn subscribe action for product list read assertion", () => {
  const selection: PageModelEvidenceSelection = {
    schemaVersion: "page-model-evidence-selection.v1",
    request: "进入理财产品中心页面，查看活期理财产品列表，期望产品列表展示币种为 USDT、产品名称为 USDT新理财、状态为进行中的产品行，并展示该行可点击的申购按钮",
    intent: {
      project: "demo",
      env: "test",
      module: "asset",
      action: "earn_product_view",
      operationType: "read",
      loginRequired: true,
      data: { asset: "USDT", status: "进行中", productName: "USDT新理财" },
      intentConfidence: 0.9,
      evidence: ["fixture"]
    },
    selectedEvidence: [
      evidence("page", "demo.earn.product_center", "demo.earn.product_center", "更多-理财"),
      {
        ...evidence("element", "earn_product_center.product_list.row_action.subscribe_by_asset", "demo.earn.product_center", "目标产品行内申购按钮"),
        role: "button",
        controlType: "button",
        semanticRole: "row_action_button",
        targetField: "action",
        rowScope: { type: "rowWhere", rowWhere: { asset: "{asset}", status: "{status}" }, actionText: "申购", actionState: "enabled" },
        locatorCandidates: [{ strategy: "rowScoped", value: "rowScoped=asset:{asset}|status:{status}|actionText:申购|actionState:enabled|match:exact" }]
      }
    ],
    fallbackEvidence: [
      {
        ...evidence("assertion", "earn_product_center.product_list.row_action_enabled", "demo.earn.product_center", "目标产品行申购按钮可点击"),
        assertionType: "element_enabled",
        targetElementId: "earn_product_center.product_list.row_action.subscribe_by_asset",
        textCandidates: ["申购"]
      },
      {
        ...evidence("assertion", "earn_product_center.subscribe.confirm_disabled", "demo.earn.product_center", "确认按钮置灰且不可点击"),
        assertionType: "element_disabled",
        targetElementId: "earn_product_center.subscribe.confirm_button",
        textCandidates: ["确定"]
      }
    ],
    excludedEvidence: [],
    gaps: [],
    blockingGaps: [],
    readiness: "ready",
    executable: true,
    reason: "fixture"
  };
  const userAssertions = parseUserAssertions({ request: selection.request, selection });
  const result = buildAutomationCaseFromPageModel({ selection, userAssertions, caseId: "earn_product_view_fixture" });

  assert.equal(result.executable, true);
  assert.equal(result.case.steps.some((step) => (step as Record<string, unknown>).elementId === "earn_product_center.product_list.row_action.subscribe_by_asset" && step.action === "click"), false);
  assert.ok(result.case.steps.some((step) => (step as Record<string, unknown>).assertionId === "earn_product_center.product_list.row_action_enabled"));
  assert.equal(result.case.steps.some((step) => (step as Record<string, unknown>).assertionId === "earn_product_center.subscribe.confirm_disabled"), false);
});

test("materializes explicitly requested earn product tabs and active tab assertion", () => {
  const selection: PageModelEvidenceSelection = {
    schemaVersion: "page-model-evidence-selection.v1",
    request: "进入更多-理财页面。点击定期理财产品标签。点击活期理财产品标签。",
    intent: {
      project: "demo",
      env: "test",
      module: "asset",
      action: "earn_product_view",
      operationType: "read",
      loginRequired: true,
      data: { productType: "活期理财", asset: "USDT", status: "进行中", productName: "USDT新理财" },
      intentConfidence: 0.9,
      evidence: ["fixture"]
    },
    selectedEvidence: [
      { ...evidence("page", "demo.earn.product_center", "demo.earn.product_center", "更多-理财"), url: "http://www.example.com/zh-hans/earn" },
      {
        ...evidence("element", "earn_product_center.product_type_tab.fixed", "demo.earn.product_center", "定期理财产品页签"),
        controlType: "tab",
        role: "tab",
        targetField: "product_type",
        optionValue: "定期理财",
        locatorCandidates: [{ strategy: "role_tab_or_button_text", value: "role=tab:定期|role=button:定期" }]
      },
      {
        ...evidence("element", "earn_product_center.product_type_tab.current", "demo.earn.product_center", "活期理财产品页签"),
        controlType: "tab",
        role: "tab",
        targetField: "product_type",
        optionValue: "活期理财",
        locatorCandidates: [{ strategy: "role_tab_or_button_text", value: "role=tab:活期|role=button:活期" }]
      }
    ],
    fallbackEvidence: [
      {
        ...evidence("assertion", "earn_product_center.product_type_tab.current_active", "demo.earn.product_center", "活期产品标签高亮"),
        assertionType: "element_enabled",
        targetElementId: "earn_product_center.product_type_tab.current"
      }
    ],
    excludedEvidence: [],
    gaps: [],
    blockingGaps: [],
    readiness: "ready",
    executable: true,
    reason: "fixture"
  };
  const userAssertions = parseUserAssertions({ assertions: ["“活期理财产品”标签处于选中/高亮状态。"], selection });
  const result = buildAutomationCaseFromPageModel({ selection, userAssertions, caseId: "earn_product_type_switch_fixture" });

  const clickTargets = result.case.steps.filter((step) => step.action === "click").map((step) => (step as Record<string, unknown>).elementId);
  assert.deepEqual(clickTargets, ["earn_product_center.product_type_tab.fixed", "earn_product_center.product_type_tab.current"]);
  const currentTabStep = result.case.steps.find((step) => (step as Record<string, unknown>).elementId === "earn_product_center.product_type_tab.current") as Record<string, unknown>;
  assert.equal(currentTabStep.primary_locator, "role=tab:活期");
  assert.deepEqual(currentTabStep.fallback_locators, ["role=button:活期"]);
  assert.equal(result.case.steps.some((step) => (step as Record<string, unknown>).assertionId === "earn_product_center.product_type_tab.current_active"), true);
});

test("does not click disabled confirm button for earn subscribe validation", () => {
  const selection: PageModelEvidenceSelection = {
    schemaVersion: "page-model-evidence-selection.v1",
    request: "进入更多-理财页面，定位 USDT 产品行，点击右侧申购按钮，输入 101 USDT，不点击确认，期望确定按钮置灰且不可点击",
    intent: {
      project: "demo",
      env: "test",
      module: "asset",
      action: "earn_subscribe",
      operationType: "write",
      loginRequired: true,
      data: { asset: "USDT", amount: 101 },
      intentConfidence: 0.9,
      evidence: ["fixture"]
    },
    selectedEvidence: [
      evidence("page", "demo.earn.product_center", "demo.earn.product_center", "更多-理财"),
      {
        ...evidence("element", "earn_product_center.product_list.row_action.subscribe_by_asset", "demo.earn.product_center", "目标产品行内申购按钮"),
        role: "button",
        controlType: "button",
        semanticRole: "row_action_button",
        targetField: "action",
        rowScope: { field: "asset", valueSource: "intent.data.asset", actionText: "申购" },
        locatorCandidates: [{ strategy: "rowScoped", value: "rowScoped=asset:{asset}|actionText:申购|match:exact" }]
      },
      {
        ...evidence("element", "earn_product_center.subscribe.amount_input", "demo.earn.product_center", "申购数量输入框"),
        role: "textbox",
        controlType: "input",
        targetField: "amount"
      },
      {
        ...evidence("element", "earn_product_center.subscribe.confirm_button", "demo.earn.product_center", "确定按钮"),
        role: "button",
        controlType: "button",
        targetField: "confirm",
        locatorCandidates: [{ strategy: "modal_text", value: "role=dialog >> text=确定" }]
      }
    ],
    fallbackEvidence: [
      {
        ...evidence("assertion", "earn_product_center.subscribe.confirm_disabled", "demo.earn.product_center", "确认按钮置灰"),
        assertionType: "element_disabled",
        targetElementId: "earn_product_center.subscribe.confirm_button",
        textCandidates: ["确定"]
      }
    ],
    excludedEvidence: [],
    gaps: [],
    blockingGaps: [],
    readiness: "ready",
    executable: true,
    reason: "fixture"
  };
  const userAssertions = parseUserAssertions({ request: selection.request, selection });
  const result = buildAutomationCaseFromPageModel({ selection, userAssertions, caseId: "earn_disabled_confirm_fixture" });

  assert.equal(result.executable, true);
  assert.ok(result.case.steps.some((step) => (step as Record<string, unknown>).elementId === "earn_product_center.product_list.row_action.subscribe_by_asset" && step.action === "click"));
  assert.ok(result.case.steps.some((step) => (step as Record<string, unknown>).elementId === "earn_product_center.subscribe.amount_input" && step.action === "input"));
  assert.equal(result.case.steps.some((step) => (step as Record<string, unknown>).elementId === "earn_product_center.subscribe.confirm_button" && step.action === "click"), false);
  assert.ok(result.case.steps.some((step) => (step as Record<string, unknown>).assertionId === "earn_product_center.subscribe.confirm_disabled"));
});

test("uses insufficient-balance disabled assertion instead of empty-amount disabled assertion", () => {
  const selection: PageModelEvidenceSelection = {
    schemaVersion: "page-model-evidence-selection.v1",
    request: "进入更多-理财页面，定位 USDT新理财 产品行，点击申购，输入 101 USDT，现货账户 USDT 余额为 0，期望确定按钮置灰且不可点击",
    intent: {
      project: "demo",
      env: "test",
      module: "asset",
      action: "earn_subscribe",
      operationType: "write",
      loginRequired: true,
      data: { asset: "USDT", amount: 101, productName: "USDT新理财" },
      intentConfidence: 0.9,
      evidence: ["fixture"]
    },
    selectedEvidence: [
      evidence("page", "demo.earn.product_center", "demo.earn.product_center", "更多-理财"),
      {
        ...evidence("element", "earn_product_center.product_list.row_action.subscribe_by_asset", "demo.earn.product_center", "目标产品行内申购按钮"),
        role: "button",
        controlType: "button",
        semanticRole: "row_action_button",
        targetField: "action",
        rowScope: { field: "asset", valueSource: "intent.data.asset", actionText: "申购" },
        locatorCandidates: [{ strategy: "rowScoped", value: "rowScoped=asset:{asset}|actionText:申购|match:exact" }]
      },
      {
        ...evidence("element", "earn_product_center.subscribe.amount_input", "demo.earn.product_center", "申购数量输入框"),
        role: "textbox",
        controlType: "input",
        targetField: "amount"
      }
    ],
    fallbackEvidence: [
      {
        ...evidence("assertion", "earn_product_center.subscribe.confirm_button_empty_amount_disabled", "demo.earn.product_center", "申购数量为空时确认按钮置灰且不可点击"),
        assertionType: "element_disabled",
        targetElementId: "earn_product_center.subscribe.confirm_button",
        targetStateId: "earn_product_center.subscribe.confirm_button.empty_amount_disabled",
        textCandidates: ["确定"]
      },
      {
        ...evidence("assertion", "earn_product_center.subscribe.confirm_button_insufficient_balance_disabled", "demo.earn.product_center", "USDT 余额不足时申购确认按钮置灰且不可点击"),
        assertionType: "element_disabled",
        targetElementId: "earn_product_center.subscribe.confirm_button",
        targetStateId: "earn_product_center.subscribe.confirm_button.insufficient_balance_disabled",
        textCandidates: ["余额不足", "现货账户 0.00 USDT", "确定"]
      }
    ],
    excludedEvidence: [],
    gaps: [],
    blockingGaps: [],
    readiness: "ready",
    executable: true,
    reason: "fixture"
  };
  const userAssertions = parseUserAssertions({ request: selection.request, selection });
  const result = buildAutomationCaseFromPageModel({ selection, userAssertions, caseId: "earn_insufficient_balance_disabled_fixture" });

  assert.equal(result.executable, true);
  assert.ok(result.case.steps.some((step) => (step as Record<string, unknown>).assertionId === "earn_product_center.subscribe.confirm_button_insufficient_balance_disabled"));
  assert.equal(result.case.steps.some((step) => (step as Record<string, unknown>).assertionId === "earn_product_center.subscribe.confirm_button_empty_amount_disabled"), false);
});

test("skips current tab and only clicks explicitly requested non-current tab", () => {
  const baseSelection: PageModelEvidenceSelection = {
    schemaVersion: "page-model-evidence-selection.v1",
    request: "进入更多-理财页面，查看活期理财产品列表",
    intent: {
      project: "demo",
      env: "test",
      module: "asset",
      action: "earn_product_view",
      operationType: "read",
      loginRequired: true,
      data: { productType: "活期理财" },
      intentConfidence: 0.9,
      evidence: ["fixture"]
    },
    selectedEvidence: [
      evidence("page", "demo.earn.product_center", "demo.earn.product_center", "更多-理财"),
      {
        ...evidence("element", "earn_product_center.product_type_tab.current", "demo.earn.product_center", "活期理财产品页签"),
        role: "tab",
        controlType: "tab",
        targetField: "product_type",
        optionValue: "活期理财"
      },
      {
        ...evidence("element", "earn_product_center.product_type_tab.fixed", "demo.earn.product_center", "定期理财产品页签"),
        role: "tab",
        controlType: "tab",
        targetField: "product_type",
        optionValue: "定期理财"
      }
    ],
    fallbackEvidence: [],
    excludedEvidence: [],
    gaps: [],
    blockingGaps: [],
    readiness: "ready",
    executable: true,
    reason: "fixture"
  };
  const currentResult = buildAutomationCaseFromPageModel({
    selection: baseSelection,
    userAssertions: parseUserAssertions({ assertions: [], selection: baseSelection }),
    caseId: "earn_current_tab_fixture"
  });
  assert.equal(currentResult.case.steps.some((step) => (step as Record<string, unknown>).elementId === "earn_product_center.product_type_tab.current"), false);
  assert.equal(currentResult.case.steps.some((step) => (step as Record<string, unknown>).elementId === "earn_product_center.product_type_tab.fixed"), false);

  const fixedSelection: PageModelEvidenceSelection = {
    ...baseSelection,
    request: "进入更多-理财页面，切换到定期理财产品列表",
    intent: { ...baseSelection.intent, data: { productType: "定期理财" } }
  };
  const fixedResult = buildAutomationCaseFromPageModel({
    selection: fixedSelection,
    userAssertions: parseUserAssertions({ assertions: [], selection: fixedSelection }),
    caseId: "earn_fixed_tab_fixture"
  });
  assert.equal(fixedResult.case.steps.some((step) => (step as Record<string, unknown>).elementId === "earn_product_center.product_type_tab.current"), false);
  assert.ok(fixedResult.case.steps.some((step) => (step as Record<string, unknown>).elementId === "earn_product_center.product_type_tab.fixed" && step.action === "click"));
});

test("materializes modal-scoped role locator into supported dialog text locator", () => {
  const selection: PageModelEvidenceSelection = {
    schemaVersion: "page-model-evidence-selection.v1",
    request: "进入更多-理财页面，定位 ZEC 产品行，点击右侧“申购”按钮，输入 101U，点击弹窗确定按钮",
    intent: {
      project: "demo",
      env: "test",
      module: "asset",
      action: "earn_subscribe",
      operationType: "write",
      loginRequired: true,
      data: { asset: "ZEC", amount: 101 },
      intentConfidence: 0.9,
      evidence: ["fixture"]
    },
    selectedEvidence: [
      evidence("page", "demo.earn.product_center", "demo.earn.product_center", "更多-理财"),
      {
        ...evidence("element", "earn_product_center.product_list.row_action.subscribe_by_asset", "demo.earn.product_center", "目标产品行内申购按钮"),
        role: "button",
        controlType: "button",
        semanticRole: "row_action_button",
        targetField: "action",
        rowScope: { field: "asset", valueSource: "intent.data.asset", actionText: "申购", expandText: "查看更多" },
        locatorCandidates: [{ strategy: "row_scoped_text", value: "row contains {asset} >> button text 申购" }]
      },
      {
        ...evidence("element", "earn_product_center.subscribe.amount_input", "demo.earn.product_center", "申购数量输入框"),
        role: "textbox",
        controlType: "input",
        targetField: "amount",
        locatorCandidates: [{ strategy: "modal_scoped_field", value: "fieldRelative=scope:dialog|label:申购数量|role:input" }]
      },
      {
        ...evidence("element", "earn_product_center.subscribe.confirm_button", "demo.earn.product_center", "申购弹窗确定按钮"),
        role: "button",
        controlType: "button",
        targetField: "submit",
        locatorCandidates: [{ strategy: "modal_scoped_role_text", value: "role=dialog:理财申购 >> role=button:确定" }]
      }
    ],
    fallbackEvidence: [],
    excludedEvidence: [],
    gaps: [],
    blockingGaps: [],
    readiness: "ready",
    executable: true,
    reason: "fixture"
  };
  const userAssertions = parseUserAssertions({ request: selection.request, selection });
  const result = buildAutomationCaseFromPageModel({ selection, userAssertions, caseId: "earn_subscribe_modal_locator_fixture" });
  const confirmStep = result.case.steps.find((step) => (step as Record<string, unknown>).elementId === "earn_product_center.subscribe.confirm_button") as Record<string, unknown>;

  assert.equal(result.executable, true);
  assert.equal(confirmStep.primary_locator, "[role='dialog'] >> text=确定");
  assert.equal(result.dslValidation.passed, true);
  assert.deepEqual(result.dslValidation.unsupportedLocators, []);
});

test("materializes stored scope dialog role locator syntax into supported dialog text locator", () => {
  const selection: PageModelEvidenceSelection = {
    schemaVersion: "page-model-evidence-selection.v1",
    request: "进入理财账户页面，定位 USDT 持仓行，点击申购，输入 2 USDT，点击确定",
    intent: {
      project: "demo",
      env: "test",
      module: "asset",
      action: "earn_subscribe",
      operationType: "write",
      loginRequired: true,
      data: { asset: "USDT", amount: 2 },
      intentConfidence: 0.9,
      evidence: ["fixture"]
    },
    selectedEvidence: [
      evidence("page", "demo.funds.finance_account", "demo.funds.finance_account", "资产中心-理财账户"),
      {
        ...evidence("element", "finance_account.row_action.subscribe", "demo.funds.finance_account", "理财账户目标币种行内申购按钮"),
        role: "button",
        controlType: "button",
        semanticRole: "row_action_button",
        targetField: "action",
        rowScope: { type: "rowWhere", rowWhere: { asset: "{asset}" }, actionText: "申购", actionState: "enabled", match: "exact" },
        locatorCandidates: [{ strategy: "rowScoped", value: "rowScoped=asset:{asset}|actionText:申购|actionState:enabled|match:exact" }]
      },
      {
        ...evidence("element", "finance_account.subscribe.amount_input", "demo.funds.finance_account", "理财申购数量输入框"),
        role: "textbox",
        controlType: "input",
        targetField: "amount",
        locatorCandidates: [{ strategy: "field_relative", value: "fieldRelative=scope:dialog|label:数量|role:input|relation:following_control" }]
      },
      {
        ...evidence("element", "finance_account.subscribe.confirm_button", "demo.funds.finance_account", "理财申购弹窗确认按钮"),
        role: "button",
        controlType: "button",
        targetField: "action",
        locatorCandidates: [{ strategy: "modal_scoped_role_text", value: "scope:dialog >> role=button:确定|确认" }]
      }
    ],
    fallbackEvidence: [],
    excludedEvidence: [],
    gaps: [],
    blockingGaps: [],
    readiness: "ready",
    executable: true,
    reason: "fixture"
  };
  const result = buildAutomationCaseFromPageModel({
    selection,
    userAssertions: parseUserAssertions({ assertions: [], selection }),
    caseId: "earn_subscribe_scope_dialog_locator_fixture"
  });
  const confirmStep = result.case.steps.find((step) => (step as Record<string, unknown>).elementId === "finance_account.subscribe.confirm_button") as Record<string, unknown>;

  assert.equal(result.executable, true);
  assert.equal(confirmStep.primary_locator, "[role='dialog'] >> text=确定");
  assert.deepEqual(result.dslValidation.unsupportedLocators, []);
});

test("materializes list-level button locator syntax into supported role locator", () => {
  const selection: PageModelEvidenceSelection = {
    schemaVersion: "page-model-evidence-selection.v1",
    request: "进入理财账户页面，点击批量赎回，断言批量赎回弹窗可见",
    intent: {
      project: "demo",
      env: "test",
      module: "asset",
      action: "earn_redeem",
      operationType: "write",
      loginRequired: true,
      data: {},
      intentConfidence: 0.9,
      evidence: ["fixture"]
    },
    selectedEvidence: [
      evidence("page", "demo.funds.finance_account", "demo.funds.finance_account", "资产中心-理财账户"),
      {
        ...evidence("element", "finance_account.batch_redeem.trigger", "demo.funds.finance_account", "理财账户列表级批量赎回按钮"),
        role: "button",
        controlType: "button",
        targetField: "action",
        locatorCandidates: [{ strategy: "list_level_button_text", value: "scope:finance_account.earn_position_table >> listLevel button text 赎回" }]
      }
    ],
    fallbackEvidence: [
      evidence("assertion", "finance_account.batch_redeem.modal_visible", "demo.funds.finance_account", "批量赎回弹窗可见")
    ],
    excludedEvidence: [],
    gaps: [],
    blockingGaps: [],
    readiness: "ready",
    executable: true,
    reason: "fixture"
  };
  const result = buildAutomationCaseFromPageModel({
    selection,
    userAssertions: parseUserAssertions({ assertions: [], selection }),
    caseId: "earn_batch_redeem_list_level_locator_fixture"
  });
  const triggerStep = result.case.steps.find((step) => (step as Record<string, unknown>).elementId === "finance_account.batch_redeem.trigger") as Record<string, unknown>;

  assert.equal(triggerStep.primary_locator, "role=button:赎回");
  assert.deepEqual(result.dslValidation.unsupportedLocators, []);
});

test("does not require targeted option verification when dropdown already shows requested current value", () => {
  const selection: PageModelEvidenceSelection = {
    schemaVersion: "page-model-evidence-selection.v1",
    request: "进入现货流水页面，币种下拉框选择 USDT，点击查询",
    intent: {
      project: "demo",
      env: "test",
      module: "asset",
      action: "spot_fund_flow_filter",
      operationType: "read",
      loginRequired: true,
      data: { account: "spot", asset: "USDT" },
      intentConfidence: 0.9,
      evidence: ["fixture"]
    },
    selectedEvidence: [
      evidence("page", "demo.funds.spot_fund_flow", "demo.funds.spot_fund_flow", "现货流水"),
      {
        ...evidence("element", "funds.spot_fund_flow.asset_filter", "demo.funds.spot_fund_flow", "现货流水币种下拉框"),
        controlType: "dropdown",
        targetField: "asset",
        locatorCandidates: [{ strategy: "scoped_role_combobox_index", value: "css=main [role=\"combobox\"] >> nth=0" }],
        dropdown: {
          currentValue: "USDT",
          optionInventory: ["USDT", "ETH"],
          verifiedOptions: ["ETH"],
          optionDiscoveryMode: "searchable_local",
          searchInput: "[role='listbox'] input",
          selectedValueSignal: "selected value visible in trigger"
        }
      },
      {
        ...evidence("element", "funds.spot_fund_flow.query_button", "demo.funds.spot_fund_flow", "查询"),
        role: "button",
        controlType: "button",
        locatorCandidates: [{ strategy: "role_button_name", value: "查询" }]
      }
    ],
    fallbackEvidence: [],
    excludedEvidence: [],
    gaps: [],
    blockingGaps: [],
    readiness: "ready",
    executable: true,
    reason: "fixture"
  };
  const result = buildAutomationCaseFromPageModel({
    selection,
    userAssertions: parseUserAssertions({ assertions: [], selection }),
    caseId: "spot_flow_current_value_fixture"
  });

  assert.equal(result.executable, true);
  assert.equal(result.gaps.some((gap) => gap.includes("dropdown_component_target_option_not_verified")), false);
});

test("normalizes modeled record type aliases to verified dropdown options", () => {
  const selection: PageModelEvidenceSelection = {
    schemaVersion: "page-model-evidence-selection.v1",
    request: "进入现货流水页面，币种选择 USDT，类型筛选充值，点击查询",
    intent: {
      project: "demo",
      env: "test",
      module: "asset",
      action: "spot_fund_flow_filter",
      operationType: "read",
      loginRequired: true,
      data: { account: "spot", asset: "USDT", type: "充值" },
      intentConfidence: 0.9,
      evidence: ["fixture"]
    },
    selectedEvidence: [
      {
        ...evidence("page", "demo.funds.spot_fund_flow", "demo.funds.spot_fund_flow", "现货流水"),
        fieldMappings: [
          {
            semanticField: "record_type",
            verifiedOptions: ["外部充值"],
            valueAliases: {
              DEPOSIT: ["外部充值", "充值", "链上充值"]
            }
          }
        ]
      },
      {
        ...evidence("element", "funds.spot_fund_flow.type_filter", "demo.funds.spot_fund_flow", "现货流水类型下拉框"),
        controlType: "dropdown",
        targetField: "record_type",
        locatorCandidates: [{ strategy: "scoped_role_combobox_index", value: "css=main [role=\"combobox\"] >> nth=4" }],
        dropdown: {
          currentValue: "全部类型",
          optionInventory: ["外部充值"],
          verifiedOptions: ["外部充值"],
          optionDiscoveryMode: "static_visible",
          selectedValueSignal: "selected value visible in trigger"
        }
      },
      {
        ...evidence("element", "funds.spot_fund_flow.query_button", "demo.funds.spot_fund_flow", "查询"),
        role: "button",
        controlType: "button",
        locatorCandidates: [{ strategy: "role_button_name", value: "查询" }]
      }
    ],
    fallbackEvidence: [],
    excludedEvidence: [],
    gaps: [],
    blockingGaps: [],
    readiness: "ready",
    executable: true,
    reason: "fixture"
  };
  const result = buildAutomationCaseFromPageModel({
    selection,
    userAssertions: parseUserAssertions({ assertions: [], selection }),
    caseId: "spot_flow_record_type_alias_fixture"
  });
  const selectStep = result.case.steps.find((step) => (step as Record<string, unknown>).elementId === "funds.spot_fund_flow.type_filter") as Record<string, unknown>;

  assert.equal(result.executable, true);
  assert.equal(selectStep.value, "外部充值");
  assert.equal(result.gaps.some((gap) => gap.includes("充值")), false);
});

function selectionFixture(): PageModelEvidenceSelection {
  return {
    schemaVersion: "page-model-evidence-selection.v1",
    request: "从现货账户划转 50 USDT 到合约账户，断言成功并在流水中出现记录",
    intent: {
      project: "demo",
      env: "test",
      module: "transfer",
      action: "spot_to_futures",
      operationType: "write",
      loginRequired: true,
      data: { asset: "USDT", amount: 50, fromAccount: "spot", toAccount: "futures" },
      intentConfidence: 0.84,
      evidence: ["fixture"]
    },
    selectedEvidence: [
      evidence("page", "demo.funds.transfer_entry", "demo.funds.transfer_entry", "划转弹窗/抽屉"),
      evidence("element", "t2.transfer.from_account_selector", "demo.funds.transfer_entry", "转出账户选择器"),
      evidence("element", "t2.transfer.to_account_selector", "demo.funds.transfer_entry", "转入账户选择器"),
      evidence("element", "t2.transfer.asset_selector", "demo.funds.transfer_entry", "币种选择器"),
      evidence("element", "t2.transfer.amount_input", "demo.funds.transfer_entry", "转入数量输入框"),
      evidence("element", "t2.transfer.submit_button", "demo.funds.transfer_entry", "划转提交按钮")
    ],
    fallbackEvidence: [
      evidence("assertion", "t2.transfer.submit_success", "demo.funds.transfer_entry", "划转提交成功提示"),
      evidence("assertion", "t2_5.transfer.record_50_usdt_spot_to_futures", "demo.funds.spot_fund_flow", "划转记录中出现 50 USDT 现货到合约记录")
    ],
    excludedEvidence: [{ id: "demo.funds.withdraw", pageId: "demo.funds.withdraw", reason: "unrelated" }],
    gaps: [],
    blockingGaps: [],
    readiness: "ready",
    executable: true,
    reason: "fixture"
  };
}

function evidence(kind: "page" | "element" | "assertion", id: string, pageId: string, semanticName: string) {
  return {
    kind,
    id,
    pageId,
    url: kind === "page" && pageId === "demo.funds.spot_fund_flow" ? "http://www.example.com/zh-hans/assets/flows/spot-flow" : undefined,
    semanticName,
    status: "execution_verified",
    confidence: 0.8,
    reason: "fixture",
    evidence: [{ source: "page_model", id, confidence: 0.8 }]
  };
}
