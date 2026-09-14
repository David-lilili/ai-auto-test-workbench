import fs from "fs-extra";
import path from "node:path";
import crypto from "node:crypto";
import { collectAllKnowledgeEvidence, type CollectedEvidence } from "./knowledge-evidence-collector.js";
import { aggregateEvidence, decidePromotion, PROMOTION_POLICIES, type KnowledgeCandidate, type PromotionDecision } from "./knowledge-promotion-policy.js";
import { promoteLocatorCandidate, type LocatorPromotionInput } from "./locator-promotion.js";
import { writeSafeJsonFile } from "./safe-file-writer.js";
import { logger } from "./logger.js";
import { isSameDynamicLocatorIdentity, hasExplicitDynamicContext, type IdentityNormalizeOptions } from "./locator-identity-normalizer.js";
import { resolveTargetIds, resolveTargetIdsSafe, pageModelsOf, type InvalidAliasBlockedEvidence } from "./element-alias-wiring.js";
import type { PageModelWithAliases } from "./page-model-types.js";

/**
 * Unified Writeback Dispatcher（P5.4-P5.6）：
 * 把 AUTO_PROMOTE 候选按知识类型分发给对应安全写回器，硬性 caps：
 *   - LOCATOR       ≤ 5（用户限制）
 *   - CONTROL_TYPE  ≤ 10（用户限制）
 *   - INTERACTION   ≤ 10
 *
 * LOCATOR 特例——修复型配对：
 *   knowledgeKey 含 observedValue（locator 字符串），因此"原 locator 失败"与"新 locator 成功"
 *   天然不会聚合进同一 candidate。而 SELF_HEALING 单条证据里同时携带 oldLocator（原 locator）
 *   + fallbackLevel>0（证明原 locator 失败）+ observedValue（新 locator 成功），
 *   所以在 semantic-target 粒度做确定性配对：同一 target 成功 ≥ policy.minEvidenceCount(2)
 *   且新 locator 唯一（无矛盾）→ AUTO_PROMOTE；否则 REVIEW。证据全部来自真实执行，无 AI。
 */

export interface WritebackCaps {
  locator?: number;
  controlType?: number;
  interaction?: number;
}

export interface WritebackDispatchOptions {
  rootDir: string;
  project: string;
  caps?: WritebackCaps;
  /** true 时只生成 plan 不落盘。 */
  dryRun?: boolean;
}

export type WritebackActionType = "append_locator_candidate" | "fill_control_type" | "record_interaction" | "skipped_cap" | "skipped_unmatched" | "error" | "noop";

export interface WritebackAction {
  knowledgeType: string;
  pageId: string;
  elementId: string;
  targetId: string;
  observedValue: string;
  decision: PromotionDecision["decision"];
  action: WritebackActionType;
  reason: string;
  detail?: Record<string, unknown>;
}

export interface WritebackDispatchResult {
  project: string;
  dryRun: boolean;
  collected: CollectedEvidence["sourceCounts"];
  uniqueCandidates: number;
  decisions: Record<string, number>;
  locatorTargets: Array<{ targetId: string; successCount: number; newLocator: string; decision: string; reason: string }>;
  planned: WritebackAction[];
  applied: WritebackAction[];
  capped: { locator: number; controlType: number; interaction: number };
  /** P16.7 Phase 2 fail-closed 审计：invalid alias 证据未产生任何 promotion / writeback（按 evidenceId 去重）。 */
  invalidAliasBlocked: InvalidAliasBlockedEvidence[];
}

export function resolveCaps(caps: WritebackCaps = {}): Required<WritebackCaps> {
  return {
    locator: caps.locator ?? 5,
    controlType: caps.controlType ?? 10,
    interaction: caps.interaction ?? 10
  };
}

interface LocatorTarget {
  pageId: string;
  targetId: string;
  /** 新 locator（成功值）。 */
  newLocator: string;
  successCount: number;
  evidenceIds: string[];
  sourceRunIds: string[];
  /** 聚合入本 target 的原始 evidence targetId 集合（alias 聚合后仍可追溯 source）。 */
  sourceTargetIds: string[];
  /** 是否全部证据都带 oldLocator（证明原 locator 失败）。 */
  fixType: boolean;
  confidence: "HIGH" | "MEDIUM" | "LOW";
}

/** 从 evidence sink 的 SELF_HEALING LOCATOR 证据按 semantic target 聚合（修复型配对）。 */
export function buildLocatorTargets(
  evidenceList: Awaited<ReturnType<typeof collectAllKnowledgeEvidence>>["evidenceList"],
  pageModels?: Map<string, PageModelWithAliases>,
  /**
   * fail-closed 诊断收集（P16.7 Phase 2）：invalid alias LOCATOR 证据被拒入时追加审计条目；
   * 不传则不收集（聚合行为不变）。
   */
  invalidAliasBlocked?: InvalidAliasBlockedEvidence[]
): LocatorTarget[] {
  const byTarget = new Map<string, { pageId: string; locators: Map<string, { count: number; evidenceIds: string[]; runIds: string[]; fixType: boolean; sourceTargetIds: string[] }> }>();
  for (const evidence of evidenceList) {
    if (evidence.knowledgeType !== "LOCATOR") continue;
    if (evidence.sourceType !== "SELF_HEALING") continue;
    if (evidence.outcome !== "success") continue;
    // alias-aware 聚合：按 canonical targetId 归组，old id 证据与 canonical 证据合并计数。
    // P16.7 Phase 2 fail-closed：invalid alias 证据不得形成可写 old source element 的
    // locator target（旧行为会以 sourceTargetId 伪 canonical 归组，导致 promotion 到旧元素）。
    const resolved = resolveTargetIdsSafe(pageModels?.get(evidence.pageId), evidence.targetId);
    if (!resolved.resolved) {
      invalidAliasBlocked?.push({
        evidenceId: evidence.evidenceId,
        knowledgeType: "LOCATOR",
        pageId: evidence.pageId,
        targetId: evidence.targetId,
        reason: "INVALID_ALIAS",
        resolutionIssue: resolved.resolutionIssue ?? "invalid alias"
      });
      continue;
    }
    const canonicalTargetId = resolved.canonicalTargetId as string;
    const key = `${evidence.pageId}|${canonicalTargetId}`;
    if (!byTarget.has(key)) byTarget.set(key, { pageId: evidence.pageId, locators: new Map() });
    const entry = byTarget.get(key)!;
    const locator = evidence.observedValue;
    if (!entry.locators.has(locator)) entry.locators.set(locator, { count: 0, evidenceIds: [], runIds: [], fixType: false, sourceTargetIds: [] });
    const locEntry = entry.locators.get(locator)!;
    locEntry.count++;
    locEntry.evidenceIds.push(evidence.evidenceId);
    if (evidence.sourceRunId) locEntry.runIds.push(evidence.sourceRunId);
    locEntry.sourceTargetIds.push(evidence.targetId);
    const observation = evidence.observation as Record<string, unknown>;
    if (observation.oldLocator && Number(observation.fallbackLevel) > 0) locEntry.fixType = true;
  }

  const targets: LocatorTarget[] = [];
  const policy = PROMOTION_POLICIES.LOCATOR;
  for (const [key, entry] of byTarget) {
    const [pageId, targetId] = key.split("|");
    // 唯一新 locator（矛盾则无唯一 winner，不自动）
    const locators = [...entry.locators.entries()].sort((a, b) => b[1].count - a[1].count);
    if (locators.length === 0) continue;
    const [newLocator, best] = locators[0];
    const totalSuccess = locators.reduce((sum, [, l]) => sum + l.count, 0);
    const dominantRatio = best.count / totalSuccess;
    const unanimous = dominantRatio >= 0.8;
    const successCount = best.count;
    const fixType = best.fixType;
    const confidence: LocatorTarget["confidence"] = successCount >= 3 ? "HIGH" : successCount >= policy.minEvidenceCount ? "MEDIUM" : "LOW";
    targets.push({
      pageId,
      targetId,
      newLocator,
      successCount,
      evidenceIds: best.evidenceIds,
      sourceRunIds: best.runIds,
      sourceTargetIds: best.sourceTargetIds,
      fixType,
      confidence
    });
  }
  return targets;
}

/** 在 store 中按 semanticName 定位元素（修复型写回目标）。 */
function findElementBySemanticName(store: { models?: Array<Record<string, unknown>> }, pageId: string, targetId: string): { model: Record<string, unknown>; element: Record<string, unknown> } | undefined {
  const model = (store.models ?? []).find((m) => String(m.pageId) === pageId);
  if (!model) return undefined;
  const elements = (model.elements ?? []) as Array<Record<string, unknown>>;
  const element = elements.find((el) =>
    // 仅元素具备显式动态展示证据（captured_inventory / dynamicBinding / currentValue）时 opt-in 剥离动态数值；
    // elementId 比较始终原始文本。
    fuzzyMatch(String(el.semanticName ?? ""), targetId, { allowDynamicValueStripping: hasExplicitDynamicContext(el) }) || fuzzyMatch(String(el.elementId ?? ""), targetId)
  );
  if (!element) return undefined;
  return { model, element };
}

/** 轻量语义匹配（与 locator-promotion 的 fuzzySemanticMatch 同规则）。默认原始文本比较，仅显式动态上下文 opt-in。 */
function fuzzyMatch(a: string, b: string, options: IdentityNormalizeOptions = {}): boolean {
  return isSameDynamicLocatorIdentity(a, b, options);
}

/**
 * CONTROL_TYPE：只在元素 controlType 为 unknown 时补标，不改语义不改 status。
 * auto 路径要求 HIGH 结构证据；humanApproved 路径允许人工权威补标（仍只补 unknown、不覆盖、带 backup）。
 */
export async function writeControlType(rootDir: string, project: string, candidate: KnowledgeCandidate, options?: { humanApproved?: boolean }): Promise<WritebackAction> {
  const storePath = path.join(rootDir, "storage", "page-models", `${project}.json`);
  if (!fs.pathExistsSync(storePath)) return { knowledgeType: "CONTROL_TYPE", pageId: candidate.pageId, elementId: candidate.targetId, targetId: candidate.targetId, observedValue: candidate.normalizedValue, decision: "AUTO_PROMOTE", action: "error", reason: "page-model store 不存在" };
  const store = fs.readJsonSync(storePath) as Record<string, unknown>;
  const models = Array.isArray(store.models) ? store.models as Array<Record<string, unknown>> : [];
  const model = models.find((m) => String(m.pageId) === candidate.pageId);
  if (!model) return { knowledgeType: "CONTROL_TYPE", pageId: candidate.pageId, elementId: candidate.targetId, targetId: candidate.targetId, observedValue: candidate.normalizedValue, decision: "AUTO_PROMOTE", action: "skipped_unmatched", reason: `页面 ${candidate.pageId} 未建模` };
  const elements = Array.isArray(model.elements) ? model.elements as Array<Record<string, unknown>> : [];
  // alias-aware：evidence 的旧 targetId 先解析为 canonical 再定位元素（elementId 本体不改写）。
  let canonicalTargetId: string;
  try {
    canonicalTargetId = resolveTargetIds(model as PageModelWithAliases, candidate.targetId).canonicalTargetId;
  } catch (error) {
    return { knowledgeType: "CONTROL_TYPE", pageId: candidate.pageId, elementId: candidate.targetId, targetId: candidate.targetId, observedValue: candidate.normalizedValue, decision: "AUTO_PROMOTE", action: "error", reason: `alias 解析失败：${error instanceof Error ? error.message : String(error)}` };
  }
  const element = elements.find((el) => String(el.elementId) === canonicalTargetId);
  if (!element) return { knowledgeType: "CONTROL_TYPE", pageId: candidate.pageId, elementId: candidate.targetId, targetId: candidate.targetId, observedValue: candidate.normalizedValue, decision: "AUTO_PROMOTE", action: "skipped_unmatched", reason: `元素 ${candidate.targetId} 未建模` };
  if (String(element.controlType ?? "unknown") !== "unknown") {
    return { knowledgeType: "CONTROL_TYPE", pageId: candidate.pageId, elementId: String(element.elementId), targetId: candidate.targetId, observedValue: candidate.normalizedValue, decision: "AUTO_PROMOTE", action: "skipped_unmatched", reason: `controlType 已存在（${element.controlType}），不覆盖` };
  }

  // 只允许 HIGH 结构证据补标（policy: control_type.v1 auto 条件）；
  // humanApproved 路径由人工权威接管（仍只补 unknown、不覆盖、带 backup + 溯源）。
  const highEvidence = candidate.evidence.filter((e) => e.confidence === "HIGH");
  if (highEvidence.length === 0 && !options?.humanApproved) {
    return { knowledgeType: "CONTROL_TYPE", pageId: candidate.pageId, elementId: String(element.elementId), targetId: candidate.targetId, observedValue: candidate.normalizedValue, decision: "AUTO_PROMOTE", action: "skipped_unmatched", reason: "无 HIGH 结构证据，拒绝补标" };
  }
  const usedEvidence = highEvidence.length ? highEvidence : candidate.evidence;

  const beforeHash = crypto.createHash("sha256").update(JSON.stringify(store)).digest("hex").slice(0, 16);
  element.controlType = candidate.normalizedValue;
  const historyEntry = {
    promotedAt: new Date().toISOString(),
    policyId: "control_type.v1",
    policyVersion: 1,
    knowledgeType: "CONTROL_TYPE",
    action: "fill_control_type",
    evidenceIds: usedEvidence.map((e) => e.evidenceId),
    sourceRunIds: usedEvidence.map((e) => e.sourceRunId).filter((v): v is string => Boolean(v)),
    controlType: candidate.normalizedValue,
    source: options?.humanApproved ? "human_review_approved" : "normalization_high_confidence"
  };
  element.verificationHistory = Array.isArray(element.verificationHistory)
    ? [...(element.verificationHistory as Array<Record<string, unknown>>), historyEntry]
    : [historyEntry];
  model.updatedAt = new Date().toISOString();

  const backupDir = path.join(rootDir, "storage", "page-models");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const backupPath = path.join(backupDir, `backup-${project}-pre-control-type-writeback-${timestamp}.json`);
  if (!(await fs.pathExists(backupPath))) await fs.writeFile(backupPath, JSON.stringify(store, null, 2) + "\n");

  await writeSafeJsonFile(storePath, store);
  logger.info("ControlType written back", { elementId: element.elementId, controlType: candidate.normalizedValue, policyId: "control_type.v1", source: options?.humanApproved ? "human_review_approved" : "normalization_high_confidence" });

  return {
    knowledgeType: "CONTROL_TYPE",
    pageId: candidate.pageId,
    elementId: String(element.elementId),
    targetId: candidate.targetId,
    observedValue: candidate.normalizedValue,
    decision: "AUTO_PROMOTE",
    action: "fill_control_type",
    reason: options?.humanApproved ? "人工 review 批准补标（MEDIUM/LOW 证据）" : "HIGH 结构证据补标 unknown controlType",
    detail: { backupPath: path.relative(rootDir, backupPath).replace(/\\/g, "/"), beforeHash, canonicalTargetId, evidenceIds: usedEvidence.map((e) => e.evidenceId), source: options?.humanApproved ? "human_review_approved" : "normalization_high_confidence" }
  };
}

/** INTERACTION：把受控探索确认的交互观察写入元素 verificationHistory（不改 status/不覆盖现有）。 */
export async function writeInteraction(rootDir: string, project: string, candidate: KnowledgeCandidate): Promise<WritebackAction> {
  const storePath = path.join(rootDir, "storage", "page-models", `${project}.json`);
  if (!fs.pathExistsSync(storePath)) return { knowledgeType: "INTERACTION", pageId: candidate.pageId, elementId: candidate.targetId, targetId: candidate.targetId, observedValue: candidate.normalizedValue, decision: "AUTO_PROMOTE", action: "error", reason: "page-model store 不存在" };
  const store = fs.readJsonSync(storePath) as Record<string, unknown>;
  const models = Array.isArray(store.models) ? store.models as Array<Record<string, unknown>> : [];
  const model = models.find((m) => String(m.pageId) === candidate.pageId);
  if (!model) return { knowledgeType: "INTERACTION", pageId: candidate.pageId, elementId: candidate.targetId, targetId: candidate.targetId, observedValue: candidate.normalizedValue, decision: "AUTO_PROMOTE", action: "skipped_unmatched", reason: `页面 ${candidate.pageId} 未建模` };
  const elements = Array.isArray(model.elements) ? model.elements as Array<Record<string, unknown>> : [];
  // alias-aware：evidence 的旧 targetId 先解析为 canonical 再定位元素（elementId 本体不改写）。
  let canonicalTargetId: string;
  try {
    canonicalTargetId = resolveTargetIds(model as PageModelWithAliases, candidate.targetId).canonicalTargetId;
  } catch (error) {
    return { knowledgeType: "INTERACTION", pageId: candidate.pageId, elementId: candidate.targetId, targetId: candidate.targetId, observedValue: candidate.normalizedValue, decision: "AUTO_PROMOTE", action: "error", reason: `alias 解析失败：${error instanceof Error ? error.message : String(error)}` };
  }
  const element = elements.find((el) => String(el.elementId) === canonicalTargetId);
  if (!element) return { knowledgeType: "INTERACTION", pageId: candidate.pageId, elementId: candidate.targetId, targetId: candidate.targetId, observedValue: candidate.normalizedValue, decision: "AUTO_PROMOTE", action: "skipped_unmatched", reason: `元素 ${candidate.targetId} 未建模` };

  const successEvidence = candidate.evidence.filter((e) => e.outcome === "success");
  const sourceRunIds = successEvidence.map((e) => e.sourceRunId).filter((v): v is string => Boolean(v));
  const evidenceIds = successEvidence.map((e) => e.evidenceId);
  // P6.2-13：幂等——同元素已存在相同 knowledgeType + 同 sourceRun 的 history 则 noop，
  // 防止 orchestrator 多轮迭代重复写回同一 candidate（此前出现同秒重复 8 次）。
  const existingHistory = Array.isArray(element.verificationHistory) ? element.verificationHistory as Array<Record<string, unknown>> : [];
  const alreadyRecorded = existingHistory.some((h) =>
    String(h.knowledgeType ?? "") === "INTERACTION"
    && Array.isArray(h.sourceRunIds)
    && (h.sourceRunIds as unknown[]).some((id) => sourceRunIds.includes(String(id)))
  );
  if (alreadyRecorded) {
    return {
      knowledgeType: "INTERACTION",
      pageId: candidate.pageId,
      elementId: String(element.elementId),
      targetId: candidate.targetId,
      observedValue: candidate.normalizedValue,
      decision: "AUTO_PROMOTE",
      action: "noop",
      reason: `幂等：元素已记录同 sourceRun 的 INTERACTION（${sourceRunIds.join(",")}）`
    };
  }
  const beforeHash = crypto.createHash("sha256").update(JSON.stringify(store)).digest("hex").slice(0, 16);
  const historyEntry = {
    promotedAt: new Date().toISOString(),
    policyId: "interaction.v1",
    policyVersion: 1,
    knowledgeType: "INTERACTION",
    action: "record_interaction",
    evidenceIds,
    sourceRunIds,
    sourceGapIds: successEvidence.map((e) => e.sourceGapId).filter((v): v is string => Boolean(v)),
    interaction: { observedValue: candidate.normalizedValue, successCount: candidate.successCount }
  };
  element.verificationHistory = Array.isArray(element.verificationHistory)
    ? [...(element.verificationHistory as Array<Record<string, unknown>>), historyEntry]
    : [historyEntry];
  model.updatedAt = new Date().toISOString();

  const backupDir = path.join(rootDir, "storage", "page-models");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const backupPath = path.join(backupDir, `backup-${project}-pre-interaction-writeback-${timestamp}.json`);
  if (!(await fs.pathExists(backupPath))) await fs.writeFile(backupPath, JSON.stringify(store, null, 2) + "\n");

  await writeSafeJsonFile(storePath, store);
  logger.info("Interaction recorded on element", { elementId: element.elementId, successCount: candidate.successCount, policyId: "interaction.v1" });

  return {
    knowledgeType: "INTERACTION",
    pageId: candidate.pageId,
    elementId: String(element.elementId),
    targetId: candidate.targetId,
    observedValue: candidate.normalizedValue,
    decision: "AUTO_PROMOTE",
    action: "record_interaction",
    reason: `受控探索确认交互（成功 ${candidate.successCount} 次）`,
    detail: { backupPath: path.relative(rootDir, backupPath).replace(/\\/g, "/"), beforeHash, canonicalTargetId }
  };
}

/** 统一分发入口：collect → aggregate → decide → 按 caps 执行 AUTO_PROMOTE。 */
export async function dispatchKnowledgeWritebacks(options: WritebackDispatchOptions): Promise<WritebackDispatchResult> {
  const { rootDir, project, dryRun = false } = options;
  const caps = resolveCaps(options.caps);

  const collected = await collectAllKnowledgeEvidence(rootDir, project);
  const storePath = path.join(rootDir, "storage", "page-models", `${project}.json`);
  const store = fs.pathExistsSync(storePath) ? fs.readJsonSync(storePath) as { models?: Array<Record<string, unknown>> } : { models: [] };
  const pageModels = pageModelsOf(store);
  // P16.7 Phase 2：invalid alias 证据 fail-closed 审计（聚合路径 + LOCATOR target 路径共用，
  // 同一条证据可能两处各记一次，最终按 evidenceId 去重后暴露）。
  const invalidAliasBlocked: InvalidAliasBlockedEvidence[] = [];
  const candidates = aggregateEvidence(collected.evidenceList, pageModels, invalidAliasBlocked);

  const decisions: Record<string, number> = {};
  for (const candidate of candidates.values()) {
    const decision = decidePromotion(candidate);
    decisions[decision.decision] = (decisions[decision.decision] ?? 0) + 1;
  }

  const planned: WritebackAction[] = [];
  const locatorTargets: WritebackDispatchResult["locatorTargets"] = [];

  // ============ LOCATOR：修复型 target 配对（独立于 knowledgeKey 聚合） ============
  let locatorBudget = caps.locator;
  const policy = PROMOTION_POLICIES.LOCATOR;
  const targets = buildLocatorTargets(collected.evidenceList, pageModels, invalidAliasBlocked).sort((a, b) => b.successCount - a.successCount);

  for (const target of targets) {
    const auto = target.successCount >= policy.minEvidenceCount && target.fixType && target.confidence !== "LOW";
    const decision = auto ? "AUTO_PROMOTE" : "REVIEW";
    const reason = auto
      ? `修复型：原 locator 失败 + 新 locator 成功 ${target.successCount} 次 ≥ ${policy.minEvidenceCount}，无矛盾`
      : !target.fixType
        ? "非修复型（无原 locator 失败证据）"
        : `成功次数 ${target.successCount} < ${policy.minEvidenceCount}`;
    locatorTargets.push({ targetId: target.targetId, successCount: target.successCount, newLocator: target.newLocator, decision, reason });

    if (!auto) continue;
    if (locatorBudget <= 0) {
      planned.push({ knowledgeType: "LOCATOR", pageId: target.pageId, elementId: target.targetId, targetId: target.targetId, observedValue: target.newLocator, decision: "AUTO_PROMOTE", action: "skipped_cap", reason: "达到 locator cap 上限，跳过" });
      continue;
    }
    const located = findElementBySemanticName(store, target.pageId, target.targetId);
    if (!located) {
      planned.push({ knowledgeType: "LOCATOR", pageId: target.pageId, elementId: target.targetId, targetId: target.targetId, observedValue: target.newLocator, decision: "AUTO_PROMOTE", action: "skipped_unmatched", reason: `semantic target「${target.targetId}」在 ${target.pageId} 未建模` });
      continue;
    }
    const strategy = target.newLocator.startsWith("text") ? "text"
      : target.newLocator.startsWith("css") || target.newLocator.startsWith("[") ? "css"
      : target.newLocator.startsWith("role") ? "role" : "unknown";
    planned.push({
      knowledgeType: "LOCATOR",
      pageId: target.pageId,
      elementId: String(located.element.elementId ?? ""),
      targetId: target.targetId,
      observedValue: target.newLocator,
      decision: "AUTO_PROMOTE",
      action: "append_locator_candidate",
      reason,
      detail: {
        oldLocator: collected.evidenceList.find((e) => e.knowledgeType === "LOCATOR" && e.sourceType === "SELF_HEALING" && resolveTargetIdsSafe(pageModels.get(e.pageId), e.targetId).canonicalTargetId === target.targetId)?.observation?.oldLocator ?? undefined,
        newLocator: target.newLocator,
        strategy,
        successCount: target.successCount,
        evidenceIds: target.evidenceIds,
        sourceRunIds: target.sourceRunIds
      }
    });
    locatorBudget--;
  }

  // ============ CONTROL_TYPE / INTERACTION：knowledgeKey 聚合路径 ============
  let controlTypeBudget = caps.controlType;
  let interactionBudget = caps.interaction;
  for (const candidate of candidates.values()) {
    const decision = decidePromotion(candidate);
    if (decision.decision !== "AUTO_PROMOTE") continue;
    const type = candidate.knowledgeType;
    if (type === "CONTROL_TYPE") {
      if (controlTypeBudget <= 0) { planned.push(skipCap(candidate, "controlType")); continue; }
      planned.push({
        knowledgeType: type, pageId: candidate.pageId, elementId: candidate.targetId, targetId: candidate.targetId, observedValue: candidate.normalizedValue,
        decision: decision.decision, action: "fill_control_type", reason: decision.reasons[0] ?? "control_type.v1 auto promote"
      });
      controlTypeBudget--;
    } else if (type === "INTERACTION") {
      if (interactionBudget <= 0) { planned.push(skipCap(candidate, "interaction")); continue; }
      planned.push({
        knowledgeType: type, pageId: candidate.pageId, elementId: candidate.targetId, targetId: candidate.targetId, observedValue: candidate.normalizedValue,
        decision: decision.decision, action: "record_interaction", reason: decision.reasons[0] ?? "interaction.v1 auto promote"
      });
      interactionBudget--;
    }
  }

  // ============ 执行（dryRun 不落盘） ============
  const applied: WritebackAction[] = [];
  if (!dryRun) {
    for (const plan of planned) {
      // 只执行真实写回动作；skipped_cap / skipped_unmatched 只留在 plan 里供审阅。
      if (plan.action === "skipped_cap" || plan.action === "skipped_unmatched") {
        applied.push({ ...plan });
        continue;
      }
      let result: WritebackAction;
      if (plan.knowledgeType === "LOCATOR") {
        const detail = plan.detail as { newLocator?: string; strategy?: string; evidenceIds?: string[]; sourceRunIds?: string[]; successCount?: number } | undefined;
        const located = findElementBySemanticName(store, plan.pageId, plan.targetId);
        if (!located || !detail?.newLocator) {
          result = { ...plan, action: "skipped_unmatched", reason: "写回时元素定位失败" };
        } else {
          const input: LocatorPromotionInput = {
            pageId: plan.pageId,
            elementId: plan.elementId,
            semanticName: String(located.element.semanticName ?? ""),
            oldLocatorCandidates: (located.element.locatorCandidates ?? []) as Array<Record<string, unknown>>,
            healedLocator: { strategy: detail.strategy ?? "unknown", value: detail.newLocator, confidence: 0.75, source: "self_healing_recovery" },
            evidenceIds: detail.evidenceIds ?? [],
            policyId: "locator.v1",
            policyVersion: 1,
            sourceRunIds: detail.sourceRunIds ?? [],
            successCount: detail.successCount ?? 0
          };
          const promoted = await promoteLocatorCandidate(rootDir, project, input);
          result = promoted.ok
            ? { ...plan, action: "append_locator_candidate", reason: promoted.action === "noop" ? "幂等：候选已存在" : plan.reason, detail: { ...plan.detail, action: promoted.action, backupPath: promoted.backupPath, mutationDiff: promoted.mutationDiff } }
            : { ...plan, action: "error", reason: promoted.error ?? "locator promotion 失败" };
        }
      } else if (plan.knowledgeType === "CONTROL_TYPE") {
        const candidate = [...candidates.values()].find((c) => c.knowledgeType === "CONTROL_TYPE" && c.pageId === plan.pageId && c.targetId === plan.targetId && c.normalizedValue === plan.observedValue);
        result = candidate ? await writeControlType(rootDir, project, candidate) : { ...plan, action: "skipped_unmatched", reason: "候选丢失" };
      } else if (plan.knowledgeType === "INTERACTION") {
        const candidate = [...candidates.values()].find((c) => c.knowledgeType === "INTERACTION" && c.pageId === plan.pageId && c.targetId === plan.targetId);
        result = candidate ? await writeInteraction(rootDir, project, candidate) : { ...plan, action: "skipped_unmatched", reason: "候选丢失" };
      } else {
        continue;
      }
      applied.push(result);
    }
  }

  // invalid alias 审计按 evidenceId 去重（聚合与 LOCATOR target 两路径可能重复记录）。
  const seenBlockedIds = new Set<string>();
  const uniqueInvalidAliasBlocked = invalidAliasBlocked.filter((entry) => {
    if (seenBlockedIds.has(entry.evidenceId)) return false;
    seenBlockedIds.add(entry.evidenceId);
    return true;
  });

  return {
    project,
    dryRun,
    collected: collected.sourceCounts,
    uniqueCandidates: candidates.size,
    decisions,
    locatorTargets,
    planned,
    applied,
    capped: {
      locator: caps.locator - Math.max(locatorBudget, 0),
      controlType: caps.controlType - Math.max(controlTypeBudget, 0),
      interaction: caps.interaction - Math.max(interactionBudget, 0)
    },
    invalidAliasBlocked: uniqueInvalidAliasBlocked
  };
}

function skipCap(candidate: KnowledgeCandidate, capName: string): WritebackAction {
  return {
    knowledgeType: candidate.knowledgeType,
    pageId: candidate.pageId,
    elementId: candidate.targetId,
    targetId: candidate.targetId,
    observedValue: candidate.normalizedValue,
    decision: "AUTO_PROMOTE",
    action: "skipped_cap",
    reason: `达到 ${capName} cap 上限，跳过`
  };
}
