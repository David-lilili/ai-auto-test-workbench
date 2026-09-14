import fs from "fs-extra";
import type { AutomationCase, DslAssertion, DslStep } from "./types.js";

export type ReadinessSeverity = "blocking" | "warning" | "runtime_resolvable" | "covered";

export interface StepReadiness {
  stepId: string;
  action: string;
  target?: string;
  targetField?: string;
  semanticName?: string;
  locator: {
    status: "covered" | "runtime_resolvable" | "missing";
    hasExactSelector: boolean;
    hasSemanticLocator: boolean;
    runtimeResolvable: boolean;
    fragileXPath: boolean;
    issue?: string;
  };
  data: {
    status: "covered" | "missing" | "not_required";
    value?: unknown;
    valueType?: string;
    issue?: string;
  };
  severity: ReadinessSeverity;
  reasons: string[];
}

export interface ProviderReadiness {
  provider: "redis:email" | "keepassxc:totp" | string;
  declared: boolean;
  called: false;
  status: "declared" | "missing";
  issue?: string;
}

export interface AssertionReadiness {
  type: string;
  target?: string;
  expected?: unknown;
  status: "covered" | "warning" | "missing";
  issue?: string;
}

export interface ExecutionReadinessResult {
  schemaVersion: "execution-readiness.v1";
  sourceMaterializedCasePath: string;
  checkedAt: string;
  ready: boolean;
  blockingIssues: Array<{ stepId?: string; issue: string; reason: string }>;
  warnings: Array<{ stepId?: string; issue: string; reason: string }>;
  runtimeResolvable: Array<{ stepId: string; issue: string; reason: string }>;
  stepReadiness: StepReadiness[];
  providerReadiness: ProviderReadiness[];
  assertionReadiness: AssertionReadiness[];
  recommendedNextAction: "proceed_to_controlled_execution" | "fix_blocking_issues_before_execution";
  executionPolicy: {
    startsBrowser: false;
    callsExecutor: false;
    callsProvider: false;
    writesKnowledge: false;
    writesBusinessFlow: false;
    writesElementStore: false;
  };
}

export async function analyzeExecutionReadiness(input: {
  materializedCasePath: string;
  checkedAt?: string;
}): Promise<ExecutionReadinessResult> {
  const raw = (await fs.readJson(input.materializedCasePath)) as Record<string, unknown>;
  const testCase = objectValue(raw.testCase) as unknown as AutomationCase;
  const steps = Array.isArray(testCase.steps) ? testCase.steps : [];
  const assertions = Array.isArray(testCase.assertions) ? testCase.assertions : [];
  const stepReadiness = steps.map(analyzeStep);
  const providerReadiness = analyzeProviders(steps);
  const assertionReadiness = assertions.map(analyzeAssertion);
  const blockingIssues = [
    ...stepReadiness.flatMap((item) => item.severity === "blocking" ? item.reasons.map((reason) => ({ stepId: item.stepId, issue: "step_not_ready", reason })) : []),
    ...providerReadiness.flatMap((item) => item.status === "missing" ? [{ issue: "provider_missing", reason: item.issue ?? `${item.provider} is not declared.` }] : []),
    ...assertionReadiness.flatMap((item) => item.status === "missing" ? [{ issue: "assertion_missing", reason: item.issue ?? "Assertion is missing target or expected result." }] : [])
  ];
  const warnings = [
    ...stepReadiness.flatMap((item) => item.severity === "warning" ? item.reasons.map((reason) => ({ stepId: item.stepId, issue: "step_warning", reason })) : []),
    ...assertionReadiness.flatMap((item) => item.status === "warning" ? [{ issue: "assertion_warning", reason: item.issue ?? "Assertion may be too broad." }] : [])
  ];
  const runtimeResolvable = stepReadiness.flatMap((item) =>
    item.severity === "runtime_resolvable" ? item.reasons.map((reason) => ({ stepId: item.stepId, issue: "runtime_resolvable_locator", reason })) : []
  );
  const ready = blockingIssues.length === 0;

  return {
    schemaVersion: "execution-readiness.v1",
    sourceMaterializedCasePath: input.materializedCasePath,
    checkedAt: input.checkedAt ?? new Date().toISOString(),
    ready,
    blockingIssues,
    warnings,
    runtimeResolvable,
    stepReadiness,
    providerReadiness,
    assertionReadiness,
    recommendedNextAction: ready ? "proceed_to_controlled_execution" : "fix_blocking_issues_before_execution",
    executionPolicy: {
      startsBrowser: false,
      callsExecutor: false,
      callsProvider: false,
      writesKnowledge: false,
      writesBusinessFlow: false,
      writesElementStore: false
    }
  };
}

function analyzeStep(step: DslStep): StepReadiness {
  const record = step as unknown as Record<string, unknown>;
  const stepId = String(step.id ?? "unknown-step");
  const action = String(step.action ?? "unknown");
  const target = stringValue(step.target);
  const semanticName = stringValue(step.semantic_target);
  const targetField = stringValue(record.targetField);
  const hasExactSelector = Boolean(step.primary_locator || isExactSelector(target));
  const hasSemanticLocator = Boolean(semanticName || target);
  const runtimeResolvable = Boolean(step.allow_healing);
  const fragileXPath = Boolean((step.primary_locator ?? target ?? "").match(/^xpath=.*following::input\[\d+\]/i));
  const requiresLocator = ["click", "input", "select", "assert"].includes(action) && !step.valueFrom?.toString().startsWith("redis:") && !step.valueFrom?.toString().startsWith("keepassxc:");
  const locatorStatus = !requiresLocator || hasExactSelector ? "covered" : runtimeResolvable && hasSemanticLocator ? "runtime_resolvable" : hasSemanticLocator ? "runtime_resolvable" : "missing";
  const data = analyzeStepData(step, targetField);
  const reasons: string[] = [];
  let severity: ReadinessSeverity = "covered";

  if (locatorStatus === "missing") {
    severity = "blocking";
    reasons.push("missing locator and no semantic locator available");
  } else if (locatorStatus === "runtime_resolvable") {
    severity = "runtime_resolvable";
    reasons.push("exact selector is missing but semantic locator can be resolved at runtime");
  }
  if (data.status === "missing") {
    severity = "blocking";
    reasons.push(data.issue ?? "input value is missing");
  }
  if (fragileXPath && severity === "covered") {
    severity = "warning";
    reasons.push("exact selector is a brittle XPath using following::input[n]");
  } else if (fragileXPath) {
    reasons.push("exact selector is a brittle XPath using following::input[n]");
  }

  return {
    stepId,
    action,
    target,
    targetField,
    semanticName,
    locator: {
      status: locatorStatus,
      hasExactSelector,
      hasSemanticLocator,
      runtimeResolvable,
      fragileXPath,
      issue: locatorStatus === "missing" ? "missing locator" : fragileXPath ? "fragile XPath" : undefined
    },
    data,
    severity,
    reasons
  };
}

function analyzeStepData(step: DslStep, targetField?: string): StepReadiness["data"] {
  if (!["input", "select"].includes(String(step.action))) return { status: "not_required" };
  if (step.valueFrom) return { status: "covered", valueType: "provider" };
  if (targetField === "red_packet_count") {
    return step.value === 1
      ? { status: "covered", value: step.value, valueType: "count" }
      : { status: "missing", value: step.value, valueType: typeof step.value, issue: "red_packet_count must be number 1" };
  }
  if (targetField === "red_packet_amount") {
    return Number(step.value) === 10
      ? { status: "covered", value: step.value, valueType: "amount" }
      : { status: "missing", value: step.value, valueType: typeof step.value, issue: "red_packet_amount must be 10" };
  }
  if (targetField === "red_packet_asset") {
    return step.value === "TON"
      ? { status: "covered", value: step.value, valueType: "asset" }
      : { status: "missing", value: step.value, valueType: typeof step.value, issue: "red_packet_asset must be TON" };
  }
  return step.value === undefined || step.value === null || step.value === ""
    ? { status: "missing", issue: "input/select step has no value" }
    : { status: "covered", value: step.value, valueType: typeof step.value };
}

function analyzeProviders(steps: DslStep[]): ProviderReadiness[] {
  const text = JSON.stringify(steps);
  return [
    {
      provider: "redis:email",
      declared: /redis:email/.test(text),
      called: false,
      status: /redis:email/.test(text) ? "declared" : "missing",
      issue: /redis:email/.test(text) ? undefined : "Redis email provider dependency is missing."
    },
    {
      provider: "keepassxc:totp",
      declared: /keepassxc:totp/.test(text),
      called: false,
      status: /keepassxc:totp/.test(text) ? "declared" : "missing",
      issue: /keepassxc:totp/.test(text) ? undefined : "KeePassXC TOTP provider dependency is missing."
    }
  ];
}

function analyzeAssertion(assertion: DslAssertion): AssertionReadiness {
  const type = String(assertion.type ?? "unknown");
  const target = stringValue(assertion.target);
  if (!target) return { type, target, expected: assertion.expected, status: "missing", issue: "Assertion target is missing." };
  if (/uistate/i.test(type) && /成功|success/i.test(`${target} ${String(assertion.expected ?? "")}`)) {
    return { type, target, expected: assertion.expected, status: "warning", issue: "UI success assertion is broad; keep API response assertion as stronger evidence." };
  }
  return { type, target, expected: assertion.expected, status: "covered" };
}

function isExactSelector(value?: string): boolean {
  return Boolean(value && /^(css=|xpath=|role=|text=|id=|data-testid=|button:|input\[|\/|https?:\/\/)/i.test(value));
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}
