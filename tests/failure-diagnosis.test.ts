import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import fs from "fs-extra";
import { diagnoseFailurePackage, writeFailureDiagnosisSidecar } from "../src/core/failure-diagnosis.js";
import { validateJsonFile } from "../src/core/safe-file-writer.js";

const fixture = "tests/fixtures/failure-package/input-red-packet-count.json";

test("diagnoses red packet count as data binding error before locator issue", async () => {
  const result = await diagnoseFailurePackage(fixture, { intentData: { count: 1 }, intentSourceId: "test_intent" });

  assert.equal(result.schemaVersion, "failure-diagnosis.v1");
  assert.equal(result.mode, "offline_diagnosis_only");
  assert.equal(result.constraints.browserStarted, false);
  assert.equal(result.constraints.knowledgeWritten, false);
  assert.equal(result.constraints.elementStoreWritten, false);
  assert.equal(result.diagnosis.semanticName, "红包个数");
  assert.equal(result.diagnosis.oldValue, "DEMO");
  assert.equal(result.diagnosis.expectedIntentValue, 1);
  assert.equal(result.diagnosis.observedDom?.labelPresent, true);
  assert.equal(result.diagnosis.observedDom?.inputPresent, true);
  assert.equal(result.diagnosis.observedDom?.inputmode, "numeric");

  const dataCause = result.diagnosis.rootCausePriority.find((item) => item.cause === "data_binding_error");
  const locatorCause = result.diagnosis.rootCausePriority.find((item) => item.cause === "locator_candidate_missing");
  const actionCause = result.diagnosis.rootCausePriority.find((item) => item.cause === "action_failed");
  assert.equal(dataCause?.priority, "high");
  assert.equal(locatorCause?.priority, "medium");
  assert.equal(actionCause?.priority, "low");
  assert.equal(result.actionExecutionResult.reason, "data_binding_error");
});

test("generates locator and data binding proposals without recommending auto write", async () => {
  const result = await diagnoseFailurePackage(fixture, { intentData: { count: 1 }, intentSourceId: "test_intent" });
  const locatorProposal = result.updateProposals.find((item) => item.proposalType === "LocatorUpdateProposal");
  const dataProposal = result.updateProposals.find((item) => item.proposalType === "DataBindingUpdateProposal");

  assert.ok(locatorProposal);
  assert.ok(dataProposal);
  assert.equal(locatorProposal.requiresHumanConfirmation, true);
  assert.equal(dataProposal.requiresHumanConfirmation, true);
  assert.equal(locatorProposal.autoWriteRecommended, false);
  assert.equal(dataProposal.autoWriteRecommended, false);
  assert.equal(locatorProposal.rootCausePriority, "medium");
  assert.equal(dataProposal.rootCausePriority, "high");

  if (dataProposal.proposalType !== "DataBindingUpdateProposal") throw new Error("unexpected proposal type");
  assert.equal(dataProposal.oldBinding?.value, "DEMO");
  assert.equal(dataProposal.newBinding.value, 1);
  assert.equal(dataProposal.newBinding.valueType, "count");
  assert.equal(dataProposal.newBinding.source, "intent");
});

test("normalizes fixture paths but does not require storage writes", async () => {
  const result = await diagnoseFailurePackage(path.normalize(fixture), { intentData: { count: 1 } });

  assert.equal(result.sourceFailurePackage, path.normalize(fixture));
  assert.equal(result.constraints.businessFlowWritten, false);
  assert.equal(result.constraints.dslRuleWritten, false);
  assert.equal(result.updateProposals.every((item) => item.requiresHumanConfirmation), true);
});

test("writes diagnosis sidecar without modifying original failure package", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "failure-diagnosis-sidecar-"));
  const localFailurePackage = path.join(dir, "input-red-packet-count.json");
  const sourceDom = path.resolve("tests/fixtures/failure-package/input-red-packet-count-dom.html");
  const localDom = path.join(dir, "input-red-packet-count-dom.html");
  const sourcePayload = await fs.readJson(fixture);
  sourcePayload.artifacts.dom_snapshot = localDom;
  await fs.copy(sourceDom, localDom);
  await fs.writeJson(localFailurePackage, sourcePayload, { spaces: 2 });
  const beforeHash = sha256(await fs.readFile(localFailurePackage));

  const diagnosis = await diagnoseFailurePackage(localFailurePackage, { intentData: { count: 1 } });
  const sidecarPath = await writeFailureDiagnosisSidecar({ failurePackagePath: localFailurePackage, diagnosis });
  const afterHash = sha256(await fs.readFile(localFailurePackage));
  const sidecar = await fs.readJson(sidecarPath);

  assert.equal(afterHash, beforeHash);
  assert.equal(await validateJsonFile(sidecarPath).then((result) => result.ok), true);
  assert.equal(sidecar.schemaVersion, "failure-diagnosis-sidecar.v1");
  assert.equal(sidecar.sourceFailurePackage, localFailurePackage);
  assert.equal(sidecar.writePolicy.writesMainStorage, false);
  assert.equal(sidecar.writePolicy.requiresHumanConfirmation, true);
  assert.equal(sidecar.diagnosis.schemaVersion, "failure-diagnosis.v1");
  assert.ok(sidecar.proposals.some((item: { proposalType?: string }) => item.proposalType === "DataBindingUpdateProposal"));
});

function sha256(data: Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}
