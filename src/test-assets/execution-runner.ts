/**
 * P13.31-40：TestAsset Runner——复用 DslExecutor + ExecutionStore。
 *
 * - ExecutionRun 扩展 test_asset_id 等（types.ts 已加可选字段）。
 * - 结果分类（P13.33-35）：PASS / PRODUCT_FAILURE / MODEL_FAILURE / TEST_DATA_FAILURE /
 *   PRECONDITION_FAILURE / EXECUTION_FAILURE / ASSERTION_FAILURE / ENVIRONMENT_FAILURE /
 *   RISK_BLOCKED / CANCELLED。
 * - 失败分类复用 executor diagnostics（locator 失败 → MODEL_FAILURE；断言 mismatch → 产品侧）。
 * - Run History 独立索引（storage/test-assets/runs），不改 TestAsset 内容。
 * - Retry 策略（P13.62/63）：technical retryable；business 不自动重试；保留 attempt 历史。
 */

import fs from "fs-extra";
import path from "node:path";
import crypto from "node:crypto";
import { DslExecutor } from "../core/dsl-executor.js";
import { ExecutionStore } from "../memory/execution-store.js";
import type { LoadedContext, RuntimeOptions, AutomationCase } from "../core/types.js";
import type { ExecutionResultStatus, AssetRunRecord } from "./execution-types.js";

export interface RunInput {
  testCase: AutomationCase;
  context: LoadedContext;
  options: RuntimeOptions;
  testAssetId: string;
  testAssetVersion: string;
  executionPreparationId: string;
  materializationFingerprint?: string;
  accountProfileId?: string;
  testDataFingerprint?: string;
  executionAuthorizationId?: string;
  environment: string;
  maxAttempts?: number;
}

export interface RunOutcome {
  result: ExecutionResultStatus;
  attempts: Array<{ attempt: number; status: ExecutionResultStatus; error?: string }>;
  retried: boolean;
  flaky: boolean;
  runId?: string;
  durationMs: number;
  detail: string;
}

export function classifyFailure(error: string | undefined, stepAction?: string): ExecutionResultStatus {
  const text = error ?? "";
  // 断言/期望不匹配 → 产品侧（P13.35：按钮成功点击但结果不符 = 产品问题）
  if (/assertion|expected|mismatch|not equal|assert/i.test(text)) return "ASSERTION_FAILURE";
  // locator/元素解析失败 → 模型问题（按钮找不到 = 自动化/模型问题，不判产品 bug）
  if (/locator|element not found|no such element|not found for step|semantic locator|timed out after|timeout.*(click|input|step)|unable to execute/i.test(text)) return "MODEL_FAILURE";
  if (/navigation|net::|ECONNREFUSED|ERR_CONNECTION|timeout.*(navigate|page)/i.test(text)) return "ENVIRONMENT_FAILURE";
  if (/precondition failed/i.test(text)) return "PRECONDITION_FAILURE";
  if (/unresolved navigation target/i.test(text)) return "MODEL_FAILURE";
  return "EXECUTION_FAILURE";
}

/** P13.62：technical retryable vs business non-retryable。 */
export function isTechnicalRetryable(result: ExecutionResultStatus): boolean {
  return result === "EXECUTION_FAILURE" || result === "ENVIRONMENT_FAILURE";
}

export async function runTestAsset(input: RunInput): Promise<RunOutcome> {
  const maxAttempts = input.maxAttempts ?? 2;
  const attempts: RunOutcome["attempts"] = [];
  const startedAt = Date.now();
  let lastRunId: string | undefined;
  let finalResult: ExecutionResultStatus = "EXECUTION_FAILURE";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let result: ExecutionResultStatus;
    let errorText: string | undefined;
    let runId: string | undefined;
    try {
      const executor = new DslExecutor(input.context);
      const caseResult = await executor.executeCase({
        testCase: input.testCase,
        context: input.context,
        options: { ...input.options, mode: input.options.mode ?? "heal" }
      });
      runId = caseResult.runId;
      lastRunId = runId;
      const stepFailures = caseResult.error ?? "";
      if (caseResult.status === "passed") {
        result = "PASS";
      } else if (/assertion|expected|mismatch/i.test(stepFailures)) {
        result = classifyFailure(stepFailures, "assert");
      } else {
        result = classifyFailure(stepFailures);
      }
      errorText = caseResult.error;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errorText = message;
      result = classifyFailure(message);
    }
    attempts.push({ attempt, status: result, error: errorText });
    finalResult = result;
    // 非技术性失败不自动重试（P13.62：assertion mismatch 不重试到 PASS）
    if (result === "PASS" || !isTechnicalRetryable(result)) break;
  }

  const flaky = attempts.length > 1 && attempts.some((a) => a.status === "PASS") && attempts.some((a) => a.status !== "PASS");

  // P13.38/39：Run History 独立索引
  const record: AssetRunRecord = {
    runId: lastRunId ?? `run-${Date.now()}`,
    testAssetId: input.testAssetId,
    testAssetVersion: input.testAssetVersion,
    executionPreparationId: input.executionPreparationId,
    materializationFingerprint: input.materializationFingerprint,
    accountProfileId: input.accountProfileId,
    testDataFingerprint: input.testDataFingerprint,
    executionAuthorizationId: input.executionAuthorizationId,
    environment: input.environment,
    result: finalResult,
    attempts,
    retried: attempts.length > 1,
    flaky,
    durationMs: Date.now() - startedAt,
    evidencePaths: [],
    createdAt: new Date().toISOString()
  };
  await appendRunHistory(input.context.rootDir, record);

  // P13.31：ExecutionRun 扩展字段写回（executor 已写 run，补 test_asset 元数据）
  if (lastRunId) {
    try {
      const store = new ExecutionStore(input.context);
      const data = await store.load();
      const runs = data.runs ?? [];
      const idx = runs.findIndex((r) => r.run_id === lastRunId);
      if (idx >= 0) {
        runs[idx] = {
          ...runs[idx],
          test_asset_id: input.testAssetId,
          test_asset_version: input.testAssetVersion,
          execution_preparation_id: input.executionPreparationId,
          materialization_fingerprint: input.materializationFingerprint,
          account_profile_id: input.accountProfileId,
          test_data_fingerprint: input.testDataFingerprint,
          execution_authorization_id: input.executionAuthorizationId,
          creation_mode: "SYSTEMATIC_BASELINE"
        };
        await store.upsertRun(runs[idx]);
      }
    } catch { /* non-blocking */ }
  }

  return {
    result: finalResult,
    attempts,
    retried: attempts.length > 1,
    flaky,
    runId: lastRunId,
    durationMs: Date.now() - startedAt,
    detail: attempts.map((a) => `attempt${a.attempt}=${a.status}${a.error ? `:${a.error.slice(0, 80)}` : ""}`).join(" | ")
  };
}

// ============ Run History（storage/test-assets/runs/<assetId>.json） ============

export function runHistoryPath(rootDir: string, assetId: string): string {
  return path.join(rootDir, "storage", "test-assets", "runs", `${assetId}.json`);
}

export async function appendRunHistory(rootDir: string, record: AssetRunRecord): Promise<void> {
  const p = runHistoryPath(rootDir, record.testAssetId);
  await fs.ensureDir(path.dirname(p));
  const existing = await loadRunHistory(rootDir, record.testAssetId);
  existing.push(record);
  await fs.writeJson(p, existing, { spaces: 2 });
}

export async function loadRunHistory(rootDir: string, assetId: string): Promise<AssetRunRecord[]> {
  const p = runHistoryPath(rootDir, assetId);
  if (!(await fs.pathExists(p))) return [];
  try { return (await fs.readJson(p)) as AssetRunRecord[]; } catch { return []; }
}

/** P13.39：asset query 用的派生 summary（不是 asset fact）。 */
export function runSummary(runs: AssetRunRecord[]): { lastRun?: string; lastPass?: string; lastFail?: string; passRate: number; latestEnvironment?: string } {
  const pass = runs.filter((r) => r.result === "PASS").length;
  return {
    lastRun: runs.at(-1)?.result,
    lastPass: [...runs].reverse().find((r) => r.result === "PASS")?.createdAt,
    lastFail: [...runs].reverse().find((r) => r.result !== "PASS")?.createdAt,
    passRate: runs.length ? pass / runs.length : 0,
    latestEnvironment: runs.at(-1)?.environment
  };
}

export function dslMaterializationFingerprint(input: { testAssetVersion: string; pageModelFingerprint?: string; knowledgeFingerprint?: string; testDataFingerprint?: string; accountProfile?: string; builderVersion: string }): string {
  const payload = JSON.stringify(input);
  return crypto.createHash("sha256").update(payload).digest("hex").slice(0, 16);
}
