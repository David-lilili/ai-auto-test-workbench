import type { ContextDocument, ContextTaskType, DocumentRegistryFile, MandatorySeverity, TaskProfile, TaskProfileFile } from "./types.js";
import { classifyContextTask } from "./task-context.js";

/**
 * P9.5-5/6：Task Composition Policy。
 *
 * composeTaskProfiles(primary, secondaries)：
 *   - REQUIRED > RECOMMENDED > OPTIONAL > EXCLUDED
 *   - SAFETY REQUIRED（critical）永远胜出，即使被另一 profile EXCLUDED
 *   - required 去重、excluded 与 required 冲突报告、budget 记录
 *
 * P9.5-7/8：Critical Context Contract + Mandatory Severity。
 *   - critical（CRITICAL）/ high / normal 分层 recall
 */

export interface ComposedProfile {
  taskTypes: ContextTaskType[];
  required: string[];
  optional: string[];
  excluded: string[];
  critical: string[];
  requiredDecisions: string[];
  conflicts: Array<{ documentId: string; reason: string; winner: "REQUIRED" | "EXCLUDED" | "SAFETY_REQUIRED" }>;
  requiredSafetyPolicies: string[];
}

/** 合并多 task profiles（primary + secondary）。 */
export function composeTaskProfiles(profiles: TaskProfileFile, primary: ContextTaskType, secondaries: ContextTaskType[]): ComposedProfile {
  const profileList = [primary, ...secondaries]
    .map((t) => profiles.profiles.find((p) => p.taskType === t))
    .filter((p): p is TaskProfile => Boolean(p));
  const composed: ComposedProfile = { taskTypes: [primary, ...secondaries], required: [], optional: [], excluded: [], critical: [], requiredDecisions: [], conflicts: [], requiredSafetyPolicies: [] };

  for (const p of profileList) {
    for (const id of p.required ?? []) {
      if (!composed.required.includes(id)) composed.required.push(id);
    }
    for (const id of p.critical ?? []) {
      if (!composed.critical.includes(id)) composed.critical.push(id);
    }
    for (const id of p.optional ?? []) {
      if (!composed.optional.includes(id) && !composed.required.includes(id)) composed.optional.push(id);
    }
    for (const id of p.excludeByDefault ?? []) {
      if (!composed.excluded.includes(id)) composed.excluded.push(id);
    }
    for (const id of p.requiredDecisions ?? []) {
      if (!composed.requiredDecisions.includes(id)) composed.requiredDecisions.push(id);
    }
    for (const id of p.requiredSafetyPolicies ?? []) {
      if (!composed.requiredSafetyPolicies.includes(id)) composed.requiredSafetyPolicies.push(id);
    }
  }

  // REQUIRED > EXCLUDED：排除被 required 覆盖的
  composed.excluded = composed.excluded.filter((id) => !composed.required.includes(id));
  // SAFETY REQUIRED 胜出：critical 即使被 excluded 也保留
  for (const id of composed.critical) {
    if (composed.excluded.includes(id)) {
      composed.excluded = composed.excluded.filter((x) => x !== id);
      composed.required.push(id);
      composed.conflicts.push({ documentId: id, reason: "safety_required 覆盖 excluded", winner: "SAFETY_REQUIRED" });
    }
  }
  // optional 冲突：被 excluded 则去掉
  composed.optional = composed.optional.filter((id) => !composed.excluded.includes(id));
  return composed;
}

/** P9.5-8：mandatory 文档严重度判定。 */
export function severityFor(profile: TaskProfile | ComposedProfile, documentId: string): MandatorySeverity {
  if ("critical" in profile && profile.critical?.includes(documentId)) return "CRITICAL";
  if (profile.required.includes(documentId)) return profile.critical?.includes(documentId) ? "CRITICAL" : "HIGH";
  if (profile.optional.includes(documentId)) return "NORMAL";
  return "NORMAL";
}

/** P9.5-7：Critical Context Recall（独立计算，不能被平均值掩盖）。 */
export function criticalContextRecall(composed: ComposedProfile, packMandatory: string[]): { criticalRecall: number; criticalMisses: string[] } {
  const misses = composed.critical.filter((id) => !packMandatory.includes(id));
  return { criticalRecall: composed.critical.length ? (composed.critical.length - misses.length) / composed.critical.length : 1, criticalMisses: misses };
}

/** P9.5-14：Decision Coverage。 */
export function decisionCoverage(composed: ComposedProfile, packDecisions: string[]): { coverage: number; missing: string[] } {
  const missing = composed.requiredDecisions.filter((id) => !packDecisions.includes(id));
  return { coverage: composed.requiredDecisions.length ? (composed.requiredDecisions.length - missing.length) / composed.requiredDecisions.length : 1, missing };
}

/** P9.5-1：Mandatory Miss Root-Cause Audit（A-J 分类）。 */
export type MissRootCause =
  | "TASK_CLASSIFICATION_ERROR"
  | "TASK_PROFILE_MISSING"
  | "DEPENDENCY_EXPANSION_MISSING"
  | "SOURCE_OF_TRUTH_MAPPING_MISSING"
  | "DOCUMENT_REGISTRY_MISSING"
  | "SECONDARY_TASK_NOT_PROPAGATED"
  | "CHANGED_FILE_SIGNAL_MISSING"
  | "GOLD_CONTEXT_OVERSTRICT"
  | "OBSOLETE_GOLD_REQUIREMENT"
  | "OTHER";

export interface MissAttribution {
  task: string;
  expectedDocument: string;
  actualPack: string[];
  severity: MandatorySeverity;
  rootCause: MissRootCause;
  recommendedFix: string;
}

export function attributeMiss(input: {
  task: string;
  expectedDocument: string;
  actualPack: string[];
  goldSeverity: MandatorySeverity;
  registry: DocumentRegistryFile;
  hasChangedFileSignal?: boolean;
}): MissAttribution {
  const registered = input.registry.documents.some((d) => d.documentId === input.expectedDocument);
  let rootCause: MissRootCause;
  let fix = "";
  if (!registered) {
    rootCause = "DOCUMENT_REGISTRY_MISSING";
    fix = `把 ${input.expectedDocument} 注册进 document-registry.yaml（documentId+path+status）`;
  } else if (input.goldSeverity === "CRITICAL" && !input.actualPack.includes(input.expectedDocument)) {
    rootCause = "TASK_PROFILE_MISSING";
    fix = `在 task-profiles.yaml 中把 ${input.expectedDocument} 加入 critical/required`;
  } else if (input.goldSeverity === "HIGH" && !input.actualPack.includes(input.expectedDocument)) {
    rootCause = "TASK_PROFILE_MISSING";
    fix = `在 task-profiles.yaml 中把 ${input.expectedDocument} 加入 required`;
  } else if (input.hasChangedFileSignal && !input.actualPack.includes(input.expectedDocument)) {
    rootCause = "CHANGED_FILE_SIGNAL_MISSING";
    fix = `检查 changed-file 是否被 classifier 的 file pattern 命中`;
  } else {
    rootCause = "GOLD_CONTEXT_OVERSTRICT";
    fix = `gold 期望可能过严；若为 OBSOLETE 则移除该 gold 项`;
  }
  return { task: input.task, expectedDocument: input.expectedDocument, actualPack: input.actualPack, severity: input.goldSeverity, rootCause, recommendedFix: fix };
}

/** P9.5-4：AMBIGUOUS 判定辅助（top1/top2 接近）。 */
export function isAmbiguous(classification: ReturnType<typeof classifyContextTask>): boolean {
  return Boolean(classification.ambiguous) || classification.confidence === "AMBIGUOUS";
}
