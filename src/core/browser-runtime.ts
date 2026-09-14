import type { Browser, BrowserContext } from "@playwright/test";
import { chromium } from "@playwright/test";
import type { RuntimeOptions } from "./types.js";

export type BrowserRuntimeKind = "playwright-chromium" | "system-chrome" | "cdp-existing-chrome";

export interface BrowserAuthToken {
  token: string;
  originUrl: string;
  headerName?: string;
  storageKeys?: string[];
  cookieNames?: string[];
}

export interface BrowserRuntimeConfig {
  kind: BrowserRuntimeKind;
  headless: boolean;
  chromePath?: string;
  userDataDir?: string;
  cdpEndpoint?: string;
  viewport?: { width: number; height: number };
  extraHTTPHeaders?: Record<string, string>;
  authToken?: BrowserAuthToken;
  recordVideoDir?: string;
}

export interface BrowserRuntimeSession {
  browser?: Browser;
  context: BrowserContext;
  config: BrowserRuntimeConfig;
  close(): Promise<void>;
}

export function resolveBrowserRuntimeConfig(input: {
  headed?: boolean;
  options?: RuntimeOptions;
  extraHTTPHeaders?: Record<string, string>;
  authToken?: BrowserAuthToken;
  viewport?: { width: number; height: number };
  recordVideoDir?: string;
}): BrowserRuntimeConfig {
  const envKind = process.env.AI_AUTOTEST_BROWSER;
  const kind = normalizeRuntimeKind(envKind);
  const headless = process.env.AI_AUTOTEST_BROWSER_HEADLESS
    ? !isFalseLike(process.env.AI_AUTOTEST_BROWSER_HEADLESS)
    : !Boolean(input.headed);
  const authToken = input.authToken ?? input.options?.webAuthToken;
  const headerAuth = authToken?.headerName ? { [authToken.headerName]: authToken.token } : undefined;
  return {
    kind,
    headless,
    chromePath: process.env.AI_AUTOTEST_CHROME_PATH,
    userDataDir: process.env.AI_AUTOTEST_CHROME_USER_DATA_DIR,
    cdpEndpoint: process.env.AI_AUTOTEST_CDP_ENDPOINT || cdpEndpointFromPort(process.env.AI_AUTOTEST_REMOTE_DEBUGGING_PORT),
    viewport: input.viewport,
    extraHTTPHeaders: {
      ...(input.extraHTTPHeaders ?? {}),
      ...(input.options?.webAuthToken?.headerName ? { [input.options.webAuthToken.headerName]: input.options.webAuthToken.token } : {}),
      ...(headerAuth ?? {})
    },
    authToken,
    recordVideoDir: input.recordVideoDir
  };
}

export async function launchBrowserRuntime(config: BrowserRuntimeConfig): Promise<BrowserRuntimeSession> {
  if (config.kind === "cdp-existing-chrome") {
    if (!config.cdpEndpoint) throw new Error("AI_AUTOTEST_CDP_ENDPOINT or AI_AUTOTEST_REMOTE_DEBUGGING_PORT is required for cdp-existing-chrome.");
    const browser = await chromium.connectOverCDP(config.cdpEndpoint);
    const context = browser.contexts()[0] ?? await browser.newContext({
      extraHTTPHeaders: config.extraHTTPHeaders,
      viewport: config.viewport,
      recordVideo: config.recordVideoDir ? { dir: config.recordVideoDir } : undefined
    });
    if (config.authToken) await injectAuthState(context, config.authToken);
    return { browser, context, config, close: async () => { await browser.close(); } };
  }

  const launchOptions = {
    headless: config.headless,
    executablePath: config.kind === "system-chrome" ? config.chromePath : undefined
  };
  if (config.userDataDir) {
    const context = await chromium.launchPersistentContext(config.userDataDir, {
      ...launchOptions,
      extraHTTPHeaders: config.extraHTTPHeaders,
      viewport: config.viewport,
      recordVideo: config.recordVideoDir ? { dir: config.recordVideoDir } : undefined
    });
    if (config.authToken) await injectAuthState(context, config.authToken);
    return { context, config, close: async () => { await context.close(); } };
  }

  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext({
    extraHTTPHeaders: config.extraHTTPHeaders,
    viewport: config.viewport,
    recordVideo: config.recordVideoDir ? { dir: config.recordVideoDir } : undefined
  });
  if (config.authToken) await injectAuthState(context, config.authToken);
  return { browser, context, config, close: async () => { await browser.close(); } };
}

export async function injectAuthState(context: BrowserContext, auth: BrowserAuthToken): Promise<void> {
  const origin = new URL(auth.originUrl).origin;
  const storageKeys = auth.storageKeys?.length
    ? auth.storageKeys
    : [auth.headerName, "token", "TOKEN", "userToken", "accessToken", "access_token", "authToken", "Authorization", "loginToken"].filter(Boolean) as string[];
  const cookieNames = auth.cookieNames?.length ? auth.cookieNames : [auth.headerName ?? "token", "token"];
  const uniqueStorageKeys = [...new Set(storageKeys.filter(Boolean))];
  const uniqueCookieNames = [...new Set(cookieNames.filter(Boolean))];
  await context.addInitScript(
    ({ tokenValue, keys }) => {
      for (const key of keys) {
        window.localStorage.setItem(key, tokenValue);
        window.sessionStorage.setItem(key, tokenValue);
      }
    },
    { tokenValue: auth.token, keys: uniqueStorageKeys }
  );
  await context.addCookies(
    uniqueCookieNames.map((name) => ({
      name,
      value: auth.token,
      url: origin,
      httpOnly: false,
      secure: origin.startsWith("https://"),
      sameSite: "Lax" as const
    }))
  );
}

function normalizeRuntimeKind(value: string | undefined): BrowserRuntimeKind {
  if (value === "system-chrome" || value === "chrome") return "system-chrome";
  if (value === "cdp-existing-chrome" || value === "cdp") return "cdp-existing-chrome";
  return "playwright-chromium";
}

function isFalseLike(value: string | undefined): boolean {
  return /^(0|false|no|off)$/i.test(String(value ?? ""));
}

function cdpEndpointFromPort(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return `http://127.0.0.1:${value}`;
}
