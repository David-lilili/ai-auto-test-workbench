import fs from "fs-extra";
import path from "node:path";
import { writeSafeJsonFile, writeSafeTextFile } from "../core/safe-file-writer.js";
import { callConfiguredAiJson } from "../core/ai-provider.js";
import { logger } from "../core/logger.js";

/** P3-A8：case drafter prompt 稳定版本。 */
export const PROMPT_VERSION = "case-drafter.v1";

/**
 * 用例资产批量起草（M3）：基于 Page Model Store 的已建模页面，
 * 用 DeepSeek 批量起草用例资产草稿。
 *
 * 边界：
 * - 草稿落在 storage/case-drafts/<project>/，不写入 storage/cases/<project>.json；
 *   入库必须人工审核后由 apply 入口执行（与 proposal 审核闭环同一原则）。
 * - AI 失败/超时/不可解析时硬失败该页，不静默跳过；整体结果如实统计。
 * - 起草只读 Page Model 元信息（页面/元素语义名/断言候选），不读 locator 细节，
 *   因为用例资产不保存定位信息。
 */

export interface CaseDraftItem {
  id: string;
  title: string;
  module: string;
  pageModelId?: string;
  priority: "P0" | "P1" | "P2" | "P3";
  caseType: "positive" | "negative" | "boundary" | "readonly";
  automationCandidate: boolean;
  request: string;
  businessRequest?: string;
  preconditions: string[];
  expectedAssertion: string;
  expectedResults: { ui?: string[]; api?: string[]; database?: string[] };
}

export interface CaseDraftPageResult {
  pageId: string;
  pageName: string;
  status: "drafted" | "failed" | "skipped";
  cases?: CaseDraftItem[];
  error?: string;
  promptTokens?: number;
  completionTokens?: number;
}

export interface CaseDraftRunResult {
  schemaVersion: "case-asset-draft-run.v1";
  runId: string;
  project: string;
  env: string;
  generatedAt: string;
  pageFilter?: string[];
  totalPages: number;
  draftedPages: number;
  failedPages: number;
  skippedPages: number;
  totalCases: number;
  draftPath: string;
  telemetry: { promptTokens: number; completionTokens: number; elapsedMs: number };
  pages: CaseDraftPageResult[];
}

export async function draftCaseAssetsFromPageModels(input: {
  rootDir: string;
  project: string;
  env: string;
  pageFilter?: string[];
  timeoutMs?: number;
}): Promise<CaseDraftRunResult> {
  const { rootDir, project, env } = input;
  if (!/^[a-z0-9_-]+$/i.test(project)) throw new Error(`Invalid project key: ${project}`);
  const storePath = path.join(rootDir, "storage", "page-models", `${project}.json`);
  if (!(await fs.pathExists(storePath))) {
    throw new Error(`Page Model Store not configured for ${project}`);
  }
  const store = await fs.readJson(storePath) as Record<string, unknown>;
  const models = Array.isArray(store.models) ? store.models as Array<Record<string, unknown>> : [];
  const selected = input.pageFilter?.length
    ? models.filter((model) => input.pageFilter!.includes(String(model.pageId ?? "")))
    : models;

  const runId = `case-draft-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const pages: CaseDraftPageResult[] = [];
  const telemetry = { promptTokens: 0, completionTokens: 0, elapsedMs: 0 };
  const startedAt = Date.now();

  for (const model of selected) {
    const pageId = String(model.pageId ?? "");
    const pageName = String(model.pageName ?? pageId);
    const status = String(model.status ?? "candidate");
    if (!pageId) {
      pages.push({ pageId, pageName, status: "skipped", error: "missing_page_id" });
      continue;
    }
    // 只为达到 dom_verified 及以上的页面起草；candidate 页面先补建模。
    if (status === "candidate") {
      pages.push({ pageId, pageName, status: "skipped", error: `page_status_candidate_needs_modeling_first` });
      continue;
    }
    const elementNames = (Array.isArray(model.elements) ? model.elements as Array<Record<string, unknown>> : [])
      .slice(0, 30)
      .map((element) => String(element.semanticName ?? ""))
      .filter(Boolean);
    const assertionCandidates = (Array.isArray(model.assertions) ? model.assertions as Array<Record<string, unknown>> : [])
      .slice(0, 6)
      .map((assertion) => ({
        semanticName: String(assertion.semanticName ?? ""),
        assertionType: String(assertion.assertionType ?? ""),
        expectedTexts: Array.isArray(assertion.expectedTexts) ? assertion.expectedTexts.map(String) : []
      }))
      .filter((item) => item.semanticName);

    const prompt = JSON.stringify({
      task: "Draft test case assets for this modeled page. Return JSON only.",
      rules: [
        "用例资产只描述业务步骤和期望断言，不包含 selector、locator 或任何执行细节。",
        "每条用例必须有 id、title、module、priority、caseType、automationCandidate、request（编号步骤）、preconditions、expectedAssertion。",
        "expectedAssertion 必须是页面上可观察的断言（可见文本、控件状态、列表行、空态），不得是接口或数据库断言。",
        "区分正向（positive）、负向（negative）、边界（boundary）、只读（readonly）用例；每页 3-5 条，优先覆盖已建模元素和断言候选。",
        "id 格式：<project>-<module拼音或英文>-<场景>-<priority小写>-<三位序号>。",
        "automationCandidate 判断：步骤全部可由已建模元素支撑且断言可观察时为 true。"
      ],
      page: {
        pageId,
        pageName,
        module: String(model.module ?? ""),
        url: String(model.url ?? ""),
        expectedCapability: String(model.expectedCapability ?? ""),
        elementSemanticNames: elementNames,
        assertionCandidates
      },
      project,
      env
    });

    const result = await callConfiguredAiJson({
      rootDir,
      promptVersion: PROMPT_VERSION,
      system: "You are a test case author for an automation platform. Output compact JSON only: {\"cases\":[...]}. Write case titles and steps in Chinese. Never invent elements not listed; base steps only on given elementSemanticNames and assertionCandidates.",
      prompt,
      timeoutMs: input.timeoutMs ?? 60_000,
      temperature: 0.2
    });
    telemetry.promptTokens += result.telemetry.promptTokens ?? 0;
    telemetry.completionTokens += result.telemetry.completionTokens ?? 0;
    if (result.status !== "completed" || !result.parsedOutput) {
      pages.push({ pageId, pageName, status: "failed", error: result.error ?? "unparseable_ai_output" });
      continue;
    }
    const parsed = result.parsedOutput as { cases?: unknown };
    if (!parsed || !Array.isArray(parsed.cases)) {
      pages.push({ pageId, pageName, status: "failed", error: "ai_output_missing_cases_array" });
      continue;
    }
    const cases = parsed.cases
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
      .map((item) => normalizeDraftCase(item, project, String(model.module ?? "")))
      .filter((item): item is CaseDraftItem => item !== null);
    if (!cases.length) {
      pages.push({ pageId, pageName, status: "failed", error: "no_valid_cases_drafted" });
      continue;
    }
    pages.push({ pageId, pageName, status: "drafted", cases, promptTokens: result.telemetry.promptTokens, completionTokens: result.telemetry.completionTokens });
  }

  telemetry.elapsedMs = Date.now() - startedAt;
  const drafted = pages.filter((page) => page.status === "drafted");
  const draftPath = path.join(rootDir, "storage", "case-drafts", project, `${runId}.json`);
  const runResult: CaseDraftRunResult = {
    schemaVersion: "case-asset-draft-run.v1",
    runId,
    project,
    env,
    generatedAt: new Date().toISOString(),
    pageFilter: input.pageFilter,
    totalPages: pages.length,
    draftedPages: drafted.length,
    failedPages: pages.filter((page) => page.status === "failed").length,
    skippedPages: pages.filter((page) => page.status === "skipped").length,
    totalCases: drafted.reduce((sum, page) => sum + (page.cases?.length ?? 0), 0),
    draftPath: path.relative(rootDir, draftPath).replace(/\\/g, "/"),
    telemetry,
    pages
  };
  await writeSafeJsonFile(draftPath, runResult);
  await writeSafeTextFile(
    path.join(rootDir, "storage", "case-drafts", project, `${runId}.md`),
    renderDraftReport(runResult)
  );
  logger.info("Case assets drafted", { project, draftedPages: runResult.draftedPages, totalCases: runResult.totalCases });
  return runResult;
}

function normalizeDraftCase(item: Record<string, unknown>, project: string, moduleFallback: string): CaseDraftItem | null {
  const title = String(item.title ?? "").trim();
  const request = String(item.request ?? "").trim();
  const expectedAssertion = String(item.expectedAssertion ?? "").trim();
  if (!title || !request || !expectedAssertion) return null;
  const priority = ["P0", "P1", "P2", "P3"].includes(String(item.priority)) ? String(item.priority) as CaseDraftItem["priority"] : "P2";
  const caseType = ["positive", "negative", "boundary", "readonly"].includes(String(item.caseType)) ? String(item.caseType) as CaseDraftItem["caseType"] : "positive";
  const id = String(item.id ?? "").trim() || `${project}-draft-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  return {
    id,
    title,
    module: String(item.module ?? moduleFallback).trim() || moduleFallback,
    pageModelId: typeof item.pageModelId === "string" ? item.pageModelId : undefined,
    priority,
    caseType,
    automationCandidate: item.automationCandidate !== false,
    request,
    businessRequest: typeof item.businessRequest === "string" ? item.businessRequest : undefined,
    preconditions: Array.isArray(item.preconditions) ? item.preconditions.map(String).filter(Boolean) : [],
    expectedAssertion,
    expectedResults: {
      ui: Array.isArray((item.expectedResults as Record<string, unknown> | undefined)?.ui)
        ? ((item.expectedResults as Record<string, unknown>).ui as unknown[]).map(String)
        : undefined,
      api: undefined,
      database: undefined
    }
  };
}

function renderDraftReport(run: CaseDraftRunResult): string {
  const lines = [
    `# 用例资产起草报告 ${run.runId}`,
    "",
    `- 项目：${run.project} / ${run.env}`,
    `- 页面：共 ${run.totalPages}，起草成功 ${run.draftedPages}，失败 ${run.failedPages}，跳过 ${run.skippedPages}`,
    `- 用例草稿：${run.totalCases} 条`,
    `- 草稿文件：\`${run.draftPath}\`（未入库；入库需人工审核）`,
    `- Token：prompt ${run.telemetry.promptTokens} / completion ${run.telemetry.completionTokens}，耗时 ${run.telemetry.elapsedMs}ms`,
    "",
    "## 各页起草结果",
    ""
  ];
  for (const page of run.pages) {
    lines.push(`- ${page.pageName}（${page.pageId}）：${page.status}${page.error ? `，原因 ${page.error}` : `，${page.cases?.length ?? 0} 条`}`);
  }
  lines.push("", "## 说明", "");
  lines.push("草稿在 storage/case-drafts/，不写入 storage/cases/。审核通过后按 docs/case-authoring-guide.md 入库，再由用例中心生成 DSL。");
  return `${lines.join("\n")}\n`;
}
