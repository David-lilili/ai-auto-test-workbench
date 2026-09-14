import assert from "node:assert/strict";
import { test } from "node:test";
import {
  getIntentPageRouting,
  normalizeIntentValueForProject,
  primaryTargetPageIdForIntent,
  registerIntentPageRouting,
  targetPageIdsForIntent,
  type ProjectIntentPageRouting
} from "../src/core/project-intent-routing.js";

const demoIntent = { project: "demo", module: "asset", action: "earn_fund_flow_filter", data: {} };

test("empty registry resolves no routing adapter", () => {
  assert.equal(getIntentPageRouting("demo"), undefined);
});

test("unregistered project degrades to empty page targets", () => {
  assert.deepEqual(targetPageIdsForIntent(demoIntent), []);
  assert.equal(primaryTargetPageIdForIntent(demoIntent), undefined);
  assert.equal(normalizeIntentValueForProject(demoIntent, "赎回"), undefined);
});

test("registered routing adapter is resolved by project key", () => {
  const fake: ProjectIntentPageRouting = {
    project: "demo",
    targetPageIdsForIntent: () => ["demo.funds.earn_fund_flow"],
    primaryTargetPageIdForIntent: () => "demo.funds.earn_fund_flow",
    normalizeIntentValue: () => "本金及收益返还"
  };
  registerIntentPageRouting(fake);
  assert.equal(getIntentPageRouting("demo"), fake);
  assert.ok(targetPageIdsForIntent(demoIntent).includes("demo.funds.earn_fund_flow"));
  assert.equal(primaryTargetPageIdForIntent(demoIntent), "demo.funds.earn_fund_flow");
  assert.equal(normalizeIntentValueForProject(demoIntent, "赎回"), "本金及收益返还");
  assert.equal(getIntentPageRouting("other-project"), undefined);
});
