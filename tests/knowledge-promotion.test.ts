import assert from "node:assert/strict";
import fs from "node:fs";
import fsExtra from "fs-extra";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
  PROMOTION_POLICIES,
  buildKnowledgeKey,
  aggregateEvidence,
  decidePromotion,
  type KnowledgeEvidence
} from "../src/core/knowledge-promotion-policy.js";
import { promoteLocatorCandidate } from "../src/core/locator-promotion.js";

let sandbox: string;

beforeEach(async () => {
  sandbox = await fs.promises.mkdtemp(path.join(os.tmpdir(), "promotion-"));
});

afterEach(async () => {
  await fs.promises.rm(sandbox, { recursive: true });
});

const evidence = (overrides: Partial<KnowledgeEvidence>): KnowledgeEvidence => ({
  evidenceId: `ev_${Math.random().toString(36).slice(2, 8)}`,
  knowledgeType: "LOCATOR",
  pageId: "demo.page",
  targetId: "demo.elem",
  sourceType: "DSL_EXECUTION",
  observation: {},
  confidence: "HIGH",
  timestamp: new Date().toISOString(),
  observedValue: "text=按钮",
  outcome: "success",
  ...overrides
});

// ============ A/B：聚合与去重 ============

test("A. 相同 knowledgeKey 的 evidence 聚合为一个 candidate", () => {
  const list = [
    evidence({ evidenceId: "e1", timestamp: "2026-08-01T00:00:00Z" }),
    evidence({ evidenceId: "e2", timestamp: "2026-08-05T00:00:00Z" }),
    evidence({ evidenceId: "e3", timestamp: "2026-08-10T00:00:00Z" })
  ];
  const candidates = aggregateEvidence(list);
  assert.equal(candidates.size, 1, "3 条同值证据聚合成 1 个 candidate");
  const candidate = [...candidates.values()][0];
  assert.equal(candidate.evidence.length, 3);
  assert.equal(candidate.successCount, 3);
  assert.equal(candidate.evidenceConfidence, "HIGH");
  assert.equal(candidate.firstObservedAt, "2026-08-01T00:00:00Z");
  assert.equal(candidate.lastObservedAt, "2026-08-10T00:00:00Z");
});

test("B. 不同 observedValue 产生不同 candidate（重复 proposal 不重复 candidate 但不同知识分开）", () => {
  const list = [
    evidence({ observedValue: "text=按钮A" }),
    evidence({ observedValue: "text=按钮A" }),
    evidence({ observedValue: "text=按钮B" })
  ];
  const candidates = aggregateEvidence(list);
  assert.equal(candidates.size, 2, "同 target 不同 locator 值是不同知识");
});

// ============ C/D：locator policy ============

test("C. locator 修复型：失败证据 + 新 locator 成功 ≥2 → AUTO_PROMOTE", () => {
  const list = [
    evidence({ outcome: "failure", observedValue: "text=查看更多", sourceType: "SELF_HEALING" }),
    evidence({ observedValue: "text=查看更多", sourceType: "SELF_HEALING" }),
    evidence({ observedValue: "text=查看更多", sourceType: "SELF_HEALING" })
  ];
  const candidates = aggregateEvidence(list);
  const decision = decidePromotion([...candidates.values()][0]);
  assert.equal(decision.decision, "AUTO_PROMOTE");
  assert.equal(decision.policyId, "locator.v1");
  assert.equal(decision.policyVersion, 1);
});

test("D. locator 有 contradiction → CONFLICT 禁止 auto", () => {
  const list = [
    evidence({ observedValue: "text=查看更多" }),
    evidence({ observedValue: "text=查看更多" }),
    evidence({ observedValue: "text=查看更多", outcome: "contradiction" })
  ];
  const candidates = aggregateEvidence(list);
  const decision = decidePromotion([...candidates.values()][0]);
  assert.equal(decision.decision, "CONFLICT");
  assert.ok(decision.contradictions.length > 0, "矛盾证据被记录");
});

// ============ E/F：normalization policy ============

test("E. CONTROL_TYPE HIGH 结构证据 → AUTO_PROMOTE（targetStatus=dom_verified）", () => {
  const list = [
    evidence({ knowledgeType: "CONTROL_TYPE", sourceType: "NORMALIZATION", observedValue: "select", confidence: "HIGH" })
  ];
  const decision = decidePromotion([...aggregateEvidence(list).values()][0]);
  assert.equal(decision.decision, "AUTO_PROMOTE");
  assert.equal(decision.targetStatus, "dom_verified", "只到 dom_verified 不到 execution_verified");
});

test("F. CONTROL_TYPE MEDIUM 不 auto（走 review）", () => {
  const list = [
    evidence({ knowledgeType: "CONTROL_TYPE", sourceType: "NORMALIZATION", observedValue: "input", confidence: "MEDIUM" })
  ];
  const decision = decidePromotion([...aggregateEvidence(list).values()][0]);
  assert.equal(decision.decision, "REVIEW");
});

// ============ G/H：assertion 与 security 恒 review ============

test("G. assertion 默认 review（即使多证据高 confidence）", () => {
  const list = [
    evidence({ knowledgeType: "ASSERTION", observedValue: "message:成功", sourceType: "DSL_EXECUTION" }),
    evidence({ knowledgeType: "ASSERTION", observedValue: "message:成功", sourceType: "DSL_EXECUTION" }),
    evidence({ knowledgeType: "ASSERTION", observedValue: "message:成功", sourceType: "CONTROLLED_EXPLORATION" })
  ];
  const decision = decidePromotion([...aggregateEvidence(list).values()][0]);
  assert.equal(decision.decision, "REVIEW", "assertion 永不 auto");
});

test("H. security requirement 永不 auto", () => {
  const list = [
    evidence({ knowledgeType: "SECURITY_REQUIREMENT", observedValue: "kyc_required", sourceType: "DSL_EXECUTION" }),
    evidence({ knowledgeType: "SECURITY_REQUIREMENT", observedValue: "kyc_required", sourceType: "DSL_EXECUTION" }),
    evidence({ knowledgeType: "SECURITY_REQUIREMENT", observedValue: "kyc_required", sourceType: "DSL_EXECUTION" })
  ];
  const decision = decidePromotion([...aggregateEvidence(list).values()][0]);
  assert.equal(decision.decision, "REVIEW", "security 永不 auto");
});

// ============ I/J：矛盾与 freshness ============

test("I. dependency contradiction → CONFLICT", () => {
  const list = [
    evidence({ knowledgeType: "DEPENDENCY", observedValue: "network→address:cleared", sourceType: "CONTROLLED_EXPLORATION" }),
    evidence({ knowledgeType: "DEPENDENCY", observedValue: "network→address:cleared", outcome: "contradiction", sourceType: "CONTROLLED_EXPLORATION" })
  ];
  const decision = decidePromotion([...aggregateEvidence(list).values()][0]);
  assert.equal(decision.decision, "CONFLICT");
});

test("J. 页面签名变化（INVALIDATED）降低 freshness → KEEP_PENDING", () => {
  const list = [];
  // 构造 >2 个不同 pageSignature → INVALIDATED
  for (let index = 0; index < 3; index += 1) {
    list.push(evidence({ pageSignature: `sig_${index}` }));
  }
  const candidate = [...aggregateEvidence(list).values()][0];
  assert.equal(candidate.freshness, "INVALIDATED");
  const decision = decidePromotion(candidate);
  assert.equal(decision.decision, "KEEP_PENDING");
});

// ============ K：exploration scope 不过度推断 ============

test("K. exploration evidence scope 严格（open/close 只证交互存在，不证业务正确）", () => {
  // option_discovery 的 evidence observedValue 是 interaction:select.option_discovery
  // ——policy 只晋升 INTERACTION（open/close 可行），不含 ASSERTION/DEPENDENCY
  const list = [
    evidence({
      knowledgeType: "INTERACTION",
      sourceType: "CONTROLLED_EXPLORATION",
      observedValue: "interaction:select.option_discovery",
      heuristicId: "select.option_discovery",
      heuristicVersion: 1
    }),
    evidence({
      knowledgeType: "INTERACTION",
      sourceType: "CONTROLLED_EXPLORATION",
      observedValue: "interaction:select.option_discovery",
      heuristicId: "select.option_discovery",
      heuristicVersion: 1
    })
  ];
  const candidate = [...aggregateEvidence(list).values()][0];
  const decision = decidePromotion(candidate);
  assert.equal(decision.decision, "AUTO_PROMOTE");
  assert.equal(decision.targetStatus, "execution_observed", "只到交互观察级，不到业务验证级");
  // 确认不产生 ASSERTION 类推断
  assert.equal(candidate.knowledgeType, "INTERACTION");
});

// ============ L/M/N/O：写回安全 ============

async function seedStore(): Promise<void> {
  await fs.promises.mkdir(path.join(sandbox, "storage", "page-models"), { recursive: true });
  await fs.promises.writeFile(path.join(sandbox, "storage", "page-models", "demo.json"), JSON.stringify({
    models: [{
      pageId: "demo.page",
      elements: [{
        elementId: "demo.btn",
        semanticName: "查看更多按钮",
        controlType: "button",
        status: "dom_verified",
        locatorCandidates: [{ strategy: "role_button_name", value: "查看更多" }],
        verificationHistory: []
      }]
    }]
  }, null, 2));
}

test("L. auto writeback 保留旧 locator（追加非覆盖）", async () => {
  await seedStore();
  const result = await promoteLocatorCandidate(sandbox, "demo", {
    pageId: "demo.page",
    elementId: "demo.btn",
    semanticName: "查看更多按钮",
    oldLocatorCandidates: [{ strategy: "role_button_name", value: "查看更多" }],
    healedLocator: { strategy: "text", value: "textExact=查看更多", confidence: 0.7, source: "self_healing" },
    evidenceIds: ["e1", "e2"],
    policyId: "locator.v1",
    policyVersion: 1,
    sourceRunIds: ["r1", "r2"],
    successCount: 2
  });
  assert.equal(result.action, "appended_locator_candidate");
  const store = JSON.parse(await fs.promises.readFile(path.join(sandbox, "storage", "page-models", "demo.json"), "utf8"));
  const element = store.models[0].elements[0];
  assert.equal(element.locatorCandidates.length, 2, "旧 + 新共 2 个");
  assert.equal(element.locatorCandidates[0].strategy, "role_button_name", "旧 locator 原样保留");
});

test("M. verificationHistory 写入完整 provenance", async () => {
  await seedStore();
  await promoteLocatorCandidate(sandbox, "demo", {
    pageId: "demo.page", elementId: "demo.btn", semanticName: "查看更多按钮",
    oldLocatorCandidates: [], healedLocator: { strategy: "text", value: "t", confidence: 0.7, source: "s" },
    evidenceIds: ["e1"], policyId: "locator.v1", policyVersion: 1, sourceRunIds: ["r1"], successCount: 1
  });
  const store = JSON.parse(await fs.promises.readFile(path.join(sandbox, "storage", "page-models", "demo.json"), "utf8"));
  const history = store.models[0].elements[0].verificationHistory;
  assert.equal(history.length, 1);
  assert.equal(history[0].policyId, "locator.v1");
  assert.equal(history[0].policyVersion, 1);
  assert.deepEqual(history[0].evidenceIds, ["e1"]);
  assert.equal(history[0].knowledgeType, "LOCATOR");
});

test("N. rollback metadata（backup 路径）存在", async () => {
  await seedStore();
  const result = await promoteLocatorCandidate(sandbox, "demo", {
    pageId: "demo.page", elementId: "demo.btn", semanticName: "查看更多按钮",
    oldLocatorCandidates: [], healedLocator: { strategy: "text", value: "t", confidence: 0.7, source: "s" },
    evidenceIds: ["e1"], policyId: "locator.v1", policyVersion: 1, sourceRunIds: ["r1"], successCount: 1
  });
  assert.ok(result.rollback?.backupPath, "rollback backupPath 存在");
  assert.ok(await fsExtra.pathExists(path.join(sandbox, result.rollback!.backupPath)), "backup 文件真实存在");
});

test("O. 无关字段字节不变（只动 locatorCandidates 与 verificationHistory）", async () => {
  await seedStore();
  const before = JSON.parse(await fs.promises.readFile(path.join(sandbox, "storage", "page-models", "demo.json"), "utf8"));
  await promoteLocatorCandidate(sandbox, "demo", {
    pageId: "demo.page", elementId: "demo.btn", semanticName: "查看更多按钮",
    oldLocatorCandidates: [], healedLocator: { strategy: "text", value: "t", confidence: 0.7, source: "s" },
    evidenceIds: ["e1"], policyId: "locator.v1", policyVersion: 1, sourceRunIds: ["r1"], successCount: 1
  });
  const after = JSON.parse(await fs.promises.readFile(path.join(sandbox, "storage", "page-models", "demo.json"), "utf8"));
  const beforeElement = before.models[0].elements[0];
  const afterElement = after.models[0].elements[0];
  assert.equal(afterElement.status, beforeElement.status, "status 不降级");
  assert.equal(afterElement.semanticName, beforeElement.semanticName, "semanticName 不变");
  assert.equal(afterElement.controlType, beforeElement.controlType, "controlType 不变");
  assert.equal(after.models.length, before.models.length, "模型数不变");
});

// ============ P/Q/R/S/T ============

test("P. policy version 进入 decision 审计", () => {
  const decision = decidePromotion([...aggregateEvidence([evidence({ outcome: "failure" }), evidence(), evidence()]).values()][0]);
  assert.ok(decision.policyId && decision.policyVersion >= 1);
});

test("Q. execution_verified 不被降级（promotion 只追加 locator，status 由 execution 通道独占）", async () => {
  await fs.promises.mkdir(path.join(sandbox, "storage", "page-models"), { recursive: true });
  await fs.promises.writeFile(path.join(sandbox, "storage", "page-models", "demo.json"), JSON.stringify({
    models: [{ pageId: "p", elements: [{ elementId: "e", semanticName: "查看更多", status: "execution_verified", locatorCandidates: [], verificationHistory: [] }] }]
  }));
  await promoteLocatorCandidate(sandbox, "demo", {
    pageId: "p", elementId: "e", semanticName: "查看更多",
    oldLocatorCandidates: [], healedLocator: { strategy: "text", value: "t", confidence: 0.7, source: "s" },
    evidenceIds: ["e1"], policyId: "locator.v1", policyVersion: 1, sourceRunIds: ["r1"], successCount: 1
  });
  const store = JSON.parse(await fs.promises.readFile(path.join(sandbox, "storage", "page-models", "demo.json"), "utf8"));
  assert.equal(store.models[0].elements[0].status, "execution_verified", "execution_verified 不被降级");
});

test("R. 真实 267 proposal 聚合后 candidate 数减少（raw > unique）", () => {
  // 模拟聚合效果：同值证据折叠
  const list = [];
  for (let index = 0; index < 154; index += 1) {
    list.push(evidence({ knowledgeType: "ASSERTION", observedValue: `assertion_${index % 66}` }));
  }
  const candidates = aggregateEvidence(list);
  assert.equal(candidates.size, 66, "154 条同值证据折叠为 66 candidate");
  assert.ok(candidates.size < list.length);
});

test("S. audit deterministic（同输入同输出）", () => {
  const list = [evidence({ evidenceId: "e1" }), evidence({ evidenceId: "e2" }), evidence({ evidenceId: "e3" })];
  const first = [...aggregateEvidence([...list]).values()][0];
  const second = [...aggregateEvidence([...list]).values()][0];
  assert.equal(first.knowledgeKey, second.knowledgeKey);
  assert.equal(first.successCount, second.successCount);
  assert.equal(decidePromotion(first).decision, decidePromotion(second).decision);
});

test("T. AI 不参与 promotion decision（policy 模块零 AI 依赖）", () => {
  const source = fs.readFileSync("src/core/knowledge-promotion-policy.ts", "utf8");
  assert.ok(!source.includes("callConfiguredAiJson") && !source.includes("ai-provider"), "promotion 完全 deterministic");
});

test("knowledgeKey 稳定且区分", () => {
  const key1 = buildKnowledgeKey("LOCATOR", "p1", "t1", "v1");
  const key2 = buildKnowledgeKey("LOCATOR", "p1", "t1", "v1");
  const key3 = buildKnowledgeKey("LOCATOR", "p1", "t1", "v2");
  assert.equal(key1, key2);
  assert.notEqual(key1, key3);
});

test("八类 policy 全部存在且 riskClass 合理", () => {
  for (const type of ["LOCATOR", "CONTROL_TYPE", "INTERACTION", "ASSERTION", "STATE", "DEPENDENCY", "BUSINESS_RULE", "SECURITY_REQUIREMENT"] as const) {
    const policy = PROMOTION_POLICIES[type];
    assert.ok(policy, `${type} policy 存在`);
    assert.ok(policy.policyId && policy.policyVersion >= 1);
  }
  assert.equal(PROMOTION_POLICIES["SECURITY_REQUIREMENT"].riskClass, "HIGH");
  assert.equal(PROMOTION_POLICIES["SECURITY_REQUIREMENT"].autoPromoteConditions.length, 0, "security 无 auto 条件");
  assert.equal(PROMOTION_POLICIES["ASSERTION"].autoPromoteConditions.length, 0, "assertion 无 auto 条件");
});
