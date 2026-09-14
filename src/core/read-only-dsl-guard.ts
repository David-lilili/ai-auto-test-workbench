import type { DslDraft, DslDraftStep } from "./ai-orchestration-schema.js";

export function applyReadOnlyDslGuard(dsl: DslDraft): DslDraft {
  if (dsl.operationType !== "read") {
    return {
      ...dsl,
      readOnlyGuardDiagnostics: {
        enabled: false,
        beforeStepCount: dsl.steps.length,
        afterStepCount: dsl.steps.length,
        removedSteps: [],
        retainedFilterSteps: [],
        warnings: []
      }
    };
  }

  const removedSteps: NonNullable<DslDraft["readOnlyGuardDiagnostics"]>["removedSteps"] = [];
  const retainedFilterSteps: string[] = [];
  const nextSteps: DslDraftStep[] = [];

  for (const step of dsl.steps) {
    const decision = classifyReadOnlyStep(step, dsl);
    if (decision.keep) {
      if (decision.filterStep) retainedFilterSteps.push(step.id);
      nextSteps.push(step);
      continue;
    }
    removedSteps.push({
      id: step.id,
      action: step.action,
      reason: decision.reason,
      semanticLocator: step.semanticLocator,
      elementRef: step.elementRef
    });
  }

  return {
    ...dsl,
    steps: nextSteps,
    readOnlyGuardDiagnostics: {
      enabled: true,
      beforeStepCount: dsl.steps.length,
      afterStepCount: nextSteps.length,
      removedSteps,
      retainedFilterSteps,
      warnings: removedSteps.length ? ["read_only_generic_or_write_steps_removed"] : []
    }
  };
}

function classifyReadOnlyStep(step: DslDraftStep, dsl: DslDraft): { keep: true; filterStep?: boolean } | { keep: false; reason: string } {
  const action = step.action.toLowerCase();
  if (["navigate", "click", "select", "assert", "wait", "openentry", "bypasslogin"].includes(action)) {
    return { keep: true, filterStep: isFilterStep(step, dsl) };
  }
  if (["input", "fill", "type"].includes(action)) {
    if (isFilterStep(step, dsl)) return { keep: true, filterStep: true };
    return { keep: false, reason: "read_only_guard:generic_input_without_filter_data_binding" };
  }
  if (["submit", "confirmwrite", "create", "delete", "transfer", "withdraw", "trade"].includes(action)) {
    return { keep: false, reason: "read_only_guard:write_action_in_read_flow" };
  }
  if (step.id.startsWith("element-") && !hasSpecificEvidence(step)) {
    return { keep: false, reason: "read_only_guard:generic_element_without_specific_evidence" };
  }
  return { keep: true };
}

function isFilterStep(step: DslDraftStep, dsl: DslDraft): boolean {
  const text = `${step.id} ${step.targetField ?? ""} ${step.semanticName ?? ""} ${step.semanticLocator ?? ""} ${step.elementRef ?? ""} ${JSON.stringify(step.inputValue ?? "")}`.toLowerCase();
  const hasFilterSemantics = /(filter|search|coin|token|asset|currency|\u7b5b\u9009|\u641c\u7d22|\u5e01\u79cd|\u5e01|\u8d44\u4ea7)/i.test(text);
  const value = step.inputValue;
  const hasIntentAssetBinding =
    step.valueSource === "intent.data.asset" ||
    (typeof value === "string" && typeof dsl.data.asset === "string" && value.toUpperCase() === dsl.data.asset.toUpperCase());
  return hasFilterSemantics && hasIntentAssetBinding;
}

function hasSpecificEvidence(step: DslDraftStep): boolean {
  return step.evidence.some((item) => {
    const quote = `${item.quote ?? ""} ${item.id ?? ""}`.toLowerCase();
    return /(filter|search|record|list|assert|asset|wallet|currency|\u7b5b\u9009|\u641c\u7d22|\u8bb0\u5f55|\u5217\u8868|\u65ad\u8a00|\u8d44\u4ea7|\u94b1\u5305|\u5e01\u79cd)/i.test(quote);
  });
}
