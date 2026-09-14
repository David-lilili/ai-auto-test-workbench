import assert from "node:assert/strict";
import { test } from "node:test";
import { parseUserAssertions } from "../src/core/user-assertion-parser.js";
import { registerDemoIntentRouting } from "./fixtures/demo-intent-routing.js";
registerDemoIntentRouting();

test("parses spot fund flow record-or-empty assertion", () => {
  const result = parseUserAssertions({
    assertions: ["断言筛选结果展示赠币类型记录或空状态"],
    selection: {
      schemaVersion: "page-model-evidence-selection.v1",
      request: "现货流水赠币筛选",
      intent: {
        project: "demo",
        env: "test",
        module: "asset",
        action: "spot_fund_flow_filter",
        operationType: "read",
        loginRequired: true,
        data: { type: "赠币" },
        intentConfidence: 0.8,
        evidence: []
      },
      selectedEvidence: [],
      fallbackEvidence: [
        evidence("assertion", "p7.spot_fund_flow.result_gift_or_empty", "demo.funds.spot_fund_flow", "赠币记录或空状态")
      ],
      excludedEvidence: [],
      gaps: [],
      blockingGaps: [],
      readiness: "ready",
      executable: true,
      reason: "fixture"
    }
  });

  assert.equal(result.assertions[0].kind, "table_column_all_equal_or_empty");
  assert.equal(result.assertions[0].acceptsEmptyState, true);
  assert.equal(result.assertions[0].assertionIntent?.field, "类型");
  assert.equal(result.assertions[0].assertionIntent?.expected, "赠币");
  assert.deepEqual(result.gaps, []);
  assert.equal(result.assertions[0].mappedEvidence[0].id, "p7.spot_fund_flow.result_gift_or_empty");
});
test("parses withdraw observable fields without treating them as fixed test assertions", () => {
  const result = parseUserAssertions({
    assertions: ["断言提交成功，并在提现记录中出现 USDT、BSC、地址、数量、状态字段"]
  });

  assert.equal(result.assertions.length, 1);
  assert.equal(result.assertions[0].kind, "record_contains");
  assert.ok(result.assertions[0].targetConcepts.includes("withdraw_record"));
  assert.ok(result.assertions[0].targetConcepts.includes("network_bsc"));
  assert.ok(result.assertions[0].targetConcepts.includes("withdraw_address"));
  assert.ok(result.gaps.some((gap) => gap.includes("assertion_capability_missing")));
});

test("does not invent assertions when the user only requests an action", () => {
  const result = parseUserAssertions({
    request: "\u767b\u5f55demo test\u73af\u5883\uff0c\u8fdb\u5165\u73b0\u8d27\u6d41\u6c34\u9875\u9762\uff0c\u7c7b\u578b\u9009\u62e9\u8d60\u5e01"
  });

  assert.deepEqual(result.assertions, []);
  assert.deepEqual(result.gaps, []);
});

test("parses table column expectation separately from filter operation value", () => {
  const result = parseUserAssertions({
    request: "登录demo test环境，进入现货流水页面，通过类型\"交易\"进行搜索，期望页面只显示类型为\"充值\"的数据",
    selection: {
      schemaVersion: "page-model-evidence-selection.v1",
      request: "fixture",
      intent: {
        project: "demo",
        env: "test",
        module: "asset",
        action: "spot_fund_flow_filter",
        operationType: "read",
        loginRequired: true,
        data: { type: "交易" },
        intentConfidence: 0.9,
        evidence: []
      },
      selectedEvidence: [
        {
          kind: "page",
          id: "demo.funds.spot_fund_flow",
          pageId: "demo.funds.spot_fund_flow",
          semanticName: "现货资金流水",
          status: "execution_verified",
          confidence: 0.9,
          reason: "fixture",
          evidence: [{ source: "page_model", id: "demo.funds.spot_fund_flow", confidence: 0.9 }]
        }
      ],
      fallbackEvidence: [],
      excludedEvidence: [],
      gaps: [],
      blockingGaps: [],
      readiness: "ready",
      executable: true,
      reason: "fixture"
    }
  });

  assert.equal(result.assertions[0].kind, "table_column_all_equal");
  assert.deepEqual(result.assertions[0].assertionIntent, {
    targetPage: "spot_fund_flow",
    targetObject: "result_table",
    field: "类型",
    operator: "all_equal",
    expected: "充值",
    emptyStateAccepted: false,
    source: "local_fallback",
    confidence: 0.82
  });
  assert.deepEqual(result.assertions[0].expectedTexts, ["充值"]);
  assert.deepEqual(result.gaps, []);
});

test("parses flexible table column display expectation", () => {
  const result = parseUserAssertions({
    request: "\u767b\u5f55demo test\u73af\u5883\uff0c\u8fdb\u5165\u73b0\u8d27\u6d41\u6c34\u9875\u9762\uff0c\u901a\u8fc7\u7c7b\u578b\"\u4ea4\u6613\"\u8fdb\u884c\u641c\u7d22\uff0c\u671f\u671b\u5217\u8868\u4e2d\u7c7b\u578b\u5217\u663e\u793a\"\u5145\u503c\"\u7684\u6570\u636e"
  });

  assert.equal(result.assertions[0].kind, "table_column_all_equal");
  assert.equal(result.assertions[0].assertionIntent?.field, "\u7c7b\u578b");
  assert.equal(result.assertions[0].assertionIntent?.expected, "\u5145\u503c");
  assert.deepEqual(result.assertions[0].expectedTexts, ["\u5145\u503c"]);
});

test("strips wrapping quotes from visible numeric assertion text", () => {
  const result = parseUserAssertions({
    assertions: ["数量列至少展示“101.00”。"]
  });

  assert.equal(result.assertions[0].kind, "record_contains");
  assert.deepEqual(result.assertions[0].expectedTexts, ["101.00"]);
});

test("parses explicit page message expectation as exact runtime message assertion", () => {
  const result = parseUserAssertions({
    request: "\u767b\u5f55 demo test \u73af\u5883\uff0c\u8fdb\u5165\u8d44\u4ea7\u4e2d\u5fc3-\u63d0\u73b0-\u5730\u5740\u7ba1\u7406\u9875\u9762\uff0cUID\u8f93\u516514605\uff0c\u70b9\u51fb\u4fdd\u5b58\u5730\u5740\uff0c\u5b8c\u6210\u53cc\u9a8c\u8bc1\u540e\u671f\u671b\u63d0\u793a\"\u64cd\u4f5c\u5931\u8d25\""
  });

  assert.equal(result.assertions.length, 1);
  assert.equal(result.assertions[0].kind, "message_visible_exact");
  assert.equal(result.assertions[0].assertionIntent?.targetObject, "message");
  assert.equal(result.assertions[0].assertionIntent?.operator, "message_visible_exact");
  assert.equal(result.assertions[0].assertionIntent?.expected, "\u64cd\u4f5c\u5931\u8d25");
  assert.deepEqual(result.assertions[0].expectedTexts, ["\u64cd\u4f5c\u5931\u8d25"]);
});

test("parses unquoted page message expectations as exact runtime messages", () => {
  const belowMinimum = parseUserAssertions({
    request: "\u767b\u5f55demo test\u73af\u5883\uff0c\u8fdb\u5165\u7406\u8d22\u4ea7\u54c1\u4e2d\u5fc3\uff0c\u8f93\u51650.5 SOL\u540e\uff0c\u9875\u9762\u63d0\u793a\u4f4e\u4e8e\u6700\u5c0f\u7533\u8d2d\u6570\u91cf\u3002"
  });
  const aboveLimit = parseUserAssertions({
    request: "\u767b\u5f55demo test\u73af\u5883\uff0c\u8fdb\u5165\u7406\u8d22\u4ea7\u54c1\u4e2d\u5fc3\uff0c\u8f93\u51655001 SOL\u540e\uff0c\u9875\u9762\u63d0\u793a\u8d85\u8fc7\u7d2f\u8ba1\u6301\u4ed3\u4e0a\u9650\u3002"
  });

  assert.equal(belowMinimum.assertions[0].kind, "message_visible_exact");
  assert.equal(belowMinimum.assertions[0].assertionIntent?.expected, "\u4f4e\u4e8e\u6700\u5c0f\u7533\u8d2d\u6570\u91cf");
  assert.deepEqual(belowMinimum.assertions[0].expectedTexts, ["\u4f4e\u4e8e\u6700\u5c0f\u7533\u8d2d\u6570\u91cf"]);
  assert.equal(aboveLimit.assertions[0].kind, "message_visible_exact");
  assert.equal(aboveLimit.assertions[0].assertionIntent?.expected, "\u8d85\u8fc7\u7d2f\u8ba1\u6301\u4ed3\u4e0a\u9650");
  assert.deepEqual(aboveLimit.assertions[0].expectedTexts, ["\u8d85\u8fc7\u7d2f\u8ba1\u6301\u4ed3\u4e0a\u9650"]);
});

test("uses DeepSeek assertion intent before local assertion fallback", () => {
  const result = parseUserAssertions({
    request: "\u767b\u5f55 demo test \u73af\u5883\uff0c\u8fdb\u5165\u63d0\u73b0-\u5730\u5740\u7ba1\u7406\uff0cUID\u8f93\u516514595\uff0c\u671f\u671b\u63d0\u793a\u8be5\u8d26\u53f7\u5df2\u5b58\u5728",
    deepSeekIntent: {
      assertions: [
        {
          sourceText: "\u671f\u671b\u63d0\u793a\u8be5\u8d26\u53f7\u5df2\u5b58\u5728",
          targetObject: "message",
          operator: "visible_exact",
          expected: "\u8be5\u8d26\u53f7\u5df2\u5b58\u5728",
          confidence: 0.91
        }
      ]
    }
  });

  assert.equal(result.assertions.length, 1);
  assert.equal(result.assertions[0].kind, "message_visible_exact");
  assert.equal(result.assertions[0].assertionIntent?.source, "deepseek_intent");
  assert.equal(result.assertions[0].assertionIntent?.expected, "\u8be5\u8d26\u53f7\u5df2\u5b58\u5728");
  assert.deepEqual(result.assertions[0].expectedTexts, ["\u8be5\u8d26\u53f7\u5df2\u5b58\u5728"]);
});

test("parses unquoted explicit message assertion without silently accepting missing evidence", () => {
  const result = parseUserAssertions({
    request: "\u767b\u5f55 demo test \u73af\u5883\uff0cUID\u8f93\u516514595\uff0c\u671f\u671b\u63d0\u793a\u8be5\u8d26\u53f7\u5df2\u5b58\u5728"
  });

  assert.equal(result.assertions[0].kind, "message_visible_exact");
  assert.equal(result.assertions[0].assertionIntent?.expected, "\u8be5\u8d26\u53f7\u5df2\u5b58\u5728");
  assert.ok(result.gaps.some((gap) => gap.startsWith("assertion_capability_missing:")));
});

test("parses only-return table column expectation for earn fund flow", () => {
  const result = parseUserAssertions({
    request: "\u767b\u5f55demo test\u73af\u5883\uff0c\u8fdb\u5165\u7406\u8d22\u6d41\u6c34\u9875\u9762\uff0c\u4ea4\u6613\u7c7b\u578b\u4e0b\u62c9\u6846\u9009\u62e9\"\u7533\u8d2d\"\u8fdb\u884c\u67e5\u8be2\uff0c\u671f\u671b\u5217\u8868\u4e2d\u4ec5\u8fd4\u56de\u7c7b\u578b\u4e3a\"\u7533\u8d2d\"\u7684\u6570\u636e"
  });

  assert.equal(result.assertions[0].kind, "table_column_all_equal");
  assert.equal(result.assertions[0].assertionIntent?.targetPage, "earn_fund_flow");
  assert.equal(result.assertions[0].assertionIntent?.targetObject, "result_table");
  assert.equal(result.assertions[0].assertionIntent?.field, "\u4ea4\u6613\u7c7b\u578b");
  assert.equal(result.assertions[0].assertionIntent?.operator, "all_equal");
  assert.equal(result.assertions[0].assertionIntent?.expected, "\u7533\u8d2d");
  assert.equal(result.assertions[0].assertionIntent?.emptyStateAccepted, false);
  assert.deepEqual(result.assertions[0].expectedTexts, ["\u7533\u8d2d"]);
});

test("maps demo earn fund flow redeem assertion to principal and earnings return record type", () => {
  const result = parseUserAssertions({
    request: "\u8fdb\u5165\u7406\u8d22\u6d41\u6c34\u9875\u9762\uff0c\u4ea4\u6613\u7c7b\u578b\u4e0b\u62c9\u6846\u9009\u62e9\u201c\u8d4e\u56de\u201d\u8fdb\u884c\u67e5\u8be2\uff0c\u671f\u671b\u5217\u8868\u4e2d\u4ec5\u8fd4\u56de\u7c7b\u578b\u4e3a\u201c\u8d4e\u56de\u201d\u7684\u6570\u636e",
    selection: {
      schemaVersion: "page-model-evidence-selection.v1",
      request: "fixture",
      intent: {
        project: "demo",
        env: "test",
        module: "asset",
        action: "earn_fund_flow_filter",
        operationType: "read",
        loginRequired: true,
        data: { recordType: "\u8d4e\u56de" },
        intentConfidence: 0.9,
        evidence: []
      },
      selectedEvidence: [],
      fallbackEvidence: [],
      excludedEvidence: [],
      gaps: [],
      blockingGaps: [],
      readiness: "ready",
      executable: true,
      reason: "fixture"
    }
  });

  assert.equal(result.assertions[0].kind, "table_column_all_equal");
  assert.equal(result.assertions[0].assertionIntent?.expected, "\u672c\u91d1\u53ca\u6536\u76ca\u8fd4\u8fd8");
  assert.deepEqual(result.assertions[0].expectedTexts, ["\u672c\u91d1\u53ca\u6536\u76ca\u8fd4\u8fd8"]);
});

test("parses quoted table field assertion wording", () => {
  const result = parseUserAssertions({
    request: "\u5217\u8868\u201c\u4ea4\u6613\u7c7b\u578b\u201d\u5217\u4ec5\u8fd4\u56de\u201c\u672c\u91d1\u53ca\u6536\u76ca\u8fd4\u8fd8\u201d\u3002"
  });

  assert.equal(result.assertions[0].kind, "table_column_all_equal");
  assert.equal(result.assertions[0].assertionIntent?.field, "\u4ea4\u6613\u7c7b\u578b");
  assert.equal(result.assertions[0].assertionIntent?.expected, "\u672c\u91d1\u53ca\u6536\u76ca\u8fd4\u8fd8");
});

test("keeps earn product center row assertion out of earn fund flow table parsing", () => {
  const result = parseUserAssertions({
    request: "\u671f\u671b\u65ad\u8a00\uff1a\u7406\u8d22\u4ea7\u54c1\u5217\u8868\u5c55\u793a\u5e01\u79cd\u4e3a SOL\u3001\u4ea7\u54c1\u540d\u79f0\u4e3a SOL\u3001\u72b6\u6001\u4e3a\u8fdb\u884c\u4e2d\u7684\u4ea7\u54c1\u884c\uff0c\u5e76\u5c55\u793a\u8be5\u884c\u201c\u7533\u8d2d\u201d\u6309\u94ae\u3002"
  });

  assert.equal(result.assertions[0].kind, "list_row_present");
  assert.equal(result.assertions[0].assertionIntent?.targetPage, "earn_product_center");
  assert.equal(result.assertions[0].assertionIntent?.field, "product_row");
  assert.deepEqual(result.assertions[0].expectedTexts, ["SOL", "\u8fdb\u884c\u4e2d", "\u7533\u8d2d"]);
});

test("does not include enumeration punctuation tail in table expected value", () => {
  const result = parseUserAssertions({
    request: "\u671f\u671b\u5217\u8868\u5c55\u793a\u5e01\u79cd\u4e3a SOL\u3001\u4ea7\u54c1\u540d\u79f0\u4e3a SOL"
  });

  assert.equal(result.assertions[0].assertionIntent?.expected, "SOL");
  assert.deepEqual(result.assertions[0].expectedTexts, ["SOL"]);
});

test("parses cleared filter expectation as field state assertion", () => {
  const result = parseUserAssertions({
    assertions: ["类型筛选条件被清空"],
    selection: {
      schemaVersion: "page-model-evidence-selection.v1",
      request: "fixture",
      intent: {
        project: "demo",
        env: "test",
        module: "asset",
        action: "spot_fund_flow_filter",
        operationType: "read",
        loginRequired: true,
        data: { resetRequested: true },
        intentConfidence: 0.9,
        evidence: []
      },
      selectedEvidence: [],
      fallbackEvidence: [
        evidence("assertion", "funds.spot_fund_flow.observable.type_filter_selected_value", "demo.funds.spot_fund_flow", "现货流水类型下拉框已选值可观察")
      ],
      excludedEvidence: [],
      gaps: [],
      blockingGaps: [],
      readiness: "ready",
      executable: true,
      reason: "fixture"
    }
  });

  assert.equal(result.assertions[0].kind, "field_value");
  assert.equal(result.assertions[0].assertionIntent?.targetObject, "field");
  assert.equal(result.assertions[0].assertionIntent?.field, "类型");
  assert.equal(result.assertions[0].assertionIntent?.expected, "全部类型");
  assert.deepEqual(result.assertions[0].expectedTexts, ["全部类型"]);
  assert.equal(result.gaps.length, 0);
});

test("maps table column assertions to result evidence instead of filter selected signals", () => {
  const result = parseUserAssertions({
    request: "\u767b\u5f55demo test\u73af\u5883\uff0c\u8fdb\u5165\u73b0\u8d27\u6d41\u6c34\u9875\u9762\uff0c\u901a\u8fc7\u7c7b\u578b\"\u8d60\u5e01\"\u8fdb\u884c\u641c\u7d22\uff0c\u671f\u671b\u9875\u9762\u53ea\u663e\u793a\u7c7b\u578b\u4e3a\"\u8d60\u5e01\"\u7684\u6570\u636e\u6216\u7a7a\u72b6\u6001",
    selection: {
      schemaVersion: "page-model-evidence-selection.v1",
      request: "fixture",
      intent: {
        project: "demo",
        env: "test",
        module: "asset",
        action: "spot_fund_flow_filter",
        operationType: "read",
        loginRequired: true,
        data: { type: "\u8d60\u5e01" },
        intentConfidence: 0.9,
        evidence: []
      },
      selectedEvidence: [
        {
          kind: "assertion",
          id: "p7.spot_fund_flow.type_filter_gift_selected",
          pageId: "demo.funds.spot_fund_flow",
          semanticName: "\u7c7b\u578b\u7b5b\u9009\u663e\u793a\u8d60\u5e01",
          status: "execution_verified",
          confidence: 0.9,
          reason: "filter selected signal",
          evidence: [{ source: "page_model", id: "p7.spot_fund_flow.type_filter_gift_selected", confidence: 0.9 }]
        },
        {
          kind: "element",
          id: "w3.spot_fund_flow.result_table",
          pageId: "demo.funds.spot_fund_flow",
          semanticName: "\u7ed3\u679c\u5217\u8868",
          status: "dom_verified",
          confidence: 0.8,
          reason: "result table evidence",
          evidence: [{ source: "page_model", id: "w3.spot_fund_flow.result_table", confidence: 0.8 }]
        }
      ],
      fallbackEvidence: [],
      excludedEvidence: [],
      gaps: [],
      blockingGaps: [],
      readiness: "ready",
      executable: true,
      reason: "fixture"
    }
  });

  assert.equal(result.assertions[0].kind, "table_column_all_equal_or_empty");
  assert.deepEqual(result.assertions[0].expectedTexts, ["\u8d60\u5e01"]);
  assert.equal(result.assertions[0].mappedEvidence[0].id, "w3.spot_fund_flow.result_table");
  assert.ok(!result.assertions[0].mappedEvidence.some((item) => item.id === "p7.spot_fund_flow.type_filter_gift_selected"));
});

test("parses empty result expectation as a user assertion", () => {
  const result = parseUserAssertions({
    request: "\u767b\u5f55demo test\u73af\u5883\uff0c\u8fdb\u5165\u73b0\u8d27\u6d41\u6c34\u9875\u9762\uff0c\u5e01\u79cd\u4e0b\u62c9\u6846\u9009\u62e9\"ETH\"\u8fdb\u884c\u67e5\u8be2\uff0c\u671f\u671b\u5217\u8868\u8fd4\u56de\u7a7a",
    selection: {
      schemaVersion: "page-model-evidence-selection.v1",
      request: "fixture",
      intent: {
        project: "demo",
        env: "test",
        module: "asset",
        action: "spot_fund_flow_filter",
        operationType: "read",
        loginRequired: true,
        data: { asset: "ETH" },
        intentConfidence: 0.9,
        evidence: []
      },
      selectedEvidence: [],
      fallbackEvidence: [
        evidence("assertion", "w3.spot_fund_flow.empty_state_visible", "demo.funds.spot_fund_flow", "\u7a7a\u72b6\u6001\u53ef\u89c1"),
        evidence("assertion", "w3.spot_fund_flow.result_list_visible", "demo.funds.spot_fund_flow", "\u7ed3\u679c\u5217\u8868\u53ef\u89c1")
      ],
      excludedEvidence: [],
      gaps: [],
      blockingGaps: [],
      readiness: "ready",
      executable: true,
      reason: "fixture"
    }
  });

  assert.equal(result.assertions[0].kind, "result_empty");
  assert.equal(result.assertions[0].assertionIntent?.operator, "empty");
  assert.equal(result.assertions[0].acceptsEmptyState, true);
  assert.equal(result.assertions[0].mappedEvidence[0].id, "w3.spot_fund_flow.empty_state_visible");
  assert.deepEqual(result.gaps, []);
});

test("uses explicit case assertion before stale DeepSeek assertion intent", () => {
  const result = parseUserAssertions({
    request: "登录 demo test 环境，进入现货流水页面，币种下拉框选择 ETH 进行查询，期望列表返回空",
    assertions: ["列表返回币种为ETH的数据"],
    deepSeekIntent: {
      assertions: [{
        targetObject: "result_table",
        operator: "empty",
        expected: "empty",
        sourceText: "期望列表返回空"
      }]
    },
    selection: {
      schemaVersion: "page-model-evidence-selection.v1",
      request: "现货流水 ETH 筛选",
      intent: {
        project: "demo",
        env: "test",
        module: "asset",
        action: "spot_fund_flow_filter",
        operationType: "read",
        loginRequired: true,
        data: { asset: "ETH" },
        intentConfidence: 0.9,
        evidence: []
      },
      selectedEvidence: [],
      fallbackEvidence: [
        evidence("assertion", "w3.spot_fund_flow.asset_column_all_equal", "demo.funds.spot_fund_flow", "币种列全等断言"),
        evidence("assertion", "w3.spot_fund_flow.empty_state_visible", "demo.funds.spot_fund_flow", "空状态可见")
      ],
      excludedEvidence: [],
      gaps: [],
      blockingGaps: [],
      readiness: "ready",
      executable: true,
      reason: "fixture"
    }
  });

  assert.equal(result.assertions[0].kind, "table_column_all_equal");
  assert.equal(result.assertions[0].assertionIntent?.expected, "ETH");
});

test("parses readable control state assertion", () => {
  const result = parseUserAssertions({
    assertions: ["目标持仓行自动申购开关状态可读取，状态来源为 aria-checked 或 data-state。"]
  });

  assert.equal(result.assertions[0].kind, "control_state_readable");
});

test("parses table time column date range assertion", () => {
  const result = parseUserAssertions({
    assertions: ["列表“时间”列均在“2026-08-01 00:00:00”至“2026-08-07 23:59:59”内。"]
  });

  assert.equal(result.assertions[0].kind, "table_column_date_between");
  assert.equal(result.assertions[0].assertionIntent?.field, "时间");
  assert.equal(result.assertions[0].assertionIntent?.expected, "2026-08-01 00:00:00~2026-08-07 23:59:59");
});

test("parses missing editable input as absence assertion", () => {
  const result = parseUserAssertions({
    assertions: ["批量赎回弹窗不展示任何可编辑的赎回数量输入框。"]
  });

  assert.equal(result.assertions[0].kind, "element_absent");
});

test("parses active tab assertion separately from enabled control assertion", () => {
  const result = parseUserAssertions({
    assertions: ["“活期理财产品”标签处于选中/高亮状态。"],
    selection: {
      schemaVersion: "page-model-evidence-selection.v1",
      request: "理财产品类型切换",
      intent: {
        project: "demo",
        env: "test",
        module: "asset",
        action: "earn_product_view",
        operationType: "read",
        loginRequired: true,
        data: { productType: "活期理财" },
        intentConfidence: 0.9,
        evidence: []
      },
      selectedEvidence: [],
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
    }
  });

  assert.equal(result.assertions[0].kind, "tab_active");
  assert.equal(result.assertions[0].mappedEvidence[0].id, "earn_product_center.product_type_tab.current_active");
});

test("parses earn product row presence without requiring row action enabled", () => {
  const result = parseUserAssertions({
    assertions: ["产品列表中可见币种为“USDT”、产品名称为“USDT新理财”、状态为“进行中”的活期产品行。"],
    selection: {
      schemaVersion: "page-model-evidence-selection.v1",
      request: "理财产品列表",
      intent: {
        project: "demo",
        env: "test",
        module: "asset",
        action: "earn_product_view",
        operationType: "read",
        loginRequired: true,
        data: { asset: "USDT", status: "进行中", productName: "USDT新理财" },
        intentConfidence: 0.9,
        evidence: []
      },
      selectedEvidence: [],
      fallbackEvidence: [
        {
          ...evidence("assertion", "earn_product_center.product_list.row_visible", "demo.earn.product_center", "理财产品列表目标产品行可见"),
          assertionType: "ui_text_visible",
          textCandidates: ["USDT", "USDT新理财", "进行中"]
        }
      ],
      excludedEvidence: [],
      gaps: [],
      blockingGaps: [],
      readiness: "ready",
      executable: true,
      reason: "fixture"
    }
  });

  assert.equal(result.assertions[0].kind, "list_row_present");
  assert.equal(result.assertions[0].assertionIntent?.field, "product_row");
  assert.deepEqual(result.assertions[0].expectedTexts, ["USDT", "进行中", "活期", "USDT新理财"]);
});

function evidence(kind: "assertion", id: string, pageId: string, semanticName: string) {
  return {
    kind,
    id,
    pageId,
    semanticName,
    status: "execution_verified",
    confidence: 0.8,
    reason: "fixture",
    evidence: [{ source: "page_model", id, confidence: 0.8 }]
  };
}
