import assert from "node:assert/strict";
import { test } from "node:test";
import { isLocatorForbiddenByStepGuard, isPageModelStep } from "../src/core/dsl-executor.js";

test("rejects global header and account locators for guarded Page Model steps", () => {
  const step = {
    scopeGuard: {
      pageModelId: "demo.funds.withdraw",
      region: "withdraw_form.network_selector",
      critical: true,
      forbiddenLocatorPatterns: [
        "[aria-label*=\"Demo\"]",
        "[aria-label*=\"User\"]",
        "record/list/table row scope"
      ]
    },
    negativeLocatorHints: ["text=BSC from withdraw record table"]
  };

  assert.equal(isLocatorForbiddenByStepGuard(step, "[aria-label*=\"Demo\"]"), true);
  assert.equal(isLocatorForbiddenByStepGuard(step, "[aria-label*=\"User352889\"]"), true);
  assert.equal(isLocatorForbiddenByStepGuard(step, "text=BSC from withdraw record table"), true);
  assert.equal(isLocatorForbiddenByStepGuard(step, "withdraw_network_dropdown:text=BSC(BEP-20)"), false);
});

test("allows unguarded legacy steps", () => {
  assert.equal(isLocatorForbiddenByStepGuard({}, "[aria-label*=\"Demo\"]"), false);
});

test("detects Page Model steps from source or evidence metadata", () => {
  assert.equal(isPageModelStep({ source: "page_model" }), true);
  assert.equal(isPageModelStep({ pageId: "demo.funds.spot_fund_flow", evidenceId: "w3.spot_fund_flow.type_filter" }), true);
  assert.equal(isPageModelStep({ source: "legacy", target: "text=查询" }), false);
});
