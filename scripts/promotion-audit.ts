import fs from "node:fs";
import path from "node:path";
import {
  aggregateEvidence,
  decidePromotion
} from "../src/core/knowledge-promotion-policy.js";
import { collectAllKnowledgeEvidence } from "../src/core/knowledge-evidence-collector.js";

/**
 * P4-B15 / P5.4：knowledge:promotion-audit
 * 消费 unified evidence sink + pending proposals + P4-A normalization + P3-B exploration runs，
 * 统一聚合为 knowledge candidates 并按 policy 分级。
 * 只读 + 生成报告（真实 writeback 由 knowledge:writeback 分发执行）。
 */

const rootDir = process.cwd();

async function main() {
  // ============ 1. 统一证据收集（P5.4：与 dispatcher 同一口径） ============
  const { evidenceList, sourceCounts } = await collectAllKnowledgeEvidence(rootDir, "demo");
  const pendingDir = path.join(rootDir, "storage/proposals/pending");
  const proposalFiles = fs.existsSync(pendingDir) ? fs.readdirSync(pendingDir).filter(f => f.endsWith(".json")) : [];

  // ============ 2. aggregation + decision ============
  const candidates = aggregateEvidence(evidenceList);
  const decisions = new Map<string, ReturnType<typeof decidePromotion>>();

  const byDecision: Record<string, number> = { AUTO_PROMOTE: 0, REVIEW: 0, KEEP_PENDING: 0, CONFLICT: 0, REJECT: 0 };
  const byTypeDistribution: Record<string, { raw: number; unique: number; auto: number; review: number; conflict: number }> = {};

  for (const [key, candidate] of candidates) {
    const decision = decidePromotion(candidate);
    decisions.set(key, decision);
    byDecision[decision.decision]++;
    const type = candidate.knowledgeType;
    if (!byTypeDistribution[type]) byTypeDistribution[type] = { raw: 0, unique: 0, auto: 0, review: 0, conflict: 0 };
    byTypeDistribution[type].unique++;
    byTypeDistribution[type].raw += candidate.evidence.length;
    if (decision.decision === "AUTO_PROMOTE") byTypeDistribution[type].auto++;
    else if (decision.decision === "CONFLICT") byTypeDistribution[type].conflict++;
    else if (decision.decision === "REVIEW") byTypeDistribution[type].review++;
  }

  // ============ 3. 输出 ============
  console.log("=== Knowledge Promotion Audit ===\n");
  console.log(`TOTAL RAW PROPOSALS: ${proposalFiles.length}`);
  console.log(`UNIQUE KNOWLEDGE CANDIDATES: ${candidates.size}`);
  console.log(`DUPLICATE COLLAPSED: ${evidenceList.length - candidates.size}`);
  console.log(`\n证据来源: sink=${sourceCounts.sink} proposals=${sourceCounts.proposals} normalization=${sourceCounts.normalization} exploration_runs=${sourceCounts.explorationRuns}`);
  console.log(`\n按 decision 分布: ${JSON.stringify(byDecision)}`);
  console.log(`\n按 knowledgeType:`);
  for (const [type, dist] of Object.entries(byTypeDistribution).sort((a, b) => b[1].raw - a[1].raw)) {
    console.log(`  ${type}: raw=${dist.raw} unique=${dist.unique} auto=${dist.auto} review=${dist.review} conflict=${dist.conflict}`);
  }

  console.log(`\nNORMALIZATION: raw=${sourceCounts.normalization}`);
  const normCandidates = [...candidates.values()].filter(c => c.knowledgeType === "CONTROL_TYPE");
  console.log(`  unique=${normCandidates.length}`);
  console.log(`  auto=${normCandidates.filter(c => decisions.get(c.knowledgeKey)?.decision === "AUTO_PROMOTE").length}`);
  console.log(`  review=${normCandidates.filter(c => decisions.get(c.knowledgeKey)?.decision === "REVIEW").length}`);

  console.log(`\nLOCATOR:`);
  const locCandidates = [...candidates.values()].filter(c => c.knowledgeType === "LOCATOR");
  console.log(`  raw proposal=${proposalFiles.filter(f => JSON.parse(fs.readFileSync(path.join(pendingDir, f), "utf8")).proposalType === "element_locator_update").length}`);
  console.log(`  unique=${locCandidates.length}`);
  console.log(`  auto=${locCandidates.filter(c => decisions.get(c.knowledgeKey)?.decision === "AUTO_PROMOTE").length}`);
  console.log(`  review=${locCandidates.filter(c => decisions.get(c.knowledgeKey)?.decision === "REVIEW").length}`);
  console.log(`  conflict=${locCandidates.filter(c => decisions.get(c.knowledgeKey)?.decision === "CONFLICT").length}`);
  console.log(`  insufficient=${locCandidates.filter(c => decisions.get(c.knowledgeKey)?.decision === "KEEP_PENDING").length}`);
  const autoLocators = locCandidates.filter(c => decisions.get(c.knowledgeKey)?.decision === "AUTO_PROMOTE");
  if (autoLocators.length) {
    console.log(`  AUTO_PROMOTE 明细:`);
    autoLocators.forEach(c => {
      const d = decisions.get(c.knowledgeKey);
      console.log(`    ${c.pageId} | ${c.targetId} → ${c.normalizedValue} (success=${c.successCount})`);
      console.log(`      reasons: ${(d?.reasons ?? []).join("; ")}`);
    });
  }

  console.log(`\nASSERTION:`);
  const assertCandidates = [...candidates.values()].filter(c => c.knowledgeType === "ASSERTION");
  console.log(`  raw proposal=${proposalFiles.filter(f => JSON.parse(fs.readFileSync(path.join(pendingDir, f), "utf8")).proposalType?.startsWith("assertion")).length}`);
  console.log(`  unique=${assertCandidates.length}`);
  console.log(`  auto=0（policy 硬规定）`);
  console.log(`  review=${assertCandidates.filter(c => decisions.get(c.knowledgeKey)?.decision === "REVIEW").length}`);
  console.log(`  conflict=${assertCandidates.filter(c => decisions.get(c.knowledgeKey)?.decision === "CONFLICT").length}`);

  console.log(`\nEXPLORATION: runs=${sourceCounts.explorationRuns}`);
  const exploreCandidates = [...candidates.values()].filter(c => c.evidence.some(e => e.sourceType === "CONTROLLED_EXPLORATION"));
  console.log(`  knowledge candidates=${exploreCandidates.length}`);
  exploreCandidates.forEach(c => {
    const d = decisions.get(c.knowledgeKey);
    console.log(`  ${c.targetId.slice(0, 45)} → ${d?.decision} (${d?.reasons[0]?.slice(0, 60)})`);
  });

  console.log(`\nSECURITY: auto=0（policy 硬规定一律 review）`);
  const secCandidates = [...candidates.values()].filter(c => c.knowledgeType === "SECURITY_REQUIREMENT");
  console.log(`  unique=${secCandidates.length} | 全部 REVIEW=${secCandidates.every(c => decisions.get(c.knowledgeKey)?.decision === "REVIEW")}`);

  fs.writeFileSync(path.join(rootDir, "reports/knowledge-promotion-audit.json"), JSON.stringify({
    totalRawProposals: proposalFiles.length,
    uniqueCandidates: candidates.size,
    duplicateCollapsed: evidenceList.length - candidates.size,
    sourceCounts,
    byDecision,
    byType: byTypeDistribution,
    candidates: [...candidates.values()].map(c => ({
      knowledgeKey: c.knowledgeKey,
      knowledgeType: c.knowledgeType,
      pageId: c.pageId,
      targetId: c.targetId,
      normalizedValue: c.normalizedValue,
      evidenceCount: c.evidence.length,
      successCount: c.successCount,
      failureCount: c.failureCount,
      contradictionCount: c.contradictionCount,
      freshness: c.freshness,
      evidenceConfidence: c.evidenceConfidence,
      decision: decisions.get(c.knowledgeKey)?.decision,
      reasons: decisions.get(c.knowledgeKey)?.reasons
    }))
  }, null, 2));
  console.log("\n报告: reports/knowledge-promotion-audit.json");
}

await main();
