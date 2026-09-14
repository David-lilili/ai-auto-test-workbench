import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import { chromium, type Page } from "@playwright/test";
import { runModelingSession } from "./modeling-orchestrator.js";
import { loadAllKnowledgeEvidence } from "./knowledge-evidence-sink.js";
import { writeSafeJsonFile } from "./safe-file-writer.js";

/**
 * P7.20：Mutation Benchmark（本地 fixture 专用，禁止真实站点 destructive mutation）。
 *
 * 从 V1 fixture 自动生成 V2 变体（add input / rename label / move button / change role /
 * add dropdown option / add modal / remove element / change table column），
 * 测平台抗页面变化能力。
 *
 * 指标：
 *   changedAreaRecall         —— 变化区被发现的比例
 *   unchangedReexploration    —— 已知区被重复探索的比例（越低越好）
 *   knowledgeRetention        —— V1 知识在 V2 保留率
 *   falseChangeDetection      —— 未变内容被误判为变化的占比
 */

export interface MutationCase {
  name: string;
  /** 返回 V1 与 V2 两个 HTML。 */
  fixtures: () => { v1: string; v2: string };
  /** 期望被发现的 V2 新增元素名。 */
  expectedNewElements: string[];
}

const BASE_V1 = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>MUT 页面</title></head><body>
<h1>MUT 页面</h1>
<div class="filters">
  <select id="asset"><option>USDT</option><option>USDC</option></select>
  <button id="query">查询</button>
  <button id="reset">重置</button>
</div>
<div class="tabs"><button role="tab" aria-selected="true">现货</button><button role="tab">合约</button></div>
<table><tr><td>USDT</td><td>100</td></tr></table>
</body></html>`;

function withV2(mutate: (html: string) => string): () => { v1: string; v2: string } {
  return () => ({ v1: BASE_V1, v2: mutate(BASE_V1) });
}

export const MUTATION_CASES: MutationCase[] = [
  {
    name: "ADD_CONTROL",
    fixtures: withV2((html) => html.replace('</table>', '<table><tr><td>USDT</td><td>100</td></tr></table><input id="amount" placeholder="输入数量" />')),
    expectedNewElements: ["输入数量"]
  },
  {
    name: "RENAME_LABEL",
    fixtures: withV2((html) => html.replace(">查询<", ">搜索<")),
    expectedNewElements: ["搜索"]
  },
  {
    name: "ADD_DROPDOWN_OPTION",
    fixtures: withV2((html) => html.replace("<option>USDC</option>", "<option>USDC</option><option>BTC</option>")),
    expectedNewElements: ["BTC"]
  },
  {
    name: "ADD_MODAL",
    fixtures: withV2((html) => html.replace("</body>", '<div role="dialog"><p>弹窗</p><button>关闭</button></div></body>')),
    expectedNewElements: ["关闭"]
  },
  {
    name: "CHANGE_COLUMN",
    fixtures: withV2((html) => html.replace("<td>100</td>", "<td>100</td><td>备注</td>")),
    expectedNewElements: ["备注"]
  },
  {
    name: "REMOVE_ELEMENT",
    fixtures: withV2((html) => html.replace('<button id="reset">重置</button>', "")),
    expectedNewElements: []
  }
];

async function modelHtml(html: string): Promise<{ elements: string[]; fingerprints: string[]; evidence: number }> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "p7-mut-"));
  const htmlPath = path.join(tmp, "page.html");
  await fs.writeFile(htmlPath, html, "utf8");
  const url = "file://" + htmlPath.replace(/\\/g, "/");
  await fs.ensureDir(path.join(tmp, "storage/page-models"));
  await fs.writeJson(path.join(tmp, "storage/page-models/demo.json"), { models: [] });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page: Page = await context.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded" });
  const result = await runModelingSession({
    rootDir: tmp, project: "demo", env: "test", startUrl: url, page,
    suggestedPageId: "demo.mut.page", dryRun: false, riskMode: "safe",
    budgets: { maxIterations: 3, maxPlansPerIteration: 4 }
  });
  await browser.close();
  const store = await fs.readJson(path.join(tmp, "storage/page-models/demo.json")) as { models: Array<Record<string, unknown>> };
  const model = store.models[0];
  const evidence = await loadAllKnowledgeEvidence(tmp, "demo");
  return {
    elements: ((model?.elements as Array<Record<string, unknown>> | undefined) ?? []).map((e) => String(e.semanticName ?? "")),
    fingerprints: result.session.executedFingerprints,
    evidence: evidence.length
  };
}

function norm(text: string): string {
  return String(text).replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, "").toLowerCase();
}

/** 运行全部 mutation cases，输出指标。 */
export async function runMutationBenchmark(outPath: string): Promise<Record<string, unknown>> {
  const results: Array<Record<string, unknown>> = [];
  for (const mutation of MUTATION_CASES) {
    const { v1, v2 } = mutation.fixtures();
    const v1Model = await modelHtml(v1);
    const v2Model = await modelHtml(v2);

    const v1Set = new Set(v1Model.elements.map(norm));
    const v2Set = new Set(v2Model.elements.map(norm));
    // 变化区 = V2 新增元素
    const changedDiscovered = mutation.expectedNewElements.filter((e) => v2Set.has(norm(e)));
    const changedRecall = mutation.expectedNewElements.length ? changedDiscovered.length / mutation.expectedNewElements.length : 1;
    // 已知区重复探索 = V2 fingerprints 与 V1 相同
    const v1Fp = new Set(v1Model.fingerprints);
    const reexplored = v2Model.fingerprints.filter((fp) => v1Fp.has(fp)).length;
    const unchangedReexploration = v2Model.fingerprints.length ? reexplored / v2Model.fingerprints.length : 0;
    // 知识保留 = V1 元素在 V2 保留
    const retained = v1Model.elements.filter((e) => v2Set.has(norm(e))).length;
    const retention = v1Model.elements.length ? retained / v1Model.elements.length : 0;
    // false change = V2 中非预期新增元素（模型新增但不在 expectedNewElements）
    const unexpectedNew = [...v2Set].filter((e) => !v1Set.has(e) && !mutation.expectedNewElements.some((x) => norm(x) === e));
    const falseChangeRate = unexpectedNew.length;

    results.push({
      mutation: mutation.name,
      expectedNewElements: mutation.expectedNewElements,
      changedDiscovered,
      changedAreaRecall: Number(changedRecall.toFixed(3)),
      unchangedReexploration: Number(unchangedReexploration.toFixed(3)),
      knowledgeRetention: Number(retention.toFixed(3)),
      unexpectedNewElements: unexpectedNew,
      falseChangeDetection: falseChangeRate
    });
  }
  const report = { generatedAt: new Date().toISOString(), mutationResults: results };
  await fs.ensureDir(path.dirname(outPath));
  await writeSafeJsonFile(outPath, report);
  return report;
}
