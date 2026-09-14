/**
 * P11.8-11/13/24-33：Coverage Obligation Engine + Manual Applicability + Designer（deterministic）。
 *
 * obligations：从 AC/Rule/State/Dependency/Constraint/Security/Precondition/Postcondition/Capability 生成。
 * manual applicability：根据 obligation 类型 + knowledge 特征选择适用 manual 规则（不全量加载）。
 * designer（systematic pass）：为每个 obligation 生成 grounded scenario candidate。
 */

import type { Criticality, ObligationType, ScenarioType, SemanticAction, TestCoverageObligation, TestDesignCandidate, TestDesignInput } from "./types.js";
import { reviewReadinessFor, testScenarioSemanticKey } from "./types.js";

// ============ P11.8-11：obligation 生成 ============

export interface ObligationEngineInput {
  input: TestDesignInput;
  knowledgeAuthority?: (factId: string) => "REQUIREMENT_CONFIRMED" | "HUMAN_CONFIRMED" | "INFERRED";
}

function criticalityFor(input: TestDesignInput, type: ObligationType, text: string): Criticality {
  // 安全/资金/权限/状态破坏 → HIGH/CRITICAL
  if (/2fa|kyc|security|验证|白名单|权限|withdraw|提现|fund|资金|删除|delete/.test(text)) {
    return /2fa|kyc|security|验证|白名单|权限/.test(text) ? "CRITICAL" : "HIGH";
  }
  if (/INVALIDATES|失效|依赖/.test(text)) return "HIGH";
  if (type === "ACCEPTANCE_CRITERION") return "HIGH";
  if (type === "STATE_TRANSITION") return "MEDIUM";
  return "MEDIUM";
}

export function buildCoverageObligations(input: TestDesignInput): TestCoverageObligation[] {
  const obligations: TestCoverageObligation[] = [];
  const add = (source: string, type: ObligationType, subject: string, condition: string | undefined, expected: string | undefined, extra: Partial<TestCoverageObligation> = {}) => {
    const isSecurity = /2fa|kyc|security|验证|白名单|权限/.test(`${subject} ${expected ?? ""} ${condition ?? ""}`);
    const criticality = extra.criticality ?? criticalityFor(input, type, `${subject} ${expected ?? ""} ${condition ?? ""}`);
    obligations.push({
      obligationId: `OBL-${String(obligations.length + 1).padStart(3, "0")}`,
      source, type, subject, condition, expected, criticality,
      requiredScenarioTypes: extra.requiredScenarioTypes ?? requiredScenarioTypesFor(type, isSecurity, expected),
      provenance: { sourceId: input.requirementId, anchor: source },
      isSecurity: extra.isSecurity ?? isSecurity,
      manualRuleRefs: extra.manualRuleRefs
    });
  };

  // AC → obligation
  for (const ac of input.acceptanceCriteria) {
    add(ac.acId, "ACCEPTANCE_CRITERION", ac.statement, undefined, ac.statement, { requiredScenarioTypes: ["POSITIVE"] });
  }
  // Rule → obligation（condition/effect 结构化）
  for (const r of input.businessRules) {
    add(r.ruleId, "BUSINESS_RULE", r.statement, r.condition, r.effect, { requiredScenarioTypes: ["POSITIVE", "STATE_TRANSITION"] });
  }
  // State transition → obligation
  for (const st of input.states) {
    add(`${st.entity}:${st.fromState}->${st.toState}`, "STATE_TRANSITION", `${st.entity} ${st.fromState}->${st.toState}`, undefined, st.toState, { requiredScenarioTypes: ["STATE_TRANSITION"] });
  }
  // Dependency → obligation
  for (const d of input.dependencies) {
    add(`${d.sourceConcept}-${d.relation}-${d.targetConcept}`, "DEPENDENCY", `${d.sourceConcept} ${d.relation} ${d.targetConcept}`, undefined, d.targetConcept, { requiredScenarioTypes: ["DEPENDENCY"] });
  }
  // Constraint → obligation
  for (const c of input.constraints) {
    add(`constraint:${c.field}`, "CONSTRAINT", `${c.field} ${c.operator ?? ""} ${c.value ?? ""}`, c.operator ? `${c.field} ${c.operator} ${c.value}` : undefined, `validation of ${c.field}`, { requiredScenarioTypes: ["BOUNDARY", "NEGATIVE"] });
  }
  // Security requirement → obligation
  for (const s of input.securityRequirements) {
    add(s.statement, "SECURITY", s.statement, undefined, undefined, { isSecurity: true, criticality: "CRITICAL", requiredScenarioTypes: ["SECURITY"] });
  }
  // Precondition/Postcondition（来自 approved facts）
  for (const f of input.approvedFacts) {
    if (f.factType === "PRECONDITION") add(f.factId, "PRECONDITION", f.canonicalStatement, undefined, "precondition holds", { requiredScenarioTypes: ["POSITIVE"] });
    if (f.factType === "POSTCONDITION") add(f.factId, "POSTCONDITION", f.canonicalStatement, undefined, f.canonicalStatement, { requiredScenarioTypes: ["POSITIVE", "PERSISTENCE"] });
  }
  // Capability change
  for (const cap of input.affectedCapabilities) {
    if (cap.match === "NEW_CAPABILITY" || cap.match === "MATCHED") {
      add(cap.capabilityId, "CAPABILITY", cap.capabilityId, undefined, "capability functions", { requiredScenarioTypes: ["POSITIVE"] });
    }
  }
  return obligations;
}

function requiredScenarioTypesFor(type: ObligationType, isSecurity: boolean, expected?: string): ScenarioType[] {
  switch (type) {
    case "BUSINESS_RULE": return ["POSITIVE", "STATE_TRANSITION"];
    case "STATE_TRANSITION": return ["STATE_TRANSITION"];
    case "DEPENDENCY": return ["DEPENDENCY"];
    case "CONSTRAINT": return ["BOUNDARY", "NEGATIVE"];
    case "SECURITY": return ["SECURITY"];
    case "ACCEPTANCE_CRITERION": return ["POSITIVE"];
    default: return ["POSITIVE"];
  }
}

// ============ P11.13：Manual Applicability ============

export interface ManualRuleRef {
  manualId: string;
  ruleId: string;   // e.g. TD.BOUNDARY.NUMERIC.MIN
  name: string;
  appliesWhen: string;
  producesScenarioTypes: ScenarioType[];
}

export interface TestDesignManualFile {
  manualId: string;
  version: string;
  rules: ManualRuleRef[];
}

export function selectTestDesignManualRules(input: TestDesignInput, manuals: TestDesignManualFile[]): Array<{ rule: ManualRuleRef; reason: string }> {
  const selected: Array<{ rule: ManualRuleRef; reason: string }> = [];
  const allRules = manuals.flatMap((m) => m.rules);
  const hasNumericConstraint = input.constraints.some((c) => c.kind === "amount" || c.kind === "other");
  const hasStringLength = input.constraints.some((c) => c.field === "maxLength");
  const hasState = input.states.length > 0;
  const hasDependency = input.dependencies.length > 0;
  const hasSecurity = input.securityRequirements.length > 0 || input.riskSummary.some((r) => r.level === "HIGH");
  const hasForm = input.approvedFacts.some((f) => f.factType === "CONSTRAINT") || input.constraints.length > 0;
  const hasFilter = /筛选|filter|查询|列表|list/i.test(input.requirementSummary);
  const hasDelete = /删除|delete|重置|reset/.test(input.requirementSummary);

  for (const r of allRules) {
    let reason = "";
    if (r.ruleId.startsWith("TD.BOUNDARY") && (hasNumericConstraint || hasStringLength)) reason = "numeric/string constraint present";
    if (r.ruleId.startsWith("TD.STATE") && hasState) reason = "state transitions present";
    if (r.ruleId.startsWith("TD.DEP") && hasDependency) reason = "dependencies present";
    if (r.ruleId.startsWith("TD.SEC") && hasSecurity) reason = "security requirement present";
    if (r.ruleId.startsWith("TD.FORM") && hasForm) reason = "form fields present";
    if (r.ruleId.startsWith("TD.LIST") && hasFilter) reason = "filter/list present";
    if (r.ruleId.startsWith("TD.CORE")) reason = "core always applies";
    if (r.ruleId.includes("CONFIRMATION") && hasDelete) reason = "destructive action present";
    if (reason) selected.push({ rule: r, reason });
  }
  return selected;
}

// ============ P11.14/24-33：systematic designer（deterministic 第一版） ============

export interface DesignerResult {
  candidates: TestDesignCandidate[];
  coveredObligationIds: string[];
  knowledgeGaps: string[];
}

export function systematicDesigner(input: TestDesignInput, obligations: TestCoverageObligation[], manualRules: Array<{ rule: ManualRuleRef; reason: string }>, options?: { maxCandidates?: number; knowledge?: DesignKnowledgeEntry[] }): DesignerResult {
  const candidates: TestDesignCandidate[] = [];
  const covered = new Set<string>();
  const gaps: string[] = [];
  const maxCandidates = options?.maxCandidates ?? 24;
  const knowledge = options?.knowledge;
  const now = new Date().toISOString();

  // 按 criticality 排序（CRITICAL > HIGH > MEDIUM > LOW）
  const rank: Record<Criticality, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
  const sorted = [...obligations].sort((a, b) => rank[a.criticality] - rank[b.criticality]);

  for (const obl of sorted) {
    if (candidates.length >= maxCandidates) break;
    const grounding = (kind: "KNOWLEDGE" | "REQUIREMENT" | "MANUAL", id: string) =>
      kind === "MANUAL" ? { kind: "MANUAL" as const, manualRuleId: id } : kind === "KNOWLEDGE" ? { kind: "KNOWLEDGE" as const, knowledgeId: id } : { kind: "REQUIREMENT" as const, factId: id };
    const manualRule = manualRules[0]?.rule;

    // 为每种 required scenario type 生成一个 candidate（合并到 1 个主 candidate）
    const primaryType = obl.requiredScenarioTypes[0] ?? "POSITIVE";
    const actionFor = (): SemanticAction => {
      if (obl.type === "SECURITY") return "VERIFY_STATE";
      if (obl.type === "DEPENDENCY") return "VERIFY_STATE";
      if (obl.type === "STATE_TRANSITION") return "VERIFY_STATE";
      if (/submit|提交|提现|withdraw|确认/.test(obl.subject)) return "SUBMIT_WITHDRAWAL";
      if (/filter|筛选|查询/.test(obl.subject)) return "APPLY_FILTER";
      if (/删除|delete|重置|reset/.test(obl.subject)) return "CONFIRM";
      return "OTHER";
    };

    // P11.5-10：缺 expected 且非 security → 查 knowledge；查不到 = KNOWLEDGE_GAP（不得脑补）
    if (!obl.expected && obl.type !== "SECURITY") {
      const kb = findKnowledgeForObligation(obl, knowledge);
      if (kb) {
        const c: TestDesignCandidate = {
          candidateId: `TC-${String(candidates.length + 1).padStart(3, "0")}`,
          requirementId: input.requirementId,
          title: `${obl.subject.slice(0, 40)} (${primaryType})`,
          objective: obl.subject,
          scenarioType: primaryType,
          preconditions: [{ statement: obl.condition ?? "default precondition", grounding: grounding("REQUIREMENT", obl.source) }],
          semanticActions: [{ action: actionFor(), target: obl.subject, grounding: grounding("REQUIREMENT", obl.source) }],
          expectedOutcomes: [{ statement: kb.canonicalConcept, grounding: grounding("KNOWLEDGE", kb.knowledgeId) }],
          testDataRequirements: [],
          coveredObligationIds: [obl.obligationId],
          coveredBusinessRuleIds: obl.type === "BUSINESS_RULE" ? [obl.source] : [],
          coveredACIds: obl.type === "ACCEPTANCE_CRITERION" ? [obl.source] : [],
          coveredCapabilityIds: [],
          risk: { designPriority: obl.criticality === "CRITICAL" ? "CRITICAL" : obl.criticality === "HIGH" ? "HIGH" : "MEDIUM", executionRisk: obl.isSecurity ? "HIGH" : "MEDIUM" },
          knowledgeRefs: [kb.knowledgeId], manualRuleRefs: manualRule ? [manualRule.ruleId] : [], manualVersions: {},
          assumptions: [], origin: "SYSTEMATIC", confidence: "HIGH", reviewStatus: "AUTO_REVIEWABLE",
          testability: "EXECUTION_PATH_UNKNOWN",
          provenance: [{ reason: `obligation ${obl.obligationId} (${obl.type}) grounded by knowledge`, source: obl.source }],
          status: "DRAFT", semanticKey: "", createdAt: now
        };
        c.semanticKey = testScenarioSemanticKey(c);
        candidates.push(c);
        covered.add(obl.obligationId);
        continue;
      }
      gaps.push(`KNOWLEDGE_GAP: ${obl.obligationId} (${obl.type}) 无明确 expected outcome`);
      const gapCandidate: TestDesignCandidate = {
        candidateId: `TC-${String(candidates.length + 1).padStart(3, "0")}`,
        requirementId: input.requirementId,
        title: `待补充业务知识：${obl.subject.slice(0, 40)}`,
        objective: obl.subject,
        scenarioType: primaryType,
        preconditions: [{ statement: obl.condition ?? "default precondition", grounding: grounding("REQUIREMENT", obl.source) }],
        semanticActions: [{ action: actionFor(), target: obl.subject, grounding: grounding("REQUIREMENT", obl.source) }],
        expectedOutcomes: [],
        testDataRequirements: [],
        coveredObligationIds: [obl.obligationId],
        coveredBusinessRuleIds: obl.type === "BUSINESS_RULE" ? [obl.source] : [],
        coveredACIds: obl.type === "ACCEPTANCE_CRITERION" ? [obl.source] : [],
        coveredCapabilityIds: [],
        risk: { designPriority: obl.criticality === "CRITICAL" ? "CRITICAL" : obl.criticality === "HIGH" ? "HIGH" : "MEDIUM", executionRisk: obl.isSecurity ? "HIGH" : "MEDIUM" },
        knowledgeRefs: [], manualRuleRefs: manualRule ? [manualRule.ruleId] : [], manualVersions: {},
        assumptions: [`${obl.obligationId} 缺少 expected outcome，需业务确认`],
        origin: "SYSTEMATIC", confidence: "LOW", reviewStatus: "NEEDS_BUSINESS_REVIEW",
        testability: "BLOCKED_BY_KNOWLEDGE",
        provenance: [{ reason: `obligation ${obl.obligationId} (${obl.type}) knowledge gap`, source: obl.source }],
        status: "NEEDS_REVIEW", semanticKey: "", createdAt: now
      };
      gapCandidate.semanticKey = testScenarioSemanticKey(gapCandidate);
      candidates.push(gapCandidate);
      covered.add(obl.obligationId);
      continue;
    }

    // P11.5-9：expected 优先 ground 到真实 knowledge（KB ablation 可测）；否则 requirement 自身事实
    const kbMatch = obl.type === "SECURITY" || !obl.expected ? findKnowledgeForObligation(obl, knowledge) : undefined;
    const statement = obl.expected ?? obl.subject;
    const expectedGrounding = kbMatch ? grounding("KNOWLEDGE", kbMatch.knowledgeId) : grounding("REQUIREMENT", obl.source);
    const candidate: TestDesignCandidate = {
      candidateId: `TC-${String(candidates.length + 1).padStart(3, "0")}`,
      requirementId: input.requirementId,
      title: `${obl.subject.slice(0, 40)} (${primaryType})`,
      objective: obl.subject,
      scenarioType: primaryType,
      preconditions: [{ statement: obl.condition ?? "default precondition", grounding: grounding("REQUIREMENT", obl.source) }],
      semanticActions: [{ action: actionFor(), target: obl.subject, grounding: grounding("REQUIREMENT", obl.source) }],
      expectedOutcomes: [{ statement, grounding: expectedGrounding }],
      testDataRequirements: [],
      coveredObligationIds: [obl.obligationId],
      coveredBusinessRuleIds: obl.type === "BUSINESS_RULE" ? [obl.source] : [],
      coveredACIds: obl.type === "ACCEPTANCE_CRITERION" ? [obl.source] : [],
      coveredCapabilityIds: [],
      risk: { designPriority: obl.criticality === "CRITICAL" ? "CRITICAL" : obl.criticality === "HIGH" ? "HIGH" : "MEDIUM", executionRisk: obl.isSecurity ? "HIGH" : "MEDIUM" },
      knowledgeRefs: kbMatch ? [kbMatch.knowledgeId] : [],
      manualRuleRefs: manualRule ? [manualRule.ruleId] : [],
      manualVersions: {},
      assumptions: [],
      origin: "SYSTEMATIC",
      confidence: obl.isSecurity ? "LOW" : "HIGH",
      reviewStatus: obl.isSecurity ? "NEEDS_SECURITY_REVIEW" : "AUTO_REVIEWABLE",
      testability: "EXECUTION_PATH_UNKNOWN",
      provenance: [{ reason: `obligation ${obl.obligationId} (${obl.type})`, source: obl.source }],
      status: obl.isSecurity ? "NEEDS_REVIEW" : "DRAFT",
      semanticKey: "",
      createdAt: now
    };
    candidate.semanticKey = testScenarioSemanticKey(candidate);
    candidates.push(candidate);
    covered.add(obl.obligationId);

    // P11.18/27：互补场景——rule/security 反向路径（如"不需要 2FA"→"需要 2FA"；KYC 前提未满足）
    const complement = complementaryScenario(obl, input, candidates.length, now);
    if (complement) {
      candidates.push(complement);
    }

    // P11.5-6：manual 驱动测试技术候选（生命周期/非法状态/低于下限/验证流程）
    for (const extra of manualTechniqueCandidates(obl, manualRules, input, candidates.length, now)) {
      if (candidates.length >= maxCandidates) break;
      candidates.push(extra);
    }
  }

  return { candidates, coveredObligationIds: [...covered], knowledgeGaps: gaps };
}

/** P11.27/30：生成互补场景（规则反向路径 / 前提未满足）。 */
function complementaryScenario(obl: TestCoverageObligation, input: TestDesignInput, index: number, now: string): TestDesignCandidate | undefined {
  const exp = obl.expected ?? "";
  const subj = obl.subject;
  // 安全豁免反向："不需要 2FA" → 反向"需要 2FA"（非豁免路径）
  if (obl.isSecurity && /not.*required|不需要|无需|not.*2fa|no.?verif|免验证/.test(`${exp} ${subj}`)) {
    const c: TestDesignCandidate = {
      candidateId: `TC-${String(index + 1).padStart(3, "0")}`,
      requirementId: input.requirementId,
      title: `非豁免路径：${subj.slice(0, 40)} 需 2FA`,
      objective: `${subj} 非豁免路径`,
      scenarioType: "SECURITY",
      preconditions: [{ statement: "未启用免验证", grounding: { kind: "TESTING_TECHNIQUE", note: "豁免反向路径" } }],
      semanticActions: [{ action: "SUBMIT_WITHDRAWAL", target: subj, grounding: { kind: "REQUIREMENT", factId: obl.source } }],
      expectedOutcomes: [{ statement: "google2FA.required = true（非豁免地址需 2FA）", grounding: { kind: "KNOWLEDGE", knowledgeId: obl.source } }],
      testDataRequirements: [{ dimension: "permission", value: "NOT_WHITELIST" }],
      coveredObligationIds: [obl.obligationId],
      coveredBusinessRuleIds: obl.type === "BUSINESS_RULE" ? [obl.source] : [],
      coveredACIds: [],
      coveredCapabilityIds: [],
      risk: { designPriority: "CRITICAL", executionRisk: "HIGH" },
      knowledgeRefs: [], manualRuleRefs: ["TD.SEC.02"], manualVersions: {},
      assumptions: [], origin: "SYSTEMATIC", confidence: "LOW",
      reviewStatus: "NEEDS_SECURITY_REVIEW",
      testability: "EXECUTION_PATH_UNKNOWN",
      provenance: [{ reason: `complementary of ${obl.obligationId} (security exemption reverse)`, source: obl.source }],
      status: "NEEDS_REVIEW", semanticKey: "", createdAt: now
    };
    c.semanticKey = testScenarioSemanticKey(c);
    return c;
  }
  // KYC 前提未满足：前提是 KYC → 反向"未完成 KYC 被拦"
  if (/KYC|实名/.test(subj) && /完成|后|才能|前提/.test(subj)) {
    const c: TestDesignCandidate = {
      candidateId: `TC-${String(index + 1).padStart(3, "0")}`,
      requirementId: input.requirementId,
      title: `未完成 KYC 被拦截：${subj.slice(0, 30)}`,
      objective: "未完成 KYC 时受限",
      scenarioType: "SECURITY",
      preconditions: [{ statement: "未完成 KYC", grounding: { kind: "TESTING_TECHNIQUE", note: "KYC 前提反向" } }],
      semanticActions: [{ action: "SUBMIT_WITHDRAWAL", target: subj, grounding: { kind: "REQUIREMENT", factId: obl.source } }],
      expectedOutcomes: [{ statement: "KYC 提示/操作被拦截", grounding: { kind: "REQUIREMENT", factId: obl.source } }],
      testDataRequirements: [{ dimension: "KYC", value: "NOT_COMPLETED" }],
      coveredObligationIds: [obl.obligationId],
      coveredBusinessRuleIds: [], coveredACIds: [], coveredCapabilityIds: [],
      risk: { designPriority: "CRITICAL", executionRisk: "HIGH" },
      knowledgeRefs: [], manualRuleRefs: ["TD.SEC.02"], manualVersions: {},
      assumptions: [], origin: "SYSTEMATIC", confidence: "MEDIUM",
      reviewStatus: "NEEDS_SECURITY_REVIEW",
      testability: "EXECUTION_PATH_UNKNOWN",
      provenance: [{ reason: `complementary of ${obl.obligationId} (KYC precondition reverse)`, source: obl.source }],
      status: "NEEDS_REVIEW", semanticKey: "", createdAt: now
    };
    c.semanticKey = testScenarioSemanticKey(c);
    return c;
  }
  // 白名单权限反向：仅白名单可 → 普通用户不可
  if (/白名单|whitelist|仅.*可/.test(subj)) {
    const c: TestDesignCandidate = {
      candidateId: `TC-${String(index + 1).padStart(3, "0")}`,
      requirementId: input.requirementId,
      title: `普通用户不可：${subj.slice(0, 30)}`,
      objective: "普通用户权限反向",
      scenarioType: "PERMISSION",
      preconditions: [{ statement: "普通用户（非白名单）", grounding: { kind: "TESTING_TECHNIQUE", note: "permission reverse" } }],
      semanticActions: [{ action: "ENABLE_FEATURE", target: subj, grounding: { kind: "REQUIREMENT", factId: obl.source } }],
      expectedOutcomes: [{ statement: "无权限提示", grounding: { kind: "REQUIREMENT", factId: obl.source } }],
      testDataRequirements: [{ dimension: "permission", value: "NORMAL_USER" }],
      coveredObligationIds: [obl.obligationId],
      coveredBusinessRuleIds: [], coveredACIds: [], coveredCapabilityIds: [],
      risk: { designPriority: "HIGH", executionRisk: "MEDIUM" },
      knowledgeRefs: [], manualRuleRefs: ["TD.SEC.02"], manualVersions: {},
      assumptions: [], origin: "SYSTEMATIC", confidence: "MEDIUM",
      reviewStatus: "AUTO_REVIEWABLE",
      testability: "EXECUTION_PATH_UNKNOWN",
      provenance: [{ reason: `complementary of ${obl.obligationId} (permission reverse)`, source: obl.source }],
      status: "DRAFT", semanticKey: "", createdAt: now
    };
    c.semanticKey = testScenarioSemanticKey(c);
    return c;
  }
  return undefined;
}

// ============ P11.5-6/9：Knowledge lookup + Manual 驱动行为 ============

export interface DesignKnowledgeEntry {
  knowledgeId: string;
  canonicalConcept: string;
  knowledgeType?: string;
}

/** 关键词交集匹配：obligation subject 与 knowledge 概念是否有共现词。 */
export function findKnowledgeForObligation(obl: TestCoverageObligation, knowledge: DesignKnowledgeEntry[] | undefined): DesignKnowledgeEntry | undefined {
  if (!knowledge || knowledge.length === 0) return undefined;
  const tokens = (obl.subject + " " + (obl.expected ?? "")).split(/[，。；、\s:：|]+/).filter((t) => t.length >= 2);
  let best: { entry: DesignKnowledgeEntry; score: number } | undefined;
  for (const k of knowledge) {
    let score = 0;
    for (const t of tokens) {
      if (k.canonicalConcept.includes(t)) score += 2;
      else if (/[\u4e00-\u9fa5]/.test(t) && k.canonicalConcept.includes(t.slice(0, Math.min(4, t.length)))) score += 1;
    }
    if (score > 0 && (!best || score > best.score)) best = { entry: k, score };
  }
  return best?.entry;
}

export const DEPENDENCY_LIFECYCLE_PHASES = ["before", "transition", "after", "re-entry"];

/**
 * P11.5-6：manual 规则必须改变设计行为（不只是 manualRuleRefs）。
 * 命中规则时产生对应测试技术的候选；Expected Behavior 仍来自 obligation/knowledge。
 */
export function manualTechniqueCandidates(obl: TestCoverageObligation, manualRules: Array<{ rule: ManualRuleRef; reason: string }>, input: TestDesignInput, index: number, now: string): TestDesignCandidate[] {
  const ids = new Set(manualRules.map((m) => m.rule.ruleId));
  const extra: TestDesignCandidate[] = [];
  const rank: Record<Criticality, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
  const push = (c: TestDesignCandidate) => { c.semanticKey = testScenarioSemanticKey(c); extra.push(c); };

  // TD.DEP.01 DEPENDENCY_LIFECYCLE：依赖生命周期 before→transition→after→re-entry
  if (obl.type === "DEPENDENCY" && ids.has("TD.DEP.01")) {
    const c: TestDesignCandidate = {
      candidateId: `TC-${String(index + extra.length + 1).padStart(3, "0")}`,
      requirementId: input.requirementId,
      title: `生命周期 ${obl.subject.slice(0, 30)} (before→transition→after→re-entry)`,
      objective: `生命周期: ${obl.subject}`,
      scenarioType: "STATE_TRANSITION",
      preconditions: DEPENDENCY_LIFECYCLE_PHASES.map((p) => ({ statement: p, grounding: { kind: "REQUIREMENT", factId: obl.source } })),
      semanticActions: [{ action: "VERIFY_STATE", target: obl.subject, grounding: { kind: "REQUIREMENT", factId: obl.source } }],
      expectedOutcomes: [{ statement: obl.expected ?? `dependency lifecycle of ${obl.subject}`, grounding: { kind: "REQUIREMENT", factId: obl.source } }],
      testDataRequirements: [{ dimension: "state", value: DEPENDENCY_LIFECYCLE_PHASES.join("→") }],
      coveredObligationIds: [obl.obligationId],
      coveredBusinessRuleIds: [], coveredACIds: [], coveredCapabilityIds: [],
      risk: { designPriority: rank[obl.criticality] <= 1 ? "HIGH" : "MEDIUM", executionRisk: obl.isSecurity ? "HIGH" : "MEDIUM" },
      knowledgeRefs: [], manualRuleRefs: ["TD.DEP.01"], manualVersions: {},
      assumptions: [], origin: "SYSTEMATIC", confidence: "HIGH", reviewStatus: "AUTO_REVIEWABLE",
      testability: "EXECUTION_PATH_UNKNOWN",
      provenance: [{ reason: "manual technique TD.DEP.01 dependency lifecycle", source: obl.source }],
      status: "DRAFT", semanticKey: "", createdAt: now
    };
    push(c);
  }

  // TD.STATE.02 STATE_INVALIDATION：非法状态变更被拦截
  if (obl.type === "STATE_TRANSITION" && ids.has("TD.STATE.02")) {
    const c: TestDesignCandidate = {
      candidateId: `TC-${String(index + extra.length + 1).padStart(3, "0")}`,
      requirementId: input.requirementId,
      title: `非法状态变更被拦截：${obl.subject.slice(0, 40)}`,
      objective: `非法状态变更被拦截: ${obl.subject}`,
      scenarioType: "NEGATIVE",
      preconditions: [{ statement: `${obl.subject} 未满足合法变更条件`, grounding: { kind: "REQUIREMENT", factId: obl.source } }],
      semanticActions: [{ action: "VERIFY_STATE", target: obl.subject, grounding: { kind: "REQUIREMENT", factId: obl.source } }],
      expectedOutcomes: [{ statement: `非法状态变更被拦截（${obl.expected ?? obl.subject}）`, grounding: { kind: "REQUIREMENT", factId: obl.source } }],
      testDataRequirements: [],
      coveredObligationIds: [obl.obligationId],
      coveredBusinessRuleIds: [], coveredACIds: [], coveredCapabilityIds: [],
      risk: { designPriority: rank[obl.criticality] <= 1 ? "HIGH" : "MEDIUM", executionRisk: "MEDIUM" },
      knowledgeRefs: [], manualRuleRefs: ["TD.STATE.02"], manualVersions: {},
      assumptions: [], origin: "SYSTEMATIC", confidence: "HIGH", reviewStatus: "AUTO_REVIEWABLE",
      testability: "EXECUTION_PATH_UNKNOWN",
      provenance: [{ reason: "manual technique TD.STATE.02 state invalidation", source: obl.source }],
      status: "DRAFT", semanticKey: "", createdAt: now
    };
    push(c);
  }

  // TD.BOUNDARY.01 NUMERIC_MIN_MAX：金额约束 → min / below-min
  if (obl.type === "CONSTRAINT" && ids.has("TD.BOUNDARY.01") && /min|最小|下限/.test(obl.subject)) {
    const c: TestDesignCandidate = {
      candidateId: `TC-${String(index + extra.length + 1).padStart(3, "0")}`,
      requirementId: input.requirementId,
      title: `低于下限：${obl.subject.slice(0, 40)}`,
      objective: `低于下限: ${obl.subject}`,
      scenarioType: "BOUNDARY",
      preconditions: [{ statement: obl.condition ?? obl.subject, grounding: { kind: "REQUIREMENT", factId: obl.source } }],
      semanticActions: [{ action: "SET_FIELD", target: obl.subject, grounding: { kind: "REQUIREMENT", factId: obl.source } }],
      expectedOutcomes: [{ statement: obl.expected ?? `validation of ${obl.subject}`, grounding: { kind: "REQUIREMENT", factId: obl.source } }],
      testDataRequirements: [{ dimension: "amount", value: "BELOW_MIN" }],
      coveredObligationIds: [obl.obligationId],
      coveredBusinessRuleIds: [], coveredACIds: [], coveredCapabilityIds: [],
      risk: { designPriority: "HIGH", executionRisk: "MEDIUM" },
      knowledgeRefs: [], manualRuleRefs: ["TD.BOUNDARY.01"], manualVersions: {},
      assumptions: [], origin: "SYSTEMATIC", confidence: "HIGH", reviewStatus: "AUTO_REVIEWABLE",
      testability: "EXECUTION_PATH_UNKNOWN",
      provenance: [{ reason: "manual technique TD.BOUNDARY.01 below-min", source: obl.source }],
      status: "DRAFT", semanticKey: "", createdAt: now
    };
    push(c);
  }

  // TD.SEC.02 VERIFICATION_FLOW：安全 obligation → 验证流程（提交→验证→确认）
  if (obl.type === "SECURITY" && ids.has("TD.SEC.02")) {
    const c: TestDesignCandidate = {
      candidateId: `TC-${String(index + extra.length + 1).padStart(3, "0")}`,
      requirementId: input.requirementId,
      title: `验证流程：${obl.subject.slice(0, 40)}`,
      objective: `验证流程: ${obl.subject}`,
      scenarioType: "SECURITY",
      preconditions: [{ statement: obl.subject, grounding: { kind: "REQUIREMENT", factId: obl.source } }],
      semanticActions: [
        { action: "SUBMIT_WITHDRAWAL", target: obl.subject, grounding: { kind: "REQUIREMENT", factId: obl.source } },
        { action: "VERIFY_STATE", target: `${obl.subject} 验证`, grounding: { kind: "REQUIREMENT", factId: obl.source } },
        { action: "CONFIRM", target: `${obl.subject} 确认`, grounding: { kind: "REQUIREMENT", factId: obl.source } }
      ],
      expectedOutcomes: [{ statement: obl.subject, grounding: { kind: "REQUIREMENT", factId: obl.source } }],
      testDataRequirements: [{ dimension: "security", value: "2FA_ENABLED" }],
      coveredObligationIds: [obl.obligationId],
      coveredBusinessRuleIds: [], coveredACIds: [], coveredCapabilityIds: [],
      risk: { designPriority: "CRITICAL", executionRisk: "HIGH" },
      knowledgeRefs: [], manualRuleRefs: ["TD.SEC.02"], manualVersions: {},
      assumptions: [], origin: "SYSTEMATIC", confidence: "MEDIUM", reviewStatus: "NEEDS_SECURITY_REVIEW",
      testability: "EXECUTION_PATH_UNKNOWN",
      provenance: [{ reason: "manual technique TD.SEC.02 verification flow", source: obl.source }],
      status: "NEEDS_REVIEW", semanticKey: "", createdAt: now
    };
    push(c);
  }

  return extra;
}
