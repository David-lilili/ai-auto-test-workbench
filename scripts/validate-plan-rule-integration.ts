import { writeSafeJsonFile, writeSafeTextFile } from "../src/core/safe-file-writer.js";

interface CliOptions {
  url?: string;
  project?: string;
  env?: string;
  request?: string;
  out?: string;
  report?: string;
}

const options = parseArgs(process.argv.slice(2));
if (!options.url || !options.project || !options.env || !options.request || !options.out || !options.report) {
  console.error("Usage: npx tsx scripts/validate-plan-rule-integration.ts --url <base-url> --project <project> --env <env> --request <text> --out <json> --report <md>");
  process.exit(2);
}

const response = await fetch(new URL("/api/assistant/plan", options.url), {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    project: options.project,
    env: options.env,
    message: options.request
  })
});
if (!response.ok) {
  throw new Error(`Plan API failed: ${response.status} ${await response.text()}`);
}

const planningResponse = (await response.json()) as Record<string, unknown>;
const plan = objectValue(planningResponse.plan);
const intent = objectValue(plan.intentSpec);
const dslDraft = objectValue(plan.dslDraft);
const steps = arrayValue(dslDraft.steps).filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object");
const countStep = steps.find((step) => step.targetField === "red_packet_count" || step.semanticName === "红包个数" || step.semanticLocator === "红包个数");
const appliedRules = arrayValue(dslDraft.appliedRules);
const coverage = objectValue(plan.coverage);

const result = {
  schemaVersion: "stage2.7-plan-rule-integration-result.v1",
  request: options.request,
  planApiUrl: new URL("/api/assistant/plan", options.url).toString(),
  intent: {
    module: intent.module,
    action: intent.action,
    operationType: intent.operationType,
    data: dslDraft.data
  },
  dslDraft: {
    stepCount: steps.length,
    countStep,
    appliedRules
  },
  coverage,
  policy: {
    calledExecute: false,
    startedBrowser: false,
    writesKnowledge: false,
    writesBusinessFlow: false,
    writesElementStore: false,
    changesProviderBehavior: false
  }
};

await writeSafeJsonFile(options.out, {
  ...result,
  planningResponse
});
await writeSafeTextFile(options.report, renderReport(result));
console.log(JSON.stringify(result, null, 2));

function renderReport(input: {
  request: string;
  intent: Record<string, unknown>;
  dslDraft: { countStep?: unknown; appliedRules: unknown[] };
}): string {
  const count = input.dslDraft.countStep as Record<string, unknown> | undefined;
  const firstRule = input.dslDraft.appliedRules[0] as Record<string, unknown> | undefined;
  return [
    "# 阶段 2.7 Plan Rule Integration 报告",
    "",
    "## 修改范围",
    "",
    "- `/api/assistant/plan` 的 DSL draft 生成后应用 DSL generation rule。",
    "- planning response 中记录 `appliedRules`，DSL step 中记录 `appliedRuleId/valueSource/inputValue`。",
    "- 未接入 `/api/assistant/execute`，未启动浏览器，未改变 provider 行为。",
    "",
    "## 输入需求",
    "",
    input.request,
    "",
    "## Planning Response 摘要",
    "",
    `- module: \`${String(input.intent.module)}\``,
    `- action: \`${String(input.intent.action)}\``,
    `- operationType: \`${String(input.intent.operationType)}\``,
    `- data.count: \`${String((input.intent.data as Record<string, unknown> | undefined)?.count)}\``,
    "",
    "## 命中规则",
    "",
    `- ruleId: \`${String(firstRule?.ruleId ?? count?.appliedRuleId ?? "")}\``,
    "",
    "## 红包个数 Step",
    "",
    "```json",
    JSON.stringify(count ?? null, null, 2),
    "```",
    "",
    "## 修复前后 Diff",
    "",
    "```json",
    JSON.stringify(firstRule ?? null, null, 2),
    "```",
    "",
    "## 执行边界",
    "",
    "- 是否调用 execute: no",
    "- 是否启动浏览器: no",
    "- 是否写主存储: no",
    "- 是否修改 business-flow: no",
    "- 是否修改 knowledge: no",
    "- 是否修改 element_store: no",
    "- 是否改变 provider 行为: no",
    "",
    "## 验收结论",
    "",
    count?.inputValue === 1 && (count?.appliedRuleId === firstRule?.ruleId || Boolean(count?.appliedRuleId))
      ? "通过：planning DSL draft 中 `红包个数` 已绑定为 `intent.data.count=1`，并记录了 applied rule。"
      : "未通过：planning DSL draft 中未找到符合预期的 `红包个数` 规则命中结果。"
  ].join("\n");
}

function parseArgs(args: string[]): CliOptions {
  const result: CliOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--url") result.url = args[++index];
    else if (arg === "--project") result.project = args[++index];
    else if (arg === "--env") result.env = args[++index];
    else if (arg === "--request") result.request = args[++index];
    else if (arg === "--out") result.out = args[++index];
    else if (arg === "--report") result.report = args[++index];
  }
  return result;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
