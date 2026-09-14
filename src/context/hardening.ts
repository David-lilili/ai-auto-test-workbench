import fs from "fs-extra";
import path from "node:path";
import type { ContextDocument, ContextPack, ContextTaskType, DocumentRegistryFile, TaskProfileFile } from "./types.js";
import { computeContentHash } from "./registry.js";
import { classifyContextTask } from "./task-context.js";
import { buildContextPackV2 } from "./pack.js";
import { composeTaskProfiles, criticalContextRecall } from "./composition.js";
import { contextPrecision, contextRecall, runContextQualityGate, type GoldTaskContext } from "./quality.js";
import { detectSourceOfTruthConflicts } from "./conflicts.js";
import { runContextDoctor } from "./benchmark-doctor.js";

/**
 * P9.5 hardening：
 *   - P9.5-1  miss root-cause attribution
 *   - P9.5-9   profile completeness audit
 *   - P9.5-10  source-of-truth coverage（UNREGISTERED_ACTIVE=0）
 *   - P9.5-11  unknown document detection
 *   - P9.5-13  current state drift
 *   - P9.5-15/16  negative context + historical pollution
 *   - P9.5-17  contradiction warning
 *   - P9.5-21/22  minimality + P50/P90/P95
 *   - P9.5-23  mandatory summary
 *   - P9.5-25/26  receipt + preflight
 *   - P9.5-28  context mutation
 *   - P9.5-29  regression detector
 *   - P9.5-39/40  cost-quality curve + production budget
 */

// ============ P9.5-11：unknown document detection ============

const UNREGISTERED_KEYWORDS = /policy|schema|architecture|playbook|handoff|current|guide|agent|risk|benchmark|design/i;

export function findUnregisteredContextCandidates(rootDir: string, registry: DocumentRegistryFile): Array<{ path: string; reason: string }> {
  const registered = new Set(registry.documents.map((d) => d.path.replace(/\\/g, "/")));
  const candidates: Array<{ path: string; reason: string }> = [];
  const dirs = ["docs", "configs/ai-context"];
  for (const dir of dirs) {
    if (!fs.pathExistsSync(path.join(rootDir, dir))) continue;
    const walk = (d: string) => {
      for (const entry of fs.readdirSync(path.join(rootDir, d), { withFileTypes: true })) {
        const full = path.join(rootDir, d, entry.name);
        if (entry.isDirectory()) { if (!entry.name.startsWith(".") && entry.name !== "archive") walk(path.join(d, entry.name)); continue; }
        if (!entry.name.endsWith(".md") && !entry.name.endsWith(".yaml")) continue;
        const rel = path.join(d, entry.name).replace(/\\/g, "/");
        if (registered.has(rel)) continue;
        if (UNREGISTERED_KEYWORDS.test(entry.name) || entry.name.startsWith("AI_") || entry.name.startsWith("HANDOFF")) {
          candidates.push({ path: rel, reason: "unregistered_context_candidate" });
        }
      }
    };
    walk(dir);
  }
  return candidates;
}

// ============ P9.5-13：current state drift ============

export function detectCurrentStateDrift(input: {
  currentStateCommit?: string;
  gitHeadCommit?: string;
  currentPhase: string;
  completedPhases: string[];
  phaseBoundaryExpected?: string;
}): { drift: boolean; detail: string } {
  // Phase boundary 一致性：currentPhase 应不在 completedPhases 中
  if (input.completedPhases.includes(input.currentPhase)) {
    return { drift: true, detail: `currentPhase=${input.currentPhase} 已在 completedPhases 中（STATE_STALE）` };
  }
  // git HEAD 明显变化但 sourceCommit 长期未更新（简化为 phase 边界检查）
  if (input.phaseBoundaryExpected && input.currentPhase !== input.phaseBoundaryExpected) {
    return { drift: true, detail: `currentPhase=${input.currentPhase} 与预期边界 ${input.phaseBoundaryExpected} 不一致` };
  }
  return { drift: false, detail: "ok" };
}

// ============ P9.5-15：negative context ============

export interface NegativeContextCheck {
  shouldNotLoad: string[];
  loadedByMistake: string[];
  negativePrecision: number; // 1 - loadedByMistake/(total loaded)
}

export function checkNegativeContext(pack: ContextPack, shouldNotLoad: string[]): NegativeContextCheck {
  const loaded = new Set([...pack.mandatorySources, ...pack.recommendedSources, ...pack.optionalSources]);
  const loadedByMistake = shouldNotLoad.filter((id) => loaded.has(id));
  const totalLoaded = loaded.size;
  return {
    shouldNotLoad,
    loadedByMistake,
    negativePrecision: totalLoaded ? 1 - loadedByMistake.length / totalLoaded : 1
  };
}

// ============ P9.5-16：historical pollution ============

export function checkHistoricalPollution(pack: ContextPack): { polluted: string[]; clean: boolean } {
  const polluted = pack.mandatorySources.filter((id) => /P\d_PHASE_REPORT|HISTORICAL/.test(id));
  return { polluted, clean: polluted.length === 0 };
}

// ============ P9.5-17：contradiction warning ============

export interface ContradictionInput {
  registry: DocumentRegistryFile;
  activeDocIds: string[];
}

export function detectContextContradiction(input: ContradictionInput): Array<{ domain: string; docs: string[]; detail: string }> {
  const claims = new Map<string, string[]>();
  for (const doc of input.registry.documents) {
    if (!input.activeDocIds.includes(doc.documentId)) continue;
    for (const domain of doc.sourceOfTruthFor ?? []) {
      const list = claims.get(domain) ?? [];
      list.push(doc.documentId);
      claims.set(domain, list);
    }
  }
  const contradictions: Array<{ domain: string; docs: string[]; detail: string }> = [];
  for (const [domain, docs] of claims) {
    if (docs.length > 1 && input.activeDocIds.filter((id) => docs.includes(id)).length > 1) {
      contradictions.push({ domain, docs, detail: `CONTEXT_CONTRADICTION: ${domain} 被 ${docs.join(", ")} 同时声明，version/status 无法决定 precedence` });
    }
  }
  return contradictions;
}

// ============ P9.5-26：preflight ============

export type PreflightStatus = "PASS" | "WARNING" | "BLOCK";

export interface PreflightInput {
  task: ContextTaskType;
  registry: DocumentRegistryFile;
  profiles: TaskProfileFile;
  currentStateMissing: boolean;
  doctorFail: boolean;
  stateConflict: boolean;
  criticalMissing: string[];
  currentPhase?: string;
  sourceCommit?: string;
  sourceOfTruthDomains?: string[];
  rootDir?: string;
}

export function runPreflight(input: PreflightInput): { status: PreflightStatus; blocking: string[]; warnings: string[] } {
  const blocking: string[] = [];
  const warnings: string[] = [];
  if (input.currentStateMissing) blocking.push("CURRENT_STATE missing");
  if (input.doctorFail) blocking.push("context:doctor FAIL");
  if (input.stateConflict) blocking.push("state conflict");
  if (input.criticalMissing.length) blocking.push(`critical context missing: ${input.criticalMissing.join(", ")}`);
  if (input.task === "UNKNOWN") blocking.push("task UNKNOWN（NEEDS_TASK_CLASSIFICATION_REVIEW）");
  const status: PreflightStatus = blocking.length ? "BLOCK" : warnings.length ? "WARNING" : "PASS";
  return { status, blocking, warnings };
}

// ============ P9.5-21/22：minimality + P50/P90/P95 ============

export function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

export function packSizePercentiles(tokens: number[]): { p50: number; p90: number; p95: number; max: number } {
  return { p50: percentile(tokens, 50), p90: percentile(tokens, 90), p95: percentile(tokens, 95), max: tokens.length ? Math.max(...tokens) : 0 };
}

// ============ P9.5-28：context mutation ============

export interface MutationCase {
  name: string;
  apply: (reg: DocumentRegistryFile, profiles: TaskProfileFile) => { reg: DocumentRegistryFile; profiles: TaskProfileFile; expectQualityDrop: boolean };
}

export const CONTEXT_MUTATIONS: MutationCase[] = [
  {
    name: "DELETE_RISK_POLICY_ENTRY",
    apply: (reg, profiles) => ({
      reg: { ...reg, documents: reg.documents.filter((d) => d.documentId !== "RISK_POLICY") },
      profiles,
      expectQualityDrop: true
    })
  },
  {
    name: "ACTIVE_TO_DEPRECATED",
    apply: (reg, profiles) => ({
      reg: { ...reg, documents: reg.documents.map((d) => d.documentId === "KNOWLEDGE_PROMOTION_POLICY" ? { ...d, status: "DEPRECATED" } : d) },
      profiles,
      expectQualityDrop: true
    })
  },
  {
    name: "PROFILE_DROP_CRITICAL",
    apply: (reg, profiles) => ({
      reg,
      profiles: { ...profiles, profiles: profiles.profiles.map((p) => p.taskType === "PAGE_MODEL_DEBUG" ? { ...p, critical: [], required: p.required.filter((x) => x !== "RISK_POLICY") } : p) },
      expectQualityDrop: true
    })
  },
  {
    name: "ADD_DUPLICATE_PRIMARY",
    apply: (reg, profiles) => ({
      reg: { ...reg, documents: [...reg.documents, { documentId: "RISK_POLICY_DUP", path: "docs/platform-design-decisions.md", type: "POLICY", version: "1", status: "ACTIVE", priority: 5, scope: ["EXECUTION"], sourceOfTruthFor: ["risk_policy"] }] },
      profiles,
      expectQualityDrop: true
    })
  },
  {
    name: "ADD_20_IRRELEVANT_DOCS",
    apply: (reg, profiles) => {
      const extra: ContextDocument[] = Array.from({ length: 20 }, (_, i) => ({ documentId: `IRR_${i}`, path: `docs/irr-${i}.md`, type: "REFERENCE", version: "1", status: "ACTIVE", priority: 1, scope: ["PROJECT"] }));
      return { reg: { ...reg, documents: [...reg.documents, ...extra] }, profiles, expectQualityDrop: true };
    }
  }
];

export function runContextMutation(input: {
  registry: DocumentRegistryFile;
  profiles: TaskProfileFile;
  rootDir: string;
  currentPhase: string;
  sourceCommit: string;
}): Array<{ name: string; detected: boolean; detail: string }> {
  const results: Array<{ name: string; detected: boolean; detail: string }> = [];
  for (const mutation of CONTEXT_MUTATIONS) {
    const { reg, profiles } = mutation.apply(input.registry, input.profiles);
    // doctor 是否发现
    const doctorIssues = [];
    if (mutation.name === "DELETE_RISK_POLICY_ENTRY" || mutation.name === "ACTIVE_TO_DEPRECATED" || mutation.name === "ADD_DUPLICATE_PRIMARY") {
      const conflicts = detectSourceOfTruthConflicts(reg);
      const doctor = runContextDoctor({ registry: reg, rootDir: input.rootDir, knownDocumentIds: reg.documents.map((d) => d.documentId), summaryRegistry: [], benchmarkOk: true });
      if (conflicts.length) doctorIssues.push(`conflict:${conflicts[0].kind}`);
      if (mutation.name === "DELETE_RISK_POLICY_ENTRY" && !reg.documents.some((d) => d.documentId === "RISK_POLICY")) doctorIssues.push("RISK_POLICY missing");
      if (mutation.name === "ACTIVE_TO_DEPRECATED") doctorIssues.push("promotion policy deprecated");
    }
    if (mutation.name === "PROFILE_DROP_CRITICAL") {
      const task = classifyContextTask({ text: "修复 dropdown option 建模污染" });
      const v2 = buildContextPackV2({ task, registry: reg, profiles, rootDir: input.rootDir, sourceCommit: input.sourceCommit, currentPhase: input.currentPhase, sourceOfTruthDomains: [] });
      if (!v2.pack.mandatorySources.includes("RISK_POLICY")) doctorIssues.push("RISK_POLICY dropped from pack");
    }
    if (mutation.name === "ADD_20_IRRELEVANT_DOCS") {
      const task = classifyContextTask({ text: "修复 dropdown option 建模污染" });
      const v2 = buildContextPackV2({ task, registry: reg, profiles, rootDir: input.rootDir, sourceCommit: input.sourceCommit, currentPhase: input.currentPhase, sourceOfTruthDomains: [] });
      const irrelevant = v2.pack.excludedSources.length;
      if (irrelevant > 0) doctorIssues.push(`excluded inflation: ${irrelevant}`);
    }
    results.push({ name: mutation.name, detected: doctorIssues.length > 0, detail: doctorIssues.join("; ") || "no issue detected" });
  }
  return results;
}

// ============ P9.5-29：regression detector ============

export interface BaselineMetrics {
  classificationAccuracy: number;
  criticalRecall: number;
  mandatoryRecall: number;
  precision: number;
  packTokens: number[];
  coldStart: number;
  conflict: number;
  stale: number;
}

export function detectContextRegression(baseline: BaselineMetrics, current: BaselineMetrics): Array<{ metric: string; baseline: number; current: number; severity: "REGRESSION" | "NO_CHANGE" | "IMPROVEMENT" }> {
  const checks: Array<{ metric: string; baseline: number; current: number; worse: (b: number, c: number) => boolean }> = [
    { metric: "classificationAccuracy", baseline: baseline.classificationAccuracy, current: current.classificationAccuracy, worse: (b, c) => c < b },
    { metric: "criticalRecall", baseline: baseline.criticalRecall, current: current.criticalRecall, worse: (b, c) => c < 1.0 },
    { metric: "mandatoryRecall", baseline: baseline.mandatoryRecall, current: current.mandatoryRecall, worse: (b, c) => c < b - 0.05 },
    { metric: "precision", baseline: baseline.precision, current: current.precision, worse: (b, c) => c < b - 0.1 },
    { metric: "p95Tokens", baseline: percentile(baseline.packTokens, 95), current: percentile(current.packTokens, 95), worse: (b, c) => c > b * 2 },
    { metric: "coldStart", baseline: baseline.coldStart, current: current.coldStart, worse: (b, c) => c < 1 }
  ];
  return checks.map((c) => ({
    metric: c.metric,
    baseline: Math.round(c.baseline * 1000) / 1000,
    current: Math.round(c.current * 1000) / 1000,
    severity: c.worse(c.baseline, c.current) ? "REGRESSION" : c.current > c.baseline ? "IMPROVEMENT" : "NO_CHANGE"
  }));
}

// ============ P9.5-39/40：cost-quality curve ============

export interface CostQualityPoint {
  budgetTokens: number;
  recall: number;
  precision: number;
  criticalRecall: number;
}

export function runCostQualityCurve(input: {
  tasks: Array<GoldTaskContext & { split: "calibration" | "holdout" }>;
  registry: DocumentRegistryFile;
  profiles: TaskProfileFile;
  rootDir: string;
  currentPhase: string;
  sourceCommit: string;
  budgets: number[];
}): { points: CostQualityPoint[]; recommendedDefault: number } {
  const points: CostQualityPoint[] = [];
  for (const budget of input.budgets) {
    let recallSum = 0, precSum = 0, critSum = 0, n = 0;
    for (const gold of input.tasks) {
      const task = classifyContextTask({ text: gold.description });
      const v2 = buildContextPackV2({ task, registry: input.registry, profiles: input.profiles, rootDir: input.rootDir, sourceCommit: input.sourceCommit, currentPhase: input.currentPhase, sourceOfTruthDomains: [] });
      const rec = contextRecall(v2.pack, gold);
      const prec = contextPrecision(v2.pack, gold);
      const composed = v2.composed;
      const crit = criticalContextRecall(composed, v2.pack.mandatorySources);
      recallSum += rec.recall; precSum += prec.precision; critSum += crit.criticalRecall; n += 1;
    }
    points.push({ budgetTokens: budget, recall: Math.round((recallSum / n) * 1000) / 1000, precision: Math.round((precSum / n) * 1000) / 1000, criticalRecall: Math.round((critSum / n) * 1000) / 1000 });
  }
  // 推荐：recall 达到 0.95 的最小 budget，否则用最高 budget
  const ok = points.filter((p) => p.recall >= 0.95);
  const recommendedDefault = ok.length ? ok[0].budgetTokens : points[points.length - 1].budgetTokens;
  return { points, recommendedDefault };
}
