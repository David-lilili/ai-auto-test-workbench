import path from "node:path";
import { parseArgs } from "node:util";
import fs from "fs-extra";
import { analyzeAssertionRootCauses } from "../src/core/assertion-root-cause.js";

/**
 * P5.9：knowledge:assertion-root-cause —— 失败断言根因分析（只读）。
 * 用法: npx tsx scripts/assertion-root-cause.ts [--project demo]
 */

const options = parseArgs({
  args: process.argv.slice(2),
  options: {
    project: { type: "string", default: "demo" }
  }
});

const rootDir = path.resolve(".");
const report = analyzeAssertionRootCauses(rootDir, options.values.project);

console.log("=== Assertion Root-Cause Analysis ===\n");
console.log(`project: ${options.values.project} | failed assertions: ${report.totalFailures}`);
console.log(`\n按根因:`);
for (const [rc, count] of Object.entries(report.byRootCause).sort((a, b) => b[1] - a[1])) {
  if (count === 0) continue;
  console.log(`  ${rc}: ${count}`);
}
console.log(`\n按修复建议类别:`);
for (const [cat, count] of Object.entries(report.byRemediation).sort((a, b) => b[1] - a[1])) {
  if (count === 0) continue;
  console.log(`  ${cat}: ${count}`);
}

console.log("\n明细（前 20 条）:");
for (const item of report.items.slice(0, 20)) {
  console.log(`  [${item.rootCause}] ${item.caseId} | ${item.assertionType} | ${item.target.slice(0, 50)}`);
}

await fs.ensureDir(path.join(rootDir, "reports"));
await fs.writeJson(path.join(rootDir, "reports/assertion-root-cause.json"), report, { spaces: 2 });
console.log("\n报告: reports/assertion-root-cause.json");
