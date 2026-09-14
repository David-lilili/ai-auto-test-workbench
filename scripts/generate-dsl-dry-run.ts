import { loadContext } from "../src/core/config-loader.js";
import { generateDslRuleDryRun, type DslRuleDryRunResult } from "../src/core/dsl-rule-dry-run.js";
import { writeSafeJsonFile, writeSafeTextFile } from "../src/core/safe-file-writer.js";

interface CliOptions {
  project?: string;
  env?: string;
  request?: string;
  applyRules?: boolean;
  out?: string;
  report?: string;
}

const options = parseArgs(process.argv.slice(2));
if (!options.project || !options.env || !options.request) {
  console.error("Usage: npx tsx scripts/generate-dsl-dry-run.ts --project <project> --env <env> --request <text> [--apply-rules] [--out <json>] [--report <md>]");
  process.exit(2);
}

const context = await loadContext({ project: options.project, env: options.env });
const result = await generateDslRuleDryRun({
  context,
  request: options.request,
  applyRules: Boolean(options.applyRules)
});

if (options.out) await writeSafeJsonFile(options.out, result);
if (options.report) await writeSafeTextFile(options.report, renderReport(result));

console.log(JSON.stringify({
  ruleFilePath: result.ruleFilePath,
  loadedRuleIds: result.loadedRuleIds,
  appliedRuleIds: result.appliedRuleIds,
  diff: result.diff,
  startsBrowser: result.executionPolicy.startsBrowser,
  executesBusiness: result.executionPolicy.executesBusiness
}, null, 2));

function renderReport(result: DslRuleDryRunResult): string {
  const countBefore = result.beforeDsl.steps.find((step) => step.targetField === "red_packet_count");
  const countAfter = result.afterDsl.steps.find((step) => step.targetField === "red_packet_count");
  return [
    "# 阶段 2.6 DSL Rule Integration Dry-run 报告",
    "",
    "## 输入需求",
    "",
    result.request,
    "",
    "## 规则读取",
    "",
    `- 规则文件: \`${result.ruleFilePath}\``,
    `- 已加载规则: ${result.loadedRuleIds.length ? result.loadedRuleIds.map((id) => `\`${id}\``).join(", ") : "无"}`,
    `- 已命中规则: ${result.appliedRuleIds.length ? result.appliedRuleIds.map((id) => `\`${id}\``).join(", ") : "无"}`,
    "",
    "## 修复前 DSL 摘要",
    "",
    "```json",
    JSON.stringify({
      semanticName: countBefore?.semanticName,
      targetField: countBefore?.targetField,
      value: countBefore?.value,
      valueSource: countBefore?.valueSource
    }, null, 2),
    "```",
    "",
    "## 修复后 DSL 摘要",
    "",
    "```json",
    JSON.stringify({
      semanticName: countAfter?.semanticName,
      targetField: countAfter?.targetField,
      value: countAfter?.value,
      valueSource: countAfter?.valueSource,
      appliedRuleId: countAfter?.appliedRuleId
    }, null, 2),
    "```",
    "",
    "## DSL Diff",
    "",
    "```json",
    JSON.stringify(result.diff, null, 2),
    "```",
    "",
    "## 执行边界",
    "",
    "- 是否启动浏览器: no",
    "- 是否执行用例: no",
    "- 是否写主存储: no",
    "- 是否修改 business-flow: no",
    "- 是否修改 knowledge: no",
    "- 是否修改 element_store: no",
    "",
    "## 下一步建议",
    "",
    "下一步可以在仍不启动浏览器的前提下，将同一套规则应用函数接入 `/api/assistant/plan` 的 DSL draft 阶段；确认 planning 输出稳定后，再讨论真实执行链路验证。"
  ].join("\n");
}

function parseArgs(args: string[]): CliOptions {
  const result: CliOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--project") result.project = args[++index];
    else if (arg === "--env") result.env = args[++index];
    else if (arg === "--request") result.request = args[++index];
    else if (arg === "--apply-rules") result.applyRules = true;
    else if (arg === "--out") result.out = args[++index];
    else if (arg === "--report") result.report = args[++index];
  }
  return result;
}
