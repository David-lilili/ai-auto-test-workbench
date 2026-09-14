/**
 * P9：Context Intelligence Foundation 共享类型。
 *
 * 目标：把被动文档升级为「可路由、可版本化、可审计的 AI Context System」。
 * 本文件是全部 context 模块的单一类型来源。
 */

export type ContextDocumentStatus = "ACTIVE" | "REFERENCE" | "HISTORICAL" | "DEPRECATED" | "SUPERSEDED";

export type ContextDocumentType =
  | "ARCHITECTURE"
  | "PLAYBOOK"
  | "POLICY"
  | "SCHEMA"
  | "OPERATION_MANUAL"
  | "CURRENT_STATE"
  | "HANDOFF"
  | "BENCHMARK"
  | "PHASE_REPORT"
  | "REFERENCE"
  | "DEVELOPER_GUIDE"
  | "RUNTIME_GUIDE"
  | "LEGACY"
  | "UNKNOWN";

export type ContextScope =
  | "PAGE_MODELING"
  | "DSL"
  | "EXECUTION"
  | "KNOWLEDGE"
  | "BENCHMARK"
  | "REQUIREMENT"
  | "CONTEXT_SYSTEM"
  | "PROJECT"
  | "SECURITY";

export type ContextPriority = 0 | 1 | 2 | 3 | 4 | 5;

export interface ContextDocument {
  documentId: string;
  path: string;
  type: ContextDocumentType;
  version: string;
  status: ContextDocumentStatus;
  priority: ContextPriority;
  scope: ContextScope[];
  sourceOfTruthFor?: string[];
  supersedes?: string[];
  dependsOn?: string[];
  mandatoryFor?: string[];
  optionalFor?: string[];
  conflictsWith?: string[];
  maxContextPriority?: ContextPriority;
  lastReviewedCommit?: string;
  owner?: string;
  summaryPath?: string;
  /** P9.5-12：文档权威级别（PRIMARY/SECONDARY/REFERENCE/HISTORICAL）。 */
  authority?: "PRIMARY" | "SECONDARY" | "REFERENCE" | "HISTORICAL";
}

/** P9.1 注册表文件结构。 */
export interface DocumentRegistryFile {
  version: string;
  documents: ContextDocument[];
}

export interface SourceOfTruthEntry {
  /** 事实域标识，如 page_model_schema / risk_policy / current_phase。 */
  domain: string;
  primary: string[];
  secondary?: string[];
  precedence?: number;
}

export interface SourceOfTruthFile {
  version: string;
  entries: SourceOfTruthEntry[];
}

export type ContextTaskType =
  | "ARCHITECTURE_CHANGE"
  | "PAGE_MODELING"
  | "PAGE_MODEL_DEBUG"
  | "EXPLORATION"
  | "HEURISTIC_CHANGE"
  | "DSL_GENERATION"
  | "DSL_DEBUG"
  | "EXECUTION_DEBUG"
  | "KNOWLEDGE_PROMOTION"
  | "KNOWLEDGE_AUDIT"
  | "BENCHMARK_CHANGE"
  | "BENCHMARK_RUN"
  | "BUG_FIX"
  | "TEST_CREATION"
  | "REFACTOR"
  | "DOCUMENTATION"
  | "RELEASE"
  | "REQUIREMENT_ANALYSIS"
  | "TEST_DESIGN"
  | "UNKNOWN";

export interface TaskProfile {
  taskType: ContextTaskType;
  required: string[];          // documentIds
  optional: string[];
  excludeByDefault: string[];  // documentIds / group
  requiredCurrentState?: string[];
  requiredSafetyPolicies?: string[];
  relevantTests?: string[];
  recommendedCommands?: string[];
  requiredSourceOfTruth?: string[];
  /** P9.5-7/8：critical mandatory documentIds（缺失=CRITICAL）。 */
  critical?: string[];
  /** P9.5-14：决策覆盖——该任务必须加载的 ADR。 */
  requiredDecisions?: string[];
}

export interface TaskProfileFile {
  version: string;
  profiles: TaskProfile[];
}

export interface CurrentProjectState {
  project: string;
  currentPhase: string;
  completedPhases: string[];
  currentGoal: string;
  architectureInvariants: string[];
  currentFocus: string[];
  knownIssues: string[];
  doNotTouchWithoutReview: string[];
  latestBenchmark?: string;
  latestHandoff?: string;
  importantCommands: string[];
  updatedAt: string;
  sourceCommit: string;
}

export interface ArchitectureDecision {
  decisionId: string;
  title: string;
  status: "ACCEPTED" | "REJECTED" | "SUPERSEDED" | "PROPOSED";
  date: string;
  decision: string;
  reason: string;
  alternativesRejected?: string[];
  affectedModules?: string[];
  supersededBy?: string;
}

export interface Handoff {
  phase: string;
  status: string;
  goal: string;
  completed: string[];
  architectureChanges: string[];
  newModules: string[];
  importantFiles: string[];
  metrics?: Record<string, unknown>;
  bugsFixed: string[];
  knownIssues: string[];
  risks: string[];
  invariants: string[];
  doNotRepeat: string[];
  recommendedNextStep: string;
  latestCommit: string;
  testStatus: string;
  generatedAt: string;
}

export type ContextInclusionLevel = "MANDATORY" | "RECOMMENDED" | "OPTIONAL" | "EXCLUDED";

export type ContextLoadLayer = "L0_BOOTSTRAP" | "L1_REQUIRED" | "L2_ON_DEMAND";

export interface ContextRequirement {
  documentId: string;
  level: ContextInclusionLevel;
  loadLayer: ContextLoadLayer;
  whyIncluded: string;
  provenance: { reason: string; task: string; authority: string };
  sourceOfTruth?: string[];
  sizeBytes?: number;
  estimatedTokens?: number;
}

export interface ContextPack {
  packId: string;
  taskId: string;
  taskType: ContextTaskType;
  createdAt: string;
  sourceCommit: string;
  currentPhase: string;
  mandatorySources: string[];
  recommendedSources: string[];
  optionalSources: string[];
  sourceOfTruth: string[];
  decisions: string[];
  currentState?: CurrentProjectState;
  relevantReports: string[];
  excludedSources: string[];
  warnings: string[];
  budget: { bootstrapBytes: number; requiredBytes: number; recommendedBytes: number; estimatedTokens: number; budgetExceeded: boolean; trimmedSources: string[] };
  coverage: { contextRecall: number; contextPrecision: number; mandatoryMisses: string[]; irrelevantSources: string[]; staleSources: string[]; conflictSources: string[] };
  fingerprint: string;
}

export type FreshnessStatus = "FRESH" | "CHANGED_SINCE_REVIEW" | "STALE" | "SUPERSEDED" | "MISSING";

export interface ContextFreshness {
  documentId: string;
  contentHash: string;
  gitCommit?: string;
  lastReviewedCommit?: string;
  status: FreshnessStatus;
}

export interface ContextGoldTask {
  id: string;
  taskType: ContextTaskType;
  description: string;
  mustKnow: string[];
  useful: string[];
  irrelevant: string[];
  dangerousToMiss: string[];
}

/** P9.5-7/8：Mandatory Context Severity。 */
export type MandatorySeverity = "CRITICAL" | "HIGH" | "NORMAL";

/** P9.5-4：分类置信度。 */
export type ClassificationConfidence = "HIGH" | "MEDIUM" | "LOW" | "AMBIGUOUS";

export interface ClassifiedTask {
  primaryTask: ContextTaskType;
  secondaryTasks: ContextTaskType[];
  confidence: ClassificationConfidence;
  numericScore: number;
  signals: string[];
  ambiguous?: boolean;
  needsReview?: boolean;
}

/** P9.5-12：Document Authority Levels。 */
export type DocumentAuthority = "PRIMARY" | "SECONDARY" | "REFERENCE" | "HISTORICAL";

/** P9.5-24：两段式 Context Pack。 */
export interface ContextPackIndex {
  packId: string;
  taskType: string;
  currentPhase: string;
  invariants: string[];
  mustRead: string[];
  warnings: string[];
  sourceCommit: string;
  fingerprint: string;
}

/** P9.5-21：Context Minimality。 */
export interface MinimalityScore {
  requiredUsefulTokens: number;
  totalPackTokens: number;
  score: number; // requiredUseful / total（越高越 minimal）
}
