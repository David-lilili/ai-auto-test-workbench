import path from "node:path";
import fs from "fs-extra";
import { writeSafeJsonFile, writeSafeTextFile } from "./safe-file-writer.js";

export type EvidenceSource =
  | "intent"
  | "page_map"
  | "element_store"
  | "business_flow"
  | "historical_dsl"
  | "failure_package"
  | "dom_snapshot"
  | "visible_text_snapshot"
  | "execution_step"
  | "ai_inferred";

export interface EvidenceRef {
  source: EvidenceSource;
  sourceId: string;
  field?: string;
  excerpt?: string;
  confidence: number;
}

export interface LocatorCandidate {
  elementRef?: string;
  semanticName: string;
  role?: "input" | "button" | "link" | "tab" | "text" | "unknown";
  label?: string;
  placeholder?: string;
  text?: string;
  testId?: string;
  css?: string;
  xpath?: string;
  pageId?: string | null;
  confidence: number;
  source: Exclude<EvidenceSource, "intent" | "execution_step">;
  successCount: number;
  failureCount: number;
  lastVerifiedAt?: string;
  fallbackLocators: string[];
  evidence: EvidenceRef[];
}

export interface DataBinding {
  targetField: string;
  semanticName: string;
  value: unknown;
  valueType: "string" | "number" | "boolean" | "asset" | "amount" | "count" | "code" | "unknown";
  source: "intent" | "test_data" | "account_profile" | "provider" | "business_flow" | "ai_inferred" | "default" | "unknown";
  sourcePath?: string;
  evidence: EvidenceRef[];
  confidence: number;
}

export interface LocatorResolutionResult {
  status: "resolved" | "not_found" | "ambiguous" | "element_not_visible" | "candidate_available";
  semanticName: string;
  selectedLocator?: string | null;
  selectedSource?: LocatorCandidate["source"] | null;
  selectedConfidence?: number | null;
  candidates: LocatorCandidate[];
  attemptedLocators: Array<{
    locator: string;
    source?: string;
    status: "success" | "failed";
    reason?: string;
  }>;
  evidence: EvidenceRef[];
  reason?: string;
}

export interface ActionExecutionResult {
  status: "success" | "failed";
  action: "click" | "input" | "select" | "assert";
  expectedValue?: unknown;
  actualValue?: unknown;
  valuePersisted?: boolean;
  validationMessage?: string | null;
  reason:
    | "locator_not_found"
    | "locator_ambiguous"
    | "element_not_visible"
    | "data_binding_error"
    | "value_type_mismatch"
    | "value_rejected"
    | "value_not_persisted"
    | "action_timeout"
    | "unknown";
  evidence: EvidenceRef[];
}

export interface LocatorUpdateProposal {
  proposalType: "LocatorUpdateProposal";
  proposalId: string;
  target: "element_store";
  module: string;
  action: string;
  semanticName: string;
  elementRef: string;
  oldLocator?: string;
  newCandidates: LocatorCandidate[];
  rootCausePriority: "low" | "medium" | "high";
  evidence: EvidenceRef[];
  confidence: number;
  autoWriteRecommended: boolean;
  requiresHumanConfirmation: boolean;
}

export interface DataBindingUpdateProposal {
  proposalType: "DataBindingUpdateProposal";
  proposalId: string;
  target: "dsl_generation_rule" | "business_flow" | "test_data";
  module: string;
  action: string;
  semanticName: string;
  targetField: string;
  oldBinding?: DataBinding;
  newBinding: DataBinding;
  rootCausePriority: "low" | "medium" | "high";
  evidence: EvidenceRef[];
  confidence: number;
  autoWriteRecommended: boolean;
  requiresHumanConfirmation: boolean;
}

export interface FailureDiagnosisResult {
  schemaVersion: "failure-diagnosis.v1";
  generatedAt: string;
  mode: "offline_diagnosis_only";
  sourceFailurePackage: string;
  sourceRunId?: string;
  constraints: {
    browserStarted: false;
    businessRerun: false;
    knowledgeWritten: false;
    businessFlowWritten: false;
    elementStoreWritten: false;
    dslRuleWritten: false;
  };
  diagnosis: {
    semanticName: string;
    failedStepId?: string;
    failureStage?: string;
    oldLocator?: string;
    oldValue?: unknown;
    expectedIntentValue?: unknown;
    expectedIntentSourcePath?: string;
    observedDom?: {
      labelPresent: boolean;
      inputPresent: boolean;
      inputmode?: string;
      maxlength?: string;
      domValue?: string;
      excerpt?: string;
    };
    rootCausePriority: Array<{ cause: string; priority: "low" | "medium" | "high"; reason: string }>;
  };
  locatorEvidence: EvidenceRef[];
  dataBindingEvidence: EvidenceRef[];
  actionExecutionEvidence: EvidenceRef[];
  locatorResolution: LocatorResolutionResult;
  dataBinding: {
    current: DataBinding;
    proposed: DataBinding;
  };
  actionExecutionResult: ActionExecutionResult;
  updateProposals: Array<LocatorUpdateProposal | DataBindingUpdateProposal>;
}

export interface FailureDiagnosisSidecar {
  schemaVersion: "failure-diagnosis-sidecar.v1";
  sourceFailurePackage: string;
  generatedAt: string;
  diagnosis: FailureDiagnosisResult;
  proposals: Array<LocatorUpdateProposal | DataBindingUpdateProposal>;
  writePolicy: {
    writesMainStorage: false;
    requiresHumanConfirmation: true;
  };
}

export interface DiagnoseFailurePackageOptions {
  intentData?: { count?: number };
  intentSourceId?: string;
  generatedAt?: string;
}

interface FailurePackageLike {
  runId?: string;
  run_id?: string;
  failureStage?: string;
  failed_step?: Record<string, unknown>;
  step_execution?: Record<string, unknown>;
  artifacts?: Record<string, unknown>;
}

export async function diagnoseFailurePackage(filePath: string, options: DiagnoseFailurePackageOptions = {}): Promise<FailureDiagnosisResult> {
  const absolutePackagePath = path.resolve(filePath);
  const payload = await fs.readJson(absolutePackagePath) as FailurePackageLike;
  const failedStep = payload.failed_step ?? {};
  const stepExecution = payload.step_execution ?? {};
  const semanticName = stringValue(failedStep.semantic_target) ?? stringValue(failedStep.semanticTarget) ?? stringValue(failedStep.target) ?? "unknown";
  const oldLocator = stringValue(failedStep.primary_locator) ?? stringValue(failedStep.primaryLocator);
  const oldValue = failedStep.value;
  const runId = payload.runId ?? payload.run_id ?? stringValue(stepExecution.run_id);
  const domPath = resolveArtifactPath(filePath, stringValue(payload.artifacts?.dom_snapshot) ?? stringValue(stepExecution.dom_snapshot_path));
  const domEvidence = domPath ? await extractDomFieldEvidence(domPath, semanticName) : undefined;
  const targetField = inferTargetField(semanticName);
  const valueType = inferValueType(semanticName, domEvidence?.inputmode);
  const expectedIntentValue = options.intentData?.count ?? inferExpectedValue(semanticName);
  const intentSourceId = options.intentSourceId ?? "stage2_user_confirmed_requirement";

  const locatorEvidence = buildLocatorEvidence(filePath, oldLocator, domPath, domEvidence);
  const dataBindingEvidence = buildDataBindingEvidence(filePath, oldValue, domPath, domEvidence, expectedIntentValue, intentSourceId);
  const actionExecutionEvidence = buildActionEvidence(runId, failedStep, stepExecution);
  const candidate = buildLocatorCandidate(semanticName, oldLocator, domPath, domEvidence);
  const currentBinding = buildCurrentBinding(targetField, semanticName, oldValue, valueType, filePath);
  const proposedBinding = buildProposedBinding(targetField, semanticName, expectedIntentValue, valueType, intentSourceId, domPath, domEvidence);
  const actionExecutionResult = buildActionExecutionResult(failedStep, stepExecution, proposedBinding.value, dataBindingEvidence);
  const rootCausePriority = buildRootCausePriority(actionExecutionResult.reason);
  const locatorResolution: LocatorResolutionResult = {
    status: candidate ? "candidate_available" : "not_found",
    semanticName,
    selectedLocator: null,
    selectedSource: null,
    candidates: candidate ? [candidate] : [],
    attemptedLocators: oldLocator ? [{
      locator: oldLocator,
      source: "failure_package",
      status: "failed",
      reason: "Execution failed; offline diagnosis does not mutate the locator."
    }] : [],
    evidence: locatorEvidence,
    reason: candidate ? "A DOM candidate exists; locator should not be treated as the only root cause." : "No DOM candidate was extracted offline."
  };
  const locatorProposal = buildLocatorProposal(runId, semanticName, oldLocator, candidate, locatorEvidence);
  const dataBindingProposal = buildDataBindingProposal(runId, semanticName, targetField, currentBinding, proposedBinding, dataBindingEvidence);

  return {
    schemaVersion: "failure-diagnosis.v1",
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    mode: "offline_diagnosis_only",
    sourceFailurePackage: path.normalize(filePath),
    sourceRunId: runId,
    constraints: {
      browserStarted: false,
      businessRerun: false,
      knowledgeWritten: false,
      businessFlowWritten: false,
      elementStoreWritten: false,
      dslRuleWritten: false
    },
    diagnosis: {
      semanticName,
      failedStepId: stringValue(failedStep.id),
      failureStage: payload.failureStage,
      oldLocator,
      oldValue,
      expectedIntentValue,
      expectedIntentSourcePath: expectedIntentValue === undefined ? undefined : "intent.data.count",
      observedDom: domEvidence,
      rootCausePriority
    },
    locatorEvidence,
    dataBindingEvidence,
    actionExecutionEvidence,
    locatorResolution,
    dataBinding: {
      current: currentBinding,
      proposed: proposedBinding
    },
    actionExecutionResult,
    updateProposals: [locatorProposal, dataBindingProposal].filter((item): item is LocatorUpdateProposal | DataBindingUpdateProposal => Boolean(item))
  };
}

export async function writeFailureDiagnosisArtifacts(input: {
  diagnosis: FailureDiagnosisResult;
  jsonOut: string;
  markdownOut?: string;
}): Promise<void> {
  await writeSafeJsonFile(input.jsonOut, input.diagnosis);
  if (input.markdownOut) await writeSafeTextFile(input.markdownOut, renderFailureDiagnosisMarkdown(input.diagnosis));
}

export async function writeFailureDiagnosisSidecar(input: {
  failurePackagePath: string;
  diagnosis: FailureDiagnosisResult;
  sidecarPath?: string;
}): Promise<string> {
  const sidecarPath = input.sidecarPath ?? input.failurePackagePath.replace(/\.json$/i, ".diagnosis.json");
  const sidecar: FailureDiagnosisSidecar = {
    schemaVersion: "failure-diagnosis-sidecar.v1",
    sourceFailurePackage: path.normalize(input.failurePackagePath),
    generatedAt: new Date().toISOString(),
    diagnosis: input.diagnosis,
    proposals: input.diagnosis.updateProposals,
    writePolicy: {
      writesMainStorage: false,
      requiresHumanConfirmation: true
    }
  };
  await writeSafeJsonFile(sidecarPath, sidecar);
  return sidecarPath;
}

export function renderFailureDiagnosisMarkdown(result: FailureDiagnosisResult): string {
  const locatorProposal = result.updateProposals.find((item) => item.proposalType === "LocatorUpdateProposal") as LocatorUpdateProposal | undefined;
  const dataProposal = result.updateProposals.find((item) => item.proposalType === "DataBindingUpdateProposal") as DataBindingUpdateProposal | undefined;
  return [
    "# 阶段 2.2 离线失败诊断报告",
    "",
    "## 输入",
    "",
    `- failure package: \`${result.sourceFailurePackage}\``,
    `- runId: \`${result.sourceRunId ?? ""}\``,
    `- semanticName: \`${result.diagnosis.semanticName}\``,
    `- failureStage: \`${result.diagnosis.failureStage ?? ""}\``,
    "",
    "## 分层诊断",
    "",
    `- locator: ${result.locatorResolution.reason ?? ""}`,
    `- data binding: 当前值 \`${String(result.dataBinding.current.value)}\`，建议值 \`${String(result.dataBinding.proposed.value)}\`。`,
    `- action: ${result.actionExecutionResult.reason}`,
    "",
    "## Root Cause Priority",
    "",
    ...result.diagnosis.rootCausePriority.map((item) => `- ${item.cause}: ${item.priority} - ${item.reason}`),
    "",
    "## Proposal",
    "",
    `- LocatorUpdateProposal: ${locatorProposal?.proposalId ?? "none"}, priority=${locatorProposal?.rootCausePriority ?? "none"}, requiresHumanConfirmation=${locatorProposal?.requiresHumanConfirmation ?? false}`,
    `- DataBindingUpdateProposal: ${dataProposal?.proposalId ?? "none"}, priority=${dataProposal?.rootCausePriority ?? "none"}, requiresHumanConfirmation=${dataProposal?.requiresHumanConfirmation ?? false}`,
    "",
    "## 写库确认",
    "",
    "- knowledgeWritten: no",
    "- businessFlowWritten: no",
    "- elementStoreWritten: no",
    "- dslRuleWritten: no",
    "- browserStarted: no",
    "- businessRerun: no",
    "",
    "## 遗留问题",
    "",
    "- 当前模块只做离线诊断，不改变执行器真实行为。",
    "- 如果要写入 element_store 或 DSL generation rule，需要人工确认 proposal。"
  ].join("\n");
}

function resolveArtifactPath(packagePath: string, artifactPath?: string): string | undefined {
  if (!artifactPath) return undefined;
  if (path.isAbsolute(artifactPath)) return artifactPath;
  return path.resolve(path.dirname(packagePath), "..", "..", "..", artifactPath);
}

async function extractDomFieldEvidence(domPath: string, semanticName: string): Promise<FailureDiagnosisResult["diagnosis"]["observedDom"] | undefined> {
  const html = await fs.readFile(domPath, "utf8").catch(() => undefined);
  if (!html) return undefined;
  const escaped = escapeRegExp(semanticName);
  const labelInput = new RegExp(`<label[^>]*>\\s*${escaped}\\s*<\\/label>\\s*(<input[^>]*>)`, "i").exec(html);
  const inputTag = labelInput?.[1] ?? findLikelyNumericInput(html);
  const excerpt = labelInput ? `${labelInput[0].slice(0, 400)}` : inputTag;
  return {
    labelPresent: new RegExp(`<label[^>]*>\\s*${escaped}\\s*<\\/label>`, "i").test(html),
    inputPresent: Boolean(inputTag),
    inputmode: readHtmlAttribute(inputTag, "inputmode"),
    maxlength: readHtmlAttribute(inputTag, "maxlength"),
    domValue: readHtmlAttribute(inputTag, "value"),
    excerpt
  };
}

function findLikelyNumericInput(html: string): string | undefined {
  return /<input[^>]*inputmode="numeric"[^>]*>/i.exec(html)?.[0];
}

function buildLocatorEvidence(packagePath: string, oldLocator: string | undefined, domPath: string | undefined, domEvidence: FailureDiagnosisResult["diagnosis"]["observedDom"] | undefined): EvidenceRef[] {
  const evidence: Array<EvidenceRef | undefined> = [
    oldLocator ? {
      source: "failure_package",
      sourceId: path.normalize(packagePath),
      field: "failed_step.primary_locator",
      excerpt: oldLocator,
      confidence: 0.7
    } satisfies EvidenceRef : undefined,
    domPath && domEvidence?.excerpt ? {
      source: "dom_snapshot",
      sourceId: path.normalize(domPath),
      field: "label/input",
      excerpt: domEvidence.excerpt,
      confidence: 0.82
    } satisfies EvidenceRef : undefined
  ];
  return compactEvidence(evidence);
}

function buildDataBindingEvidence(packagePath: string, oldValue: unknown, domPath: string | undefined, domEvidence: FailureDiagnosisResult["diagnosis"]["observedDom"] | undefined, expectedIntentValue: unknown, intentSourceId: string): EvidenceRef[] {
  const evidence: Array<EvidenceRef | undefined> = [
    {
      source: "failure_package",
      sourceId: path.normalize(packagePath),
      field: "failed_step.value",
      excerpt: String(oldValue),
      confidence: 0.95
    },
    domPath && domEvidence?.inputmode ? {
      source: "dom_snapshot",
      sourceId: path.normalize(domPath),
      field: "input.inputmode",
      excerpt: `inputmode="${domEvidence.inputmode}"${domEvidence.maxlength ? ` maxlength="${domEvidence.maxlength}"` : ""}`,
      confidence: 0.9
    } satisfies EvidenceRef : undefined,
    expectedIntentValue !== undefined ? {
      source: "intent",
      sourceId: intentSourceId,
      field: "intent.data.count",
      excerpt: `用户需求中的红包数量为 ${String(expectedIntentValue)}`,
      confidence: 0.9
    } satisfies EvidenceRef : undefined
  ];
  return compactEvidence(evidence);
}

function buildActionEvidence(runId: string | undefined, failedStep: Record<string, unknown>, stepExecution: Record<string, unknown>): EvidenceRef[] {
  return [{
    source: "execution_step",
    sourceId: `${runId ?? "unknown"}/${String(failedStep.id ?? "failed-step")}`,
    field: "error_message",
    excerpt: String(stepExecution.error_message ?? ""),
    confidence: 0.7
  }];
}

function buildLocatorCandidate(semanticName: string, oldLocator: string | undefined, domPath: string | undefined, domEvidence: FailureDiagnosisResult["diagnosis"]["observedDom"] | undefined): LocatorCandidate | undefined {
  if (!domPath || !domEvidence?.inputPresent) return undefined;
  const elementRef = elementRefFor(semanticName);
  return {
    elementRef,
    semanticName,
    role: "input",
    label: domEvidence.labelPresent ? semanticName : undefined,
    css: domEvidence.inputmode && domEvidence.maxlength ? `input[inputmode="${domEvidence.inputmode}"][maxlength="${domEvidence.maxlength}"]` : undefined,
    xpath: `xpath=//label[normalize-space()='${semanticName}']/following-sibling::input[1]`,
    pageId: null,
    confidence: 0.65,
    source: "dom_snapshot",
    successCount: 0,
    failureCount: 1,
    fallbackLocators: [oldLocator, domEvidence.inputmode && domEvidence.maxlength ? `css=input[inputmode="${domEvidence.inputmode}"][maxlength="${domEvidence.maxlength}"]` : undefined].filter((item): item is string => Boolean(item)),
    evidence: [{
      source: "dom_snapshot",
      sourceId: path.normalize(domPath),
      field: "label/input",
      excerpt: domEvidence.excerpt,
      confidence: 0.82
    }]
  };
}

function buildCurrentBinding(targetField: string, semanticName: string, oldValue: unknown, valueType: DataBinding["valueType"], packagePath: string): DataBinding {
  return {
    targetField,
    semanticName,
    value: oldValue,
    valueType: typeof oldValue === "string" ? "string" : valueType,
    source: "unknown",
    sourcePath: "failed_step.value",
    evidence: [{
      source: "failure_package",
      sourceId: path.normalize(packagePath),
      field: "failed_step.value",
      excerpt: String(oldValue),
      confidence: 0.95
    }],
    confidence: 0.2
  };
}

function buildProposedBinding(targetField: string, semanticName: string, expectedValue: unknown, valueType: DataBinding["valueType"], intentSourceId: string, domPath: string | undefined, domEvidence: FailureDiagnosisResult["diagnosis"]["observedDom"] | undefined): DataBinding {
  return {
    targetField,
    semanticName,
    value: expectedValue,
    valueType,
    source: "intent",
    sourcePath: targetField === "red_packet_count" ? "intent.data.count" : "intent.data.value",
    evidence: compactEvidence([
      {
        source: "intent",
        sourceId: intentSourceId,
        field: targetField === "red_packet_count" ? "intent.data.count" : "intent.data.value",
        excerpt: `用户需求中的红包数量为 ${String(expectedValue)}`,
        confidence: 0.9
      },
      domPath && domEvidence?.inputmode ? {
        source: "dom_snapshot",
        sourceId: path.normalize(domPath),
        field: "input.inputmode",
        excerpt: `inputmode="${domEvidence.inputmode}"${domEvidence.maxlength ? ` maxlength="${domEvidence.maxlength}"` : ""}`,
        confidence: 0.9
      } satisfies EvidenceRef : undefined
    ]),
    confidence: 0.9
  };
}

function buildActionExecutionResult(failedStep: Record<string, unknown>, stepExecution: Record<string, unknown>, expectedValue: unknown, evidence: EvidenceRef[]): ActionExecutionResult {
  const actualValue = failedStep.value;
  return {
    status: "failed",
    action: normalizeAction(failedStep.action),
    expectedValue,
    actualValue,
    valuePersisted: false,
    validationMessage: null,
    reason: isValueTypeMismatch(actualValue, expectedValue) ? "data_binding_error" : "unknown",
    evidence: [
      ...evidence,
      {
        source: "execution_step",
        sourceId: String(stepExecution.run_id ?? "unknown"),
        field: "error_message",
        excerpt: String(stepExecution.error_message ?? ""),
        confidence: 0.7
      }
    ]
  };
}

function buildRootCausePriority(reason: ActionExecutionResult["reason"]): FailureDiagnosisResult["diagnosis"]["rootCausePriority"] {
  return [
    {
      cause: "data_binding_error",
      priority: reason === "data_binding_error" ? "high" : "medium",
      reason: "The failed DSL bound an incompatible value to a numeric/count field."
    },
    {
      cause: "locator_candidate_missing",
      priority: "medium",
      reason: "The DOM contains a usable label/input candidate, but the current DSL only records a hard-coded XPath without structured locator evidence."
    },
    {
      cause: "action_failed",
      priority: "low",
      reason: "The executor collapsed the failure into a generic input failure; offline evidence points first to data binding."
    }
  ];
}

function buildLocatorProposal(runId: string | undefined, semanticName: string, oldLocator: string | undefined, candidate: LocatorCandidate | undefined, evidence: EvidenceRef[]): LocatorUpdateProposal | undefined {
  if (!candidate) return undefined;
  return {
    proposalType: "LocatorUpdateProposal",
    proposalId: `stage2_locator_${slug(semanticName)}_${(runId ?? "unknown").slice(0, 8)}`,
    target: "element_store",
    module: "red-packet",
    action: "create",
    semanticName,
    elementRef: candidate.elementRef ?? elementRefFor(semanticName),
    oldLocator,
    newCandidates: [candidate],
    rootCausePriority: "medium",
    evidence,
    confidence: 0.65,
    autoWriteRecommended: false,
    requiresHumanConfirmation: true
  };
}

function buildDataBindingProposal(runId: string | undefined, semanticName: string, targetField: string, oldBinding: DataBinding, newBinding: DataBinding, evidence: EvidenceRef[]): DataBindingUpdateProposal {
  return {
    proposalType: "DataBindingUpdateProposal",
    proposalId: `stage2_data_binding_${slug(semanticName)}_${(runId ?? "unknown").slice(0, 8)}`,
    target: "dsl_generation_rule",
    module: "red-packet",
    action: "create",
    semanticName,
    targetField,
    oldBinding,
    newBinding,
    rootCausePriority: "high",
    evidence,
    confidence: 0.9,
    autoWriteRecommended: false,
    requiresHumanConfirmation: true
  };
}

function inferTargetField(semanticName: string): string {
  if (/红包个数|count|quantity/i.test(semanticName)) return "red_packet_count";
  return slug(semanticName);
}

function inferValueType(semanticName: string, inputmode?: string): DataBinding["valueType"] {
  if (/红包个数|count|quantity/i.test(semanticName)) return "count";
  if (inputmode === "numeric") return "number";
  if (/amount|金额|数量/.test(semanticName)) return "amount";
  return "unknown";
}

function inferExpectedValue(semanticName: string): unknown {
  if (/红包个数|count|quantity/i.test(semanticName)) return 1;
  return undefined;
}

function normalizeAction(action: unknown): ActionExecutionResult["action"] {
  if (action === "click" || action === "select" || action === "assert") return action;
  return "input";
}

function isValueTypeMismatch(actual: unknown, expected: unknown): boolean {
  return typeof expected === "number" && typeof actual === "string" && Number.isNaN(Number(actual));
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readHtmlAttribute(inputTag: string | undefined, attribute: string): string | undefined {
  if (!inputTag) return undefined;
  return new RegExp(`${attribute}="([^"]*)"`, "i").exec(inputTag)?.[1];
}

function elementRefFor(semanticName: string): string {
  if (semanticName === "红包个数") return "demo.red_packet.create.count_input";
  return `demo.element.${slug(semanticName)}`;
}

function slug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "_")
    .replace(/^_+|_+$/g, "") || "unknown";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compactEvidence(items: Array<EvidenceRef | undefined>): EvidenceRef[] {
  return items.filter((item): item is EvidenceRef => Boolean(item));
}
