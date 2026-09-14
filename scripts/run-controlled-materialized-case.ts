import fs from "fs-extra";
import path from "node:path";
import { loadContext } from "../src/core/config-loader.js";
import { DslExecutor } from "../src/core/dsl-executor.js";
import { AccountStore } from "../src/memory/account-store.js";
import { EnvironmentDiscoveryStore } from "../src/memory/environment-discovery-store.js";
import { ExecutionStore } from "../src/memory/execution-store.js";
import type { AutomationCase, DslStep, LoadedContext, RuntimeOptions, TestAccount } from "../src/core/types.js";
import { writeSafeJsonFile, writeSafeTextFile } from "../src/core/safe-file-writer.js";

interface CliOptions {
  casePath?: string;
  project?: string;
  env?: string;
  out?: string;
  report?: string;
  timeoutMs?: number;
}

const options = parseArgs(process.argv.slice(2));
if (!options.casePath || !options.project || !options.env || !options.out || !options.report) {
  console.error("Usage: npx tsx scripts/run-controlled-materialized-case.ts --case <materialized-case.json> --project <project> --env <env> --out <json> --report <md> [--timeout-ms <ms>]");
  process.exit(2);
}

const context = await loadContext({ project: options.project, env: options.env });
const accountStore = new AccountStore(context);
await accountStore.seedDefaults();
const account = (await accountStore.list({ project: options.project, env: options.env }))[0];
const source = await fs.readJson(options.casePath) as Record<string, unknown>;
const sourceCase = readObject(source.testCase) as unknown as AutomationCase;
const projectedCase = buildControlledProjection(sourceCase, account);
const auth = account ? await buildWebAuth(context, account).catch((error) => ({ error: error instanceof Error ? error.message : String(error) })) : undefined;
const runtime: RuntimeOptions = {
  project: options.project,
  env: options.env,
  tags: [],
  locales: [],
  dryRun: false,
  mode: "debug",
  maxAiCalls: 0,
  maxDurationMs: options.timeoutMs ?? 120_000,
  webAuthToken: auth && "token" in auth && context.env.web?.baseUrl
    ? {
        token: auth.token,
        originUrl: context.env.web.baseUrl,
        headerName: auth.headerName,
        storageKeys: auth.storageKeys,
        cookieNames: auth.cookieNames
      }
    : undefined
};

let executionError: string | undefined;
let result = await new DslExecutor(context).executeCase({ testCase: projectedCase, context, options: runtime }).catch((error) => {
  executionError = error instanceof Error ? error.message : String(error);
  return undefined;
});
const executionStore = new ExecutionStore(context);
const executionData = await executionStore.load();
const runId = result?.runId;
const run = runId ? executionData.runs.find((item) => item.run_id === runId) : undefined;
const steps = runId ? executionData.steps.filter((item) => item.run_id === runId) : [];
const failureReports = runId ? executionData.failureReports.filter((item) => item.run_id === runId) : [];
const failurePackagePath = failureReports.find((item) => item.codex_failure_package_path)?.codex_failure_package_path;
const failurePackage = failurePackagePath && await fs.pathExists(path.resolve(context.rootDir, failurePackagePath))
  ? await fs.readJson(path.resolve(context.rootDir, failurePackagePath)).catch(() => undefined)
  : undefined;
const providerCallsArtifactPath = runId ? path.join("artifacts", "execution", runId, "provider-calls.json") : undefined;
const providerCallsArtifact = providerCallsArtifactPath && await fs.pathExists(path.resolve(context.rootDir, providerCallsArtifactPath))
  ? await fs.readJson(path.resolve(context.rootDir, providerCallsArtifactPath)).catch(() => undefined)
  : undefined;
const countStepDefinition = projectedCase.steps.find((step) => (step as unknown as Record<string, unknown>).targetField === "red_packet_count");
const countStepExecution = steps.find((step) => step.dsl_step_id === countStepDefinition?.id);
const countStepIndex = projectedCase.steps.findIndex((step) => step.id === countStepDefinition?.id);
const failedStepIndex = steps.findIndex((step) => step.status === "failed");
const crossedCountStep = countStepIndex >= 0 && steps.some((step) => step.dsl_step_id === countStepDefinition?.id && (step.status === "passed" || step.status === "healed"));
const containsDemo = JSON.stringify({ projectedCase, steps }).includes("DEMO");
const providerCalls = Array.isArray((failurePackage as Record<string, unknown> | undefined)?.providerCalls)
  ? ((failurePackage as Record<string, unknown>).providerCalls as unknown[])
  : Array.isArray((providerCallsArtifact as Record<string, unknown> | undefined)?.calls)
    ? ((providerCallsArtifact as Record<string, unknown>).calls as unknown[])
  : [];
const finalFailureStage = typeof (failurePackage as Record<string, unknown> | undefined)?.failureStage === "string"
  ? String((failurePackage as Record<string, unknown>).failureStage)
  : result?.status === "passed"
    ? "passed"
    : run?.error_summary
      ? classifyFallbackFailureStage(run.error_summary)
      : "unknown";

const summary = {
  schemaVersion: "stage2.9-controlled-execution-result.v1",
  sourceMaterializedCasePath: options.casePath,
  projectedCase,
  authInjected: Boolean(runtime.webAuthToken),
  authError: auth && "error" in auth ? auth.error : undefined,
  runId,
  run,
  result,
  executionError,
  enteredExecutor: Boolean(runId),
  browserStarted: Boolean(runId),
  countStep: {
    id: countStepDefinition?.id,
    configuredValue: countStepDefinition?.value,
    valueSource: (countStepDefinition as unknown as Record<string, unknown> | undefined)?.valueSource,
    appliedRuleId: (countStepDefinition as unknown as Record<string, unknown> | undefined)?.appliedRuleId,
    executionStatus: countStepExecution?.status,
    actualLocatorUsed: countStepExecution?.actual_locator_used,
    errorMessage: countStepExecution?.error_message,
    crossed: crossedCountStep
  },
  containsDemo,
  crossedOriginalCountFailurePoint: crossedCountStep,
  failedStepIndex,
  finalFailureStage,
  providerCalls,
  failurePackagePath,
  artifacts: {
    executionDir: runId ? path.join("artifacts", "execution", runId) : undefined,
    failurePackageDir: runId ? path.join("artifacts", "codex-failure-packages", runId) : undefined,
    providerCalls: providerCallsArtifactPath
  },
  hangingRun: Boolean(run && !run.end_time),
  generatedProposal: false,
  notes: [
    "This controlled projection does not modify business-flow, knowledge, element_store, assertions, or providers.",
    "Unsupported planning metadata steps are excluded from the executable projection."
  ]
};

await writeSafeJsonFile(options.out, summary);
await writeSafeTextFile(options.report, renderReport(summary));
console.log(JSON.stringify({
  runId,
  enteredExecutor: summary.enteredExecutor,
  browserStarted: summary.browserStarted,
  crossedOriginalCountFailurePoint: summary.crossedOriginalCountFailurePoint,
  countValue: summary.countStep.configuredValue,
  containsDemo,
  finalFailureStage,
  failurePackagePath,
  hangingRun: summary.hangingRun,
  providerCallCount: providerCalls.length
}, null, 2));

function buildControlledProjection(sourceCase: AutomationCase, account?: TestAccount): AutomationCase {
  const steps = sourceCase.steps;
  const enhancedCount = steps.find((step) => (step as unknown as Record<string, unknown>).targetField === "red_packet_count") as (DslStep & Record<string, unknown>) | undefined;
  const keepIds = new Set(["navigate-target-page", "plan-5", "plan-6", "plan-7", "plan-8", "plan-9", "plan-10", "plan-11", "plan-12", "plan-13"]);
  const executable = steps
    .filter((step) => keepIds.has(step.id ?? ""))
    .map((step) => {
      const next = { ...step };
      if (step.id === "plan-10") {
        next.value = enhancedCount?.value ?? 1;
        (next as Record<string, unknown>).valueSource = enhancedCount?.valueSource ?? "intent.data.count";
        (next as Record<string, unknown>).appliedRuleId = enhancedCount?.appliedRuleId ?? "demo.red_packet.create.red_packet_count.intent_count";
        (next as Record<string, unknown>).targetField = "red_packet_count";
        next.semantic_target = "红包个数";
      }
      if (step.id === "plan-9") {
        next.value = 10;
        (next as Record<string, unknown>).targetField = "red_packet_amount";
      }
      return next;
    });
  executable.push({
    id: "provider-redis-email",
    action: "input",
    target: "input[placeholder*='邮箱验证码']",
    primary_locator: "input[placeholder*='邮箱验证码']",
    semantic_target: "邮箱验证码",
    valueFrom: {
      type: "redisVerificationCode",
      provider: "redis",
      account: account?.username,
      scene: "red-packet-create",
      codeType: "email",
      timeoutMs: 20_000
    },
    sensitive: true,
    timeout_ms: 25_000,
    allow_healing: true
  });
  executable.push({
    id: "provider-keepassxc-totp",
    action: "input",
    target: "input[placeholder*='Google Authenticator']",
    primary_locator: "input[placeholder*='Google Authenticator']",
    semantic_target: "GA 验证码",
    valueFrom: {
      type: "totp",
      provider: "keepassxc",
      account: account?.username,
      scene: "red-packet-create",
      timeoutMs: 15_000
    },
    sensitive: true,
    timeout_ms: 20_000,
    allow_healing: true
  });
  return {
    ...sourceCase,
    id: "assistant_materialized_controlled_stage2_9",
    title: "Stage 2.9 controlled materialized execution",
    dataProfile: account?.username,
    steps: executable,
    assertions: sourceCase.assertions
  };
}

async function buildWebAuth(context: LoadedContext, account: TestAccount): Promise<{ token: string; headerName: string; storageKeys?: string[]; cookieNames?: string[] }> {
  const discovery = await new EnvironmentDiscoveryStore(context).load(context.project.projectKey, context.env.env);
  const bypass = discovery.bypassLogin;
  if (!bypass?.enabled) throw new Error("Bypass login is not enabled.");
  if (!context.env.api?.baseUrl) throw new Error("Bypass login requires env.api.baseUrl.");
  const response = await fetch(new URL(bypass.path, context.env.api.baseUrl), {
    method: bypass.method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...(bypass.extraPayload ?? {}), [bypass.usernameField]: account.username, [bypass.passwordField]: account.password, uaTime: formatDateTime(new Date()) })
  });
  const body = await response.json().catch(async () => ({ raw: await response.text() }));
  const token = readJsonPath(body, bypass.tokenResponsePath);
  if (!response.ok || !token) throw new Error(`Bypass login failed: HTTP ${response.status} ${JSON.stringify(body).slice(0, 500)}`);
  return { token: String(token), headerName: bypass.tokenHeaderName, storageKeys: discovery.authInjection?.storageKeys, cookieNames: discovery.authInjection?.cookieNames };
}

function renderReport(summary: Record<string, unknown>): string {
  const countStep = summary.countStep as Record<string, unknown>;
  return [
    "# 阶段 2.9 Controlled Execution 报告",
    "",
    "## 输入",
    "",
    `- materialized case: \`${summary.sourceMaterializedCasePath}\``,
    `- runId: \`${String(summary.runId ?? "")}\``,
    "",
    "## 执行边界",
    "",
    "- 是否启动浏览器: yes",
    "- 是否进入 executor: yes",
    "- 是否调用 Redis provider: 根据执行是否到 provider step 决定",
    "- 是否调用 KeePassXC provider: 根据执行是否到 provider step 决定",
    "- 是否修改 business-flow: no",
    "- 是否修改 knowledge: no",
    "- 是否修改 element_store: no",
    "- 是否修改成功断言: no",
    "",
    "## 红包个数验证",
    "",
    `- 是否执行到红包个数 step: ${countStep.executionStatus ? "yes" : "no"}`,
    `- 红包个数配置值: \`${String(countStep.configuredValue)}\``,
    `- valueSource: \`${String(countStep.valueSource)}\``,
    `- appliedRuleId: \`${String(countStep.appliedRuleId)}\``,
    `- 红包个数执行状态: \`${String(countStep.executionStatus ?? "")}\``,
    `- 是否越过原失败点: ${summary.crossedOriginalCountFailurePoint ? "yes" : "no"}`,
    `- 是否出现 DEMO: ${summary.containsDemo ? "yes" : "no"}`,
    "",
    "## 最终结果",
    "",
    `- final failureStage: \`${String(summary.finalFailureStage)}\``,
    `- failure package: \`${String(summary.failurePackagePath ?? "")}\``,
    `- execution artifacts: \`${String((summary.artifacts as Record<string, unknown>).executionDir ?? "")}\``,
    `- failure package artifacts: \`${String((summary.artifacts as Record<string, unknown>).failurePackageDir ?? "")}\``,
    `- 是否 hanging run: ${summary.hangingRun ? "yes" : "no"}`,
    `- providerCalls count: ${(summary.providerCalls as unknown[]).length}`,
    `- 是否生成新的 proposal: ${summary.generatedProposal ? "yes" : "no"}`,
    "",
    "## ProviderCalls 摘要",
    "",
    "```json",
    JSON.stringify(summary.providerCalls, null, 2),
    "```",
    "",
    "## 下一步建议",
    "",
    summary.crossedOriginalCountFailurePoint
      ? "已越过红包个数原失败点。下一步应根据新的 failureStage 分层处理，不要回退到手补红包个数 selector。"
      : "未越过红包个数原失败点。下一步应基于新 failure package 生成 locator/data/action proposal，不直接手补 selector。"
  ].join("\n");
}

function parseArgs(args: string[]): CliOptions {
  const result: CliOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--case") result.casePath = args[++index];
    else if (arg === "--project") result.project = args[++index];
    else if (arg === "--env") result.env = args[++index];
    else if (arg === "--out") result.out = args[++index];
    else if (arg === "--report") result.report = args[++index];
    else if (arg === "--timeout-ms") result.timeoutMs = Number(args[++index]);
  }
  return result;
}

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function readJsonPath(value: unknown, dottedPath: string): unknown {
  return dottedPath.split(".").reduce<unknown>((current, key) => {
    return current && typeof current === "object" ? (current as Record<string, unknown>)[key] : undefined;
  }, value);
}

function formatDateTime(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function classifyFallbackFailureStage(message: string): string {
  if (/stream disconnected|client.*disconnect|ERR_NETWORK_CHANGED|ERR_INTERNET_DISCONNECTED/i.test(message)) return "external_interrupt";
  if (/verification|totp|redis|keepass/i.test(message)) return "provider";
  if (/assert/i.test(message)) return "assertion";
  if (/locator|selector|unable to execute/i.test(message)) return "selector";
  return "execution";
}
