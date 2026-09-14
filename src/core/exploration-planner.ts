import { HEURISTIC_REGISTRY, type ExplorationHeuristic } from "./exploration-heuristics.js";
import { heuristicActionsExecutable } from "./interaction-matrix.js";

/**
 * Gap → Heuristic Matcher（P3-B1）：deterministic 第一层匹配，无 LLM。
 *
 * 匹配依据（按顺序过滤）：
 *   1. triggerGapSources 与 gap.source 精确匹配
 *   2. appliesTo 与 gap 的 controlType 匹配（或 gap 无控件类型时按维度白名单）
 *   3. Applicability Matrix：candidateActions 对该控件必须有可执行项
 *      （NOT_APPLICABLE 动作被过滤；全部 NOT_APPLICABLE 则该 heuristic 不适用）
 *   4. heuristic preconditions 的证据可得性（第一版：element_locator 类前置
 *      要求 gap 带元素定位信息）
 *
 * 输出 NO_MATCH 是合法结果——不为覆盖率强行匹配。
 */

export interface GapForMatching {
  gapId: string;
  pageId: string;
  dimension: "element" | "interaction" | "state" | "dependency";
  target: string;
  source: string;
  /** 元素类 gap 的控件类型（来自 Page Model controlType）。 */
  controlType?: string;
  /** gap 是否携带可定位的元素信息。 */
  hasElementLocator?: boolean;
}

export interface MatchedHeuristic {
  heuristicId: string;
  heuristicVersion: number;
  applicabilityScore: number;
  reasons: string[];
  rejectedActions?: string[];
  conditionalActions?: Array<{ action: string; condition: string }>;
}

export interface MatchResult {
  gapId: string;
  matched: MatchedHeuristic[];
  verdict: "MATCHED" | "MULTI_MATCH" | "NO_MATCH" | "NOT_APPLICABLE";
}

/** 无控件类型的 gap（state/dependency 维度）允许的 heuristic 维度白名单。 */
const NON_ELEMENT_DIMENSION_WHITELIST = new Set(["state_transition_gap"]);

export function matchHeuristicsForGap(
  gap: GapForMatching,
  pageModel?: Record<string, unknown>,
  registry: ExplorationHeuristic[] = HEURISTIC_REGISTRY
): MatchResult {
  const controlType = gap.controlType ?? inferControlTypeFromPageModel(gap, pageModel);
  const matched: MatchedHeuristic[] = [];

  for (const heuristic of registry) {
    const reasons: string[] = [];
    let score = 0;

    // 1. triggerGapSources
    if (!heuristic.triggerGapSources.includes(gap.source)) continue;
    reasons.push(`gap source '${gap.source}' 命中 triggerGapSources`);
    score += 0.4;

    // 2. appliesTo（元素类 gap 必须有控件类型匹配；无控件类型的 state gap 走白名单）
    if (gap.dimension === "element" || controlType) {
      if (!controlType || !heuristic.appliesTo.includes(controlType)) continue;
      reasons.push(`控件类型 '${controlType}' 命中 appliesTo`);
      score += 0.3;
    } else {
      if (!NON_ELEMENT_DIMENSION_WHITELIST.has(gap.source)) continue;
      reasons.push(`非元素 gap（${gap.dimension}）经维度白名单放行`);
      score += 0.2;
    }

    // 3. Applicability Matrix 过滤
    if (controlType) {
      const actionCheck = heuristicActionsExecutable(controlType, heuristic.candidateActions);
      if (actionCheck.executable.length === 0 && actionCheck.conditional.length === 0) {
        continue;
      }
      if (actionCheck.notApplicable.length) {
        reasons.push(`过滤 NOT_APPLICABLE 动作: ${actionCheck.notApplicable.join(", ")}`);
      }
      if (actionCheck.conditional.length) {
        reasons.push(`CONDITIONAL 动作: ${actionCheck.conditional.map((item) => item.action).join(", ")}`);
      }
      score += 0.2;
      // P6.0：全 CONDITIONAL 动作的 heuristic 也应保留（conditional 动作由 plan builder 纳入，
      // 并经 risk gate 把关；之前只保留 executable 会把 modal.open_close 对 link 的匹配丢弃）。
      if (actionCheck.executable.length > 0 || actionCheck.conditional.length > 0) {
        matched.push({
          heuristicId: heuristic.id,
          heuristicVersion: heuristic.version,
          applicabilityScore: Number(score.toFixed(2)),
          reasons,
          rejectedActions: actionCheck.notApplicable,
          conditionalActions: actionCheck.conditional
        });
      }
    } else {
      matched.push({
        heuristicId: heuristic.id,
        heuristicVersion: heuristic.version,
        applicabilityScore: Number(score.toFixed(2)),
        reasons
      });
    }
  }

  matched.sort((a, b) => b.applicabilityScore - a.applicabilityScore || a.heuristicId.localeCompare(b.heuristicId));
  const verdict: MatchResult["verdict"] = matched.length === 0
    ? (controlType ? "NO_MATCH" : "NOT_APPLICABLE")
    : matched.length === 1
      ? "MATCHED"
      : "MULTI_MATCH";
  return { gapId: gap.gapId, matched, verdict };
}

/** 从 Page Model 元素推断控件类型（gap 无显式 controlType 时）。 */
function inferControlTypeFromPageModel(gap: GapForMatching, pageModel?: Record<string, unknown>): string | undefined {
  if (!pageModel) return undefined;
  const elements = Array.isArray(pageModel.elements) ? pageModel.elements as Array<Record<string, unknown>> : [];
  const element = elements.find((item) => String(item.elementId ?? "") === gap.target);
  if (!element) return undefined;
  const controlType = String(element.controlType ?? "");
  return controlType || undefined;
}

// ==================== P3-B3/B4/B5：Plan / Risk Gate / Fingerprint ====================

import { classifyRisk } from "./exploration-risk-policy.js";
import crypto from "node:crypto";

export type PlanRisk = "LOW" | "MEDIUM" | "HIGH" | "FORBIDDEN";

export interface PlanStep {
  stepId: string;
  action: string;
  targetElementId?: string;
  params?: Record<string, unknown>;
  observationTargets: string[];
  risk: PlanRisk;
}

export interface ExplorationPlan {
  planId: string;
  gapId: string;
  pageId: string;
  heuristicId: string;
  heuristicVersion: number;
  target: string;
  preconditions: string[];
  steps: PlanStep[];
  observations: string[];
  restoreSteps: PlanStep[];
  stopConditions: string[];
  risk: PlanRisk;
  estimatedCost: "LOW" | "MEDIUM" | "HIGH";
  expectedEvidence: string[];
  fingerprint: string;
  status: "PLANNED" | "BLOCKED_BY_RISK";
  /** risk gate 拒绝时的理由。 */
  blockedReason?: string;
}

/** Risk Gate（P3-B4）：消费共享 risk policy，priority 与 risk 分离。 */
export function gatePlanRisk(heuristicId: string, actions: string[]): { risk: PlanRisk; reason: string } {
  const text = `${heuristicId} ${actions.join(" ")}`;
  const level = classifyRisk(text);
  if (level === "forbidden") return { risk: "FORBIDDEN", reason: "动作语义命中 FORBIDDEN 词表（真实资金/删除/安全配置）" };
  if (level === "high") return { risk: "HIGH", reason: "动作语义命中 HIGH 风险词表（withdraw/transfer/delete 等）" };
  if (level === "medium") return { risk: "MEDIUM", reason: "动作语义命中 MEDIUM 风险词表（submit/save/create 等）" };
  return { risk: "LOW", reason: "动作语义无风险词命中" };
}

/** Fingerprint（P3-B5）：稳定探索指纹（page identity + gap + heuristic@version + target + preconditions）。 */
export function buildExplorationFingerprint(input: {
  pageId: string;
  pageSignature?: string;
  gapId: string;
  heuristicId: string;
  heuristicVersion: number;
  target: string;
  preconditions: string[];
}): string {
  const raw = JSON.stringify({
    pageId: input.pageId,
    pageSignature: input.pageSignature ?? "",
    gapId: input.gapId,
    heuristicId: input.heuristicId,
    heuristicVersion: input.heuristicVersion,
    target: input.target,
    preconditions: [...input.preconditions].sort()
  });
  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 32);
}

/** Plan Builder（P3-B3）：deterministic 基础计划，不执行任何动作。 */
export function buildExplorationPlan(input: {
  gap: GapForMatching;
  pageId: string;
  heuristic: ExplorationHeuristic;
  pageModel?: Record<string, unknown>;
  pageSignature?: string;
}): ExplorationPlan {
  const heuristic = input.heuristic;
  const gate = gatePlanRisk(heuristic.id, heuristic.candidateActions);
  const controlType = input.gap.controlType ?? inferControlTypeFromPageModel(input.gap, input.pageModel);
  const actionCheck = controlType ? heuristicActionsExecutable(controlType, heuristic.candidateActions) : { executable: heuristic.candidateActions, conditional: [], notApplicable: [] };

  // 只用 APPLICABLE + CONDITIONAL 动作构建步骤；NOT_APPLICABLE 被矩阵过滤。
  const planActions = [...actionCheck.executable, ...actionCheck.conditional.map((item) => item.action)];
  const steps: PlanStep[] = planActions.map((action, index) => ({
    stepId: `${heuristic.id.replace(/\./g, "_")}_step${index + 1}`,
    action,
    targetElementId: input.gap.dimension === "element" ? input.gap.target : undefined,
    params: {},
    observationTargets: heuristic.observations,
    risk: gate.risk
  }));

  // restore 步骤从 restoreStrategy 派生（deterministic 映射）
  const restoreSteps: PlanStep[] = deriveRestoreSteps(heuristic.restoreStrategy, input.gap.target, steps.length);

  const fingerprint = buildExplorationFingerprint({
    pageId: input.pageId,
    pageSignature: input.pageSignature,
    gapId: input.gap.gapId,
    heuristicId: heuristic.id,
    heuristicVersion: heuristic.version,
    target: input.gap.target,
    preconditions: heuristic.preconditions
  });

  return {
    planId: `plan_${fingerprint.slice(0, 12)}`,
    gapId: input.gap.gapId,
    pageId: input.pageId,
    heuristicId: heuristic.id,
    heuristicVersion: heuristic.version,
    target: input.gap.target,
    preconditions: heuristic.preconditions,
    steps,
    observations: heuristic.observations,
    restoreSteps,
    stopConditions: heuristic.stopConditions,
    risk: gate.risk,
    estimatedCost: heuristic.riskClass === "LOW" ? "LOW" : heuristic.riskClass === "MEDIUM" ? "MEDIUM" : "HIGH",
    expectedEvidence: [
      `interaction_observation:${heuristic.id}`,
      `element_observation:${input.gap.target}`,
      ...heuristic.observations.map((observation) => `observation:${observation}`)
    ],
    fingerprint,
    status: gate.risk === "LOW" || gate.risk === "MEDIUM" ? "PLANNED" : "BLOCKED_BY_RISK",
    blockedReason: gate.risk === "HIGH" || gate.risk === "FORBIDDEN" ? gate.reason : undefined
  };
}

function deriveRestoreSteps(strategy: string, target: string, offset: number): PlanStep[] {
  const step = (action: string, index: number): PlanStep => ({
    stepId: `restore_${index + 1}`,
    action,
    targetElementId: target || undefined,
    params: {},
    observationTargets: ["restored_state"],
    risk: "LOW"
  });
  switch (strategy) {
    case "clear_to_original":
      return [step("clear", 0)];
    case "reselect_original_value":
      return [step("restore_original", 0)];
    case "close_dropdown":
      return [step("close_dropdown", 0)];
    case "close_modal":
      return [step("close_modal", 0)];
    case "click_original_tab":
      return [step("click_original_tab", 0)];
    case "toggle_back":
      return [step("interact_toggle_back", 0)];
    case "restore_original_value":
      return [step("restore", 0)];
    case "none_read_only":
      return [];
    default:
      return [];
  }
}
