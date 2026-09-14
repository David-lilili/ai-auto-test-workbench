import type { ExplorationHeuristic } from "./exploration-heuristics.js";

/**
 * Interaction Applicability Matrix（P3-B2）：控件 × 动作的适用性单一事实源。
 *
 * 三态：
 *   APPLICABLE     该控件天然支持该动作
 *   CONDITIONAL    特定组件形态下适用（带 condition 说明）
 *   NOT_APPLICABLE 该控件不支持该动作（heuristic matcher 必须过滤）
 *
 * matcher / plan builder 均消费本矩阵；NOT_APPLICABLE 的 candidateAction
 * 不得进入 plan（有测试固化）。
 */

export type Applicability = "APPLICABLE" | "CONDITIONAL" | "NOT_APPLICABLE";

export interface MatrixCell {
  applicability: Applicability;
  /** CONDITIONAL 时的条件说明（必填）；APPLICABLE 时为可选补充。 */
  condition?: string;
}

/** 控件类型 → 动作 → 适用性。未列出的组合默认 NOT_APPLICABLE（保守）。 */
export const INTERACTION_APPLICABILITY_MATRIX: Record<string, Record<string, MatrixCell>> = {
  input: {
    input: { applicability: "APPLICABLE" },
    clear: { applicability: "APPLICABLE" },
    focus: { applicability: "APPLICABLE" },
    click: { applicability: "CONDITIONAL", condition: "input 控件可点击聚焦（focus 等价），但 click 不是其主要交互" },
    select: { applicability: "NOT_APPLICABLE" },
    submit: { applicability: "NOT_APPLICABLE" }
  },
  number_input: {
    input: { applicability: "APPLICABLE" },
    clear: { applicability: "APPLICABLE" },
    focus: { applicability: "APPLICABLE" },
    select: { applicability: "NOT_APPLICABLE" },
    submit: { applicability: "NOT_APPLICABLE" }
  },
  text_input: {
    input: { applicability: "APPLICABLE" },
    clear: { applicability: "APPLICABLE" },
    focus: { applicability: "APPLICABLE" },
    select: { applicability: "NOT_APPLICABLE" }
  },
  otp_input: {
    input: { applicability: "APPLICABLE" },
    clear: { applicability: "APPLICABLE" },
    focus: { applicability: "APPLICABLE" },
    select: { applicability: "NOT_APPLICABLE" }
  },
  select: {
    select: { applicability: "APPLICABLE" },
    open_dropdown: { applicability: "APPLICABLE" },
    close_dropdown: { applicability: "APPLICABLE" },
    switch_back: { applicability: "APPLICABLE" },
    restore_original: { applicability: "APPLICABLE" },
    select_alternative: { applicability: "APPLICABLE" },
    input: { applicability: "NOT_APPLICABLE" },
    clear: { applicability: "NOT_APPLICABLE" }
  },
  searchable_select: {
    select: { applicability: "APPLICABLE" },
    open_dropdown: { applicability: "APPLICABLE" },
    close_dropdown: { applicability: "APPLICABLE" },
    restore_original: { applicability: "APPLICABLE" },
    select_alternative: { applicability: "APPLICABLE" },
    input: { applicability: "CONDITIONAL", condition: "searchable dropdown 的搜索框可输入过滤词" },
    clear: { applicability: "CONDITIONAL", condition: "searchable dropdown 搜索框可清空" }
  },
  dropdown: {
    select: { applicability: "APPLICABLE" },
    open_dropdown: { applicability: "APPLICABLE" },
    close_dropdown: { applicability: "APPLICABLE" },
    restore_original: { applicability: "APPLICABLE" },
    select_alternative: { applicability: "APPLICABLE" },
    input: { applicability: "CONDITIONAL", condition: "searchable dropdown 组件才支持输入" },
    clear: { applicability: "CONDITIONAL", condition: "searchable dropdown 才支持清空" }
  },
  dropdown_option: {
    select: { applicability: "APPLICABLE" },
    click: { applicability: "APPLICABLE" },
    capture_options: { applicability: "APPLICABLE" },
    input: { applicability: "NOT_APPLICABLE" }
  },
  button: {
    click: { applicability: "APPLICABLE" },
    double_click: { applicability: "CONDITIONAL", condition: "仅特定组件（如批量操作）有双击语义" },
    // P6.0：补 capture_enabled_state / open_modal——只允许「观察计划」，不代表允许自动 click。
    // money-action/submit/withdraw 等 click 风险仍由 risk gate 拦截。
    capture_enabled_state: { applicability: "APPLICABLE", condition: "按钮可安全观察 enabled/disabled 状态（只读，不点击）" },
    open_modal: { applicability: "CONDITIONAL", condition: "按钮具备弹窗触发语义时适用（由 modal.open_close heuristic 在 expected_dialog 前置下使用，观察后关闭）" },
    input: { applicability: "NOT_APPLICABLE" },
    select: { applicability: "NOT_APPLICABLE" },
    submit: { applicability: "CONDITIONAL", condition: "submit 属写操作语义，仅 HIGH-risk plan 且永不自动执行" }
  },
  submit_button: {
    click: { applicability: "APPLICABLE" },
    capture_enabled_state: { applicability: "APPLICABLE" },
    input: { applicability: "NOT_APPLICABLE" },
    submit: { applicability: "CONDITIONAL", condition: "submit 语义属 HIGH risk，自动执行被 risk gate 阻断" }
  },
  link: {
    click: { applicability: "APPLICABLE" },
    // P6.0：链接可打开弹窗/抽屉（观察后关闭，不自动导航写操作）。
    open_modal: { applicability: "CONDITIONAL", condition: "链接具备弹窗/抽屉触发语义时适用（由 modal.open_close heuristic 在 expected_dialog 前置下使用，观察后关闭）" },
    input: { applicability: "NOT_APPLICABLE" },
    select: { applicability: "NOT_APPLICABLE" }
  },
  tab: {
    click: { applicability: "APPLICABLE" },
    click_non_current_tab: { applicability: "APPLICABLE" },
    click_original_tab: { applicability: "APPLICABLE" },
    capture_current_active: { applicability: "APPLICABLE" },
    input: { applicability: "NOT_APPLICABLE" },
    select: { applicability: "NOT_APPLICABLE" }
  },
  checkbox: {
    click: { applicability: "APPLICABLE" },
    interact_toggle: { applicability: "APPLICABLE" },
    interact_toggle_back: { applicability: "APPLICABLE" },
    input: { applicability: "NOT_APPLICABLE" },
    select: { applicability: "NOT_APPLICABLE" }
  },
  toggle: {
    click: { applicability: "APPLICABLE" },
    interact_toggle: { applicability: "APPLICABLE" },
    interact_toggle_back: { applicability: "APPLICABLE" },
    input: { applicability: "NOT_APPLICABLE" }
  },
  modal_trigger: {
    open_modal: { applicability: "APPLICABLE" },
    close_modal: { applicability: "CONDITIONAL", condition: "modal 已打开时才可关闭（open 成功后适用）" },
    verify_closed: { applicability: "CONDITIONAL", condition: "modal 已打开过才需要验证关闭" }
  },
  table: {
    view: { applicability: "APPLICABLE" },
    click: { applicability: "NOT_APPLICABLE" },
    input: { applicability: "NOT_APPLICABLE" }
  },
  text: {
    view: { applicability: "APPLICABLE" },
    click: { applicability: "NOT_APPLICABLE" },
    input: { applicability: "NOT_APPLICABLE" },
    select: { applicability: "NOT_APPLICABLE" }
  },
  date_range: {
    input: { applicability: "APPLICABLE" },
    clear: { applicability: "APPLICABLE" },
    select: { applicability: "NOT_APPLICABLE" }
  },
  page_entry: {
    navigate_to_page: { applicability: "APPLICABLE" },
    capture_block_state: { applicability: "APPLICABLE" },
    click: { applicability: "NOT_APPLICABLE" }
  }
};

/** 查询控件×动作适用性（未知组合默认 NOT_APPLICABLE）。 */
export function lookupApplicability(controlType: string, action: string): MatrixCell {
  const row = INTERACTION_APPLICABILITY_MATRIX[controlType];
  if (!row) return { applicability: "NOT_APPLICABLE" };
  return row[action] ?? { applicability: "NOT_APPLICABLE" };
}

/** heuristic 的 candidateActions 对某控件是否全部可执行（matcher 消费）。 */
export function heuristicActionsExecutable(controlType: string, candidateActions: string[]): {
  executable: string[];
  conditional: Array<{ action: string; condition: string }>;
  notApplicable: string[];
} {
  const executable: string[] = [];
  const conditional: Array<{ action: string; condition: string }> = [];
  const notApplicable: string[] = [];
  for (const action of candidateActions) {
    const cell = lookupApplicability(controlType, action);
    if (cell.applicability === "APPLICABLE") executable.push(action);
    else if (cell.applicability === "CONDITIONAL") conditional.push({ action, condition: cell.condition ?? "条件未说明" });
    else notApplicable.push(action);
  }
  return { executable, conditional, notApplicable };
}
