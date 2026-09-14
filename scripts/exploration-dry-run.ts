import fs from "node:fs";
import path from "node:path";
import { matchHeuristicsForGap, buildExplorationPlan, type GapForMatching } from "../src/core/exploration-planner.js";
import { HEURISTIC_REGISTRY, getHeuristic } from "../src/core/exploration-heuristics.js";
import { buildExplorationGaps } from "../src/core/exploration-gaps.js";
import { buildCoverageSnapshot } from "../src/core/exploration-coverage.js";

const rootDir = process.cwd();

async function main() {
  const snapshot = await buildCoverageSnapshot(rootDir, "demo");
  const gapReport = await buildExplorationGaps(rootDir, "demo", snapshot);

  // 从 snapshot 取每个 gap 的控件类型（element 维度）
  const elementControlType = new Map<string, string>();
  for (const page of snapshot.pages) {
    for (const element of page.elements) {
      elementControlType.set(element.elementId, element.controlType ?? "unknown");
    }
  }

  const store = JSON.parse(fs.readFileSync(path.join(rootDir, "storage/page-models/demo.json"), "utf8"));
  const modelsByPage = new Map<string, Record<string, unknown>>(store.models.map((m: Record<string, unknown>) => [String(m.pageId), m]));

  const stats = {
    total: 0, matched: 0, multiMatch: 0, noMatch: 0, notApplicable: 0,
    blockedByRisk: 0, plannableLow: 0, plannableMedium: 0, high: 0, forbidden: 0
  };
  const noMatchGaps: Array<{ gapId: string; controlType?: string; source: string; dimension: string; target: string }> = [];
  const top20Plans: unknown[] = [];

  for (const gap of gapReport.gaps) {
    stats.total++;
    const gapForMatch: GapForMatching = {
      gapId: gap.gapId,
      pageId: gap.pageId,
      dimension: gap.dimension,
      target: gap.target,
      source: gap.source,
      controlType: gap.dimension === "element" ? elementControlType.get(gap.target) : undefined,
      hasElementLocator: gap.dimension === "element"
    };
    const pageModel = modelsByPage.get(gap.pageId);
    const result = matchHeuristicsForGap(gapForMatch, pageModel);

    if (result.verdict === "NO_MATCH") { stats.noMatch++; noMatchGaps.push({ gapId: gap.gapId, controlType: gapForMatch.controlType, source: gap.source, dimension: gap.dimension, target: gap.target }); continue; }
    if (result.verdict === "NOT_APPLICABLE") { stats.notApplicable++; noMatchGaps.push({ gapId: gap.gapId, controlType: gapForMatch.controlType, source: gap.source, dimension: gap.dimension, target: gap.target }); continue; }
    if (result.verdict === "MATCHED") stats.matched++;
    if (result.verdict === "MULTI_MATCH") stats.multiMatch++;

    // 用最高分 heuristic 构建 plan
    const best = result.matched[0];
    const heuristic = getHeuristic(best.heuristicId);
    if (!heuristic) { stats.noMatch++; continue; }
    const plan = buildExplorationPlan({ gap: gapForMatch, pageId: gap.pageId, heuristic, pageModel });
    if (plan.status === "BLOCKED_BY_RISK") {
      stats.blockedByRisk++;
      if (plan.risk === "HIGH") stats.high++;
      if (plan.risk === "FORBIDDEN") stats.forbidden++;
    } else if (plan.risk === "LOW") stats.plannableLow++;
    else if (plan.risk === "MEDIUM") stats.plannableMedium++;

    if (top20Plans.length < 20) {
      top20Plans.push({
        gap: gap.gapId.replace(/^gap:/, "").slice(0, 70),
        priority: gap.priority,
        matchedHeuristic: `${best.heuristicId}@${best.heuristicVersion}`,
        steps: plan.steps.map((s) => s.action),
        risk: plan.risk,
        cost: plan.estimatedCost,
        autoExecutable: plan.risk === "LOW",
        restore: plan.restoreSteps.map((s) => s.action).join(",") || "none",
        evidence: plan.expectedEvidence.slice(0, 3)
      });
    }
  }

  console.log("=== Exploration Dry-run（403 gaps）===");
  console.log(JSON.stringify(stats, null, 1));
  const coverage = ((stats.matched + stats.multiMatch) / stats.total * 100).toFixed(1);
  console.log(`\nGap→Heuristic 覆盖率: ${coverage}%（${stats.matched + stats.multiMatch}/${stats.total}）`);

  console.log("\n=== Top 20 Plans ===");
  top20Plans.forEach((p, i) => {
    const plan = p as Record<string, unknown>;
    console.log(`${i + 1}. [${plan.priority}][risk=${plan.risk}][auto=${plan.autoExecutable}] ${plan.gap}`);
    console.log(`   heuristic: ${plan.matchedHeuristic} | steps: ${(plan.steps as string[]).join(" → ")}`);
    console.log(`   restore: ${plan.restore}`);
  });

  console.log(`\n=== NO_MATCH Top 30 ===`);
  const byControl: Record<string, number> = {};
  noMatchGaps.forEach(g => { byControl[g.controlType ?? "(none)"] = (byControl[g.controlType ?? "(none)"] ?? 0) + 1; });
  console.log("NO_MATCH 按控件类型:", JSON.stringify(byControl));
  noMatchGaps.slice(0, 30).forEach((g, i) => {
    console.log(`${i + 1}. ${g.gapId.replace(/^gap:/, "").slice(0, 75)} | ct=${g.controlType ?? "-"} | src=${g.source}`);
  });

  fs.writeFileSync(path.join(rootDir, "reports/exploration-dry-run.json"), JSON.stringify({ stats, top20Plans, noMatchSample: noMatchGaps.slice(0, 50) }, null, 2));
}

await main();
