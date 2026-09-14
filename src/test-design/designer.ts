/**
 * P11 主流程：buildTestDesignInput → obligations → manual selection → design → validate → coverage → readiness。
 */

import fs from "fs-extra";
import path from "node:path";
import yaml from "yaml";
import type { RequirementModel } from "../requirements/types.js";
import { loadKnowledgeStore, findBusinessKnowledge, type KnowledgeStoreFile } from "../requirements/knowledge-store.js";
import type { TestDesignInput } from "./types.js";
import { knowledgeVersionFingerprint } from "../requirements/knowledge-context.js";
import type { ApprovedRequirementFact } from "../requirements/knowledge-activation.js";
import type { TestCoverageObligation, TestDesignCandidate } from "./types.js";
import { buildCoverageObligations, selectTestDesignManualRules, systematicDesigner, type ManualRuleRef, type TestDesignManualFile, type DesignKnowledgeEntry } from "./obligations.js";
import { validateCandidateGrounding, dedupeCandidates, buildCoverageMatrix, obligationCoverage, criticalObligationCoverage, securityObligationCoverage, testDesignQualityGate, type CoverageRow } from "./engine.js";
import { testDesignReadiness } from "./types.js";
import { runTestDesignPreflight, type TestDesignPreflightResult } from "./preflight.js";

export const TEST_DESIGNER_PROMPT_VERSION = "test-designer.v1";
export const TEST_DESIGN_MANUAL_VERSION = "test-design-manual.v1";

export const MANUAL_DIR = "docs/ai-manuals/test-design";

// ============ Manual Registry（P11.3/79/80） ============

export async function loadTestDesignManuals(rootDir: string): Promise<TestDesignManualFile[]> {
  const dir = path.join(rootDir, MANUAL_DIR);
  if (!fs.pathExistsSync(dir)) return [];
  const manuals: TestDesignManualFile[] = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".md")) continue;
    const text = fs.readFileSync(path.join(dir, file), "utf8");
    // 解析 frontmatter
    const fmMatch = text.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) continue;
    const fm = yaml.parse(fmMatch[1]) as { manualId: string; version: string; appliesWhen?: string };
    // 提取 TD.XXX.YYY 规则 id
    const rules: ManualRuleRef[] = [];
    for (const line of text.split("\n")) {
      const m = line.match(/^##\s+(TD\.[A-Z]+\.[A-Z0-9_]+)\s+(.+)$/);
      if (m) {
        rules.push({ manualId: fm.manualId, ruleId: m[1], name: m[2], appliesWhen: fm.appliesWhen ?? "always", producesScenarioTypes: [] });
      }
    }
    manuals.push({ manualId: fm.manualId, version: fm.version, rules });
  }
  return manuals;
}

export function manualRuleRegistry(manuals: TestDesignManualFile[]): ManualRuleRef[] {
  return manuals.flatMap((m) => m.rules);
}

// ============ P11.7：TestDesignInput builder（从 requirement + knowledge store） ============

export async function buildTestDesignInputFromStore(rootDir: string, model: RequirementModel): Promise<TestDesignInput> {
  const kb = await loadKnowledgeStore(rootDir);
  const active = findBusinessKnowledge(kb, { status: "ACTIVE" });
  const knowledgeRefs = active.filter((k) => k.requirementRefs.includes(model.requirementId)).map((k) => k.knowledgeId);
  const facts: ApprovedRequirementFact[] = model.businessRules.map((r) => ({
    factId: r.ruleId, requirementId: model.requirementId, requirementVersion: model.version,
    factType: "BUSINESS_RULE", canonicalStatement: r.statement, structuredValue: { condition: r.condition, effect: r.effect },
    origin: r.origin, confidence: r.confidence, reviewStatus: "APPROVED",
    provenance: { sourceId: model.sourceId, sourceAnchor: r.statement, requirementVersion: model.version },
    isSecurity: /2fa|验证|kyc|security|提现/.test(r.statement), status: "APPROVED", createdAt: model.createdAt, updatedAt: model.updatedAt
  }));
  // 构建扩充版 TestDesignInput（P11.7 schema）
  return {
    testDesignInputId: `tdi_${model.requirementId}_${model.version}`,
    requirementId: model.requirementId,
    requirementVersion: model.version,
    requirementSummary: model.summary,
    approvedFacts: facts,
    acceptanceCriteria: model.acceptanceCriteria.map((a) => ({ acId: a.acId, statement: a.statement, origin: a.origin })),
    businessRules: model.businessRules.map((r) => ({ ruleId: r.ruleId, statement: r.statement, condition: r.condition, effect: r.effect, scope: r.scope, origin: r.origin })),
    states: model.states.map((s) => ({ entity: s.entity, fromState: s.fromState, toState: s.toState, trigger: s.trigger, explicitness: s.explicitness })),
    transitions: model.states.map((s) => ({ entity: s.entity, fromState: s.fromState, toState: s.toState, trigger: s.trigger })),
    dependencies: model.dependencies.map((d) => ({ sourceConcept: d.sourceConcept, relation: d.relation, targetConcept: d.targetConcept })),
    constraints: model.constraints.map((c) => ({ field: c.field, operator: c.operator, value: c.value, kind: c.kind })),
    securityRequirements: model.securityImplications.map((s) => ({ statement: s.description, domain: s.area })),
    affectedCapabilities: model.affectedCapabilities.map((c) => ({ capabilityId: c.capabilityId, match: c.match })),
    relevantBusinessKnowledgeRefs: knowledgeRefs,
    knownUnknowns: model.unknowns,
    resolvedAmbiguities: model.ambiguities.filter((a) => a.status === "RESOLVED").map((a) => a.ambiguityId),
    remainingNonBlockingAmbiguities: model.openQuestions.filter((q) => q.priority !== "BLOCKING").map((q) => q.questionId),
    riskSummary: model.risks.map((r) => ({ domain: r.domain, level: r.level })),
    contextFingerprint: model.contextReceipt?.contextFingerprint ?? "unknown",
    knowledgeSnapshotFingerprint: knowledgeVersionFingerprint(kb)
  };
}

// ============ P11.17：完整设计流程 ============

export interface TestDesignRunResult {
  input: TestDesignInput;
  obligations: TestCoverageObligation[];
  manualRulesApplied: Array<{ rule: ManualRuleRef; reason: string }>;
  candidates: TestDesignCandidate[];
  duplicateRemoved: string[];
  coverageMatrix: CoverageRow[];
  coverage: ReturnType<typeof obligationCoverage>;
  criticalCoverage: ReturnType<typeof criticalObligationCoverage>;
  securityCoverage: ReturnType<typeof securityObligationCoverage>;
  groundIssues: ReturnType<typeof validateCandidateGrounding>;
  knowledgeGaps: string[];
  readiness: ReturnType<typeof testDesignReadiness>;
  qualityGate: ReturnType<typeof testDesignQualityGate>;
  fingerprints: { context: string; knowledge: string; manual: string; prompt: string };
  /** P11.5-5：runtime preflight；缺失 critical context 时 blockedRun=true 且不产出 candidates。 */
  preflight?: TestDesignPreflightResult;
  blockedRun?: boolean;
}

export async function runTestDesign(rootDir: string, model: RequirementModel, options?: { maxCandidates?: number; preflight?: boolean; knowledge?: DesignKnowledgeEntry[] }): Promise<TestDesignRunResult> {
  const input = await buildTestDesignInputFromStore(rootDir, model);
  const obligations = buildCoverageObligations(input);
  const manuals = await loadTestDesignManuals(rootDir);
  const manualRulesApplied = selectTestDesignManualRules(input, manuals);
  const kb = await loadKnowledgeStore(rootDir);
  const knowledgeSnapshot = options?.knowledge ?? kb.knowledge.filter((k) => k.status === "ACTIVE").map((k) => ({ knowledgeId: k.knowledgeId, canonicalConcept: k.canonicalConcept, knowledgeType: k.knowledgeType }));

  // P11.5-5/20：TEST_DESIGN runtime 缺 critical context → BLOCK（内部 baseline 可显式关闭）
  if (options?.preflight !== false) {
    const preflight = await runTestDesignPreflight(rootDir, model);
    if (!preflight.pass) {
      return {
        input, obligations, manualRulesApplied, candidates: [], duplicateRemoved: [], coverageMatrix: [],
        coverage: { total: obligations.length, covered: 0, uncoveredIds: obligations.map((o) => o.obligationId), ratio: 0 },
        criticalCoverage: { covered: false, uncoveredIds: obligations.filter((o) => o.criticality === "CRITICAL").map((o) => o.obligationId) },
        securityCoverage: { covered: false, uncoveredIds: obligations.filter((o) => o.isSecurity).map((o) => o.obligationId) },
        groundIssues: [], knowledgeGaps: [],
        readiness: { status: "BLOCKED", blockingIssues: preflight.missing.map((m) => `missing critical context: ${m}`), warningIssues: [] },
        qualityGate: { status: "BLOCKED", blocking: preflight.missing.map((m) => `missing critical context: ${m}`), warnings: [] },
        fingerprints: { context: input.contextFingerprint, knowledge: knowledgeVersionFingerprint(kb), manual: TEST_DESIGN_MANUAL_VERSION, prompt: TEST_DESIGNER_PROMPT_VERSION },
        preflight, blockedRun: true
      };
    }
  }

  const designed = systematicDesigner(input, obligations, manualRulesApplied, { maxCandidates: options?.maxCandidates ?? 24, knowledge: knowledgeSnapshot });
  const { unique, removed } = dedupeCandidates(designed.candidates);
  const groundIssues = unique.flatMap((c) => validateCandidateGrounding(c));
  const coverageMatrix = buildCoverageMatrix(obligations, unique);
  const coverage = obligationCoverage(obligations, unique);
  const criticalCoverage = criticalObligationCoverage(obligations, unique);
  const securityCoverage = securityObligationCoverage(obligations, unique);
  const readiness = testDesignReadiness({ obligations, coveredObligationIds: coverageMatrix.filter((r) => r.coveredByCandidateIds.length).map((r) => r.factId), unsupportedCritical: 0, knowledgeGaps: designed.knowledgeGaps });
  const qualityGate = testDesignQualityGate({ readiness, unsupportedCritical: 0, invalidProvenance: groundIssues.length, preflightFail: false });
  const fingerprints = {
    context: model.contextReceipt?.contextFingerprint ?? "unknown",
    knowledge: knowledgeVersionFingerprint(kb),
    manual: TEST_DESIGN_MANUAL_VERSION,
    prompt: TEST_DESIGNER_PROMPT_VERSION
  };
  return { input, obligations, manualRulesApplied, candidates: unique, duplicateRemoved: removed, coverageMatrix, coverage, criticalCoverage, securityCoverage, groundIssues, knowledgeGaps: designed.knowledgeGaps, readiness, qualityGate, fingerprints };
}

// ============ P11.34/35：coverage repair（最多 1 pass） ============

export async function runTestDesignWithRepair(rootDir: string, model: RequirementModel, options?: { maxCandidates?: number; preflight?: boolean }): Promise<TestDesignRunResult & { repairAdded: number }> {
  const base = await runTestDesign(rootDir, model, { maxCandidates: options?.maxCandidates, preflight: options?.preflight });
  if (base.blockedRun) return { ...base, repairAdded: 0 };
  if (base.coverage.uncoveredIds.length === 0) return { ...base, repairAdded: 0 };
  // targeted repair：只给 uncovered obligations
  const uncovered = base.obligations.filter((o) => base.coverage.uncoveredIds.includes(o.obligationId));
  const { systematicDesignForObligations } = await import("./engine.js");
  const repair = systematicDesignForObligations(uncovered, base.candidates.length);
  const all = [...base.candidates, ...repair];
  const { unique } = dedupeCandidates(all);
  const coverage = obligationCoverage(base.obligations, unique);
  const criticalCoverage = criticalObligationCoverage(base.obligations, unique);
  const securityCoverage = securityObligationCoverage(base.obligations, unique);
  const coverageMatrix = buildCoverageMatrix(base.obligations, unique);
  const readiness = testDesignReadiness({ obligations: base.obligations, coveredObligationIds: coverageMatrix.filter((r) => r.coveredByCandidateIds.length).map((r) => r.factId), unsupportedCritical: 0, knowledgeGaps: base.knowledgeGaps });
  return { ...base, candidates: unique, coverage, criticalCoverage, securityCoverage, coverageMatrix, readiness, repairAdded: repair.length };
}
