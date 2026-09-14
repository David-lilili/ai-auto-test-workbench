import path from "node:path";
import { loadCaptureRunConfig } from "../src/capture/config-loader.js";
import { runCapture } from "../src/capture/runner.js";

const args = process.argv.slice(2);
const configFlagIndex = args.indexOf("--config");
const configPath = configFlagIndex >= 0 ? args[configFlagIndex + 1] : undefined;
if (!configPath) {
  console.error("Usage: tsx scripts/run-capture.ts --config <capture-run.yaml> [--headed]");
  process.exit(1);
}

try {
  const config = await loadCaptureRunConfig(path.resolve(configPath));
  const outcome = await runCapture({ rootDir: process.cwd(), config });
  console.log(JSON.stringify(outcome, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
