import { Command } from "commander";
import { runTests } from "../src/core/test-runner.js";
import type { ExecutionMode, FallbackLevel, RuntimeOptions, TestType } from "../src/core/types.js";

const program = new Command();

program
  .option("--project <project>", "project key", "demo")
  .option("--env <env>", "environment", "test")
  .option("--type <type>", "web | api | app")
  .option("--tags <tags>", "comma separated tags")
  .option("--case <caseId>", "single case id")
  .option("--device-profile <profile>", "app device profile")
  .option("--locales <locales>", "comma separated locales")
  .option("--mode <mode>", "strict | heal | explore | debug", "strict")
  .option("--start-url <url>", "bootstrap_scan start URL")
  .option("--target-flows <flows>", "bootstrap_scan comma separated target flows")
  .option("--max-pages <count>", "bootstrap_scan maximum pages")
  .option("--max-depth <count>", "bootstrap_scan maximum depth")
  .option("--max-paths <count>", "bootstrap_scan maximum paths")
  .option("--max-duration-ms <ms>", "bootstrap_scan maximum duration")
  .option("--allowed-domains <domains>", "bootstrap_scan comma separated allowed domains")
  .option("--denied-patterns <patterns>", "bootstrap_scan comma separated denied URL regex patterns")
  .option("--denied-actions <patterns>", "bootstrap_scan comma separated denied action regex patterns")
  .option("--max-ai-calls <count>", "maximum AI calls per run")
  .option("--max-ai-tokens <count>", "maximum AI tokens per run")
  .option("--max-estimated-cost <usd>", "maximum estimated AI cost per run")
  .option("--max-step-healing-level <level>", "maximum fallback/self-healing level per step")
  .option("--dry-run", "select and validate cases without executing", false);

program.parse();
const opts = program.opts();

const runtime: RuntimeOptions = {
  project: opts.project,
  env: opts.env,
  type: opts.type as TestType | undefined,
  tags: opts.tags ? String(opts.tags).split(",").filter(Boolean) : [],
  caseId: opts.case,
  deviceProfile: opts.deviceProfile,
  locales: opts.locales ? String(opts.locales).split(",").filter(Boolean) : [],
  mode: opts.mode as ExecutionMode,
  maxAiCalls: opts.maxAiCalls ? Number(opts.maxAiCalls) : undefined,
  maxAiTokens: opts.maxAiTokens ? Number(opts.maxAiTokens) : undefined,
  maxEstimatedCost: opts.maxEstimatedCost ? Number(opts.maxEstimatedCost) : undefined,
  maxStepHealingLevel: opts.maxStepHealingLevel ? (Number(opts.maxStepHealingLevel) as FallbackLevel) : undefined,
  startUrl: opts.startUrl,
  targetFlows: opts.targetFlows ? String(opts.targetFlows).split(",").filter(Boolean) : [],
  maxPages: opts.maxPages ? Number(opts.maxPages) : undefined,
  maxDepth: opts.maxDepth ? Number(opts.maxDepth) : undefined,
  maxPaths: opts.maxPaths ? Number(opts.maxPaths) : undefined,
  maxDurationMs: opts.maxDurationMs ? Number(opts.maxDurationMs) : undefined,
  allowedDomains: opts.allowedDomains ? String(opts.allowedDomains).split(",").filter(Boolean) : undefined,
  deniedPatterns: opts.deniedPatterns ? String(opts.deniedPatterns).split(",").filter(Boolean) : undefined,
  deniedActions: opts.deniedActions ? String(opts.deniedActions).split(",").filter(Boolean) : undefined,
  dryRun: Boolean(opts.dryRun)
};

const results = await runTests(runtime);
const failed = results.filter((item) => item.status === "failed");
console.table(results.map(({ id, status, durationMs, error }) => ({ id, status, durationMs, error })));
process.exitCode = failed.length ? 1 : 0;
