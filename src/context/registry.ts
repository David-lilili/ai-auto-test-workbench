import fs from "fs-extra";
import path from "node:path";
import crypto from "node:crypto";
import yaml from "yaml";
import type { ContextDocument, ContextFreshness, DocumentRegistryFile, FreshnessStatus, SourceOfTruthEntry, SourceOfTruthFile } from "./types.js";

/**
 * P9.1 / P9.2：Document Registry + Source-of-Truth Registry。
 *
 * - documentId 是稳定标识（PROJECT_ARCHITECTURE / PAGE_MODEL_SCHEMA ...）。
 * - status：ACTIVE / REFERENCE / HISTORICAL / DEPRECATED / SUPERSEDED。
 * - sourceOfTruth：某类事实的 primary / secondary 权威（schema/policy 代码可能比文档更高）。
 */

export const DOCUMENT_REGISTRY_PATH = "configs/ai-context/document-registry.yaml";
export const SOURCE_OF_TRUTH_PATH = "configs/ai-context/source-of-truth.yaml";

export async function loadDocumentRegistry(rootDir: string): Promise<DocumentRegistryFile> {
  const full = path.join(rootDir, DOCUMENT_REGISTRY_PATH);
  if (!(await fs.pathExists(full))) return { version: "none", documents: [] };
  const text = await fs.readFile(full, "utf8");
  return yaml.parse(text) as DocumentRegistryFile;
}

export async function loadSourceOfTruth(rootDir: string): Promise<SourceOfTruthFile> {
  const full = path.join(rootDir, SOURCE_OF_TRUTH_PATH);
  if (!(await fs.pathExists(full))) return { version: "none", entries: [] };
  const text = await fs.readFile(full, "utf8");
  return yaml.parse(text) as SourceOfTruthFile;
}

/** 校验 registry：documentId 唯一、path 非空、type 合法。返回问题列表。 */
export function validateDocumentRegistry(registry: DocumentRegistryFile): string[] {
  const issues: string[] = [];
  const ids = new Set<string>();
  for (const doc of registry.documents) {
    if (!doc.documentId || !doc.path) {
      issues.push(`${doc.documentId ?? "(no-id)"}: documentId 与 path 必填`);
    }
    if (ids.has(doc.documentId)) issues.push(`${doc.documentId}: 重复 documentId`);
    ids.add(doc.documentId);
    if (!fs.pathExistsSync(doc.path)) {
      issues.push(`${doc.documentId}: 文件不存在 ${doc.path}`);
    }
  }
  // dependsOn 指向必须存在
  for (const doc of registry.documents) {
    for (const dep of doc.dependsOn ?? []) {
      if (!ids.has(dep)) issues.push(`${doc.documentId}: dependsOn 指向不存在的 ${dep}`);
    }
  }
  return issues;
}

/** 检测依赖环（DFS）。 */
export function findDependencyCycles(registry: DocumentRegistryFile): string[][] {
  const byId = new Map(registry.documents.map((d) => [d.documentId, d]));
  const cycles: string[][] = [];
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
    const doc = byId.get(id);
    for (const dep of doc?.dependsOn ?? []) {
      if (byId.has(dep)) dfs(dep);
    }
    stack.pop();
    inStack.delete(id);
  };

  for (const id of byId.keys()) dfs(id);
  // 去重
  const unique = new Set(cycles.map((c) => c.join("->")));
  return [...unique].map((s) => s.split("->"));
}

/** P9.17：计算 contentHash + freshness。 */
export function computeContentHash(filePath: string): string {
  if (!fs.pathExistsSync(filePath)) return "";
  const text = fs.readFileSync(filePath, "utf8");
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
}

export function freshnessFor(doc: ContextDocument, currentCommit: string, currentHash: string): ContextFreshness {
  if (doc.status === "DEPRECATED" || doc.status === "SUPERSEDED") {
    return { documentId: doc.documentId, contentHash: currentHash, gitCommit: currentCommit, lastReviewedCommit: doc.lastReviewedCommit, status: "SUPERSEDED" };
  }
  if (!doc.lastReviewedCommit) {
    return { documentId: doc.documentId, contentHash: currentHash, gitCommit: currentCommit, status: "CHANGED_SINCE_REVIEW" };
  }
  if (doc.lastReviewedCommit === currentCommit) {
    return { documentId: doc.documentId, contentHash: currentHash, gitCommit: currentCommit, lastReviewedCommit: doc.lastReviewedCommit, status: "FRESH" };
  }
  return { documentId: doc.documentId, contentHash: currentHash, gitCommit: currentCommit, lastReviewedCommit: doc.lastReviewedCommit, status: "CHANGED_SINCE_REVIEW" };
}

export function sourceOfTruthForDomain(registry: SourceOfTruthFile, domain: string): SourceOfTruthEntry | undefined {
  return registry.entries.find((e) => e.domain === domain);
}

/** P9.34：conflict precedence——不同 domain 可以不同，代码/safety 优先。 */
export const DEFAULT_CONFLICT_PRECEDENCE = [
  "explicit_current_task",
  "safety_policy",
  "executable_schema_policy_code",
  "current_state",
  "active_source_of_truth_docs",
  "latest_handoff",
  "latest_benchmark",
  "reference_docs",
  "historical_reports"
];
