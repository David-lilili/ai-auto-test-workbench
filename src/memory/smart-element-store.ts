import path from "node:path";
import crypto from "node:crypto";
import fs from "fs-extra";
import type { LoadedContext, Platform, SmartElement } from "../core/types.js";
import { writeSafeJsonFile } from "../core/safe-file-writer.js";

interface SmartElementData {
  updatedAt: string;
  elements: SmartElement[];
}

export class SmartElementStore {
  private readonly filePath: string;

  constructor(private readonly context: LoadedContext) {
    this.filePath = path.join(context.rootDir, "storage", "smart-elements", `${context.project.projectKey}.json`);
  }

  async load(): Promise<SmartElementData> {
    if (!(await fs.pathExists(this.filePath))) return { updatedAt: new Date().toISOString(), elements: [] };
    return (await fs.readJson(this.filePath)) as SmartElementData;
  }

  async save(data: SmartElementData): Promise<string> {
    data.updatedAt = new Date().toISOString();
    await writeSafeJsonFile(this.filePath, data);
    return this.filePath;
  }

  async findCandidates(input: {
    platform: Platform;
    pageId?: string;
    semanticName?: string;
    elementType?: string;
  }): Promise<SmartElement[]> {
    const data = await this.load();
    const target = normalize(input.semanticName ?? "");
    return data.elements
      .filter((item) => item.platform === input.platform)
      .filter((item) => !input.pageId || !item.page_id || item.page_id === input.pageId)
      .filter((item) => !input.elementType || item.element_type === input.elementType || item.element_type === "unknown")
      .map((item) => ({ item, score: scoreElement(item, target) }))
      .filter((item) => item.score > 0 || !target)
      .sort((a, b) => b.score - a.score || b.item.confidence_score - a.item.confidence_score)
      .map((item) => item.item);
  }

  async recordSuccess(input: {
    projectId: string;
    platform: Platform;
    pageId?: string;
    semanticName: string;
    semanticRole?: string;
    elementType?: SmartElement["element_type"];
    locator: string;
    textCandidates?: string[];
    nearbyTexts?: string[];
    screenRegion?: SmartElement["screen_region"];
    visualSignature?: string;
    source?: SmartElement["source"];
    sourceScanId?: string;
  }): Promise<SmartElement> {
    const data = await this.load();
    const elementId = stableId([input.projectId, input.platform, input.pageId, input.semanticName].join("|"));
    const now = new Date().toISOString();
    const index = data.elements.findIndex((item) => isSameSmartElement(item, input, elementId));
    const existing = index >= 0 ? data.elements[index] : undefined;
    const fallbackLocators = [
      ...new Set([...(existing?.fallback_locators ?? []), existing?.primary_locator, input.locator].filter(Boolean) as string[])
    ];
    const next: SmartElement = {
      element_id: existing?.element_id ?? elementId,
      project_id: input.projectId,
      platform: input.platform,
      page_id: input.pageId,
      semantic_name: input.semanticName,
      semantic_role: input.semanticRole ?? existing?.semantic_role,
      element_type: input.elementType ?? existing?.element_type ?? "unknown",
      primary_locator: existing?.primary_locator ?? input.locator,
      fallback_locators: fallbackLocators,
      text_candidates: [...new Set([...(existing?.text_candidates ?? []), ...(input.textCandidates ?? [])])].slice(0, 30),
      nearby_texts: [...new Set([...(existing?.nearby_texts ?? []), ...(input.nearbyTexts ?? [])])].slice(0, 30),
      visual_signature: input.visualSignature ?? existing?.visual_signature,
      screen_region: input.screenRegion ?? existing?.screen_region,
      last_success_locator: input.locator,
      success_count: (existing?.success_count ?? 0) + 1,
      failure_count: existing?.failure_count ?? 0,
      confidence_score: confidence((existing?.success_count ?? 0) + 1, existing?.failure_count ?? 0),
      source: input.source ?? existing?.source,
      source_scan_id: input.sourceScanId ?? existing?.source_scan_id,
      last_seen_at: now,
      last_updated_at: now
    };
    if (index >= 0) data.elements[index] = next;
    else data.elements.unshift(next);
    await this.save(data);
    return next;
  }

  async recordFailure(input: { platform: Platform; semanticName?: string; locator?: string; pageId?: string }): Promise<void> {
    const data = await this.load();
    const target = normalize(input.semanticName ?? "");
    let changed = false;
    for (const element of data.elements) {
      if (element.platform !== input.platform) continue;
      if (input.pageId && element.page_id && element.page_id !== input.pageId) continue;
      if (input.locator && ![element.primary_locator, ...element.fallback_locators].includes(input.locator)) continue;
      if (target && normalize(element.semantic_name) !== target) continue;
      element.failure_count += 1;
      element.confidence_score = confidence(element.success_count, element.failure_count);
      element.last_updated_at = new Date().toISOString();
      changed = true;
    }
    if (changed) await this.save(data);
  }
}

function scoreElement(element: SmartElement, target: string): number {
  if (!target) return element.confidence_score;
  const haystack = [element.semantic_name, ...element.text_candidates, ...element.nearby_texts].map(normalize).join(" ");
  if (normalize(element.semantic_name) === target) return 100 + element.confidence_score;
  const textScore = target
    .split(/\s+/)
    .filter(Boolean)
    .reduce((score, term) => score + (haystack.includes(term) ? 10 : 0), 0);
  return textScore > 0 ? textScore + element.confidence_score : 0;
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function confidence(success: number, failure: number): number {
  return Math.min(0.99, Math.max(0.1, success / Math.max(1, success + failure)));
}

function stableId(value: string): string {
  return crypto.createHash("sha1").update(value).digest("hex").slice(0, 16);
}

function isSameSmartElement(
  element: SmartElement,
  input: {
    projectId: string;
    platform: Platform;
    pageId?: string;
    semanticName: string;
    locator: string;
    textCandidates?: string[];
  },
  elementId: string
): boolean {
  if (element.element_id === elementId) return true;
  if (element.project_id !== input.projectId || element.platform !== input.platform) return false;
  if (element.page_id && input.pageId && element.page_id !== input.pageId) return false;
  const locators = [element.primary_locator, element.last_success_locator, ...element.fallback_locators].filter(Boolean);
  if (locators.includes(input.locator)) return true;
  if (normalize(element.semantic_name) === normalize(input.semanticName)) return true;
  const inputTexts = (input.textCandidates ?? []).map(normalize).filter(Boolean);
  const elementTexts = [element.semantic_name, ...element.text_candidates].map(normalize).filter(Boolean);
  return inputTexts.some((text) => elementTexts.includes(text));
}
