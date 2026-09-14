import path from "node:path";
import fs from "fs-extra";
import type { DslStep, FailureReport, LoadedContext, StepExecution } from "./types.js";
import type { FailureStage, ProviderCallRecord } from "./ai-orchestration-schema.js";
import { safeArtifactText, writeSafeJsonArtifact } from "./json-artifact-writer.js";
import { writeSafeTextFile } from "./safe-file-writer.js";

interface BuildInput {
  context: LoadedContext;
  runId: string;
  caseId: string;
  step: DslStep;
  record: StepExecution;
  report: Omit<FailureReport, "report_id" | "created_at">;
  domOrPageSource?: string;
  providerCalls?: ProviderCallRecord[];
  previousSteps?: StepExecution[];
  automationCase?: unknown;
}

export interface CodexFailurePackageResult {
  packagePath: string;
  promptPath: string;
}

export async function writeCodexFailurePackage(input: BuildInput): Promise<CodexFailurePackageResult> {
  const root = path.join(input.context.rootDir, input.context.workspace.artifactRoot, "codex-failure-packages", input.runId);
  await fs.ensureDir(root);
  const baseName = safeName(input.record.dsl_step_id || input.record.step_id);
  const packagePath = path.join(root, `${baseName}.json`);
  const promptPath = path.join(root, `${baseName}.prompt.md`);
  const relative = (value?: string): string | undefined => {
    if (!value) return undefined;
    return path.isAbsolute(value) ? path.relative(input.context.rootDir, value) : value;
  };
  const failureStage = classifyExecutionFailureStage(input.step, input.record, input.report, input.providerCalls ?? []);
  const assertionEvidence = buildAssertionEvidence(input.record, relative);
  const payload = {
    schemaVersion: "failure-package.v1",
    objective: "Analyze this automation failure and propose stable locator or DSL fixes.",
    project: input.context.project.projectKey,
    env: input.context.env.env,
    runId: input.runId,
    run_id: input.runId,
    case_id: input.caseId,
    originalUserRequest: input.step.semantic_target ?? input.step.target ?? "",
    normalizedUserRequest: safeArtifactText(input.step.semantic_target ?? input.step.target ?? ""),
    executionStarted: true,
    failureStage,
    diagnosisSummary: buildDiagnosisSummary(failureStage, assertionEvidence, input.record.error_message ?? input.report.error_message),
    executionSteps: input.previousSteps?.length ? input.previousSteps : [input.record],
    automationCase: summarizeAutomationCase(input.automationCase),
    explainTrace: extractExplainTrace(input.automationCase, input.step),
    providerCalls: input.providerCalls ?? [],
    failed_step: input.step,
    step_execution: input.record,
    failure_report: input.report,
    assertionEvidence,
    finalPageState: buildFinalPageState(input.record),
    networkSummary: input.record.network_summary ?? {
      enabled: false,
      requests: [],
      matchedBusinessApis: [],
      limitations: ["network listener is not available in current executor"]
    },
    aiDiagnosticLog: buildExecutionAiDiagnosticLog(input, relative),
    artifacts: {
      screenshot: relative(input.report.screenshot_path),
      dom_snapshot: relative(input.report.dom_snapshot_path),
      page_source: relative(input.report.page_source_path),
      assertion_after_dom: relative(input.record.assertion_after_dom_path),
      visible_text_snapshot: relative(input.record.visible_text_snapshot_path),
      assertion_evidence: relative(input.record.assertion_evidence_path)
    },
    dom_or_page_source_excerpt: input.domOrPageSource?.slice(0, 20_000),
    expected_response: {
      classification: "locator_failed | page_transition_failed | assertion_failed | test_data_failed | environment_failed | ai_decision_failed | unknown",
      recommended_locator: "stable locator if available",
      fallback_locators: ["optional fallback locators"],
      dsl_patch: "minimal DSL step changes",
      reason: "why this fix should work",
      needs_human_decision: false
    }
  };
  await writeSafeJsonArtifact(packagePath, payload, {
    runId: input.runId,
    project: input.context.project.projectKey,
    env: input.context.env.env,
    originalUserRequestRaw: input.step.semantic_target ?? input.step.target,
    originalUserRequestSafe: safeArtifactText(input.step.semantic_target ?? input.step.target ?? ""),
    detectedIntent: input.step.action,
    retrievalSummary: {},
    coverageGaps: [],
    blockedStage: "execution",
    errorMessage: input.report.error_message
  });
  await writeSafeTextFile(promptPath, buildPrompt(payload));
  return { packagePath, promptPath };
}

function buildExecutionAiDiagnosticLog(input: BuildInput, relative: (value?: string) => string | undefined): Record<string, unknown> {
  const failureStage = classifyExecutionFailureStage(input.step, input.record, input.report, input.providerCalls ?? []);
  const assertionEvidence = buildAssertionEvidence(input.record, relative);
  return {
    schemaVersion: "ai-diagnostic-log.v1",
    failure: {
      stage: failureStage,
      executionStarted: true,
      errorMessage: input.record.error_message ?? input.report.error_message,
      reportCategory: input.report.category
    },
    step: summarizeFailedStep(input.step),
    executionRecord: summarizeExecutionRecord(input.record),
    providerCalls: input.providerCalls ?? [],
    assertionEvidence,
    finalPageState: buildFinalPageState(input.record),
    networkSummary: input.record.network_summary ?? {
      enabled: false,
      requests: [],
      matchedBusinessApis: [],
      limitations: ["network listener is not available in current executor"]
    },
    artifacts: {
      screenshot: relative(input.report.screenshot_path),
      domSnapshot: relative(input.report.dom_snapshot_path),
      pageSource: relative(input.report.page_source_path),
      assertionAfterDom: relative(input.record.assertion_after_dom_path),
      visibleTextSnapshot: relative(input.record.visible_text_snapshot_path),
      assertionEvidence: relative(input.record.assertion_evidence_path)
    },
    diagnosisHints: inferExecutionDiagnosisHints(input.step, input.record, input.report, failureStage, assertionEvidence)
  };
}

function buildDiagnosisSummary(failureStage: FailureStage, assertionEvidence: Record<string, unknown> | undefined, errorMessage?: string): string {
  if (failureStage === "assertion") {
    const diagnostics = assertionEvidence?.assertionDiagnostics && typeof assertionEvidence.assertionDiagnostics === "object"
      ? assertionEvidence.assertionDiagnostics as Record<string, unknown>
      : undefined;
    const rootCause = String(diagnostics?.rootCause ?? "");
    const readiness = diagnostics?.tableReadiness && typeof diagnostics.tableReadiness === "object"
      ? diagnostics.tableReadiness as Record<string, unknown>
      : {};
    if (rootCause === "values_extracted") {
      return "断言已从目标表格提取到数据，失败更可能是期望值不匹配或后续断言逻辑问题。";
    }
    if (rootCause === "empty_state_visible") {
      return "目标结果区域显示空状态。需要确认用户是否允许空结果，或 Page Model 是否把空态绑定到了正确表格容器。";
    }
    if (rootCause === "assertion_column_not_observable") {
      return "断言目标列在当前结果表中不可观察。需要补充列映射或修正用户期望字段。";
    }
    if (rootCause === "table_values_not_extracted") {
      return "结果表可见但断言引擎未能提取目标列值。需要补充通用表格抽取能力或 Page Model resultTable 结构。";
    }
    if (readiness.loading === true) {
      return "断言失败时表格仍处于加载状态。需要检查等待条件、接口响应或结果稳定信号。";
    }
  }
  if (failureStage === "selector") return "元素定位或组件动作失败。优先检查 materialized locator、组件契约和 actionResult trace。";
  if (failureStage === "provider") return "外部验证码或安全验证 provider 失败。优先检查 provider timeline、账号环境和验证弹窗元素。";
  if (failureStage === "external_interrupt") return "浏览器或网络被外部中断。优先排除环境连通性和会话状态。";
  return errorMessage ? `执行失败：${errorMessage}` : "执行失败，需要结合 failureStage、step、页面快照和诊断日志继续分析。";
}

function summarizeFailedStep(step: DslStep): Record<string, unknown> {
  const raw = step as unknown as Record<string, unknown>;
  return {
    id: step.id,
    action: step.action,
    pageModelId: raw.pageModelId,
    elementId: raw.elementId,
    assertionId: raw.assertionId,
    evidenceId: raw.evidenceId,
    semanticTarget: step.semantic_target ?? step.semanticTarget,
    target: step.target,
    primaryLocator: step.primary_locator ?? raw.primaryLocator,
    fallbackLocators: step.fallback_locators,
    value: step.value,
    valueFrom: step.valueFrom,
    assertion: step.assertion
    , explain: raw.explain
  };
}

function summarizeAutomationCase(automationCase: unknown): Record<string, unknown> | undefined {
  if (!automationCase || typeof automationCase !== "object") return undefined;
  const raw = automationCase as Record<string, unknown>;
  const steps = Array.isArray(raw.steps) ? raw.steps as Array<Record<string, unknown>> : [];
  return {
    id: raw.id,
    title: raw.title,
    module: raw.module,
    stepCount: steps.length,
    steps: steps.map((step) => ({
      id: step.id,
      action: step.action,
      semanticTarget: step.semantic_target ?? step.semanticTarget,
      pageModelId: step.pageModelId,
      elementId: step.elementId ?? step.targetElementId,
      assertionId: step.assertionId,
      evidenceId: step.evidenceId,
      providerRequirementId: step.providerRequirementId,
      explain: step.explain
    }))
  };
}

function extractExplainTrace(automationCase: unknown, failedStep: DslStep): Array<Record<string, unknown>> {
  const failedStepId = failedStep.id;
  const caseSteps = automationCase && typeof automationCase === "object" && Array.isArray((automationCase as Record<string, unknown>).steps)
    ? (automationCase as Record<string, unknown>).steps as Array<Record<string, unknown>>
    : [];
  const source = caseSteps.length ? caseSteps : [failedStep as unknown as Record<string, unknown>];
  return source.map((step, index) => ({
    index,
    stepId: step.id,
    action: step.action,
    semanticTarget: step.semantic_target ?? step.semanticTarget,
    failed: failedStepId ? step.id === failedStepId : false,
    explain: step.explain
  }));
}

function summarizeExecutionRecord(record: StepExecution): Record<string, unknown> {
  const raw = record as unknown as Record<string, unknown>;
  return {
    stepId: record.step_id,
    dslStepId: record.dsl_step_id,
    actionType: record.action_type,
    status: record.status,
    startedAt: raw.start_time ?? raw.startedAt,
    endedAt: raw.end_time ?? raw.endedAt,
    durationMs: record.duration_ms,
    errorMessage: record.error_message,
    finalUrl: record.final_url,
    finalTitle: record.final_title,
    finalVisibleTexts: record.final_visible_texts,
    actionResult: raw.action_result,
    assertionSummary: raw.assertion_summary
  };
}

function inferExecutionDiagnosisHints(
  step: DslStep,
  record: StepExecution,
  report: Omit<FailureReport, "report_id" | "created_at">,
  failureStage: FailureStage,
  assertionEvidence?: Record<string, unknown>
): string[] {
  const hints: string[] = [];
  if (failureStage === "selector") hints.push("selector_or_locator_resolution_failed");
  if (failureStage === "assertion") hints.push("assertion_observable_mismatch");
  if (failureStage === "provider") hints.push("external_provider_failed");
  if (failureStage === "external_interrupt") hints.push("browser_or_network_interrupted");
  if (step.action === "assert" && !record.assertion_evidence_path) hints.push("assertion_failed_without_structured_evidence_file");
  if (!record.final_url && !record.final_title && !record.final_visible_texts?.length) hints.push("final_page_state_missing");
  if (/timeout/i.test(record.error_message ?? report.error_message ?? "")) hints.push("timeout_observed");
  const diagnostics = record.assertion_summary?.diagnostics && typeof record.assertion_summary.diagnostics === "object"
    ? record.assertion_summary.diagnostics as Record<string, unknown>
    : assertionEvidence?.assertionDiagnostics && typeof assertionEvidence.assertionDiagnostics === "object"
      ? assertionEvidence.assertionDiagnostics as Record<string, unknown>
      : undefined;
  if (typeof diagnostics?.rootCause === "string") hints.push(`assertion_root_cause:${diagnostics.rootCause}`);
  const readiness = diagnostics?.tableReadiness && typeof diagnostics.tableReadiness === "object"
    ? diagnostics.tableReadiness as Record<string, unknown>
    : undefined;
  if (readiness?.loading === true) hints.push("table_loading_observed");
  if (readiness?.headersReady === true && readiness?.rowsReady === false) hints.push("table_headers_ready_rows_pending");
  const columnResolution = diagnostics?.columnResolution && typeof diagnostics.columnResolution === "object"
    ? diagnostics.columnResolution as Record<string, unknown>
    : undefined;
  if (columnResolution && Number(columnResolution.matchedHeaderIndex) >= 0) hints.push("assertion_column_resolved");
  if (Array.isArray(diagnostics?.trace)) hints.push("assertion_extraction_trace_available");
  return hints;
}

function buildPrompt(payload: unknown): string {
  return [
    "# Codex Automation Failure Analysis",
    "",
    "请分析下面的自动化失败包，给出稳定 locator 或 DSL 修复建议。",
    "",
    "重点判断：",
    "- 当前失败是定位问题、页面路径变化、断言问题、测试数据问题还是环境问题。",
    "- 如果是定位问题，请给出 primary_locator 和 fallback_locators。",
    "- 如果需要修改 DSL，请给出最小 DSL patch。",
    "- 如果无法自动决定，请明确需要人工确认什么。",
    "",
    "```json",
    JSON.stringify(payload, null, 2),
    "```"
  ].join("\n");
}

function safeName(value: string): string {
  return value.replace(/[^\w.-]+/g, "_").slice(0, 80) || "failed-step";
}

function buildAssertionEvidence(record: StepExecution, relative: (value?: string) => string | undefined): Record<string, unknown> | undefined {
  if (!record.assertion_evidence_path && record.action_type !== "assert") return undefined;
  const expectedAssertions = readJsonField<string[]>(record.assertion_evidence_path, "expectedAssertions") ?? [];
  const matchedAssertions = readJsonField<string[]>(record.assertion_evidence_path, "matchedAssertions") ?? [];
  const unmatchedAssertions = readJsonField<string[]>(record.assertion_evidence_path, "unmatchedAssertions") ?? expectedAssertions;
  const assertionDiagnostics = readJsonField<Record<string, unknown>>(record.assertion_evidence_path, "assertionDiagnostics");
  return {
    expectedAssertions,
    matchedAssertions,
    unmatchedAssertions,
    assertionWaitMs: readJsonField<number>(record.assertion_evidence_path, "assertionWaitMs") ?? record.duration_ms,
    assertionError: readJsonField<string>(record.assertion_evidence_path, "assertionError") ?? record.error_message,
    assertionActual: readJsonField<unknown>(record.assertion_evidence_path, "assertionActual"),
    assertionDiagnostics,
    assertionExtractionTrace: Array.isArray(assertionDiagnostics?.trace) ? assertionDiagnostics.trace : undefined,
    tableReadinessTrace: assertionDiagnostics?.tableReadiness,
    columnResolutionTrace: assertionDiagnostics?.columnResolution,
    afterScreenshotPath: relative(record.after_screenshot_path),
    afterDomPath: relative(record.assertion_after_dom_path),
    visibleTextSnapshotPath: relative(record.visible_text_snapshot_path)
  };
}

function buildFinalPageState(record: StepExecution): Record<string, unknown> | undefined {
  if (!record.final_url && !record.final_title && !record.final_visible_texts) return undefined;
  return {
    url: record.final_url,
    title: record.final_title,
    visibleTexts: record.final_visible_texts ?? [],
    capturedAt: new Date().toISOString()
  };
}

function readJsonField<T>(filePath: string | undefined, field: string): T | undefined {
  if (!filePath || !fs.existsSync(filePath)) return undefined;
  try {
    const data = fs.readJsonSync(filePath) as Record<string, unknown>;
    return data[field] as T | undefined;
  } catch {
    return undefined;
  }
}

function classifyExecutionFailureStage(step: DslStep, record: StepExecution, report: Omit<FailureReport, "report_id" | "created_at">, providerCalls: ProviderCallRecord[]): FailureStage {
  if (isExternalInterrupt(record.error_message ?? report.error_message)) return "external_interrupt";
  if (providerCalls.some((call) => call.status === "failed")) return "provider";
  if (isProviderStep(step)) return "provider";
  if (step.action === "assert" || report.category === "assertion_failed" || /assert/i.test(record.error_message ?? "")) return "assertion";
  if (report.category === "locator_failed" || /unable to execute|locator|selector/i.test(record.error_message ?? "")) return "selector";
  return "execution";
}

function isExternalInterrupt(message?: string): boolean {
  return /ERR_NETWORK_CHANGED|ERR_INTERNET_DISCONNECTED|ERR_CONNECTION_RESET|stream disconnected|client.*disconnect|browser.*closed|target page.*closed|request.*aborted/i.test(message ?? "");
}

function isProviderStep(step: DslStep): boolean {
  const valueFrom = step.valueFrom;
  if (typeof valueFrom === "string") return /redisVerificationCode|totp|totpCode|keepassxcTotp/i.test(valueFrom);
  if (!valueFrom || typeof valueFrom !== "object") return false;
  const raw = valueFrom as Record<string, unknown>;
  return /redisVerificationCode|verificationCode|totp|totpCode|keepassxcTotp/i.test(String(raw.type ?? "")) || /redis|totp|keepassxc/i.test(String(raw.provider ?? ""));
}
