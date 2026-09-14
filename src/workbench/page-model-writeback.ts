import fs from "fs-extra";
import path from "node:path";
import { writeSafeJsonFile } from "../core/safe-file-writer.js";
import { logger } from "../core/logger.js";
import type { CaptureIngestPayload } from "./capture-proposal-ingest.js";
import { toResultRegionModel, isResultRegionAlreadyModeled, type ResultRegionModel } from "../core/modeling-result-region.js";
import { generateResultAssertions } from "../core/modeling-coverage-analysis.js";
import { parseMarketQuote } from "../core/market-quote-parser.js";

/**
 * Page Model Store 受控写回（M1 写回通道的出口）。
 *
 * 硬边界：
 * 1. 状态上限 candidate（对齐 store 自身 writePolicy.aiCanWrite）；
 *    execution_verified 只能由受控执行升级，本通道永不写。
 * 2. 只追加：新页面整页追加；既有页面只追加新元素/断言候选，
 *    永不修改、降级或删除既有条目。
 * 3. 写入走 safe-file-writer，并维护 indexes.byPageId 与顶层 ingest 日志。
 * 4. Market Element Identity Dedup Guard：写新元素前先做稳定语义身份匹配
 *    （normalized semanticName + controlType + 定位器语义；价格数字不入 identity），
 *    命中既有元素则复用 existing elementId，不再产生跨 bootstrap 的 semantic duplicate。
 */

const INGEST_STATUS_CAP = "candidate";
const MAX_ELEMENTS_PER_PAGE = 40;
const MAX_ASSERTIONS_PER_PAGE = 8;

export interface PageModelWriteBackElementDiff {
  elementId: string;
  semanticName: string;
  controlType: string;
  locatorCandidates: Array<Record<string, unknown>>;
  confidence: number;
  /** P6.2-1/2：dropdown option 元数据。 */
  targetField?: string;
  optionValue?: string;
  parentElementId?: string;
  /** P6.2-5：结构观察状态上限（dom_verified）或默认 candidate。 */
  status?: "dom_verified" | "candidate";
  /** P6.2-2：OPTION_EXISTS / OPTION_SELECTABLE 分层（不写 EFFECT）。 */
  optionTier?: "OPTION_EXISTS" | "OPTION_SELECTABLE";
  /** P16.6：行情元素动态值表示。仅 captured_inventory + ticker/name + 价格/涨跌幅 全部可识别时写入；
   *  semanticName 同时稳定到 ticker/name（价格/涨跌幅不入 semantic identity）。 */
  dynamicValue?: { price: string; changePercent: string };
}

export interface PageModelWriteBackAssertionDiff {
  assertionId: string;
  semanticName: string;
  assertionType: string;
  expectedTexts: string[];
  confidence: number;
  /** P6.2-3/4：canonical UserAssertionKind（复用现有 taxonomy）。 */
  canonicalKind?: string;
  /** P6.2-5：结构观察状态上限（dom_verified）或默认 candidate。 */
  status?: "dom_verified" | "candidate";
}

export interface PageModelWriteBackDiff {
  schemaVersion: "page-model-write-back-diff.v1";
  proposalId: string;
  project: string;
  pageId: string;
  pageName: string;
  /** P1.1 身份重定向：SAME_PAGE 时写回的 canonical 目标（incoming pageId 的证据并入此模型）。 */
  identityRemap?: {
    incomingPageId: string;
    resolvedTargetPageId: string;
    evidence: string;
    score: number;
  };
  action: "add_page" | "merge_page" | "no_op";
  newPage: boolean;
  statusCap: string;
  newElements: PageModelWriteBackElementDiff[];
  newAssertions: PageModelWriteBackAssertionDiff[];
  skippedElements: number;
  skippedAssertions: number;
  /** Market Element Identity Dedup Guard：语义匹配命中并复用 existing elementId 的元素数（未产生新副本）。 */
  matchedExistingElements: number;
  protections: string[];
}

export interface PageModelWriteBackResult {
  schemaVersion: "page-model-write-back-result.v1";
  proposalId: string;
  storePath: string;
  applied: boolean;
  action: "add_page" | "merge_page" | "no_op";
  addedElements: number;
  addedAssertions: number;
  wroteExecutionVerified: false;
  modifiedExistingEntries: false;
  ingestedAt: string;
  reviewedBy: string;
}

function pageModelStorePath(rootDir: string, project: string): string {
  if (!/^[a-z0-9_-]+$/i.test(project)) throw new Error(`Invalid project key: ${project}`);
  return path.join(rootDir, "storage", "page-models", `${project}.json`);
}

function pageIdBase(pageId: string): string {
  return pageId.includes(".") ? pageId.split(".").slice(1).join(".") : pageId;
}

function slugify(value: string): string {
  const cleaned = value.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned || "item";
}

function readCaptureIngestPayload(proposal: Record<string, unknown>): CaptureIngestPayload {
  const payload = proposal.captureIngest;
  if (!payload || typeof payload !== "object") {
    throw new Error("Proposal is missing captureIngest payload.");
  }
  return payload as CaptureIngestPayload;
}

function controlTypeForRole(role: string): string {
  const normalized = role.toLowerCase();
  if (/button|link|a$/.test(normalized)) return "button";
  // P6.1：combobox 是下拉/选择控件，不是 input——映射错会导致 select heuristic 不匹配、
  // DSL 无法物化筛选步骤、option 永远探索不出来。
  if (/combobox|select|dropdown/.test(normalized)) return "select";
  if (/input|field|textarea/.test(normalized)) return "input";
  if (/table|list/.test(normalized)) return "table";
  return "unknown";
}

/**
 * Market Element Identity Dedup Guard —— 稳定语义身份归一化。
 *
 * 行情类动态文本（价格/涨跌幅数字）不进入 semantic identity：
 *   "BTC比特币79,588.00-1.40%" 与 "BTC比特币80,123.00+0.50%"
 *   → 同一身份 "btc比特币"（ticker + 业务文本），价格变化不产生新 identity。
 * 业务性数字 token 一律保留："步骤 1"/"步骤 2"、"等级 1"/"等级 2"、
 * "30 天"/"90 天"、"24h 涨幅榜" —— 这些数字是语义的一部分，剥离会造成错误合并。
 */
function normalizeSemanticIdentity(value: string): string {
  return String(value ?? "")
    .toLowerCase()
    // 行情价格簇（数字序列含 , . % +/- 分隔符）：79,588.00 / -1.40% / 2,450.33 / +3.21
    // 无分隔符的纯数字词（24h / 30 / 步骤 1 中的数字）不是价格形态，保留。
    // 观测到的行情动态值均带分隔符，由本规则覆盖；裸整数（如 "BTC 80000"）宁可
    // 保留为独立身份（安全方向：最多多建元素，绝不错误合并业务数字）。
    .replace(/[+\-]?\d[\d.,]*%?/g, (m) => /[.,%]/.test(m) ? " " : m)
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .trim();
}

/** 定位器语义签名：策略 + 归一化值（价格剥离），用于同一身份校验。 */
function locatorIdentitySignature(candidates: unknown[] | undefined): string {
  return (candidates ?? [])
    .map((c) => {
      const item = c as Record<string, unknown>;
      return `${String(item.strategy ?? "")}:${normalizeSemanticIdentity(String(item.value ?? ""))}`;
    })
    .filter(Boolean)
    .sort()
    .join("|");
}

/** 参与身份判定的最小元素形态（CaptureIngestElement 与既有模型元素均满足）。 */
interface IdentityCandidateElement {
  semanticName?: unknown;
  controlType?: unknown;
  role?: unknown;
  locatorCandidates?: unknown;
}

/** 元素实际生效的 controlType（与写回落库口径一致：unknown 视为缺失，由 role 推断）。 */
function controlTypeOf(element: IdentityCandidateElement): string {
  const controlType = element.controlType;
  return controlType && String(controlType) !== "unknown"
    ? String(controlType)
    : controlTypeForRole(String(element.role ?? ""));
}

interface SemanticElementRef {
  elementId: string;
  controlType: string;
  locatorCandidates: Array<Record<string, unknown>>;
}

type SemanticIdentityVerdict = "EXISTING_MATCH" | "NEW_ELEMENT" | "SEMANTIC_IDENTITY_UNRESOLVED";

interface SemanticElementResolution {
  verdict: SemanticIdentityVerdict;
  /** EXISTING_MATCH：复用的既有 elementId；NEW/UNRESOLVED：新元素 elementId 的稳定基座（不含计数器）。 */
  identityBase: string;
}

/**
 * 稳定语义身份匹配：
 * - 命中既有元素（normalized semanticName + controlType 兼容 + 定位器语义不冲突）
 *   → EXISTING_MATCH：复用 existing elementId，不产生新 duplicate。
 * - 无法可靠确认 SAME_ELEMENT（identity 为空 / controlType 冲突 / 定位器语义冲突）
 *   → SEMANTIC_IDENTITY_UNRESOLVED：宁可按新元素处理，不错误合并。
 * - 否则 NEW_ELEMENT：以归一化语义生成稳定 elementId 基座（价格数字不入 ID）。
 */
function resolveSemanticElementIdentity(
  element: IdentityCandidateElement,
  base: string,
  existingByIdentity: Map<string, SemanticElementRef[]>,
  acceptedByIdentity: Map<string, SemanticElementRef[]>
): SemanticElementResolution {
  const controlType = controlTypeOf(element);
  const identityKey = normalizeSemanticIdentity(String(element.semanticName ?? ""));
  const newElementBase = `${base}.capture.${slugify(identityKey || String(element.semanticName ?? "item"))}`;
  if (!identityKey) {
    return { verdict: "SEMANTIC_IDENTITY_UNRESOLVED", identityBase: newElementBase };
  }
  const incomingLocatorSignature = locatorIdentitySignature(Array.isArray(element.locatorCandidates) ? element.locatorCandidates : []);
  const findMatch = (refs: SemanticElementRef[] | undefined): SemanticElementRef | undefined => {
    for (const ref of refs ?? []) {
      // controlType：必须兼容（相等，或任一侧 unknown 视为未判定）。
      const controlCompatible = ref.controlType === controlType || ref.controlType === "unknown" || controlType === "unknown";
      if (!controlCompatible) continue;
      // 定位器语义：双方都有签名且不一致时，不认为是同一元素（保守，宁可不合并）。
      const existingSignature = locatorIdentitySignature(ref.locatorCandidates);
      if (incomingLocatorSignature && existingSignature && incomingLocatorSignature !== existingSignature) continue;
      return ref;
    }
    return undefined;
  };
  const existingHit = findMatch(existingByIdentity.get(identityKey));
  if (existingHit) return { verdict: "EXISTING_MATCH", identityBase: existingHit.elementId };
  // 本批次内已接受过同一 identity（如同一批里紧凑/空格两种文本形态的行情行）→ 同样复用，不再重复。
  const acceptedHit = findMatch(acceptedByIdentity.get(identityKey));
  if (acceptedHit) return { verdict: "EXISTING_MATCH", identityBase: acceptedHit.elementId };
  return { verdict: "NEW_ELEMENT", identityBase: newElementBase };
}

/**
 * P1.1 canonical 写回目标解析：
 * proposal 携带 P1 resolver 判定 SAME_PAGE 且 targetPageId 是已有模型时，
 * incoming 证据必须并入 canonical 模型，不得按 incoming pageId 新建页面。
 * 仅 SAME_PAGE 可自动重定向；POSSIBLE/CONFLICT/RELATED 状态下不重定向。
 */
function resolveCanonicalWriteBackTarget(
  payload: CaptureIngestPayload,
  models: Array<Record<string, unknown>>
): { pageId: string; remap?: PageModelWriteBackDiff["identityRemap"] } {
  const incomingPageId = String(payload.pageModel?.pageId ?? "");
  const verdict = payload.identityVerdict;
  const targetPageId = verdict?.verdict === "SAME_PAGE"
    ? String(verdict.candidatePageIds?.[0] ?? "")
    : "";
  // 仅当 target 真实存在于 store 时才重定向（防 resolver 幻觉目标）。
  const targetExists = Boolean(targetPageId) && models.some((model) => String(model.pageId ?? "") === targetPageId);
  if (verdict?.verdict === "SAME_PAGE" && targetPageId && targetPageId !== incomingPageId && targetExists) {
    return {
      pageId: targetPageId,
      remap: {
        incomingPageId,
        resolvedTargetPageId: targetPageId,
        evidence: verdict.score >= 0.75
          ? `url_semantic_composite (score=${verdict.score})`
          : String(verdict.reasons[0] ?? "identity match"),
        score: verdict.score
      }
    };
  }
  return { pageId: incomingPageId };
}

export async function buildPageModelWriteBackDiff(rootDir: string, project: string, proposal: Record<string, unknown>): Promise<PageModelWriteBackDiff> {
  const payload = readCaptureIngestPayload(proposal);
  const storePath = pageModelStorePath(rootDir, project);
  const store = (await fs.pathExists(storePath))
    ? await fs.readJson(storePath) as Record<string, unknown>
    : { schemaVersion: "page-model-store.v1", project, models: [] };
  const models = Array.isArray(store.models) ? store.models as Array<Record<string, unknown>> : [];
  const pageModel = payload.pageModel;
  // P1.1：SAME_PAGE 时写回 canonical 目标（incoming pageId 的证据并入已有模型）。
  const canonical = resolveCanonicalWriteBackTarget(payload, models);
  const pageId = canonical.pageId;
  const existing = models.find((model) => String(model.pageId ?? "") === pageId);
  const existingElements = existing && Array.isArray(existing.elements) ? existing.elements as Array<Record<string, unknown>> : [];
  const existingElementIds = new Set(existingElements.map((item) => String(item.elementId ?? "")));
  const existingAssertionIds = new Set(existing ? (Array.isArray(existing.assertions) ? (existing.assertions as Array<Record<string, unknown>>).map((item) => String(item.assertionId ?? "")) : []) : []);
  const base = pageIdBase(pageId);

  // Market Element Identity Dedup Guard：为既有元素建立稳定语义身份索引
  // （normalized semanticName → refs），用于跨 bootstrap 复用 elementId。
  const existingByIdentity = new Map<string, SemanticElementRef[]>();
  for (const item of existingElements) {
    const identityKey = normalizeSemanticIdentity(String(item.semanticName ?? ""));
    if (!identityKey) continue;
    const ref: SemanticElementRef = {
      elementId: String(item.elementId ?? ""),
      controlType: controlTypeOf(item),
      locatorCandidates: Array.isArray(item.locatorCandidates) ? item.locatorCandidates as Array<Record<string, unknown>> : []
    };
    const bucket = existingByIdentity.get(identityKey);
    if (bucket) bucket.push(ref);
    else existingByIdentity.set(identityKey, [ref]);
  }

  const newElements: PageModelWriteBackElementDiff[] = [];
  let skippedElements = 0;
  let matchedExistingElements = 0;
  // 本 diff 批次内已接受的 identity（防止同一批次内重复元素再次落库）。
  const acceptedByIdentity = new Map<string, SemanticElementRef[]>();
  // 本批次内已占用的 elementId（两个不同 identity 可能共享同一 slug 基座，计数器必须避开）。
  const acceptedElementIds = new Set<string>();
  for (const element of payload.elements.slice(0, MAX_ELEMENTS_PER_PAGE)) {
    const seq = newElements.length + 1;
    const resolution = resolveSemanticElementIdentity(element, base, existingByIdentity, acceptedByIdentity);
    if (resolution.verdict === "EXISTING_MATCH") {
      // 复用 existing elementId：不产生新副本，不改写既有元素（verificationHistory/evidence 原样保留）。
      matchedExistingElements += 1;
      skippedElements += 1;
      continue;
    }
    // NEW_ELEMENT / SEMANTIC_IDENTITY_UNRESOLVED：生成稳定 elementId（归一化语义 slug + 计数器）。
    // 计数器仅用于同基座消歧；若与既有/本批 ID 碰撞则递增，绝不静默跳过新元素。
    let elementId = `${resolution.identityBase}_${seq}`;
    let nextSeq = seq;
    while (existingElementIds.has(elementId) || acceptedElementIds.has(elementId)) {
      nextSeq += 1;
      elementId = `${resolution.identityBase}_${nextSeq}`;
    }
    acceptedElementIds.add(elementId);
    // P16.6：行情元素（captured_inventory + ticker/name + 动态报价）落库表示拆分——
    // semanticName 稳定到 ticker/name，价格/涨跌幅进 dynamicValue；
    // 业务数字（最低 0.01 BTC / 费率 0.1% / 收益率 3.5% / 30 天 / 步骤 1）不满足 opt-in gate，保持原文。
    const quote = parseMarketQuote(String(element.semanticName ?? ""));
    newElements.push({
      elementId,
      semanticName: quote ? quote.stableName : element.semanticName || `采集元素 ${newElements.length + 1}`,
      dynamicValue: quote ? { price: quote.price, changePercent: quote.changePercent } : undefined,
      // P6.2-1/2：option 元素自带 dropdown_option；combobox 等由 role 推断为 select。
      // 注意 proposal 里 controlType 可能被序列化为 "unknown"（truthy）——必须视为缺失，
      // 否则会覆盖 controlTypeForRole 的正确推断（combobox→select）。
      controlType: element.controlType && String(element.controlType) !== "unknown"
        ? String(element.controlType)
        : controlTypeForRole(element.role),
      locatorCandidates: element.locatorCandidates,
      confidence: element.confidence,
      targetField: element.targetField ? String(element.targetField) : undefined,
      optionValue: element.optionValue ? String(element.optionValue) : undefined,
      parentElementId: element.parentElementId ? String(element.parentElementId) : undefined,
      status: element.status === "dom_verified" ? "dom_verified" : element.status === "candidate" ? "candidate" : undefined,
      optionTier: element.optionTier === "OPTION_EXISTS" ? "OPTION_EXISTS" : element.optionTier === "OPTION_SELECTABLE" ? "OPTION_SELECTABLE" : undefined
    });
    const acceptedKey = normalizeSemanticIdentity(String(element.semanticName ?? ""));
    if (acceptedKey) {
      const ref: SemanticElementRef = {
        elementId,
        controlType: controlTypeOf(element),
        locatorCandidates: Array.isArray(element.locatorCandidates) ? element.locatorCandidates as Array<Record<string, unknown>> : []
      };
      const bucket = acceptedByIdentity.get(acceptedKey);
      if (bucket) bucket.push(ref);
      else acceptedByIdentity.set(acceptedKey, [ref]);
    }
  }
  skippedElements += Math.max(0, payload.elements.length - MAX_ELEMENTS_PER_PAGE);

  const newAssertions: PageModelWriteBackAssertionDiff[] = [];
  let skippedAssertions = 0;
  for (const assertionModel of payload.assertionModels) {
    const expectedTexts = assertionModel.candidates
      .flatMap((candidate) => Array.isArray(candidate.expected) ? candidate.expected.map(String) : [])
      .filter(Boolean);
    if (!expectedTexts.length) {
      skippedAssertions += 1;
      continue;
    }
    const assertionId = `${base}.capture_assertion.${slugify(assertionModel.assertionKind)}`;
    if (existingAssertionIds.has(assertionId)) {
      skippedAssertions += 1;
      continue;
    }
    if (newAssertions.length >= MAX_ASSERTIONS_PER_PAGE) {
      skippedAssertions += 1;
      continue;
    }
    newAssertions.push({
      assertionId,
      // P6.2-3/4：断言语义名带 canonical kind 标识，供 DSL 消费（record_or_empty_state 等）。
      semanticName: String(assertionModel.semanticName ?? `${String(pageModel.pageName ?? pageId)} ${assertionModel.assertionKind === "success_or_page_state" ? "成功态" : "阻断态"}可见文本候选`),
      assertionType: "visible_text_any",
      expectedTexts,
      confidence: Number(assertionModel.confidence ?? 0.45),
      canonicalKind: assertionModel.canonicalKind ? String(assertionModel.canonicalKind) : undefined,
      status: assertionModel.status === "dom_verified" ? "dom_verified" : undefined
    });
  }

  return {
    schemaVersion: "page-model-write-back-diff.v1",
    proposalId: String(proposal.proposalId ?? ""),
    project,
    pageId,
    pageName: String(pageModel.pageName ?? ""),
    identityRemap: canonical.remap,
    action: !existing ? "add_page" : newElements.length || newAssertions.length ? "merge_page" : "no_op",
    newPage: !existing,
    statusCap: INGEST_STATUS_CAP,
    newElements,
    newAssertions,
    skippedElements,
    skippedAssertions,
    matchedExistingElements,
    protections: [
      "本通道写入状态上限为 candidate；execution_verified 只能由受控执行升级。",
      "既有页面只追加新元素/断言候选，不修改、不降级、不删除既有条目。",
      "写回走 safe-file-writer 并维护 indexes.byPageId。",
      "Market Element Identity Dedup Guard：稳定语义身份命中时复用 existing elementId（不新增副本）；无法确认 SAME_ELEMENT 时按新元素处理，不错误合并。"
    ]
  };
}

export async function applyPageModelWriteBack(rootDir: string, project: string, proposal: Record<string, unknown>, input: {
  reviewedBy: string;
  note?: string;
  /**
   * P6.2-5：写回状态上限。
   *   - 默认 "candidate"（legacy capture 审核路径，行为不变）；
   *   - P6 orchestrator 结构观察路径可传 "dom_verified"（DOM 明确观察到 table/empty/button-state 等客观结构，
   *     满足 DSL MATERIALIZABLE 门槛）；
   *   - 永不接受 "execution_verified" / "execution_observed"（只能由真实受控执行升级）。
   */
  statusCap?: "candidate" | "dom_verified";
}): Promise<PageModelWriteBackResult> {
  const payload = readCaptureIngestPayload(proposal);
  const diff = await buildPageModelWriteBackDiff(rootDir, project, proposal);
  const statusCap = input.statusCap ?? INGEST_STATUS_CAP;
  // P6.2-5 铁律：写回通道永不允许直接写 execution_verified / execution_observed——
  // 类型层已限制 statusCap ∈ {candidate, dom_verified}，此处为运行时兜底（防未来扩展误用）。
  if ((statusCap as string) === "execution_verified" || (statusCap as string) === "execution_observed") {
    throw new Error(`[P6.2-5] 写回状态上限不允许 ${statusCap}——execution 级只能由受控执行升级。`);
  }
  const storePath = pageModelStorePath(rootDir, project);
  const store = (await fs.pathExists(storePath))
    ? await fs.readJson(storePath) as Record<string, unknown>
    : { schemaVersion: "page-model-store.v1", project, models: [], indexes: { byPageId: {} }, writePolicy: {} };
  const models = Array.isArray(store.models) ? store.models as Array<Record<string, unknown>> : [];
  const byPageId = (store.indexes && typeof (store.indexes as Record<string, unknown>).byPageId === "object"
    ? (store.indexes as { byPageId: Record<string, number> }).byPageId
    : {}) as Record<string, number>;
  const ingestedAt = new Date().toISOString();
  const pageModel = payload.pageModel;
  const pageId = diff.pageId;

  let existing = models.find((model) => String(model.pageId ?? "") === pageId);
  if (!existing) {
    existing = {
      schemaVersion: "page-model.v1",
      pageId,
      pageName: String(pageModel.pageName ?? pageId),
      project,
      platform: String(pageModel.platform ?? "web"),
      locale: String(pageModel.locale ?? "zh-hans"),
      module: String(pageModel.module ?? "unknown"),
      action: String(pageModel.action ?? "open"),
      url: String(pageModel.url ?? ""),
      title: String(pageModel.title ?? ""),
      pageType: String(pageModel.pageType ?? "page"),
      status: INGEST_STATUS_CAP,
      confidence: Number(pageModel.confidence ?? 0.4),
      sourceCaptureRun: payload.runId,
      sourceProposal: String(proposal.proposalId ?? ""),
      sourceArtifacts: pageModel.sourceArtifacts ?? {},
      expectedCapability: String(pageModel.expectedCapability ?? ""),
      regions: pageModel.regions ?? [],
      elements: [],
      assertions: [],
      dialogs: pageModel.dialogs ?? [],
      iframes: pageModel.iframes ?? [],
      ingestedBy: "capture_review_writeback",
      ingestedAt
    };
    models.push(existing);
    byPageId[pageId] = models.length - 1;
  }

  const elements = (Array.isArray(existing.elements) ? existing.elements : []) as Array<Record<string, unknown>>;
  for (const element of diff.newElements) {
    elements.push({
      elementId: element.elementId,
      semanticName: element.semanticName,
      controlType: element.controlType,
      semanticRole: element.controlType === "dropdown_option" ? "filter_option" : "captured_inventory",
      // P6.2-5：元素级状态（bootstrap option=dom_verified）优先；无则用 statusCap。
      status: element.status ?? statusCap,
      confidence: element.confidence,
      locatorCandidates: element.locatorCandidates,
      ...(element.targetField ? { targetField: element.targetField } : {}),
      ...(element.optionValue ? { optionValue: element.optionValue } : {}),
      ...(element.parentElementId ? { parentElementId: element.parentElementId } : {}),
      ...(element.optionTier ? { optionTier: element.optionTier } : {}),
      ...(element.dynamicValue ? { dynamicValue: element.dynamicValue } : {}),
      sourceCaptureRun: payload.runId,
      ingestedAt
    });
  }
  existing.elements = elements;

  const assertions = (Array.isArray(existing.assertions) ? existing.assertions : []) as Array<Record<string, unknown>>;
  for (const assertion of diff.newAssertions) {
    assertions.push({
      assertionId: assertion.assertionId,
      semanticName: assertion.semanticName,
      assertionType: assertion.assertionType,
      // P6.2-5：断言级状态（bootstrap 结构扫描=dom_verified）优先；无则用 statusCap。
      status: assertion.status ?? statusCap,
      confidence: assertion.confidence,
      expectedTexts: assertion.expectedTexts,
      ...(assertion.canonicalKind ? { canonicalKind: assertion.canonicalKind } : {}),
      sourceCaptureRun: payload.runId,
      ingestedAt
    });
  }
  existing.assertions = assertions;

  // P8.12-15/17：ResultRegion 正式进入 Page Model（受控写回，幂等 + 状态上限）。
  // 只读结构建模，不推断业务正确性；列模型 + 结果断言候选由 region 派生。
  const existingRegions = (Array.isArray(existing.resultRegions) ? existing.resultRegions : []) as ResultRegionModel[];
  const newRegionCount = { added: 0, skipped: 0 };
  for (const regionInput of payload.resultRegions ?? []) {
    const region = toResultRegionModel(regionInput);
    if (isResultRegionAlreadyModeled(pageId, region, existingRegions)) {
      newRegionCount.skipped += 1;
      continue;
    }
    existingRegions.push({ ...region, verificationHistory: [{
      promotedAt: ingestedAt,
      policyId: "result-region.v1",
      knowledgeType: "STRUCTURE",
      action: "result_region_materialization",
      sourceCaptureRun: payload.runId
    }] });
    newRegionCount.added += 1;
    // P8.17：ResultRegion 派生有限断言候选（RESULT_REGION_EXISTS / EMPTY_STATE_VISIBLE / COLUMN_EXISTS）
    for (const candidate of generateResultAssertions(region)) {
      const resultAssertionId = `${pageIdBase(pageId)}.capture_assertion.${slugify(candidate.canonicalKind)}_region_${slugify(region.resultRegionId)}`;
      if (assertions.some((a) => String(a.assertionId ?? "") === resultAssertionId)) continue;
      assertions.push({
        assertionId: resultAssertionId,
        semanticName: candidate.semanticName,
        assertionType: "visible_text_any",
        status: "dom_verified",
        confidence: candidate.confidence,
        expectedTexts: candidate.expectedTexts,
        canonicalKind: candidate.canonicalKind,
        sourceCaptureRun: payload.runId,
        ingestedAt
      });
    }
  }
  if (newRegionCount.added) {
    existing.resultRegions = existingRegions;
  }
  existing.updatedAt = ingestedAt;

  const ingestLog = Array.isArray(store.captureIngests) ? store.captureIngests as Array<Record<string, unknown>> : [];
  ingestLog.push({
    runId: payload.runId,
    proposalId: String(proposal.proposalId ?? ""),
    pageId,
    action: diff.action,
    reviewedBy: input.reviewedBy,
    note: input.note ?? "",
    addedElements: diff.newElements.length,
    addedAssertions: diff.newAssertions.length,
    ingestedAt,
    // P1.1 审计：SAME_PAGE 重定向必须可追踪（incoming pageId → canonical 目标）。
    ...(diff.identityRemap ? { identityRemap: diff.identityRemap } : {})
  });
  if (diff.identityRemap) {
    logger.info("Page identity canonical remap applied", {
      incomingPageId: diff.identityRemap.incomingPageId,
      resolvedTargetPageId: diff.identityRemap.resolvedTargetPageId,
      evidence: diff.identityRemap.evidence,
      proposalId: String(proposal.proposalId ?? "")
    });
  }
  store.captureIngests = ingestLog;
  store.models = models;
  store.indexes = { ...(store.indexes as object | undefined), byPageId };
  store.updatedAt = ingestedAt;
  await writeSafeJsonFile(storePath, store);
  logger.info("Page model write-back applied", { project, pageId, action: diff.action, addedElements: diff.newElements.length, addedAssertions: diff.newAssertions.length });

  return {
    schemaVersion: "page-model-write-back-result.v1",
    proposalId: String(proposal.proposalId ?? ""),
    storePath: path.relative(rootDir, storePath).replace(/\\/g, "/"),
    applied: true,
    action: diff.action,
    addedElements: diff.newElements.length,
    addedAssertions: diff.newAssertions.length,
    wroteExecutionVerified: false,
    modifiedExistingEntries: false,
    ingestedAt,
    reviewedBy: input.reviewedBy
  };
}
