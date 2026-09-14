import assert from "node:assert/strict";
import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { executeExplorationPlan, validatePlanForExecution, type ExplorationPlan, type PlanStep } from "../src/core/exploration-executor.js";

/**
 * P4-A0：restore failure 回归硬化（mock driver，不碰真实页面）。
 * P3-B 已实现状态机但未真实触发过 restore 失败路径——本测试用注入失败的
 * mock page 对象驱动完整执行路径验证。
 */

let sandbox: string;

beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "restore-fail-"));
});

afterEach(async () => {
  await fs.remove(sandbox);
});

/** mock Playwright Page：capture 类动作成功，restore 动作抛错。 */
function createMockPage(options: { restoreFails?: boolean } = {}): unknown {
  return {
    url: () => "http://x.com/page",
    title: async () => "Test Page",
    locator: () => {
      const base = {
        innerText: async () => "页面文本 before-state",
        isEnabled: async () => true,
        isVisible: async () => true,
        click: async () => {
          if (options.restoreFails) throw new Error("mock restore click timeout");
        },
        fill: async () => {
          if (options.restoreFails) throw new Error("mock restore fill timeout");
        }
      };
      return { ...base, first: () => base };
    },
    keyboard: {
      press: async () => {
        if (options.restoreFails) throw new Error("mock escape failed");
      }
    },
    waitForTimeout: async () => undefined
  };
}

function makePlan(overrides: Partial<ExplorationPlan> = {}): ExplorationPlan {
  return {
    planId: "plan_restore_test",
    gapId: "gap:restore-test",
    pageId: "demo.page",
    heuristicId: "select.switch_restore",
    heuristicVersion: 1,
    target: "demo.select_filter",
    preconditions: [],
    steps: [
      { stepId: "s1", action: "capture_before", observationTargets: [], risk: "LOW" },
      { stepId: "s2", action: "select_alternative", observationTargets: [], risk: "LOW" }
    ],
    observations: [],
    restoreSteps: [
      { stepId: "r1", action: "clear", targetElementId: "demo.select_filter", observationTargets: [], risk: "LOW" }
    ],
    stopConditions: ["restore_failed"],
    risk: "LOW",
    estimatedCost: "LOW",
    expectedEvidence: [],
    fingerprint: "fp_restore_test",
    status: "PLANNED",
    ...overrides
  };
}

test("P4-A0：restore 失败 → COMPLETED_WITH_RESTORE_FAILURE + restoreResult=FAILED + evidence 保留 + 不标 CLEANLY", async () => {
  const plan = makePlan();
  const run = await executeExplorationPlan({
    page: createMockPage({ restoreFails: true }) as never,
    plan,
    rootDir: sandbox,
    locatorResolver: () => "css=.filter"
  });
  assert.equal(run.restoreResult, "FAILED");
  assert.equal(run.status, "COMPLETED_WITH_RESTORE_FAILURE", "不得标记 COMPLETED_CLEANLY");
  // evidence 保留（失败也产出 run 记录与 evidence 文件）
  assert.ok(run.evidence.length >= 1, "evidence 必须保留");
  assert.ok(run.evidence[0].runId === run.runId);
  assert.ok(run.evidence[0].heuristicId === "select.switch_restore");
  assert.ok(run.evidence[0].heuristicVersion === 1);
  // run 产物落盘（可审计）
  const runPath = path.join(sandbox, "storage", "exploration-runs", `${run.runId}.json`);
  assert.ok(await fs.pathExists(runPath), "失败 run 必须持久化");
});

test("P4-A0：restore 成功路径对照 → COMPLETED_CLEANLY", async () => {
  const plan = makePlan();
  const run = await executeExplorationPlan({
    page: createMockPage() as never,
    plan,
    rootDir: sandbox,
    locatorResolver: () => "css=.filter"
  });
  assert.equal(run.status, "COMPLETED_CLEANLY");
  assert.equal(run.restoreResult, "SUCCESS");
});

test("P4-A0：restore 失败后 Page Model 不被修改（executor 无写入口）", async () => {
  const storePath = path.join(sandbox, "storage", "page-models", "demo.json");
  await fs.ensureDir(path.dirname(storePath));
  const original = { models: [{ pageId: "demo.page", elements: [{ elementId: "demo.select_filter" }] }] };
  await fs.writeJson(storePath, original);
  const run = await executeExplorationPlan({
    page: createMockPage({ restoreFails: true }) as never,
    plan: makePlan(),
    rootDir: sandbox
  });
  assert.equal(run.status, "COMPLETED_WITH_RESTORE_FAILURE");
  const after = await fs.readJson(storePath);
  assert.deepEqual(after, original, "Page Model 字节不变");
});

test("P4-A0：步骤失败 → STOPPED + 后续步骤不再执行", async () => {
  const plan = makePlan({
    steps: [
      { stepId: "s1", action: "capture_before", observationTargets: [], risk: "LOW" },
      { stepId: "s2", action: "clear", observationTargets: [], risk: "LOW" },
      { stepId: "s3", action: "capture_after", observationTargets: [], risk: "LOW" }
    ]
  });
  // mock：clear 抛错（无 locator 也抛——用不提供 resolver 使 clear 失败）
  const run = await executeExplorationPlan({
    page: createMockPage() as never,
    plan,
    rootDir: sandbox,
    locatorResolver: undefined
  });
  assert.equal(run.status, "STOPPED");
  const executed = run.steps.filter((step) => step.status === "executed").map((step) => step.stepId);
  assert.ok(!executed.includes("s3"), "s1 失败后 s3 不得执行");
  assert.ok(run.failure?.includes("失败") || run.failure?.length > 0, "failure 必须记录");
});

test("P4-A0：未注册动作被拒（白名单防线在 executor 内独立生效）", async () => {
  const plan = makePlan({
    steps: [{ stepId: "s1", action: "invented_by_ai", observationTargets: [], risk: "LOW" }]
  });
  const run = await executeExplorationPlan({
    page: createMockPage() as never,
    plan,
    rootDir: sandbox
  });
  assert.equal(run.steps[0].status, "skipped_not_applicable");
  assert.ok(run.steps[0].error?.includes("白名单"));
});
