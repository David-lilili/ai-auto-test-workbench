import path from "node:path";
import { parseArgs } from "node:util";
import fs from "fs-extra";
import {
  recordReviewDecision,
  applyApprovedReviews,
  loadReviewDecisions
} from "../src/core/knowledge-review-lifecycle.js";

/**
 * P5.10-P5.11：knowledge:review-decision —— 人工 review 决策 + 应用。
 *
 * 用法:
 *   npx tsx scripts/review-decision.ts list [--project demo]
 *   npx tsx scripts/review-decision.ts record --key <knowledgeKey> --decision APPROVED|REJECTED|KEEP_PENDING [--note "说明"] [--project demo]
 *   npx tsx scripts/review-decision.ts apply [--project demo]     # 应用所有 APPROVED（只允许 LOCATOR/CONTROL_TYPE/INTERACTION）
 */

const rootDir = path.resolve(".");

function baseOptions(): { project: string } {
  const parsed = parseArgs({
    args: process.argv.slice(2),
    options: { project: { type: "string", default: "demo" } },
    allowPositionals: true,
    strict: false
  });
  return { project: String(parsed.values.project ?? "demo") };
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const project = baseOptions().project;

  if (command === "list") {
    const decisions = await loadReviewDecisions(rootDir, project);
    console.log("=== Review Decisions ===\n");
    if (!decisions.length) { console.log("（空）"); return; }
    for (const d of decisions) {
      console.log(`  [${d.decision}] ${d.knowledgeType} | ${d.targetId} | ${d.normalizedValue.slice(0, 50)}${d.note ? ` | note: ${d.note}` : ""} (${d.decidedAt})`);
    }
    return;
  }

  if (command === "record") {
    const parsed = parseArgs({
      args: process.argv.slice(2),
      options: {
        project: { type: "string", default: "demo" },
        key: { type: "string" },
        decision: { type: "string" },
        note: { type: "string", default: "" },
        "knowledge-type": { type: "string", default: "" },
        "page-id": { type: "string", default: "" },
        "target-id": { type: "string", default: "" },
        value: { type: "string", default: "" }
      },
      allowPositionals: true,
      strict: false
    });
    const v = parsed.values;
    const key = String(v.key ?? "");
    const decisionValue = String(v.decision ?? "");
    if (!key || !decisionValue || !["APPROVED", "REJECTED", "KEEP_PENDING"].includes(decisionValue)) {
      console.error("用法: review-decision record --key <key> --decision APPROVED|REJECTED|KEEP_PENDING [--note ...] [--knowledge-type LOCATOR] [--page-id ...] [--target-id ...] [--value ...]");
      process.exit(2);
    }
    const result = await recordReviewDecision(rootDir, project, {
      knowledgeKey: key,
      knowledgeType: String(v["knowledge-type"] ?? "") || "UNKNOWN",
      pageId: String(v["page-id"] ?? ""),
      targetId: String(v["target-id"] ?? ""),
      normalizedValue: String(v.value ?? ""),
      decision: decisionValue as "APPROVED" | "REJECTED" | "KEEP_PENDING",
      decidedBy: "human",
      note: v.note ? String(v.note) : undefined
    });
    console.log(result.ok ? `✓ 已记录 ${decisionValue}: ${key}` : `✗ ${result.error}`);
    return;
  }

  if (command === "apply") {
    const result = await applyApprovedReviews(rootDir, project);
    console.log("=== Apply Approved Reviews ===\n");
    console.log(`approved: ${result.approvedCount} | applied: ${result.applied.length} | blocked: ${result.blocked.length}`);
    for (const a of result.applied) {
      console.log(`  ${a.ok ? "✓" : "·"} ${a.knowledgeType} | ${a.targetId} | ${a.action}${a.reason ? ` (${a.reason})` : ""}`);
    }
    for (const b of result.blocked) {
      console.log(`  ✗ ${b.knowledgeType} | ${b.reason}`);
    }
    await fs.writeJson(path.join(rootDir, "reports/knowledge-review-apply.json"), result, { spaces: 2 });
    console.log("\n报告: reports/knowledge-review-apply.json");
    return;
  }

  console.error("用法: review-decision list | record ... | apply");
  process.exit(2);
}

await main();
