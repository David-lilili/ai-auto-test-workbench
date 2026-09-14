/**
 * P9.41：Context Report。
 *
 * 汇总全部 context 系统产物 → reports/context/latest.json / latest.md。
 */

import fs from "fs-extra";
import path from "node:path";
import { loadDocumentRegistry, loadSourceOfTruth, validateDocumentRegistry } from "../src/context/registry.js";
import { loadTaskProfiles } from "../src/context/task-context.js";
import { runContextBenchmark, runContextDoctor } from "../src/context/benchmark-doctor.js";
import { writeSafeJsonFile, writeSafeTextFile } from "../src/core/safe-file-writer.js";

const ROOT = process.cwd();
const OUT = "reports/context";

function readIfExists(p: string): Record<string, unknown> | undefined {
  const full = path.join(ROOT, p);
  return fs.pathExistsSync(full) ? JSON.parse(fs.readFileSync(full, "utf8")) : undefined;
}

async function main(): Promise<void> {
  await fs.ensureDir(OUT);
  const registry = await loadDocumentRegistry(ROOT);
  const profiles = await loadTaskProfiles(ROOT);
  const sourceOfTruth = await loadSourceOfTruth(ROOT);
  const currentState = readIfExists("configs/ai-context/current-state.json");
  const inventory = readIfExists("reports/context-audit/document-inventory.json");
  const trials = readIfExists("reports/context/trials.json");
  const doctor = runContextDoctor({ registry, rootDir: ROOT, knownDocumentIds: registry.documents.map((d) => d.documentId), summaryRegistry: [], benchmarkOk: true });
  const registryIssues = validateDocumentRegistry(registry);

  const benchmark = runContextBenchmark({
    registry,
    profiles,
    rootDir: ROOT,
    sourceCommit: String(currentState?.sourceCommit ?? "unknown"),
    currentPhase: String(currentState?.currentPhase ?? "unknown"),
    sourceOfTruthDomains: sourceOfTruth.entries.map((e) => e.domain),
    coldStartPassed: Boolean(((trials?.p9_38_coldStart as { pass?: boolean } | undefined)?.pass) ?? false)
  });

  const report = {
    generatedAt: new Date().toISOString(),
    documents: registry.documents.length,
    taskProfiles: profiles.profiles.length,
    sourceOfTruthEntries: sourceOfTruth.entries.length,
    registryIssues: registryIssues.length,
    doctor,
    benchmark,
    inventory: inventory ? (inventory as { summary?: Record<string, unknown> }).summary : undefined,
    trials: trials ? {
      p9_37: (trials as { p9_37_realTrials?: { verdict?: string } }).p9_37_realTrials?.verdict,
      p9_38: (trials as { p9_38_coldStart?: { pass?: boolean } }).p9_38_coldStart?.pass,
      p9_39: (trials as { p9_39_drift?: { allDetected?: boolean } }).p9_39_drift?.allDetected,
      p9_40: (trials as { p9_40_tokenAnalysis?: { tokenReductionRatio?: number } }).p9_40_tokenAnalysis?.tokenReductionRatio
    } : undefined,
    qualityGate: {
      blockingIssues: registryIssues.filter((i) => i.includes("重复") || i.includes("不存在") || i.includes("指向不存在")),
      doctorPass: doctor.pass,
      classificationAccuracy: benchmark.taskClassificationAccuracy,
      mandatoryRecall: benchmark.mandatoryContextRecall
    }
  };

  await writeSafeJsonFile(path.join(OUT, "latest.json"), report);

  const md = [
    "# Context Report",
    "",
    `- generatedAt: ${report.generatedAt}`,
    "",
    "## Registry",
    "",
    `- documents: ${report.documents} | task profiles: ${report.taskProfiles} | source-of-truth entries: ${report.sourceOfTruthEntries}`,
    `- registry issues: ${report.registryIssues}`,
    "",
    "## Doctor",
    "",
    `- pass: ${report.doctor.pass}`,
    `- missing files: ${report.doctor.missingFiles.length} | broken links: ${report.doctor.brokenLinks.length} | stale summaries: ${report.doctor.staleSummaries.length}`,
    `- duplicate SoT: ${report.doctor.duplicateSourceOfTruth.length} | deprecated refs: ${report.doctor.deprecatedReferences.length}`,
    "",
    "## Benchmark",
    "",
    `- classification accuracy: ${report.benchmark.taskClassificationAccuracy}`,
    `- mandatory context recall: ${report.benchmark.mandatoryContextRecall}`,
    `- context precision: ${report.benchmark.contextPrecision}`,
    `- critical misses: ${report.benchmark.criticalContextMisses}`,
    `- avg pack sources: ${report.benchmark.averagePackSources} | avg tokens: ${report.benchmark.averageEstimatedTokens}`,
    `- stale rate: ${report.benchmark.staleSourceRate} | conflict rate: ${report.benchmark.conflictRate} | cold-start pass rate: ${report.benchmark.coldStartPassRate}`,
    "",
    "## Trials",
    "",
    `- P9.37 real task trials: ${report.trials?.p9_37}`,
    `- P9.38 cold-start: ${report.trials?.p9_38}`,
    `- P9.39 drift all detected: ${report.trials?.p9_39}`,
    `- P9.40 token reduction: ${Math.round(Number(report.trials?.p9_40 ?? 0) * 100)}%`,
    "",
    "## Quality Gate",
    "",
    `- blocking issues: ${report.qualityGate.blockingIssues.length}`,
    `- doctor pass: ${report.qualityGate.doctorPass}`,
    `- classification accuracy: ${report.qualityGate.classificationAccuracy}`,
    `- mandatory recall: ${report.qualityGate.mandatoryRecall}`,
    ""
  ].join("\n");
  await writeSafeTextFile(path.join(OUT, "latest.md"), md);

  console.log(`context report 输出: ${OUT}/latest.json / latest.md`);
}

await main();
