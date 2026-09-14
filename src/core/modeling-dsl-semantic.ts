/**
 * P8.24-26：DSL Semantic Completeness。
 *
 * P8.24：每条 READY DSL 必须同时报告 completeness 等级：READY_FULL / READY_PARTIAL /
 * READY_SHALLOW / BLOCKED。READY + SHALLOW 不能当成真正完整自动测试。
 *
 * P8.25：Intent Requirement Graph——把 intent 转为 required semantic operations
 * （NAVIGATE / SELECT_FILTER / APPLY_FILTER / ASSERT_RESULT / SET_DATE_RANGE / SUBMIT_FORM / ASSERT_STATE ...）。
 * 根据 action/domain deterministic 推导，AI intent 提供业务语义，但 completeness 比较本地进行。
 *
 * P8.26：Missing Semantic Operation Diagnostics——如果 DSL 只含 navigate+assert，
 * 用户却要求 select filter + assert result，输出 MISSING: [SELECT_FILTER, ASSERT_FILTERED_RESULT]，
 * 而不是只说 READY。
 *
 * 铁律：不针对 benchmark case 特化；本地确定性推导。
 */

import { round } from "./modeling-quality-metrics.js";

export type DslSemanticLevel = "READY_FULL" | "READY_PARTIAL" | "READY_SHALLOW" | "BLOCKED";

export type SemanticOperation =
  | "NAVIGATE"
  | "SELECT_FILTER"
  | "APPLY_FILTER"
  | "ASSERT_RESULT"
  | "ASSERT_FILTERED_RESULT"
  | "SET_DATE_RANGE"
  | "SUBMIT_FORM"
  | "ASSERT_STATE"
  | "ASSERT_MESSAGE"
  | "OPEN_MODAL"
  | "SELECT_OPTION"
  | "VERIFY_RECORD"
  | "UNKNOWN";

export interface IntentRequirementGraph {
  operations: SemanticOperation[];
  /** 每项 operation 的来源依据。 */
  rationale: Array<{ op: SemanticOperation; reason: string }>;
}

/** 从自然语言 intent 推导 required semantic operations（确定性关键词 → 依赖）。 */
export function buildIntentRequirementGraph(intent: string): IntentRequirementGraph {
  const text = String(intent ?? "");
  const ops = new Set<SemanticOperation>();
  const rationale: IntentRequirementGraph["rationale"] = [];

  const has = (re: RegExp) => re.test(text);

  // 导航类
  if (has(/打开|进入|访问|页面|navigate|open|goto|跳转/)) {
    ops.add("NAVIGATE");
    rationale.push({ op: "NAVIGATE", reason: "intent 提到进入/打开页面" });
  }
  // 筛选类
  if (has(/筛选|过滤|查询|搜索|filter|select.*(币种|asset)|按.*筛选/)) {
    ops.add("SELECT_FILTER");
    rationale.push({ op: "SELECT_FILTER", reason: "intent 提到筛选条件" });
    ops.add("APPLY_FILTER");
    rationale.push({ op: "APPLY_FILTER", reason: "筛选需要应用（查询/确认）" });
    ops.add("ASSERT_FILTERED_RESULT");
    rationale.push({ op: "ASSERT_FILTERED_RESULT", reason: "筛选后需断言过滤结果" });
  }
  // 日期范围
  if (has(/时间范围|日期|起止|from.*to|date range|start.*end/)) {
    ops.add("SET_DATE_RANGE");
    rationale.push({ op: "SET_DATE_RANGE", reason: "intent 提到时间范围" });
  }
  // 下拉选择
  if (has(/选择|下拉|option|select.*(链|网络|type)/)) {
    ops.add("SELECT_OPTION");
    rationale.push({ op: "SELECT_OPTION", reason: "intent 提到下拉选择" });
  }
  // 提交表单（去掉裸"确认/confirm"——"确认记录"是验证语义不是提交）
  if (has(/提交|下单|创建|保存|提现|充值|确认订单|确认提交|确认付款|submit|create|confirm\s+(order|submit|payment)/i)) {
    ops.add("SUBMIT_FORM");
    rationale.push({ op: "SUBMIT_FORM", reason: "intent 提到提交动作" });
    ops.add("ASSERT_MESSAGE");
    rationale.push({ op: "ASSERT_MESSAGE", reason: "提交后需断言反馈消息" });
  }
  // 打开弹窗
  if (has(/弹窗|对话框|modal|dialog|打开.*(设置|管理)/)) {
    ops.add("OPEN_MODAL");
    rationale.push({ op: "OPEN_MODAL", reason: "intent 提到弹窗" });
  }
  // 结果断言
  if (has(/确认|验证|断言|出现|记录|结果|assert|verify|存在|列表/)) {
    ops.add("ASSERT_RESULT");
    rationale.push({ op: "ASSERT_RESULT", reason: "intent 要求确认结果" });
  }
  // 状态断言
  if (has(/状态|置灰|可用|disabled|enabled|可见/)) {
    ops.add("ASSERT_STATE");
    rationale.push({ op: "ASSERT_STATE", reason: "intent 提到状态" });
  }
  // 记录内容验证（需具体字段：金额/哈希/地址/明细，或"记录+出现/包含"——裸"记录"不算）
  if (has(/金额.*(等于|为|=)|哈希|地址|明细|记录.*(包含|出现|有)/i)) {
    ops.add("VERIFY_RECORD");
    rationale.push({ op: "VERIFY_RECORD", reason: "intent 要求验证记录内容" });
  }

  if (ops.size === 0) {
    ops.add("UNKNOWN");
    rationale.push({ op: "UNKNOWN", reason: "无确定性信号" });
  }
  return { operations: [...ops], rationale };
}

/** 从 DSL 步骤文本推断"已覆盖"的 semantic operations。 */
export function inferCoveredOperations(stepTexts: string[]): Set<SemanticOperation> {
  const covered = new Set<SemanticOperation>();
  let hasApplyFilter = false;
  for (const step of stepTexts) {
    const s = String(step ?? "").toLowerCase();
    if (s.includes("navigate") || s.includes("goto") || s.includes("打开")) covered.add("NAVIGATE");
    if (s.includes("select") || s.includes("选择")) {
      covered.add("SELECT_OPTION");
      // 选择筛选值 = SELECT_FILTER 的一部分
      covered.add("SELECT_FILTER");
    }
    if (s.includes("filter") || s.includes("筛选") || s.includes("apply") || s.includes("查询") || s.includes("搜索")) {
      covered.add("APPLY_FILTER");
      hasApplyFilter = true;
    }
    if (s.includes("assert") || s.includes("断言") || s.includes("expect") || s.includes("确认") || s.includes("验证")) {
      covered.add("ASSERT_RESULT");
      if (hasApplyFilter) covered.add("ASSERT_FILTERED_RESULT");
    }
    if (s.includes("date") || s.includes("range") || s.includes("时间")) covered.add("SET_DATE_RANGE");
    if (s.includes("submit") || s.includes("提交")) covered.add("SUBMIT_FORM");
    if (s.includes("modal") || s.includes("dialog") || s.includes("弹窗")) covered.add("OPEN_MODAL");
    if (s.includes("message") || s.includes("消息") || s.includes("toast")) covered.add("ASSERT_MESSAGE");
    if (s.includes("state") || s.includes("状态") || s.includes("enabled") || s.includes("disabled")) covered.add("ASSERT_STATE");
    if (s.includes("verify") || s.includes("record") || s.includes("记录") || s.includes("金额") || s.includes("哈希") || s.includes("地址")) covered.add("VERIFY_RECORD");
  }
  return covered;
}

/** P8.26：输出 missing semantic operations（要求有但 DSL 无）。 */
export function missingSemanticOperations(intent: string, stepTexts: string[]): SemanticOperation[] {
  const required = buildIntentRequirementGraph(intent).operations;
  const covered = inferCoveredOperations(stepTexts);
  // ASSERT_RESULT 可由 ASSERT_FILTERED_RESULT 覆盖
  if (covered.has("ASSERT_FILTERED_RESULT")) covered.add("ASSERT_RESULT");
  return required.filter((op) => !covered.has(op));
}

/** P8.24：计算 DSL semantic level。 */
export function computeDslSemanticLevel(intent: string, stepTexts: string[], executable: boolean): { level: DslSemanticLevel; missing: SemanticOperation[]; requiredCount: number; coveredRatio: number } {
  if (!executable) return { level: "BLOCKED", missing: [], requiredCount: 0, coveredRatio: 0 };
  const required = buildIntentRequirementGraph(intent).operations.filter((op) => op !== "UNKNOWN");
  const missing = missingSemanticOperations(intent, stepTexts);
  if (required.length === 0) return { level: "READY_SHALLOW", missing: [], requiredCount: 0, coveredRatio: 0 };
  const coveredCount = required.length - missing.length;
  const ratio = round(coveredCount / required.length);
  if (ratio >= 0.9 && missing.length === 0) return { level: "READY_FULL", missing, requiredCount: required.length, coveredRatio: ratio };
  if (ratio >= 0.6) return { level: "READY_PARTIAL", missing, requiredCount: required.length, coveredRatio: ratio };
  return { level: "READY_SHALLOW", missing, requiredCount: required.length, coveredRatio: ratio };
}
