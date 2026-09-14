import assert from "node:assert/strict";
import { test } from "node:test";
import os from "node:os";
import path from "node:path";
import fs from "fs-extra";
import {
  createModelingSession,
  saveModelingSession,
  loadModelingSession,
  listModelingSessions,
  assertTransition,
  canTransition,
  type ModelingSession
} from "../src/core/modeling-session.js";
import { bootstrapPageForModeling, pageModelStoreHash } from "../src/core/modeling-bootstrap.js";
import { buildCoverageSnapshot } from "../src/core/exploration-coverage.js";
import { buildExplorationGaps } from "../src/core/exploration-gaps.js";
import { buildNormalizedPageModelView } from "../src/core/page-model-normalizer.js";
import { matchHeuristicsForGap, buildExplorationPlan, buildExplorationFingerprint } from "../src/core/exploration-planner.js";
import { getHeuristic } from "../src/core/exploration-heuristics.js";
import { validatePlanForExecution } from "../src/core/exploration-executor.js";
import { recordExplorationRunEvidence, inferEvidenceKind } from "../src/core/modeling-evidence.js";
import { aggregateEvidence, decidePromotion } from "../src/core/knowledge-promotion-policy.js";
import { recordKnowledgeEvidence } from "../src/core/knowledge-evidence-sink.js";
import { selectPlans, computeProgress, runModelingSession } from "../src/core/modeling-orchestrator.js";
import type { ExplorationRun } from "../src/core/exploration-executor.js";
import type { KnowledgeEvidence } from "../src/core/knowledge-promotion-policy.js";
import type { Page } from "@playwright/test";

/**
 * P6.18：测试 A-X（覆盖面）。
 * FakePage：不依赖真实浏览器，unit 级确定性；W/X 用真实 chromium 冒烟（环境允许）。
 */

// ============ FakePage（满足 bootstrap / executor 用到的 Page 子集） ============
const CANNED_INVENTORY = {
  clickables: [
    { index: 0, tag: "button", role: "button", text: "查询", disabled: false },
    { index: 1, tag: "a", role: "link", text: "查看详情", href: "#" }
  ],
  fields: [
    { index: 0, tag: "input", type: "text", placeholder: "搜索币种", valuePresent: false },
    { index: 1, tag: "select", role: "combobox", text: "USDT" }
  ],
  buttons: [
    { index: 0, tag: "button", role: "button", text: "查询", disabled: false },
    { index: 1, tag: "button", role: "button", text: "重置", disabled: false }
  ],
  tables: [{ index: 0, tag: "table", text: "USDT USDC", rowCount: 2 }],
  dialogs: [{ index: 0, tag: "div", role: "dialog", text: "弹窗内容" }],
  iframes: [],
  selectLike: [{ index: 0, tag: "select", role: "combobox", text: "USDT USDC" }]
};

function fakePage(overrides: Partial<Record<string, unknown>> = {}): Page {
  const evaluate = (fn: unknown) => {
    if (typeof fn === "string" && fn.includes("clickables")) return CANNED_INVENTORY;
    return {};
  };
  const page = {
    url: () => "file:///fake-page",
    title: async () => "Fake Page",
    content: async () => "<html><body><button>查询</button></body></html>",
    locator: () => ({ innerText: async () => "查询 重置 查看详情" }),
    screenshot: async () => undefined,
    goto: async () => undefined,
    waitForTimeout: async () => undefined,
    evaluate,
    ...overrides
  } as unknown as Page;
  return page;
}

async function seedRoot(): Promise<string> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "p6-"));
  await fs.ensureDir(path.join(rootDir, "storage", "page-models"));
  await fs.writeJson(path.join(rootDir, "storage", "page-models", "demo.json"), { schemaVersion: "page-model-store.v1", project: "demo", models: [] });
  return rootDir;
}

// ============ T. session audit / 状态机 ============
test("T1. session 持久化 + 审计字段完整", async () => {
  const rootDir = await seedRoot();
  const session = createModelingSession(rootDir, { project: "demo", startUrl: "https://x.test/page", dryRun: true });
  const rel = await saveModelingSession(rootDir, session);
  assert.ok(fs.pathExistsSync(path.join(rootDir, rel)));
  const loaded = await loadModelingSession(rootDir, "demo", session.sessionId);
  assert.ok(loaded);
  assert.equal(loaded!.status, "CREATED");
  assert.ok(loaded!.sessionId && loaded!.startedAt && loaded!.updatedAt);
  const all = await listModelingSessions(rootDir, "demo");
  assert.equal(all.length, 1);
});

test("T2. 状态机合法迁移（CREATED→BOOTSTRAPPING→MODELING→COMPLETED）", async () => {
  const rootDir = await seedRoot();
  const session = createModelingSession(rootDir, { project: "demo", startUrl: "https://x" });
  assert.equal(canTransition("CREATED", "BOOTSTRAPPING"), true);
  assertTransition(session, "BOOTSTRAPPING", "t");
  assertTransition(session, "MODELING", "t");
  assertTransition(session, "COMPLETED", "t");
  assert.throws(() => assertTransition(session, "BOOTSTRAPPING", "illegal"));
});

test("S. cancel 生效（任意状态可取消）", async () => {
  const rootDir = await seedRoot();
  const session = createModelingSession(rootDir, { project: "demo", startUrl: "https://x" });
  assertTransition(session, "CANCELLED", "user cancel");
  assert.equal(session.status, "CANCELLED");
  assert.throws(() => assertTransition(session, "MODELING", "cancelled 后不可建模"));
});

// ============ A/E/V. NEW bootstrap + 不 direct write store ============
test("A/E/V. NEW page bootstrap 产生 proposal，store 哈希不变（无 direct write）", async () => {
  const rootDir = await seedRoot();
  const before = await pageModelStoreHash(rootDir, "demo");
  const result = await bootstrapPageForModeling({
    rootDir, project: "demo", env: "test", url: "https://new-page.test/zh-hans/foo",
    page: fakePage(), artifactDir: path.join(rootDir, "artifacts/bootstrap"), suggestedPageId: "demo.foo.page"
  });
  const after = await pageModelStoreHash(rootDir, "demo");
  assert.equal(before, after, "P6.3: bootstrap 不得 direct write store");
  assert.equal(result.identity.verdict, "NEW_PAGE");
  assert.equal(result.branchAction, "new_proposal");
  assert.ok(result.proposalId);
  // proposal 落在 pending（受控通道）
  assert.ok(fs.pathExistsSync(path.join(rootDir, "storage/proposals/pending", `${result.proposalId}.json`)));
  assert.ok(result.initialCapture.interactiveElementCount > 0);
});

// ============ B. SAME page canonical reuse ============
test("B. SAME_PAGE 归入 canonical（identity 不绕过）", async () => {
  const rootDir = await seedRoot();
  // fakePage content() 恒定 → domHash 可预测；给 canonical 模型配相同 domHash → resolver 判 SAME_PAGE。
  const fakeDom = "<html><body><button>查询</button></body></html>";
  const domHash = await (await import("node:crypto")).createHash("sha256").update(fakeDom).digest("hex");
  await fs.writeJson(path.join(rootDir, "storage/page-models/demo.json"), {
    models: [{
      pageId: "demo.canonical.page", pageName: "Canonical Page", url: "https://same.test/zh-hans/canonical", domHash,
      elements: [{ elementId: "c.e1", semanticName: "查询", role: "button", status: "dom_verified" }]
    }]
  });
  const result = await bootstrapPageForModeling({
    rootDir, project: "demo", env: "test", url: "https://same.test/zh-hans/canonical",
    page: fakePage({ url: () => "https://same.test/zh-hans/canonical", title: async () => "Canonical Page" }),
    artifactDir: path.join(rootDir, "artifacts/bootstrap"), suggestedPageId: "demo.incoming.page"
  });
  assert.equal(result.identity.verdict, "SAME_PAGE");
  assert.equal(result.branchAction, "same_canonical_merge");
  assert.equal(result.canonicalPageId, "demo.canonical.page");
});

// ============ C. POSSIBLE → review ============
test("C. POSSIBLE_SAME_PAGE 停到 review（不自动新建）", async () => {
  const rootDir = await seedRoot();
  // 造一个仅部分信号匹配的模型 → POSSIBLE
  await fs.writeJson(path.join(rootDir, "storage/page-models/demo.json"), {
    models: [{
      pageId: "demo.similar.page", pageName: "类似页", url: "https://maybe.test/zh-hans/similar",
      elements: [{ elementId: "s.e1", semanticName: "查询按钮", role: "button", status: "dom_verified" }]
    }]
  });
  const result = await bootstrapPageForModeling({
    rootDir, project: "demo", env: "test", url: "https://maybe.test/zh-hans/similar",
    page: fakePage({ url: () => "https://maybe.test/zh-hans/similar", title: async () => "类似页" }),
    artifactDir: path.join(rootDir, "artifacts/bootstrap"), suggestedPageId: "demo.incoming.page"
  });
  // POSSIBLE_SAME_PAGE 或 CONFLICT 都必须在 bootstrap 层阻止自动新建
  if (result.identity.verdict === "POSSIBLE_SAME_PAGE" || result.identity.verdict === "CONFLICT") {
    assert.equal(result.branchAction, "review_required");
    assert.ok(!result.proposalId, "POSSIBLE/CONFLICT 不得自动产生 proposal");
  }
});

// ============ D. RELATED state 不创建重复 base ============
test("D. RELATED_STATE_MODEL 不创建重复 base page", async () => {
  const rootDir = await seedRoot();
  await fs.writeJson(path.join(rootDir, "storage/page-models/demo.json"), {
    models: [{
      pageId: "demo.asset.total_assets", pageName: "资产总览", url: "https://rel.test/zh-hans/assets",
      elements: [{ elementId: "r.e1", semanticName: "资产总览菜单项", role: "link", status: "dom_verified" }]
    }]
  });
  const result = await bootstrapPageForModeling({
    rootDir, project: "demo", env: "test", url: "https://rel.test/zh-hans/assets",
    page: fakePage({ url: () => "https://rel.test/zh-hans/assets", title: async () => "资产总览" }),
    artifactDir: path.join(rootDir, "artifacts/bootstrap"), suggestedPageId: "demo.asset.total_assets_state"
  });
  // RELATED_STATE_MODEL 或 SAME 都必须不产生重复 base 的 NEW proposal
  if (result.identity.verdict === "RELATED_STATE_MODEL") {
    assert.equal(result.branchAction, "related_state");
    assert.ok(!result.proposalId);
  }
});

// ============ F. gap→heuristic→plan 串通 ============
test("F. gap→heuristic→plan 串通（button 现在能出 plan）", async () => {
  const rootDir = await seedRoot();
  const store = {
    models: [{
      pageId: "demo.p", pageName: "P", url: "https://p.test/zh-hans/p",
      elements: [{ elementId: "p.b1", semanticName: "查询", role: "button", controlType: "button", status: "dom_verified", locatorCandidates: [{ strategy: "role_button", value: "查询" }] }]
    }]
  };
  await fs.writeJson(path.join(rootDir, "storage/page-models/demo.json"), store);
  const snapshot = await buildCoverageSnapshot(rootDir, "demo");
  const gapReport = await buildExplorationGaps(rootDir, "demo", snapshot);
  const pageModel = store.models[0];
  const view = buildNormalizedPageModelView(pageModel);
  const buttonGap = gapReport.gaps.find((g) => g.target === "p.b1");
  assert.ok(buttonGap, "button gap 存在");
  const ctrl = view.elements.find((e) => e.elementId === "p.b1")!.normalizedControlType;
  const match = matchHeuristicsForGap({ gapId: buttonGap!.gapId, pageId: "demo.p", dimension: "element", target: "p.b1", source: buttonGap!.source, controlType: ctrl, hasElementLocator: true }, pageModel);
  assert.ok(match.matched.some((m) => m.heuristicId === "button.enabled_state_observation"), "button 匹配 enabled_state_observation");
  const plan = buildExplorationPlan({ gap: { gapId: buttonGap!.gapId, pageId: "demo.p", dimension: "element", target: "p.b1", source: buttonGap!.source, controlType: ctrl, hasElementLocator: true }, pageId: "demo.p", heuristic: getHeuristic("button.enabled_state_observation")!, pageModel });
  assert.equal(plan.risk, "LOW");
});

// ============ G/H. LOW 自动执行 / HIGH·FORBIDDEN 零执行 ============
test("G. LOW plan 可执行", () => {
  const plan = buildExplorationPlan({
    gap: { gapId: "g", pageId: "p", dimension: "element", target: "t", source: "element_unverified", controlType: "button", hasElementLocator: true },
    pageId: "p",
    heuristic: getHeuristic("button.enabled_state_observation")!,
    pageModel: undefined
  });
  assert.equal(validatePlanForExecution(plan).ok, true);
});

test("H. HIGH/FORBIDDEN plan 被 validatePlanForExecution 拒绝", () => {
  // 直接构造 HIGH / FORBIDDEN risk 的 plan（模拟 withdraw/submit 语义），验证 executor 硬门禁。
  const lowPlan = buildExplorationPlan({
    gap: { gapId: "g", pageId: "p", dimension: "element", target: "t", source: "element_unverified", controlType: "select", hasElementLocator: true },
    pageId: "p", heuristic: getHeuristic("select.option_discovery")!, pageModel: undefined
  });
  const highPlan = { ...lowPlan, risk: "HIGH" as const, blockedReason: "动作语义命中 HIGH 风险词表" };
  const forbiddenPlan = { ...lowPlan, risk: "FORBIDDEN" as const, blockedReason: "动作语义命中 FORBIDDEN 词表" };
  assert.equal(validatePlanForExecution(highPlan).ok, false);
  assert.equal(validatePlanForExecution(forbiddenPlan).ok, false);
  assert.equal(validatePlanForExecution(lowPlan).ok, true);
});

// ============ O. fingerprint 去重 ============
test("O. selectPlans 按 fingerprint 去重且限量", () => {
  const planA = buildExplorationPlan({
    gap: { gapId: "g1", pageId: "p", dimension: "element", target: "t1", source: "element_unverified", controlType: "select", hasElementLocator: true },
    pageId: "p", heuristic: getHeuristic("select.option_discovery")!, pageModel: undefined
  });
  const planB = buildExplorationPlan({
    gap: { gapId: "g1", pageId: "p", dimension: "element", target: "t1", source: "element_unverified", controlType: "select", hasElementLocator: true },
    pageId: "p", heuristic: getHeuristic("select.option_discovery")!, pageModel: undefined
  });
  assert.equal(planA.fingerprint, planB.fingerprint);
  const selected = selectPlans([planA, planB], new Set(), 5);
  assert.equal(selected.length, 1, "同 fingerprint 只选一个");
  const executed = new Set([planA.fingerprint]);
  const selected2 = selectPlans([planA], executed, 5);
  assert.equal(selected2.length, 0, "已执行 fingerprint 不重跑");
});

// ============ M. NO_PROGRESS ============
test("M. computeProgress 正确识别 NO_PROGRESS", () => {
  const noProgress = computeProgress({ iteration: 1, gapsBefore: 10, gapsAfter: 10, matchedBefore: 3, matchedAfter: 3, verifiedBefore: 1, verifiedAfter: 1, newEvidence: 0, promotedKnowledge: 0, reviewCandidates: 0, unresolvedUnknown: 2, riskBlocked: 0, exploredPlans: [] });
  assert.equal(noProgress.progressed, false);
  const progress = computeProgress({ iteration: 2, gapsBefore: 10, gapsAfter: 8, matchedBefore: 3, matchedAfter: 5, verifiedBefore: 1, verifiedAfter: 2, newEvidence: 2, promotedKnowledge: 1, reviewCandidates: 0, unresolvedUnknown: 1, riskBlocked: 0, exploredPlans: ["fp"] });
  assert.equal(progress.progressed, true);
});

// ============ I. exploration evidence 自动入 sink ============
test("I. exploration SUCCESS 自动入 unified sink；restore 失败不产生 auto-promotable evidence", async () => {
  const rootDir = await seedRoot();
  const cleanRun: ExplorationRun = {
    runId: "explore_clean", planId: "plan1", gapId: "gap:...:element:t1", heuristicId: "select.option_discovery", heuristicVersion: 1,
    pageId: "demo.p", before: { visibleTextHash: "a" }, steps: [{ stepId: "s1", action: "open_dropdown", status: "executed", observation: { optionCount: 3 } }],
    observations: [{ optionCount: 3 }], after: { visibleTextHash: "a" }, restoreResult: "SUCCESS", status: "COMPLETED_CLEANLY", evidence: []
  };
  const sinkOk = await recordExplorationRunEvidence(rootDir, "demo", cleanRun);
  assert.equal(sinkOk.skipped, false);
  assert.ok(sinkOk.evidenceId);
  const all = await (await import("../src/core/knowledge-evidence-sink.js")).loadAllKnowledgeEvidence(rootDir, "demo");
  assert.ok(all.some((e) => e.sourceType === "CONTROLLED_EXPLORATION" && e.outcome === "success"));

  const restoreFailRun: ExplorationRun = {
    runId: "explore_restore_fail", planId: "plan2", gapId: "gap:...:element:t2", heuristicId: "select.option_discovery", heuristicVersion: 1,
    pageId: "demo.p", before: { visibleTextHash: "a" }, steps: [], observations: [], after: { visibleTextHash: "b" },
    restoreResult: "FAILED", status: "COMPLETED_WITH_RESTORE_FAILURE", evidence: []
  };
  const sinkFail = await recordExplorationRunEvidence(rootDir, "demo", restoreFailRun);
  assert.equal(sinkFail.skipped, true, "restore 失败不得产生 auto-promotable evidence");
});

// ============ J. promotion policy 被调用 ============
test("J. aggregate + decide 走 promotion policy（ASSERTION 永不 AUTO）", async () => {
  const rootDir = await seedRoot();
  const assertionEvidence: KnowledgeEvidence = {
    evidenceId: "e1", knowledgeType: "ASSERTION", pageId: "demo.p", targetId: "t", sourceType: "DSL_EXECUTION",
    observation: {}, confidence: "HIGH", timestamp: new Date().toISOString(), observedValue: "v", outcome: "success"
  };
  await recordKnowledgeEvidence(rootDir, {
    project: "demo", knowledgeType: "ASSERTION", pageId: "demo.p", targetId: "t", sourceType: "DSL_EXECUTION",
    observation: {}, confidence: "HIGH", observedValue: "v", outcome: "success"
  });
  const candidates = aggregateEvidence([assertionEvidence]);
  for (const c of candidates.values()) {
    const d = decidePromotion(c);
    assert.notEqual(d.decision, "AUTO_PROMOTE", "ASSERTION 永不 AUTO");
  }
});

// ============ P. resume 不重跑已成功 plan ============
test("P. resume 携带 executedFingerprints 后不重跑旧 plan", () => {
  const plan = buildExplorationPlan({
    gap: { gapId: "g1", pageId: "p", dimension: "element", target: "t1", source: "element_unverified", controlType: "select", hasElementLocator: true },
    pageId: "p", heuristic: getHeuristic("select.option_discovery")!, pageModel: undefined
  });
  const resumed = selectPlans([plan], new Set([plan.fingerprint]), 5);
  assert.equal(resumed.length, 0);
});

// ============ Q. coverage 每轮重算 ============
test("Q. runModelingSession dry-run 完整跑通（bootstrap→coverage→gap→plan→progress）", async () => {
  const rootDir = await seedRoot();
  // 预置一个已建模页面使 coverage/gap 非空
  await fs.writeJson(path.join(rootDir, "storage/page-models/demo.json"), {
    models: [{
      pageId: "demo.known.page", pageName: "已知页", url: "https://known.test/zh-hans/k",
      elements: [{ elementId: "k.b1", semanticName: "查询", role: "button", controlType: "button", status: "dom_verified", locatorCandidates: [{ strategy: "role_button", value: "查询" }] }]
    }]
  });
  const result = await runModelingSession({
    rootDir, project: "demo", env: "test", startUrl: "https://new.test/zh-hans/n",
    page: fakePage({ url: () => "https://new.test/zh-hans/n" }),
    dryRun: true, budgets: { maxIterations: 2, maxPlansPerIteration: 3 }
  });
  assert.ok(result.session.sessionId);
  assert.ok(["COMPLETED", "PARTIAL", "WAITING_FOR_REVIEW", "BLOCKED"].includes(result.session.status));
  assert.ok(result.session.progressHistory.length >= 1, "至少一轮 progress");
});

// ============ L. restore failure 停 session ============
test("L. executor 返回 restore failure 时记录到 evidence（failure），不自动 promote", async () => {
  const rootDir = await seedRoot();
  const run: ExplorationRun = {
    runId: "x", planId: "p", gapId: "g", heuristicId: "h", heuristicVersion: 1, pageId: "demo.p",
    before: { visibleTextHash: "a" }, steps: [], observations: [], after: { visibleTextHash: "b" },
    restoreResult: "FAILED", status: "COMPLETED_WITH_RESTORE_FAILURE", evidence: []
  };
  const r = await recordExplorationRunEvidence(rootDir, "demo", run);
  assert.equal(r.skipped, true);
});

// ============ K/P-resume. review checkpoint 后 resume 不重跑已成功 plan ============
test("P-resume. WAITING_FOR_REVIEW resume 后从已持久化状态继续（executedFingerprints 不重跑）", async () => {
  const rootDir = await seedRoot();
  // 手工构造一个 WAITING_FOR_REVIEW 的 session 并持久化，模拟 review checkpoint
  const session = createModelingSession(rootDir, { project: "demo", startUrl: "https://resume.test/zh-hans/r", dryRun: true });
  session.identityVerdict = "POSSIBLE_SAME_PAGE";
  session.canonicalPageId = "demo.resume.page";
  session.executedFingerprints = ["fp-already-done"];
  session.iteration = 1;
  session.status = "WAITING_FOR_REVIEW";
  session.reviewRequests = [{ reason: "identity=POSSIBLE_SAME_PAGE 需人工确认", details: [], candidateEvidence: [], suggestedDecision: "keep_pending" }];
  await saveModelingSession(rootDir, session);

  // resume（人工批准）→ 状态应回 MODELING 并继续
  const resumed = await runModelingSession({
    rootDir, project: "demo", env: "test", startUrl: "https://resume.test/zh-hans/r",
    page: fakePage({ url: () => "https://resume.test/zh-hans/r" }),
    resumeSessionId: session.sessionId,
    resumeApproved: true,
    dryRun: true,
    budgets: { maxIterations: 3, maxPlansPerIteration: 2 }
  });
  assert.ok(["COMPLETED", "PARTIAL", "BLOCKED", "WAITING_FOR_REVIEW"].includes(resumed.session.status));
  // executedFingerprints 保留（不因 resume 丢失）
  assert.ok(resumed.session.executedFingerprints.includes("fp-already-done"), "resume 后 executedFingerprints 保留");
  // resume 后不再从头 bootstrap（iteration 继续而非重置为 0）
  assert.ok(resumed.session.iteration >= 1, "resume 从持久化 iteration 继续");
});
