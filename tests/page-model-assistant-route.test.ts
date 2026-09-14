import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import fs from "fs-extra";
import {
  planAssistantRequestWithPageModels,
  summarizePageModelRouteForResponse
} from "../src/core/page-model-assistant-route.js";

test("assistant route ignores legacy knowledge and plans only from Page Model Store", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "page-model-route-"));
  await fs.ensureDir(path.join(rootDir, "storage", "page-models"));
  await fs.ensureDir(path.join(rootDir, "storage", "knowledge"));
  await fs.writeJson(path.join(rootDir, "storage", "knowledge", "demo.json"), {
    project: "demo",
    updatedAt: new Date().toISOString(),
    chunks: [
      {
        chunkId: "legacy_red_packet_create",
        project: "demo",
        sourceType: "business_flow",
        sourceId: "red_packet_create",
        platform: "web",
        title: "legacy red packet create flow",
        content: "create red packet, submit amount, send red packet",
        keywords: ["red", "packet", "create"],
        confidence: 0.99,
        updatedAt: new Date().toISOString()
      }
    ]
  });
  await fs.writeJson(path.join(rootDir, "storage", "page-models", "demo.json"), fixturePageModelStore());

  const route = await planAssistantRequestWithPageModels({
    rootDir,
    project: "demo",
    env: "test",
    message: "登录demo test环境，进入现货流水页面，类型选择红包发放进行搜索"
  });

  assert.equal(route.route, "page_model");
  if (route.route !== "page_model") return;
  const response = summarizePageModelRouteForResponse(route.plan);
  assert.equal(route.plan.selection.intent.module, "asset");
  assert.equal(route.plan.selection.intent.action, "spot_fund_flow_filter");
  assert.equal(route.plan.selection.intent.data.type, "红包发放");
  assert.equal(route.plan.executable, true);
  assert.equal(route.plan.materialization.case.steps.some((step) => JSON.stringify(step).includes("red_packet_create")), false);
  assert.equal(JSON.stringify(response).includes("legacy_red_packet_create"), false);
});

function fixturePageModelStore(): Record<string, unknown> {
  return {
    project: "demo",
    models: [
      {
        pageId: "demo.funds.spot_fund_flow",
        pageName: "现货资金流水",
        project: "demo",
        platform: "web",
        locale: "zh-hans",
        module: "asset",
        action: "spot_fund_flow_filter",
        status: "execution_verified",
        confidence: 0.9,
        url: "http://www.example.com/zh-hans/assets/flows/spot-flow",
        evidence: [{ source: "dom", path: "fixture.html", confidence: 0.8 }],
        elements: [
          element("w3.spot_fund_flow.type_filter", "类型筛选控件", "record_type"),
          element("w3.spot_fund_flow.type_filter.option.红包发放", "类型筛选选项:红包发放", "record_type", "红包发放"),
          element("w3.spot_fund_flow.query_button", "查询按钮", "action"),
          element("w3.spot_fund_flow.result_list", "资金流水结果列表", "result")
        ],
        assertions: [
          {
            assertionId: "w3.spot_fund_flow.result_record_type_or_empty",
            assertionKind: "result_list_or_empty_state",
            status: "execution_verified",
            confidence: 0.82,
            evidence: [{ source: "dom", path: "fixture.html", confidence: 0.8 }]
          }
        ]
      }
    ]
  };
}

function element(elementId: string, semanticName: string, targetField: string, optionValue?: string): Record<string, unknown> {
  return {
    elementId,
    semanticName,
    role: optionValue ? "option" : "button",
    targetField,
    optionValue,
    parentElementId: optionValue ? "w3.spot_fund_flow.type_filter" : undefined,
    status: "execution_verified",
    confidence: 0.82,
    locatorCandidates: [{ strategy: "text", value: optionValue ?? semanticName, confidence: 0.8 }],
    evidence: [{ source: "dom", path: "fixture.html", confidence: 0.8 }]
  };
}

