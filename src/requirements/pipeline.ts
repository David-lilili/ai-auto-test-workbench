/**
 * P10 分析主流程（deterministic 第一版）：
 *   analyzeRequirement(source) → RequirementModel
 *
 * 由确定性提取器（keyword/pattern）产出 draft，再归一化组装为 RequirementModel。
 * LLM 可作为可选增强（见 llm-contract.ts），但核心提取不依赖 LLM。
 */

import type { RequirementAnalysisDraft, RequirementModel, RequirementSource } from "./types.js";
import {
  buildRequirementModel, createRequirementSource, extractAcceptanceCriteria, extractActors, extractBusinessChanges,
  extractBusinessRules, extractConstraints, extractDependencies, extractPreconditions, extractRisks,
  extractStateTransitions, detectAmbiguities, provenanceFor
} from "./analyzer.js";

export const REQUIREMENT_ANALYZER_PROMPT_VERSION = "requirement-analyzer.v1";

/**
 * P10.8-16：deterministic 分析——从原始需求提取结构化 draft。
 * 所有 origin 为 EXPLICIT_REQUIREMENT 的项都有 source anchor；
 * 无法确定的 → AI_INFERENCE（绝不伪装 EXPLICIT）。
 */
export function analyzeDeterministic(source: RequirementSource): RequirementAnalysisDraft {
  const text = source.rawContent;

  const actors = extractActors(text, source.sourceId).map((a) => ({ name: a.name, sourceAnchor: a.name, confidence: "HIGH" as const, origin: a.origin as RequirementAnalysisDraft["actors"][number]["origin"] }));
  const changes = extractBusinessChanges(text, source.sourceId).map((c) => ({ type: c.type, before: c.before, after: c.after, affectedEntity: c.affectedEntity, sourceAnchor: c.evidence, confidence: c.confidence, origin: c.origin as RequirementAnalysisDraft["changes"][number]["origin"] }));
  const acceptanceCriteria = extractAcceptanceCriteria(text, source.sourceId).map((a) => ({ statement: a.statement, kind: a.kind, sourceAnchor: a.statement, confidence: "HIGH" as const, origin: a.origin as RequirementAnalysisDraft["acceptanceCriteria"][number]["origin"] }));
  const businessRules = extractBusinessRules(text, source.sourceId).map((r) => ({ statement: r.statement, condition: r.condition, effect: r.effect, scope: r.scope, sourceAnchor: r.statement, confidence: "HIGH" as const, origin: r.origin as RequirementAnalysisDraft["businessRules"][number]["origin"] }));
  const preconditions = extractPreconditions(text, source.sourceId).map((p) => ({ statement: p.statement, sourceAnchor: p.statement, source: p.source as "REQUIREMENT_EXPLICIT" }));
  const states = extractStateTransitions(text, source.sourceId).map((s) => ({ entity: s.entity, fromState: s.fromState, toState: s.toState, trigger: s.trigger, explicitness: s.explicitness, sourceAnchor: `${s.fromState}->${s.toState}` }));
  const constraints = extractConstraints(text, source.sourceId).map((c) => ({ field: c.field, operator: c.operator, value: c.value, kind: c.kind, sourceAnchor: c.field, origin: c.origin as RequirementAnalysisDraft["constraints"][number]["origin"] }));
  const dependencies = extractDependencies(text, source.sourceId).map((d) => ({ sourceConcept: d.sourceConcept, relation: d.relation, targetConcept: d.targetConcept, sourceAnchor: `${d.sourceConcept}-${d.targetConcept}` }));
  const risks = extractRisks(text, source.sourceId).map((r) => ({ domain: r.domain, description: r.description, level: r.level, sourceAnchor: r.domain }));
  const ambiguities = detectAmbiguities(text, source.sourceId).map((a) => ({ type: a.type, question: a.question, context: a.context, sourceAnchor: a.question }));

  return {
    summary: text.length > 200 ? text.slice(0, 200) + "…" : text,
    actors,
    changes,
    acceptanceCriteria,
    businessRules,
    preconditions,
    states,
    constraints,
    dependencies,
    risks,
    ambiguities,
    assumptions: [],
    affectedDomains: []
  };
}

/** 便捷：source → analyzeDeterministic → buildRequirementModel。 */
export function analyzeRequirement(input: {
  sourceId: string;
  title: string;
  rawContent: string;
  language?: "zh" | "en" | "mixed";
  requirementId?: string;
  contextReceipt?: RequirementModel["contextReceipt"];
}): RequirementModel {
  const source = createRequirementSource({
    sourceId: input.sourceId,
    sourceType: "PLAIN_TEXT",
    title: input.title,
    rawContent: input.rawContent,
    language: input.language
  });
  const draft = analyzeDeterministic(source);
  return buildRequirementModel({
    requirementId: input.requirementId ?? input.sourceId,
    source,
    draft,
    contextReceipt: input.contextReceipt,
    promptVersion: REQUIREMENT_ANALYZER_PROMPT_VERSION
  });
}

/** P10.32：置信度综合（source explicitness + anchor + conflict + review）。 */
export function computeRequirementConfidence(input: { explicitCount: number; inferredCount: number; conflictCount: number; humanConfirmed: boolean }): "HIGH" | "MEDIUM" | "LOW" {
  if (input.humanConfirmed) return "HIGH";
  if (input.conflictCount > 0) return "LOW";
  if (input.explicitCount >= 3 && input.inferredCount === 0) return "HIGH";
  if (input.explicitCount >= 1) return "MEDIUM";
  return "LOW";
}

