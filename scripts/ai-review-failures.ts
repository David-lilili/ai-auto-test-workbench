import path from "node:path";
import fs from "fs-extra";
import { reviewFailure } from "../src/core/ai-assistant.js";
import type { CaseResult } from "../src/core/types.js";
import { writeSafeJsonFile } from "../src/core/safe-file-writer.js";

const resultPath = path.join(process.cwd(), "artifacts", "logs", "latest-results.json");
if (!(await fs.pathExists(resultPath))) {
  console.log("No latest result found. Run tests first.");
  process.exit(0);
}

const payload = await fs.readJson(resultPath) as { results: CaseResult[] };
const failed = payload.results.filter((item) => item.status === "failed");
const reviews = failed.map((item) => ({ id: item.id, ...reviewFailure(item) }));
await writeSafeJsonFile(path.join(process.cwd(), "reports", "ai-summary", "latest-failure-review.json"), reviews);
console.table(reviews);
