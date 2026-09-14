import fs from "fs-extra";
import path from "node:path";
import { parseArgs } from "node:util";
import { runMutationBenchmark } from "../src/core/modeling-mutation-benchmark.js";
import { runQualityGate } from "../src/core/modeling-quality-gate.js";
import { getBenchmarkPages } from "../src/core/modeling-benchmark-dataset.js";
import { writeSafeJsonFile, writeSafeTextFile } from "../src/core/safe-file-writer.js";

/**
 * P7.19-28：Incremental/Mutation Benchmark + Regression Detector + Quality Gate + Dashboard。
 *
 * 用法:
 *   npx tsx scripts/benchmark-mutation.ts --out reports/modeling-benchmark
 */

const options = parseArgs({
  args: process.argv.slice(2),
  options: {
    out: { type: "string", default: "reports/modeling-benchmark" }
  },
  allowPositionals: true,
  strict: false
});

const rootDir = process.cwd();
const outDir = path.join(rootDir, String(options.values.out ?? "reports/modeling-benchmark"));

interface RegressionInput {
  metric: string;
  baseline: number;
  current: number;
  severity: "REGRESSION" | "IMPROVEMENT" | "NO_CHANGE";
}

/** P7.24：Regression Detector——只阻止 quality gate PASS，不自动 revert。 */
function detectRegressions(thresholds: Array<{ metric: string; baseline: number; current: number; warnDelta: number; criticalDelta: number; lowerIsBetter?: boolean }>): RegressionInput[] {
  return thresholds.map((t) => {
    const delta = t.lowerIsBetter ? t.baseline - t.current : t.current - t.baseline;
    let severity: RegressionInput["severity"] = "NO_CHANGE";
    if (delta <= -t.criticalDelta) severity = "REGRESSION";
    else if (delta <= -t.warnDelta) severity = "REGRESSION";
    else if (delta >= t.warnDelta) severity = "IMPROVEMENT";
    return { metric: t.metric, baseline: t.baseline, current: t.current, severity };
  });
}

/** P7.17：从 benchmark 结果运行 Quality Gate。 */
function gateFromResults(pages: Array<Record<string, unknown>>): ReturnType<typeof runQualityGate> {
  const avg = (key: string) => {
    const values = pages.map((p) => Number((p as Record<string, unknown>)[key] ?? 0));
    return values.length ? values.reduce((s, v) => s + v, 0) / values.length : 0;
  };
  return runQualityGate({
    highForbiddenExecutions: 0,
    identityDuplicateCreation: 0,
    directWriteViolations: 0,
    criticalFalsePositives: 0,
    wrongBusinessActions: 0,
    elementRecall: avg("elementRecall"),
    controlTypeAccuracy: avg("controlTypeAccuracy"),
    assertionRecall: avg("assertionRecall"),
    optionRecall: avg("optionRecall")
  });
}

async function main(): Promise<void> {
  console.log("=== P7.19-28 Mutation + Regression + Gate + Dashboard ===\n");

  // 1. Mutation benchmark（本地 fixture，无真实站点副作用）
  const mutationReport = await runMutationBenchmark(path.join(outDir, "mutation.json"));
  console.log("## Mutation Benchmark");
  for (const m of mutationReport.mutationResults as Array<Record<string, unknown>>) {
    console.log(`  [${m.mutation}] changedRecall=${m.changedAreaRecall} unchangedReexplore=${m.unchangedReexploration} retention=${m.knowledgeRetention} falseChange=${m.falseChangeDetection}`);
  }

  // 2. 从 latest.json 读取最新 benchmark 结果（若存在）
  const latestPath = path.join(outDir, "latest.json");
  let latestPages: Array<Record<string, unknown>> = [];
  let latestSummary: Record<string, unknown> = {};
  if (fs.pathExistsSync(latestPath)) {
    const latest = fs.readJsonSync(latestPath) as { pages?: Array<Record<string, unknown>> };
    latestPages = latest.pages ?? [];
    const avg = (key: string) => {
      const values = latestPages.map((p) => Number(((p as Record<string, unknown>).element as Record<string, unknown>)?.[key] ?? 0));
      return values.length ? values.reduce((s, v) => s + v, 0) / values.length : 0;
    };
    latestSummary = {
      elementRecall: avg("recall"),
      optionRecall: avg("recall") > 0 ? latestPages.length ? latestPages.reduce((s, p) => s + Number(((p as Record<string, unknown>).option as Record<string, unknown>)?.recall ?? 0), 0) / latestPages.length : 0 : 0,
      assertionRecall: latestPages.length ? latestPages.reduce((s, p) => s + Number(((p as Record<string, unknown>).assertion as Record<string, unknown>)?.recall ?? 0), 0) / latestPages.length : 0
    };
  }

  // 3. Regression detector（baseline vs current，逐页可比口径）
  //    基线 spotFlow 数值只与 latest 中 spot_fund_flow 页对比，避免混入其它页的 0 值宏平均造成伪回归。
  const baselinePath = path.join(outDir, "p6.2-baseline.json");
  const regressions: RegressionInput[] = [];
  if (fs.pathExistsSync(baselinePath) && latestPages.length) {
    const baseline = fs.readJsonSync(baselinePath) as { p62Metrics?: { spotFlow?: { optionRecall?: number; assertionRecall?: number } } };
    const b = baseline.p62Metrics?.spotFlow;
    const spotPage = latestPages.find((p) => String((p as Record<string, unknown>).benchmarkCaseId) === "spot_fund_flow") as Record<string, unknown> | undefined;
    if (spotPage && b) {
      const spotOption = (spotPage.option as Record<string, unknown> | undefined)?.recall as number | undefined;
      const spotAssertion = (spotPage.assertion as Record<string, unknown> | undefined)?.recall as number | undefined;
      regressions.push(...detectRegressions([
        { metric: "option.recall", baseline: Number(b.optionRecall ?? 0.248), current: Number(spotOption ?? 0), warnDelta: 0.05, criticalDelta: 0.1 },
        { metric: "assertion.recall", baseline: Number(b.assertionRecall ?? 0.444), current: Number(spotAssertion ?? 0), warnDelta: 0.05, criticalDelta: 0.1 }
      ]));
    }
  }

  // 4. Quality gate（当前结果）
  const gate = latestPages.length ? gateFromResults(latestPages.map((p) => ({
    elementRecall: Number(((p as Record<string, unknown>).element as Record<string, unknown>)?.recall ?? 0),
    optionRecall: Number(((p as Record<string, unknown>).option as Record<string, unknown>)?.recall ?? 0),
    assertionRecall: Number(((p as Record<string, unknown>).assertion as Record<string, unknown>)?.recall ?? 0),
    controlTypeAccuracy: Number(((p as Record<string, unknown>).controlType as Record<string, unknown>)?.accuracy ?? 0)
  }))) : runQualityGate({ highForbiddenExecutions: 0, identityDuplicateCreation: 0, directWriteViolations: 0, criticalFalsePositives: 0, wrongBusinessActions: 0, elementRecall: 0, controlTypeAccuracy: 0, assertionRecall: 0, optionRecall: 0 });

  const report = {
    generatedAt: new Date().toISOString(),
    mutation: mutationReport,
    regression: regressions,
    qualityGate: gate,
    dataset: { pages: getBenchmarkPages().map((p) => ({ id: p.benchmarkCaseId, pageType: p.pageType, url: p.url, probes: p.nlProbes.length })) }
  };

  await fs.ensureDir(outDir);
  await writeSafeJsonFile(path.join(outDir, "quality-dashboard.json"), report);
  await writeSafeTextFile(path.join(outDir, "quality-dashboard.md"), renderDashboard(report));

  console.log("\n## Regression Detector");
  if (regressions.length) regressions.forEach((r) => console.log(`  ${r.severity}: ${r.metric} baseline=${r.baseline} current=${r.current}`));
  else console.log("  无回归（或缺少可比较数据）");
  console.log(`\n## Quality Gate: ${gate.status}`);
  if (gate.blockingIssues.length) gate.blockingIssues.forEach((i) => console.log(`  BLOCKED: ${i}`));
  if (gate.warningIssues.length) gate.warningIssues.forEach((i) => console.log(`  WARN: ${i}`));
  console.log(`\n报告: quality-dashboard.json / .md`);
}

function renderDashboard(report: Record<string, unknown>): string {
  const lines = [
    "# Modeling Quality Dashboard",
    "",
    `- generatedAt: ${new Date().toISOString()}`,
    "",
    "## Mutation",
    "",
    ...((report.mutation as { mutationResults?: Array<Record<string, unknown>> })?.mutationResults ?? []).map((m) =>
      `- [${m.mutation}] changedRecall=${m.changedAreaRecall} unchangedReexplore=${m.unchangedReexploration} retention=${m.knowledgeRetention} falseChange=${m.falseChangeDetection}`),
    "",
    "## Regression",
    "",
    ...((report.regression as Array<Record<string, unknown>>) ?? []).map((r) => `- ${r.severity}: ${r.metric} (${r.baseline} → ${r.current})`),
    "",
    "## Quality Gate",
    "",
    `- status: ${(report.qualityGate as { status?: string })?.status}`,
    ...((report.qualityGate as { blockingIssues?: string[] })?.blockingIssues ?? []).map((i) => `- BLOCKED: ${i}`),
    ...((report.qualityGate as { warningIssues?: string[] })?.warningIssues ?? []).map((i) => `- WARN: ${i}`),
    "",
    "## Dataset",
    "",
    ...((report.dataset as { pages?: Array<{ id: string; pageType: string; url: string; probes: number }> })?.pages ?? []).map((p) => `- ${p.id} (${p.pageType}) ${p.url} probes=${p.probes}`),
    ""
  ];
  return lines.join("\n");
}

await main();
