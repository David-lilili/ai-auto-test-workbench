export type AiStageName =
  | "requirement_understanding"
  | "retrieval_rerank"
  | "evidence_fusion"
  | "dsl_draft"
  | "dsl_review"
  | "coverage_explanation"
  | "preflight_decision"
  | "failure_analysis"
  | "memory_update_proposal";

export type FailureStage =
  | "requirement"
  | "retrieval"
  | "rerank"
  | "evidence_fusion"
  | "dsl"
  | "coverage"
  | "preflight"
  | "execution"
  | "provider"
  | "selector"
  | "assertion"
  | "product_bug"
  | "external_interrupt"
  | "unknown";

export interface EvidenceRef {
  source: "knowledge" | "page_map" | "business_flow" | "historical_dsl" | "account_profile" | "provider" | "config" | "ai_inferred";
  id?: string;
  quote?: string;
  confidence?: number;
  evidenceLevel?: "verified" | "weak_candidate";
  sourceProposalId?: string;
  status?: "candidate" | "verified" | "deprecated";
  retrievalWeight?: "weak" | "normal" | "strong";
  targetPageStatus?: "unverified" | "verified";
}

export interface AiStageEnvelope<TParsed = unknown> {
  schemaVersion: "ai-stage-envelope.v1";
  stage: AiStageName;
  model: string;
  startedAt: string;
  endedAt: string;
  elapsedMs: number;
  inputSummary: Record<string, unknown>;
  rawOutput: unknown;
  parsedOutput?: TParsed;
  schemaValid: boolean;
  evidence: EvidenceRef[];
  confidence: number;
  uncertainty: string[];
  error?: string;
}

export interface DslDraftStep {
  id: string;
  action: string;
  pageId?: string;
  targetField?: string;
  elementRef?: string;
  semanticName?: string;
  semanticLocator?: string;
  exactSelector?: string;
  inputValue?: unknown;
  valueSource?: string;
  appliedRuleId?: string;
  evidenceLevel?: "verified" | "weak_candidate";
  sourceProposalId?: string;
  candidateStatus?: "candidate" | "verified" | "deprecated";
  targetPageStatus?: "unverified" | "verified";
  providerDependency?: string;
  assertion?: Record<string, unknown>;
  runtimeResolvable: boolean;
  evidence: EvidenceRef[];
  aiConfidence: number;
}

export interface DslDraft {
  schemaVersion: "dsl-draft.v1";
  project: string;
  env: string;
  module: string;
  action: string;
  operationType: "read" | "write" | "unknown";
  loginRequired: boolean;
  data: Record<string, unknown>;
  providerDependencies: string[];
  steps: DslDraftStep[];
  readOnlyGuardDiagnostics?: {
    enabled: boolean;
    beforeStepCount: number;
    afterStepCount: number;
    removedSteps: Array<{
      id: string;
      action: string;
      reason: string;
      semanticLocator?: string;
      elementRef?: string;
    }>;
    retainedFilterSteps: string[];
    warnings: string[];
  };
  appliedRules?: Array<{
    ruleId: string;
    stepId: string;
    targetField?: string;
    semanticName?: string;
    beforeValue?: unknown;
    afterValue?: unknown;
    valueSource?: string;
  }>;
  assertions: Array<Record<string, unknown>>;
  clarificationQuestions: string[];
}

export interface DslReview {
  schemaVersion: "dsl-review.v1";
  blocking: string[];
  runtimeResolvable: string[];
  askUser: string[];
  assumed: string[];
  assertionCandidates: Array<Record<string, unknown>>;
  providerDependencies: string[];
}

export interface CoverageExplanation {
  schemaVersion: "coverage-explanation.v1";
  items: Array<{
    item: string;
    status: "covered" | "partial" | "missing";
    blocking: boolean;
    runtimeResolvable: boolean;
    evidence: EvidenceRef[];
    explanation: string;
  }>;
  blockingGaps: string[];
  runtimeResolvableGaps: string[];
}

export interface PreflightDecision {
  schemaVersion: "preflight-decision.v1";
  decision: "continue" | "degradedContinue" | "askUser" | "block";
  ready?: boolean;
  recommendedNextAction?: string;
  blockingReasons: string[];
  warnings: string[];
  assumed: string[];
}

export interface ProviderCallRecord {
  provider: string;
  operation: string;
  scene?: string;
  startedAt: string;
  endedAt: string;
  elapsedMs: number;
  status: "success" | "failed" | "skipped";
  errorCode?: string;
  errorMessage?: string;
  requestSummary: Record<string, unknown>;
}

export interface FailurePackageV1 {
  schemaVersion: "failure-package.v1";
  runId: string;
  project: string;
  env: string;
  originalUserRequest: string;
  normalizedUserRequest: string;
  intent?: unknown;
  deepseekRequirementOutput?: AiStageEnvelope;
  rawRetrievalHits?: unknown[];
  deepseekRerankOutput?: AiStageEnvelope;
  fusedEvidence?: AiStageEnvelope;
  dslDraft?: AiStageEnvelope<DslDraft>;
  dslReview?: AiStageEnvelope<DslReview>;
  coverageResult?: unknown;
  deepseekCoverageExplanation?: AiStageEnvelope<CoverageExplanation>;
  preflightResult?: unknown;
  deepseekPreflightDecision?: AiStageEnvelope<PreflightDecision>;
  executionStarted: boolean;
  failureStage: FailureStage;
  providerCalls: ProviderCallRecord[];
  recommendedMemoryUpdates?: AiStageEnvelope;
}

export function createLocalAiStageEnvelope<TParsed>(input: {
  stage: AiStageName;
  inputSummary: Record<string, unknown>;
  parsedOutput: TParsed;
  evidence?: EvidenceRef[];
  confidence?: number;
  uncertainty?: string[];
  error?: string;
}): AiStageEnvelope<TParsed> {
  const at = new Date().toISOString();
  return {
    schemaVersion: "ai-stage-envelope.v1",
    stage: input.stage,
    model: "local-structured",
    startedAt: at,
    endedAt: at,
    elapsedMs: 0,
    inputSummary: input.inputSummary,
    rawOutput: input.parsedOutput,
    parsedOutput: input.parsedOutput,
    schemaValid: !input.error,
    evidence: input.evidence ?? [],
    confidence: input.confidence ?? 0.7,
    uncertainty: input.uncertainty ?? [],
    error: input.error
  };
}

export function assertAiStageEnvelope(value: AiStageEnvelope): void {
  if (value.schemaVersion !== "ai-stage-envelope.v1") throw new Error("Invalid AI stage schemaVersion.");
  if (!value.stage || !value.startedAt || !value.endedAt) throw new Error("Invalid AI stage envelope.");
  if (!Array.isArray(value.evidence) || !Array.isArray(value.uncertainty)) throw new Error("Invalid AI stage arrays.");
}
