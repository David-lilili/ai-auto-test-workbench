import fs from "fs-extra";
import { buildAutomationCaseFromPageModel, type PageModelDslBuildResult } from "./page-model-dsl-builder.js";
import { selectRelevantPageOperationManuals, type PageOperationManualSelection } from "./page-operation-manual.js";
import { rebuildEvidenceBuckets, selectEvidenceFromPageModelStore, type PageModelEvidenceSelection, type SelectedPageModelEvidence } from "./page-model-evidence-selector.js";
import { parseUserAssertions, type UserAssertionParseResult } from "./user-assertion-parser.js";
import { validateIntentContract, type IntentContractValidation } from "./intent-contract-validator.js";
import { FALLBACK_PROJECT, FALLBACK_ENV } from "./project-defaults.js";
import { normalizeIntentValueForProject, primaryTargetPageIdForIntent } from "./project-intent-routing.js";

export interface PageModelExecutionPlan {
  schemaVersion: "page-model-execution-plan.v1";
  request: string;
  project: string;
  env: string;
  selection: PageModelEvidenceSelection;
  evidenceBucketSummary: Record<string, number>;
  executionContract: {
    targetPageId?: string;
    materializedPageIds: string[];
    missingRoles: string[];
    forbiddenEvidenceUsed: string[];
  };
  intentContract: IntentContractValidation;
  planningContext: {
    deepseekMessageContractVersion: "page-model-deepseek-contract.v1";
    userGoal: string;
    intent: PageModelEvidenceSelection["intent"];
    intentArbitration?: PageModelEvidenceSelection["intentArbitration"];
    retrievedPageModelContext: {
      targetPages: Array<Record<string, unknown>>;
      executableElements: Array<Record<string, unknown>>;
      assertions: Array<Record<string, unknown>>;
      providers: Array<Record<string, unknown>>;
      gaps: string[];
    };
    retrievedOperationManualContext?: PageOperationManualSelection;
    dslOutputRules: string[];
  };
  userAssertions: UserAssertionParseResult;
  materialization: PageModelDslBuildResult;
  executable: boolean;
  readiness: PageModelEvidenceSelection["readiness"];
  gaps: string[];
  blockingGaps: string[];
  recommendedNextAction: "execute" | "collect_more_evidence" | "resolve_precondition" | "unsupported";
  reason: string;
}

export async function planPageModelExecution(input: {
  request?: string;
  pageModelStorePath: string;
  operationManualStorePath?: string;
  project?: string;
  env?: string;
  assertions?: string[];
  deepSeekIntent?: unknown;
  /** P13-A2：TEST_ASSET source 的正式结构化输入；request 仅作 diagnostic/display。 */
  structuredIntent?: import("../test-assets/structured-intent.js").StructuredExecutionIntent;
}): Promise<PageModelExecutionPlan> {
  const store = await fs.readJson(input.pageModelStorePath);
  const operationManualStore = input.operationManualStorePath && await fs.pathExists(input.operationManualStorePath)
    ? await fs.readJson(input.operationManualStorePath)
    : undefined;
  // P13-A2：结构化 intent 存在时，request 只作为 display text，不作为语义事实源
  const request = input.structuredIntent
    ? `[TEST_ASSET ${input.structuredIntent.source.testAssetId}@${input.structuredIntent.source.testAssetVersion}] ${input.structuredIntent.module}.${input.structuredIntent.action}`
    : input.request ?? "";
  const deepSeekIntent = input.deepSeekIntent ?? (input.structuredIntent
    ? {
        project: input.structuredIntent.project,
        module: input.structuredIntent.module,
        action: input.structuredIntent.action,
        operationType: input.structuredIntent.operationType,
        capabilities: input.structuredIntent.capabilities,
        entities: input.structuredIntent.entities,
        data: input.structuredIntent.data,
        source: input.structuredIntent.source
      }
    : undefined);
  return planPageModelExecutionFromStore({
    request,
    store,
    operationManualStore,
    operationManualStorePath: input.operationManualStorePath,
    project: input.project ?? FALLBACK_PROJECT,
    env: input.env ?? FALLBACK_ENV,
    assertions: input.assertions,
    deepSeekIntent
  });
}

export function planPageModelExecutionFromStore(input: {
  request: string;
  store: Record<string, unknown>;
  operationManualStore?: Record<string, unknown>;
  operationManualStorePath?: string;
  project: string;
  env: string;
  assertions?: string[];
  deepSeekIntent?: unknown;
}): PageModelExecutionPlan {
  const selection = selectEvidenceFromPageModelStore({
    request: input.request,
    store: input.store as never,
    project: input.project,
    env: input.env,
    deepSeekIntent: input.deepSeekIntent
  });
  enrichSelectionFromPageModelStore(selection, input.store);
  rebuildEvidenceBuckets(selection);
  const userAssertions = parseUserAssertions({
    request: input.request,
    assertions: input.assertions,
    deepSeekIntent: input.deepSeekIntent,
    selection
  });
  const operationManualSelection = input.operationManualStore
    ? selectRelevantPageOperationManuals({
      store: input.operationManualStore,
      storePath: input.operationManualStorePath,
      env: input.env,
      intent: selection.intent,
      request: input.request
    })
    : undefined;
  const materialization = buildAutomationCaseFromPageModel({
    selection,
    userAssertions,
    operationManualSelection,
    caseId: `asset_module_${selection.intent.module}_${selection.intent.action}`
  });
  const intentContract = validateIntentContract({ selection, operationManualSelection, userAssertions });
  const executionContract = buildExecutionContractSummary(selection, userAssertions, materialization);
  const planningContext = buildDeepSeekPageModelPlanningContext(input.request, selection, operationManualSelection);
  const sanityGaps = planSanityGaps(selection, materialization, operationManualSelection);
  const gaps = [...new Set([...selection.gaps, ...userAssertions.gaps, ...materialization.gaps, ...intentContract.blockingGaps, ...sanityGaps])];
  const blockingGaps = [...new Set([...selection.blockingGaps, ...userAssertions.gaps, ...materialization.blockingGaps, ...intentContract.blockingGaps, ...sanityGaps])];
  const executable = selection.executable && materialization.executable && intentContract.passed && userAssertions.gaps.length === 0 && sanityGaps.length === 0;
  return {
    schemaVersion: "page-model-execution-plan.v1",
    request: input.request,
    project: input.project,
    env: input.env,
    selection,
    evidenceBucketSummary: summarizeEvidenceBuckets(selection),
    executionContract,
    intentContract,
    planningContext,
    userAssertions,
    materialization,
    executable,
    readiness: sanityGaps.length ? "partial" : selection.readiness,
    gaps,
    blockingGaps,
    recommendedNextAction: nextAction(sanityGaps.length ? "partial" : selection.readiness, executable, blockingGaps),
    reason: sanityGaps.length
      ? "Execution plan failed platform sanity checks; regenerate from bounded Page Model evidence."
      : reasonFor(selection.readiness, executable, gaps, blockingGaps)
  };
}

function summarizeEvidenceBuckets(selection: PageModelEvidenceSelection): Record<string, number> {
  const buckets = selection.evidenceBuckets;
  return {
    targetPage: buckets.targetPage.length,
    navigation: buckets.navigation.length,
    executableElements: buckets.executableElements.length,
    actionResults: buckets.actionResults.length,
    assertions: buckets.assertions.length,
    providers: buckets.providers.length,
    preconditions: buckets.preconditions.length,
    supporting: buckets.supporting.length,
    excluded: buckets.excluded.length
  };
}

function buildDeepSeekPageModelPlanningContext(request: string, selection: PageModelEvidenceSelection, operationManualSelection?: PageOperationManualSelection): PageModelExecutionPlan["planningContext"] {
  const compactEvidence = (item: SelectedPageModelEvidence) => {
    const raw = item as unknown as Record<string, unknown>;
    return ({
    id: item.id,
    pageId: item.pageId,
    semanticName: item.semanticName,
    role: item.role,
    controlType: item.controlType,
    targetField: item.targetField,
    optionValue: item.optionValue,
    status: item.status,
    confidence: item.confidence,
    scope: item.container ?? item.region,
    provider: raw.provider,
    codeType: raw.codeType,
    providerRequirementId: raw.providerRequirementId,
    preconditions: item.preconditions
  });
  };
  return {
    deepseekMessageContractVersion: "page-model-deepseek-contract.v1",
    userGoal: request,
    intent: selection.intent,
    intentArbitration: selection.intentArbitration,
    retrievedPageModelContext: {
      targetPages: selection.evidenceBuckets.targetPage.map(compactEvidence),
      executableElements: selection.evidenceBuckets.executableElements.map(compactEvidence),
      assertions: selection.evidenceBuckets.assertions.map(compactEvidence),
      providers: selection.evidenceBuckets.providers.map(compactEvidence),
      gaps: selection.gaps
    },
    retrievedOperationManualContext: operationManualSelection,
    dslOutputRules: [
      "Only use targetPageId, targetElementId, assertionId, and providerRequirementId from retrievedPageModelContext.",
      "Use retrievedOperationManualContext to infer implicit business steps, provider requirements, and success evidence policies.",
      "Do not invent URL, selector, locator, option, provider, or page state.",
      "For click/input/select steps, targetElementId is required.",
      "For dropdown selection, requested value must exist in Page Model option inventory or the plan must return a modeling gap.",
      "For provider-gated actions, use operation manual businessSteps to express business-visible verification steps such as input Google code, input email code if present, and click confirm if present.",
      "For verification inputs, declare providerRequirementIds and credentialType only; do not describe Redis keys, KeePassXC entries, polling, or secret retrieval internals."
    ]
  };
}

function buildExecutionContractSummary(
  selection: PageModelEvidenceSelection,
  userAssertions: UserAssertionParseResult,
  materialization: PageModelDslBuildResult
): PageModelExecutionPlan["executionContract"] {
  const targetPageId = selection.evidenceBuckets.targetPage[0]?.pageId;
  const materializedPageIds = [...new Set((materialization.case.steps as unknown as Array<Record<string, unknown>>)
    .map((step) => String(step.pageModelId ?? ""))
    .filter(Boolean))];
  const authorizedEvidenceIds = new Set([
    ...selection.evidenceBuckets.targetPage.map((item) => item.id),
    ...selection.evidenceBuckets.navigation.map((item) => item.id),
    ...selection.evidenceBuckets.executableElements.map((item) => item.id),
    ...selection.evidenceBuckets.assertions.map((item) => item.id),
    ...selection.evidenceBuckets.providers.map((item) => item.id)
  ]);
  const forbiddenEvidenceUsed = (materialization.case.steps as unknown as Array<Record<string, unknown>>)
    .map((step) => String(step.elementId ?? step.assertionId ?? step.evidenceId ?? step.pageModelId ?? ""))
    .filter((id) => id && !authorizedEvidenceIds.has(id));
  const missingRoles: string[] = [];
  if (!selection.evidenceBuckets.targetPage.length) missingRoles.push("target_page");
  if (selection.intent.operationType === "read" && selection.executable && !selection.evidenceBuckets.executableElements.length) missingRoles.push("executable_element");
  if (userAssertions.assertions.length && !selection.evidenceBuckets.assertions.length) missingRoles.push("assertion");
  return {
    targetPageId,
    materializedPageIds,
    missingRoles,
    forbiddenEvidenceUsed: [...new Set(forbiddenEvidenceUsed)]
  };
}

function planSanityGaps(
  selection: PageModelEvidenceSelection,
  materialization: PageModelDslBuildResult,
  operationManualSelection?: PageOperationManualSelection
): string[] {
  const gaps: string[] = [];
  const steps = materialization.case.steps as unknown as Array<Record<string, unknown>>;
  if (isFundFlowFilterIntent(selection.intent.module, selection.intent.action)) {
    const targetPageId = primaryTargetPageIdForIntent(selection.intent) ?? "demo.funds.spot_fund_flow";
    const forbiddenPage = steps.find((step) => {
      const pageId = String(step.pageModelId ?? "");
      return pageId && pageId !== targetPageId;
    });
    if (forbiddenPage) gaps.push(`plan_page_boundary_violation:${String(forbiddenPage.pageModelId)}`);
    const writeStep = steps.find((step) => /submit|confirm|withdraw|transfer|deposit|\u63d0\u4ea4|\u786e\u8ba4|\u63d0\u73b0|\u5212\u8f6c|\u5145\u503c/i.test(`${step.id ?? ""} ${step.semanticTarget ?? ""}`));
    if (writeStep) gaps.push(`plan_operation_boundary_violation:${String(writeStep.id ?? "")}`);
  }
  if (selection.intent.module === "withdraw" && selection.intent.action === "add_withdraw_address") {
    const request = selection.request;
    const requiresVerificationCompletion = /完成.*验证|双验证|安全验证|email|邮箱|GA|TOTP|谷歌/i.test(request);
    const expectsSaveSuccess = /保存成功|可以保存成功|保存.*成功|成功提示|success/i.test(request);
    const operationManualRequiresProvider = Boolean(operationManualSelection?.providerFlows.length);
    const operationManualRequiresSuccessEvidence = operationManualSelection?.capabilities.some((capability) => Boolean(capability.successEvidencePolicyId)) ?? false;
    const hasProviderStep = steps.some((step) =>
      String(step.action ?? "") === "provider" ||
      isVerificationCredentialValueFrom(step.valueFrom) ||
      /provider_input|email_code|totp|send_email_code|confirm_verification/i.test(`${step.id ?? ""} ${step.semanticTarget ?? ""} ${step.targetField ?? ""}`)
    );
    const hasSuccessAssertion = steps.some((step) =>
      String(step.action ?? "") === "assert" &&
      /success|\u6210\u529f|\u4fdd\u5b58/.test(JSON.stringify(step))
    );
    const hasExplicitMessageAssertion = steps.some((step) =>
      String(step.action ?? "") === "assert" &&
      String((step.assertion as Record<string, unknown> | undefined)?.type ?? "") === "message_visible_exact" &&
      String((step.assertion as Record<string, unknown> | undefined)?.source ?? "") === "user_explicit_assertion"
    );
    if ((requiresVerificationCompletion || operationManualRequiresProvider) && !hasProviderStep) gaps.push("provider_verification_step_not_materialized");
    if ((expectsSaveSuccess || operationManualRequiresSuccessEvidence) && !hasSuccessAssertion && !hasExplicitMessageAssertion) gaps.push("write_success_assertion_not_materialized");
  }
  const rawEvidenceStep = steps.find((step) => /^p4\..*(?:clickable|field|table)_/i.test(String(step.elementId ?? step.assertionId ?? step.evidenceId ?? "")));
  if (rawEvidenceStep) gaps.push(`raw_scan_evidence_not_executable:${String(rawEvidenceStep.elementId ?? rawEvidenceStep.assertionId ?? rawEvidenceStep.evidenceId)}`);
  return [...new Set(gaps)];
}

function isVerificationCredentialValueFrom(valueFrom: unknown): boolean {
  if (!valueFrom || typeof valueFrom !== "object") return false;
  const raw = valueFrom as Record<string, unknown>;
  return raw.type === "verificationCredential";
}

function enrichSelectionFromPageModelStore(selection: PageModelEvidenceSelection, store: Record<string, unknown>): void {
  const models = Array.isArray((store as { models?: unknown }).models) ? (store as { models: Array<Record<string, any>> }).models : [];
  if (isFundFlowFilterIntent(selection.intent.module, selection.intent.action)) {
    const pageId = primaryTargetPageIdForIntent(selection.intent) ?? "demo.funds.spot_fund_flow";
    addModelEvidence(selection, models, pageId);
    addElementEvidence(selection, models, pageId, fundFlowFilterElementPatternV2(selection.intent.data));
    addElementEvidence(selection, models, pageId, /gift_coin|\u8d60\u5e01|\u7533\u8d2d|\u8d4e\u56de|\u6536\u76ca|type_filter|record_type|product_type|asset_filter|query_button|result_list|result_table/i);
    addAssertionEvidence(selection, models, pageId, /gift|\u8d60\u5e01|\u7533\u8d2d|\u8d4e\u56de|\u6536\u76ca|empty|result|list|table|\u7a7a\u72b6\u6001|\u5217\u8868|\u8868\u683c/i);
  }
  if (selection.intent.module === "transfer") {
    addModelEvidence(selection, models, "demo.funds.transfer_entry");
    addModelEvidence(selection, models, "demo.funds.spot_fund_flow");
    addElementEvidence(selection, models, "demo.funds.transfer_entry", /transfer|from_account|to_account|asset_selector|amount_input|submit_button|杞嚭|杞叆|甯佺|鏁伴噺|鎻愪氦/i);
    addElementEvidence(selection, models, "demo.funds.spot_fund_flow", /transfer_record|asset_filter|result_list|transfer|USDT/i);
    addAssertionEvidence(selection, models, "demo.funds.transfer_entry", /transfer|submit_success|modal_visible|amount_50|success/i);
    addAssertionEvidence(selection, models, "demo.funds.spot_fund_flow", /transfer|record_50|spot_to_futures|transfer_record/i);
  }
  if (selection.intent.module === "withdraw") {
    if (selection.intent.action === "add_withdraw_address" || selection.intent.action === "manage_withdraw_address") {
      addModelEvidence(selection, models, "demo.funds.withdraw");
      addModelEvidence(selection, models, "demo.funds.withdraw.address_management");
      addElementEvidence(selection, models, "demo.funds.withdraw", /address_management_entry|地址管理/i);
      addElementEvidence(selection, models, "demo.funds.withdraw.address_management", /address_management|add_address|添加地址|保存地址|security|verification|email|totp|GA|谷歌|USDT|BSC|network|asset|address/i);
      addAssertionEvidence(selection, models, "demo.funds.withdraw.address_management", /address_management|security_verification|安全验证|邮箱验证码|谷歌验证码/i);
    } else {
      addModelEvidence(selection, models, "demo.funds.withdraw");
      addElementEvidence(selection, models, "demo.funds.withdraw", isNegativeWithdrawAmountIntent(selection) ? /withdraw|asset|chain|network|address|amount|fee|USDT|BSC|submit|failure|precondition/i : /withdraw|asset|chain|network|address|amount|verification|fee|record|USDT|BSC/i);
      addAssertionEvidence(selection, models, "demo.funds.withdraw", /withdraw|success|failure|record|empty|USDT|BSC/i);
    }
  }
  enforceFundFlowReadBoundary(selection);
  enforceNegativeWithdrawAmountBoundary(selection);
  enforceWithdrawAddressManagementBoundary(selection);
  selection.gaps = selection.gaps.filter((gap) => !gapClosed(selection, gap));
  selection.blockingGaps = selection.blockingGaps.filter((gap) => selection.gaps.includes(gap));
  removeSelectedEvidenceFromExcluded(selection);
  selection.readiness = selection.gaps.length ? selection.readiness : "ready";
  selection.executable = selection.readiness === "ready";
}

function enforceNegativeWithdrawAmountBoundary(selection: PageModelEvidenceSelection): void {
  if (!isNegativeWithdrawAmountIntent(selection)) return;
  const allowedPageIds = new Set(["demo.funds.withdraw"]);
  const allowedItem = (item: PageModelEvidenceSelection["selectedEvidence"][number]): boolean => {
    if (item.kind === "page") return allowedPageIds.has(item.pageId ?? item.id);
    if (item.pageId !== "demo.funds.withdraw") return false;
    const text = `${item.id} ${item.semanticName ?? ""} ${item.reason ?? ""}`.toLowerCase();
    if (/address_management|地址管理|verification|provider|email_code|sms_code|totp|passkey|验证码|安全验证|record_entry|记录入口/i.test(text)) return false;
    return /withdraw|asset|network|chain|address|amount|fee|submit|failure|precondition|USDT|BSC|提现|提币|网络|地址|数量|手续费|失败|前置条件/i.test(text);
  };
  selection.selectedEvidence = selection.selectedEvidence.filter(allowedItem);
  selection.fallbackEvidence = selection.fallbackEvidence.filter((item) => {
    if (item.pageId && item.pageId !== "demo.funds.withdraw") return false;
    const text = `${item.id} ${item.semanticName ?? ""} ${item.reason ?? ""}`.toLowerCase();
    if (/verification|provider|email_code|sms_code|totp|passkey|验证码|安全验证|success|成功|record_entry|记录入口/i.test(text)) return false;
    return true;
  });
  rebuildEvidenceBuckets(selection);
}

function enforceFundFlowReadBoundary(selection: PageModelEvidenceSelection): void {
  if (!isFundFlowFilterIntent(selection.intent.module, selection.intent.action)) return;
  const targetPageId = primaryTargetPageIdForIntent(selection.intent) ?? "demo.funds.spot_fund_flow";
  const allowedNavigationPageIds = new Set([
    targetPageId,
    "demo.funds.spot_account",
    "demo.funds.futures_account",
    "demo.funds.fund_flow_entry"
  ]);
  const allowedItem = (item: PageModelEvidenceSelection["selectedEvidence"][number]): boolean => {
    if (item.kind === "page") return allowedNavigationPageIds.has(item.pageId ?? item.id);
    if (item.pageId !== targetPageId) return false;
    const text = `${item.id} ${item.semanticName ?? ""} ${item.reason ?? ""}`.toLowerCase();
    return !/c3\.withdraw|withdraw|提现|t2_5\.transfer(?:\.|_record)/.test(text);
  };
  selection.selectedEvidence = selection.selectedEvidence.filter(allowedItem);
  selection.fallbackEvidence = selection.fallbackEvidence.filter(allowedItem);
  rebuildEvidenceBuckets(selection);
}

function enforceWithdrawAddressManagementBoundary(selection: PageModelEvidenceSelection): void {
  if (selection.intent.module !== "withdraw" || !["add_withdraw_address", "manage_withdraw_address"].includes(selection.intent.action)) return;
  const allowedPageIds = new Set(["demo.funds.withdraw", "demo.funds.withdraw.address_management"]);
  const hasDirectAddressManagementPage = selection.selectedEvidence.some((item) =>
    item.kind === "page" &&
    item.pageId === "demo.funds.withdraw.address_management" &&
    Boolean(item.url || item.urlPattern)
  );
  selection.selectedEvidence = selection.selectedEvidence.filter((item) => {
    if (item.kind === "page") return allowedPageIds.has(item.pageId ?? item.id);
    if (item.pageId === "demo.funds.withdraw.address_management") return true;
    if (item.pageId === "demo.funds.withdraw") return !hasDirectAddressManagementPage && /address_management_entry|open_address_management/i.test(item.id);
    return false;
  });
  selection.fallbackEvidence = selection.fallbackEvidence.filter((item) => {
    if (item.pageId === "demo.funds.withdraw.address_management") return true;
    if (item.pageId === "demo.funds.withdraw") return /address_management_entry|open_address_management/i.test(item.id);
    return !item.pageId || allowedPageIds.has(item.pageId);
  });
  rebuildEvidenceBuckets(selection);
}

function isNegativeWithdrawAmountIntent(selection: PageModelEvidenceSelection): boolean {
  return selection.intent.module === "withdraw" &&
    selection.intent.action === "submit_withdraw" &&
    typeof selection.intent.data.amountPolicy === "string" &&
    /below_minimum|above_available_balance|invalid|negative/i.test(selection.intent.data.amountPolicy);
}

function fundFlowFilterElementPattern(typeValue: unknown): RegExp {
  const escapedType = typeof typeValue === "string" && typeValue.trim()
    ? escapeRegExp(typeValue.trim())
    : "\u8d60\u5e01|gift_coin";
  return new RegExp(`type_filter|query_button|result_list|${escapedType}`, "i");
}

function fundFlowFilterElementPatternV2(data: Record<string, unknown>): RegExp {
  const values = ["query_button", "result_list", "result_table"];
  if (typeof data.asset === "string" && data.asset.trim()) {
    values.push("asset_filter", escapeRegExp(data.asset.trim()));
  }
  const recordType = typeof data.recordType === "string" && data.recordType.trim()
    ? data.recordType
    : typeof data.type === "string" && data.type.trim()
      ? data.type
      : undefined;
  if (recordType) {
    values.push("type_filter", escapeRegExp(recordType.trim()));
  }
  if (typeof data.productType === "string" && data.productType.trim()) {
    values.push("product_type", escapeRegExp(data.productType.trim()));
  }
  if (data.timeRange) {
    values.push("time_filter", "date_filter");
  }
  return new RegExp(values.join("|"), "i");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function removeSelectedEvidenceFromExcluded(selection: PageModelEvidenceSelection): void {
  const usedEvidenceIds = new Set([
    ...selection.selectedEvidence.map((item) => item.id),
    ...selection.selectedEvidence.map((item) => item.pageId).filter(Boolean),
    ...selection.fallbackEvidence.map((item) => item.id),
    ...selection.fallbackEvidence.map((item) => item.pageId).filter(Boolean)
  ]);
  selection.excludedEvidence = selection.excludedEvidence.filter((item) => !usedEvidenceIds.has(item.id) && !usedEvidenceIds.has(item.pageId));
}

function addModelEvidence(selection: PageModelEvidenceSelection, models: Array<Record<string, any>>, pageId: string): void {
  if (selection.selectedEvidence.some((item) => item.kind === "page" && item.id === pageId)) return;
  const model = models.find((item) => item.pageId === pageId);
  if (!model) return;
  selection.selectedEvidence.push({
    kind: "page",
    id: pageId,
    pageId,
    semanticName: model.pageName,
    status: model.status,
    confidence: model.confidence,
    resultTable: model.resultTable,
    fieldMappings: model.fieldMappings,
    reason: "PageModel selected by normalized asset-module execution planner.",
    evidence: normalizeEvidence(model.evidence, pageId)
  });
}

function addElementEvidence(selection: PageModelEvidenceSelection, models: Array<Record<string, any>>, pageId: string, pattern: RegExp): void {
  const model = models.find((item) => item.pageId === pageId);
  const structuredFields = structuredDropdownFields(model);
  for (const element of model?.elements ?? []) {
    const id = String(element.elementId ?? element.sourceProposalId ?? "");
    const text = `${id} ${element.semanticName ?? ""}`;
    if (hasGeneratedActionReplacement(model, element)) continue;
    if (isRawScanNoiseElement(element)) continue;
    if (!isSpotFundFlowElementAllowed(selection, element, text)) continue;
    const targetField = inferElementTargetField(element, text);
    if (targetField && !isPlannerIntentFieldRequested(selection, targetField)) continue;
    if (targetField && !plannerOptionMatchesIntent(selection, element, targetField)) continue;
    if (targetField && hasStructuredReplacement(element, targetField, structuredFields)) continue;
    if (isMismatchedFundFlowTypeOption(selection.intent.module, selection.intent.action, selection.intent.data.type, text)) continue;
    if (isEvidenceExcludedByIntent(selection.intent.module, selection.intent.action, text)) continue;
    if (!id || !pattern.test(text) || selection.selectedEvidence.some((item) => item.id === id)) continue;
    selection.selectedEvidence.push({
      kind: "element",
      id,
      pageId,
      semanticName: element.semanticName,
      status: element.status,
      confidence: element.confidence,
      role: element.role,
      container: element.container,
      region: element.region,
      semanticRole: element.semanticRole,
      controlType: element.controlType,
      targetField,
      optionValue: inferElementOptionValue(element, targetField ?? ""),
      parentElementId: element.parentElementId,
      dropdown: element.dropdown,
      locatorCandidates: element.locatorCandidates,
      negativeLocatorHints: element.negativeLocatorHints,
      preconditions: element.preconditions,
      reason: "Element selected by normalized Page Model capability match.",
      evidence: normalizeEvidence(element.evidence, id)
    });
  }
}

function isRawScanNoiseElement(element: Record<string, unknown>): boolean {
  const id = String(element.elementId ?? element.sourceProposalId ?? "");
  return /^p4\..*(?:clickable|field|table)_/i.test(id);
}

function isPlannerIntentFieldRequested(selection: PageModelEvidenceSelection, targetField: string): boolean {
  const module = selection.intent.module;
  const data = selection.intent.data;
  if (targetField === "action") return true;
  if (targetField === "address_type" || targetField === "withdraw_mode") return module === "withdraw" && typeof data.addressType === "string";
  if (targetField === "asset") return typeof data.asset === "string" && data.asset.trim().length > 0;
  if (targetField === "record_type") return typeof (data.recordType ?? data.type) === "string";
  if (targetField === "product_type") return typeof data.productType === "string" && data.productType.trim().length > 0;
  if (targetField === "time_range") return Boolean(data.timeRange);
  if (targetField === "network") return typeof data.network === "string" && data.network.trim().length > 0;
  if (targetField === "address") return typeof data.address === "string" && data.address.trim().length > 0;
  if (targetField === "uid" || targetField === "internal_uid") return typeof (data.uid ?? data.internalUid) === "string";
  if (targetField === "amount") return typeof data.amount === "number" || typeof data.amountPolicy === "string";
  if (targetField === "verification_code") return module === "withdraw" && !isNegativeWithdrawAmountIntent(selection);
  if (targetField === "email_code" || targetField === "totp" || targetField === "sms_code") return module === "withdraw" && !isNegativeWithdrawAmountIntent(selection);
  if (targetField === "send_email_code" || targetField === "confirm_verification") return module === "withdraw" && !isNegativeWithdrawAmountIntent(selection);
  return false;
}

function plannerOptionMatchesIntent(selection: PageModelEvidenceSelection, element: Record<string, any>, targetField: string): boolean {
  const optionValue = inferElementOptionValue(element, targetField);
  if (!optionValue) return true;
  if (isUnavailableOption(optionValue) || isUnavailableOption(`${element.semanticName ?? ""} ${element.elementId ?? ""}`)) return false;
  const expected = targetField === "record_type" ? normalizeProjectRecordTypeAlias(selection, selection.intent.data.recordType ?? selection.intent.data.type) : selection.intent.data[targetField];
  if (typeof expected !== "string") return true;
  if (targetField === "network") return normalizeText(optionValue).includes(normalizeText(expected));
  return normalizeText(optionValue) === normalizeText(expected);
}

function isUnavailableOption(value: string): boolean {
  return /暂不支持|不可用|禁用|disabled|unavailable|not_supported|not supported/i.test(value);
}

function hasGeneratedActionReplacement(model: Record<string, any> | undefined, element: Record<string, any>): boolean {
  const id = String(element.elementId ?? element.sourceProposalId ?? "");
  if (!/query_button|reset_button/i.test(id)) return false;
  if (id.startsWith("funds.")) return false;
  const actionId = /query_button/i.test(id) ? "query_button" : "reset_button";
  return ((model?.elements ?? []) as Array<Record<string, any>>).some((candidate) =>
    String(candidate.elementId ?? "").startsWith("funds.") &&
    String(candidate.elementId ?? "").endsWith(actionId) &&
    isUsableStatus(candidate.status)
  );
}

function structuredDropdownFields(model: Record<string, any> | undefined): Set<string> {
  return new Set(((model?.elements ?? []) as Array<Record<string, any>>)
    .filter((element) => element.controlType === "dropdown" && typeof element.targetField === "string" && isUsableStatus(element.status))
    .map((element) => normalizeTargetField(element.targetField)));
}

function hasStructuredReplacement(element: Record<string, any>, targetField: string, structuredFields: Set<string>): boolean {
  if (!structuredFields.has(targetField)) return false;
  if (element.controlType === "dropdown" || element.controlType === "dropdown_option") return false;
  const id = String(element.elementId ?? element.sourceProposalId ?? "");
  if (id.startsWith("funds.")) return false;
  return /filter|selector|option|w3\.|w5\.|p7\./i.test(`${id} ${element.semanticName ?? ""} ${element.parentElementId ?? ""}`);
}

function isSpotFundFlowElementAllowed(selection: PageModelEvidenceSelection, element: Record<string, any>, text: string): boolean {
  if (!isFundFlowFilterIntent(selection.intent.module, selection.intent.action)) return true;
  const targetField = inferElementTargetField(element, text);
  if (!targetField) return true;
  const requestedValue = valueForTargetField(selection, targetField);
  if (requestedValue === undefined && targetField !== "action") return false;
  const optionValue = inferElementOptionValue(element, targetField);
  if (optionValue === undefined || requestedValue === undefined) return true;
  return normalizeText(optionValue) === normalizeText(String(requestedValue));
}

function inferElementTargetField(element: Record<string, any>, text: string): string | undefined {
  const explicit = typeof element.targetField === "string" ? normalizeTargetField(element.targetField) : undefined;
  if (explicit) return explicit;
  const searchText = `${text} ${element.parentElementId ?? ""} ${element.semanticRole ?? ""}`;
  if (/button|open_modal|open_secondary|submit_or_confirm|action_button|query|reset|save_button/i.test(`${element.role ?? ""} ${element.controlType ?? ""} ${element.semanticRole ?? ""} ${element.elementId ?? ""}`)) return "action";
  if (/product_type|\u4ea7\u54c1\u7c7b\u578b|\u6d3b\u671f\u7406\u8d22|\u5b9a\u671f\u7406\u8d22/i.test(searchText)) return "product_type";
  if (/type_filter|record_type|gift_coin|red_packet|\u7c7b\u578b|\u8d60\u5e01|\u7ea2\u5305/i.test(searchText)) return "record_type";
  if (/asset_filter|currency_filter|currency|asset|symbol|\u5e01\u79cd/i.test(searchText)) return "asset";
  if (/network_selector|network|chain|BSC|BEP|TRC|ERC|\u7f51\u7edc|\u94fe/i.test(searchText)) return "network";
  if (/uid|UID|\u7ad9\u5185.*\u5730\u5740/i.test(searchText)) return "uid";
  if (/address_type|withdraw_mode|\u94fe\u4e0a\u5730\u5740|\u7ad9\u5185\u5730\u5740|\u7ad9\u5185/i.test(searchText)) return "address_type";
  if (/address_input|address|\u5730\u5740/i.test(searchText)) return "address";
  if (/amount_input|amount|min_amount|minimum|\u6570\u91cf|\u91d1\u989d|\u6700\u5c0f/i.test(searchText)) return "amount";
  if (/verification|email_code|sms_code|totp|provider|\u9a8c\u8bc1\u7801/i.test(searchText)) return "verification_code";
  if (/time_filter|date_filter|time_range|\u65f6\u95f4|\u65e5\u671f/i.test(searchText)) return "time_range";
  return undefined;
}

function valueForTargetField(selection: PageModelEvidenceSelection, targetField: string): unknown {
  const data = selection.intent.data;
  if (targetField === "asset") return data.asset;
  if (targetField === "record_type") return normalizeProjectRecordTypeAlias(selection, data.recordType ?? data.type);
  if (targetField === "product_type") return data.productType;
  if (targetField === "time_range") return data.timeRange;
  if (targetField === "address_type") return data.addressType;
  if (targetField === "uid" || targetField === "internal_uid") return data.uid ?? data.internalUid;
  return undefined;
}

function normalizeProjectRecordTypeAlias(selection: PageModelEvidenceSelection, value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  const modeledAlias = normalizeFieldValueAlias(selection, "record_type", trimmed);
  if (modeledAlias) return modeledAlias;
  const projectAlias = normalizeIntentValueForProject(selection.intent, trimmed);
  if (projectAlias) return projectAlias;
  return trimmed || value;
}

function normalizeFieldValueAlias(selection: PageModelEvidenceSelection, semanticField: string, value: string): string | undefined {
  const normalizedValue = normalizeText(value);
  const mappings = selection.selectedEvidence
    .filter((item) => item.kind === "page")
    .flatMap((item) => Array.isArray((item as unknown as Record<string, unknown>).fieldMappings) ? (item as unknown as Record<string, any>).fieldMappings as Array<Record<string, unknown>> : [])
    .filter((item) => (item.semanticField ?? item.targetField) === semanticField);
  for (const mapping of mappings) {
    const verifiedOptions = readStringArray(mapping.verifiedOptions ?? mapping.options);
    const optionSet = new Set(verifiedOptions.map(normalizeText));
    const aliases = mapping.valueAliases;
    if (!aliases || typeof aliases !== "object" || Array.isArray(aliases)) continue;
    for (const [canonical, rawAliases] of Object.entries(aliases as Record<string, unknown>)) {
      const candidates = readStringArray([canonical, ...readStringArray(rawAliases)]);
      if (!candidates.map(normalizeText).includes(normalizedValue)) continue;
      if (optionSet.has(normalizeText(canonical))) return canonical;
      const verifiedAlias = candidates.find((candidate) => optionSet.has(normalizeText(candidate)));
      if (verifiedAlias) return verifiedAlias;
    }
  }
  return undefined;
}

function inferElementOptionValue(element: Record<string, any>, targetField: string): string | undefined {
  if (typeof element.optionValue === "string") return element.optionValue;
  const id = String(element.elementId ?? element.sourceProposalId ?? "");
  const semanticName = String(element.semanticName ?? "");
  const optionMatch = id.match(/\.option\.([^.\s]+)$/i)?.[1];
  if (optionMatch) return /^[a-z0-9]+$/i.test(optionMatch) ? optionMatch.toUpperCase() : optionMatch;
  if (targetField === "asset") return `${id} ${semanticName}`.match(/\b[A-Z0-9]{2,12}\b/)?.[0];
  const namedOption = semanticName.match(/[:\uff1a]\s*([^:]+)$/)?.[1]?.trim();
  return namedOption;
}

function normalizeTargetField(value: string): string {
  const normalized = value.toLowerCase();
  if (["currency", "coin", "symbol"].includes(normalized)) return "asset";
  if (["type", "recordtype", "record_type"].includes(normalized)) return "record_type";
  if (["producttype", "product_type", "product"].includes(normalized)) return "product_type";
  if (["time", "date", "timerange", "time_range", "date_range"].includes(normalized)) return "time_range";
  if (["mode", "addressmode", "address_mode", "addresstype", "address_type", "withdrawmode", "withdraw_mode"].includes(normalized)) return "address_type";
  if (["internaluid", "internal_uid", "useruid", "user_uid"].includes(normalized)) return "uid";
  if (["emailcode", "email_code", "mailcode", "mail_code"].includes(normalized)) return "email_code";
  if (["totpcode", "totp_code", "ga", "gacode", "ga_code", "googlecode", "google_code"].includes(normalized)) return "totp";
  if (["smscode", "sms_code", "phonecode", "phone_code"].includes(normalized)) return "sms_code";
  if (["sendemailcode", "send_email_code", "sendcode", "send_code"].includes(normalized)) return "send_email_code";
  if (["confirmverification", "confirm_verification", "verificationconfirm", "verification_confirm"].includes(normalized)) return "confirm_verification";
  return normalized;
}

function isMismatchedFundFlowTypeOption(module: string, action: string, typeValue: unknown, text: string): boolean {
  if (!isFundFlowFilterIntent(module, action) || typeof typeValue !== "string" || !typeValue.trim()) return false;
  const normalizedType = normalizeText(typeValue);
  const normalizedText = normalizeText(text);
  if (!/option|gift_coin|\u8d60\u5e01|\u7ea2\u5305\u53d1\u653e/i.test(text)) return false;
  return !normalizedText.includes(normalizedType);
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, "");
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item).trim()).filter(Boolean);
}

function addAssertionEvidence(selection: PageModelEvidenceSelection, models: Array<Record<string, any>>, pageId: string, pattern: RegExp): void {
  const model = models.find((item) => item.pageId === pageId);
  for (const assertion of model?.assertions ?? []) {
    const id = String(assertion.assertionId ?? assertion.sourceProposalId ?? "");
    const text = `${id} ${assertion.assertionKind ?? ""} ${assertion.semanticName ?? ""}`;
    if (isEvidenceExcludedByIntent(selection.intent.module, selection.intent.action, text)) continue;
    if (!id || !pattern.test(text) || selection.fallbackEvidence.some((item) => item.id === id)) continue;
    selection.fallbackEvidence.push({
      kind: "assertion",
      id,
      pageId,
      semanticName: assertion.assertionKind ?? assertion.semanticName,
      status: assertion.status,
      confidence: assertion.confidence,
      reason: "ObservableSignal selected by normalized Page Model capability match.",
      evidence: normalizeEvidence(assertion.evidence, id)
    });
  }
}

function isEvidenceExcludedByIntent(module: string, action: string, text: string): boolean {
  if (isFundFlowFilterIntent(module, action)) {
    if (/\u7ea2\u5305\u53d1\u653e/.test(text)) return false;
    const unrelatedPage = action === "earn_fund_flow_filter"
      ? /spot_fund_flow|contract_fund_flow|\u73b0\u8d27\u6d41\u6c34|\u5408\u7ea6\u6d41\u6c34/i
      : action === "contract_fund_flow_filter"
        ? /spot_fund_flow|earn_fund_flow|\u73b0\u8d27\u6d41\u6c34|\u7406\u8d22\u6d41\u6c34/i
        : /earn_fund_flow|contract_fund_flow|\u7406\u8d22\u6d41\u6c34|\u5408\u7ea6\u6d41\u6c34/i;
    return unrelatedPage.test(text) || /transfer|withdraw|deposit|red[_-]?packet|order|\u5212\u8f6c|\u63d0\u73b0|\u5145\u503c|\u7ea2\u5305|\u8ba2\u5355/i.test(text);
  }
  if (module === "transfer") {
    return /withdraw|deposit|red[_-]?packet|order|\u63d0\u73b0|\u5145\u503c|\u7ea2\u5305|\u8ba2\u5355/i.test(text);
  }
  if (module === "withdraw") {
    return /transfer|deposit|red[_-]?packet|order|\u5212\u8f6c|\u5145\u503c|\u7ea2\u5305|\u8ba2\u5355/i.test(text);
  }
  return false;
}

function gapClosed(selection: PageModelEvidenceSelection, gap: string): boolean {
  const all = [...selection.selectedEvidence, ...selection.fallbackEvidence];
  const has = (pattern: RegExp) => all.some((item) => pattern.test(`${item.id} ${item.semanticName ?? ""}`) && isUsableStatus(item.status));
  if (/^(spot|earn|contract)_fund_flow_type_filter_option:/.test(gap)) {
    const expected = gap.split(":").slice(1).join(":");
    return hasExactOptionOrDynamicDropdown(selection, "record_type", expected);
  }
  if (/^(spot|earn|contract)_fund_flow_asset_filter_option:/.test(gap)) {
    const expected = gap.split(":").slice(1).join(":");
    return hasExactOptionOrDynamicDropdown(selection, "asset", expected);
  }
  if (/^(spot|earn|contract)_fund_flow_product_type_filter_option:/.test(gap)) {
    const expected = gap.split(":").slice(1).join(":");
    return hasExactOptionOrDynamicDropdown(selection, "product_type", expected);
  }
  if (/^(spot|earn)_fund_flow_result_assertion$/.test(gap)) return has(/result|list|table|empty|\u7ed3\u679c|\u5217\u8868|\u8868\u683c|\u7a7a\u72b6\u6001/i);
  if (gap === "spot_fund_flow_type_filter_option_gift_coin") return has(/gift_coin|\u7ea2\u5305\u53d1\u653e/i);
  if (gap === "spot_fund_flow_result_assertion") return has(/result_gift_or_empty|result_list|empty|\u7a7a\u72b6\u6001/i);
  if (gap === "transfer_from_account_selector") return has(/from_account|\u4ece.*\u8d26\u6237|\u8f6c\u51fa\u8d26\u6237/i);
  if (gap === "transfer_to_account_selector") return has(/to_account|\u5230.*\u8d26\u6237|\u8f6c\u5165\u8d26\u6237/i);
  if (gap === "transfer_asset_selector") return has(/asset_selector|\u5e01\u79cd|USDT/i);
  if (gap === "transfer_amount_input") return has(/amount_input|\u6570\u91cf|\u91d1\u989d/i);
  if (gap === "transfer_submit_result_assertion") return has(/submit_success|\u63d0\u4ea4\u6210\u529f|\u6210\u529f\u63d0\u793a/i);
  if (gap === "transfer_record_assertion") return has(/transfer\.record|record_50|transfer_record/i);
  if (gap === "withdraw_chain_selector_bsc") return has(/withdraw.*(?:chain|network|bsc)|network.*BSC|BSC.*network/i);
  if (gap === "withdraw_min_amount_source") return has(/withdraw.*(?:min_amount|minimum|amount)|min_amount|minimum/i);
  if (gap === "withdraw_verification_provider_state") return has(/withdraw.*(?:verification|email_code|sms_code|totp|provider)|GA|TOTP/i);
  if (gap === "withdraw_success_assertion") return has(/withdraw.*(?:success|submit_success|submitted|pending_review)/i);
  if (gap === "withdraw_record_assertion") return has(/withdraw.*record|record.*withdraw|record_contains|record_empty/i);
  return false;
}

function hasExactOptionOrDynamicDropdown(selection: PageModelEvidenceSelection, targetField: string, expected: string): boolean {
  const normalized = targetField === "record_type" ? normalizeProjectRecordTypeAlias(selection, expected) : expected;
  const normalizedExpected = normalizeText(typeof normalized === "string" ? normalized : expected);
  return selection.selectedEvidence.some((item) => {
    if (item.kind !== "element" || !isUsableStatus(item.status)) return false;
    const raw = item as Record<string, any>;
    const field = normalizeTargetField(String(item.targetField ?? raw.targetField ?? ""));
    if (field !== targetField) return false;
    if (item.controlType === "dropdown_option" || item.optionValue) {
      return normalizeText(String(item.optionValue ?? inferElementOptionValue(raw, targetField) ?? "")) === normalizedExpected;
    }
    if (item.controlType !== "dropdown") return false;
    const dropdown = raw.dropdown && typeof raw.dropdown === "object" ? raw.dropdown as Record<string, unknown> : {};
    const mode = String(dropdown.optionDiscoveryMode ?? dropdown.option_discovery_mode ?? "").toLowerCase();
    const hasSearchInput = Boolean(dropdown.searchInput || dropdown.search_input || dropdown.searchInputLocator || dropdown.search_input_locator);
    const hasSelectedValueSignal = Boolean(dropdown.selectedValueSignal || dropdown.selected_value_signal || dropdown.valuePersistenceSignal);
    return /searchable|dynamic|remote|virtualized/.test(mode) && hasSearchInput && hasSelectedValueSignal;
  });
}

function isUsableStatus(status?: string): boolean {
  return ["dom_verified", "screenshot_verified", "click_observed", "execution_observed", "execution_verified", "input_observed"].includes(status ?? "");
}

function isFundFlowFilterIntent(module: string, action: string): boolean {
  return module === "asset" && (action === "spot_fund_flow_filter" || action === "earn_fund_flow_filter" || action === "contract_fund_flow_filter");
}

function normalizeEvidence(value: unknown, id?: string) {
  if (!Array.isArray(value)) return [{ source: "page_map" as const, id, confidence: 0.5 }];
  return value.slice(0, 5).map((item) => {
    const record = item && typeof item === "object" ? item as Record<string, unknown> : {};
    return {
      source: "page_map" as const,
      id: String(id ?? record.path ?? record.source ?? "page_model"),
      quote: typeof record.path === "string" ? record.path : undefined,
      confidence: typeof record.confidence === "number" ? record.confidence : 0.5
    };
  });
}

function nextAction(readiness: PageModelEvidenceSelection["readiness"], executable: boolean, blockingGaps: string[]): PageModelExecutionPlan["recommendedNextAction"] {
  if (executable) return "execute";
  if (readiness === "blocked_by_precondition" || blockingGaps.some((gap) => /precondition|provider|verification|balance|kyc|whitelist/i.test(gap))) return "resolve_precondition";
  if (readiness === "missing") return "unsupported";
  return "collect_more_evidence";
}

function reasonFor(readiness: PageModelEvidenceSelection["readiness"], executable: boolean, gaps: string[], blockingGaps: string[]): string {
  if (executable) return "Page Model evidence and user assertion capabilities are sufficient to execute.";
  if (readiness === "missing") return "No matching Page Model exists for this request.";
  if (blockingGaps.length) return `Execution is blocked by required capabilities or preconditions: ${blockingGaps.join(", ")}`;
  return `More Page Model evidence is needed before execution: ${gaps.join(", ")}`;
}

