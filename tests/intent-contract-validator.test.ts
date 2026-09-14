import assert from "node:assert/strict";
import { test } from "node:test";
import { validateIntentContract } from "../src/core/intent-contract-validator.js";
import type { PageModelEvidenceSelection } from "../src/core/page-model-evidence-selector.js";
import type { PageOperationManualSelection } from "../src/core/page-operation-manual.js";
import type { UserAssertionParseResult } from "../src/core/user-assertion-parser.js";

test("passes when selected intent has page, capability, required data, provider, policy, and assertion evidence", () => {
  const result = validateIntentContract({
    selection: selectionFixture({ operationType: "write", data: { uid: "14605" } }),
    operationManualSelection: manualFixture({
      capabilities: [{
        capabilityId: "create_internal_withdraw_address",
        operationType: "write",
        requiredData: ["uid"],
        providerFlowIds: ["security.email_and_totp"],
        successEvidencePolicyId: "address.create.success"
      }],
      providerFlows: [{ providerFlowId: "security.email_and_totp" }],
      successEvidencePolicies: [{ policyId: "address.create.success" }]
    }),
    userAssertions: assertionFixture("message_visible_exact", true)
  });

  assert.equal(result.passed, true);
  assert.deepEqual(result.blockingGaps, []);
  assert.deepEqual(result.capabilityContract.missingRequiredData, []);
});

test("reports deterministic contract gaps without guessing a replacement business intent", () => {
  const result = validateIntentContract({
    selection: selectionFixture({ operationType: "write", data: {} }),
    operationManualSelection: manualFixture({
      capabilities: [{
        capabilityId: "delete_withdraw_address",
        operationType: "delete",
        requiredData: ["rowIdentifier"],
        providerFlowIds: ["security.confirm"],
        successEvidencePolicyId: "address.delete.success"
      }],
      providerFlows: [],
      successEvidencePolicies: []
    }),
    userAssertions: assertionFixture("table_row_absent", false)
  });

  assert.equal(result.passed, false);
  assert.ok(result.blockingGaps.includes("intent_contract_required_data_missing:rowIdentifier"));
  assert.ok(result.blockingGaps.includes("intent_contract_provider_flow_missing:security.confirm"));
  assert.ok(result.warningGaps.includes("intent_contract_success_policy_missing:address.delete.success"));
  assert.equal(result.blockingGaps.includes("intent_contract_success_policy_missing:address.delete.success"), false);
  assert.equal(result.assertionContract.hasMappedEvidence, false);
});

test("keeps success policy and operation type mismatches as warnings when DSL evidence is grounded", () => {
  const result = validateIntentContract({
    selection: selectionFixture({ operationType: "read", data: { uid: "14605" } }),
    operationManualSelection: manualFixture({
      capabilities: [{
        capabilityId: "view_product",
        operationType: "write",
        requiredData: [],
        successEvidencePolicyId: "product.list.visible"
      }],
      providerFlows: [],
      successEvidencePolicies: []
    }),
    userAssertions: assertionFixture("element_enabled", true)
  });

  assert.equal(result.passed, true);
  assert.deepEqual(result.blockingGaps, []);
  assert.ok(result.warningGaps.includes("intent_contract_success_policy_missing:product.list.visible"));
  assert.ok(result.warningGaps.includes("intent_contract_operation_type_mismatch"));
});

function selectionFixture(input: { operationType: "read" | "write" | "unknown"; data: Record<string, unknown> }): PageModelEvidenceSelection {
  return {
    schemaVersion: "page-model-evidence-selection.v1",
    request: "fixture",
    intent: {
      project: "demo",
      env: "test",
      module: "withdraw",
      action: "add_withdraw_address",
      operationType: input.operationType,
      loginRequired: true,
      data: input.data,
      intentConfidence: 0.9,
      evidence: ["fixture"]
    },
    evidenceBuckets: {
      targetPage: [{ kind: "page", id: "demo.funds.withdraw.address_management", pageId: "demo.funds.withdraw.address_management", evidenceRole: "target_page", reason: "fixture", evidence: [] }],
      navigation: [],
      executableElements: [],
      actionResults: [],
      assertions: [],
      providers: [],
      preconditions: [],
      supporting: [],
      excluded: []
    },
    selectedEvidence: [],
    fallbackEvidence: [],
    excludedEvidence: [],
    gaps: [],
    blockingGaps: [],
    readiness: "ready",
    executable: true,
    reason: "fixture"
  };
}

function manualFixture(input: {
  capabilities: Array<Record<string, unknown>>;
  providerFlows: Array<Record<string, unknown>>;
  successEvidencePolicies: Array<Record<string, unknown>>;
}): PageOperationManualSelection {
  return {
    manuals: [],
    capabilities: input.capabilities,
    providerFlows: input.providerFlows,
    successEvidencePolicies: input.successEvidencePolicies,
    modelingRules: [],
    gaps: []
  };
}

function assertionFixture(kind: string, mapped: boolean): UserAssertionParseResult {
  return {
    schemaVersion: "user-assertion-parse.v1",
    assertions: [{
      kind: kind as never,
      sourceText: "fixture assertion",
      expected: "fixture",
      mappedEvidence: mapped ? [{ id: "assertion.fixture", kind: "assertion", confidence: 0.9, reason: "fixture" }] : [],
      gaps: []
    }],
    gaps: []
  };
}
