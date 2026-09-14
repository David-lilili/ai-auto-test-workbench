import assert from "node:assert/strict";
import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { buildCoverageSnapshot } from "../src/core/exploration-coverage.js";
import { buildExplorationGaps } from "../src/core/exploration-gaps.js";
import { rebuildPageModelIndexes, auditPageModelIndexes } from "../src/core/page-model-index.js";
import { isStateModelPageId } from "../src/core/exploration-coverage.js";

let sandbox: string;

beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "p2-coverage-"));
});

afterEach(async () => {
  await fs.remove(sandbox);
});

async function writeStore(models: Array<Record<string, unknown>>, indexesOverride?: Record<string, unknown>): Promise<void> {
  await fs.ensureDir(path.join(sandbox, "storage", "page-models"));
  await fs.writeJson(path.join(sandbox, "storage", "page-models", "demo.json"), {
    schemaVersion: "page-model-store.v1",
    project: "demo",
    models,
    indexes: indexesOverride ?? rebuildPageModelIndexes(models)
  });
}

async function writeDsl(elementIds: string[]): Promise<void> {
  await fs.ensureDir(path.join(sandbox, "storage", "case-dsl", "demo"));
  await fs.writeJson(path.join(sandbox, "storage", "case-dsl", "demo", "case-1.json"), {
    automationCase: { steps: elementIds.map((elementId, index) => ({ id: `s${index}`, action: "click", targetElementId: elementId })) }
  });
}

async function writeHistory(passedElementIds: string[]): Promise<void> {
  await fs.ensureDir(path.join(sandbox, "storage", "case-history", "demo"));
  await fs.writeJson(path.join(sandbox, "storage", "case-history", "demo", "case-1.json"), {
    executions: [{
      status: "passed",
      executionSteps: passedElementIds.map((elementId, index) => ({ index, action: "click", targetElementId: elementId }))
    }]
  });
}

const baseModel = (pageId: string, elements: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  schemaVersion: "page-model.v1",
  pageId,
  pageName: pageId,
  url: `http://x.com/${pageId}`,
  status: "dom_verified",
  elements,
  ...extra
});

test("A. execution_verified element → VERIFIED", async () => {
  await writeStore([baseModel("demo.page", [
    { elementId: "page.btn_submit", semanticName: "提交", controlType: "button", status: "execution_verified", locatorCandidates: [] }
  ])]);
  const snapshot = await buildCoverageSnapshot(sandbox, "demo");
  assert.equal(snapshot.pages[0].elements[0].status, "VERIFIED");
});

test("B. dom_verified 但从未执行 → OBSERVED", async () => {
  await writeStore([baseModel("demo.page", [
    { elementId: "page.btn_submit", semanticName: "提交", status: "dom_verified", locatorCandidates: [] }
  ])]);
  const snapshot = await buildCoverageSnapshot(sandbox, "demo");
  assert.equal(snapshot.pages[0].elements[0].status, "OBSERVED");
});

test("C. candidate → UNCERTAIN", async () => {
  await writeStore([baseModel("demo.page", [
    { elementId: "page.btn_new", semanticName: "新按钮", status: "candidate", locatorCandidates: [] }
  ])]);
  const snapshot = await buildCoverageSnapshot(sandbox, "demo");
  assert.equal(snapshot.pages[0].elements[0].status, "UNCERTAIN");
});

test("D. 已存在 element 但 DSL 从未引用 → 按建模状态区分（OBSERVED 不是 UNEXPLORED）", async () => {
  await writeStore([baseModel("demo.page", [
    { elementId: "page.btn_a", semanticName: "A", status: "dom_verified", locatorCandidates: [] },
    { elementId: "page.btn_b", semanticName: "B", status: "candidate", locatorCandidates: [] }
  ])]);
  const snapshot = await buildCoverageSnapshot(sandbox, "demo");
  const a = snapshot.pages[0].elements.find((element) => element.elementId === "page.btn_a")!;
  const b = snapshot.pages[0].elements.find((element) => element.elementId === "page.btn_b")!;
  assert.equal(a.status, "OBSERVED", "dom_verified 未引用未执行 = OBSERVED");
  assert.equal(b.status, "UNCERTAIN", "candidate 未引用 = UNCERTAIN");
  assert.notEqual(a.status, "UNEXPLORED");
});

test("E. RELATED_STATE_MODEL 不计为 duplicate page（identityGroup 分组呈现）", async () => {
  await writeStore([
    baseModel("demo.page", [{ elementId: "page.elem", semanticName: "元素", status: "dom_verified", locatorCandidates: [] }]),
    baseModel("demo.page_entry", [{ elementId: "page_entry.btn", semanticName: "入口", status: "dom_verified", locatorCandidates: [] }], { url: "http://x.com/demo.page" })
  ]);
  const related = new Map([["demo.page", ["demo.page_entry"]], ["demo.page_entry", ["demo.page"]]]);
  const snapshot = await buildCoverageSnapshot(sandbox, "demo", related);
  assert.equal(snapshot.totalPages, 2, "两个模型都进 snapshot（状态模型不折叠消失）");
  const main = snapshot.pages.find((page) => page.pageId === "demo.page")!;
  const state = snapshot.pages.find((page) => page.pageId === "demo.page_entry")!;
  assert.ok(main.identityGroup?.includes("demo.page_entry"), "identityGroup 含状态族成员");
  assert.equal(state.isStateModel, true);
  assert.ok(state.states.some((item) => item.kind === "related_state_model"));
});

test("F. modal/state model 进入 state coverage", async () => {
  await writeStore([baseModel("demo.page_modal", [
    { elementId: "page_modal.confirm", semanticName: "确认", status: "dom_verified", locatorCandidates: [] }
  ], {
    dialogs: [{ dialogId: "page_modal.dialog", semanticName: "确认弹窗", status: "dom_verified" }],
    blockedStates: [{ blockId: "page_modal.block_kyc", blockType: "kyc_required" }]
  })]);
  const snapshot = await buildCoverageSnapshot(sandbox, "demo");
  const states = snapshot.pages[0].states;
  assert.ok(states.some((item) => item.kind === "dialog" && item.stateId === "page_modal.dialog"));
  assert.ok(states.some((item) => item.kind === "blocked_state" && item.status === "BLOCKED"));
  assert.equal(isStateModelPageId("demo.page_modal"), true);
});

test("G. DSL 成功执行后 element/interaction 体现 execution evidence", async () => {
  await writeStore([baseModel("demo.page", [
    { elementId: "page.btn_submit", semanticName: "提交", status: "dom_verified", locatorCandidates: [] }
  ])]);
  await writeDsl(["page.btn_submit"]);
  await writeHistory(["page.btn_submit"]);
  const snapshot = await buildCoverageSnapshot(sandbox, "demo");
  const element = snapshot.pages[0].elements[0];
  assert.equal(element.status, "VERIFIED", "执行成功历史优先于静态 dom_verified");
  assert.equal(element.executionEvidenceCount, 1);
  assert.equal(element.dslReferenceCount, 1);
  assert.ok(snapshot.pages[0].interactions.some((item) => item.interaction === "click" && item.status === "VERIFIED"));
});

test("H. failure diagnostic 指向模型缺失时生成 exploration gap", async () => {
  await writeStore([baseModel("demo.page", [
    { elementId: "page.btn", semanticName: "按钮", status: "dom_verified", locatorCandidates: [] }
  ])]);
  const diagDir = path.join(sandbox, "storage", "dsl-diagnostics", "demo", "test", "case-missing");
  await fs.ensureDir(diagDir);
  await fs.writeJson(path.join(diagDir, "2026-01-01.json"), {
    caseId: "case-missing",
    stage: "grounded_contract_validation",
    gaps: ["assertion_capability_missing:page.btn_x"]
  });
  const snapshot = await buildCoverageSnapshot(sandbox, "demo");
  const gaps = await buildExplorationGaps(sandbox, "demo", snapshot);
  const diagGap = gaps.gaps.find((gap) => gap.source === "dsl_diagnostic_gap");
  assert.ok(diagGap, "诊断类 gap 必须生成");
  assert.equal(diagGap!.priority, "HIGH");
  assert.ok(String(diagGap!.target).includes("assertion_capability_missing"));
});

test("I. NOT_APPLICABLE 不进入 gap（candidate 有 DSL 引用时不判 stale）", async () => {
  await writeStore([baseModel("demo.page", [
    { elementId: "page.text_label", semanticName: "纯文本", controlType: "text", status: "dom_verified", locatorCandidates: [] }
  ])]);
  // 控件类型 text 无适用交互——interaction 维度不产生 NOT_APPLICABLE gap
  const snapshot = await buildCoverageSnapshot(sandbox, "demo");
  const gaps = await buildExplorationGaps(sandbox, "demo", snapshot);
  assert.ok(!gaps.gaps.some((gap) => gap.status === "NOT_APPLICABLE"), "NOT_APPLICABLE 不得进入 gap 列表");
});

test("J. index 缺失不改变 coverage truth（coverage 从 models 推导）", async () => {
  const models = [
    baseModel("demo.page", [{ elementId: "page.btn", semanticName: "按钮", status: "execution_verified", locatorCandidates: [] }])
  ];
  // 完整索引 vs 空/损坏索引——两次 coverage 结果（除 generatedAt）必须一致
  await writeStore(models, rebuildPageModelIndexes(models));
  const withIndex = await buildCoverageSnapshot(sandbox, "demo");
  await writeStore(models, { byPageId: {}, byModuleAction: {}, byCapability: {} });
  const brokenIndex = await buildCoverageSnapshot(sandbox, "demo");
  const strip = (snapshot: Record<string, unknown>) => JSON.stringify({ ...snapshot, generatedAt: undefined });
  assert.equal(strip(withIndex as unknown as Record<string, unknown>), strip(brokenIndex as unknown as Record<string, unknown>), "索引状态不影响 coverage 结果");
});

test("K. rebuild index 前后 coverage 完全一致 + rebuild 纯函数性质", async () => {
  const models = [
    baseModel("demo.page_a", [{ elementId: "page_a.btn", semanticName: "按钮A", status: "dom_verified", locatorCandidates: [] }], { module: "asset", action: "view" }),
    baseModel("demo.page_b", [{ elementId: "page_b.input", semanticName: "输入B", status: "candidate", locatorCandidates: [] }], { module: "withdraw", action: "submit" })
  ];
  const first = rebuildPageModelIndexes(models);
  const second = rebuildPageModelIndexes(models);
  assert.deepEqual(first, second, "同输入同输出");
  assert.equal(first.byPageId["demo.page_a"], 0);
  assert.equal(first.byPageId["demo.page_b"], 1);
  assert.deepEqual(first.byModuleAction["asset.view"], ["demo.page_a"]);
  assert.deepEqual(first.byModuleAction["withdraw.submit"], ["demo.page_b"]);
  assert.ok(first.byCapability["page_a"], "elementId 前缀进 byCapability");
  // coverage 一致性
  await writeStore(models, first);
  const coverage1 = await buildCoverageSnapshot(sandbox, "demo");
  await writeStore(models, second);
  const coverage2 = await buildCoverageSnapshot(sandbox, "demo");
  const strip = (snapshot: Record<string, unknown>) => JSON.stringify({ ...snapshot, generatedAt: undefined });
  assert.equal(strip(coverage1 as unknown as Record<string, unknown>), strip(coverage2 as unknown as Record<string, unknown>));
});

test("index audit 能发现 byModuleAction 的历史缺口（悬空键/缺失键）", () => {
  const models = [baseModel("demo.page", [], { module: "asset", action: "overview" })];
  const store = {
    models,
    indexes: {
      byPageId: { "demo.page": 0 },
      byModuleAction: { "asset.old_key": ["demo.page"], "stale.key": ["ghost.page"] },
      byCapability: { "legacy.cap": ["ghost.page"] }
    }
  };
  const audit = auditPageModelIndexes(store as never);
  assert.ok(audit.byModuleAction.staleKeys.includes("stale.key"), "悬空键被识别");
  assert.ok(audit.byModuleAction.staleKeys.includes("asset.old_key") || audit.byModuleAction.missingKeys.includes("asset.overview"));
  assert.ok(audit.byCapability.staleKeys.includes("legacy.cap"));
  assert.deepEqual(audit.byPageId, { staleEntries: [], wrongPositions: [], missingEntries: [] });
});
