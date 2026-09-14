import path from "node:path";
import crypto from "node:crypto";
import { chromium, type BrowserContext, type Page } from "@playwright/test";
import fs from "fs-extra";
import { loadContext } from "../src/core/config-loader.js";
import { AccountStore } from "../src/memory/account-store.js";
import { EnvironmentDiscoveryStore } from "../src/memory/environment-discovery-store.js";
import type { EnvironmentDiscovery, LoadedContext, TestAccount } from "../src/core/types.js";
import { writeSafeJsonFile, writeSafeTextFile } from "../src/core/safe-file-writer.js";

interface CliOptions {
  project: string;
  env: string;
  artifactDir: string;
  out: string;
  report: string;
  headed: boolean;
}

interface CaptureState {
  url: string;
  title: string;
  screenshotPath: string;
  domPath: string;
  visibleTextPath: string;
  visibleText: string;
  domHash: string;
  textHash: string;
  clickableSummary: ClickableSummary[];
  featureSignals: FeatureSignals;
}

interface ClickableSummary {
  index: number;
  tagName: string;
  role?: string;
  text?: string;
  ariaLabel?: string;
  href?: string;
  type?: string;
  disabled?: boolean;
}

interface FeatureSignals {
  recordTerms: string[];
  filterTerms: string[];
  listTerms: string[];
  emptyStateTerms: string[];
  score: number;
}

const options = parseArgs(process.argv.slice(2));
const context = await loadContext({ project: options.project, env: options.env });
const artifactRoot = path.resolve(context.rootDir, options.artifactDir);
await fs.ensureDir(artifactRoot);

const account = (await new AccountStore(context).list({ project: options.project, env: options.env }))[0];
if (!account) throw new Error(`No account configured for ${options.project}/${options.env}.`);

const discovery = await new EnvironmentDiscoveryStore(context).load(options.project, options.env);
const baseUrl = context.env.web?.baseUrl;
if (!baseUrl) throw new Error(`Missing web.baseUrl for ${options.project}/${options.env}.`);

const auth = await buildAuth(context, discovery, account);
const browser = await chromium.launch({ headless: !options.headed });
const browserContext = await browser.newContext({ extraHTTPHeaders: auth.headers });
if (auth.token) await injectAuthState(browserContext, baseUrl, auth.token, auth.headerName, discovery.authInjection);
const page = await browserContext.newPage();

let result: Record<string, unknown>;
try {
  const targetUrl = new URL("/zh-hans/assets/total-assets", baseUrl).toString();
  await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
  await page.waitForTimeout(1500);

  const before = await captureState(page, artifactRoot, "before");
  const click = await clickFundFlowEntry(page);
  await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => undefined);
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
  await page.waitForTimeout(2000);
  const after = await captureState(page, artifactRoot, "after");
  const analysis = analyzeEntryVerification(before, after, click);
  const proposal = buildProposal(analysis, before, after, click, options);
  result = {
    schemaVersion: "g1.9.asset-record-entry-verification.v1",
    generatedAt: new Date().toISOString(),
    project: options.project,
    env: options.env,
    sourceProposalId: "g1_6_asset_record_candidate_fund_flow",
    targetUrl,
    login: {
      method: discovery.bypassLogin?.enabled ? "bypassLogin" : "existing_session_or_headers",
      account: maskAccount(account.username),
      authInjected: Boolean(auth.token)
    },
    before: summarizeCapture(before),
    after: summarizeCapture(after),
    click,
    analysis,
    proposal,
    artifacts: {
      dir: options.artifactDir,
      beforeScreenshot: relativePath(context, before.screenshotPath),
      afterScreenshot: relativePath(context, after.screenshotPath),
      beforeDom: relativePath(context, before.domPath),
      afterDom: relativePath(context, after.domPath),
      beforeVisibleText: relativePath(context, before.visibleTextPath),
      afterVisibleText: relativePath(context, after.visibleTextPath),
      clickableSummary: relativePath(context, path.join(artifactRoot, "clickable-summary.json"))
    },
    boundaries: {
      executedFullUseCase: false,
      filteredUsdt: false,
      submittedForm: false,
      calledProvider: false,
      wroteKnowledge: false,
      wroteBusinessFlow: false,
      wroteElementStore: false,
      upgradedCandidate: false
    }
  };
  await writeSafeJsonFile(path.join(artifactRoot, "clickable-summary.json"), {
    before: before.clickableSummary,
    after: after.clickableSummary
  });
  await writeSafeJsonFile(path.resolve(context.rootDir, options.out), result);
  await writeSafeTextFile(path.resolve(context.rootDir, options.report), renderReport(result));
  console.log(JSON.stringify({
    conclusion: analysis.conclusion,
    shouldUpgradeToVerified: analysis.shouldUpgradeToVerified,
    beforeUrl: before.url,
    afterUrl: after.url,
    urlChanged: analysis.urlChanged,
    domChanged: analysis.domChanged,
    textChanged: analysis.textChanged,
    report: options.report,
    out: options.out,
    artifacts: options.artifactDir
  }, null, 2));
} finally {
  await browserContext.close().catch(() => undefined);
  await browser.close().catch(() => undefined);
}

function parseArgs(args: string[]): CliOptions {
  const out: CliOptions = {
    project: "demo",
    env: "test",
    artifactDir: "artifacts/g1_9-asset-record-entry",
    out: "reports/g1_9-candidate-entry-verification.json",
    report: "reports/g1_9-candidate-entry-verification.md",
    headed: false
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];
    if (arg === "--project" && next) out.project = next;
    if (arg === "--env" && next) out.env = next;
    if (arg === "--artifact-dir" && next) out.artifactDir = next;
    if (arg === "--out" && next) out.out = next;
    if (arg === "--report" && next) out.report = next;
    if (arg === "--headed") out.headed = true;
    if (arg.startsWith("--") && next && arg !== "--headed") index += 1;
  }
  return out;
}

async function buildAuth(
  context: LoadedContext,
  discovery: EnvironmentDiscovery,
  account: TestAccount
): Promise<{ headers: Record<string, string>; token?: string; headerName?: string }> {
  const bypass = discovery.bypassLogin;
  if (!bypass?.enabled || !context.env.api?.baseUrl) return { headers: {} };
  const response = await fetch(new URL(bypass.path, context.env.api.baseUrl), {
    method: bypass.method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...(bypass.extraPayload ?? {}),
      [bypass.usernameField]: account.username,
      [bypass.passwordField]: account.password,
      uaTime: formatDateTime(new Date())
    })
  });
  const body = await response.json().catch(async () => ({ raw: await response.text() }));
  const token = readPath(body, bypass.tokenResponsePath);
  if (!response.ok || !token) throw new Error(`Bypass login failed: HTTP ${response.status} ${JSON.stringify(body).slice(0, 500)}`);
  return { headers: { [bypass.tokenHeaderName]: String(token) }, token: String(token), headerName: bypass.tokenHeaderName };
}

async function injectAuthState(
  browserContext: BrowserContext,
  baseUrl: string,
  token: string,
  headerName?: string,
  authInjection?: EnvironmentDiscovery["authInjection"]
): Promise<void> {
  const origin = new URL(baseUrl).origin;
  const storageKeys = authInjection?.storageKeys?.length ? authInjection.storageKeys : ["token", "exchange-token", headerName ?? "exchange-token"];
  await browserContext.addInitScript(
    ({ tokenValue, keys }) => {
      for (const key of keys) {
        window.localStorage.setItem(key, tokenValue);
        window.sessionStorage.setItem(key, tokenValue);
      }
    },
    { tokenValue: token, keys: storageKeys }
  );
  const cookieNames = authInjection?.cookieNames?.length ? authInjection.cookieNames : ["token", "exchange-token"];
  await browserContext.addCookies(cookieNames.map((name) => ({ name, value: token, url: origin, httpOnly: false, sameSite: "Lax" as const })));
}

async function captureState(page: Page, artifactRoot: string, prefix: "before" | "after"): Promise<CaptureState> {
  const screenshotPath = path.join(artifactRoot, `${prefix}.png`);
  const domPath = path.join(artifactRoot, `${prefix}.dom.html`);
  const visibleTextPath = path.join(artifactRoot, `${prefix}.visible-text.txt`);
  const [url, title, dom, visibleText, clickableSummary] = await Promise.all([
    Promise.resolve(page.url()),
    page.title().catch(() => ""),
    page.content(),
    page.locator("body").innerText({ timeout: 5000 }).catch(() => ""),
    collectClickableSummary(page)
  ]);
  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => undefined);
  await writeSafeTextFile(domPath, dom);
  await writeSafeTextFile(visibleTextPath, visibleText);
  return {
    url,
    title,
    screenshotPath,
    domPath,
    visibleTextPath,
    visibleText,
    domHash: sha256(dom),
    textHash: sha256(visibleText),
    clickableSummary,
    featureSignals: detectFeatureSignals(`${title}\n${url}\n${visibleText}\n${clickableSummary.map((item) => `${item.text ?? ""} ${item.ariaLabel ?? ""} ${item.href ?? ""}`).join("\n")}`)
  };
}

async function collectClickableSummary(page: Page): Promise<ClickableSummary[]> {
  return page.evaluate(() => {
    const nodes = [...document.querySelectorAll("a,button,[role='button'],input,select,[tabindex]")].slice(0, 120);
    return nodes.map((node, index) => {
      const element = node as HTMLElement;
      const input = node as HTMLInputElement;
      return {
        index,
        tagName: element.tagName.toLowerCase(),
        role: element.getAttribute("role") || undefined,
        text: (element.innerText || element.textContent || input.placeholder || "").trim().slice(0, 80) || undefined,
        ariaLabel: element.getAttribute("aria-label") || undefined,
        href: (node as HTMLAnchorElement).href || undefined,
        type: input.type || undefined,
        disabled: Boolean(input.disabled || element.getAttribute("aria-disabled") === "true")
      };
    });
  }).catch(() => []);
}

async function clickFundFlowEntry(page: Page): Promise<Record<string, unknown>> {
  const attempts = [
    { strategy: "role_button_name", locator: page.getByRole("button", { name: /资金流水|資金流水/ }).first() },
    { strategy: "text_exact", locator: page.getByText("资金流水", { exact: true }).first() },
    { strategy: "text_fuzzy", locator: page.getByText(/资金流水|資金流水/).first() },
    { strategy: "xpath_text", locator: page.locator("xpath=//*[contains(normalize-space(.), '资金流水')]").first() }
  ];
  for (const attempt of attempts) {
    try {
      const count = await attempt.locator.count();
      if (!count) continue;
      const visible = await attempt.locator.isVisible({ timeout: 3000 }).catch(() => false);
      if (!visible) continue;
      await attempt.locator.click({ timeout: 8000 });
      return { clicked: true, strategy: attempt.strategy };
    } catch (error) {
      return { clicked: false, strategy: attempt.strategy, error: error instanceof Error ? error.message : String(error) };
    }
  }
  return { clicked: false, strategy: "not_found", error: "资金流水 candidate entry was not found or not visible." };
}

function analyzeEntryVerification(before: CaptureState, after: CaptureState, click: Record<string, unknown>): Record<string, unknown> {
  const urlChanged = normalizeUrl(before.url) !== normalizeUrl(after.url);
  const domChanged = before.domHash !== after.domHash;
  const textChanged = before.textHash !== after.textHash;
  const afterScore = after.featureSignals.score;
  const beforeScore = before.featureSignals.score;
  const deltaScore = afterScore - beforeScore;
  const clicked = click.clicked === true;
  const hasNewRecordSignals = afterScore > beforeScore + 4;
  const hasRecordViewSignals = afterScore >= 6 && (urlChanged || hasNewRecordSignals);
  const hasSomeSignals = clicked && (afterScore >= 4 || deltaScore > 0 || domChanged || textChanged);
  const conclusion = hasRecordViewSignals
    ? "verified_entry"
    : hasSomeSignals
      ? "still_candidate"
      : clicked
        ? "rejected"
        : "inconclusive";
  return {
    conclusion,
    shouldUpgradeToVerified: conclusion === "verified_entry",
    urlChanged,
    domChanged,
    textChanged,
    beforeFeatureSignals: before.featureSignals,
    afterFeatureSignals: after.featureSignals,
    clicked,
    clickStrategy: click.strategy,
    reason:
      conclusion === "verified_entry"
        ? "Click produced enough new asset record or fund flow view signals."
        : conclusion === "still_candidate"
          ? "Click produced some evidence, but not enough to verify an independent asset record page or complete record view."
          : conclusion === "rejected"
            ? "Click happened but did not expose enough record-view evidence."
            : "Candidate entry could not be reliably clicked or page state was unstable."
  };
}

function buildProposal(
  analysis: Record<string, unknown>,
  before: CaptureState,
  after: CaptureState,
  click: Record<string, unknown>,
  options: CliOptions
): Record<string, unknown> {
  const base = {
    sourceProposalId: "g1_6_asset_record_candidate_fund_flow",
    sourceVerificationId: "g1_9_asset_record_entry_verification",
    project: options.project,
    env: options.env,
    module: "asset",
    action: "record",
    operationType: "read",
    evidence: [
      { type: "before_screenshot", path: relativePath(context, before.screenshotPath) },
      { type: "after_screenshot", path: relativePath(context, after.screenshotPath) },
      { type: "before_dom", path: relativePath(context, before.domPath) },
      { type: "after_dom", path: relativePath(context, after.domPath) },
      { type: "before_visible_text", path: relativePath(context, before.visibleTextPath) },
      { type: "after_visible_text", path: relativePath(context, after.visibleTextPath) }
    ],
    click
  };
  if (analysis.conclusion === "verified_entry") {
    return {
      type: "candidate_to_verified",
      target: "page_map_and_entry_element",
      autoWriteRecommended: false,
      humanConfirmationRequired: true,
      confidence: 0.78,
      recommendation: "Human may confirm upgrading the asset.record entry candidate, but USDT filter and list assertions still need separate verification.",
      ...base
    };
  }
  if (analysis.conclusion === "still_candidate") {
    return {
      type: "candidate_evidence_append",
      target: "page_map_and_entry_element",
      autoWriteRecommended: false,
      humanConfirmationRequired: true,
      confidence: 0.55,
      recommendation: "Keep the candidate as weak/unverified and append this verification evidence after human review.",
      ...base
    };
  }
  if (analysis.conclusion === "rejected") {
    return {
      type: "candidate_demote_or_deprecate",
      target: "page_map_and_entry_element",
      autoWriteRecommended: false,
      humanConfirmationRequired: true,
      confidence: 0.7,
      recommendation: "Consider demoting or deprecating the candidate because click did not expose asset record evidence.",
      ...base
    };
  }
  return {
    type: "no_knowledge_change",
    target: "none",
    autoWriteRecommended: false,
    humanConfirmationRequired: true,
    confidence: 0.35,
    recommendation: "Do not change knowledge. Re-run collection with a visible browser or manual confirmation.",
    ...base
  };
}

function detectFeatureSignals(text: string): FeatureSignals {
  const recordTerms = findTerms(text, ["资金流水", "资产记录", "财务记录", "资金记录", "账单", "明细", "流水", "record", "history", "statement"]);
  const filterTerms = findTerms(text, ["币种", "类型", "时间", "状态", "筛选", "搜索", "USDT", "currency", "type", "time", "status", "filter"]);
  const listTerms = findTerms(text, ["列表", "记录", "金额", "数量", "资产", "日期", "创建时间", "list", "amount", "date"]);
  const emptyStateTerms = findTerms(text, ["暂无记录", "暂无数据", "无记录", "空状态", "No records", "No data", "empty"]);
  return {
    recordTerms,
    filterTerms,
    listTerms,
    emptyStateTerms,
    score: recordTerms.length * 3 + filterTerms.length * 2 + listTerms.length + emptyStateTerms.length * 2
  };
}

function findTerms(text: string, terms: string[]): string[] {
  return terms.filter((term) => new RegExp(escapeRegExp(term), "i").test(text));
}

function summarizeCapture(capture: CaptureState): Record<string, unknown> {
  return {
    url: capture.url,
    title: capture.title,
    screenshotPath: relativePath(context, capture.screenshotPath),
    domPath: relativePath(context, capture.domPath),
    visibleTextPath: relativePath(context, capture.visibleTextPath),
    clickableCount: capture.clickableSummary.length,
    featureSignals: capture.featureSignals,
    domHash: capture.domHash,
    textHash: capture.textHash
  };
}

function renderReport(result: Record<string, unknown>): string {
  const analysis = result.analysis as Record<string, unknown>;
  const artifacts = result.artifacts as Record<string, unknown>;
  const before = result.before as Record<string, unknown>;
  const after = result.after as Record<string, unknown>;
  const proposal = result.proposal as Record<string, unknown>;
  const lines = [
    "# G1.9 候选入口验证采集报告",
    "",
    "## 目标",
    "",
    "只验证资产总览页中的“资金流水”是否是 asset.record/read 的候选入口。本阶段未执行完整用例，未筛选 USDT，未做断言验证。",
    "",
    "## 采集边界",
    "",
    "- 启动浏览器：yes",
    "- 使用登录态或 bypass login：yes",
    "- 打开资产总览页：yes",
    "- 点击“资金流水”：yes",
    "- 筛选 USDT：no",
    "- 提交表单：no",
    "- 调用 provider：no",
    "- 写 knowledge：no",
    "- 写 business-flow：no",
    "- 写 element_store：no",
    "- 升级 candidate 为 verified：no",
    "",
    "## 点击前后状态",
    "",
    `- before URL: \`${String(before.url)}\``,
    `- after URL: \`${String(after.url)}\``,
    `- before title: \`${String(before.title)}\``,
    `- after title: \`${String(after.title)}\``,
    `- URL 是否变化: ${analysis.urlChanged ? "yes" : "no"}`,
    `- DOM 是否变化: ${analysis.domChanged ? "yes" : "no"}`,
    `- visible text 是否变化: ${analysis.textChanged ? "yes" : "no"}`,
    "",
    "## 记录页特征",
    "",
    "```json",
    JSON.stringify({
      before: before.featureSignals,
      after: after.featureSignals
    }, null, 2),
    "```",
    "",
    "## 结论",
    "",
    `- conclusion: \`${String(analysis.conclusion)}\``,
    `- shouldUpgradeToVerified: ${analysis.shouldUpgradeToVerified ? "yes" : "no"}`,
    `- reason: ${String(analysis.reason)}`,
    "",
    "## Proposal",
    "",
    `- proposal type: \`${String(proposal.type)}\``,
    `- autoWriteRecommended: ${proposal.autoWriteRecommended ? "yes" : "no"}`,
    `- humanConfirmationRequired: ${proposal.humanConfirmationRequired ? "yes" : "no"}`,
    `- recommendation: ${String(proposal.recommendation)}`,
    "",
    "## Artifacts",
    "",
    `- before screenshot: \`${String(artifacts.beforeScreenshot)}\``,
    `- after screenshot: \`${String(artifacts.afterScreenshot)}\``,
    `- before DOM: \`${String(artifacts.beforeDom)}\``,
    `- after DOM: \`${String(artifacts.afterDom)}\``,
    `- before visible text: \`${String(artifacts.beforeVisibleText)}\``,
    `- after visible text: \`${String(artifacts.afterVisibleText)}\``,
    `- clickable summary: \`${String(artifacts.clickableSummary)}\``,
    "",
    "## 下一步建议",
    "",
    analysis.conclusion === "verified_entry"
      ? "可以进入人工确认 candidate_to_verified proposal，但仍需要单独采集 USDT 筛选器、列表区域和空状态断言。"
      : analysis.conclusion === "still_candidate"
        ? "保持 candidate/weak/unverified，只追加本次证据；后续建议人工或 headed 模式确认点击后的视图。"
        : analysis.conclusion === "rejected"
          ? "不要升级为 verified。建议人工确认是否应降权或废弃该候选入口。"
          : "不修改知识。建议人工确认页面状态或重新进行可视化采集。"
  ];
  return `${lines.join("\n")}\n`;
}

function readPath(value: unknown, pathText: string): unknown {
  return pathText.split(".").reduce<unknown>((current, key) => current && typeof current === "object" && key in current ? (current as Record<string, unknown>)[key] : undefined, value);
}

function formatDateTime(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function sha256(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function normalizeUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.toString();
  } catch {
    return value;
  }
}

function relativePath(context: LoadedContext, filePath: string): string {
  return path.relative(context.rootDir, filePath).replace(/\\/g, "/");
}

function maskAccount(account: string): string {
  const [name, domain] = account.split("@");
  if (!domain) return `${account.slice(0, 2)}***`;
  return `${name.slice(0, 2)}***@${domain}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
