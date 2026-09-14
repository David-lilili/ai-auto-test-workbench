import { recordKnowledgeEvidence } from "./knowledge-evidence-sink.js";
import type { ExplorationRun } from "./exploration-executor.js";
import { logger } from "./logger.js";

/**
 * P6.8：Controlled Exploration → Unified Evidence Sink 自动接线。
 *
 * Post-P5 Audit 确认的断链：exploration-executor 只写 storage/exploration-runs/，
 * 不写 unified evidence sink。本模块把「受控探索成功」的 run 映射为 KnowledgeEvidence
 * 并调用 recordKnowledgeEvidence()（幂等、可审计、进 P4-B promotion 聚合）。
 *
 * 严格 scope（P6.8）：
 *   - 仅 COMPLETED_CLEANLY（restore=SUCCESS）产生 auto-promotable evidence；
 *   - restore != SUCCESS 的 run：不产生 INTERACTION 成功证据（可记录 observation 但 outcome=failure）；
 *   - evidence 只描述"观察到的交互/控件/状态"，不做业务推断。
 */

export type ExplorationEvidenceKind = "INTERACTION" | "CONTROL_TYPE" | "STATE" | "DEPENDENCY";

/** 从 exploration run 的观察产物推断 evidence 类型（确定性，无 LLM）。 */
export function inferEvidenceKind(run: ExplorationRun): ExplorationEvidenceKind {
  const actions = run.steps.map((s) => s.action);
  if (actions.includes("open_dropdown") || actions.includes("select_alternative") || actions.includes("capture_options")) {
    return "INTERACTION";
  }
  // P6.1：capture_enabled_state 观察的是"按钮可观察/可交互状态"，不是控件类型判定。
  // 映射为 INTERACTION（CONTROLLED_EXPLORATION 成功 → 交互可观察证据，可参与 INTERACTION auto-promote），
  // 而非 CONTROL_TYPE（其 policy 要求 NORMALIZATION source，探索证据永远无法晋升 → 飞轮断链）。
  if (actions.includes("capture_enabled_state")) {
    return "INTERACTION";
  }
  if (actions.includes("click_non_current_tab") || actions.includes("interact_toggle")) {
    return "CONTROL_TYPE";
  }
  if (actions.includes("capture_block_state") || actions.includes("open_modal")) {
    return "STATE";
  }
  if (actions.includes("observe_dependents") || actions.includes("change_value")) {
    return "DEPENDENCY";
  }
  return "INTERACTION";
}

/** 从 run 的观察记录提取 targetId（元素级）。 */
export function extractRunTargetId(run: ExplorationRun): string {
  const observation = run.observations?.[0] as Record<string, unknown> | undefined;
  const target = String(observation?.targetElementId ?? observation?.elementId ?? run.gapId ?? "");
  if (target.includes(":element:")) return target.split(":element:")[1];
  return target;
}

/** 把单个 exploration run 记录进 unified sink（幂等）。 */
export async function recordExplorationRunEvidence(rootDir: string, project: string, run: ExplorationRun): Promise<{ evidenceId?: string; knowledgeType?: string; skipped: boolean; reason?: string }> {
  const kind = inferEvidenceKind(run);
  const targetId = extractRunTargetId(run);
  const cleanlyDone = run.status === "COMPLETED_CLEANLY";

  if (!cleanlyDone) {
    // P6.8：restore != SUCCESS → 不产生 auto-promotable interaction evidence。
    // 记录一条 failure observation 供审计（不参与 auto-promote）。
    const failureValue = `exploration:${run.heuristicId}:${run.status}`;
    await recordKnowledgeEvidence(rootDir, {
      project,
      knowledgeType: kind,
      pageId: run.pageId,
      targetId: targetId || run.gapId,
      sourceType: "CONTROLLED_EXPLORATION",
      sourceRunId: run.runId,
      sourceGapId: run.gapId,
      heuristicId: run.heuristicId,
      heuristicVersion: run.heuristicVersion,
      observation: {
        status: run.status,
        restore: run.restoreResult,
        failure: run.failure,
        steps: run.steps.map((s) => s.action)
      },
      confidence: "LOW",
      pageSignature: String(run.after?.visibleTextHash ?? run.before?.visibleTextHash ?? ""),
      observedValue: failureValue,
      outcome: "failure"
    }).catch((error) => {
      logger.warn("Exploration failure evidence sink failed (non-blocking)", { runId: run.runId, error: error instanceof Error ? error.message : String(error) });
    });
    return { skipped: true, reason: `restore=${run.restoreResult}，不产生 auto-promotable evidence（已记录 failure observation）` };
  }

  try {
    const observedValue = `interaction:${run.heuristicId}`;
    const result = await recordKnowledgeEvidence(rootDir, {
      project,
      knowledgeType: kind,
      pageId: run.pageId,
      targetId: targetId || run.gapId,
      sourceType: "CONTROLLED_EXPLORATION",
      sourceRunId: run.runId,
      sourceGapId: run.gapId,
      heuristicId: run.heuristicId,
      heuristicVersion: run.heuristicVersion,
      observation: {
        status: run.status,
        restore: run.restoreResult,
        steps: run.steps.map((s) => s.action),
        optionCount: (run.observations?.[0] as Record<string, unknown> | undefined)?.optionCount,
        enabledState: (run.observations?.[0] as Record<string, unknown> | undefined)?.button_enabled
      },
      confidence: run.status === "COMPLETED_CLEANLY" ? "HIGH" : "MEDIUM",
      pageSignature: String(run.after?.visibleTextHash ?? ""),
      observedValue,
      outcome: "success"
    });
    return { evidenceId: result.evidenceId, knowledgeType: kind, skipped: false };
  } catch (error) {
    logger.warn("Exploration evidence sink failed (non-blocking)", { runId: run.runId, error: error instanceof Error ? error.message : String(error) });
    return { skipped: true, reason: "sink 写入失败" };
  }
}
