import { draftCaseAssetsFromPageModels } from "../src/workbench/case-asset-drafter.js";

const args = process.argv.slice(2);
function argValue(name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

const project = argValue("project");
const env = argValue("env");
if (!project || !env) {
  console.error("Usage: tsx scripts/draft-case-assets.ts --project <project> --env <env> [--pages pageId1,pageId2] [--timeout-ms 60000]");
  process.exit(1);
}

const pages = argValue("pages")?.split(",").map((item) => item.trim()).filter(Boolean);
try {
  const result = await draftCaseAssetsFromPageModels({
    rootDir: process.cwd(),
    project,
    env,
    pageFilter: pages,
    timeoutMs: argValue("timeout-ms") ? Number(argValue("timeout-ms")) : undefined
  });
  console.log(JSON.stringify({
    runId: result.runId,
    draftPath: result.draftPath,
    totalPages: result.totalPages,
    draftedPages: result.draftedPages,
    failedPages: result.failedPages,
    skippedPages: result.skippedPages,
    totalCases: result.totalCases
  }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
