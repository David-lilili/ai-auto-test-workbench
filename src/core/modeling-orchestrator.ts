import fs from "fs-extra";
import path from "node:path";
import { isSameDynamicLocatorIdentity, hasExplicitDynamicContext, type IdentityNormalizeOptions } from "./locator-identity-normalizer.js";
import type { Page } from "@playwright/test";
import {
  createModelingSession,
  saveModelingSession,
  loadModelingSession,
  assertTransition,
  type ModelingSession,
  type ModelingBudgets,
  type ModelingProgress,
  type ModelingReviewRequest,
  type StopReason,
  type CreateModelingSessionInput,
  type InitialCaptureSummary
} from "./modeling-session.js";
import { bootstrapPageForModeling, pageModelStoreHash } from "./modeling-bootstrap.js";
import { applyPageModelWriteBack } from "../workbench/page-model-writeback.js";
import { buildCoverageSnapshot, type CoverageSnapshot } from "./exploration-coverage.js";
import { buildExplorationGaps, type ExplorationGap } from "./exploration-gaps.js";
import { buildNormalizedPageModelView } from "./page-model-normalizer.js";
import { matchHeuristicsForGap, buildExplorationPlan, gatePlanRisk, type ExplorationPlan, type GapForMatching } from "./exploration-planner.js";
import { getHeuristic } from "./exploration-heuristics.js";
import { executeExplorationPlan, type ExplorationRun } from "./exploration-executor.js";
import { recordExplorationRunEvidence } from "./modeling-evidence.js";
import { extractOptionsFromRun, isOptionDiscoveryRun, promoteDiscoveredOptions } from "./modeling-option-promotion.js";
import { collectAllKnowledgeEvidence } from "./knowledge-evidence-collector.js";
import { aggregateEvidence, decidePromotion } from "./knowledge-promotion-policy.js";
import { writeControlType, writeInteraction, buildLocatorTargets } from "./knowledge-writeback-dispatcher.js";
import { promoteLocatorCandidate } from "./locator-promotion.js";
import { pageModelsOf, type InvalidAliasBlockedEvidence } from "./element-alias-wiring.js";
import { logger } from "./logger.js";

/**
 * Modeling Orchestrator（P6.4-P6.11）：把 P2-P5 的现有模块串成「从 URL 开始的自动建模闭环」。
 *
 * 原则（P6 约束）：
 *   - 只编排，不重实现：coverage/gap/planner/risk/executor/sink/promotion 全部复用现有 API；
 *   - 不绕过 Page Identity Resolver（bootstrap 内判定，POSSIBLE/CONFLICT 停到 review）；
 *   - 不自动执行 HIGH/FORBIDDEN（executor validatePlanForExecution 只放 LOW）；
 *   - 不允许 AI 直接改 Page Model（bootstrap 只写 proposal；promotion 走受控 writer）；
 *   - exploration evidence 自动进 unified sink（P6.8）；promotion 只自动 apply 受 policy 允许的类型；
 *   - 每轮进度、stopReason、review request、resume 全部持久化。
 *
 * 主循环（P6.4）：每轮 15 步见 iterate()。
 */

export interface ModelingOrchestratorInput {
  rootDir: string;
  project: string;
  env: string;
  startUrl: string;
  page?: Page;
  /** P6.1：建模目标 canonical pageId（业务命名，如 demo.funds.spot_fund_flow）。
   *  不传则由 bootstrap 从 URL path 确定性派生。 */
  suggestedPageId?: string;
  riskMode?: "safe" | "review";
  dryRun?: boolean;
  budgets?: Partial<ModelingBudgets>;
  /** resume 用：已有 sessionId（不从头建模）。 */
  resumeSessionId?: string;
  /** resume 时是否已由人工批准 review（跳过 WAITING_FOR_REVIEW 阻断）。 */
  resumeApproved?: boolean;
}

export interface ModelingOrchestratorResult {
  session: ModelingSession;
  stopReason?: StopReason;
  stopDetail?: string;
}

export interface IterationContext {
  snapshot: CoverageSnapshot;
  pageModel: Record<string, unknown>;
  normalizedView: ReturnType<typeof buildNormalizedPageModelView>;
}

const AUTO_PROMOTABLE_TYPES = new Set(["LOCATOR", "CONTROL_TYPE", "INTERACTION"]);

function gapToMatching(gap: ExplorationGap, controlType: string | undefined): GapForMatching {
  return {
    gapId: gap.gapId,
    pageId: gap.pageId,
    dimension: gap.dimension,
    target: gap.target,
    source: gap.source,
    controlType,
    hasElementLocator: gap.dimension === "element"
  };
}

/** P6.7：deterministic plan selection——每轮最多 N 个，fingerprint 去重。 */
export function selectPlans(
  plans: ExplorationPlan[],
  executedFingerprints: Set<string>,
  maxPlans: number
): ExplorationPlan[] {
  const seen = new Set<string>();
  const selected: ExplorationPlan[] = [];
  const sorted = [...plans].sort((a, b) => {
    // 1. LOW 且可执行优先；2. HIGH-priority gap 优先；3. 聚合（步骤多）次之；4. fingerprint 稳定。
    const riskScore = (p: ExplorationPlan): number => (p.risk === "LOW" ? 0 : p.risk === "MEDIUM" ? 10 : 100);
    const priorityScore = (p: ExplorationPlan): number => (p.gapId.includes("HIGH") || p.gapId.includes("LOW") ? 0 : 0);
    const actionCount = (p: ExplorationPlan): number => -p.steps.length;
    return riskScore(a) - riskScore(b) || priorityScore(a) - priorityScore(b) || actionCount(a) - actionCount(b);
  });
  for (const plan of sorted) {
    if (selected.length >= maxPlans) break;
    if (executedFingerprints.has(plan.fingerprint)) continue;
    if (seen.has(plan.fingerprint)) continue;
    seen.add(plan.fingerprint);
    selected.push(plan);
  }
  return selected;
}

/** P6.6：progress metric——是否出现任一真实改善。 */
export function computeProgress(input: {
  iteration: number;
  gapsBefore: number;
  gapsAfter: number;
  matchedBefore: number;
  matchedAfter: number;
  verifiedBefore: number;
  verifiedAfter: number;
  newEvidence: number;
  promotedKnowledge: number;
  reviewCandidates: number;
  unresolvedUnknown: number;
  riskBlocked: number;
  exploredPlans: string[];
}): ModelingProgress {
  const progressed =
    input.gapsAfter < input.gapsBefore
    || input.matchedAfter > input.matchedBefore
    || input.verifiedAfter > input.verifiedBefore
    || input.newEvidence > 0
    || input.promotedKnowledge > 0
    || input.unresolvedUnknown < input.unresolvedUnknown; // 占位，避免恒 false（实际用 gaps 差值）
  return {
    ...input,
    progressed: input.gapsAfter < input.gapsBefore || input.matchedAfter > input.matchedBefore || input.verifiedAfter > input.verifiedBefore || input.newEvidence > 0 || input.promotedKnowledge > 0
  };
}

export async function runModelingSession(input: ModelingOrchestratorInput): Promise<ModelingOrchestratorResult> {
  const { rootDir, project, env, startUrl } = input;
  let session: ModelingSession;
  if (input.resumeSessionId) {
    const existing = await loadModelingSession(rootDir, project, input.resumeSessionId);
    if (!existing) throw new Error(`Modeling session 不存在: ${input.resumeSessionId}`);
    session = existing;
    if (input.resumeApproved && session.status === "WAITING_FOR_REVIEW") {
      assertTransition(session, "MODELING", "resume after review approved");
    }
  } else {
    const createInput: CreateModelingSessionInput = {
      project,
      startUrl,
      riskMode: input.riskMode,
      dryRun: input.dryRun ?? true,
      budgets: input.budgets
    };
    session = createModelingSession(rootDir, createInput);
  }
  await saveModelingSession(rootDir, session);

  const page = input.page;
  try {
    // ============ BOOTSTRAP（P6.2） ============
    if (session.iteration === 0 && session.status === "CREATED") {
      assertTransition(session, "BOOTSTRAPPING", "initial bootstrap");
      await saveModelingSession(rootDir, session);
      if (!page) throw new Error("runModelingSession 需要已打开的 Playwright Page（P6 不重复登录）");

      const artifactDir = path.join(rootDir, "artifacts", "modeling-sessions", session.sessionId, "bootstrap");
      // P6.3：bootstrap 前后断言 Page Model store 哈希不变（禁止 direct write）。
      const storeHashBefore = await pageModelStoreHash(rootDir, project);
      const bootstrap = await bootstrapPageForModeling({
        rootDir,
        project,
        env,
        url: startUrl,
        page,
        artifactDir,
        suggestedPageId: input.suggestedPageId,
        allowSamePageMerge: true
      });
      const storeHashAfter = await pageModelStoreHash(rootDir, project);
      if (storeHashBefore !== storeHashAfter) {
        throw new Error(`[P6.3] bootstrap 直接修改了 Page Model store（hash ${storeHashBefore} → ${storeHashAfter}）`);
      }
      session.initialCapture = bootstrap.initialCapture;
      session.canonicalPageId = bootstrap.canonicalPageId ?? (bootstrap.identity.verdict === "NEW_PAGE" ? bootstrap.pageId : undefined);
      session.identityVerdict = bootstrap.identity.verdict;
      session.possibleTargetPageId = bootstrap.identity.verdict === "POSSIBLE_SAME_PAGE" || bootstrap.identity.verdict === "CONFLICT"
        ? bootstrap.identity.candidatePageIds[0]
        : undefined;
      session.pageSignatures = [bootstrap.initialCapture.visibleTextHash ?? ""].filter(Boolean);

      if (bootstrap.identity.verdict === "POSSIBLE_SAME_PAGE" || bootstrap.identity.verdict === "CONFLICT") {
        // P6.2/P6.10：不得自动新建，停到 review。
        session.reviewRequests.push({
          reason: bootstrap.reviewReason ?? `identity=${bootstrap.identity.verdict} 需人工确认`,
          details: bootstrap.identity.reasons,
          candidateEvidence: [],
          suggestedDecision: "keep_pending"
        });
        assertTransition(session, "WAITING_FOR_REVIEW", `identity=${bootstrap.identity.verdict}`);
        session.stopReason = "review_required";
        session.stopDetail = bootstrap.reviewReason;
        await saveModelingSession(rootDir, session);
        return { session, stopReason: "review_required", stopDetail: bootstrap.reviewReason };
      }
      if (bootstrap.identity.verdict === "RELATED_STATE_MODEL") {
        // 不创建重复 base page；作为 related state 记录后停止（P6.2）。
        assertTransition(session, "PARTIAL", "related_state_model 不重复建模");
        session.stopReason = "no_plannable_low_risk";
        session.stopDetail = "RELATED_STATE_MODEL：作为已有 canonical 的 related state，不创建重复 base page。";
        session.partialReason = session.stopDetail;
        await saveModelingSession(rootDir, session);
        return { session, stopReason: "no_plannable_low_risk", stopDetail: session.stopDetail };
      }
      // NEW / SAME → 受控物化（candidate 上限）→ MODELING
      // P6.9：bootstrap 只产 proposal，经 applyPageModelWriteBack 以 candidate 状态写入，
      // 供 coverage/gap 迭代消费。identity SAME 时 remap 到 canonical。
      if (bootstrap.proposalPath) {
        const proposalPath = path.join(rootDir, bootstrap.proposalPath);
        const proposal = await fs.readJson(proposalPath) as Record<string, unknown>;
        const payload = (proposal.captureIngest ?? {}) as { pageModel?: { pageId?: string } };
        // P6.2-5：bootstrap 结构观察（table/empty-state/button-state/native options）已由 DOM 明确观察到，
        // 物化状态上限 = dom_verified（MATERIALIZABLE）；execution_verified 永不在此写入。
        const materialized = await applyPageModelWriteBack(rootDir, project, proposal, {
          reviewedBy: "modeling_orchestrator",
          note: `P6 自动建模 bootstrap 物化（identity=${bootstrap.identity.verdict}，statusCap=dom_verified）`,
          statusCap: "dom_verified"
        });
        // materialized 无 pageId 字段；canonical = proposal.pageModel.pageId（SAME remap 后与 canonical 一致）
        session.canonicalPageId = payload.pageModel?.pageId ?? bootstrap.canonicalPageId ?? bootstrap.pageId;
        session.promotionResults.push({
          knowledgeType: "CONTROL_TYPE",
          targetId: session.canonicalPageId,
          action: materialized.action === "no_op" ? "noop" : "materialize_candidate",
          ok: materialized.applied,
          reason: `bootstrap 物化（+${materialized.addedElements} elements, +${materialized.addedAssertions} assertions, status=dom_verified）`
        });
        // 记录结构扫描摘要（P6.2-3/6）
        session.initialCapture = {
          ...session.initialCapture!,
          resultRegions: bootstrap.structureScan?.resultRegions ?? 0,
          assertionCandidates: bootstrap.structureScan?.assertionCandidates ?? 0,
          nativeSelectOptions: bootstrap.structureScan?.nativeSelectOptions ?? 0
        } as typeof session.initialCapture;
      } else {
        session.canonicalPageId = bootstrap.canonicalPageId ?? bootstrap.pageId;
      }
      assertTransition(session, "MODELING", "bootstrap complete");
      await saveModelingSession(rootDir, session);
    }

    // ============ ITERATIONS（P6.4） ============
    let noProgressStreak = 0;
    const startTime = Date.now();

    while (session.status === "MODELING" || session.status === "EXPLORING" || session.status === "PROMOTING") {
      session.status = "MODELING";
      session.iteration += 1;
      await saveModelingSession(rootDir, session);

      const iteration = await runIteration(rootDir, project, env, session, page, startUrl);

      // 追加进度
      session.progressHistory.push(iteration.progress);
      session.executedFingerprints = [...new Set([...session.executedFingerprints, ...iteration.executedFingerprints])];
      session.evidenceIds = [...new Set([...session.evidenceIds, ...iteration.evidenceIds])];
      session.lastGaps = iteration.gaps;
      session.lastPlans = iteration.plans;
      session.promotionResults.push(...iteration.promotionResults);
      session.updatedAt = new Date().toISOString();

      // ============ REVIEW CHECKPOINT（P6.10） ============
      if (iteration.reviewRequests.length) {
        session.reviewRequests.push(...iteration.reviewRequests);
        assertTransition(session, "WAITING_FOR_REVIEW", "iteration review checkpoint");
        session.stopReason = "review_required";
        session.stopDetail = iteration.reviewRequests.map((r) => r.reason).join("; ");
        await saveModelingSession(rootDir, session);
        return { session, stopReason: "review_required", stopDetail: session.stopDetail };
      }

      // ============ STOP CONDITIONS（P6.5） ============
      const stop = evaluateStopConditions(session, iteration, { startTime, noProgressStreak });
      if (stop.stop) {
        session.stopReason = stop.reason;
        session.stopDetail = stop.detail;
        assertTransition(session, "PARTIAL", `stop: ${stop.reason}`);
        await saveModelingSession(rootDir, session);
        return { session, stopReason: stop.reason, stopDetail: stop.detail };
      }
      noProgressStreak = iteration.progress.progressed ? 0 : noProgressStreak + 1;

      // 无 page 时不继续探索（dry-run 只规划一轮，防止空转）；有 page 但 dryRun=true 时
      // 继续按 budget 迭代（P6.5 budget 语义：maxIterations 应真正生效）。
      if (!page) {
        assertTransition(session, "PARTIAL", "no page provided (dry-run planning only)");
        session.stopReason = "no_plannable_low_risk";
        session.stopDetail = "dry-run：无浏览器，仅完成一轮规划。";
        await saveModelingSession(rootDir, session);
        return { session, stopReason: "no_plannable_low_risk" };
      }
    }

    // 自然结束：循环自然退出时（未命中 stop/!page 分支）且 budget 未耗尽 → COMPLETED；
    // budget 耗尽但仍有可探索项 → PARTIAL（stop 分支已处理 budget_reached，此处为兜底）。
    if (session.iteration >= session.budgets.maxIterations) {
      assertTransition(session, "PARTIAL", "maxIterations reached");
      session.stopReason = "budget_reached";
      session.stopDetail = `达到 maxIterations=${session.budgets.maxIterations}`;
    } else {
      assertTransition(session, "COMPLETED", "modeling completed");
      session.stopReason = "completed";
    }
    await saveModelingSession(rootDir, session);
    return { session, stopReason: session.stopReason, stopDetail: session.stopDetail };
  } catch (error) {
    logger.error("Modeling session failed", { sessionId: session.sessionId, error: error instanceof Error ? error.message : String(error) });
    try {
      assertTransition(session, "FAILED", "unhandled error");
      session.error = error instanceof Error ? error.message : String(error);
      session.stopReason = "failed";
      await saveModelingSession(rootDir, session);
    } catch {
      // 状态已失败/取消则忽略
    }
    throw error;
  }
}

interface IterationResult {
  progress: ModelingProgress;
  executedFingerprints: string[];
  evidenceIds: string[];
  gaps: ExplorationGap[];
  plans: ExplorationPlan[];
  promotionResults: ModelingSession["promotionResults"];
  reviewRequests: ModelingReviewRequest[];
}

/** 单轮迭代（导出供 production-path 定向测试直接驱动真实聚合/promotion 路径）。 */
export async function runIteration(
  rootDir: string,
  project: string,
  env: string,
  session: ModelingSession,
  page: Page | undefined,
  startUrl: string
): Promise<IterationResult> {
  const canonicalPageId = session.canonicalPageId;
  const snapshot = await buildCoverageSnapshot(rootDir, project);
  const gapReport = await buildExplorationGaps(rootDir, project, snapshot);
  const gaps = gapReport.gaps;
  const store = await fs.readJson(path.join(rootDir, "storage", "page-models", `${project}.json`)) as { models?: Array<Record<string, unknown>> };
  // P16.7：alias-aware 聚合——与 dispatcher 同口径，旧 id 证据与 canonical id 证据按 canonical 归组。
  const pageModels = pageModelsOf(store);
  const pageModel = (store.models ?? []).find((m) => String(m.pageId) === canonicalPageId);

  // 构建 normalized view（供 controlType 推断）
  const normalizedView = pageModel ? buildNormalizedPageModelView(pageModel) : undefined;

  // ============ GAP → HEURISTIC → PLAN（P6.4 5-8） ============
  const plans: ExplorationPlan[] = [];
  const reviewRequests: ModelingReviewRequest[] = [];
  for (const gap of gaps) {
    if (canonicalPageId && gap.pageId !== canonicalPageId) continue;
    let controlType: string | undefined;
    if (pageModel && gap.dimension === "element") {
      const el = normalizedView?.elements.find((i) => i.elementId === gap.target);
      if (el) {
        if (!el.interactionTarget) continue;
        controlType = el.normalizedControlType;
      }
    }
    const match = matchHeuristicsForGap(gapToMatching(gap, controlType), pageModel);
    if (match.verdict === "NO_MATCH" && gap.source === "candidate_stale") {
      // candidate_stale 且无法匹配：不自动处理，仅记录（P6.0 语义：不一致则保留 NO_MATCH）。
      continue;
    }
    for (const matched of match.matched) {
      const heuristic = getHeuristic(matched.heuristicId);
      if (!heuristic) continue;
      // P6.1：尊重 heuristic 声明的 preconditions——modal.open_close 要求 expected_dialog，
      // 页面无 dialog 时不得反复选中（否则浪费探索预算且全部失败）。
      if (!heuristicPreconditionsMet(heuristic, pageModel, session)) {
        continue;
      }
      const plan = buildExplorationPlan({
        gap: gapToMatching(gap, controlType),
        pageId: gap.pageId,
        heuristic,
        pageModel
      });
      // risk gate 已内建于 buildExplorationPlan（gatePlanRisk）；这里显式复核。
      const gate = gatePlanRisk(plan.heuristicId, plan.steps.map((s) => s.action));
      if (gate.risk === "HIGH" || gate.risk === "FORBIDDEN") {
        // 不自动执行，不进入 plan 队列。
        continue;
      }
      plans.push(plan);
    }
  }

  // P6.7：每轮最多 maxPlansPerIteration 个，fingerprint 去重。
  const selected = selectPlans(plans, new Set(session.executedFingerprints), session.budgets.maxPlansPerIteration);

  // ============ 执行 + 证据（P6.8） ============
  const executedFingerprints: string[] = [];
  const evidenceIds: string[] = [];
  const explorationRuns: ExplorationRun[] = [];
  // P6.2：探索期 promotion 结果（option_discovery 写回）与 P6.9 aggregation 共用同一数组。
  const promotionResults: ModelingSession["promotionResults"] = [];
  if (page && !session.dryRun) {
    for (const plan of selected) {
      const locatorResolver = (targetElementId: string): string | undefined => {
        const model = (store.models ?? []).find((m) => String(m.pageId) === plan.pageId);
        const el = (model?.elements as Array<Record<string, unknown>> | undefined)?.find((e) => String(e.elementId) === targetElementId);
        const candidates = Array.isArray(el?.locatorCandidates) ? (el!.locatorCandidates as Array<Record<string, unknown>>) : [];
        const first = candidates[0];
        if (!first) return undefined;
        const value = String(first.value ?? "");
        return value || undefined;
      };
      const run = await executeExplorationPlan({ page, plan, rootDir, locatorResolver });
      explorationRuns.push(run);
      if (run.status === "COMPLETED_CLEANLY") executedFingerprints.push(plan.fingerprint);
      // P6.8：evidence 自动入 unified sink。
      const sinkResult = await recordExplorationRunEvidence(rootDir, project, run);
      if (sinkResult.evidenceId) evidenceIds.push(sinkResult.evidenceId);
      // P6.2-1/2：select.option_discovery 成功 → 把观察到的 option 受控写回 Page Model（OPTION_EXISTS, dom_verified）。
      if (isOptionDiscoveryRun(run) && plan.target) {
        const discoveredOptions = extractOptionsFromRun(run);
        // P8.8：把父控件当前显示值（currentValue）传给 promotion，过滤"当前值/占位符被当 option"的污染。
        const parentModel = (store.models ?? []).find((m) => String(m.pageId) === plan.pageId);
        const parentEl = (parentModel?.elements as Array<Record<string, unknown>> | undefined)?.find((e) => String(e.elementId) === plan.target);
        const triggerDisplayText = String(
          (parentEl as Record<string, unknown> | undefined)?.dropdown && typeof (parentEl as Record<string, unknown>).dropdown === "object"
            ? ((parentEl as Record<string, unknown>).dropdown as Record<string, unknown>)?.currentValue ?? (parentEl as Record<string, unknown>)?.currentValue ?? ""
            : (parentEl as Record<string, unknown>)?.currentValue ?? ""
        ) || undefined;
        const optionResult = await promoteDiscoveredOptions(rootDir, project, {
          pageId: plan.pageId,
          parentElementId: plan.target,
          options: discoveredOptions,
          sourceRunId: run.runId,
          sourceGapId: run.gapId,
          heuristicVersion: run.heuristicVersion,
          triggerDisplayText
        });
        if (optionResult.ok && optionResult.action === "appended_options") {
          promotionResults.push({
            knowledgeType: "INTERACTION",
            targetId: plan.target,
            action: "append_dropdown_options",
            ok: true,
            reason: `option_discovery 写回 ${optionResult.addedOptions} 个 option（OPTION_EXISTS, dom_verified）`
          });
        }
      }
      // restore failure → 停 session（P6.17）。
      if (run.status === "COMPLETED_WITH_RESTORE_FAILURE") {
        session.stopReason = "restore_failure";
        session.stopDetail = `plan ${plan.planId} restore 失败`;
      }
    }
  } else {
    // dry-run：不执行，但记录计划（供审阅）
    session.lastPlans = selected;
  }

  // ============ AGGREGATE + DECIDE + PROMOTION（P6.9） ============
  if (!session.dryRun) {
    const collected = await collectAllKnowledgeEvidence(rootDir, project);
    // P16.7 Phase 2：invalid alias 证据 fail-closed——不入候选、不写旧 source element，
    // 聚合路径与 LOCATOR target 路径的拒入诊断统一收集（按 evidenceId 去重后暴露）。
    const invalidAliasBlocked: InvalidAliasBlockedEvidence[] = [];
    const candidates = aggregateEvidence(collected.evidenceList, pageModels, invalidAliasBlocked);
    const locatorTargets = buildLocatorTargets(collected.evidenceList, pageModels, invalidAliasBlocked);
    const byTarget = new Map(locatorTargets.map((t) => [`${t.pageId}|${t.targetId}`, t]));

    for (const candidate of candidates.values()) {
      if (!AUTO_PROMOTABLE_TYPES.has(candidate.knowledgeType)) continue;
      if (canonicalPageId && candidate.pageId !== canonicalPageId) continue;
      const decision = decidePromotion(candidate);
      if (decision.decision !== "AUTO_PROMOTE") {
        if (candidate.knowledgeType === "ASSERTION" || candidate.knowledgeType === "SECURITY_REQUIREMENT" || candidate.knowledgeType === "BUSINESS_RULE") {
          reviewRequests.push({
            reason: `${candidate.knowledgeType} 候选需要人工 review（policy 硬规定）`,
            details: decision.reasons,
            candidateEvidence: candidate.evidence.slice(0, 5).map((e) => ({
              evidenceId: e.evidenceId,
              knowledgeType: e.knowledgeType,
              targetId: e.targetId,
              observedValue: e.observedValue,
              confidence: e.confidence,
              outcome: e.outcome
            })),
            suggestedDecision: "keep_pending"
          });
        }
        continue;
      }
      try {
        if (candidate.knowledgeType === "CONTROL_TYPE") {
          const result = await writeControlType(rootDir, project, candidate);
          promotionResults.push({ knowledgeType: "CONTROL_TYPE", targetId: candidate.targetId, action: result.action, ok: result.action === "fill_control_type", reason: result.reason });
        } else if (candidate.knowledgeType === "INTERACTION") {
          const result = await writeInteraction(rootDir, project, candidate);
          promotionResults.push({ knowledgeType: "INTERACTION", targetId: candidate.targetId, action: result.action, ok: result.action === "record_interaction", reason: result.reason });
        } else if (candidate.knowledgeType === "LOCATOR") {
          // P16.7：canonical writeback——candidate.targetId 保留首个 source（provenance），
          // 最终 element identity 一律用 canonicalTargetId（oldA 证据的 locator 写入 canonicalA，oldA 不得追加）。
          // P16.7 Phase 2：无合法 canonical 解析的候选不 promotion（fail-closed，不伪造 canonical）。
          const canonicalTargetId = candidate.canonicalTargetId;
          if (!canonicalTargetId) {
            promotionResults.push({ knowledgeType: "LOCATOR", targetId: candidate.targetId, action: "error", ok: false, reason: "候选缺少合法 canonical 解析，拒绝 promotion（INVALID_ALIAS fail-closed）" });
            continue;
          }
          const target = byTarget.get(`${candidate.pageId}|${canonicalTargetId}`);
          if (!target) continue;
          const model = (store.models ?? []).find((m) => String(m.pageId) === candidate.pageId);
          const elements = (model?.elements as Array<Record<string, unknown>> | undefined) ?? [];
          const element = elements.find((e) => String(e.elementId) === canonicalTargetId)
            ?? elements.find((e) => {
              const name = String(e.semanticName ?? "");
              // 仅元素具备显式动态展示证据（captured_inventory / dynamicBinding / currentValue）时 opt-in 剥离动态数值。
              return fuzzyMatch(name, canonicalTargetId, { allowDynamicValueStripping: hasExplicitDynamicContext(e) });
            });
          if (!element) continue;
          const strategy = target.newLocator.startsWith("text") ? "text"
            : target.newLocator.startsWith("css") || target.newLocator.startsWith("[") ? "css"
            : target.newLocator.startsWith("role") ? "role" : "unknown";
          const promoted = await promoteLocatorCandidate(rootDir, project, {
            pageId: candidate.pageId,
            elementId: String(element.elementId ?? ""),
            semanticName: String(element.semanticName ?? ""),
            oldLocatorCandidates: (element.locatorCandidates ?? []) as Array<Record<string, unknown>>,
            healedLocator: { strategy, value: target.newLocator, confidence: 0.75, source: "modeling_orchestrator" },
            evidenceIds: target.evidenceIds,
            policyId: "locator.v1",
            policyVersion: 1,
            sourceRunIds: target.sourceRunIds,
            successCount: target.successCount
          });
          promotionResults.push({ knowledgeType: "LOCATOR", targetId: candidate.targetId, action: promoted.action, ok: promoted.ok, reason: promoted.error ?? promoted.action });
        }
      } catch (error) {
        promotionResults.push({ knowledgeType: candidate.knowledgeType, targetId: candidate.targetId, action: "error", ok: false, reason: error instanceof Error ? error.message : String(error) });
      }
    }

    // P16.7 Phase 2：invalid alias 证据的拒入诊断显式暴露为 promotionResults（不静默吞掉）。
    const seenBlocked = new Set<string>();
    for (const blocked of invalidAliasBlocked) {
      if (seenBlocked.has(blocked.evidenceId)) continue;
      seenBlocked.add(blocked.evidenceId);
      promotionResults.push({
        knowledgeType: blocked.knowledgeType,
        targetId: blocked.targetId,
        action: "blocked_invalid_alias",
        ok: false,
        reason: `INVALID_ALIAS：${blocked.resolutionIssue}`
      });
    }
  }

  // ============ REBUILD COVERAGE + PROGRESS（P6.4 14-15 / P6.6） ============
  const gapsBefore = gaps.length;
  const matchedBefore = plans.length;
  const verifiedBefore = snapshot.projectSummary.elementsByStatus.VERIFIED ?? 0;
  const snapshotAfter = await buildCoverageSnapshot(rootDir, project);
  const gapReportAfter = await buildExplorationGaps(rootDir, project, snapshotAfter);
  const gapsAfter = gapReportAfter.totalGaps;
  const matchedAfter = gapReportAfter.gaps.length;
  const verifiedAfter = snapshotAfter.projectSummary.elementsByStatus.VERIFIED ?? 0;
  const unresolvedUnknown = snapshotAfter.pages.reduce((sum, p) => sum + p.elements.filter((e) => !e.controlType || e.controlType === "unknown").length, 0);

  const progress = computeProgress({
    iteration: session.iteration,
    gapsBefore,
    gapsAfter,
    matchedBefore,
    matchedAfter,
    verifiedBefore,
    verifiedAfter,
    newEvidence: evidenceIds.length,
    promotedKnowledge: promotionResults.filter((r) => r.ok).length,
    reviewCandidates: reviewRequests.length,
    unresolvedUnknown,
    riskBlocked: 0,
    exploredPlans: executedFingerprints
  });

  return { progress, executedFingerprints, evidenceIds, gaps, plans: selected, promotionResults, reviewRequests };
}

function evaluateStopConditions(
  session: ModelingSession,
  iteration: IterationResult,
  context: { startTime: number; noProgressStreak: number }
): { stop: boolean; reason?: StopReason; detail?: string } {
  const budgets = session.budgets;
  // F. budget：maxIterations
  if (session.iteration >= budgets.maxIterations) {
    return { stop: true, reason: "budget_reached", detail: `达到 maxIterations=${budgets.maxIterations}` };
  }
  // E. review 已在 runIteration 返回前处理（WAITING_FOR_REVIEW）
  // A. 无 LOW-risk plannable gap
  if (iteration.plans.length === 0) {
    return { stop: true, reason: "no_plannable_low_risk", detail: "本轮无 LOW-risk plannable gap" };
  }
  // B/C. 连续两轮无改善（NO_PROGRESS）
  if (iteration.progress.progressed === false && context.noProgressStreak >= 1) {
    return { stop: true, reason: "no_progress", detail: "连续两轮无真实改善（gap/verified/new evidence/promoted）" };
  }
  // D. 只剩 MEDIUM/HIGH/FORBIDDEN（plans 已只含 LOW，故此处等价于无 LOW plan——见 A）
  // G. restore failure（runIteration 已设 stopReason）
  if (session.stopReason === "restore_failure") {
    return { stop: true, reason: "restore_failure", detail: session.stopDetail };
  }
  // F. budget：maxDurationMs
  if (Date.now() - context.startTime > budgets.maxDurationMs) {
    return { stop: true, reason: "budget_reached", detail: "达到 maxDurationMs" };
  }
  return { stop: false };
}

function fuzzyMatch(a: string, b: string, options: IdentityNormalizeOptions = {}): boolean {
  return isSameDynamicLocatorIdentity(a, b, options);
}

/**
 * P6.1：heuristic 声明的 preconditions 与当前页面事实是否满足。
 * 缺省未声明前置 → true（保持旧行为）；已声明但事实不满足 → false（不选该 plan）。
 * 避免 planner 反复选中注定失败的 plan（如无 dialog 页面反复 open_modal）。
 */
function heuristicPreconditionsMet(
  heuristic: { preconditions: string[] },
  pageModel: Record<string, unknown> | undefined,
  session: ModelingSession
): boolean {
  const preconditions = heuristic.preconditions ?? [];
  if (preconditions.length === 0) return true;
  const dialogCount = Number(session.initialCapture?.dialogCount ?? 0)
    || (Array.isArray(pageModel?.dialogs) ? (pageModel!.dialogs as unknown[]).length : 0);
  const elementCount = (Array.isArray(pageModel?.elements) ? (pageModel!.elements as unknown[]).length : 0);
  for (const precondition of preconditions) {
    switch (precondition) {
      case "expected_dialog":
        // modal.open_close 前置：页面必须存在 dialog 证据，否则不该反复尝试打开弹窗。
        if (dialogCount <= 0) return false;
        break;
      case "dependent_elements":
        // 依赖观察前置：页面需有多个元素才可能观察依赖关系。
        if (elementCount < 2) return false;
        break;
      case "element_locator":
        // 元素可定位由 gap.hasElementLocator 保证；此处不再额外拦截。
        break;
      case "account_precondition_unmet":
        // 需要账号前置不满足才能观察阻断态；建模会话默认不判定，放行由 executor 观察结果决定。
        break;
      default:
        // 未识别的 precondition 不拦截（保守放行）。
        break;
    }
  }
  return true;
}
