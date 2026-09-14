import path from "node:path";
import fs from "fs-extra";
import type { LoadedContext } from "./types.js";

export interface RedisSeed {
  host: string;
  port: number;
}

export interface ResolvedRedisConfig {
  project: string;
  env: string;
  service: string;
  enabled: boolean;
  version?: string;
  mode: "standalone" | "cluster";
  externalSeeds: RedisSeed[];
  internalSeeds: RedisSeed[];
  password?: string;
  passwordSecret?: string;
  verificationCodes?: RedisVerificationCodeConfig;
}

export interface RedisVerificationCodeConfig {
  db: number;
  pollTimeoutMs: number;
  pollIntervalMs: number;
  codeRegex: string;
  deleteAfterRead: boolean;
  valueTypes: Array<"string" | "hash" | "list">;
  keyTemplates: Array<{ name: string; key: string }>;
  scenes: Record<string, RedisVerificationSceneConfig>;
}

export interface RedisVerificationSceneConfig {
  provider?: string;
  codeType?: "sms" | "email" | "totp";
  keyPatterns: Array<{ name: string; key: string }>;
  codeRegex?: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  db?: number;
  deleteAfterRead?: boolean;
  valueTypes?: Array<"string" | "hash" | "list">;
}

export async function resolveRedisConfig(context: LoadedContext, service = "spot"): Promise<ResolvedRedisConfig> {
  const redis = context.env.redis && typeof context.env.redis === "object" ? (context.env.redis as Record<string, unknown>) : {};
  const services = redis.services && typeof redis.services === "object" ? (redis.services as Record<string, unknown>) : {};
  const rawService = services[service] && typeof services[service] === "object" ? (services[service] as Record<string, unknown>) : redis;
  const passwordSecret = typeof rawService.passwordSecret === "string" ? rawService.passwordSecret : undefined;
  return {
    project: context.project.projectKey,
    env: context.env.env,
    service,
    enabled: Boolean(redis.enabled),
    version: typeof rawService.version === "string" ? rawService.version : undefined,
    mode: rawService.mode === "cluster" ? "cluster" : "standalone",
    externalSeeds: parseRedisSeeds(rawService.externalSeeds),
    internalSeeds: parseRedisSeeds(rawService.internalSeeds),
    passwordSecret,
    password: passwordSecret ? await readSecretValue(context.rootDir, passwordSecret) : undefined,
    verificationCodes: parseVerificationCodeConfig(rawService.verificationCodes)
  };
}

export function redisSeedsForNetwork(config: ResolvedRedisConfig, network: "external" | "internal"): RedisSeed[] {
  const selected = network === "internal" ? config.internalSeeds : config.externalSeeds;
  return selected.length ? selected : config.externalSeeds.length ? config.externalSeeds : config.internalSeeds;
}

function parseRedisSeeds(value: unknown): RedisSeed[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!item || typeof item !== "object") return undefined;
      const raw = item as Record<string, unknown>;
      const host = typeof raw.host === "string" ? raw.host.trim() : "";
      const port = Number(raw.port ?? 6379);
      return host && Number.isFinite(port) ? { host, port } : undefined;
    })
    .filter((item): item is RedisSeed => Boolean(item));
}

function parseVerificationCodeConfig(value: unknown): RedisVerificationCodeConfig | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const keyTemplates = Array.isArray(raw.keyTemplates)
    ? raw.keyTemplates
        .map((item) => {
          if (!item || typeof item !== "object") return undefined;
          const record = item as Record<string, unknown>;
          const name = typeof record.name === "string" ? record.name : "";
          const key = typeof record.key === "string" ? record.key : "";
          return name && key ? { name, key } : undefined;
        })
        .filter((item): item is { name: string; key: string } => Boolean(item))
    : [];
  return {
    db: Number(raw.db ?? 0),
    pollTimeoutMs: Number(raw.pollTimeoutMs ?? 15_000),
    pollIntervalMs: Number(raw.pollIntervalMs ?? 1_000),
    codeRegex: typeof raw.codeRegex === "string" ? raw.codeRegex : "\\b\\d{4,8}\\b",
    deleteAfterRead: Boolean(raw.deleteAfterRead),
    valueTypes: parseValueTypes(raw.valueTypes),
    keyTemplates,
    scenes: parseVerificationScenes(raw.scenes)
  };
}

function parseVerificationScenes(value: unknown): Record<string, RedisVerificationSceneConfig> {
  if (!value || typeof value !== "object") return {};
  const scenes: Record<string, RedisVerificationSceneConfig> = {};
  for (const [scene, rawValue] of Object.entries(value as Record<string, unknown>)) {
    if (!rawValue || typeof rawValue !== "object") continue;
    const raw = rawValue as Record<string, unknown>;
    const keyPatterns = Array.isArray(raw.keyPatterns)
      ? raw.keyPatterns
          .map((item) => {
            if (!item || typeof item !== "object") return undefined;
            const record = item as Record<string, unknown>;
            const name = typeof record.name === "string" ? record.name : "";
            const key = typeof record.key === "string" ? record.key : "";
            return name && key ? { name, key } : undefined;
          })
          .filter((item): item is { name: string; key: string } => Boolean(item))
      : [];
    scenes[scene] = {
      provider: typeof raw.provider === "string" ? raw.provider : undefined,
      codeType: raw.codeType === "sms" || raw.codeType === "email" || raw.codeType === "totp" ? raw.codeType : undefined,
      keyPatterns,
      codeRegex: typeof raw.codeRegex === "string" ? raw.codeRegex : undefined,
      timeoutMs: raw.timeoutMs === undefined ? undefined : Number(raw.timeoutMs),
      pollIntervalMs: raw.pollIntervalMs === undefined ? undefined : Number(raw.pollIntervalMs),
      db: raw.db === undefined ? undefined : Number(raw.db),
      deleteAfterRead: raw.deleteAfterRead === undefined ? undefined : Boolean(raw.deleteAfterRead),
      valueTypes: raw.valueTypes === undefined ? undefined : parseValueTypes(raw.valueTypes)
    };
  }
  return scenes;
}

function parseValueTypes(value: unknown): Array<"string" | "hash" | "list"> {
  if (!Array.isArray(value)) return ["string"];
  const parsed = value.filter((item): item is "string" | "hash" | "list" => item === "string" || item === "hash" || item === "list");
  return parsed.length ? parsed : ["string"];
}

async function readSecretValue(rootDir: string, dottedPath: string): Promise<string | undefined> {
  const filePath = path.join(rootDir, "storage", "secrets.local.json");
  if (!(await fs.pathExists(filePath))) return undefined;
  const data = (await fs.readJson(filePath)) as unknown;
  const value = dottedPath.split(".").reduce<unknown>((current, key) => {
    return current && typeof current === "object" ? (current as Record<string, unknown>)[key] : undefined;
  }, data);
  return typeof value === "string" ? value : undefined;
}
