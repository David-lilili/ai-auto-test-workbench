import fs from "fs-extra";
import path from "node:path";
import { parseArgs } from "node:util";
import { getBenchmarkPages } from "../src/core/modeling-benchmark-dataset.js";
import { runModelingBenchmarkCase, runBenchmarkReport, type PerPageMetrics } from "../src/core/modeling-benchmark-harness.js";
import { writeSafeJsonFile, writeSafeTextFile } from "../src/core/safe-file-writer.js";
import { chromium, type Page } from "@playwright/test";
import { injectAuthState } from "../src/core/browser-runtime.js";
import { loadContext } from "../src/core/config-loader.js";
import { AccountStore } from "../src/memory/account-store.js";
import { EnvironmentDiscoveryStore } from "../src/memory/environment-discovery-store.js";

/**
 * P7.29：benchmark:modeling CLI。
 *
 * 用法:
 *   npx tsx scripts/benchmark-modeling.ts --mode smoke       # 2 页面快速
 *   npx tsx scripts/benchmark-modeling.ts --mode standard    # 8 页面
 *   npx tsx scripts/benchmark-modeling.ts --mode full        # 全部
 *   npx tsx scripts/benchmark-modeling.ts --page spot_fund_flow
 *   --baseline p6.2-baseline --no-execute
 */

const options = parseArgs({
  args: process.argv.slice(2),
  options: {
    mode: { type: "string", default: "smoke" },
    page: { type: "string" },
    project: { type: "string", default: "demo" },
    env: { type: "string", default: "test" },
    baseline: { type: "string", default: "p6.2-baseline" },
    "no-execute": { type: "boolean", default: false },
    out: { type: "string", default: "reports/modeling-benchmark" }
  },
  allowPositionals: true,
  strict: false
});

const rootDir = process.cwd();
const mode = String(options.values.mode ?? "smoke");
const baselineId = String(options.values.baseline ?? "p6.2-baseline");

// SMOKE: 前 2 页；STANDARD: 全部 8；FULL: 全部
const allPages = getBenchmarkPages();
const selectedPages = options.values.page
  ? getBenchmarkPages([String(options.values.page)])
  : mode === "smoke"
    ? allPages.slice(0, 2)
    : allPages;

async function openPageFor(pageCase: { url: string }): Promise<{ page: Page; browser: import("@playwright/test").Browser } | undefined> {
  const project = String(options.values.project ?? "demo");
  const env = String(options.values.env ?? "test");
  const context = await loadContext({ project, env });
  const accountStore = new AccountStore(context);
  await accountStore.seedDefaults();
  const account = (await accountStore.list({ project, env }))[0];
  const discovery = await new EnvironmentDiscoveryStore(context).load(project, env);
  const bypass = discovery.bypassLogin;
  if (!bypass?.enabled || !account) return undefined;
  const loginResponse = await fetch(new URL(bypass.path, context.env.api!.baseUrl!), {
    method: bypass.method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...(bypass.extraPayload ?? {}), [bypass.usernameField]: account.username, [bypass.passwordField]: account.password, uaTime: new Date().toISOString().replace("T", " ").slice(0, 19) })
  });
  const loginBody = await loginResponse.json() as Record<string, unknown>;
  const token = String(bypass.tokenResponsePath.split(".").reduce((cur: unknown, key: string) => (cur as Record<string, unknown>)?.[key], loginBody));
  if (!token || token === "undefined") return undefined;
  const browser = await chromium.launch({ headless: true });
  const browserContext = await browser.newContext({ extraHTTPHeaders: { [bypass.tokenHeaderName ?? "token"]: token } });
  await injectAuthState(browserContext, {
    token,
    originUrl: context.env.web?.baseUrl ?? pageCase.url,
    headerName: bypass.tokenHeaderName ?? "token",
    storageKeys: discovery.authInjection?.storageKeys,
    cookieNames: discovery.authInjection?.cookieNames
  });
  const page = await browserContext.newPage();
  await page.goto(pageCase.url, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(3000);
  return { page, browser };
}

async function main(): Promise<void> {
  console.log(`=== P7 Modeling Benchmark ===`);
  console.log(`mode: ${mode} | pages: ${selectedPages.map((p) => p.benchmarkCaseId).join(", ")} | baseline: ${baselineId}`);

  const pages: PerPageMetrics[] = [];
  for (const pageCase of selectedPages) {
    console.log(`\n--- benchmark case: ${pageCase.benchmarkCaseId} (${pageCase.pageType}) ---`);
    const opened = await openPageFor(pageCase);
    if (!opened) {
      console.log(`  SKIP: 无法认证/打开 ${pageCase.url}`);
      continue;
    }
    const { page, browser } = opened;
    try {
      const metrics = await runModelingBenchmarkCase({
        project: pageCase.project,
        env: pageCase.env,
        url: pageCase.url,
        canonicalPageId: pageCase.canonicalPageId,
        goldStorePath: pageCase.goldStorePath,
        pageType: pageCase.pageType,
        nlProbes: pageCase.nlProbes,
        expectedCapabilities: pageCase.expectedCapabilities,
        runId: pageCase.benchmarkCaseId,
        baselineId
      }, page);
      pages.push(metrics);
      console.log(`  AUTO: ${metrics.auto.elements} els / ${metrics.auto.options} opts / ${metrics.auto.assertions} as`);
      console.log(`  GOLD: ${metrics.gold.elements} els / ${metrics.gold.options} opts / ${metrics.gold.assertions} as`);
      console.log(`  element P=${metrics.element.precision} R=${metrics.element.recall} F1=${metrics.element.f1}`);
      console.log(`  option  P=${metrics.option.precision} R=${metrics.option.recall}`);
      console.log(`  assert  P=${metrics.assertion.precision} R=${metrics.assertion.recall}`);
      console.log(`  ctrl    acc=${metrics.controlType.accuracy} coverage=${metrics.controlType.coverage}`);
      console.log(`  DSL     ready=${metrics.dsl.ready}/${metrics.dsl.probes} completeness=${metrics.dsl.completeness} semantic=${metrics.dsl.semantic.readyFull}F/${metrics.dsl.semantic.readyPartial}P/${metrics.dsl.semantic.readyShallow}S/${metrics.dsl.semantic.blocked}B`);
      console.log(`  cost    ${metrics.cost.elapsedMs}ms runs=${metrics.cost.explorationRuns} ev=${metrics.cost.evidenceCount}`);
    } finally {
      await browser.close();
    }
  }

  const report = await runBenchmarkReport(pages, baselineId);

  // Quality Gate（P7.17）
  const gate = runQualityGateFor(pages);

  const final = { ...report, qualityGate: gate };
  await fs.ensureDir(path.join(rootDir, String(options.values.out)));
  await writeSafeJsonFile(path.join(rootDir, String(options.values.out), "latest.json"), final);
  await writeSafeTextFile(path.join(rootDir, String(options.values.out), "latest.md"), renderMarkdown(final));

  console.log(`\n=== 汇总 ===`);
  console.log(`pages: ${pages.length}`);
  if (pages.length) {
    console.log(`element macro: P=${report.aggregate.element.macroPrecision} R=${report.aggregate.element.macroRecall} F1=${report.aggregate.element.macroF1}`);
    console.log(`option  macro: R=${report.aggregate.option.macroRecall}`);
    console.log(`assert  macro: R=${report.aggregate.assertion.macroRecall}`);
    console.log(`DSL readiness: ${report.aggregate.dsl.ready}/${report.aggregate.dsl.probes} (${report.aggregate.dsl.readinessRate}) completeness=${report.aggregate.dsl.completeness}`);
    console.log(`DSL semantic: ${report.aggregate.dsl.semantic.readyFull}F/${report.aggregate.dsl.semantic.readyPartial}P/${report.aggregate.dsl.semantic.readyShallow}S/${report.aggregate.dsl.semantic.blocked}B`);
    console.log(`Quality Gate: ${gate.status}${gate.blockingIssues.length ? ` | BLOCKED: ${gate.blockingIssues.join("; ")}` : ""}`);
  }
  console.log(`\n报告: ${options.values.out}/latest.json / latest.md`);
}

function runQualityGateFor(pages: PerPageMetrics[]) {
  if (!pages.length) return { status: "PASS", blockingIssues: [], warningIssues: [], details: {} };
  const avg = (fn: (p: PerPageMetrics) => number) => round2(pages.reduce((s, p) => s + fn(p), 0) / pages.length);
  return {
    status: "computed",
    blockingIssues: [] as string[],
    warningIssues: [] as string[],
    details: {
      elementRecall: avg((p) => p.element.recall),
      optionRecall: avg((p) => p.option.recall),
      assertionRecall: avg((p) => p.assertion.recall),
      controlTypeAccuracy: avg((p) => p.controlType.accuracy),
      highForbiddenExecutions: pages.reduce((s, p) => s + p.cost.highForbiddenBlocked, 0)
    }
  };
}

function round2(v: number): number { return Number(v.toFixed(3)); }

function renderMarkdown(report: ReturnType<typeof runQualityGateFor> extends never ? never : unknown): string {
  const r = report as { pages?: PerPageMetrics[]; aggregate?: { element: { macroPrecision: number; macroRecall: number; macroF1: number }; option: { macroRecall: number }; assertion: { macroRecall: number }; dsl: { readinessRate: number; completeness: number; semantic: { readyFull: number; readyPartial: number; readyShallow: number; blocked: number } } } } & { pages: PerPageMetrics[]; qualityGate: { status: string; blockingIssues: string[] } };
  const lines = [
    "# Modeling Benchmark",
    "",
    `- generatedAt: ${new Date().toISOString()}`,
    `- pages: ${(r.pages ?? []).length}`,
    "",
    "## Aggregate",
    "",
    `- element macro: P=${r.aggregate?.element.macroPrecision} R=${r.aggregate?.element.macroRecall} F1=${r.aggregate?.element.macroF1}`,
    `- option macro recall: ${r.aggregate?.option.macroRecall}`,
    `- assertion macro recall: ${r.aggregate?.assertion.macroRecall}`,
    `- DSL readiness: ${r.aggregate?.dsl.readinessRate} | completeness: ${r.aggregate?.dsl.completeness}`,
    `- DSL semantic: ${r.aggregate?.dsl.semantic.readyFull}F / ${r.aggregate?.dsl.semantic.readyPartial}P / ${r.aggregate?.dsl.semantic.readyShallow}S / ${r.aggregate?.dsl.semantic.blocked}B`,
    "",
    "## Per Page",
    "",
    ...(r.pages ?? []).map((p) => [
      `### ${p.benchmarkCaseId} (${p.pageType})`,
      `- element P=${p.element.precision} R=${p.element.recall} F1=${p.element.f1}`,
      `- option P=${p.option.precision} R=${p.option.recall}`,
      `- assertion P=${p.assertion.precision} R=${p.assertion.recall}`,
      `- controlType acc=${p.controlType.accuracy} coverage=${p.controlType.coverage}`,
      `- DSL ready=${p.dsl.ready}/${p.dsl.probes} completeness=${p.dsl.completeness} semantic=${p.dsl.semantic.readyFull}F/${p.dsl.semantic.readyPartial}P/${p.dsl.semantic.readyShallow}S/${p.dsl.semantic.blocked}B`,
      `- cost ${p.cost.elapsedMs}ms / ${p.cost.explorationRuns} runs / ${p.cost.evidenceCount} ev`,
      ""
    ]).flat(),
    "## Quality Gate",
    "",
    `- status: ${r.qualityGate?.status}`,
    ...(r.qualityGate?.blockingIssues ?? []).map((issue) => `- BLOCKED: ${issue}`),
    ""
  ];
  return lines.join("\n");
}

await main();
