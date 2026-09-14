import fs from "fs-extra";
import path from "node:path";
import { collectAllKnowledgeEvidence } from "./knowledge-evidence-collector.js";
import { aggregateEvidence } from "./knowledge-promotion-policy.js";
import { writeControlType, writeInteraction, buildLocatorTargets } from "./knowledge-writeback-dispatcher.js";
import { promoteLocatorCandidate } from "./locator-promotion.js";
import { pageModelsOf, resolveTargetIdsSafe } from "./element-alias-wiring.js";
import { logger } from "./logger.js";
import { isSameDynamicLocatorIdentity, hasExplicitDynamicContext, type IdentityNormalizeOptions } from "./locator-identity-normalizer.js";

/**
 * P5.10-P5.11：Knowledge Candidate Lifecycle（REVIEW → 人工决策 → 应用/搁置）。
 *
 * 铁律（延续用户约束）：
 *   - Assertion / Security 永不 auto-promote：即使人工 APPROVED，也只记录决策，
 *     不进入 writeback（writeback 只接受 LOCATOR/CONTROL_TYPE/INTERACTION）；
 *   - 人工 APPROVED 是 REVIEW 候选推进为写回的唯一通道（决策带 decidedBy + note + 时间）；
 *   - REJECTED 候选被记忆，后续 projection 不再重复推荐；
 *   - KEEP_PENDING 保留在队列。
 *
 * 存储：storage/knowledge-review/<project>.json（knowledgeKey 幂等覆盖）。
 */

export type ReviewDecisionType = "APPROVED" | "REJECTED" | "KEEP_PENDING";

export interface ReviewDecision {
  knowledgeKey: string;
  knowledgeType: string;
  pageId: string;
  targetId: string;
  normalizedValue: string;
  decision: ReviewDecisionType;
  decidedBy: "human" | "system";
  note?: string;
  decidedAt: string;
}

export interface ReviewDecisionResult {
  ok: boolean;
  decision: ReviewDecision;
  error?: string;
}

export interface LifecycleApplyResult {
  project: string;
  approvedCount: number;
  applied: Array<{ knowledgeKey: string; knowledgeType: string; targetId: string; action: string; ok: boolean; reason?: string }>;
  blocked: Array<{ knowledgeKey: string; knowledgeType: string; reason: string }>;
}

function reviewStorePath(rootDir: string, project: string): string {
  return path.join(rootDir, "storage", "knowledge-review", `${project}.json`);
}

export async function loadReviewDecisions(rootDir: string, project: string): Promise<ReviewDecision[]> {
  const storePath = reviewStorePath(rootDir, project);
  if (!(await fs.pathExists(storePath))) return [];
  return (await fs.readJson(storePath)).decisions ?? [];
}

/** 幂等记录决策（同 knowledgeKey 覆盖旧决策）。 */
export async function recordReviewDecision(rootDir: string, project: string, input: Omit<ReviewDecision, "decidedAt">): Promise<ReviewDecisionResult> {
  const storePath = reviewStorePath(rootDir, project);
  const existing = await loadReviewDecisions(rootDir, project);
  const decision: ReviewDecision = { ...input, decidedAt: new Date().toISOString() };
  const filtered = existing.filter((item) => item.knowledgeKey !== input.knowledgeKey);
  filtered.push(decision);
  await fs.ensureDir(path.dirname(storePath));
  await fs.writeJson(storePath, { project, updatedAt: new Date().toISOString(), decisions: filtered }, { spaces: 2 });
  logger.info("Review decision recorded", { knowledgeKey: input.knowledgeKey, decision: input.decision, decidedBy: input.decidedBy });
  return { ok: true, decision };
}

const PROMOTABLE_TYPES = new Set(["LOCATOR", "CONTROL_TYPE", "INTERACTION"]);

/**
 * 应用人工批准的 REVIEW 候选。
 * 对每个 APPROVED 决策：重建完整 candidate（带 evidence）→ 调用对应写回器。
 * LOCATOR 走修复型 target 配对（与 dispatcher 同口径），其余走 knowledgeKey 聚合候选。
 */
export async function applyApprovedReviews(rootDir: string, project: string): Promise<LifecycleApplyResult> {
  const decisions = await loadReviewDecisions(rootDir, project);
  const approved = decisions.filter((d) => d.decision === "APPROVED");
  if (approved.length === 0) {
    return { project, approvedCount: 0, applied: [], blocked: [] };
  }

  const collected = await collectAllKnowledgeEvidence(rootDir, project);
  const storePath = path.join(rootDir, "storage", "page-models", `${project}.json`);
  const store = fs.pathExistsSync(storePath) ? await fs.readJson(storePath) as { models?: Array<Record<string, unknown>> } : { models: [] };
  // P16.7：alias-aware 聚合（与 dispatcher 同口径）——旧 id 证据与 canonical id 证据合并为同一 candidate/target。
  const pageModels = pageModelsOf(store);
  const candidates = aggregateEvidence(collected.evidenceList, pageModels);
  const locatorTargets = buildLocatorTargets(collected.evidenceList, pageModels);
  const byTargetId = new Map(locatorTargets.map((t) => [`${t.pageId}|${t.targetId}`, t]));

  const results: LifecycleApplyResult["applied"] = [];
  const blocked: LifecycleApplyResult["blocked"] = [];
  const appliedKeys = new Set<string>();

  for (const decision of approved) {
    if (!PROMOTABLE_TYPES.has(decision.knowledgeType)) {
      blocked.push({ knowledgeKey: decision.knowledgeKey, knowledgeType: decision.knowledgeType, reason: `${decision.knowledgeType} 不参与自动 writeback（policy 硬规定，仅记录决策）` });
      continue;
    }

    // P16.7 Phase 2 fail-closed：人工 APPROVED 也不能绕过 alias integrity——
    // 决策 target 的 alias 无法合法解析（环 / self alias / canonical 缺失 / 链断裂）时
    // 拒绝写回并保留确定性诊断；绝不回退写旧 source element。
    const resolution = resolveTargetIdsSafe(pageModels.get(decision.pageId), decision.targetId);
    if (!resolution.resolved) {
      blocked.push({ knowledgeKey: decision.knowledgeKey, knowledgeType: decision.knowledgeType, reason: `INVALID_ALIAS：${resolution.resolutionIssue ?? "alias 解析失败"}` });
      continue;
    }

    try {
      if (decision.knowledgeType === "CONTROL_TYPE") {
        const candidate = [...candidates.values()].find(
          (c) => c.knowledgeType === "CONTROL_TYPE" && c.knowledgeKey === decision.knowledgeKey
        );
        if (!candidate) {
          blocked.push({ knowledgeKey: decision.knowledgeKey, knowledgeType: "CONTROL_TYPE", reason: "聚合候选不存在" });
          continue;
        }
        const result = await writeControlType(rootDir, project, candidate, { humanApproved: true });
        results.push({ knowledgeKey: decision.knowledgeKey, knowledgeType: "CONTROL_TYPE", targetId: decision.targetId, action: result.action, ok: result.action === "fill_control_type", reason: result.reason });
        if (result.action === "fill_control_type") appliedKeys.add(decision.knowledgeKey);
      } else if (decision.knowledgeType === "INTERACTION") {
        const candidate = [...candidates.values()].find(
          (c) => c.knowledgeType === "INTERACTION" && c.knowledgeKey === decision.knowledgeKey
        );
        if (!candidate) {
          blocked.push({ knowledgeKey: decision.knowledgeKey, knowledgeType: "INTERACTION", reason: "聚合候选不存在" });
          continue;
        }
        const result = await writeInteraction(rootDir, project, candidate);
        results.push({ knowledgeKey: decision.knowledgeKey, knowledgeType: "INTERACTION", targetId: decision.targetId, action: result.action, ok: result.action === "record_interaction", reason: result.reason });
        if (result.action === "record_interaction") appliedKeys.add(decision.knowledgeKey);
      } else if (decision.knowledgeType === "LOCATOR") {
        // P16.7：人工批准的 source targetId 先解析为 canonical——locator 最终写 canonical 元素，
        // old 元素不追加；provenance（决策 targetId / sourceTargetId）保留原值。
        // 非法 alias 已在上方 guard 拦截（resolution.resolved=false 时不会到达这里）。
        const canonicalTargetId = resolution.canonicalTargetId as string;
        const target = byTargetId.get(`${decision.pageId}|${canonicalTargetId}`);
        if (!target) {
          blocked.push({ knowledgeKey: decision.knowledgeKey, knowledgeType: "LOCATOR", reason: "无修复型 target 配对（SELF_HEALING 证据不足或非修复型）" });
          continue;
        }
        const model = (store.models ?? []).find((m) => String(m.pageId) === decision.pageId);
        const elements = (model?.elements as Array<Record<string, unknown>> | undefined) ?? [];
        const element = elements.find((e) => String(e.elementId) === canonicalTargetId)
          ?? elements.find((e) => {
            const name = String(e.semanticName ?? "");
            // 仅元素具备显式动态展示证据（captured_inventory / dynamicBinding / currentValue）时 opt-in 剥离动态数值。
            return fuzzyMatch(name, canonicalTargetId, { allowDynamicValueStripping: hasExplicitDynamicContext(e) });
          });
        if (!element) {
          blocked.push({ knowledgeKey: decision.knowledgeKey, knowledgeType: "LOCATOR", reason: `semantic target「${decision.targetId}」未建模` });
          continue;
        }
        const strategy = target.newLocator.startsWith("text") ? "text"
          : target.newLocator.startsWith("css") || target.newLocator.startsWith("[") ? "css"
          : target.newLocator.startsWith("role") ? "role" : "unknown";
        const promoted = await promoteLocatorCandidate(rootDir, project, {
          pageId: decision.pageId,
          elementId: String(element.elementId ?? ""),
          semanticName: String(element.semanticName ?? ""),
          oldLocatorCandidates: (element.locatorCandidates ?? []) as Array<Record<string, unknown>>,
          healedLocator: { strategy, value: target.newLocator, confidence: 0.75, source: "human_approved_review" },
          evidenceIds: target.evidenceIds,
          policyId: "locator.v1",
          policyVersion: 1,
          sourceRunIds: target.sourceRunIds,
          successCount: target.successCount
        });
        results.push({ knowledgeKey: decision.knowledgeKey, knowledgeType: "LOCATOR", targetId: decision.targetId, action: promoted.action, ok: promoted.ok, reason: promoted.error ?? promoted.action });
        if (promoted.ok) appliedKeys.add(decision.knowledgeKey);
      }
    } catch (error) {
      blocked.push({ knowledgeKey: decision.knowledgeKey, knowledgeType: decision.knowledgeType, reason: `写回异常: ${error instanceof Error ? error.message : String(error)}` });
    }
  }

  // 已应用的 APPROVED 决策从队列移除（避免重复应用）；REJECTED/KEEP_PENDING 保留。
  if (appliedKeys.size) {
    const remaining = await loadReviewDecisions(rootDir, project);
    const updated = remaining.filter((d) => !(appliedKeys.has(d.knowledgeKey) && d.decision === "APPROVED"));
    await fs.ensureDir(path.dirname(reviewStorePath(rootDir, project)));
    await fs.writeJson(reviewStorePath(rootDir, project), { project, updatedAt: new Date().toISOString(), decisions: updated }, { spaces: 2 });
  }

  return { project, approvedCount: approved.length, applied: results, blocked };
}

function fuzzyMatch(a: string, b: string, options: IdentityNormalizeOptions = {}): boolean {
  return isSameDynamicLocatorIdentity(a, b, options);
}
