import fs from "fs-extra";
import type { AutomationCase, DslStep } from "./types.js";

export interface MaterializedCaseResult {
  schemaVersion: "execution-materialization-dry-run.v1";
  sourcePlanningResultPath: string;
  materializedAt: string;
  project: string;
  env: string;
  caseSource: "assistant_plan_dsl_draft";
  executionPolicy: {
    startsBrowser: false;
    callsExecutor: false;
    callsProvider: false;
    writesKnowledge: false;
    writesBusinessFlow: false;
    writesElementStore: false;
  };
  testCase: AutomationCase;
  checks: {
    containsDemo: boolean;
    redPacketCount: {
      found: boolean;
      value?: unknown;
      valueSource?: string;
      appliedRuleId?: string;
    };
  };
  planToMaterializedDiff: Array<{
    stepId: string;
    targetField?: string;
    semanticName?: string;
    planInputValue?: unknown;
    materializedValue?: unknown;
    valueSource?: string;
    appliedRuleId?: string;
  }>;
}

export async function materializeAssistantPlanDryRun(input: {
  planningResultPath: string;
  materializedAt?: string;
}): Promise<MaterializedCaseResult> {
  const raw = (await fs.readJson(input.planningResultPath)) as Record<string, unknown>;
  const plan = objectValue(objectValue(raw.planningResponse).plan);
  const dslDraft = objectValue(plan.dslDraft);
  const steps = arrayValue(dslDraft.steps).filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object");
  const project = stringValue(dslDraft.project) ?? stringValue(plan.project) ?? "unknown";
  const env = stringValue(dslDraft.env) ?? stringValue(plan.env) ?? "unknown";
  const materializedSteps = steps.map(materializeDslDraftStep).filter((step): step is DslStep => Boolean(step));
  const testCase: AutomationCase = {
    id: `assistant_materialized_${project}_${env}`,
    title: "Assistant materialized execution case dry-run",
    type: "web",
    project,
    module: stringValue(dslDraft.module) ?? "unknown",
    priority: "P2",
    tags: ["assistant", "materialization", "dry-run"],
    owner: "qa",
    env: [env],
    steps: materializedSteps,
    assertions: normalizeAssertions(dslDraft.assertions)
  };
  const countStep = selectRedPacketCountStep(materializedSteps);
  const caseText = JSON.stringify(testCase);

  return {
    schemaVersion: "execution-materialization-dry-run.v1",
    sourcePlanningResultPath: input.planningResultPath,
    materializedAt: input.materializedAt ?? new Date().toISOString(),
    project,
    env,
    caseSource: "assistant_plan_dsl_draft",
    executionPolicy: {
      startsBrowser: false,
      callsExecutor: false,
      callsProvider: false,
      writesKnowledge: false,
      writesBusinessFlow: false,
      writesElementStore: false
    },
    testCase,
    checks: {
      containsDemo: /DEMO/.test(caseText),
      redPacketCount: {
        found: Boolean(countStep),
        value: countStep?.value,
        valueSource: stringValue((countStep as unknown as Record<string, unknown> | undefined)?.valueSource),
        appliedRuleId: stringValue((countStep as unknown as Record<string, unknown> | undefined)?.appliedRuleId)
      }
    },
    planToMaterializedDiff: steps.map((step, index) => {
      const materialized = materializedSteps[index] as unknown as Record<string, unknown> | undefined;
      return {
        stepId: stringValue(step.id) ?? `step-${index + 1}`,
        targetField: stringValue(step.targetField),
        semanticName: normalizedSemanticName(step),
        planInputValue: step.inputValue,
        materializedValue: materialized?.value,
        valueSource: stringValue(step.valueSource),
        appliedRuleId: stringValue(step.appliedRuleId)
      };
    })
  };
}

function materializeDslDraftStep(step: Record<string, unknown>): DslStep | undefined {
  const action = stringValue(step.action) ?? "unknown";
  if (/^provider/i.test(String(step.id ?? ""))) {
    return {
      id: stringValue(step.id),
      action: "input",
      target: stringValue(step.semanticLocator) ?? stringValue(step.providerDependency),
      valueFrom: stringValue(step.providerDependency),
      semantic_target: normalizedSemanticName(step),
      riskLevel: "medium",
      sensitive: true
    };
  }

  return {
    id: stringValue(step.id),
    action,
    target: stringValue(step.exactSelector) ?? stringValue(step.semanticLocator) ?? normalizedSemanticName(step),
    value: normalizeMaterializedValue(step),
    valueFrom: stringValue(step.valueSource),
    semantic_target: normalizedSemanticName(step),
    primary_locator: stringValue(step.exactSelector),
    fallback_locators: [],
    riskLevel: action === "click" || action === "input" || action === "select" ? "medium" : "low",
    allow_healing: Boolean(step.runtimeResolvable),
    ...(stringValue(step.targetField) ? { targetField: stringValue(step.targetField) } : {}),
    ...(stringValue(step.appliedRuleId) ? { appliedRuleId: stringValue(step.appliedRuleId) } : {}),
    ...(stringValue(step.valueSource) ? { valueSource: stringValue(step.valueSource) } : {})
  } as DslStep;
}

function normalizeAssertions(value: unknown): AutomationCase["assertions"] {
  return arrayValue(value)
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .map((item) => ({
      type: stringValue(item.type) ?? "uiState",
      target: stringValue(item.target),
      expected: item.expected
    }));
}

function isRedPacketCountStep(step: DslStep): boolean {
  const record = step as unknown as Record<string, unknown>;
  return record.targetField === "red_packet_count" || /红包个数|red[_-]?packet[_-]?count/i.test(`${step.id ?? ""} ${step.semantic_target ?? ""} ${step.target ?? ""}`);
}

function selectRedPacketCountStep(steps: DslStep[]): DslStep | undefined {
  return (
    steps.find((step) => {
      const record = step as unknown as Record<string, unknown>;
      return record.targetField === "red_packet_count" && Boolean(record.appliedRuleId);
    }) ??
    steps.find((step) => {
      const record = step as unknown as Record<string, unknown>;
      return record.targetField === "red_packet_count";
    }) ??
    steps.find((step) => isRedPacketCountStep(step))
  );
}

function normalizeMaterializedValue(step: Record<string, unknown>): unknown {
  if (step.targetField === "red_packet_count" && typeof step.inputValue === "string" && /^\d+$/.test(step.inputValue)) {
    return Number(step.inputValue);
  }
  return step.inputValue;
}

function normalizedSemanticName(step: Record<string, unknown>): string | undefined {
  if (step.targetField === "red_packet_count") return "红包个数";
  if (step.targetField === "red_packet_amount") return "红包金额";
  if (step.targetField === "red_packet_asset") return "红包币种";
  return stringValue(step.semanticName) ?? stringValue(step.semanticLocator);
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}
