import { Command } from "commander";
import { loadContext } from "../src/core/config-loader.js";
import type { ExplorationMode } from "../src/core/types.js";
import { AndroidAppExplorer } from "../src/exploration/android-app-explorer.js";

const program = new Command();

program
  .requiredOption("--app-package <package>", "Android app package name")
  .option("--app-activity <activity>", "Android launch activity")
  .option("--apk <apk>", "apk path to install before exploration")
  .option("--device-id <deviceId>", "adb device id")
  .option("--project <project>", "project key", "demo")
  .option("--env <env>", "environment", "test")
  .option("--mode <mode>", "readOnly | safeForm | sandboxWrite | fullExploration", "readOnly")
  .option("--max-depth <depth>", "max BFS depth", "2")
  .option("--max-pages <pages>", "max screens to visit", "30");

program.parse();
const opts = program.opts();
const context = await loadContext({ project: opts.project, env: opts.env });
const explorer = new AndroidAppExplorer(context);

const result = await explorer.explore({
  deviceId: opts.deviceId,
  apk: opts.apk,
  appPackage: opts.appPackage,
  appActivity: opts.appActivity,
  mode: opts.mode as ExplorationMode,
  maxDepth: Number(opts.maxDepth),
  maxPages: Number(opts.maxPages)
});

console.table([result]);
