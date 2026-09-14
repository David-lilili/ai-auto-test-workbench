/**
 * P11.5-22：AI Designer 测试（A–T，20 条）。
 *
 * A actual LLM path invoked   B promptVersion   C JSON schema validation
 * D missing manual block      E missing KB block F systematic fallback
 * G manual changes behavior   H manual version   I KB changes grounding
 * J real knowledge gap        K page summary     L gold isolation
 * M LLM failure fallback      N invalid JSON     O one repair maximum
 * P repair only uncovered     Q context receipt  R AI candidate provenance
 * S AI unsupported rejected   T blind holdout isolation
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { analyzeRequirement } from "../src/requirements/pipeline.js";
import { buildCoverageObligations, systematicDesigner } from "../src/test-design/obligations.js";
import { dedupeCandidates } from "../src/test-design/engine.js";
import { buildTestDesignerPrompt, parseTestDesignerCandidates, TEST_DESIGNER_PROMPT_VERSION, type TestDesignerContext } from "../src/test-design/llm-contract.js";
import { runActualTestDesign, callAiDesigner, applyExecutionPathAwareness, validateAiCandidates, AI_DESIGN_PATH_CANNOT_IMPORT_GOLD } from "../src/test-design/ai-designer.js";
import { runTestDesignPreflight } from "../src/test-design/preflight.js";
import { GOLD_BLIND_HOLDOUT, GOLD_TEST_DESIGN, splitGoldTestDesign } from "../src/test-design/gold.js";
import type { AiChatInput, AiChatResult } from "../src/core/ai-provider.js";
import type { TestDesignInput, TestCoverageObligation } from "../src/test-design/types.js";

const ROOT = process.cwd();

function fakeInput(text: string, id: string): TestDesignInput {
  const m = analyzeRequirement({ sourceId: id, title: id, rawContent: text });
  return {
    testDesignInputId: `tdi_${id}`, requirementId: id, requirementVersion: "1.0", requirementSummary: m.summary,
    approvedFacts: [], acceptanceCriteria: m.acceptanceCriteria.map((a) => ({ acId: a.acId, statement: a.statement, origin: a.origin })),
    businessRules: m.businessRules.map((r) => ({ ruleId: r.ruleId, statement: r.statement, condition: r.condition, effect: r.effect, scope: r.scope, origin: r.origin })),
    states: m.states.map((s) => ({ entity: s.entity, fromState: s.fromState, toState: s.toState, trigger: s.trigger, explicitness: s.explicitness })),
    transitions: m.states.map((s) => ({ entity: s.entity, fromState: s.fromState, toState: s.toState, trigger: s.trigger })),
    dependencies: m.dependencies.map((d) => ({ sourceConcept: d.sourceConcept, relation: d.relation, targetConcept: d.targetConcept })),
    constraints: m.constraints.map((c) => ({ field: c.field, operator: c.operator, value: c.value, kind: c.kind })),
    securityRequirements: m.securityImplications.map((s) => ({ statement: s.description, domain: s.area })),
    affectedCapabilities: [], relevantBusinessKnowledgeRefs: [], knownUnknowns: [], resolvedAmbiguities: [], remainingNonBlockingAmbiguities: [],
    riskSummary: m.risks.map((r) => ({ domain: r.domain, level: r.level })),
    contextFingerprint: "fp-test", knowledgeSnapshotFingerprint: "ks-test"
  };
}

function modelOf(input: TestDesignInput) {
  return analyzeRequirement({ sourceId: input.requirementId, title: input.requirementId, rawContent: input.requirementSummary });
}

function ctxOf(input: TestDesignInput, obligations: TestCoverageObligation[]): TestDesignerContext {
  return { input, obligations, manualRulesApplied: [], knowledgeSnapshot: [], capabilities: [], pageSummary: undefined };
}

function jsonCandidates(obligations: TestCoverageObligation[], ids?: string[]): string {
  const target = ids ?? obligations.map((o) => o.obligationId);
  return JSON.stringify({
    candidates: target.map((id, i) => {
      const obl = obligations.find((o) => o.obligationId === id)!;
      return {
        title: `AI candidate ${i} for ${id}`, scenarioType: "POSITIVE", coveredObligationIds: [id],
        semanticActions: [{ action: "VERIFY_STATE", target: obl.subject }],
        expectedOutcomes: [{ statement: obl.expected ?? obl.subject, grounding: { kind: "REQUIREMENT", factId: obl.source } }],
        knowledgeRefs: [], manualRuleRefs: [], assumptions: [], risk: { designPriority: "HIGH", executionRisk: "MEDIUM" }, reviewStatus: "AUTO_REVIEWABLE"
      };
    })
  });
}

function queueLlm(calls: Array<{ status: "completed" | "failed" | "skipped"; rawOutput?: string }>) {
  let index = 0;
  const captured: string[] = [];
  const fn = async (input: AiChatInput): Promise<AiChatResult> => {
    captured.push(input.prompt);
    const c = calls[Math.min(index, calls.length - 1)];
    index += 1;
    if (c.status !== "completed") {
      return { status: c.status, provider: "deepseek", model: "fake", prompt: input.prompt, error: "fake fail", telemetry: { provider: "deepseek", model: "fake", status: c.status, promptChars: input.prompt.length, elapsedMs: 5, parseStatus: "not_attempted", error: "fake" } };
    }
    // 模拟真实 provider：垃圾输出 → parsedOutput undefined（parseStatus=unparseable），不抛错
    let parsed: unknown;
    try { parsed = JSON.parse(c.rawOutput ?? "{}"); } catch { parsed = undefined; }
    return { status: "completed", provider: "deepseek", model: "fake", prompt: input.prompt, rawOutput: c.rawOutput, parsedOutput: parsed, telemetry: { provider: "deepseek", model: "fake", status: "completed", promptChars: input.prompt.length, promptTokens: 100, completionTokens: 50, totalTokens: 150, elapsedMs: 5, parseStatus: parsed === undefined ? "unparseable" : "parsed", promptVersion: TEST_DESIGNER_PROMPT_VERSION } };
  };
  return { fn: fn as never, captured, callCount: () => index };
}

// ============ A–C ============

test("A. actual LLM path invoked（fake LLM → AI_DESIGNED + AI_GENERATED 候选）", async () => {
  const input = fakeInput("提现需要 Google 2FA 验证", "R_ATA");
  const obligations = buildCoverageObligations(input);
  const llm = queueLlm([{ status: "completed", rawOutput: jsonCandidates(obligations) }]);
  const result = await runActualTestDesign(ROOT, modelOf(input), { inputOverride: input, callLlm: llm.fn, preflight: false, persistReceipt: false });
  assert.equal(result.aiStatus, "AI_DESIGNED");
  assert.equal(result.telemetry.primaryCalls, 1);
  assert.ok(result.candidates.some((c) => c.origin === "AI_GENERATED"));
});

test("B. promptVersion（telemetry + receipt 均为 test-designer.v1）", async () => {
  const input = fakeInput("提现需要 Google 2FA 验证", "R_ATB");
  const obligations = buildCoverageObligations(input);
  const llm = queueLlm([{ status: "completed", rawOutput: jsonCandidates(obligations) }]);
  const result = await runActualTestDesign(ROOT, modelOf(input), { inputOverride: input, callLlm: llm.fn, preflight: false, persistReceipt: false });
  assert.ok(llm.captured[0].includes("## 已批准事实 / Coverage Obligations"));
  assert.equal(TEST_DESIGNER_PROMPT_VERSION, "test-designer.v1");
  assert.equal(result.fingerprints.prompt, "test-designer.v1");
});

test("C. JSON schema validation（合法/非法均被正确判定）", () => {
  const input = fakeInput("提现需要 Google 2FA 验证", "R_ATC");
  const obligations = buildCoverageObligations(input);
  const ctx = ctxOf(input, obligations);
  const good = JSON.parse(jsonCandidates(obligations));
  const r1 = parseTestDesignerCandidates(good, ctx);
  assert.equal(r1.valid, true);
  assert.ok(r1.candidates && r1.candidates.length === obligations.length);
  // 非法：引用不存在的 obligation
  const bad = JSON.parse(jsonCandidates(obligations));
  bad.candidates[0].coveredObligationIds = ["OBL-NOPE"];
  const r2 = parseTestDesignerCandidates(bad, ctx);
  assert.equal(r2.valid, false);
  assert.ok(r2.errors.some((e) => e.includes("OBL-NOPE")));
  // 非法：expectedOutcome 用 TESTING_TECHNIQUE grounding
  const bad2 = JSON.parse(jsonCandidates(obligations));
  bad2.candidates[0].expectedOutcomes[0].grounding = { kind: "TESTING_TECHNIQUE", note: "无来源" };
  const r3 = parseTestDesignerCandidates(bad2, ctx);
  assert.equal(r3.valid, false);
});

// ============ D–F ============

test("D. missing manual runtime block（preflight BLOCK，不产出候选、不调用 AI）", async () => {
  const input = fakeInput("提现需要 Google 2FA 验证", "R_ATD");
  const preflight = { pass: false, checks: [{ name: "TEST_DESIGN_MANUAL", ok: false, detail: "0 manuals" }], missing: ["TEST_DESIGN_MANUAL"] };
  const result = await runActualTestDesign(ROOT, modelOf(input), { inputOverride: input, preflightResult: preflight, persistReceipt: false });
  assert.equal(result.aiStatus, "NOT_INVOKED");
  assert.equal(result.candidates.length, 0);
  assert.equal(result.readiness.status, "BLOCKED");
});

test("E. missing KB runtime block（BUSINESS_KNOWLEDGE_SNAPSHOT 缺失 → BLOCK）", async () => {
  const input = fakeInput("提现需要 Google 2FA 验证", "R_ATE");
  const preflight = { pass: false, checks: [{ name: "BUSINESS_KNOWLEDGE_SNAPSHOT", ok: false, detail: "0 ACTIVE" }], missing: ["BUSINESS_KNOWLEDGE_SNAPSHOT"] };
  const result = await runActualTestDesign(ROOT, modelOf(input), { inputOverride: input, preflightResult: preflight, persistReceipt: false });
  assert.equal(result.aiStatus, "NOT_INVOKED");
  assert.equal(result.candidates.length, 0);
  assert.ok(result.blocked?.missing.includes("BUSINESS_KNOWLEDGE_SNAPSHOT"));
});

test("F. systematic internal fallback（LLM 失败 → baseline 保底 + AI_DESIGNER_UNAVAILABLE）", async () => {
  const input = fakeInput("提现需要 Google 2FA 验证", "R_ATF");
  const llm = queueLlm([{ status: "failed", rawOutput: undefined }]);
  const result = await runActualTestDesign(ROOT, modelOf(input), { inputOverride: input, callLlm: llm.fn, preflight: false, persistReceipt: false });
  assert.equal(result.aiStatus, "AI_DESIGNER_UNAVAILABLE");
  assert.equal(result.telemetry.failures, 1);
  assert.equal(result.telemetry.fallbackRate, 1);
  assert.ok(result.candidates.length >= 2, "baseline 保底候选存在");
  assert.ok(!result.candidates.some((c) => c.origin === "AI_GENERATED"), "未假装 AI 参与");
});

// ============ G–I ============

test("G. manual changes behavior（WITH manual → 技术候选出现）", () => {
  const input = fakeInput("提现金额最小 10 USDT；修改地址后免验证失效；提现提交时需要 Google 2FA", "R_ATG");
  const obligations = buildCoverageObligations(input);
  const manual = [
    { rule: { manualId: "TD.BOUNDARY", ruleId: "TD.BOUNDARY.01", name: "NUMERIC_MIN_MAX", appliesWhen: "numeric", producesScenarioTypes: [] as never[] }, reason: "numeric" },
    { rule: { manualId: "TD.DEP", ruleId: "TD.DEP.01", name: "DEPENDENCY_LIFECYCLE", appliesWhen: "dep", producesScenarioTypes: [] as never[] }, reason: "dep" },
    { rule: { manualId: "TD.SEC", ruleId: "TD.SEC.02", name: "VERIFICATION_FLOW", appliesWhen: "security", producesScenarioTypes: [] as never[] }, reason: "security" }
  ];
  const without = systematicDesigner(input, obligations, []);
  const withM = systematicDesigner(input, obligations, manual);
  const techniqueRules = ["TD.DEP.01", "TD.BOUNDARY.01", "TD.SEC.02"];
  const count = (cands: typeof withM.candidates) => cands.flatMap((c) => c.manualRuleRefs).filter((r) => techniqueRules.includes(r)).length;
  assert.ok(count(withM.candidates) > count(without.candidates), "manual 规则真实改变设计行为");
});

test("H. manual version changes behavior（v2 增加生命周期）", () => {
  const input = fakeInput("修改地址后免验证失效", "R_ATH");
  const obligations = buildCoverageObligations(input);
  const mk = (ruleId: string) => [{ rule: { manualId: "TD.DEP", ruleId, name: "R", appliesWhen: "dep", producesScenarioTypes: [] as never[] }, reason: "dep" }];
  const v1 = systematicDesigner(input, obligations, mk("TD.DEP.NONE"));
  const v2 = systematicDesigner(input, obligations, mk("TD.DEP.01"));
  const phases = ["before", "transition", "after", "re-entry"];
  const hasLifecycle = (cands: typeof v2.candidates) => cands.some((c) => phases.every((p) => c.preconditions.some((pc) => pc.statement === p)));
  assert.ok(!hasLifecycle(v1.candidates));
  assert.ok(hasLifecycle(v2.candidates));
});

test("I. KB changes grounding（WITH KB → KNOWLEDGE grounding 出现）", () => {
  const input = fakeInput("提现提交时需要 Google 2FA 二次验证", "R_ATI");
  const obligations = buildCoverageObligations(input);
  const secObl = obligations.find((o) => o.type === "SECURITY")!;
  const kb = [{ knowledgeId: "KB-SEC-001", canonicalConcept: `${secObl.subject}：提交提现需要 Google 2FA 二次验证` }];
  const without = systematicDesigner(input, obligations, []);
  const withKb = systematicDesigner(input, obligations, [], { knowledge: kb });
  const knowledgeGrounded = (cands: typeof withKb.candidates) => cands.some((c) => c.expectedOutcomes.some((e) => e.grounding.kind === "KNOWLEDGE" && e.grounding.knowledgeId === "KB-SEC-001"));
  assert.ok(!knowledgeGrounded(without.candidates));
  assert.ok(knowledgeGrounded(withKb.candidates));
});

// ============ J–L ============

test("J. real knowledge gap（不脑补 expected → NEEDS_BUSINESS_REVIEW）", () => {
  const input = fakeInput("开启提现加速功能后提现状态会变化", "R_ATJ");
  const obligations = buildCoverageObligations(input);
  obligations.push({
    obligationId: "OBL-GAP-1", source: "ac_gap", type: "ACCEPTANCE_CRITERION", subject: "开启提现加速功能后提现状态会变化",
    condition: undefined, expected: undefined, criticality: "HIGH", requiredScenarioTypes: ["POSITIVE"],
    provenance: { sourceId: "R_ATJ", anchor: "ac_gap" }, isSecurity: false
  });
  const designed = systematicDesigner(input, obligations, [], { knowledge: [] });
  const gapCandidate = designed.candidates.find((c) => c.coveredObligationIds.includes("OBL-GAP-1"))!;
  assert.ok(designed.knowledgeGaps.some((g) => g.includes("OBL-GAP-1")));
  assert.equal(gapCandidate.expectedOutcomes.length, 0, "不得脑补 expected");
  assert.equal(gapCandidate.reviewStatus, "NEEDS_BUSINESS_REVIEW");
  assert.equal(gapCandidate.testability, "BLOCKED_BY_KNOWLEDGE");
});

test("K. page summary awareness（执行路径感知提升，recall 不变）", () => {
  const input = fakeInput("提现需要 Google 2FA 验证", "R_ATK");
  const obligations = buildCoverageObligations(input);
  const designed = systematicDesigner(input, obligations, []);
  const aware = applyExecutionPathAwareness(designed.candidates, { actions: ["SUBMIT_WITHDRAWAL", "VERIFY_STATE"] });
  const awareCount = aware.filter((c) => c.testability === "EXECUTION_PATH_KNOWN" || c.testability === "EXECUTION_PATH_PARTIAL").length;
  assert.ok(awareCount > 0, "page summary 提升执行路径感知");
  assert.equal(aware.length, designed.candidates.length, "候选数量不变（不改 recall）");
});

test("L. gold isolation（runtime 模块禁止 import gold + 哨兵导出）", () => {
  const runtimeModules = [
    "src/test-design/designer.ts", "src/test-design/llm-contract.ts", "src/test-design/ai-designer.ts",
    "src/test-design/obligations.ts", "src/test-design/engine.ts", "src/test-design/preflight.ts"
  ];
  for (const f of runtimeModules) {
    const text = fs.readFileSync(path.join(ROOT, f), "utf8");
    assert.ok(!/from\s+["'].*gold.*["']/i.test(text), `${f} 不得 import gold`);
  }
  assert.equal(AI_DESIGN_PATH_CANNOT_IMPORT_GOLD, "AI_DESIGN_PATH_CANNOT_IMPORT_GOLD");
});

// ============ M–P ============

test("M. LLM failure fallback（timeout/502 → AI_DESIGNER_UNAVAILABLE）", async () => {
  const input = fakeInput("提现需要 Google 2FA", "R_ATM");
  const obligations = buildCoverageObligations(input);
  const llm = queueLlm([{ status: "failed", rawOutput: undefined }]);
  const outcome = await callAiDesigner({ rootDir: ROOT, ctx: ctxOf(input, obligations), callLlm: llm.fn });
  assert.equal(outcome.status, "AI_DESIGNER_UNAVAILABLE");
  assert.equal(outcome.candidates.length, 0);
});

test("N. invalid JSON fallback（LLM 返回垃圾 → 不产出 AI 候选）", async () => {
  const input = fakeInput("提现需要 Google 2FA", "R_ATN");
  const obligations = buildCoverageObligations(input);
  const llm = queueLlm([{ status: "completed", rawOutput: "{ this is not json" }]);
  const outcome = await callAiDesigner({ rootDir: ROOT, ctx: ctxOf(input, obligations), callLlm: llm.fn });
  assert.equal(outcome.status, "AI_DESIGNER_UNAVAILABLE");
  assert.equal(outcome.candidates.length, 0);
});

test("O. one repair maximum（最多 1 次 repair，不追加第二次）", async () => {
  const input = fakeInput("提现需要 Google 2FA 验证，地址必填", "R_ATO");
  const obligations = buildCoverageObligations(input);
  const covered = obligations[0].obligationId;
  const rest = obligations.slice(1).map((o) => o.obligationId);
  const llm = queueLlm([
    { status: "completed", rawOutput: jsonCandidates(obligations, [covered]) },
    { status: "completed", rawOutput: jsonCandidates(obligations, rest) },
    { status: "completed", rawOutput: jsonCandidates(obligations) } // 第三个绝不应被消费
  ]);
  const result = await runActualTestDesign(ROOT, modelOf(input), { inputOverride: input, baselineOverride: [], callLlm: llm.fn, preflight: false, persistReceipt: false });
  assert.equal(llm.callCount(), 2, "只允许 primary + 1 repair");
  assert.equal(result.telemetry.primaryCalls, 1);
  assert.equal(result.telemetry.repairCalls, 1);
  assert.equal(result.coverage.covered, result.coverage.total);
});

test("P. repair only uncovered（repair prompt 只含 uncovered obligations）", async () => {
  const input = fakeInput("提现需要 Google 2FA 验证，地址必填", "R_ATP");
  const obligations = buildCoverageObligations(input);
  const covered = obligations[0].obligationId;
  const rest = obligations.slice(1).map((o) => o.obligationId);
  const llm = queueLlm([
    { status: "completed", rawOutput: jsonCandidates(obligations, [covered]) },
    { status: "completed", rawOutput: jsonCandidates(obligations, rest) }
  ]);
  await runActualTestDesign(ROOT, modelOf(input), { inputOverride: input, baselineOverride: [], callLlm: llm.fn, preflight: false, persistReceipt: false });
  const repairPrompt = llm.captured[1];
  assert.ok(rest.every((id) => repairPrompt.includes(id)), "repair 包含所有 uncovered");
  assert.ok(!repairPrompt.includes(covered), "repair 不含已覆盖 obligation");
  assert.ok(repairPrompt.includes("repair pass"), "repair 输入带 repair 标记");
});

// ============ Q–T ============

test("Q. context receipt（指纹/manualVersions/promptVersion/model 持久化）", async () => {
  const input = fakeInput("提现需要 Google 2FA 验证", "R_ATQ");
  const obligations = buildCoverageObligations(input);
  const llm = queueLlm([{ status: "completed", rawOutput: jsonCandidates(obligations) }]);
  await runActualTestDesign(ROOT, modelOf(input), { inputOverride: input, callLlm: llm.fn, preflight: false, persistReceipt: true });
  const receiptsPath = path.join(ROOT, "storage", "test-design-candidates", "receipts.json");
  assert.ok(fs.existsSync(receiptsPath), "receipt 文件存在");
  const receipts = JSON.parse(fs.readFileSync(receiptsPath, "utf8")) as Record<string, Record<string, unknown>>;
  const receipt = receipts["R_ATQ"];
  assert.ok(receipt, "R_ATQ receipt 已写入");
  assert.equal(receipt.promptVersion, "test-designer.v1");
  assert.equal(receipt.contextFingerprint, "fp-test");
  assert.ok(typeof receipt.knowledgeFingerprint === "string" && receipt.knowledgeFingerprint.length > 0, "knowledgeFingerprint 为真实快照哈希");
  assert.equal((receipt.telemetry as { primaryCalls: number }).primaryCalls, 1);
  assert.ok(receipt.model, "model 记录");
  assert.ok(typeof receipt.selectedManualRules === "object", "selectedManualRules 记录");
});

test("R. AI candidate provenance（origin=AI_GENERATED + provenance 可追溯）", async () => {
  const input = fakeInput("提现需要 Google 2FA 验证", "R_ATR");
  const obligations = buildCoverageObligations(input);
  const llm = queueLlm([{ status: "completed", rawOutput: jsonCandidates(obligations) }]);
  const result = await runActualTestDesign(ROOT, modelOf(input), { inputOverride: input, callLlm: llm.fn, preflight: false, persistReceipt: false });
  const aiCands = result.candidates.filter((c) => c.origin === "AI_GENERATED");
  assert.ok(aiCands.length > 0);
  for (const c of aiCands) {
    assert.ok(c.provenance.length > 0, "provenance 存在");
    assert.ok(c.provenance[0].reason.includes("ai-designer"));
    assert.ok(c.coveredObligationIds.every((id) => result.obligations.some((o) => o.obligationId === id)));
  }
});

test("S. AI unsupported rejected（TESTING_TECHNIQUE expected → 整体 schema 拒绝）", async () => {
  const input = fakeInput("提现需要 Google 2FA", "R_ATS");
  const obligations = buildCoverageObligations(input);
  const ctx = ctxOf(input, obligations);
  // 构造一条 TESTING_TECHNIQUE grounding 的候选 → parse 层拒绝
  const parsed = parseTestDesignerCandidates(JSON.parse(jsonCandidates(obligations)), ctx);
  assert.equal(parsed.valid, true);
  const bad = JSON.parse(jsonCandidates(obligations));
  bad.candidates[0].expectedOutcomes[0].grounding = { kind: "TESTING_TECHNIQUE", note: "无来源" };
  const r = parseTestDesignerCandidates(bad, ctx);
  assert.equal(r.valid, false);
  // gauntlet 层：factId 不存在 → rejected
  const bad2 = JSON.parse(jsonCandidates(obligations));
  bad2.candidates[0].expectedOutcomes[0].grounding = { kind: "REQUIREMENT", factId: "NOT-A-FACT" };
  const parsed2 = parseTestDesignerCandidates(bad2, ctx);
  assert.equal(parsed2.valid, false);
  const validation = validateAiCandidates([{
    title: "t", scenarioType: "POSITIVE" as const, coveredObligationIds: [obligations[0].obligationId],
    semanticActions: [{ action: "VERIFY_STATE", target: "x" }],
    expectedOutcomes: [{ statement: "s", grounding: { kind: "REQUIREMENT", factId: "NOT-A-FACT" } }],
    knowledgeRefs: [], manualRuleRefs: [], assumptions: [], risk: { designPriority: "HIGH", executionRisk: "MEDIUM" }, reviewStatus: "AUTO_REVIEWABLE"
  }], ctx, []);
  assert.ok(validation.rejected.length === 1, "无效 factId 候选被拒");
});

test("T. blind holdout isolation（bh 集与校准集完全隔离）", () => {
  const goldIds = new Set(GOLD_TEST_DESIGN.map((g) => g.id));
  const bhIds = GOLD_BLIND_HOLDOUT.map((g) => g.id);
  assert.ok(bhIds.every((id) => !goldIds.has(id)), "blind holdout 与既有 gold 隔离");
  assert.ok(bhIds.length >= 5, "至少 5 条 blind holdout");
  const { holdout } = splitGoldTestDesign();
  assert.ok(!holdout.some((g) => bhIds.includes(g.id)), "旧 holdout 不含 blind 集");
});
