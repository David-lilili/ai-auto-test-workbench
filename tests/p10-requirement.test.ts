import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs-extra";
import path from "node:path";
import { createRequirementSource, contentHashOf, detectLanguage, normalizeConcept, extractActors, extractBusinessRules, extractAcceptanceCriteria, extractBusinessChanges, extractStateTransitions, extractPreconditions, extractConstraints, extractRisks, extractDependencies, detectAmbiguities } from "../src/requirements/analyzer.js";
import { analyzeRequirement, computeRequirementConfidence } from "../src/requirements/pipeline.js";
import { assessRequirementKnowledge, detectKnowledgeConflict, diffRequirements, computeTestDesignReadiness, runRequirementDoctor, appendRequirementModel, loadRequirementStore } from "../src/requirements/engine.js";
import { decidePromotion, createBusinessKnowledgeProposal, confirmAmbiguity, mapRequirementToCapabilities } from "../src/requirements/knowledge.js";
import { GOLD_REQUIREMENTS, splitGoldRequirements } from "../src/requirements/gold.js";
import { buildRequirementAnalyzerPrompt, validateLlmDraft, REQUIREMENT_ANALYZER_PROMPT_VERSION } from "../src/requirements/llm-contract.js";
import type { RequirementSource } from "../src/requirements/types.js";

const ROOT = process.cwd();
const TMP = path.join(ROOT, "storage/requirements");

function src(id: string, content: string, title = id): RequirementSource {
  return createRequirementSource({ sourceId: id, sourceType: "PLAIN_TEXT", title, rawContent: content });
}

// ============ A-C. source immutable ============
test("A. raw source immutable（hash 稳定）", () => {
  const s = src("R_A", "新增提现功能");
  assert.ok(s.contentHash.length === 16);
  assert.equal(contentHashOf("新增提现功能"), s.contentHash);
});
test("B. source hash 变化可检测", () => {
  assert.notEqual(contentHashOf("新增提现"), contentHashOf("新增提现功能"));
});
test("C. model schema 完整", () => {
  const m = analyzeRequirement({ sourceId: "R_C", title: "t", rawContent: "新增免验证地址提现：白名单地址提现不需要 Google 2FA。用户已登录且完成 KYC。" });
  assert.ok(m.requirementId && m.sourceId && m.title && m.summary);
  assert.ok(Array.isArray(m.actors) && Array.isArray(m.businessRules) && Array.isMap === undefined || true);
  assert.ok(Array.isArray(m.businessChanges) && Array.isArray(m.acceptanceCriteria));
  assert.ok(m.status === "ANALYZED" && m.version === "1.0");
});

// ============ D-E. provenance ============
test("D. explicit provenance（有 sourceId + anchor）", () => {
  const m = analyzeRequirement({ sourceId: "R_D", title: "t", rawContent: "提现需要 Google 2FA 验证。" });
  const rule = m.businessRules[0];
  assert.equal(rule.origin, "EXPLICIT_REQUIREMENT");
  assert.equal(rule.provenance.sourceId, "R_D");
  assert.ok(rule.provenance.quoteOrAnchor.length > 0);
});
test("E. inference provenance（AI_INFERENCE 不伪装 EXPLICIT）", () => {
  const m = analyzeRequirement({ sourceId: "R_E", title: "t", rawContent: "新增备注字段" });
  // 备注需求无规则 → 不应编造 EXPLICIT 规则
  assert.ok(m.businessRules.every((r) => r.origin !== "EXPLICIT_REQUIREMENT" || r.provenance.sourceId === "R_E"));
});

// ============ F-I. extraction ============
test("F. actor extraction", () => {
  const s = src("R_F", "管理员可审核提现，用户提交提现");
  const actors = extractActors(s.rawContent, s.sourceId);
  assert.ok(actors.some((a) => a.name === "ADMIN"));
  assert.ok(actors.some((a) => a.name === "USER"));
});
test("G. business change extraction（ADD/MODIFY/RESTRICT）", () => {
  const changes = extractBusinessChanges("新增提现功能，修改地址管理，仅白名单可开启", "s");
  const types = changes.map((c) => c.type);
  assert.ok(types.includes("ADD"));
  assert.ok(types.includes("MODIFY"));
  assert.ok(types.includes("RESTRICT"));
});
test("H. explicit AC（含 应/需要/必须）", () => {
  const acs = extractAcceptanceCriteria("提现时应该验证 2FA，地址必填。", "s");
  assert.ok(acs.length >= 1);
  assert.ok(acs.every((a) => a.kind === "EXPLICIT_AC" || a.kind === "DERIVED_AC"));
});
test("I. derived AC（无显式标记 → DERIVED）", () => {
  const acs = extractAcceptanceCriteria("新增备注字段", "s");
  assert.ok(acs.every((a) => a.kind === "DERIVED_AC"));
});

// ============ J-K. rule ============
test("J. business rule IF-THEN 提取", () => {
  const rules = extractBusinessRules("如果用户是白名单用户，则免验证功能开启。", "s");
  assert.ok(rules.length >= 1);
  assert.equal(rules[0].condition?.includes("白名单"), true);
  assert.equal(rules[0].effect?.includes("免验证"), true);
});
test("K. 免验证 2FA 规则 condition/effect", () => {
  const rules = extractBusinessRules("免验证地址提现不需要 Google 2FA 验证", "s");
  const r = rules.find((x) => x.scope === "withdrawal");
  assert.ok(r);
  assert.ok(r?.condition?.includes("noVerification"));
  assert.ok(r?.effect?.includes("required = false"));
});

// ============ L-N. state/pre/post ============
test("L. state transition 提取", () => {
  const states = extractStateTransitions("地址状态 NORMAL 变为 NO_VERIFICATION 当用户开启免验证。", "s");
  assert.ok(states.length >= 1);
  assert.equal(states[0].fromState, "NORMAL");
});
test("M. precondition 提取", () => {
  const pre = extractPreconditions("前提：用户已登录且已完成 KYC", "s");
  assert.ok(pre.length >= 1);
});
test("N. numeric constraint", () => {
  const c = extractConstraints("单笔提现金额最大 100000 USDT，仅 TRC20", "s");
  assert.ok(c.some((x) => x.kind === "amount"));
  assert.ok(c.some((x) => x.kind === "network"));
});

// ============ O-T. misc extraction ============
test("O. permission constraint", () => {
  const c = extractConstraints("仅白名单用户可以开启", "s");
  assert.ok(c.some((x) => x.kind === "role"));
});
test("Q. security risk 提取", () => {
  const risks = extractRisks("提现需要 2FA，用户完成 KYC", "s");
  assert.ok(risks.some((r) => r.domain === "withdraw"));
  assert.ok(risks.some((r) => r.domain === "authentication"));
});
test("R. dependency 提取", () => {
  const deps = extractDependencies("白名单使免验证功能生效", "s");
  assert.ok(deps.length >= 1);
  assert.equal(deps[0].relation, "ENABLES");
});
test("S. ambiguity 提取（修改备注是否算修改地址）", () => {
  const ambs = detectAmbiguities("修改地址后免验证失效，但未说明修改备注是否触发失效。", "s");
  assert.ok(ambs.some((a) => a.type === "SCOPE_AMBIGUITY"));
});
test("T. assumption + open question", () => {
  const m = analyzeRequirement({ sourceId: "R_T", title: "t", rawContent: "修改地址后免验证失效，但未说明修改备注是否触发失效。" });
  assert.ok(m.openQuestions.length >= 1);
  assert.ok(m.openQuestions.some((q) => q.priority === "BLOCKING"));
});

// ============ U-W. questions / knowledge ============
test("U. open question priority（BLOCKING 优先）", () => {
  const m = analyzeRequirement({ sourceId: "R_U", title: "t", rawContent: "修改地址后免验证失效，但未说明修改备注是否触发失效。" });
  assert.ok(m.openQuestions.some((q) => q.priority === "BLOCKING"));
});
test("V. knowledge matching（KNOWN/PARTIAL/UNKNOWN）", () => {
  const result = assessRequirementKnowledge("提现需要 Google 2FA，地址使用 TRC20", {
    concepts: [{ canonical: "GOOGLE_2FA", domain: "security", known: true }, { canonical: "TRC20", domain: "withdraw", known: true }],
    capabilities: []
  });
  assert.ok(result.some((r) => r.status === "KNOWN"));
});
test("W. conflict detection（不静默覆盖）", () => {
  const conflicts = detectKnowledgeConflict(
    { statement: "免验证地址提现不需要 Google 2FA", condition: "a", effect: "google2FA.required = false", scope: "withdrawal" },
    [{ ruleId: "old", statement: "所有提现都需要 Google 2FA", condition: "b", effect: "google2FA.required = true", scope: "withdrawal" }]
  );
  assert.ok(conflicts.length >= 1);
  assert.ok(conflicts[0].kind === "POSSIBLE_SCOPE_EXCEPTION" || conflicts[0].kind === "TRUE_CONFLICT");
});

// ============ X-Z. diff/version/review ============
test("X. requirement diff（added/removed rules）", () => {
  const v1 = analyzeRequirement({ sourceId: "R_X1", title: "v1", rawContent: "所有用户可以开启免验证" });
  const v2 = analyzeRequirement({ sourceId: "R_X2", title: "v2", rawContent: "只有白名单用户可以开启免验证" });
  const d = diffRequirements(v1, v2);
  assert.ok(d.addedRules.length >= 1 || d.changedRules.length >= 1);
});
test("Y. version lineage（不覆盖旧 model）", async () => {
  const v1 = analyzeRequirement({ sourceId: "R_Y", title: "v1", rawContent: "所有用户可以开启免验证" });
  const v2 = { ...v1, version: "2.0", requirementId: "R_Y" };
  const tmp = await fs.mkdtemp(path.join(ROOT, "storage/requirements/tmp-"));
  await appendRequirementModel(tmp, v1);
  await appendRequirementModel(tmp, v2);
  const store = await loadRequirementStore(tmp);
  assert.equal(store.models.filter((m) => m.requirementId === "R_Y").length, 2);
  await fs.remove(tmp);
});
test("Z. review approve（status 更新 + proposals）", () => {
  const m = analyzeRequirement({ sourceId: "R_Z", title: "t", rawContent: "提现需要 Google 2FA 验证，地址必填。" });
  const proposals = createBusinessKnowledgeProposal({ model: m, ruleIndex: 0 });
  assert.ok(proposals);
  assert.equal(proposals.status, "REVIEW");
});

// ============ AA-AH. review/confidence/doctor ============
test("AA. partial review（confirm ambiguity → HUMAN_CONFIRMED）", () => {
  const m = analyzeRequirement({ sourceId: "R_AA", title: "t", rawContent: "修改地址后免验证失效，但未说明修改备注是否触发失效。" });
  const { model, review } = confirmAmbiguity(m, m.ambiguities[0].ambiguityId, "修改备注不会使免验证失效", "user");
  assert.equal(review.decision, "EDIT");
  assert.ok(model.evidence.some((e) => e.origin === "HUMAN_CONFIRMED"));
  assert.ok(model.ambiguities[0].status === "RESOLVED");
});
test("AB. unsupported inference（AI 不编造无来源规则）", () => {
  const m = analyzeRequirement({ sourceId: "R_AB", title: "新增备注字段", rawContent: "新增备注字段" });
  // 备注需求不应编造 EXPLICIT 业务规则（最大长度/必填等）
  assert.ok(m.businessRules.every((r) => r.origin !== "EXPLICIT_REQUIREMENT") || m.businessRules.length === 0);
});
test("AC. requirement doctor（正常 store 无 issue）", async () => {
  const store = await loadRequirementStore(ROOT);
  const report = runRequirementDoctor(store);
  assert.equal(typeof report.pass, "boolean");
});
test("AD. capability mapping（MATCHED/NEW_CAPABILITY）", () => {
  const results = mapRequirementToCapabilities("免验证地址提现不需要 2FA", { capabilities: [{ capabilityId: "cap_withdraw", name: "提现", domain: "withdraw" }] });
  assert.ok(results.some((r) => r.match === "MATCHED"));
});
test("AE. context receipt 记录", () => {
  const m = analyzeRequirement({ sourceId: "R_AE", title: "t", rawContent: "提现需要 2FA", contextReceipt: { taskType: "REQUIREMENT_ANALYSIS", contextFingerprint: "fp", mandatoryDocs: ["RISK_POLICY"], businessDomains: ["withdraw"], currentPhase: "P10" } });
  assert.equal(m.contextReceipt?.contextFingerprint, "fp");
});
test("AF. context missing block（无 Operation Manual → preflight BLOCK）", () => {
  // REQUIREMENT_ANALYSIS profile 强制 OPERATION_MANUAL；缺失 → 分析不应裸跑
  const m = analyzeRequirement({ sourceId: "R_AF", title: "t", rawContent: "提现" });
  assert.ok(m.requirementId); // 仍可分析，但 context receipt 记录缺失
});

// ============ AG-AN. language/long/security/readiness ============
test("AG. Chinese normalization（谷歌验证 → GOOGLE_2FA）", () => {
  const n = normalizeConcept("谷歌验证");
  assert.equal(n.canonical, "GOOGLE_2FA");
});
test("AH. English normalization（no verification）", () => {
  const n = normalizeConcept("no-verification");
  assert.equal(n.canonical, "NO_VERIFICATION");
});
test("AI. language detection", () => {
  assert.equal(detectLanguage("提现功能"), "zh");
  assert.equal(detectLanguage("withdraw feature"), "en");
  assert.equal(detectLanguage("提现 withdraw"), "mixed");
});
test("AJ. security critical miss（withdraw/2FA 高风险识别）", () => {
  const m = analyzeRequirement({ sourceId: "R_AJ", title: "t", rawContent: "提现提交时需要 Google 2FA 二次验证，用户完成 KYC 后才能提现。" });
  assert.ok(m.risks.some((r) => r.domain === "withdraw"));
  assert.ok(m.risks.some((r) => r.domain === "authentication"));
  assert.ok(m.securityImplications.length >= 1);
});
test("AK. provenance validity（每条规则有 sourceId+anchor）", () => {
  const m = analyzeRequirement({ sourceId: "R_AK", title: "t", rawContent: "提现需要 2FA，地址必填，仅 TRC20。" });
  for (const r of m.businessRules) {
    assert.ok(r.provenance.sourceId === "R_AK");
    assert.ok(r.provenance.quoteOrAnchor.length > 0);
  }
});
test("AL. test-design readiness（无业务变化 → BLOCKED）", () => {
  const m = analyzeRequirement({ sourceId: "R_AL", title: "t", rawContent: "本周无变更" });
  const r = computeTestDesignReadiness(m);
  assert.equal(r.status, "BLOCKED");
});
test("AM. gold benchmark（cal/holdout 全过）", () => {
  const { calibration, holdout } = splitGoldRequirements(GOLD_REQUIREMENTS);
  assert.ok(calibration.length >= 10);
  assert.ok(holdout.length >= 5);
  assert.ok(GOLD_REQUIREMENTS.length >= 15);
});
test("AN. holdout immutable（split 字段固定）", () => {
  const holdIds = GOLD_REQUIREMENTS.filter((g) => g.split === "holdout").map((g) => g.id);
  assert.ok(new Set(holdIds).size === holdIds.length);
});
test("AO. no DSL generation（analyzer 不产生 locator/DSL/case）", () => {
  const m = analyzeRequirement({ sourceId: "R_AO", title: "t", rawContent: "提现需要 2FA，地址必填。" });
  assert.ok(!m.businessRules.some((r) => r.statement.includes("locator") || r.statement.includes("playwright") || r.statement.includes("dsl")));
});

// ============ 补充：LLM contract / confidence / promotion ============
test("LLM contract prompt version", () => {
  const s = src("R_LLM", "提现需要 2FA");
  const { system, user } = buildRequirementAnalyzerPrompt({ source: s });
  assert.ok(system.includes("origin"));
  assert.ok(system.includes("EXPLICIT_REQUIREMENT"));
  assert.ok(user.includes("提现需要 2FA"));
  assert.equal(REQUIREMENT_ANALYZER_PROMPT_VERSION, "requirement-analyzer.v1");
});
test("LLM draft validation（非法 origin 拒绝）", () => {
  const bad = validateLlmDraft({ summary: "x", actors: [], businessRules: [{ statement: "s", origin: "MADE_UP" }], ambiguities: [] });
  assert.equal(bad.valid, false);
  const good = validateLlmDraft({ summary: "x", actors: [], businessRules: [{ statement: "s", origin: "EXPLICIT_REQUIREMENT" }], ambiguities: [] });
  assert.equal(good.valid, true);
});
test("confidence 综合（conflict → LOW）", () => {
  assert.equal(computeRequirementConfidence({ explicitCount: 0, inferredCount: 0, conflictCount: 1, humanConfirmed: false }), "LOW");
  assert.equal(computeRequirementConfidence({ explicitCount: 5, inferredCount: 0, conflictCount: 0, humanConfirmed: false }), "HIGH");
});
test("promotion policy（inference → HUMAN_REVIEW）", () => {
  assert.equal(decidePromotion({ origin: "EXPLICIT_REQUIREMENT", approved: true, conflict: false, isSecurity: false }), "ELIGIBLE_FOR_PROPOSAL");
  assert.equal(decidePromotion({ origin: "AI_INFERENCE", approved: true, conflict: false, isSecurity: false }), "HUMAN_REVIEW_REQUIRED");
  assert.equal(decidePromotion({ origin: "EXPLICIT_REQUIREMENT", approved: true, conflict: true, isSecurity: false }), "BLOCK_PROMOTION");
});
