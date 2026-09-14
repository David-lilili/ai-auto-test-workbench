import { round } from "./modeling-quality-metrics.js";

/**
 * P7.13：DSL Semantic Completeness。
 *
 * 不能只看 READY/PASS。用户需求期望的 intent operations 与物化 DSL steps 按语义比较：
 *
 *   FULL      —— 覆盖全部 expected operations
 *   PARTIAL   —— 覆盖大部分但缺 1-2 个关键操作
 *   SHALLOW   —— 只有 navigate/基础观察，缺核心业务操作
 *   MISMATCH  —— DSL 动作与期望 intent 不一致
 */

export type CompletenessVerdict = "FULL" | "PARTIAL" | "SHALLOW" | "MISMATCH";

export interface DslCompletenessInput {
  request: string;
  expectedIntent: string; // 语义操作集合描述（如 "open+filter+assert"）
  expectedOperations: string[];
  materializedActions: string[]; // DSL step 的 action 列表
}

export interface DslCompletenessResult {
  verdict: CompletenessVerdict;
  expectedOperations: string[];
  materializedOperations: string[];
  coveredOperations: string[];
  missingOperations: string[];
  score: number; // 0-1
}

/** action 语义 → 标准操作（确定性映射）。 */
function actionToOperation(action: string): string {
  const a = String(action ?? "").toLowerCase();
  if (a === "navigate" || a === "open" || a === "goto") return "open";
  if (a === "click") return "click";
  if (a === "input" || a === "fill" || a === "type") return "input";
  if (a === "select" || a === "choose" || a === "select_option") return "select";
  if (a === "assert" || a === "assert_visible" || a === "verify") return "assert";
  if (a === "tab" || a === "switch_tab") return "tab";
  if (a === "modal" || a === "open_modal") return "modal";
  if (a === "setDateRange" || a === "date_range") return "date_range";
  if (a === "filter" || a === "apply_filter") return "filter";
  return a;
}

/** expectedIntent 描述串 → 标准操作集。 */
export function parseExpectedOperations(expectedIntent: string): string[] {
  const normalized = String(expectedIntent ?? "").toLowerCase().replace(/[^a-z_+]/g, " ");
  const tokens = normalized.split(/[\s+]+/).filter(Boolean);
  const map: Record<string, string> = {
    open: "open", view: "open", navigate: "open",
    filter: "filter", select: "select", choose: "select",
    input: "input", fill: "input",
    assert: "assert", verify: "assert", check: "assert",
    tab: "tab", modal: "modal", date: "date_range",
    click: "click"
  };
  return [...new Set(tokens.map((t) => map[t] ?? t).filter(Boolean))];
}

export function computeDslCompleteness(input: DslCompletenessInput): DslCompletenessResult {
  const expected = input.expectedOperations.length ? input.expectedOperations : parseExpectedOperations(input.expectedIntent);
  const materialized = [...new Set(input.materializedActions.map(actionToOperation).filter(Boolean))];

  const covered = expected.filter((op) => materialized.includes(op));
  const missing = expected.filter((op) => !materialized.includes(op));
  const score = expected.length ? covered.length / expected.length : 0;

  let verdict: CompletenessVerdict;
  if (expected.length === 0) verdict = "FULL";
  else if (missing.length === 0) verdict = "FULL";
  else if (score >= 0.5 && !missing.includes("open")) verdict = "PARTIAL";
  else if (materialized.length <= 1 && !materialized.includes("assert")) verdict = "SHALLOW";
  else verdict = "PARTIAL";

  // MISMATCH：期望有 assert 但物化完全没有 assert 类操作
  if (expected.includes("assert") && !materialized.includes("assert") && score < 0.5) verdict = "SHALLOW";

  return { verdict, expectedOperations: expected, materializedOperations: materialized, coveredOperations: covered, missingOperations: missing, score: round(score) };
}

// ============ P7.18：Model Readiness L0-L5 ============

export type ReadinessLevel = "L0_DISCOVERED" | "L1_STRUCTURAL" | "L2_DSL_MATERIALIZABLE" | "L3_EXECUTION_CAPABLE" | "L4_REGRESSION_READY" | "L5_TRUSTED";

export interface ReadinessInput {
  pageIdentityKnown: boolean;
  elementCount: number;
  hasControlType: boolean;
  dslReady: boolean;
  dslPassCount: number;
  executionEvidenceCount: number;
  coverageVerified: number; // 核心 capability 覆盖数
  benchmarkPassed: boolean;
  freshnessDays: number;
}

export function computeModelReadiness(input: ReadinessInput): { level: ReadinessLevel; reasons: string[] } {
  const reasons: string[] = [];
  if (!input.pageIdentityKnown) return { level: "L0_DISCOVERED", reasons: ["URL/identity 已知但无模型"] };
  if (input.elementCount === 0 || !input.hasControlType) {
    reasons.push("基础 element/control 已建模");
    return { level: "L1_STRUCTURAL", reasons: [...reasons, "尚未达到 DSL 物化所需证据"] };
  }
  // L2：结构完成但 DSL 尚未可执行
  if (!input.dslReady || input.dslPassCount < 1) {
    reasons.push("结构建模完成");
    return { level: "L2_DSL_MATERIALIZABLE", reasons: [...reasons, "DSL 可生成但尚未实跑通过"] };
  }
  // L3：至少一组核心 DSL 实跑通过
  if (input.coverageVerified < 2 || input.executionEvidenceCount < 3) {
    reasons.push("核心 DSL 实跑通过");
    return { level: "L3_EXECUTION_CAPABLE", reasons: [...reasons, "需稳定 coverage + 更多执行证据"] };
  }
  // L4：核心 capabilities 有稳定 coverage
  if (!input.benchmarkPassed || input.freshnessDays > 14) {
    reasons.push("核心 capabilities 有稳定 coverage");
    return { level: "L4_REGRESSION_READY", reasons: [...reasons, "需 benchmark + freshness 达标"] };
  }
  return { level: "L5_TRUSTED", reasons: ["通过 benchmark + freshness + execution history"] };
}

// ============ P7.17：Quality Gate ============

export interface QualityGateInput {
  highForbiddenExecutions: number;
  identityDuplicateCreation: number;
  directWriteViolations: number;
  criticalFalsePositives: number;
  wrongBusinessActions: number;
  elementRecall: number;
  controlTypeAccuracy: number;
  assertionRecall: number;
  optionRecall: number;
}

export type GateStatus = "BLOCKED" | "WARNING" | "PASS";

export interface QualityGateResult {
  status: GateStatus;
  blockingIssues: string[];
  warningIssues: string[];
  details: Record<string, number>;
}

/** P7.17：Quality Gate。blocking 控制 production-ready，不控制能否继续探索。 */
export function runQualityGate(input: QualityGateInput): QualityGateResult {
  const blockingIssues: string[] = [];
  const warningIssues: string[] = [];
  if (input.highForbiddenExecutions > 0) blockingIssues.push(`HIGH/FORBIDDEN 自动执行 ${input.highForbiddenExecutions} 次`);
  if (input.identityDuplicateCreation > 0) blockingIssues.push(`Page identity 重复创建 ${input.identityDuplicateCreation} 个`);
  if (input.directWriteViolations > 0) blockingIssues.push(`Page Model direct-write 违规 ${input.directWriteViolations} 次`);
  if (input.criticalFalsePositives > 0) blockingIssues.push(`关键语义 false positive ${input.criticalFalsePositives} 个`);
  if (input.wrongBusinessActions > 0) blockingIssues.push(`DSL 业务动作错误 ${input.wrongBusinessActions} 个`);
  if (input.elementRecall < 0.7) warningIssues.push(`element recall ${round(input.elementRecall)} < 0.7`);
  if (input.controlTypeAccuracy < 0.8) warningIssues.push(`controlType accuracy ${round(input.controlTypeAccuracy)} < 0.8`);
  if (input.assertionRecall < 0.4) warningIssues.push(`assertion recall ${round(input.assertionRecall)} < 0.4`);
  if (input.optionRecall < 0.3) warningIssues.push(`option recall ${round(input.optionRecall)} < 0.3`);
  const status: GateStatus = blockingIssues.length ? "BLOCKED" : warningIssues.length ? "WARNING" : "PASS";
  return { status, blockingIssues, warningIssues, details: { highForbiddenExecutions: input.highForbiddenExecutions, identityDuplicateCreation: input.identityDuplicateCreation, directWriteViolations: input.directWriteViolations, criticalFalsePositives: input.criticalFalsePositives, wrongBusinessActions: input.wrongBusinessActions, elementRecall: input.elementRecall, controlTypeAccuracy: input.controlTypeAccuracy, assertionRecall: input.assertionRecall, optionRecall: input.optionRecall } };
}
