import path from "node:path";
import fs from "fs-extra";
import { loadContext } from "../src/core/config-loader.js";
import { launchBrowserRuntime, resolveBrowserRuntimeConfig } from "../src/core/browser-runtime.js";
import { AccountStore } from "../src/memory/account-store.js";
import { EnvironmentDiscoveryStore } from "../src/memory/environment-discovery-store.js";
import type { LoadedContext, TestAccount } from "../src/core/types.js";
import { writeSafeJsonFile } from "../src/core/safe-file-writer.js";

const args = parseArgs(process.argv.slice(2));
const project = args.project ?? "demo";
const env = args.env ?? "test";
const targetUrl = args.url ?? "http://www.example.com/zh-hans/assets/flows/spot-flow";
const headed = args.headed === "true" || args.headed === "1";
const holdMs = Number(args.holdMs ?? (headed ? "120000" : "0"));
const outPath = args.out ?? "reports/browser-runtime-check.json";

const context = await loadContext({ project, env });
const account = await firstAccount(context);
const auth = account ? await buildWebAuth(context, account).catch((error) => ({ error })) : undefined;
const runtime = await launchBrowserRuntime(resolveBrowserRuntimeConfig({
  headed,
  authToken: auth && "token" in auth && context.env.web?.baseUrl
    ? {
        token: auth.token,
        originUrl: context.env.web.baseUrl,
        headerName: auth.headerName,
        storageKeys: auth.storageKeys,
        cookieNames: auth.cookieNames
      }
    : undefined,
  extraHTTPHeaders: auth && "token" in auth ? { [auth.headerName]: auth.token } : undefined,
  viewport: { width: 1440, height: 1000 }
}));

const page = await runtime.context.newPage();
const result: Record<string, unknown> = {
  schemaVersion: "browser-runtime-check.v1",
  project,
  env,
  targetUrl,
  runtime: {
    kind: runtime.config.kind,
    headless: runtime.config.headless,
    hasUserDataDir: Boolean(runtime.config.userDataDir),
    hasCdpEndpoint: Boolean(runtime.config.cdpEndpoint)
  },
  auth: {
    account: account?.username ? maskAccount(account.username) : undefined,
    bypassLoginAttempted: Boolean(account),
    bypassLoginSucceeded: Boolean(auth && "token" in auth),
    bypassLoginError: auth && "error" in auth ? String(auth.error instanceof Error ? auth.error.message : auth.error) : undefined
  }
};

try {
  await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
  await page.waitForTimeout(1500);
  const beforeUrl = page.url();
  const beforeTitle = await page.title().catch(() => "");
  const beforeText = await visibleText(page);
  const typeTriggerCount = await page.getByText("全部类型", { exact: false }).count().catch(() => 0);
  const signedIn = !/\/signin/i.test(beforeUrl) && beforeText.includes("资金流水");

  let clickSucceeded = false;
  let clickError: string | undefined;
  if (typeTriggerCount > 0) {
    await page.getByText("全部类型", { exact: false }).first().click({ timeout: 10_000 }).then(
      () => { clickSucceeded = true; },
      (error) => { clickError = error instanceof Error ? error.message : String(error); }
    );
  }
  await page.waitForTimeout(1000);
  const afterText = await visibleText(page);
  const redPacketIssuedCount = await page.getByText("红包发放", { exact: false }).count().catch(() => 0);
  Object.assign(result, {
    page: {
      beforeUrl,
      beforeTitle,
      signedIn,
      typeTriggerCount,
      clickSucceeded,
      clickError,
      redPacketIssuedCount,
      dropdownOpened: redPacketIssuedCount > 0 || afterText.includes("红包发放")
    }
  });
  await writeSafeJsonFile(path.resolve(outPath), result);
  if (holdMs > 0) await page.waitForTimeout(holdMs);
} finally {
  await writeSafeJsonFile(path.resolve(outPath), result);
  if (!headed || holdMs <= 0) await runtime.close().catch(() => undefined);
}

console.log(JSON.stringify(result, null, 2));

async function firstAccount(context: LoadedContext): Promise<TestAccount | undefined> {
  const accounts = await new AccountStore(context).list({ project: context.project.projectKey, env: context.env.env });
  return accounts[0];
}

async function buildWebAuth(context: LoadedContext, account: TestAccount): Promise<{ token: string; headerName: string; storageKeys?: string[]; cookieNames?: string[] }> {
  const discovery = await new EnvironmentDiscoveryStore(context).load(context.project.projectKey, context.env.env);
  const bypass = discovery.bypassLogin;
  if (!bypass?.enabled) throw new Error("Bypass login is not enabled.");
  if (!context.env.api?.baseUrl) throw new Error("Bypass login requires env.api.baseUrl.");
  const response = await fetch(new URL(bypass.path, context.env.api.baseUrl), {
    method: bypass.method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...(bypass.extraPayload ?? {}), [bypass.usernameField]: account.username, [bypass.passwordField]: account.password, uaTime: formatDateTime(new Date()) })
  });
  const body = await response.json().catch(async () => ({ raw: await response.text() }));
  const token = readJsonPath(body, bypass.tokenResponsePath);
  if (!response.ok || !token) throw new Error(`Bypass login failed: HTTP ${response.status}`);
  return { token: String(token), headerName: bypass.tokenHeaderName, storageKeys: discovery.authInjection?.storageKeys, cookieNames: discovery.authInjection?.cookieNames };
}

async function visibleText(page: { locator(selector: string): { evaluate(fn: (body: HTMLElement) => string): Promise<string> } }): Promise<string> {
  return page.locator("body").evaluate((body) => body.innerText || "").catch(() => "");
}

function readJsonPath(value: unknown, dotPath: string): unknown {
  return dotPath.split(".").reduce((current: any, key) => current?.[key], value);
}

function formatDateTime(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function maskAccount(value: string): string {
  const [name, domain] = value.split("@");
  if (!domain) return `${value.slice(0, 2)}***`;
  return `${name.slice(0, 2)}***@${domain}`;
}

function parseArgs(values: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let index = 0; index < values.length; index += 1) {
    const item = values[index];
    if (!item?.startsWith("--")) continue;
    const key = item.slice(2);
    const next = values[index + 1];
    if (next && !next.startsWith("--")) {
      out[key] = next;
      index += 1;
    } else {
      out[key] = "true";
    }
  }
  return out;
}
