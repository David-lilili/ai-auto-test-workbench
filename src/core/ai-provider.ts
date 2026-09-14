import fs from "fs-extra";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { withProviderRetry } from "./agent-retry-policy.js";
import type { RetryTelemetryRecord } from "./agent-retry-policy.js";

export type AiProviderName = "deepseek" | "openai" | "glm";

export interface AiProviderSettings {
  provider: AiProviderName;
  model: string;
  baseUrl?: string;
  apiKey?: string;
  updatedAt?: string;
}

export interface AiChatInput {
  rootDir: string;
  system: string;
  prompt: string;
  timeoutMs: number;
  /** P3-A8：稳定 prompt 版本标识，进入 telemetry/cache metadata，用于质量回归基线。 */
  promptVersion?: string;
  temperature?: number;
  maxTokens?: number;
  provider?: AiProviderName;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
}

export interface AiChatResult {
  status: "completed" | "skipped" | "failed";
  provider: AiProviderName;
  model: string;
  prompt?: string;
  rawOutput?: string;
  parsedOutput?: unknown;
  error?: string;
  telemetry: AiCallTelemetry;
}

export interface AiCallTelemetry {
  provider: AiProviderName;
  model: string;
  status: "completed" | "skipped" | "failed";
  promptVersion?: string;
  promptChars: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  elapsedMs?: number;
  parseStatus?: "parsed" | "unparseable" | "not_attempted";
  error?: string;
  /** 发生重试（或多于一次 attempt）时的逐次 attempt telemetry（agent-retry-policy）。 */
  attempts?: RetryTelemetryRecord[];
}

/**
 * Provider 非 2xx 响应错误。status 供 agent-retry-policy 分类：
 * 429 / 5xx 可重试，400 / 401 / 403 等 4xx 禁止重试。
 */
export class ProviderHttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "ProviderHttpError";
  }
}

/**
 * 所有 provider 走 OpenAI 兼容 /chat/completions 协议，差异只在 base URL。
 * glm 的腾讯部署必须显式配置 baseUrl；官方默认指向智谱 open.bigmodel.cn。
 */
const DEFAULT_BASE_URLS: Record<AiProviderName, string> = {
  deepseek: "https://api.deepseek.com",
  openai: "https://api.openai.com/v1",
  glm: "https://open.bigmodel.cn/api/paas/v4"
};

export function normalizeProviderName(value: unknown): AiProviderName {
  return value === "openai" || value === "glm" || value === "deepseek" ? value : "deepseek";
}

export function envApiKeyFor(provider: AiProviderName): string | undefined {
  if (provider === "glm") return process.env.GLM_API_KEY;
  if (provider === "openai") return process.env.OPENAI_API_KEY;
  return process.env.DEEPSEEK_API_KEY;
}

export function envBaseUrlFor(provider: AiProviderName): string | undefined {
  const value = provider === "glm" ? process.env.GLM_BASE_URL : provider === "openai" ? process.env.OPENAI_BASE_URL : process.env.DEEPSEEK_BASE_URL;
  return value && value.trim() ? value.trim() : undefined;
}

export function envModelFor(provider: AiProviderName): string | undefined {
  const value = provider === "glm" ? process.env.GLM_MODEL : provider === "openai" ? process.env.OPENAI_MODEL : process.env.DEEPSEEK_MODEL;
  return value && value.trim() ? value.trim() : undefined;
}

export function normalizeAiModel(provider: AiProviderName, model: string): string {
  const value = String(model || "").trim();
  if (provider === "deepseek" && (!value || value === "deepseek-chat" || value === "deepseek-reasoner")) return "deepseek-v4-flash";
  return value;
}

/** base URL（如 https://host/v1）→ 完整 chat/completions endpoint；已带路径则原样使用。 */
export function resolveChatEndpoint(baseUrl: string): string {
  const trimmed = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!trimmed) throw new Error("AI provider base URL is empty.");
  return trimmed.endsWith("/chat/completions") ? trimmed : `${trimmed}/chat/completions`;
}

export interface AiRuntimeConfig {
  provider: AiProviderName;
  model: string;
  apiKey?: string;
  baseUrl: string;
  endpoint: string;
}

/**
 * 统一的 provider 运行时解析，环境变量优先：
 * 环境变量（GLM_API_KEY/GLM_MODEL/GLM_BASE_URL 等）> 显式覆盖 > storage/ai-settings.json > 默认值。
 * 有任何一个 provider 的环境变量在运行时存在时，该字段以环境变量为准（「写死」入口）。
 */
export async function resolveAiRuntime(rootDir: string, overrides?: {
  provider?: AiProviderName;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
}): Promise<AiRuntimeConfig> {
  const settings = await readAiProviderSettings(rootDir);
  // 环境变量声明了 provider 就以它为准；否则用设置文件或默认 deepseek。
  const envProvider = process.env.AI_PROVIDER;
  const provider = normalizeProviderName(envProvider ?? overrides?.provider ?? settings.provider);
  const envModel = envModelFor(provider);
  const envBase = envBaseUrlFor(provider);
  const envKey = envApiKeyFor(provider);
  const model = normalizeAiModel(
    provider,
    envModel ?? overrides?.model ?? settings.model ?? ""
  );
  const apiKey = envKey ?? overrides?.apiKey ?? settings.apiKey;
  const baseUrl = String(envBase ?? overrides?.baseUrl ?? settings.baseUrl ?? DEFAULT_BASE_URLS[provider] ?? "").trim();
  return { provider, model, apiKey, baseUrl, endpoint: resolveChatEndpoint(baseUrl) };
}

/** 是否完全由环境变量驱动（用于前端只读展示当前生效配置来源）。 */
export function aiRuntimeSource(provider: AiProviderName): { provider: AiProviderName; envDriven: boolean; missing: string[] } {
  const missing: string[] = [];
  if (!envApiKeyFor(provider)) missing.push(`${provider.toUpperCase()}_API_KEY`);
  if (!envModelFor(provider)) missing.push(`${provider.toUpperCase()}_MODEL`);
  if (provider === "glm" && !envBaseUrlFor(provider)) missing.push("GLM_BASE_URL");
  return { provider, envDriven: missing.length === 0, missing };
}

export async function callConfiguredAiJson(input: AiChatInput): Promise<AiChatResult> {
  const runtime = await resolveAiRuntime(input.rootDir, input);
  const { provider, model, apiKey } = runtime;
  const startedAt = Date.now();
  const promptChars = input.prompt.length;
  if (!apiKey) {
    const error = `${provider} API key is not configured.`;
    return {
      status: "skipped",
      provider,
      model,
      prompt: input.prompt,
      error,
      telemetry: { provider, model, status: "skipped", promptChars, elapsedMs: 0, parseStatus: "not_attempted", error }
    };
  }
  if (!model) {
    const error = `${provider} model is not configured. Set the model (e.g. glm-5.3-tencent) in storage/ai-settings.json.`;
    return {
      status: "failed",
      provider,
      model,
      prompt: input.prompt,
      error,
      telemetry: { provider, model, status: "failed", promptChars, elapsedMs: 0, parseStatus: "not_attempted", error }
    };
  }
  const callId = randomUUID();
  const { value, records, lastError } = await withProviderRetry(
    () => performProviderRequest(input, runtime, startedAt, promptChars),
    { callId }
  );
  if (value) {
    if (records.length > 1 || records[0].retryReason !== null) value.telemetry.attempts = records;
    return value;
  }
  const error = lastError?.message ?? `AI provider ${provider} request failed.`;
  const attempts = records.length > 1 || records[0].retryReason !== null ? records : undefined;
  return {
    status: "failed",
    provider,
    model,
    prompt: input.prompt,
    error,
    telemetry: buildTelemetry({ provider, model, status: "failed", promptChars, startedAt, parseStatus: "not_attempted", error, promptVersion: input.promptVersion, attempts })
  };
}

async function performProviderRequest(input: AiChatInput, runtime: AiRuntimeConfig, startedAt: number, promptChars: number): Promise<AiChatResult> {
  const { provider, model } = runtime;
  let response: Response;
  try {
    response = await fetch(runtime.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${runtime.apiKey}` },
      signal: AbortSignal.timeout(input.timeoutMs),
      body: JSON.stringify({
        model,
        temperature: input.temperature ?? 0.1,
        ...(input.maxTokens ? { max_tokens: input.maxTokens } : {}),
        messages: [
          { role: "system", content: input.system },
          { role: "user", content: input.prompt }
        ]
      })
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const timeout = /timeout|aborted/i.test(message);
    const normalized = timeout ? `AI provider ${provider} timed out after ${input.timeoutMs}ms.` : `AI provider ${provider} error: ${message}`;
    throw new Error(normalized);
  }
  const payload = (await response.json().catch(async () => ({ error: await response.text().catch(() => "") }))) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    error?: unknown;
  };
  if (!response.ok) {
    throw new ProviderHttpError(
      response.status,
      `AI provider ${provider} failed: HTTP ${response.status}${payload.error ? ` ${redactAiErrorBody(JSON.stringify(payload.error))}` : ""}`
    );
  }
  const rawOutput = payload.choices?.[0]?.message?.content ?? "";
  const parsedOutput = parseJsonOrUndefined(rawOutput);
  return {
    status: "completed",
    provider,
    model,
    prompt: input.prompt,
    rawOutput,
    parsedOutput,
    telemetry: buildTelemetry({
      provider,
      model,
      status: "completed",
      promptChars,
      startedAt,
      usage: payload.usage,
      parseStatus: parsedOutput === undefined ? "unparseable" : "parsed",
      promptVersion: input.promptVersion
    })
  };
}

export async function readAiProviderSettings(rootDir: string): Promise<AiProviderSettings> {
  const filePath = path.join(rootDir, "storage", "ai-settings.json");
  if (!(await fs.pathExists(filePath))) {
    return { provider: "deepseek", model: normalizeAiModel("deepseek", process.env.DEEPSEEK_MODEL || "deepseek-v4-flash"), updatedAt: new Date().toISOString() };
  }
  const settings = (await fs.readJson(filePath)) as Partial<AiProviderSettings>;
  const provider = normalizeProviderName(settings.provider);
  const model = normalizeAiModel(provider, settings.model || envModelFor(provider) || "");
  return {
    provider,
    model,
    baseUrl: typeof settings.baseUrl === "string" && settings.baseUrl.trim() ? settings.baseUrl.trim() : undefined,
    apiKey: settings.apiKey,
    updatedAt: settings.updatedAt || new Date().toISOString()
  };
}

export function parseJsonOrUndefined(value: string): unknown {
  const trimmed = value.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = (fenced ?? trimmed).trim();
  try {
    return JSON.parse(candidate);
  } catch {
    return undefined;
  }
}

function buildTelemetry(input: {
  provider: AiProviderName;
  model: string;
  status: "completed" | "skipped" | "failed";
  promptChars: number;
  startedAt: number;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  parseStatus: "parsed" | "unparseable" | "not_attempted";
  error?: string;
  promptVersion?: string;
  attempts?: RetryTelemetryRecord[];
}): AiCallTelemetry {
  return {
    provider: input.provider,
    model: input.model,
    status: input.status,
    promptVersion: input.promptVersion,
    promptChars: input.promptChars,
    promptTokens: input.usage?.prompt_tokens,
    completionTokens: input.usage?.completion_tokens,
    totalTokens: input.usage?.total_tokens,
    elapsedMs: Date.now() - input.startedAt,
    parseStatus: input.parseStatus,
    error: input.error,
    attempts: input.attempts
  };
}

function redactAiErrorBody(value: string): string {
  return value
    .replace(/sk-[A-Za-z0-9_-]+/g, "sk-***")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer ***")
    .slice(0, 800);
}
