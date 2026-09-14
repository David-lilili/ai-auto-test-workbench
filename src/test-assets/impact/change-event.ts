/**
 * P14.2-9：ChangeEvent 统一模型 + ChangeSet。
 *
 * ChangeEvent：一次可追踪的变化（Requirement/KB/Capability/Page/Manual/Env）。
 * ChangeSet：V1→V2 的语义 diff（不是文本 diff）。
 */

export type ChangeSourceType = "REQUIREMENT" | "BUSINESS_KNOWLEDGE" | "CAPABILITY" | "PAGE_MODEL" | "TEST_MANUAL" | "ENVIRONMENT";

export type BusinessVsTechnical = "BUSINESS_CHANGE" | "TEST_INTENT_CHANGE" | "EXECUTION_CHANGE" | "TEST_METHOD_CHANGE" | "UNKNOWN";

export const CHANGE_TYPES = [
  "REQUIREMENT_RULE_ADDED", "REQUIREMENT_RULE_REMOVED", "REQUIREMENT_RULE_CHANGED",
  "AC_ADDED", "AC_REMOVED", "AC_CHANGED",
  "ACTOR_SCOPE_CHANGED", "PERMISSION_CHANGED", "SECURITY_CHANGED", "CONSTRAINT_CHANGED", "STATE_CHANGED", "DEPENDENCY_CHANGED",
  "CAPABILITY_ADDED", "CAPABILITY_CHANGED", "CAPABILITY_REMOVED",
  "PAGE_STRUCTURE_CHANGED", "PAGE_INTERACTION_CHANGED", "PAGE_ASSERTION_CHANGED", "PAGE_LOCATOR_CHANGED", "PAGE_STATE_CHANGED",
  "MANUAL_RULE_ADDED", "MANUAL_RULE_CHANGED", "MANUAL_RULE_REMOVED"
] as const;
export type ChangeType = (typeof CHANGE_TYPES)[number];

export interface ChangeEvent {
  changeEventId: string;
  sourceType: ChangeSourceType;
  sourceId: string;
  fromVersion?: string;
  toVersion: string;
  changeType: ChangeType;
  changedFields: string[];
  added: string[];
  removed: string[];
  modified: string[];
  criticality: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  provenance: { reason: string; source: string };
  detectedAt: string;
  fingerprint: string;
  /** P14.4：业务 vs 技术变化分类。 */
  businessVsTechnical: BusinessVsTechnical;
}

export function classifyChangeNature(event: Pick<ChangeEvent, "sourceType" | "changeType">): BusinessVsTechnical {
  if (event.sourceType === "PAGE_MODEL") {
    return event.changeType === "PAGE_LOCATOR_CHANGED" ? "EXECUTION_CHANGE" : "EXECUTION_CHANGE";
  }
  if (event.sourceType === "TEST_MANUAL") return "TEST_METHOD_CHANGE";
  if (event.sourceType === "REQUIREMENT" || event.sourceType === "BUSINESS_KNOWLEDGE") {
    return event.changeType.startsWith("AC_") || event.changeType.startsWith("REQUIREMENT_RULE_") || event.changeType.includes("SECURITY") || event.changeType.includes("PERMISSION") || event.changeType.includes("STATE") || event.changeType.includes("DEPENDENCY") || event.changeType.includes("CONSTRAINT") || event.changeType.includes("ACTOR")
      ? "BUSINESS_CHANGE"
      : "TEST_INTENT_CHANGE";
  }
  return "UNKNOWN";
}

// ============ P14.5 Requirement ChangeSet ============

export interface RequirementChangeSet {
  requirementId: string;
  fromVersion: string;
  toVersion: string;
  addedRules: string[];
  removedRules: string[];
  changedRules: string[];
  addedAC: string[];
  removedAC: string[];
  changedAC: string[];
  actorChanges: string[];
  stateChanges: string[];
  dependencyChanges: string[];
  securityChanges: string[];
  constraintChanges: string[];
  /** 全部变化事实 id（用于 impact traversal）。 */
  changedFactIds: string[];
  removedFactIds: string[];
}

export interface DiffableFact { ruleId: string; statement: string; condition?: string; effect?: string }

export function diffRules<T extends DiffableFact>(v1: T[], v2: T[]): { added: string[]; removed: string[]; changed: string[] } {
  const byId = (list: T[]) => new Map(list.map((r) => [r.ruleId, r]));
  const m1 = byId(v1);
  const m2 = byId(v2);
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const [id, r2] of m2) {
    const r1 = m1.get(id);
    if (!r1) { added.push(id); continue; }
    if (r1.statement !== r2.statement || r1.condition !== r2.condition || r1.effect !== r2.effect) changed.push(id);
  }
  for (const id of m1.keys()) if (!m2.has(id)) removed.push(id);
  return { added, removed, changed };
}

export function buildRequirementChangeSet(input: {
  requirementId: string;
  v1: { version: string; rules: Array<{ ruleId: string; statement: string; condition?: string; effect?: string }>; acs: Array<{ acId: string; statement: string }>; actors?: string[]; states?: string[]; dependencies?: string[]; security?: string[]; constraints?: string[] };
  v2: { version: string; rules: Array<{ ruleId: string; statement: string; condition?: string; effect?: string }>; acs: Array<{ acId: string; statement: string }>; actors?: string[]; states?: string[]; dependencies?: string[]; security?: string[]; constraints?: string[] };
}): RequirementChangeSet {
  const rules = diffRules(input.v1.rules, input.v2.rules);
  const acDiff = diffRules(input.v1.acs.map((a) => ({ ruleId: a.acId, statement: a.statement })), input.v2.acs.map((a) => ({ ruleId: a.acId, statement: a.statement })));
  const diffStr = (a: string[] = [], b: string[] = []) => ({ added: b.filter((x) => !a.includes(x)), removed: a.filter((x) => !b.includes(x)) });
  const actors = diffStr(input.v1.actors, input.v2.actors);
  const states = diffStr(input.v1.states, input.v2.states);
  const deps = diffStr(input.v1.dependencies, input.v2.dependencies);
  const sec = diffStr(input.v1.security, input.v2.security);
  const constraints = diffStr(input.v1.constraints, input.v2.constraints);
  const changedFactIds = [...rules.added, ...rules.removed, ...rules.changed, ...acDiff.added, ...acDiff.removed, ...acDiff.changed, ...actors.added, ...actors.removed, ...states.added, ...states.removed, ...deps.added, ...deps.removed, ...sec.added, ...sec.removed, ...constraints.added, ...constraints.removed];
  const removedFactIds = [...rules.removed, ...acDiff.removed];
  return {
    requirementId: input.requirementId,
    fromVersion: input.v1.version,
    toVersion: input.v2.version,
    addedRules: rules.added,
    removedRules: rules.removed,
    changedRules: rules.changed,
    addedAC: acDiff.added,
    removedAC: acDiff.removed,
    changedAC: acDiff.changed,
    actorChanges: [...actors.added, ...actors.removed],
    stateChanges: [...states.added, ...states.removed],
    dependencyChanges: [...deps.added, ...deps.removed],
    securityChanges: [...sec.added, ...sec.removed],
    constraintChanges: [...constraints.added, ...constraints.removed],
    changedFactIds,
    removedFactIds
  };
}

// ============ P14.6 Knowledge ChangeSet ============

export interface KnowledgeChangeSet {
  knowledgeId: string;
  fromVersion: string;
  toVersion: string;
  changeKind: "SUPERSEDED" | "SCOPED_EXCEPTION_ADDED" | "RULE_CHANGED" | "CONSTRAINT_CHANGED" | "SECURITY_CHANGED" | "DEPENDENCY_CHANGED";
  changedFields: string[];
}

export function classifyKnowledgeChange(k: { fromVersion: string; toVersion: string; fromCanonical?: string; toCanonical?: string; fromType?: string; toType?: string }): KnowledgeChangeSet["changeKind"] {
  if (k.fromType !== k.toType) {
    if (k.toType === "CONSTRAINT") return "CONSTRAINT_CHANGED";
    if (k.toType === "SECURITY_REQUIREMENT") return "SECURITY_CHANGED";
    if (k.toType === "DEPENDENCY") return "DEPENDENCY_CHANGED";
  }
  return k.fromCanonical !== k.toCanonical ? "RULE_CHANGED" : "SUPERSEDED";
}

// ============ P14.7/8 Page ChangeSet ============

export interface PageChangeSet {
  pageId: string;
  fromVersion: string;
  toVersion: string;
  changeTypes: Array<"ADD_ELEMENT" | "REMOVE_ELEMENT" | "CONTROL_TYPE_CHANGE" | "INTERACTION_CHANGE" | "ASSERTION_CHANGE" | "STATE_CHANGE" | "RESULT_COLUMN_CHANGE" | "OPTION_CHANGE" | "LOCATOR_ONLY_CHANGE">;
  locatorOnly: boolean;
}

export function buildPageChangeSet(input: {
  pageId: string;
  from: { version: string; elementIds: string[]; locatorHashes?: Record<string, string>; assertionIds?: string[]; interactionIds?: string[] };
  to: { version: string; elementIds: string[]; locatorHashes?: Record<string, string>; assertionIds?: string[]; interactionIds?: string[] };
}): PageChangeSet {
  const types: PageChangeSet["changeTypes"] = [];
  const addedElements = input.to.elementIds.filter((id) => !input.from.elementIds.includes(id));
  const removedElements = input.from.elementIds.filter((id) => !input.to.elementIds.includes(id));
  if (addedElements.length) types.push("ADD_ELEMENT");
  if (removedElements.length) types.push("REMOVE_ELEMENT");
  const locatorsChanged = input.from.locatorHashes && input.to.locatorHashes
    ? Object.keys(input.to.locatorHashes).some((id) => input.from.locatorHashes?.[id] && input.from.locatorHashes[id] !== input.to.locatorHashes![id])
    : false;
  if (locatorsChanged) types.push("LOCATOR_ONLY_CHANGE");
  const assertionsChanged = (input.from.assertionIds ?? []).join(",") !== (input.to.assertionIds ?? []).join(",");
  if (assertionsChanged) types.push("ASSERTION_CHANGE");
  const interactionsChanged = (input.from.interactionIds ?? []).join(",") !== (input.to.interactionIds ?? []).join(",");
  if (interactionsChanged) types.push("INTERACTION_CHANGE");
  const locatorOnly = types.length === 1 && types[0] === "LOCATOR_ONLY_CHANGE" || (locatorsChanged && !assertionsChanged && !interactionsChanged && addedElements.length === 0 && removedElements.length === 0);
  return { pageId: input.pageId, fromVersion: input.from.version, toVersion: input.to.version, changeTypes: types, locatorOnly };
}
