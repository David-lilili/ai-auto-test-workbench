/**
 * P12 TestAsset 核心类型。
 *
 * TestAsset = 长期、可版本化、可追溯的测试意图资产。
 * 绝不包含：locator / selector / xpath / css / Playwright API / DSL steps。
 */

// ============ Status Lifecycle（P12.3） ============

export type TestAssetStatus =
  | "DRAFT"
  | "IN_REVIEW"
  | "APPROVED"
  | "ACTIVE"
  | "BLOCKED"
  | "DEPRECATED"
  | "SUPERSEDED"
  | "REJECTED";

export type AssetFreshness = "FRESH" | "POSSIBLY_STALE" | "STALE" | "INVALID";
export type ExecutionFreshness = "FRESH" | "STALE" | "UNKNOWN";

export type CreationMode = "SYSTEMATIC_BASELINE" | "SYSTEMATIC_PLUS_AI";

// ============ Review（P12.6/7） ============

export type ReviewDecision =
  | "APPROVE"
  | "EDIT_AND_APPROVE"
  | "REJECT"
  | "BLOCK"
  | "REQUEST_CLARIFICATION"
  | "MERGE_WITH_EXISTING";

export type ReviewableField = "precondition" | "semanticAction" | "expectedOutcome" | "testDataRequirement" | "title" | "objective";

export interface ReviewRecord {
  reviewId: string;
  assetId: string;
  assetVersion: string;
  decision: ReviewDecision;
  reviewer: string;
  timestamp: string;
  reason: string;
  reviewedFields?: ReviewableField[];
  before?: unknown;
  after?: unknown;
  contextFingerprint?: string;
  requirementVersion?: string;
  knowledgeFingerprint?: string;
  manualVersions?: Record<string, string>;
  candidateHash?: string;
  mergeWithAssetId?: string;
}

// ============ Test Data（P12.20/21/22） ============

export interface TestDataRequirement {
  dimension: "actor" | "kyc" | "balance" | "address" | "network" | "permission" | "security" | "asset" | "amount" | "other";
  value: string;
  resolved: boolean;
  note?: string;
}

export type TestDataResolution = "RESOLVED" | "TEST_DATA_UNRESOLVED";

// ============ Execution Path（P12.17/18） ============

export type ExecutionPathStatus = "KNOWN" | "PARTIAL" | "UNKNOWN";
export type SemanticActionMapping = "MAPPED" | "PARTIAL" | "UNMAPPED";

export interface TestExecutionPath {
  status: ExecutionPathStatus;
  capabilities: string[];
  pages: string[];
  semanticActions: Array<{ action: string; mapping: SemanticActionMapping }>;
}

// ============ TestAsset（P12.2） ============

export interface TestAsset {
  testAssetId: string;
  title: string;
  objective: string;
  description?: string;

  requirementRefs: string[];
  businessRuleRefs: string[];
  acceptanceCriterionRefs: string[];
  capabilityRefs: string[];

  scenarioType: string;
  preconditions: Array<{ statement: string; groundingKind: string; factId?: string; knowledgeId?: string }>;
  semanticActions: Array<{ action: string; target: string; groundingKind: string; factId?: string }>;
  expectedOutcomes: Array<{ statement: string; groundingKind: string; factId?: string; knowledgeId?: string }>;
  testDataRequirements: TestDataRequirement[];
  accountProfileRequirements: Array<{ dimension: string; value: string }>;

  risk: { designPriority: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW"; executionRisk: "HIGH" | "MEDIUM" | "LOW" | "FORBIDDEN" };

  manualRuleRefs: string[];
  knowledgeRefs: string[];
  coverageObligationRefs: string[];

  executionPath: TestExecutionPath;

  status: TestAssetStatus;
  version: string;
  createdAt: string;
  updatedAt: string;
  createdFromCandidateId?: string;

  /** P12.8：human 拥有最高优先级，AI 重新生成不得覆盖。 */
  humanAuthoredFields: ReviewableField[];

  reviewHistory: ReviewRecord[];
  provenance: Array<{ reason: string; source: string }>;
  creationMode: CreationMode;
  contextFingerprint?: string;
  designerVersion?: string;

  /** P12.71：完整性指纹，silent mutation 检测。 */
  contentFingerprint: string;

  assetFreshness: AssetFreshness;
  executionFreshness: ExecutionFreshness;
}

// ============ Candidate Eligibility（P12.4） ============

export type CandidateEligibilityStatus = "ELIGIBLE" | "REVIEW_REQUIRED" | "BLOCKED" | "REJECT";

export interface CandidateEligibility {
  status: CandidateEligibilityStatus;
  reasons: string[];
  securityReviewRequired: boolean;
  highRisk: boolean;
  batchReviewEligible: boolean;
}

// ============ Candidate match（P12.12） ============

export type CandidateMatchKind = "NEW" | "SAME" | "POSSIBLE_UPDATE" | "DUPLICATE" | "CONFLICT";

// ============ Requirement V2 preview（P12.33） ============

export type RequirementChangeKind = "UNCHANGED" | "POSSIBLE_UPDATE" | "NEW" | "POSSIBLE_REMOVE";

// ============ Store file（P12.28） ============

export interface TestAssetStoreFile {
  schemaVersion: "test-assets.v1";
  assets: TestAsset[];
  versionSequence: Record<string, number>;
  updatedAt: string;
}

export interface RelationshipIndex {
  byRequirement: Record<string, string[]>;
  byCapability: Record<string, string[]>;
  byBusinessRule: Record<string, string[]>;
  byPage: Record<string, string[]>;
  byStatus: Record<string, string[]>;
  byRisk: Record<string, string[]>;
  byScenarioType: Record<string, string[]>;
}

// ============ Execution Preparation Package（P12.66） ============

export interface ExecutionPreparationPackage {
  packageId: string;
  asset: TestAsset;
  semanticActions: TestAsset["semanticActions"];
  expectedOutcomes: TestAsset["expectedOutcomes"];
  requiredCapabilities: string[];
  pageRefs: string[];
  testDataRequirements: TestDataRequirement[];
  accountProfileRequirements: TestAsset["accountProfileRequirements"];
  executionRisk: TestAsset["risk"]["executionRisk"];
  knowledgeRefs: string[];
  contextFingerprint?: string;
  executionPath: TestExecutionPath;
}
