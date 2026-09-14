/**
 * P10 核心引擎：
 *   - P10.24 Knowledge Matching（KNOWN/PARTIAL/UNKNOWN）
 *   - P10.25 Conflict Detection（不静默覆盖）
 *   - P10.26/27 Diff + Versioning
 *   - P10.28 Store（append/versioned/audit/backup）
 *   - P10.33/34 Test-Design Readiness Gate
 *   - P10.38 Requirement Doctor
 *
 * 全部 deterministic；不生成 locator/DSL/case；不执行浏览器。
 */

import fs from "fs-extra";
import path from "node:path";
import crypto from "node:crypto";
import type { KnowledgeMatchStatus, RequirementDiff, RequirementModel, RequirementReview, RequirementSource, TestDesignReadiness } from "./types.js";
import { normalizeConcept } from "./analyzer.js";

// ============ P10.24：Knowledge Matching ============

export interface KnowledgeCatalog {
  concepts: Array<{ canonical: string; domain: string; known: boolean }>;
  capabilities: Array<{ capabilityId: string; name: string; domain: string }>;
}

export function matchConceptToKnowledge(concept: string, catalog: KnowledgeCatalog): { status: KnowledgeMatchStatus; canonical?: string; matchedDomain?: string } {
  const norm = normalizeConcept(concept);
  if (norm.matched) {
    const entry = catalog.concepts.find((c) => c.canonical === norm.canonical);
    if (entry) return { status: entry.known ? "KNOWN" : "PARTIAL", canonical: norm.canonical, matchedDomain: norm.domain };
  }
  for (const c of catalog.concepts) {
    if (concept.toLowerCase().includes(c.canonical.toLowerCase()) || c.canonical.toLowerCase().includes(concept.toLowerCase())) {
      return { status: c.known ? "KNOWN" : "PARTIAL", canonical: c.canonical, matchedDomain: c.domain };
    }
  }
  return { status: "UNKNOWN" };
}

/** 提取 requirement 中的概念并批量匹配。 */
export function assessRequirementKnowledge(text: string, catalog: KnowledgeCatalog): Array<{ concept: string; status: KnowledgeMatchStatus; canonical?: string; domain?: string }> {
  // 提取候选概念：大写 token + 中文业务词
  const candidates = new Set<string>();
  for (const m of text.matchAll(/\b[A-Z][A-Za-z0-9_]{1,24}\b/g)) candidates.add(m[0]);
  for (const m of text.matchAll(/(提现|地址|白名单|免验证|实名认证|2FA|二次验证|谷歌验证|转账|划转|KYC)/g)) candidates.add(m[1]);
  const results: Array<{ concept: string; status: KnowledgeMatchStatus; canonical?: string; domain?: string }> = [];
  for (const c of candidates) {
    const r = matchConceptToKnowledge(c, catalog);
    if (r.status === "UNKNOWN" && /提现|地址|白名单|免验证|2FA|实名|KYC/.test(c)) {
      results.push({ concept: c, status: "PARTIAL", domain: undefined });
    } else {
      results.push({ concept: c, status: r.status, canonical: r.canonical, domain: r.matchedDomain });
    }
  }
  return results;
}

// ============ P10.25：Conflict Detection ============

export interface ExistingRule {
  ruleId: string;
  statement: string;
  condition?: string;
  effect?: string;
  scope?: string;
}

export type ConflictKind = "REQUIREMENT_OVERRIDES_OLD" | "POSSIBLE_SCOPE_EXCEPTION" | "TRUE_CONFLICT" | "UNKNOWN";

export interface KnowledgeConflict {
  conflictId: string;
  kind: ConflictKind;
  requirementRule: string;
  existingRule: string;
  detail: string;
}

export function detectKnowledgeConflict(requirementRule: { statement: string; condition?: string; effect?: string; scope?: string }, existing: ExistingRule[]): KnowledgeConflict[] {
  const conflicts: KnowledgeConflict[] = [];
  const reqEff = (requirementRule.effect ?? requirementRule.statement).toLowerCase();
  for (const ex of existing) {
    const exEff = (ex.effect ?? ex.statement).toLowerCase();
    // 同一 scope + 同一 subject 但 effect 相反 → TRUE_CONFLICT / POSSIBLE_SCOPE_EXCEPTION
    if (requirementRule.scope && ex.scope && requirementRule.scope === ex.scope && reqEff !== exEff) {
      if (/not.*require|不需要|免/.test(reqEff) && /require|需要/.test(exEff)) {
        conflicts.push({ conflictId: `conf_${conflicts.length + 1}`, kind: "POSSIBLE_SCOPE_EXCEPTION", requirementRule: requirementRule.statement, existingRule: ex.statement, detail: `新规则 ${requirementRule.statement} 与已有 ${ex.statement} 冲突（免验证 vs 需要验证）` });
      } else {
        conflicts.push({ conflictId: `conf_${conflicts.length + 1}`, kind: "TRUE_CONFLICT", requirementRule: requirementRule.statement, existingRule: ex.statement, detail: `同 scope ${requirementRule.scope} 的规则效果冲突` });
      }
    }
  }
  return conflicts;
}

// ============ P10.26/27：Diff + Versioning ============

export function diffRequirements(v1: RequirementModel, v2: RequirementModel): RequirementDiff {
  const v1Rules = new Map(v1.businessRules.map((r) => [r.ruleId, r]));
  const v2Rules = new Map(v2.businessRules.map((r) => [r.ruleId, r]));
  const addedRules = [...v2Rules.entries()].filter(([id]) => !v1Rules.has(id)).map(([, r]) => ({ ruleId: r.ruleId, statement: r.statement }));
  const removedRules = [...v1Rules.entries()].filter(([id]) => !v2Rules.has(id)).map(([, r]) => ({ ruleId: r.ruleId, statement: r.statement }));
  const changedRules = [...v2Rules.entries()]
    .filter(([id, r]) => v1Rules.has(id) && v1Rules.get(id)!.statement !== r.statement)
    .map(([id, r]) => ({ ruleId: id, before: v1Rules.get(id)!.statement, after: r.statement }));

  const v1AC = new Map(v1.acceptanceCriteria.map((a) => [a.acId, a]));
  const v2AC = new Map(v2.acceptanceCriteria.map((a) => [a.acId, a]));
  const newAC = [...v2AC.keys()].filter((id) => !v1AC.has(id)).map((id) => ({ acId: id, statement: v2AC.get(id)!.statement }));
  const removedAC = [...v1AC.keys()].filter((id) => !v2AC.has(id)).map((id) => ({ acId: id, statement: v1AC.get(id)!.statement }));

  const v1Amb = new Map(v1.ambiguities.map((a) => [a.ambiguityId, a]));
  const v2Amb = new Map(v2.ambiguities.map((a) => [a.ambiguityId, a]));
  const newAmbiguities = [...v2Amb.keys()].filter((id) => !v1Amb.has(id)).map((id) => ({ ambiguityId: id, question: v2Amb.get(id)!.question }));
  const resolvedAmbiguities = [...v1Amb.keys()]
    .filter((id) => !v2Amb.has(id) || v2Amb.get(id)!.status === "RESOLVED")
    .filter((id) => v1Amb.has(id))
    .map((id) => ({ ambiguityId: id, question: v1Amb.get(id)!.question, resolution: v2Amb.get(id)?.resolution ?? "removed" }));

  const actorChanges = diffActors(v1, v2);
  return { addedRules, removedRules, changedRules, newAC, removedAC, newAmbiguities, resolvedAmbiguities, actorChanges };
}

function diffActors(v1: RequirementModel, v2: RequirementModel): RequirementDiff["actorChanges"] {
  const changes: RequirementDiff["actorChanges"] = [];
  const v1Actors = new Set(v1.actors.map((a) => a.name));
  const v2Actors = new Set(v2.actors.map((a) => a.name));
  for (const a of v2Actors) if (!v1Actors.has(a)) changes.push({ actor: a, after: "added" });
  for (const a of v1Actors) if (!v2Actors.has(a)) changes.push({ actor: a, before: "removed" });
  return changes;
}

// ============ P10.28：Store（append/versioned/audit/backup） ============

export interface RequirementStore {
  sources: RequirementSource[];
  models: RequirementModel[];
  reviews: RequirementReview[];
}

export function requirementStorePath(rootDir: string): string {
  return path.join(rootDir, "storage/requirements/store.json");
}

export async function loadRequirementStore(rootDir: string): Promise<RequirementStore> {
  const p = requirementStorePath(rootDir);
  if (!(await fs.pathExists(p))) return { sources: [], models: [], reviews: [] };
  return fs.readJson(p) as Promise<RequirementStore>;
}

export async function saveRequirementStore(rootDir: string, store: RequirementStore, reason: string): Promise<{ backupPath?: string }> {
  const p = requirementStorePath(rootDir);
  await fs.ensureDir(path.dirname(p));
  // audit backup（不静默覆盖）
  const backupDir = path.join(rootDir, "storage/requirements/backups");
  await fs.ensureDir(backupDir);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const backupPath = path.join(backupDir, `store-${stamp}-${reason}.json`);
  await fs.writeJson(backupPath, store, { spaces: 2 });
  await fs.writeJson(p, store, { spaces: 2 });
  return { backupPath: path.relative(rootDir, backupPath).replace(/\\/g, "/") };
}

export async function appendRequirementSource(rootDir: string, source: RequirementSource): Promise<RequirementStore> {
  const store = await loadRequirementStore(rootDir);
  if (store.sources.some((s) => s.sourceId === source.sourceId && s.contentHash === source.contentHash)) {
    return store; // 幂等：同 sourceId + 同 hash 不重复追加
  }
  store.sources.push(source);
  await saveRequirementStore(rootDir, store, "append_source");
  return store;
}

export async function appendRequirementModel(rootDir: string, model: RequirementModel): Promise<RequirementStore> {
  const store = await loadRequirementStore(rootDir);
  const existing = store.models.find((m) => m.requirementId === model.requirementId && m.version === model.version);
  if (existing) return store;
  // P10.27：不覆盖旧 version——保留 lineage
  store.models.push(model);
  await saveRequirementStore(rootDir, store, "append_model");
  return store;
}

export async function appendRequirementReview(rootDir: string, review: RequirementReview): Promise<RequirementStore> {
  const store = await loadRequirementStore(rootDir);
  store.reviews.push(review);
  await saveRequirementStore(rootDir, store, "append_review");
  return store;
}

// ============ P10.33/34：Test-Design Readiness ============

export function computeTestDesignReadiness(model: RequirementModel): TestDesignReadiness {
  const blockingIssues: string[] = [];
  const warningIssues: string[] = [];
  const diagnostics: TestDesignReadiness["diagnostics"] = [];

  if (model.businessChanges.length === 0) { blockingIssues.push("无业务变化"); diagnostics.push({ code: "NO_BUSINESS_CHANGE", detail: "需求未定义任何业务变化", severity: "CRITICAL" }); }
  if (model.acceptanceCriteria.length === 0) { warningIssues.push("无验收标准"); diagnostics.push({ code: "MISSING_ACCEPTANCE_CRITERIA", detail: "未提取验收标准", severity: "WARNING" }); }
  if (model.actors.length === 0) { blockingIssues.push("关键 actor 未知"); diagnostics.push({ code: "UNCLEAR_ACTOR", detail: "未识别角色", severity: "CRITICAL" }); }
  const blockingAmb = model.ambiguities.filter((a) => a.status === "OPEN" && /SECURITY|SCOPE|ACTOR/.test(a.type));
  if (blockingAmb.length) { blockingIssues.push(`存在 blocking ambiguity: ${blockingAmb.length} 个`); diagnostics.push({ code: "BLOCKING_AMBIGUITY", detail: blockingAmb.map((a) => a.question).join("; "), severity: "CRITICAL" }); }
  const highRisk = model.risks.filter((r) => r.level === "HIGH");
  if (highRisk.length && model.securityImplications.length === 0) { warningIssues.push("高风险但无安全影响分析"); diagnostics.push({ code: "SECURITY_SCOPE_UNCLEAR", detail: "高风险区域缺少安全影响", severity: "WARNING" }); }
  const unconfirmedAssumptions = model.assumptions.filter((a) => a.status === "UNCONFIRMED");
  if (unconfirmedAssumptions.length) { warningIssues.push(`存在 ${unconfirmedAssumptions.length} 个未确认假设`); diagnostics.push({ code: "UNRESOLVED_ASSUMPTION", detail: unconfirmedAssumptions.map((a) => a.assumptionId).join(", "), severity: "WARNING" }); }
  if (model.businessRules.length === 0) { warningIssues.push("无业务规则"); diagnostics.push({ code: "MISSING_BUSINESS_RULE", detail: "未提取业务规则", severity: "WARNING" }); }

  const status = blockingIssues.length ? "BLOCKED" : warningIssues.length ? "NEEDS_REVIEW" : "READY_FOR_TEST_DESIGN";
  return { status, blockingIssues, warningIssues, diagnostics };
}

// ============ P10.38：Requirement Doctor ============

export interface RequirementDoctorReport {
  pass: boolean;
  issues: string[];
  brokenSources: string[];
  missingAnalysis: string[];
  staleContextFingerprint: string[];
  unresolvedConflicts: string[];
  blockingAmbiguities: string[];
  invalidProvenance: string[];
  orphanBusinessRules: string[];
  versionCycles: string[];
  approvedWithUnreviewedInference: string[];
}

export function runRequirementDoctor(store: RequirementStore): RequirementDoctorReport {
  const report: RequirementDoctorReport = {
    pass: true, issues: [], brokenSources: [], missingAnalysis: [], staleContextFingerprint: [],
    unresolvedConflicts: [], blockingAmbiguities: [], invalidProvenance: [], orphanBusinessRules: [], versionCycles: [], approvedWithUnreviewedInference: []
  };
  const sourceIds = new Set(store.sources.map((s) => s.sourceId));
  for (const m of store.models) {
    if (!sourceIds.has(m.sourceId)) { report.brokenSources.push(m.requirementId); report.pass = false; }
    for (const r of m.businessRules) {
      if (!r.provenance?.sourceId || !r.provenance.quoteOrAnchor) { report.invalidProvenance.push(`${m.requirementId}:${r.ruleId}`); report.pass = false; }
      if (r.status === "INFERRED" && !m.assumptions.some((a) => a.affects.includes(r.ruleId)) && r.origin === "AI_INFERENCE") { report.orphanBusinessRules.push(`${m.requirementId}:${r.ruleId}`); report.pass = false; }
    }
    if (m.status === "APPROVED" && m.businessRules.some((r) => r.origin === "AI_INFERENCE" && r.status === "INFERRED")) {
      report.approvedWithUnreviewedInference.push(m.requirementId);
      report.pass = false;
    }
    if (m.ambiguities.some((a) => a.status === "OPEN" && /SECURITY|SCOPE/.test(a.type))) {
      report.blockingAmbiguities.push(m.requirementId);
      report.pass = false;
    }
  }
  report.issues = [...report.brokenSources, ...report.invalidProvenance, ...report.orphanBusinessRules, ...report.approvedWithUnreviewedInference, ...report.blockingAmbiguities];
  return report;
}
