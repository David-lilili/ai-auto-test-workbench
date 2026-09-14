import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";
import { runModelingSession } from "./modeling-orchestrator.js";
import { buildGoldModelProjection, type GoldProjectionResult } from "./modeling-gold-projection.js";
import { matchModelElements, scoreElementPair, isSiteNavNoise, type MatchVerdict, type ModelElementLike } from "./modeling-semantic-match.js";
import { computePR, computeControlTypeMatrix, aggregatePR, round, type PrecisionRecall, type MacroWeighted } from "./modeling-quality-metrics.js";
import { planPageModelExecution } from "./page-model-execution-planner.js";
import { writeSafeJsonFile } from "./safe-file-writer.js";
import { logger } from "./logger.js";
import { computeDslSemanticLevel } from "./modeling-dsl-semantic.js";
import { normalizeAssertionSemantics } from "./modeling-assertion-quality.js";

/**
 * P7.4/P7.5：Modeling Benchmark Harness（isolated replay）。
 *
 * 硬隔离：AUTO 建模用空 isolated project（临时 rootDir），gold 只在建模完成后加载用于比较。
 * runModelingBenchmarkCase 绝不读取成熟 store 来辅助 AUTO 建模。
 *
 * 流程：empty isolated → URL → Orchestrator → AUTO Model → Gold Projection → Semantic Match → Metrics → DSL Probe → Report
 */

export interface BenchmarkPageCase {
  benchmarkCaseId: string;
  url: string;
  canonicalPageId: string;
  pageType: "flow_list" | "form" | "modal_heavy" | "tab" | "dropdown_heavy" | "blocked_state" | "security_provider" | "simple_navigation";
  goldStorePath: string; // 成熟 store 路径（仅比较用）
  project: string;
  env: string;
  safeRiskMode: "safe" | "review";
  expectedCapabilities: string[];
  nlProbes: Array<{ id: string; request: string; expectedIntent: string; risk: "LOW" | "MEDIUM" | "HIGH" }>;
}

export interface PerPageMetrics {
  benchmarkCaseId: string;
  url: string;
  canonicalPageId: string;
  pageType: string;
  auto: { elements: number; options: number; assertions: number; resultRegions: number };
  gold: { elements: number; options: number; assertions: number; states: number; dependencies: number };
  element: PrecisionRecall & { verdictDistribution: Record<MatchVerdict, number> };
  option: PrecisionRecall;
  assertion: PrecisionRecall;
  controlType: ReturnType<typeof computeControlTypeMatrix>;
  resultRegion: { autoRegions: number; goldRegions: number; recall: number; autoColumns: string[]; goldColumns: string[]; columnRecall: number; columnPrecision: number };
  dsl: { probes: number; ready: number; readinessRate: number; avgSteps: number; completeness: number; semantic: { readyFull: number; readyPartial: number; readyShallow: number; blocked: number } };
  cost: { elapsedMs: number; browserActions: number; explorationRuns: number; evidenceCount: number; promotions: number; llmCalls: number; manualActions: number; customCodeLines: number; highForbiddenBlocked: number };
  goldProjection: { kept: number; filtered: number };
  raw: Record<string, unknown>;
}

export interface BenchmarkReport {
  generatedAt: string;
  baselineId: string;
  pages: PerPageMetrics[];
  aggregate: {
    element: MacroWeighted;
    option: MacroWeighted;
    assertion: MacroWeighted;
    resultRegion: { totalAutoRegions: number; totalGoldRegions: number; regionRecall: number; columnRecall: number; columnPrecision: number };
    dsl: { probes: number; ready: number; readinessRate: number; avgSteps: number; completeness: number; semantic: { readyFull: number; readyPartial: number; readyShallow: number; blocked: number } };
    cost: { totalElapsedMs: number; totalBrowserActions: number; totalExplorationRuns: number; totalEvidence: number; totalPromotions: number };
  };
  regression: Array<{ metric: string; baseline: number; current: number; delta: number; severity: "REGRESSION" | "IMPROVEMENT" | "NO_CHANGE" }>;
}

export interface BenchmarkRunInput {
  project: string;
  env: string;
  url: string;
  canonicalPageId: string;
  goldStorePath: string;
  pageType: BenchmarkPageCase["pageType"];
  nlProbes: BenchmarkPageCase["nlProbes"];
  expectedCapabilities?: string[];
  budgets?: { maxIterations?: number; maxPlansPerIteration?: number };
  runId?: string;
  baselineId?: string;
}

/** 从成熟 store 读取指定页面的 model（仅比较用）。 */
export function loadGoldModel(goldStorePath: string, canonicalPageId: string): Record<string, unknown> | undefined {
  if (!fs.pathExistsSync(goldStorePath)) return undefined;
  const store = fs.readJsonSync(goldStorePath) as { models?: Array<Record<string, unknown>> };
  return store.models?.find((m) => String(m.pageId) === canonicalPageId);
}

function modelElementLike(element: Record<string, unknown>): ModelElementLike {
  return {
    elementId: String(element.elementId ?? ""),
    semanticName: String(element.semanticName ?? ""),
    controlType: String(element.controlType ?? ""),
    targetField: String(element.targetField ?? ""),
    optionValue: String(element.optionValue ?? ""),
    role: String(element.role ?? ""),
    tag: String(element.tag ?? ""),
    region: String(element.region ?? ""),
    parentElementId: String(element.parentElementId ?? ""),
    locatorCandidates: Array.isArray(element.locatorCandidates) ? element.locatorCandidates as Array<{ value?: string; strategy?: string }> : []
  };
}

/** 计算 element PR（正确口径：recall = TP / goldRelevant；POSSIBLE_MATCH 不计 TP，单列 ambiguous；
 *  AUTO 侧 site-nav 噪音先过滤——P7.2 声明口径，避免导航元素当 FP）。 */
export function computeElementMetrics(autoElements: Array<Record<string, unknown>>, goldElements: ModelElementLike[]): PrecisionRecall & { verdictDistribution: Record<MatchVerdict, number>; ambiguous: number; navNoiseFiltered: number } {
  const nonNoise = autoElements.filter((e) => !isSiteNavNoise(e));
  const navNoiseFiltered = autoElements.length - nonNoise.length;
  const autoLike = nonNoise.map(modelElementLike);
  const matched = matchModelElements(autoLike, goldElements);
  const verdictDistribution: Record<MatchVerdict, number> = {
    EXACT_MATCH: 0, STRONG_MATCH: 0, POSSIBLE_MATCH: 0, UNMATCHED_AUTO: 0, UNMATCHED_GOLD: 0
  };
  let tpCount = 0;
  let fpCount = 0;
  let ambiguous = 0;
  for (const entry of matched) {
    const verdict = entry.result.verdict;
    verdictDistribution[verdict]++;
    if (verdict === "EXACT_MATCH" || verdict === "STRONG_MATCH") tpCount += 1;
    else if (verdict === "POSSIBLE_MATCH") ambiguous += 1; // P7 诚实口径：不半计，单列
    else fpCount += 1;
  }
  // 未匹配的 gold = FN
  const matchedGoldIds = new Set(matched.filter((m) => m.result.matchedGoldId).map((m) => m.result.matchedGoldId));
  const fnCount = goldElements.filter((g) => !matchedGoldIds.has(g.elementId ?? "")).length;
  const goldRelevant = goldElements.length;
  const pr = computePR({ tp: tpCount, fp: fpCount + ambiguous, fn: fnCount, goldRelevant });
  return { ...pr, verdictDistribution, ambiguous, navNoiseFiltered };
}

/** 计算 option PR（optionValue 归一化匹配）。 */
export function computeOptionMetrics(autoElements: Array<Record<string, unknown>>, goldOptions: ModelElementLike[]): PrecisionRecall {
  const autoOptions = autoElements.filter((e) => String(e.controlType) === "dropdown_option" && e.optionValue);
  const goldValues = new Set(goldOptions.map((g) => String(g.optionValue ?? "").toLowerCase()));
  const autoValues = new Set(autoOptions.map((e) => String(e.optionValue ?? "").toLowerCase()));
  let tp = 0;
  for (const value of autoValues) if (goldValues.has(value)) tp++;
  const fp = autoValues.size - tp;
  const fn = goldValues.size - [...goldValues].filter((v) => autoValues.has(v)).length;
  return computePR({ tp, fp, fn, goldRelevant: goldValues.size });
}

/** P8.12-15：ResultRegion / Column 指标。 */
export function computeResultRegionMetrics(autoRegions: Array<Record<string, unknown>>, goldAssertions: Array<Record<string, unknown>>): { autoRegions: number; goldRegions: number; recall: number; autoColumns: string[]; goldColumns: string[]; columnRecall: number; columnPrecision: number } {
  const autoColumns = autoRegions.flatMap((r) => Array.isArray(r.columns) ? (r.columns as Array<Record<string, unknown>>).map((c) => String(c.semanticName ?? "")) : []);
  const goldRegions = goldAssertions.filter((a) => {
    const kind = String(a.canonicalKind ?? a.assertionKind ?? "");
    return kind === "record_or_empty_state" || kind === "result_empty" || kind === "table_column_all_equal";
  }).length;
  // gold 列：从 table_column_all_equal 断言的语义名 "列存在（X）" 提取
  const goldColumns = goldAssertions
    .filter((a) => String(a.canonicalKind ?? "") === "table_column_all_equal")
    .map((a) => {
      const name = String(a.semanticName ?? "");
      const m = name.match(/列存在[（(]([^）)]+)[)）]/);
      return m ? m[1] : name;
    })
    .filter(Boolean);
  const autoColumnSet = new Set(autoColumns.map((c) => String(c).toLowerCase()));
  const goldColumnSet = new Set(goldColumns.map((c) => String(c).toLowerCase()));
  const colTp = [...autoColumnSet].filter((c) => goldColumnSet.has(c)).length;
  const columnRecall = goldColumnSet.size ? colTp / goldColumnSet.size : 0;
  const columnPrecision = autoColumnSet.size ? colTp / autoColumnSet.size : 0;
  const regionRecall = goldRegions ? Math.min(1, autoRegions.length / goldRegions) : 0;
  return {
    autoRegions: autoRegions.length,
    goldRegions,
    recall: round(regionRecall),
    autoColumns: [...new Set(autoColumns)],
    goldColumns: [...new Set(goldColumns)],
    columnRecall: round(columnRecall),
    columnPrecision: round(columnPrecision)
  };
}

/** 计算 assertion PR（canonicalKind + 语义名）。tp 按唯一 gold 匹配计数（recall ≤ 1）。
 *  P8.1 修复：gold 侧历史 kind（ObservableSignal/AssertionCapability）与 auto canonical kind 不同，
 *  首 token 匹配失效；增加语义归一化包含匹配（normalizeAssertionSemantics），
 *  使 "现货流水结果列表或空状态可观察" ↔ "结果列表或空状态" 这类真实业务断言可命中。 */
export function computeAssertionMetrics(autoAssertions: Array<Record<string, unknown>>, goldAssertions: Array<Record<string, unknown>>): PrecisionRecall {
  const goldTexts = goldAssertions.map((g) => `${String(g.canonicalKind ?? g.assertionKind ?? "")} ${String(g.semanticName ?? "")}`.toLowerCase());
  const autoTexts = autoAssertions.map((a) => `${String(a.canonicalKind ?? a.assertionKind ?? "")} ${String(a.semanticName ?? "")}`.toLowerCase());
  // 语义归一化文本（P8.5：同义短语 → result_list/empty_state，去弱词）
  const goldNorms = goldAssertions.map((g) => normalizeAssertionSemantics(String(g.semanticName ?? "")));
  const autoNorms = autoAssertions.map((a) => normalizeAssertionSemantics(String(a.semanticName ?? "")));
  const matchedGold = new Set<number>();
  for (let ai = 0; ai < autoTexts.length; ai += 1) {
    const auto = autoTexts[ai];
    const autoNorm = autoNorms[ai];
    for (let gi = 0; gi < goldTexts.length; gi += 1) {
      const g = goldTexts[gi];
      const goldNorm = goldNorms[gi];
      // ① 首 token（kind）相等 ② 子串包含 ③ 语义归一化后包含（P8.1 新增）
      const kindMatch = auto.split(" ")[0] === g.split(" ")[0];
      const substringMatch = g.includes(auto) || auto.includes(g);
      const semanticMatch = autoNorm.length >= 2 && (goldNorm.includes(autoNorm) || autoNorm.includes(goldNorm));
      if (kindMatch || substringMatch || semanticMatch) {
        matchedGold.add(gi);
      }
    }
  }
  const tp = matchedGold.size;
  const fp = autoTexts.length - tp;
  const fn = goldTexts.length - tp;
  return computePR({ tp, fp, fn, goldRelevant: goldTexts.length });
}

/** 计算 controlType（在 matched pairs 上）。 */
export function computeControlTypeOnMatched(autoElements: Array<Record<string, unknown>>, goldElements: ModelElementLike[]): ReturnType<typeof computeControlTypeMatrix> {
  const autoLike = autoElements.map(modelElementLike);
  const matched = matchModelElements(autoLike, goldElements);
  const pairs: Array<{ gold: string; auto: string }> = [];
  for (const entry of matched) {
    if (!entry.result.matchedGoldId || (entry.result.verdict !== "EXACT_MATCH" && entry.result.verdict !== "STRONG_MATCH")) continue;
    const goldElement = goldElements.find((g) => g.elementId === entry.result.matchedGoldId);
    if (!goldElement) continue;
    pairs.push({ gold: goldElement.controlType ?? "unknown", auto: entry.auto.controlType ?? "unknown" });
  }
  const matrix = computeControlTypeMatrix(pairs);
  matrix.coverage = round(goldElements.length ? pairs.length / goldElements.length : 0);
  matrix.goldRelevant = goldElements.length;
  return matrix;
}

/** DSL probe：生成 DSL 并评估 readiness / completeness（P7.13）+ semantic completeness（P8.24）。 */
export async function runDslProbes(rootDir: string, project: string, env: string, nlProbes: BenchmarkPageCase["nlProbes"], expectedCapabilities: string[]): Promise<{ probes: number; ready: number; readinessRate: number; avgSteps: number; completeness: number; perProbe: Array<Record<string, unknown>>; semantic: { readyFull: number; readyPartial: number; readyShallow: number; blocked: number } }> {
  const storePath = path.join(rootDir, "storage", "page-models", `${project}.json`);
  const perProbe: Array<Record<string, unknown>> = [];
  let ready = 0;
  let totalSteps = 0;
  let completenessSum = 0;
  const semantic = { readyFull: 0, readyPartial: 0, readyShallow: 0, blocked: 0 };
  for (const probe of nlProbes) {
    const plan = await planPageModelExecution({ request: probe.request, pageModelStorePath: storePath, project, env, assertions: [] });
    const executable = plan.materialization.executable;
    const stepCount = plan.materialization.case?.steps?.length ?? 0;
    if (executable) ready++;
    totalSteps += stepCount;
    // completeness：期望 intent action 覆盖（P7.13 简化——按执行层判断 FULL/PARTIAL）
    const completeness = executable ? (stepCount >= 2 ? 1 : 0.5) : 0;
    completenessSum += completeness;
    // P8.24-26：semantic completeness（Intent Requirement Graph + Missing Ops）
    const stepTexts = (plan.materialization.case?.steps ?? []).map((s) => {
      const raw = s as { action?: unknown; semanticTarget?: unknown; semantic_target?: unknown };
      return `${String(raw.action ?? "")} ${String(raw.semanticTarget ?? raw.semantic_target ?? "")}`;
    });
    const semanticLevel = computeDslSemanticLevel(probe.request, stepTexts, executable);
    if (semanticLevel.level === "READY_FULL") semantic.readyFull++;
    else if (semanticLevel.level === "READY_PARTIAL") semantic.readyPartial++;
    else if (semanticLevel.level === "READY_SHALLOW") semantic.readyShallow++;
    else semantic.blocked++;
    perProbe.push({ id: probe.id, request: probe.request, executable, stepCount, completeness, semanticLevel: semanticLevel.level, missingOps: semanticLevel.missing, gaps: plan.gaps.slice(0, 5) });
  }
  return {
    probes: nlProbes.length,
    ready,
    readinessRate: round(nlProbes.length ? ready / nlProbes.length : 0),
    avgSteps: round(nlProbes.length ? totalSteps / nlProbes.length : 0),
    completeness: round(nlProbes.length ? completenessSum / nlProbes.length : 0),
    perProbe,
    semantic
  };
}

/**
 * P7.5：运行单个 benchmark case（isolated replay）。
 * 返回 PerPageMetrics。runId 用于日志/报告隔离。
 */
export async function runModelingBenchmarkCase(input: BenchmarkRunInput, page?: Page): Promise<PerPageMetrics> {
  const { project, env, url, canonicalPageId, goldStorePath, pageType, nlProbes } = input;
  const runId = input.runId ?? `bench_${Date.now()}`;
  const isolatedRoot = await fs.mkdtemp(path.join(os.tmpdir(), `p7-bench-${runId}-`));

  // 1. empty isolated project
  await fs.ensureDir(path.join(isolatedRoot, "storage/page-models"));
  await fs.writeJson(path.join(isolatedRoot, "storage/page-models/demo.json"), { schemaVersion: "page-model-store.v1", project, models: [] });

  // 2. AUTO modeling（不读 gold store）
  const startedAt = Date.now();
  const result = await runModelingSession({
    rootDir: isolatedRoot,
    project,
    env,
    startUrl: url,
    page,
    suggestedPageId: canonicalPageId,
    dryRun: false,
    riskMode: "safe",
    budgets: input.budgets ?? { maxIterations: 4, maxPlansPerIteration: 5 }
  });
  const elapsedMs = Date.now() - startedAt;
  const session = result.session;

  const autoStore = await fs.readJson(path.join(isolatedRoot, "storage/page-models/demo.json")) as { models?: Array<Record<string, unknown>> };
  const autoModel = autoStore.models?.[0];
  const autoElements = (autoModel?.elements as Array<Record<string, unknown>> | undefined) ?? [];
  const autoAssertions = (autoModel?.assertions as Array<Record<string, unknown>> | undefined) ?? [];
  const autoResultRegions = Number(session.initialCapture?.resultRegions ?? 0);
  // P8.12-15：正式物化后 resultRegions[] / columns[] 进入 Page Model
  const autoRegions = (autoModel?.resultRegions as Array<Record<string, unknown>> | undefined) ?? [];
  const autoColumns = autoRegions.flatMap((r) => Array.isArray(r.columns) ? (r.columns as Array<Record<string, unknown>>).map((c) => String(c.semanticName ?? "")) : []);

  // 3. Gold projection（比较用，建模后才加载）
  const matureModel = loadGoldModel(goldStorePath, canonicalPageId);
  const gold: GoldProjectionResult = matureModel
    ? buildGoldModelProjection(matureModel)
    : { goldElements: [], goldOptions: [], goldAssertions: [], goldStates: [], goldDependencies: [], filtered: [], kept: [] };

  // 4. Metrics
  const element = computeElementMetrics(autoElements, gold.goldElements);
  const option = computeOptionMetrics(autoElements, gold.goldOptions);
  const assertion = computeAssertionMetrics(autoAssertions, gold.goldAssertions);
  const controlType = computeControlTypeOnMatched(autoElements, gold.goldElements);
  const resultRegion = computeResultRegionMetrics(autoRegions, gold.goldAssertions);

  // 5. DSL probes
  const dsl = await runDslProbes(isolatedRoot, project, env, nlProbes, input.expectedCapabilities ?? []);

  // 6. Cost
  const evidenceCount = session.evidenceIds.length;
  const explorationRuns = session.progressHistory.reduce((sum, p) => sum + p.exploredPlans.length, 0);
  const cost = {
    elapsedMs,
    browserActions: session.initialCapture?.interactiveElementCount ?? 0,
    explorationRuns,
    evidenceCount,
    promotions: session.promotionResults.length,
    llmCalls: 0,
    manualActions: 0,
    customCodeLines: 0,
    highForbiddenBlocked: session.progressHistory.reduce((sum, p) => sum + (p.riskBlocked ?? 0), 0)
  };

  return {
    benchmarkCaseId: runId,
    url,
    canonicalPageId,
    pageType,
    auto: { elements: autoElements.length, options: autoElements.filter((e) => e.controlType === "dropdown_option").length, assertions: autoAssertions.length, resultRegions: autoResultRegions },
    gold: { elements: gold.goldElements.length, options: gold.goldOptions.length, assertions: gold.goldAssertions.length, states: gold.goldStates.length, dependencies: gold.goldDependencies.length },
    element,
    option,
    assertion,
    controlType,
    resultRegion,
    dsl,
    cost,
    goldProjection: { kept: gold.kept.length, filtered: gold.filtered.length },
    raw: { sessionId: session.sessionId, stopReason: session.stopReason, identity: session.identityVerdict, isolatedRoot }
  };
}

/** 聚合 benchmark report（macro + weighted）。 */
export async function runBenchmarkReport(pages: PerPageMetrics[], baselineId: string): Promise<BenchmarkReport> {
  const element = aggregatePR(pages.map((p) => p.element));
  const option = aggregatePR(pages.map((p) => p.option));
  const assertion = aggregatePR(pages.map((p) => p.assertion));
  const dsl = {
    probes: pages.reduce((s, p) => s + p.dsl.probes, 0),
    ready: pages.reduce((s, p) => s + p.dsl.ready, 0),
    readinessRate: round(pages.reduce((s, p) => s + p.dsl.ready, 0) / Math.max(pages.reduce((s, p) => s + p.dsl.probes, 0), 1)),
    avgSteps: round(pages.reduce((s, p) => s + p.dsl.avgSteps, 0) / Math.max(pages.length, 1)),
    completeness: round(pages.reduce((s, p) => s + p.dsl.completeness, 0) / Math.max(pages.length, 1)),
    semantic: {
      readyFull: pages.reduce((s, p) => s + p.dsl.semantic.readyFull, 0),
      readyPartial: pages.reduce((s, p) => s + p.dsl.semantic.readyPartial, 0),
      readyShallow: pages.reduce((s, p) => s + p.dsl.semantic.readyShallow, 0),
      blocked: pages.reduce((s, p) => s + p.dsl.semantic.blocked, 0)
    }
  };
  const cost = {
    totalElapsedMs: pages.reduce((s, p) => s + p.cost.elapsedMs, 0),
    totalBrowserActions: pages.reduce((s, p) => s + p.cost.browserActions, 0),
    totalExplorationRuns: pages.reduce((s, p) => s + p.cost.explorationRuns, 0),
    totalEvidence: pages.reduce((s, p) => s + p.cost.evidenceCount, 0),
    totalPromotions: pages.reduce((s, p) => s + p.cost.promotions, 0)
  };
  const resultRegion = {
    totalAutoRegions: pages.reduce((s, p) => s + p.resultRegion.autoRegions, 0),
    totalGoldRegions: pages.reduce((s, p) => s + p.resultRegion.goldRegions, 0),
    regionRecall: round(pages.reduce((s, p) => s + p.resultRegion.recall, 0) / Math.max(pages.length, 1)),
    columnRecall: round(pages.reduce((s, p) => s + p.resultRegion.columnRecall, 0) / Math.max(pages.length, 1)),
    columnPrecision: round(pages.reduce((s, p) => s + p.resultRegion.columnPrecision, 0) / Math.max(pages.length, 1))
  };
  return { generatedAt: new Date().toISOString(), baselineId, pages, aggregate: { element, option, assertion, resultRegion, dsl, cost }, regression: [] };
}
