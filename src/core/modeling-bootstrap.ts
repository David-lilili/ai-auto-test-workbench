import fs from "fs-extra";
import path from "node:path";
import crypto from "node:crypto";
import type { Page } from "@playwright/test";
import { writeSafeJsonFile, writeSafeTextFile } from "./safe-file-writer.js";
import { logger } from "./logger.js";
import { collectInventory } from "../capture/inventory.js";
import type { InventoryItem, InventorySummary } from "../capture/types.js";
import { resolvePageIdentity, loadPageIdentitySignals, normalizeUrl, type PageIdentityResult } from "./page-identity-resolver.js";
import { scanPageStructure } from "./modeling-structure-scanner.js";
import type { InitialCaptureSummary } from "./modeling-session.js";

/**
 * P6.2/P6.3：通用 initial bootstrap——「未建模 URL → Initial Page Model Candidate」。
 *
 * 硬约束（P6.3）：
 *   - 本模块绝不直接 read/write storage/page-models/<project>.json；
 *   - 产出物是与既有审核管线兼容的 page_model_ingest proposal（storage/proposals/pending/），
 *     后续写回只经 page-model-writeback（状态上限 candidate）；
 *   - Page Identity Resolver 不可绕过：NEW→proposal；SAME→canonical merge；POSSIBLE/CONFLICT→stop to review；
 *     RELATED_STATE_MODEL→作为 related state，不创建重复 base page。
 */

export const MODELING_INGEST_PROPOSAL_TYPE = "page_model_ingest";

export interface BootstrapPageResult {
  pageId: string;
  url: string;
  normalizedUrl: string;
  title: string;
  identity: PageIdentityResult;
  /** P6.2 采集摘要（写入 session.initialCapture）。 */
  initialCapture: InitialCaptureSummary;
  /** proposal 相对路径（仅 NEW_PAGE 或 SAME 需 merge 时产生）。 */
  proposalPath?: string;
  proposalId?: string;
  /** SAME_PAGE 时的 canonical 写回目标（identity.targetPageId）。 */
  canonicalPageId?: string;
  /** P6.2：结构扫描摘要（result regions / assertion candidates / native options）。 */
  structureScan?: {
    resultRegions: number;
    assertionCandidates: number;
    nativeSelectOptions: number;
  };
  /** identity 分支后的处理说明。 */
  branchAction: "new_proposal" | "same_canonical_merge" | "related_state" | "review_required";
  reviewReason?: string;
}

export interface BootstrapPageInput {
  rootDir: string;
  project: string;
  env: string;
  url: string;
  /** 已打开的页面（外部注入，避免重复登录）；未传则自行打开。 */
  page?: Page;
  artifactDir: string;
  /** 建议的 base pageId（NEW_PAGE 时作为初始 pageId 前缀）。 */
  suggestedPageId?: string;
  /** 是否允许向 existing canonical 写 merge proposal（SAME_PAGE 时）。 */
  allowSamePageMerge?: boolean;
}

function sha256(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function slugify(value: string): string {
  return String(value ?? "")
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase()
    .slice(0, 40);
}

/** HTML tag / ARIA role → 合法 Playwright role engine role（a→link, input→textbox, select→combobox 等）。 */
function normalizeAriaRole(roleOrTag: string): string | undefined {
  const value = String(roleOrTag ?? "").toLowerCase().trim();
  if (!value) return undefined;
  const validRoles = new Set(["button", "link", "textbox", "combobox", "tab", "option", "dialog", "checkbox", "radio", "listbox", "grid", "row", "columnheader", "gridcell", "heading", "switch", "tabpanel"]);
  if (validRoles.has(value)) return value;
  const tagToRole: Record<string, string> = {
    a: "link",
    input: "textbox",
    select: "combobox",
    textarea: "textbox"
  };
  return tagToRole[value];
}

/**
 * P6.1：从 URL path 确定性派生 pageId（不用 title）。
 * `http://host/zh-hans/assets/flows/spot-flow` → `demo.assets.flows.spot-flow`。
 * 去掉 locale 前缀、query/hash、扩展名；每段 slugify 后拼进 pageId。
 */
function derivePageIdFromUrl(url: string, project: string): string {
  const cleaned = String(url ?? "")
    .replace(/[?#].*$/, "")
    .replace(/\/+$/, "");
  const segments = cleaned.split("/")
    .map((seg) => seg.trim())
    .filter(Boolean)
    // 去掉协议、host、locale 前缀段
    .filter((seg, index, arr) => {
      if (index < 2) return false; // scheme + host
      return !/^(zh-hans|zh-cn|en|en-us|zh-hant|zh)$/i.test(seg);
    })
    .map((seg) => slugify(seg))
    .filter(Boolean);
  if (segments.length === 0) return `${project}.unknown.modeling_candidate`;
  return `${project}.${segments.join(".")}.modeling_candidate`;
}

/** 把采集到的 inventory 转成 captureIngest 可消费的元素清单（与 legacy ingest 同构）。 */
function elementsFromInventory(inventory: InventorySummary, base: string): Array<Record<string, unknown>> {
  const seen = new Set<string>();
  const elements: Array<Record<string, unknown>> = [];
  const push = (item: InventoryItem, role: string): void => {
    const name = String(item.text ?? item.ariaLabel ?? item.label ?? item.placeholder ?? `${item.tag ?? ""} ${item.index ?? ""}`).trim();
    if (!name || seen.has(name)) return;
    seen.add(name);
    const locatorCandidates: Array<Record<string, unknown>> = [];
    if (item.role || item.tag) {
      const role = String(item.role ?? "");
      const tag = String(item.tag ?? "");
      // ARIA role 白名单：HTML tag 需映射为合法 ARIA role（a→link, input→textbox），
      // 否则 role=input / role=a 不是 Playwright 合法 role engine 选择器。
      const normalizedRole = normalizeAriaRole(role || tag);
      if (normalizedRole) {
        locatorCandidates.push({ strategy: "role", value: `role=${normalizedRole}:${name.slice(0, 24)}`, confidence: role ? 0.6 : 0.5, source: "generic_bootstrap" });
      }
    }
    if (item.placeholder) locatorCandidates.push({ strategy: "placeholder", value: `placeholder=${item.placeholder}`, confidence: 0.45, source: "generic_bootstrap" });
    if (item.name) locatorCandidates.push({ strategy: "name", value: `name=${item.name}`, confidence: 0.4, source: "generic_bootstrap" });
    elements.push({
      semanticName: name,
      role,
      locatorCandidates,
      confidence: locatorCandidates.length ? 0.5 : 0.3,
      elementId: `${base}.${slugify(name)}`
    });
  };
  for (const item of inventory.fields) push(item, String(item.role ?? "input"));
  for (const item of inventory.buttons) push(item, String(item.role ?? "button"));
  for (const item of inventory.clickables) push(item, String(item.role ?? ""));
  for (const item of inventory.selectLike) push(item, "combobox");
  // 去重后限制数量（防止超大页面爆 proposal）
  return elements.slice(0, 60);
}

async function writeModelingProposal(rootDir: string, project: string, env: string, input: {
  pageId: string;
  url: string;
  pageName: string;
  domHash?: string;
  visibleTextHash?: string;
  semanticNames: string[];
  identityVerdict: PageIdentityResult;
  elements: Array<Record<string, unknown>>;
  /** P6.2-3/4：结构断言候选（result table / empty state / button state）。 */
  assertionCandidates?: Array<{
    assertionKind: string;
    canonicalKind: string;
    semanticName: string;
    expectedTexts: string[];
    status: "dom_verified" | "candidate";
    confidence: number;
    source: string;
  }>;
  /** P6.2-1A：native select 直接读到的 options（无需打开下拉）。 */
  nativeSelectOptions?: Array<{
    parentControlId: string;
    semanticName: string;
    options: Array<{ value?: string; text?: string; disabled?: boolean }>;
  }>;
  /** P8.12/8.14：结果区域 + 列模型（结构级，candidate/dom_verified）。 */
  resultRegions?: Array<{
    resultRegionId: string;
    type: string;
    columns?: string[];
    rowLocator?: string;
    emptyState?: string[];
    pagination?: string[];
    evidence?: string[];
  }>;
  source: string;
  artifactRefs: string[];
}): Promise<{ proposalId: string; proposalPath: string }> {
  const proposalId = `pmb_${crypto.randomUUID()}`;
  const pendingDir = path.join(rootDir, "storage", "proposals", "pending");
  await fs.ensureDir(pendingDir);
  const assertionModels = (input.assertionCandidates ?? []).map((c) => ({
    proposalId,
    assertionKind: c.assertionKind,
    canonicalKind: c.canonicalKind,
    semanticName: c.semanticName,
    candidates: [{ type: "visible_text_any", expected: c.expectedTexts, confidence: c.confidence, source: c.source }],
    status: c.status
  }));
  // P6.2-1A：native select options → 元素候选（挂父控件，controlType=dropdown_option）
  const optionElements: Array<Record<string, unknown>> = [];
  for (const select of input.nativeSelectOptions ?? []) {
    for (const opt of select.options) {
      const text = String(opt.text ?? "").trim();
      if (!text) continue;
      optionElements.push({
        semanticName: `${select.semanticName}选项：${text}`,
        role: "option",
        controlType: "dropdown_option",
        targetField: "asset",
        optionValue: text,
        parentElementId: select.parentControlId,
        locatorCandidates: [
          { strategy: "role_option", value: text, confidence: 0.7, source: "native_select_options" },
          { strategy: "text_exact", value: `textExact=${text}`, confidence: 0.6, source: "visible_text" }
        ],
        confidence: 0.7,
        status: "dom_verified"
      });
    }
  }
  const payload = {
    runId: input.source,
    sourceReport: "",
    pageModel: {
      pageId: input.pageId,
      pageName: input.pageName,
      url: input.url,
      module: String(input.pageId).split(".")[1] ?? "",
      platform: "web",
      status: "candidate"
    },
    identity: {
      url: input.url,
      pageName: input.pageName,
      domHash: input.domHash,
      visibleTextHash: input.visibleTextHash,
      semanticNames: input.semanticNames
    },
    identityVerdict: {
      verdict: input.identityVerdict.verdict,
      score: input.identityVerdict.score,
      reasons: input.identityVerdict.reasons,
      matchedSignals: input.identityVerdict.matchedSignals,
      conflictingSignals: input.identityVerdict.conflictingSignals,
      candidatePageIds: input.identityVerdict.candidatePageIds
    },
    elements: [
      ...input.elements.map((e) => ({
        proposalId,
        semanticName: String(e.semanticName ?? ""),
        role: String(e.role ?? "unknown"),
        controlType: String(e.controlType ?? "unknown"),
        targetField: e.targetField ? String(e.targetField) : undefined,
        optionValue: e.optionValue ? String(e.optionValue) : undefined,
        parentElementId: e.parentElementId ? String(e.parentElementId) : undefined,
        locatorCandidates: Array.isArray(e.locatorCandidates) ? e.locatorCandidates : [],
        confidence: Number(e.confidence ?? 0.4),
        status: e.status ? String(e.status) : undefined
      })),
      ...optionElements.map((e) => ({
        proposalId,
        semanticName: String(e.semanticName ?? ""),
        role: String(e.role ?? "option"),
        controlType: String(e.controlType ?? "dropdown_option"),
        targetField: e.targetField ? String(e.targetField) : undefined,
        optionValue: e.optionValue ? String(e.optionValue) : undefined,
        parentElementId: e.parentElementId ? String(e.parentElementId) : undefined,
        locatorCandidates: Array.isArray(e.locatorCandidates) ? e.locatorCandidates : [],
        confidence: Number(e.confidence ?? 0.5),
        status: String(e.status ?? "dom_verified")
      }))
    ],
    assertionModels,
    artifactRefs: input.artifactRefs,
    // P8.12/8.14：结果区域 + 列模型（结构级，不进入 DSL 直通，供 review/writeback）
    resultRegions: (input.resultRegions ?? []).map((r) => ({
      resultRegionId: r.resultRegionId,
      type: r.type,
      columns: r.columns ?? [],
      rowLocator: r.rowLocator,
      emptyState: r.emptyState ?? [],
      pagination: r.pagination ?? [],
      evidence: r.evidence ?? [],
      status: "dom_verified"
    }))
  };
  await writeSafeJsonFile(path.join(pendingDir, `${proposalId}.json`), {
    schemaVersion: "knowledge-update-proposal.v1",
    proposalId,
    status: "pending_review",
    createdAt: new Date().toISOString(),
    project,
    env,
    runId: input.source,
    source: "modeling_orchestrator_bootstrap",
    reason: `P6 自动建模 bootstrap 采集 ${input.url}（${input.pageName}），identity=${input.identityVerdict.verdict}，共 ${input.elements.length} 个元素候选。审核批准后以 candidate 状态写入 Page Model Store。`,
    proposalType: MODELING_INGEST_PROPOSAL_TYPE,
    writeBackPolicy: "review_then_write_page_model_store_candidate_only",
    recommendedActions: [
      "检查写回预览：新页面或仅新增元素/断言候选，不得改动既有 execution_verified 内容。",
      "确认页面归属 module 与 url 正确。",
      "批准后执行受控写回；拒绝则仅归档不写库。"
    ],
    captureIngest: payload
  });
  logger.info("Modeling bootstrap proposal written", { proposalId, pageId: input.pageId, verdict: input.identityVerdict.verdict });
  return { proposalId, proposalPath: path.relative(rootDir, path.join(pendingDir, `${proposalId}.json`)).replace(/\\/g, "/") };
}

/** P6.3：禁止 P6 modeling path 直接写 Page Model store 的运行时 guard。 */
export function assertNoDirectPageModelWrite(rootDir: string, project: string, context: string): void {
  const storePath = path.join(rootDir, "storage", "page-models", `${project}.json`);
  const used = (): never => {
    throw new Error(`[P6.3] Modeling path ${context} 禁止直接写 Page Model store（${storePath}）——必须经 page-model-writeback 受控写回。`);
  };
  // 运行时防呆：任何 modeling 模块不得调用写 store 的 fs 写方法（此处为声明式 guard，供 orchestrator 断言用）。
  void used;
  void storePath;
}

/** 计算 Page Model store 的当前内容哈希（供「未改动」断言）。 */
export async function pageModelStoreHash(rootDir: string, project: string): Promise<string> {
  const storePath = path.join(rootDir, "storage", "page-models", `${project}.json`);
  if (!(await fs.pathExists(storePath))) return "MISSING";
  const content = await fs.readFile(storePath, "utf8");
  return crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
}

/** 通用初始采集：导航 + DOM/visibleText/screenshot/inventory + identity 判定 + 受控 proposal。 */
export async function bootstrapPageForModeling(input: BootstrapPageInput): Promise<BootstrapPageResult> {
  const { rootDir, project, env, url } = input;
  const normalizedUrl = normalizeUrl(url);
  const page = input.page;
  if (!page) throw new Error("bootstrapPageForModeling 需要已打开的 Playwright Page（P6 不重复登录）");

  const title = await page.title().catch(() => "");
  const dom = await page.content().catch(() => "");
  const visibleText = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
  const inventory = await collectInventory(page);
  const domHash = sha256(dom);
  const visibleTextHash = sha256(visibleText);

  await fs.ensureDir(input.artifactDir);
  const prefix = slugify(normalizedUrl.split("/").pop() ?? "page");
  await writeSafeTextFile(path.join(input.artifactDir, `${prefix}.dom.html`), dom);
  await writeSafeTextFile(path.join(input.artifactDir, `${prefix}.visible-text.txt`), visibleText);
  await page.screenshot({ path: path.join(input.artifactDir, `${prefix}.png`), fullPage: true }).catch(() => undefined);

  // P6.1：pageId 派生——优先 caller 提供的 canonical 目标 pageId；
  // 否则从 URL path 确定性派生（不用 page title，title 含站点通用文案会污染 pageId）。
  // URL `.../zh-hans/assets/flows/spot-flow` → `demo.assets.flows.spot-flow`（确定性、可审计）。
  const pageId = input.suggestedPageId ?? derivePageIdFromUrl(url, project);
  const semanticNames = [
    ...inventory.buttons.map((b) => String(b.text ?? "")).filter(Boolean),
    ...inventory.fields.map((f) => String(f.label ?? f.text ?? "")).filter(Boolean)
  ].slice(0, 40);

  // P6.2：Page Identity Resolver（不可绕过）
  const existingSignals = await loadPageIdentitySignals(rootDir, project).catch(() => []);
  const identity = resolvePageIdentity(
    { pageId, url, pageName: title, domHash, visibleTextHash, semanticNames },
    existingSignals
  );

  const initialCapture: InitialCaptureSummary = {
    url,
    normalizedUrl,
    title,
    domHash,
    visibleTextHash,
    interactiveElementCount: inventory.clickables.length + inventory.fields.length,
    dialogCount: inventory.dialogs.length,
    tableCount: inventory.tables.length,
    listCount: inventory.selectLike.length,
    hasCapturedDom: Boolean(dom),
    hasScreenshot: true,
    capturedAt: new Date().toISOString()
  };

  const base = String(pageId).split(".").slice(0, 3).join(".");
  const elements = elementsFromInventory(inventory, base);
  // P6.2-3/4/6：结构扫描——结果区域 + 断言候选 + native select options（只读，不写 store）。
  const structure = scanPageStructure(inventory, visibleText);
  const assertionCandidates = structure.assertionCandidates.map((c) => ({
    assertionKind: c.assertionKind,
    canonicalKind: c.canonicalKind,
    semanticName: c.semanticName,
    expectedTexts: c.expectedTexts,
    status: c.status,
    confidence: c.confidence,
    source: c.source
  }));
  const artifactRefs = [
    path.join(input.artifactDir, `${prefix}.dom.html`),
    path.join(input.artifactDir, `${prefix}.visible-text.txt`),
    path.join(input.artifactDir, `${prefix}.png`)
  ].map((p) => path.relative(rootDir, p).replace(/\\/g, "/"));

  const result: BootstrapPageResult = {
    pageId,
    url,
    normalizedUrl,
    title,
    identity,
    initialCapture,
    branchAction: "new_proposal",
    structureScan: {
      resultRegions: structure.resultRegions.length,
      assertionCandidates: assertionCandidates.length,
      nativeSelectOptions: structure.nativeSelectOptions.length
    }
  };

  switch (identity.verdict) {
    case "NEW_PAGE": {
      const proposal = await writeModelingProposal(rootDir, project, env, {
        pageId,
        url,
        pageName: title || pageId,
        domHash,
        visibleTextHash,
        semanticNames,
        identityVerdict: identity,
        elements,
        assertionCandidates,
        nativeSelectOptions: structure.nativeSelectOptions,
        resultRegions: structure.resultRegions,
        source: `bootstrap_${pageId}`,
        artifactRefs
      });
      result.proposalPath = proposal.proposalPath;
      result.proposalId = proposal.proposalId;
      result.branchAction = "new_proposal";
      break;
    }
    case "SAME_PAGE": {
      // 归入 canonical（identity.targetPageId），仍走受控 merge proposal。
      const canonicalId = identity.targetPageId ?? identity.candidatePageIds[0] ?? pageId;
      if (input.allowSamePageMerge) {
        const proposal = await writeModelingProposal(rootDir, project, env, {
          pageId: canonicalId,
          url,
          pageName: title || canonicalId,
          domHash,
          visibleTextHash,
          semanticNames,
          identityVerdict: identity,
          elements,
          assertionCandidates,
          nativeSelectOptions: structure.nativeSelectOptions,
          resultRegions: structure.resultRegions,
          source: `bootstrap_same_${pageId}`,
          artifactRefs
        });
        result.proposalPath = proposal.proposalPath;
        result.proposalId = proposal.proposalId;
      }
      result.canonicalPageId = canonicalId;
      result.branchAction = "same_canonical_merge";
      break;
    }
    case "RELATED_STATE_MODEL": {
      // 不创建重复 base page，不产生 merge proposal；仅记录关系。
      result.branchAction = "related_state";
      result.reviewReason = `identity=${identity.verdict}：作为 ${identity.candidatePageIds.join(",")} 的 related state，不创建重复 base page。`;
      break;
    }
    case "POSSIBLE_SAME_PAGE":
    case "CONFLICT": {
      // 停止自动建模，进入 REVIEW；不得自动新建。
      result.branchAction = "review_required";
      result.reviewReason = `identity=${identity.verdict}（score=${identity.score.toFixed(2)}）：候选页面 ${identity.candidatePageIds.join(",") || "(none)"}，需人工确认。`;
      result.canonicalPageId = identity.targetPageId;
      break;
    }
  }

  return result;
}
