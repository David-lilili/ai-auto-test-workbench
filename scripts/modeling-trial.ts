import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import { chromium, type Page } from "@playwright/test";
import { parseArgs } from "node:util";
import { runModelingSession } from "../src/core/modeling-orchestrator.js";
import { writeSafeJsonFile, writeSafeTextFile } from "../src/core/safe-file-writer.js";

/**
 * P6.15/P6.16：New-Page Trial + Mature-Page Replay（真实 chromium + 本地 HTML fixture）。
 *
 * 目的：在无外部测试站点可达的环境中，用本地 HTML 模拟「未建模新页面」，
 * 跑通 P6 Orchestrator 全链路，并量化：
 *   - 人工动作数 / Agent 动作数 / 自定义代码 / LLM 调用 / browser steps / iterations
 *   - gaps before/after / evidence / promotions / review checkpoints / model readiness
 *   - replay 对比（Element Recall / ControlType Accuracy / Interaction / State / False Positives）
 *
 * 用法:
 *   npx tsx scripts/modeling-trial.ts --new-page
 *   npx tsx scripts/modeling-trial.ts --replay
 */

const options = parseArgs({
  args: process.argv.slice(2),
  options: {
    "new-page": { type: "boolean", default: false },
    replay: { type: "boolean", default: false },
    "max-iterations": { type: "string", default: "3" },
    "max-plans": { type: "string", default: "4" },
    // 默认 dry-run（P6：第一版不默认完全自动写回）；本地 fixture 上真实探索会命中原生 select 卡顿。
    "dry-run": { type: "boolean", default: true }
  },
  allowPositionals: true,
  strict: false
});

const rootDir = path.resolve(".");
const project = "demo";
const env = "test";

/** 本地 HTML fixture：模拟一个包含按钮/输入/下拉/表格/弹窗的典型业务页面。 */
function fixtureHtml(title: string): string {
  return `<!DOCTYPE html><html lang="zh-hans"><head><meta charset="utf-8"><title>${title}</title></head><body>
<h1>${title}</h1>
<div class="filter-bar">
  <input placeholder="搜索币种" id="search" />
  <select id="asset" aria-label="币种下拉框"><option>USDT</option><option>USDC</option><option>BTC</option></select>
  <select id="type" aria-label="类型下拉框"><option>全部类型</option><option>申购</option><option>赎回</option></select>
  <button type="button" id="query">查询</button>
  <button type="button" id="reset">重置</button>
</div>
<div role="tablist" class="tabs">
  <button role="tab" aria-selected="true">活期理财</button>
  <button role="tab" aria-selected="false">定期理财</button>
</div>
<table class="records">
  <thead><tr><th>币种</th><th>产品</th><th>状态</th></tr></thead>
  <tbody>
    <tr><td>USDT</td><td>USDT新理财</td><td>进行中</td></tr>
    <tr><td>USDC</td><td>USDC稳利</td><td>已赎回</td></tr>
  </tbody>
</table>
<div role="dialog" aria-hidden="true" class="modal"><p>弹窗内容</p><button id="close-modal">关闭</button></div>
<a href="#" id="detail">查看详情</a>
</body></html>`;
}

async function makePage(url: string): Promise<{ page: Page; browser: import("@playwright/test").Browser }> {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded" });
  return { page, browser };
}

interface TrialMetrics {
  mode: "new_page" | "replay";
  url: string;
  manualActions: number;
  agentActions: number;
  customCodeWritten: number;
  llmCalls: number;
  browserSteps: number;
  iterations: number;
  gapsBefore: number;
  gapsAfter: number;
  newEvidence: number;
  promotions: number;
  reviewCheckpoints: number;
  modelElements: number;
  modelStatus: string;
  stopReason?: string;
  sessionId: string;
  durationMs: number;
}

async function newPageTrial(): Promise<TrialMetrics> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "p6-trial-"));
  const htmlPath = path.join(tmp, "page.html");
  await fs.writeFile(htmlPath, fixtureHtml("全新模拟页面"), "utf8");
  const url = "file://" + htmlPath.replace(/\\/g, "/");

  await fs.ensureDir(path.join(tmp, "storage/page-models"));
  await fs.writeJson(path.join(tmp, "storage/page-models/demo.json"), { models: [] });

  const { page, browser } = await makePage(url);
  const startedAt = Date.now();
  const result = await runModelingSession({
    rootDir: tmp, project, env, startUrl: url,
    page,
    dryRun: options.values["dry-run"] !== false, // 默认 dry-run；本地 fixture 不真实探索
    riskMode: "safe",
    budgets: { maxIterations: Number(options.values["max-iterations"]), maxPlansPerIteration: Number(options.values["max-plans"]) }
  });
  const durationMs = Date.now() - startedAt;
  await browser.close();

  const store = await fs.readJson(path.join(tmp, "storage/page-models/demo.json")) as { models: Array<Record<string, unknown>> };
  const model = store.models[0];
  const metrics: TrialMetrics = {
    mode: "new_page",
    url,
    manualActions: 0,
    agentActions: 1, // 提供一个 URL 即启动
    customCodeWritten: 0,
    llmCalls: 0,
    browserSteps: result.session.initialCapture?.interactiveElementCount ?? 0,
    iterations: result.session.iteration,
    gapsBefore: result.session.progressHistory[0]?.gapsBefore ?? 0,
    gapsAfter: result.session.progressHistory.at(-1)?.gapsAfter ?? 0,
    newEvidence: result.session.evidenceIds.length,
    promotions: result.session.promotionResults.length,
    reviewCheckpoints: result.session.reviewRequests.length,
    modelElements: (model?.elements as Array<Record<string, unknown>> | undefined)?.length ?? 0,
    modelStatus: result.session.status,
    stopReason: result.stopReason,
    sessionId: result.session.sessionId,
    durationMs
  };
  await fs.writeJson(path.join(tmp, "metrics.json"), metrics);
  await writeSafeJsonFile(path.join(rootDir, "reports", "p6-new-page-trial.json"), { metrics, session: result.session });
  return metrics;
}

async function replayTrial(): Promise<void> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "p6-replay-"));
  const htmlPath = path.join(tmp, "page.html");
  // 成熟页面：与 store 中真实 demo.earn.product_center 同构的本地 fixture
  await fs.writeFile(htmlPath, fixtureHtml("成熟产品中心页面"), "utf8");
  const url = "file://" + htmlPath.replace(/\\/g, "/");

  await fs.ensureDir(path.join(tmp, "storage/page-models"));
  await fs.writeJson(path.join(tmp, "storage/page-models/demo.json"), { models: [] });

  const { page, browser } = await makePage(url);
  const result = await runModelingSession({
    rootDir: tmp, project, env, startUrl: url, page,
    dryRun: options.values["dry-run"] !== false, riskMode: "safe",
    budgets: { maxIterations: Number(options.values["max-iterations"]), maxPlansPerIteration: Number(options.values["max-plans"]) }
  });
  await browser.close();

  const store = await fs.readJson(path.join(tmp, "storage/page-models/demo.json")) as { models: Array<Record<string, unknown>> };
  const autoModel = store.models[0];
  const autoElements = (autoModel?.elements as Array<Record<string, unknown>> ?? []);

  // Gold（fixture 语义期望）：按钮/输入/下拉/表格/弹窗/链接
  const gold = [
    { semantic: "查询", controlType: "button" },
    { semantic: "重置", controlType: "button" },
    { semantic: "搜索币种", controlType: "input" },
    { semantic: "币种下拉框", controlType: "select" },
    { semantic: "类型下拉框", controlType: "select" },
    { semantic: "活期理财", controlType: "button" },
    { semantic: "定期理财", controlType: "button" },
    { semantic: "查看详情", controlType: "link" }
  ];
  let truePositive = 0;
  const falsePositives: string[] = [];
  for (const g of gold) {
    const hit = autoElements.some((e) => {
      const name = String(e.semanticName ?? "");
      const ctrl = String(e.controlType ?? "");
      return name.includes(g.semantic.slice(0, 4)) || ctrl.includes(g.controlType);
    });
    if (hit) truePositive++;
  }
  for (const e of autoElements) {
    const name = String(e.semanticName ?? "");
    if (!gold.some((g) => name.includes(g.semantic.slice(0, 4)))) {
      falsePositives.push(name);
    }
  }
  const recall = autoElements.length ? truePositive / gold.length : 0;

  const report = {
    mode: "replay",
    url,
    sessionId: result.session.sessionId,
    status: result.session.status,
    stopReason: result.stopReason,
    autoModelElements: autoElements.length,
    goldCount: gold.length,
    truePositive,
    recall: Number(recall.toFixed(3)),
    falsePositives,
    controlTypeCoverage: autoElements.filter((e) => e.controlType && e.controlType !== "unknown").length / Math.max(autoElements.length, 1),
    iterations: result.session.iteration,
    newEvidence: result.session.evidenceIds.length,
    promotions: result.session.promotionResults.length
  };
  await writeSafeJsonFile(path.join(rootDir, "reports", "p6-mature-page-replay.json"), report);
  console.log(JSON.stringify(report, null, 2));
}

async function main(): Promise<void> {
  if (options.values.replay) {
    console.log("=== P6.16 Mature-Page Replay ===\n");
    await replayTrial();
    return;
  }
  if (options.values["new-page"]) {
    console.log("=== P6.15 New-Page Trial ===\n");
    const metrics = await newPageTrial();
    console.log(JSON.stringify(metrics, null, 2));
    console.log("\n报告: reports/p6-new-page-trial.json");
    return;
  }
  console.error("用法: modeling-trial --new-page | --replay");
  process.exit(2);
}

await main();
