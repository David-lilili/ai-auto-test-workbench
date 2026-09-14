/**
 * P11.5-2：AI Test Designer LLM Contract（test-designer.v1）。
 *
 * 铁律（P11.5-3）：
 * - LLM 只组合已有事实（obligations / business knowledge / manual rules），不拥有事实权。
 * - 不允许新增业务规则、产品状态、金额限制、权限、Security Flow、页面元素。
 * - 每条 expectedOutcome 必须 grounding 到输入中存在的 knowledgeId / factId。
 * - 不允许输出定位器 / DSL / browser execution 内容。
 *
 * 输出严格 JSON：{ "candidates": [...] }，schema 见 buildTestDesignerPrompt。
 * 每次调用记录 promptVersion / model / tokens / latency / hashes（P11.5-18/19）。
 */

import crypto from "node:crypto";
import type { TestDesignInput, TestCoverageObligation, TestDesignCandidate, ScenarioType } from "./types.js";
import type { ManualRuleRef } from "./obligations.js";

export const TEST_DESIGNER_PROMPT_VERSION = "test-designer.v1";

export const SCENARIO_TYPES: ScenarioType[] = [
  "POSITIVE", "NEGATIVE", "BOUNDARY", "STATE_TRANSITION", "DEPENDENCY", "PERMISSION",
  "SECURITY", "ERROR_HANDLING", "PERSISTENCE", "RECOVERY", "IDEMPOTENCY", "DATA_VARIATION", "UI_BEHAVIOR"
];

export const SEMANTIC_ACTIONS = [
  "SUBMIT_WITHDRAWAL", "SET_FIELD", "SELECT_OPTION", "APPLY_FILTER", "CONFIRM",
  "ENABLE_FEATURE", "DISABLE_FEATURE", "VERIFY_STATE", "CANCEL", "NAVIGATE", "OTHER"
];

export interface TestDesignerContext {
  input: TestDesignInput;
  obligations: TestCoverageObligation[];
  manualRulesApplied: Array<{ rule: ManualRuleRef; reason: string }>;
  knowledgeSnapshot: Array<{ knowledgeId: string; canonicalConcept: string; knowledgeType?: string }>;
  capabilities: string[];
  pageSummary?: string;
  existingCasesSummary?: string;
}

/** P11.5-2：构造 test-designer.v1 prompt（严格 JSON schema）。 */
export function buildTestDesignerPrompt(ctx: TestDesignerContext): { system: string; user: string } {
  const obls = ctx.obligations.map((o) => `- ${o.obligationId} [${o.type}/${o.criticality}${o.isSecurity ? "/SECURITY" : ""}] ${o.subject}${o.condition ? ` (if ${o.condition})` : ""}${o.expected ? ` -> ${o.expected}` : ""}`);
  const manualRules = ctx.manualRulesApplied.map((m) => `${m.rule.ruleId} ${m.rule.name} (${m.reason})`);
  const knowledge = ctx.knowledgeSnapshot.map((k) => `${k.knowledgeId} [${k.knowledgeType ?? "FACT"}] ${k.canonicalConcept}`);
  const system = `你是测试设计助手。给定需求事实（obligations）、测试方法手册（manual rules）、业务知识（knowledge）和能力清单，设计结构化测试场景。

输出必须是合法 JSON，严格符合以下 schema：
{
  "candidates": [
    {
      "title": string,
      "scenarioType": "${SCENARIO_TYPES.join("|")}",
      "coveredObligationIds": [string],
      "semanticActions": [{ "action": "${SEMANTIC_ACTIONS.join("|")}", "target": string }],
      "expectedOutcomes": [{ "statement": string, "grounding": { "kind": "KNOWLEDGE|REQUIREMENT|MANUAL", "knowledgeId"?: string, "factId"?: string, "manualRuleId"?: string } }],
      "knowledgeRefs": [string],
      "manualRuleRefs": [string],
      "assumptions": [string],
      "risk": { "designPriority": "CRITICAL|HIGH|MEDIUM|LOW", "executionRisk": "HIGH|MEDIUM|LOW" },
      "reviewStatus": "AUTO_REVIEWABLE|NEEDS_SECURITY_REVIEW|NEEDS_BUSINESS_REVIEW"
    }
  ]
}

铁律：
1. 你只能组合输入中已有的 obligation / knowledge / manual rule，绝不能发明业务规则、产品状态、金额限制、权限、安全流程或页面元素。
2. 每条 expectedOutcome 的 grounding 必须引用输入中真实存在的 knowledgeId（KNOWLEDGE）或 factId（REQUIREMENT）或 manualRuleId（MANUAL）。
3. coveredObligationIds 只能引用输入中的 obligationId，且每个 candidate 至少覆盖一个 obligation。
4. knowledgeRefs / manualRuleRefs 只能引用输入中真实存在的 id。
5. 覆盖 SECURITY obligation 的候选 reviewStatus 必须是 NEEDS_SECURITY_REVIEW。
6. 禁止出现定位器（xpath/css/selector）、DSL 代码、浏览器执行指令。
7. 不知道的事实写进 assumptions，不要脑补 expected outcome。
8. 只输出 JSON，不要 Markdown。`;

  const lines = [
    `## 需求`,
    `ID: ${ctx.input.requirementId} v${ctx.input.requirementVersion}`,
    ctx.input.requirementSummary,
    ``,
    `## 已批准事实 / Coverage Obligations`,
    obls.join("\n") || "(无)",
    ``,
    `## 选中的 Test Design Manual 规则`,
    manualRules.join("\n") || "(无)",
    ``,
    `## Business Knowledge Snapshot`,
    knowledge.join("\n") || "(无)",
    ``,
    `## 能力`,
    ctx.capabilities.join(", ") || "(无)",
    ``,
    `## Page Summary`,
    ctx.pageSummary ?? "(无)",
    ``,
    `## 既有用例摘要`,
    ctx.existingCasesSummary ?? "(无)",
    ``,
    `## 任务`,
    `基于以上事实设计 5-10 个测试场景候选：多 obligation 合理组合、lifecycle 场景、realistic composition、data variation 想法、manual 驱动的测试技术、清晰的 semantic actions。安全/资金类必须覆盖。`
  ];
  return { system, user: lines.join("\n") };
}

/** 每个候选的校验结果（P11.5-3 gauntlet 的 schema 层）。 */
export interface ParsedCandidate {
  title: string;
  scenarioType: ScenarioType;
  coveredObligationIds: string[];
  semanticActions: Array<{ action: string; target: string }>;
  expectedOutcomes: Array<{ statement: string; grounding: { kind: "KNOWLEDGE" | "REQUIREMENT" | "MANUAL"; knowledgeId?: string; factId?: string; manualRuleId?: string } }>;
  knowledgeRefs: string[];
  manualRuleRefs: string[];
  assumptions: string[];
  risk: { designPriority: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW"; executionRisk: "HIGH" | "MEDIUM" | "LOW" };
  reviewStatus: "AUTO_REVIEWABLE" | "NEEDS_SECURITY_REVIEW" | "NEEDS_BUSINESS_REVIEW";
}

/** P11.5-2/3：LLM 输出严格解析 + schema 校验（id 必须存在于输入上下文）。 */
export function parseTestDesignerCandidates(raw: unknown, ctx: TestDesignerContext): { valid: boolean; errors: string[]; candidates?: ParsedCandidate[] } {
  const errors: string[] = [];
  if (!raw || typeof raw !== "object") return { valid: false, errors: ["输出非对象"] };
  const root = raw as Record<string, unknown>;
  if (!Array.isArray(root.candidates)) return { valid: false, errors: ["candidates 缺失或非数组"] };

  const obligationIds = new Set(ctx.obligations.map((o) => o.obligationId));
  const knowledgeIds = new Set(ctx.knowledgeSnapshot.map((k) => k.knowledgeId));
  const factIds = new Set<string>(ctx.obligations.map((o) => o.source));
  ctx.input.acceptanceCriteria.forEach((a) => factIds.add(a.acId));
  ctx.input.businessRules.forEach((r) => factIds.add(r.ruleId));
  const manualRuleIds = new Set(ctx.manualRulesApplied.map((m) => m.rule.ruleId));
  const priorityRank = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];
  const riskRank = ["HIGH", "MEDIUM", "LOW"];

  const candidates: ParsedCandidate[] = [];
  (root.candidates as unknown[]).forEach((item, i) => {
    if (!item || typeof item !== "object") { errors.push(`candidates[${i}] 非对象`); return; }
    const c = item as Record<string, unknown>;
    const tag = `candidates[${i}]`;
    if (typeof c.title !== "string" || !c.title.trim()) errors.push(`${tag}.title 缺失`);
    if (typeof c.scenarioType !== "string" || !SCENARIO_TYPES.includes(c.scenarioType as ScenarioType)) errors.push(`${tag}.scenarioType 非法: ${String(c.scenarioType)}`);
    if (!Array.isArray(c.coveredObligationIds) || c.coveredObligationIds.length === 0) errors.push(`${tag}.coveredObligationIds 缺失或为空`);
    else for (const id of c.coveredObligationIds as unknown[]) {
      if (typeof id !== "string" || !obligationIds.has(id)) errors.push(`${tag} 引用不存在的 obligation: ${String(id)}`);
    }
    const actions = Array.isArray(c.semanticActions) ? c.semanticActions : [];
    if (actions.length === 0) errors.push(`${tag}.semanticActions 为空`);
    for (const a of actions as Array<Record<string, unknown>>) {
      if (!a || typeof a.action !== "string" || !SEMANTIC_ACTIONS.includes(a.action)) errors.push(`${tag}.semanticActions.action 非法: ${String(a?.action)}`);
      if (typeof a.target !== "string" || !a.target.trim()) errors.push(`${tag}.semanticActions.target 缺失`);
      if (typeof a.action === "string" && /xpath|css|selector|locator|playwright|driver\./i.test(a.action + String(a.target ?? ""))) errors.push(`${tag} 禁止出现定位器/DSL`);
    }
    const outcomes = Array.isArray(c.expectedOutcomes) ? c.expectedOutcomes : [];
    if (outcomes.length === 0) errors.push(`${tag}.expectedOutcomes 为空`);
    for (const e of outcomes as Array<Record<string, unknown>>) {
      if (!e || typeof e.statement !== "string" || !e.statement.trim()) { errors.push(`${tag}.expectedOutcome.statement 缺失`); continue; }
      const g = e.grounding as Record<string, unknown> | undefined;
      if (!g || typeof g !== "object") { errors.push(`${tag} expectedOutcome 缺少 grounding`); continue; }
      if (g.kind === "TESTING_TECHNIQUE") { errors.push(`${tag} expectedOutcome 用 TESTING_TECHNIQUE grounding（对 outcome 非法）`); continue; }
      if (g.kind !== "KNOWLEDGE" && g.kind !== "REQUIREMENT" && g.kind !== "MANUAL") { errors.push(`${tag}.grounding.kind 非法: ${String(g.kind)}`); continue; }
      if (g.kind === "KNOWLEDGE" && (typeof g.knowledgeId !== "string" || !knowledgeIds.has(g.knowledgeId))) errors.push(`${tag} grounding 引用不存在的 knowledgeId: ${String(g.knowledgeId)}`);
      if (g.kind === "REQUIREMENT" && (typeof g.factId !== "string" || !factIds.has(g.factId))) errors.push(`${tag} grounding 引用不存在的 factId: ${String(g.factId)}`);
      if (g.kind === "MANUAL" && (typeof g.manualRuleId !== "string" || !manualRuleIds.has(g.manualRuleId))) errors.push(`${tag} grounding 引用不存在的 manualRuleId: ${String(g.manualRuleId)}`);
    }
    const refs = Array.isArray(c.knowledgeRefs) ? c.knowledgeRefs : [];
    for (const id of refs as unknown[]) { if (typeof id !== "string" || !knowledgeIds.has(id)) errors.push(`${tag} 引用不存在的 knowledge: ${String(id)}`); }
    const mrefs = Array.isArray(c.manualRuleRefs) ? c.manualRuleRefs : [];
    for (const id of mrefs as unknown[]) { if (typeof id !== "string" || !manualRuleIds.has(id)) errors.push(`${tag} 引用不存在的 manualRule: ${String(id)}`); }
    const risk = c.risk as Record<string, unknown> | undefined;
    if (!risk || typeof risk !== "object") errors.push(`${tag}.risk 缺失`);
    else {
      if (!priorityRank.includes(String(risk.designPriority))) errors.push(`${tag}.risk.designPriority 非法: ${String(risk.designPriority)}`);
      if (!riskRank.includes(String(risk.executionRisk))) errors.push(`${tag}.risk.executionRisk 非法: ${String(risk.executionRisk)}`);
    }
    if (!["AUTO_REVIEWABLE", "NEEDS_SECURITY_REVIEW", "NEEDS_BUSINESS_REVIEW"].includes(String(c.reviewStatus))) errors.push(`${tag}.reviewStatus 非法: ${String(c.reviewStatus)}`);

    candidates.push({
      title: String(c.title ?? ""), scenarioType: (c.scenarioType ?? "POSITIVE") as ScenarioType,
      coveredObligationIds: (c.coveredObligationIds as string[]) ?? [],
      semanticActions: (actions as Array<{ action: string; target: string }>),
      expectedOutcomes: (outcomes as ParsedCandidate["expectedOutcomes"]),
      knowledgeRefs: (c.knowledgeRefs as string[]) ?? [],
      manualRuleRefs: (c.manualRuleRefs as string[]) ?? [],
      assumptions: (c.assumptions as string[]) ?? [],
      risk: { designPriority: (risk?.designPriority ?? "MEDIUM") as ParsedCandidate["risk"]["designPriority"], executionRisk: (risk?.executionRisk ?? "MEDIUM") as ParsedCandidate["risk"]["executionRisk"] },
      reviewStatus: (c.reviewStatus ?? "AUTO_REVIEWABLE") as ParsedCandidate["reviewStatus"]
    });
  });

  return { valid: errors.length === 0, errors, candidates: errors.length === 0 ? candidates : undefined };
}

/** P11.5-19：记录一次 actual AI design run（hash 溯源）。 */
export interface TestDesignerRunRecord {
  promptVersion: string;
  contextFingerprint?: string;
  knowledgeFingerprint?: string;
  model: string;
  latencyMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  inputHash: string;
  outputHash: string;
  status: "AI_DESIGNED" | "AI_DESIGNER_UNAVAILABLE";
}

export function recordTestDesignerRun(input: {
  contextFingerprint?: string;
  knowledgeFingerprint?: string;
  model: string;
  latencyMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  inputContent: string;
  outputContent: string;
  status: TestDesignerRunRecord["status"];
}): TestDesignerRunRecord {
  return {
    promptVersion: TEST_DESIGNER_PROMPT_VERSION,
    contextFingerprint: input.contextFingerprint,
    knowledgeFingerprint: input.knowledgeFingerprint,
    model: input.model,
    latencyMs: input.latencyMs,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    inputHash: crypto.createHash("sha256").update(input.inputContent).digest("hex").slice(0, 12),
    outputHash: crypto.createHash("sha256").update(input.outputContent).digest("hex").slice(0, 12),
    status: input.status
  };
}

/** P11.5-13：runtime 模块禁止引用 gold。此处仅声明哨兵，不引入 gold。 */
export const GOLD_ISOLATION_GUARD = "AI_DESIGN_PATH_CANNOT_IMPORT_GOLD";
