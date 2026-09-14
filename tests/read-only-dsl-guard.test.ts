import assert from "node:assert/strict";
import { test } from "node:test";
import type { DslDraft } from "../src/core/ai-orchestration-schema.js";
import { applyReadOnlyDslGuard } from "../src/core/read-only-dsl-guard.js";

test("removes generic input steps from read-only DSL while keeping asset filter", () => {
  const guarded = applyReadOnlyDslGuard({
    schemaVersion: "dsl-draft.v1",
    project: "demo",
    env: "test",
    module: "asset",
    action: "record",
    operationType: "read",
    loginRequired: true,
    data: { asset: "USDT" },
    providerDependencies: [],
    steps: [
      step("navigate-target-page", "navigate", "资产记录页"),
      {
        ...step("filter-asset", "input", "币种筛选器"),
        targetField: "asset_filter",
        inputValue: "USDT",
        valueSource: "intent.data.asset"
      },
      step("assert-list", "assert", "资产记录列表"),
      step("element-1", "input", undefined),
      step("element-2", "input", undefined)
    ],
    assertions: [{ type: "uiState", target: "资产记录列表", expected: "USDT record or empty state" }],
    clarificationQuestions: []
  });

  assert.deepEqual(guarded.steps.map((item) => item.id), ["navigate-target-page", "filter-asset", "assert-list"]);
  assert.equal(guarded.readOnlyGuardDiagnostics?.removedSteps.length, 2);
  assert.deepEqual(guarded.readOnlyGuardDiagnostics?.retainedFilterSteps, ["filter-asset"]);
});

test("does not apply read-only guard to write DSL", () => {
  const dsl: DslDraft = {
    schemaVersion: "dsl-draft.v1",
    project: "demo",
    env: "test",
    module: "red-packet",
    action: "create",
    operationType: "write",
    loginRequired: true,
    data: {},
    providerDependencies: [],
    steps: [step("input-count", "input", "红包个数")],
    assertions: [],
    clarificationQuestions: []
  };

  const guarded = applyReadOnlyDslGuard(dsl);

  assert.equal(guarded.steps.length, 1);
  assert.equal(guarded.readOnlyGuardDiagnostics?.enabled, false);
});

function step(id: string, action: string, semanticLocator?: string) {
  return {
    id,
    action,
    semanticLocator,
    runtimeResolvable: true,
    evidence: [{ source: "ai_inferred" as const, id, quote: semanticLocator ?? id, confidence: 0.5 }],
    aiConfidence: 0.5
  };
}
