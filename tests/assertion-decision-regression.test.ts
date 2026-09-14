import assert from "node:assert/strict";
import { test } from "node:test";
import { parseUserAssertions } from "../src/core/user-assertion-parser.js";

test("control-value assertions classify as field_value instead of ui_text_visible", () => {
  const cases = [
    { text: "类型下拉框显示“全部类型”，币种下拉框恢复页面默认值。", expected: "field_value" },
    { text: "币种下拉框显示 USDT。", expected: "field_value" },
    { text: "金额输入框恢复为空。", expected: "field_value" }
  ];
  for (const { text, expected } of cases) {
    const result = parseUserAssertions({ assertions: [text] });
    assert.equal(result.assertions[0].kind, expected, `断言分类错误: ${text}`);
  }
});

test("table_column_date_between classification stays correct", () => {
  const result = parseUserAssertions({ assertions: ["列表“时间”列均在“2026-08-01 00:00:00”至“2026-08-07 23:59:59”内。"] });
  assert.equal(result.assertions[0].kind, "table_column_date_between");
});

test("tab_active and control-state classifications stay correct", () => {
  const tab = parseUserAssertions({ assertions: ["“活期理财产品”标签处于选中/高亮状态。"] });
  assert.equal(tab.assertions[0].kind, "tab_active");
  const disabled = parseUserAssertions({ assertions: ["申购弹窗中“确定”按钮置灰且不可点击。"] });
  assert.equal(disabled.assertions[0].kind, "element_disabled");
});

test("page-text visibility still classifies as ui_text_visible", () => {
  const result = parseUserAssertions({ assertions: ["页面出现红包错误口令领取失败提示。"] });
  assert.notEqual(result.assertions[0].kind, "field_value");
});
