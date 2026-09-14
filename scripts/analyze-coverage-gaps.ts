import fs from "fs-extra";
import path from "node:path";
import { analyzeCoverageGaps, renderCoverageGapReport } from "../src/workbench/coverage-gap-engine.js";

const args = process.argv.slice(2);
function argValue(name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

const project = argValue("project");
if (!project) {
  console.error("Usage: tsx scripts/analyze-coverage-gaps.ts --project <project> [--save]");
  process.exit(1);
}

try {
  const rootDir = process.cwd();
  const report = await analyzeCoverageGaps(rootDir, project);
  if (argValue("save") !== undefined || args.includes("--save")) {
    const outPath = path.join(rootDir, "reports", `coverage-gaps-${project}.json`);
    const mdPath = path.join(rootDir, "reports", `coverage-gaps-${project}.md`);
    await fs.ensureDir(path.dirname(outPath));
    await fs.writeJson(outPath, report, { spaces: 2 });
    await fs.writeFile(mdPath, renderCoverageGapReport(report), "utf8");
    console.log(JSON.stringify({
      reportPath: path.relative(rootDir, outPath).replace(/\\/g, "/"),
      totalPages: report.totalPages,
      totalCapabilities: report.totalCapabilities,
      covered: report.covered,
      partial: report.partial,
      uncovered: report.uncovered,
      coveragePercent: report.coveragePercent
    }, null, 2));
  } else {
    console.log(renderCoverageGapReport(report));
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
