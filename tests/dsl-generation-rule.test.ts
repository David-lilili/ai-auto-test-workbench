import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "fs-extra";
import {
  buildDslGenerationRuleDiff,
  buildDslGenerationRuleFromProposal,
  dataBindingProposalFromSidecar,
  DslGenerationRuleStore
} from "../src/core/dsl-generation-rule.js";
import type { FailureDiagnosisSidecar } from "../src/core/failure-diagnosis.js";
import type { LoadedContext } from "../src/core/types.js";

const sidecarPath = "tests/fixtures/failure-package/input-red-packet-count.diagnosis.json";

test("builds DSL generation rule from data binding proposal without hardcoding value", async () => {
  const sidecar = (await fs.readJson(sidecarPath)) as FailureDiagnosisSidecar;
  const proposal = dataBindingProposalFromSidecar(sidecar);
  const rule = buildDslGenerationRuleFromProposal({ project: "demo", sourceRunId: sidecar.diagnosis.sourceRunId, proposal });
  const diff = buildDslGenerationRuleDiff({ proposal, rule });

  assert.equal(rule.ruleId, "demo.red_packet.create.red_packet_count.intent_count");
  assert.equal(rule.targetField, "red_packet_count");
  assert.equal(rule.semanticName, "红包个数");
  assert.equal(rule.valueSource, "intent.data.count");
  assert.deepEqual(rule.fallbackSources, ["intent.data.quantity"]);
  assert.equal(rule.valueType, "count");
  assert.equal(rule.enabled, true);
  assert.equal(rule.sourceProposalId, proposal.proposalId);
  assert.equal(diff.before.value, "DEMO");
  assert.equal(diff.after.value, 1);
  assert.equal(diff.after.valueSource, "intent.data.count");
});

test("DSL generation rule store writes only when explicitly called", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "dsl-rule-store-"));
  const context = contextFor(rootDir);
  const store = new DslGenerationRuleStore(context);
  assert.equal(await fs.pathExists(store.filePath), false);

  const sidecar = (await fs.readJson(sidecarPath)) as FailureDiagnosisSidecar;
  const proposal = dataBindingProposalFromSidecar(sidecar);
  const rule = buildDslGenerationRuleFromProposal({ project: "demo", sourceRunId: sidecar.diagnosis.sourceRunId, proposal });
  await store.upsert(rule);

  const data = await fs.readJson(store.filePath);
  assert.equal(data.schemaVersion, "dsl-generation-rule-store.v1");
  assert.equal(data.rules.length, 1);
  assert.equal(data.rules[0].ruleId, rule.ruleId);
  assert.equal(data.rules[0].sourceProposalId, proposal.proposalId);
});

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
