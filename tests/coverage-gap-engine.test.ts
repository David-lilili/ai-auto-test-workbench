import assert from "node:assert/strict";
import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { analyzeCoverageGaps, renderCoverageGapReport } from "../src/workbench/coverage-gap-engine.js";

let sandbox: string;

beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "coverage-gap-"));
});

afterEach(async () => {
  await fs.remove(sandbox);
});

async function writeStores(manuals: unknown[], cases: unknown[]): Promise<void> {
  await fs.ensureDir(path.join(sandbox, "storage", "operation-manuals"));
  await fs.ensureDir(path.join(sandbox, "storage", "cases"));
  await fs.writeJson(path.join(sandbox, "storage", "operation-manuals", "demo.json"), { manuals });
  await fs.writeJson(path.join(sandbox, "storage", "cases", "demo.json"), { cases });
}

test("covered: case text hits capability alias across separators", async () => {
  await writeStores(
    [{ pageId: "demo.page", pageName: "资产中心-合约流水", module: "asset", capabilities: [{ capabilityId: "filter_contract_fund_flow", naturalLanguageAliases: ["合约流水筛选", "合约流水查询"], operationType: "read" }] }],
    [{ id: "case-1", pageModelId: "demo.page", title: "合约流水-按转入筛选返回匹配记录", request: "进入合约流水页面，类型选择转入，点击查询" }]
  );
  const report = await analyzeCoverageGaps(sandbox, "demo");
  assert.equal(report.gaps[0].coverageStatus, "covered");
  assert.deepEqual(report.gaps[0].coveredCaseIds, ["case-1"]);
});

test("partial: page has cases but capability untouched", async () => {
  await writeStores(
    [
      { pageId: "demo.page", pageName: "资产中心-理财", module: "earn", capabilities: [
        { capabilityId: "subscribe_earn_product", naturalLanguageAliases: ["申购理财产品"], operationType: "write" },
        { capabilityId: "toggle_auto_subscribe", naturalLanguageAliases: ["切换自动申购"], operationType: "write" }
      ] }
    ],
    [{ id: "case-1", pageModelId: "demo.page", title: "理财-申购数量为空时确认按钮置灰", request: "进入理财页面，点击申购" }]
  );
  const report = await analyzeCoverageGaps(sandbox, "demo");
  const subscribe = report.gaps.find((item) => item.capabilityId === "subscribe_earn_product");
  const toggle = report.gaps.find((item) => item.capabilityId === "toggle_auto_subscribe");
  assert.equal(subscribe?.coverageStatus, "covered");
  assert.equal(toggle?.coverageStatus, "partial");
});

test("uncovered: no case touches the page", async () => {
  await writeStores(
    [{ pageId: "demo.page", pageName: "资产中心-提现", module: "withdraw", capabilities: [{ capabilityId: "submit_onchain_withdraw", naturalLanguageAliases: ["发起提现"], operationType: "write" }] }],
    [{ id: "case-1", pageModelId: "other.page", title: "别的页面用例", request: "无关内容" }]
  );
  const report = await analyzeCoverageGaps(sandbox, "demo");
  assert.equal(report.gaps[0].coverageStatus, "uncovered");
  assert.equal(report.uncovered, 1);
});

test("negative-guard alias core matching still works", async () => {
  await writeStores(
    [{ pageId: "demo.page", pageName: "资产中心-红包", module: "red-packet", capabilities: [{ capabilityId: "create_red_packet", naturalLanguageAliases: ["红包创建未绑谷歌拦截", "创建红包"], operationType: "write" }] }],
    [{ id: "case-1", pageModelId: "demo.page", title: "红包-创建成功", request: "进入红包页面，创建红包" }]
  );
  const report = await analyzeCoverageGaps(sandbox, "demo");
  assert.equal(report.gaps[0].coverageStatus, "covered");
});

test("report renders chinese markdown with uncovered/partial sections", async () => {
  await writeStores(
    [{ pageId: "demo.page", pageName: "资产中心-提现", module: "withdraw", capabilities: [{ capabilityId: "submit_onchain_withdraw", naturalLanguageAliases: ["发起提现"], operationType: "write" }] }],
    []
  );
  const report = await analyzeCoverageGaps(sandbox, "demo");
  const markdown = renderCoverageGapReport(report);
  assert.ok(markdown.includes("用例覆盖差距报告"));
  assert.ok(markdown.includes("未覆盖能力"));
  assert.ok(markdown.includes("submit_onchain_withdraw"));
});

test("unconfigured project store fails loudly", async () => {
  await assert.rejects(() => analyzeCoverageGaps(sandbox, "not-configured"), /未配置/);
});
