import crypto from "node:crypto";
import path from "node:path";
import fs from "fs-extra";
import type { LoadedContext, PageState, PageTransition } from "../core/types.js";
import { writeSafeJsonFile } from "../core/safe-file-writer.js";

interface PageStateData {
  updatedAt: string;
  states: PageState[];
  transitions: PageTransition[];
}

export class PageStateStore {
  private readonly filePath: string;

  constructor(private readonly context: LoadedContext) {
    this.filePath = path.join(context.rootDir, "storage", "page-states", `${context.project.projectKey}.json`);
  }

  async load(): Promise<PageStateData> {
    if (!(await fs.pathExists(this.filePath))) return { updatedAt: new Date().toISOString(), states: [], transitions: [] };
    return (await fs.readJson(this.filePath)) as PageStateData;
  }

  async save(data: PageStateData): Promise<string> {
    data.updatedAt = new Date().toISOString();
    await writeSafeJsonFile(this.filePath, data);
    return this.filePath;
  }

  async upsertState(state: PageState): Promise<void> {
    const data = await this.load();
    const index = data.states.findIndex((item) => isSamePageState(item, state));
    if (index >= 0) {
      const existing = data.states[index];
      const visitCount = (existing.visit_count ?? 0) + 1;
      data.states[index] = {
        ...existing,
        ...mergePageState(existing, state),
        known_elements: [...new Set([...existing.known_elements, ...state.known_elements])],
        outgoing_transitions: [...new Set([...existing.outgoing_transitions, ...state.outgoing_transitions])],
        visit_count: visitCount,
        confidence_score: pageConfidence(visitCount)
      };
    } else {
      data.states.unshift({ ...state, visit_count: state.visit_count ?? 1, confidence_score: state.confidence_score ?? pageConfidence(1) });
    }
    await this.save(data);
  }

  async recordTransition(transition: PageTransition, success: boolean, durationMs: number): Promise<void> {
    const data = await this.load();
    const index = data.transitions.findIndex((item) => isSameTransition(item, transition));
    const next = index >= 0 ? data.transitions[index] : transition;
    const successCount = next.success_count + (success ? 1 : 0);
    const failureCount = next.failure_count + (success ? 0 : 1);
    const totalSuccess = Math.max(1, successCount);
    const merged: PageTransition = {
      ...next,
      ...transition,
      success_count: successCount,
      failure_count: failureCount,
      average_duration_ms: Math.round((next.average_duration_ms * next.success_count + durationMs * (success ? 1 : 0)) / totalSuccess),
      confidence_score: Math.min(0.99, successCount / Math.max(1, successCount + failureCount))
    };
    if (index >= 0) data.transitions[index] = merged;
    else data.transitions.unshift(merged);
    const fromIndex = data.states.findIndex((item) => item.page_id === transition.from_page_id);
    if (fromIndex >= 0) {
      data.states[fromIndex] = {
        ...data.states[fromIndex],
        outgoing_transitions: [...new Set([...data.states[fromIndex].outgoing_transitions, transition.transition_id])]
      };
    }
    await this.save(data);
  }
}

function isSamePageState(a: PageState, b: PageState): boolean {
  if (a.page_id === b.page_id) return true;
  if (a.project_id !== b.project_id || a.platform !== b.platform) return false;
  if (a.url_pattern && b.url_pattern && a.url_pattern === b.url_pattern) return true;
  if (a.activity_name && b.activity_name && a.activity_name === b.activity_name) return true;
  if (a.route_name && b.route_name && a.route_name === b.route_name) return true;
  if (a.dom_signature && b.dom_signature && a.dom_signature === b.dom_signature) return true;
  if (a.page_source_signature && b.page_source_signature && a.page_source_signature === b.page_source_signature) return true;
  return false;
}

function mergePageState(existing: PageState, next: PageState): PageState {
  return {
    ...existing,
    ...next,
    page_id: existing.page_id,
    page_name: next.page_name ?? existing.page_name,
    title: next.title ?? existing.title,
    source: next.source ?? existing.source,
    source_scan_id: next.source_scan_id ?? existing.source_scan_id,
    page_type: next.page_type ?? existing.page_type,
    required_preconditions: [...new Set([...(existing.required_preconditions ?? []), ...(next.required_preconditions ?? [])])],
    last_verified_at: next.last_verified_at ?? existing.last_verified_at
  };
}

function isSameTransition(a: PageTransition, b: PageTransition): boolean {
  if (a.transition_id === b.transition_id) return true;
  return a.from_page_id === b.from_page_id && a.to_page_id === b.to_page_id && normalize(a.action_description) === normalize(b.action_description);
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export function pageStateId(parts: unknown[]): string {
  return crypto.createHash("sha1").update(JSON.stringify(parts)).digest("hex").slice(0, 16);
}

function pageConfidence(visitCount: number): number {
  return Math.min(0.99, 0.5 + Math.log10(Math.max(1, visitCount)) / 2);
}
