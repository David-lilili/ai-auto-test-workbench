import assert from "node:assert/strict";
import { test } from "node:test";
import { planPageModelExecutionFromStore } from "../src/core/page-model-execution-planner.js";
import { registerDemoIntentRouting } from "./fixtures/demo-intent-routing.js";
registerDemoIntentRouting();

test("plans ready execution for verified spot fund flow gift filter", () => {
  const plan = planPageModelExecutionFromStore({
    request: "进入现货资金流水，类型选择赠币，断言结果为赠币记录或空状态",
    assertions: ["断言结果为赠币记录或空状态"],
    store: fixtureStore(),
    project: "demo",
    env: "test"
  });

  assert.equal(plan.selection.intent.module, "asset");
  assert.equal(plan.selection.intent.operationType, "read");
  assert.equal(plan.executable, true);
  assert.equal(plan.recommendedNextAction, "execute");
  assert.deepEqual(plan.gaps, []);
  assert.ok(plan.materialization.case.steps.some((step) => (step as Record<string, unknown>).assertionId === "p7.spot_fund_flow.result_gift_or_empty"));
  assert.ok(plan.materialization.case.steps.some((step) => {
    const record = step as Record<string, unknown>;
    return record.elementId === "p7.spot_fund_flow.type_filter" &&
      record.pageModelId === "demo.funds.spot_fund_flow" &&
      record.source === "page_model";
  }));
});

test("keeps spot fund flow assertions from matching withdraw record evidence", () => {
  const store = fixtureStore();
  const spot = store.models.find((item) => item.pageId === "demo.funds.spot_fund_flow")!;
  spot.elements.push(
    element("c3.withdraw.record_page", "提现记录页 / 现货资金流水提现筛选页"),
    element("c3.withdraw.record_result_list", "提现记录结果列表")
  );
  spot.assertions.push(
    assertion("c3.withdraw.record_observable_signals", "提现记录可观察字段集合", "dom_verified"),
    assertion("t2_5.transfer.record_50_usdt_spot_to_futures", "划转记录中出现 50 USDT 现货到合约记录", "execution_verified")
  );

  const plan = planPageModelExecutionFromStore({
    request: "登录 demo test 环境，进入现货流水页面，类型选择红包发放进行搜索，期望列表中仅返回类型为红包发放的数据",
    store,
    project: "demo",
    env: "test"
  });

  assert.equal(plan.selection.intent.action, "spot_fund_flow_filter");
  assert.equal(plan.executable, true);
  assert.deepEqual(plan.gaps, []);
  const stepIds = (plan.materialization.case.steps as Array<Record<string, unknown>>).map((step) =>
    String(step.elementId ?? step.assertionId ?? step.evidenceId ?? "")
  );
  assert.equal(stepIds.some((id) => /c3\.withdraw|t2_5\.transfer/.test(id)), false);
});

test("materializes searchable dropdown field binding as select with postcondition", () => {
  const store = fixtureStore();
  const spot = store.models.find((item) => item.pageId === "demo.funds.spot_fund_flow")!;
  spot.elements = [
    {
      elementId: "funds.spot_fund_flow.asset_filter",
      semanticName: "现货流水币种下拉框",
      role: "combobox",
      controlType: "dropdown",
      targetField: "asset",
      semanticRole: "filter_control",
      status: "execution_verified",
      confidence: 0.86,
      dropdown: {
        popupScope: "dropdown_layer",
        optionDiscoveryMode: "searchable_local",
        searchInput: "[role='listbox'] input",
        selectedValueSignal: "selected value visible in trigger"
      },
      locatorCandidates: [{ strategy: "scoped_role_combobox_index", value: "css=main [role=\"combobox\"] >> nth=3", confidence: 0.78 }]
    },
    fieldElement("funds.spot_fund_flow.query_button", "现货流水查询按钮", "action"),
    element("funds.spot_fund_flow.result_list", "现货流水结果列表")
  ];

  const plan = planPageModelExecutionFromStore({
    request: "登录 demo test 环境，进入现货流水页面，币种下拉框选择“ETH”进行查询，期望列表返回空",
    store,
    project: "demo",
    env: "test"
  });

  assert.equal(plan.executable, true);
  assert.deepEqual(plan.gaps, []);
  const selectStep = plan.materialization.case.steps.find((step) => (step as Record<string, unknown>).elementId === "funds.spot_fund_flow.asset_filter") as Record<string, any> | undefined;
  assert.ok(selectStep);
  assert.equal(selectStep.action, "select");
  assert.equal(selectStep.value, "ETH");
  assert.equal(selectStep.component?.optionDiscoveryMode, "searchable_local");
  assert.equal(selectStep.postconditions?.[0]?.type, "selectedValueEquals");
  assert.equal(selectStep.postconditions?.[0]?.expected, "ETH");
});

test("plans ready execution for earn fund flow transaction type filter without spot evidence", () => {
  const plan = planPageModelExecutionFromStore({
    request: "\u767b\u5f55demo test\u73af\u5883\uff0c\u8fdb\u5165\u7406\u8d22\u6d41\u6c34\u9875\u9762\uff0c\u4ea4\u6613\u7c7b\u578b\u9009\u62e9\u7533\u8d2d\u8fdb\u884c\u641c\u7d22\uff0c\u671f\u671b\u5217\u8868\u4e2d\u4ea4\u6613\u7c7b\u578b\u5217\u663e\u793a\u7533\u8d2d\u7684\u6570\u636e\u6216\u5217\u8868\u4e3a\u7a7a",
    store: fixtureStore(),
    project: "demo",
    env: "test"
  });

  assert.equal(plan.selection.intent.module, "asset");
  assert.equal(plan.selection.intent.action, "earn_fund_flow_filter");
  assert.equal(plan.selection.intent.data.recordType, "\u7533\u8d2d");
  assert.equal(plan.executable, true);
  assert.deepEqual(plan.gaps, []);
  assert.ok(plan.materialization.case.steps.some((step) => (step as Record<string, unknown>).pageModelId === "demo.funds.earn_fund_flow"));
  assert.ok(plan.materialization.case.steps.some((step) => (step as Record<string, unknown>).elementId === "w5.earn_fund_flow.transaction_type_filter.option.\u7533\u8d2d"));
  assert.ok(plan.materialization.case.steps.some((step) => (step as Record<string, unknown>).elementId === "w5.earn_fund_flow.query_button"));
  assert.ok(plan.materialization.case.steps.some((step) => {
    const record = step as Record<string, unknown>;
    const assertion = record.assertion as Record<string, unknown> | undefined;
    return record.action === "assert" &&
      assertion?.type === "table_column_all_equal_or_empty" &&
      assertion?.table === "earn_fund_flow.result_table" &&
      assertion?.column === "\u7c7b\u578b" &&
      assertion?.semanticField === "record_type" &&
      assertion?.expected === "\u7533\u8d2d";
  }));
  assert.equal(plan.materialization.case.steps.some((step) => (step as Record<string, unknown>).pageModelId === "demo.funds.spot_fund_flow"), false);
});

test("plans demo earn fund flow redeem wording through principal and earnings return option", () => {
  const plan = planPageModelExecutionFromStore({
    request: "\u767b\u5f55demo test\u73af\u5883\uff0c\u8fdb\u5165\u7406\u8d22\u6d41\u6c34\u9875\u9762\uff0c\u4ea4\u6613\u7c7b\u578b\u4e0b\u62c9\u6846\u9009\u62e9\u201c\u8d4e\u56de\u201d\u8fdb\u884c\u67e5\u8be2\uff0c\u671f\u671b\u5217\u8868\u4e2d\u4ec5\u8fd4\u56de\u7c7b\u578b\u4e3a\u201c\u8d4e\u56de\u201d\u7684\u6570\u636e",
    store: fixtureStore(),
    project: "demo",
    env: "test"
  });

  assert.equal(plan.selection.intent.action, "earn_fund_flow_filter");
  assert.equal(plan.selection.intent.data.recordType, "\u8d4e\u56de");
  assert.equal(plan.executable, true);
  assert.deepEqual(plan.gaps, []);
  assert.ok(plan.materialization.case.steps.some((step) => (step as Record<string, unknown>).value === "\u672c\u91d1\u53ca\u6536\u76ca\u8fd4\u8fd8"));
  assert.ok(plan.materialization.case.steps.some((step) => {
    const record = step as Record<string, unknown>;
    const assertion = record.assertion as Record<string, unknown> | undefined;
    return record.action === "assert" &&
      assertion?.type === "table_column_all_equal" &&
      assertion?.expected === "\u672c\u91d1\u53ca\u6536\u76ca\u8fd4\u8fd8";
  }));
});

test("materializes user assertion for exact earn fund flow only-return wording", () => {
  const plan = planPageModelExecutionFromStore({
    request: "\u767b\u5f55demo test\u73af\u5883\uff0c\u8fdb\u5165\u7406\u8d22\u6d41\u6c34\u9875\u9762\uff0c\u4ea4\u6613\u7c7b\u578b\u4e0b\u62c9\u6846\u9009\u62e9\"\u7533\u8d2d\"\u8fdb\u884c\u67e5\u8be2\uff0c\u671f\u671b\u5217\u8868\u4e2d\u4ec5\u8fd4\u56de\u7c7b\u578b\u4e3a\"\u7533\u8d2d\"\u7684\u6570\u636e",
    store: fixtureStore(),
    project: "demo",
    env: "test"
  });

  assert.equal(plan.selection.intent.action, "earn_fund_flow_filter");
  assert.equal(plan.selection.intent.data.recordType, "\u7533\u8d2d");
  assert.equal(plan.executable, true);
  assert.deepEqual(plan.gaps, []);
  const assertStep = plan.materialization.case.steps.find((step) => step.action === "assert") as Record<string, unknown> | undefined;
  assert.ok(assertStep);
  assert.equal(assertStep?.pageModelId, "demo.funds.earn_fund_flow");
  assert.equal((assertStep?.assertion as Record<string, unknown>)?.type, "table_column_all_equal");
  assert.equal((assertStep?.assertion as Record<string, unknown>)?.table, "earn_fund_flow.result_table");
  assert.equal((assertStep?.assertion as Record<string, unknown>)?.column, "\u7c7b\u578b");
  assert.equal((assertStep?.assertion as Record<string, unknown>)?.semanticField, "record_type");
  assert.deepEqual((assertStep?.assertion as Record<string, unknown>)?.columnMapping, {
    semanticField: "record_type",
    filterField: "transaction_type_filter",
    resultColumn: "\u7c7b\u578b",
    source: "fixture"
  });
  assert.equal((assertStep?.assertion as Record<string, unknown>)?.expected, "\u7533\u8d2d");
});

test("plans contract fund flow transfer type as read filter without transfer write steps", () => {
  const plan = planPageModelExecutionFromStore({
    request: "\u767b\u5f55 demo test \u73af\u5883\uff0c\u8fdb\u5165\u5408\u7ea6\u6d41\u6c34\u9875\u9762\uff0c\u7c7b\u578b\u9009\u62e9\u5212\u8f6c\u8fdb\u884c\u641c\u7d22\uff0c\u671f\u671b\u5217\u8868\u4e2d\u7c7b\u578b\u8fd4\u56de\u5212\u8f6c\u7684\u6570\u636e",
    store: fixtureStore(),
    project: "demo",
    env: "test"
  });

  assert.equal(plan.selection.intent.module, "asset");
  assert.equal(plan.selection.intent.action, "contract_fund_flow_filter");
  assert.equal(plan.selection.intent.operationType, "read");
  assert.equal(plan.selection.intent.data.recordType, "\u5212\u8f6c");
  assert.equal(plan.executable, true);
  assert.deepEqual(plan.gaps, []);
  assert.ok(plan.materialization.case.steps.some((step) => (step as Record<string, unknown>).pageModelId === "demo.funds.contract_fund_flow"));
  assert.ok(plan.materialization.case.steps.some((step) => (step as Record<string, unknown>).elementId === "funds.contract_fund_flow.type_filter.option.\u5212\u8f6c"));
  assert.equal(plan.materialization.case.steps.some((step) => (step as Record<string, unknown>).pageModelId === "demo.funds.transfer_entry"), false);
  assert.equal(plan.materialization.case.steps.some((step) => /submit|transfer_entry|t2\.transfer/i.test(`${(step as Record<string, unknown>).id ?? ""} ${(step as Record<string, unknown>).elementId ?? ""}`)), false);
});

test("keeps contract fund flow execution bounded when helper pages are selected", () => {
  const store = fixtureStore();
  store.models.unshift(
    model("demo.funds.futures_account", "\u5408\u7ea6\u8d26\u6237", "asset", "futures_account", [
      element("futures_account_fund_flow_entry", "\u5408\u7ea6\u8d26\u6237\u8d44\u91d1\u6d41\u6c34\u5165\u53e3")
    ], []),
    model("demo.funds.fund_flow_entry", "\u8d44\u91d1\u6d41\u6c34\u5165\u53e3", "asset", "record", [
      element("fund_flow_entry", "\u8d44\u91d1\u6d41\u6c34")
    ], [])
  );

  const plan = planPageModelExecutionFromStore({
    request: "\u767b\u5f55 demo test \u73af\u5883\uff0c\u8fdb\u5165\u5408\u7ea6\u6d41\u6c34\u9875\u9762\uff0c\u4ea4\u6613\u7c7b\u578b\u4e0b\u62c9\u6846\u9009\u62e9\u201c\u5212\u8f6c\u201d\u8fdb\u884c\u67e5\u8be2\uff0c\u671f\u671b\u5217\u8868\u4e2d\u4ec5\u8fd4\u56de\u7c7b\u578b\u4e3a\u201c\u5212\u8f6c\u201d\u7684\u6570\u636e",
    store,
    project: "demo",
    env: "test"
  });

  assert.equal(plan.executable, true);
  assert.deepEqual(plan.gaps, []);
  assert.equal(plan.evidenceBucketSummary.targetPage, 1);
  assert.equal(plan.evidenceBucketSummary.navigation, 2);
  assert.equal(plan.executionContract.targetPageId, "demo.funds.contract_fund_flow");
  assert.deepEqual(plan.executionContract.forbiddenEvidenceUsed, []);
  const pageIds = new Set(plan.materialization.case.steps.map((step) => (step as Record<string, unknown>).pageModelId).filter(Boolean));
  assert.deepEqual([...pageIds], ["demo.funds.contract_fund_flow"]);
});

test("plans ready execution for verified transfer write flow", () => {
  const plan = planPageModelExecutionFromStore({
    request: "从现货账户划转 50 USDT 到合约账户，断言成功并在流水中出现记录",
    assertions: ["断言划转成功", "断言流水中出现 USDT 50 现货到合约划转记录"],
    store: fixtureStore(),
    project: "demo",
    env: "test"
  });

  assert.equal(plan.selection.intent.module, "transfer");
  assert.equal(plan.selection.intent.operationType, "write");
  assert.equal(plan.selection.intent.data.amount, 50);
  assert.equal(plan.executable, true);
  assert.equal(plan.recommendedNextAction, "execute");
  assert.deepEqual(plan.gaps, []);
  assert.ok(plan.materialization.case.steps.some((step) => (step as Record<string, unknown>).elementId === "t2.transfer.submit_button"));
});

test("keeps withdraw partial when observable capabilities or preconditions are missing", () => {
  const plan = planPageModelExecutionFromStore({
    request: "USDT BSC 链提现到指定地址，断言提交成功并在提现记录中出现记录",
    assertions: ["断言提交成功并在提现记录中出现 USDT、BSC、地址、数量、状态字段"],
    store: fixtureStore(),
    project: "demo",
    env: "test"
  });

  assert.equal(plan.selection.intent.module, "withdraw");
  assert.equal(plan.selection.intent.operationType, "write");
  assert.equal(plan.executable, false);
  assert.ok(plan.gaps.includes("withdraw_verification_provider_state"));
  assert.equal(plan.recommendedNextAction, "resolve_precondition");
});

test("bounds add withdraw address planning and blocks provider-gated write without operation manual steps", () => {
  const store = fixtureStore();
  const withdraw = store.models.find((item) => item.pageId === "demo.funds.withdraw")!;
  withdraw.url = "http://www.example.com/zh-hans/assets/withdraw";
  withdraw.elements.push(
    fieldElement("funds.withdraw.address_management_entry", "\u63d0\u5e01\u5730\u5740\u7ba1\u7406\u5165\u53e3", "action"),
    fieldElement("funds.withdraw.network_selector", "\u63d0\u5e01\u7f51\u7edc\u4e0b\u62c9\u6846", "network"),
    fieldElement("funds.withdraw.address_input", "\u63d0\u5e01\u5730\u5740\u8f93\u5165\u6846", "address")
  );
  store.models.push({
    pageId: "demo.funds.withdraw.address_management",
    parentPageId: "demo.funds.withdraw",
    pageName: "\u63d0\u5e01\u5730\u5740\u7ba1\u7406",
    project: "demo",
    module: "withdraw",
    action: "manage_withdraw_address",
    url: "http://www.example.com/zh-hans/assets/address-manage",
    status: "click_observed",
    confidence: 0.82,
    evidence: [{ source: "dom", path: "address-manage.dom.html", confidence: 0.8 }],
    elements: [
      fieldElement("funds.withdraw.address_management.add_address_button", "\u5730\u5740\u7ba1\u7406\u6dfb\u52a0\u5730\u5740\u6309\u94ae", "action"),
      fieldElement("funds.withdraw.add_address.asset_selector", "\u6dfb\u52a0\u5730\u5740\u5e01\u79cd\u4e0b\u62c9\u6846", "asset"),
      fieldElement("funds.withdraw.add_address.network_selector", "\u6dfb\u52a0\u5730\u5740\u7f51\u7edc\u4e0b\u62c9\u6846", "network", "BSC"),
      fieldElement("funds.withdraw.add_address.address_input", "\u6dfb\u52a0\u5730\u5740\u5730\u5740\u8f93\u5165\u6846", "address"),
      fieldElement("funds.withdraw.add_address.save_button", "\u6dfb\u52a0\u5730\u5740\u4fdd\u5b58\u6309\u94ae", "action")
    ],
    assertions: [],
    providerRequirements: [
      { providerRequirementId: "funds.withdraw.add_address.provider.email_code", pageId: "demo.funds.withdraw.address_management", scene: "withdraw_add_address_verification", provider: "redis", codeType: "email", action: "add_withdraw_address", status: "click_observed", evidence: [] },
      { providerRequirementId: "funds.withdraw.add_address.provider.totp", pageId: "demo.funds.withdraw.address_management", scene: "withdraw_add_address_verification", provider: "keepassxc", codeType: "totp", action: "add_withdraw_address", status: "click_observed", evidence: [] }
    ]
  });

  const plan = planPageModelExecutionFromStore({
    request: "\u767b\u5f55 demo test \u73af\u5883\uff0c\u8fdb\u5165\u63d0\u5e01\u5730\u5740\u7ba1\u7406\uff0c\u6dfb\u52a0 USDT BSC \u63d0\u5e01\u5730\u5740 0x000000000000000000000000000000000000dEaD\uff0c\u4fdd\u5b58\u5730\u5740\uff0c\u9700\u8981\u90ae\u7bb1\u9a8c\u8bc1\u7801\u548cGA\u9a8c\u8bc1",
    store,
    project: "demo",
    env: "test"
  });

  assert.equal(plan.selection.intent.action, "add_withdraw_address");
  assert.equal(plan.executable, false);
  assert.ok(plan.gaps.includes("provider_verification_step_not_materialized"));
  assert.equal(plan.evidenceBucketSummary.providers, 2);
  const steps = plan.materialization.case.steps as Array<Record<string, unknown>>;
  assert.equal(steps.some((step) => step.elementId === "funds.withdraw.network_selector"), false);
  assert.equal(steps.some((step) => step.elementId === "funds.withdraw.address_input"), false);
  const addIndex = steps.findIndex((step) => step.elementId === "funds.withdraw.address_management.add_address_button");
  const assetIndex = steps.findIndex((step) => step.elementId === "funds.withdraw.add_address.asset_selector");
  const addressIndex = steps.findIndex((step) => step.elementId === "funds.withdraw.add_address.address_input");
  const saveIndex = steps.findIndex((step) => step.elementId === "funds.withdraw.add_address.save_button");
  assert.ok(addIndex >= 0 && assetIndex > addIndex && addressIndex > assetIndex && saveIndex > addressIndex);
  const addressStep = steps[addressIndex];
  assert.equal(addressStep.value, "0x000000000000000000000000000000000000dEaD");
  assert.equal(addressStep.valueSource, "intent.data.address");
});

function fixtureStore() {
  return {
    project: "demo",
    models: [
      model("demo.funds.contract_fund_flow", "\u5408\u7ea6\u6d41\u6c34", "asset", "contract_fund_flow_filter", [
        fieldElement("funds.contract_fund_flow.type_filter", "\u5408\u7ea6\u6d41\u6c34\u7c7b\u578b\u7b5b\u9009", "record_type"),
        fieldElement("funds.contract_fund_flow.type_filter.option.\u5212\u8f6c", "\u5408\u7ea6\u6d41\u6c34\u7c7b\u578b\u9009\u9879:\u5212\u8f6c", "record_type", "\u5212\u8f6c"),
        fieldElement("funds.contract_fund_flow.query_button", "\u5408\u7ea6\u6d41\u6c34\u67e5\u8be2\u6309\u94ae", "action"),
        element("funds.contract_fund_flow.result_table", "\u5408\u7ea6\u6d41\u6c34\u7ed3\u679c\u5217\u8868")
      ], [
        assertion("funds.contract_fund_flow.result_list_or_empty", "\u5408\u7ea6\u6d41\u6c34\u7ed3\u679c\u5217\u8868\u6216\u7a7a\u72b6\u6001", "dom_verified")
      ]),
      model("demo.funds.earn_fund_flow", "\u7406\u8d22\u6d41\u6c34", "asset", "earn_fund_flow_filter", [
        fieldElement("w5.earn_fund_flow.transaction_type_filter", "\u7406\u8d22\u6d41\u6c34\u4ea4\u6613\u7c7b\u578b\u7b5b\u9009", "record_type"),
        fieldElement("w5.earn_fund_flow.transaction_type_filter.option.\u7533\u8d2d", "\u7406\u8d22\u6d41\u6c34\u4ea4\u6613\u7c7b\u578b\u9009\u9879:\u7533\u8d2d", "record_type", "\u7533\u8d2d"),
        fieldElement("w5.earn_fund_flow.transaction_type_filter.option.\u672c\u91d1\u53ca\u6536\u76ca\u8fd4\u8fd8", "\u7406\u8d22\u6d41\u6c34\u4ea4\u6613\u7c7b\u578b\u9009\u9879:\u672c\u91d1\u53ca\u6536\u76ca\u8fd4\u8fd8", "record_type", "\u672c\u91d1\u53ca\u6536\u76ca\u8fd4\u8fd8"),
        fieldElement("w5.earn_fund_flow.query_button", "\u7406\u8d22\u6d41\u6c34\u67e5\u8be2\u6309\u94ae", "action"),
        element("w5.earn_fund_flow.result_table", "\u7406\u8d22\u6d41\u6c34\u7ed3\u679c\u5217\u8868")
      ], [
        assertion("w5.earn_fund_flow.result_list_or_empty", "\u7406\u8d22\u6d41\u6c34\u7ed3\u679c\u5217\u8868\u6216\u7a7a\u72b6\u6001", "dom_verified")
      ]),
      model("demo.funds.spot_fund_flow", "现货资金流水", "asset", "spot_fund_flow_filter", [
        fieldElement("p7.spot_fund_flow.type_filter", "类型筛选控件", "record_type"),
        fieldElement("p7.spot_fund_flow.gift_coin_option", "赠币类型选项", "record_type", "赠币"),
        fieldElement("funds.spot_fund_flow.type_filter.option.红包发放", "现货流水类型选项:红包发放", "record_type", "红包发放"),
        element("p7.spot_fund_flow.query_button", "查询按钮"),
        element("p7.spot_fund_flow.result_list", "资金流水结果列表"),
        element("t2_5.transfer_record.transfer_type_option", "划转类型选项"),
        element("t2_5.transfer_record.asset_filter", "币种筛选控件"),
        element("t2_5.transfer_record.result_list", "划转记录结果列表")
      ], [
        assertion("p7.spot_fund_flow.result_gift_or_empty", "赠币记录或空状态", "execution_verified"),
        assertion("funds.spot_fund_flow.result_list_or_empty", "现货流水结果列表或空状态", "execution_verified"),
        assertion("t2_5.transfer.record_50_usdt_spot_to_futures", "划转记录中出现 50 USDT 现货到合约记录", "execution_verified")
      ]),
      model("demo.funds.transfer_entry", "划转弹窗/抽屉", "transfer", "spot_to_futures", [
        element("t2.transfer.from_account_selector", "转出账户选择器"),
        element("t2.transfer.to_account_selector", "转入账户选择器"),
        element("t2.transfer.asset_selector", "币种选择器"),
        element("t2.transfer.amount_input", "转入数量输入框"),
        element("t2.transfer.submit_button", "划转提交按钮")
      ], [
        assertion("t2.transfer.modal_visible", "划转弹窗可见", "execution_verified"),
        assertion("t2.transfer.submit_success", "划转提交成功提示", "execution_verified")
      ]),
      model("demo.funds.withdraw", "提现页面", "withdraw", "submit_withdraw", [
        element("withdraw_asset_selector", "提现币种选择器 USDT"),
        element("withdraw_address_input", "提现地址输入框"),
        element("withdraw_amount_input", "提现数量输入框")
      ], [
        assertion("withdraw_record_observable", "提现记录表字段候选", "candidate")
      ], [
        {
          blockId: "withdraw_verification_block",
          blockType: "blocked_by_precondition",
          status: "blocked",
          requiredHumanAction: "需要验证码 provider、白名单、KYC 或余额状态确认。",
          evidence: [{ source: "screenshot", path: "withdraw.png", confidence: 0.6 }]
        }
      ])
    ]
  };
}

function model(pageId: string, pageName: string, module: string, action: string, elements: unknown[], assertions: unknown[], blockedStates: unknown[] = []) {
  const isEarnFundFlow = pageId === "demo.funds.earn_fund_flow";
  const isSpotFundFlow = pageId === "demo.funds.spot_fund_flow";
  return {
    pageId,
    pageName,
    project: "demo",
    module,
    action,
    status: "execution_verified",
    confidence: 0.82,
    evidence: [{ source: "dom", path: `${pageId}.dom.html`, confidence: 0.75 }],
    resultTable: isEarnFundFlow
      ? resultTable("earn_fund_flow.result_table", ["\u5e01\u79cd", "\u65f6\u95f4", "\u4ea7\u54c1\u7c7b\u578b", "\u4ea7\u54c1\u540d\u79f0", "\u7c7b\u578b", "\u6570\u91cf", "\u72b6\u6001", "\u64cd\u4f5c"])
      : isSpotFundFlow
        ? resultTable("spot_fund_flow.result_table", ["\u5e01\u79cd", "\u65f6\u95f4", "\u7c7b\u578b", "\u6570\u91cf", "\u72b6\u6001"])
        : undefined,
    fieldMappings: isEarnFundFlow
      ? [
          { semanticField: "record_type", filterField: "transaction_type_filter", filterLabel: "\u4ea4\u6613\u7c7b\u578b", resultColumn: "\u7c7b\u578b", aliases: ["\u4ea4\u6613\u7c7b\u578b", "\u7c7b\u578b"], source: "fixture" },
          { semanticField: "asset", filterField: "asset_filter", filterLabel: "\u5e01\u79cd", resultColumn: "\u5e01\u79cd", aliases: ["\u5e01\u79cd"], source: "fixture" }
        ]
      : isSpotFundFlow
        ? [
            { semanticField: "record_type", filterField: "type_filter", filterLabel: "\u7c7b\u578b", resultColumn: "\u7c7b\u578b", aliases: ["\u7c7b\u578b"], source: "fixture" },
            { semanticField: "asset", filterField: "asset_filter", filterLabel: "\u5e01\u79cd", resultColumn: "\u5e01\u79cd", aliases: ["\u5e01\u79cd"], source: "fixture" }
          ]
        : undefined,
    elements,
    assertions,
    blockedStates
  };
}

function resultTable(tableId: string, labels: string[]) {
  return {
    tableId,
    columns: labels.map((label, index) => ({ label, index, status: "dom_verified" })),
    emptyState: { texts: ["\u6682\u65e0\u6570\u636e", "\u6682\u65e0\u8bb0\u5f55"], status: "dom_verified" }
  };
}

function element(elementId: string, semanticName: string) {
  return {
    elementId,
    semanticName,
    role: "button",
    status: "execution_verified",
    confidence: 0.76,
    locatorCandidates: [{ strategy: "text", value: elementId.includes("type_filter") ? "全部类型" : semanticName, confidence: 0.7 }],
    evidence: [{ source: "dom", path: `${elementId}.dom.html`, confidence: 0.72 }]
  };
}

function fieldElement(elementId: string, semanticName: string, targetField: string, optionValue?: string) {
  return {
    ...element(elementId, semanticName),
    targetField,
    optionValue,
    semanticRole: optionValue ? "filter_option" : targetField === "action" ? "action_button" : "filter_control",
    locatorCandidates: [{ strategy: optionValue ? "role_option_name" : "role_button_name", value: optionValue ?? semanticName, confidence: 0.72 }]
  };
}

function assertion(assertionId: string, assertionKind: string, status: string) {
  return {
    assertionId,
    assertionKind,
    candidates: [{ type: "visible_text_any", expected: [assertionKind] }],
    status,
    confidence: 0.76,
    evidence: [{ source: "visible_text", path: `${assertionId}.txt`, confidence: 0.7 }]
  };
}
