import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "fs-extra";
import { createLocalAiStageEnvelope, assertAiStageEnvelope, type ProviderCallRecord } from "../src/core/ai-orchestration-schema.js";
import { writeCodexFailurePackage } from "../src/core/codex-failure-package.js";
import type { DslStep, FailureReport, LoadedContext, StepExecution } from "../src/core/types.js";

test("creates schema-valid AI stage envelopes", () => {
  const envelope = createLocalAiStageEnvelope({
    stage: "coverage_explanation",
    inputSummary: { requiredGoals: ["write_goal"] },
    parsedOutput: { ok: true },
    evidence: [{ source: "business_flow", id: "flow:create_red_packet", confidence: 0.9 }],
    confidence: 0.8,
    uncertainty: []
  });

  assert.doesNotThrow(() => assertAiStageEnvelope(envelope));
  assert.equal(envelope.schemaVersion, "ai-stage-envelope.v1");
  assert.equal(envelope.schemaValid, true);
  assert.equal(envelope.evidence[0].source, "business_flow");
});

test("execution failure package keeps providerCalls timeline", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-auto-provider-calls-"));
  const context: LoadedContext = {
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
  const step: DslStep = { id: "email-code", action: "input", semantic_target: "email verification code", valueFrom: { type: "verificationCode", provider: "redis" } };
  const record: StepExecution = {
    step_id: "step-1",
    dsl_step_id: "email-code",
    action: "input",
    status: "failed",
    start_time: new Date().toISOString(),
    end_time: new Date().toISOString(),
    duration_ms: 10,
    fallback_level_used: 0,
    error_message: "provider failed"
  };
  const report: Omit<FailureReport, "report_id" | "created_at"> = {
    run_id: "run-1",
    case_id: "case-1",
    step_id: "step-1",
    category: "test_data_failed",
    failed_step: step,
    failed_layer: 0,
    error_message: "provider failed",
    attempted_locators: [],
    suggested_fix: "check provider configuration"
  };
  const startedAt = new Date().toISOString();
  const providerCalls: ProviderCallRecord[] = [{
    provider: "redis",
    operation: "get_verification_code",
    scene: "email",
    startedAt,
    endedAt: startedAt,
    elapsedMs: 0,
    status: "failed",
    errorCode: "timeout",
    errorMessage: "timeout",
    requestSummary: { keyPattern: "email:{env}:{scene}:{account}" }
  }];

  const result = await writeCodexFailurePackage({ context, runId: "run-1", caseId: "case-1", step, record, report, providerCalls });
  const payload = await fs.readJson(result.packagePath);

  assert.equal(payload.schemaVersion, "failure-package.v1");
  assert.equal(payload.executionStarted, true);
  assert.equal(payload.failureStage, "provider");
  assert.equal(payload.providerCalls.length, 1);
  assert.equal(payload.providerCalls[0].provider, "redis");
});

test("network changed execution failure is classified as external_interrupt", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-auto-external-interrupt-"));
  const context: LoadedContext = {
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
  const step: DslStep = { id: "open", action: "navigate", target: "http://www.example.com/zh-hans/assets/red-packet" };
  const message = "page.goto: net::ERR_NETWORK_CHANGED at http://www.example.com/zh-hans/assets/red-packet";
  const record: StepExecution = {
    step_id: "step-1",
    dsl_step_id: "open",
    action: "navigate",
    status: "failed",
    start_time: new Date().toISOString(),
    end_time: new Date().toISOString(),
    duration_ms: 10,
    fallback_level_used: 0,
    error_message: message
  };
  const report: Omit<FailureReport, "report_id" | "created_at"> = {
    run_id: "run-1",
    case_id: "case-1",
    step_id: "step-1",
    category: "page_transition_failed",
    failed_step: step,
    failed_layer: 0,
    error_message: message,
    attempted_locators: [],
    suggested_fix: "network changed"
  };

  const result = await writeCodexFailurePackage({ context, runId: "run-1", caseId: "case-1", step, record, report });
  const payload = await fs.readJson(result.packagePath);

  assert.equal(payload.failureStage, "external_interrupt");
});

test("assertion failure package includes page evidence fields", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-auto-assertion-evidence-"));
  const artifactDir = path.join(rootDir, "artifacts", "execution", "run-assert");
  await fs.ensureDir(artifactDir);
  const afterDomPath = path.join(artifactDir, "assertion-1-after-dom.html");
  const visibleTextSnapshotPath = path.join(artifactDir, "assertion-1-visible-text-snapshot.json");
  const assertionEvidencePath = path.join(artifactDir, "assertion-1-assertion-evidence.json");
  await fs.writeFile(afterDomPath, "<html><body>创建失败 验证码错误</body></html>", "utf8");
  await fs.writeJson(visibleTextSnapshotPath, {
    capturedAt: "2026-07-15T00:00:00.000Z",
    url: "http://www.example.com/zh-hans/assets/red-packet",
    title: "Red Packet",
    visibleTexts: ["创建失败", "验证码错误"]
  });
  await fs.writeJson(assertionEvidencePath, {
    expectedAssertions: ["创建成功", "成功"],
    matchedAssertions: [],
    unmatchedAssertions: ["创建成功", "成功"],
    assertionWaitMs: 8000,
    assertionError: "None of expected texts became visible",
    assertionActual: { typeValues: [], empty: false },
    assertionDiagnostics: {
      requestedColumn: "类型",
      expected: "转入",
      observedHeaders: ["币种", "时间", "类型", "金额"],
      selectedFilters: [],
      rowSample: ["USDT", "2026-07-20 08:26:50", "转入", "50"],
      extractionStrategy: "dom_table_headers_and_cells",
      tableReadiness: { loading: false, headersReady: true, rowsReady: true, rowCount: 1 },
      columnResolution: { requestedColumn: "类型", matchedHeaderIndex: 2, observedHeaders: ["币种", "时间", "类型", "金额"] },
      trace: [
        {
          source: "dom",
          rootCause: "values_extracted",
          observedHeaders: ["币种", "时间", "类型", "金额"],
          selectedFilters: [],
          rowSample: ["USDT", "2026-07-20 08:26:50", "转入", "50"],
          typeValues: ["转入"],
          empty: false,
          loading: false
        }
      ],
      rootCause: "values_extracted"
    },
    afterScreenshotPath: path.join(artifactDir, "assertion-1-after.png"),
    afterDomPath,
    visibleTextSnapshotPath
  });
  const context: LoadedContext = {
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
  const step: DslStep = { id: "assertion-1", action: "assert", assertion: { type: "textVisibleAny", expected: ["创建成功", "成功"] } };
  const record: StepExecution = {
    step_id: "step-assert",
    run_id: "run-assert",
    dsl_step_id: "assertion-1",
    action_type: "assert",
    status: "failed",
    duration_ms: 8010,
    fallback_level_used: 0,
    error_message: "None of expected texts became visible",
    ai_used: false,
    token_input: 0,
    token_output: 0,
    estimated_cost: 0,
    after_screenshot_path: path.join(artifactDir, "assertion-1-after.png"),
    assertion_after_dom_path: afterDomPath,
    visible_text_snapshot_path: visibleTextSnapshotPath,
    assertion_evidence_path: assertionEvidencePath,
    final_url: "http://www.example.com/zh-hans/assets/red-packet",
    final_title: "Red Packet",
    final_visible_texts: ["创建失败", "验证码错误"],
    network_summary: {
      enabled: false,
      requests: [],
      matchedBusinessApis: [],
      limitations: ["network listener is not available in current executor"]
    }
  };
  const report: Omit<FailureReport, "report_id" | "created_at"> = {
    run_id: "run-assert",
    case_id: "case-assert",
    step_id: "step-assert",
    category: "assertion_failed",
    failed_step: step,
    failed_layer: 0,
    error_message: "None of expected texts became visible",
    screenshot_path: record.after_screenshot_path,
    dom_snapshot_path: record.assertion_after_dom_path,
    attempted_locators: ["assertion"],
    suggested_fix: "check assertion candidates"
  };

  const result = await writeCodexFailurePackage({ context, runId: "run-assert", caseId: "case-assert", step, record, report });
  const payload = await fs.readJson(result.packagePath);

  assert.equal(payload.failureStage, "assertion");
  assert.deepEqual(payload.assertionEvidence.unmatchedAssertions, ["创建成功", "成功"]);
  assert.equal(payload.finalPageState.url, "http://www.example.com/zh-hans/assets/red-packet");
  assert.equal(payload.finalPageState.visibleTexts.includes("验证码错误"), true);
  assert.equal(payload.networkSummary.enabled, false);
  assert.equal(payload.artifacts.assertion_after_dom, path.relative(rootDir, afterDomPath));
  assert.equal(payload.aiDiagnosticLog.schemaVersion, "ai-diagnostic-log.v1");
  assert.equal(payload.aiDiagnosticLog.failure.stage, "assertion");
  assert.equal(payload.aiDiagnosticLog.step.id, "assertion-1");
  assert.equal(payload.aiDiagnosticLog.artifacts.assertionAfterDom, path.relative(rootDir, afterDomPath));
  assert.ok(payload.aiDiagnosticLog.diagnosisHints.includes("assertion_observable_mismatch"));
  assert.ok(payload.aiDiagnosticLog.diagnosisHints.includes("assertion_extraction_trace_available"));
  assert.equal(payload.assertionEvidence.columnResolutionTrace.matchedHeaderIndex, 2);
  assert.equal(payload.assertionEvidence.assertionExtractionTrace[0].source, "dom");
  assert.equal(payload.aiDiagnosticLog.assertionEvidence.tableReadinessTrace.headersReady, true);
});
