import path from "node:path";
import { parseArgs } from "node:util";
import { writeReviewProjection } from "../src/core/review-candidate-projection.js";
import { loadReviewDecisions } from "../src/core/knowledge-review-lifecycle.js";

/**
 * P5.8 / P5.11：knowledge:review-projection —— REVIEW candidate 投影（只读）。
 * 把 REVIEW 决策的候选投影为人工 review 队列（JSON + MD），并自动排除已 REJECTED 的候选。
 * 不做写回。人工在队列里 approve / reject 后由 knowledge:review-decision 记录。
 *
 * 用法: npx tsx scripts/review-candidate-projection.ts [--project demo]
 */

const options = parseArgs({
  args: process.argv.slice(2),
  options: {
    project: { type: "string", default: "demo" },
    out: { type: "string", default: "reports" }
  }
});

const rootDir = path.resolve(".");
const decisions = await loadReviewDecisions(rootDir, options.values.project);
const rejectedKeys = new Set(decisions.filter((d) => d.decision === "REJECTED").map((d) => d.knowledgeKey));
const projection = await writeReviewProjection(rootDir, options.values.project, path.join(rootDir, options.values.out), { excludeKeys: rejectedKeys });

const bySuggestion: Record<string, number> = {};
for (const item of projection.items) bySuggestion[item.suggestedAction] = (bySuggestion[item.suggestedAction] ?? 0) + 1;

console.log("=== Review Candidate Projection ===\n");
console.log(`project: ${projection.project}`);
console.log(`total candidates: ${projection.totalCandidates}`);
console.log(`decisions: ${JSON.stringify(projection.byDecision)}`);
console.log(`REVIEW items: ${projection.items.length}`);
console.log(`suggested actions: ${JSON.stringify(bySuggestion)}`);

if (projection.items.length) {
  console.log("\n按 suggestedAction 的 TOP 项:");
  for (const item of projection.items.slice(0, 15)) {
    console.log(`  [${item.suggestedAction}] ${item.knowledgeType} | ${item.pageId} | ${item.targetId} → ${item.normalizedValue}`);
  }
  if (projection.items.length > 15) console.log(`  ... 其余 ${projection.items.length - 15} 项见报告`);
}

console.log("\n报告: reports/review-candidates.json / .md");
