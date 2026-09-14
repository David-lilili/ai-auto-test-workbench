import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildStructuredCaseContext,
  lintStructuredCaseContext
} from "../src/core/case-context.js";

test("lints page-structure preconditions and mixed assertions", () => {
  const context = buildStructuredCaseContext({
    title: "理财-切换产品类型后列表刷新",
    businessRequest: "1. 进入更多-理财页面。",
    preconditions: ["页面具备活期理财产品与定期理财产品两个产品类型标签。"],
    expectedAssertion: "“活期理财产品”标签高亮，产品列表展示 USDT USDT新理财 进行中的活期产品行。"
  });

  assert.deepEqual(lintStructuredCaseContext(context), [
    "mixed_assertion_detected:“活期理财产品”标签高亮，产品列表展示 USDT USDT新理财 进行中的活期产品行。",
    "precondition_contains_page_structure:页面具备活期理财产品与定期理财产品两个产品类型标签。"
  ]);
});
