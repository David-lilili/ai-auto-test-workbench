/**
 * P11：AI Test Designer 核心类型。
 *
 * 核心流程（deterministic）：
 *   TestDesignInput → Coverage Obligations → Manual Applicability → Scenario Candidates
 *   → Grounding Validator → Duplicate Control → Coverage Matrix → Test Design Readiness
 *
 * 铁律：
 *   - 不直接 Requirement→LLM→Cases；
 *   - 先 deterministic Coverage Obligations（哪些值得测，LLM 不决定）；
 *   - AI 只组合场景；Grounding Validator 校验事实引用；
 *   - 不发明业务规则；AI_INFERENCE → REVIEW_REQUIRED；
 *   - security/high-risk → 标记 review；不生成 locator/DSL；不执行浏览器。
 */

import type { ApprovedRequirementFact, BusinessKnowledge } from "../requirements/knowledge-activation.js";

// ============ P11.7：TestDesignInput ============

export interface TestDesignInput {
  testDesignInputId: string;
  requirementId: string;
  requirementVersion: string;
  requirementSummary: string;
  approvedFacts: ApprovedRequirementFact[];
  acceptanceCriteria: Array<{ acId: string; statement: string; origin: string }>;
  businessRules: Array<{ ruleId: string; statement: string; condition?: string; effect?: string; scope?: string; origin: string }>;
  states: Array<{ entity: string; fromState: string; toState: string; trigger: string; explicitness: string }>;
  transitions: Array<{ entity: string; fromState: string; toState: string; trigger: string }>;
  dependencies: Array<{ sourceConcept: string; relation: string; targetConcept: string }>;
  constraints: Array<{ field: string; operator?: string; value?: string; kind: string }>;
  securityRequirements: Array<{ statement: string; domain: string }>;
  affectedCapabilities: Array<{ capabilityId: string; match: string }>;
  relevantBusinessKnowledgeRefs: string[];
  knownUnknowns: string[];
  resolvedAmbiguities: string[];
  remainingNonBlockingAmbiguities: string[];
  riskSummary: Array<{ domain: string; level: string }>;
  contextFingerprint: string;
  knowledgeSnapshotFingerprint: string;
}

// ============ P11.8-11：Coverage Obligation ============

export type ObligationType =
  | "ACCEPTANCE_CRITERION"
  | "BUSINESS_RULE"
  | "STATE_TRANSITION"
  | "DEPENDENCY"
  | "CONSTRAINT"
  | "SECURITY"
  | "PRECONDITION"
  | "POSTCONDITION"
  | "CAPABILITY"
  | "ERROR_BEHAVIOR";

export type Criticality = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

export interface TestCoverageObligation {
  obligationId: string;
  source: string;           // factId / ruleId / acId
  type: ObligationType;
  subject: string;
  condition?: string;
  expected?: string;
  criticality: Criticality;
  requiredScenarioTypes: ScenarioType[];
  provenance: { sourceId: string; anchor: string };
  isSecurity: boolean;
  manualRuleRefs?: string[];
}

// ============ P11.12：Scenario Type ============

export type ScenarioType =
  | "POSITIVE"
  | "NEGATIVE"
  | "BOUNDARY"
  | "STATE_TRANSITION"
  | "DEPENDENCY"
  | "PERMISSION"
  | "SECURITY"
  | "ERROR_HANDLING"
  | "PERSISTENCE"
  | "RECOVERY"
  | "IDEMPOTENCY"
  | "DATA_VARIATION"
  | "UI_BEHAVIOR";

// ============ P11.14/15/16：Candidate ============

export type SemanticAction =
  | "SUBMIT_WITHDRAWAL"
  | "SET_FIELD"
  | "SELECT_OPTION"
  | "ENABLE_FEATURE"
  | "MODIFY_ADDRESS"
  | "SUBMIT"
  | "VERIFY_STATE"
  | "VERIFY_MESSAGE"
  | "APPLY_FILTER"
  | "RESET_FILTER"
  | "DELETE"
  | "CONFIRM"
  | "VERIFY_RECORD"
  | "VERIFY_CAPABILITY"
  | "LOGIN"
  | "NAVIGATE"
  | "OTHER";

export interface SemanticStep {
  action: SemanticAction;
  target?: string;
  value?: string;
  grounding: GroundingSource;
}

export type GroundingSource =
  | { kind: "KNOWLEDGE"; knowledgeId: string }
  | { kind: "REQUIREMENT"; factId: string }
  | { kind: "MANUAL"; manualRuleId: string }
  | { kind: "TESTING_TECHNIQUE"; note: string };

export interface TestDesignCandidate {
  candidateId: string;
  requirementId: string;
  title: string;
  objective: string;
  scenarioType: ScenarioType;
  preconditions: Array<{ statement: string; grounding: GroundingSource }>;
  semanticActions: SemanticStep[];
  expectedOutcomes: Array<{ statement: string; grounding: GroundingSource }>;
  testDataRequirements: Array<{ dimension: string; value: string }>;
  coveredObligationIds: string[];
  coveredBusinessRuleIds: string[];
  coveredACIds: string[];
  coveredCapabilityIds: string[];
  risk: { designPriority: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW"; executionRisk: "HIGH" | "MEDIUM" | "LOW" };
  knowledgeRefs: string[];
  manualRuleRefs: string[];
  manualVersions: Record<string, string>;
  assumptions: string[];
  origin: "SYSTEMATIC" | "AI_GENERATED" | "MANUAL";
  confidence: "HIGH" | "MEDIUM" | "LOW";
  reviewStatus: "AUTO_REVIEWABLE" | "NEEDS_BUSINESS_REVIEW" | "NEEDS_SECURITY_REVIEW" | "BLOCKED";
  testability: "DESIGN_READY" | "EXECUTION_PATH_KNOWN" | "EXECUTION_PATH_PARTIAL" | "EXECUTION_PATH_UNKNOWN" | "BLOCKED_BY_KNOWLEDGE";
  provenance: Array<{ reason: string; source: string }>;
  status: "DRAFT" | "VALIDATED" | "NEEDS_REVIEW" | "BLOCKED" | "REJECTED";
  semanticKey: string;
  createdAt: string;
}

// ============ P11.22：Duplicate Identity ============

export function testScenarioSemanticKey(c: Pick<TestDesignCandidate, "objective" | "scenarioType" | "coveredObligationIds" | "coveredACIds" | "coveredBusinessRuleIds" | "preconditions" | "expectedOutcomes">): string {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9_\u4e00-\u9fa5]/g, "_");
  const pre = c.preconditions.map((p) => norm(p.statement)).sort().join(",");
  const out = c.expectedOutcomes.map((e) => norm(e.statement)).sort().join(",");
  return [c.scenarioType, c.coveredObligationIds.sort().join("+"), c.coveredACIds.sort().join("+"), c.coveredBusinessRuleIds.sort().join("+"), pre, out].join("|");
}

// ============ P11.44：Review Readiness ============

export function reviewReadinessFor(candidate: Pick<TestDesignCandidate, "risk" | "expectedOutcomes" | "assumptions">): TestDesignCandidate["reviewStatus"] {
  if (candidate.expectedOutcomes.some((e) => e.grounding.kind === "TESTING_TECHNIQUE") && candidate.assumptions.length) return "NEEDS_BUSINESS_REVIEW";
  if (candidate.risk.executionRisk === "HIGH" || candidate.risk.designPriority === "CRITICAL") return "NEEDS_SECURITY_REVIEW";
  return "AUTO_REVIEWABLE";
}

// ============ P11.75：Test Design Readiness ============

export interface TestDesignReadinessResult {
  status: "TEST_DESIGN_READY" | "NEEDS_REVIEW" | "BLOCKED";
  blockingIssues: string[];
  warningIssues: string[];
}

export function testDesignReadiness(input: {
  obligations: TestCoverageObligation[];
  coveredObligationIds: string[];
  unsupportedCritical: number;
  knowledgeGaps: string[];
}): TestDesignReadinessResult {
  const blockingIssues: string[] = [];
  const warningIssues: string[] = [];
  const criticalObls = input.obligations.filter((o) => o.criticality === "CRITICAL");
  const criticalCovered = criticalObls.filter((o) => input.coveredObligationIds.includes(o.obligationId));
  if (criticalCovered.length < criticalObls.length) blockingIssues.push(`critical obligation uncovered: ${criticalObls.filter((o) => !input.coveredObligationIds.includes(o.obligationId)).map((o) => o.obligationId).join(",")}`);
  const secObls = input.obligations.filter((o) => o.isSecurity);
  const secCovered = secObls.filter((o) => input.coveredObligationIds.includes(o.obligationId));
  if (secCovered.length < secObls.length) blockingIssues.push(`security obligation uncovered: ${secObls.filter((o) => !input.coveredObligationIds.includes(o.obligationId)).map((o) => o.obligationId).join(",")}`);
  if (input.unsupportedCritical > 0) blockingIssues.push(`unsupported critical scenarios: ${input.unsupportedCritical}`);
  if (input.knowledgeGaps.some((g) => g.includes("BLOCKING"))) blockingIssues.push("blocking knowledge gap");
  const normalObls = input.obligations.filter((o) => o.criticality !== "CRITICAL");
  const normalCovered = normalObls.filter((o) => input.coveredObligationIds.includes(o.obligationId));
  if (normalObls.length && normalCovered.length / normalObls.length < 0.7) warningIssues.push("normal obligation coverage < 0.7");
  return { status: blockingIssues.length ? "BLOCKED" : warningIssues.length ? "NEEDS_REVIEW" : "TEST_DESIGN_READY", blockingIssues, warningIssues };
}

// ============ P11.76：P12 Handoff ============

export interface TestDesignPackage {
  packageId: string;
  requirement: { requirementId: string; version: string; summary: string };
  candidateRefs: string[];
  coverageMatrix: Array<{ factId: string; type: string; coveredByCandidateIds: string[] }>;
  knowledgeRefs: string[];
  manualRefs: string[];
  risk: Array<{ domain: string; level: string }>;
  testDataRequirements: Array<{ dimension: string; value: string }>;
  executionPathStatus: Array<{ candidateId: string; testability: string }>;
  openReviewItems: Array<{ candidateId: string; reviewStatus: string; reason: string }>;
  contextFingerprint: string;
  knowledgeSnapshotFingerprint: string;
  testDesignManualVersion: string;
  testDesignerPromptVersion: string;
  status: "DRAFT" | "NEEDS_REVIEW" | "TEST_DESIGN_READY";
}

// ============ P11.72/73：Test Data Requirement + Account Profile ============

export interface AccountProfileRequirement {
  dimension: "KYC" | "balance" | "security" | "permission" | "network" | "asset";
  value: string;
}

export function accountProfileFor(text: string): AccountProfileRequirement[] {
  const reqs: AccountProfileRequirement[] = [];
  if (/kyc|实名/.test(text)) reqs.push({ dimension: "KYC", value: "KYC_COMPLETED" });
  if (/2fa|二次验证/.test(text)) reqs.push({ dimension: "security", value: "2FA_ENABLED" });
  if (/白名单/.test(text)) reqs.push({ dimension: "permission", value: "WHITELIST" });
  if (/余额|balance/.test(text)) reqs.push({ dimension: "balance", value: "BALANCE_SUFFICIENT" });
  if (/trc20/.test(text)) reqs.push({ dimension: "network", value: "TRC20" });
  return reqs;
}
