/**
 * P11.19-23/26-30/41-48：Grounding Validator + Duplicate/Merge + Coverage + Doctor + Store。
 *
 * - Grounding：每个 precondition/action/expected 必须有 knowledgeRef/requirementRef/manualRef 或 TESTING_TECHNIQUE；
 *   unsupported expectation → BLOCK candidate。
 * - Duplicate：testScenarioSemanticKey 去重；同 obligation+condition+expected → merge；actor 不同不合并。
 * - Coverage：obligation/AC/rule/state/dependency/security 覆盖矩阵。
 * - Doctor：candidate missing requirement / unknown knowledgeRef / unsupported expectation / duplicate key / critical uncovered / security uncovered / invalid provenance / invalid manual ref / count explosion。
 */

import fs from "fs-extra";
import path from "node:path";
import crypto from "node:crypto";
import type { GroundingSource, TestCoverageObligation, TestDesignCandidate, TestDesignInput } from "./types.js";
import { testScenarioSemanticKey, testDesignReadiness, type TestDesignReadinessResult } from "./types.js";

// ============ P11.19-21：Grounding Validator ============

export type UnsupportedKind = "UNSUPPORTED_BUSINESS_RULE" | "UNSUPPORTED_EXPECTATION" | "UNSUPPORTED_PRECONDITION" | "UNSUPPORTED_ACTOR" | "UNSUPPORTED_STATE";

export interface GroundingIssue {
  candidateId: string;
  kind: UnsupportedKind;
  detail: string;
}

export function isGrounded(g: GroundingSource): boolean {
  return g.kind !== "TESTING_TECHNIQUE";
}

export function validateCandidateGrounding(candidate: TestDesignCandidate): GroundingIssue[] {
  const issues: GroundingIssue[] = [];
  // expected outcome 必须有事实来源（TESTING_TECHNIQUE 对 outcome 不合法）
  for (const e of candidate.expectedOutcomes) {
    if (e.grounding.kind === "TESTING_TECHNIQUE") {
      issues.push({ candidateId: candidate.candidateId, kind: "UNSUPPORTED_EXPECTATION", detail: `expected outcome 无事实来源: ${e.statement.slice(0, 50)}` });
    }
  }
  // 若 candidate 有 assumption 且 origin 非 HUMAN，需 review
  return issues;
}

// ============ P11.22/23：Duplicate + Merge ============

export function dedupeCandidates(candidates: TestDesignCandidate[]): { unique: TestDesignCandidate[]; removed: string[] } {
  const seen = new Map<string, TestDesignCandidate>();
  const removed: string[] = [];
  for (const c of candidates) {
    const key = testScenarioSemanticKey(c);
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, c);
      continue;
    }
    // actor 不同不合并（preconditions 含 actor 差异 → key 已含 precondition 差异）
    // 合并：保留 criticality 更高者
    const rank = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
    if ((rank as Record<string, number>)[c.risk.designPriority] < (rank as Record<string, number>)[existing.risk.designPriority]) {
      seen.set(key, c);
      removed.push(existing.candidateId);
    } else {
      removed.push(c.candidateId);
    }
  }
  return { unique: [...seen.values()], removed };
}

// ============ P11.24-30：Coverage Matrix ============

export interface CoverageRow {
  factId: string;
  type: string;
  coveredByCandidateIds: string[];
}

export function buildCoverageMatrix(obligations: TestCoverageObligation[], candidates: TestDesignCandidate[]): CoverageRow[] {
  return obligations.map((o) => ({
    factId: o.obligationId,
    type: o.type,
    coveredByCandidateIds: candidates.filter((c) => c.coveredObligationIds.includes(o.obligationId)).map((c) => c.candidateId)
  }));
}

export function obligationCoverage(obligations: TestCoverageObligation[], candidates: TestDesignCandidate[]): { total: number; covered: number; uncoveredIds: string[]; ratio: number } {
  const covered = new Set<string>();
  for (const c of candidates) for (const id of c.coveredObligationIds) covered.add(id);
  const uncoveredIds = obligations.filter((o) => !covered.has(o.obligationId)).map((o) => o.obligationId);
  return { total: obligations.length, covered: covered.size, uncoveredIds, ratio: obligations.length ? covered.size / obligations.length : 1 };
}

export function criticalObligationCoverage(obligations: TestCoverageObligation[], candidates: TestDesignCandidate[]): { covered: boolean; uncoveredIds: string[] } {
  const crit = obligations.filter((o) => o.criticality === "CRITICAL");
  const covered = new Set<string>();
  for (const c of candidates) for (const id of c.coveredObligationIds) covered.add(id);
  const uncoveredIds = crit.filter((o) => !covered.has(o.obligationId)).map((o) => o.obligationId);
  return { covered: uncoveredIds.length === 0, uncoveredIds };
}

export function securityObligationCoverage(obligations: TestCoverageObligation[], candidates: TestDesignCandidate[]): { covered: boolean; uncoveredIds: string[] } {
  const sec = obligations.filter((o) => o.isSecurity);
  const covered = new Set<string>();
  for (const c of candidates) for (const id of c.coveredObligationIds) covered.add(id);
  const uncoveredIds = sec.filter((o) => !covered.has(o.obligationId)).map((o) => o.obligationId);
  return { covered: uncoveredIds.length === 0, uncoveredIds };
}

// ============ P11.34/35：Coverage Repair Pass ============

export function coverageRepair(uncoveredObligations: TestCoverageObligation[], existing: TestDesignCandidate[]): TestDesignCandidate[] {
  // targeted：只为 uncovered obligations 生成（输入只给 uncovered）
  return systematicDesignForObligations(uncoveredObligations, existing.length);
}

export function systematicDesignForObligations(obligations: TestCoverageObligation[], startIndex: number): TestDesignCandidate[] {
  const now = new Date().toISOString();
  const candidates: TestDesignCandidate[] = [];
  for (const obl of obligations) {
    const c: TestDesignCandidate = {
      candidateId: `TC-${String(startIndex + candidates.length + 1).padStart(3, "0")}`,
      requirementId: obl.provenance.sourceId,
      title: `REPAIR ${obl.subject.slice(0, 40)}`,
      objective: obl.subject,
      scenarioType: obl.requiredScenarioTypes[0] ?? "POSITIVE",
      preconditions: [{ statement: obl.condition ?? "default", grounding: { kind: "REQUIREMENT", factId: obl.source } }],
      semanticActions: [{ action: "VERIFY_STATE", target: obl.subject, grounding: { kind: "REQUIREMENT", factId: obl.source } }],
      expectedOutcomes: [{ statement: obl.expected ?? obl.subject, grounding: { kind: "REQUIREMENT", factId: obl.source } }],
      testDataRequirements: [],
      coveredObligationIds: [obl.obligationId],
      coveredBusinessRuleIds: obl.type === "BUSINESS_RULE" ? [obl.source] : [],
      coveredACIds: obl.type === "ACCEPTANCE_CRITERION" ? [obl.source] : [],
      coveredCapabilityIds: [],
      risk: { designPriority: obl.criticality, executionRisk: obl.isSecurity ? "HIGH" : "MEDIUM" },
      knowledgeRefs: [],
      manualRuleRefs: [],
      manualVersions: {},
      assumptions: [],
      origin: "SYSTEMATIC",
      confidence: "MEDIUM",
      reviewStatus: obl.isSecurity ? "NEEDS_SECURITY_REVIEW" : "AUTO_REVIEWABLE",
      testability: "EXECUTION_PATH_UNKNOWN",
      provenance: [{ reason: `coverage repair for ${obl.obligationId}`, source: obl.source }],
      status: "DRAFT",
      semanticKey: "",
      createdAt: now
    };
    c.semanticKey = testScenarioSemanticKey(c);
    candidates.push(c);
  }
  return candidates;
}

// ============ P11.75/92：Quality Gate ============

export function testDesignQualityGate(input: { readiness: TestDesignReadinessResult; unsupportedCritical: number; invalidProvenance: number; preflightFail: boolean }): { status: "BLOCKED" | "WARNING" | "PASS"; blocking: string[]; warnings: string[] } {
  const blocking: string[] = [];
  const warnings: string[] = [];
  if (input.preflightFail) blocking.push("context preflight fail");
  if (input.readiness.status === "BLOCKED") blocking.push(...input.readiness.blockingIssues);
  if (input.unsupportedCritical > 0) blocking.push("unsupported critical expectation");
  if (input.invalidProvenance > 0) blocking.push("invalid provenance");
  if (input.readiness.warningIssues.length) warnings.push(...input.readiness.warningIssues);
  return { status: blocking.length ? "BLOCKED" : warnings.length ? "WARNING" : "PASS", blocking, warnings };
}

// ============ P11.48：Doctor ============

export interface TestDesignDoctorReport {
  pass: boolean;
  issues: string[];
  candidateMissingRequirement: string[];
  unknownKnowledgeRef: string[];
  unsupportedExpectation: string[];
  duplicateSemanticKey: string[];
  criticalUncovered: string[];
  securityUncovered: string[];
  invalidProvenance: string[];
  invalidManualRef: string[];
  countExplosion: boolean;
}

export function runTestDesignDoctor(input: { candidates: TestDesignCandidate[]; obligations: TestCoverageObligation[]; knownKnowledgeRefs: string[]; knownManualRefs: string[]; maxCandidates: number }): TestDesignDoctorReport {
  const report: TestDesignDoctorReport = { pass: true, issues: [], candidateMissingRequirement: [], unknownKnowledgeRef: [], unsupportedExpectation: [], duplicateSemanticKey: [], criticalUncovered: [], securityUncovered: [], invalidProvenance: [], invalidManualRef: [], countExplosion: false };

  const seen = new Map<string, string[]>();
  for (const c of input.candidates) {
    if (!c.requirementId) { report.candidateMissingRequirement.push(c.candidateId); report.pass = false; }
    if (!c.provenance.length) { report.invalidProvenance.push(c.candidateId); report.pass = false; }
    for (const k of c.knowledgeRefs) {
      if (!input.knownKnowledgeRefs.includes(k)) { report.unknownKnowledgeRef.push(`${c.candidateId}:${k}`); report.pass = false; }
    }
    for (const m of c.manualRuleRefs) {
      if (!input.knownManualRefs.includes(m)) { report.invalidManualRef.push(`${c.candidateId}:${m}`); report.pass = false; }
    }
    const key = c.semanticKey || testScenarioSemanticKey(c);
    const list = seen.get(key) ?? [];
    list.push(c.candidateId);
    seen.set(key, list);
    for (const e of c.expectedOutcomes) {
      if (e.grounding.kind === "TESTING_TECHNIQUE") { report.unsupportedExpectation.push(`${c.candidateId}:${e.statement.slice(0, 30)}`); report.pass = false; }
    }
  }
  for (const [key, ids] of seen) if (ids.length > 1) { report.duplicateSemanticKey.push(key); report.pass = false; }
  const crit = criticalObligationCoverage(input.obligations, input.candidates);
  if (!crit.covered) { report.criticalUncovered = crit.uncoveredIds; report.pass = false; }
  const sec = securityObligationCoverage(input.obligations, input.candidates);
  if (!sec.covered) { report.securityUncovered = sec.uncoveredIds; report.pass = false; }
  if (input.candidates.length > input.maxCandidates) { report.countExplosion = true; report.pass = false; }
  report.issues = [...report.candidateMissingRequirement, ...report.unknownKnowledgeRef, ...report.unsupportedExpectation, ...report.duplicateSemanticKey, ...report.criticalUncovered, ...report.securityUncovered, ...report.invalidProvenance, ...report.invalidManualRef];
  return report;
}

// ============ P11.46：Candidate Store ============

export interface CandidateStoreFile {
  version: string;
  candidates: TestDesignCandidate[];
  coverage: Array<{ requirementId: string; matrix: CoverageRow[]; readiness: TestDesignReadinessResult }>;
  testDesignInputs: Array<{ requirementId: string; input: TestDesignInput }>;
}

export function candidateStorePath(rootDir: string): string {
  return path.join(rootDir, "storage/test-design-candidates/store.json");
}

export async function loadCandidateStore(rootDir: string): Promise<CandidateStoreFile> {
  const p = candidateStorePath(rootDir);
  if (!(await fs.pathExists(p))) return { version: "1.0", candidates: [], coverage: [], testDesignInputs: [] };
  return fs.readJson(p) as Promise<CandidateStoreFile>;
}

export async function saveCandidateStore(rootDir: string, store: CandidateStoreFile): Promise<void> {
  const p = candidateStorePath(rootDir);
  await fs.ensureDir(path.dirname(p));
  await fs.writeJson(p, store, { spaces: 2 });
}

export function candidateStoreFingerprint(store: CandidateStoreFile): string {
  const active = store.candidates.map((c) => `${c.candidateId}:${c.semanticKey}:${c.status}`).sort().join("|");
  return crypto.createHash("sha256").update(active).digest("hex").slice(0, 12);
}
