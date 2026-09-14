import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "fs-extra";
import { DslExecutor } from "../src/core/dsl-executor.js";
import type { DslStep, FallbackLevel, LoadedContext, PageState } from "../src/core/types.js";
import type { WebDriverAdapter } from "../src/drivers/web-driver-adapter.js";

/**
 * P5.3 回归：自愈成功的 knowledge evidence 必须对所有来源步骤落盘——
 * 尤其是 page-model DSL 步骤。旧实现里 isPageModelStep guard 在 evidence sink
 * 之前提前 return，导致绝大多数用例（page-model 生成）的自愈证据永远不落盘。
 */

const PAGE_MODEL_STEP: DslStep = {
  id: "click-earn_product_center-product_type_tab-current",
  action: "click",
  target: "活期理财产品页签",
  semantic_target: "click-earn_product_center-product_type_tab-current",
  primary_locator: "text=活期理财",
  source: "page_model",
  pageId: "demo.earn.product_center",
  evidenceId: "pm.earn.product_center.product_type_tab"
} as unknown as DslStep;

const LEGACY_STEP: DslStep = {
  id: "click-legacy-step",
  action: "click",
  target: "text=查询"
} as DslStep;

function contextFor(rootDir: string): LoadedContext {
  return {
    rootDir,
    workspace: {
      workspaceName: "test",
      defaultProject: "demo",
      defaultEnv: "test",
      artifactRoot: "artifacts",
      reportRoot: "reports",
      storage: {
        sqlitePath: "storage/workbench.sqlite",
        accountsPath: "storage/accounts.json"
      }
    },
    project: { projectKey: "demo", projectName: "demo", owners: [], enabledTestTypes: ["web"], defaultEnv: "test", report: {}, failureArtifacts: {} },
    env: { env: "test" }
  };
}

function driverMock(): WebDriverAdapter {
  const state: PageState = {
    page_id: "demo.earn.product_center",
    project_id: "demo",
    platform: "web",
    dom_signature: "sig-earn-product-center",
    known_elements: [],
    outgoing_transitions: [],
    last_seen_at: new Date().toISOString()
  };
  return { getCurrentPageState: async () => state } as unknown as WebDriverAdapter;
}

async function callRecordElementSuccess(executor: DslExecutor, step: DslStep, fallbackLevel: FallbackLevel, runId: string): Promise<void> {
  // 私有方法，测试通过动态调用进入（tsx 运行时无 private 强约束）。
  await (executor as unknown as {
    recordElementSuccess(step: DslStep, locator: string, fallbackLevel: FallbackLevel, driver: WebDriverAdapter, candidate: undefined, runId?: string): Promise<void>;
  }).recordElementSuccess(step, "text=活期理财", fallbackLevel, driverMock(), undefined, runId);
}

function evidenceFiles(rootDir: string): string[] {
  const dir = path.join(rootDir, "storage", "knowledge-evidence", "demo", "LOCATOR");
  if (!fs.pathExistsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => name.endsWith(".json"));
}

test("page-model step with self-healing fallback persists LOCATOR evidence", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "dsl-exec-evidence-"));
  const executor = new DslExecutor(contextFor(rootDir));
  await callRecordElementSuccess(executor, PAGE_MODEL_STEP, 2, "run-self-heal-001");

  const files = evidenceFiles(rootDir);
  assert.equal(files.length, 1, `expected one evidence file, got ${files.join(", ")}`);
  const record = await fs.readJson(path.join(rootDir, "storage", "knowledge-evidence", "demo", "LOCATOR", files[0]));
  assert.equal(record.evidence.length, 1);
  const ev = record.evidence[0];
  assert.equal(ev.knowledgeType, "LOCATOR");
  assert.equal(ev.sourceType, "SELF_HEALING");
  assert.equal(ev.outcome, "success");
  assert.equal(ev.sourceRunId, "run-self-heal-001");
  assert.equal(ev.confidence, "HIGH");
  assert.equal(ev.observation.fallbackLevel, 2);
  assert.equal(ev.observation.newLocator, "text=活期理财");
});

test("page-model step without fallback records no evidence", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "dsl-exec-evidence-"));
  const executor = new DslExecutor(contextFor(rootDir));
  await callRecordElementSuccess(executor, PAGE_MODEL_STEP, 0, "run-normal-001");

  assert.equal(evidenceFiles(rootDir).length, 0);
});

test("legacy step with fallback still persists evidence", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "dsl-exec-evidence-"));
  const executor = new DslExecutor(contextFor(rootDir));
  await callRecordElementSuccess(executor, LEGACY_STEP, 1, "run-legacy-heal-001");

  const files = evidenceFiles(rootDir);
  assert.equal(files.length, 1);
  const record = await fs.readJson(path.join(rootDir, "storage", "knowledge-evidence", "demo", "LOCATOR", files[0]));
  assert.equal(record.evidence[0].sourceType, "SELF_HEALING");
});

test("identical self-healing run is deduplicated", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "dsl-exec-evidence-"));
  const executor = new DslExecutor(contextFor(rootDir));
  await callRecordElementSuccess(executor, PAGE_MODEL_STEP, 2, "run-dedupe-001");
  await callRecordElementSuccess(executor, PAGE_MODEL_STEP, 2, "run-dedupe-001");

  const files = evidenceFiles(rootDir);
  assert.equal(files.length, 1);
  const record = await fs.readJson(path.join(rootDir, "storage", "knowledge-evidence", "demo", "LOCATOR", files[0]));
  assert.equal(record.evidence.length, 1);
});
