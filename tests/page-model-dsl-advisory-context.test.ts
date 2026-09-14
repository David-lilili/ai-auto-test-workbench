import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCompressedPageModelDslAdvisoryContext } from "../src/core/page-model-dsl-advisory-context.js";
import type { PageModelExecutionPlan } from "../src/core/page-model-execution-planner.js";

test("compressed advisory context only includes materialized DSL referenced evidence", () => {
  const plan = {
    selection: {
      intent: { module: "asset", action: "spot_fund_flow_filter", operationType: "read", data: {} },
      evidenceBuckets: {
        targetPage: [
          { id: "page.used", pageId: "asset.spot.fund_flow", semanticName: "现货流水" },
          { id: "page.unused", pageId: "asset.withdraw", semanticName: "提现" }
        ],
        executableElements: [
          { id: "element.used", semanticName: "类型筛选" },
          { id: "element.unused", semanticName: "提现按钮" }
        ],
        assertions: [
          { id: "assertion.used", semanticName: "类型列一致" },
          { id: "assertion.unused", semanticName: "提现成功提示" }
        ],
        providers: [],
        navigation: [],
        actionResults: [],
        preconditions: [],
        supporting: [],
        excluded: []
      }
    },
    planningContext: {
      retrievedOperationManualContext: {
        capabilities: [],
        providerFlows: [],
        successEvidencePolicies: []
      }
    },
    executable: true,
    readiness: "ready",
    gaps: [],
    blockingGaps: [],
    intentContract: { passed: true, gaps: [], blockingGaps: [] },
    materialization: {
      dslValidation: { passed: true, contractGaps: [] },
      case: {
        steps: [
          {
            id: "step.select_type",
            action: "select",
            pageModelId: "asset.spot.fund_flow",
            elementId: "element.used"
          },
          {
            id: "step.assert_type",
            action: "assert",
            pageModelId: "asset.spot.fund_flow",
            assertionId: "assertion.used"
          }
        ]
      }
    }
  } as unknown as PageModelExecutionPlan;
  const context = buildCompressedPageModelDslAdvisoryContext({
    project: "demo",
    env: "test",
    request: "筛选现货流水类型",
    plan,
    planSummary: {
      automationCase: {
        steps: plan.materialization.case.steps
      }
    },
    originalPromptChars: 20_000
  });

  assert.equal(context.mode, "compressed");
  assert.equal(context.prompt.includes("element.used"), true);
  assert.equal(context.prompt.includes("assertion.used"), true);
  assert.equal(context.prompt.includes("asset.spot.fund_flow"), true);
  assert.equal(context.prompt.includes("element.unused"), false);
  assert.equal(context.prompt.includes("assertion.unused"), false);
  assert.equal(context.prompt.includes("asset.withdraw"), false);
  assert.equal(context.promptCharReductionPercent && context.promptCharReductionPercent > 80, true);
});

test("compressed advisory context carries exact assertion text candidates and review rules", () => {
  const plan = {
    selection: {
      intent: { module: "red-packet", action: "claim_red_packet", operationType: "write", loginRequired: true, data: {} },
      evidenceBuckets: {
        targetPage: [
          { id: "demo.funds.red_packet", pageId: "demo.funds.red_packet", semanticName: "资产中心-红包" }
        ],
        executableElements: [
          { id: "funds.red_packet.claim.passphrase_input", semanticName: "红包口令输入框" },
          { id: "funds.red_packet.claim.claim_button", semanticName: "领取按钮" }
        ],
        assertions: [
          {
            id: "funds.red_packet.claim.nonexistent_passphrase_error_message",
            semanticName: "红包口令不存在或格式非法失败提示",
            assertionType: "message_visible_exact",
            textCandidates: ["红包口令错误"]
          }
        ],
        providers: [],
        navigation: [],
        actionResults: [],
        preconditions: [],
        supporting: [],
        excluded: []
      }
    },
    planningContext: {
      retrievedOperationManualContext: {
        capabilities: [
          { capabilityId: "claim_red_packet", operationType: "write", successEvidencePolicyId: "demo.red_packet.claim.success_policy" }
        ],
        providerFlows: [],
        successEvidencePolicies: [
          { policyId: "demo.red_packet.claim.success_policy" }
        ]
      }
    },
    executable: true,
    readiness: "ready",
    gaps: [],
    blockingGaps: [],
    intentContract: { passed: true, gaps: [], blockingGaps: [] },
    materialization: {
      dslValidation: { passed: true, contractGaps: [] },
      case: {
        steps: [
          {
            id: "step.open_red_packet",
            action: "navigate",
            pageModelId: "demo.funds.red_packet",
            targetPageId: "demo.funds.red_packet"
          },
          {
            id: "step.input_passphrase",
            action: "input",
            pageModelId: "demo.funds.red_packet",
            elementId: "funds.red_packet.claim.passphrase_input"
          },
          {
            id: "step.claim",
            action: "click",
            pageModelId: "demo.funds.red_packet",
            elementId: "funds.red_packet.claim.claim_button"
          },
          {
            id: "step.assert_invalid",
            action: "assert",
            pageModelId: "demo.funds.red_packet",
            assertionId: "funds.red_packet.claim.nonexistent_passphrase_error_message",
            assertion: {
              type: "message_visible_exact",
              expected: "红包口令错误"
            }
          }
        ]
      }
    }
  } as unknown as PageModelExecutionPlan;
  const context = buildCompressedPageModelDslAdvisoryContext({
    project: "demo",
    env: "test",
    request: "红包错误口令领取失败",
    plan,
    planSummary: {
      automationCase: {
        steps: plan.materialization.case.steps
      }
    }
  });

  const prompt = JSON.parse(context.prompt) as Record<string, unknown>;
  assert.match(context.prompt, /红包口令错误/);
  assert.match(context.prompt, /Runtime login\/auth/);
  assert.match(context.prompt, /exact Page Model textCandidates/);
  assert.deepEqual(((prompt.selectedKnowledge as Record<string, unknown>).operationManual as Record<string, unknown>).capabilities, [
    {
      capabilityId: "claim_red_packet",
      operationType: "write",
      successEvidencePolicyId: "demo.red_packet.claim.success_policy"
    }
  ]);
});
