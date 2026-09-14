/**
 * P11.5：Actual AI Test Designer。
 *
 * 流水线：
 *   Preflight（缺 critical context → BLOCK）
 *   → SYSTEMATIC_BASELINE（保底）
 *   → AI_DESIGNER primary（test-designer.v1，真实 LLM）
 *   → 校验 gauntlet（grounding/unsupported/risk/duplicate/coverage）
 *   → merge + dedupe
 *   → 最多 1 次 Targeted Repair（只输入 uncovered obligations）
 *   → execution path awareness（Page Summary）
 *   → telemetry + context receipt 持久化
 *
 * LLM 失败（timeout/502/invalid JSON/schema violation）→ AI_DESIGNER_UNAVAILABLE，
 * systematic baseline 继续，绝不假装 AI 参与（P11.5-16）。
 */

import path from "node:path";
import fs from "fs-extra";
import type { RequirementModel } from "../requirements/types.js";
import { loadKnowledgeStore } from "../requirements/knowledge-store.js";
import { knowledgeVersionFingerprint } from "../requirements/knowledge-context.js";
import { callConfiguredAiJson, type AiChatInput, type AiChatResult } from "../core/ai-provider.js";
import type { TestDesignInput, TestCoverageObligation, TestDesignCandidate } from "./types.js";
import { buildCoverageObligations, selectTestDesignManualRules, systematicDesigner, findKnowledgeForObligation, type ManualRuleRef, type TestDesignManualFile } from "./obligations.js";
import { validateCandidateGrounding, dedupeCandidates, buildCoverageMatrix, obligationCoverage, criticalObligationCoverage, securityObligationCoverage, testDesignQualityGate, systematicDesignForObligations } from "./engine.js";
import { testDesignReadiness } from "./types.js";
import { buildTestDesignerPrompt, parseTestDesignerCandidates, recordTestDesignerRun, TEST_DESIGNER_PROMPT_VERSION, type TestDesignerContext, type ParsedCandidate } from "./llm-contract.js";
import { runTestDesignPreflight, type TestDesignPreflightResult } from "./preflight.js";
import { loadTestDesignManuals, buildTestDesignInputFromStore, type TestDesignRunResult } from "./designer.js";
import { writeSafeJsonFile } from "../core/safe-file-writer.js";

export type LlmCallFn = (input: AiChatInput) => Promise<AiChatResult>;

export interface AiDesignerTelemetry {
  status: "AI_DESIGNED" | "AI_DESIGNER_UNAVAILABLE" | "NOT_INVOKED";
  primaryCalls: number;
  repairCalls: number;
  totalCalls: number;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs?: number;
  failures: number;
  fallbackRate: number;
  rejectedCount: number;
  provider?: string;
  model?: string;
}

export interface TestDesignReceipt {
  requirementId: string;
  generatedAt: string;
  promptVersion: string;
  model: string;
  provider?: string;
  contextFingerprint: string;
  knowledgeFingerprint: string;
  manualVersions: Record<string, string>;
  selectedManualRules: string[];
  telemetry: AiDesignerTelemetry;
  candidateCount: number;
  obligationCount: number;
  readiness: string;
}

export interface ActualDesignResult extends TestDesignRunResult {
  aiStatus: AiDesignerTelemetry["status"];
  telemetry: AiDesignerTelemetry;
  receipt?: TestDesignReceipt;
  blocked?: TestDesignPreflightResult;
}

// ============ P11.5-13：Gold 隔离哨兵 ============

export const AI_DESIGN_PATH_CANNOT_IMPORT_GOLD = "AI_DESIGN_PATH_CANNOT_IMPORT_GOLD";

// ============ P11.5-3：AI 候选校验 gauntlet ============

export interface AiCandidateValidationResult {
  candidates: TestDesignCandidate[];
  rejected: Array<{ index: number; reasons: string[] }>;
}

function toTestDesignCandidate(parsed: ParsedCandidate, ctx: TestDesignerContext, index: number): TestDesignCandidate {
  const securityCovered = parsed.coveredObligationIds.some((id) => ctx.obligations.find((o) => o.obligationId === id)?.isSecurity);
  const now = new Date().toISOString();
  const obligationIds = new Set(parsed.coveredObligationIds);
  return {
    candidateId: `AI-${String(index + 1).padStart(3, "0")}`,
    requirementId: ctx.input.requirementId,
    title: parsed.title,
    objective: parsed.title,
    scenarioType: parsed.scenarioType,
    preconditions: [],
    semanticActions: parsed.semanticActions.map((a) => ({ action: a.action as TestDesignCandidate["semanticActions"][number]["action"], target: a.target, grounding: { kind: "REQUIREMENT" as const, factId: ctx.input.requirementId } })),
    expectedOutcomes: parsed.expectedOutcomes.map((e) => ({ statement: e.statement, grounding: e.grounding as TestDesignCandidate["expectedOutcomes"][number]["grounding"] })),
    testDataRequirements: [],
    coveredObligationIds: parsed.coveredObligationIds,
    coveredBusinessRuleIds: ctx.input.businessRules.filter((r) => obligationIds.has(ctx.obligations.find((o) => o.source === r.ruleId)?.obligationId ?? "")).map((r) => r.ruleId),
    coveredACIds: ctx.input.acceptanceCriteria.filter((a) => obligationIds.has(ctx.obligations.find((o) => o.source === a.acId)?.obligationId ?? "")).map((a) => a.acId),
    coveredCapabilityIds: [],
    risk: parsed.risk,
    knowledgeRefs: parsed.knowledgeRefs,
    manualRuleRefs: parsed.manualRuleRefs,
    manualVersions: {},
    assumptions: parsed.assumptions,
    origin: "AI_GENERATED",
    confidence: "MEDIUM",
    // P11.5-3 risk validator：覆盖 security obligation → 强制安全审查
    reviewStatus: securityCovered ? "NEEDS_SECURITY_REVIEW" : parsed.reviewStatus === "NEEDS_BUSINESS_REVIEW" ? "NEEDS_BUSINESS_REVIEW" : "AUTO_REVIEWABLE",
    testability: "EXECUTION_PATH_UNKNOWN",
    provenance: [{ reason: `ai-designer primary candidate ${index + 1}`, source: ctx.input.requirementId }],
    status: securityCovered ? "NEEDS_REVIEW" : "DRAFT",
    semanticKey: "",
    createdAt: now
  };
}

/** P11.5-3：grounding / unsupported / risk / duplicate / coverage gauntlet。 */
export function validateAiCandidates(parsed: ParsedCandidate[], ctx: TestDesignerContext, existing: TestDesignCandidate[]): AiCandidateValidationResult {
  const valid: TestDesignCandidate[] = [];
  const rejected: Array<{ index: number; reasons: string[] }> = [];
  const obligationIds = new Set(ctx.obligations.map((o) => o.obligationId));
  const knowledgeIds = new Set(ctx.knowledgeSnapshot.map((k) => k.knowledgeId));
  const manualIds = new Set(ctx.manualRulesApplied.map((m) => m.rule.ruleId));
  const seenKeys = new Set(existing.map((c) => c.semanticKey || c.title));

  parsed.forEach((p, i) => {
    const reasons: string[] = [];
    // coverage validator：至少覆盖一个 obligation 且都真实存在
    if (p.coveredObligationIds.length === 0) reasons.push("coveredObligationIds 为空");
    if (!p.coveredObligationIds.every((id) => obligationIds.has(id))) reasons.push("引用不存在的 obligationId");
    // unsupported / grounding validator：expectedOutcome 必须 grounded 到上下文事实
    for (const e of p.expectedOutcomes) {
      if (e.grounding.kind === "KNOWLEDGE" && !knowledgeIds.has(e.grounding.knowledgeId ?? "")) reasons.push("grounding 引用不存在的 knowledgeId");
      if (e.grounding.kind === "MANUAL" && !manualIds.has(e.grounding.manualRuleId ?? "")) reasons.push("grounding 引用不存在的 manualRuleId");
      if (e.grounding.kind === "REQUIREMENT") {
        const factIds = new Set<string>(ctx.obligations.map((o) => o.source));
        ctx.input.acceptanceCriteria.forEach((a) => factIds.add(a.acId));
        ctx.input.businessRules.forEach((r) => factIds.add(r.ruleId));
        if (!factIds.has(e.grounding.factId ?? "")) reasons.push("grounding 引用不存在的 factId");
      }
    }
    // knowledgeRefs / manualRuleRefs 必须真实
    for (const k of p.knowledgeRefs) if (!knowledgeIds.has(k)) reasons.push("knowledgeRefs 引用不存在");
    for (const m of p.manualRuleRefs) if (!manualIds.has(m)) reasons.push("manualRuleRefs 引用不存在");
    // duplicate validator：与 baseline 重复的 AI 候选丢弃
    if (seenKeys.has(p.title)) reasons.push("与已有候选重复");
    seenKeys.add(p.title);

    if (reasons.length === 0) {
      const c = toTestDesignCandidate(p, ctx, valid.length);
      c.semanticKey = `${c.origin}|${c.title}|${c.coveredObligationIds.sort().join("+")}`;
      valid.push(c);
    } else {
      rejected.push({ index: i, reasons });
    }
  });
  return { candidates: valid, rejected };
}

// ============ P11.5-2/16：真实 LLM 调用（primary / repair 共用） ============

export interface AiDesignCallOptions {
  rootDir: string;
  ctx: TestDesignerContext;
  callLlm?: LlmCallFn;
  timeoutMs?: number;
}

export async function callAiDesigner(options: AiDesignCallOptions & { existing?: TestDesignCandidate[] }): Promise<{ status: "AI_DESIGNED" | "AI_DESIGNER_UNAVAILABLE"; candidates: TestDesignCandidate[]; rejected: Array<{ index: number; reasons: string[] }>; telemetry: AiChatResult["telemetry"] }> {
  const { system, user } = buildTestDesignerPrompt(options.ctx);
  const result = await (options.callLlm ?? callConfiguredAiJson)({
    rootDir: options.rootDir,
    system,
    prompt: user,
    timeoutMs: options.timeoutMs ?? 60000,
    promptVersion: TEST_DESIGNER_PROMPT_VERSION,
    temperature: 0.1,
    maxTokens: 4096
  });
  if (result.status !== "completed") {
    return { status: "AI_DESIGNER_UNAVAILABLE", candidates: [], rejected: [], telemetry: result.telemetry };
  }
  const parsed = parseTestDesignerCandidates(result.parsedOutput, options.ctx);
  if (!parsed.valid || !parsed.candidates) {
    return { status: "AI_DESIGNER_UNAVAILABLE", candidates: [], rejected: [], telemetry: { ...result.telemetry, error: `schema violation: ${parsed.errors.slice(0, 3).join("; ")}` } };
  }
  const validated = validateAiCandidates(parsed.candidates, options.ctx, options.existing ?? []);
  return { status: "AI_DESIGNED", candidates: validated.candidates, rejected: validated.rejected, telemetry: result.telemetry };
}

// ============ P11.5-11：Page Summary → Execution Path Awareness ============

export interface PageSummaryInput {
  actions: string[];
}

/** Page Summary 只影响执行路径感知（testability），不影响"测什么"（recall）。 */
export function applyExecutionPathAwareness(candidates: TestDesignCandidate[], pageSummary?: PageSummaryInput): TestDesignCandidate[] {
  if (!pageSummary || pageSummary.actions.length === 0) return candidates;
  return candidates.map((c) => {
    const actions = c.semanticActions.map((a) => a.action);
    const matched = actions.filter((a) => pageSummary.actions.includes(a));
    if (matched.length === 0) return c;
    const awareness: TestDesignCandidate["testability"] = matched.length >= actions.length ? "EXECUTION_PATH_KNOWN" : "EXECUTION_PATH_PARTIAL";
    return { ...c, testability: awareness };
  });
}

/** 从 storage/page-models/*.json 汇总 interaction 动作（真实 page summary）。 */
export async function loadPageSummary(rootDir: string): Promise<PageSummaryInput | undefined> {
  const dir = path.join(rootDir, "storage", "page-models");
  if (!fs.pathExistsSync(dir)) return undefined;
  const actions = new Set<string>();
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    try {
      const store = fs.readJsonSync(path.join(dir, file)) as Record<string, unknown>;
      const pages = store.pages as Array<Record<string, unknown>> | undefined;
      for (const p of pages ?? []) {
        for (const i of (p.interactions as Array<Record<string, unknown>>) ?? []) {
          const kind = String(i.kind ?? i.action ?? "").toUpperCase();
          if (kind) actions.add(kind);
          const action = String(i.action ?? "").toUpperCase();
          if (action) actions.add(action);
        }
      }
    } catch { /* skip unreadable */ }
  }
  return actions.size ? { actions: [...actions] } : undefined;
}

// ============ P11.5：完整 Actual Design 流水线 ============

export interface RunActualDesignOptions {
  maxCandidates?: number;
  callLlm?: LlmCallFn;
  pageSummary?: PageSummaryInput;
  preflight?: boolean;
  persistReceipt?: boolean;
  timeoutMs?: number;
  repairEnabled?: boolean;
  /** 跳过 store 构建，直接用给定 input（内部/盲测路径）。 */
  inputOverride?: TestDesignInput;
  /** 注入 preflight 结果（测试 BLOCK 路径用）。 */
  preflightResult?: TestDesignPreflightResult;
  /** 覆盖 baseline（测试 repair 路径用）。 */
  baselineOverride?: TestDesignCandidate[];
}

const RECEIPT_PATH = "storage/test-design-candidates/receipts.json";

async function loadReceipts(rootDir: string): Promise<Record<string, TestDesignReceipt>> {
  const p = path.join(rootDir, RECEIPT_PATH);
  if (!fs.pathExistsSync(p)) return {};
  try { return (await fs.readJson(p)) as Record<string, TestDesignReceipt>; } catch { return {}; }
}

export async function runActualTestDesign(rootDir: string, model: RequirementModel, options: RunActualDesignOptions = {}): Promise<ActualDesignResult> {
  const maxCandidates = options.maxCandidates ?? 24;
  const input = options.inputOverride ?? await buildTestDesignInputFromStore(rootDir, model);
  const obligations = buildCoverageObligations(input);
  const manuals = await loadTestDesignManuals(rootDir);
  const manualRulesApplied = selectTestDesignManualRules(input, manuals);
  const kb = await loadKnowledgeStore(rootDir);
  const knowledgeSnapshot = kb.knowledge.filter((k) => k.status === "ACTIVE").map((k) => ({ knowledgeId: k.knowledgeId, canonicalConcept: k.canonicalConcept, knowledgeType: k.knowledgeType }));
  const manualVersions = Object.fromEntries(manuals.map((m) => [m.manualId, m.version]));

  // P11.5-5：preflight BLOCK（inputOverride 为内部路径，跳过 store 相关 preflight）
  const preflight = options.preflightResult ?? (options.preflight !== false && !options.inputOverride ? await runTestDesignPreflight(rootDir, model) : undefined);
  if (preflight && !preflight.pass) {
    const blocked: ActualDesignResult = {
      input, obligations, manualRulesApplied, candidates: [], duplicateRemoved: [], coverageMatrix: [],
      coverage: { total: obligations.length, covered: 0, uncoveredIds: obligations.map((o) => o.obligationId), ratio: 0 },
      criticalCoverage: { covered: false, uncoveredIds: obligations.filter((o) => o.criticality === "CRITICAL").map((o) => o.obligationId) },
      securityCoverage: { covered: false, uncoveredIds: obligations.filter((o) => o.isSecurity).map((o) => o.obligationId) },
      groundIssues: [], knowledgeGaps: [], readiness: { status: "BLOCKED", blockingIssues: preflight.missing.map((m) => `missing critical context: ${m}`), warningIssues: [] },
      qualityGate: { status: "BLOCKED", blocking: preflight.missing.map((m) => `missing critical context: ${m}`), warnings: [] },
      fingerprints: { context: input.contextFingerprint, knowledge: knowledgeVersionFingerprint(kb), manual: "n/a", prompt: TEST_DESIGNER_PROMPT_VERSION },
      aiStatus: "NOT_INVOKED",
      telemetry: { status: "NOT_INVOKED", primaryCalls: 0, repairCalls: 0, totalCalls: 0, failures: 0, fallbackRate: 0, rejectedCount: 0 },
      blocked: preflight
    };
    return blocked;
  }

  // 1) SYSTEMATIC_BASELINE（保底 + critical/security 覆盖；可被测试覆盖）
  const baselineDesigned = options.baselineOverride === undefined
    ? systematicDesigner(input, obligations, manualRulesApplied, { maxCandidates, knowledge: knowledgeSnapshot })
    : undefined;
  const baselineCandidates = baselineDesigned?.candidates ?? options.baselineOverride ?? [];
  const knowledgeGaps = baselineDesigned?.knowledgeGaps ?? [];
  const baseUnique = dedupeCandidates(baselineCandidates).unique;

  // 2) AI_DESIGNER primary
  const primaryCtx: TestDesignerContext = {
    input, obligations, manualRulesApplied,
    knowledgeSnapshot,
    capabilities: input.affectedCapabilities.map((c) => c.capabilityId),
    pageSummary: options.pageSummary ? `pages/interactions: ${options.pageSummary.actions.join(", ")}` : undefined
  };
  const primary = await callAiDesigner({ rootDir, ctx: primaryCtx, callLlm: options.callLlm, timeoutMs: options.timeoutMs, existing: baseUnique });

  let merged = dedupeCandidates([...baseUnique, ...primary.candidates]).unique;
  let coverage = obligationCoverage(obligations, merged);
  let repairCalls = 0;
  let primaryFailures = primary.status === "AI_DESIGNER_UNAVAILABLE" ? 1 : 0;
  let rejectedCount = primary.rejected.length;

  // 3) Targeted Repair（最多 1 次；只输入 uncovered obligations + 必要 context）
  if (options.repairEnabled !== false && primary.status === "AI_DESIGNED" && coverage.uncoveredIds.length > 0) {
    const uncovered = obligations.filter((o) => coverage.uncoveredIds.includes(o.obligationId));
    const repairCtx: TestDesignerContext = {
      input: { ...input, requirementSummary: `${input.requirementSummary}\n(repair pass: 仅补覆盖缺口)` },
      obligations: uncovered,
      manualRulesApplied,
      knowledgeSnapshot,
      capabilities: [],
      pageSummary: undefined
    };
    const repair = await callAiDesigner({ rootDir, ctx: repairCtx, callLlm: options.callLlm, timeoutMs: options.timeoutMs, existing: [...merged, ...primary.candidates] });
    repairCalls = 1;
    rejectedCount += repair.rejected.length;
    if (repair.status === "AI_DESIGNED") {
      merged = dedupeCandidates([...merged, ...repair.candidates]).unique;
      coverage = obligationCoverage(obligations, merged);
    } else {
      primaryFailures += 1;
    }
  }

  // 4) Execution path awareness（Page Summary 不改 recall）
  const finalCandidates = applyExecutionPathAwareness(merged, options.pageSummary);

  const { unique: deduped, removed } = dedupeCandidates(finalCandidates);
  const groundIssues = deduped.flatMap((c) => validateCandidateGrounding(c));
  const coverageMatrix = buildCoverageMatrix(obligations, deduped);
  const criticalCoverage = criticalObligationCoverage(obligations, deduped);
  const securityCoverage = securityObligationCoverage(obligations, deduped);
  const unsupportedCritical = deduped.filter((c) => c.expectedOutcomes.some((e) => e.grounding.kind === "TESTING_TECHNIQUE") && c.coveredObligationIds.some((id) => obligations.find((o) => o.obligationId === id)?.criticality === "CRITICAL")).length;
  const readiness = testDesignReadiness({ obligations, coveredObligationIds: coverageMatrix.filter((r) => r.coveredByCandidateIds.length).map((r) => r.factId), unsupportedCritical, knowledgeGaps: knowledgeGaps });
  const qualityGate = testDesignQualityGate({ readiness, unsupportedCritical, invalidProvenance: groundIssues.length, preflightFail: false });

  const totalCalls = 1 + repairCalls;
  const telemetry: AiDesignerTelemetry = {
    status: primary.status === "AI_DESIGNED" ? "AI_DESIGNED" : "AI_DESIGNER_UNAVAILABLE",
    primaryCalls: 1,
    repairCalls,
    totalCalls,
    inputTokens: primary.telemetry.promptTokens,
    outputTokens: primary.telemetry.completionTokens,
    latencyMs: primary.telemetry.elapsedMs,
    failures: primaryFailures,
    fallbackRate: totalCalls ? primaryFailures / totalCalls : 1,
    rejectedCount,
    provider: primary.telemetry.provider,
    model: primary.telemetry.model
  };

  const result: ActualDesignResult = {
    input, obligations, manualRulesApplied, candidates: deduped, duplicateRemoved: removed,
    coverageMatrix, coverage, criticalCoverage, securityCoverage, groundIssues,
    knowledgeGaps: knowledgeGaps, readiness, qualityGate,
    fingerprints: { context: input.contextFingerprint, knowledge: knowledgeVersionFingerprint(kb), manual: "test-design-manual.v1", prompt: TEST_DESIGNER_PROMPT_VERSION },
    aiStatus: telemetry.status,
    telemetry
  };

  // P11.5-19：context receipt 持久化
  if (options.persistReceipt !== false) {
    const receipt: TestDesignReceipt = {
      requirementId: model.requirementId,
      generatedAt: new Date().toISOString(),
      promptVersion: TEST_DESIGNER_PROMPT_VERSION,
      model: telemetry.model ?? "unknown",
      provider: telemetry.provider,
      contextFingerprint: input.contextFingerprint,
      knowledgeFingerprint: knowledgeVersionFingerprint(kb),
      manualVersions,
      selectedManualRules: manualRulesApplied.map((m) => m.rule.ruleId),
      telemetry,
      candidateCount: deduped.length,
      obligationCount: obligations.length,
      readiness: readiness.status
    };
    result.receipt = receipt;
    const receipts = await loadReceipts(rootDir);
    receipts[model.requirementId] = receipt;
    await writeSafeJsonFile(path.join(rootDir, RECEIPT_PATH), receipts);
  }

  return result;
}
