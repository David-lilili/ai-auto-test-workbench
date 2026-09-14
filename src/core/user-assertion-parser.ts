import type { PageModelEvidenceSelection, SelectedPageModelEvidence } from "./page-model-evidence-selector.js";
import { normalizeIntentValueForProject } from "./project-intent-routing.js";

export type UserAssertionKind =
  | "result_empty"
  | "record_or_empty_state"
  | "record_contains"
  | "table_column_all_equal"
  | "table_column_all_equal_or_empty"
  | "table_column_date_between"
  | "message_visible_exact"
  | "success_message"
  | "failure_message"
  | "element_disabled"
  | "element_enabled"
  | "tab_active"
  | "list_row_present"
  | "element_absent"
  | "control_state_readable"
  | "ui_text_visible"
  | "field_value"
  | "unknown";

export interface UserAssertionIntent {
  id: string;
  rawText: string;
  kind: UserAssertionKind;
  assertionIntent?: {
    targetPage?: string;
    targetObject?: string;
    field?: string;
    operator?: "all_equal" | "contains" | "visible" | "success" | "failure" | "record_or_empty" | "empty" | "message_visible_exact" | "disabled" | "enabled" | "active" | "selected" | "between" | "date_between";
    expected?: string;
    emptyStateAccepted?: boolean;
    source: "deepseek_intent" | "local_fallback";
    confidence: number;
  };
  targetConcepts: string[];
  expectedTexts: string[];
  acceptsEmptyState: boolean;
  mappedEvidence: Array<{
    id: string;
    kind: SelectedPageModelEvidence["kind"];
    pageId?: string;
    status?: string;
    confidence?: number;
    reason: string;
  }>;
  gaps: string[];
  confidence: number;
}

export interface UserAssertionParseResult {
  schemaVersion: "user-assertion-parse.v1";
  assertions: UserAssertionIntent[];
  gaps: string[];
}

export function parseUserAssertions(input: {
  request?: string;
  assertions?: string[];
  deepSeekIntent?: unknown;
  selection?: PageModelEvidenceSelection;
}): UserAssertionParseResult {
  if (input.assertions?.length) {
    const rawAssertions = input.assertions.map((value) => String(value).trim()).filter(Boolean);
    const assertions = rawAssertions.map((rawText, index) => parseOneAssertion(rawText, index, input.selection));
    return {
      schemaVersion: "user-assertion-parse.v1",
      assertions,
      gaps: [...new Set(assertions.flatMap((item) => item.gaps))]
    };
  }
  const deepSeekAssertions = assertionIntentsFromDeepSeek(input.deepSeekIntent);
  if (deepSeekAssertions.length) {
    const assertions = deepSeekAssertions.map((item, index) => parseOneAssertion(item.rawText, index, input.selection, item.assertionIntent));
    return {
      schemaVersion: "user-assertion-parse.v1",
      assertions,
      gaps: [...new Set(assertions.flatMap((item) => item.gaps))]
    };
  }
  const sourceTexts = [input.request ?? ""];
  if (!sourceTexts.some(hasNormalChineseAssertionLanguage)) {
    return {
      schemaVersion: "user-assertion-parse.v1",
      assertions: [],
      gaps: []
    };
  }
  const rawAssertions = normalizeAssertionTexts(sourceTexts);
  if (!rawAssertions.length && sourceTexts.some(hasNormalChineseAssertionLanguage)) {
    rawAssertions.push(...sourceTexts.map((value) => String(value).trim()).filter(Boolean));
  }
  const assertions = rawAssertions.map((rawText, index) => parseOneAssertion(rawText, index, input.selection));
  return {
    schemaVersion: "user-assertion-parse.v1",
    assertions,
    gaps: [...new Set(assertions.flatMap((item) => item.gaps))]
  };
}

function parseOneAssertion(
  rawText: string,
  index: number,
  selection?: PageModelEvidenceSelection,
  preferredIntent?: UserAssertionIntent["assertionIntent"]
): UserAssertionIntent {
  const assertionIntent = preferredIntent ?? assertionIntentFor(rawText);
  const targetConcepts = conceptsFor(rawText);
  const normalizedIntent = normalizeAssertionIntentForSelection(assertionIntent, selection);
  const targetConceptsForSelection = targetConcepts.map((concept) => normalizeExpectedTextForSelection(concept, selection));
  const kind = kindFor(rawText, normalizedIntent);
  const fallbackExpectedTexts = expectedTextsFor(rawText).map((text) => normalizeExpectedTextForSelection(text, selection));
  const expectedTexts = kind === "list_row_present" && normalizedIntent?.expected === "\u4ea7\u54c1\u884c"
    ? fallbackExpectedTexts
    : normalizedIntent?.expected
      ? [normalizedIntent.expected]
      : fallbackExpectedTexts;
  const mappedEvidence = mapEvidence({ rawText, targetConcepts, expectedTexts, kind, selection });
  const gaps = kind === "unknown"
    ? [`user_assertion_not_understood:${rawText.slice(0, 80)}`]
    : mappedEvidence.length
    ? []
    : [`assertion_capability_missing:${targetConcepts[0] ?? kind}`];
  return {
    id: `user_assertion_${index + 1}`,
    rawText,
    kind,
    assertionIntent: normalizedIntent,
    targetConcepts: targetConceptsForSelection,
    expectedTexts,
    acceptsEmptyState: isEmptyResultAssertion(rawText),
    mappedEvidence,
    gaps,
    confidence: kind === "unknown" ? 0.35 : mappedEvidence.length ? 0.82 : 0.58
  };
}

function normalizeAssertionIntentForSelection(
  assertionIntent: UserAssertionIntent["assertionIntent"] | undefined,
  selection?: PageModelEvidenceSelection
): UserAssertionIntent["assertionIntent"] | undefined {
  if (!assertionIntent?.expected) return assertionIntent;
  const expected = normalizeExpectedTextForSelection(assertionIntent.expected, selection);
  return expected === assertionIntent.expected ? assertionIntent : { ...assertionIntent, expected };
}

function normalizeExpectedTextForSelection(value: string, selection?: PageModelEvidenceSelection): string {
  const typeValuePrefix = "type_value:";
  if (selection && value.startsWith(typeValuePrefix)) {
    const projectAlias = normalizeIntentValueForProject(selection.intent, value.slice(typeValuePrefix.length));
    if (projectAlias) return `${typeValuePrefix}${projectAlias}`;
  }
  if (selection) {
    const projectAlias = normalizeIntentValueForProject(selection.intent, value);
    if (projectAlias) return projectAlias;
  }
  return value;
}

function normalizeAssertionTexts(values: string[]): string[] {
  return values
    .map((value) => String(value).trim())
    .map((value) => value.trim())
    .filter((value) => hasNormalChineseAssertionLanguage(value) || /assert|expect|success|failure|record|empty/i.test(value));
}

function hasNormalChineseAssertionLanguage(value: unknown): boolean {
  return /\u65ad\u8a00|\u671f\u671b|\u5e94\u8be5|\u63d0\u793a|\u62a5\u9519|\u53ea\u663e\u793a|\u53ea\u8fd4\u56de|\u4ec5\u8fd4\u56de|\u53ea\u5305\u542b|\u4ec5\u5305\u542b|\u5747\u4e3a|\u90fd\u662f|\u663e\u793a|\u5c55\u793a|\u51fa\u73b0|\u6210\u529f|\u5931\u8d25|\u7a7a\u72b6\u6001|\u6682\u65e0|\u65e0\u8bb0\u5f55|\u8bb0\u5f55|\u7b5b\u9009\u7ed3\u679c|\u8fd4\u56de\u7a7a|\u4e3a\u7a7a|\u65e0\u6570\u636e|\u6ca1\u6709\u6570\u636e|\u7f6e\u7070|\u4e0d\u53ef\u70b9\u51fb|\u7981\u7528|\u4e0d\u53ef\u7528|\u9ad8\u4eae|\u53ef\u70b9\u51fb|\u53ef\u7528|disabled|enabled|clickable/.test(String(value));
}

function assertionIntentsFromDeepSeek(value: unknown): Array<{
  rawText: string;
  assertionIntent: NonNullable<UserAssertionIntent["assertionIntent"]>;
}> {
  const root = value && typeof value === "object" ? value as Record<string, unknown> : undefined;
  const candidates = Array.isArray(root?.assertions)
    ? root.assertions
    : Array.isArray(root?.assertionIntents)
      ? root.assertionIntents
      : [];
  const results: Array<{ rawText: string; assertionIntent: NonNullable<UserAssertionIntent["assertionIntent"]> }> = [];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const raw = candidate as Record<string, unknown>;
    const expected = typeof raw.expected === "string"
      ? raw.expected.trim()
      : typeof raw.expectedText === "string"
        ? raw.expectedText.trim()
        : typeof raw.value === "string"
          ? raw.value.trim()
          : "";
    const sourceText = String(raw.sourceText ?? raw.rawText ?? raw.description ?? expected);
    let targetObject = normalizeDeepSeekTargetObject(raw.targetObject ?? raw.type ?? raw.assertionType);
    let operator = normalizeDeepSeekAssertionOperator(raw.operator ?? raw.matchMode ?? raw.assertionOperator, targetObject);
    if (targetObject === "message" && !isExplicitRuntimeMessageAssertion(sourceText)) {
      targetObject = "page";
      if (operator === "message_visible_exact") operator = "visible";
    }
    if (!targetObject || !operator || !expected) continue;
    results.push({
      rawText: sourceText,
      assertionIntent: {
        targetPage: typeof raw.targetPage === "string" ? raw.targetPage : undefined,
        targetObject,
        field: typeof raw.field === "string" ? raw.field : typeof raw.semanticField === "string" ? raw.semanticField : undefined,
        operator,
        expected,
        emptyStateAccepted: Boolean(raw.emptyStateAccepted),
        source: "deepseek_intent",
        confidence: clampConfidence(raw.confidence, 0.86)
      }
    });
  }
  return results;
}

function isExplicitRuntimeMessageAssertion(text: string): boolean {
  return /toast|message|alert|\u63d0\u793a|\u5f39\u7a97|\u62a5\u9519|\u901a\u77e5/.test(text);
}

function normalizeDeepSeekTargetObject(value: unknown): string | undefined {
  const text = String(value ?? "").toLowerCase();
  if (/message|toast|alert|notification|\u63d0\u793a|\u5f39\u7a97/.test(text)) return "message";
  if (/tab|tag|\u6807\u7b7e|\u9875\u7b7e/.test(text)) return "tab";
  if (/table|list|result|record|\u5217\u8868|\u8868\u683c|\u8bb0\u5f55/.test(text)) return "result_table";
  if (/page|\u9875\u9762/.test(text)) return "page";
  return undefined;
}

function normalizeDeepSeekAssertionOperator(value: unknown, targetObject?: string): NonNullable<UserAssertionIntent["assertionIntent"]>["operator"] | undefined {
  const text = String(value ?? "").toLowerCase();
  if (targetObject === "message" && /exact|visible|equals?|match|message_visible_exact|visible_exact/.test(text)) return "message_visible_exact";
  if (/between|range|date_between|within/.test(text)) return "between";
  if (/all_equal|equals?|only|all/.test(text)) return "all_equal";
  if (/empty/.test(text)) return "empty";
  if (/contains?/.test(text)) return "contains";
  if (/visible/.test(text)) return "visible";
  if (/success/.test(text)) return "success";
  if (/failure|fail/.test(text)) return "failure";
  if (/disabled|\u7f6e\u7070|\u4e0d\u53ef\u70b9\u51fb|\u7981\u7528|\u4e0d\u53ef\u7528/.test(text)) return "disabled";
  if (/enabled|clickable|\u9ad8\u4eae|\u53ef\u70b9\u51fb|\u53ef\u7528/.test(text)) return "enabled";
  if (/active|selected|\u9ad8\u4eae|\u9009\u4e2d|\u5904\u4e8e\u9009\u4e2d/.test(text)) return "active";
  if (targetObject === "message") return "message_visible_exact";
  return undefined;
}

function clampConfidence(value: unknown, fallback: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.min(1, numeric));
}

function assertionIntentFor(text: string): UserAssertionIntent["assertionIntent"] | undefined {
  const disabledControl = disabledControlExpectation(text);
  if (disabledControl) {
    return {
      targetObject: "field",
      field: disabledControl.field,
      operator: "disabled",
      expected: disabledControl.expected,
      emptyStateAccepted: false,
      source: "local_fallback",
      confidence: 0.84
    };
  }
  const activeTab = activeTabExpectation(text);
  if (activeTab) {
    return {
      targetObject: "tab",
      field: "product_type",
      operator: "active",
      expected: activeTab,
      emptyStateAccepted: false,
      source: "local_fallback",
      confidence: 0.86
    };
  }
  const enabledControl = enabledControlExpectation(text);
  if (enabledControl) {
    return {
      targetObject: "field",
      field: enabledControl.field,
      operator: "enabled",
      expected: enabledControl.expected,
      emptyStateAccepted: false,
      source: "local_fallback",
      confidence: 0.84
    };
  }
  const explicitMessage = explicitMessageExpectation(text);
  if (explicitMessage) {
    return {
      targetObject: "message",
      operator: "message_visible_exact",
      expected: explicitMessage,
      emptyStateAccepted: false,
      source: "local_fallback",
      confidence: 0.9
    };
  }
  const clearedFilter = clearedFilterExpectation(text);
  if (clearedFilter) {
    return {
      targetPage: fundFlowTargetPageFromText(text),
      targetObject: "field",
      field: clearedFilter.field,
      operator: "visible",
      expected: clearedFilter.expected,
      emptyStateAccepted: false,
      source: "local_fallback",
      confidence: 0.78
    };
  }
  if (isProductCenterRowVisibleAssertion(text)) {
    return {
      targetPage: "earn_product_center",
      targetObject: "result_table",
      field: "product_row",
      operator: "visible",
      expected: "\u4ea7\u54c1\u884c",
      emptyStateAccepted: false,
      source: "local_fallback",
      confidence: 0.84
    };
  }
  const dateRange = dateRangeExpectation(text);
  if (dateRange && /\u5217\u8868|\u8868\u683c|\u8bb0\u5f55|\u6d41\u6c34|\u7ed3\u679c/.test(text) && /\u65f6\u95f4|\u65e5\u671f/.test(text)) {
    return {
      targetPage: fundFlowTargetPageFromText(text),
      targetObject: "result_table",
      field: "\u65f6\u95f4",
      operator: "date_between",
      expected: `${dateRange.start}~${dateRange.end}`,
      emptyStateAccepted: false,
      source: "local_fallback",
      confidence: 0.84
    };
  }
  const expectedType = expectedTypeValueForAssertion(text);
  if (expectedType && /\u5217\u8868|\u7ed3\u679c|\u6570\u636e|\u53ea\u663e\u793a|\u53ea\u8fd4\u56de|\u4ec5\u8fd4\u56de|\u53ea\u5305\u542b|\u4ec5\u5305\u542b|\u5747\u4e3a|\u90fd\u662f|\u5e01\u79cd|\u72b6\u6001|\u4ea7\u54c1\u7c7b\u578b|\u7c7b\u578b\u5217|\u4ea4\u6613\u7c7b\u578b|\u7c7b\u578b/.test(text)) {
    return {
      targetPage: fundFlowTargetPageFromText(text),
      targetObject: "result_table",
      field: assertionFieldFromText(text),
      operator: "all_equal",
      expected: expectedType,
      emptyStateAccepted: isEmptyResultAssertion(text),
      source: "local_fallback",
      confidence: 0.82
    };
  }
  if (isPureEmptyResultAssertion(text)) {
    return {
      targetPage: fundFlowTargetPageFromText(text),
      targetObject: "result_table",
      operator: "empty",
      expected: "empty",
      emptyStateAccepted: true,
      source: "local_fallback",
      confidence: 0.86
    };
  }
  return undefined;
}

function kindFor(text: string, assertionIntent?: UserAssertionIntent["assertionIntent"]): UserAssertionKind {
  if (/状态.{0,8}(?:可读|可读取|可观察|可获取)|(?:可读|可读取).{0,8}状态|aria-checked|data-state/i.test(text)) return "control_state_readable";
  if (/(?:不展示|未展示|没有|不存在|未提供|不提供|无).{0,20}(?:输入框|控件|字段|按钮|input|textbox)|(?:输入框|控件|字段|按钮|input|textbox).{0,20}(?:不展示|未展示|没有|不存在|未提供|不提供|无)/i.test(text)) return "element_absent";
  if (assertionIntent?.operator === "disabled" || /(?:按钮|button|控件|确认|确定|保存|提交).{0,16}(?:置灰|不可点击|禁用|不可用|disabled)|(?:置灰|不可点击|禁用|不可用|disabled).{0,16}(?:按钮|button|控件|确认|确定|保存|提交)/i.test(text)) return "element_disabled";
  if (assertionIntent?.targetObject === "tab" && (assertionIntent.operator === "active" || assertionIntent.operator === "selected")) return "tab_active";
  if (/(?:标签|页签|tab).{0,16}(?:高亮|选中|处于选中|active|selected)|(?:高亮|选中|处于选中|active|selected).{0,16}(?:标签|页签|tab)/i.test(text)) return "tab_active";
  if (isProductCenterRowVisibleAssertion(text)) return "list_row_present";
  if (assertionIntent?.operator === "enabled" || /(?:按钮|button|控件|确认|确定|保存|提交).{0,16}(?:高亮|可点击|可用|enabled|clickable)|(?:高亮|可点击|可用|enabled|clickable).{0,16}(?:按钮|button|控件|确认|确定|保存|提交)/i.test(text)) return "element_enabled";
  if (assertionIntent?.operator === "message_visible_exact") return "message_visible_exact";
  if (assertionIntent?.targetObject === "field") return "field_value";
  if (assertionIntent?.targetObject === "page" && assertionIntent.operator === "visible") return "ui_text_visible";
  if (
    assertionIntent?.targetObject === "result_table" &&
    assertionIntent.field &&
    isTimeColumnName(assertionIntent.field) &&
    dateRangeExpectation(assertionIntent.expected ?? text)
  ) {
    return "table_column_date_between";
  }
  if (assertionIntent?.targetObject === "result_table" && assertionIntent.field && assertionIntent.operator === "all_equal") {
    return assertionIntent.emptyStateAccepted ? "table_column_all_equal_or_empty" : "table_column_all_equal";
  }
  if (
    assertionIntent?.targetObject === "result_table" &&
    assertionIntent.field &&
    (assertionIntent.operator === "between" || assertionIntent.operator === "date_between") &&
    isTimeColumnName(assertionIntent.field) &&
    dateRangeExpectation(assertionIntent.expected ?? text)
  ) {
    return "table_column_date_between";
  }
  if (dateRangeExpectation(text) && /\u5217\u8868|\u8868\u683c|\u8bb0\u5f55|\u6d41\u6c34|\u7ed3\u679c/.test(text) && /\u65f6\u95f4|\u65e5\u671f/.test(text)) return "table_column_date_between";
  if (assertionIntent?.operator === "empty" || isPureEmptyResultAssertion(text)) return "result_empty";
  if (/\u53ea\u663e\u793a|\u53ea\u8fd4\u56de|\u4ec5\u8fd4\u56de|\u53ea\u5305\u542b|\u4ec5\u5305\u542b|\u5747\u4e3a|\u90fd\u662f/.test(text) && /\u5e01\u79cd|\u72b6\u6001|\u4ea7\u54c1\u7c7b\u578b|\u7c7b\u578b|\u4ea4\u6613\u7c7b\u578b/.test(text) && /\u7a7a\u72b6\u6001|\u6682\u65e0|\u65e0\u8bb0\u5f55/.test(text)) return "table_column_all_equal_or_empty";
  if (expectedTypeValueForAssertion(text) && /\u5217\u8868|\u53ea\u663e\u793a|\u53ea\u8fd4\u56de|\u4ec5\u8fd4\u56de|\u53ea\u5305\u542b|\u4ec5\u5305\u542b|\u5747\u4e3a|\u90fd\u662f/.test(text) && /\u5e01\u79cd|\u8d44\u4ea7|\u72b6\u6001|\u4ea7\u54c1\u7c7b\u578b|\u7c7b\u578b|\u4ea4\u6613\u7c7b\u578b/.test(text)) return "table_column_all_equal";
  if (/\u8bb0\u5f55.*\u7a7a\u72b6\u6001|\u7a7a\u72b6\u6001|\u6682\u65e0|\u65e0\u8bb0\u5f55/i.test(text)) return "record_or_empty_state";
  // 控件值断言（下拉框/输入框/字段 显示或恢复为某值）优先于泛页面可见分支：
  // "类型下拉框显示全部类型" 是字段值校验，不是页面文本可见。
  if (/\u4e0b\u62c9\u6846|\u8f93\u5165\u6846|\u5b57\u6bb5|select|dropdown|combobox|input|textbox/i.test(text) && /\u663e\u793a|\u6062\u590d|\u4e3a|\u503c|selected|value/i.test(text)) return "field_value";
  if (/\u9875\u9762|\u5f39\u7a97|\u62bd\u5c49|\u5206\u533a|section|modal|drawer/i.test(text) && /\u51fa\u73b0|\u5c55\u793a|\u663e\u793a|\u53ef\u89c1|visible/i.test(text)) return "ui_text_visible";
  if (/\u8bb0\u5f55|\u6d41\u6c34|\u5217\u8868|\u51fa\u73b0|\u53ea\u663e\u793a|\u5c55\u793a|\u663e\u793a/i.test(text)) return "record_contains";
  if (/\u6210\u529f|\u63d0\u4ea4\u6210\u529f|\u5212\u8f6c\u6210\u529f|\u63d0\u73b0\u6210\u529f/i.test(text)) return "success_message";
  if (/\u5931\u8d25|\u9519\u8bef|\u4f59\u989d\u4e0d\u8db3|\u98ce\u63a7|\u6743\u9650|KYC/i.test(text)) return "failure_message";
  if (/\u7b5b\u9009\u4e3a|\u9009\u62e9\u4e3a|\u503c\u4e3a|\u53ea\u663e\u793a|\u663e\u793a\u7c7b\u578b|\u7c7b\u578b\u4e3a/i.test(text)) return "field_value";
  return "unknown";
}

function assertionFieldFromText(text: string): string {
  if (/\u65f6\u95f4|\u65e5\u671f/.test(text)) return "\u65f6\u95f4";
  if (/\u5e01\u79cd|\u8d44\u4ea7/.test(text)) return "\u5e01\u79cd";
  if (/\u72b6\u6001/.test(text) && !/\u7a7a\u72b6\u6001/.test(text)) return "\u72b6\u6001";
  if (/\u4ea4\u6613\u7c7b\u578b/.test(text)) return "\u4ea4\u6613\u7c7b\u578b";
  if (/\u4ea7\u54c1\u7c7b\u578b/.test(text)) return "\u4ea7\u54c1\u7c7b\u578b";
  return "\u7c7b\u578b";
}

function isTimeColumnName(value: string): boolean {
  return /\u65f6\u95f4|\u65e5\u671f|time|date/i.test(value);
}

function dateRangeExpectation(text: string): { start: string; end: string } | undefined {
  const matches = [...String(text).matchAll(/\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?/g)].map((match) => match[0].trim());
  if (matches.length < 2) return undefined;
  return { start: normalizeDateTimeBoundary(matches[0], "start"), end: normalizeDateTimeBoundary(matches[1], "end") };
}

function normalizeDateTimeBoundary(value: string, boundary: "start" | "end"): string {
  const normalized = value.replace(/\//g, "-").replace(/\s+/g, " ").trim();
  if (/\d{1,2}:\d{2}/.test(normalized)) return normalized;
  return `${normalized} ${boundary === "start" ? "00:00:00" : "23:59:59"}`;
}

function fundFlowTargetPageFromText(text: string): string | undefined {
  if (/\u7406\u8d22\u6d41\u6c34/.test(text)) return "earn_fund_flow";
  if (/\u5408\u7ea6\u6d41\u6c34/.test(text)) return "contract_fund_flow";
  if (/\u73b0\u8d27|\u8d44\u91d1\u6d41\u6c34|\u73b0\u8d27\u6d41\u6c34/.test(text)) return "spot_fund_flow";
  return undefined;
}

function isProductCenterRowVisibleAssertion(text: string): boolean {
  return /\u7406\u8d22\u4ea7\u54c1|\u4ea7\u54c1\u4e2d\u5fc3|\u4ea7\u54c1\u5217\u8868/.test(text) &&
    /\u4ea7\u54c1\u884c|\u884c/.test(text) &&
    /\u5c55\u793a|\u663e\u793a|\u53ef\u89c1|\u5305\u542b/.test(text);
}

function activeTabExpectation(text: string): string | undefined {
  if (!/(?:标签|页签|tab).{0,16}(?:高亮|选中|处于选中|active|selected)|(?:高亮|选中|处于选中|active|selected).{0,16}(?:标签|页签|tab)/i.test(text)) return undefined;
  const quoted = text.match(/[“"']([^”"']{1,30}(?:理财产品|理财|产品)?)["'”]/)?.[1]?.trim();
  if (quoted) return quoted;
  if (/活期/.test(text)) return "\u6d3b\u671f\u7406\u8d22";
  if (/定期/.test(text)) return "\u5b9a\u671f\u7406\u8d22";
  return "\u9009\u4e2d\u6807\u7b7e";
}

function conceptsFor(text: string): string[] {
  const concepts: string[] = [];
  const explicitMessage = explicitMessageExpectation(text);
  if (explicitMessage) concepts.push("message_signal", `message_text:${explicitMessage}`);
  const expectedType = expectedTypeValueForAssertion(text);
  if (expectedType) concepts.push(`type_value:${expectedType}`);
  if (/\u8d60\u5e01/.test(text)) concepts.push("gift_coin_type");
  if (/\u7ea2\u5305\u53d1\u653e/.test(text)) concepts.push("red_packet_issued_type");
  if (/\u4ea4\u6613/.test(text)) concepts.push("trade_type");
  if (/\u5145\u503c/.test(text)) concepts.push("deposit_type");
  if (/\u5212\u8f6c/.test(text)) concepts.push("transfer_record");
  if (/\u63d0\u73b0/.test(text)) concepts.push("withdraw_record");
  if (/USDT/.test(text)) concepts.push("asset_usdt");
  if (/BSC/.test(text)) concepts.push("network_bsc");
  if (/\u73b0\u8d27/.test(text)) concepts.push("spot_account");
  if (/\u5408\u7ea6/.test(text)) concepts.push("futures_account");
  if (/\u5730\u5740/.test(text)) concepts.push("withdraw_address");
  if (/\u624b\u7eed\u8d39/.test(text)) concepts.push("fee");
  if (/\u4f59\u989d/.test(text)) concepts.push("balance");
  if (/\u6210\u529f/.test(text)) concepts.push("success_message");
  if (/\u5931\u8d25|\u9519\u8bef/.test(text)) concepts.push("failure_message");
  if (isEmptyResultAssertion(text)) concepts.push("empty_state");
  if (clearedFilterExpectation(text)) concepts.push("selected_filter_state", "filter_default_value");
  const activeTab = activeTabExpectation(text);
  if (activeTab) concepts.push("tab_active", `tab_value:${activeTab}`);
  if (isProductCenterRowVisibleAssertion(text)) concepts.push("product_row", "earn_product_center_list");
  if (/\u7f6e\u7070|\u4e0d\u53ef\u70b9\u51fb|\u7981\u7528|\u4e0d\u53ef\u7528|disabled/i.test(text)) concepts.push("element_disabled", "disabled_button", "control_state");
  if (/状态.{0,8}(?:可读|可读取|可观察|可获取)|(?:可读|可读取).{0,8}状态|aria-checked|data-state/i.test(text)) concepts.push("control_state_readable", "control_state", "switch_state");
  if (/(?:不展示|未展示|没有|不存在|未提供|不提供|无).{0,20}(?:输入框|控件|字段|按钮|input|textbox)|(?:输入框|控件|字段|按钮|input|textbox).{0,20}(?:不展示|未展示|没有|不存在|未提供|不提供|无)/i.test(text)) concepts.push("element_absent", "input_absent");
  if (/UID|uid/i.test(text)) concepts.push("uid");
  if (/\u90ae\u7bb1|email/i.test(text)) concepts.push("email");
  if (/\u8c37\u6b4c\u9a8c\u8bc1\u7801|google|ga|totp/i.test(text)) concepts.push("google_auth_status", "totp");
  if (/\u8d44\u91d1\u5bc6\u7801/.test(text)) concepts.push("fund_password");
  if (/\u624b\u673a\u53f7/.test(text)) concepts.push("mobile");
  if (/\u767b\u5f55\u5bc6\u7801/.test(text)) concepts.push("login_password");
  if (/\u9080\u8bf7\u7801|\u9080\u8bf7\u94fe\u63a5/.test(text)) concepts.push("invite_code");
  if (/\u8eab\u4efd\u8ba4\u8bc1|KYC/i.test(text)) concepts.push("kyc");
  if (/API/i.test(text)) concepts.push("api_management");
  return [...new Set(concepts)];
}

function expectedTextsFor(text: string): string[] {
  const values = new Set<string>();
  const explicitMessage = explicitMessageExpectation(text);
  if (explicitMessage) return [explicitMessage];
  if (isProductCenterRowVisibleAssertion(text)) {
    const productValues = ["SOL", "USDT", "BTC", "ETH", "ZEC", "\u8fdb\u884c\u4e2d", "\u6d3b\u671f", "\u5b9a\u671f", "\u7533\u8d2d"].filter((token) => text.includes(token));
    const productName = text.match(/(?:产品名称为|产品名为|名称为)?\s*([A-Za-z0-9]+新理财)/)?.[1];
    if (productName) productValues.push(productName);
    return [...new Set(productValues.length ? productValues : ["\u4ea7\u54c1\u884c"])];
  }
  for (const value of visibleTextExpectations(text)) values.add(value);
  const clearedFilter = clearedFilterExpectation(text);
  if (clearedFilter) return [clearedFilter.expected];
  const expectedType = expectedTypeValueForAssertion(text);
  if (expectedType) return [expectedType];
  if (isPureEmptyResultAssertion(text)) return ["empty"];
  const disabledControl = disabledControlExpectation(text);
  if (disabledControl) values.add(disabledControl.expected);
  const enabledControl = enabledControlExpectation(text);
  if (enabledControl) values.add(enabledControl.expected);
  for (const token of ["\u8d60\u5e01", "\u5212\u8f6c", "\u8d26\u6237\u5212\u8f6c", "USDT", "BSC", "50", "-50.00", "\u73b0\u8d27", "\u5408\u7ea6", "\u6210\u529f", "\u5931\u8d25", "\u6682\u65e0\u6570\u636e", "\u6682\u65e0\u8bb0\u5f55"]) {
    if (text.includes(token) && !expectedType) values.add(token);
  }
  const address = text.match(/0x[a-fA-F0-9]{32,}/)?.[0];
  if (address) values.add(address);
  return [...values];
}

function visibleTextExpectations(text: string): string[] {
  const normalized = text.replace(/[“”]/g, "\"").replace(/[‘’]/g, "'");
  const values = new Set<string>();
  const listMatch = normalized.match(/(?:展示|显示|出现|包含|可见)([^。；;\n]+)/)?.[1];
  if (listMatch) {
    for (const token of listMatch.split(/[、,，和及]/).map((item) => item.trim()).filter(Boolean)) {
      const cleaned = token
        .replace(/^(页面|弹窗|抽屉|中|里|内|并|和|以及|应|应该|期望|展示|显示|出现|包含|可见)+/, "")
        .replace(/(输入框|按钮|入口|状态|设置项|等|信息|区域|内容)$/g, "")
        .replace(/^["']|["']$/g, "")
        .trim();
      if (isUsefulVisibleTextExpectation(cleaned)) values.add(cleaned);
    }
  }
  for (const token of [
    "UID",
    "邮箱",
    "登录密码",
    "手机号",
    "谷歌验证码",
    "资金密码",
    "提币白名单",
    "我的邀请码",
    "邀请码",
    "邀请链接",
    "身份认证",
    "未认证",
    "开始认证",
    "请选择您的国家或地区",
    "美国",
    "API管理",
    "创建API",
    "立即创建",
    "标签",
    "确认",
    "您当前未创建API"
  ]) {
    if (normalized.includes(token)) values.add(token);
  }
  return [...values];
}

function isUsefulVisibleTextExpectation(value: string): boolean {
  if (!value || value.length > 30) return false;
  if (/^(和|及|以及|等|入口|页面|弹窗|按钮|输入框|状态|设置项)$/.test(value)) return false;
  return true;
}

function disabledControlExpectation(text: string): { field: string; expected: string } | undefined {
  if (!/置灰|不可点击|禁用|不可用|disabled/i.test(text)) return undefined;
  if (/保存/.test(text)) return { field: "save_button", expected: "保存" };
  if (/提交/.test(text)) return { field: "submit_button", expected: "提交" };
  if (/确认|确定|confirm/i.test(text)) return { field: "confirm_button", expected: "确认/确定" };
  if (/按钮|button/i.test(text)) return { field: "button", expected: "disabled" };
  return { field: "control", expected: "disabled" };
}

function enabledControlExpectation(text: string): { field: string; expected: string } | undefined {
  if (!/高亮|可点击|可用|enabled|clickable/i.test(text)) return undefined;
  if (/保存/.test(text)) return { field: "save_button", expected: "保存" };
  if (/提交/.test(text)) return { field: "submit_button", expected: "提交" };
  if (/确认|确定|confirm/i.test(text)) return { field: "confirm_button", expected: "确认/确定" };
  if (/按钮|button/i.test(text)) return { field: "button", expected: "enabled" };
  return { field: "control", expected: "enabled" };
}

function clearedFilterExpectation(text: string): { field: string; expected: string } | undefined {
  if (!/(筛选|条件|下拉|选择|选中|过滤|filter)/i.test(text)) return undefined;
  if (!/(清空|被清空|重置|恢复默认|默认状态|reset|cleared?)/i.test(text)) return undefined;
  const field = assertionFieldFromText(text);
  if (field === "币种") return { field, expected: "全部币种" };
  if (field === "产品类型") return { field, expected: "全部产品" };
  if (field === "交易类型") return { field, expected: "全部类型" };
  return { field, expected: "全部类型" };
}

function explicitMessageExpectation(text: string): string | undefined {
  const normalized = text.replace(/[“”]/g, "\"").replace(/[‘’]/g, "'");
  const patterns = [
    /(?:\u671f\u671b|\u65ad\u8a00|\u5e94\u8be5)[^\n\u3002\uff1b;]{0,20}?(?:\u63d0\u793a|\u5f39\u7a97\u63d0\u793a|\u62a5\u9519|toast|message|alert)\s*["']([^"']{1,80})["']/i,
    /(?:\u63d0\u793a|\u5f39\u7a97\u63d0\u793a|\u62a5\u9519|toast|message|alert)[^\n\u3002\uff1b;]{0,12}?(?:\u4e3a|\u662f|=|:|：)\s*["']?([^"',\u3002\uff1b;]{1,40})["']?/i,
    /(?:\u671f\u671b|\u65ad\u8a00|\u5e94\u8be5)?[^\n\u3002\uff1b;]{0,20}?(?:\u9875\u9762)?(?:\u63d0\u793a|\u5f39\u7a97\u63d0\u793a|\u62a5\u9519)\s*["']?([^"',\u3002\uff1b;]{2,40})["']?/i
  ];
  for (const pattern of patterns) {
    const value = normalized.match(pattern)?.[1]?.trim();
    if (value) return value;
  }
  return undefined;
}

function isEmptyResultAssertion(text: string): boolean {
  return /\u8fd4\u56de\u7a7a|\u8fd4\u56de\u4e3a\u7a7a|\u5217\u8868\u4e3a\u7a7a|\u7ed3\u679c\u4e3a\u7a7a|\u67e5\u8be2\u7ed3\u679c\u4e3a\u7a7a|\u7a7a\u5217\u8868|\u6ca1\u6709\u6570\u636e|\u65e0\u6570\u636e|\u7a7a\u72b6\u6001|\u6682\u65e0|\u65e0\u8bb0\u5f55|empty/i.test(text);
}

function isPureEmptyResultAssertion(text: string): boolean {
  return /\u8fd4\u56de\u7a7a|\u8fd4\u56de\u4e3a\u7a7a|\u5217\u8868\u4e3a\u7a7a|\u7ed3\u679c\u4e3a\u7a7a|\u67e5\u8be2\u7ed3\u679c\u4e3a\u7a7a|\u7a7a\u5217\u8868|\u6ca1\u6709\u6570\u636e|\u65e0\u6570\u636e|empty/i.test(text);
}

function expectedTypeValueForAssertion(text: string): string | undefined {
  const normalExpected = expectedTypeValueFromNormalChinese(text);
  if (normalExpected) return normalExpected;
  return undefined;
}

function cleanExpectedTypeValue(value: string): string | undefined {
  const cleaned = value
    .replace(/\u7684\u6570\u636e.*$/, "")
    .replace(/\u6216\u7a7a\u72b6\u6001.*$/, "")
    .replace(/閻ㄥ嫭鏆熼幑?/, "")
    .trim();
  return cleaned || undefined;
}

function expectedTypeValueFromNormalChinese(text: string): string | undefined {
  const normalized = text.replace(/[“”]/g, "\"").replace(/[‘’]/g, "'");
  const patterns = [
    /\u5217\u8868[^\u3002\uff1b\n]*?["']?(?:\u4ea4\u6613\u7c7b\u578b|\u4ea7\u54c1\u7c7b\u578b|\u5e01\u79cd|\u72b6\u6001|\u7c7b\u578b)["']?\u5217?(?:\u4ec5\u8fd4\u56de|\u53ea\u8fd4\u56de|\u53ea\u5305\u542b|\u4ec5\u5305\u542b|\u5747\u4e3a|\u90fd\u662f|\u4e3a|\u662f)\s*["']?([^"',\u3001\uff0c\u3002\uff1b\s]+)["']?/,
    /\u5217\u8868[^\u3002\uff1b\n]*?(?:\u8fd4\u56de|\u53ea\u8fd4\u56de|\u4ec5\u8fd4\u56de|\u5c55\u793a|\u663e\u793a|\u5305\u542b)[^\u3002\uff1b\n]*?(?:\u5e01\u79cd|\u8d44\u4ea7|\u72b6\u6001|\u4ea7\u54c1\u7c7b\u578b|\u4ea4\u6613\u7c7b\u578b|\u7c7b\u578b)\u5217?(?:\u5747\u4e3a|\u90fd\u662f|\u90fd\u4e3a|\u4e3a|\u662f)\s*["']?([^"',\u3001\uff0c\u3002\uff1b\s]+)["']?/,
    /\u671f\u671b[^\u3002\uff1b\n]*?(?:\u5e01\u79cd|\u8d44\u4ea7|\u72b6\u6001|\u4ea7\u54c1\u7c7b\u578b|\u4ea4\u6613\u7c7b\u578b|\u7c7b\u578b)\u5217?(?:\u5747\u4e3a|\u90fd\u662f|\u90fd\u4e3a|\u4e3a|\u662f)\s*["']?([^"',\u3001\uff0c\u3002\uff1b\s]+)["']?/,
    /\u5c55\u793a\s*["']?([^"',\u3001\uff0c\u3002\uff1b\s]+)["']?\u7c7b\u578b(?:\u8bb0\u5f55|\u6570\u636e)/,
    /\u671f\u671b[^\u3002\uff1b\n]*?(?:\u53ea\u8fd4\u56de|\u4ec5\u8fd4\u56de|\u53ea\u5305\u542b|\u4ec5\u5305\u542b)[^\u3002\uff1b\n]*?(?:\u4ea4\u6613\u7c7b\u578b|\u7c7b\u578b)(?:\u4e3a|\u662f)?\s*["']?([^"',\u3001\uff0c\u3002\uff1b\s]+)["']?/,
    /\u671f\u671b[^\u3002\uff1b\n]*?(?:\u4ea4\u6613\u7c7b\u578b|\u7c7b\u578b)\u5217?(?:\u5747\u4e3a|\u90fd\u662f|\u53ea\u5305\u542b|\u4ec5\u5305\u542b|\u53ea\u8fd4\u56de|\u4ec5\u8fd4\u56de)\s*["']?([^"',\u3001\uff0c\u3002\uff1b\s]+)["']?/,
    /\u5217\u8868[^\u3002\uff1b\n]*?(?:\u53ea\u8fd4\u56de|\u4ec5\u8fd4\u56de|\u53ea\u5305\u542b|\u4ec5\u5305\u542b)[^\u3002\uff1b\n]*?(?:\u4ea4\u6613\u7c7b\u578b|\u7c7b\u578b)(?:\u4e3a|\u662f)?\s*["']?([^"',\u3001\uff0c\u3002\uff1b\s]+)["']?/,
    /\u5217\u8868[^\u3002\uff1b\n]*?(?:\u4ea4\u6613\u7c7b\u578b|\u7c7b\u578b)\u5217?(?:\u5747\u4e3a|\u90fd\u662f|\u53ea\u5305\u542b|\u4ec5\u5305\u542b)\s*["']?([^"',\u3001\uff0c\u3002\uff1b\s]+)["']?/,
    /\u671f\u671b[^\u3002\uff1b\n]*?\u53ea\u663e\u793a[^\u3002\uff1b\n]*?\u7c7b\u578b(?:\u4e3a|\u662f|\u663e\u793a\u4e3a)?\s*["']?([^"',\u3001\uff0c\u3002\uff1b\s]+)["']?/,
    /\u671f\u671b[^\u3002\uff1b\n]*?\u7c7b\u578b\u5217(?:\u53ea\u663e\u793a|\u5168\u90e8\u4e3a|\u90fd\u662f|\u663e\u793a|\u663e\u793a\u4e3a|\u4e3a|\u662f)\s*["']?([^"',\u3001\uff0c\u3002\uff1b\s]+)["']?/,
    /\u671f\u671b[^\u3002\uff1b\n]*?\u5217\u8868[^\u3002\uff1b\n]*?\u7c7b\u578b\u5217(?:\u53ea\u663e\u793a|\u5168\u90e8\u4e3a|\u90fd\u662f|\u663e\u793a|\u663e\u793a\u4e3a|\u4e3a|\u662f)\s*["']?([^"',\u3001\uff0c\u3002\uff1b\s]+)["']?/,
    /\u65ad\u8a00[^\u3002\uff1b\n]*?\u7c7b\u578b\u5217(?:\u53ea\u663e\u793a|\u5168\u90e8\u4e3a|\u90fd\u662f|\u663e\u793a|\u663e\u793a\u4e3a|\u4e3a|\u662f)\s*["']?([^"',\u3001\uff0c\u3002\uff1b\s]+)["']?/
  ];
  for (const pattern of patterns) {
    const value = normalized.match(pattern)?.[1]?.trim();
    const cleaned = value ? cleanExpectedTypeValue(value) : undefined;
    if (cleaned) return cleaned;
  }
  return undefined;
}

function mapEvidence(input: {
  rawText: string;
  targetConcepts: string[];
  expectedTexts: string[];
  kind: UserAssertionKind;
  selection?: PageModelEvidenceSelection;
}): UserAssertionIntent["mappedEvidence"] {
  if (input.kind === "message_visible_exact") {
    const explicitAssertion = [...(input.selection?.selectedEvidence ?? []), ...(input.selection?.fallbackEvidence ?? [])]
      .find((item) => item.kind === "assertion" && assertionEvidenceMatchesTexts(item, input.expectedTexts));
    if (explicitAssertion) {
      return [{
        id: explicitAssertion.id,
        kind: explicitAssertion.kind,
        pageId: explicitAssertion.pageId,
        status: explicitAssertion.status,
        confidence: explicitAssertion.confidence,
        reason: "Runtime message assertion matched a Page Model message signal."
      }];
    }
    const targetPage = input.selection?.evidenceBuckets?.targetPage?.[0]
      ?? input.selection?.selectedEvidence?.find((item) => item.kind === "page")
      ?? input.selection?.selectedEvidence?.[0];
    return targetPage ? [{
      id: targetPage.id,
      kind: targetPage.kind,
      pageId: targetPage.pageId,
      status: targetPage.status,
      confidence: targetPage.confidence,
      reason: "Runtime message assertion uses target page as execution scope."
    }] : [];
  }
  if (input.kind === "ui_text_visible") {
    const targetPage = input.selection?.evidenceBuckets?.targetPage?.[0]
      ?? input.selection?.selectedEvidence?.find((item) => item.kind === "page");
    const explicitAssertion = [...(input.selection?.fallbackEvidence ?? []), ...(input.selection?.selectedEvidence ?? [])]
      .find((item) => item.kind === "assertion" && assertionEvidenceMatchesTexts(item, input.expectedTexts));
    const target = explicitAssertion ?? targetPage;
    return target ? [{
      id: target.id,
      kind: target.kind,
      pageId: target.pageId,
      status: target.status,
      confidence: target.confidence,
      reason: "Generic UI visible-text assertion uses target page or observable assertion scope."
    }] : [];
  }
  const evidence = [...(input.selection?.selectedEvidence ?? []), ...(input.selection?.fallbackEvidence ?? [])];
  const wantsRecordLikeTarget = /\u8bb0\u5f55|\u6d41\u6c34|\u5217\u8868|\u8868\u683c|record|list|table/i.test(input.rawText);
  const scored = evidence
    .filter((item) => isAssertionEvidenceAllowedForIntent(input.selection, input.kind, item))
    .map((item) => {
      const haystack = `${item.id} ${item.semanticName ?? ""} ${item.reason ?? ""} ${(item.textCandidates ?? []).join(" ")}`.toLowerCase();
      let score = 0;
      for (const concept of input.targetConcepts) {
        if (haystack.includes(concept.replace(/_/g, "")) || conceptMatchesText(concept, haystack)) score += 3;
      }
      for (const expected of input.expectedTexts) {
        if (haystack.includes(expected.toLowerCase())) score += 2;
      }
      if (input.kind.includes("record") && wantsRecordLikeTarget && /record|list|\u6d41\u6c34|\u8bb0\u5f55|\u5217\u8868/i.test(haystack)) score += 3;
      if (input.kind === "result_empty" && /result|list|table|record|empty|\u7ed3\u679c|\u5217\u8868|\u8868\u683c|\u8bb0\u5f55|\u7a7a\u72b6\u6001|\u6682\u65e0/i.test(haystack)) score += 5;
      if (input.kind.startsWith("table_column") && /result|list|table|record|empty|\u7ed3\u679c|\u5217\u8868|\u8bb0\u5f55|\u7a7a\u72b6\u6001/i.test(haystack)) score += 4;
      if (input.kind.startsWith("table_column") && item.kind === "page" && (item as unknown as Record<string, unknown>).resultTable) score += 6;
      if (input.kind.startsWith("table_column") && item.pageId === "demo.funds.spot_fund_flow") score += 2;
      if (input.kind.startsWith("table_column") && item.pageId === "demo.funds.earn_fund_flow") score += 2;
      if (input.kind === "result_empty" && item.pageId === "demo.funds.earn_fund_flow") score += 2;
      if (input.kind.startsWith("table_column") && /filter.*selected|selected.*filter|type_filter.*selected|field_value/i.test(haystack)) score -= 8;
      if (input.kind === "field_value" && /filter.*selected|selected.*filter|type_filter.*selected|selected_value|\u7b5b\u9009.*\u5df2\u9009|\u4e0b\u62c9\u6846/i.test(haystack)) score += 6;
      if (input.kind === "element_disabled" && /element_disabled|disabled|置灰|不可点击|禁用|button|按钮|confirm_button|确认|确定/i.test(haystack)) score += 8;
      if (input.kind === "element_enabled" && /element_enabled|enabled|高亮|可点击|可用|button|按钮|confirm_button|确认|确定/i.test(haystack)) score += 8;
      if (input.kind === "element_enabled" && /element_disabled|disabled|置灰|不可点击|禁用|不可用/i.test(haystack)) score -= 12;
      if (input.kind === "tab_active" && /tab|标签|页签|active|selected|高亮|选中/i.test(haystack)) score += 10;
      if (input.kind === "list_row_present" && /product_list|product_row|row_visible|列表|产品行/i.test(haystack)) score += 10;
      if (input.kind === "control_state_readable" && /control_state_readable|state_readable|状态可读|switch|开关|aria-checked|data-state/i.test(haystack)) score += 10;
      if (input.kind === "element_absent" && /input_absent|absent|not_editable|未提供|不展示|输入框|textbox|input/i.test(haystack)) score += 10;
      if (input.kind === "record_contains" && !wantsRecordLikeTarget && item.kind === "page") score += 3;
      if (input.kind === "record_contains" && assertionEvidenceMatchesTexts(item, input.expectedTexts)) score += 8;
      if (input.kind === "record_contains" && input.expectedTexts.length && item.pageId === input.selection?.evidenceBuckets?.targetPage?.[0]?.pageId) score += 3;
      if (input.kind === "success_message" && /success|\u6210\u529f/i.test(haystack)) score += 3;
      if (input.kind === "failure_message" && /failure|\u5931\u8d25|\u9519\u8bef/i.test(haystack)) score += 3;
      return { item, score };
    })
    .filter(({ item, score }) => {
      if (score <= 0) return false;
      if (!input.kind.startsWith("table_column") && input.kind !== "result_empty") return true;
      const haystack = `${item.id} ${item.semanticName ?? ""} ${item.reason ?? ""}`.toLowerCase();
      if (input.kind.startsWith("table_column") && item.kind === "page" && (item as unknown as Record<string, unknown>).resultTable) return true;
      return item.kind === "page" || /result|list|table|record|empty|\u7ed3\u679c|\u5217\u8868|\u8bb0\u5f55|\u7a7a\u72b6\u6001/i.test(haystack);
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
  return scored.map(({ item, score }) => ({
    id: item.id,
    kind: item.kind,
    pageId: item.pageId,
    status: item.status,
    confidence: item.confidence,
    reason: `Matched user assertion by observable signal score ${score}.`
  }));
}

function assertionEvidenceMatchesTexts(item: SelectedPageModelEvidence, expectedTexts: string[]): boolean {
  if (!expectedTexts.length) return false;
  const haystack = `${item.id} ${item.semanticName ?? ""} ${(item.textCandidates ?? []).join(" ")}`.toLowerCase();
  return expectedTexts.some((text) => haystack.includes(text.toLowerCase()));
}

function isAssertionEvidenceAllowedForIntent(
  selection: PageModelEvidenceSelection | undefined,
  kind: UserAssertionKind,
  item: SelectedPageModelEvidence
): boolean {
  if (!selection || !isFundFlowReadIntent(selection) || (kind !== "result_empty" && !kind.startsWith("table_column"))) return true;
  const targetPageId = fundFlowTargetPageId(selection);
  if (item.pageId && item.pageId !== targetPageId) return false;
  const text = `${item.id} ${item.semanticName ?? ""} ${item.reason ?? ""}`.toLowerCase();
  if (/c3\.withdraw|withdraw|提现|t2_5\.transfer(?:\.|_record)/.test(text)) return false;
  return true;
}

function isFundFlowReadIntent(selection: PageModelEvidenceSelection): boolean {
  return selection.intent.module === "asset" &&
    ["spot_fund_flow_filter", "earn_fund_flow_filter", "contract_fund_flow_filter"].includes(selection.intent.action);
}

function fundFlowTargetPageId(selection: PageModelEvidenceSelection): string {
  if (selection.intent.action === "earn_fund_flow_filter") return "demo.funds.earn_fund_flow";
  if (selection.intent.action === "contract_fund_flow_filter") return "demo.funds.contract_fund_flow";
  return "demo.funds.spot_fund_flow";
}

function conceptMatchesText(concept: string, text: string): boolean {
  const normalAliases: Record<string, RegExp> = {
    gift_coin_type: /\u8d60\u5e01|gift/,
    transfer_record: /\u5212\u8f6c|transfer|\u8d26\u6237\u5212\u8f6c/,
    withdraw_record: /\u63d0\u73b0|withdraw/,
    asset_usdt: /usdt/,
    network_bsc: /bsc|\u94fe|\u7f51\u7edc/,
    spot_account: /\u73b0\u8d27|spot/,
    futures_account: /\u5408\u7ea6|futures|contract/,
    success_message: /\u6210\u529f|success/,
    failure_message: /\u5931\u8d25|\u9519\u8bef|failure|error/,
    empty_state: /\u6682\u65e0|\u7a7a\u72b6\u6001|empty/
  };
  if (normalAliases[concept]?.test(text)) return true;
  return false;
}
