import { Command } from "commander";
import { loadContext } from "../src/core/config-loader.js";
import type { ExplorationMode, WebSurface } from "../src/core/types.js";
import { WebPageExplorer } from "../src/exploration/web-page-explorer.js";

const program = new Command();

program
  .requiredOption("--url <url>", "start web url")
  .option("--project <project>", "project key", "demo")
  .option("--env <env>", "environment", "test")
  .option("--mode <mode>", "readOnly | safeForm | sandboxWrite | fullExploration", "readOnly")
  .option("--max-depth <depth>", "max BFS depth")
  .option("--max-pages <pages>", "max pages to visit")
  .option("--surface <surface>", "site | spotAdmin", "site")
  .option("--login-required <value>", "true | false", "true")
  .option("--username <username>", "login username")
  .option("--password <password>", "login password")
  .option("--headed", "run with visible browser", false)
  .option("--hold-seconds <seconds>", "keep browser open after exploration")
  .option("--max-button-clicks-per-page <count>", "max non-link button clicks per page", "8")
  .option("--click-buttons", "try clicking safe non-link buttons", false);

program.parse();
const opts = program.opts();
const context = await loadContext({ project: opts.project, env: opts.env });
const explorer = new WebPageExplorer(context);

const result = await explorer.explore({
  startUrl: opts.url,
  mode: opts.mode as ExplorationMode,
  maxDepth: opts.maxDepth ? Number(opts.maxDepth) : context.project.exploration?.maxDepth ?? 3,
  maxPages: opts.maxPages ? Number(opts.maxPages) : context.project.exploration?.maxPages ?? 50,
  headed: Boolean(opts.headed),
  holdSeconds: opts.holdSeconds ? Number(opts.holdSeconds) : undefined,
  clickButtons: Boolean(opts.clickButtons),
  maxButtonClicksPerPage: opts.maxButtonClicksPerPage ? Number(opts.maxButtonClicksPerPage) : undefined,
  surface: opts.surface as WebSurface,
  login: {
    required: String(opts.loginRequired).toLowerCase() !== "false",
    username: opts.username,
    password: opts.password
  }
});

console.table([result]);
