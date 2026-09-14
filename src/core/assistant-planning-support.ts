import type { BusinessFlow, DslStep, KnowledgeChunk, PageTransition } from "./types.js";

export interface KnowledgeRerankAudit {
  query: string;
  matchedKnowledgeId: string;
  matchedSource: string;
  score: number;
  originalConfidence: number;
  rerankReason: string;
  included: boolean;
  evidenceLevel?: "verified" | "weak_candidate";
  sourceProposalId?: string;
  status?: "candidate" | "verified" | "deprecated";
  retrievalWeight?: "weak" | "normal" | "strong";
  targetPageStatus?: "unverified" | "verified";
  evidenceSource?: string;
}

export interface LayeredEvidenceMetadata {
  evidenceLevel?: "verified" | "weak_candidate";
  sourceProposalId?: string;
  status?: "candidate" | "verified" | "deprecated";
  retrievalWeight?: "weak" | "normal" | "strong";
  targetPageStatus?: "unverified" | "verified";
  evidenceSource?: string;
}

export interface RerankedKnowledgeHit {
  chunk: KnowledgeChunk;
  score: number;
  reason: string;
}

export interface CoverageEvidence {
  item: string;
  status: "covered" | "partial" | "runtime_resolvable" | "missing";
  locatorLevel?: "exact_selector" | "semantic_locator" | "missing";
  source: "knowledge" | "page_map" | "business_flow" | "account_profile" | "runtime_probe" | "config";
  evidence: string[];
  evidenceLevel?: "verified" | "weak_candidate";
  sourceProposalId?: string;
  targetPageStatus?: "unverified" | "verified";
}

export interface PreflightCheck {
  name: string;
  status: "verified" | "declared" | "unknown";
  source: "business_flow" | "account_profile" | "runtime_probe" | "config";
  evidence?: string;
  blocksExecution: boolean;
}

export interface BusinessFlowCoverageResult {
  matchedFlowIds: string[];
  evidence: CoverageEvidence[];
  preflightChecks: PreflightCheck[];
}

export function rerankKnowledgeHitsForIntent(
  hits: KnowledgeChunk[],
  intent: { module?: string; action?: string; operationType?: string },
  query: string,
  limit: number
): { hits: KnowledgeChunk[]; audit: KnowledgeRerankAudit[] } {
  const reranked = hits.map((chunk) => rerankOne(chunk, intent, query));
  const sorted = reranked
    .sort((a, b) => b.score - a.score)
    .filter((item) => !shouldExcludeRerankedHit(item, intent))
    .slice(0, limit);
  return {
    hits: sorted.map((item) => ({ ...item.chunk, confidence: Math.max(0, Math.min(1, item.score)) })),
    audit: reranked
      .sort((a, b) => b.score - a.score)
      .map((item) => ({
        query,
        matchedKnowledgeId: knowledgeId(item.chunk),
        matchedSource: item.chunk.sourceType,
        score: Number(item.score.toFixed(4)),
        originalConfidence: item.chunk.confidence,
        rerankReason: item.reason,
        included: sorted.some((selected) => knowledgeId(selected.chunk) === knowledgeId(item.chunk)),
        ...candidateMetadata(item.chunk)
      }))
  };
}

export function detectRedPacketCreateClaimPollution(hits: KnowledgeChunk[], intent: { module?: string; action?: string }, topN = 5): boolean {
  if (intent.module !== "red-packet" || intent.action !== "create") return false;
  const top = hits.slice(0, topN);
  return top.length > 0 && top.filter((hit) => isClaimLike(hit)).length >= Math.ceil(top.length / 2);
}

export function buildBusinessFlowCoverage(
  flows: BusinessFlow[],
  transitions: PageTransition[],
  intent: { module?: string; action?: string; operationType?: string },
  project: string,
  env: string
): BusinessFlowCoverageResult {
  const matched = flows.filter((flow) => flow.project_id === project && flow.env === env && flow.platform === "web" && flowMatchesIntent(flow, intent));
  const dslSteps = matched.flatMap((flow) => flow.transition_ids.flatMap((id) => transitions.find((transition) => transition.transition_id === id)?.dsl_steps ?? []));
  const writeEvidence = classifyWriteActionEvidence(dslSteps);
  const evidence: CoverageEvidence[] = [];
  if (matched.length) {
    evidence.push({ item: "business_flow", status: "covered", source: "business_flow", evidence: matched.map((flow) => flow.flow_id) });
  }
  if (intent.operationType === "write") {
    evidence.push({
      item: "write_action_locator",
      status: writeEvidence.status,
      locatorLevel: writeEvidence.locatorLevel,
      source: "business_flow",
      evidence: writeEvidence.evidence
    });
  }
  const preflightChecks = matched.flatMap((flow) => extractPreflightChecks(flow.preconditions ?? []));
  return { matchedFlowIds: matched.map((flow) => flow.flow_id), evidence, preflightChecks };
}

export function classifyWriteActionEvidence(steps: DslStep[]): CoverageEvidence {
  const writeSteps = steps.filter((step) => ["click", "input", "fill", "type", "select", "confirmWrite"].includes(step.action));
  const exact = writeSteps.filter((step) => Boolean(step.primary_locator || step.target || step.fallback_locators?.some((locator) => isExactLocator(locator))));
  const semantic = writeSteps.filter((step) => Boolean(step.semantic_target || step.semanticTarget));
  if (exact.length) {
    return {
      item: "write_action_locator",
      status: "covered",
      locatorLevel: "exact_selector",
      source: "business_flow",
      evidence: exact.slice(0, 8).map((step) => `${step.id ?? step.action}:${step.primary_locator ?? step.target ?? step.semantic_target ?? step.semanticTarget}`)
    };
  }
  if (semantic.length) {
    return {
      item: "write_action_locator",
      status: "runtime_resolvable",
      locatorLevel: "semantic_locator",
      source: "business_flow",
      evidence: semantic.slice(0, 8).map((step) => `${step.id ?? step.action}:${step.semantic_target ?? step.semanticTarget}`)
    };
  }
  return { item: "write_action_locator", status: "missing", locatorLevel: "missing", source: "business_flow", evidence: [] };
}

export function summarizeRetrievalForFailure(plan: Record<string, unknown>): Record<string, unknown> {
  const retrieval = plan.retrievalBundle && typeof plan.retrievalBundle === "object" ? (plan.retrievalBundle as Record<string, unknown>) : {};
  return {
    status: retrieval.status,
    retrievalQueries: retrieval.retrievalQueries,
    pageCandidateCount: Array.isArray(retrieval.pageCandidates) ? retrieval.pageCandidates.length : 0,
    elementCandidateCount: Array.isArray(retrieval.elementCandidates) ? retrieval.elementCandidates.length : 0,
    businessFlowCandidateCount: Array.isArray(retrieval.businessFlowCandidates) ? retrieval.businessFlowCandidates.length : 0,
    gaps: retrieval.gaps
  };
}

export function extractCoverageGaps(plan: Record<string, unknown>): string[] {
  const retrieval = plan.retrievalBundle && typeof plan.retrievalBundle === "object" ? (plan.retrievalBundle as Record<string, unknown>) : {};
  const coverage = plan.coverage && typeof plan.coverage === "object" ? (plan.coverage as Record<string, unknown>) : {};
  const pageModelExecutionPlan = plan.pageModelExecutionPlan && typeof plan.pageModelExecutionPlan === "object" ? (plan.pageModelExecutionPlan as Record<string, unknown>) : {};
  return [...new Set([
    ...(Array.isArray(retrieval.gaps) ? retrieval.gaps.map(String) : []),
    ...(Array.isArray(coverage.uncoveredGoals) ? coverage.uncoveredGoals.map(String) : []),
    ...(Array.isArray(pageModelExecutionPlan.gaps) ? pageModelExecutionPlan.gaps.map(String) : []),
    ...(Array.isArray(pageModelExecutionPlan.blockingGaps) ? pageModelExecutionPlan.blockingGaps.map(String) : [])
  ])];
}

export function buildAiDiagnosticLogForFailure(input: {
  plan: Record<string, unknown>;
  failureStage: string;
  blockedStage?: string;
  readiness?: string;
  automationReason?: string;
}): Record<string, unknown> {
  const pageModelExecutionPlan = asRecord(input.plan.pageModelExecutionPlan);
  const selection = asRecord(pageModelExecutionPlan?.selection);
  const materialization = asRecord(pageModelExecutionPlan?.materialization);
  const automationCase = asRecord(materialization?.case);
  const retrievalBundle = asRecord(input.plan.retrievalBundle);
  const coverage = asRecord(input.plan.coverage);
  const executionContract = asRecord(pageModelExecutionPlan?.executionContract);
  const evidenceBucketSummary = asRecord(pageModelExecutionPlan?.evidenceBucketSummary);
  const steps = Array.isArray(automationCase?.steps) ? automationCase.steps as Array<Record<string, unknown>> : [];

  return {
    schemaVersion: "ai-diagnostic-log.v1",
    failure: {
      stage: input.failureStage,
      blockedStage: input.blockedStage,
      readiness: input.readiness,
      reason: input.automationReason
    },
    route: {
      usedPageModelExecutionPlan: Boolean(pageModelExecutionPlan),
      pageModelUnavailableReason: input.plan.pageModelUnavailableReason,
      legacyRetrievalPresent: Boolean(retrievalBundle)
    },
    intent: {
      assistantIntent: input.plan.intentSpec ?? input.plan.intent,
      pageModelIntent: selection?.intent
    },
    pageModel: {
      readiness: pageModelExecutionPlan?.readiness,
      executable: pageModelExecutionPlan?.executable,
      gaps: pageModelExecutionPlan?.gaps,
      blockingGaps: pageModelExecutionPlan?.blockingGaps,
      recommendedNextAction: pageModelExecutionPlan?.recommendedNextAction,
      reason: pageModelExecutionPlan?.reason,
      evidenceBucketSummary,
      executionContract,
      selectedEvidence: summarizePageModelEvidence(selection?.selectedEvidence),
      fallbackEvidence: summarizePageModelEvidence(selection?.fallbackEvidence),
      excludedEvidence: summarizeExcludedEvidence(selection?.excludedEvidence),
      userAssertions: pageModelExecutionPlan?.userAssertions
    },
    materialization: {
      executable: materialization?.executable,
      gaps: materialization?.gaps,
      blockingGaps: materialization?.blockingGaps,
      excludedEvidenceUsed: materialization?.excludedEvidenceUsed,
      temporarySelectorUsed: materialization?.temporarySelectorUsed,
      stepCount: steps.length,
      steps: steps.map(summarizeMaterializedStep)
    },
    coverage: {
      coverageGaps: extractCoverageGaps(input.plan),
      rawCoverage: coverage
    },
    retrieval: {
      summary: summarizeRetrievalForFailure(input.plan),
      gaps: asArray(retrievalBundle?.gaps).map(String),
      runtimeResolvable: retrievalBundle?.runtimeResolvable,
      preflightChecks: retrievalBundle?.preflightChecks
    },
    diagnosisHints: inferAiDiagnosisHints({ pageModelExecutionPlan, executionContract, steps })
  };
}

function summarizePageModelEvidence(value: unknown): Array<Record<string, unknown>> {
  return asArray(value).map((item) => {
    const record = asRecord(item) ?? {};
    return {
      kind: record.kind,
      id: record.id,
      pageId: record.pageId,
      semanticName: record.semanticName,
      role: record.role,
      semanticRole: record.semanticRole,
      controlType: record.controlType,
      targetField: record.targetField,
      optionValue: record.optionValue,
      status: record.status,
      confidence: record.confidence,
      evidenceRole: record.evidenceRole,
      executionAllowed: record.executionAllowed,
      reason: record.reason,
      locatorCandidateCount: asArray(record.locatorCandidates).length,
      evidenceCount: asArray(record.evidence).length
    };
  });
}

function summarizeExcludedEvidence(value: unknown): Array<Record<string, unknown>> {
  return asArray(value).slice(0, 100).map((item) => {
    const record = asRecord(item) ?? {};
    return {
      id: record.id,
      pageId: record.pageId,
      reason: record.reason,
      evidenceRole: record.evidenceRole,
      executionAllowed: record.executionAllowed
    };
  });
}

function summarizeMaterializedStep(step: Record<string, unknown>): Record<string, unknown> {
  const assertion = asRecord(step.assertion);
  return {
    id: step.id,
    action: step.action,
    pageModelId: step.pageModelId,
    elementId: step.elementId,
    assertionId: step.assertionId,
    evidenceId: step.evidenceId,
    primaryLocator: step.primary_locator ?? step.primaryLocator ?? step.target,
    fallbackLocatorCount: asArray(step.fallback_locators ?? step.fallbackLocators).length,
    value: step.value,
    valueSource: step.valueSource,
    dataBinding: step.dataBinding,
    assertion: assertion ? {
      type: assertion.type,
      table: assertion.table,
      column: assertion.column,
      semanticField: assertion.semanticField,
      expected: assertion.expected,
      emptyStateAccepted: assertion.emptyStateAccepted,
      columnMapping: assertion.columnMapping
    } : undefined
  };
}

function inferAiDiagnosisHints(input: {
  pageModelExecutionPlan?: Record<string, unknown>;
  executionContract?: Record<string, unknown>;
  steps: Array<Record<string, unknown>>;
}): string[] {
  const hints: string[] = [];
  const forbidden = asArray(input.executionContract?.forbiddenEvidenceUsed).map(String);
  const missingRoles = asArray(input.executionContract?.missingRoles).map(String);
  const materializedPageIds = asArray(input.executionContract?.materializedPageIds).map(String);
  if (forbidden.length) hints.push("execution_contract_forbidden_evidence_used");
  if (missingRoles.length) hints.push(`execution_contract_missing_roles:${missingRoles.join(",")}`);
  if (materializedPageIds.length > 1) hints.push("multiple_page_models_materialized");
  if (asArray(input.pageModelExecutionPlan?.gaps).length) hints.push("page_model_gaps_present");
  if (!input.steps.some((step) => step.action === "assert") && asArray(input.pageModelExecutionPlan?.userAssertions).length) hints.push("user_assertion_not_materialized");
  return hints;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function rerankOne(chunk: KnowledgeChunk, intent: { module?: string; action?: string; operationType?: string }, query: string): RerankedKnowledgeHit {
  let score = chunk.confidence;
  const text = `${chunk.title} ${chunk.sourceType} ${chunk.surface ?? ""} ${chunk.content} ${JSON.stringify(chunk.metadata ?? {})}`.toLowerCase();
  const reasons: string[] = ["base_confidence"];
  if (intent.module === "red-packet" && intent.action === "create") {
    if (/(create_red_packet|create red packet|red packet create|\u521b\u5efa\u7ea2\u5305|\u53d1\u7ea2\u5305|\u53d1\u653e\u7ea2\u5305)/i.test(text)) {
      score += 0.45;
      reasons.push("boost:red_packet_create");
    }
    if (/business-flow|business_flow|flow_id|demo_test_create_red_packet/i.test(text)) {
      score += 0.25;
      reasons.push("boost:business_flow");
    }
    if (/(claim|receive|redeem|passphrase|\u9886\u53d6|\u53e3\u4ee4|\u62a2\u7ea2\u5305)/i.test(text)) {
      score -= 0.55;
      reasons.push("demote:claim_receive");
    }
  }
  if (isAssetOverviewIntent(intent)) {
    if (isAssetOverviewLikeText(text)) {
      score += 0.55;
      reasons.push("boost:asset_overview");
    }
    if (/(usdt|tether|asset list|total-assets|\u8d44\u4ea7\u5217\u8868|\u8d44\u4ea7\u603b\u89c8|\u6211\u7684\u8d44\u4ea7|\u5e01\u79cd\u7ef4\u5ea6|\u8d26\u6237\u7ef4\u5ea6)/i.test(text)) {
      score += 0.25;
      reasons.push("boost:asset_overview_terms");
    }
    if (/(fund flow|\u8d44\u91d1\u6d41\u6c34|\u8d44\u91d1\u660e\u7ec6|\u8d26\u5355|\u8bb0\u5f55|history|statement|transaction)/i.test(text) && !/total-assets|asset overview|\u8d44\u4ea7\u603b\u89c8|\u8d44\u4ea7\u5217\u8868/i.test(text)) {
      score -= 0.4;
      reasons.push("demote:record_candidate_for_asset_overview");
    }
    if (isRedPacketLikeText(text)) {
      score -= 1.2;
      reasons.push("demote:module_mismatch:red_packet_for_asset_overview");
    }
    if (isWriteOnlyText(text)) {
      score -= 0.45;
      reasons.push("demote:read_intent_write_evidence");
    }
  } else if (isAssetRecordIntent(intent)) {
    if (isAssetRecordLikeText(text)) {
      score += 0.5;
      reasons.push("boost:asset_wallet_record");
    }
    if (/(usdt|coin|token|currency|\u5e01\u79cd|\u7b5b\u9009)/i.test(text)) {
      score += 0.15;
      reasons.push("boost:asset_filter_terms");
    }
    if (isRedPacketLikeText(text)) {
      score -= 1.2;
      reasons.push("demote:module_mismatch:red_packet_for_asset_record");
    }
    if (isWriteOnlyText(text)) {
      score -= 0.45;
      reasons.push("demote:read_intent_write_evidence");
    }
    if (/(withdraw|deposit|transfer|trade|order|\u63d0\u73b0|\u63d0\u5e01|\u5145\u503c|\u8f6c\u8d26|\u4e0b\u5355|\u4ea4\u6613)/i.test(text)) {
      score -= 0.25;
      reasons.push("demote:adjacent_module_for_asset_record");
    }
  }
  if (query && text.includes(query.toLowerCase())) reasons.push("query_exact");
  return { chunk, score, reason: reasons.join(",") };
}

function shouldExcludeRerankedHit(item: RerankedKnowledgeHit, intent: { module?: string; action?: string; operationType?: string }): boolean {
  if (isAssetOverviewIntent(intent)) {
    const text = `${item.chunk.title} ${item.chunk.sourceType} ${item.chunk.surface ?? ""} ${item.chunk.content} ${JSON.stringify(item.chunk.metadata ?? {})}`.toLowerCase();
    if (isRedPacketLikeText(text)) return true;
    return item.score < 0.6;
  }
  if (!isAssetRecordIntent(intent)) return false;
  const text = `${item.chunk.title} ${item.chunk.sourceType} ${item.chunk.surface ?? ""} ${item.chunk.content} ${JSON.stringify(item.chunk.metadata ?? {})}`.toLowerCase();
  if (!isAssetRecordLikeText(text)) return true;
  return item.score < 0.75 || /demote:module_mismatch:red_packet_for_asset_record/.test(item.reason);
}

function knowledgeId(chunk: KnowledgeChunk): string {
  return `${chunk.sourceType}:${chunk.title}:${chunk.content.slice(0, 80)}`;
}

function candidateMetadata(chunk: KnowledgeChunk): Partial<KnowledgeRerankAudit> {
  const metadata = chunk.metadata && typeof chunk.metadata === "object" ? chunk.metadata as Record<string, unknown> : {};
  const status = metadata.status === "candidate" || metadata.status === "verified" || metadata.status === "deprecated" ? metadata.status : undefined;
  const retrievalWeight = metadata.retrievalWeight === "weak" || metadata.retrievalWeight === "normal" || metadata.retrievalWeight === "strong" ? metadata.retrievalWeight : undefined;
  const targetPageStatus = metadata.targetPageStatus === "unverified" || metadata.targetPageStatus === "verified" ? metadata.targetPageStatus : undefined;
  const isCandidate = String(chunk.sourceType) === "candidate_knowledge" || status === "candidate" || retrievalWeight === "weak" || targetPageStatus === "unverified";
  return {
    evidenceLevel: isCandidate ? "weak_candidate" : "verified",
    sourceProposalId: typeof metadata.sourceProposalId === "string" ? metadata.sourceProposalId : undefined,
    status,
    retrievalWeight,
    targetPageStatus,
    evidenceSource: chunk.sourceType
  };
}

function isClaimLike(chunk: KnowledgeChunk): boolean {
  return /(claim|receive|redeem|passphrase|\u9886\u53d6|\u53e3\u4ee4|\u62a2\u7ea2\u5305)/i.test(`${chunk.title} ${chunk.content} ${JSON.stringify(chunk.metadata ?? {})}`);
}

export function isAssetRecordIntent(intent: { module?: string; action?: string; operationType?: string }): boolean {
  return (intent.module === "asset" || intent.module === "wallet") && intent.operationType !== "write" && /(record|query|view|history|read)/i.test(String(intent.action ?? ""));
}

export function isAssetOverviewIntent(intent: { module?: string; action?: string; operationType?: string }): boolean {
  const action = String(intent.action ?? "");
  return (
    (intent.module === "asset" || intent.module === "wallet") &&
    intent.operationType !== "write" &&
    /(overview|view|list|read)/i.test(action) &&
    !/(record|history|statement|transaction)/i.test(action)
  );
}

export function isAssetRecordKnowledge(chunk: KnowledgeChunk): boolean {
  return isAssetRecordLikeText(`${chunk.title} ${chunk.sourceType} ${chunk.surface ?? ""} ${chunk.content} ${JSON.stringify(chunk.metadata ?? {})}`.toLowerCase());
}

export function layerEvidenceMetadata(value: unknown, scope: "self" | "nestedCandidate" = "self"): LayeredEvidenceMetadata {
  if (!value || typeof value !== "object") return {};
  const record = value as Record<string, unknown>;
  const metadata = record.metadata && typeof record.metadata === "object" ? (record.metadata as Record<string, unknown>) : {};
  const candidate = record.candidate && typeof record.candidate === "object" ? (record.candidate as Record<string, unknown>) : {};
  const source = scope === "nestedCandidate" ? { ...candidate } : { ...metadata, ...record };
  delete (source as Record<string, unknown>).candidate;
  delete (source as Record<string, unknown>).metadata;

  const rawStatus = stringValue(source.status ?? source.knowledge_status ?? source.review_status);
  const status = rawStatus === "candidate" || rawStatus === "deprecated" ? rawStatus : rawStatus ? "verified" : undefined;
  const retrievalWeight = source.retrievalWeight === "weak" || source.retrievalWeight === "normal" || source.retrievalWeight === "strong" ? source.retrievalWeight : undefined;
  const targetPageStatus =
    source.targetPageStatus === "unverified" || source.targetPageStatus === "verified"
      ? source.targetPageStatus
      : isVerifiedKnowledgeStatus(rawStatus)
        ? "verified"
        : undefined;
  const sourceProposalId =
    typeof source.sourceProposalId === "string"
      ? source.sourceProposalId
      : typeof source.source_scan_id === "string"
        ? source.source_scan_id
        : typeof source.sourceId === "string"
          ? source.sourceId
          : undefined;
  const evidenceSource = typeof source.sourceType === "string" ? source.sourceType : typeof source.source === "string" ? source.source : undefined;
  const isCandidate =
    evidenceSource === "candidate_knowledge" ||
    rawStatus === "candidate" ||
    retrievalWeight === "weak" ||
    targetPageStatus === "unverified" ||
    Boolean(sourceProposalId && /candidate/i.test(String(evidenceSource ?? "")));
  const evidenceLevel = isCandidate ? "weak_candidate" : sourceProposalId || rawStatus || retrievalWeight || targetPageStatus ? "verified" : undefined;

  return {
    evidenceLevel,
    sourceProposalId,
    status,
    retrievalWeight,
    targetPageStatus,
    evidenceSource
  };
}

export function isWeakLayeredEvidence(item: LayeredEvidenceMetadata): boolean {
  return item.evidenceLevel === "weak_candidate" || item.status === "candidate" || item.retrievalWeight === "weak" || item.targetPageStatus === "unverified";
}

export function hasVerifiedAssetOverviewEvidence(input: {
  pageCandidates: LayeredEvidenceMetadata[];
  elementCandidates: Array<LayeredEvidenceMetadata & { text?: string; selector?: string; id?: string; title?: string }>;
}): boolean {
  const hasVerifiedPage = input.pageCandidates.some((item) => item.evidenceLevel === "verified" && item.targetPageStatus !== "unverified");
  const hasVerifiedAssetElement = input.elementCandidates.some((item) => {
    if (item.evidenceLevel !== "verified") return false;
    return /(asset|assets|usdt|tether|\u8d44\u4ea7|\u6211\u7684\u8d44\u4ea7|\u5e01\u79cd|\u8d26\u6237\u7ef4\u5ea6|\u5e01\u79cd\u7ef4\u5ea6)/i.test(`${item.text ?? ""} ${item.selector ?? ""} ${item.id ?? ""} ${item.title ?? ""}`);
  });
  return hasVerifiedPage && hasVerifiedAssetElement;
}

function isAssetRecordLikeText(text: string): boolean {
  return (
    /(asset|assets|wallet|finance|fund|\u8d44\u4ea7|\u94b1\u5305|\u8d22\u52a1|\u8d44\u91d1).{0,40}(record|records|history|statement|transaction|list|\u8bb0\u5f55|\u660e\u7ec6|\u8d26\u5355|\u5217\u8868)/i.test(text) ||
    /(record|records|history|statement|transaction|list|\u8bb0\u5f55|\u660e\u7ec6|\u8d26\u5355|\u5217\u8868).{0,40}(asset|assets|wallet|finance|fund|\u8d44\u4ea7|\u94b1\u5305|\u8d22\u52a1|\u8d44\u91d1)/i.test(text) ||
    /assets\/(total-assets|records?|history|bill|statement)/i.test(text)
  );
}

function isAssetOverviewLikeText(text: string): boolean {
  return (
    /(asset|assets|wallet|\u8d44\u4ea7|\u94b1\u5305).{0,40}(overview|center|list|total-assets|\u603b\u89c8|\u4e2d\u5fc3|\u5217\u8868|\u6211\u7684\u8d44\u4ea7)/i.test(text) ||
    /(overview|center|list|total-assets|\u603b\u89c8|\u4e2d\u5fc3|\u5217\u8868|\u6211\u7684\u8d44\u4ea7).{0,40}(asset|assets|wallet|\u8d44\u4ea7|\u94b1\u5305)/i.test(text) ||
    /assets\/total-assets/i.test(text)
  );
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isVerifiedKnowledgeStatus(status: string | undefined): boolean {
  return Boolean(status && /^(verified|screenshot_verified|dom_verified|click_verified|execution_observed|execution_verified)$/i.test(status));
}

function isRedPacketLikeText(text: string): boolean {
  return /(red[-\s]?packet|packet|claim|passphrase|\u7ea2\u5305|\u53e3\u4ee4|\u9886\u53d6|\u62a2\u7ea2\u5305)/i.test(text);
}

function isWriteOnlyText(text: string): boolean {
  return /(create|submit|delete|remove|send|claim|withdraw|transfer|order|buy|sell|\u521b\u5efa|\u63d0\u4ea4|\u5220\u9664|\u53d1\u653e|\u9886\u53d6|\u63d0\u73b0|\u8f6c\u8d26|\u4e0b\u5355|\u4e70\u5165|\u5356\u51fa)/i.test(text);
}

function flowMatchesIntent(flow: BusinessFlow, intent: { module?: string; action?: string }): boolean {
  const text = `${flow.flow_id} ${flow.name} ${(flow.target_flows ?? []).join(" ")}`.toLowerCase();
  if (intent.module === "red-packet" && intent.action === "create") return /(create_red_packet|create red packet|red packet create|\u521b\u5efa\u7ea2\u5305|\u53d1\u653e\u7ea2\u5305|\u53d1\u7ea2\u5305)/i.test(text);
  return false;
}

function extractPreflightChecks(preconditions: string[]): PreflightCheck[] {
  return preconditions.flatMap((item) => {
      const balance = item.match(/^asset\.balance\.([A-Z0-9]+)\s*>=\s*([0-9.]+)$/i);
      if (balance) {
        return [{
          name: `asset.balance.${balance[1].toUpperCase()}`,
          status: "declared" as const,
          source: "business_flow" as const,
          evidence: item,
          blocksExecution: false
        }];
      }
      return [];
    });
}

function isExactLocator(locator: string): boolean {
  return /^(css=|xpath=|role=|text=|id=|data-testid=)/i.test(locator);
}
