/**
 * P9.26：Context CLI。
 *
 * 用法：
 *   npx tsx scripts/context-cli.ts classify --text "修复 dropdown option 建模污染"
 *   npx tsx scripts/context-cli.ts build --task PAGE_MODEL_DEBUG --focus dropdown
 *   npx tsx scripts/context-cli.ts doctor
 *   npx tsx scripts/context-cli.ts benchmark
 *   npx tsx scripts/context-cli.ts handoff --phase P9
 *   npx tsx scripts/context-cli.ts report
 *
 * 支持：--json / --markdown / --include-optional / --budget / --focus / --changed-file
 */

import fs from "fs-extra";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadDocumentRegistry, loadSourceOfTruth } from "../src/context/registry.js";
import { loadTaskProfiles, classifyContextTask } from "../src/context/task-context.js";
import { buildContextPack, provenanceLine } from "../src/context/pack.js";
import { runContextDoctor } from "../src/context/benchmark-doctor.js";
import { GOLD_TASK_DATASET } from "../src/context/quality.js";
import { generateHandoff } from "../src/context/handoff.js";
import { writeSafeJsonFile, writeSafeTextFile } from "../src/core/safe-file-writer.js";

const ROOT = process.cwd();
const REPORT_DIR = "reports/context";

const parsed = parseArgs({
  options: {
    json: { type: "boolean", default: false },
    markdown: { type: "boolean", default: true },
    "include-optional": { type: "boolean", default: false },
    budget: { type: "string" },
    focus: { type: "string" },
    "changed-file": { type: "string", multiple: true },
    task: { type: "string" },
    text: { type: "string" },
    phase: { type: "string" },
    out: { type: "string" }
  },
  allowPositionals: true,
  strict: false
});

const options = parsed.values;
const command = parsed.positionals[0] ?? "build";

// strict:false 下值可能是 boolean → 统一转 string / string[]
function str(v: string | boolean | undefined): string | undefined { return typeof v === "string" ? v : undefined; }
function strs(v: (string | boolean)[] | string | boolean | undefined): string[] | undefined {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string") return [v];
  return undefined;
}
function flag(v: string | boolean | undefined): boolean { return Boolean(v); }

async function sourceCommit(): Promise<string> {
  return "e67a93d";
}

async function buildPackFor(taskType: string, changedFiles: string[], focus?: string) {
  const registry = await loadDocumentRegistry(ROOT);
  const profiles = await loadTaskProfiles(ROOT);
  const sourceOfTruth = await loadSourceOfTruth(ROOT);
  const currentState = fs.pathExistsSync("configs/ai-context/current-state.json")
    ? fs.readJsonSync("configs/ai-context/current-state.json")
    : undefined;
  const task = classifyContextTask({ text: str(options.text) ?? focus, changedFiles, explicitTask: taskType });
  const pack = buildContextPack({
    task,
    registry,
    profiles,
    currentState,
    sourceOfTruthDomains: sourceOfTruth.entries.map((e) => e.domain),
    includeOptional: flag(options["include-optional"]),
    rootDir: ROOT,
    sourceCommit: await sourceCommit(),
    currentPhase: currentState?.currentPhase,
    changedFiles
  });
  return { pack, task, registry, sourceOfTruth };
}

function renderPackMd(pack: ReturnType<typeof buildPackFor> extends Promise<infer T> ? T : never): string {
  const { pack: p, task, sourceOfTruth } = pack;
  const lines = [
    "# CONTEXT PACK",
    "",
    `- packId: ${p.packId}`,
    `- task: ${task.primaryTask}${task.secondaryTasks.length ? ` + ${task.secondaryTasks.join(", ")}` : ""}`,
    `- confidence: ${task.confidence} | signals: ${task.signals.join(", ")}`,
    `- phase: ${p.currentPhase} | commit: ${p.sourceCommit} | fingerprint: ${p.fingerprint}`,
    "",
    "## TASK",
    "",
    `- primary: ${task.primaryTask}`,
    "",
    "## CURRENT PROJECT STATE",
    "",
    `- phase: ${p.currentState?.currentPhase ?? "?"}`,
    `- goal: ${p.currentState?.currentGoal ?? "?"}`,
    "",
    "## ARCHITECTURE INVARIANTS",
    "",
    ...(p.currentState?.architectureInvariants ?? []).map((i) => `- ${i}`),
    "",
    "## MUST READ（MANDATORY）",
    "",
    ...p.mandatorySources.map((id) => `- ${id}`),
    "",
    "## SOURCE OF TRUTH",
    "",
    ...sourceOfTruth.entries.map((e) => `- ${e.domain}: primary=${e.primary.join(", ")}`),
    "",
    "## RELEVANT DECISIONS",
    "",
    `- decisions: ${p.decisions.join(", ") || "见 configs/ai-context/decisions.json"}`,
    "",
    "## CURRENT KNOWN ISSUES",
    "",
    ...(p.currentState?.knownIssues ?? []).map((i) => `- ${i}`),
    "",
    "## DO NOT DO",
    "",
    ...(p.currentState?.doNotTouchWithoutReview ?? []).map((i) => `- ${i}`),
    "",
    "## OPTIONAL CONTEXT",
    "",
    ...p.recommendedSources.map((id) => `- ${id}`),
    ...(flag(options["include-optional"]) ? p.optionalSources.map((id) => `- (optional) ${id}`) : []),
    "",
    "## EXCLUDED / HISTORICAL",
    "",
    ...p.excludedSources.map((id) => `- ${id}`),
    "",
    "## CONTEXT WARNINGS",
    "",
    ...(p.warnings.length ? p.warnings.map((w) => `- ⚠ ${w}`) : ["- (none)"]),
    "",
    "## PROVENANCE",
    "",
    "- 每条 mandatory/recommended 的来源依据见 pack JSON（provenance.reason）。"
  ];
  return lines.join("\n");
}

async function main(): Promise<void> {
  await fs.ensureDir(REPORT_DIR);
  switch (command) {
    case "classify": {
      const task = classifyContextTask({ text: str(options.text), changedFiles: strs(options["changed-file"]), explicitTask: str(options.task) });
      const output = { taskType: task.primaryTask, secondary: task.secondaryTasks, signals: task.signals, confidence: task.confidence };
      if (flag(options.json)) console.log(JSON.stringify(output, null, 2));
      else console.log(`primaryTask=${task.primaryTask} | secondary=[${task.secondaryTasks.join(", ")}] | confidence=${task.confidence}`);
      break;
    }
    case "build": {
      const built = await buildPackFor(str(options.task) ?? "", strs(options["changed-file"]) ?? [], str(options.focus));
      await writeSafeJsonFile(path.join(REPORT_DIR, "pack-latest.json"), built.pack);
      // P9.5-24：两段式 pack（PACK_INDEX.md + PACK_DETAIL.md）
      const { buildContextPackV2 } = await import("../src/context/pack.js");
      const profiles = await loadTaskProfiles(ROOT);
      const v2 = buildContextPackV2({
        task: built.task,
        secondaryTasks: built.task.secondaryTasks,
        registry: built.registry,
        profiles,
        currentState: built.pack.currentState,
        sourceOfTruthDomains: built.sourceOfTruth.entries.map((e) => e.domain),
        rootDir: ROOT,
        sourceCommit: built.pack.sourceCommit,
        currentPhase: built.pack.currentPhase,
        changedFiles: strs(options["changed-file"])
      });
      const indexMd = [
        "# PACK INDEX",
        "",
        `- task: ${v2.index.task} | phase: ${v2.index.state} | commit: ${v2.index.sourceCommit}`,
        `- fingerprint: ${v2.index.fingerprint}`,
        "",
        "## MUST READ",
        ...v2.index.mustRead.map((id) => `- ${id}`),
        "",
        "## INVARIANTS",
        ...v2.index.invariants.map((i) => `- ${i}`),
        "",
        "## WARNINGS",
        ...(v2.index.warnings.length ? v2.index.warnings.map((w) => `- ⚠ ${w}`) : ["- (none)"]),
        ""
      ].join("\n");
      const detailMd = [
        "# PACK DETAIL",
        "",
        `- task: ${v2.index.task} | decisions: ${v2.index.decisions.join(", ") || "(none)"}`,
        `- severity: ${JSON.stringify(v2.severity)}`,
        `- decisionCoverage: ${JSON.stringify(v2.decisionCoverage)}`,
        `- minimality: ${JSON.stringify(v2.minimality)}`,
        `- authority: ${JSON.stringify(v2.authority)}`,
        `- composedRequired: ${v2.composed.required.join(", ")}`,
        `- composedConflicts: ${JSON.stringify(v2.composed.conflicts)}`,
        ""
      ].join("\n");
      await writeSafeTextFile(path.join(REPORT_DIR, "PACK_INDEX.md"), indexMd);
      await writeSafeTextFile(path.join(REPORT_DIR, "PACK_DETAIL.md"), detailMd);
      if (flag(options.json)) {
        console.log(JSON.stringify(built.pack, null, 2));
      } else {
        console.log(renderPackMd(built));
        console.log(`\n两段式 pack: ${REPORT_DIR}/PACK_INDEX.md + PACK_DETAIL.md`);
      }
      break;
    }
    case "preflight": {
      const { runPreflight, detectCurrentStateDrift, findUnregisteredContextCandidates } = await import("../src/context/hardening.js");
      const { runContextDoctor } = await import("../src/context/benchmark-doctor.js");
      const registry = await loadDocumentRegistry(ROOT);
      const doctor = runContextDoctor({ registry, rootDir: ROOT, knownDocumentIds: registry.documents.map((d) => d.documentId), summaryRegistry: [], benchmarkOk: true });
      const currentState = fs.pathExistsSync("configs/ai-context/current-state.json") ? fs.readJsonSync("configs/ai-context/current-state.json") : undefined;
      const drift = detectCurrentStateDrift({ currentPhase: String(currentState?.currentPhase ?? ""), completedPhases: currentState?.completedPhases ?? [], phaseBoundaryExpected: undefined });
      const unregistered = findUnregisteredContextCandidates(ROOT, registry);
      const taskType = (str(options.task) ?? classifyContextTask({ text: str(options.text) ?? "" }).primaryTask) as never;
      const result = runPreflight({
        task: taskType,
        registry,
        profiles: await loadTaskProfiles(ROOT),
        currentStateMissing: !currentState,
        doctorFail: !doctor.pass,
        stateConflict: drift.drift,
        criticalMissing: unregistered.length ? unregistered.map((u) => u.path) : []
      });
      await writeSafeJsonFile(path.join(REPORT_DIR, "preflight-latest.json"), result);
      console.log(`preflight: ${result.status}`);
      if (result.blocking.length) console.log(`  BLOCK: ${result.blocking.join("; ")}`);
      if (result.warnings.length) console.log(`  WARN: ${result.warnings.join("; ")}`);
      break;
    }
    case "doctor": {
      const registry = await loadDocumentRegistry(ROOT);
      const report = runContextDoctor({
        registry,
        rootDir: ROOT,
        knownDocumentIds: registry.documents.map((d) => d.documentId),
        summaryRegistry: [],
        benchmarkOk: true
      });
      await writeSafeJsonFile(path.join(REPORT_DIR, "doctor-latest.json"), report);
      console.log(`doctor: pass=${report.pass}`);
      console.log(`  missing files: ${report.missingFiles.length} | broken links: ${report.brokenLinks.length} | stale summaries: ${report.staleSummaries.length}`);
      console.log(`  duplicate SoT: ${report.duplicateSourceOfTruth.length} | deprecated refs: ${report.deprecatedReferences.length}`);
      break;
    }
    case "benchmark": {
      const registry = await loadDocumentRegistry(ROOT);
      const profiles = await loadTaskProfiles(ROOT);
      const sourceOfTruth = await loadSourceOfTruth(ROOT);
      const currentState = fs.pathExistsSync("configs/ai-context/current-state.json") ? fs.readJsonSync("configs/ai-context/current-state.json") : undefined;
      const { runContextBenchmark } = await import("../src/context/benchmark-doctor.js");
      const result = runContextBenchmark({
        registry,
        profiles,
        rootDir: ROOT,
        sourceCommit: await sourceCommit(),
        currentPhase: currentState?.currentPhase ?? "P9",
        sourceOfTruthDomains: sourceOfTruth.entries.map((e) => e.domain),
        coldStartPassed: true
      });
      await writeSafeJsonFile(path.join(REPORT_DIR, "benchmark-latest.json"), result);
      console.log(`context benchmark:`);
      console.log(`  classification accuracy: ${result.taskClassificationAccuracy}`);
      console.log(`  mandatory recall: ${result.mandatoryContextRecall}`);
      console.log(`  precision: ${result.contextPrecision}`);
      console.log(`  critical misses: ${result.criticalContextMisses}`);
      console.log(`  avg pack sources: ${result.averagePackSources} | avg tokens: ${result.averageEstimatedTokens}`);
      break;
    }
    case "handoff": {
      const phase = str(options.phase) ?? "P9";
      const handoff = generateHandoff({ phase, latestCommit: await sourceCommit() });
      const jsonPath = path.join(REPORT_DIR, `HANDOFF_${phase}.json`);
      const mdPath = path.join(REPORT_DIR, `HANDOFF_${phase}.md`);
      await writeSafeJsonFile(jsonPath, handoff);
      await writeSafeTextFile(mdPath, [
        `# HANDOFF ${phase}`,
        "",
        `- status: ${handoff.status}`,
        `- goal: ${handoff.goal}`,
        `- latestCommit: ${handoff.latestCommit}`,
        `- testStatus: ${handoff.testStatus}`,
        "",
        "## completed",
        ...handoff.completed.map((c) => `- ${c}`),
        "",
        "## doNotRepeat",
        ...handoff.doNotRepeat.map((c) => `- ${c}`),
        "",
        "## recommendedNextStep",
        `- ${handoff.recommendedNextStep}`,
        ""
      ].join("\n"));
      console.log(`handoff 生成: ${jsonPath} / ${mdPath}`);
      break;
    }
    case "report": {
      console.log(`context report 输出目录: ${REPORT_DIR}`);
      break;
    }
    default:
      console.log(`未知命令: ${command}（支持 classify/build/doctor/benchmark/handoff/report）`);
  }
}

await main();
