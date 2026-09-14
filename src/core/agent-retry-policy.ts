/**
 * Development Agent 自动重试策略（P16 审计收敛项）。
 *
 * 约束：
 * - Provider/model 请求：首次 + 最多 2 次 retry，总 attempts <= 3。
 * - 仅允许 timeout / network error / HTTP 429 / HTTP 5xx 自动重试。
 * - 400 / 401 / 403 / schema/validation / deterministic error 禁止重试。
 * - Exponential backoff：1s -> 2s -> fail。
 * - 每次 attempt 记录 telemetry：attempt / retryReason / errorSignature / wasRetry / retryOfCallId。
 */

/** Provider 请求最多重试次数（首次 + maxRetries 次重试，总 attempts = maxRetries + 1）。 */
export const MAX_PROVIDER_RETRIES = 2;
/** 每次重试前的 backoff 延迟（ms）：第 1 次重试前 1s，第 2 次重试前 2s。 */
export const PROVIDER_RETRY_BACKOFF_MS = [1000, 2000] as const;

export type RetryReason =
  | "timeout"
  | "network_error"
  | "http_429"
  | "http_5xx"
  | "http_400"
  | "http_401"
  | "http_403"
  | "http_4xx"
  | "schema_validation_error"
  | "deterministic_error";

const RETRYABLE_REASONS: ReadonlySet<RetryReason> = new Set(["timeout", "network_error", "http_429", "http_5xx"]);

export function isRetryableReason(reason: RetryReason): boolean {
  return RETRYABLE_REASONS.has(reason);
}

export interface ErrorClassification {
  retryable: boolean;
  retryReason: RetryReason | null;
}

const TIMEOUT_PATTERN = /timeout|aborted|timed out/i;
const NETWORK_PATTERN = /fetch failed|network|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up|econnrefused|econnreset/i;
const SCHEMA_PATTERN = /schema[ _-]?validation|validation error|invalid schema|does not satisfy/i;
const DETERMINISTIC_PATTERN = /deterministic (?:error|failure|code|test)|no state change/i;

function extractHttpStatus(error: unknown): number | null {
  if (error && typeof error === "object") {
    const candidate = (error as { status?: unknown; statusCode?: unknown }).status ?? (error as { statusCode?: unknown }).statusCode;
    if (typeof candidate === "number" && Number.isInteger(candidate) && candidate >= 100 && candidate < 600) return candidate;
    if (typeof candidate === "string") {
      const parsed = Number.parseInt(candidate, 10);
      if (Number.isInteger(parsed) && parsed >= 100 && parsed < 600) return parsed;
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  const match = message.match(/HTTP[ /](\d{3})/i);
  if (match) {
    const parsed = Number.parseInt(match[1], 10);
    if (parsed >= 100 && parsed < 600) return parsed;
  }
  return null;
}

function classifyHttpStatus(status: number): RetryReason {
  if (status === 429) return "http_429";
  if (status >= 500 && status < 600) return "http_5xx";
  if (status === 400) return "http_400";
  if (status === 401) return "http_401";
  if (status === 403) return "http_403";
  return "http_4xx";
}

/**
 * 将任意错误分类为可重试 / 不可重试。
 * 优先级：HTTP 状态 > 显式标记（code/name/deterministic 属性）> 消息模式。
 */
export function classifyError(error: unknown): ErrorClassification {
  const status = extractHttpStatus(error);
  if (status !== null) {
    const reason = classifyHttpStatus(status);
    return { retryable: isRetryableReason(reason), retryReason: reason };
  }
  if (error && typeof error === "object") {
    const code = (error as { code?: unknown }).code;
    const name = error instanceof Error ? error.name : "";
    if (code === "schema_validation" || code === "SCHEMA_VALIDATION" || name === "SchemaValidationError") {
      return { retryable: false, retryReason: "schema_validation_error" };
    }
    if ((error as { deterministic?: unknown }).deterministic === true || code === "deterministic_error" || name === "DeterministicError") {
      return { retryable: false, retryReason: "deterministic_error" };
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  if (TIMEOUT_PATTERN.test(message)) return { retryable: true, retryReason: "timeout" };
  if (NETWORK_PATTERN.test(message)) return { retryable: true, retryReason: "network_error" };
  if (SCHEMA_PATTERN.test(message)) return { retryable: false, retryReason: "schema_validation_error" };
  if (DETERMINISTIC_PATTERN.test(message)) return { retryable: false, retryReason: "deterministic_error" };
  return { retryable: false, retryReason: null };
}

/** 每次 attempt 的 telemetry 记录（provider 与 tool 失败路径共用）。 */
export interface RetryTelemetryRecord {
  /** 1-based attempt 序号。 */
  attempt: number;
  /** 本次失败触发的分类原因；成功 attempt 为 null。 */
  retryReason: RetryReason | null;
  /** 工具失败路径为 buildErrorSignature 签名；provider 路径为 null（无 command/stderr 上下文）。 */
  errorSignature: string | null;
  /** 是否为重试 attempt（attempt > 1）。 */
  wasRetry: boolean;
  /** 重试所属的原始调用 ID；首次 attempt 为 null。 */
  retryOfCallId: string | null;
}

export interface ProviderRetryResult<T> {
  value: T | null;
  records: RetryTelemetryRecord[];
  lastError: Error | null;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 带策略的 provider 调用包装：
 * - 总 attempts <= MAX_PROVIDER_RETRIES + 1（= 3）。
 * - 仅 timeout / network / 429 / 5xx 重试；400/401/403/schema/deterministic 立即失败。
 * - backoff 1s -> 2s，可用 sleep 注入（测试用 0 延迟）。
 * - 返回每次 attempt 的 telemetry 记录。
 */
export async function withProviderRetry<T>(
  action: () => Promise<T>,
  options: { callId: string; sleep?: (ms: number) => Promise<void> } = { callId: "" }
): Promise<ProviderRetryResult<T>> {
  const sleep = options.sleep ?? defaultSleep;
  const maxAttempts = MAX_PROVIDER_RETRIES + 1;
  const records: RetryTelemetryRecord[] = [];
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const value = await action();
      records.push({
        attempt,
        retryReason: null,
        errorSignature: null,
        wasRetry: attempt > 1,
        retryOfCallId: attempt > 1 ? options.callId : null
      });
      return { value, records, lastError: null };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      const classification = classifyError(lastError);
      records.push({
        attempt,
        retryReason: classification.retryReason,
        errorSignature: null,
        wasRetry: attempt > 1,
        retryOfCallId: attempt > 1 ? options.callId : null
      });
      if (!classification.retryable || attempt >= maxAttempts) break;
      const delayMs = PROVIDER_RETRY_BACKOFF_MS[attempt - 1] ?? PROVIDER_RETRY_BACKOFF_MS[PROVIDER_RETRY_BACKOFF_MS.length - 1];
      await sleep(delayMs);
    }
  }
  return { value: null, records, lastError };
}
