import { materializeAssistantPlanDryRun } from "../src/core/execution-materialization.js";
import { writeSafeJsonFile, writeSafeTextFile } from "../src/core/safe-file-writer.js";

interface CliOptions {
  plan?: string;
  out?: string;
  report?: string;
}

const options = parseArgs(process.argv.slice(2));
if (!options.plan || !options.out || !options.report) {
  console.error("Usage: npx tsx scripts/materialize-plan-dry-run.ts --plan <planning-result.json> --out <materialized-case.json> --report <report.md>");
  process.exit(2);
}

const result = await materializeAssistantPlanDryRun({ planningResultPath: options.plan });
await writeSafeJsonFile(options.out, result);
await writeSafeTextFile(options.report, renderReport(result, options.out));

console.log(JSON.stringify({
  materializedCasePath: options.out,
  reportPath: options.report,
  containsDemo: result.checks.containsDemo,
  redPacketCount: result.checks.redPacketCount,
  startsBrowser: result.executionPolicy.startsBrowser,
  callsExecutor: result.executionPolicy.callsExecutor,
  callsProvider: result.executionPolicy.callsProvider
}, null, 2));

function renderReport(result: Awaited<ReturnType<typeof materializeAssistantPlanDryRun>>, materializedCasePath: string): string {
  const countDiff = result.planToMaterializedDiff.find((item) => item.targetField === "red_packet_count");
  return [
    "# 阶段 2.8 Execution Materialization Dry-run 报告",
    "",
    "## 输入",
    "",
    `- planning result: \`${result.sourcePlanningResultPath}\``,
    `- materialized case: \`${materializedCasePath}\``,
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
    "- 是否改成功断言: no",
    "",
    "## 检查结果",
    "",
    `- materialized case 是否仍包含 DEMO: ${result.checks.containsDemo ? "yes" : "no"}`,
    `- 红包个数 step 是否存在: ${result.checks.redPacketCount.found ? "yes" : "no"}`,
    `- 红包个数最终值: \`${String(result.checks.redPacketCount.value)}\``,
    `- valueSource: \`${String(result.checks.redPacketCount.valueSource)}\``,
    `- appliedRuleId: \`${String(result.checks.redPacketCount.appliedRuleId)}\``,
    "",
    "## Plan -> Materialized Case Diff",
    "",
    "```json",
    JSON.stringify(countDiff ?? null, null, 2),
    "```",
    "",
    "## 下一步建议",
    "",
    result.checks.containsDemo || result.checks.redPacketCount.value !== 1
      ? "暂不进入真实执行验证；需要先修复 execution materialization 的数据绑定。"
      : "可以进入下一阶段的受控真实执行验证，但仍应先设置超时、失败包证据采集和 provider timeline 检查。"
  ].join("\n");
}

function parseArgs(args: string[]): CliOptions {
  const result: CliOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--plan") result.plan = args[++index];
    else if (arg === "--out") result.out = args[++index];
    else if (arg === "--report") result.report = args[++index];
  }
  return result;
}
