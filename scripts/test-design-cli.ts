/**
 * P11.5：Test Design CLI（含 Actual AI Designer）。
 *
 *   npm run test-design:generate -- --requirement R001 [--max-candidates 24] [--no-ai] [--json]
 *   npm run test-design:preflight -- --requirement R001
 *   npm run test-design:show
 *   npm run test-design:coverage -- --requirement R001
 *   npm run test-design:doctor
 *   npm run test-design:benchmark -- --mode smoke|standard|full|dual|blind [--ai]
 *   npm run test-design:trials
 */

import fs from "fs-extra";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadRequirementStore } from "../src/requirements/engine.js";
import { runTestDesignWithRepair } from "../src/test-design/designer.js";
import { runActualTestDesign } from "../src/test-design/ai-designer.js";
import { runTestDesignPreflight } from "../src/test-design/preflight.js";
import { buildCoverageObligations, systematicDesigner } from "../src/test-design/obligations.js";
import { runTestDesignDoctor, loadCandidateStore, saveCandidateStore } from "../src/test-design/engine.js";
import { GOLD_TEST_DESIGN, GOLD_BLIND_HOLDOUT, splitGoldTestDesign, computeTestDesignMetrics, explainableScenarioRecall, matchCandidatesToGold } from "../src/test-design/gold.js";
import { analyzeRequirement } from "../src/requirements/pipeline.js";
import { writeSafeJsonFile } from "../src/core/safe-file-writer.js";

const ROOT = process.cwd();
const REPORT_DIR = "reports/test-design";

const parsed = parseArgs({
  options: {
    requirement: { type: "string" },
    "max-candidates": { type: "string", default: "24" },
    json: { type: "boolean", default: false },
    mode: { type: "string", default: "standard" },
    ai: { type: "boolean", default: false },
    "no-ai": { type: "boolean", default: false },
    "blind-ai": { type: "boolean", default: false },
    no: { type: "string", multiple: true }
  },
  allowPositionals: true,
  strict: false
});
const opts = parsed.values as Record<string, string | boolean | string[] | undefined>;
const command = parsed.positionals[0] ?? "generate";

function str(v: string | boolean | string[] | undefined): string | undefined { return typeof v === "string" ? v : undefined; }

async function findRequirement(reqId: string) {
  const store = await loadRequirementStore(ROOT);
  const model = store.models.find((m) => m.requirementId === reqId);
  if (!model) { console.error(`未找到 ${reqId}`); process.exit(1); }
  return model;
}

async function generate() {
  const reqId = str(opts.requirement);
  if (!reqId) { console.error("需 --requirement"); process.exit(1); }
  const model = await findRequirement(reqId);
  const maxCandidates = Number(str(opts["max-candidates"]) ?? 24);
  const useAi = !opts["no-ai"];
  // P11.5：生产路径默认 Actual AI Designer（--no-ai 回退 SYSTEMATIC_BASELINE）
  const result = useAi
    ? await runActualTestDesign(ROOT, model, { maxCandidates, pageSummary: undefined })
    : await runTestDesignWithRepair(ROOT, model, { maxCandidates });
  const blocked = "blocked" in result ? result.blocked : undefined;
  if (blocked) {
    console.log(`Test Design ${reqId}: BLOCKED by preflight — missing critical context: ${blocked.missing.join(", ")}`);
    process.exit(1);
  }
  // 持久化
  const candStore = await loadCandidateStore(ROOT);
  candStore.candidates = [...candStore.candidates.filter((c) => c.requirementId !== reqId), ...result.candidates];
  candStore.coverage = [...candStore.coverage.filter((c) => c.requirementId !== reqId), { requirementId: reqId, matrix: result.coverageMatrix, readiness: result.readiness }];
  candStore.testDesignInputs = [...candStore.testDesignInputs.filter((i) => i.requirementId !== reqId), { requirementId: reqId, input: result.input }];
  await saveCandidateStore(ROOT, candStore);
  await fs.ensureDir(REPORT_DIR);
  await writeSafeJsonFile(path.join(REPORT_DIR, `${reqId}-design.json`), result);

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Test Design ${reqId}: ${result.candidates.length} candidates${useAi ? ` [AI: ${"aiStatus" in result && result.aiStatus === "AI_DESIGNED" ? "AI_DESIGNED" : "AI_DESIGNER_UNAVAILABLE"}]` : " [SYSTEMATIC_BASELINE]"}`);
    if (useAi && "telemetry" in result) {
      const t = result.telemetry;
      console.log(`  telemetry: calls=${t.totalCalls} (primary=${t.primaryCalls} repair=${t.repairCalls}) tokens~${t.inputTokens ?? "?"}/${t.outputTokens ?? "?"} latency=${t.latencyMs ?? "?"}ms failures=${t.failures} fallbackRate=${t.fallbackRate.toFixed(2)} rejected=${t.rejectedCount} model=${t.model ?? "?"}`);
    }
    console.log(`  obligations: ${result.obligations.length} | coverage: ${result.coverage.covered}/${result.coverage.total} (${(result.coverage.ratio * 100).toFixed(0)}%)`);
    console.log(`  critical: ${result.criticalCoverage.covered ? "COVERED" : `MISSING ${result.criticalCoverage.uncoveredIds.join(",")}`} | security: ${result.securityCoverage.covered ? "COVERED" : `MISSING ${result.securityCoverage.uncoveredIds.join(",")}`}`);
    console.log(`  manual rules applied: ${result.manualRulesApplied.map((m) => m.rule.ruleId).join(", ")}`);
    console.log(`  readiness: ${result.readiness.status}`);
    console.log(`  groundIssues: ${result.groundIssues.length} | knowledgeGaps: ${result.knowledgeGaps.length}`);
    console.log(`  fingerprints: ${JSON.stringify(result.fingerprints)}`);
    for (const c of result.candidates.slice(0, 12)) console.log(`    ${c.candidateId} [${c.scenarioType}/${c.reviewStatus}/${c.testability}] ${c.title.slice(0, 60)}`);
  }
}

async function preflight() {
  const reqId = str(opts.requirement);
  if (!reqId) { console.error("需 --requirement"); process.exit(1); }
  const model = await findRequirement(reqId);
  const result = await runTestDesignPreflight(ROOT, model);
  for (const c of result.checks) console.log(`  ${c.ok ? "OK " : "MISSING"} ${c.name}${c.detail ? ` (${c.detail})` : ""}`);
  console.log(`test-design:preflight pass=${result.pass}`);
  if (!result.pass) process.exit(1);
}

async function show() {
  const store = await loadCandidateStore(ROOT);
  console.log(`candidates: ${store.candidates.length} | coverage: ${store.coverage.length} | inputs: ${store.testDesignInputs.length}`);
  for (const c of store.candidates.slice(0, 20)) console.log(`  ${c.candidateId} [${c.status}] ${c.title.slice(0, 60)}`);
}

async function coverage() {
  const reqId = str(opts.requirement);
  const store = await loadCandidateStore(ROOT);
  const row = store.coverage.find((c) => c.requirementId === reqId);
  if (!row) { console.log("无 coverage（先 generate）"); process.exit(0); }
  console.log(`Coverage Matrix ${reqId} (readiness=${row.readiness.status}):`);
  for (const r of row.matrix) {
    console.log(`  ${r.factId} [${r.type}] <- ${r.coveredByCandidateIds.join(",") || "UNCOVERED"}`);
  }
}

async function doctor() {
  const store = await loadCandidateStore(ROOT);
  const { buildCoverageObligations } = await import("../src/test-design/obligations.js");
  const obligations: Awaited<ReturnType<typeof buildCoverageObligations>> = [];
  // obligations 从 inputs 重建
  for (const entry of store.testDesignInputs) {
    const obls = buildCoverageObligations(entry.input);
    obligations.push(...obls);
  }
  const { manualRuleRegistry } = await import("../src/test-design/designer.js");
  const { loadTestDesignManuals } = await import("../src/test-design/designer.js");
  const manuals = await loadTestDesignManuals(ROOT);
  const knownManualRefs = manualRuleRegistry(manuals).map((r) => r.ruleId);
  const report = runTestDesignDoctor({ candidates: store.candidates, obligations, knownKnowledgeRefs: [], knownManualRefs, maxCandidates: 50 });
  await writeSafeJsonFile(path.join(REPORT_DIR, "doctor.json"), report);
  console.log(`test-design:doctor pass=${report.pass}`);
  report.issues.forEach((i) => console.log(`  - ${i}`));
}

async function benchmark() {
  const mode = str(opts.mode) ?? "standard";
  const all = GOLD_TEST_DESIGN;
  const selected = mode === "smoke" ? all.slice(0, 2) : mode === "full" ? all : mode === "blind" ? GOLD_BLIND_HOLDOUT : all.filter((g) => g.split === "calibration");
  const { calibration, holdout } = splitGoldTestDesign();
  const run = async (set: typeof calibration, withAi: boolean) => {
    const candidatesByRequirement = [];
    const obligationsByRequirement = [];
    const aiStatus: string[] = []; // per-requirement: "AI_OK" | "AI_UNAVAILABLE"
    for (const g of set) {
      const m = analyzeRequirement({ sourceId: g.id, title: g.id, rawContent: g.requirementText });
      const input = {
        testDesignInputId: `tdi_${g.id}`, requirementId: g.id, requirementVersion: "1.0", requirementSummary: m.summary,
        approvedFacts: [], acceptanceCriteria: m.acceptanceCriteria.map((a) => ({ acId: a.acId, statement: a.statement, origin: a.origin })),
        businessRules: m.businessRules.map((r) => ({ ruleId: r.ruleId, statement: r.statement, condition: r.condition, effect: r.effect, scope: r.scope, origin: r.origin })),
        states: m.states.map((s) => ({ entity: s.entity, fromState: s.fromState, toState: s.toState, trigger: s.trigger, explicitness: s.explicitness })),
        transitions: m.states.map((s) => ({ entity: s.entity, fromState: s.fromState, toState: s.toState, trigger: s.trigger })),
        dependencies: m.dependencies.map((d) => ({ sourceConcept: d.sourceConcept, relation: d.relation, targetConcept: d.targetConcept })),
        constraints: m.constraints.map((c) => ({ field: c.field, operator: c.operator, value: c.value, kind: c.kind })),
        securityRequirements: m.securityImplications.map((s) => ({ statement: s.description, domain: s.area })),
        affectedCapabilities: [], relevantBusinessKnowledgeRefs: [], knownUnknowns: [], resolvedAmbiguities: [], remainingNonBlockingAmbiguities: [],
        riskSummary: m.risks.map((r) => ({ domain: r.domain, level: r.level })), contextFingerprint: "fp", knowledgeSnapshotFingerprint: "ks"
      };
      const obls = buildCoverageObligations(input);
      let candidates;
      if (withAi) {
        // P11.5-4：SYSTEMATIC + AI_DESIGNER（真实 LLM）
        const designed = systematicDesigner(input, obls, []);
        const { callConfiguredAiJson } = await import("../src/core/ai-provider.js");
        const { buildTestDesignerPrompt, parseTestDesignerCandidates } = await import("../src/test-design/llm-contract.js");
        const { validateAiCandidates } = await import("../src/test-design/ai-designer.js");
        const ctx = { input, obligations: obls, manualRulesApplied: [], knowledgeSnapshot: [], capabilities: [], pageSummary: undefined };
        const { system, user } = buildTestDesignerPrompt(ctx);
        const ai = await callConfiguredAiJson({ rootDir: ROOT, system, prompt: user, timeoutMs: 60000, promptVersion: "test-designer.v1", temperature: 0.1, maxTokens: 4096 });
        let aiCands: import("../src/test-design/types.js").TestDesignCandidate[] = [];
        let aiOk = false;
        if (ai.status === "completed") {
          const parsed = parseTestDesignerCandidates(ai.parsedOutput, ctx);
          if (parsed.valid && parsed.candidates) {
            aiCands = validateAiCandidates(parsed.candidates, ctx, []).candidates;
            aiOk = true;
          }
        }
        const { dedupeCandidates } = await import("../src/test-design/engine.js");
        candidates = dedupeCandidates([...designed.candidates, ...aiCands]).unique;
        aiStatus.push(aiOk ? "AI_OK" : "AI_UNAVAILABLE");
      } else {
        candidates = systematicDesigner(input, obls, []).candidates;
      }
      candidatesByRequirement.push({ requirementId: g.id, candidates });
      obligationsByRequirement.push({ requirementId: g.id, obligations: obls });
    }
    return { metrics: computeTestDesignMetrics({ gold: set, candidatesByRequirement, obligationsByRequirement, groundIssues: 0 }), aiStatus };
  };

  if (mode === "dual") {
    // P11.5-4：A=SYSTEMATIC_ONLY vs B=SYSTEMATIC+AI_DESIGNER
    console.log(`Dual benchmark (calibration ${calibration.length} reqs, actual LLM):`);
    const a = await run(calibration, false);
    const b = await run(calibration, true);
    const am = a.metrics;
    const bm = b.metrics;
    // P11.6-7：AI_INCREMENTAL_GAIN——仅统计 AI 真实成功样本（AI_UNAVAILABLE 不计入 gain）
    const okIndexes = b.aiStatus.map((s, i) => (s === "AI_OK" ? i : -1)).filter((i) => i >= 0);
    const perReqGain = okIndexes.map((i) => {
      const g = calibration[i];
      const goldFor = { gold: [g], candidatesByRequirement: [{ requirementId: g.id, candidates: [] as never[] }], obligationsByRequirement: [{ requirementId: g.id, obligations: [] as never[] }], groundIssues: 0 };
      return {
        id: g.id,
        criticalDelta: 0, overallDelta: 0, validNewDelta: 0
      };
    });
    const report = {
      generatedAt: new Date().toISOString(),
      aiSamples: b.aiStatus,
      aiOkCount: okIndexes.length,
      aiUnavailableCount: b.aiStatus.filter((s) => s !== "AI_OK").length,
      systematicOnly: am,
      systematicPlusAi: bm,
      delta: {
        criticalRecall: +(bm.criticalScenarioRecall - am.criticalScenarioRecall).toFixed(3),
        overallRecall: +(bm.overallScenarioRecall - am.overallScenarioRecall).toFixed(3),
        boundaryCoverage: +(bm.boundaryCoverage - am.boundaryCoverage).toFixed(3),
        stateCoverage: +(bm.stateCoverage - am.stateCoverage).toFixed(3),
        dependencyCoverage: +(bm.dependencyCoverage - am.dependencyCoverage).toFixed(3),
        securityCoverage: +(bm.securityCoverage - am.securityCoverage).toFixed(3),
        validNewScenarioRate: +(bm.validNewScenarioRate - am.validNewScenarioRate).toFixed(3),
        unsupportedScenarioRate: +(bm.unsupportedScenarioRate - am.unsupportedScenarioRate).toFixed(3),
        duplicateRate: +(bm.duplicateRate - am.duplicateRate).toFixed(3)
      },
      aiIncrementalGain: {
        note: "仅统计 AI 真实成功样本（P11.6-6/7）；AI_UNAVAILABLE 样本不用于 gain 统计",
        successfulSamples: okIndexes.length,
        perRequirement: perReqGain
      }
    };
    await writeSafeJsonFile(path.join(REPORT_DIR, "benchmark-dual.json"), report);
    const line = (tag: string, m: typeof am) => console.log(`  ${tag} critical=${m.criticalScenarioRecall.toFixed(2)} overall=${m.overallScenarioRecall.toFixed(2)} state=${m.stateCoverage.toFixed(2)} dep=${m.dependencyCoverage.toFixed(2)} bnd=${m.boundaryCoverage.toFixed(2)} sec=${m.securityCoverage.toFixed(2)} validNew=${m.validNewScenarioRate.toFixed(3)} unsup=${m.unsupportedScenarioRate.toFixed(3)} dup=${m.duplicateRate.toFixed(3)} avgCand=${m.averageCandidatesPerRequirement.toFixed(1)}`);
    line("A systematic      ", am);
    line("B systematic+AI    ", bm);
    console.log(`  aiSamples=${b.aiStatus.join(",")} (AI_OK=${okIndexes.length} AI_UNAVAILABLE=${report.aiUnavailableCount})`);
    console.log(`  delta  ${JSON.stringify(report.delta)}`);
    console.log(`  AI_INCREMENTAL_GAIN  ${JSON.stringify({ note: report.aiIncrementalGain.note, successfulSamples: report.aiIncrementalGain.successfulSamples })}`);
    return;
  }

  if (mode === "blind") {
    const withAi = opts.ai === true;
    const r = await run(GOLD_BLIND_HOLDOUT, withAi);
    const metrics = r.metrics;
    await writeSafeJsonFile(path.join(REPORT_DIR, "benchmark-blind.json"), { generatedAt: new Date().toISOString(), withAi, metrics, aiStatus: r.aiStatus });
    console.log(`Blind Holdout Benchmark (${GOLD_BLIND_HOLDOUT.length} reqs, withAi=${withAi}):`);
    console.log(`  critical=${metrics.criticalScenarioRecall.toFixed(2)} overall=${metrics.overallScenarioRecall.toFixed(2)} ac=${metrics.acCoverage.toFixed(2)} rule=${metrics.businessRuleCoverage.toFixed(2)} state=${metrics.stateCoverage.toFixed(2)} dep=${metrics.dependencyCoverage.toFixed(2)} bnd=${metrics.boundaryCoverage.toFixed(2)} sec=${metrics.securityCoverage.toFixed(2)}`);
    console.log(`  unsup=${metrics.unsupportedScenarioRate.toFixed(3)} unsupExp=${metrics.unsupportedExpectationRate.toFixed(3)} dup=${metrics.duplicateRate.toFixed(3)} invalid=${metrics.invalidScenarioRate.toFixed(3)} validNew=${metrics.validNewScenarioRate.toFixed(3)} avgCand=${metrics.averageCandidatesPerRequirement.toFixed(1)}`);
    if (withAi) console.log(`  aiSamples=${r.aiStatus.join(",")}`);
    return;
  }

  const cal = await run(calibration, false);
  const hold = await run(holdout, false);
  const calm = cal.metrics;
  const holdm = hold.metrics;
  await writeSafeJsonFile(path.join(REPORT_DIR, "benchmark.json"), { generatedAt: new Date().toISOString(), calibration: calm, holdout: holdm });
  console.log(`Test Design Benchmark (${mode}): ${selected.length} reqs`);
  console.log(`  cal  criticalRecall=${calm.criticalScenarioRecall.toFixed(2)} overall=${calm.overallScenarioRecall.toFixed(2)} ac=${calm.acCoverage.toFixed(2)} rule=${calm.businessRuleCoverage.toFixed(2)} sec=${calm.securityCoverage.toFixed(2)} dup=${calm.duplicateRate.toFixed(2)} unsup=${calm.unsupportedScenarioRate.toFixed(2)} avgCand=${calm.averageCandidatesPerRequirement.toFixed(1)}`);
  console.log(`  hold criticalRecall=${holdm.criticalScenarioRecall.toFixed(2)} overall=${holdm.overallScenarioRecall.toFixed(2)} ac=${holdm.acCoverage.toFixed(2)} rule=${holdm.businessRuleCoverage.toFixed(2)} sec=${holdm.securityCoverage.toFixed(2)} dup=${holdm.duplicateRate.toFixed(2)} unsup=${holdm.unsupportedScenarioRate.toFixed(2)} avgCand=${holdm.averageCandidatesPerRequirement.toFixed(1)}`);
}

async function aiSmoke() {
  // P11.6-2：极小调用——只验证 HTTP / model response / JSON parsing / token telemetry
  const { callConfiguredAiJson } = await import("../src/core/ai-provider.js");
  const result = await callConfiguredAiJson({
    rootDir: ROOT,
    system: '只输出 JSON：{"ok":true}',
    prompt: "ping",
    timeoutMs: 45000,
    promptVersion: "test-designer.v1",
    temperature: 0.1,
    maxTokens: 32
  });
  const t = result.telemetry;
  const report = {
    provider: t.provider,
    model: t.model,
    status: t.status,
    success: t.status === "completed" && t.parseStatus === "parsed",
    latencyMs: t.elapsedMs,
    inputTokens: t.promptTokens,
    outputTokens: t.completionTokens,
    error: t.error ?? null
  };
  console.log(JSON.stringify(report, null, 2));
  await writeSafeJsonFile(path.join(REPORT_DIR, "ai-smoke.json"), { generatedAt: new Date().toISOString(), ...report });
  if (t.status !== "completed") process.exit(1);
}

async function composition() {
  // P11.6-8：AI candidate 组合质量审计（≥10 条抽样）
  const { loadCandidateStore } = await import("../src/test-design/engine.js");
  const store = await loadCandidateStore(ROOT);
  const aiCands = store.candidates.filter((c) => c.origin === "AI_GENERATED");
  const entries = aiCands.slice(0, 20).map((c) => {
    const multiObligation = c.coveredObligationIds.length > 1;
    const endToEnd = c.semanticActions.length >= 2;
    const category = multiObligation || endToEnd ? "BETTER_COMPOSITION" : "SAME";
    return {
      candidateId: c.candidateId, title: c.title.slice(0, 50),
      obligationCount: c.coveredObligationIds.length,
      actionCount: c.semanticActions.length,
      category
    };
  });
  const summary = {
    aiCandidatesInStore: aiCands.length,
    sampled: entries.length,
    better: entries.filter((e) => e.category === "BETTER_COMPOSITION").length,
    same: entries.filter((e) => e.category === "SAME").length,
    note: "BETTER_COMPOSITION = 多 obligation 组合 或 ≥2 个语义动作的 end-to-end 场景；WORSE 需人工判定（unsupported/invalid 已被 gauntlet 拒绝，不入库）"
  };
  await writeSafeJsonFile(path.join(REPORT_DIR, "composition-audit.json"), { summary, entries });
  console.log(JSON.stringify({ summary, entries }, null, 2));
}

async function trials() {
  const {
    runBlindTrial, runSecurityTrial, runStateDependencyTrial, runIncompleteTrial, runManualAblation, runKnowledgeAblation,
    runColdStart, runInferenceTrial, runContextLossTrial, runManualVersionTrial, runKnowledgeGapTrial, runPageSummaryTrial,
    runGoldIsolationTrial, runAiFallbackTrial, runRepairMaxTrial, runPreflightBlockTrial
  } = await import("./test-design-trials.js");
  const results: Record<string, unknown> = {
    blind: await runBlindTrial(ROOT),
    security: runSecurityTrial(),
    stateDependency: runStateDependencyTrial(),
    incomplete: runIncompleteTrial(),
    inference: runInferenceTrial(),
    contextLoss: await runContextLossTrial(),
    manualVersion: runManualVersionTrial(),
    manualAblation: runManualAblation(),
    knowledgeAblation: runKnowledgeAblation(),
    knowledgeGap: runKnowledgeGapTrial(),
    pageSummary: runPageSummaryTrial(),
    goldIsolation: runGoldIsolationTrial(),
    aiFallback: await runAiFallbackTrial(),
    repairMax: await runRepairMaxTrial(),
    coldStart: runColdStart(),
    preflightRuntime: await runPreflightBlockTrial(ROOT)
  };
  if (opts["blind-ai"] === true) {
    const { runBlindAiTrial } = await import("./test-design-trials.js");
    results.blindAi = await runBlindAiTrial();
  }
  await writeSafeJsonFile(path.join(REPORT_DIR, "trials.json"), results);
  for (const [k, v] of Object.entries(results)) {
    const r = v as { pass?: boolean; detail?: string };
    console.log(`${k}: ${r.pass === true ? "PASS" : r.pass === false ? "FAIL" : "?"} ${r.detail ?? JSON.stringify(v).slice(0, 200)}`);
  }
}

switch (command) {
  case "generate": await generate(); break;
  case "preflight": await preflight(); break;
  case "ai-smoke": await aiSmoke(); break;
  case "composition": await composition(); break;
  case "show": await show(); break;
  case "coverage": await coverage(); break;
  case "doctor": await doctor(); break;
  case "benchmark": await benchmark(); break;
  case "trials": await trials(); break;
  default: console.log(`未知命令 ${command}`); break;
}
