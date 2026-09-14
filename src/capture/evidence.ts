import crypto from "node:crypto";
import path from "node:path";
import type { Page } from "@playwright/test";
import { writeSafeJsonFile, writeSafeTextFile } from "../core/safe-file-writer.js";
import { collectInventory } from "./inventory.js";
import type {
  CaptureEvidence,
  CaptureKnowledgeStatus,
  CaptureRunConfig,
  CaptureSignalGroup,
  CaptureSignalRole,
  CaptureSignalSummary,
  CaptureTarget,
  InventoryItem,
  InventorySummary
} from "./types.js";

export function sha256(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

export function toRelativePath(rootDir: string, filePath: string): string {
  return path.relative(rootDir, filePath).replace(/\\/g, "/");
}

export async function capturePage(
  page: Page,
  rootDir: string,
  artifactDir: string,
  prefix: string,
  target: CaptureTarget,
  config: CaptureRunConfig
): Promise<CaptureEvidence> {
  const safePrefix = prefix.replace(/[^a-z0-9_-]+/gi, "_").toLowerCase();
  const screenshotPath = path.join(artifactDir, `${safePrefix}.png`);
  const domPath = path.join(artifactDir, `${safePrefix}.dom.html`);
  const visibleTextPath = path.join(artifactDir, `${safePrefix}.visible-text.txt`);
  const accessibilityPath = path.join(artifactDir, `${safePrefix}.accessibility.json`);
  const summaryPath = path.join(artifactDir, `${safePrefix}.summary.json`);
  const url = page.url();
  const title = await page.title().catch(() => "");
  const dom = await page.content().catch(() => "");
  const visibleText = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
  const accessibility = { unavailable: true, reason: "Playwright accessibility snapshot API is not exposed by the current Page object." };
  const inventory = await collectInventory(page);
  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => undefined);
  await writeSafeTextFile(domPath, dom);
  await writeSafeTextFile(visibleTextPath, visibleText);
  await writeSafeJsonFile(accessibilityPath, accessibility);
  await writeSafeJsonFile(summaryPath, inventory);
  const signals = detectSignals([title, url, visibleText, JSON.stringify(inventory)].join("\n"), config.signalGroups);
  const status = inferStatus(target, signals, dom, visibleText);
  return {
    id: target.id,
    pageId: target.pageId,
    label: target.label,
    module: target.module,
    action: target.action,
    url,
    title,
    pageType: inferPageType(inventory, signals),
    screenshotPath: toRelativePath(rootDir, screenshotPath),
    domPath: toRelativePath(rootDir, domPath),
    visibleTextPath: toRelativePath(rootDir, visibleTextPath),
    accessibilityPath: toRelativePath(rootDir, accessibilityPath),
    summaryPath: toRelativePath(rootDir, summaryPath),
    domHash: sha256(dom),
    visibleTextHash: sha256(visibleText),
    visibleTextSample: visibleText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 30),
    signals,
    inventory,
    status,
    confidence: inferConfidence(status, signals, inventory)
  };
}

export async function clickEntry(page: Page, text: string): Promise<Record<string, unknown>> {
  const beforeUrl = page.url();
  const strategies = [
    { name: "role_button", locator: page.getByRole("button", { name: new RegExp(escapeRegex(text)) }).first() },
    { name: "role_link", locator: page.getByRole("link", { name: new RegExp(escapeRegex(text)) }).first() },
    { name: "text_exact", locator: page.getByText(text, { exact: true }).first() },
    { name: "text_fuzzy", locator: page.getByText(new RegExp(escapeRegex(text))).first() }
  ];
  for (const item of strategies) {
    const count = await item.locator.count().catch(() => 0);
    if (!count) continue;
    const visible = await item.locator.isVisible({ timeout: 1500 }).catch(() => false);
    if (!visible) continue;
    try {
      await item.locator.click({ timeout: 8000 });
      return { attempted: true, status: "clicked", strategy: item.name, text, beforeUrl, afterUrl: page.url() };
    } catch (error) {
      return { attempted: true, status: "click_failed", strategy: item.name, text, beforeUrl, afterUrl: page.url(), errorMessage: formatError(error) };
    }
  }
  return { attempted: true, status: "entry_not_found", text, beforeUrl, afterUrl: page.url() };
}

export function detectSignals(text: string, groups: CaptureSignalGroup[]): CaptureSignalSummary {
  const matchedGroups = groups.map((group) => ({
    name: group.name,
    matched: findTerms(text, group.terms),
    weight: group.weight ?? 1,
    role: group.role
  }));
  const blockTerms = matchedGroups.filter((group) => group.role === "block").flatMap((group) => group.matched);
  const score = matchedGroups.reduce((total, group) => total + group.matched.length * group.weight, 0);
  return { groups: matchedGroups, blockTerms, score };
}

export function matchedTermsByRole(signals: CaptureSignalSummary, role: CaptureSignalRole): string[] {
  return [...new Set(signals.groups.filter((group) => group.role === role).flatMap((group) => group.matched))];
}

export function inferPageType(inventory: InventorySummary, signals: CaptureSignalSummary): string {
  if (inventory.dialogs.length) return "modal_or_drawer_state";
  if (inventory.fields.length >= 2 || matchedTermsByRole(signals, "form").length >= 3) return "form_or_filter";
  if (inventory.tables.length || matchedTermsByRole(signals, "record").length) return "list_or_dashboard";
  return "page";
}

export function inferStatus(target: CaptureTarget, signals: CaptureSignalSummary, dom: string, visibleText: string): CaptureKnowledgeStatus {
  if (!dom && !visibleText) return "blocked";
  if (target.kind === "same_page_action") return "click_observed";
  if (signals.score > 0 && dom) return "dom_verified";
  if (visibleText) return "screenshot_verified";
  return "candidate";
}

export function inferConfidence(status: CaptureKnowledgeStatus, signals: CaptureSignalSummary, inventory: InventorySummary): number {
  let confidence = status === "dom_verified" ? 0.68 : status === "click_observed" ? 0.62 : status === "screenshot_verified" ? 0.55 : 0.4;
  if (signals.score >= 8) confidence += 0.08;
  if (inventory.fields.length || inventory.tables.length || inventory.clickables.length) confidence += 0.05;
  return Number(Math.min(0.82, confidence).toFixed(2));
}

export function inferActionStatus(actionResult?: Record<string, unknown>): string {
  if (!actionResult) return "not_attempted";
  return actionResult.status === "clicked" ? "click_observed" : String(actionResult.status ?? "unknown");
}

export function locatorCandidatesFromInventory(item: InventoryItem): Array<Record<string, unknown>> {
  return [
    item.id ? { strategy: "css", value: `#${String(item.id)}`, confidence: 0.72, source: "dom" } : undefined,
    item.name ? { strategy: "css", value: `[name="${String(item.name)}"]`, confidence: 0.68, source: "dom" } : undefined,
    item.ariaLabel ? { strategy: "aria_label", value: item.ariaLabel, confidence: 0.64, source: "dom" } : undefined,
    item.placeholder ? { strategy: "placeholder", value: item.placeholder, confidence: 0.62, source: "dom" } : undefined,
    item.text ? { strategy: "text", value: item.text, confidence: 0.58, source: "visible_text" } : undefined,
    item.href ? { strategy: "href", value: item.href, confidence: 0.55, source: "dom" } : undefined
  ].filter(Boolean) as Array<Record<string, unknown>>;
}

export function confidenceForElement(item: InventoryItem): number {
  if (item.id || item.name) return 0.68;
  if (item.ariaLabel || item.placeholder) return 0.62;
  if (item.text) return 0.56;
  return 0.42;
}

export function sourceArtifacts(capture: CaptureEvidence): Record<string, string> {
  return {
    screenshot: capture.screenshotPath,
    dom: capture.domPath,
    visibleText: capture.visibleTextPath,
    accessibility: capture.accessibilityPath,
    summary: capture.summaryPath
  };
}

export function evidenceRefs(capture: CaptureEvidence): Array<Record<string, unknown>> {
  return [
    { source: "screenshot", path: capture.screenshotPath, confidence: 0.65 },
    { source: "dom", path: capture.domPath, confidence: 0.75 },
    { source: "visible_text", path: capture.visibleTextPath, confidence: 0.6 },
    { source: "accessibility", path: capture.accessibilityPath, confidence: 0.55 },
    { source: "inventory_summary", path: capture.summaryPath, confidence: 0.7 }
  ];
}

function findTerms(text: string, terms: string[]): string[] {
  return [...new Set(terms.filter((term) => new RegExp(escapeRegex(term), "i").test(text)))];
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
