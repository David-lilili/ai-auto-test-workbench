import crypto from "node:crypto";
import type { DriverAdapter, VisualTargetCandidate } from "../core/driver-adapter.js";
import type { BootstrapInteractiveElement, DslAssertion, PageState, Platform } from "../core/types.js";
import { matchSemanticLocators, type SemanticLocatorCandidate } from "../core/semantic-locator-matcher.js";

interface MobileDriverOptions {
  serverUrl: string;
  sessionId: string;
  projectId: string;
  platform?: Platform;
}

interface ElementRef {
  ELEMENT?: string;
  ["element-6066-11e4-a52e-4f735466cecf"]?: string;
}

export class MobileDriverAdapter implements DriverAdapter {
  private readonly serverUrl: string;
  private readonly sessionId: string;
  private readonly projectId: string;
  private readonly platform: Platform;

  constructor(options: MobileDriverOptions) {
    this.serverUrl = options.serverUrl.replace(/\/$/, "");
    this.sessionId = options.sessionId;
    this.projectId = options.projectId;
    this.platform = options.platform ?? "android";
  }

  async getCurrentPageState(): Promise<PageState> {
    const source = await this.getDomOrPageSource().catch(() => "");
    const activity = await this.getCurrentUrlOrActivity().catch(() => "");
    return {
      page_id: stableId([this.projectId, this.platform, activity, source.slice(0, 8000)]),
      project_id: this.projectId,
      platform: this.platform,
      activity_name: activity,
      page_source_signature: stableId([source.slice(0, 20_000)]),
      known_elements: matchSemanticLocators({
        semanticTarget: "",
        actionType: "click",
        platform: this.platform,
        pageStructure: source
      }).map((item) => item.locator),
      outgoing_transitions: [],
      visit_count: 1,
      confidence_score: 0.5,
      last_seen_at: new Date().toISOString()
    };
  }

  async getDomOrPageSource(): Promise<string> {
    const payload = await this.request("GET", "/source");
    return String(payload.value ?? "");
  }

  async getAccessibilityTree(): Promise<unknown> {
    return this.getDomOrPageSource();
  }

  async takeScreenshot(filePath?: string): Promise<string | Buffer> {
    const payload = await this.request("GET", "/screenshot");
    const buffer = Buffer.from(String(payload.value ?? ""), "base64");
    if (!filePath) return buffer;
    const fs = await import("fs-extra");
    const path = await import("node:path");
    await fs.ensureDir(path.dirname(filePath));
    await fs.writeFile(filePath, buffer);
    return filePath;
  }

  async findElement(locator: string): Promise<ElementRef> {
    const { using, value } = locatorToAppium(locator);
    const payload = await this.request("POST", "/element", { using, value });
    if (!payload.value) throw new Error(`Element not found: ${locator}`);
    return payload.value as ElementRef;
  }

  async click(target: string): Promise<void> {
    const element = await this.findElement(target);
    await this.request("POST", `/element/${elementId(element)}/click`, {});
  }

  async input(target: string, text: string): Promise<void> {
    const element = await this.findElement(target);
    await this.request("POST", `/element/${elementId(element)}/value`, { text, value: [...text] });
  }

  async swipe(params: { startX?: number; startY?: number; endX?: number; endY?: number; durationMs?: number }): Promise<void> {
    await this.request("POST", "/actions", {
      actions: [
        {
          type: "pointer",
          id: "finger1",
          parameters: { pointerType: "touch" },
          actions: [
            { type: "pointerMove", duration: 0, x: params.startX ?? 500, y: params.startY ?? 1400 },
            { type: "pointerDown", button: 0 },
            { type: "pause", duration: params.durationMs ?? 200 },
            { type: "pointerMove", duration: params.durationMs ?? 500, x: params.endX ?? 500, y: params.endY ?? 400 },
            { type: "pointerUp", button: 0 }
          ]
        }
      ]
    });
  }

  async waitFor(condition: unknown, timeoutMs = 5_000): Promise<void> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (typeof condition === "string") {
        const found = await this.findElement(condition).then(() => true).catch(() => false);
        if (found) return;
        await new Promise((resolve) => setTimeout(resolve, 250));
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`Timed out waiting for mobile condition: ${String(condition)}`);
  }

  async assertState(assertion: DslAssertion): Promise<void> {
    if (assertion.type === "textVisible" && assertion.target) {
      await this.findElement(`text=${assertion.target}`);
      return;
    }
    throw new Error(`Unsupported mobile assertion: ${assertion.type}`);
  }

  async getCurrentUrlOrActivity(): Promise<string> {
    const payload = await this.request("GET", "/appium/device/current_activity").catch(() => undefined);
    return String(payload?.value ?? "");
  }

  async dismissSystemOverlays(): Promise<number> {
    const candidates = [
      "text=Allow",
      "text=ALLOW",
      "text=OK",
      "text=Got it",
      "text=I know",
      "text=Accept",
      "text=Close",
      "text=While using the app",
      "text=Only this time",
      "text=允许",
      "text=确定",
      "text=同意",
      "text=知道了",
      "text=关闭",
      "text=接受",
      "text=仅在使用中允许"
    ];
    let dismissed = 0;
    for (const locator of candidates) {
      const found = await this.findElement(locator).then(() => true).catch(() => false);
      if (!found) continue;
      await this.click(locator).catch(() => undefined);
      dismissed += 1;
      if (dismissed >= 5) break;
    }
    return dismissed;
  }

  async switchToWebView(): Promise<boolean> {
    const contexts = await this.request("GET", "/contexts").catch(() => undefined);
    const values = Array.isArray(contexts?.value) ? contexts.value.map(String) : [];
    const webview = values.find((item) => /WEBVIEW/i.test(item));
    if (!webview) return false;
    await this.request("POST", "/context", { name: webview });
    return true;
  }

  async getInteractiveElements(): Promise<BootstrapInteractiveElement[]> {
    const source = await this.getDomOrPageSource();
    return extractMobileInteractiveElements(source);
  }

  async findSemanticLocators(semanticTarget: string, actionType: string): Promise<SemanticLocatorCandidate[]> {
    const pageSource = await this.getDomOrPageSource();
    return matchSemanticLocators({
      semanticTarget,
      actionType,
      platform: this.platform,
      pageStructure: pageSource
    });
  }

  async findVisualTargets(semanticTarget: string, actionType: string): Promise<VisualTargetCandidate[]> {
    return (await this.findSemanticLocators(semanticTarget, actionType)).map((item) => ({
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      score: item.score,
      reason: item.reason,
      locator: item.locator,
      textCandidates: item.textCandidates,
      nearbyTexts: item.nearbyTexts
    }));
  }

  async close(): Promise<void> {
    return;
  }

  private async request(method: "GET" | "POST", route: string, body?: unknown): Promise<{ value?: unknown }> {
    const response = await fetch(`${this.serverUrl}/session/${this.sessionId}${route}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    if (!response.ok) throw new Error(`Appium ${method} ${route} failed: HTTP ${response.status}`);
    return (await response.json()) as { value?: unknown };
  }
}

function locatorToAppium(locator: string): { using: string; value: string } {
  if (locator.startsWith("accessibility_id=")) return { using: "accessibility id", value: locator.slice("accessibility_id=".length) };
  if (locator.startsWith("resource_id=")) return { using: "id", value: locator.slice("resource_id=".length) };
  if (locator.startsWith("id=")) return { using: "id", value: locator.slice(3) };
  if (locator.startsWith("xpath=")) return { using: "xpath", value: locator.slice(6) };
  if (locator.startsWith("text=")) {
    const text = locator.slice(5).replace(/"/g, '\\"');
    return { using: "-android uiautomator", value: `new UiSelector().textContains("${text}")` };
  }
  return { using: "xpath", value: locator };
}

function elementId(element: ElementRef): string {
  const value = element["element-6066-11e4-a52e-4f735466cecf"] ?? element.ELEMENT;
  if (!value) throw new Error(`Invalid Appium element reference: ${JSON.stringify(element)}`);
  return value;
}

function stableId(value: unknown): string {
  return crypto.createHash("sha1").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

function extractMobileInteractiveElements(source: string): BootstrapInteractiveElement[] {
  const rows: BootstrapInteractiveElement[] = [];
  const nodePattern = /<([A-Za-z0-9_.-]+)\b([^>]*)>/g;
  let match: RegExpExecArray | null;
  while ((match = nodePattern.exec(source)) && rows.length < 500) {
    const tag = match[1];
    const attrs = parseAttrs(match[2]);
    const clickable = attrs.clickable === "true";
    const enabled = attrs.enabled !== "false";
    const text = attrs.text || attrs["content-desc"] || attrs["resource-id"];
    if (!enabled || (!clickable && !text && !attrs["resource-id"])) continue;
    const locator = attrs["resource-id"]
      ? `resource_id=${attrs["resource-id"]}`
      : attrs["content-desc"]
        ? `accessibility_id=${attrs["content-desc"]}`
        : text
          ? `text=${text}`
          : undefined;
    rows.push({
      tag,
      role: attrs.class || tag,
      text: attrs.text || undefined,
      ariaLabel: attrs["content-desc"] || undefined,
      id: attrs["resource-id"] || undefined,
      selector: locator,
      elementType: /EditText|Input/i.test(tag) ? "input" : clickable ? "button" : "text",
      riskLevel: classifyMobileRisk(text || "")
    });
  }
  return rows;
}

function parseAttrs(value: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const match of value.matchAll(/([\w:-]+)="([^"]*)"/g)) attrs[match[1]] = match[2];
  return attrs;
}

function classifyMobileRisk(value: string): "low" | "medium" | "high" {
  if (/withdraw|payment|pay|delete|transfer|submit order|place order|提现|支付|删除|转账|提交订单|下单/i.test(value)) return "high";
  if (/submit|save|create|update|edit|confirm|申请|保存|创建|修改|提交|确认/i.test(value)) return "medium";
  return "low";
}
