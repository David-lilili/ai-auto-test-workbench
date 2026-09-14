import type { LoadedContext } from "./types.js";
import { SimpleRedisClient } from "./redis-client.js";
import { redisSeedsForNetwork, resolveRedisConfig, type ResolvedRedisConfig } from "./redis-config.js";
import { logger } from "./logger.js";
import { readTotpCode } from "./totp-provider.js";

export type VerificationCodeSource = "redis" | "totp" | "email" | "mock" | "manual";
export type VerificationCodeType = "sms" | "email" | "totp";
export type VerificationCodeErrorCode =
  | "connection_failed"
  | "auth_failed"
  | "key_not_found"
  | "format_mismatch"
  | "timeout"
  | "config_error"
  | "forbidden"
  | "provider_error";

export interface VerificationCodeContext {
  project: string;
  env: string;
  scene: string;
  account: string;
  codeType: VerificationCodeType;
  timeoutSeconds?: number;
  pollIntervalSeconds?: number;
}

export interface VerificationCodeRequest extends Partial<VerificationCodeContext> {
  provider?: VerificationCodeSource;
  service?: string;
  network?: "external" | "internal";
  timeoutMs?: number;
  pollIntervalMs?: number;
  entry?: string;
  entryRoot?: string;
  cliPath?: string;
  databasePath?: string;
}

export interface VerificationCodeResult {
  success: boolean;
  code?: string;
  source: VerificationCodeSource;
  maskedTarget: string;
  fetchedAt: string;
  errorMessage?: string;
  errorCode?: VerificationCodeErrorCode;
  elapsedMs: number;
  metadata?: {
    service?: string;
    network?: string;
    scene?: string;
    codeType?: VerificationCodeType;
    key?: string;
    keyPatternName?: string;
    attempts?: Array<{ key: string; found: boolean; valueType?: string; errorCode?: VerificationCodeErrorCode }>;
  };
}

export interface VerificationCodeProvider {
  readonly source: VerificationCodeSource;
  get_code(context: VerificationCodeContext): Promise<VerificationCodeResult>;
}

interface RedisReadableClient {
  connect(): Promise<void>;
  select(db: number): Promise<void>;
  type(key: string): Promise<string>;
  get(key: string): Promise<string | undefined>;
  hgetall(key: string): Promise<Record<string, string>>;
  lrange(key: string, start?: number, stop?: number): Promise<string[]>;
  del(key: string): Promise<number>;
  close(): void;
}

interface RedisProviderOptions {
  service?: string;
  network?: "external" | "internal";
  timeoutMs?: number;
  pollIntervalMs?: number;
  clientFactory?: (seed: { host: string; port: number }, password: string | undefined, timeoutMs: number) => RedisReadableClient;
}

interface RedisReadConfig {
  db: number;
  timeoutMs: number;
  pollIntervalMs: number;
  codeRegex: RegExp;
  deleteAfterRead: boolean;
  valueTypes: Array<"string" | "hash" | "list">;
  keyPatterns: Array<{ name: string; key: string }>;
}

export class RedisVerificationCodeProvider implements VerificationCodeProvider {
  readonly source = "redis" as const;

  constructor(
    private readonly loadedContext: LoadedContext,
    private readonly options: RedisProviderOptions = {}
  ) {}

  async get_code(codeContext: VerificationCodeContext): Promise<VerificationCodeResult> {
    const startedAt = Date.now();
    const maskedTarget = maskTarget(codeContext.account);
    const service = this.options.service ?? "spot";
    const network = this.options.network ?? "external";

    logger.info("Verification code fetch started", {
      provider: this.source,
      project: codeContext.project,
      env: codeContext.env,
      scene: codeContext.scene,
      codeType: codeContext.codeType,
      account: maskedTarget
    });

    try {
      const forbidden = guardProductionRead(this.loadedContext);
      if (forbidden) return failure("forbidden", forbidden, startedAt, maskedTarget, service, network, codeContext);
      const redis = await resolveRedisConfig(this.loadedContext, service);
      const readConfig = buildRedisReadConfig(redis, codeContext, this.options);
      const seeds = uniqueRedisSeeds(redisSeedsForNetwork(redis, network));
      if (!redis.enabled) return failure("config_error", `Redis is disabled for ${codeContext.project}/${codeContext.env}.`, startedAt, maskedTarget, service, network, codeContext);
      if (!seeds.length) return failure("config_error", `No Redis ${network} seeds configured for ${codeContext.project}/${codeContext.env}/${service}.`, startedAt, maskedTarget, service, network, codeContext);
      if (redis.passwordSecret && !redis.password) return failure("auth_failed", `Redis password is missing for ${codeContext.project}/${codeContext.env}/${service}.`, startedAt, maskedTarget, service, network, codeContext);
      if (!readConfig.keyPatterns.length) return failure("config_error", `No Redis key patterns configured for scene=${codeContext.scene}.`, startedAt, maskedTarget, service, network, codeContext);

      const deadline = Date.now() + readConfig.timeoutMs;
      const attempts: NonNullable<VerificationCodeResult["metadata"]>["attempts"] = [];
      let lastError: { code: VerificationCodeErrorCode; message: string } | undefined;
      for (const seed of seeds) {
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) break;
        const client = this.createClient(seed, redis.password, Math.min(5_000, Math.max(500, remainingMs)));
        try {
          await client.connect();
          await client.select(readConfig.db);
          while (Date.now() < deadline) {
            for (const pattern of readConfig.keyPatterns) {
              const key = materializeKey(pattern.key, codeContext);
              try {
                const value = await readRedisValue(client, key, readConfig.valueTypes);
                attempts.push({ key: maskRedisKey(key), found: value.values.length > 0, valueType: value.type });
                const code = extractVerificationCode(value.values, readConfig.codeRegex);
                if (code) {
                  if (readConfig.deleteAfterRead) await client.del(key).catch(() => undefined);
                  return success(code, startedAt, maskedTarget, service, network, codeContext, maskRedisKey(key), pattern.name, attempts);
                }
                if (value.values.length > 0) lastError = { code: "format_mismatch", message: `Verification code format mismatch for key pattern ${pattern.name}.` };
              } catch (error) {
                const classified = classifyRedisError(error);
                attempts.push({ key: maskRedisKey(key), found: false, errorCode: classified.code });
                lastError = classified;
              }
            }
            await sleep(Math.min(readConfig.pollIntervalMs, Math.max(0, deadline - Date.now())));
          }
        } catch (error) {
          lastError = classifyRedisError(error);
        } finally {
          client.close();
        }
      }

      const errorCode =
        lastError?.code === "format_mismatch" || lastError?.code === "connection_failed" || lastError?.code === "auth_failed"
          ? lastError.code
          : "timeout";
      const message =
        errorCode === "format_mismatch"
          ? lastError?.message ?? "Verification code format mismatch."
          : errorCode === "connection_failed" || errorCode === "auth_failed"
            ? lastError?.message ?? "Redis verification code provider failed."
          : `Verification code not found before timeout for ${codeContext.scene}/${codeContext.codeType}.`;
      return failure(errorCode, message, startedAt, maskedTarget, service, network, codeContext, attempts);
    } finally {
      logger.info("Verification code fetch finished", {
        provider: this.source,
        project: codeContext.project,
        env: codeContext.env,
        scene: codeContext.scene,
        codeType: codeContext.codeType,
        account: maskedTarget,
        elapsedMs: Date.now() - startedAt
      });
    }
  }

  private createClient(seed: { host: string; port: number }, password: string | undefined, timeoutMs: number): RedisReadableClient {
    return this.options.clientFactory ? this.options.clientFactory(seed, password, timeoutMs) : new SimpleRedisClient(seed, password, timeoutMs);
  }
}

export async function getVerificationCode(context: LoadedContext, request: VerificationCodeRequest): Promise<VerificationCodeResult> {
  const codeContext = buildVerificationContext(context, request);
  const provider = request.provider ?? providerForCodeType(codeContext.codeType);
  if (provider === "redis") {
    return new RedisVerificationCodeProvider(context, {
      service: request.service,
      network: request.network,
      timeoutMs: request.timeoutMs,
      pollIntervalMs: request.pollIntervalMs
    }).get_code(codeContext);
  }
  if (provider === "totp") {
    const startedAt = Date.now();
    try {
      const code = await readTotpCode(context, {
        provider: "keepassxc",
        account: request.account,
        entry: request.entry,
        entryRoot: request.entryRoot,
        cliPath: request.cliPath,
        databasePath: request.databasePath,
        timeoutMs: request.timeoutMs
      });
      return {
        success: true,
        code,
        source: "totp",
        maskedTarget: maskTarget(codeContext.account),
        fetchedAt: new Date().toISOString(),
        elapsedMs: Date.now() - startedAt,
        metadata: { scene: codeContext.scene, codeType: codeContext.codeType }
      };
    } catch (error) {
      return failure("provider_error", error instanceof Error ? error.message : String(error), startedAt, maskTarget(codeContext.account), request.service, request.network, codeContext, undefined, "totp");
    }
  }
  return failure("provider_error", `Verification code provider is not implemented here: ${provider}`, Date.now(), maskTarget(codeContext.account), request.service, request.network, codeContext);
}

export const get_verification_code = getVerificationCode;

export interface RedisVerificationCodeRequest {
  account: string;
  project?: string;
  env?: string;
  scene?: string;
  codeType?: VerificationCodeType;
  service?: string;
  network?: "external" | "internal";
  timeoutMs?: number;
}

export interface RedisVerificationCodeResult {
  code: string;
  key: string;
  templateName: string;
  attempts: Array<{ key: string; found: boolean }>;
}

export async function readRedisVerificationCode(context: LoadedContext, request: RedisVerificationCodeRequest): Promise<RedisVerificationCodeResult> {
  const result = await getVerificationCode(context, {
    provider: "redis",
    account: request.account,
    scene: request.scene ?? "default",
    codeType: request.codeType ?? "email",
    service: request.service,
    network: request.network,
    timeoutMs: request.timeoutMs
  });
  if (!result.success || !result.code) throw new Error(result.errorMessage ?? "Verification code fetch failed.");
  return {
    code: result.code,
    key: result.metadata?.key ?? "",
    templateName: result.metadata?.keyPatternName ?? "",
    attempts: (result.metadata?.attempts ?? []).map((item) => ({ key: item.key, found: item.found }))
  };
}

export function maskTarget(target: string): string {
  if (target.includes("@")) {
    const [name, domain] = target.split("@");
    const maskedName = name.length <= 2 ? `${name[0] ?? ""}***` : `${name.slice(0, 2)}***`;
    return `${maskedName}@${domain}`;
  }
  return target.replace(/(\d{3})\d*(\d{4})$/, "$1****$2");
}

export function maskRedisKey(key: string): string {
  return key
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, (value) => maskTarget(value))
    .replace(/(\d{3})\d*(\d{4})/g, "$1****$2");
}

function buildVerificationContext(context: LoadedContext, request: VerificationCodeRequest): VerificationCodeContext {
  const account = request.account;
  if (!account) throw new Error("Verification code account is required.");
  return {
    project: request.project ?? context.project.projectKey,
    env: request.env ?? context.env.env,
    scene: request.scene ?? "default",
    account,
    codeType: request.codeType ?? "email",
    timeoutSeconds: request.timeoutSeconds,
    pollIntervalSeconds: request.pollIntervalSeconds
  };
}

function providerForCodeType(codeType: VerificationCodeType): VerificationCodeSource {
  return codeType === "totp" ? "totp" : "redis";
}

function guardProductionRead(context: LoadedContext): string | undefined {
  const safety = context.env.safety;
  if (safety?.productionReadonly && !safety.writeActionsAllowed) {
    return `Verification code reads are disabled by safety config for ${context.project.projectKey}/${context.env.env}.`;
  }
  return undefined;
}

function buildRedisReadConfig(redis: ResolvedRedisConfig, context: VerificationCodeContext, options: RedisProviderOptions): RedisReadConfig {
  const base = redis.verificationCodes;
  if (!base) throw new Error(`Redis verification code config is missing for ${context.project}/${context.env}/${redis.service}.`);
  const scene = base.scenes[context.scene];
  const keyPatterns = scene?.keyPatterns?.length ? scene.keyPatterns : base.keyTemplates;
  const requestTimeoutMs = context.timeoutSeconds === undefined ? undefined : context.timeoutSeconds * 1_000;
  const requestPollIntervalMs = context.pollIntervalSeconds === undefined ? undefined : context.pollIntervalSeconds * 1_000;
  const timeoutMs = options.timeoutMs ?? scene?.timeoutMs ?? requestTimeoutMs;
  const pollIntervalMs = options.pollIntervalMs ?? scene?.pollIntervalMs ?? requestPollIntervalMs;
  return {
    db: scene?.db ?? base.db,
    timeoutMs: timeoutMs ?? base.pollTimeoutMs,
    pollIntervalMs: pollIntervalMs ?? base.pollIntervalMs,
    codeRegex: new RegExp(scene?.codeRegex ?? base.codeRegex),
    deleteAfterRead: scene?.deleteAfterRead ?? base.deleteAfterRead,
    valueTypes: scene?.valueTypes ?? base.valueTypes,
    keyPatterns
  };
}

async function readRedisValue(client: RedisReadableClient, key: string, supportedTypes: Array<"string" | "hash" | "list">): Promise<{ type: string; values: string[] }> {
  const type = await client.type(key);
  if (type === "none") return { type, values: [] };
  if (type === "string" && supportedTypes.includes("string")) {
    const value = await client.get(key);
    return { type, values: value === undefined ? [] : [value] };
  }
  if (type === "hash" && supportedTypes.includes("hash")) {
    const value = await client.hgetall(key);
    return { type, values: Object.values(value) };
  }
  if (type === "list" && supportedTypes.includes("list")) {
    return { type, values: await client.lrange(key, 0, -1) };
  }
  return { type, values: [] };
}

function extractVerificationCode(values: string[], regex: RegExp): string | undefined {
  for (const value of values) {
    const match = value.match(regex);
    if (match?.[0]) return match[0];
  }
  return undefined;
}

function materializeKey(template: string, context: VerificationCodeContext): string {
  return template
    .replaceAll("{project}", context.project)
    .replaceAll("{env}", context.env)
    .replaceAll("{scene}", context.scene)
    .replaceAll("{account}", context.account)
    .replaceAll("{codeType}", context.codeType);
}

function uniqueRedisSeeds(seeds: Array<{ host: string; port: number }>): Array<{ host: string; port: number }> {
  const seen = new Set<string>();
  return seeds.filter((seed) => {
    const key = `${seed.host}:${seed.port}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function classifyRedisError(error: unknown): { code: VerificationCodeErrorCode; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  if (lower.includes("auth") || lower.includes("password") || lower.includes("noauth") || lower.includes("wrongpass")) return { code: "auth_failed", message };
  if (lower.includes("connect") || lower.includes("econn") || lower.includes("timeout") || lower.includes("network")) return { code: "connection_failed", message };
  return { code: "provider_error", message };
}

function success(
  code: string,
  startedAt: number,
  maskedTarget: string,
  service: string,
  network: string,
  context: VerificationCodeContext,
  key: string,
  keyPatternName: string,
  attempts: NonNullable<VerificationCodeResult["metadata"]>["attempts"]
): VerificationCodeResult {
  return {
    success: true,
    code,
    source: "redis",
    maskedTarget,
    fetchedAt: new Date().toISOString(),
    elapsedMs: Date.now() - startedAt,
    metadata: { service, network, scene: context.scene, codeType: context.codeType, key, keyPatternName, attempts }
  };
}

function failure(
  errorCode: VerificationCodeErrorCode,
  errorMessage: string,
  startedAt: number,
  maskedTarget: string,
  service: string | undefined,
  network: string | undefined,
  context: VerificationCodeContext,
  attempts?: NonNullable<VerificationCodeResult["metadata"]>["attempts"],
  source: VerificationCodeSource = "redis"
): VerificationCodeResult {
  return {
    success: false,
    source,
    maskedTarget,
    fetchedAt: new Date().toISOString(),
    errorCode,
    errorMessage,
    elapsedMs: Date.now() - startedAt,
    metadata: { service, network, scene: context.scene, codeType: context.codeType, attempts }
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
