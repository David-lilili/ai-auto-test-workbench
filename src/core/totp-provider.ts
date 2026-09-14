import { spawn } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import fs from "fs-extra";
import type { LoadedContext } from "./types.js";

export type TotpProviderName = "keepassxc" | "bitwarden" | "onepassword" | "vault";

export interface TotpProvider {
  get_totp(entry: string): Promise<string>;
}

export interface KeePassXcTotpProviderOptions {
  cliPath: string;
  databasePath: string;
  timeoutMs?: number;
  databasePassword?: string;
}

export interface TotpCodeRequest {
  provider?: TotpProviderName;
  account?: string;
  entry?: string;
  entryRoot?: string;
  cliPath?: string;
  databasePath?: string;
  timeoutMs?: number;
}

export interface KeePassXcTotpRegistrationRequest {
  account: string;
  secret: string;
  issuer?: string;
  entry?: string;
  entryRoot?: string;
  cliPath?: string;
  databasePath?: string;
  timeoutMs?: number;
}

export interface KeePassXcTotpRegistrationResult {
  entry: string;
  databasePath: string;
  verified: boolean;
  nativeTotpRegistered: boolean;
  fallbackOtpUriRegistered: boolean;
  providerReadable: boolean;
  registrationMode: "native_totp" | "notes_fallback" | "unverified";
}

export type TotpReadinessStatus =
  | "ready"
  | "provider_not_configured"
  | "provider_unimplemented"
  | "entry_missing"
  | "database_unlock_failed"
  | "totp_unreadable";

export interface TotpReadinessResult {
  ready: boolean;
  status: TotpReadinessStatus;
  reason?: string;
  digits?: number;
}

interface AccountTotpConfig {
  provider?: TotpProviderName;
  entry?: string;
  databasePath?: string;
}

interface LocalSecrets {
  data: unknown;
}

export class KeePassXcTotpProvider implements TotpProvider {
  private readonly cliPath: string;
  private readonly databasePath: string;
  private readonly timeoutMs: number;
  private readonly databasePassword?: string;

  constructor(options: KeePassXcTotpProviderOptions) {
    this.cliPath = options.cliPath;
    this.databasePath = options.databasePath;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.databasePassword = options.databasePassword;
  }

  async get_totp(entry: string): Promise<string> {
    const normalizedEntry = entry.trim();
    if (!normalizedEntry) throw new Error("KeePassXC TOTP entry is missing.");
    if (!(await fs.pathExists(this.cliPath))) throw new Error(`KeePassXC CLI not found: ${this.cliPath}`);
    if (!(await fs.pathExists(this.databasePath))) throw new Error(`KeePassXC database not found: ${this.databasePath}`);

    const result = await runKeepassXcTotp({
      cliPath: this.cliPath,
      databasePath: this.databasePath,
      entry: normalizedEntry,
      timeoutMs: this.timeoutMs,
      databasePassword: this.databasePassword
    });
    const code = result.stdout.trim().match(/^\d{6}$/)?.[0] ?? result.stdout.match(/\b\d{6}\b/)?.[0];
    if (code) return code;

    const fallbackCode = await readTotpFromKeePassXcOtpUri({
      cliPath: this.cliPath,
      databasePath: this.databasePath,
      entry: normalizedEntry,
      timeoutMs: this.timeoutMs,
      databasePassword: this.databasePassword
    });
    if (fallbackCode) return fallbackCode;
    throw mapKeePassXcError(result.exitCode, result.stdout, result.stderr, normalizedEntry);
  }
}

export async function readTotpCode(context: LoadedContext, request: TotpCodeRequest): Promise<string> {
  const secrets = await readLocalSecrets(context.rootDir);
  const envConfig = readEnvTotpConfig(context);
  const accountConfig = request.account ? readAccountTotpConfig(secrets, context, request.account) : {};
  const provider = request.provider ?? accountConfig.provider ?? envConfig.provider ?? "keepassxc";
  if (provider !== "keepassxc") throw new Error(`TOTP provider is not implemented yet: ${provider}`);

  const cliPath = request.cliPath ?? envConfig.cliPath;
  const databasePath = request.databasePath ?? accountConfig.databasePath ?? envConfig.databasePath;
  const entryRoot = request.entryRoot ?? envConfig.entryRoot;
  const entry =
    request.entry ??
    accountConfig.entry ??
    (request.account && entryRoot && cliPath && databasePath
      ? await resolveEntryFromKeePassXcGroup({
          cliPath,
          databasePath,
          entryRoot,
          account: request.account,
          timeoutMs: request.timeoutMs ?? envConfig.timeoutMs ?? 10_000,
          databasePassword: readDatabasePassword(secrets, context)
        })
      : undefined);
  if (!cliPath) throw new Error("KeePassXC CLI path is missing. Configure mfa.totp.providers.keepassxc.cliPath.");
  if (!databasePath) throw new Error("KeePassXC database path is missing. Configure mfa.totp.providers.keepassxc.databasePath.");
  if (!entry) throw new Error("KeePassXC TOTP entry is missing. Configure step.valueFrom.entry, account mfa.entry, or mfa.totp.providers.keepassxc.entryRoot.");

  const providerInstance = new KeePassXcTotpProvider({
    cliPath,
    databasePath,
    timeoutMs: request.timeoutMs ?? envConfig.timeoutMs,
    databasePassword: readDatabasePassword(secrets, context)
  });
  return providerInstance.get_totp(entry);
}

export async function checkTotpReadiness(context: LoadedContext, request: TotpCodeRequest): Promise<TotpReadinessResult> {
  try {
    const code = await readTotpCode(context, request);
    return {
      ready: true,
      status: "ready",
      digits: code.length
    };
  } catch (error) {
    return classifyTotpReadinessError(error);
  }
}

export function classifyTotpReadinessError(error: unknown): TotpReadinessResult {
  const message = sanitizeKeePassXcOutput(error instanceof Error ? error.message : String(error));
  const lower = message.toLowerCase();
  if (/not implemented/.test(lower)) {
    return { ready: false, status: "provider_unimplemented", reason: message };
  }
  if (/cli path is missing|database path is missing|cli not found|database not found|entry root is missing/.test(lower)) {
    return { ready: false, status: "provider_not_configured", reason: message };
  }
  if (/entry is missing|entry not found|multiple keepassxc entries match/.test(lower)) {
    return { ready: false, status: "entry_missing", reason: message };
  }
  if (/unlock failed|wrong password|invalid credentials|master password/.test(lower)) {
    return { ready: false, status: "database_unlock_failed", reason: message };
  }
  return { ready: false, status: "totp_unreadable", reason: message };
}

export async function registerKeePassXcTotpEntry(context: LoadedContext, request: KeePassXcTotpRegistrationRequest): Promise<KeePassXcTotpRegistrationResult> {
  const secrets = await readLocalSecrets(context.rootDir);
  const envConfig = readEnvTotpConfig(context);
  const cliPath = request.cliPath ?? envConfig.cliPath;
  const databasePath = request.databasePath ?? envConfig.databasePath;
  const entryRoot = request.entryRoot ?? envConfig.entryRoot;
  if (!cliPath) throw new Error("KeePassXC CLI path is missing. Configure mfa.totp.providers.keepassxc.cliPath.");
  if (!databasePath) throw new Error("KeePassXC database path is missing. Configure mfa.totp.providers.keepassxc.databasePath.");
  if (!entryRoot && !request.entry) throw new Error("KeePassXC entry root is missing. Configure mfa.totp.providers.keepassxc.entryRoot or pass an explicit entry.");
  if (!(await fs.pathExists(cliPath))) throw new Error(`KeePassXC CLI not found: ${cliPath}`);
  if (!(await fs.pathExists(databasePath))) throw new Error(`KeePassXC database not found: ${databasePath}`);

  const secret = normalizeBase32Secret(request.secret);
  if (!secret) throw new Error("TOTP secret is missing or not a valid Base32 value.");
  const entry = request.entry ?? `${entryRoot}/${request.account}`.replace(/\/+/g, "/");
  const group = entry.includes("/") ? entry.slice(0, entry.lastIndexOf("/")) : entryRoot;
  const issuer = request.issuer ?? context.project.projectName ?? context.project.projectKey;
  const otpUri = buildOtpAuthUri({ issuer, account: request.account, secret });
  const databasePassword = readDatabasePassword(secrets, context);
  const timeoutMs = request.timeoutMs ?? envConfig.timeoutMs ?? 10_000;

  if (group) {
    const mkdir = await runKeePassXcCommand({
      cliPath,
      args: ["mkdir", "-q", databasePath, group],
      timeoutMs,
      databasePassword
    });
    if (mkdir.exitCode !== 0 && !/exist|already|已(?:经)?存在/i.test(`${mkdir.stdout}\n${mkdir.stderr}`)) {
      throw mapKeePassXcError(mkdir.exitCode, mkdir.stdout, mkdir.stderr, group);
    }
  }

  const exists = await keepassXcEntryExists({ cliPath, databasePath, entry, timeoutMs, databasePassword });
  const commonArgs = [
    "--username",
    request.account,
    "--url",
    "https://www.example.com",
    "--notes",
    `Managed by ai-auto-test-workbench account factory.\n${otpUri}`,
    databasePath,
    entry
  ];
  const result = exists
    ? await runKeePassXcCommand({ cliPath, args: ["edit", "-q", ...commonArgs], timeoutMs, databasePassword })
    : await runKeePassXcCommand({ cliPath, args: ["add", "-q", ...commonArgs], timeoutMs, databasePassword });
  if (result.exitCode !== 0) throw mapKeePassXcError(result.exitCode, result.stdout, result.stderr, entry);

  const nativeResult = await runKeepassXcTotp({ cliPath, databasePath, entry, timeoutMs, databasePassword });
  const nativeCode = nativeResult.stdout.trim().match(/^\d{6}$/)?.[0] ?? nativeResult.stdout.match(/\b\d{6}\b/)?.[0];
  const nativeTotpRegistered = Boolean(nativeCode);
  const fallbackCode = await readTotpFromKeePassXcOtpUri({ cliPath, databasePath, entry, timeoutMs, databasePassword });
  const fallbackOtpUriRegistered = Boolean(fallbackCode);
  const providerReadable = nativeTotpRegistered || fallbackOtpUriRegistered;

  return {
    entry,
    databasePath,
    verified: providerReadable,
    nativeTotpRegistered,
    fallbackOtpUriRegistered,
    providerReadable,
    registrationMode: nativeTotpRegistered ? "native_totp" : fallbackOtpUriRegistered ? "notes_fallback" : "unverified"
  };
}

export function generateTotpCode(secret: string, nowMs = Date.now()): string {
  const key = base32Decode(normalizeBase32Secret(secret));
  const counter = Math.floor(nowMs / 1000 / 30);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac("sha1", key).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24) | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3];
  return String(binary % 1_000_000).padStart(6, "0");
}

function readEnvTotpConfig(context: LoadedContext): {
  provider?: TotpProviderName;
  cliPath?: string;
  databasePath?: string;
  entryRoot?: string;
  timeoutMs?: number;
} {
  const mfa = context.env.mfa && typeof context.env.mfa === "object" ? context.env.mfa : {};
  const totp = readRecord((mfa as Record<string, unknown>).totp);
  const providers = readRecord(totp.providers);
  const keepassxc = readRecord(providers.keepassxc ?? totp.keepassxc);
  return {
    provider: asTotpProvider(totp.defaultProvider ?? totp.provider) ?? "keepassxc",
    cliPath: readString(keepassxc.cliPath),
    databasePath: readString(keepassxc.databasePath),
    entryRoot: readString(keepassxc.entryRoot),
    timeoutMs: readNumber(keepassxc.timeoutMs)
  };
}

function readAccountTotpConfig(secrets: LocalSecrets, context: LoadedContext, account: string): AccountTotpConfig {
  const root = readRecord(secrets.data);
  const direct = readRecord(readRecord(readRecord(readRecord(root.mfa).accounts)[context.project.projectKey])[context.env.env])[account];
  const accountNode = direct ?? readRecord(readRecord(readRecord(root.accounts)[context.project.projectKey])[context.env.env])[account];
  const accountRecord = readRecord(accountNode);
  const mfa = readRecord(accountRecord.mfa ?? accountRecord);
  return {
    provider: asTotpProvider(mfa.provider),
    entry: readString(mfa.entry ?? mfa.totpEntry),
    databasePath: readString(mfa.databasePath)
  };
}

function readDatabasePassword(secrets: LocalSecrets, context: LoadedContext): string | undefined {
  const envPassword = process.env.KEEPASSXC_DATABASE_PASSWORD;
  if (envPassword) return envPassword;

  const mfa = context.env.mfa && typeof context.env.mfa === "object" ? context.env.mfa : {};
  const totp = readRecord((mfa as Record<string, unknown>).totp);
  const providers = readRecord(totp.providers);
  const keepassxc = readRecord(providers.keepassxc ?? totp.keepassxc);
  const secretPath = readString(keepassxc.databasePasswordSecret);
  if (!secretPath) return undefined;
  return readDottedSecret(secrets.data, secretPath);
}

async function readLocalSecrets(rootDir: string): Promise<LocalSecrets> {
  const filePath = path.join(rootDir, "storage", "secrets.local.json");
  if (!(await fs.pathExists(filePath))) return { data: {} };
  return { data: await fs.readJson(filePath) };
}

function readDottedSecret(data: unknown, dottedPath: string): string | undefined {
  const value = dottedPath.split(".").reduce<unknown>((current, key) => {
    return current && typeof current === "object" ? (current as Record<string, unknown>)[key] : undefined;
  }, data);
  return typeof value === "string" ? value : undefined;
}

async function runKeepassXcTotp(input: {
  cliPath: string;
  databasePath: string;
  entry: string;
  timeoutMs: number;
  databasePassword?: string;
}): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return runKeePassXcCommand({
    cliPath: input.cliPath,
    args: ["show", "--totp", input.databasePath, input.entry],
    timeoutMs: input.timeoutMs,
    databasePassword: input.databasePassword
  });
}

async function readTotpFromKeePassXcOtpUri(input: {
  cliPath: string;
  databasePath: string;
  entry: string;
  timeoutMs: number;
  databasePassword?: string;
}): Promise<string | undefined> {
  const result = await runKeePassXcCommand({
    cliPath: input.cliPath,
    args: ["show", "--show-protected", "--attributes", "Notes", input.databasePath, input.entry],
    timeoutMs: input.timeoutMs,
    databasePassword: input.databasePassword
  });
  if (result.exitCode !== 0) {
    const output = `${result.stdout}\n${result.stderr}`;
    if (/invalid credentials|wrong password|incorrect password|could not open|failed to open|unable to open|hmac|凭据无效|读取数据库时出错/i.test(output)) {
      throw mapKeePassXcError(result.exitCode, result.stdout, result.stderr, input.entry);
    }
    return undefined;
  }
  const otpUri = `${result.stdout}\n${result.stderr}`.match(/otpauth:\/\/totp\/[^\s]+/i)?.[0];
  if (!otpUri) return undefined;
  const parsed = new URL(otpUri);
  const secret = parsed.searchParams.get("secret");
  return secret ? generateTotpCode(secret) : undefined;
}

async function runKeePassXcCommand(input: {
  cliPath: string;
  args: string[];
  timeoutMs: number;
  databasePassword?: string;
}): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.cliPath, input.args, {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32" && /\.(?:cmd|bat)$/i.test(input.cliPath)
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`KeePassXC TOTP read timed out after ${input.timeoutMs}ms.`));
    }, input.timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({ exitCode, stdout, stderr });
    });
    if (input.databasePassword) child.stdin.end(`${input.databasePassword}\n`);
    else child.stdin.end();
  });
}

async function resolveEntryFromKeePassXcGroup(input: {
  cliPath: string;
  databasePath: string;
  entryRoot: string;
  account: string;
  timeoutMs: number;
  databasePassword?: string;
}): Promise<string | undefined> {
  const result = await runKeePassXcList({
    cliPath: input.cliPath,
    databasePath: input.databasePath,
    group: input.entryRoot,
    timeoutMs: input.timeoutMs,
    databasePassword: input.databasePassword
  });
  if (result.exitCode !== 0) throw mapKeePassXcError(result.exitCode, result.stdout, result.stderr, input.entryRoot);
  const entries = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.endsWith("/"));
  const accountLower = input.account.toLowerCase();
  const exact = entries.find((entry) => entry.toLowerCase() === accountLower);
  if (exact) return exact;
  const containing = entries.filter((entry) => entry.toLowerCase().includes(accountLower));
  if (containing.length === 1) return containing[0];
  if (containing.length > 1) {
    throw new Error(`Multiple KeePassXC entries match account ${input.account} under ${input.entryRoot}. Configure account mfa.entry explicitly.`);
  }
  return undefined;
}

async function runKeePassXcList(input: {
  cliPath: string;
  databasePath: string;
  group: string;
  timeoutMs: number;
  databasePassword?: string;
}): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return runKeePassXcCommand({
    cliPath: input.cliPath,
    args: ["ls", "-f", input.databasePath, input.group],
    timeoutMs: input.timeoutMs,
    databasePassword: input.databasePassword
  });
}

async function keepassXcEntryExists(input: {
  cliPath: string;
  databasePath: string;
  entry: string;
  timeoutMs: number;
  databasePassword?: string;
}): Promise<boolean> {
  const result = await runKeePassXcCommand({
    cliPath: input.cliPath,
    args: ["show", "-q", input.databasePath, input.entry],
    timeoutMs: input.timeoutMs,
    databasePassword: input.databasePassword
  });
  if (result.exitCode === 0) return true;
  const output = `${result.stdout}\n${result.stderr}`.toLowerCase();
  if (/does not exist|not found|no such entry|cannot find|不存在|找不到路径|找不到.*条目/.test(output)) return false;
  throw mapKeePassXcError(result.exitCode, result.stdout, result.stderr, input.entry);
}

function mapKeePassXcError(exitCode: number | null, stdout: string, stderr: string, entry: string): Error {
  const output = sanitizeKeePassXcOutput(`${stdout}\n${stderr}`.trim());
  const lower = output.toLowerCase();
  if (/does not exist|not found|no such entry|cannot find|找不到路径|找不到.*条目/.test(lower)) {
    return new Error(`KeePassXC entry not found: ${entry}`);
  }
  if (/totp.*not|no totp|not configured|does not have.*totp/.test(lower)) {
    return new Error(`KeePassXC TOTP is not configured for entry: ${entry}`);
  }
  if (/invalid credentials|wrong password|incorrect password|could not open|failed to open|unable to open|hmac|凭据无效|读取数据库时出错/.test(lower)) {
    return new Error("KeePassXC database unlock failed; check the master password.");
  }
  return new Error(`KeePassXC TOTP read failed${exitCode === null ? "" : ` with exit code ${exitCode}`}: ${output || "empty output"}`);
}

function sanitizeKeePassXcOutput(value: string): string {
  return value
    .replace(/\b\d{6}\b/g, "******")
    .replace(/otpauth:\/\/totp\/[^\s]+/gi, "otpauth://totp/<masked>")
    .replace(/\b[A-Z2-7]{16,}\b/g, "<masked-base32>");
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNumber(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

function asTotpProvider(value: unknown): TotpProviderName | undefined {
  return value === "keepassxc" || value === "bitwarden" || value === "onepassword" || value === "vault" ? value : undefined;
}

function buildOtpAuthUri(input: { issuer: string; account: string; secret: string }): string {
  const issuer = input.issuer.trim() || "DEMO";
  const label = `${issuer}:${input.account}`;
  const params = new URLSearchParams({
    secret: input.secret,
    issuer,
    algorithm: "SHA1",
    digits: "6",
    period: "30"
  });
  return `otpauth://totp/${encodeURIComponent(label)}?${params.toString()}`;
}

function normalizeBase32Secret(value: string | undefined): string {
  return String(value ?? "").replace(/\s+/g, "").replace(/=+$/g, "").toUpperCase();
}

function base32Decode(value: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of normalizeBase32Secret(value)) {
    const index = alphabet.indexOf(char);
    if (index < 0) throw new Error("TOTP secret contains non-Base32 characters.");
    bits += index.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let offset = 0; offset + 8 <= bits.length; offset += 8) {
    bytes.push(Number.parseInt(bits.slice(offset, offset + 8), 2));
  }
  return Buffer.from(bytes);
}
