import path from "node:path";
import fs from "fs-extra";
import YAML from "yaml";
import type { BrowserContext, Page } from "@playwright/test";
import type { CaptureAuthContext } from "./types.js";

export async function readCaptureAuthContext(rootDir: string, project: string, env: string): Promise<CaptureAuthContext> {
  const envFilePath = path.join(rootDir, "configs", "projects", project, `env.${env}.yaml`);
  const discoveryPath = path.join(rootDir, "storage", "environment-discovery", project, `${env}.json`);
  const accountStorePath = path.join(rootDir, "storage", "accounts.json");

  const envFile = await fs.pathExists(envFilePath) ? await fs.readFile(envFilePath, "utf8") : "";
  const envConfig = envFile ? (YAML.parse(envFile) ?? {}) : {};
  const webBaseUrl = readString(envConfig, ["web", "baseUrl"]) ?? "";
  const apiBaseUrl = readString(envConfig, ["api", "baseUrl"]) ?? "";

  const discovery = (await fs.readJson(discoveryPath).catch(() => ({}))) as Record<string, unknown>;
  const accountStore = (await fs.readJson(accountStorePath).catch(() => ({ accounts: [] }))) as { accounts?: Array<Record<string, unknown>> };
  const account = (accountStore.accounts ?? []).find((item) => item.project === project && item.env === env);
  const bypassLogin = normalizeBypassLogin(discovery.bypassLogin);
  const authInjection = normalizeAuthInjection(discovery.authInjection);
  return {
    webBaseUrl,
    apiBaseUrl,
    bypassLogin,
    authInjection,
    account: account ? { username: String(account.username ?? ""), password: String(account.password ?? "") } : undefined
  };
}

export async function requestBypassLogin(
  context: CaptureAuthContext
): Promise<{ token?: string; headerName: string; headers: Record<string, string> } | undefined> {
  const bypass = context.bypassLogin;
  const account = context.account;
  if (!bypass?.enabled || !account?.username || !account?.password || !context.apiBaseUrl) return undefined;
  const response = await fetch(new URL(bypass.path, context.apiBaseUrl), {
    method: bypass.method ?? "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...(bypass.extraPayload ?? {}),
      [bypass.usernameField]: account.username,
      [bypass.passwordField]: account.password,
      uaTime: formatDateTime(new Date())
    })
  });
  const body = (await response.json().catch(async () => ({ raw: await response.text() }))) as unknown;
  const token = readPath(body, bypass.tokenResponsePath ?? "data.token");
  const headerName = bypass.tokenHeaderName ?? "token";
  return token ? { token: String(token), headerName, headers: { [headerName]: String(token) } } : { headerName, headers: {} };
}

export async function injectAuthState(
  browserContext: BrowserContext,
  baseUrl: string,
  token: string,
  headerName = "token",
  authInjection?: { storageKeys?: string[]; cookieNames?: string[] }
): Promise<void> {
  const keys = authInjection?.storageKeys?.length ? authInjection.storageKeys : [headerName, "token", "exchange-token", "userToken", "accessToken"];
  await browserContext.addInitScript(({ tokenValue, storageKeys }) => {
    for (const key of storageKeys) {
      window.localStorage.setItem(key, tokenValue);
      window.sessionStorage.setItem(key, tokenValue);
    }
  }, { tokenValue: token, storageKeys: keys });
  const cookies = authInjection?.cookieNames?.length ? authInjection.cookieNames : [headerName, "token", "exchange-token"];
  await browserContext.addCookies(cookies.map((name) => ({ name, value: token, url: new URL(baseUrl).origin, sameSite: "Lax" as const })));
}

export async function waitSettled(page: Page): Promise<void> {
  await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => undefined);
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
  await page.waitForTimeout(1200);
}

function normalizeBypassLogin(value: unknown): CaptureAuthContext["bypassLogin"] {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (!record.path || !record.usernameField || !record.passwordField) return undefined;
  return {
    enabled: Boolean(record.enabled),
    method: typeof record.method === "string" ? record.method : undefined,
    path: String(record.path),
    tokenHeaderName: typeof record.tokenHeaderName === "string" ? record.tokenHeaderName : undefined,
    tokenResponsePath: typeof record.tokenResponsePath === "string" ? record.tokenResponsePath : undefined,
    usernameField: String(record.usernameField),
    passwordField: String(record.passwordField),
    extraPayload: (record.extraPayload && typeof record.extraPayload === "object" ? record.extraPayload : undefined) as Record<string, unknown> | undefined
  };
}

function normalizeAuthInjection(value: unknown): { storageKeys?: string[]; cookieNames?: string[] } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  return {
    storageKeys: Array.isArray(record.storageKeys) ? record.storageKeys.map(String) : undefined,
    cookieNames: Array.isArray(record.cookieNames) ? record.cookieNames.map(String) : undefined
  };
}

function readString(source: unknown, keys: string[]): string | undefined {
  let current: unknown = source;
  for (const key of keys) {
    if (!current || typeof current !== "object" || !(key in current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "string" && current ? current : undefined;
}

function readPath(value: unknown, pathText: string): unknown {
  return pathText.split(".").reduce<unknown>((current, key) => current && typeof current === "object" && key in current ? (current as Record<string, unknown>)[key] : undefined, value);
}

function formatDateTime(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function maskAccount(account: string): string {
  const [name, domain] = account.split("@");
  if (!domain) return `${account.slice(0, 2)}***`;
  return `${name.slice(0, 2)}***@${domain}`;
}
