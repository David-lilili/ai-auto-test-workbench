import type { PageModelExecutionPlan } from "./page-model-execution-planner.js";

export interface CompressedPageModelDslAdvisoryContextInput {
  project: string;
  env: string;
  request: string;
  initialUnderstanding?: unknown;
  plan: PageModelExecutionPlan;
  planSummary: Record<string, unknown>;
  originalPromptChars?: number;
}

export interface CompressedPageModelDslAdvisoryContext {
  mode: "compressed";
  prompt: string;
  promptChars: number;
  originalPromptChars?: number;
  promptCharReductionPercent?: number;
  selectedKnowledge: Record<string, unknown>;
}

export function buildCompressedPageModelDslAdvisoryContext(input: CompressedPageModelDslAdvisoryContextInput): CompressedPageModelDslAdvisoryContext {
  const selectedKnowledge = compactSelectedKnowledge(input.plan);
  const prompt = JSON.stringify({
    task: "Review whether the local materialized DSL is semantically aligned with the user request. Return shouldWriteDsl=false when it should be blocked; do not invent executable knowledge.",
    reviewRules: [
      "Runtime login/auth is represented by localPlan.intent.loginRequired and account preparation; do not require a visible login DSL step when the plan is otherwise executable.",
      "A user request may describe a business failure semantically while the DSL asserts the exact execution-observed page text from selectedKnowledge assertions or operationManual policies; treat that as aligned.",
      "For message assertions, exact Page Model textCandidates are authoritative refinements of generic user wording when the assertionId is selected and valid.",
      "Empty operationManual capability context is a gap only when no Page Model assertion/element evidence covers the requested behavior; do not block solely for missing manual context if the DSL is grounded by selected Page Model evidence.",
      "User-defined assertions (e.g. table_column_*/element_disabled/message_visible_exact with explicit expected values) are by design NOT predefined in the knowledge base; when dslValidationPassed=true and referenced element/page IDs are valid, treat them as aligned. Never set shouldWriteDsl=false solely because a user assertion is not predefined.",
      "Concrete test data values (amounts, asset codes, dates) in the DSL must match the user request exactly; a mismatch is a real gap."
    ],
    project: input.project,
    env: input.env,
    userRequest: input.request,
    initialUnderstanding: compactInitialUnderstanding(input.initialUnderstanding),
    localPlan: {
      intent: input.plan.selection.intent,
      executable: input.plan.executable,
      readiness: input.plan.readiness,
      gaps: input.plan.gaps,
      blockingGaps: input.plan.blockingGaps,
      intentContractPassed: input.plan.intentContract.passed,
      intentContractGaps: input.plan.intentContract.gaps,
      dslValidationPassed: input.plan.materialization.dslValidation.passed,
      dslValidationGaps: input.plan.materialization.dslValidation.contractGaps
    },
    selectedKnowledge,
    materializedDsl: (input.planSummary.automationCase as { steps?: Array<Record<string, unknown>> } | undefined)?.steps?.map(compactStep),
    outputSchema: {
      semanticAlignment: "aligned|has_gap|uncertain",
      shouldWriteDsl: false,
      referencedIdsValid: true,
      gaps: ["max 3 short Chinese gaps"],
      notes: ["max 3 short Chinese notes"]
    }
  }, null, 2);
  return {
    mode: "compressed",
    prompt,
    promptChars: prompt.length,
    originalPromptChars: input.originalPromptChars,
    promptCharReductionPercent: input.originalPromptChars && input.originalPromptChars > 0
      ? Math.round((1 - prompt.length / input.originalPromptChars) * 1000) / 10
      : undefined,
    selectedKnowledge
  };
}

export function compactSelectedKnowledge(plan: PageModelExecutionPlan): Record<string, unknown> {
  const buckets = plan.selection.evidenceBuckets;
  const manual = plan.planningContext.retrievedOperationManualContext;
  const usedIds = usedKnowledgeIds(plan);
  return {
    pages: buckets.targetPage.filter((item) => usedIds.has(item.id) || usedIds.has(String(item.pageId))).map((item) => compactEvidence(item as unknown as Record<string, unknown>)),
    elements: buckets.executableElements.filter((item) => usedIds.has(item.id)).map((item) => compactEvidence(item as unknown as Record<string, unknown>)),
    assertions: buckets.assertions.filter((item) => usedIds.has(item.id)).map((item) => compactEvidence(item as unknown as Record<string, unknown>)),
    providers: buckets.providers.filter((item) => usedIds.has(item.id) || usedIds.has(String(item.providerRequirementId))).map((item) => compactEvidence(item as unknown as Record<string, unknown>)),
    operationManual: manual ? {
      capabilities: manual.capabilities.map((item) => pick(item as unknown as Record<string, unknown>, ["capabilityId", "operationType", "requiredData", "providerFlowIds", "successEvidencePolicyId"])),
      providerFlows: manual.providerFlows.map((item) => pick(item as unknown as Record<string, unknown>, ["providerFlowId"])),
      successEvidencePolicies: manual.successEvidencePolicies.map((item) => pick(item as unknown as Record<string, unknown>, ["policyId"]))
    } : undefined
  };
}

export function usedKnowledgeIds(plan: PageModelExecutionPlan): Set<string> {
  const ids = new Set<string>();
  for (const step of plan.materialization.case.steps as unknown as Array<Record<string, unknown>>) {
    for (const key of ["pageModelId", "targetPageId", "elementId", "targetElementId", "assertionId", "providerRequirementId", "evidenceId"]) {
      const value = step[key];
      if (typeof value === "string" && value) ids.add(value);
    }
  }
  return ids;
}

function compactInitialUnderstanding(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const raw = value as Record<string, unknown>;
  return {
    pageIntent: raw.pageIntent,
    businessAction: raw.businessAction,
    operationType: raw.operationType,
    extractedData: raw.extractedData,
    expectedOutcome: raw.expectedOutcome,
    assertions: Array.isArray(raw.assertions)
      ? raw.assertions.map((item) => pick(item as Record<string, unknown>, ["sourceText", "targetObject", "operator", "expected", "field"]))
      : undefined
  };
}

function compactStep(step: Record<string, unknown>): Record<string, unknown> {
  const assertion = step.assertion && typeof step.assertion === "object"
    ? pick(step.assertion as Record<string, unknown>, ["type", "expected", "column", "field", "source"])
    : undefined;
  return {
    ...pick(step, ["id", "action", "semanticTarget", "value", "targetElementId", "assertionId", "providerRequirementId", "pageModelId"]),
    assertion
  };
}

function compactEvidence(item: Record<string, unknown>): Record<string, unknown> {
  return pick(item, [
    "id",
    "pageId",
    "semanticName",
    "role",
    "controlType",
    "targetField",
    "optionValue",
    "status",
    "assertionType",
    "textCandidates",
    "provider",
    "codeType",
    "providerRequirementId"
  ]);
}

function pick(item: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const value = key === "textCandidates" ? compactTextCandidates(item[key]) : item[key];
    if (value !== undefined && value !== "" && !(Array.isArray(value) && value.length === 0)) out[key] = value;
  }
  return out;
}

function compactTextCandidates(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const texts = value.map(String).map((item) => item.trim()).filter(Boolean);
  return [...new Set(texts)].slice(0, 5);
}
