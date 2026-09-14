import fs from "fs-extra";
import path from "node:path";
import { collectAllKnowledgeEvidence } from "./knowledge-evidence-collector.js";
import { aggregateEvidence, decidePromotion, type KnowledgeCandidate, type PromotionDecision } from "./knowledge-promotion-policy.js";
import { pageModelsOf, type InvalidAliasBlockedEvidence } from "./element-alias-wiring.js";

/**
 * P5.8：Review Candidate Projection（只读）。
 * 把 REVIEW 决策的知识候选投影成「人工 review 队列」：
 * 每条候选带上证据摘要、缺什么、矛盾/风险、freshness、建议动作。
 * 不做任何写回；供人工在 workbench 或报告中决定 approve / reject / keep_pending。
 */

export interface ReviewProjectionItem {
  knowledgeKey: string;
  knowledgeType: string;
  pageId: string;
  /** 首个 source targetId（provenance，永不被 alias 改写）。 */
  targetId: string;
  /** alias-aware 聚合后的 canonical identity（无 alias 时等于 targetId）。 */
  canonicalTargetId?: string;
  normalizedValue: string;
  decision: PromotionDecision["decision"];
  targetStatus: string;
  reasons: string[];
  missingEvidence: string[];
  contradictions: string[];
  evidenceSummary: {
    total: number;
    success: number;
    failure: number;
    contradiction: number;
    sourceTypes: string[];
    confidence: string;
    freshness: string;
    firstObservedAt: string;
    lastObservedAt: string;
  };
  suggestedAction: "approve_candidate" | "reject_candidate" | "keep_pending_collect_more" | "needs_conflict_resolution";
}

export interface ReviewProjection {
  project: string;
  generatedAt: string;
  totalCandidates: number;
  byDecision: Record<string, number>;
  byType: Record<string, number>;
  items: ReviewProjectionItem[];
  /** P16.7 Phase 2：invalid alias 证据 fail-closed 审计——不投影为可批准候选，只留诊断。 */
  invalidAliasBlocked: InvalidAliasBlockedEvidence[];
}

export function suggestAction(candidate: KnowledgeCandidate, decision: PromotionDecision): ReviewProjectionItem["suggestedAction"] {
  if (decision.decision === "CONFLICT") return "needs_conflict_resolution";
  if (decision.decision === "REJECT") return "reject_candidate";
  if (decision.missingEvidence.length > 0) return "keep_pending_collect_more";
  if (candidate.successCount === 0 && candidate.failureCount === 0) return "keep_pending_collect_more";
  return "approve_candidate";
}

export function buildReviewProjection(rootDir: string, project: string, options?: { excludeKeys?: Set<string> }): Promise<ReviewProjection> {
  return (async () => {
    const collected = await collectAllKnowledgeEvidence(rootDir, project);
    // P16.7：alias-aware 聚合——old id 与 canonical id 证据合并为同一 review candidate
    // （identity / grouping 走 canonical，UI 仍可展示 source targetId）。
    // P16.7 Phase 2：invalid alias 证据 fail-closed——不投影为候选，收集到 invalidAliasBlocked 审计。
    const storePath = path.join(rootDir, "storage", "page-models", `${project}.json`);
    const store = fs.pathExistsSync(storePath) ? await fs.readJson(storePath) as { models?: Array<Record<string, unknown>> } : { models: [] };
    const invalidAliasBlocked: InvalidAliasBlockedEvidence[] = [];
    const candidates = aggregateEvidence(collected.evidenceList, pageModelsOf(store), invalidAliasBlocked);
    const excludeKeys = options?.excludeKeys ?? new Set<string>();

    const byDecision: Record<string, number> = {};
    const byType: Record<string, number> = {};
    const items: ReviewProjectionItem[] = [];

    for (const candidate of candidates.values()) {
      const decision = decidePromotion(candidate);
      byDecision[decision.decision] = (byDecision[decision.decision] ?? 0) + 1;
      byType[candidate.knowledgeType] = (byType[candidate.knowledgeType] ?? 0) + 1;

      if (decision.decision !== "REVIEW") continue;
      if (excludeKeys.has(candidate.knowledgeKey)) continue; // REJECTED 不再重复推荐

      const sourceTypes = [...new Set(candidate.evidence.map((e) => e.sourceType))];
      items.push({
        knowledgeKey: candidate.knowledgeKey,
        knowledgeType: candidate.knowledgeType,
        pageId: candidate.pageId,
        targetId: candidate.targetId,
        canonicalTargetId: candidate.canonicalTargetId,
        normalizedValue: candidate.normalizedValue,
        decision: decision.decision,
        targetStatus: decision.targetStatus,
        reasons: decision.reasons,
        missingEvidence: decision.missingEvidence,
        contradictions: decision.contradictions,
        evidenceSummary: {
          total: candidate.evidence.length,
          success: candidate.successCount,
          failure: candidate.failureCount,
          contradiction: candidate.contradictionCount,
          sourceTypes,
          confidence: candidate.evidenceConfidence,
          freshness: candidate.freshness,
          firstObservedAt: candidate.firstObservedAt,
          lastObservedAt: candidate.lastObservedAt
        },
        suggestedAction: suggestAction(candidate, decision)
      });
    }

    // 排序：人工最关心的在前（矛盾 → 缺证据的 → 纯新增 → 其余）
    const priority = { needs_conflict_resolution: 0, keep_pending_collect_more: 1, approve_candidate: 2, reject_candidate: 3 } as const;
    items.sort((a, b) => priority[a.suggestedAction] - priority[b.suggestedAction] || b.evidenceSummary.total - a.evidenceSummary.total);

    return {
      project,
      generatedAt: new Date().toISOString(),
      totalCandidates: candidates.size,
      byDecision,
      byType,
      items,
      invalidAliasBlocked
    };
  })();
}

export function renderReviewReport(projection: ReviewProjection): string {
  const lines = [
    "# Knowledge Review Queue",
    "",
    `- project: ${projection.project}`,
    `- generatedAt: ${projection.generatedAt}`,
    `- total candidates: ${projection.totalCandidates}`,
    `- decisions: ${JSON.stringify(projection.byDecision)}`,
    `- REVIEW items: ${projection.items.length}`,
    "",
    "## 按类型",
    "",
    ...Object.entries(projection.byType).map(([type, count]) => `- ${type}: ${count}`),
    ""
  ];

  if (projection.items.length === 0) {
    lines.push("（当前无 REVIEW 候选）", "");
    return lines.join("\n");
  }

  for (const item of projection.items) {
    lines.push(
      `### ${item.knowledgeType} | ${item.targetId}`,
      "",
      `- pageId: \`${item.pageId}\``,
      `- observedValue: \`${item.normalizedValue}\``,
      `- suggestedAction: **${item.suggestedAction}**`,
      `- evidence: ${item.evidenceSummary.total}（success=${item.evidenceSummary.success} failure=${item.evidenceSummary.failure} contradiction=${item.evidenceSummary.contradiction}）sources=[${item.evidenceSummary.sourceTypes.join(", ")}]`,
      `- confidence: ${item.evidenceSummary.confidence} | freshness: ${item.evidenceSummary.freshness}`,
      "",
      "  reasons:",
      ...item.reasons.map((r) => `  - ${r}`),
      ""
    );
    if (item.missingEvidence.length) {
      lines.push("  missing:", ...item.missingEvidence.map((m) => `  - ${m}`), "");
    }
    if (item.contradictions.length) {
      lines.push("  contradictions:", ...item.contradictions.map((c) => `  - ${c}`), "");
    }
  }

  if (projection.invalidAliasBlocked.length) {
    lines.push(
      "",
      "## Invalid Alias Blocked（fail-closed）",
      "",
      ...projection.invalidAliasBlocked.map((b) => `- ${b.knowledgeType} | ${b.targetId} | ${b.evidenceId} | ${b.resolutionIssue}`),
      ""
    );
  }
  return lines.join("\n");
}

/** 只读入口：把 REVIEW 队列落盘（报告 + JSON），不做任何写回。 */
export async function writeReviewProjection(rootDir: string, project: string, outDir: string, options?: { excludeKeys?: Set<string> }): Promise<ReviewProjection> {
  const projection = await buildReviewProjection(rootDir, project, options);
  await fs.ensureDir(outDir);
  await fs.writeJson(path.join(outDir, "review-candidates.json"), projection, { spaces: 2 });
  await fs.writeFile(path.join(outDir, "review-candidates.md"), renderReviewReport(projection), "utf8");
  return projection;
}
