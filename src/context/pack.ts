import fs from "fs-extra";
import path from "node:path";
import crypto from "node:crypto";
import type { ContextDocument, ContextPack, ContextRequirement, ContextTaskType, CurrentProjectState, DocumentRegistryFile, MandatorySeverity, TaskProfileFile } from "./types.js";
import { resolveContextRequirements } from "./task-context.js";
import type { ClassifiedTask } from "./types.js";
import { composeTaskProfiles, decisionCoverage, severityFor, type ComposedProfile } from "./composition.js";
import { DEFAULT_CONFLICT_PRECEDENCE } from "./registry.js";

/**
 * P9.12-15 / P9.18-19：Context Pack Builder + Budget + Fingerprint + Provenance + Progressive Loading。
 *
 * 不把文件全文拼进去——pack 以 index / summary / paths 为主，
 * AI 根据 pack 再打开具体文档（L0 → L1 → L2 渐进加载）。
 */

export const MAX_BOOTSTRAP_BYTES = 12_000;
export const MAX_REQUIRED_BYTES = 60_000;
export const MAX_RECOMMENDED_BYTES = 40_000;

export interface PackBuildInput {
  task: ClassifiedTask;
  registry: DocumentRegistryFile;
  profiles: TaskProfileFile;
  currentState?: CurrentProjectState;
  sourceOfTruthDomains: string[];
  includeOptional?: boolean;
  rootDir: string;
  sourceCommit: string;
  currentPhase?: string;
  changedFiles?: string[];
}

function fileSize(rootDir: string, p: string): number {
  const full = path.join(rootDir, p);
  if (!fs.pathExistsSync(full)) return 0;
  return fs.statSync(full).size;
}

/** P9.5-23：大文档用 summary 估算（避免 mandatory 大文档撑爆 budget；summary 需 FRESH）。 */
export function effectiveDocBytes(rootDir: string, d: ContextDocument): number {
  const bytes = fileSize(rootDir, d.path);
  if (bytes <= 12_000) return bytes;
  // >12KB：按 summary 策略计 15%（大文档全文不默认加载，读 summary + source path）
  return Math.round(bytes * 0.15);
}

function estimateTokens(bytes: number): number {
  return Math.round(bytes / 3.5);
}

function packFingerprint(input: {
  taskType: string;
  sourceCommit: string;
  mandatory: string[];
  currentStateVersion?: string;
  profileVersion: string;
}): string {
  const payload = JSON.stringify([input.taskType, input.sourceCommit, input.mandatory, input.currentStateVersion, input.profileVersion]);
  return crypto.createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

export function buildContextPack(input: PackBuildInput): ContextPack {
  const byId = new Map(input.registry.documents.map((d) => [d.documentId, d]));
  const requirements = resolveContextRequirements({
    taskType: input.task.primaryTask,
    profiles: input.profiles,
    registry: input.registry,
    sourceOfTruthDomains: input.sourceOfTruthDomains,
    includeOptional: input.includeOptional,
    currentPhase: input.currentPhase
  });

  const mandatory = requirements.filter((r) => r.level === "MANDATORY");
  const recommended = requirements.filter((r) => r.level === "RECOMMENDED");
  const optional = requirements.filter((r) => r.level === "OPTIONAL");

  const mandatoryDocs = mandatory.map((r) => byId.get(r.documentId)).filter(Boolean) as ContextDocument[];
  const recommendedDocs = recommended.map((r) => byId.get(r.documentId)).filter(Boolean) as ContextDocument[];

  // P9.33：历史报告默认不加载（PHASE_REPORT / HISTORICAL 只进 excluded）
  const excludedSources = input.registry.documents
    .filter((d) => d.status === "HISTORICAL" || d.status === "DEPRECATED" || d.status === "SUPERSEDED" || d.type === "PHASE_REPORT")
    .map((d) => d.documentId)
    .filter((id) => !mandatory.some((r) => r.documentId === id) && !recommended.some((r) => r.documentId === id));

  // P9.35：mandatory missing → warning（不允许 silent fallback）
  const warnings: string[] = [];
  const mandatoryMisses = mandatory
    .filter((r) => !byId.has(r.documentId))
    .map((r) => r.documentId);
  if (mandatoryMisses.length) {
    warnings.push(`MISSING_CRITICAL_CONTEXT: ${mandatoryMisses.join(", ")}`);
  }

  // P9.17：stale mandatory → warning
  const staleSources = mandatoryDocs
    .filter((d) => d.status === "DEPRECATED" || d.status === "SUPERSEDED")
    .map((d) => d.documentId);
  if (staleSources.length) warnings.push(`STALE_MANDATORY: ${staleSources.join(", ")}`);

  // P9.15：budget
  const bootstrapBytes = [input.currentState ? fileSize(input.rootDir, "configs/ai-context/current-state.json") : 0].reduce((a, b) => a + b, 0);
  const requiredBytes = mandatoryDocs.reduce((s, d) => s + effectiveDocBytes(input.rootDir, d), 0);
  const recommendedBytes = recommendedDocs.reduce((s, d) => s + effectiveDocBytes(input.rootDir, d), 0);
  const trimmedSources: string[] = [];
  let budgetExceeded = false;
  // 优先级：Mandatory 保留 → summary → Recommended 降级 → Optional 不加载
  let reqTrimmed = requiredBytes;
  if (reqTrimmed > MAX_REQUIRED_BYTES) {
    // 不截断 Mandatory：记录 budgetExceeded（由外层用 summary）
    budgetExceeded = true;
  }
  if (recommendedBytes > MAX_RECOMMENDED_BYTES) {
    trimmedSources.push(...recommendedDocs.slice(0, 3).map((d) => d.documentId));
    budgetExceeded = true;
  }

  // P9.20：coverage（gold 由 benchmark 提供；此处仅记录结构）
  const irrelevantSources = requirements.filter((r) => r.level === "OPTIONAL" && !input.includeOptional).map((r) => r.documentId);

  const estimatedTokens = estimateTokens(bootstrapBytes + requiredBytes + Math.min(recommendedBytes, MAX_RECOMMENDED_BYTES));

  return {
    packId: `pack_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    taskId: `${input.task.primaryTask}_${input.changedFiles?.length ? "changed" : "text"}`,
    taskType: input.task.primaryTask,
    createdAt: new Date().toISOString(),
    sourceCommit: input.sourceCommit,
    currentPhase: input.currentPhase ?? input.currentState?.currentPhase ?? "unknown",
    mandatorySources: mandatoryDocs.map((d) => d.documentId),
    recommendedSources: recommendedDocs.map((d) => d.documentId),
    optionalSources: optional.map((r) => r.documentId),
    sourceOfTruth: input.sourceOfTruthDomains,
    decisions: [],
    currentState: input.currentState,
    relevantReports: [],
    excludedSources,
    warnings,
    budget: { bootstrapBytes, requiredBytes, recommendedBytes, estimatedTokens, budgetExceeded, trimmedSources },
    coverage: {
      contextRecall: 0,
      contextPrecision: 0,
      mandatoryMisses,
      irrelevantSources,
      staleSources,
      conflictSources: []
    },
    fingerprint: packFingerprint({
      taskType: input.task.primaryTask,
      sourceCommit: input.sourceCommit,
      mandatory: mandatoryDocs.map((d) => d.documentId),
      currentStateVersion: input.currentState?.updatedAt,
      profileVersion: input.profiles.version
    })
  };
}

/** P9.19：provenance 渲染（为什么每个文档进 pack）。 */
export function provenanceLine(requirement: ContextRequirement): string {
  return `${requirement.documentId} :: ${requirement.level} :: ${requirement.provenance.reason} :: authority=${requirement.provenance.authority}`;
}

/** P9.34：conflict precedence（声明，不靠 Agent 猜）。 */
export function precedenceRank(layer: string): number {
  const idx = DEFAULT_CONFLICT_PRECEDENCE.indexOf(layer);
  return idx >= 0 ? idx : 99;
}

/**
 * P9.5-5/6/24：multi-task Context Pack v2（组合 + 两段式）。
 * 保留 v1 buildContextPack 供旧测试/调用使用；新流程用 buildContextPackV2。
 */
export interface PackV2Input extends PackBuildInput {
  secondaryTasks?: ContextTaskType[];
}

export interface ContextPackV2 {
  pack: ContextPack;
  index: { task: string; state: string; invariants: string[]; mustRead: string[]; warnings: string[]; decisions: string[]; sourceCommit: string; fingerprint: string };
  composed: ComposedProfile;
  severity: Record<string, MandatorySeverity>;
  decisionCoverage: { coverage: number; missing: string[] };
  minimality: { score: number; requiredUsefulTokens: number; totalPackTokens: number };
  authority: Record<string, string>;
}

export function buildContextPackV2(input: PackV2Input): ContextPackV2 {
  const composed = composeTaskProfiles(input.profiles, input.task.primaryTask, input.secondaryTasks ?? []);
  // 用组合 profile 构造一个等效 TaskProfileFile 交给 v1 构建（required 合并）
  const mergedProfileFile: TaskProfileFile = {
    version: input.profiles.version,
    profiles: [{
      taskType: input.task.primaryTask,
      required: composed.required,
      optional: composed.optional,
      excludeByDefault: composed.excluded,
      critical: composed.critical,
      requiredDecisions: composed.requiredDecisions,
      requiredSafetyPolicies: composed.requiredSafetyPolicies
    }]
  };
  const pack = buildContextPack({ ...input, profiles: mergedProfileFile });
  pack.excludedSources = composed.excluded.filter((id) => !pack.mandatorySources.includes(id));

  // 决策 coverage（从 decisions.json 加载 documentId 列表近似：pack.decisions 由调用方填充）
  const dc = decisionCoverage(composed, pack.decisions);

  const severity: Record<string, MandatorySeverity> = {};
  for (const id of pack.mandatorySources) severity[id] = severityFor(composed, id);

  const authority: Record<string, string> = {};
  for (const d of input.registry.documents) {
    if (d.authority) authority[d.documentId] = d.authority;
  }

  const requiredUsefulTokens = pack.budget.requiredBytes / 3.5;
  const minimalityScore = pack.budget.estimatedTokens > 0 ? Math.round((requiredUsefulTokens / pack.budget.estimatedTokens) * 1000) / 1000 : 0;

  return {
    pack,
    index: {
      task: `${input.task.primaryTask}${input.secondaryTasks?.length ? ` + ${input.secondaryTasks.join(",")}` : ""}`,
      state: pack.currentPhase,
      invariants: input.currentState?.architectureInvariants ?? [],
      mustRead: pack.mandatorySources,
      warnings: pack.warnings,
      decisions: composed.requiredDecisions,
      sourceCommit: input.sourceCommit,
      fingerprint: pack.fingerprint
    },
    composed,
    severity,
    decisionCoverage: dc,
    minimality: { score: minimalityScore, requiredUsefulTokens: Math.round(requiredUsefulTokens), totalPackTokens: pack.budget.estimatedTokens },
    authority
  };
}
