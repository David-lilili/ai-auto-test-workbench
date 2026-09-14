/**
 * P8.18/P8.19：Button Semantic Role Recovery。
 *
 * P8.18：在 normalized view 增加 semanticRole：FILTER_APPLY / FILTER_RESET / NAVIGATION /
 * MODAL_TRIGGER / SUBMIT / CANCEL / UTILITY / DESTRUCTIVE / SECURITY_ACTION / UNKNOWN。
 *
 * 不是为了自动点击按钮，而是让 Coverage/Heuristic/Risk/DSL 知道"这是哪类按钮"。
 *
 * P8.19：优先信号——form association、text、targetField、Operation Manual、region、href、
 * type=submit、dialog ancestry、risk policy。
 *
 * 铁律：Risk Policy 永远是最终安全权威。SemanticRole 不得降低风险。
 */

export type ButtonSemanticRole =
  | "FILTER_APPLY"
  | "FILTER_RESET"
  | "NAVIGATION"
  | "MODAL_TRIGGER"
  | "SUBMIT"
  | "CANCEL"
  | "UTILITY"
  | "DESTRUCTIVE"
  | "SECURITY_ACTION"
  | "UNKNOWN";

export interface ButtonRoleInput {
  text?: string;
  ariaLabel?: string;
  href?: string;
  type?: string;
  inForm?: boolean;
  inDialog?: boolean;
  inNavContainer?: boolean;
  regionType?: string;
  disabled?: boolean;
  /** 风险级别（来自 risk policy / capture risk）。 */
  riskLevel?: "low" | "medium" | "high";
}

const APPLY_TERMS = ["查询", "搜索", "筛选", "apply", "search", "filter", "go", "确定", "确认筛选", "提交查询"];
const RESET_TERMS = ["重置", "清空", "reset", "clear"];
const CANCEL_TERMS = ["取消", "关闭", "cancel", "close", "返回", "back"];
const SUBMIT_TERMS = ["提交", "确认", "保存", "submit", "confirm", "save", "创建", "下单", "充值", "提现", "购买", "继续"];
const DESTRUCTIVE_TERMS = ["删除", "移除", "清空记录", "注销", "取消授权", "delete", "remove", "revoke", "close account", "终止"];
const SECURITY_TERMS = ["验证", "安全", "绑定", "解绑", "修改密码", "开启二次验证", "verify", "security", "bind", "2fa", "google authenticator"];
const UTILITY_TERMS = ["复制", "下载", "导出", "copy", "download", "export", "刷新", "refresh", "帮助", "help", "客服"];

/**
 * P8.19：确定性 semanticRole 判定。
 * 优先级：显式 type=submit → dialog 内取消/关闭 → destructive/security（高风险词，即使在中性区域）→
 * 表单内 apply/reset → 导航 → 工具性 → UNKNOWN。
 */
export function determineButtonRole(input: ButtonRoleInput): { semanticRole: ButtonSemanticRole; evidence: string[] } {
  const text = String(input.text ?? input.ariaLabel ?? "").trim();
  const lower = text.toLowerCase();
  const evidence: string[] = [];

  // 1. type=submit 且无更具体信号 → SUBMIT
  if (input.type === "submit" && !DESTRUCTIVE_TERMS.some((t) => lower.includes(t)) && !SECURITY_TERMS.some((t) => lower.includes(t))) {
    evidence.push("type=submit");
    return { semanticRole: "SUBMIT", evidence };
  }

  // 2. destructive / security：高风险词优先级最高（无论在哪个区域）
  if (DESTRUCTIVE_TERMS.some((t) => lower.includes(t))) {
    evidence.push("destructive_term");
    return { semanticRole: "DESTRUCTIVE", evidence };
  }
  if (SECURITY_TERMS.some((t) => lower.includes(t))) {
    evidence.push("security_term");
    return { semanticRole: "SECURITY_ACTION", evidence };
  }

  // 3. dialog 内 cancel/close
  if (input.inDialog && CANCEL_TERMS.some((t) => lower.includes(t))) {
    evidence.push("in_dialog", "cancel_term");
    return { semanticRole: "CANCEL", evidence };
  }
  if (input.inDialog && SUBMIT_TERMS.some((t) => lower.includes(t))) {
    evidence.push("in_dialog", "submit_term");
    return { semanticRole: "SUBMIT", evidence };
  }

  // 4. 表单/筛选区内 apply / reset
  if (RESET_TERMS.some((t) => lower.includes(t))) {
    evidence.push("reset_term");
    return { semanticRole: "FILTER_RESET", evidence };
  }
  if (APPLY_TERMS.some((t) => lower.includes(t))) {
    evidence.push("apply_term");
    return { semanticRole: "FILTER_APPLY", evidence };
  }

  // 5. 导航（href 或 nav 区域）
  if (input.href || (input.inNavContainer && !input.inForm)) {
    evidence.push(input.href ? "has_href" : "in_nav_container");
    return { semanticRole: "NAVIGATION", evidence };
  }

  // 6. 工具性
  if (UTILITY_TERMS.some((t) => lower.includes(t))) {
    evidence.push("utility_term");
    return { semanticRole: "UTILITY", evidence };
  }

  // 7. modal trigger（对话框开启：不在 dialog 内，词含"设置/管理/新建"等）
  if (/设置|管理|新建|添加|新增|导入|upload|setting|manage|add|new/i.test(lower)) {
    evidence.push("modal_trigger_term");
    return { semanticRole: "MODAL_TRIGGER", evidence };
  }

  evidence.push("no_strong_signal");
  return { semanticRole: "UNKNOWN", evidence };
}

/** P8.19：semanticRole 不得降低风险——高风险词永远标记高优先级，交由 risk policy 裁决。 */
export function riskRelevantRole(role: ButtonSemanticRole): boolean {
  return role === "DESTRUCTIVE" || role === "SECURITY_ACTION";
}
