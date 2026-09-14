import type { ContextDocument, ContextPack, DocumentRegistryFile, TaskProfileFile } from "./types.js";
import { resolveContextRequirements } from "./task-context.js";

/**
 * P9.20-24：Context Coverage Metrics + Gold Dataset + Severity + Quality Gate。
 *
 * - Context Recall：pack 覆盖 mandatory gold 的比例。
 * - Context Precision：pack 中「相关」的比例（irrelevant sources 越低越好）。
 * - Missing Context Severity：CRITICAL / HIGH / MEDIUM / LOW。
 * - Quality Gate：BLOCK（CRITICAL mandatory missing / conflicting primary SoT / CURRENT_STATE missing / invalid profile / dependency cycle）、
 *   WARNING（stale recommended / budget exceeded / low precision）、PASS。
 */

export type MissingSeverity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

export interface GoldTaskContext {
  taskId: string;
  taskType: string;
  description: string;
  mustKnow: string[];        // mandatory gold documentIds
  useful: string[];          // recommended gold
  irrelevant: string[];      // should NOT be loaded
  dangerousToMiss: string[]; // CRITICAL if missing
}

/** 单个 documentId 缺失的严重度。 */
export function missingSeverity(gold: GoldTaskContext, missingId: string): MissingSeverity {
  if (gold.dangerousToMiss.includes(missingId)) return "CRITICAL";
  if (gold.mustKnow.includes(missingId)) return "HIGH";
  if (gold.useful.includes(missingId)) return "MEDIUM";
  return "LOW";
}

/** P9.20：Context Recall（pack 覆盖 gold mustKnow 的比例）。 */
export function contextRecall(pack: ContextPack, gold: GoldTaskContext): { recall: number; misses: string[] } {
  const loaded = new Set([...pack.mandatorySources, ...pack.recommendedSources, ...pack.optionalSources]);
  const misses = gold.mustKnow.filter((id) => !loaded.has(id));
  return { recall: gold.mustKnow.length ? (gold.mustKnow.length - misses.length) / gold.mustKnow.length : 1, misses };
}

/** P9.20：Context Precision（pack 中不相关来源的比例）。 */
export function contextPrecision(pack: ContextPack, gold: GoldTaskContext): { precision: number; irrelevant: string[] } {
  const loaded = [...pack.mandatorySources, ...pack.recommendedSources, ...pack.optionalSources];
  const relevant = new Set([...gold.mustKnow, ...gold.useful]);
  const irrelevant = loaded.filter((id) => !relevant.has(id));
  return { precision: loaded.length ? (loaded.length - irrelevant.length) / loaded.length : 1, irrelevant };
}

/** P9.23：aggregate missing severity 列表。 */
export function missingContextSeverities(pack: ContextPack, gold: GoldTaskContext): Array<{ documentId: string; severity: MissingSeverity }> {
  const loaded = new Set([...pack.mandatorySources, ...pack.recommendedSources, ...pack.optionalSources]);
  return [...new Set([...gold.mustKnow, ...gold.useful, ...gold.dangerousToMiss])]
    .filter((id) => !loaded.has(id))
    .map((id) => ({ documentId: id, severity: missingSeverity(gold, id) }));
}

export interface QualityGateInput {
  pack: ContextPack;
  gold?: GoldTaskContext;
  registry: DocumentRegistryFile;
  profiles: TaskProfileFile;
  currentStateMissing: boolean;
  conflictingSourceOfTruth: string[];
  dependencyCycles: string[];
}

export type GateStatus = "BLOCKED" | "WARNING" | "PASS";

export interface QualityGateResult {
  status: GateStatus;
  blockingIssues: string[];
  warningIssues: string[];
}

/** P9.24：Context Quality Gate。 */
export function runContextQualityGate(input: QualityGateInput): QualityGateResult {
  const blockingIssues: string[] = [];
  const warningIssues: string[] = [];
  const loaded = new Set([...input.pack.mandatorySources, ...input.pack.recommendedSources, ...input.pack.optionalSources]);

  // BLOCK：CRITICAL mandatory missing
  if (input.gold) {
    const critical = missingContextSeverities(input.pack, input.gold).filter((m) => m.severity === "CRITICAL");
    for (const c of critical) blockingIssues.push(`CRITICAL missing: ${c.documentId}`);
    const high = missingContextSeverities(input.pack, input.gold).filter((m) => m.severity === "HIGH");
    for (const h of high) blockingIssues.push(`HIGH missing: ${h.documentId}`);
  }
  if (input.currentStateMissing) blockingIssues.push("CURRENT_STATE missing");
  if (input.conflictingSourceOfTruth.length) blockingIssues.push(`conflicting source-of-truth: ${input.conflictingSourceOfTruth.join(", ")}`);
  if (input.dependencyCycles.length) blockingIssues.push(`dependency cycle: ${input.dependencyCycles.join("; ")}`);
  const profile = input.profiles.profiles.find((p) => p.taskType === input.pack.taskType);
  if (!profile) blockingIssues.push(`invalid task profile: ${input.pack.taskType}`);

  // WARNING：stale / budget / low precision / historical loaded
  if (input.pack.budget.budgetExceeded) warningIssues.push("context budget exceeded");
  if (input.pack.coverage.staleSources.length) warningIssues.push(`stale sources: ${input.pack.coverage.staleSources.join(", ")}`);
  if (input.gold) {
    const { precision } = contextPrecision(input.pack, input.gold);
    if (precision < 0.5) warningIssues.push(`low context precision: ${precision.toFixed(2)}`);
  }
  if (input.pack.coverage.irrelevantSources.length) warningIssues.push(`historical sources loaded unnecessarily: ${input.pack.coverage.irrelevantSources.slice(0, 3).join(", ")}`);

  const status: GateStatus = blockingIssues.length ? "BLOCKED" : warningIssues.length ? "WARNING" : "PASS";
  return { status, blockingIssues, warningIssues };
}

/** P9.21：Context Gold Dataset（真实历史任务，10 个）。 */
export const GOLD_TASK_DATASET: GoldTaskContext[] = [
  { taskId: "gold_1", taskType: "PAGE_MODEL_DEBUG", description: "page identity duplicate bug", mustKnow: ["PAGE_MODEL_SCHEMA", "PAGE_MODEL_MODELING_PLAYBOOK", "CURRENT_PROJECT_STATE", "ARCHITECTURE_DECISIONS"], useful: ["RISK_POLICY", "KNOWLEDGE_PROMOTION_POLICY"], irrelevant: ["P3_PHASE_REPORT", "P6_BENCHMARK_HISTORICAL"], dangerousToMiss: ["RISK_POLICY", "CURRENT_PROJECT_STATE"] },
  { taskId: "gold_2", taskType: "PAGE_MODEL_DEBUG", description: "dropdown option pollution", mustKnow: ["PAGE_MODEL_SCHEMA", "PAGE_MODEL_MODELING_PLAYBOOK", "KNOWLEDGE_PROMOTION_POLICY", "CURRENT_PROJECT_STATE"], useful: ["MODELING_BENCHMARK_LATEST"], irrelevant: ["P2_PHASE_REPORT", "P4_PHASE_REPORT"], dangerousToMiss: ["KNOWLEDGE_PROMOTION_POLICY"] },
  { taskId: "gold_3", taskType: "PAGE_MODEL_DEBUG", description: "assertion nav noise", mustKnow: ["PAGE_MODEL_SCHEMA", "PAGE_MODEL_MODELING_PLAYBOOK", "KNOWLEDGE_PROMOTION_POLICY"], useful: ["OPERATION_MANUAL"], irrelevant: ["P5_PHASE_REPORT", "P1_PHASE_REPORT"], dangerousToMiss: ["KNOWLEDGE_PROMOTION_POLICY"] },
  { taskId: "gold_4", taskType: "DSL_DEBUG", description: "DSL PARTIAL debugging", mustKnow: ["DSL_ARCHITECTURE", "PAGE_MODEL_SCHEMA", "CURRENT_PROJECT_STATE", "OPERATION_MANUAL"], useful: ["MODELING_BENCHMARK_LATEST"], irrelevant: ["P7_PHASE_REPORT", "P8_PHASE_REPORT"], dangerousToMiss: ["CURRENT_PROJECT_STATE"] },
  { taskId: "gold_5", taskType: "KNOWLEDGE_PROMOTION", description: "promotion fan-out bug", mustKnow: ["KNOWLEDGE_PROMOTION_POLICY", "EVIDENCE_MODEL", "RISK_POLICY", "CURRENT_PROJECT_STATE"], useful: ["PAGE_MODEL_SCHEMA"], irrelevant: ["P3_PHASE_REPORT"], dangerousToMiss: ["RISK_POLICY", "KNOWLEDGE_PROMOTION_POLICY"] },
  { taskId: "gold_6", taskType: "EXECUTION_DEBUG", description: "risk gate bug", mustKnow: ["RISK_POLICY", "CURRENT_PROJECT_STATE", "ARCHITECTURE_DECISIONS"], useful: ["DSL_ARCHITECTURE"], irrelevant: ["P1_PHASE_REPORT", "P2_PHASE_REPORT"], dangerousToMiss: ["RISK_POLICY"] },
  { taskId: "gold_7", taskType: "BENCHMARK_CHANGE", description: "modeling benchmark metric bug", mustKnow: ["MODELING_BENCHMARK_CONTRACT", "MODELING_BENCHMARK_LATEST", "CURRENT_PROJECT_STATE"], useful: ["PAGE_MODEL_SCHEMA"], irrelevant: ["P4_PHASE_REPORT"], dangerousToMiss: ["MODELING_BENCHMARK_CONTRACT"] },
  { taskId: "gold_8", taskType: "PAGE_MODELING", description: "result region writeback", mustKnow: ["PAGE_MODEL_SCHEMA", "PAGE_MODEL_MODELING_PLAYBOOK", "KNOWLEDGE_PROMOTION_POLICY", "CURRENT_PROJECT_STATE"], useful: ["OPERATION_MANUAL"], irrelevant: ["P5_PHASE_REPORT"], dangerousToMiss: ["KNOWLEDGE_PROMOTION_POLICY"] },
  { taskId: "gold_9", taskType: "EXECUTION_DEBUG", description: "self-healing evidence sink bug", mustKnow: ["KNOWLEDGE_PROMOTION_POLICY", "EVIDENCE_MODEL", "CURRENT_PROJECT_STATE"], useful: ["DSL_ARCHITECTURE"], irrelevant: ["P6_PHASE_REPORT"], dangerousToMiss: ["EVIDENCE_MODEL"] },
  { taskId: "gold_10", taskType: "PAGE_MODELING", description: "form modeling gap (withdraw)", mustKnow: ["PAGE_MODEL_SCHEMA", "PAGE_MODEL_MODELING_PLAYBOOK", "OPERATION_MANUAL", "CURRENT_PROJECT_STATE"], useful: ["KNOWLEDGE_PROMOTION_POLICY"], irrelevant: ["P8_PHASE_REPORT"], dangerousToMiss: ["OPERATION_MANUAL", "CURRENT_PROJECT_STATE"] }
];
