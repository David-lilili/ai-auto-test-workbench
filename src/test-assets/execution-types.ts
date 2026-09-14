/**
 * P13 执行层类型。
 */

import type { TestAsset } from "../test-assets/types.js";

// ============ P13.2 ExecutionPreparationPackage ============

export type ExecutionReadinessStatus =
  | "READY"
  | "READY_WITH_REVIEW"
  | "NEEDS_MODELING"
  | "NEEDS_TEST_DATA"
  | "NEEDS_ACCOUNT_PROFILE"
  | "NEEDS_SECURITY_APPROVAL"
  | "BLOCKED_BY_RISK"
  | "BLOCKED_BY_KNOWLEDGE"
  | "INVALID_ASSET";

export interface ResolvedTestData {
  dimension: string;
  value: string;
  source: "STATIC_FIXTURE" | "ACCOUNT_PROFILE" | "ENV_CONFIG" | "BUSINESS_KNOWLEDGE" | "USER_PROVIDED" | "RUNTIME_QUERY";
  environment?: string;
  freshness?: "FRESH" | "STALE" | "UNKNOWN";
  provenance?: string;
}

export interface ResolvedProfile {
  profileId?: string;
  matched: boolean;
  matchEvidence: string[];
  missingDimensions: string[];
  needsConfirmation: boolean;
}

export interface ExecutionPreparationPackage {
  executionPreparationId: string;
  testAssetId: string;
  testAssetVersion: string;
  requirementRefs: string[];
  businessRuleRefs: string[];
  capabilityRefs: string[];
  semanticActions: TestAsset["semanticActions"];
  expectedOutcomes: TestAsset["expectedOutcomes"];
  pageModelRefs: string[];
  testDataRequirements: TestAsset["testDataRequirements"];
  resolvedTestData: ResolvedTestData[];
  accountProfileRequirements: TestAsset["accountProfileRequirements"];
  resolvedAccountProfile?: ResolvedProfile;
  executionRisk: TestAsset["risk"]["executionRisk"];
  assetFreshness: TestAsset["assetFreshness"];
  executionFreshness: TestAsset["executionFreshness"];
  knowledgeFingerprint?: string;
  pageModelFingerprint?: string;
  contextFingerprint?: string;
  readiness: ExecutionReadinessStatus;
  blockReasons: string[];
  createdAt: string;
  /** P13-A15：Structured Execution Bridge v2 字段 */
  structuredIntent?: import("./structured-intent.js").StructuredExecutionIntent;
  resolvedCapabilities?: string[];
  resolvedPages?: string[];
  executionOperations?: Array<{ action: string; target: string; value?: string; sourceSemanticActionId?: string; capabilityRef?: string }>;
  assertionIntents?: Array<{ statement: string; userAssertionKind: string; mappingSource: string; materializable: boolean }>;
  modelGaps?: Array<{ capability: string; semanticAction: string; pageId?: string; missing: string[] }>;
  riskAssessment?: { riskLevel: string; needsAuthorization: boolean; reason: string };
  materializationInputs?: { baseUrl?: string; pageId?: string };
}

// ============ P13.6 ExecutionIntent ============

export interface ExecutionIntentOperation {
  action: string;
  target: string;
  value?: string;
  mappedTo?: string; // canonical action
}

export interface ExecutionIntent {
  capabilities: string[];
  operations: ExecutionIntentOperation[];
  entities: string[];
  expectedOutcomes: Array<{ statement: string; assertionKind?: string }>;
  preconditions: Array<{ statement: string; category?: string }>;
  testDataBindings: Array<{ dimension: string; value: string }>;
}

// ============ P13.7 Action Registry ============

export type ActionMappingStatus = "SUPPORTED" | "ALIAS" | "NEEDS_MAPPING" | "UNSUPPORTED";

// ============ P13.29 Authorization ============

export interface ExecutionAuthorization {
  authorizationId: string;
  assetId: string;
  assetVersion: string;
  runScope: string;
  environment: string;
  risk: string;
  approvedBy: string;
  expiresAt: string;
  createdAt: string;
}

// ============ P13.31 ExecutionRun 扩展 ============

export interface TestAssetRunExtension {
  testAssetId?: string;
  testAssetVersion?: string;
  requirementRefs?: string[];
  executionPreparationId?: string;
  materializationFingerprint?: string;
  accountProfileId?: string;
  testDataFingerprint?: string;
  executionAuthorizationId?: string;
  creationMode?: string;
  sourceType?: "NATURAL_LANGUAGE" | "TEST_ASSET";
  sourceRef?: string;
  dslMaterializationFingerprint?: string;
}

// ============ P13.33 Result Taxonomy ============

export type ExecutionResultStatus =
  | "PASS"
  | "PRODUCT_FAILURE"
  | "MODEL_FAILURE"
  | "TEST_DATA_FAILURE"
  | "PRECONDITION_FAILURE"
  | "EXECUTION_FAILURE"
  | "ASSERTION_FAILURE"
  | "ENVIRONMENT_FAILURE"
  | "RISK_BLOCKED"
  | "CANCELLED";

export interface AssetRunRecord {
  runId: string;
  testAssetId: string;
  testAssetVersion: string;
  executionPreparationId: string;
  materializationFingerprint?: string;
  accountProfileId?: string;
  testDataFingerprint?: string;
  executionAuthorizationId?: string;
  environment: string;
  result: ExecutionResultStatus;
  attempts: Array<{ attempt: number; status: ExecutionResultStatus; error?: string }>;
  retried: boolean;
  flaky: boolean;
  durationMs: number;
  evidencePaths: string[];
  createdAt: string;
}

// ============ P13.17 Precondition ============

export type PreconditionCategory = "ACCOUNT_STATE" | "PRODUCT_STATE" | "PAGE_STATE" | "DATA_STATE" | "SECURITY_STATE";
export type PreconditionDisposition = "already_satisfied" | "can_prepare_safely" | "requires_user" | "requires_high_risk_operation" | "unknown";

// ============ P13.26 Semantic Completeness ============

export type SemanticCompleteness = "FULL" | "PARTIAL" | "SHALLOW" | "MISMATCH";
