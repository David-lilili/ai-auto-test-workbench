import { Command } from "commander";
import fs from "fs-extra";
import { loadContext } from "../src/core/config-loader.js";
import { BootstrapScanner } from "../src/bootstrap/bootstrap-scanner.js";
import type { Platform } from "../src/core/types.js";

const program = new Command();

program
  .option("--project <project>", "project key", "demo")
  .option("--env <env>", "environment", "test")
  .option("--platform <platform>", "web | android | ios", "web")
  .option("--start-url <url>", "web start URL")
  .option("--start-activity <activity>", "mobile start activity")
  .option("--appium-server-url <url>", "Appium server URL")
  .option("--appium-session-id <sessionId>", "existing Appium session id")
  .option("--target-flows <flows>", "comma separated target flows")
  .option("--max-pages <count>", "maximum pages", "20")
  .option("--max-depth <count>", "maximum depth", "2")
  .option("--max-paths <count>", "maximum paths", "30")
  .option("--max-duration-ms <ms>", "maximum duration in milliseconds")
  .option("--allowed-domains <domains>", "comma separated allowed domains")
  .option("--denied-patterns <patterns>", "comma separated denied URL regex patterns")
  .option("--denied-actions <patterns>", "comma separated denied action regex patterns")
  .option("--max-ai-calls <count>", "maximum AI calls")
  .option("--max-ai-tokens <count>", "maximum AI tokens")
  .option("--dry-run-only", "do not click non-link controls", true)
  .option("--allow-actions", "allow safe click actions during scan", false)
  .option("--require-human-approval-before-submit", "block submit-like actions", true)
  .option("--headed", "show browser window", false)
  .option("--login-required", "use configured bypass login before web scan", false)
  .option("--username <username>", "account username for bypass login")
  .option("--password <password>", "account password for bypass login")
  .option("--replay <scanId>", "replay/dry-run validate staging DSL for scan id")
  .option("--promote <scanId>", "promote approved and replay-passed staging assets")
  .option("--approve <scanId>", "mark staging assets approved for a scan id")
  .option("--import-review <file>", "import manual/AI review result file")
  .option("--scan-id <scanId>", "scan id for import-review");
program.option("--preflight", "check bootstrap_scan readiness without scanning", false);

program.parse();
const opts = program.opts();

const context = await loadContext({ project: opts.project, env: opts.env });
const scanner = new BootstrapScanner(context);

if (opts.replay) {
  const result = await scanner.replay(String(opts.replay));
  console.log(JSON.stringify({ replay: result }, null, 2));
  process.exit(result.failed > 0 ? 1 : 0);
}

if (opts.promote) {
  const result = await scanner.promote(String(opts.promote));
  console.log(JSON.stringify({ promote: result }, null, 2));
  process.exit(0);
}

if (opts.importReview) {
  const scanId = String(opts.scanId ?? "");
  if (!scanId) throw new Error("--scan-id is required with --import-review.");
  const filePath = String(opts.importReview);
  const result = await scanner.importCodexReviewResult({
    scanId,
    filePath,
    rawText: await fs.readFile(filePath, "utf8")
  });
  console.log(JSON.stringify({ importReview: result }, null, 2));
  process.exit(0);
}

if (opts.approve) {
  const { BootstrapScanStore } = await import("../src/memory/bootstrap-scan-store.js");
  await new BootstrapScanStore(context).markReviewStatus(String(opts.approve), "approved");
  console.log(JSON.stringify({ approved: opts.approve }, null, 2));
  process.exit(0);
}

const startUrl = opts.startUrl || context.env.web?.baseUrl;
const scanOptions = {
  projectId: context.project.projectKey,
  platform: String(opts.platform) as Platform,
  env: context.env.env,
  startUrl,
  startActivity: opts.startActivity,
  appiumServerUrl: opts.appiumServerUrl,
  appiumSessionId: opts.appiumSessionId,
  targetFlows: parseList(opts.targetFlows),
  maxPages: Number(opts.maxPages ?? 20),
  maxDepth: Number(opts.maxDepth ?? 2),
  maxPaths: Number(opts.maxPaths ?? 30),
  maxDurationMs: opts.maxDurationMs ? Number(opts.maxDurationMs) : undefined,
  allowedDomains: parseList(opts.allowedDomains || domainFromUrl(startUrl)),
  deniedPatterns: parseList(opts.deniedPatterns),
  deniedActions: parseList(
    opts.deniedActions ||
      "withdraw,payment,pay,delete,transfer,submit order,place order,提现,支付,删除,转账,提交订单,下单,修改权限,资金设置"
  ),
  maxAiCalls: opts.maxAiCalls ? Number(opts.maxAiCalls) : undefined,
  maxAiTokens: opts.maxAiTokens ? Number(opts.maxAiTokens) : undefined,
  dryRunOnly: opts.allowActions ? false : Boolean(opts.dryRunOnly),
  requireHumanApprovalBeforeSubmit: Boolean(opts.requireHumanApprovalBeforeSubmit),
  headed: Boolean(opts.headed),
  loginRequired: Boolean(opts.loginRequired),
  username: opts.username,
  password: opts.password
};

if (opts.preflight) {
  const result = await scanner.preflight(scanOptions);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}

const result = await scanner.scan(scanOptions);

console.log(
  JSON.stringify(
    {
      scanId: result.run.scan_id,
      status: result.run.status,
      summary: result.run.summary,
      storagePath: result.storagePath,
      reviewPackage: result.reviewPackage.package_path,
      prompt: result.reviewPackage.prompt_md_path
    },
    null,
    2
  )
);
process.exit(result.run.status === "failed" ? 1 : 0);

function parseList(value: unknown): string[] {
  return String(value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function domainFromUrl(value?: string): string {
  if (!value) return "";
  try {
    return new URL(value).hostname;
  } catch {
    return "";
  }
}
