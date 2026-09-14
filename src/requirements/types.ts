/**
 * P10：Requirement Intelligence 共享类型（单一事实源）。
 *
 * 核心边界（P10 原则）：
 *   - 原始需求 immutable，后续模型引用 sourceId；
 *   - AI 提取的事实必须有 provenance；AI 推断 ≠ 产品事实；
 *   - 不允许推断直接升级为 VERIFIED Business Knowledge；
 *   - Requirement / Inference / Existing Knowledge 严格区分；
 *   - 不生成 locator/DSL/测试 case，不执行浏览器。
 */

export type RequirementSourceType = "PLAIN_TEXT" | "MARKDOWN" | "DOCX" | "PDF" | "API_DOC" | "TICKET" | "CONFLUENCE" | "CHAT" | "OTHER";

export type RequirementOrigin = "EXPLICIT_REQUIREMENT" | "EXISTING_KNOWLEDGE" | "AI_INFERENCE" | "HUMAN_CONFIRMED";

export type RequirementStatus = "RAW" | "PARSED" | "ANALYZED" | "NEEDS_REVIEW" | "APPROVED" | "REJECTED" | "SUPERSEDED";

export type BusinessRuleStatus = "EXTRACTED" | "INFERRED" | "CONFIRMED" | "CONFLICTED" | "REJECTED";

export type ConfidenceLevel = "HIGH" | "MEDIUM" | "LOW";

export type KnowledgeMatchStatus = "KNOWN" | "PARTIAL" | "UNKNOWN";

export type AmbiguityType =
  | "SCOPE_AMBIGUITY"
  | "VALUE_AMBIGUITY"
  | "STATE_AMBIGUITY"
  | "ACTOR_AMBIGUITY"
  | "ERROR_BEHAVIOR_AMBIGUITY"
  | "SECURITY_AMBIGUITY"
  | "DEPENDENCY_AMBIGUITY"
  | "LIFECYCLE_AMBIGUITY";

export type OpenQuestionPriority = "BLOCKING" | "IMPORTANT" | "OPTIONAL";

export type BusinessChangeType =
  | "ADD"
  | "MODIFY"
  | "REMOVE"
  | "RESTRICT"
  | "RELAX"
  | "DEPENDENCY_CHANGE"
  | "STATE_CHANGE"
  | "VALIDATION_CHANGE"
  | "SECURITY_CHANGE"
  | "UI_CHANGE"
  | "BACKEND_BEHAVIOR_CHANGE";

export type RiskLevel = "LOW" | "MEDIUM" | "HIGH";

/** P10.2：RequirementSource（原始需求，immutable）。 */
export interface RequirementSource {
  sourceId: string;
  sourceType: RequirementSourceType;
  title: string;
  rawContent: string;
  sourcePath?: string;
  externalReference?: string;
  language: "zh" | "en" | "mixed";
  createdAt: string;
  receivedAt: string;
  contentHash: string;
  version: string;
  metadata: Record<string, unknown>;
}

/** P10.4：Provenance（每个提取事实的来源）。 */
export interface FactProvenance {
  sourceId: string;
  quoteOrAnchor: string;
  section?: string;
  sourceType: RequirementSourceType;
  /** origin 必须显式：EXPLICIT_REQUIREMENT vs AI_INFERENCE vs EXISTING_KNOWLEDGE vs HUMAN_CONFIRMED。 */
  origin: RequirementOrigin;
}

export interface EvidenceRef {
  evidenceId: string;
  sourceId: string;
  kind: "quote" | "knowledge" | "human_review" | "analysis";
  detail: string;
  origin: RequirementOrigin;
}

/** P10.14/15：Business Rule（IF-THEN 结构化 + raw statement）。 */
export interface BusinessRule {
  ruleId: string;
  statement: string;
  condition?: string;
  effect?: string;
  scope?: string;
  relation?: "IF_THEN" | "WHEN_REQUIRES" | "INVALIDATES" | "FORBIDS" | "ALLOWS" | "DEFAULTS_TO";
  status: BusinessRuleStatus;
  provenance: FactProvenance;
  origin: RequirementOrigin;
  confidence: ConfidenceLevel;
  affectedDomains?: string[];
}

export type AcceptanceCriterionKind = "EXPLICIT_AC" | "DERIVED_AC";

export interface AcceptanceCriterion {
  acId: string;
  kind: AcceptanceCriterionKind;
  statement: string;
  gwt?: { given?: string; when?: string; then?: string };
  provenance: FactProvenance;
  origin: RequirementOrigin;
  confidence: ConfidenceLevel;
}

export interface Actor {
  actorId: string;
  name: string;
  canonicalName?: string;
  role?: "USER" | "ADMIN" | "SYSTEM" | "PROVIDER" | "BACKEND" | "EXTERNAL_SERVICE";
  origin: RequirementOrigin;
  provenance: FactProvenance;
}

export interface BusinessChange {
  changeId: string;
  type: BusinessChangeType;
  before?: string;
  after?: string;
  affectedEntity: string;
  evidence: string;
  origin: RequirementOrigin;
  provenance: FactProvenance;
  confidence: ConfidenceLevel;
}

export interface StateTransition {
  stateId: string;
  entity: string;
  fromState: string;
  toState: string;
  trigger: string;
  explicitness: "EXPLICIT" | "INFERRED";
  provenance: FactProvenance;
  origin: RequirementOrigin;
}

export interface Precondition {
  preconditionId: string;
  statement: string;
  source: "REQUIREMENT_EXPLICIT" | "BUSINESS_KNOWLEDGE_EXISTING" | "AI_ASSUMPTION";
  provenance: FactProvenance;
}

export interface Constraint {
  constraintId: string;
  field: string;
  operator?: string;
  value?: string;
  kind: "amount" | "time" | "role" | "country" | "network" | "currency" | "account_state" | "kyc" | "security" | "other";
  provenance: FactProvenance;
  origin: RequirementOrigin;
}

export interface RiskItem {
  riskId: string;
  domain: string;
  description: string;
  level: RiskLevel;
  provenance: FactProvenance;
  origin: RequirementOrigin;
}

export interface Dependency {
  dependencyId: string;
  sourceConcept: string;
  relation: "INVALIDATES" | "ENABLES" | "REQUIRES" | "AFFECTS";
  targetConcept: string;
  provenance: FactProvenance;
}

export interface Ambiguity {
  ambiguityId: string;
  type: AmbiguityType;
  question: string;
  context: string;
  status: "OPEN" | "RESOLVED";
  resolution?: string;
  resolvedByReview?: string;
}

export interface Assumption {
  assumptionId: string;
  statement: string;
  status: "UNCONFIRMED" | "CONFIRMED" | "REJECTED";
  affects: string[]; // ruleId/acId
  provenance: FactProvenance;
}

export interface OpenQuestion {
  questionId: string;
  question: string;
  priority: OpenQuestionPriority;
  ambiguityId?: string;
}

/** P10.8：LLM / deterministic analyzer 输出 Draft。 */
export interface RequirementAnalysisDraft {
  summary: string;
  actors: Array<{ name: string; sourceAnchor: string; confidence: ConfidenceLevel; origin: RequirementOrigin }>;
  changes: Array<{ type: BusinessChangeType; before?: string; after?: string; affectedEntity: string; sourceAnchor: string; confidence: ConfidenceLevel; origin: RequirementOrigin }>;
  acceptanceCriteria: Array<{ statement: string; kind: AcceptanceCriterionKind; sourceAnchor: string; confidence: ConfidenceLevel; origin: RequirementOrigin }>;
  businessRules: Array<{ statement: string; condition?: string; effect?: string; scope?: string; sourceAnchor: string; confidence: ConfidenceLevel; origin: RequirementOrigin }>;
  preconditions: Array<{ statement: string; sourceAnchor: string; source: "REQUIREMENT_EXPLICIT" | "BUSINESS_KNOWLEDGE_EXISTING" | "AI_ASSUMPTION" }>;
  states: Array<{ entity: string; fromState: string; toState: string; trigger: string; explicitness: "EXPLICIT" | "INFERRED"; sourceAnchor: string }>;
  constraints: Array<{ field: string; operator?: string; value?: string; kind: Constraint["kind"]; sourceAnchor: string; origin: RequirementOrigin }>;
  dependencies: Array<{ sourceConcept: string; relation: Dependency["relation"]; targetConcept: string; sourceAnchor: string }>;
  risks: Array<{ domain: string; description: string; level: RiskLevel; sourceAnchor: string }>;
  ambiguities: Array<{ type: AmbiguityType; question: string; context: string; sourceAnchor: string }>;
  assumptions: Array<{ statement: string; sourceAnchor: string }>;
  affectedDomains: string[];
}

/** P10.3：RequirementModel（完整分析结果）。 */
export interface RequirementModel {
  requirementId: string;
  sourceId: string;
  title: string;
  summary: string;
  status: RequirementStatus;
  version: string;
  supersedes?: string;
  supersededBy?: string;
  actors: Actor[];
  businessChanges: BusinessChange[];
  acceptanceCriteria: AcceptanceCriterion[];
  businessRules: BusinessRule[];
  preconditions: Precondition[];
  postconditions: Array<{ statement: string; provenance: FactProvenance; origin: RequirementOrigin }>;
  states: StateTransition[];
  constraints: Constraint[];
  dependencies: Dependency[];
  exceptions: Array<{ statement: string; provenance: FactProvenance }>;
  risks: RiskItem[];
  affectedDomains: string[];
  affectedCapabilities: Array<{ capabilityId: string; match: "MATCHED" | "POSSIBLE" | "NEW_CAPABILITY"; confidence: ConfidenceLevel }>;
  dataEntities: Array<{ name: string; origin: RequirementOrigin }>;
  securityImplications: Array<{ area: string; description: string; riskLevel: RiskLevel }>;
  unknowns: string[];
  ambiguities: Ambiguity[];
  assumptions: Assumption[];
  openQuestions: OpenQuestion[];
  evidence: EvidenceRef[];
  confidence: ConfidenceLevel;
  contextReceipt?: {
    taskType: string;
    contextFingerprint: string;
    mandatoryDocs: string[];
    businessDomains: string[];
    currentPhase: string;
    riskPolicyVersion?: string;
    operationManualVersion?: string;
  };
  promptVersion?: string;
  createdAt: string;
  updatedAt: string;
}

/** P10.26：Requirement Diff。 */
export interface RequirementDiff {
  addedRules: Array<{ ruleId: string; statement: string }>;
  removedRules: Array<{ ruleId: string; statement: string }>;
  changedRules: Array<{ ruleId: string; before: string; after: string }>;
  newAC: Array<{ acId: string; statement: string }>;
  removedAC: Array<{ acId: string; statement: string }>;
  newAmbiguities: Array<{ ambiguityId: string; question: string }>;
  resolvedAmbiguities: Array<{ ambiguityId: string; question: string; resolution: string }>;
  actorChanges: Array<{ actor: string; before?: string; after?: string }>;
}

/** P10.30：Review。 */
export interface RequirementReview {
  reviewId: string;
  requirementId: string;
  reviewer: string;
  decision: "APPROVE" | "EDIT" | "REJECT";
  reason: string;
  timestamp: string;
  target?: "requirement" | "business_rule" | "acceptance_criterion" | "assumption" | "ambiguity";
  targetId?: string;
  before?: unknown;
  after?: unknown;
}

/** P10.29：Business Knowledge Proposal。 */
export interface BusinessKnowledgeProposal {
  proposalId: string;
  knowledgeType: "BUSINESS_RULE" | "ACCEPTANCE_CRITERION" | "CONSTRAINT" | "STATE_TRANSITION" | "DEPENDENCY";
  source: string; // requirementId
  rule?: BusinessRule;
  ac?: AcceptanceCriterion;
  constraint?: Constraint;
  state?: StateTransition;
  dependency?: Dependency;
  status: "REVIEW" | "APPROVED" | "REJECTED";
  origin: RequirementOrigin;
  contextFingerprint?: string;
  createdAt: string;
}

/** P10.33/34：Test-Design Readiness。 */
export type ReadinessStatus = "READY_FOR_TEST_DESIGN" | "NEEDS_REVIEW" | "BLOCKED";

export interface TestDesignReadiness {
  status: ReadinessStatus;
  blockingIssues: string[];
  warningIssues: string[];
  diagnostics: Array<{ code: string; detail: string; severity: "CRITICAL" | "WARNING" }>;
}

/** P10.57：Business Knowledge Boundary。 */
export type KnowledgeBoundary =
  | "SOURCE_EXPLICIT"
  | "CONTEXT_SUPPORTED"
  | "REASONABLE_INFERENCE"
  | "UNSUPPORTED"
  | "NEEDS_HUMAN";

export function boundaryFor(origin: RequirementOrigin, contextSupported: boolean, conflict: boolean): KnowledgeBoundary {
  if (origin === "HUMAN_CONFIRMED") return "SOURCE_EXPLICIT";
  if (origin === "EXPLICIT_REQUIREMENT") return "SOURCE_EXPLICIT";
  if (origin === "EXISTING_KNOWLEDGE") return "CONTEXT_SUPPORTED";
  if (origin === "AI_INFERENCE") {
    if (conflict) return "UNSUPPORTED";
    if (contextSupported) return "REASONABLE_INFERENCE";
    return "NEEDS_HUMAN";
  }
  return "NEEDS_HUMAN";
}
