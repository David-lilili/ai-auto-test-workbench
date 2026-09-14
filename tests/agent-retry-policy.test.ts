/**
 * Development Agent 重试策略测试（agent-retry-policy + ai-provider 接线）。
 * 覆盖：attempts <= 3 / 401/403 retry = 0 / backoff 1s->2s / telemetry 字段。
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_PROVIDER_RETRIES,
  PROVIDER_RETRY_BACKOFF_MS,
  classifyError,
  withProviderRetry,
  isRetryableReason
} from "../src/core/agent-retry-policy.js";
import type { RetryTelemetryRecord } from "../src/core/agent-retry-policy.js";
import { ProviderHttpError } from "../src/core/ai-provider.js";

const noSleep = async (): Promise<void> => undefined;

test("1. 错误分类：timeout / network / 429 / 5xx 可重试", () => {
  const cases: Array<[unknown, string]> = [
    [new Error("fetch aborted due to timeout"), "timeout"],
    [new Error("AI provider deepseek timed out after 60000ms."), "timeout"],
    [new Error("fetch failed"), "network_error"],
    [new Error("connect ECONNREFUSED 127.0.0.1:443"), "network_error"],
    [new ProviderHttpError(429, "AI provider failed: HTTP 429"), "http_429"],
    [new ProviderHttpError(500, "AI provider failed: HTTP 500"), "http_5xx"],
    [new ProviderHttpError(502, "AI provider failed: HTTP 502"), "http_5xx"],
    [new ProviderHttpError(503, "AI provider failed: HTTP 503"), "http_5xx"]
  ];
  for (const [error, expectedReason] of cases) {
    const classification = classifyError(error);
    assert.equal(classification.retryable, true, `expect retryable: ${String(error)}`);
    assert.equal(classification.retryReason, expectedReason);
    assert.ok(isRetryableReason(classification.retryReason!));
  }
});

test("2. 错误分类：400 / 401 / 403 / schema / deterministic 禁止重试", () => {
  const cases: Array<[unknown, string]> = [
    [new ProviderHttpError(400, "AI provider failed: HTTP 400"), "http_400"],
    [new ProviderHttpError(401, "AI provider failed: HTTP 401"), "http_401"],
    [new ProviderHttpError(403, "AI provider failed: HTTP 403"), "http_403"],
    [new Error("response does not satisfy schema: missing field"), "schema_validation_error"],
    [new Error("schema validation error at $.price"), "schema_validation_error"],
    [new Error("deterministic test failure: always fails"), "deterministic_error"],
    [Object.assign(new Error("explicit marker"), { deterministic: true }), "deterministic_error"],
    [Object.assign(new Error("code marker"), { code: "schema_validation" }), "schema_validation_error"],
    [new Error("unclassified error"), null]
  ];
  for (const [error, expectedReason] of cases) {
    const classification = classifyError(error);
    assert.equal(classification.retryable, false, `expect non-retryable: ${String(error)}`);
    assert.equal(classification.retryReason, expectedReason);
  }
});

test("3. Provider attempts <= 3：连续 5xx 最多 3 次 attempt 后失败", async () => {
  let calls = 0;
  const action = async (): Promise<string> => {
    calls += 1;
    throw new ProviderHttpError(503, `AI provider deepseek failed: HTTP 503 (call ${calls})`);
  };
  const { value, records, lastError } = await withProviderRetry(action, { callId: "call-3", sleep: noSleep });
  assert.equal(value, null);
  assert.equal(calls, MAX_PROVIDER_RETRIES + 1);
  assert.equal(records.length, 3);
  assert.ok(lastError instanceof ProviderHttpError);
  assert.deepEqual(records.map((r) => r.attempt), [1, 2, 3]);
  assert.deepEqual(records.map((r) => r.retryReason), ["http_5xx", "http_5xx", "http_5xx"]);
});

test("4. Provider attempts <= 3：429 两次后成功（第 3 次成功）", async () => {
  let calls = 0;
  const action = async (): Promise<string> => {
    calls += 1;
    if (calls <= 2) throw new ProviderHttpError(429, "AI provider deepseek failed: HTTP 429");
    return "ok";
  };
  const { value, records } = await withProviderRetry(action, { callId: "call-4", sleep: noSleep });
  assert.equal(value, "ok");
  assert.equal(calls, 3);
  assert.equal(records.length, 3);
  assert.deepEqual(records.map((r) => r.wasRetry), [false, true, true]);
});

test("5. 401 / 403 retry count = 0：单次 attempt，不重试", async () => {
  for (const status of [401, 403]) {
    let calls = 0;
    const action = async (): Promise<string> => {
      calls += 1;
      throw new ProviderHttpError(status, `AI provider deepseek failed: HTTP ${status}`);
    };
    const { value, records, lastError } = await withProviderRetry(action, { callId: `call-${status}`, sleep: noSleep });
    assert.equal(value, null);
    assert.equal(calls, 1, `HTTP ${status} must not retry`);
    assert.equal(records.length, 1);
    assert.equal(records[0].wasRetry, false);
    assert.equal(records[0].retryReason, status === 401 ? "http_401" : "http_403");
    assert.ok(lastError instanceof ProviderHttpError);
  }
});

test("6. 400 不重试", async () => {
  let calls = 0;
  const action = async (): Promise<string> => {
    calls += 1;
    throw new ProviderHttpError(400, "AI provider deepseek failed: HTTP 400");
  };
  await withProviderRetry(action, { callId: "call-400", sleep: noSleep });
  assert.equal(calls, 1);
});

test("7. Exponential backoff：重试前延迟为 1s -> 2s", async () => {
  const sleeps: number[] = [];
  const sleepRecorder = async (ms: number): Promise<void> => {
    sleeps.push(ms);
  };
  let calls = 0;
  const action = async (): Promise<string> => {
    calls += 1;
    if (calls <= 2) throw new ProviderHttpError(429, "AI provider deepseek failed: HTTP 429");
    return "ok";
  };
  await withProviderRetry(action, { callId: "call-backoff", sleep: sleepRecorder });
  assert.deepEqual(sleeps, [PROVIDER_RETRY_BACKOFF_MS[0], PROVIDER_RETRY_BACKOFF_MS[1]]);
  assert.deepEqual(sleeps, [1000, 2000]);
});

test("8. Telemetry 记录字段：attempt / retryReason / errorSignature / wasRetry / retryOfCallId", async () => {
  let calls = 0;
  const action = async (): Promise<string> => {
    calls += 1;
    if (calls === 1) throw new ProviderHttpError(500, "AI provider deepseek failed: HTTP 500");
    if (calls === 2) throw new Error("fetch failed (network)");
    return "ok";
  };
  const { records } = await withProviderRetry(action, { callId: "call-tel", sleep: noSleep });
  assert.equal(records.length, 3);

  const first = records[0];
  assert.equal(first.attempt, 1);
  assert.equal(first.retryReason, "http_5xx");
  assert.equal(first.errorSignature, null);
  assert.equal(first.wasRetry, false);
  assert.equal(first.retryOfCallId, null);

  const second = records[1];
  assert.equal(second.attempt, 2);
  assert.equal(second.retryReason, "network_error");
  assert.equal(second.wasRetry, true);
  assert.equal(second.retryOfCallId, "call-tel");

  const third = records[2];
  assert.equal(third.attempt, 3);
  assert.equal(third.retryReason, null);
  assert.equal(third.wasRetry, true);
  assert.equal(third.retryOfCallId, "call-tel");

  for (const record of records) {
    for (const key of ["attempt", "retryReason", "errorSignature", "wasRetry", "retryOfCallId"] as const) {
      assert.ok(key in record, `record must carry ${key}`);
    }
  }
});

test("9. 成功且无重试时只记录 1 条 attempt", async () => {
  const { value, records } = await withProviderRetry(async () => "ok", { callId: "call-9", sleep: noSleep });
  assert.equal(value, "ok");
  assert.equal(records.length, 1);
  assert.equal(records[0].wasRetry, false);
  assert.equal(records[0].retryReason, null);
});

test("10. 类型守卫：RetryTelemetryRecord 字段集合", () => {
  const record: RetryTelemetryRecord = {
    attempt: 1,
    retryReason: null,
    errorSignature: null,
    wasRetry: false,
    retryOfCallId: null
  };
  assert.deepEqual(Object.keys(record).sort(), ["attempt", "errorSignature", "retryOfCallId", "retryReason", "wasRetry"]);
});
