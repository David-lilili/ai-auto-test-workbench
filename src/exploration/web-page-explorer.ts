import crypto from "node:crypto";
import { chromium, type Browser, type BrowserContext, type Page } from "@playwright/test";
import type {
  ExplorationMode,
  EnvironmentDiscovery,
  LoadedContext,
  PageEdgeMemory,
  PageElementMemory,
  PageNodeMemory,
  WebSurface
} from "../core/types.js";
import { logger } from "../core/logger.js";
import { PageGraphStore } from "../memory/page-graph-store.js";
import { KnowledgeStore } from "../memory/knowledge-store.js";
import { EnvironmentDiscoveryStore } from "../memory/environment-discovery-store.js";
import { AccountStore } from "../memory/account-store.js";

const RISKY_TEXT = [
  "支付",
  "下单",
  "提交订单",
  "确认交易",
  "提现",
  "转账",
  "删除",
  "注销",
  "关闭账户",
  "confirm",
  "pay",
  "submit order",
  "withdraw",
  "transfer",
  "delete"
];

const GLOBAL_NOISE_TEXT = [
  "下载APP",
  "下载 APP",
  "语言",
  "Open menu",
  "Notifications",
  "Notifications alt+T",
  "Go to previous page",
  "Go to next page"
];

export interface WebExploreOptions {
  startUrl: string;
  mode: ExplorationMode;
  maxDepth: number;
  maxPages: number;
  headed: boolean;
  holdSeconds?: number;
  clickButtons: boolean;
  maxButtonClicksPerPage?: number;
  surface: WebSurface;
  login?: {
    required: boolean;
    username?: string;
    password?: string;
  };
}

interface Candidate {
  role: string;
  text?: string;
  selector?: string;
  href?: string;
  riskLevel: "low" | "medium" | "high";
}

export class WebPageExplorer {
  private readonly store: PageGraphStore;
  private readonly knowledgeStore: KnowledgeStore;
  private readonly environmentStore: EnvironmentDiscoveryStore;

  constructor(private readonly context: LoadedContext) {
    this.store = new PageGraphStore(context);
    this.knowledgeStore = new KnowledgeStore(context);
    this.environmentStore = new EnvironmentDiscoveryStore(context);
  }

  async explore(
    options: WebExploreOptions
  ): Promise<{ nodes: number; edges: number; graphPath: string; knowledgePath: string; knowledgeChunks: number }> {
    logger.info("Web exploration started", {
      project: this.context.project.projectKey,
      env: this.context.env.env,
      startUrl: options.startUrl,
      maxDepth: options.maxDepth,
      maxPages: options.maxPages,
      surface: options.surface,
      headed: options.headed,
      clickButtons: options.clickButtons,
      loginRequired: options.login?.required
    });
    const browser = await chromium.launch({ headless: !options.headed });
    const auth = await this.buildAuth(options);
    const browserContext = await browser.newContext({ extraHTTPHeaders: auth.headers });
    if (auth.token) await injectAuthState(browserContext, options.startUrl, auth.token, auth.headerName, auth.authInjection);
    const page = await browserContext.newPage();
    page.on("popup", async (popup) => {
      logger.warn("Closing unexpected popup page during exploration", { url: popup.url() });
      await popup.close().catch(() => undefined);
    });
    try {
      const result = await this.exploreWithPage(page, options);
      if (options.holdSeconds && options.holdSeconds > 0) {
        logger.info("Holding browser open after exploration", { seconds: options.holdSeconds });
        await page.waitForTimeout(options.holdSeconds * 1000);
      }
      return result;
    } finally {
      await browserContext.close().catch(() => undefined);
      await browser.close().catch(() => undefined);
    }
  }

  private async buildAuth(
    options: WebExploreOptions
  ): Promise<{
    headers: Record<string, string>;
    token?: string;
    headerName?: string;
    authInjection?: EnvironmentDiscovery["authInjection"];
  }> {
    if (!options.login?.required) return { headers: {} };
    if (!options.login.username || !options.login.password) {
      throw new Error("Login is required, but username or password is empty.");
    }
    const discovery = await this.environmentStore.load();
    const bypass = discovery.bypassLogin;
    if (!bypass?.enabled) return { headers: {} };
    if (!this.context.env.api?.baseUrl) {
      throw new Error("Bypass login requires env.api.baseUrl.");
    }

    const attempts = [
      { username: options.login.username, password: options.login.password, source: "selected" },
      ...(await this.fallbackAccounts(options.login.username)).map((account) => ({
        username: account.username,
        password: account.password,
        source: account.label ? `saved:${account.label}` : "saved"
      }))
    ];
    const failures: string[] = [];
    for (const attempt of attempts) {
      const result = await this.requestBypassToken({
        username: attempt.username,
        password: attempt.password,
        bypass,
        apiBaseUrl: this.context.env.api.baseUrl
      });
      if (result.token) {
        logger.info("Bypass login succeeded", {
          loginUrl: result.loginUrl,
          header: bypass.tokenHeaderName,
          username: attempt.username,
          source: attempt.source
        });
        return {
          headers: { [bypass.tokenHeaderName]: String(result.token) },
          token: String(result.token),
          headerName: bypass.tokenHeaderName,
          authInjection: discovery.authInjection
        };
      }
      failures.push(`${attempt.username}: ${result.status} ${JSON.stringify(result.body)}`);
    }

    throw new Error(
      [
        "Bypass login failed for all available accounts.",
        "请在探索页选择可用于旁路登录的账号，或在账号管理中新增当前项目/环境账号。",
        ...failures
      ].join("\n")
    );
  }

  private async fallbackAccounts(selectedUsername: string): Promise<Array<{ username: string; password: string; label?: string }>> {
    const accounts = await new AccountStore(this.context).list({
      project: this.context.project.projectKey,
      env: this.context.env.env
    });
    return accounts
      .filter((account) => account.username !== selectedUsername)
      .sort((a, b) => accountScore(b) - accountScore(a))
      .map((account) => ({ username: account.username, password: account.password, label: account.label }));
  }

  private async requestBypassToken(input: {
    username: string;
    password: string;
    bypass: NonNullable<EnvironmentDiscovery["bypassLogin"]>;
    apiBaseUrl: string;
  }): Promise<{ loginUrl: string; status: number; body: unknown; token?: unknown }> {
    const loginUrl = new URL(input.bypass.path, input.apiBaseUrl).toString();
    const payload = {
      ...input.bypass.extraPayload,
      [input.bypass.usernameField]: input.username,
      [input.bypass.passwordField]: input.password,
      uaTime: formatDateTime(new Date())
    };
    const response = await fetch(loginUrl, {
      method: input.bypass.method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    const body = (await response.json().catch(() => undefined)) as unknown;
    const token = readPath(body, input.bypass.tokenResponsePath);
    return { loginUrl, status: response.status, body, token: response.ok ? token : undefined };
  }

  private async exploreWithPage(
    page: Page,
    options: WebExploreOptions
  ): Promise<{ nodes: number; edges: number; graphPath: string; knowledgePath: string; knowledgeChunks: number }> {
    const queue: Array<{ url: string; depth: number; fromPageId?: string; via?: Candidate }> = [
      { url: options.startUrl, depth: 0 }
    ];
    const visited = new Set<string>();
    const network = new NetworkCollector();
    page.on("request", (request) => network.record(request.method(), request.url()));
    let edgeCount = 0;

    while (queue.length > 0 && visited.size < options.maxPages) {
      const current = queue.shift();
      if (!current || visited.has(normalizeUrl(current.url))) continue;
      visited.add(normalizeUrl(current.url));

      const startedAt = Date.now();
      logger.info("Explore page navigation started", { url: current.url, depth: current.depth });
      const navigated = await this.gotoForExploration(page, current.url);
      if (!navigated) continue;
      await this.dismissBlockingOverlays(page);
      const node = await this.captureNode(page, options.surface);
      await this.store.upsertNode(node);
      logger.info("Explored page", {
        url: node.url,
        pageId: node.pageId,
        depth: current.depth,
        title: node.title,
        elementCount: node.elements.length,
        preconditions: node.requiredPreconditions
      });

      if (current.fromPageId && current.via) {
        await this.store.upsertEdge(
          buildEdge(
            this.context.project.projectKey,
            options.surface,
            current.fromPageId,
            node.pageId,
            current.via,
            Date.now() - startedAt
          )
        );
        edgeCount += 1;
      }

      if (current.depth >= options.maxDepth) continue;

      logger.info("Explore page candidates collected", {
        pageId: node.pageId,
        depth: current.depth,
        linkCount: node.elements.filter((item) => item.href).length,
        clickableCount: node.elements.filter((item) => item.selector && !item.href).length,
        clickButtons: options.clickButtons
      });

      let buttonClicks = 0;
      const triedClickKeys = new Set<string>();
      const maxButtonClicksPerPage = options.maxButtonClicksPerPage ?? 8;
      for (const candidate of node.elements) {
        if (candidate.href) {
          const nextUrl = resolveUrl(candidate.href, current.url);
          if (nextUrl && sameOrigin(nextUrl, options.startUrl) && !visited.has(normalizeUrl(nextUrl))) {
            queue.push({
              url: nextUrl,
              depth: current.depth + 1,
              fromPageId: node.pageId,
              via: candidate
            });
          }
          continue;
        }

        if (!options.clickButtons || !candidate.selector) continue;
        if (buttonClicks >= maxButtonClicksPerPage) continue;
        if (isGlobalNoise(candidate.text)) continue;
        const clickKey = `${candidate.selector}|${candidate.text ?? ""}`;
        if (triedClickKeys.has(clickKey)) continue;
        triedClickKeys.add(clickKey);
        buttonClicks += 1;
        const transition = await this.tryClickAndCaptureTransition(page, current.url, candidate, options.surface);
        if (!transition) continue;
        if (transition.node) {
          await this.store.upsertNode(transition.node);
          await this.store.upsertEdge(
            buildEdge(this.context.project.projectKey, options.surface, node.pageId, transition.node.pageId, candidate, 0)
          );
          edgeCount += 1;
        }
        const nextUrl = transition.url;
        if (nextUrl && sameOrigin(nextUrl, options.startUrl) && !visited.has(normalizeUrl(nextUrl))) {
          queue.push({
            url: nextUrl,
            depth: current.depth + 1,
            fromPageId: node.pageId,
            via: candidate
          });
        }
      }
    }

    const graph = await this.store.load();
    const graphPath = await this.store.save(graph);
    const knowledge = await this.knowledgeStore.syncPageGraph(graph);
    await this.environmentStore.mergeNetwork(network.snapshot());
    logger.info("Web exploration finished", {
      nodes: graph.nodes.length,
      edges: graph.edges.length || edgeCount,
      graphPath,
      knowledgePath: knowledge.knowledgePath,
      knowledgeChunks: knowledge.chunks
    });
    return {
      nodes: graph.nodes.length,
      edges: graph.edges.length || edgeCount,
      graphPath,
      knowledgePath: knowledge.knowledgePath,
      knowledgeChunks: knowledge.chunks
    };
  }

  private async captureNode(page: Page, surface: WebSurface, stateKey?: string, stateName?: string): Promise<PageNodeMemory> {
    const url = page.url();
    const title = await page.title().catch(() => undefined);
    const elements = await page.evaluate(() => {
      const candidates = [
        ...document.querySelectorAll(
          "a,button,input,textarea,select,[role='button'],[role='textbox'],[role='combobox'],[role='menuitem'],[role='tab'],[onclick],[tabindex],[contenteditable='true']"
        )
      ];
      const results = [];
      for (const element of candidates.slice(0, 600)) {
        const htmlElement = element as HTMLElement;
        const inputElement = element as HTMLInputElement;
        const rect = htmlElement.getBoundingClientRect();
        const style = window.getComputedStyle(htmlElement);
        if (
          rect.width < 1 ||
          rect.height < 1 ||
          style.visibility === "hidden" ||
          style.display === "none" ||
          Number(style.opacity || "1") === 0
        ) {
          continue;
        }
        const text = (
          htmlElement.innerText ||
          htmlElement.getAttribute("aria-label") ||
          htmlElement.getAttribute("placeholder") ||
          inputElement.name ||
          ""
        ).trim();
        const testId =
          htmlElement.getAttribute("data-testid") ||
          htmlElement.getAttribute("data-test") ||
          htmlElement.getAttribute("data-qa");
        const id = htmlElement.id;
        const name = inputElement.name;
        const placeholder = htmlElement.getAttribute("placeholder");
        const selector = testId
          ? `[data-testid="${testId}"],[data-test="${testId}"],[data-qa="${testId}"]`
          : id
            ? `#${CSS.escape(id)}`
            : name
              ? `${element.tagName.toLowerCase()}[name="${CSS.escape(name)}"]`
              : placeholder
                ? `${element.tagName.toLowerCase()}[placeholder="${CSS.escape(placeholder)}"]`
                : text
                  ? `text=${text.replace(/\s+/g, " ").slice(0, 80)}`
                  : undefined;
        results.push({
          role: htmlElement.getAttribute("role") || element.tagName.toLowerCase(),
          text,
          selector,
          inputType: inputElement.type || undefined,
          name: name || undefined,
          placeholder: placeholder || undefined,
          href: element instanceof HTMLAnchorElement ? element.href : undefined
        });
      }
      return results;
    });

    const now = new Date().toISOString();
    const memoryElements: PageElementMemory[] = elements.map((item) => ({
      elementId: stableId([url, item.role, item.text, item.selector, item.href].join("|")),
      role: item.role,
      text: item.text || undefined,
      selector: item.selector,
      href: item.href,
      inputType: item.inputType,
      name: item.name,
      placeholder: item.placeholder,
      riskLevel: classifyRisk(item.text, item.href),
      lastSeenAt: now
    }));

    return {
      pageId: stableId(stateKey ? `${surface}|${url}|${stateKey}` : `${surface}|${url}`),
      project: this.context.project.projectKey,
      platform: "web",
      surface,
      url,
      urlPattern: toUrlPattern(url),
      title,
      semanticName: stateName ? `${title || new URL(url).pathname || "home"} / ${stateName}` : title || new URL(url).pathname || "home",
      requiredPreconditions: inferPreconditions(title, memoryElements),
      elements: memoryElements,
      discoveredBy: "exploration",
      confidence: 0.7,
      visitCount: 1,
      lastSeenAt: now
    };
  }

  private async tryClickAndCaptureTransition(
    page: Page,
    currentUrl: string,
    candidate: Candidate,
    surface: WebSurface
  ): Promise<{ url?: string; node?: PageNodeMemory } | undefined> {
    try {
      if (normalizeUrl(page.url()) !== normalizeUrl(currentUrl)) {
        const navigated = await this.gotoForExploration(page, currentUrl);
        if (!navigated) return undefined;
        await this.dismissBlockingOverlays(page);
      }
      const beforeUrl = page.url();
      const beforeSignature = await page.locator("body").innerText({ timeout: 1000 }).catch(() => "");
      await page
        .locator(candidate.selector!)
        .first()
        .click({ timeout: 1500 })
        .catch(async (error) => {
          const dismissed = await this.dismissBlockingOverlays(page);
          if (dismissed === 0) throw error;
          await page.locator(candidate.selector!).first().click({ timeout: 1500 });
        });
      await page.waitForLoadState("domcontentloaded", { timeout: 3000 }).catch(() => undefined);
      await page.waitForTimeout(300);
      await this.dismissBlockingOverlays(page);
      const afterUrl = page.url();
      const afterSignature = await page.locator("body").innerText({ timeout: 1000 }).catch(() => "");
      if (normalizeUrl(afterUrl) !== normalizeUrl(beforeUrl)) return { url: afterUrl };
      if (stableId(beforeSignature.slice(0, 2000)) !== stableId(afterSignature.slice(0, 2000))) {
        const stateKey = stableId([candidate.selector, candidate.text, afterSignature.slice(0, 500)].join("|"));
        const node = await this.captureNode(page, surface, stateKey, candidate.text);
        await page.keyboard.press("Escape").catch(() => undefined);
        return { node };
      }
      return undefined;
    } catch (error) {
      logger.warn("Candidate click exploration failed", {
        url: currentUrl,
        selector: candidate.selector,
        text: candidate.text,
        error: error instanceof Error ? error.message : String(error)
      });
      return undefined;
    }
  }

  private async dismissBlockingOverlays(page: Page): Promise<number> {
    const closeTargets = [
      page.getByText(/^(我已知晓|知道了|我知道了|确认|确定|同意|允许|接受|关闭|OK|Got it|I know|Agree|Allow|Accept|Close)$/i),
      page.getByRole("button", {
        name: /^(我已知晓|知道了|我知道了|确认|确定|同意|允许|接受|关闭|取消|OK|Got it|I know|Agree|Allow|Accept|Close)$/i
      }),
      page.locator("button").filter({
        hasText: /^(我已知晓|知道了|我知道了|确认|确定|同意|允许|接受|关闭|OK|Got it|I know|Agree|Allow|Accept|Close)$/i
      }),
      page.locator("[aria-label='Close'],[aria-label='close'],[aria-label='关闭']"),
      page.locator(".ant-modal-close,.el-dialog__headerbtn,.modal-close,.modal__close,.close-icon,.close"),
      page.locator(".modal button, .ant-modal button, .el-dialog button, [role='dialog'] button").filter({
        hasText: /^(×|x|X|关闭|我已知晓|知道了|我知道了|确定|同意|允许|接受)$/i
      }),
      page.locator("span,div,i").filter({
        hasText: /^(×|x|X)$/
      })
    ];
    let dismissed = 0;
    for (let round = 0; round < 5; round += 1) {
      let clickedThisRound = false;
      for (const target of closeTargets) {
        const count = await target.count().catch(() => 0);
        for (let index = 0; index < Math.min(count, 5); index += 1) {
          const item = target.nth(index);
          if (!(await item.isVisible({ timeout: 300 }).catch(() => false))) continue;
          await item.click({ timeout: 800 }).catch(() => undefined);
          await page.waitForTimeout(250);
          dismissed += 1;
          clickedThisRound = true;
          logger.info("Dismissed blocking overlay during exploration", {
            url: page.url(),
            round,
            index,
            text: (await item.innerText({ timeout: 300 }).catch(() => "")).slice(0, 80)
          });
          break;
        }
        if (clickedThisRound) break;
      }
      if (!clickedThisRound) break;
    }
    if (dismissed === 0) {
      await page.keyboard.press("Escape").catch(() => undefined);
      await page.waitForTimeout(100);
    }
    return dismissed;
  }

  private async gotoForExploration(page: Page, url: string): Promise<boolean> {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 });
      return true;
    } catch (error) {
      logger.warn("Explore page navigation domcontentloaded timeout, retrying with commit", {
        url,
        error: error instanceof Error ? error.message : String(error)
      });
    }
    try {
      await page.goto(url, { waitUntil: "commit", timeout: 10_000 });
      await page.waitForTimeout(1_000);
      return true;
    } catch (error) {
      logger.warn("Explore page navigation skipped after timeout", {
        url,
        error: error instanceof Error ? error.message : String(error)
      });
      return false;
    }
  }
}

class NetworkCollector {
  private readonly domains = new Set<string>();
  private readonly apiEndpoints = new Map<string, { method?: string; url: string; domain: string; path: string }>();

  record(method: string, url: string): void {
    try {
      const parsed = new URL(url);
      this.domains.add(parsed.hostname);
      if (isApiLike(parsed)) {
        const normalizedUrl = `${parsed.origin}${parsed.pathname}`;
        this.apiEndpoints.set(`${method}|${normalizedUrl}`, {
          method,
          url: normalizedUrl,
          domain: parsed.hostname,
          path: parsed.pathname
        });
      }
    } catch {
      return;
    }
  }

  snapshot(): { domains: string[]; apiEndpoints: Array<{ method?: string; url: string; domain: string; path: string }> } {
    return {
      domains: [...this.domains].sort(),
      apiEndpoints: [...this.apiEndpoints.values()]
    };
  }
}

function buildEdge(
  project: string,
  surface: WebSurface,
  fromPageId: string,
  toPageId: string,
  candidate: Candidate,
  durationMs: number
): PageEdgeMemory {
  return {
    edgeId: stableId([surface, fromPageId, toPageId, candidate.text, candidate.selector, candidate.href].join("|")),
    project,
    platform: "web",
    surface,
    fromPageId,
    toPageId,
    action: {
      type: candidate.href ? "navigate" : "click",
      selector: candidate.selector,
      text: candidate.text,
      href: candidate.href
    },
    preconditions: [],
    riskLevel: candidate.riskLevel,
    successCount: 1,
    failedCount: 0,
    averageDurationMs: durationMs,
    confidence: 0.8,
    lastVerifiedAt: new Date().toISOString()
  };
}

function classifyRisk(text?: string, href?: string): "low" | "medium" | "high" {
  const value = `${text ?? ""} ${href ?? ""}`.toLowerCase();
  if (RISKY_TEXT.some((item) => value.includes(item.toLowerCase()))) return "high";
  if (/submit|save|create|update|edit|申请|保存|创建|修改|提交/i.test(value)) return "medium";
  return "low";
}

function isGlobalNoise(text?: string): boolean {
  const value = (text ?? "").trim();
  if (!value) return false;
  return GLOBAL_NOISE_TEXT.some((item) => value.includes(item));
}

function accountScore(account: { username: string; label?: string }): number {
  const value = `${account.username} ${account.label ?? ""}`.toLowerCase();
  if (value.includes("bypass")) return 100;
  if (value.includes("uat")) return 20;
  return 0;
}

async function injectAuthState(
  context: BrowserContext,
  startUrl: string,
  token: string,
  headerName = "token",
  authInjection?: EnvironmentDiscovery["authInjection"]
): Promise<void> {
  const origin = new URL(startUrl).origin;
  const storageKeys = authInjection?.storageKeys?.length
    ? authInjection.storageKeys
    : [headerName, "token", "TOKEN", "userToken", "accessToken", "access_token", "authToken", "Authorization", "loginToken"];
  const cookieNames = authInjection?.cookieNames?.length ? authInjection.cookieNames : [headerName, "token"];
  const uniqueStorageKeys = [...new Set(storageKeys.filter(Boolean))];
  const uniqueCookieNames = [...new Set(cookieNames.filter(Boolean))];
  await context.addInitScript(
    ({ tokenValue, keys }) => {
      for (const key of keys) {
        window.localStorage.setItem(key, tokenValue);
        window.sessionStorage.setItem(key, tokenValue);
      }
    },
    { tokenValue: token, keys: uniqueStorageKeys }
  );
  await context.addCookies(
    uniqueCookieNames.map((name) => ({
      name,
      value: token,
      url: origin,
      httpOnly: false,
      secure: origin.startsWith("https://"),
      sameSite: "Lax"
    }))
  );
  logger.info("Injected bypass auth state into browser context", {
    origin,
    headerName,
    storageKeys: uniqueStorageKeys,
    cookieNames: uniqueCookieNames
  });
}

function inferPreconditions(title: string | undefined, elements: PageElementMemory[]): string[] {
  const text = `${title ?? ""} ${elements.map((item) => item.text ?? "").join(" ")}`;
  const preconditions: string[] = [];
  if (/登录|login|sign in/i.test(text)) preconditions.push("user.not_logged_in_or_session_expired");
  if (/kyc|身份认证|实名认证/i.test(text)) preconditions.push("user.kyc_required");
  return preconditions;
}

function stableId(value: string): string {
  return crypto.createHash("sha1").update(value).digest("hex").slice(0, 16);
}

function normalizeUrl(url: string): string {
  const parsed = new URL(url);
  parsed.hash = "";
  return parsed.toString();
}

function sameOrigin(url: string, startUrl: string): boolean {
  return new URL(url).origin === new URL(startUrl).origin;
}

function resolveUrl(value: string, baseUrl: string): string | undefined {
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return undefined;
  }
}

function toUrlPattern(url: string): string {
  const parsed = new URL(url);
  return parsed.pathname.replace(/[0-9a-f]{8,}|\d+/gi, ":id") || "/";
}

function isApiLike(url: URL): boolean {
  const value = `${url.hostname}${url.pathname}`.toLowerCase();
  return /api|graphql|gateway|openapi|ajax|rest|\/v\d+\//i.test(value);
}

function readPath(value: unknown, pathText: string): unknown {
  return pathText.split(".").reduce<unknown>((current, key) => {
    if (current && typeof current === "object" && key in current) {
      return (current as Record<string, unknown>)[key];
    }
    return undefined;
  }, value);
}

function formatDateTime(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes()
  )}:${pad(date.getSeconds())}`;
}
