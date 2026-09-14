import type { LoadedContext } from "./types.js";
import { DslGenerationRuleStore, type DslGenerationRule } from "./dsl-generation-rule.js";
import type { DslDraft, DslDraftStep } from "./ai-orchestration-schema.js";

export interface DryRunIntent {
  project: string;
  env: string;
  module: "red-packet" | "unknown";
  action: "create" | "unknown";
  operationType: "write" | "read" | "unknown";
  data: {
    asset?: string;
    amount?: number;
    count?: number;
  };
  providerDependencies: string[];
}

export interface DryRunDslStep {
  id: string;
  action: "navigate" | "input" | "select" | "click" | "assert";
  semanticName: string;
  targetField?: string;
  value?: unknown;
  valueSource?: string;
  appliedRuleId?: string;
}

export interface DryRunDsl {
  schemaVersion: "dsl-dry-run.v1";
  project: string;
  env: string;
  module: string;
  action: string;
  operationType: string;
  data: DryRunIntent["data"];
  providerDependencies: string[];
  steps: DryRunDslStep[];
}

export interface DryRunDslDiff {
  stepId: string;
  semanticName: string;
  targetField?: string;
  before: {
    value?: unknown;
    valueSource?: string;
  };
  after: {
    value?: unknown;
    valueSource?: string;
    appliedRuleId?: string;
  };
}

export interface DslRuleDryRunResult {
  schemaVersion: "dsl-rule-dry-run-result.v1";
  project: string;
  env: string;
  request: string;
  ruleFilePath: string;
  loadedRuleIds: string[];
  appliedRuleIds: string[];
  intent: DryRunIntent;
  beforeDsl: DryRunDsl;
  afterDsl: DryRunDsl;
  diff: DryRunDslDiff[];
  executionPolicy: {
    startsBrowser: false;
    executesBusiness: false;
    writesKnowledge: false;
    writesBusinessFlow: false;
    writesElementStore: false;
    writesMainStorage: false;
  };
}

export interface AssistantDslRuleApplication {
  dsl: DslDraft;
  appliedRules: NonNullable<DslDraft["appliedRules"]>;
}

export function parseDryRunIntent(input: { project: string; env: string; request: string }): DryRunIntent {
  const text = input.request;
  const amount = numberAfter(text, /金额\s*([0-9]+(?:\.[0-9]+)?)/i) ?? numberAfter(text, /amount\s*([0-9]+(?:\.[0-9]+)?)/i);
  const count = numberAfter(text, /数量\s*([0-9]+)/i) ?? numberAfter(text, /个数\s*([0-9]+)/i) ?? numberAfter(text, /count\s*([0-9]+)/i);
  const asset = /TON/i.test(text) ? "TON" : /USDT/i.test(text) ? "USDT" : undefined;
  const providerDependencies: string[] = [];
  if (/邮箱验证码|email.*code|email verification/i.test(text)) providerDependencies.push("redis:email");
  if (/\bGA\b|Google Authenticator|TOTP|动态验证码/i.test(text)) providerDependencies.push("keepassxc:totp");

  return {
    project: input.project,
    env: input.env,
    module: /红包|red\s*packet/i.test(text) ? "red-packet" : "unknown",
    action: /创建|发红包|create/i.test(text) ? "create" : "unknown",
    operationType: /创建|发红包|申购|下单|删除|create|submit|buy|delete/i.test(text) ? "write" : "read",
    data: { asset, amount, count },
    providerDependencies
  };
}

export function buildBaselineDslForDryRun(intent: DryRunIntent): DryRunDsl {
  const steps: DryRunDslStep[] = [
    {
      id: "navigate-red-packet-create",
      action: "navigate",
      semanticName: "红包创建页面"
    },
    {
      id: "input-red-packet-asset",
      action: "select",
      semanticName: "红包币种",
      targetField: "red_packet_asset",
      value: intent.data.asset,
      valueSource: "intent.data.asset"
    },
    {
      id: "input-red-packet-amount",
      action: "input",
      semanticName: "红包金额",
      targetField: "red_packet_amount",
      value: intent.data.amount,
      valueSource: "intent.data.amount"
    },
    {
      id: "input-red-packet-count",
      action: "input",
      semanticName: "红包个数",
      targetField: "red_packet_count",
      value: "DEMO",
      valueSource: "legacy.dsl.step.value"
    },
    {
      id: "input-email-code",
      action: "input",
      semanticName: "邮箱验证码",
      targetField: "email_verification_code",
      valueSource: "provider.redis.email"
    },
    {
      id: "input-ga-code",
      action: "input",
      semanticName: "GA 验证码",
      targetField: "ga_totp_code",
      valueSource: "provider.keepassxc.totp"
    },
    {
      id: "assert-create-success",
      action: "assert",
      semanticName: "创建成功提示"
    }
  ];

  return {
    schemaVersion: "dsl-dry-run.v1",
    project: intent.project,
    env: intent.env,
    module: intent.module,
    action: intent.action,
    operationType: intent.operationType,
    data: intent.data,
    providerDependencies: intent.providerDependencies,
    steps
  };
}

export function applyDslGenerationRules(input: {
  dsl: DryRunDsl;
  intent: DryRunIntent;
  rules: DslGenerationRule[];
}): { dsl: DryRunDsl; appliedRuleIds: string[]; diff: DryRunDslDiff[] } {
  const enabledRules = input.rules.filter((rule) => rule.enabled && rule.module === input.dsl.module && rule.action === input.dsl.action);
  const appliedRuleIds: string[] = [];
  const diff: DryRunDslDiff[] = [];
  const nextSteps = input.dsl.steps.map((step) => {
    const rule = enabledRules.find((candidate) => candidate.targetField === step.targetField);
    if (!rule) return step;
    const resolved = resolveValue(input.intent, rule);
    if (!resolved.found) return step;
    const next: DryRunDslStep = {
      ...step,
      value: resolved.value,
      valueSource: resolved.source,
      appliedRuleId: rule.ruleId
    };
    appliedRuleIds.push(rule.ruleId);
    diff.push({
      stepId: step.id,
      semanticName: step.semanticName,
      targetField: step.targetField,
      before: {
        value: step.value,
        valueSource: step.valueSource
      },
      after: {
        value: next.value,
        valueSource: next.valueSource,
        appliedRuleId: next.appliedRuleId
      }
    });
    return next;
  });

  return {
    dsl: { ...input.dsl, steps: nextSteps },
    appliedRuleIds: [...new Set(appliedRuleIds)],
    diff
  };
}

export function applyDslGenerationRulesToDraft(input: {
  dsl: DslDraft;
  rules: DslGenerationRule[];
}): AssistantDslRuleApplication {
  const enabledRules = input.rules.filter((rule) => rule.enabled && rule.module === input.dsl.module && rule.action === input.dsl.action);
  const appliedRules: NonNullable<DslDraft["appliedRules"]> = [];
  const steps = input.dsl.steps.map((step) => {
    const rule = enabledRules.find((candidate) => candidate.targetField === step.targetField);
    if (!rule) return step;
    const resolved = resolveValue({ project: input.dsl.project, env: input.dsl.env, module: input.dsl.module as DryRunIntent["module"], action: input.dsl.action as DryRunIntent["action"], operationType: input.dsl.operationType as DryRunIntent["operationType"], data: input.dsl.data as DryRunIntent["data"], providerDependencies: input.dsl.providerDependencies }, rule);
    if (!resolved.found) return step;
    const next: DslDraftStep = {
      ...step,
      inputValue: resolved.value,
      valueSource: resolved.source,
      appliedRuleId: rule.ruleId
    };
    appliedRules.push({
      ruleId: rule.ruleId,
      stepId: step.id,
      targetField: step.targetField,
      semanticName: step.semanticName ?? step.semanticLocator,
      beforeValue: step.inputValue,
      afterValue: next.inputValue,
      valueSource: next.valueSource
    });
    return next;
  });
  return { dsl: { ...input.dsl, steps, appliedRules }, appliedRules };
}

export async function generateDslRuleDryRun(input: {
  context: LoadedContext;
  request: string;
  applyRules: boolean;
}): Promise<DslRuleDryRunResult> {
  const intent = parseDryRunIntent({
    project: input.context.project.projectKey,
    env: input.context.env.env,
    request: input.request
  });
  const beforeDsl = buildBaselineDslForDryRun(intent);
  const store = new DslGenerationRuleStore(input.context);
  const storeData = await store.load();
  const activeRules = input.applyRules ? storeData.rules : [];
  const applied = applyDslGenerationRules({ dsl: beforeDsl, intent, rules: activeRules });

  return {
    schemaVersion: "dsl-rule-dry-run-result.v1",
    project: input.context.project.projectKey,
    env: input.context.env.env,
    request: input.request,
    ruleFilePath: store.filePath,
    loadedRuleIds: storeData.rules.map((rule) => rule.ruleId),
    appliedRuleIds: applied.appliedRuleIds,
    intent,
    beforeDsl,
    afterDsl: applied.dsl,
    diff: applied.diff,
    executionPolicy: {
      startsBrowser: false,
      executesBusiness: false,
      writesKnowledge: false,
      writesBusinessFlow: false,
      writesElementStore: false,
      writesMainStorage: false
    }
  };
}

function resolveValue(intent: DryRunIntent, rule: DslGenerationRule): { found: true; value: unknown; source: string } | { found: false } {
  const sources = [rule.valueSource, ...rule.fallbackSources];
  for (const source of sources) {
    const value = valueAtPath(intent, source);
    if (value !== undefined && value !== null && value !== "") return { found: true, value, source };
  }
  return { found: false };
}

function valueAtPath(intent: DryRunIntent, sourcePath: string): unknown {
  if (!sourcePath.startsWith("intent.")) return undefined;
  const parts = sourcePath.split(".").slice(1);
  let current: unknown = intent;
  for (const part of parts) {
    if (!current || typeof current !== "object" || !(part in current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function numberAfter(text: string, pattern: RegExp): number | undefined {
  const match = text.match(pattern);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : undefined;
}
