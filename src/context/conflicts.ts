import fs from "fs-extra";
import path from "node:path";
import type { ContextDocument, DocumentRegistryFile, SourceOfTruthFile } from "./types.js";

/**
 * P9.3：Document Conflict Detection（metadata / structural，第一版不要求理解全文语义）。
 *
 * A. 两个 ACTIVE 文档同时宣称同一 sourceOfTruthFor
 * B. deprecated 文档被 mandatoryFor 引用
 * C. superseded 文档仍在 AI_START_HERE
 * D. 文件不存在
 * E. dependsOn 指向不存在
 * F. circular dependency
 * G. CURRENT_STATE phase 与最新 handoff 不一致
 * H. benchmark latest 与 baseline version 不一致
 * I. schema version 文档与代码明显不一致
 * J. registry version 没更新但文件 hash 发生大变化
 */

export interface ContextConflict {
  kind: string;
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  detail: string;
  a?: string;
  b?: string;
}

export interface ConflictInput {
  registry: DocumentRegistryFile;
  sourceOfTruth: SourceOfTruthFile;
  currentPhase: string;
  handoffPhase?: string;
  benchmarkVersion?: string;
  baselineVersion?: string;
  aIStartHereText?: string;
}

/** A：同一 sourceOfTruthFor 被两个 ACTIVE 文档宣称。 */
export function detectSourceOfTruthConflicts(registry: DocumentRegistryFile): ContextConflict[] {
  const conflicts: ContextConflict[] = [];
  const claims = new Map<string, string[]>();
  for (const doc of registry.documents) {
    if (doc.status !== "ACTIVE") continue;
    for (const domain of doc.sourceOfTruthFor ?? []) {
      const list = claims.get(domain) ?? [];
      list.push(doc.documentId);
      claims.set(domain, list);
    }
  }
  for (const [domain, ids] of claims) {
    if (ids.length > 1) {
      conflicts.push({ kind: "SOURCE_OF_TRUTH_CONFLICT", severity: "HIGH", detail: `domain ${domain} 被多个 ACTIVE 文档宣称: ${ids.join(", ")}`, a: ids[0], b: ids[1] });
    }
  }
  return conflicts;
}

/** B/C：deprecated/superseded 文档被引用。 */
export function detectDeprecatedReferences(registry: DocumentRegistryFile, aIStartHereText?: string): ContextConflict[] {
  const conflicts: ContextConflict[] = [];
  const byId = new Map(registry.documents.map((d) => [d.documentId, d]));
  for (const doc of registry.documents) {
    if (doc.status === "DEPRECATED" || doc.status === "SUPERSEDED") {
      for (const referrer of registry.documents) {
        if (referrer.mandatoryFor?.includes(doc.documentId)) {
          conflicts.push({ kind: "DEPRECATED_MANDATORY_REF", severity: "HIGH", detail: `${referrer.documentId} 把 ${doc.documentId} 作为 mandatory（但它是 ${doc.status}）`, a: referrer.documentId, b: doc.documentId });
        }
      }
      if (aIStartHereText && aIStartHereText.includes(doc.path)) {
        conflicts.push({ kind: "SUPERSEDED_IN_AI_START_HERE", severity: "MEDIUM", detail: `${doc.documentId} (${doc.status}) 仍被 AI_START_HERE 引用`, b: doc.documentId });
      }
    }
  }
  return conflicts;
}

/** D/E：文件/依赖缺失。 */
export function detectMissingFiles(registry: DocumentRegistryFile): ContextConflict[] {
  const conflicts: ContextConflict[] = [];
  const ids = new Set(registry.documents.map((d) => d.documentId));
  for (const doc of registry.documents) {
    if (!fs.pathExistsSync(doc.path)) {
      conflicts.push({ kind: "MISSING_FILE", severity: doc.status === "ACTIVE" ? "HIGH" : "LOW", detail: `${doc.documentId}: 文件不存在 ${doc.path}`, b: doc.documentId });
    }
    for (const dep of doc.dependsOn ?? []) {
      if (!ids.has(dep)) {
        conflicts.push({ kind: "MISSING_DEPENDENCY", severity: "MEDIUM", detail: `${doc.documentId}: dependsOn 指向不存在的 ${dep}`, b: doc.documentId });
      }
    }
  }
  return conflicts;
}

/** F：依赖环（复用 registry.findDependencyCycles）。 */
export function detectDependencyCycles(registry: DocumentRegistryFile): ContextConflict[] {
  const cycles: string[][] = [];
  const byId = new Map(registry.documents.map((d) => [d.documentId, d]));
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const stack: string[] = [];
  const dfs = (id: string) => {
    if (inStack.has(id)) {
      const idx = stack.indexOf(id);
      if (idx >= 0) cycles.push([...stack.slice(idx), id]);
      return;
    }
    if (visited.has(id)) return;
    visited.add(id);
    inStack.add(id);
    stack.push(id);
    for (const dep of byId.get(id)?.dependsOn ?? []) if (byId.has(dep)) dfs(dep);
    stack.pop();
    inStack.delete(id);
  };
  for (const id of byId.keys()) dfs(id);
  const seen = new Set<string>();
  return cycles
    .filter((c) => { const k = c.join("->"); if (seen.has(k)) return false; seen.add(k); return true; })
    .map((c) => ({ kind: "DEPENDENCY_CYCLE", severity: "HIGH" as const, detail: `依赖环: ${c.join(" -> ")}`, b: c[0] }));
}

/** G：CURRENT_STATE phase 与最新 handoff 不一致。 */
export function detectStateHandoffConflict(currentPhase: string, handoffPhase?: string): ContextConflict[] {
  if (handoffPhase && currentPhase && handoffPhase !== currentPhase) {
    return [{ kind: "STATE_HANDOFF_CONFLICT", severity: "MEDIUM", detail: `CURRENT_STATE=${currentPhase} 与最新 HANDOFF=${handoffPhase} 不一致`, a: currentPhase, b: handoffPhase }];
  }
  return [];
}

/** H：benchmark latest 与 baseline version 不一致。 */
export function detectBenchmarkVersionConflict(benchmarkVersion?: string, baselineVersion?: string): ContextConflict[] {
  if (benchmarkVersion && baselineVersion && benchmarkVersion !== baselineVersion) {
    return [{ kind: "BENCHMARK_BASELINE_MISMATCH", severity: "LOW", detail: `benchmark=${benchmarkVersion} 与 baseline=${baselineVersion} 不一致`, a: benchmarkVersion, b: baselineVersion }];
  }
  return [];
}

/** 汇总全部 conflict（P9.3 auditContextConflicts）。 */
export function auditContextConflicts(input: ConflictInput): ContextConflict[] {
  return [
    ...detectSourceOfTruthConflicts(input.registry),
    ...detectDeprecatedReferences(input.registry, input.aIStartHereText),
    ...detectMissingFiles(input.registry),
    ...detectDependencyCycles(input.registry),
    ...detectStateHandoffConflict(input.currentPhase, input.handoffPhase),
    ...detectBenchmarkVersionConflict(input.benchmarkVersion, input.baselineVersion)
  ];
}
