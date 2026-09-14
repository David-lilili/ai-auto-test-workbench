/**
 * P13.7/8：Canonical Semantic Action Registry。
 *
 * 统一 P11/P12 semanticActions 与现有 DSL canonical action / page model intent，
 * 不建立第二套长期 action taxonomy。
 */

import type { ActionMappingStatus } from "./execution-types.js";

export interface ActionRegistryEntry {
  assetAction: string;
  dslAction: string;            // 现有 executor canonical action
  intentAction?: string;        // page model intent action 词
  status: ActionMappingStatus;
  notes?: string;
}

export const ACTION_REGISTRY: ActionRegistryEntry[] = [
  { assetAction: "SUBMIT_WITHDRAWAL", dslAction: "click", intentAction: "submit_withdrawal", status: "SUPPORTED" },
  { assetAction: "SUBMIT", dslAction: "click", intentAction: "submit", status: "ALIAS" },
  { assetAction: "SET_FIELD", dslAction: "input", status: "SUPPORTED" },
  { assetAction: "SELECT_OPTION", dslAction: "select_option", status: "SUPPORTED" },
  { assetAction: "APPLY_FILTER", dslAction: "click", intentAction: "apply_filter", status: "SUPPORTED" },
  { assetAction: "CONFIRM", dslAction: "click", intentAction: "confirm", status: "SUPPORTED" },
  { assetAction: "ENABLE_FEATURE", dslAction: "click", status: "SUPPORTED" },
  { assetAction: "DISABLE_FEATURE", dslAction: "click", status: "SUPPORTED" },
  { assetAction: "VERIFY_STATE", dslAction: "assert", status: "SUPPORTED" },
  { assetAction: "NAVIGATE", dslAction: "navigate", status: "SUPPORTED" },
  { assetAction: "CANCEL", dslAction: "click", status: "ALIAS" },
  { assetAction: "OTHER", dslAction: "click", status: "NEEDS_MAPPING" }
];

const registryByAction = new Map(ACTION_REGISTRY.map((e) => [e.assetAction, e]));

export function mapAssetAction(action: string): ActionRegistryEntry {
  return registryByAction.get(action) ?? { assetAction: action, dslAction: "click", status: "UNSUPPORTED", notes: "unknown action" };
}

/** P13.8：asset action → ExecutionIntent operation（不产生 locator）。 */
export function toIntentOperation(input: { action: string; target: string; value?: string }): { action: string; target: string; value?: string; mappedTo?: string } {
  const entry = mapAssetAction(input.action);
  return { action: input.action, target: input.target, value: input.value, mappedTo: entry.dslAction };
}
