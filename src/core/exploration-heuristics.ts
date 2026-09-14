import { classifyRisk, type RiskLevel } from "./exploration-risk-policy.js";

/**
 * Heuristic Registry（P3-A2/A3）：把 page-model-modeling-playbook.md 中
 * 已被历史建模实践验证的测试经验，结构化为平台运行时可消费的策略。
 *
 * 四层职责边界：
 *   Knowledge  = Operation Manual/Page Model（产品是什么）
 *   Prompt     = intent/advisor system（AI 怎么理解）
 *   Heuristic  = 本模块（应该怎么测试/探索）
 *   Policy     = exploration-risk-policy（什么不能自动做）
 *
 * 编译纪律（P3-A 硬约束）：
 *   - 每条 heuristic 必须有 sourceRule 指向已有经验来源（playbook:PMH.* 稳定 Rule ID /
 *     existing-code:<module> / operation-manual:<capability>）；
 *   - 不增加原规则没有的业务语义（结构化表达，不发明）；
 *   - 版本从 1 起，行为变更必须 bump。
 *
 * 版本 bump 规则（P3-A.1 固化；ExplorationRun 将依赖 heuristicId+version 建立证据溯源）：
 *   必须 bump version：
 *     - candidateActions 行为变化（增删改动作或改变顺序语义）
 *     - observations 变化
 *     - restoreStrategy 变化
 *     - riskClass 变化
 *     - stopConditions 变化
 *     - appliesTo 适用范围变化
 *   不需要 bump：
 *     - description 文案修改
 *     - sourceLocation 行号漂移（playbook 插行）
 *     - 注释、formatting
 *
 * 本阶段只建立 schema/registry 与 traceability，不执行任何探索。
 */

export type HeuristicRiskClass = "LOW" | "MEDIUM" | "HIGH" | "FORBIDDEN";
export type CostClass = "LOW" | "MEDIUM" | "HIGH";
export type HeuristicCategory =
  | "input_boundary"
  | "control_state"
  | "select_exploration"
  | "tab_state"
  | "modal_state"
  | "field_validation"
  | "dependency_observation"
  | "visibility"
  | "blocked_state";

export interface ExplorationHeuristic {
  id: string;
  version: number;
  category: HeuristicCategory;
  /**
   * 经验来源溯源（P3-A 硬约束：禁止无来源规则）。
   * P3-A.1：主身份是 playbook 稳定 Rule ID（PMH.*），行号不再作为 identity；
   * sourceLocation 仅记录人查看用的当前位置，playbook 插行不影响 sourceRule 解析。
   */
  sourceRule: string;
  /** 人查看用位置（非 identity；playbook 行变化时允许漂移，无需 bump version）。 */
  sourceLocation?: string;
  appliesTo: string[];
  triggerGapSources: string[];
  preconditions: string[];
  candidateActions: string[];
  observations: string[];
  restoreStrategy: string;
  riskClass: HeuristicRiskClass;
  stopConditions: string[];
  dedupeStrategy: string;
  description: string;
}

export const HEURISTIC_REGISTRY: ExplorationHeuristic[] = [
  {
    id: "input.basic_observation",
    version: 2,
    category: "input_boundary",
    sourceRule: "playbook:PMH.INPUT.REQUIRED",
    sourceLocation: "docs/page-model-modeling-playbook.md:L58",
    appliesTo: ["input", "number_input", "text_input", "otp_input"],
    // P6.0：candidate_stale 的 input 需要补采观察（语义一致：观察不提交）。
    triggerGapSources: ["element_unverified", "candidate_stale"],
    preconditions: ["element_locator", "page_loaded"],
    candidateActions: ["focus", "input_local_test_value", "observe_value"],
    observations: ["value_changed", "validation_message_changed"],
    restoreStrategy: "clear_to_original",
    riskClass: "LOW",
    stopConditions: ["input_rejected", "page_navigated_away", "timeout"],
    dedupeStrategy: "pageId+elementId+heuristicId",
    description: "必填边界观察：输入本地测试值观察值变化与校验消息，不提交（源：必填边界-空值/默认值规则）"
  },
  {
    id: "input.clear_restore",
    version: 2,
    category: "input_boundary",
    sourceRule: "playbook:PMH.INPUT.REQUIRED",
    sourceLocation: "docs/page-model-modeling-playbook.md:L58",
    appliesTo: ["input", "number_input", "text_input"],
    triggerGapSources: ["element_unverified", "interaction_unverified", "candidate_stale"],
    preconditions: ["element_locator"],
    candidateActions: ["capture_before", "input_test_value", "clear", "observe_restored"],
    observations: ["value_cleared", "validation_reset", "confirm_button_state_changed"],
    restoreStrategy: "clear_to_original",
    riskClass: "LOW",
    stopConditions: ["clear_failed", "page_navigated_away"],
    dedupeStrategy: "pageId+elementId+heuristicId",
    description: "输入后清空并确认恢复（源：空值下确认/提交按钮状态规则）"
  },
  {
    id: "button.enabled_state_observation",
    version: 2,
    category: "control_state",
    sourceRule: "playbook:PMH.BUTTON.ENABLED_STATE",
    sourceLocation: "docs/page-model-modeling-playbook.md:L83",
    appliesTo: ["button", "submit_button"],
    triggerGapSources: ["element_unverified", "candidate_stale"],
    preconditions: ["element_locator"],
    candidateActions: ["capture_enabled_state"],
    observations: ["button_enabled", "button_disabled", "disabled_reason_visible"],
    restoreStrategy: "none_read_only",
    riskClass: "LOW",
    stopConditions: ["element_not_found"],
    dedupeStrategy: "pageId+elementId+heuristicId",
    description: "按钮置灰即有效断言能力，只观察不点击（源：按钮置灰表达限制规则）"
  },
  {
    id: "select.option_discovery",
    version: 2,
    category: "select_exploration",
    sourceRule: "playbook:PMH.SELECT.FILTER_BOUNDARY",
    sourceLocation: "docs/page-model-modeling-playbook.md:L65",
    appliesTo: ["select", "searchable_select", "dropdown"],
    triggerGapSources: ["element_unverified", "candidate_stale"],
    preconditions: ["element_locator"],
    candidateActions: ["open_dropdown", "capture_options", "close_dropdown"],
    observations: ["options_list_captured", "option_count", "value_aliases_detected"],
    restoreStrategy: "close_dropdown",
    riskClass: "LOW",
    stopConditions: ["dropdown_not_open", "timeout"],
    dedupeStrategy: "pageId+elementId+heuristicId",
    description: "采集下拉全部 option 清单后收起，不选择（源：每个已建模 option 规则）"
  },
  {
    id: "select.switch_restore",
    version: 2,
    category: "select_exploration",
    sourceRule: "playbook:PMH.SELECT.FILTER_BOUNDARY",
    sourceLocation: "docs/page-model-modeling-playbook.md:L65",
    appliesTo: ["select", "dropdown"],
    triggerGapSources: ["interaction_unverified", "candidate_stale"],
    preconditions: ["element_locator", "current_value_known"],
    candidateActions: ["capture_before", "select_alternative", "capture_after", "restore_original"],
    observations: ["selected_value_changed", "selected_value_restored", "result_column_mapping_hint"],
    restoreStrategy: "reselect_original_value",
    riskClass: "LOW",
    stopConditions: ["select_failed", "restore_failed"],
    dedupeStrategy: "pageId+elementId+optionValue+heuristicId",
    description: "切换 option 观察后恢复原值（源：筛选边界-每个已建模 option/重置后状态规则）"
  },
  {
    id: "select.dependency_observation",
    version: 1,
    category: "dependency_observation",
    sourceRule: "playbook:PMH.SELECT.FILTER_BOUNDARY",
    sourceLocation: "docs/page-model-modeling-playbook.md:L65",
    appliesTo: ["select", "searchable_select", "dropdown"],
    triggerGapSources: ["manual_capability_gap", "element_unverified"],
    preconditions: ["element_locator", "dependent_elements"],
    candidateActions: ["capture_before", "select_alternative", "observe_dependents", "restore_original"],
    observations: ["dependent_value_changed", "dependent_options_changed", "button_state_changed", "result_column_mapping_changed"],
    restoreStrategy: "reselect_original_value",
    riskClass: "MEDIUM",
    stopConditions: ["dependent_mutation_detected", "restore_failed", "timeout"],
    dedupeStrategy: "pageId+elementId+dependentId+heuristicId",
    description: "切换 select 观察依赖控件变化（如 network→address，源：字段到结果列映射规则）"
  },
  {
    id: "tab.switch_restore",
    version: 2,
    category: "tab_state",
    sourceRule: "playbook:PMH.TAB.BOUNDARY",
    sourceLocation: "docs/page-model-modeling-playbook.md:L72",
    appliesTo: ["tab"],
    triggerGapSources: ["element_unverified", "interaction_unverified", "candidate_stale"],
    preconditions: ["element_locator"],
    candidateActions: ["capture_current_active", "click_non_current_tab", "capture_after", "click_original_tab"],
    observations: ["tab_active_changed", "panel_content_changed", "active_state_assertable"],
    restoreStrategy: "click_original_tab",
    riskClass: "LOW",
    stopConditions: ["tab_not_found", "restore_failed"],
    dedupeStrategy: "pageId+elementId+tabValue+heuristicId",
    description: "区分 current 与非 current tab，切换观察面板后切回（源：Tab 边界规则）"
  },
  {
    id: "modal.open_close",
    version: 2,
    category: "modal_state",
    sourceRule: "playbook:PMH.MODAL.BOUNDARY",
    sourceLocation: "docs/page-model-modeling-playbook.md:L68",
    appliesTo: ["button", "link"],
    triggerGapSources: ["state_transition_gap", "element_unverified", "candidate_stale"],
    preconditions: ["element_locator", "expected_dialog"],
    candidateActions: ["capture_before", "open_modal", "capture_modal_content", "close_modal", "verify_closed"],
    observations: ["dialog_appeared", "dialog_content_captured", "dialog_closed", "loading_state_observed"],
    restoreStrategy: "close_modal",
    riskClass: "LOW",
    stopConditions: ["modal_not_opened", "close_failed"],
    dedupeStrategy: "pageId+elementId+dialogId+heuristicId",
    description: "打开弹窗采集内容后关闭并确认关闭（源：弹窗/抽屉边界-打开关闭取消规则）"
  },
  {
    id: "field.validation_non_submit",
    version: 2,
    category: "field_validation",
    sourceRule: "playbook:PMH.FIELD.RULE_VALUE",
    sourceLocation: "docs/page-model-modeling-playbook.md:L81",
    appliesTo: ["input", "number_input"],
    triggerGapSources: ["dsl_diagnostic_gap", "element_unverified", "candidate_stale"],
    preconditions: ["element_locator", "visible_rule_value"],
    candidateActions: ["capture_before", "input_boundary_value", "observe_validation", "clear"],
    observations: ["validation_message_appeared", "confirm_button_state_changed"],
    restoreStrategy: "clear_to_original",
    riskClass: "LOW",
    stopConditions: ["page_navigated_away", "unexpected_submit"],
    dedupeStrategy: "pageId+elementId+boundaryValue+heuristicId",
    description: "按页面展示的规则值推导边界输入（低于最小值等），观察校验与按钮状态，不提交（源：规则值+可推导测试值规则）"
  },
  {
    id: "dependent_field_change_observation",
    version: 1,
    category: "dependency_observation",
    sourceRule: "playbook:PMH.FIELD.RULE_DEFINITION",
    sourceLocation: "docs/page-model-modeling-playbook.md:L88",
    appliesTo: ["input", "select"],
    triggerGapSources: ["manual_capability_gap", "dsl_diagnostic_gap"],
    preconditions: ["element_locator", "dependent_elements"],
    candidateActions: ["capture_before", "change_value", "observe_dependents", "restore"],
    observations: ["dependent_state_changed", "button_enable_condition_observed"],
    restoreStrategy: "restore_original_value",
    riskClass: "MEDIUM",
    stopConditions: ["dependent_mutation_detected", "restore_failed"],
    dedupeStrategy: "pageId+elementId+dependentId+heuristicId",
    description: "改变字段值观察依赖控件与按钮启用条件（源：规则-按钮启用条件规则）"
  },
  {
    id: "blocked_state_observation",
    version: 1,
    category: "blocked_state",
    sourceRule: "playbook:PMH.BLOCKED_STATE",
    sourceLocation: "docs/page-model-modeling-playbook.md:L61",
    appliesTo: ["button", "link", "page_entry"],
    triggerGapSources: ["state_transition_gap", "element_unverified"],
    preconditions: ["account_precondition_unmet"],
    candidateActions: ["navigate_to_page", "capture_block_state"],
    observations: ["block_message_visible", "block_type_identified", "block_action_disallowed"],
    restoreStrategy: "none_read_only",
    riskClass: "LOW",
    stopConditions: ["page_not_reachable"],
    dedupeStrategy: "pageId+blockType+heuristicId",
    description: "账号前置不满足时采集拦截状态（KYC/GA/白名单等，源：业务状态边界-账号状态拦截规则）"
  },
  {
    id: "visibility_change_observation",
    version: 2,
    category: "visibility",
    sourceRule: "playbook:PMH.LIST_BOUNDARY",
    sourceLocation: "docs/page-model-modeling-playbook.md:L63",
    appliesTo: ["checkbox", "toggle", "tab", "link"],
    triggerGapSources: ["element_unverified", "state_transition_gap", "candidate_stale"],
    preconditions: ["element_locator"],
    candidateActions: ["capture_before", "interact_toggle", "capture_after", "interact_toggle_back"],
    observations: ["element_visibility_changed", "region_appeared", "region_disappeared", "empty_state_changed"],
    restoreStrategy: "toggle_back",
    riskClass: "LOW",
    stopConditions: ["unexpected_navigation", "restore_failed"],
    dedupeStrategy: "pageId+elementId+heuristicId",
    description: "切换可见性开关观察区域出现/消失（空列表/单行/多行等，源：列表边界规则）"
  }
];

export function getHeuristic(id: string): ExplorationHeuristic | undefined {
  return HEURISTIC_REGISTRY.find((heuristic) => heuristic.id === id);
}

/** 按 gap source + 控件类型匹配 heuristic（deterministic）。 */
export function matchHeuristics(input: { controlType: string; gapSource: string }): ExplorationHeuristic[] {
  return HEURISTIC_REGISTRY.filter((heuristic) =>
    heuristic.triggerGapSources.includes(input.gapSource)
    && heuristic.appliesTo.includes(input.controlType)
  );
}

/** Schema validation：registry 完整性（P3-A3 要求，被 skills:audit 复用）。 */
export function validateHeuristicRegistry(): string[] {
  const issues: string[] = [];
  const seenIds = new Set<string>();
  for (const heuristic of HEURISTIC_REGISTRY) {
    if (!heuristic.id) issues.push("heuristic missing id");
    if (seenIds.has(heuristic.id)) issues.push(`duplicate heuristic id: ${heuristic.id}`);
    seenIds.add(heuristic.id);
    if (!Number.isInteger(heuristic.version) || heuristic.version < 1) issues.push(`${heuristic.id}: version must be integer >= 1`);
    if (!heuristic.sourceRule) issues.push(`orphan heuristic（无 sourceRule）: ${heuristic.id}`);
    else if (!/^(playbook:PMH\.[A-Z0-9_.]+|existing-code:[\w.-]+|operation-manual:[\w.-]+)$/.test(heuristic.sourceRule)) {
      issues.push(`${heuristic.id}: sourceRule 格式非法 ${heuristic.sourceRule}`);
    }
    if (!heuristic.appliesTo?.length) issues.push(`${heuristic.id}: appliesTo 为空`);
    if (!heuristic.triggerGapSources?.length) issues.push(`${heuristic.id}: triggerGapSources 为空`);
    if (!heuristic.candidateActions?.length) issues.push(`${heuristic.id}: candidateActions 为空`);
    if (!heuristic.observations?.length) issues.push(`${heuristic.id}: observations 为空`);
    if (!heuristic.stopConditions?.length) issues.push(`${heuristic.id}: stopConditions 为空`);
    if (!heuristic.restoreStrategy) issues.push(`${heuristic.id}: restoreStrategy 缺失`);
    if (!heuristic.dedupeStrategy) issues.push(`${heuristic.id}: dedupeStrategy 缺失`);
    // 风险分级必须经统一 policy 校验（A4：不复制词表）
    const policyRisk = classifyRisk(heuristicDescription(heuristic));
    if (heuristic.riskClass === "FORBIDDEN") issues.push(`${heuristic.id}: registry 不允许声明 FORBIDDEN（该等级只属于 policy）`);
  }
  return issues;
}

function heuristicDescription(heuristic: ExplorationHeuristic): string {
  return `${heuristic.id} ${heuristic.description} ${heuristic.candidateActions.join(" ")}`;
}
