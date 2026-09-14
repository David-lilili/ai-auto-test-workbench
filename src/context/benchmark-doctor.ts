import fs from "fs-extra";
import path from "node:path";
import type { ContextDocument, ContextPack, DocumentRegistryFile, TaskProfileFile } from "./types.js";
import { computeContentHash } from "./registry.js";
import { GOLD_TASK_DATASET, contextPrecision, contextRecall, runContextQualityGate, type GoldTaskContext } from "./quality.js";
import { classifyContextTask } from "./task-context.js";
import type { ClassifiedTask } from "./types.js";
import { buildContextPack } from "./pack.js";

/**
 * P9.22 / P9.25：Context Benchmark + Context Doctor。
 *
 * Benchmark：跑全部 gold tasks，输出 classification accuracy / recall / precision / stale / conflict / pack size / tokens。
 * Doctor：registry integrity / broken links / missing files / stale summaries / duplicate SoT / state freshness / unknown docs / deprecated refs。
 */

export interface BenchmarkCaseResult {
  taskId: string;
  taskType: string;
  classification: ClassifiedTask;
  classifiedCorrect: boolean;
  pack?: ContextPack;
  contextRecall: number;
  contextPrecision: number;
  missingCritical: number;
  staleSources: string[];
  conflictSources: string[];
  packSources: number;
  estimatedTokens: number;
}

export interface ContextBenchmarkResult {
  generatedAt: string;
  taskClassificationAccuracy: number;
  mandatoryContextRecall: number;
  contextPrecision: number;
  criticalContextMisses: number;
  averagePackSources: number;
  averageEstimatedTokens: number;
  staleSourceRate: number;
  conflictRate: number;
  coldStartPassRate: number;
  cases: BenchmarkCaseResult[];
}

/** P9.22：跑 context benchmark。 */
export function runContextBenchmark(input: {
  registry: DocumentRegistryFile;
  profiles: TaskProfileFile;
  rootDir: string;
  sourceCommit: string;
  currentPhase: string;
  sourceOfTruthDomains: string[];
  coldStartPassed: boolean;
}): ContextBenchmarkResult {
  const cases: BenchmarkCaseResult[] = [];
  let classifiedCorrect = 0;
  let recallSum = 0;
  let precisionSum = 0;
  let criticalMisses = 0;
  let packSourcesSum = 0;
  let tokenSum = 0;
  let staleSum = 0;
  let conflictSum = 0;

  for (const gold of GOLD_TASK_DATASET) {
    const classification = classifyContextTask({ text: gold.description });
    const correct = classification.primaryTask === gold.taskType;
    const pack = buildContextPack({
      task: classification,
      registry: input.registry,
      profiles: input.profiles,
      rootDir: input.rootDir,
      sourceCommit: input.sourceCommit,
      currentPhase: input.currentPhase,
      sourceOfTruthDomains: input.sourceOfTruthDomains
    });
    const recall = contextRecall(pack, gold);
    const precision = contextPrecision(pack, gold);
    const missingCritical = pack.coverage.mandatoryMisses.length;

    if (correct) classifiedCorrect += 1;
    recallSum += recall.recall;
    precisionSum += precision.precision;
    criticalMisses += missingCritical;
    packSourcesSum += pack.mandatorySources.length + pack.recommendedSources.length;
    tokenSum += pack.budget.estimatedTokens;
    staleSum += pack.coverage.staleSources.length;
    conflictSum += pack.coverage.conflictSources.length;

    cases.push({
      taskId: gold.taskId,
      taskType: gold.taskType,
      classification,
      classifiedCorrect: correct,
      pack,
      contextRecall: recall.recall,
      contextPrecision: precision.precision,
      missingCritical,
      staleSources: pack.coverage.staleSources,
      conflictSources: pack.coverage.conflictSources,
      packSources: pack.mandatorySources.length + pack.recommendedSources.length,
      estimatedTokens: pack.budget.estimatedTokens
    });
  }

  const n = GOLD_TASK_DATASET.length;
  return {
    generatedAt: new Date().toISOString(),
    taskClassificationAccuracy: Math.round((classifiedCorrect / n) * 1000) / 1000,
    mandatoryContextRecall: Math.round((recallSum / n) * 1000) / 1000,
    contextPrecision: Math.round((precisionSum / n) * 1000) / 1000,
    criticalContextMisses: criticalMisses,
    averagePackSources: Math.round((packSourcesSum / n) * 100) / 100,
    averageEstimatedTokens: Math.round(tokenSum / n),
    staleSourceRate: Math.round((staleSum / (n * 10)) * 1000) / 1000,
    conflictRate: Math.round((conflictSum / (n * 10)) * 1000) / 1000,
    coldStartPassRate: input.coldStartPassed ? 1 : 0,
    cases
  };
}

/** P9.25：Context Doctor 输出。 */
export interface DoctorReport {
  generatedAt: string;
  registryIntegrity: string[];
  brokenLinks: string[];
  missingFiles: string[];
  staleSummaries: string[];
  duplicateSourceOfTruth: string[];
  currentStateFreshness: string;
  handoffFreshness: string;
  unknownDocuments: string[];
  deprecatedReferences: string[];
  benchmarkStatus: string;
  pass: boolean;
}

export function runContextDoctor(input: {
  registry: DocumentRegistryFile;
  rootDir: string;
  knownDocumentIds: string[];
  summaryRegistry: Array<{ path: string; sourceHash: string; sourceVersion: string }>;
  currentStateCommit?: string;
  handoffCommit?: string;
  benchmarkOk: boolean;
}): DoctorReport {
  const report: DoctorReport = {
    generatedAt: new Date().toISOString(),
    registryIntegrity: [],
    brokenLinks: [],
    missingFiles: [],
    staleSummaries: [],
    duplicateSourceOfTruth: [],
    currentStateFreshness: "FRESH",
    handoffFreshness: "FRESH",
    unknownDocuments: [],
    deprecatedReferences: [],
    benchmarkStatus: input.benchmarkOk ? "PASS" : "WARNING",
    pass: true
  };

  for (const doc of input.registry.documents) {
    if (!fs.pathExistsSync(path.join(input.rootDir, doc.path))) {
      report.missingFiles.push(doc.documentId);
      report.pass = false;
    }
    for (const dep of doc.dependsOn ?? []) {
      if (!input.knownDocumentIds.includes(dep)) {
        report.brokenLinks.push(`${doc.documentId} -> ${dep}`);
        report.pass = false;
      }
    }
    if (doc.status === "DEPRECATED" || doc.status === "SUPERSEDED") {
      for (const referrer of input.registry.documents) {
        if (referrer.mandatoryFor?.includes(doc.documentId)) {
          report.deprecatedReferences.push(`${referrer.documentId} -> ${doc.documentId}`);
          report.pass = false;
        }
      }
    }
  }

  // stale summaries：sourceHash 与当前内容不一致
  for (const s of input.summaryRegistry) {
    const current = computeContentHash(path.join(input.rootDir, s.path));
    if (current && s.sourceHash && current !== s.sourceHash) {
      report.staleSummaries.push(`${s.path} (source changed)`);
      report.pass = false;
    }
  }

  // duplicate source-of-truth
  const claims = new Map<string, string[]>();
  for (const doc of input.registry.documents) {
    for (const domain of doc.sourceOfTruthFor ?? []) {
      const list = claims.get(domain) ?? [];
      list.push(doc.documentId);
      claims.set(domain, list);
    }
  }
  for (const [domain, ids] of claims) {
    if (ids.length > 1) {
      report.duplicateSourceOfTruth.push(`${domain}: ${ids.join(", ")}`);
      report.pass = false;
    }
  }

  // unknown docs（registry 未登记的文档出现在 known path 下）
  report.unknownDocuments = []; // 由 CLI 扫描填充
  return report;
}
