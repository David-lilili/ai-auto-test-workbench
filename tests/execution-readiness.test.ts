import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "fs-extra";
import { analyzeExecutionReadiness } from "../src/core/execution-readiness.js";

test("execution readiness accepts materialized red packet case without calling execution dependencies", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "execution-readiness-"));
  const casePath = path.join(rootDir, "materialized.json");
  await fs.writeJson(casePath, materializedFixture(), { spaces: 2 });

  const result = await analyzeExecutionReadiness({ materializedCasePath: casePath, checkedAt: "2026-07-16T00:00:00.000Z" });
  const count = result.stepReadiness.find((item) => item.targetField === "red_packet_count");
  const amount = result.stepReadiness.find((item) => item.targetField === "red_packet_amount");
  const asset = result.stepReadiness.find((item) => item.targetField === "red_packet_asset");

  assert.equal(result.ready, true);
  assert.equal(result.blockingIssues.length, 0);
  assert.equal(result.recommendedNextAction, "proceed_to_controlled_execution");
  assert.equal(count?.data.value, 1);
  assert.equal(count?.data.valueType, "count");
  assert.equal(amount?.data.value, 10);
  assert.equal(asset?.data.value, "TON");
  assert.equal(result.providerReadiness.find((item) => item.provider === "redis:email")?.declared, true);
  assert.equal(result.providerReadiness.find((item) => item.provider === "redis:email")?.called, false);
  assert.equal(result.providerReadiness.find((item) => item.provider === "keepassxc:totp")?.declared, true);
  assert.equal(result.executionPolicy.startsBrowser, false);
  assert.equal(result.executionPolicy.callsExecutor, false);
  assert.equal(result.executionPolicy.callsProvider, false);
  assert.equal(result.warnings.some((item) => /UI success assertion is broad/.test(item.reason)), true);
});

function materializedFixture(): Record<string, unknown> {
  return {
    testCase: {
      id: "assistant_materialized_demo_test",
      title: "Assistant materialized execution case dry-run",
      type: "web",
      project: "demo",
      module: "red-packet",
      priority: "P2",
      tags: ["assistant"],
      owner: "qa",
      env: ["test"],
      steps: [
        {
          id: "input-red-packet-asset",
          action: "select",
          target: "红包币种",
          value: "TON",
          semantic_target: "红包币种",
          targetField: "red_packet_asset",
          allow_healing: true
        },
        {
          id: "input-red-packet-amount",
          action: "input",
          target: "红包金额",
          value: 10,
          semantic_target: "红包金额",
          targetField: "red_packet_amount",
          allow_healing: true
        },
        {
          id: "input-red-packet-count",
          action: "input",
          target: "红包个数",
          value: 1,
          valueSource: "intent.data.count",
          appliedRuleId: "demo.red_packet.create.red_packet_count.intent_count",
          semantic_target: "红包个数",
          targetField: "red_packet_count",
          allow_healing: true
        },
        {
          id: "provider-redis-email",
          action: "input",
          target: "email verification code input",
          valueFrom: "redis:email",
          sensitive: true
        },
        {
          id: "provider-keepassxc-totp",
          action: "input",
          target: "GA TOTP input",
          valueFrom: "keepassxc:totp",
          sensitive: true
        }
      ],
      assertions: [
        { type: "apiResponse", target: "POST /api/red-packet/create", expected: "code=0 and succ=true" },
        { type: "uiState", target: "页面提示成功", expected: "页面显示创建成功或类似成功提示" }
      ]
    }
  };
}
