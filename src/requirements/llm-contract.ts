/**
 * P10.9：Requirement Analyzer LLM Contract。
 *
 * LLM 输出必须符合 RequirementAnalysisDraft schema（不允许自由 Markdown 当系统事实）。
 * 每次调用记录 promptVersion / contextFingerprint / model / latency / tokens / inputHash / outputHash。
 * LLM 是可选增强——核心提取 deterministic（analyzer.ts），LLM draft 也会经 deterministic 归一。
 */

import crypto from "node:crypto";
import type { RequirementAnalysisDraft, RequirementSource } from "./types.js";
import { normalizeConcept, type DomainVocabulary } from "./analyzer.js";

export const REQUIREMENT_ANALYZER_PROMPT_VERSION = "requirement-analyzer.v1";

export interface RequirementPromptRun {
  promptVersion: string;
  contextFingerprint?: string;
  model: string;
  latencyMs?: number;
  tokens?: number;
  inputHash: string;
  outputHash: string;
}

export interface RequirementAnalyzerInput {
  source: RequirementSource;
  contextFingerprint?: string;
  businessContext?: { operationManualSnippets: string[]; capabilities: string[]; domainVocabulary?: DomainVocabulary };
}

/** P10.9：构造 analyzer system prompt（要求严格 JSON，origin 必须显式）。 */
export function buildRequirementAnalyzerPrompt(input: RequirementAnalyzerInput): { system: string; user: string } {
  const system = `你是需求分析助手。把产品需求转换为结构化 JSON。
输出必须是合法 JSON，符合以下 schema：
{
  "summary": string,
  "actors": [{ "name": string, "sourceAnchor": string, "confidence": "HIGH|MEDIUM|LOW", "origin": "EXPLICIT_REQUIREMENT|AI_INFERENCE" }],
  "changes": [{ "type": "ADD|MODIFY|REMOVE|RESTRICT|RELAX|SECURITY_CHANGE|VALIDATION_CHANGE|STATE_CHANGE|DEPENDENCY_CHANGE|UI_CHANGE|BACKEND_BEHAVIOR_CHANGE", "before"?: string, "after"?: string, "affectedEntity": string, "sourceAnchor": string, "confidence": string, "origin": string }],
  "acceptanceCriteria": [{ "statement": string, "kind": "EXPLICIT_AC|DERIVED_AC", "sourceAnchor": string, "confidence": string, "origin": string }],
  "businessRules": [{ "statement": string, "condition"?: string, "effect"?: string, "scope"?: string, "sourceAnchor": string, "confidence": string, "origin": string }],
  "preconditions": [{ "statement": string, "sourceAnchor": string, "source": "REQUIREMENT_EXPLICIT|BUSINESS_KNOWLEDGE_EXISTING|AI_ASSUMPTION" }],
  "states": [{ "entity": string, "fromState": string, "toState": string, "trigger": string, "explicitness": "EXPLICIT|INFERRED", "sourceAnchor": string }],
  "constraints": [{ "field": string, "operator"?: string, "value"?: string, "kind": "amount|time|role|country|network|currency|account_state|kyc|security|other", "sourceAnchor": string, "origin": string }],
  "dependencies": [{ "sourceConcept": string, "relation": "INVALIDATES|ENABLES|REQUIRES|AFFECTS", "targetConcept": string, "sourceAnchor": string }],
  "risks": [{ "domain": string, "description": string, "level": "LOW|MEDIUM|HIGH", "sourceAnchor": string }],
  "ambiguities": [{ "type": "SCOPE_AMBIGUITY|VALUE_AMBIGUITY|STATE_AMBIGUITY|ACTOR_AMBIGUITY|ERROR_BEHAVIOR_AMBIGUITY|SECURITY_AMBIGUITY|DEPENDENCY_AMBIGUITY|LIFECYCLE_AMBIGUITY", "question": string, "context": string, "sourceAnchor": string }],
  "assumptions": [{ "statement": string, "sourceAnchor": string }],
  "affectedDomains": [string]
}
铁律：
1. origin 只能是 EXPLICIT_REQUIREMENT（需求原文明确）或 AI_INFERENCE（推断）。
2. 需求没写的 → origin="AI_INFERENCE"，绝不能伪装 EXPLICIT_REQUIREMENT。
3. 需求模糊 → 放进 ambiguities，不要自己脑补。
4. 只输出 JSON，不要 Markdown。`;
  const ctx = input.businessContext
    ? `\n\n参考业务上下文（Operation Manual / Capabilities）：\n${input.businessContext.operationManualSnippets.join("\n")}\n能力: ${input.businessContext.capabilities.join(", ")}`
    : "";
  const user = `需求标题: ${input.source.title}\n需求原文:\n${input.source.rawContent}${ctx}`;
  return { system, user };
}

/** P10.9：记录 run。 */
export function recordRequirementRun(input: { contextFingerprint?: string; model: string; latencyMs?: number; tokens?: number; inputContent: string; outputContent: string }): RequirementPromptRun {
  return {
    promptVersion: REQUIREMENT_ANALYZER_PROMPT_VERSION,
    contextFingerprint: input.contextFingerprint,
    model: input.model,
    latencyMs: input.latencyMs,
    tokens: input.tokens,
    inputHash: crypto.createHash("sha256").update(input.inputContent).digest("hex").slice(0, 12),
    outputHash: crypto.createHash("sha256").update(input.outputContent).digest("hex").slice(0, 12)
  };
}

/** P10.10：draft 归一化（concept 归一化，POST-LLM deterministic 校验）。 */
export function normalizeDraft(draft: RequirementAnalysisDraft, vocabulary?: DomainVocabulary): RequirementAnalysisDraft {
  const norm = (s: string) => normalizeConcept(s, vocabulary).canonical;
  return {
    ...draft,
    actors: draft.actors.map((a) => ({ ...a, name: norm(a.name) })),
    affectedDomains: draft.affectedDomains.map((d) => norm(d)),
    businessRules: draft.businessRules.map((r) => ({ ...r, condition: r.condition ? norm(r.condition) : undefined, effect: r.effect ? norm(r.effect) : undefined, scope: r.scope ? norm(r.scope) : undefined })),
    constraints: draft.constraints.map((c) => ({ ...c, field: norm(c.field) }))
  };
}

/** P10.8：LLM 输出合法性校验（必须符合 draft schema）。 */
export function validateLlmDraft(raw: unknown): { valid: boolean; errors: string[]; draft?: RequirementAnalysisDraft } {
  const errors: string[] = [];
  if (!raw || typeof raw !== "object") return { valid: false, errors: ["非对象"] };
  const d = raw as Record<string, unknown>;
  if (typeof d.summary !== "string") errors.push("summary 缺失");
  if (!Array.isArray(d.actors)) errors.push("actors 缺失");
  if (!Array.isArray(d.businessRules)) errors.push("businessRules 缺失");
  if (!Array.isArray(d.ambiguities)) errors.push("ambiguities 缺失");
  if (Array.isArray(d.businessRules)) {
    for (const r of d.businessRules as Array<Record<string, unknown>>) {
      if (r.origin !== "EXPLICIT_REQUIREMENT" && r.origin !== "AI_INFERENCE" && r.origin !== "HUMAN_CONFIRMED" && r.origin !== "EXISTING_KNOWLEDGE") {
        errors.push(`businessRule origin 非法: ${String(r.origin)}`);
      }
    }
  }
  return { valid: errors.length === 0, errors, draft: errors.length === 0 ? (raw as RequirementAnalysisDraft) : undefined };
}
