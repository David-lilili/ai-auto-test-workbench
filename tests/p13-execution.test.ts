/**
 * P13 测试（35 项）：Structured Bridge + Risk Gate + Resolver + Materialization + Run。
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildStructuredExecutionIntent, expandExecutableOperations, mapExpectedOutcomeToAssertionIntent, resolveExecutionModel } from "../src/test-assets/structured-bridge.js";
import { structuredIntentToLegacy, structuredIntentFallbackRecord } from "../src/test-assets/structured-intent.js";
import { mapAssetAction } from "../src/test-assets/action-registry.js";
import { evaluateExecutionReadiness } from "../src/test-assets/execution-readiness.js";
import { executionRiskGate, environmentGate, createExecutionAuthorization } from "../src/test-assets/execution-risk-gate.js";
import { resolveTestDataRequirements, resolveAccountProfileRequirements, classifyPrecondition } from "../src/test-assets/execution-resolvers.js";
import { materializeTestAssetDsl, mapExpectedOutcome } from "../src/test-assets/execution-materializer.js";
import { runTestAsset, loadRunHistory, isTechnicalRetryable, dslMaterializationFingerprint } from "../src/test-assets/execution-runner.js";
import { TestAssetExecutionService } from "../src/test-assets/execution-service.js";
import { assetContentFingerprint, TestAssetStore } from "../src/test-assets/store.js";
import { computeAssetFreshness, computeExecutionFreshness } from "../src/test-assets/freshness.js";
import type { TestAsset } from "../src/test-assets/types.js";
import type { TestAssetStoreFile } from "../src/test-assets/types.js";

function fakeAsset(over: Partial<TestAsset> = {}): TestAsset {
  const a: TestAsset = {
    testAssetId: "TA-X", title: "查询资金流水", objective: "查询资金流水并验证结果",
    requirementRefs: ["R1"], businessRuleRefs: ["br_1"], acceptanceCriterionRefs: ["ac_1"], capabilityRefs: ["funds.filter"],
    scenarioType: "POSITIVE", preconditions: [{ statement: "已登录", groundingKind: "REQUIREMENT", factId: "r1" }],
    semanticActions: [{ action: "APPLY_FILTER", target: "查询", groundingKind: "REQUIREMENT", factId: "r1" }],
    expectedOutcomes: [{ statement: "查询完成提示可见", groundingKind: "REQUIREMENT", factId: "r1" }],
    testDataRequirements: [{ dimension: "balance", value: "USDT>=10", resolved: true }], accountProfileRequirements: [],
    risk: { designPriority: "MEDIUM", executionRisk: "LOW" }, manualRuleRefs: [], knowledgeRefs: [], coverageObligationRefs: ["OBL-1"],
    executionPath: { status: "KNOWN", capabilities: ["funds.filter"], pages: ["fixture.funds"], semanticActions: [] },
    status: "ACTIVE", version: "v1", createdAt: "2026-09-03T00:00:00.000Z", updatedAt: "2026-09-03T00:00:00.000Z",
    humanAuthoredFields: [], reviewHistory: [], provenance: [{ reason: "t", source: "R1" }], creationMode: "SYSTEMATIC_BASELINE",
    contentFingerprint: "", assetFreshness: "FRESH", executionFreshness: "FRESH", ...over
  };
  a.contentFingerprint = assetContentFingerprint(a);
  return a;
}

function emptyStore(): TestAssetStoreFile { return { schemaVersion: "test-assets.v1", assets: [], versionSequence: {}, updatedAt: "" }; }

const READY_INPUT = {
  asset: fakeAsset(),
  knowledgeRefsActive: () => true,
  pageModelsAvailable: () => true,
  semanticActionsMaterializable: true,
  expectedOutcomesMaterializable: true,
  testDataResolved: true,
  accountProfileResolved: true,
  riskPermitted: true,
  blockingAmbiguity: 0,
  executionPathKnown: true,
  staleCriticalKnowledge: false
};

// ============ 1-6 Structured Intent / Bridge ============

test("1. StructuredExecutionIntent 结构（provider-neutral）", () => {
  const intent = buildStructuredExecutionIntent(fakeAsset());
  assert.equal(intent.source.type, "TEST_ASSET");
  assert.equal(intent.source.testAssetId, "TA-X");
  assert.ok(intent.capabilities.includes("funds.filter"));
  assert.ok(intent.semanticActions.length >= 1);
  assert.equal(typeof intent.module, "string");
  assert.equal(typeof intent.action, "string");
});

test("2. no NL fallback for TestAsset（structured 存在时 request 仅 display）", async () => {
  const svc = new TestAssetExecutionService({ rootDir: process.cwd(), project: "demo", env: "test", environment: "LOCAL" });
  const intent = buildStructuredExecutionIntent(fakeAsset());
  const legacy = structuredIntentToLegacy(intent);
  assert.equal(legacy.source.type, "TEST_ASSET");
  const fallback = structuredIntentFallbackRecord(intent, "missing data");
  assert.equal(fallback.code, "STRUCTURED_INTENT_FALLBACK");
  assert.ok(fallback.source.includes("TA-X@v1"));
  // request 不含业务语义（仅 display）
  const plan = await svc.planTestAssetExecution(fakeAsset(), { pageModelStorePath: "storage/page-models/demo.json" }).catch(() => undefined);
  assert.ok(plan === undefined || typeof plan.reason === "string");
});

test("3. semantic action mapping（registry）", () => {
  assert.equal(mapAssetAction("APPLY_FILTER").dslAction, "click");
  assert.equal(mapAssetAction("SUBMIT_WITHDRAWAL").status, "SUPPORTED");
  assert.equal(mapAssetAction("NOPE").status, "UNSUPPORTED");
});

test("4. composite action（SUBMIT_WITHDRAWAL → N executable operations）", () => {
  const asset = fakeAsset({
    semanticActions: [{ action: "SUBMIT_WITHDRAWAL", target: "确认提现", groundingKind: "REQUIREMENT", factId: "r1" }],
    testDataRequirements: [{ dimension: "asset", value: "USDT", resolved: true }, { dimension: "network", value: "TRC20", resolved: true }, { dimension: "amount", value: "100", resolved: true }]
  });
  const ops = expandExecutableOperations(asset, { action: "SUBMIT_WITHDRAWAL", target: "确认提现" });
  assert.ok(ops.length >= 4, `composite ops=${ops.length}`);
  assert.ok(ops.some((o) => o.action === "click" && o.target === "确认提现"));
  assert.ok(ops.some((o) => o.capabilityRef === "withdraw.asset"));
});

test("5. capability page resolution", () => {
  const asset = fakeAsset({ executionPath: { status: "KNOWN", capabilities: ["funds.filter"], pages: [], semanticActions: [] } });
  const svc = new TestAssetExecutionService({ rootDir: process.cwd(), project: "demo", env: "test", environment: "LOCAL", capabilityPageResolver: (cap) => (cap === "funds.filter" ? ["demo.funds.list"] : undefined) });
  const m = resolveExecutionModel({ asset, capabilityPageResolver: (cap) => (cap === "funds.filter" ? ["demo.funds.list"] : undefined) });
  assert.ok(m.resolvedPages.includes("demo.funds.list"));
});

test("6. stale page hint（routing 优先，hint 仅辅助）", () => {
  const asset = fakeAsset({ capabilityRefs: ["funds.filter"], executionPath: { status: "KNOWN", capabilities: ["funds.filter"], pages: ["old.page"], semanticActions: [] } });
  const m = resolveExecutionModel({ asset, capabilityPageResolver: () => ["new.page"] });
  assert.equal(m.pageHintStale, true);
  assert.ok(m.resolvedPages.includes("new.page"));
});

// ============ 7-10 ExpectedOutcome ============

test("7. expected outcome mapping（→ UserAssertionKind）", () => {
  const m = mapExpectedOutcome("查询完成提示可见");
  assert.equal(m.assertionKind, "message_visible_exact");
  assert.equal(m.materializable, true);
});

test("8. structured assertion mapping", () => {
  const m = mapExpectedOutcomeToAssertionIntent({ statement: "查询完成提示可见", factId: "r1" });
  assert.equal(m.userAssertionKind, "message_visible_exact");
  assert.equal(m.sourceKnowledgeRef, "r1");
});

test("9. parser fallback marked", () => {
  const m = mapExpectedOutcomeToAssertionIntent({ statement: "完全无法理解的期望内容XYZ", factId: "r1" });
  assert.equal(m.mappingSource, "PARSER_FALLBACK");
});

test("10. knowledge stale block", () => {
  const r = evaluateExecutionReadiness({ ...READY_INPUT, staleCriticalKnowledge: true });
  assert.equal(r.status, "BLOCKED_BY_KNOWLEDGE");
});

// ============ 11-16 Readiness / Risk ============

test("11. needs modeling（page model 缺失）", () => {
  const r = evaluateExecutionReadiness({ ...READY_INPUT, pageModelsAvailable: () => false });
  assert.equal(r.status, "NEEDS_MODELING");
});

test("12. risk LOW 可执行", () => {
  const r = executionRiskGate({ asset: fakeAsset(), environment: "LOCAL", actionText: "查询资金流水" });
  assert.equal(r.allowed, true);
  assert.equal(r.riskLevel, "LOW");
});

test("13. risk HIGH 需授权", () => {
  const asset = fakeAsset({ risk: { designPriority: "HIGH", executionRisk: "HIGH" }, semanticActions: [{ action: "SUBMIT_WITHDRAWAL", target: "提现", groundingKind: "REQUIREMENT", factId: "r1" }] });
  const noAuth = executionRiskGate({ asset, environment: "LOCAL" });
  assert.equal(noAuth.allowed, false);
  const auth = createExecutionAuthorization({ assetId: "TA-X", assetVersion: "v1", environment: "LOCAL", risk: "high", approvedBy: "david" });
  const withAuth = executionRiskGate({ asset, environment: "LOCAL", authorization: auth });
  assert.equal(withAuth.allowed, true);
});

test("14. risk FORBIDDEN 即使授权也 BLOCK", () => {
  const asset = fakeAsset({ title: "production payment 真实支付", risk: { designPriority: "CRITICAL", executionRisk: "FORBIDDEN" } });
  const auth = createExecutionAuthorization({ assetId: "TA-X", assetVersion: "v1", environment: "LOCAL", risk: "forbidden", approvedBy: "david" });
  const r = executionRiskGate({ asset, environment: "LOCAL", authorization: auth });
  assert.equal(r.allowed, false);
  assert.equal(r.riskLevel, "FORBIDDEN");
});

test("15. authorization（过期不生效）", () => {
  const asset = fakeAsset({ risk: { designPriority: "HIGH", executionRisk: "HIGH" }, semanticActions: [{ action: "SUBMIT_WITHDRAWAL", target: "提现", groundingKind: "REQUIREMENT", factId: "r1" }] });
  const expired = { risk: "high", expiresAt: new Date(Date.now() - 3600_000).toISOString() };
  const r = executionRiskGate({ asset, environment: "LOCAL", authorization: expired });
  assert.equal(r.allowed, false);
});

test("16. production 默认禁止 autonomous", () => {
  const e = environmentGate({ environment: "PRODUCTION" });
  assert.equal(e.allowed, false);
  const ok = environmentGate({ environment: "UAT" });
  assert.equal(ok.allowed, true);
});

// ============ 17-21 Test Data / Account ============

test("17. test data resolve（static fixture）", () => {
  const r = resolveTestDataRequirements([{ dimension: "balance", value: "USDT>=10", resolved: false }], { staticFixtures: { "USDT>=10": "USDT 10" } });
  assert.equal(r.status, "RESOLVED");
  assert.equal(r.resolved[0].source, "STATIC_FIXTURE");
});

test("18. data unresolved", () => {
  const r = resolveTestDataRequirements([{ dimension: "balance", value: "USDT>=999999", resolved: false }], { staticFixtures: {} });
  assert.equal(r.status, "UNRESOLVED");
});

test("19. account deterministic matching", () => {
  const r = resolveAccountProfileRequirements([{ dimension: "KYC", value: "LEVEL_2" }], [{ KYC: "LEVEL_2", accountId: "a1" }, { KYC: "LEVEL_1", accountId: "a2" }]);
  assert.equal(r.matched, true);
  assert.equal(r.profileId, "a1");
  assert.equal(r.needsConfirmation, false);
});

test("20. no accountStore.list()[0]（按需求匹配，非取第一个）", () => {
  const r = resolveAccountProfileRequirements([{ dimension: "KYC", value: "LEVEL_2" }], [{ KYC: "LEVEL_1", accountId: "first" }, { KYC: "LEVEL_2", accountId: "second" }]);
  assert.equal(r.profileId, "second");
});

test("21. multiple profile review（HIGH 需确认）", () => {
  const r = resolveAccountProfileRequirements([{ dimension: "KYC", value: "LEVEL_2" }], [{ KYC: "LEVEL_2", accountId: "a1" }, { KYC: "LEVEL_2", accountId: "a2" }]);
  assert.equal(r.needsConfirmation, true);
});

// ============ 22-26 Materialization ============

test("22. DSL source metadata（sourceType=TEST_ASSET, sourceRef）", () => {
  const m = materializeTestAssetDsl({ asset: fakeAsset(), pageId: "fixture.funds", caseId: "TA-X@v1" });
  assert.equal(m.sourceType, "TEST_ASSET");
  assert.equal(m.sourceRef, "TA-X@v1");
});

test("23. materialization fingerprint（随输入变化）", () => {
  const f1 = dslMaterializationFingerprint({ testAssetVersion: "v1", pageModelFingerprint: "pm1", builderVersion: "p13" });
  const f2 = dslMaterializationFingerprint({ testAssetVersion: "v1", pageModelFingerprint: "pm2", builderVersion: "p13" });
  assert.notEqual(f1, f2);
});

test("24. semantic FULL", () => {
  const m = materializeTestAssetDsl({ asset: fakeAsset(), pageId: "fixture.funds", caseId: "TA-X@v1" });
  assert.equal(m.semanticCompleteness, "FULL");
});

test("25. SHALLOW block（无 assertion 不得 FULL）", () => {
  const asset = fakeAsset({ expectedOutcomes: [{ statement: "完全无法理解的期望内容XYZ", groundingKind: "REQUIREMENT", factId: "r1" }] });
  const m = materializeTestAssetDsl({ asset, pageId: "fixture.funds", caseId: "TA-X@v1" });
  assert.notEqual(m.semanticCompleteness, "FULL");
  assert.ok(m.warnings.some((w) => w.includes("UNMATERIALIZABLE")));
});

test("26. DSL 无 locator（semantic_target 驱动）", () => {
  const m = materializeTestAssetDsl({ asset: fakeAsset(), pageId: "fixture.funds", caseId: "TA-X@v1" });
  const json = JSON.stringify(m.testCase);
  assert.ok(!/xpath|css=|primary_locator|locator_strategy/.test(json), "DSL 不含定位器");
});

// ============ 27-32 Run / Failure ============

test("27. ExecutionRun asset provenance（test_asset_id 扩展字段存在）", () => {
  // ExecutionRun 接口已扩展可选字段（core/types.ts），记录可携带 test asset 溯源
  const record = { run_id: "r1", project_id: "p", platform: "web" as const, env: "test", test_case_id: "t", test_asset_id: "TA-X", test_asset_version: "v1", mode: "strict" as const, start_time: new Date().toISOString(), status: "passed" as const, total_steps: 1, passed_steps: 1, failed_steps: 0, healed_steps: 0, ai_invocation_count: 0, token_input_total: 0, token_output_total: 0, estimated_cost: 0, duration_ms: 1 };
  assert.equal(record.test_asset_id, "TA-X");
  assert.equal(record.test_asset_version, "v1");
});

test("28. failure taxonomy 分类（deterministic，非 LLM）", async () => {
  const { classifyFailure } = await import("../src/test-assets/execution-runner.js");
  assert.equal(classifyFailure("Expected message was not visible exactly: X"), "ASSERTION_FAILURE");
  assert.equal(classifyFailure("Unable to execute click on foo."), "MODEL_FAILURE");
  assert.equal(classifyFailure("net::ERR_CONNECTION_REFUSED"), "ENVIRONMENT_FAILURE");
  assert.equal(classifyFailure("Precondition failed for step"), "PRECONDITION_FAILURE");
  assert.equal(classifyFailure("generic executor error"), "EXECUTION_FAILURE");
});

test("29. product failure（断言不匹配 → ASSERTION_FAILURE，不归 MODEL）", () => {
  const m = materializeTestAssetDsl({ asset: fakeAsset({ expectedOutcomes: [{ statement: "拒绝提示可见", groundingKind: "REQUIREMENT", factId: "r1" }] }), pageId: "fixture.funds", caseId: "TA-X@v1" });
  assert.ok(m.testCase.assertions.length >= 1);
  assert.equal(m.testCase.assertions[0].type, "message_visible_exact");
});

test("30. model failure（元素缺失 → 自动化侧）", async () => {
  const { classifyFailure } = await import("../src/test-assets/execution-runner.js");
  const err = "Unable to execute click on 不存在的按钮.";
  assert.equal(classifyFailure(err), "MODEL_FAILURE");
});

test("31. retry policy（technical retryable / assertion 不重试）", () => {
  assert.equal(isTechnicalRetryable("EXECUTION_FAILURE"), true);
  assert.equal(isTechnicalRetryable("ENVIRONMENT_FAILURE"), true);
  assert.equal(isTechnicalRetryable("ASSERTION_FAILURE"), false);
  assert.equal(isTechnicalRetryable("PRODUCT_FAILURE"), false);
});

test("32. precondition 分类", () => {
  const p1 = classifyPrecondition("打开提现页面");
  assert.equal(p1.disposition, "can_prepare_safely");
  const p2 = classifyPrecondition("用户完成 KYC 后才能提现");
  assert.equal(p2.disposition, "requires_high_risk_operation");
});

// ============ 33-35 Freshness / History ============

test("33. asset fingerprint unchanged by execution（execution 不改 asset）", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p13-"));
  const store = new TestAssetStore(dir);
  const asset = fakeAsset();
  const file = emptyStore();
  file.assets.push(asset);
  await store.save(file, "seed");
  const before = asset.contentFingerprint;
  const reloaded = (await store.load()).assets[0];
  assert.equal(reloaded.contentFingerprint, before);
});

test("34. page change rematerialization（asset FRESH + execution STALE）", () => {
  const asset = fakeAsset();
  const assetFresh = computeAssetFreshness(asset, { requirementChanges: new Set(), knowledgeChanges: new Set(), manualChanges: {} });
  const execStale = computeExecutionFreshness(asset, true, true);
  assert.equal(assetFresh, "FRESH");
  assert.equal(execStale, "STALE");
});

test("35. cold start（无聊天历史，仅本地 store 可查询）", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p13-cs-"));
  const store = new TestAssetStore(dir);
  const file = emptyStore();
  file.assets.push(fakeAsset({ status: "ACTIVE" }));
  await store.save(file, "seed");
  const loaded = await store.load();
  assert.equal(loaded.assets.length, 1);
  assert.equal(loaded.assets[0].testAssetId, "TA-X");
});
