import assert from "node:assert/strict";
import { test } from "node:test";
import { buildMessageAssertionDiagnostics, readFundFlowTableSnapshot } from "../src/drivers/web-driver-adapter.js";

test("diagnoses table assertion column that is not observable in visible result table", () => {
  const snapshot = readFundFlowTableSnapshot(
    [
      "时间",
      "币种",
      "全部币种",
      "类型",
      "全部产品类型",
      "交易类型",
      "申购",
      "查询",
      "重置",
      "产品类型",
      "产品名称",
      "数量",
      "状态",
      "操作",
      "DOT",
      "Polkadot",
      "2026-07-08 11:58:19",
      "活期理财",
      "DOT 1号",
      "+10000.0000000",
      "成功",
      "查看详情"
    ].join("\n"),
    {
      column: "交易类型",
      expected: "申购",
      intent: { field: "交易类型" }
    }
  );

  assert.equal(snapshot.empty, false);
  assert.equal(snapshot.loading, false);
  assert.deepEqual(snapshot.diagnostics.observedHeaders, ["产品类型", "产品名称", "数量", "状态", "操作"]);
  assert.deepEqual(snapshot.diagnostics.selectedFilters, [
    { label: "币种", value: "全部币种", source: "visible_text" },
    { label: "类型", value: "全部产品类型", source: "visible_text" },
    { label: "交易类型", value: "申购", source: "visible_text" }
  ]);
  assert.equal(snapshot.diagnostics.requestedColumn, "交易类型");
  assert.equal(snapshot.diagnostics.expected, "申购");
  assert.equal(snapshot.diagnostics.rootCause, "assertion_column_not_observable");
});

test("does not treat adjacent table header as selected filter value", () => {
  const snapshot = readFundFlowTableSnapshot(
    [
      "合约流水",
      "USDT",
      "转入",
      "查询",
      "重置",
      "币种",
      "时间",
      "类型",
      "金额",
      "USDT",
      "Tether",
      "2026-07-20 08:26:50",
      "转入",
      "50",
      "USDT",
      "Tether",
      "2026-07-02 11:54:41",
      "转入",
      "100"
    ].join("\n"),
    {
      column: "类型",
      expected: "转入",
      intent: { field: "交易类型" }
    }
  );

  assert.deepEqual(snapshot.diagnostics.observedHeaders, ["币种", "时间", "类型", "金额"]);
  assert.deepEqual(snapshot.diagnostics.selectedFilters, []);
  assert.deepEqual(snapshot.typeValues, ["转入"]);
  assert.equal(snapshot.diagnostics.rootCause, "values_extracted");
});

test("merges runtime selected filter trace into table assertion diagnostics", () => {
  const snapshot = readFundFlowTableSnapshot(
    [
      "币种",
      "时间",
      "类型",
      "数量",
      "状态",
      "操作",
      "ETH",
      "Ether",
      "2026-07-07 13:32:25",
      "账户划转-转出",
      "-99.90000000",
      "成功",
      "查看详情"
    ].join("\n"),
    {
      expected: "empty",
      runtimeSelectedFilters: [
        {
          label: "币种",
          field: "asset",
          value: "ETH",
          elementId: "funds.spot_fund_flow.asset_filter",
          selectedValueAfter: "ETH",
          verified: true
        }
      ]
    }
  );

  assert.deepEqual(snapshot.diagnostics.selectedFilters, [
    {
      label: "币种",
      field: "asset",
      value: "ETH",
      elementId: "funds.spot_fund_flow.asset_filter",
      selectedValueAfter: "ETH",
      verified: true,
      source: "runtime_step_trace"
    }
  ]);
});

test("uses data table contract to read asset code from compound asset cells", () => {
  const tableContract = {
    regionId: "spot_fund_flow.result_table",
    type: "data_table",
    columns: [
      { field: "asset", label: "币种", cellType: "asset_identity", aliases: ["currency", "coin"], subFields: ["asset.code", "asset.name"] },
      { field: "time", label: "时间", cellType: "datetime" },
      { field: "type", label: "类型", cellType: "text" },
      { field: "amount", label: "数量", cellType: "amount" },
      { field: "status", label: "状态", cellType: "status" },
      { field: "action", label: "操作", cellType: "row_action" }
    ]
  };
  const visibleText = [
    "现货流水",
    "ETH",
    "全部类型",
    "查询",
    "重置",
    "币种",
    "时间",
    "类型",
    "数量",
    "状态",
    "操作",
    "ETH",
    "Ether",
    "2026-07-07 13:32:25",
    "账户划转-转出",
    "-99.90000000",
    "成功",
    "查看详情",
    "ETH",
    "Ether",
    "2026-07-02 18:23:02",
    "账户划转-转出",
    "-0.10000000",
    "成功",
    "查看详情",
    "ETH",
    "Ether",
    "2026-07-02 15:41:39",
    "赠币",
    "100.00000000",
    "已完成",
    "查看详情"
  ].join("\n");

  const assetSnapshot = readFundFlowTableSnapshot(
    visibleText,
    {
      column: "币种",
      expected: "ETH",
      intent: { field: "币种" }
    },
    tableContract
  );
  assert.deepEqual(assetSnapshot.typeValues, ["ETH"]);
  assert.equal(assetSnapshot.diagnostics.extractionStrategy, "page_model_data_table_contract");

  const currencyAliasSnapshot = readFundFlowTableSnapshot(
    visibleText,
    {
      column: "currency",
      expected: "ETH",
      intent: { field: "currency" }
    },
    tableContract
  );
  assert.deepEqual(currencyAliasSnapshot.typeValues, ["ETH"]);
  assert.equal(currencyAliasSnapshot.diagnostics.extractionStrategy, "page_model_data_table_contract");

  const typeSnapshot = readFundFlowTableSnapshot(
    visibleText,
    {
      column: "类型",
      expected: "账户划转-转出",
      intent: { field: "类型" }
    },
    tableContract
  );
  assert.deepEqual(typeSnapshot.typeValues, ["账户划转-转出", "赠币"]);
});

test("visible result rows are not considered an empty result", () => {
  const snapshot = readFundFlowTableSnapshot(
    [
      "现货流水",
      "USDT",
      "查询",
      "币种",
      "时间",
      "类型",
      "数量",
      "状态",
      "操作",
      "USDT",
      "Tether",
      "2026-07-06 17:35:30",
      "账户划转-转入",
      "107.04",
      "成功",
      "查看详情"
    ].join("\n"),
    {
      column: "类型",
      expected: "empty",
      intent: { field: "类型" }
    }
  );

  assert.equal(snapshot.empty, false);
  assert.equal(snapshot.loading, false);
  assert.equal(snapshot.diagnostics.tableReadiness?.rowCount, 1);
  assert.equal(snapshot.diagnostics.rootCause, "values_extracted");
});

test("visible result rows win over unrelated empty-state text", () => {
  const snapshot = readFundFlowTableSnapshot(
    [
      "\u73b0\u8d27\u6d41\u6c34",
      "\u6682\u65e0\u6570\u636e",
      "\u5e01\u79cd",
      "\u65f6\u95f4",
      "\u7c7b\u578b",
      "\u6570\u91cf",
      "\u72b6\u6001",
      "\u64cd\u4f5c",
      "USDT",
      "Tether",
      "2026-07-27 18:03:39",
      "\u7ea2\u5305\u53d1\u653e",
      "-5.00",
      "\u5df2\u5b8c\u6210",
      "\u67e5\u770b\u8be6\u60c5"
    ].join("\n"),
    {
      column: "\u7c7b\u578b",
      expected: "\u7ea2\u5305\u53d1\u653e",
      intent: { field: "\u7c7b\u578b" }
    }
  );

  assert.equal(snapshot.empty, false);
  assert.deepEqual(snapshot.typeValues, ["\u7ea2\u5305\u53d1\u653e"]);
  assert.equal(snapshot.diagnostics.rootCause, "values_extracted");
});

test("message assertion diagnostics keep highly similar visible text without passing exact assertion", () => {
  const diagnostics = buildMessageAssertionDiagnostics("\u8be5\u8d26\u53f7\u5df2\u5b58\u5728", undefined, [
    { text: "\u8be5\u8d26\u6237\u5df2\u5b58\u5728", source: "visible_text", similarity: 5 / 6 },
    { text: "\u4fdd\u5b58\u5730\u5740", source: "visible_text", similarity: 0.1 }
  ]);

  assert.equal(diagnostics.attribution.rootCause, "opposite_or_failure_message_seen");
  assert.equal(diagnostics.bestCandidates[0]?.text, "\u8be5\u8d26\u6237\u5df2\u5b58\u5728");
});
