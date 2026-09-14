export interface StructuredCaseContext {
  title: string;
  businessSteps: string[];
  preconditions: string[];
  expectedAssertions: string[];
  expectedResults: string[];
  caseType?: string;
  pageModelId?: string;
}

export function buildStructuredCaseContext(input: {
  title?: string;
  businessRequest?: string;
  request?: string;
  preconditions?: unknown;
  expectedAssertion?: string;
  expectedResults?: unknown;
  caseType?: string;
  pageModelId?: string;
}): StructuredCaseContext {
  return {
    title: String(input.title ?? "").trim(),
    businessSteps: normalizeStepLines(String(input.businessRequest ?? input.request ?? "")),
    preconditions: normalizeStringArray(input.preconditions),
    expectedAssertions: normalizeAssertionLines(input.expectedAssertion),
    expectedResults: normalizeExpectedResults(input.expectedResults),
    caseType: input.caseType,
    pageModelId: input.pageModelId
  };
}

export function caseContextToRequest(context: StructuredCaseContext, input: { project: string; env: string }): string {
  const parts = [`登录 ${input.project} ${input.env} 环境`];
  if (context.title) parts.push(`用例标题：${context.title}`);
  if (context.businessSteps.length) parts.push(`业务步骤：\n${context.businessSteps.map((step, index) => `${index + 1}. ${stripLeadingStepNumber(step)}`).join("\n")}`);
  if (context.expectedAssertions.length) parts.push(`期望断言：\n${context.expectedAssertions.join("\n")}`);
  return parts.join("，");
}

export function lintStructuredCaseContext(context: StructuredCaseContext): string[] {
  const gaps: string[] = [];
  for (const assertion of context.expectedAssertions) {
    if (/标签|页签|tab/i.test(assertion) && /列表|产品行|记录|表格/i.test(assertion)) gaps.push(`mixed_assertion_detected:${assertion.slice(0, 80)}`);
    if (/按钮|确定|确认|保存|提交/i.test(assertion) && /列表|产品行|记录|表格/i.test(assertion)) gaps.push(`mixed_assertion_detected:${assertion.slice(0, 80)}`);
    if (/^(?:列表)?刷新(?:完成)?[。.]?$/.test(assertion.trim())) gaps.push("refresh_assertion_not_observable");
  }
  for (const precondition of context.preconditions) {
    if (/页面具备|页面包含|页面存在|具备.*(?:标签|页签|按钮|输入框|列表)|可进入目标页面|已有可登录/.test(precondition)) {
      gaps.push(`precondition_contains_page_structure:${precondition.slice(0, 80)}`);
    }
  }
  return [...new Set(gaps)];
}

function normalizeStepLines(value: string): string[] {
  return String(value ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function normalizeAssertionLines(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  return String(value ?? "").split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item).trim()).filter(Boolean) : [];
}

function normalizeExpectedResults(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return normalizeStringArray(value);
  if (typeof value === "object" && Array.isArray((value as Record<string, unknown>).ui)) return normalizeStringArray((value as Record<string, unknown>).ui);
  return [];
}

function stripLeadingStepNumber(value: string): string {
  return value.replace(/^\s*\d+[.、)]\s*/, "").trim();
}
