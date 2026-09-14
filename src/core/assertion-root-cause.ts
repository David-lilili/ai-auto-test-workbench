import fs from "fs-extra";
import path from "node:path";

/**
 * P5.9：Assertion Root-Cause Analysis（只读）。
 * 把执行历史里的失败断言按根因聚类，输出可操作修复建议。
 *
 * 根因分类（确定性规则，无 LLM）：
 *   - ELEMENT_STATE_MISMATCH：断言 disabled/enabled 但元素状态相反（产品或断言设计问题）
 *   - ROW_SCOPED_TARGET_MISSING：行作用域目标未命中（数据/行状态问题）
 *   - EXPECTED_TEXT_NOT_VISIBLE：期望文本超时未出现（时间范围/筛选/结果为空）
 *   - MESSAGE_MISMATCH：期望消息未见、其他消息出现（断言文本与页面实际不一致）
 *   - EMPTY_STATE_VISIBLE：断言了数据行但页面为空态
 *   - VALUES_EXTRACTED_MISMATCH：提取值后断言不匹配
 *   - TIMEOUT_OR_NETWORK：超时/网络/环境问题
 *   - OTHER：未归类
 *
 * 每条聚类附带 remediation（断言设计/数据/环境/产品判断），供 P5.11 lifecycle 消费。
 */

export type AssertionRootCause =
  | "ELEMENT_STATE_MISMATCH"
  | "ROW_SCOPED_TARGET_MISSING"
  | "EXPECTED_TEXT_NOT_VISIBLE"
  | "MESSAGE_MISMATCH"
  | "EMPTY_STATE_VISIBLE"
  | "VALUES_EXTRACTED_MISMATCH"
  | "TIMEOUT_OR_NETWORK"
  | "OTHER";

export type RemediationCategory = "assertion_design" | "test_data" | "environment" | "product_defect" | "review";

export interface AssertionFailureItem {
  stepId: string;
  runId: string;
  caseId: string;
  assertionType: string;
  target: string;
  rootCause: AssertionRootCause;
  evidence: string;
  remediation: RemediationCategory;
  recommendation: string;
}

export interface AssertionRootCauseReport {
  project: string;
  generatedAt: string;
  totalFailures: number;
  byRootCause: Record<AssertionRootCause, number>;
  byRemediation: Record<RemediationCategory, number>;
  items: AssertionFailureItem[];
}

interface RawStep {
  step_id?: string;
  run_id?: string;
  dsl_step_id?: string;
  action_type?: string;
  status?: string;
  error_message?: string;
  assertion_summary?: {
    type?: string;
    target?: string;
    diagnostics?: { rootCause?: string };
    actual?: Record<string, unknown>;
  };
}

const ROOT_CAUSE_REMEDIATION: Record<AssertionRootCause, { remediation: RemediationCategory; recommendation: string }> = {
  ELEMENT_STATE_MISMATCH: { remediation: "product_defect", recommendation: "校验元素实际状态：可能产品未置灰/置灰逻辑未实现，或断言期望写反" },
  ROW_SCOPED_TARGET_MISSING: { remediation: "test_data", recommendation: "行作用域目标未命中：检查行内数据（asset/status/actionText）是否与页面实际一致" },
  EXPECTED_TEXT_NOT_VISIBLE: { remediation: "assertion_design", recommendation: "期望文本超时未出现：检查筛选/时间范围断言是否与数据实际窗口匹配" },
  MESSAGE_MISMATCH: { remediation: "assertion_design", recommendation: "期望消息未见但其他消息出现：对比 assertion_summary.actual 与期望文本" },
  EMPTY_STATE_VISIBLE: { remediation: "test_data", recommendation: "页面为空态：确认测试数据是否存在，或调整 emptyStateAccepted" },
  VALUES_EXTRACTED_MISMATCH: { remediation: "assertion_design", recommendation: "提取值后断言不匹配：检查提取逻辑/列映射" },
  TIMEOUT_OR_NETWORK: { remediation: "environment", recommendation: "超时/网络/环境问题：重跑确认，必要时延长 timeout_ms" },
  OTHER: { remediation: "review", recommendation: "未归类失败，需人工 review" }
};

function classify(raw: RawStep): { rootCause: AssertionRootCause; evidence: string } {
  const summary = raw.assertion_summary;
  const diagnosticsRootCause = summary?.diagnostics?.rootCause;
  const error = String(raw.error_message ?? "");
  const target = String(summary?.target ?? "");

  // 1. 显式 diagnostics.rootCause（executor 已判定）
  if (diagnosticsRootCause === "element_enabled") return { rootCause: "ELEMENT_STATE_MISMATCH", evidence: "diagnostics.rootCause=element_enabled" };
  if (diagnosticsRootCause === "empty_state_visible") return { rootCause: "EMPTY_STATE_VISIBLE", evidence: "diagnostics.rootCause=empty_state_visible" };
  if (diagnosticsRootCause === "expected_message_not_seen_other_messages_seen") return { rootCause: "MESSAGE_MISMATCH", evidence: "diagnostics.rootCause=expected_message_not_seen_other_messages_seen" };
  if (diagnosticsRootCause === "values_extracted") return { rootCause: "VALUES_EXTRACTED_MISMATCH", evidence: "diagnostics.rootCause=values_extracted" };

  // 2. 错误消息模式
  if (/Row scoped action was not found|rowScoped=/.test(error) && /was not found/.test(error)) {
    return { rootCause: "ROW_SCOPED_TARGET_MISSING", evidence: error.slice(0, 160) };
  }
  if (/Expected element to be (disabled|enabled)/.test(error)) {
    return { rootCause: "ELEMENT_STATE_MISMATCH", evidence: error.slice(0, 160) };
  }
  if (/None of expected texts became visible/.test(error)) {
    // 时间范围/筛选类 target 提示数据窗口问题
    if (/时间|date|日期/.test(target)) {
      return { rootCause: "EXPECTED_TEXT_NOT_VISIBLE", evidence: error.slice(0, 160) };
    }
    return { rootCause: "EXPECTED_TEXT_NOT_VISIBLE", evidence: error.slice(0, 160) };
  }
  if (/empty|空|no results|未找到/.test(error)) {
    return { rootCause: "EMPTY_STATE_VISIBLE", evidence: error.slice(0, 160) };
  }
  if (/Timeout|timed out|ERR_CONNECTION|net::/.test(error)) {
    return { rootCause: "TIMEOUT_OR_NETWORK", evidence: error.slice(0, 160) };
  }
  if (/other messages|other text|但.*出现/.test(error)) {
    return { rootCause: "MESSAGE_MISMATCH", evidence: error.slice(0, 160) };
  }
  return { rootCause: "OTHER", evidence: error.slice(0, 160) };
}

export function analyzeAssertionRootCauses(rootDir: string, project: string): AssertionRootCauseReport {
  const execPath = path.join(rootDir, "storage", "execution", `${project}.json`);
  if (!fs.pathExistsSync(execPath)) {
    return { project, generatedAt: new Date().toISOString(), totalFailures: 0, byRootCause: emptyByRootCause(), byRemediation: emptyByRemediation(), items: [] };
  }
  const data = fs.readJsonSync(execPath) as { steps?: RawStep[]; runs?: Array<{ run_id?: string; test_case_id?: string }> };
  const steps = data.steps ?? [];
  const runToCase = new Map((data.runs ?? []).map((r) => [String(r.run_id ?? ""), String(r.test_case_id ?? "")]));

  const byRootCause = emptyByRootCause();
  const byRemediation = emptyByRemediation();
  const items: AssertionFailureItem[] = [];

  for (const step of steps) {
    if (!String(step.action_type ?? "").includes("assert")) continue;
    if (step.status !== "failed") continue;
    const { rootCause, evidence } = classify(step);
    const remediationInfo = ROOT_CAUSE_REMEDIATION[rootCause];
    byRootCause[rootCause]++;
    byRemediation[remediationInfo.remediation]++;
    items.push({
      stepId: String(step.step_id ?? step.dsl_step_id ?? ""),
      runId: String(step.run_id ?? ""),
      caseId: runToCase.get(String(step.run_id ?? "")) ?? String(step.dsl_step_id ?? "").split("-")[0] ?? "",
      assertionType: String(step.assertion_summary?.type ?? ""),
      target: String(step.assertion_summary?.target ?? ""),
      rootCause,
      evidence,
      remediation: remediationInfo.remediation,
      recommendation: remediationInfo.recommendation
    });
  }

  return { project, generatedAt: new Date().toISOString(), totalFailures: items.length, byRootCause, byRemediation, items };
}

function emptyByRootCause(): Record<AssertionRootCause, number> {
  return { ELEMENT_STATE_MISMATCH: 0, ROW_SCOPED_TARGET_MISSING: 0, EXPECTED_TEXT_NOT_VISIBLE: 0, MESSAGE_MISMATCH: 0, EMPTY_STATE_VISIBLE: 0, VALUES_EXTRACTED_MISMATCH: 0, TIMEOUT_OR_NETWORK: 0, OTHER: 0 };
}

function emptyByRemediation(): Record<RemediationCategory, number> {
  return { assertion_design: 0, test_data: 0, environment: 0, product_defect: 0, review: 0 };
}
