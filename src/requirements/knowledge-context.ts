/**
 * P10.5-19/20/21/22/37/38/39：Context Router Knowledge Selection + Snapshot + Provenance。
 *
 * - P11 TEST_DESIGN task：Context Router 选择 domain 相关 Business Rules/Capabilities/Security Rules/
 *   Approved Facts + OM + Page Model，而非整个 Knowledge Store。
 * - BusinessKnowledgeSnapshot：按 task/domain/capabilities/concepts 生成（不含巨大 store）。
 * - Snapshot budget：exact capability > exact concept > security critical > dependencies > related domain；
 *   不得因 budget 丢 Critical Security rule。
 * - Context Pack 显示 knowledge provenance（来源 Requirement + Human approved + 时间）。
 * - Knowledge promotion 后 fingerprint 必须变化（证明知识成为上下文版本一部分）。
 */

import fs from "fs-extra";
import crypto from "node:crypto";
import path from "node:path";
import type { BusinessKnowledge } from "./knowledge-activation.js";
import { buildBusinessKnowledgeSnapshot, loadKnowledgeStore, type BusinessKnowledgeSnapshot } from "./knowledge-store.js";

export interface KnowledgeContextInput {
  domain: string;
  concepts?: string[];
  capability?: string;
  budgetLimit?: number;
  includeHistorical?: boolean;
}

export interface KnowledgeContextResult {
  snapshot: BusinessKnowledgeSnapshot;
  included: BusinessKnowledge[];
  provenanceLines: string[];
  budget: { total: number; included: number; securityCriticalIncluded: boolean };
  fingerprint: string;
}

export async function buildKnowledgeContext(rootDir: string, input: KnowledgeContextInput): Promise<KnowledgeContextResult> {
  const store = await loadKnowledgeStore(rootDir);
  const snapshot = buildBusinessKnowledgeSnapshot(store, { domain: input.domain, concepts: input.concepts, budgetLimit: input.budgetLimit });

  // 排序：exact capability > exact concept > security > dependencies > related
  const rank = (k: BusinessKnowledge) => {
    const text = `${k.canonicalConcept} ${JSON.stringify(k.structuredValue)} ${k.scope.capability ?? ""}`.toLowerCase();
    let score = 0;
    if (input.capability && k.scope.capability?.toLowerCase() === input.capability.toLowerCase()) score += 0;
    else if (input.concepts?.some((c) => text.includes(c.toLowerCase()))) score += 1;
    else if (k.knowledgeType === "SECURITY_REQUIREMENT") score += 2;
    else if (k.knowledgeType === "DEPENDENCY") score += 3;
    else score += 4;
    return score;
  };
  const all = [...snapshot.relevantRules, ...snapshot.constraints, ...snapshot.dependencies, ...snapshot.states, ...snapshot.security]
    .filter((k) => k.status === "ACTIVE")
    .sort((a, b) => rank(a) - rank(b));

  const budgetLimit = input.budgetLimit ?? 30;
  let included = all.slice(0, budgetLimit);
  // 不得因 budget 丢 Critical Security rule
  const missingSecurity = snapshot.security.filter((s) => !included.some((i) => i.knowledgeId === s.knowledgeId));
  if (missingSecurity.length) included = [...missingSecurity, ...included].slice(0, budgetLimit + missingSecurity.length);

  const provenanceLines = included.map((k) => {
    const p = k.provenance[0];
    const authority = k.authority === "HUMAN_CONFIRMED" ? "Human approved" : k.authority;
    return `KB ${k.knowledgeId}（${k.canonicalConcept.slice(0, 40)}） ← Requirement ${p.sourceId} v${p.requirementVersion} · ${authority}`;
  });

  const fingerprint = crypto.createHash("sha256")
    .update(included.map((k) => `${k.knowledgeId}:${k.version}:${k.status}`).join("|"))
    .digest("hex").slice(0, 12);

  return {
    snapshot,
    included,
    provenanceLines,
    budget: { total: all.length, included: included.length, securityCriticalIncluded: missingSecurity.length === 0 },
    fingerprint
  };
}

/** P10.5-37：知识版本指纹（用于检测 promotion 后 fingerprint 变化）。 */
export function knowledgeVersionFingerprint(store: { knowledge: BusinessKnowledge[] }): string {
  return crypto.createHash("sha256")
    .update(store.knowledge.filter((k) => k.status === "ACTIVE").map((k) => `${k.knowledgeId}:${k.version}:${k.semanticKey}`).sort().join("|"))
    .digest("hex").slice(0, 12);
}

/** P10.5-22：pack 中 knowledge provenance 渲染。 */
export function renderKnowledgeProvenance(k: BusinessKnowledge): string {
  const p = k.provenance[0];
  const review = k.authority === "HUMAN_CONFIRMED" ? "Human approved" : k.authority;
  const history = k.verificationHistory?.map((h) => h.action).join(", ") ?? "";
  return `${k.knowledgeId} [${k.status}/${k.authority}] ${k.canonicalConcept} ← Requirement ${p?.sourceId ?? "?"} v${p?.requirementVersion ?? "?"} · ${review} · history:${history}`;
}

/** 同步版 buildKnowledgeContext（测试用，避免 async 挂起）。 */
export function buildKnowledgeContextSync(rootDir: string, input: KnowledgeContextInput): KnowledgeContextResult {
  const storePath = path.join(rootDir, "storage/business-knowledge/store.json");
  const store = fs.pathExistsSync(storePath) ? fs.readJsonSync(storePath) as { knowledge: BusinessKnowledge[] } : { knowledge: [] };
  const snapshot = buildBusinessKnowledgeSnapshot({ version: "1.0", knowledge: store.knowledge, reviewQueue: [], reviews: [] }, { domain: input.domain, concepts: input.concepts, budgetLimit: input.budgetLimit });
  const rank = (k: BusinessKnowledge) => {
    const text = `${k.canonicalConcept} ${JSON.stringify(k.structuredValue)} ${k.scope.capability ?? ""}`.toLowerCase();
    let score = 0;
    if (input.capability && k.scope.capability?.toLowerCase() === input.capability.toLowerCase()) score += 0;
    else if (input.concepts?.some((c) => text.includes(c.toLowerCase()))) score += 1;
    else if (k.knowledgeType === "SECURITY_REQUIREMENT") score += 2;
    else if (k.knowledgeType === "DEPENDENCY") score += 3;
    else score += 4;
    return score;
  };
  const all = [...snapshot.relevantRules, ...snapshot.constraints, ...snapshot.dependencies, ...snapshot.states, ...snapshot.security]
    .filter((k) => k.status === "ACTIVE")
    .sort((a, b) => rank(a) - rank(b));
  const budgetLimit = input.budgetLimit ?? 30;
  let included = all.slice(0, budgetLimit);
  const missingSecurity = snapshot.security.filter((s) => !included.some((i) => i.knowledgeId === s.knowledgeId));
  if (missingSecurity.length) included = [...missingSecurity, ...included].slice(0, budgetLimit + missingSecurity.length);
  const provenanceLines = included.map((k) => {
    const p = k.provenance[0];
    return `KB ${k.knowledgeId}（${k.canonicalConcept.slice(0, 40)}） ← Requirement ${p?.sourceId ?? "?"} v${p?.requirementVersion ?? "?"} · ${k.authority}`;
  });
  const fingerprint = crypto.createHash("sha256").update(included.map((k) => `${k.knowledgeId}:${k.version}:${k.status}`).join("|")).digest("hex").slice(0, 12);
  return { snapshot, included, provenanceLines, budget: { total: all.length, included: included.length, securityCriticalIncluded: missingSecurity.length === 0 }, fingerprint };
}
