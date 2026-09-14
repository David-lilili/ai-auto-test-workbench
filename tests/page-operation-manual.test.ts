import assert from "node:assert/strict";
import { test } from "node:test";
import { selectRelevantPageOperationManuals } from "../src/core/page-operation-manual.js";

test("selects earn product boundary capability for insufficient balance subscribe validation", () => {
  const result = selectRelevantPageOperationManuals({
    env: "test",
    request: "进入更多-理财页面，定位 USDT新理财 产品行，输入 101 USDT，现货账户 USDT 余额为 0，期望确定按钮置灰且不可点击",
    intent: {
      module: "asset",
      action: "earn_subscribe",
      data: { asset: "USDT", amount: 101 }
    },
    store: {
      manuals: [
        {
          manualId: "demo.earn.product_center.manual",
          module: "asset",
          pageId: "demo.earn.product_center",
          pageName: "更多-理财",
          pageSummary: { primaryCapabilities: ["view_earn_products", "subscribe_earn_product_boundary_validation"] },
          capabilities: [
            {
              capabilityId: "view_earn_products",
              operationType: "read",
              successEvidencePolicyId: "demo.earn.product_center.list_visible_policy",
              naturalLanguageAliases: ["更多-理财", "理财产品列表"]
            },
            {
              capabilityId: "subscribe_earn_product_boundary_validation",
              operationType: "write",
              requiredData: ["asset", "amount"],
              successEvidencePolicyId: "demo.earn.product_center.subscribe_boundary_message_policy",
              naturalLanguageAliases: ["申购数量为空", "余额不足", "确认按钮置灰"]
            }
          ]
        }
      ],
      successEvidencePolicies: [
        { policyId: "demo.earn.product_center.subscribe_boundary_message_policy" }
      ]
    }
  });

  assert.deepEqual(result.capabilities.map((item) => item.capabilityId), ["subscribe_earn_product_boundary_validation"]);
  assert.deepEqual(result.successEvidencePolicies.map((item) => item.policyId), ["demo.earn.product_center.subscribe_boundary_message_policy"]);
  assert.equal(result.gaps.includes("operation_manual_success_policy_missing"), false);
});

test("selects earn product type switch capability for explicit tab switch request", () => {
  const result = selectRelevantPageOperationManuals({
    env: "test",
    request: "进入更多-理财页面。点击定期理财产品标签。点击活期理财产品标签。",
    intent: {
      module: "asset",
      action: "earn_product_view",
      data: { productType: "活期理财" }
    },
    store: {
      manuals: [
        {
          manualId: "demo.earn.product_center.manual",
          module: "asset",
          pageId: "demo.earn.product_center",
          pageName: "更多-理财",
          pageSummary: { primaryCapabilities: ["view_earn_products", "switch_earn_product_type"] },
          capabilities: [
            { capabilityId: "view_earn_products", operationType: "read", naturalLanguageAliases: ["理财产品列表"] },
            { capabilityId: "switch_earn_product_type", operationType: "read", naturalLanguageAliases: ["切换产品类型", "点击产品类型标签"] }
          ]
        }
      ]
    }
  });

  assert.deepEqual(result.capabilities.map((item) => item.capabilityId), ["switch_earn_product_type"]);
});

test("selects red packet claim capability by intent action", () => {
  const result = selectRelevantPageOperationManuals({
    env: "test",
    request: "红包错误口令领取失败",
    intent: {
      module: "red-packet",
      action: "claim_red_packet",
      data: { passphrase: "AUTO_TEST_INVALID_20260807_001" }
    },
    store: {
      manuals: [
        {
          manualId: "demo.funds.red_packet.manual",
          module: "red-packet",
          pageId: "demo.funds.red_packet",
          pageName: "资产中心-红包",
          capabilities: [
            {
              capabilityId: "create_red_packet",
              operationType: "write",
              naturalLanguageAliases: ["创建红包"]
            },
            {
              capabilityId: "claim_red_packet",
              operationType: "write",
              successEvidencePolicyId: "demo.red_packet.claim.success_policy",
              naturalLanguageAliases: ["领取红包"]
            },
            {
              capabilityId: "view_red_packet_records",
              operationType: "read",
              naturalLanguageAliases: ["红包明细"]
            }
          ]
        }
      ],
      successEvidencePolicies: [
        { policyId: "demo.red_packet.claim.success_policy" }
      ]
    }
  });

  assert.deepEqual(result.capabilities.map((item) => item.capabilityId), ["claim_red_packet"]);
  assert.deepEqual(result.successEvidencePolicies.map((item) => item.policyId), ["demo.red_packet.claim.success_policy"]);
  assert.equal(result.gaps.includes("operation_manual_capability_not_found_for_intent"), false);
});
