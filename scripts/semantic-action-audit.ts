/**
 * P13-A4：Canonical Semantic Action Audit。
 * 生成 reports/execution/semantic-action-mapping.json。
 */

import fs from "fs-extra";
import path from "node:path";
import { ACTION_REGISTRY } from "../src/test-assets/action-registry.js";

const ROOT = process.cwd();

const assetActions = [
  "SUBMIT_WITHDRAWAL", "SUBMIT", "SET_FIELD", "SELECT_OPTION", "ENABLE_FEATURE", "MODIFY_ADDRESS",
  "VERIFY_STATE", "APPLY_FILTER", "CONFIRM", "NAVIGATE", "DISABLE_FEATURE", "CANCEL", "OTHER"
];

// 现有 DSL canonical actions（dsl-executor 支持的动作）
const dslCanonicalActions = ["navigate", "click", "input", "select_option", "setDateRange", "swipe", "wait", "assert"];

// PageModelIntent action 词表（evidence-selector 的 local parser 产物）
const pageModelIntentActions = ["earn_subscribe", "spot_fund_flow_filter", "submit_withdrawal", "apply_filter", "confirm", "manage_withdraw_address", "add_withdraw_address"];

const mapping = assetActions.map((action) => {
  const entry = ACTION_REGISTRY.find((r) => r.assetAction === action);
  const category = entry?.status === "SUPPORTED"
    ? (entry.intentAction && pageModelIntentActions.includes(entry.intentAction) ? "DIRECT_CANONICAL" : "DIRECT_CANONICAL")
    : entry?.status === "ALIAS" ? "ALIAS"
    : entry?.status === "NEEDS_MAPPING" ? "NEEDS_MAPPING"
    : "UNSUPPORTED";
  return {
    assetAction: action,
    dslAction: entry?.dslAction ?? null,
    intentAction: entry?.intentAction ?? null,
    category,
    dslSupported: Boolean(entry && dslCanonicalActions.includes(entry.dslAction)),
    note: entry?.notes
  };
});

await fs.ensureDir(path.join(ROOT, "reports", "execution"));
await fs.writeJson(path.join(ROOT, "reports", "execution", "semantic-action-mapping.json"), {
  schemaVersion: "semantic-action-mapping.v1",
  generatedAt: new Date().toISOString(),
  sourceOfTruth: {
    dslCanonicalActions,
    note: "现有 DSL executor 动作集（单一出口 AutomationCase）"
  },
  mapping
}, { spaces: 2 });

console.log(JSON.stringify(mapping, null, 1));
