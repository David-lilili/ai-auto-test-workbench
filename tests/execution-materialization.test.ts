import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "fs-extra";
import { materializeAssistantPlanDryRun } from "../src/core/execution-materialization.js";

test("materializes assistant planning DSL without legacy DEMO binding", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "materialized-plan-"));
  const planPath = path.join(rootDir, "plan.json");
  await fs.writeJson(planPath, planningFixture(), { spaces: 2 });

  const result = await materializeAssistantPlanDryRun({ planningResultPath: planPath, materializedAt: "2026-07-16T00:00:00.000Z" });
  const countStep = result.testCase.steps.find((step) => (step as Record<string, unknown>).targetField === "red_packet_count") as Record<string, unknown> | undefined;

  assert.equal(result.checks.containsDemo, false);
  assert.equal(result.checks.redPacketCount.found, true);
  assert.equal(result.checks.redPacketCount.value, 1);
  assert.equal(result.checks.redPacketCount.valueSource, "intent.data.count");
  assert.equal(result.checks.redPacketCount.appliedRuleId, "demo.red_packet.create.red_packet_count.intent_count");
  assert.equal(countStep?.value, 1);
  assert.equal(countStep?.valueSource, "intent.data.count");
  assert.equal(countStep?.appliedRuleId, "demo.red_packet.create.red_packet_count.intent_count");
  assert.equal(JSON.stringify(result.testCase).includes("DEMO"), false);
  assert.equal(result.executionPolicy.startsBrowser, false);
  assert.equal(result.executionPolicy.callsExecutor, false);
  assert.equal(result.executionPolicy.callsProvider, false);
});

function planningFixture(): Record<string, unknown> {
  return {
    planningResponse: {
      plan: {
        project: "demo",
        env: "test",
        dslDraft: {
          schemaVersion: "dsl-draft.v1",
          project: "demo",
          env: "test",
          module: "red-packet",
          action: "create",
          operationType: "write",
          loginRequired: true,
          data: { asset: "TON", amount: 10, count: 1 },
          providerDependencies: ["redis:email", "keepassxc:totp"],
          steps: [
            {
              id: "input-red-packet-count",
              action: "input",
              targetField: "red_packet_count",
              semanticName: "红包个数",
              semanticLocator: "红包个数",
              inputValue: 1,
              valueSource: "intent.data.count",
              appliedRuleId: "demo.red_packet.create.red_packet_count.intent_count",
              runtimeResolvable: true,
              evidence: [],
              aiConfidence: 0.72
            }
          ],
          appliedRules: [
            {
              ruleId: "demo.red_packet.create.red_packet_count.intent_count",
              stepId: "input-red-packet-count",
              targetField: "red_packet_count",
              semanticName: "红包个数",
              beforeValue: "DEMO",
              afterValue: 1,
              valueSource: "intent.data.count"
            }
          ],
          assertions: [],
          clarificationQuestions: []
        }
      }
    }
  };
}
