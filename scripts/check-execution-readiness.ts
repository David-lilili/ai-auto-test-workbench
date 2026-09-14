import { analyzeExecutionReadiness, type ExecutionReadinessResult } from "../src/core/execution-readiness.js";
import { writeSafeJsonFile, writeSafeTextFile } from "../src/core/safe-file-writer.js";

interface CliOptions {
  case?: string;
  out?: string;
  report?: string;
}

const options = parseArgs(process.argv.slice(2));
if (!options.case || !options.out || !options.report) {
  console.error("Usage: npx tsx scripts/check-execution-readiness.ts --case <materialized-case.json> --out <readiness.json> --report <readiness.md>");
  process.exit(2);
}

const result = await analyzeExecutionReadiness({ materializedCasePath: options.case });
await writeSafeJsonFile(options.out, result);
await writeSafeTextFile(options.report, renderReport(result, options.out));

console.log(JSON.stringify({
  readinessPath: options.out,
  reportPath: options.report,
  ready: result.ready,
  blockingIssues: result.blockingIssues,
  warnings: result.warnings,
  runtimeResolvable: result.runtimeResolvable,
  recommendedNextAction: result.recommendedNextAction,
  executionPolicy: result.executionPolicy
}, null, 2));

function renderReport(result: ExecutionReadinessResult, readinessPath: string): string {
  const redPacketSteps = result.stepReadiness.filter((item) => item.targetField?.startsWith("red_packet_"));
  return [
    "# 阶段 2.8.5 Execution Readiness 报告",
    "",
    "## 输入",
    "",
    `- materialized case: \`${result.sourceMaterializedCasePath}\``,
    `- readiness JSON: \`${readinessPath}\``,
    "",
    "## 执行边界",
    "",
    "- 是否启动浏览器: no",
    "- 是否调用 executor: no",
    "- 是否调用 provider: no",
    "- 是否重跑业务: no",
    "- 是否写 knowledge: no",
    "- 是否写 business-flow: no",
    "- 是否写 element_store: no",
    "",
    "## Readiness 结论",
    "",
    `- ready: ${result.ready ? "true" : "false"}`,
    `- recommendedNextAction: \`${result.recommendedNextAction}\``,
    "",
    "## Blocking Issues",
    "",
    result.blockingIssues.length ? result.blockingIssues.map((item) => `- ${item.stepId ? `${item.stepId}: ` : ""}${item.reason}`).join("\n") : "- 无",
    "",
    "## Warnings",
    "",
    result.warnings.length ? result.warnings.map((item) => `- ${item.stepId ? `${item.stepId}: ` : ""}${item.reason}`).join("\n") : "- 无",
    "",
    "## Runtime Resolvable",
    "",
    result.runtimeResolvable.length ? result.runtimeResolvable.map((item) => `- ${item.stepId}: ${item.reason}`).join("\n") : "- 无",
    "",
    "## 红包关键字段",
    "",
    "```json",
    JSON.stringify(redPacketSteps.map((item) => ({
      stepId: item.stepId,
      targetField: item.targetField,
      data: item.data,
      locator: item.locator,
      severity: item.severity
    })), null, 2),
    "```",
    "",
    "## Provider Readiness",
    "",
    "```json",
    JSON.stringify(result.providerReadiness, null, 2),
    "```",
    "",
    "## Assertion Readiness",
    "",
    "```json",
    JSON.stringify(result.assertionReadiness, null, 2),
    "```"
  ].join("\n");
}

function parseArgs(args: string[]): CliOptions {
  const result: CliOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--case") result.case = args[++index];
    else if (arg === "--out") result.out = args[++index];
    else if (arg === "--report") result.report = args[++index];
  }
  return result;
}
