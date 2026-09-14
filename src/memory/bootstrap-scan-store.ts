import crypto from "node:crypto";
import path from "node:path";
import fs from "fs-extra";
import type {
  AutomationCase,
  BootstrapReviewPackage,
  BootstrapReviewStatus,
  BootstrapScanData,
  BootstrapScanElement,
  BootstrapScanPage,
  BootstrapScanPath,
  BootstrapScanRun,
  LoadedContext,
  PageState,
  PageTransition,
  SmartElement
} from "../core/types.js";
import { PageStateStore } from "./page-state-store.js";
import { SmartElementStore } from "./smart-element-store.js";
import { KnowledgeStore } from "./knowledge-store.js";
import { BusinessFlowStore, businessFlowId } from "./business-flow-store.js";
import { writeSafeJsonFile } from "../core/safe-file-writer.js";

export class BootstrapScanStore {
  private readonly filePath: string;

  constructor(private readonly context: LoadedContext) {
    this.filePath = path.join(context.rootDir, "storage", "bootstrap-scans", `${context.project.projectKey}.json`);
  }

  async load(): Promise<BootstrapScanData> {
    if (!(await fs.pathExists(this.filePath))) {
      return {
        updatedAt: new Date().toISOString(),
        runs: [],
        pages: [],
        paths: [],
        elements: [],
        reviewPackages: [],
        dslCases: []
      };
    }
    return (await fs.readJson(this.filePath)) as BootstrapScanData;
  }

  async save(data: BootstrapScanData): Promise<string> {
    data.updatedAt = new Date().toISOString();
    await writeSafeJsonFile(this.filePath, data);
    return this.filePath;
  }

  async upsertRun(run: BootstrapScanRun): Promise<void> {
    const data = await this.load();
    const index = data.runs.findIndex((item) => item.scan_id === run.scan_id);
    if (index >= 0) data.runs[index] = run;
    else data.runs.unshift(run);
    data.runs = data.runs.slice(0, 200);
    await this.save(data);
  }

  async appendPage(page: BootstrapScanPage): Promise<void> {
    const data = await this.load();
    const index = data.pages.findIndex((item) => item.scan_page_id === page.scan_page_id);
    if (index >= 0) data.pages[index] = page;
    else data.pages.push(page);
    await this.save(data);
  }

  async appendElement(element: BootstrapScanElement): Promise<void> {
    const data = await this.load();
    const index = data.elements.findIndex((item) => item.scan_element_id === element.scan_element_id);
    if (index >= 0) data.elements[index] = element;
    else data.elements.push(element);
    await this.save(data);
  }

  async appendPath(scanPath: BootstrapScanPath): Promise<void> {
    const data = await this.load();
    const index = data.paths.findIndex((item) => item.scan_path_id === scanPath.scan_path_id);
    if (index >= 0) data.paths[index] = scanPath;
    else data.paths.push(scanPath);
    await this.save(data);
  }

  async appendDslCase(testCase: AutomationCase): Promise<void> {
    const data = await this.load();
    const index = data.dslCases.findIndex((item) => item.id === testCase.id);
    if (index >= 0) data.dslCases[index] = testCase;
    else data.dslCases.push(testCase);
    await this.save(data);
  }

  async appendReviewPackage(reviewPackage: BootstrapReviewPackage): Promise<void> {
    const data = await this.load();
    const index = data.reviewPackages.findIndex((item) => item.package_id === reviewPackage.package_id);
    if (index >= 0) data.reviewPackages[index] = reviewPackage;
    else data.reviewPackages.unshift(reviewPackage);
    await this.save(data);
  }

  async markReviewStatus(scanId: string, status: BootstrapReviewStatus): Promise<void> {
    const data = await this.load();
    for (const run of data.runs.filter((item) => item.scan_id === scanId)) run.review_status = status;
    for (const page of data.pages.filter((item) => item.scan_id === scanId)) page.review_status = status;
    for (const item of data.paths.filter((pathItem) => pathItem.scan_id === scanId)) item.review_status = status;
    for (const element of data.elements.filter((item) => item.scan_id === scanId)) element.review_status = status;
    await this.save(data);
  }

  async importReviewResult(input: { scanId: string; rawText: string; filePath?: string }): Promise<{ imported: boolean; updated: number }> {
    const data = await this.load();
    const parsed = parseReviewResult(input.rawText);
    let updated = 0;
    for (const item of parsed.elements) {
      const target = data.elements.find(
        (element) =>
          element.scan_id === input.scanId &&
          (item.scan_element_id
            ? element.scan_element_id === item.scan_element_id
            : normalize(element.semantic_name) === normalize(item.semantic_name ?? ""))
      );
      if (!target) continue;
      if (item.primary_locator) target.primary_locator = item.primary_locator;
      if (item.fallback_locators?.length) target.fallback_locators = unique([...(target.fallback_locators ?? []), ...item.fallback_locators]);
      if (item.semantic_name) target.semantic_name = item.semantic_name;
      target.review_status = "approved";
      target.confidence_score = Math.max(target.confidence_score, 0.85);
      updated += 1;
    }
    for (const item of parsed.dslCases) {
      const testCase = normalizeDslCase(item, input.scanId, data.dslCases.length + 1);
      const index = data.dslCases.findIndex((existing) => existing.id === testCase.id);
      if (index >= 0) data.dslCases[index] = testCase;
      else data.dslCases.push(testCase);
      updated += 1;
    }
    for (const pack of data.reviewPackages.filter((item) => item.scan_id === input.scanId)) {
      pack.imported = true;
      pack.review_result_path = input.filePath;
    }
    await this.save(data);
    return { imported: updated > 0, updated };
  }

  async replay(scanId: string): Promise<{ passed: number; failed: number; total: number }> {
    const data = await this.load();
    let passed = 0;
    let failed = 0;
    for (const item of data.paths.filter((pathItem) => pathItem.scan_id === scanId)) {
      const valid = item.candidate_dsl_steps.length > 0 && item.candidate_dsl_steps.every((step) => Boolean(step.action) && Boolean(step.semantic_target ?? step.target));
      item.replay_status = valid ? "passed" : "failed";
      if (valid) passed += 1;
      else failed += 1;
    }
    await this.save(data);
    return { passed, failed, total: passed + failed };
  }

  async promote(scanId: string): Promise<{ pages: number; paths: number; elements: number; dslCases: number; files: string[] }> {
    const data = await this.load();
    const pageStore = new PageStateStore(this.context);
    const elementStore = new SmartElementStore(this.context);
    const promotedPages = data.pages.filter((item) => item.scan_id === scanId && item.review_status === "approved");
    const promotedPaths = data.paths.filter((item) => item.scan_id === scanId && item.review_status === "approved" && item.replay_status === "passed");
    const promotedElements = data.elements.filter((item) => item.scan_id === scanId && item.review_status === "approved");
    let pages = 0;
    let paths = 0;
    let elements = 0;
    const files: string[] = [];
    const promotedPageStates: PageState[] = [];
    const promotedTransitions: PageTransition[] = [];
    const promotedSmartElements: SmartElement[] = [];
    for (const page of promotedPages) {
      const state: PageState = {
        ...page.candidate_page_state,
        source: "bootstrap_scan",
        source_scan_id: scanId,
        page_type: page.detected_page_type,
        last_verified_at: new Date().toISOString()
      };
      await pageStore.upsertState(state);
      promotedPageStates.push(state);
      page.review_status = "promoted";
      pages += 1;
    }
    for (const item of promotedPaths) {
      await pageStore.recordTransition(item.candidate_transition, true, item.candidate_transition.average_duration_ms || 0);
      promotedTransitions.push(item.candidate_transition);
      item.review_status = "promoted";
      paths += 1;
    }
    for (const element of promotedElements) {
      const smart = await elementStore.recordSuccess({
        projectId: this.context.project.projectKey,
        platform: this.context.project.enabledTestTypes.includes("web") ? "web" : "android",
        pageId: promotedPages.find((page) => page.scan_page_id === element.scan_page_id)?.candidate_page_state.page_id,
        semanticName: element.semantic_name,
        semanticRole: element.semantic_role,
        elementType: element.element_type,
        locator: element.primary_locator ?? element.fallback_locators[0] ?? `semantic=${element.semantic_name}`,
        textCandidates: element.text_candidates,
        nearbyTexts: element.nearby_texts,
        screenRegion: element.bounding_box,
        visualSignature: element.visual_signature,
        source: "bootstrap_scan",
        sourceScanId: scanId
      });
      promotedSmartElements.push(smart);
      element.review_status = "promoted";
      elements += 1;
    }
    const approvedCases = data.dslCases.filter((item) => item.id.includes(scanId.slice(0, 8)));
    for (const testCase of approvedCases) {
      const filePath = path.join(this.context.rootDir, "projects", this.context.project.projectKey, "bootstrap", `${safeName(testCase.id)}.case.json`);
      await writeSafeJsonFile(filePath, testCase);
      files.push(filePath);
    }
    const run = data.runs.find((item) => item.scan_id === scanId);
    if (run) run.promote_status = pages + paths + elements + files.length > 0 ? "promoted" : "skipped";
    const blockedActions = run?.blocked_actions ?? [];
    const businessFlows = (run?.target_flows ?? []).map((flow) => ({
      flow_id: businessFlowId([this.context.project.projectKey, this.context.env.env, flow]),
      project_id: this.context.project.projectKey,
      env: this.context.env.env,
      platform: this.context.project.enabledTestTypes.includes("web") ? ("web" as const) : ("android" as const),
      name: flow,
      target_flows: [flow],
      start_page_id: promotedPageStates[0]?.page_id,
      target_page_ids: [...new Set(promotedPageStates.map((item) => item.page_id))],
      transition_ids: [...new Set(promotedTransitions.map((item) => item.transition_id))],
      dsl_case_ids: approvedCases.map((item) => item.id),
      preconditions: [...new Set(promotedPageStates.flatMap((item) => item.required_preconditions ?? []))],
      risk_level: blockedActions.some((item) => item.reason === "high_risk") ? ("high" as const) : ("medium" as const),
      source_scan_id: scanId,
      review_status: "approved" as const,
      replay_status: promotedPaths.some((item) => item.replay_status === "failed") ? ("failed" as const) : ("passed" as const),
      promote_status: pages + paths + elements + files.length > 0 ? ("promoted" as const) : ("skipped" as const),
      confidence_score: Math.min(0.95, 0.55 + Math.min(0.3, promotedPaths.length / 20) + Math.min(0.1, approvedCases.length / 20)),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }));
    for (const flow of businessFlows) await new BusinessFlowStore(this.context).upsert(flow);
    await new KnowledgeStore(this.context).syncFormalAssets({
      pages: promotedPageStates,
      transitions: promotedTransitions,
      elements: promotedSmartElements,
      dslCases: approvedCases,
      sourceScanId: scanId
    });
    if (businessFlows.length) await new KnowledgeStore(this.context).syncBusinessFlows(businessFlows);
    await this.save(data);
    return { pages, paths, elements, dslCases: files.length, files };
  }
}

export function bootstrapId(parts: unknown[]): string {
  return crypto.createHash("sha1").update(JSON.stringify(parts)).digest("hex").slice(0, 16);
}

function parseReviewResult(rawText: string): {
  elements: Array<{ scan_element_id?: string; semantic_name?: string; primary_locator?: string; fallback_locators?: string[] }>;
  dslCases: unknown[];
} {
  const jsonText = extractJson(rawText);
  if (!jsonText) return { elements: [], dslCases: [] };
  const parsed = JSON.parse(jsonText) as Record<string, unknown>;
  return {
    elements: Array.isArray(parsed.elements) ? (parsed.elements as never[]) : [],
    dslCases: Array.isArray(parsed.dsl_cases) ? parsed.dsl_cases : Array.isArray(parsed.dslCases) ? parsed.dslCases : []
  };
}

function extractJson(rawText: string): string | undefined {
  const fenced = rawText.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();
  const start = rawText.indexOf("{");
  const end = rawText.lastIndexOf("}");
  if (start >= 0 && end > start) return rawText.slice(start, end + 1);
  return undefined;
}

function normalizeDslCase(value: unknown, scanId: string, index: number): AutomationCase {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    id: String(raw.id ?? `bootstrap_${scanId.slice(0, 8)}_${String(index).padStart(3, "0")}`),
    title: String(raw.title ?? "Bootstrap generated DSL"),
    type: String(raw.type ?? "web") as AutomationCase["type"],
    project: String(raw.project ?? ""),
    module: String(raw.module ?? "bootstrap"),
    priority: String(raw.priority ?? "P2") as AutomationCase["priority"],
    tags: Array.isArray(raw.tags) ? raw.tags.map(String) : ["bootstrap_scan"],
    owner: String(raw.owner ?? "qa"),
    env: Array.isArray(raw.env) ? raw.env.map(String) : [],
    steps: Array.isArray(raw.steps) ? (raw.steps as AutomationCase["steps"]) : [],
    assertions: Array.isArray(raw.assertions) ? (raw.assertions as AutomationCase["assertions"]) : [],
    automationCandidate: true,
    suggestedLayer: "web"
  };
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function safeName(value: string): string {
  return value.replace(/[^\w.-]+/g, "_");
}
