import type { AutomationCase, DslStep } from "./types.js";
import { rebuildEvidenceBuckets, type PageModelEvidenceSelection, type SelectedPageModelEvidence } from "./page-model-evidence-selector.js";
import type { UserAssertionParseResult } from "./user-assertion-parser.js";
import type { PageOperationManualSelection } from "./page-operation-manual.js";

export interface PageModelDslBuildResult {
  schemaVersion: "page-model-dsl-build.v1";
  executable: boolean;
  gaps: string[];
  blockingGaps: string[];
  case: AutomationCase;
  excludedEvidenceUsed: string[];
  temporarySelectorUsed: boolean;
  dslValidation: {
    contractVersion: "automation-dsl-contract.v1";
    passed: boolean;
    checkedRules: string[];
    contractGaps: string[];
    stepResults: Array<{
      stepId: string;
      action: string;
      passed: boolean;
      gaps: string[];
      pageModelId?: string;
      elementId?: string;
      assertionId?: string;
      evidenceId?: string;
      providerRequirementId?: string;
    }>;
    missingTargetRefs: string[];
    unsupportedLocators: string[];
    inventedSelectors: string[];
  };
}

const generatedValueCache = new WeakMap<PageModelEvidenceSelection, Record<string, string>>();

export function buildAutomationCaseFromPageModel(input: {
  selection: PageModelEvidenceSelection;
  userAssertions: UserAssertionParseResult;
  operationManualSelection?: PageOperationManualSelection;
  caseId?: string;
  title?: string;
}): PageModelDslBuildResult {
  ensureEvidenceBuckets(input.selection);
  const excluded = new Set(input.selection.excludedEvidence.map((item) => item.id));
  const steps: DslStep[] = [];
  const excludedEvidenceUsed: string[] = [];

  for (const page of navigationPagesForSelection(input.selection)) {
    pushIfAllowed(steps, excludedEvidenceUsed, excluded, buildNavigateStep(input.selection, page));
  }

  const negativeGuard = hasNegativeGuardCapability(input.operationManualSelection);
  const openOnlyNegativeGuard = input.selection.intent.operationType === "read" && negativeGuard || hasOpenOnlyNegativeGuardCapability(input.operationManualSelection);
  const executableElements = openOnlyNegativeGuard
    ? []
    : dedupeExecutableElements(executableElementEvidenceForSelection(input.selection)
    .filter((item) => shouldMaterializeElement(input.selection, item))
    .filter((item) => !negativeGuard || shouldMaterializeNegativeGuardElement(item))
    .sort((a, b) => elementExecutionOrder(input.selection, a) - elementExecutionOrder(input.selection, b)), input.selection);
  for (const element of executableElements) {
    const expansionStep = buildExplicitRowExpansionStep(input.selection, element, steps);
    if (expansionStep) pushIfAllowed(steps, excludedEvidenceUsed, excluded, expansionStep);
    pushIfAllowed(steps, excludedEvidenceUsed, excluded, buildElementStep(input.selection, element));
  }

  for (const assertion of input.userAssertions.assertions) {
    if (assertion.kind === "element_disabled" || assertion.kind === "element_enabled" || assertion.kind === "control_state_readable" || assertion.kind === "tab_active") {
      const controlStateEvidence = preferredControlStateAssertionEvidence(input.selection, assertion);
      if (controlStateEvidence) {
        pushIfAllowed(steps, excludedEvidenceUsed, excluded, buildAssertionStep(input.selection, controlStateEvidence, assertion));
        continue;
      }
    }
    const mappedEvidence = assertion.kind.startsWith("table_column")
      ? assertion.mappedEvidence
      : assertion.kind === "message_visible_exact"
        ? assertion.mappedEvidence
      : assertion.kind === "ui_text_visible" || assertion.kind === "record_contains" || assertion.kind === "record_or_empty_state" || assertion.kind === "field_value"
        ? assertion.mappedEvidence
      : assertion.mappedEvidence.filter((item) => item.kind === "assertion" || item.kind === "element");
    const preferredFailureEvidence = preferredRedPacketClaimFailureAssertionEvidence(input.selection, assertion);
    const orderedMappedEvidence = preferredFailureEvidence
      ? [{ id: preferredFailureEvidence.id }, ...mappedEvidence.filter((item) => item.id !== preferredFailureEvidence.id)]
      : mappedEvidence;
    for (const mapped of orderedMappedEvidence) {
      const evidence = assertion.kind === "message_visible_exact"
        ? messageAssertionScopeEvidence(input.selection, mapped.id)
          : assertion.kind === "element_disabled" || assertion.kind === "element_enabled" || assertion.kind === "control_state_readable" || assertion.kind === "element_absent" || assertion.kind === "tab_active"
          ? assertionEvidenceForSelection(input.selection).find((item) => item.id === mapped.id)
            ?? executableElementEvidenceForSelection(input.selection).find((item) => item.id === mapped.id)
          : assertionEvidenceForSelection(input.selection).find((item) => item.id === mapped.id)
            ?? executableElementEvidenceForSelection(input.selection).find((item) => item.id === mapped.id)
            ?? input.selection.evidenceBuckets.targetPage.find((item) => item.id === mapped.id);
      if (!evidence) continue;
      pushIfAllowed(steps, excludedEvidenceUsed, excluded, buildAssertionStep(input.selection, evidence, assertion));
      break;
    }
  }
  if (!shouldSuppressSuccessPolicyAssertion(input.userAssertions, input.operationManualSelection)) {
    for (const step of buildSuccessPolicyAssertionSteps(input.selection, input.operationManualSelection, negativeGuard)) {
      steps.push(step);
    }
  }

  const dslContractGaps = dslComponentContractGaps(steps);
  const dslValidation = validateStructuredDslTargets(steps, input.selection);
  const dslValidationGaps = dslValidation.passed ? [] : [
    ...dslValidation.contractGaps.map((gap) => `dsl_contract_gap:${gap}`),
    ...dslValidation.missingTargetRefs.map((id) => `dsl_missing_target_ref:${id}`),
    ...dslValidation.unsupportedLocators.map((locator) => `dsl_unsupported_locator:${locator}`),
    ...dslValidation.inventedSelectors.map((locator) => `dsl_invented_selector:${locator}`)
  ];
  const gaps = [...new Set([...input.selection.gaps, ...input.userAssertions.gaps, ...dslContractGaps, ...dslValidationGaps])];
  const blockingGaps = [...new Set([...input.selection.blockingGaps, ...input.userAssertions.gaps, ...dslContractGaps, ...dslValidationGaps])];
  const executable = input.selection.executable && input.userAssertions.gaps.length === 0 && excludedEvidenceUsed.length === 0 && dslContractGaps.length === 0 && dslValidation.passed;
  return {
    schemaVersion: "page-model-dsl-build.v1",
    executable,
    gaps,
    blockingGaps,
    excludedEvidenceUsed,
    temporarySelectorUsed: false,
    dslValidation,
    case: {
      id: input.caseId ?? `page_model_${input.selection.intent.module}_${input.selection.intent.action}`,
      title: input.title ?? `Page Model task: ${input.selection.intent.module}.${input.selection.intent.action}`,
      type: "web",
      project: input.selection.intent.project,
      module: input.selection.intent.module === "unknown" ? "asset" : input.selection.intent.module,
      priority: "P1",
      tags: ["page-model", "asset-module"],
      owner: "codex",
      env: [input.selection.intent.env],
      automationCandidate: executable,
      suggestedLayer: "web",
      preconditions: input.selection.intent.loginRequired ? ["user.logged_in"] : [],
      risk: input.selection.intent.operationType === "write" ? ["funds_write_action"] : ["read_only"],
      dataProfile: "page-model",
      steps,
      assertions: []
    }
  };
}

function hasNegativeGuardCapability(operationManualSelection?: PageOperationManualSelection): boolean {
  return (operationManualSelection?.capabilities ?? []).some((capability) => String(capability.operationType ?? "") === "negative_guard");
}

function hasOpenOnlyNegativeGuardCapability(operationManualSelection?: PageOperationManualSelection): boolean {
  return (operationManualSelection?.capabilities ?? []).some((capability) => {
    if (String(capability.operationType ?? "") !== "negative_guard") return false;
    const idText = [
      capability.capabilityId,
      capability.flowId,
      readStringArray(capability.blockedStateIds).join(" ")
    ].join(" ").toLowerCase();
    const behaviorText = [
      capability.capabilityId,
      capability.flowId,
      readStringArray(capability.naturalLanguageAliases).join(" "),
      readStringArray(capability.expectedEffects).join(" ")
    ].join(" ").toLowerCase();
    return /(?:^|[._-])open(?:[._-]|$)|initial/.test(idText) &&
      /直接进入|直接访问|进入.{0,8}页|页面不应进入|open[_\s-]*(page|withdraw|address)|initial/i.test(behaviorText);
  });
}

function shouldMaterializeNegativeGuardElement(element: SelectedPageModelEvidence): boolean {
  const text = `${element.id} ${element.semanticName ?? ""} ${element.targetField ?? ""}`.toLowerCase();
  if (/验证码|google|totp|email|邮箱|手机|security|amount|count|quantity|asset|type|input|submit|confirm|确定|提交/.test(text)) return false;
  return /entry|open|入口|打开|创建|新增|添加|发起|create|add/.test(text);
}

function buildSuccessPolicyAssertionSteps(selection: PageModelEvidenceSelection, operationManualSelection?: PageOperationManualSelection, includeReadNegativeGuard = false): Array<DslStep & Record<string, unknown>> {
  if (!operationManualSelection?.successEvidencePolicies.length) return [];
  if (selection.intent.operationType !== "write" && !includeReadNegativeGuard) return [];
  const targetPage = selection.evidenceBuckets.targetPage[0] ?? selection.selectedEvidence.find((item) => item.kind === "page");
  const steps: Array<DslStep & Record<string, unknown>> = [];
  for (const policy of operationManualSelection.successEvidencePolicies) {
    const textCandidates = successPolicyTextCandidates(policy);
    if (textCandidates.length) {
      steps.push({
        id: `assert-${safeId(String(policy.policyId ?? "success-policy"))}`,
        action: "assert",
        semantic_target: String(policy.description ?? "观察写操作成功信号"),
        assertion: {
          type: "textVisibleAny",
          expected: textCandidates,
          source: "operation_manual_success_policy",
          observeWindowMs: observeWindowMsForSuccessPolicy(policy)
        },
        pageId: targetPage?.pageId,
        pageModelId: targetPage?.pageId,
        assertionId: String(policy.policyId ?? "success_policy"),
        evidenceId: String(policy.policyId ?? "success_policy"),
        allow_healing: false,
        max_healing_level: 0,
        collect_snapshot: true,
        timeout_ms: observeWindowMsForSuccessPolicy(policy),
        source: "operation_manual",
        readiness: "operation_manual_backed"
      });
    }
    for (const fieldSignal of successPolicyPageFieldSignals(policy)) {
      const expected = materializeIntentPlaceholders(fieldSignal.expected, selection);
      if (!expected) continue;
      steps.push({
        id: `assert-${safeId(String(policy.policyId ?? "success-policy"))}-${safeId(fieldSignal.field)}`,
        action: "assert",
        semantic_target: `${fieldSignal.field} updated`,
        assertion: {
          type: "textVisibleAny",
          expected: [expected],
          source: "operation_manual_success_policy_page_field",
          observeWindowMs: fieldSignal.observeWindowMs ?? observeWindowMsForSuccessPolicy(policy)
        },
        pageId: targetPage?.pageId,
        pageModelId: targetPage?.pageId,
        assertionId: `${String(policy.policyId ?? "success_policy")}.${fieldSignal.field}`,
        evidenceId: `${String(policy.policyId ?? "success_policy")}.${fieldSignal.field}`,
        allow_healing: false,
        max_healing_level: 0,
        collect_snapshot: true,
        timeout_ms: fieldSignal.observeWindowMs ?? observeWindowMsForSuccessPolicy(policy),
        source: "operation_manual",
        readiness: "operation_manual_backed"
      });
    }
  }
  return steps;
}

function successPolicyPageFieldSignals(policy: Record<string, unknown>): Array<{ field: string; expected: string; observeWindowMs?: number }> {
  const acceptedSignals = Array.isArray(policy.acceptedSignals) ? policy.acceptedSignals as Array<Record<string, unknown>> : [];
  return acceptedSignals
    .filter((signal) => String(signal.type ?? "").toLowerCase() === "page_field")
    .map((signal) => ({
      field: String(signal.field ?? "").trim(),
      expected: String(signal.expected ?? "").trim(),
      observeWindowMs: Number.isFinite(Number(signal.observeWindowMs)) ? Number(signal.observeWindowMs) : undefined
    }))
    .filter((signal) => signal.field && signal.expected);
}

function successPolicyTextCandidates(policy: Record<string, unknown>): string[] {
  const acceptedSignals = Array.isArray(policy.acceptedSignals) ? policy.acceptedSignals as Array<Record<string, unknown>> : [];
  const candidates = acceptedSignals.flatMap((signal) => readStringArray(signal.textCandidates));
  if (candidates.length) return [...new Set(candidates)];
  return /\u6210\u529f|success/i.test(`${policy.policyId ?? ""} ${policy.description ?? ""}`) ? ["成功"] : [];
}

function observeWindowMsForSuccessPolicy(policy: Record<string, unknown>): number {
  const acceptedSignals = Array.isArray(policy.acceptedSignals) ? policy.acceptedSignals as Array<Record<string, unknown>> : [];
  const windows = acceptedSignals.map((signal) => Number(signal.observeWindowMs)).filter((value) => Number.isFinite(value) && value > 0);
  return windows.length ? Math.max(...windows) : 8_000;
}

function pushIfAllowed(steps: DslStep[], excludedEvidenceUsed: string[], excluded: Set<string>, step: DslStep & Record<string, unknown>): void {
  const evidenceId = String(step.evidenceId ?? step.elementId ?? step.assertionId ?? step.pageModelId ?? "");
  if (excluded.has(evidenceId)) {
    excludedEvidenceUsed.push(evidenceId);
    return;
  }
  steps.push(step);
}

function buildNavigateStep(selection: PageModelEvidenceSelection, page: SelectedPageModelEvidence): DslStep & Record<string, unknown> {
  const target = page.url ?? page.urlPattern;
  return baseStep({
    id: `open-${safeId(page.pageId ?? page.id)}`,
    action: "navigate",
    semanticTarget: `打开 ${page.semanticName ?? page.id}`,
    evidence: page,
    selection,
    extra: { pageModelId: page.pageId ?? page.id, target, primary_locator: target }
  });
}

function navigationPagesForSelection(selection: PageModelEvidenceSelection): SelectedPageModelEvidence[] {
  const bucketPages = selection.evidenceBuckets?.targetPage ?? [];
  if (bucketPages.length) return bucketPages;
  const pages = selection.selectedEvidence.filter((item) => item.kind === "page");
  if (isFundFlowFilterSelection(selection)) {
    const targetPageId = fundFlowTargetPageId(selection);
    const directTarget = pages.find((page) => page.pageId === targetPageId);
    if (directTarget) return [directTarget];
  }
  return pages;
}

function executableElementEvidenceForSelection(selection: PageModelEvidenceSelection): SelectedPageModelEvidence[] {
  const bucketElements = selection.evidenceBuckets?.executableElements ?? [];
  const providerUiElements = (selection.evidenceBuckets?.providers ?? []).filter((item) => item.kind === "element" && item.executionAllowed !== false);
  if (bucketElements.length || providerUiElements.length) return [...bucketElements, ...providerUiElements];
  return selection.selectedEvidence.filter((item) => item.kind === "element" && item.executionAllowed !== false);
}

function assertionEvidenceForSelection(selection: PageModelEvidenceSelection): SelectedPageModelEvidence[] {
  const bucketAssertions = selection.evidenceBuckets?.assertions ?? [];
  const bucketTargetPages = selection.evidenceBuckets?.targetPage ?? [];
  const bucketEvidence = [...bucketAssertions, ...bucketTargetPages];
  if (bucketEvidence.length) return bucketEvidence;
  return [...selection.fallbackEvidence, ...selection.selectedEvidence].filter((item) =>
    (item.kind === "assertion" || item.kind === "page" || isObservableAssertionEvidence(item)) &&
    item.executionAllowed !== false
  );
}

function preferredControlStateAssertionEvidence(
  selection: PageModelEvidenceSelection,
  assertion: UserAssertionParseResult["assertions"][number]
): SelectedPageModelEvidence | undefined {
  const assertions = assertionEvidenceForSelection(selection)
    .filter((item) => item.kind === "assertion" && item.executionAllowed !== false);
  const pattern = assertion.kind === "tab_active"
    ? /active|selected|高亮|选中|element_enabled|tab/i
    : assertion.kind === "element_enabled"
    ? /element_enabled|enabled|高亮|可点击|可用/i
    : assertion.kind === "control_state_readable"
      ? /control_state_readable|state_readable|状态可读|switch|开关|aria-checked|data-state/i
      : /element_disabled|disabled|置灰|不可点击|禁用/i;
  const controlStateAssertions = assertions.filter((item) => {
    const text = `${item.assertionType ?? ""} ${item.id} ${item.semanticName ?? ""}`;
    if (assertion.kind === "tab_active" && !/tab|标签|页签|product_type/i.test(`${text} ${item.targetElementId ?? ""}`)) return false;
    if ((assertion.kind === "element_enabled" || assertion.kind === "tab_active") && /element_disabled|disabled|置灰|不可点击|禁用|不可用/i.test(text)) return false;
    return pattern.test(text);
  });
  if (!controlStateAssertions.length) return undefined;
  return controlStateAssertions
    .sort((left, right) => controlStateAssertionEvidenceScore(right, assertion) - controlStateAssertionEvidenceScore(left, assertion))[0];
}

function controlStateAssertionEvidenceScore(
  evidence: SelectedPageModelEvidence,
  assertion: UserAssertionParseResult["assertions"][number]
): number {
  const haystack = `${evidence.id} ${evidence.semanticName ?? ""} ${evidence.targetElementId ?? ""} ${(evidence.textCandidates ?? []).join(" ")}`;
  const normalizedHaystack = haystack.toLowerCase();
  const assertionText = `${assertion.rawText} ${assertion.assertionIntent?.expected ?? ""} ${assertion.expectedTexts.join(" ")}`.toLowerCase();
  let score = 0;
  if (/confirm|确定|确认|submit|保存/i.test(haystack)) score += 30;
  if (assertion.assertionIntent?.field && normalizedHaystack.includes(String(assertion.assertionIntent.field).toLowerCase())) score += 20;
  if (assertion.kind === "tab_active" && /tab|标签|页签|active|selected|高亮|选中/i.test(haystack)) score += 35;
  if (assertion.kind === "tab_active") {
    const expected = normalizeStepText(String(assertion.assertionIntent?.expected ?? assertion.rawText));
    if (expected && normalizeStepText(haystack).includes(expected.replace(/理财产品|理财|产品/g, ""))) score += 40;
  }
  score += disabledScenarioScore(assertionText, normalizedHaystack);
  for (const concept of assertion.targetConcepts ?? []) {
    if (concept && normalizedHaystack.includes(String(concept).toLowerCase())) score += 4;
  }
  score += Number(evidence.confidence ?? 0) * 10;
  return score;
}

function disabledScenarioScore(assertionText: string, evidenceText: string): number {
  if (!/置灰|不可点击|禁用|不可用|disabled/.test(assertionText)) return 0;
  const wantsBalance = /余额不足|余额为\s*0|现货账户\s*0|available=0|insufficient/.test(assertionText);
  const wantsBelowMinimum = /低于最小|小于最小|最小申购|below.*min/.test(assertionText);
  const wantsEmpty = /为空|未输入|空数量|empty/.test(assertionText);
  let score = 0;
  if (wantsBalance) {
    if (/余额不足|余额为\s*0|现货账户\s*0|insufficient|balance/.test(evidenceText)) score += 35;
    if (/empty|空数量|为空/.test(evidenceText)) score -= 40;
    if (/低于最小|below.*min|minimum/.test(evidenceText)) score -= 18;
  }
  if (wantsBelowMinimum) {
    if (/低于最小|小于最小|below.*min|minimum/.test(evidenceText)) score += 35;
    if (/empty|空数量|为空/.test(evidenceText)) score -= 30;
    if (/余额不足|insufficient|balance/.test(evidenceText)) score -= 12;
  }
  if (wantsEmpty) {
    if (/empty|空数量|为空/.test(evidenceText)) score += 35;
    if (/余额不足|insufficient|balance|低于最小|below.*min|minimum/.test(evidenceText)) score -= 18;
  }
  return score;
}

function messageAssertionScopeEvidence(selection: PageModelEvidenceSelection, id: string): SelectedPageModelEvidence | undefined {
  return [
    ...(selection.evidenceBuckets?.targetPage ?? []),
    ...selection.selectedEvidence,
    ...selection.fallbackEvidence
  ].find((item) => item.id === id && (item.kind === "page" || item.kind === "assertion") && item.executionAllowed !== false);
}

function preferredRedPacketClaimFailureAssertionEvidence(
  selection: PageModelEvidenceSelection,
  assertion: UserAssertionParseResult["assertions"][number]
): SelectedPageModelEvidence | undefined {
  if (selection.intent.module !== "red-packet" || selection.intent.action !== "claim_red_packet") return undefined;
  const requestText = `${selection.request} ${assertion.rawText} ${assertion.expectedTexts.join(" ")}`;
  if (!/错误口令|口令错误|无效口令|不存在|领取失败|失败|invalid|wrong/i.test(requestText)) return undefined;
  const assertions = assertionEvidenceForSelection(selection)
    .filter((item) => item.kind === "assertion" && item.executionAllowed !== false);
  return assertions
    .filter((item) => /passphrase|口令|领取失败|错误|invalid|nonexistent|failure/i.test(`${item.id} ${item.semanticName ?? ""} ${(item.textCandidates ?? []).join(" ")}`))
    .sort((left, right) => redPacketFailureAssertionScore(right) - redPacketFailureAssertionScore(left))[0];
}

function redPacketFailureAssertionScore(evidence: SelectedPageModelEvidence): number {
  const text = `${evidence.assertionType ?? ""} ${evidence.id} ${evidence.semanticName ?? ""} ${(evidence.textCandidates ?? []).join(" ")}`;
  let score = Number(evidence.confidence ?? 0) * 10;
  if (/api_message_exact|message_visible_exact/i.test(text)) score += 40;
  if (/nonexistent_passphrase|invalid_passphrase|口令错误|错误口令|红包口令错误/i.test(text)) score += 35;
  if (/领取失败|failure/i.test(text)) score += 15;
  return score;
}

function targetElementForAssertion(selection: PageModelEvidenceSelection, assertionEvidence: SelectedPageModelEvidence): SelectedPageModelEvidence | undefined {
  const targetElementId = assertionEvidence.targetElementId;
  if (!targetElementId) return undefined;
  return [
    ...(selection.evidenceBuckets?.executableElements ?? []),
    ...(selection.selectedEvidence ?? []),
    ...(selection.fallbackEvidence ?? [])
  ].find((item) => item.kind === "element" && item.id === targetElementId && item.executionAllowed !== false);
}

function ensureEvidenceBuckets(selection: PageModelEvidenceSelection): void {
  if (selection.evidenceBuckets) return;
  rebuildEvidenceBuckets(selection);
}

function buildElementStep(selection: PageModelEvidenceSelection, element: SelectedPageModelEvidence): DslStep & Record<string, unknown> {
  const action = inferAction(selection, element);
  const targetField = inferTargetField(element);
  const component = componentForEvidence(element, targetField);
  const value = normalizeElementValueAlias(valueFor(selection, element), component);
  const credentialType = verificationCredentialTypeForElement(element, targetField);
  const providerRequirementId = credentialType ? providerRequirementIdFor(selection, credentialType) : undefined;
  const materializedLocators = [
    primaryLocatorForEvidence(element),
    ...(fallbackLocatorsForEvidence(element) ?? [])
  ]
    ?.map((locator) => materializeIntentPlaceholders(locator, selection))
    .filter((locator): locator is string => Boolean(locator));
  const primaryLocator = preferredLocatorForSelection(materializedLocators ?? [], selection) ?? materializedLocators?.[0];
  const fallbackLocators = materializedLocators?.filter((locator) => locator !== primaryLocator);
  return baseStep({
    id: `${action}-${safeId(element.id)}`,
    action,
    semanticTarget: element.semanticName ?? element.id,
    evidence: element,
    selection,
    extra: {
      pageModelId: element.pageId,
      elementId: element.id,
      targetPageId: element.pageId,
      targetElementId: element.id,
      targetField,
      target: primaryLocator,
      primary_locator: primaryLocator,
      fallback_locators: fallbackLocators,
      value: credentialType ? undefined : value,
      valueFrom: credentialType
        ? {
          type: "verificationCredential",
          credentialType,
          scene: providerSceneFor(selection, credentialType),
          account: undefined
        }
        : undefined,
      providerRequirementId,
      valueSource: value === undefined ? undefined : valueSourceFor(selection, element),
      dataBinding: dataBindingFor(selection, element),
      component,
      postconditions: postconditionsForEvidence(selection, element, targetField, value),
      scopeGuard: scopeGuardForEvidence(element),
      negativeLocatorHints: element.negativeLocatorHints,
      preconditions: element.preconditions
    }
  });
}

function normalizeElementValueAlias(value: unknown, component?: Record<string, unknown>): unknown {
  if (typeof value !== "string" || !component || component.type !== "dropdown") return value;
  const optionSet = new Set([
    ...readStringArray(component.verifiedOptions),
    ...readStringArray(component.optionInventory)
  ].map(normalizeStepText));
  const aliases = component.valueAliases;
  if (!aliases || typeof aliases !== "object" || Array.isArray(aliases)) return value;
  const normalizedValue = normalizeStepText(value);
  for (const [canonical, rawAliases] of Object.entries(aliases as Record<string, unknown>)) {
    const candidates = readStringArray([canonical, ...readStringArray(rawAliases)]);
    if (!candidates.map(normalizeStepText).includes(normalizedValue)) continue;
    const verifiedAlias = candidates.find((candidate) => optionSet.has(normalizeStepText(candidate)));
    return verifiedAlias ?? canonical;
  }
  return value;
}

function buildExplicitRowExpansionStep(selection: PageModelEvidenceSelection, element: SelectedPageModelEvidence, existingSteps: DslStep[]): (DslStep & Record<string, unknown>) | undefined {
  const rowScope = element.rowScope && typeof element.rowScope === "object" ? element.rowScope as Record<string, unknown> : undefined;
  const expandText = typeof rowScope?.expandText === "string" ? rowScope.expandText.trim() : "";
  if (!expandText || !selection.request.includes(expandText)) return undefined;
  if (!isEarnRowActionEvidence(element) && !/row_action|row action|行内|列表/i.test(`${element.id} ${element.semanticName ?? ""}`)) return undefined;
  if (existingSteps.some((step) => {
    const record = step as unknown as Record<string, unknown>;
    return String(record.primary_locator ?? record.target ?? "").includes(expandText);
  })) return undefined;
  return baseStep({
    id: `click-${safeId(element.id)}-expand-list`,
    action: "click",
    semanticTarget: `点击${expandText}`,
    evidence: element,
    selection,
    extra: {
      pageModelId: element.pageId,
      elementId: element.id,
      targetPageId: element.pageId,
      targetElementId: element.id,
      targetField: "list_expansion",
      target: `role=button:${expandText}`,
      primary_locator: `role=button:${expandText}`,
      fallback_locators: [`textExact=${expandText}`],
      syntheticFromRowScopeExpansion: true
    }
  });
}

function preferredLocatorForSelection(locators: string[], selection: PageModelEvidenceSelection): string | undefined {
  const asset = typeof selection.intent.data.asset === "string" ? selection.intent.data.asset : undefined;
  if (asset) {
    const scoped = locators.find((locator) => locator.includes(asset) && /xpath=|css=|\[|tr|table|row/i.test(locator));
    if (scoped) return scoped;
  }
  return locators[0];
}

function materializeIntentPlaceholders(locator: string | undefined, selection: PageModelEvidenceSelection): string | undefined {
  if (!locator) return undefined;
  return locator
    .replace(/intent\.data\.asset/g, String(selection.intent.data.asset ?? ""))
    .replace(/\{asset\}/g, String(selection.intent.data.asset ?? ""))
    .replace(/\{status\}/g, inferredRowStatus(selection) ?? "")
    .replace(/\{productName\}/g, inferredProductName(selection) ?? "")
    .replace(/\{amount\}/g, String(selection.intent.data.amount ?? selection.intent.data.amountPolicy ?? ""))
    .replace(/\{network\}/g, String(selection.intent.data.network ?? ""))
    .replace(/\{uid\}/g, String(selection.intent.data.uid ?? selection.intent.data.internalUid ?? ""))
    .replace(/\{nickname\}/g, String(selection.intent.data.nickname ?? generatedNicknameValue(selection) ?? ""));
}

function inferredRowStatus(selection: PageModelEvidenceSelection): string | undefined {
  const explicit = selection.intent.data.status ?? selection.intent.data.rowStatus ?? selection.intent.data.productStatus;
  if (typeof explicit === "string" && explicit.trim()) return normalizeRowStatusText(explicit.trim());
  const request = selection.request;
  if (/进行中/.test(request)) return "进行中";
  if (/已结束|结束/.test(request)) return "已结束";
  if (/已下架|下架/.test(request)) return "已下架";
  const match = request.match(/状态(?:为|是)?\s*["“”']?([^"，,。；;\s]+)["“”']?/)?.[1];
  if (match) return match.trim();
  return undefined;
}

function normalizeRowStatusText(value: string): string {
  if (/进行中/.test(value)) return "进行中";
  if (/已结束|结束/.test(value)) return "已结束";
  if (/已下架|下架/.test(value)) return "已下架";
  return value;
}

function inferredProductName(selection: PageModelEvidenceSelection): string | undefined {
  const explicit = selection.intent.data.productName ?? selection.intent.data.product;
  if (typeof explicit === "string" && explicit.trim()) return explicit.trim();
  const request = selection.request;
  return request.match(/(?:产品名|项目名|理财名称|名称)(?:为|是)?\s*["“”']?([^"，,。；;]+?)["“”']?(?:右侧|产品行|，|,|。|；|;|$)/)?.[1]?.trim();
}

function shouldMaterializeElement(selection: PageModelEvidenceSelection, element: SelectedPageModelEvidence): boolean {
  const text = `${element.id} ${element.semanticName ?? ""} ${element.role ?? ""}`.toLowerCase();
  if (element.controlType === "tab" || /\btab\b|页签/i.test(text)) {
    return shouldMaterializeTabElement(selection, element);
  }
  if (selection.intent.module === "personal") {
    if (selection.intent.action.startsWith("view_")) return false;
    if (selection.intent.action === "assert_nickname_confirm_disabled" && /confirm|确定|disabled|置灰/i.test(text)) return false;
    if (selection.intent.action === "open_api_create_modal") return /create_button|empty_create_button|创建api按钮|立即创建按钮/i.test(text);
    if (selection.intent.action === "open_kyc_start_modal") return /start_button|开始认证按钮/i.test(text);
    if (selection.intent.action === "open_invite_modal") return /invite_view_button|邀请码.*查看|查看按钮/i.test(text);
    if (selection.intent.action === "update_nickname") return /nickname_edit_button|nickname_input|nickname_confirm_button|昵称.*修改|昵称输入|确定按钮/i.test(text);
    if (selection.intent.action === "open_nickname_modal" || selection.intent.action === "assert_nickname_confirm_disabled") return /nickname_edit_button|昵称.*修改/i.test(text);
  }
  const isRowAction = /row_action|action_button|open_modal|submit_or_confirm|\u7533\u8d2d|\u8d4e\u56de/i.test(text);
  if (!isRowAction && /table|list|row|empty_state|pagination|page_state|\u5217\u8868|\u8868\u683c|\u8bb0\u5f55|\u7a7a\u72b6\u6001|\u5206\u9875/i.test(text)) {
    if (selection.intent.module === "red-packet" && selection.intent.action === "view_red_packet_records" && /records?\.entry|record_entry|\u7ea2\u5305\u8bb0\u5f55\u5165\u53e3|\u7ea2\u5305\u660e\u7ec6/i.test(text)) {
      return true;
    }
    return false;
  }
  if (/entry|\u5165\u53e3/i.test(text) && selection.intent.operationType === "read") {
    return false;
  }
  if (selection.intent.data.amountPolicy === "empty" && /confirm_button|submit|确定|确认/i.test(text)) {
    return false;
  }
  if (/置灰|不可点击|禁用|不可用|disabled|不点击确认|不点击确定/i.test(selection.request) && /confirm_button|submit|确定|确认/i.test(text)) {
    return false;
  }
  if (selection.intent.action === "earn_product_view" && /row_action|action_button|open_modal|submit_or_confirm|amount_input|申购|赎回|确定|确认/i.test(text)) {
    return false;
  }
  if (isUnrequestedRedPacketClaimDetailAction(selection, element)) return false;
  if (isEarnOperationSelection(selection) && isEarnRowActionEvidence(element)) {
    const requestedAsset = normalizeAssetSymbolCandidate(selection.intent.data.asset);
    const boundAsset = evidenceBoundAsset(element);
    if (requestedAsset && boundAsset && boundAsset !== requestedAsset) return false;
  }
  if (isFundFlowFilterSelection(selection)) {
    const targetPageId = fundFlowTargetPageId(selection);
    if (hasDirectFundFlowTarget(selection) && element.pageId !== targetPageId) return false;
    if (isUnrequestedSpotFundFlowFilterElement(selection, element)) return false;
    if (isSpotFundFlowTransferRecordHelper(selection, element)) return false;
    if (/query_button|\u67e5\u8be2/i.test(text)) return true;
    if (/reset_button|\u91cd\u7f6e/i.test(text)) return Boolean(selection.intent.data.resetRequested);
    if (element.controlType === "dropdown_option") return false;
    const binding = dataBindingFor(selection, element);
    if (binding && binding.validation !== "matched") return false;
    if (binding?.targetField === "record_type") return true;
    if (binding?.targetField === "product_type") return true;
    if (binding?.targetField === "asset") return true;
    if (binding?.targetField === "time_range") return true;
    return false;
  }
  return true;
}

function isUnrequestedRedPacketClaimDetailAction(selection: PageModelEvidenceSelection, element: SelectedPageModelEvidence): boolean {
  if (selection.intent.module !== "red-packet" || selection.intent.action !== "claim_red_packet") return false;
  const text = `${element.id} ${element.semanticName ?? ""} ${element.targetField ?? ""}`;
  if (!/detail_modal|详情弹窗|详情.*领取|弹窗.*领取/i.test(text)) return false;
  if (/详情|弹窗|二次领取|确认领取/.test(selection.request)) return false;
  if (/错误口令|无效口令|口令错误|领取失败|失败|invalid|wrong/i.test(selection.request)) return true;
  return false;
}

function shouldMaterializeTabElement(selection: PageModelEvidenceSelection, element: SelectedPageModelEvidence): boolean {
  const targetField = inferTargetField(element);
  const requested = targetField ? valueForTargetField(selection, targetField) : undefined;
  const record = element as unknown as Record<string, unknown>;
  const optionValue = String(element.optionValue ?? record.value ?? element.semanticName ?? "");
  if (isExplicitTabRequested(selection.request, optionValue, element.semanticName ?? element.id)) return true;
  if (requested === undefined) return false;
  if (normalizeStepText(optionValue) !== normalizeStepText(String(requested))) return false;
  const text = `${element.id} ${element.semanticName ?? ""} ${element.status ?? ""}`;
  if (/current|active|selected|当前|已选中|高亮/i.test(text)) return false;
  return true;
}

function isExplicitTabRequested(request: string, optionValue: string, semanticName: string): boolean {
  const normalizedRequest = normalizeStepText(request);
  const candidates = [optionValue, semanticName]
    .flatMap((value) => [value, value.replace(/理财产品|理财|产品|标签|页签/g, "")])
    .map(normalizeStepText)
    .filter(Boolean);
  if (!candidates.some((candidate) => normalizedRequest.includes(candidate))) return false;
  return /点击|选择|切换|标签|页签|tab/i.test(request);
}

function isEarnOperationSelection(selection: PageModelEvidenceSelection): boolean {
  return selection.intent.module === "asset" && (selection.intent.action === "earn_subscribe" || selection.intent.action === "earn_redeem");
}

function isEarnRowActionEvidence(element: SelectedPageModelEvidence): boolean {
  const text = `${element.id} ${element.semanticName ?? ""} ${element.role ?? ""} ${element.semanticRole ?? ""} ${element.controlType ?? ""}`;
  if (!/subscribe|redeem|申购|赎回/i.test(text)) return false;
  return /row|产品行|持仓行|product_list|finance_account|row_action|action_button/i.test(text);
}

function evidenceBoundAsset(element: SelectedPageModelEvidence): string | undefined {
  const explicit = normalizeAssetSymbolCandidate(element.entityBindings?.asset);
  if (explicit) return explicit;
  const rowScopeValue = element.rowScope && typeof element.rowScope === "object" ? element.rowScope.value : undefined;
  const rowScopeAsset = normalizeAssetSymbolCandidate(rowScopeValue);
  if (rowScopeAsset) return rowScopeAsset;
  const locatorText = JSON.stringify(element.locatorCandidates ?? []);
  const rowScopedMatch = locatorText.match(/rowScoped=(?:value|asset):([A-Za-z][A-Za-z0-9]{1,11})/i)?.[1];
  const rowContainsMatch = locatorText.match(/row\s+contains\s+([A-Za-z][A-Za-z0-9]{1,11})/i)?.[1];
  const locatorAsset = normalizeAssetSymbolCandidate(rowScopedMatch ?? rowContainsMatch);
  if (locatorAsset) return locatorAsset;
  const text = `${element.id} ${element.semanticName ?? ""}`;
  const rowTextMatch = text.match(/\b([A-Za-z][A-Za-z0-9]{1,11})\b\s*(?:产品行|持仓行|币种行|资产行)/i)?.[1]
    ?? text.match(/[._-]([A-Za-z][A-Za-z0-9]{1,11})[._-]row(?!_action)/i)?.[1];
  return normalizeAssetSymbolCandidate(rowTextMatch);
}

function normalizeAssetSymbolCandidate(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const raw = String(value).trim().replace(/["“”']/g, "");
  if (!/^[A-Za-z][A-Za-z0-9]{1,11}$/.test(raw)) return undefined;
  const normalized = raw.toUpperCase();
  return new Set(["UID", "ID", "GA", "TOTP", "OTP", "API", "KYC", "TEST", "UAT", "ENV", "LOGIN", "USER", "ACCOUNT"]).has(normalized)
    ? undefined
    : normalized;
}

function isObservableAssertionEvidence(item: SelectedPageModelEvidence): boolean {
  if (item.kind !== "element") return false;
  const text = `${item.id} ${item.semanticName ?? ""} ${item.role ?? ""} ${item.semanticRole ?? ""} ${item.controlType ?? ""}`;
  if (/row_action|action_button|open_modal|submit_or_confirm|\u7533\u8d2d|\u8d4e\u56de/i.test(text)) return false;
  return /result|table|list|row|empty_state|page_state|\u7ed3\u679c|\u5217\u8868|\u8868\u683c|\u8bb0\u5f55|\u7a7a\u72b6\u6001|\u6682\u65e0/i.test(text);
}

function dedupeExecutableElements(elements: SelectedPageModelEvidence[], selection: PageModelEvidenceSelection): SelectedPageModelEvidence[] {
  if (selection.intent.module === "personal") {
    return dedupePersonalExecutableElements(elements, selection);
  }
  if (!isFundFlowFilterSelection(selection)) {
    return elements.sort((a, b) => elementExecutionOrder(selection, a) - elementExecutionOrder(selection, b));
  }
  const selected = new Map<string, SelectedPageModelEvidence>();
  for (const element of elements) {
    const key = executableCapabilityKey(element);
    const current = selected.get(key);
    if (!current || elementMaterializationScore(element) > elementMaterializationScore(current)) {
      selected.set(key, element);
    }
  }
  return [...selected.values()].sort((a, b) => elementExecutionOrder(selection, a) - elementExecutionOrder(selection, b));
}

function dedupePersonalExecutableElements(elements: SelectedPageModelEvidence[], selection: PageModelEvidenceSelection): SelectedPageModelEvidence[] {
  if (selection.intent.action !== "open_api_create_modal") {
    return elements.sort((a, b) => elementExecutionOrder(selection, a) - elementExecutionOrder(selection, b));
  }
  const requestedEmptyEntry = /空状态|立即创建/.test(selection.request);
  const candidates = elements.filter((element) => /create_api|create_button|empty_create_button|创建api|立即创建/i.test(`${element.id} ${element.semanticName ?? ""} ${element.targetField ?? ""}`));
  const chosen = candidates
    .sort((left, right) => personalApiCreateEntryScore(right, requestedEmptyEntry) - personalApiCreateEntryScore(left, requestedEmptyEntry))[0];
  const rest = elements.filter((element) => !candidates.includes(element));
  return [...rest, ...(chosen ? [chosen] : [])].sort((a, b) => elementExecutionOrder(selection, a) - elementExecutionOrder(selection, b));
}

function personalApiCreateEntryScore(element: SelectedPageModelEvidence, requestedEmptyEntry: boolean): number {
  const text = `${element.id} ${element.semanticName ?? ""} ${JSON.stringify(element.locatorCandidates ?? [])}`;
  let score = elementMaterializationScore(element);
  if (/empty_create_button|立即创建/.test(text)) score += requestedEmptyEntry ? 80 : -80;
  if (/create_button|创建API按钮/i.test(text) && !/empty_create_button/.test(text)) score += requestedEmptyEntry ? -20 : 60;
  return score;
}

function executableCapabilityKey(element: SelectedPageModelEvidence): string {
  const targetField = inferTargetField(element);
  const optionValue = targetField ? inferOptionValue(element, targetField) : undefined;
  const pageId = element.pageId ?? "";
  if (/query_button|search_button/i.test(element.id)) return `${pageId}:action:query`;
  if (!targetField) return `${pageId}:element:${element.id}`;
  if (optionValue) return `${pageId}:${targetField}:option:${normalizeStepText(String(optionValue))}`;
  return `${pageId}:${targetField}:trigger`;
}

function elementMaterializationScore(element: SelectedPageModelEvidence): number {
  let score = 0;
  if (element.id.startsWith("funds.")) score += 100;
  if (element.controlType === "dropdown") score += 30;
  if (element.controlType === "dropdown_option") score += 30;
  if (element.controlType === "tab") score += 30;
  if (element.status === "execution_verified") score += 60;
  if (element.status === "execution_observed") score += 50;
  if (element.status === "click_observed") score += 40;
  if (element.status === "dom_verified") score += 30;
  score += Number(element.confidence ?? 0) * 10;
  return score;
}

function hasDirectFundFlowTarget(selection: PageModelEvidenceSelection): boolean {
  const targetPageId = fundFlowTargetPageId(selection);
  return selection.selectedEvidence.some((item) =>
    item.kind === "page" &&
    item.pageId === targetPageId &&
    Boolean(item.url || item.urlPattern)
  );
}

function isUnrequestedSpotFundFlowFilterElement(selection: PageModelEvidenceSelection, element: SelectedPageModelEvidence): boolean {
  const targetField = inferTargetField(element);
  if (!targetField || targetField === "action") return false;
  return valueForTargetField(selection, targetField) === undefined;
}

function isSpotFundFlowTransferRecordHelper(selection: PageModelEvidenceSelection, element: SelectedPageModelEvidence): boolean {
  if (!isFundFlowFilterSelection(selection)) return false;
  const text = `${element.id} ${element.semanticName ?? ""} ${element.parentElementId ?? ""}`.toLowerCase();
  if (!/t2_5\.transfer_record|transfer_record/.test(text)) return false;
  const requestedType = selection.intent.data.recordType ?? selection.intent.data.type;
  return typeof requestedType !== "string" || !/\u5212\u8f6c|transfer/i.test(requestedType);
}

function elementExecutionOrder(selection: PageModelEvidenceSelection, element: SelectedPageModelEvidence): number {
  const text = `${element.id} ${element.semanticName ?? ""} ${element.role ?? ""}`.toLowerCase();
  const explicitTabOrder = explicitTabRequestOrder(selection, element);
  if (explicitTabOrder !== undefined) return explicitTabOrder;
  if (selection.intent.module === "personal" && selection.intent.action === "update_nickname") {
    if (/nickname_edit_button|昵称.*修改/i.test(text)) return 10;
    if (/nickname_input|昵称.*输入/i.test(text)) return 20;
    if (/nickname_confirm_button|确定按钮|confirm/i.test(text)) return 30;
  }
  if (selection.intent.module === "withdraw" && selection.intent.action === "add_withdraw_address") {
    if (/send_email_code|\u53d1\u9001.*\u90ae\u7bb1|\u83b7\u53d6.*\u9a8c\u8bc1\u7801/i.test(text)) return 86;
    if (/totp|ga|google|\u8c37\u6b4c/i.test(text)) return 88;
    if (/email_code|\u90ae\u7bb1.*\u9a8c\u8bc1\u7801/i.test(text)) return 90;
    if (/confirm_verification|\u5b89\u5168\u9a8c\u8bc1.*\u786e\u8ba4|\u786e\u5b9a/i.test(text)) return 92;
    if (/address_management_entry|open_address_management/i.test(text)) return 5;
    if (/add_address_button|open_add_address/i.test(text)) return 10;
    if (/internal_address_mode|address_type|\u7ad9\u5185\u5730\u5740|\u9875\u7b7e/i.test(text)) return 15;
    if (/add_address.*asset|asset_selector|\u5e01\u79cd/i.test(text)) return 20;
    if (/add_address.*network|network_selector|bsc|\u7f51\u7edc|\u94fe/i.test(text)) return 30;
    if (/add_address.*address|address_input|\u5730\u5740/i.test(text)) return 40;
    if (/add_address.*label|label_input|remark|\u6807\u7b7e|\u5907\u6ce8/i.test(text)) return 50;
    if (/save_button|save_withdraw_address|\u4fdd\u5b58/i.test(text)) return 80;
    if (/security|verification|email_code|totp|ga|\u9a8c\u8bc1/i.test(text)) return 90;
  }
  if (selection.intent.module === "red-packet") {
    if (/create-entry|create_entry|entry_button/i.test(text)) return 10;
    if (/red_packet_type|random|normal|\u62fc\u624b\u6c14|\u666e\u901a/i.test(text)) return 20;
    if (/asset|coin|\u5e01\u79cd|USDT/i.test(text)) return 30;
    if (/amount|\u53d1\u653e\u6570\u91cf|\u91d1\u989d/i.test(text)) return 40;
    if (/count|quantity|\u7ea2\u5305\u4e2a\u6570|\u4e2a\u6570/i.test(text)) return 50;
    if (/greeting|\u795d\u798f\u8bed/i.test(text)) return 60;
    if (/confirm_create|submit|\u786e\u8ba4\u521b\u5efa/i.test(text)) return 70;
    if (/switch_other_methods|\u4f7f\u7528\u5176\u4ed6\u9a8c\u8bc1\u65b9\u5f0f/i.test(text)) return 78;
    if (/send_email_code|\u83b7\u53d6\u9a8c\u8bc1\u7801/i.test(text)) return 80;
    if (/totp|ga|google|\u8c37\u6b4c/i.test(text)) return 82;
    if (/email_code|\u90ae\u7bb1.*\u9a8c\u8bc1\u7801/i.test(text)) return 84;
    if (/confirm_verification|\u5b89\u5168\u9a8c\u8bc1|\u786e\u5b9a/i.test(text)) return 86;
    if (/passphrase|\u53e3\u4ee4/i.test(text)) return 20;
    if (/claim_button|\u9886\u53d6/i.test(text)) return 30;
    if (/record_entry|\u8bb0\u5f55|\u660e\u7ec6/i.test(text)) return 20;
  }
  if (selection.intent.module === "asset" && (selection.intent.action === "earn_redeem" || selection.intent.action === "earn_subscribe")) {
    const targetField = inferTargetField(element);
    if (targetField === "amount") return 50;
    if (/product_type|活期|定期|tab/i.test(text)) return 10;
    if (/asset_selector|coin_selector|币种/i.test(text) && !/option|选项/i.test(text)) return 20;
    if (/asset_option|coin_option|option|选项/i.test(text)) return 30;
    if (/amount_input|redeem_amount|subscribe_amount|最小|数量|金额/i.test(text)) return 50;
    if (/confirm_button|确定|submit/i.test(text)) return 70;
    if (/redeem_button|赎回/i.test(text)) return 40;
    if (/subscribe_button|申购|购买/i.test(text)) return 40;
    if (/max_button|最大/i.test(text)) return 55;
  }
  if (isFundFlowFilterSelection(selection)) {
    if (/asset_filter|\u5e01\u79cd\u7b5b\u9009/i.test(text) && !/option|\u9009\u9879/i.test(text)) return 10;
    if (/asset_filter.*option|\u5e01\u79cd.*\u9009\u9879/i.test(text)) return 20;
    if (/product_type_filter|\u4ea7\u54c1\u7c7b\u578b/i.test(text) && !/option|\u9009\u9879/i.test(text)) return 30;
    if (/product_type_filter.*option|\u4ea7\u54c1\u7c7b\u578b.*\u9009\u9879/i.test(text)) return 40;
    if (/type_filter|record_type|\u4ea4\u6613\u7c7b\u578b|\u7c7b\u578b\u7b5b\u9009/i.test(text) && !/option|\u9009\u9879/i.test(text)) return 50;
    if (/type_filter.*option|record_type.*option|\u4ea4\u6613\u7c7b\u578b.*\u9009\u9879|\u7c7b\u578b.*\u9009\u9879/i.test(text)) return 60;
    if (/query_button|\u67e5\u8be2/i.test(text)) return 90;
    if (/reset_button|\u91cd\u7f6e/i.test(text)) return 100;
  }
  return 50;
}

function explicitTabRequestOrder(selection: PageModelEvidenceSelection, element: SelectedPageModelEvidence): number | undefined {
  if (element.controlType !== "tab" && !/\btab\b|标签|页签/i.test(`${element.id} ${element.semanticName ?? ""} ${element.role ?? ""}`)) return undefined;
  const record = element as unknown as Record<string, unknown>;
  const optionValue = String(element.optionValue ?? record.value ?? element.semanticName ?? "");
  const candidates = [optionValue, element.semanticName ?? element.id]
    .flatMap((value) => [value, value.replace(/理财产品|理财|产品|标签|页签/g, "")])
    .map(normalizeStepText)
    .filter(Boolean);
  const request = normalizeStepText(selection.request);
  const positions = candidates
    .map((candidate) => request.indexOf(candidate))
    .filter((index) => index >= 0);
  if (!positions.length) return undefined;
  return 10 + Math.min(...positions) / 1000;
}

function buildAssertionStep(selection: PageModelEvidenceSelection, evidence: SelectedPageModelEvidence, assertion: UserAssertionParseResult["assertions"][number]): DslStep & Record<string, unknown> {
  const expected = assertionExpectedTextsForEvidence(evidence, assertion);
  const dslAssertion = assertionDslFor(selection, evidence, assertion, expected);
  return baseStep({
    id: `assert-${safeId(assertion.id)}-${safeId(evidence.id)}`,
    action: "assert",
    semanticTarget: assertion.rawText,
    evidence,
    selection,
    extra: {
      pageModelId: evidence.pageId,
      assertionId: evidence.id,
      assertion: dslAssertion
    }
  });
}

function assertionExpectedTextsForEvidence(evidence: SelectedPageModelEvidence, assertion: UserAssertionParseResult["assertions"][number]): string[] {
  const userExpected = assertion.expectedTexts.length ? assertion.expectedTexts : [assertion.rawText].filter(Boolean);
  const evidenceCandidates = readStringArray(evidence.textCandidates);
  if (!evidenceCandidates.length || assertion.kind === "message_visible_exact") return userExpected;
  if (!shouldUseAssertionEvidenceTextCandidates(evidence, assertion)) return userExpected;
  return [...new Set([...evidenceCandidates, ...userExpected])];
}

function shouldUseAssertionEvidenceTextCandidates(evidence: SelectedPageModelEvidence, assertion: UserAssertionParseResult["assertions"][number]): boolean {
  if (assertion.kind === "result_empty" || assertion.kind.startsWith("table_column") || assertion.kind === "field_value") return false;
  if (isExactMessageAssertionEvidence(evidence) && /红包|口令|领取失败|错误|invalid|wrong/i.test(`${evidence.id} ${evidence.semanticName ?? ""} ${assertion.rawText}`)) return true;
  if (assertion.assertionIntent?.targetObject === "message") return false;
  if (evidence.kind !== "assertion") return false;
  return assertion.kind === "success_message" ||
    assertion.kind === "ui_text_visible" ||
    assertion.kind === "record_contains" ||
    assertion.kind === "record_or_empty_state" ||
    assertion.assertionIntent?.operator === "visible" ||
    assertion.assertionIntent?.operator === "success" ||
    assertion.targetConcepts.includes("success_message");
}

function isExactMessageAssertionEvidence(evidence: SelectedPageModelEvidence): boolean {
  return /api_message_exact|message_visible_exact/i.test(String(evidence.assertionType ?? ""));
}

function assertionDslFor(
  selection: PageModelEvidenceSelection,
  evidence: SelectedPageModelEvidence,
  assertion: UserAssertionParseResult["assertions"][number],
  expected: string[]
): Record<string, unknown> {
  if (assertion.kind === "control_state_readable") {
    const targetElement = targetElementForAssertion(selection, evidence);
    const locators = targetElement
      ? preferredMaterializedLocatorsForEvidence(targetElement)
        .map((locator) => materializeIntentPlaceholders(locator, selection))
        .filter((locator): locator is string => Boolean(locator))
      : preferredMaterializedLocatorsForEvidence(evidence)
        .map((locator) => materializeIntentPlaceholders(locator, selection))
        .filter((locator): locator is string => Boolean(locator));
    return {
      type: "control_state_readable",
      target: assertion.rawText,
      locator: locators[0],
      fallbackLocators: locators.slice(1),
      expected: "readable",
      stateAttributes: ["aria-checked", "data-state"],
      source: "user_explicit_control_state_readable_assertion",
      targetElementId: evidence.targetElementId ?? targetElement?.id,
      targetStateId: evidence.targetStateId,
      intent: assertion.assertionIntent
    };
  }
  if (assertion.kind === "element_absent") {
    const targetElement = targetElementForAssertion(selection, evidence);
    const locators = targetElement
      ? preferredMaterializedLocatorsForEvidence(targetElement)
        .map((locator) => materializeIntentPlaceholders(locator, selection))
        .filter((locator): locator is string => Boolean(locator))
      : preferredMaterializedLocatorsForEvidence(evidence)
        .map((locator) => materializeIntentPlaceholders(locator, selection))
        .filter((locator): locator is string => Boolean(locator));
    return {
      type: evidence.assertionType === "input_absent" ? "input_absent" : "element_absent",
      target: assertion.rawText,
      locator: locators[0],
      fallbackLocators: locators.slice(1),
      expected: "absent",
      source: "user_explicit_absence_assertion",
      targetElementId: evidence.targetElementId ?? targetElement?.id,
      targetStateId: evidence.targetStateId,
      intent: assertion.assertionIntent
    };
  }
  if (assertion.kind === "element_disabled" || assertion.kind === "element_enabled" || assertion.kind === "tab_active") {
    const targetElement = targetElementForAssertion(selection, evidence);
    const locators = targetElement
      ? preferredMaterializedLocatorsForEvidence(targetElement)
        .map((locator) => materializeIntentPlaceholders(locator, selection))
        .filter((locator): locator is string => Boolean(locator))
      : preferredMaterializedLocatorsForEvidence(evidence)
        .map((locator) => materializeIntentPlaceholders(locator, selection))
        .filter((locator): locator is string => Boolean(locator));
    return {
      type: assertion.kind === "tab_active" ? "element_enabled" : assertion.kind,
      target: assertion.rawText,
      locator: locators[0],
      fallbackLocators: locators.slice(1),
      expected: assertion.kind === "element_disabled" ? "disabled" : assertion.kind === "tab_active" ? "active" : "enabled",
      source: assertion.kind === "tab_active" ? "user_explicit_tab_active_assertion" : "user_explicit_control_state_assertion",
      targetElementId: evidence.targetElementId ?? targetElement?.id,
      targetStateId: evidence.targetStateId,
      intent: assertion.assertionIntent
    };
  }
  if (assertion.kind === "message_visible_exact") {
    return {
      type: "message_visible_exact",
      target: assertion.rawText,
      expected: expected[0] ?? assertion.assertionIntent?.expected ?? assertion.rawText,
      source: "user_explicit_assertion",
      observeWindowMs: 3_000,
      pollIntervalMs: 200,
      matchMode: "normalized_exact",
      intent: assertion.assertionIntent
    };
  }
  if (assertion.kind === "result_empty") {
    return {
      type: "result_empty",
      target: assertion.rawText,
      table: tableTargetForAssertionV2(selection, assertion),
      expected: "empty",
      emptyStateAccepted: true,
      intent: assertion.assertionIntent
    };
  }
  if (assertion.kind === "table_column_all_equal" || assertion.kind === "table_column_all_equal_or_empty") {
    return {
      type: assertion.kind,
      target: assertion.rawText,
      table: tableTargetForAssertionV2(selection, assertion),
      column: columnForAssertionV2(selection, assertion),
      semanticField: semanticFieldForAssertion(assertion),
      columnMapping: columnMappingForAssertion(selection, assertion),
      expected: expected[0] ?? assertion.rawText,
      emptyStateAccepted: assertion.kind === "table_column_all_equal_or_empty" || assertion.acceptsEmptyState,
      intent: assertion.assertionIntent
    };
  }
  if (assertion.kind === "table_column_date_between") {
    return {
      type: "table_column_date_between",
      target: assertion.rawText,
      table: tableTargetForAssertionV2(selection, assertion),
      column: columnForAssertionV2(selection, assertion),
      semanticField: semanticFieldForAssertion(assertion),
      columnMapping: columnMappingForAssertion(selection, assertion),
      expected: dateRangeForAssertion(assertion),
      emptyStateAccepted: false,
      intent: assertion.assertionIntent
    };
  }
  if (assertion.kind === "field_value") {
    return {
      type: "textVisibleAny",
      target: assertion.rawText,
      expected: expected.length ? expected : [assertion.assertionIntent?.expected ?? assertion.rawText],
      source: "user_explicit_field_state_assertion",
      intent: assertion.assertionIntent
    };
  }
  if ((assertion.kind === "ui_text_visible" || assertion.kind === "record_contains" || assertion.kind === "record_or_empty_state") && isExactMessageAssertionEvidence(evidence)) {
    return {
      type: "message_visible_exact",
      target: assertion.rawText,
      expected: expected[0] ?? assertion.rawText,
      source: "page_model_exact_message_assertion",
      observeWindowMs: 3_000,
      pollIntervalMs: 200,
      matchMode: "normalized_exact",
      intent: assertion.assertionIntent
    };
  }
  if (
    assertion.kind === "list_row_present" &&
    (evidence.assertionType === "element_enabled" ||
      assertion.assertionIntent?.operator === "enabled" ||
      /row_action|action_button|button|按钮|可点击|可用|enabled/i.test(`${evidence.id} ${evidence.semanticName ?? ""} ${assertion.rawText}`))
  ) {
    const targetElement = targetElementForAssertion(selection, evidence);
    const rowScopedLocator = rowScopedLocatorFrom(evidence, "", "row_scoped_assertion");
    const locators = [
      rowScopedLocator,
      ...(targetElement
        ? preferredMaterializedLocatorsForEvidence(targetElement)
        : preferredMaterializedLocatorsForEvidence(evidence))
    ]
      .map((locator) => materializeIntentPlaceholders(locator, selection))
      .filter((locator): locator is string => Boolean(locator));
    return {
      type: "element_enabled",
      target: assertion.rawText,
      locator: locators[0],
      fallbackLocators: locators.slice(1),
      expected: "enabled",
      source: "user_explicit_list_row_action_enabled_assertion",
      targetElementId: evidence.targetElementId ?? targetElement?.id,
      targetStateId: evidence.targetStateId,
      rowScope: evidence.rowScope,
      intent: assertion.assertionIntent
    };
  }
  if (assertion.kind === "ui_text_visible" || assertion.kind === "record_contains" || assertion.kind === "record_or_empty_state" || assertion.kind === "list_row_present") {
    return {
      type: "textVisibleAny",
      target: assertion.rawText,
      expected: expected.length ? expected : [assertion.rawText],
      source: "user_explicit_ui_visible_assertion",
      scopePageModelId: evidence.pageId,
      intent: assertion.assertionIntent
    };
  }
  return {
    type: "textVisibleAny",
    target: assertion.rawText,
    expected
  };
}

function shouldSuppressSuccessPolicyAssertion(userAssertions: UserAssertionParseResult, operationManualSelection?: PageOperationManualSelection): boolean {
  const hasNonTextSuccessEvidence = (operationManualSelection?.successEvidencePolicies ?? []).some((policy) => {
    const acceptedSignals = Array.isArray(policy.acceptedSignals) ? policy.acceptedSignals as Array<Record<string, unknown>> : [];
    return acceptedSignals.some((signal) => {
      const type = String(signal.type ?? "").toLowerCase();
      return type && !/toast|message|alert|notification|text/.test(type);
    });
  });
  if (hasNonTextSuccessEvidence) return false;
  return userAssertions.assertions.some((assertion) =>
    assertion.kind === "message_visible_exact" ||
    assertion.gaps.length > 0 ||
    assertion.assertionIntent?.source === "deepseek_intent"
  );
}

function tableTargetForAssertionV2(selection: PageModelEvidenceSelection, assertion: UserAssertionParseResult["assertions"][number]): string {
  const tableId = pageEvidenceForAssertion(selection, assertion)?.resultTable?.tableId;
  if (typeof tableId === "string" && tableId.trim()) return tableId;
  if (/\u7406\u8d22\u6d41\u6c34|\u7406\u8d22|earn/i.test(assertion.rawText)) return "earn_fund_flow.result_table";
  if (/\u5408\u7ea6\u6d41\u6c34|\u5408\u7ea6|contract|futures/i.test(assertion.rawText)) return "contract_fund_flow.result_table";
  if (/\u73b0\u8d27\u6d41\u6c34|\u8d44\u91d1\u6d41\u6c34|spot/i.test(assertion.rawText)) return "spot_fund_flow.result_table";
  return "result_table";
}

function columnForAssertionV2(selection: PageModelEvidenceSelection, assertion: UserAssertionParseResult["assertions"][number]): string {
  const mapping = columnMappingForAssertion(selection, assertion);
  if (mapping?.resultColumn) return mapping.resultColumn;
  if (assertion.assertionIntent?.field) return assertion.assertionIntent.field;
  if (/\u65f6\u95f4|\u65e5\u671f/.test(assertion.rawText)) return "\u65f6\u95f4";
  if (/\u4ea4\u6613\u7c7b\u578b/.test(assertion.rawText)) return "\u4ea4\u6613\u7c7b\u578b";
  if (/\u4ea7\u54c1\u7c7b\u578b/.test(assertion.rawText)) return "\u4ea7\u54c1\u7c7b\u578b";
  if (/\u7c7b\u578b/.test(assertion.rawText) || assertion.targetConcepts.some((item) => item.startsWith("type_value:"))) return "\u7c7b\u578b";
  return "\u6587\u672c";
}

function semanticFieldForAssertion(assertion: UserAssertionParseResult["assertions"][number]): string | undefined {
  const field = assertion.assertionIntent?.field;
  if (field && /\u65f6\u95f4|\u65e5\u671f|time|date/i.test(field)) return "time_range";
  if (field === "\u4ea4\u6613\u7c7b\u578b" || field === "\u7c7b\u578b") return "record_type";
  if (field === "\u4ea7\u54c1\u7c7b\u578b") return "product_type";
  return field;
}

function dateRangeForAssertion(assertion: UserAssertionParseResult["assertions"][number]): { start: string; end: string } {
  const source = assertion.assertionIntent?.expected ?? assertion.rawText;
  const matches = [...String(source).matchAll(/\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?/g)].map((match) => match[0].replace(/\//g, "-").replace(/\s+/g, " ").trim());
  if (matches.length >= 2) {
    return {
      start: normalizeDateTimeBoundary(matches[0], "start"),
      end: normalizeDateTimeBoundary(matches[1], "end")
    };
  }
  return { start: "", end: "" };
}

function normalizeDateTimeBoundary(value: string, boundary: "start" | "end"): string {
  if (/\d{1,2}:\d{2}/.test(value)) return value;
  return `${value} ${boundary === "start" ? "00:00:00" : "23:59:59"}`;
}

function columnMappingForAssertion(selection: PageModelEvidenceSelection, assertion: UserAssertionParseResult["assertions"][number]): { semanticField?: string; filterField?: string; resultColumn?: string; source?: string } | undefined {
  const semanticField = semanticFieldForAssertion(assertion);
  const model = pageEvidenceForAssertion(selection, assertion);
  const mappings = Array.isArray(model?.fieldMappings) ? model.fieldMappings : [];
  const found = mappings.find((item) =>
    (semanticField && item.semanticField === semanticField) ||
    (assertion.assertionIntent?.field && item.filterLabel === assertion.assertionIntent.field) ||
    (assertion.assertionIntent?.field && Array.isArray(item.aliases) && item.aliases.includes(assertion.assertionIntent.field))
  );
  if (!found) return undefined;
  return {
    semanticField: String(found.semanticField ?? semanticField ?? ""),
    filterField: typeof found.filterField === "string" ? found.filterField : undefined,
    resultColumn: typeof found.resultColumn === "string" ? found.resultColumn : undefined,
    source: typeof found.source === "string" ? found.source : "page_model"
  };
}

function pageEvidenceForAssertion(selection: PageModelEvidenceSelection, assertion: UserAssertionParseResult["assertions"][number]): SelectedPageModelEvidence | undefined {
  const targetPage = assertion.assertionIntent?.targetPage;
  const targetPageId = targetPage === "earn_fund_flow"
    ? "demo.funds.earn_fund_flow"
    : targetPage === "spot_fund_flow"
      ? "demo.funds.spot_fund_flow"
      : targetPage === "contract_fund_flow"
        ? "demo.funds.contract_fund_flow"
        : fundFlowTargetPageId(selection);
  return selection.selectedEvidence.find((item) => item.kind === "page" && item.pageId === targetPageId)
    ?? selection.selectedEvidence.find((item) => item.kind === "page");
}

function tableTargetForAssertion(assertion: UserAssertionParseResult["assertions"][number]): string {
  if (/\u7406\u8d22\u6d41\u6c34|\u7406\u8d22|earn/i.test(assertion.rawText)) return "earn_fund_flow.result_table";
  if (/现货流水|资金流水|spot/i.test(assertion.rawText)) return "spot_fund_flow.result_table";
  return "result_table";
}

function columnForAssertion(assertion: UserAssertionParseResult["assertions"][number]): string {
  if (/类型/.test(assertion.rawText) || assertion.targetConcepts.some((item) => item.startsWith("type_value:"))) return "类型";
  return "文本";
}

function baseStep(input: {
  id: string;
  action: string;
  semanticTarget: string;
  evidence: SelectedPageModelEvidence;
  selection?: PageModelEvidenceSelection;
  extra?: Record<string, unknown>;
}): DslStep & Record<string, unknown> {
  const extra = input.extra ?? {};
  return {
    id: input.id,
    action: input.action,
    semantic_target: input.semanticTarget,
    allow_healing: true,
    max_healing_level: 1,
    collect_snapshot: true,
    timeout_ms: 15_000,
    pageId: input.evidence.pageId,
    evidenceId: input.evidence.id,
    evidenceStatus: input.evidence.status,
    confidence: input.evidence.confidence,
    readiness: input.evidence.status === "candidate" ? "candidate" : "evidence_backed",
    source: "page_model",
    evidence: input.evidence.evidence,
    explain: buildStepExplain(input.selection, input.evidence, input.action, input.semanticTarget, extra),
    ...extra
  };
}

function buildStepExplain(
  selection: PageModelEvidenceSelection | undefined,
  evidence: SelectedPageModelEvidence,
  action: string,
  semanticTarget: string,
  extra: Record<string, unknown>
): Record<string, unknown> {
  return {
    schemaVersion: "step-explain.v1",
    source: "page_model_materialization",
    intent: selection
      ? {
        module: selection.intent.module,
        action: selection.intent.action,
        operationType: selection.intent.operationType,
    targetPageId: (selection.intent as unknown as Record<string, unknown>).targetPageId,
        data: selection.intent.data
      }
      : undefined,
    selectedAction: action,
    semanticTarget,
    pageModelId: extra.pageModelId ?? evidence.pageId,
    evidenceId: evidence.id,
    evidenceKind: evidence.kind,
    evidenceRole: evidence.evidenceRole ?? evidence.role,
    semanticName: evidence.semanticName,
    targetField: extra.targetField,
    elementId: extra.elementId,
    assertionId: extra.assertionId,
    providerRequirementId: extra.providerRequirementId,
    confidence: evidence.confidence,
    readiness: evidence.status === "candidate" ? "candidate" : "evidence_backed",
    locatorSource: extra.primary_locator || extra.target ? "page_model" : undefined,
    valueSource: extra.valueSource,
    dataBinding: extra.dataBinding,
    reason: evidence.reason ?? "Selected from bounded Page Model evidence and materialized by local DSL builder."
  };
}

function inferAction(selection: PageModelEvidenceSelection, element: SelectedPageModelEvidence): string {
  const text = `${element.id} ${element.semanticName ?? ""}`;
  const normalizedText = normalizeStepText(text);
  const role = `${element.role ?? ""}`.toLowerCase();
  const targetField = inferTargetField(element);
  if (targetField === "send_email_code" || targetField === "confirm_verification") return "click";
  if (targetField === "email_code" || targetField === "totp" || targetField === "sms_code" || targetField === "verification_code") return "input";
  if (targetField === "time_range" && valueForTargetField(selection, targetField) !== undefined) return "setDateRange";
  if (element.controlType === "dropdown" && targetField && valueForTargetField(selection, targetField) !== undefined) return "select";
  if (element.controlType === "tab" || /tab/.test(role)) return "click";
  if (isFundFlowFilterSelection(selection)) {
    if (/type_filter|record_type|product_type|asset_filter|time_filter|option|query_button|reset_button/i.test(text)) return "click";
    if (
      normalizedText.includes("\u7c7b\u578b\u7b5b\u9009") ||
      normalizedText.includes("\u4ea4\u6613\u7c7b\u578b") ||
      normalizedText.includes("\u4ea7\u54c1\u7c7b\u578b") ||
      normalizedText.includes("\u5e01\u79cd\u7b5b\u9009") ||
      normalizedText.includes("\u65f6\u95f4") ||
      normalizedText.includes("\u9009\u9879") ||
      normalizedText.includes("\u67e5\u8be2") ||
      normalizedText.includes("\u91cd\u7f6e")
    ) {
      return "click";
    }
  }
  if (/option/.test(role)) return "click";
  if (/filter|selector|combobox/.test(role)) return "click";
  if (/button|link/.test(role)) return "click";
  if (/table|list|row|empty|pagination/.test(role)) return "wait";
  if (/数量|金额|输入框|地址|验证码/.test(text)) return "input";
  if (/筛选|选项|账户|币种|链|网络/.test(text)) return "click";
  if (/按钮|入口|提交|确认|确定|下一步|提现|划转|查询|申购|赎回|购买/.test(text)) return "click";
  if (/列表|记录|表格|行/.test(text)) return "wait";
  if (/amount|数量|输入框|地址|验证码/i.test(text)) return "input";
  if (/selector|filter|option|筛选|选项|账户|币种|链/i.test(text)) return "click";
  if (/button|按钮|入口|query|submit|提交|查询|划转|申购|赎回|购买/i.test(text)) return "click";
  if (/list|table|row|列表|记录/i.test(text)) return "wait";
  return "wait";
}

function componentForEvidence(element: SelectedPageModelEvidence, targetField?: string): Record<string, unknown> | undefined {
  if (element.controlType !== "dropdown") return undefined;
  const dropdown = (element as unknown as Record<string, any>).dropdown && typeof (element as unknown as Record<string, any>).dropdown === "object"
    ? (element as unknown as Record<string, any>).dropdown as Record<string, unknown>
    : {};
  const optionInventory = readStringArray(dropdown.optionInventory ?? dropdown.option_inventory);
  const verifiedOptions = readStringArray(dropdown.verifiedOptions ?? dropdown.verified_options);
  const sampledOptions = readStringArray(dropdown.sampledOptions ?? dropdown.sampled_options);
  const optionDiscoveryMode = dropdown.optionDiscoveryMode ?? dropdown.option_discovery_mode ?? (optionInventory.length ? "static_visible" : "unknown");
  const coverageMode = dropdown.coverageMode ?? dropdown.coverage_mode ?? (optionInventory.length ? "complete" : "unknown");
  const selectedValueSignal = dropdown.selectedValueSignal ??
    dropdown.selected_value_signal ??
    dropdown.valuePersistenceSignal ??
    dropdown.value_persistence_signal;
  return {
    type: "dropdown",
    semanticName: element.semanticName,
    region: element.region,
    targetField,
    optionDiscoveryMode,
    popupScope: dropdown.popupScope ?? dropdown.popup_scope,
    triggerCandidates: Array.isArray(dropdown.trigger) ? dropdown.trigger : undefined,
    currentValue: dropdown.currentValue ?? dropdown.current_value,
    searchInput: dropdown.searchInput ?? dropdown.search_input ?? dropdown.searchInputLocator ?? dropdown.search_input_locator,
    optionInventory: optionInventory.length ? optionInventory : undefined,
    sampledOptions: sampledOptions.length ? sampledOptions : undefined,
    verifiedOptions: verifiedOptions.length ? verifiedOptions : undefined,
    valueAliases: dropdown.valueAliases,
    coverageMode,
    selectionAction: dropdown.selectionAction ?? dropdown.selection_action,
    selectedValueSignal,
    valuePersistenceSignal: dropdown.valuePersistenceSignal ?? dropdown.value_persistence_signal,
    readinessSignals: readStringArray(dropdown.readinessSignals ?? dropdown.readiness_signals)
  };
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item).trim()).filter(Boolean);
}

function dslComponentContractGaps(steps: DslStep[]): string[] {
  const gaps: string[] = [];
  for (const step of steps as Array<DslStep & Record<string, unknown>>) {
    if (isProviderVerificationStep(step)) {
      const elementId = String(step.elementId ?? step.id ?? "unknown");
      const locators = [step.primary_locator, step.primaryLocator, step.target, ...(Array.isArray(step.fallback_locators) ? step.fallback_locators : [])]
        .filter((locator): locator is string => typeof locator === "string" && locator.trim().length > 0);
      if (step.readiness === "candidate" || step.evidenceStatus === "candidate") {
        gaps.push(`provider_component_candidate_not_executable:${elementId}`);
      }
      if (!locators.length || locators.some(isPlaceholderProviderLocator)) {
        gaps.push(`provider_component_missing_executable_locator:${elementId}`);
      }
      continue;
    }
    if (step.action !== "select") continue;
    const component = step.component && typeof step.component === "object" ? step.component as Record<string, unknown> : {};
    if (component.type !== "dropdown") continue;
    const mode = String(component.optionDiscoveryMode ?? "unknown").toLowerCase();
    const coverageMode = String(component.coverageMode ?? "complete").toLowerCase();
    const optionInventory = readStringArray(component.optionInventory);
    const verifiedOptions = readStringArray(component.verifiedOptions);
    const hasDynamicDiscovery = /searchable|dynamic|remote|virtualized/.test(mode) && Boolean(component.searchInput);
    const hasStaticDiscovery = optionInventory.length > 0 || (/static_visible/.test(mode) && optionInventory.length > 0);
    const hasSelectedValueSignal = Boolean(component.selectedValueSignal || component.valuePersistenceSignal);
    const expected = step.value === undefined ? undefined : String(step.value);
    const currentValue = component.currentValue === undefined ? undefined : String(component.currentValue);
    if (!hasStaticDiscovery && !hasDynamicDiscovery) {
      gaps.push(`dropdown_component_missing_option_discovery:${String(step.elementId ?? step.id ?? "unknown")}`);
    }
    if (expected) {
      const normalizedExpected = normalizeStepText(expected);
      const inventoryHasExpected = optionInventory.map(normalizeStepText).includes(normalizedExpected);
      const verifiedHasExpected = verifiedOptions.map(normalizeStepText).includes(normalizedExpected);
      const currentValueHasExpected = currentValue !== undefined && normalizeStepText(currentValue) === normalizedExpected;
      if (verifiedOptions.length > 0 && !verifiedHasExpected && !currentValueHasExpected) {
        gaps.push(`dropdown_component_target_option_not_verified:${String(step.elementId ?? step.id ?? "unknown")}:${expected}`);
      } else if (optionInventory.length > 0 && !inventoryHasExpected) {
        const gapCode = hasDynamicDiscovery && /sampled|targeted_verified|unknown/.test(coverageMode)
          ? "dropdown_component_target_option_not_verified"
          : "dropdown_component_option_not_modeled";
        gaps.push(`${gapCode}:${String(step.elementId ?? step.id ?? "unknown")}:${expected}`);
      }
    }
    if (!hasSelectedValueSignal) {
      gaps.push(`dropdown_component_missing_selected_value_signal:${String(step.elementId ?? step.id ?? "unknown")}`);
    }
  }
  return gaps;
}

function isProviderVerificationStep(step: DslStep & Record<string, unknown>): boolean {
  if (step.action === "assert") return false;
  const text = `${step.id ?? ""} ${step.semantic_target ?? step.semanticTarget ?? ""} ${step.targetField ?? ""} ${step.providerRequirementId ?? ""}`;
  return /provider|verification|email_code|sms_code|totp|send_email_code|confirm_verification|\u9a8c\u8bc1\u7801|\u5b89\u5168\u9a8c\u8bc1/i.test(text);
}

function isPlaceholderProviderLocator(locator: string): boolean {
  return /^(?:text=)?(?:security modal field|modal field near|provider field|verification field)\b/i.test(locator.trim());
}

function validateStructuredDslTargets(steps: DslStep[], selection: PageModelEvidenceSelection): PageModelDslBuildResult["dslValidation"] {
  const checkedRules = [
    "action_enum",
    "navigate_requires_page_ref",
    "element_action_requires_element_ref",
    "assert_requires_assertion_contract",
    "provider_credential_requires_requirement_ref",
    "locator_must_be_supported",
    "no_invented_selector_without_model_ref"
  ];
  const supportedActions = new Set(["navigate", "click", "input", "select", "setDateRange", "wait", "assert", "fail"]);
  const authorizedIds = new Set([
    ...selection.selectedEvidence.map((item) => item.id),
    ...selection.selectedEvidence.map((item) => item.pageId).filter((item): item is string => Boolean(item)),
    ...selection.fallbackEvidence.map((item) => item.id),
    ...selection.fallbackEvidence.map((item) => item.pageId).filter((item): item is string => Boolean(item))
  ]);
  const missingTargetRefs: string[] = [];
  const unsupportedLocators: string[] = [];
  const inventedSelectors: string[] = [];
  const contractGaps: string[] = [];
  const stepResults: PageModelDslBuildResult["dslValidation"]["stepResults"] = [];
  for (const step of steps as Array<DslStep & Record<string, unknown>>) {
    const stepId = String(step.id ?? "unknown");
    const stepGaps: string[] = [];
    if (!supportedActions.has(String(step.action))) stepGaps.push("unsupported_action");
    if (step.action === "navigate") {
      if (!step.pageModelId && !step.target) stepGaps.push("navigate_missing_page_or_target");
    }
    if (step.action === "assert") {
      if (!step.assertion || typeof step.assertion !== "object") stepGaps.push("assertion_contract_missing");
      if (!step.assertionId && !step.evidenceId && !step.pageModelId) stepGaps.push("assertion_missing_model_ref");
      stepResults.push({
        stepId,
        action: String(step.action),
        passed: stepGaps.length === 0,
        gaps: stepGaps,
        pageModelId: stringOrUndefined(step.pageModelId),
        assertionId: stringOrUndefined(step.assertionId),
        evidenceId: stringOrUndefined(step.evidenceId)
      });
      contractGaps.push(...stepGaps.map((gap) => `${gap}:${stepId}`));
      continue;
    }
    const targetRef = String(step.targetElementId ?? step.elementId ?? step.evidenceId ?? "");
    if (!targetRef || !authorizedIds.has(targetRef)) {
      missingTargetRefs.push(stepId);
      stepGaps.push("missing_authorized_target_ref");
    }
    if (step.valueFrom && typeof step.valueFrom === "object" && String((step.valueFrom as Record<string, unknown>).type ?? "") === "verificationCredential" && !step.providerRequirementId) {
      stepGaps.push("provider_requirement_ref_missing");
    }
    for (const locator of [step.primary_locator, step.primaryLocator, step.target, ...(Array.isArray(step.fallback_locators) ? step.fallback_locators : [])]) {
      if (typeof locator !== "string" || !locator.trim()) continue;
      if (/^role=[^:]+:.*>>/.test(locator) || /^role=[^:]+:[^ ]*\|/.test(locator) || /^modal\s*>>/.test(locator)) {
        unsupportedLocators.push(locator);
        stepGaps.push("unsupported_locator");
      }
      if (!targetRef && /^(css=|xpath=|text=|role=|\[|\.|#|\/\/)/.test(locator)) inventedSelectors.push(locator);
    }
    stepResults.push({
      stepId,
      action: String(step.action),
      passed: stepGaps.length === 0,
      gaps: [...new Set(stepGaps)],
      pageModelId: stringOrUndefined(step.pageModelId),
      elementId: stringOrUndefined(step.elementId ?? step.targetElementId),
      evidenceId: stringOrUndefined(step.evidenceId),
      providerRequirementId: stringOrUndefined(step.providerRequirementId)
    });
    contractGaps.push(...stepGaps.map((gap) => `${gap}:${stepId}`));
  }
  return {
    contractVersion: "automation-dsl-contract.v1",
    passed: missingTargetRefs.length === 0 && unsupportedLocators.length === 0 && inventedSelectors.length === 0 && contractGaps.length === 0,
    checkedRules,
    contractGaps: [...new Set(contractGaps)],
    stepResults,
    missingTargetRefs: [...new Set(missingTargetRefs)],
    unsupportedLocators: [...new Set(unsupportedLocators)],
    inventedSelectors: [...new Set(inventedSelectors)]
  };
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function postconditionsForEvidence(selection: PageModelEvidenceSelection, element: SelectedPageModelEvidence, targetField: string | undefined, value: unknown): Array<Record<string, unknown>> | undefined {
  const postconditions: Array<Record<string, unknown>> = [];
  if (element.controlType === "dropdown" && targetField && value !== undefined) {
    postconditions.push({
      id: `${targetField}.selected_value_equals`,
      type: "selectedValueEquals",
      targetField,
      expected: String(value),
      source: "page_model_component_contract"
    });
  }
  const actionPostconditions = Array.isArray(element.actionPostconditions) ? element.actionPostconditions : [];
  for (const postcondition of actionPostconditions) {
    const built = actionPostconditionForStep(selection, postcondition);
    if (built) postconditions.push(built);
  }
  return postconditions.length ? postconditions : undefined;
}

function actionPostconditionForStep(selection: PageModelEvidenceSelection, postcondition: Record<string, unknown>): Record<string, unknown> | undefined {
  const assertionId = typeof postcondition.assertionId === "string" ? postcondition.assertionId : undefined;
  if (!assertionId) return undefined;
  const assertionEvidence = assertionEvidenceForSelection(selection).find((item) => item.id === assertionId);
  if (!assertionEvidence) return undefined;
  const type = String(postcondition.type ?? "");
  const expectedTexts = readStringArray(assertionEvidence.textCandidates);
  if (type === "textVisibleAny" || type === "resultVisible" || type === "pageStateVisible") {
    const expected = expectedTexts.length ? expectedTexts : expectedTextsFromAssertionCandidates(assertionEvidence);
    if (!expected.length) return undefined;
    return {
      id: `${postcondition.actionId ?? "action"}.${assertionId}`,
      type,
      assertionId,
      assertion: { type: "textVisibleAny", expected, source: "page_model_action_postcondition" }
    };
  }
  if (type === "modalVisible" || type === "messageVisible") {
    const expected = expectedTexts.length ? expectedTexts : [assertionEvidence.semanticName ?? assertionId].filter(Boolean) as string[];
    return {
      id: `${postcondition.actionId ?? "action"}.${assertionId}`,
      type,
      assertionId,
      assertion: type === "messageVisible"
        ? { type: "message_visible_exact", expected: expected[0], source: "page_model_action_postcondition" }
        : { type: "textVisibleAny", expected, source: "page_model_action_postcondition" }
    };
  }
  if (type === "elementEnabled" || type === "elementDisabled") {
    const targetElement = targetElementForAssertion(selection, assertionEvidence);
    const locators = targetElement
      ? preferredMaterializedLocatorsForEvidence(targetElement)
        .map((locator) => materializeIntentPlaceholders(locator, selection))
        .filter((locator): locator is string => Boolean(locator))
      : [];
    if (!locators.length) return undefined;
    return {
      id: `${postcondition.actionId ?? "action"}.${assertionId}`,
      type,
      assertionId,
      assertion: {
        type: type === "elementEnabled" ? "element_enabled" : "element_disabled",
        locator: locators[0],
        fallbackLocators: locators.slice(1),
        expected: type === "elementEnabled" ? "enabled" : "disabled",
        source: "page_model_action_postcondition",
        targetElementId: assertionEvidence.targetElementId
      }
    };
  }
  if (type === "fieldValueUpdated") {
    const expected = typeof valueForTargetField(selection, String(assertionEvidence.targetElementId ?? "nickname")) === "string"
      ? String(valueForTargetField(selection, "nickname"))
      : materializeIntentPlaceholders(expectedTexts[0], selection);
    if (!expected) return undefined;
    return {
      id: `${postcondition.actionId ?? "action"}.${assertionId}`,
      type,
      assertionId,
      assertion: { type: "textVisibleAny", expected: [expected], source: "page_model_action_postcondition" }
    };
  }
  return undefined;
}

function expectedTextsFromAssertionCandidates(assertionEvidence: SelectedPageModelEvidence): string[] {
  const candidates = (assertionEvidence as SelectedPageModelEvidence & { candidates?: unknown[] }).candidates;
  return (Array.isArray(candidates) ? candidates : [])
    .flatMap((candidate) => {
      if (!candidate || typeof candidate !== "object") return [];
      const expected = (candidate as Record<string, unknown>).expected;
      return readStringArray(expected);
    })
    .filter(Boolean);
}

function dataBindingFor(selection: PageModelEvidenceSelection, element: SelectedPageModelEvidence): Record<string, unknown> | undefined {
  if (!isFundFlowFilterSelection(selection)) return undefined;
  const targetField = inferTargetField(element);
  if (!targetField) return undefined;
  if (targetField === "action") return undefined;
  const intentField = intentFieldForTarget(targetField);
  const expectedValue = valueForTargetField(selection, targetField);
  if (expectedValue === undefined) {
    return { intentField, targetField, validation: "field_not_requested" };
  }
  const optionValue = inferOptionValue(element, targetField);
  const validation = optionValue === undefined || normalizeStepText(String(optionValue)) === normalizeStepText(String(expectedValue))
    ? "matched"
    : "value_mismatch";
  return {
    intentField,
    targetField,
    expectedValue,
    selectedOptionValue: optionValue,
    validation
  };
}

function valueFor(selection: PageModelEvidenceSelection, element: SelectedPageModelEvidence): unknown {
  const targetField = inferTargetField(element);
  if (targetField) return valueForTargetField(selection, targetField);
  const text = `${element.id} ${element.semanticName ?? ""}`;
  if (isFundFlowFilterSelection(selection) && /product_type_filter|\u4ea7\u54c1\u7c7b\u578b/.test(text)) {
    return selection.intent.data.productType;
  }
  if (isFundFlowFilterSelection(selection) && /type_filter|record_type|option|\u4ea4\u6613\u7c7b\u578b|\u7c7b\u578b\u7b5b\u9009|\u9009\u9879/.test(text)) {
    return selection.intent.data.type;
  }
  if (/USDT|币种/.test(text)) return selection.intent.data.asset;
  if (/BSC|链|网络/.test(text)) return selection.intent.data.network;
  if (/地址/.test(text)) return selection.intent.data.address;
  if (/数量|金额/.test(text)) return selection.intent.data.amount ?? selection.intent.data.amountPolicy;
  if (/转出/.test(text)) return selection.intent.data.fromAccount;
  if (/转入/.test(text)) return selection.intent.data.toAccount;
  if (/赠币|gift/i.test(text)) return selection.intent.data.type;
  if (/USDT|币种|asset/i.test(text)) return selection.intent.data.asset;
  if (/BSC|链|network/i.test(text)) return selection.intent.data.network;
  if (/UID|uid|internal/i.test(text)) return selection.intent.data.uid ?? selection.intent.data.internalUid;
  if (/地址|address/i.test(text)) return selection.intent.data.address;
  if (/数量|amount/i.test(text)) return selection.intent.data.amount ?? selection.intent.data.amountPolicy;
  if (/转出|from/i.test(text)) return selection.intent.data.fromAccount;
  if (/转入|to/i.test(text)) return selection.intent.data.toAccount;
  return undefined;
}

function valueSourceFor(selection: PageModelEvidenceSelection, element: SelectedPageModelEvidence): string | undefined {
  const targetField = inferTargetField(element);
  if (targetField) return `intent.data.${intentFieldForTarget(targetField)}`;
  const text = `${element.id} ${element.semanticName ?? ""}`;
  if (isFundFlowFilterSelection(selection) && /product_type_filter|\u4ea7\u54c1\u7c7b\u578b/.test(text)) {
    return "intent.data.productType";
  }
  if (isFundFlowFilterSelection(selection) && /type_filter|record_type|option|\u4ea4\u6613\u7c7b\u578b|\u7c7b\u578b\u7b5b\u9009|\u9009\u9879/.test(text)) {
    return "intent.data.type";
  }
  if (/USDT|币种/.test(text)) return "intent.data.asset";
  if (/BSC|链|网络/.test(text)) return "intent.data.network";
  if (/地址/.test(text)) return "intent.data.address";
  if (/数量|金额/.test(text)) return selection.intent.data.amount === undefined ? "intent.data.amountPolicy" : "intent.data.amount";
  if (/转出/.test(text)) return "intent.data.fromAccount";
  if (/转入/.test(text)) return "intent.data.toAccount";
  if (/赠币|gift/i.test(text)) return "intent.data.type";
  if (/USDT|币种|asset/i.test(text)) return "intent.data.asset";
  if (/BSC|链|network/i.test(text)) return "intent.data.network";
  if (/UID|uid|internal/i.test(text)) return "intent.data.uid";
  if (/地址|address/i.test(text)) return "intent.data.address";
  if (/数量|amount/i.test(text)) return selection.intent.data.amount === undefined ? "intent.data.amountPolicy" : "intent.data.amount";
  if (/转出|from/i.test(text)) return "intent.data.fromAccount";
  if (/转入|to/i.test(text)) return "intent.data.toAccount";
  return undefined;
}

function valueForTargetField(selection: PageModelEvidenceSelection, targetField: string): unknown {
  if (targetField === "asset") return selection.intent.data.asset;
  if (targetField === "record_type") return normalizeProjectRecordTypeAlias(selection, selection.intent.data.recordType ?? selection.intent.data.type);
  if (targetField === "product_type") return selection.intent.data.productType;
  if (targetField === "time_range") return selection.intent.data.timeRange;
  if (targetField === "status") return selection.intent.data.status;
  if (targetField === "network") return selection.intent.data.network;
  if (targetField === "address") return selection.intent.data.address;
  if (targetField === "uid" || targetField === "internal_uid") return selection.intent.data.uidPolicy === "empty" ? "" : selection.intent.data.uid ?? selection.intent.data.internalUid;
  if (targetField === "address_type") return selection.intent.data.addressType;
  if (targetField === "amount") return selection.intent.data.amountPolicy === "empty" ? "" : selection.intent.data.amount ?? selection.intent.data.amountPolicy;
  if (targetField === "count" || targetField === "quantity") return selection.intent.data.count ?? selection.intent.data.quantity;
  if (targetField === "red_packet_type") return selection.intent.data.redPacketType;
  if (targetField === "greeting") return selection.intent.data.greeting;
  if (targetField === "passphrase") return selection.intent.data.passphrase;
  if (targetField === "label") return selection.intent.data.label;
  if (targetField === "nickname") return selection.intent.data.nickname ?? generatedNicknameValue(selection);
  return undefined;
}

function normalizeProjectRecordTypeAlias(selection: PageModelEvidenceSelection, value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  const modeledAlias = normalizeFieldValueAlias(selection, "record_type", trimmed);
  if (modeledAlias) return modeledAlias;
  if (selection.intent.project === "demo" && selection.intent.action === "earn_fund_flow_filter" && trimmed === "\u8d4e\u56de") {
    return "\u672c\u91d1\u53ca\u6536\u76ca\u8fd4\u8fd8";
  }
  return trimmed || value;
}

function normalizeFieldValueAlias(selection: PageModelEvidenceSelection, semanticField: string, value: string): string | undefined {
  const normalizedValue = normalizeStepText(value);
  const mappings = selection.selectedEvidence
    .filter((item) => item.kind === "page")
    .flatMap((item) => Array.isArray((item as unknown as Record<string, unknown>).fieldMappings) ? (item as unknown as Record<string, any>).fieldMappings as Array<Record<string, unknown>> : [])
    .filter((item) => (item.semanticField ?? item.targetField) === semanticField);
  for (const mapping of mappings) {
    const verifiedOptions = readStringArray(mapping.verifiedOptions ?? mapping.options);
    const optionSet = new Set(verifiedOptions.map(normalizeStepText));
    const aliases = mapping.valueAliases;
    if (!aliases || typeof aliases !== "object" || Array.isArray(aliases)) continue;
    for (const [canonical, rawAliases] of Object.entries(aliases as Record<string, unknown>)) {
      const candidates = readStringArray([canonical, ...readStringArray(rawAliases)]);
      if (!candidates.map(normalizeStepText).includes(normalizedValue)) continue;
      if (optionSet.has(normalizeStepText(canonical))) return canonical;
      const verifiedAlias = candidates.find((candidate) => optionSet.has(normalizeStepText(candidate)));
      if (verifiedAlias) return verifiedAlias;
    }
  }
  return undefined;
}

function generatedNicknameValue(selection: PageModelEvidenceSelection): string | undefined {
  if (selection.intent.data.nicknamePolicy !== "generate_valid_changed_value") return undefined;
  const cached = generatedValueCache.get(selection)?.nickname;
  if (cached) return cached;
  const value = `Nick${String(Date.now() % 1000000).padStart(6, "0")}`;
  const next = { ...(generatedValueCache.get(selection) ?? {}), nickname: value };
  generatedValueCache.set(selection, next);
  return value;
}

function verificationCredentialTypeForElement(element: SelectedPageModelEvidence, targetField?: string): "email_code" | "totp" | "sms_code" | undefined {
  const text = `${element.id} ${element.semanticName ?? ""} ${element.semanticRole ?? ""} ${targetField ?? ""}`;
  if (/send_email_code|confirm_verification/i.test(targetField ?? "")) return undefined;
  if (/totp|google|ga|谷歌/i.test(text)) return "totp";
  if (/email|邮箱/i.test(text)) return "email_code";
  if (/sms|phone|手机|短信/i.test(text)) return "sms_code";
  return undefined;
}

function providerRequirementIdFor(selection: PageModelEvidenceSelection, credentialType: "email_code" | "totp" | "sms_code"): string | undefined {
  const provider = selection.evidenceBuckets.providers.find((item) => item.kind === "provider" && (() => {
    const text = `${item.id} ${item.semanticName ?? ""} ${item.provider ?? ""} ${item.codeType ?? ""}`;
    if (credentialType === "totp") return /totp|keepassxc|google|ga/i.test(text);
    if (credentialType === "email_code") return /email|redis/i.test(text);
    return /sms|phone/i.test(text);
  })());
  return provider?.providerRequirementId ?? provider?.id;
}

function providerSceneFor(selection: PageModelEvidenceSelection, credentialType: "email_code" | "totp" | "sms_code"): string | undefined {
  const provider = selection.evidenceBuckets.providers.find((item) => item.kind === "provider" && (() => {
    const text = `${item.id} ${item.semanticName ?? ""} ${item.provider ?? ""} ${item.codeType ?? ""}`;
    if (credentialType === "totp") return /totp|keepassxc|google|ga/i.test(text);
    if (credentialType === "email_code") return /email|redis/i.test(text);
    return /sms|phone/i.test(text);
  })());
  return provider?.scene;
}

function intentFieldForTarget(targetField: string): string {
  if (targetField === "record_type") return "recordType";
  if (targetField === "product_type") return "productType";
  if (targetField === "time_range") return "timeRange";
  if (targetField === "red_packet_type") return "redPacketType";
  return targetField;
}

function inferTargetField(element: SelectedPageModelEvidence): string | undefined {
  if (element.targetField) return normalizeTargetField(element.targetField);
  const text = `${element.id} ${element.semanticName ?? ""} ${element.parentElementId ?? ""} ${element.semanticRole ?? ""}`.toLowerCase();
  if (/button|open_modal|open_secondary|submit_or_confirm|action_button|query|reset|save_button/i.test(`${element.role ?? ""} ${element.controlType ?? ""} ${element.semanticRole ?? ""} ${element.id}`)) return "action";
  if (/red_packet_type|packet_type|\u62fc\u624b\u6c14\u7ea2\u5305|\u666e\u901a\u7ea2\u5305/i.test(text)) return "red_packet_type";
  if (/red_packet_count|packet_count|\u7ea2\u5305\u4e2a\u6570|\u4e2a\u6570/i.test(text)) return "count";
  if (/red_packet_passphrase|passphrase|\u7ea2\u5305\u53e3\u4ee4|\u53e3\u4ee4/i.test(text)) return "passphrase";
  if (/greeting|\u795d\u798f\u8bed/i.test(text)) return "greeting";
  if (/product_type|\u4ea7\u54c1\u7c7b\u578b|\u6d3b\u671f\u7406\u8d22|\u5b9a\u671f\u7406\u8d22/i.test(text)) return "product_type";
  if (/type_filter|record_type|gift_coin|red_packet|deposit|withdraw|transfer|\u7c7b\u578b|\u8d60\u5e01|\u7ea2\u5305|\u5145\u503c|\u63d0\u73b0|\u5212\u8f6c/i.test(text)) return "record_type";
  if (/asset_filter|\u5e01\u79cd|currency_filter|currency|asset|symbol/i.test(text)) return "asset";
  if (/uid|UID|\u7ad9\u5185.*\u5730\u5740/i.test(text)) return "uid";
  if (/address_type|withdraw_mode|\u94fe\u4e0a\u5730\u5740|\u7ad9\u5185\u5730\u5740|\u7ad9\u5185/i.test(text)) return "address_type";
  if (/time_filter|\u65f6\u95f4|\u65e5\u671f|date/i.test(text)) return "time_range";
  if (/status|\u72b6\u6001/i.test(text)) return "status";
  return undefined;
}

function inferOptionValue(element: SelectedPageModelEvidence, targetField: string): string | undefined {
  if (element.optionValue) return String(element.optionValue);
  const idMatch = element.id.match(/\.option\.([^.\s]+)$/i)?.[1];
  if (idMatch) return /^[a-z0-9]+$/i.test(idMatch) ? idMatch.toUpperCase() : idMatch;
  const nameMatch = `${element.semanticName ?? ""}`.match(/[:\uff1a]\s*([^:：]+)$/)?.[1]?.trim();
  if (nameMatch) return nameMatch;
  if (targetField === "asset") return `${element.id} ${element.semanticName ?? ""}`.match(/\b[A-Z0-9]{2,12}\b/)?.[0];
  return undefined;
}

function normalizeTargetField(value: string): string {
  const normalized = value.toLowerCase();
  if (["currency", "coin", "symbol"].includes(normalized)) return "asset";
  if (["redpackettype", "red_packet_type", "packettype", "packet_type"].includes(normalized)) return "red_packet_type";
  if (["count", "quantity", "redpacketcount", "red_packet_count"].includes(normalized)) return "count";
  if (["passphrase", "redpacketpassphrase", "red_packet_passphrase", "packetcode", "packet_code"].includes(normalized)) return "passphrase";
  if (["greeting", "blessing", "message"].includes(normalized)) return "greeting";
  if (["type", "recordtype", "record_type"].includes(normalized)) return "record_type";
  if (["producttype", "product_type", "product"].includes(normalized)) return "product_type";
  if (["time", "date", "timerange", "time_range", "date_range"].includes(normalized)) return "time_range";
  if (["chain"].includes(normalized)) return "network";
  if (["mode", "addressmode", "address_mode", "addresstype", "address_type", "withdrawmode", "withdraw_mode"].includes(normalized)) return "address_type";
  if (["internaluid", "internal_uid", "useruid", "user_uid"].includes(normalized)) return "uid";
  if (["emailcode", "email_code", "mailcode", "mail_code"].includes(normalized)) return "email_code";
  if (["totpcode", "totp_code", "ga", "gacode", "ga_code", "googlecode", "google_code"].includes(normalized)) return "totp";
  if (["smscode", "sms_code", "phonecode", "phone_code"].includes(normalized)) return "sms_code";
  if (["sendemailcode", "send_email_code", "sendcode", "send_code"].includes(normalized)) return "send_email_code";
  if (["confirmverification", "confirm_verification", "verificationconfirm", "verification_confirm"].includes(normalized)) return "confirm_verification";
  if (["remark", "memo", "name"].includes(normalized)) return "label";
  return normalized;
}

function isFundFlowFilterSelection(selection: PageModelEvidenceSelection): boolean {
  return selection.intent.module === "asset" &&
    (selection.intent.action === "spot_fund_flow_filter" || selection.intent.action === "earn_fund_flow_filter" || selection.intent.action === "contract_fund_flow_filter");
}

function fundFlowTargetPageId(selection: PageModelEvidenceSelection): string {
  if (selection.intent.action === "earn_fund_flow_filter") return "demo.funds.earn_fund_flow";
  if (selection.intent.action === "contract_fund_flow_filter") return "demo.funds.contract_fund_flow";
  return "demo.funds.spot_fund_flow";
}

function primaryLocatorForEvidence(element: SelectedPageModelEvidence): string | undefined {
  return preferredMaterializedLocatorsForEvidence(element)[0];
}

function fallbackLocatorsForEvidence(element: SelectedPageModelEvidence): string[] | undefined {
  const primary = primaryLocatorForEvidence(element);
  const rawLocators = ((element.locatorCandidates ?? []) as Array<Record<string, unknown>>)
    .map((candidate) => (typeof candidate.value === "string" ? candidate.value.trim() : undefined))
    .filter((value): value is string => Boolean(value))
    .filter((value) => !isUnsupportedDslLocatorSyntax(value));
  const locators = [...new Set([...preferredMaterializedLocatorsForEvidence(element), ...rawLocators])].filter((locator) => locator !== primary);
  return locators.length ? locators : undefined;
}

function preferredMaterializedLocatorsForEvidence(element: SelectedPageModelEvidence): string[] {
  const locators = materializedLocatorsForEvidence(element);
  const roleLocators = locators.filter((locator) => locator.startsWith("role="));
  const textLocators = locators.filter((locator) => locator.startsWith("text=") || locator.startsWith("textExact="));
  const structuralLocators = locators.filter((locator) => !roleLocators.includes(locator) && !textLocators.includes(locator));
  return [...roleLocators, ...structuralLocators, ...textLocators];
}

function materializedLocatorsForEvidence(element: SelectedPageModelEvidence): string[] {
  const candidates = (element.locatorCandidates ?? []) as Array<Record<string, unknown>>;
  const locators = candidates
    .flatMap((candidate) => materializeLocatorCandidates(candidate, element))
    .filter((value): value is string => Boolean(value));
  return [...new Set(locators)];
}

function materializeLocatorCandidates(candidate: Record<string, unknown>, element: SelectedPageModelEvidence): Array<string | undefined> {
  if (typeof candidate.value !== "string" || !candidate.value.trim()) return [];
  const value = candidate.value.trim();
  if (/^role=[^:]+:[^|]+(?:\|role=[^:]+:[^|]+)+$/.test(value)) {
    return value.split("|").map((part) => materializeLocatorCandidate({ ...candidate, value: part }, element));
  }
  return [materializeLocatorCandidate(candidate, element)];
}

function materializeLocatorCandidate(candidate: Record<string, unknown>, element: SelectedPageModelEvidence): string | undefined {
  if (typeof candidate.value !== "string" || !candidate.value.trim()) return undefined;
  const value = candidate.value.trim();
  const strategy = String(candidate.strategy ?? "").toLowerCase();
  const roleAlternative = value.match(/^(role=[^:]+:[^|]+)\|role=[^:]+:/)?.[1];
  if (roleAlternative) return roleAlternative;
  const relativeRow = rowRelativeTextLocator(value);
  if (relativeRow) return relativeRow;
  const rowScoped = rowScopedLocatorFrom(element, value, strategy);
  if (rowScoped) return rowScoped;
  const scopedText = scopedTextLocatorFrom(value);
  if (scopedText) return scopedText;
  const listLevel = listLevelLocatorFrom(value);
  if (listLevel) return listLevel;
  if (strategy.includes("modal_scoped") && /^modal\s*>>\s*text=/.test(value)) {
    return `[role='dialog'] >> text=${value.replace(/^modal\s*>>\s*text=/, "").trim()}`;
  }
  if (strategy.includes("modal_scoped") && /^role=[^:]+:.*>>\s*role=[^:]+:/.test(value)) {
    return `[role='dialog'] >> text=${value.replace(/^.*>>\s*role=[^:]+:/, "").trim()}`;
  }
  if (strategy.includes("modal_scoped") && /^role=[^:]+:.*>>\s*text=/.test(value)) {
    return `[role='dialog'] >> text=${value.replace(/^.*>>\s*text=/, "").trim()}`;
  }
  if (strategy.includes("modal_scoped") && /^modal\s*>>\s*role=[^:]+:/.test(value)) {
    return `[role='dialog'] >> text=${value.replace(/^modal\s*>>\s*role=[^:]+:/, "").trim()}`;
  }
  if (strategy.includes("modal_scoped") && (strategy.includes("role_button") || strategy.includes("button"))) {
    return `[role='dialog'] >> text=${value}`;
  }
  if (strategy.includes("placeholder") && !/^(css=|xpath=|text=|textExact=|role=|\.|#|\[|\/\/|input|button|textarea|select)/.test(value)) {
    const selector = `input[placeholder*=${cssStringLiteral(value)}],textarea[placeholder*=${cssStringLiteral(value)}]`;
    return modalScopedEvidence(element) ? `css=[role='dialog'] ${selector}` : `css=${selector}`;
  }
  if (strategy.includes("modal_scoped") && /^scope:dialog\s*>>\s*first visible amount input$/i.test(value)) {
    return "xpath=(//*[@role='dialog'])[last()]//*[self::input or self::textarea or @role='textbox'][not(@disabled)][1]";
  }
  if (isUnsupportedDslLocatorSyntax(value)) return undefined;
  if (strategy.includes("modal_scoped") && value.startsWith("modal field near")) return undefined;
  if (value.startsWith("fieldRelative=")) return value;
  if (value.startsWith("rowScoped=")) return value;
  if (value.includes(":input near") || value.includes("withdraw_form:")) return value;
  if (/^(css=|xpath=|text=|textExact=|role=|\.|#|\[|\/\/|input|button|textarea|select)/.test(value)) return value;

  const role = `${element.role ?? ""}`.toLowerCase();
  if (strategy.includes("role_option") || role.includes("option")) return `role=option:${value}`;
  if (strategy.includes("role_button") || role.includes("button")) return `role=button:${value}`;
  return `text=${value}`;
}

function cssStringLiteral(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
}

function modalScopedEvidence(element: SelectedPageModelEvidence): boolean {
  const region = typeof element.region === "string" ? element.region : "";
  const role = typeof element.role === "string" ? element.role : "";
  return /modal|dialog/i.test(region) || /dialog/i.test(role);
}

function rowRelativeTextLocator(value: string): string | undefined {
  const match = value.match(/^row\s*:\s*(.+?)\s*>>\s*text\s*=\s*(.+)$/i);
  if (!match) return undefined;
  const rowValue = match[1]?.trim();
  const actionText = match[2]?.trim();
  if (!rowValue || !actionText) return undefined;
  return `rowScoped=value:${rowValue}|actionText:${actionText}|match:exact`;
}

function scopedTextLocatorFrom(value: string): string | undefined {
  const scopedRole = value.match(/^scope:([^>\s]+)\s*>>\s*role=[^:]+:(.+)$/i);
  if (scopedRole) {
    const scope = scopedRole[1]?.trim();
    const text = firstAlternation(scopedRole[2]?.trim());
    if (!scope || !text) return undefined;
    if (scope === "dialog" || /modal|dialog|drawer/i.test(scope)) return `[role='dialog'] >> text=${text}`;
    return `text=${text}`;
  }
  const scopedText = value.match(/^scope:([^>\s]+)\s*>>\s*text=(.+)$/i);
  if (scopedText) {
    const scope = scopedText[1]?.trim();
    const text = scopedText[2]?.trim();
    if (!scope || !text) return undefined;
    if (scope === "dialog" || /modal|dialog|drawer/i.test(scope)) return `[role='dialog'] >> text=${text}`;
    return `text=${text}`;
  }
  return undefined;
}

function listLevelLocatorFrom(value: string): string | undefined {
  const match = value.match(/^scope:[^>]+>>\s*listLevel\s+button\s+text\s+(.+)$/i);
  const text = match?.[1]?.trim();
  return text ? `role=button:${firstAlternation(text)}` : undefined;
}

function firstAlternation(value: string | undefined): string | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  return text.split("|").map((item) => item.trim()).find(Boolean);
}

function isUnsupportedDslLocatorSyntax(locator: string): boolean {
  if (/^rowScoped=/i.test(locator)) return false;
  if (/^fieldRelative=/i.test(locator)) return false;
  if (/^row\s+contains\b/i.test(locator)) return true;
  return /^role=[^:]+:.*>>/.test(locator) ||
    /^role=[^:]+:.*\|/.test(locator) ||
    /^modal\s*>>/.test(locator) ||
    /^[^=]*\|[^=]*$/.test(locator);
}

function rowScopedLocatorFrom(element: SelectedPageModelEvidence, rawValue: string, strategy: string): string | undefined {
  const rowScope = element.rowScope && typeof element.rowScope === "object" ? element.rowScope as Record<string, unknown> : undefined;
  const rowValue = typeof rowScope?.value === "string" ? rowScope.value.trim() : undefined;
  const rowValueSource = typeof rowScope?.valueSource === "string" ? rowScope.valueSource.trim() : undefined;
  const actionText = typeof rowScope?.actionText === "string" ? rowScope.actionText.trim() : undefined;
  const actionState = typeof rowScope?.actionState === "string" ? rowScope.actionState.trim() : undefined;
  const expandText = typeof rowScope?.expandText === "string" ? rowScope.expandText.trim() : undefined;
  const matchMode = typeof rowScope?.match === "string" ? rowScope.match.trim() : "exact";
  const matchPart = matchMode ? `|match:${matchMode}` : "";
  const expandPart = expandText ? `|expandText:${expandText}` : "";
  const actionStatePart = actionState ? `|actionState:${actionState}` : "";
  const rowWhere = rowScope?.rowWhere && typeof rowScope.rowWhere === "object" ? rowScope.rowWhere as Record<string, unknown> : undefined;
  if (rowWhere && actionText) {
    const conditionParts = Object.entries(rowWhere)
      .map(([key, value]) => {
        const conditionValue = typeof value === "string" ? value.trim() : "";
        return key && conditionValue ? `${key}:${conditionValue}` : "";
      })
      .filter(Boolean);
    if (conditionParts.length) return `rowScoped=${conditionParts.join("|")}|actionText:${actionText}${actionStatePart}${expandPart}${matchPart}`;
  }
  if (rowValue && actionText) {
    return `rowScoped=value:${rowValue}|actionText:${actionText}${actionStatePart}${expandPart}${matchPart}`;
  }
  if (rowValueSource === "intent.data.asset" && actionText) {
    return `rowScoped=asset:{asset}|actionText:${actionText}${actionStatePart}${expandPart}${matchPart}`;
  }
  if (!strategy.includes("row_scoped") && !/^row\s+contains/i.test(rawValue)) return undefined;
  const match = rawValue.match(/row\s+contains\s+(.+?)\s*>>\s*button\s+text\s+(.+)$/i);
  if (!match) return undefined;
  const value = match[1]?.trim();
  const action = match[2]?.trim();
  if (!value || !action) return undefined;
  return `rowScoped=value:${value}|actionText:${action}|match:exact`;
}

function scopeGuardForEvidence(element: SelectedPageModelEvidence): Record<string, unknown> | undefined {
  const text = `${element.id} ${element.semanticName ?? ""} ${element.role ?? ""}`;
  const critical = /network|amount|submit|provider|selector|input|option|button|filter|提现|提币|网络|数量|验证码|筛选|选项|查询/i.test(text);
  if (!element.negativeLocatorHints?.length && !element.container && !element.region && !critical) return undefined;
  const forbiddenPatterns = [
    "[aria-label*=\"Demo\"]",
    "[aria-label*=\"User\"]",
    "logo",
    "header",
    "global navigation",
    "record/list/table row scope",
    ...(element.negativeLocatorHints ?? [])
  ];
  return {
    pageModelId: element.pageId,
    region: element.region ?? element.container,
    critical,
    forbiddenLocatorPatterns: forbiddenPatterns,
    forbiddenScopes: forbiddenPatterns.filter((item) => /header|nav|logo|record|table|User|Demo|global/i.test(item))
  };
}

function safeId(value: string): string {
  return value.replace(/[^a-z0-9_-]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();
}

function normalizeStepText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, "");
}
