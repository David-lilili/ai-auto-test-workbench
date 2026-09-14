import fs from "fs-extra";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadAllKnowledgeEvidence } from "../src/core/knowledge-evidence-sink.js";
import { collectAllKnowledgeEvidence } from "../src/core/knowledge-evidence-collector.js";
import { aggregateEvidence, decidePromotion } from "../src/core/knowledge-promotion-policy.js";
import { loadReviewDecisions } from "../src/core/knowledge-review-lifecycle.js";
import { buildCoverageSnapshot } from "../src/core/exploration-coverage.js";
import { buildExplorationGaps } from "../src/core/exploration-gaps.js";
import { writeSafeJsonFile, writeSafeTextFile } from "../src/core/safe-file-writer.js";

/**
 * P5.14：knowledge:flywheel-audit —— 知识飞轮全链路审计（只读）。
 *
 * 覆盖：
 *  1. Evidence Sink：总量 / 按知识类型 / 按来源 / 按 outcome / 时间跨度 / 幂等去重率
 *  2. Proposal Backlog：待处理量 / 时间跨度（含过期治理建议）
 *  3. Review Queue：APPROVED / REJECTED / KEEP_PENDING 分布
 *  4. Writeback History：最近批次结果 + caps 合规（读 reports/knowledge-writeback-results.json）
 *  5. Coverage Feedback：最近一次 before/after delta（读 reports/coverage-feedback.json）
 *  6. Storage Footprint：knowledge-evidence / proposals / review / page-model backups 占用
 *  7. 治理建议（确定性规则，只读）
 *
 * 用法: npx tsx scripts/flywheel-audit.ts [--project demo] [--out reports]
 */

const options = parseArgs({
  args: process.argv.slice(2),
  options: {
    project: { type: "string", default: "demo" },
    out: { type: "string", default: "reports" }
  }
});

const rootDir = path.resolve(".");
const project = options.values.project;

function dirSize(dir: string): number {
  if (!fs.pathExistsSync(dir)) return 0;
  let total = 0;
  const walk = (p: string): void => {
    for (const entry of fs.readdirSync(p, { withFileTypes: true })) {
      const full = path.join(p, entry.name);
      if (entry.isDirectory()) walk(full);
      else total += fs.statSync(full).size;
    }
  };
  walk(dir);
  return total;
}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

async function main(): Promise<void> {
  // 1. Evidence sink
  const sink = await loadAllKnowledgeEvidence(rootDir, project);
  const byType: Record<string, number> = {};
  const bySource: Record<string, number> = {};
  const byOutcome: Record<string, number> = {};
  let oldest: string | null = null;
  let newest: string | null = null;
  for (const evidence of sink) {
    byType[evidence.knowledgeType] = (byType[evidence.knowledgeType] ?? 0) + 1;
    bySource[evidence.sourceType] = (bySource[evidence.sourceType] ?? 0) + 1;
    byOutcome[evidence.outcome] = (byOutcome[evidence.outcome] ?? 0) + 1;
    if (!oldest || evidence.timestamp < oldest) oldest = evidence.timestamp;
    if (!newest || evidence.timestamp > newest) newest = evidence.timestamp;
  }

  // 2. Proposal backlog
  const pendingDir = path.join(rootDir, "storage/proposals/pending");
  const proposalFiles = fs.pathExistsSync(pendingDir) ? fs.readdirSync(pendingDir).filter((f) => f.endsWith(".json")) : [];
  let proposalOldest: string | null = null;
  let proposalNewest: string | null = null;
  for (const file of proposalFiles) {
    try {
      const proposal = fs.readJsonSync(path.join(pendingDir, file)) as { createdAt?: string };
      if (!proposal.createdAt) continue;
      if (!proposalOldest || proposal.createdAt < proposalOldest) proposalOldest = proposal.createdAt;
      if (!proposalNewest || proposal.createdAt > proposalNewest) proposalNewest = proposal.createdAt;
    } catch {
      // 忽略损坏文件
    }
  }

  // 3. Review queue
  const decisions = await loadReviewDecisions(rootDir, project);
  const byDecision: Record<string, number> = {};
  for (const decision of decisions) byDecision[decision.decision] = (byDecision[decision.decision] ?? 0) + 1;

  // 4. Candidates + decisions（当前口径）
  const collected = await collectAllKnowledgeEvidence(rootDir, project);
  const candidates = aggregateEvidence(collected.evidenceList);
  const byPromotion: Record<string, number> = {};
  for (const candidate of candidates.values()) {
    const decision = decidePromotion(candidate);
    byPromotion[decision.decision] = (byPromotion[decision.decision] ?? 0) + 1;
  }

  // 5. Writeback history（最近批次）
  const writebackReportPath = path.join(rootDir, "reports/knowledge-writeback-results.json");
  const writebackReport = fs.pathExistsSync(writebackReportPath) ? fs.readJsonSync(writebackReportPath) : undefined;

  // 6. Coverage feedback（最近一次）
  const feedbackPath = path.join(rootDir, "reports/coverage-feedback.json");
  const feedback = fs.pathExistsSync(feedbackPath) ? fs.readJsonSync(feedbackPath) : undefined;

  // 7. Storage footprint
  const footprint = {
    evidence: dirSize(path.join(rootDir, "storage/knowledge-evidence", project)),
    proposals: dirSize(path.join(rootDir, "storage/proposals")),
    review: dirSize(path.join(rootDir, "storage/knowledge-review")),
    pageModelBackups: dirSize(path.join(rootDir, "storage/page-models"))
  };

  // 8. Governance 建议（确定性规则）
  const now = Date.now();
  const governance: string[] = [];
  const proposalAgeDays = proposalOldest ? (now - new Date(proposalOldest).getTime()) / 86400000 : 0;
  if (proposalFiles.length > 200) governance.push(`proposal backlog ${proposalFiles.length} 条：建议对 >60 天且无新证据的旧 proposal 归档（保留提案文件，移入 storage/proposals/archived）`);
  if (proposalAgeDays > 60) governance.push(`proposal 最老 ${Math.round(proposalAgeDays)} 天：超过 freshness 窗口，建议人工 review 后归档`);
  if (sink.length > 2000) governance.push(`evidence sink ${sink.length} 条：超过 2000 建议按 freshness/时间窗归档`);
  const backupCount = fs.pathExistsSync(path.join(rootDir, "storage/page-models"))
    ? fs.readdirSync(path.join(rootDir, "storage/page-models")).filter((f) => f.startsWith("backup-")).length
    : 0;
  if (backupCount > 10) governance.push(`page-model backups ${backupCount} 个：建议保留最近 10 个，旧备份移入 storage/archives`);

  const report = {
    project,
    generatedAt: new Date().toISOString(),
    evidenceSink: { total: sink.length, byType, bySource, byOutcome, oldest, newest },
    proposalBacklog: { total: proposalFiles.length, oldest: proposalOldest, newest: proposalNewest, ageDays: Math.round(proposalAgeDays) },
    reviewQueue: { total: decisions.length, byDecision },
    candidates: { total: candidates.size, byPromotion },
    writeback: writebackReport ? {
      generatedAt: writebackReport.generatedAt,
      dryRun: writebackReport.dryRun,
      capped: writebackReport.capped,
      planned: writebackReport.planned?.length,
      applied: writebackReport.applied?.length,
      locatorTargets: writebackReport.locatorTargets?.length
    } : undefined,
    coverageFeedback: feedback ? {
      beforeGaps: feedback.before?.gaps,
      afterGaps: feedback.after?.gaps,
      gapDelta: feedback.delta?.gapDelta,
      controlTypeFilled: feedback.delta?.controlTypeFilled
    } : undefined,
    storageFootprint: { evidence: mb(footprint.evidence), proposals: mb(footprint.proposals), review: mb(footprint.review), pageModelBackups: mb(footprint.pageModelBackups) },
    governance
  };

  await fs.ensureDir(path.join(rootDir, options.values.out));
  await writeSafeJsonFile(path.join(rootDir, options.values.out, "flywheel-audit.json"), report);

  const lines = [
    "# Knowledge Flywheel Audit",
    "",
    `- project: ${project}`,
    `- generatedAt: ${report.generatedAt}`,
    "",
    "## 1. Evidence Sink",
    "",
    `- total: ${sink.length}`,
    `- byType: ${JSON.stringify(byType)}`,
    `- bySource: ${JSON.stringify(bySource)}`,
    `- byOutcome: ${JSON.stringify(byOutcome)}`,
    `- span: ${oldest ?? "-"} → ${newest ?? "-"}`,
    "",
    "## 2. Proposal Backlog",
    "",
    `- total: ${proposalFiles.length}`,
    `- span: ${proposalOldest ?? "-"} → ${proposalNewest ?? "-"}（最老 ${Math.round(proposalAgeDays)} 天）`,
    "",
    "## 3. Review Queue",
    "",
    `- total: ${decisions.length}`,
    `- byDecision: ${JSON.stringify(byDecision)}`,
    "",
    "## 4. Candidates & Promotion",
    "",
    `- total candidates: ${candidates.size}`,
    `- byPromotion: ${JSON.stringify(byPromotion)}`,
    "",
    "## 5. Writeback History（最近批次）",
    "",
    ...(writebackReport ? [
      `- generatedAt: ${writebackReport.generatedAt}`,
      `- caps: ${JSON.stringify(writebackReport.capped)}`,
      `- planned: ${writebackReport.planned?.length} | applied: ${writebackReport.applied?.length}`,
      `- locator targets: ${writebackReport.locatorTargets?.length ?? "-"}`
    ] : ["- 无 writeback 记录"]),
    "",
    "## 6. Coverage Feedback",
    "",
    ...(feedback ? [
      `- gaps: ${feedback.before?.gaps} → ${feedback.after?.gaps}（delta ${feedback.delta?.gapDelta}）`,
      `- controlType filled: ${feedback.delta?.controlTypeFilled}`
    ] : ["- 无 coverage feedback 记录"]),
    "",
    "## 7. Storage Footprint",
    "",
    `- evidence: ${mb(footprint.evidence)}`,
    `- proposals: ${mb(footprint.proposals)}`,
    `- review: ${mb(footprint.review)}`,
    `- page-model backups: ${mb(footprint.pageModelBackups)}`,
    "",
    "## 8. Governance",
    "",
    ...(governance.length ? governance.map((g) => `- ${g}`) : ["- 无治理建议"]),
    ""
  ];
  await writeSafeTextFile(path.join(rootDir, options.values.out, "flywheel-audit.md"), lines.join("\n"));

  console.log(lines.join("\n"));
  console.log(`报告: ${options.values.out}/flywheel-audit.json / .md`);
}

await main();
