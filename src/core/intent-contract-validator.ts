import type { PageOperationManualSelection } from "./page-operation-manual.js";
import type { PageModelEvidenceSelection } from "./page-model-evidence-selector.js";
import type { UserAssertionParseResult } from "./user-assertion-parser.js";

export interface IntentContractValidation {
  schemaVersion: "intent-contract-validation.v1";
  passed: boolean;
  checkedRules: string[];
  gaps: string[];
  blockingGaps: string[];
  hardBlockingGaps: string[];
  warningGaps: string[];
  pageContract: {
    pageId?: string;
    exists: boolean;
  };
  capabilityContract: {
    capabilityIds: string[];
    exists: boolean;
    missingRequiredData: string[];
    operationTypeCompatible: boolean;
  };
  providerContract: {
    requiredProviderFlowIds: string[];
    availableProviderFlowIds: string[];
    missingProviderFlowIds: string[];
  };
  assertionContract: {
    assertionTypes: string[];
    unsupportedAssertionTypes: string[];
    hasMappedEvidence: boolean;
  };
  successEvidenceContract: {
    requiredPolicyIds: string[];
    availablePolicyIds: string[];
    missingPolicyIds: string[];
  };
}

const SUPPORTED_ASSERTION_TYPES = new Set([
  "message_visible_exact",
  "result_empty",
  "table_column_all_equal",
  "table_column_all_equal_or_empty",
  "table_column_date_between",
  "table_column_contains",
  "record_or_empty_state",
  "record_contains",
  "success_message",
  "failure_message",
  "field_value",
  "textVisibleAny",
  "ui_text_visible",
  "urlContains",
  "element_disabled",
  "element_enabled",
  "tab_active",
  "list_row_present",
  "element_absent",
  "input_absent",
  "control_state_readable",
  "field_validation_visible",
  "table_row_present",
  "table_row_absent",
  "dialog_visible",
  "dialog_closed",
  "selected_value_equals"
]);

export function validateIntentContract(input: {
  selection: PageModelEvidenceSelection;
  operationManualSelection?: PageOperationManualSelection;
  userAssertions: UserAssertionParseResult;
}): IntentContractValidation {
  const checkedRules = [
    "page_contract_has_target_page",
    "operation_manual_capability_exists_when_manual_available",
    "required_data_present",
    "provider_flow_available_when_required",
    "success_policy_available_when_required",
    "assertion_type_supported",
    "assertion_mapping_observed"
  ];
  const targetPage = input.selection.evidenceBuckets.targetPage[0] ?? input.selection.selectedEvidence.find((item) => item.evidenceRole === "target_page");
  const capabilities = input.operationManualSelection?.capabilities ?? [];
  const providerFlows = input.operationManualSelection?.providerFlows ?? [];
  const successPolicies = input.operationManualSelection?.successEvidencePolicies ?? [];
  const manualHasRelevantContext = Boolean(input.operationManualSelection && !input.operationManualSelection.gaps.includes("operation_manual_store_missing") && input.operationManualSelection.manuals.length > 0);
  const capabilityIds = capabilities.map((item) => String(item.capabilityId ?? "")).filter(Boolean);
  const missingRequiredData = unique(capabilities.flatMap((capability) =>
    readStringArray(capability.requiredData).filter((field) => !intentHasDataField(input.selection.intent.data, field))
  ));
  const requiredProviderFlowIds = unique(capabilities.flatMap((capability) => readStringArray(capability.providerFlowIds)));
  const availableProviderFlowIds = unique(providerFlows.map((flow) => String(flow.providerFlowId ?? "")).filter(Boolean));
  const missingProviderFlowIds = requiredProviderFlowIds.filter((id) => !availableProviderFlowIds.includes(id));
  const requiredPolicyIds = unique(capabilities.map((capability) => String(capability.successEvidencePolicyId ?? "")).filter(Boolean));
  const availablePolicyIds = unique(successPolicies.map((policy) => String(policy.policyId ?? "")).filter(Boolean));
  const missingPolicyIds = requiredPolicyIds.filter((id) => !availablePolicyIds.includes(id));
  const assertionTypes = unique(input.userAssertions.assertions.map((assertion) => assertion.kind).filter(Boolean));
  const unsupportedAssertionTypes = assertionTypes.filter((type) => !SUPPORTED_ASSERTION_TYPES.has(type));
  const hasMappedEvidence = input.userAssertions.assertions.every((assertion) => assertion.mappedEvidence.length > 0);
  const operationTypeCompatible = capabilities.every((capability) =>
    operationTypesCompatible(String(input.selection.intent.operationType ?? "unknown"), String(capability.operationType ?? "unknown"))
  );
  const gaps = [
    targetPage ? undefined : "intent_contract_page_missing",
    manualHasRelevantContext && !capabilityIds.length ? "intent_contract_capability_missing" : undefined,
    ...missingRequiredData.map((field) => `intent_contract_required_data_missing:${field}`),
    ...missingProviderFlowIds.map((id) => `intent_contract_provider_flow_missing:${id}`),
    ...missingPolicyIds.map((id) => `intent_contract_success_policy_missing:${id}`),
    operationTypeCompatible ? undefined : "intent_contract_operation_type_mismatch",
    ...unsupportedAssertionTypes.map((type) => `intent_contract_assertion_type_unsupported:${type}`),
  ].filter((item): item is string => Boolean(item));
  const hardBlockingGaps = gaps.filter((gap) =>
    /page_missing|required_data_missing|provider_flow_missing|assertion_type_unsupported/.test(gap)
  );
  const warningGaps = gaps.filter((gap) =>
    /success_policy_missing|operation_type_mismatch|capability_missing/.test(gap)
  );
  return {
    schemaVersion: "intent-contract-validation.v1",
    passed: hardBlockingGaps.length === 0,
    checkedRules,
    gaps: unique(gaps),
    blockingGaps: unique(hardBlockingGaps),
    hardBlockingGaps: unique(hardBlockingGaps),
    warningGaps: unique(warningGaps),
    pageContract: {
      pageId: targetPage?.pageId ?? targetPage?.id,
      exists: Boolean(targetPage)
    },
    capabilityContract: {
      capabilityIds,
      exists: capabilityIds.length > 0,
      missingRequiredData,
      operationTypeCompatible
    },
    providerContract: {
      requiredProviderFlowIds,
      availableProviderFlowIds,
      missingProviderFlowIds
    },
    assertionContract: {
      assertionTypes,
      unsupportedAssertionTypes,
      hasMappedEvidence
    },
    successEvidenceContract: {
      requiredPolicyIds,
      availablePolicyIds,
      missingPolicyIds
    }
  };
}

function operationTypesCompatible(intentType: string, capabilityType: string): boolean {
  if (!intentType || intentType === "unknown" || !capabilityType || capabilityType === "unknown") return true;
  if (intentType === capabilityType) return true;
  if (intentType === "write" && (capabilityType === "delete" || capabilityType === "negative_validation")) return true;
  if (intentType === "delete" && capabilityType === "write") return true;
  return false;
}

function intentHasDataField(data: Record<string, unknown>, field: string): boolean {
  if (Object.prototype.hasOwnProperty.call(data, field) && data[field] !== undefined && data[field] !== "") return true;
  const normalizedField = normalizeField(field);
  return Object.entries(data).some(([key, value]) => normalizeField(key) === normalizedField && value !== undefined && value !== "");
}

function normalizeField(value: string): string {
  return value.toLowerCase().replace(/[_\-\s]/g, "");
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item).trim()).filter(Boolean) : [];
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}
