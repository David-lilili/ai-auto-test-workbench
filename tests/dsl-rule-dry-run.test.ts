import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "fs-extra";
import {
  applyDslGenerationRules,
  applyDslGenerationRulesToDraft,
  buildBaselineDslForDryRun,
  generateDslRuleDryRun,
  parseDryRunIntent
} from "../src/core/dsl-rule-dry-run.js";
import type { DslDraft } from "../src/core/ai-orchestration-schema.js";
import type { DslGenerationRuleStoreData } from "../src/core/dsl-generation-rule.js";
import type { LoadedContext } from "../src/core/types.js";

const request = "登录 demo test 环境，创建一个 TON 红包，金额 10，数量 1，需要邮箱验证码和 GA 验证码，创建成功后断言页面提示成功。";
const ruleId = "demo.red_packet.create.red_packet_count.intent_count";

test("applies DSL generation rule to red packet count during dry-run", () => {
  const intent = parseDryRunIntent({ project: "demo", env: "test", request });
  const beforeDsl = buildBaselineDslForDryRun(intent);
  const countBefore = beforeDsl.steps.find((step) => step.targetField === "red_packet_count");
  assert.equal(countBefore?.value, "DEMO");

  const applied = applyDslGenerationRules({
    dsl: beforeDsl,
    intent,
    rules: [ruleForTest()]
  });
  const countAfter = applied.dsl.steps.find((step) => step.targetField === "red_packet_count");

  assert.deepEqual(applied.appliedRuleIds, [ruleId]);
  assert.equal(countAfter?.value, 1);
  assert.equal(countAfter?.valueSource, "intent.data.count");
  assert.equal(countAfter?.appliedRuleId, ruleId);
  assert.equal(applied.diff[0].before.value, "DEMO");
  assert.equal(applied.diff[0].after.value, 1);
});

test("generateDslRuleDryRun reads rule store without starting execution", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "dsl-rule-dry-run-"));
  const context = contextFor(rootDir);
  const storePath = path.join(rootDir, "storage", "dsl-generation-rules", "demo.json");
  const store: DslGenerationRuleStoreData = {
    schemaVersion: "dsl-generation-rule-store.v1",
    project: "demo",
    updatedAt: new Date().toISOString(),
    rules: [ruleForTest()]
  };
  await fs.ensureDir(path.dirname(storePath));
  await fs.writeJson(storePath, store);

  const result = await generateDslRuleDryRun({ context, request, applyRules: true });
  const countBefore = result.beforeDsl.steps.find((step) => step.targetField === "red_packet_count");
  const countAfter = result.afterDsl.steps.find((step) => step.targetField === "red_packet_count");

  assert.equal(countBefore?.value, "DEMO");
  assert.equal(countAfter?.value, 1);
  assert.deepEqual(result.appliedRuleIds, [ruleId]);
  assert.equal(result.executionPolicy.startsBrowser, false);
  assert.equal(result.executionPolicy.executesBusiness, false);
  assert.equal(result.executionPolicy.writesMainStorage, false);
});

test("applies DSL generation rule to assistant planning DSL draft fields", () => {
  const dsl: DslDraft = {
    schemaVersion: "dsl-draft.v1",
    project: "demo",
    env: "test",
    module: "red-packet",
    action: "create",
    operationType: "write",
    loginRequired: true,
    data: { asset: "TON", amount: 10, count: 1 },
    providerDependencies: ["redis:email", "keepassxc:totp"],
    steps: [{
      id: "input-red-packet-count",
      action: "input",
      targetField: "red_packet_count",
      semanticName: "红包个数",
      semanticLocator: "红包个数",
      inputValue: "DEMO",
      valueSource: "legacy.dsl.step.value",
      runtimeResolvable: true,
      evidence: [],
      aiConfidence: 0.7
    }],
    assertions: [],
    clarificationQuestions: []
  };

  const result = applyDslGenerationRulesToDraft({ dsl, rules: [ruleForTest()] });
  const step = result.dsl.steps[0];

  assert.equal(step.inputValue, 1);
  assert.equal(step.valueSource, "intent.data.count");
  assert.equal(step.appliedRuleId, ruleId);
  assert.equal(result.dsl.appliedRules?.[0]?.beforeValue, "DEMO");
  assert.equal(result.dsl.appliedRules?.[0]?.afterValue, 1);
});

function ruleForTest() {
  const at = "2026-07-16T00:00:00.000Z";
  return {
    schemaVersion: "dsl-generation-rule.v1" as const,
    ruleId,
    project: "demo",
    module: "red-packet",
    action: "create",
    targetField: "red_packet_count",
    semanticName: "红包个数",
    valueSource: "intent.data.count",
    fallbackSources: ["intent.data.quantity"],
    valueType: "count" as const,
    validation: {
      required: true,
      type: "number" as const,
      min: 1,
      integer: true
    },
    evidence: [],
    sourceProposalId: "stage2_data_binding_红包个数_76c1f44b",
    sourceRunId: "76c1f44b-b719-43cd-986e-7a6b5efc1241",
    enabled: true,
    createdAt: at,
    createdBy: "manual-confirmation" as const,
    updatedAt: at
  };
}

function contextFor(rootDir: string): LoadedContext {
  return {
    rootDir,
    workspace: {
      workspaceName: "test",
      defaultProject: "demo",
      defaultEnv: "test",
      artifactRoot: "artifacts",
      reportRoot: "reports"
    },
    project: {
      projectKey: "demo",
      projectName: "Demo",
      owners: [],
      enabledTestTypes: ["web"],
      defaultEnv: "test",
      report: {},
      failureArtifacts: {}
    },
    env: { env: "test" }
  };
}
