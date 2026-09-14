/**
 * P13-A：Structured TestAsset Execution Bridge。
 *
 * TestAsset
 *   → StructuredExecutionIntent（provider-neutral）
 *   → ExecutionPreparationPackage v2
 *   → Existing Page Model Planner（structuredIntent 输入）
 *   → Existing DSL Builder
 *   → AutomationCase（唯一出口）
 *
 * 禁止：TestAsset → NL 回译（request 仅 display）；semantic action → locator。
 */

import type { TestAsset } from "./types.js";
import type { StructuredExecutionIntent } from "./structured-intent.js";
import { mapAssetAction } from "./action-registry.js";
import { resolvePagesForAsset } from "./execution-intent.js";
import { mapExpectedOutcome } from "./execution-materializer.js";

// ============ A5/6：Composite Action Expansion ============

export interface ExecutableOperation {
  action: string;          // canonical executable action（click/input/select_option/assert...）
  target: string;          // semantic target（不产生 locator）
  value?: string;
  sourceSemanticActionId?: string;
  capabilityRef?: string;
}

export interface CompositeExpansionRule {
  semanticAction: string;
  /** 展开为 N 个 executable operation（能力/产品知识驱动，非 AI 临时拆）。 */
  expand: (asset: TestAsset, target: string) => ExecutableOperation[];
}

/** A6：业务语义动作 → N 个可执行操作。默认 1:1；资金类动作为复合。 */
export const COMPOSITE_EXPANSION: CompositeExpansionRule[] = [
  {
    semanticAction: "SUBMIT_WITHDRAWAL",
    expand: (asset, target) => {
      const ops: ExecutableOperation[] = [];
      // 由 testData bindings 提供字段值（asset/network/address/amount）
      const bindings = Object.fromEntries(asset.testDataRequirements.map((d) => [d.dimension, d.value]));
      if (bindings.asset) ops.push({ action: "select_option", target: "asset", value: bindings.asset, capabilityRef: "withdraw.asset" });
      if (bindings.network) ops.push({ action: "select_option", target: "network", value: bindings.network, capabilityRef: "withdraw.network" });
      if (bindings.address) ops.push({ action: "input", target: "address", value: bindings.address, capabilityRef: "withdraw.address" });
      if (bindings.balance || bindings.amount) ops.push({ action: "input", target: "amount", value: bindings.amount ?? bindings.balance, capabilityRef: "withdraw.amount" });
      ops.push({ action: "click", target, capabilityRef: "withdraw.submit" });
      return ops;
    }
  }
];

const compositeByAction = new Map(COMPOSITE_EXPANSION.map((r) => [r.semanticAction, r]));

/** A6：1 semantic action → N executable operations（无规则时 1:1）。 */
export function expandExecutableOperations(asset: TestAsset, semanticAction: { action: string; target: string }): ExecutableOperation[] {
  const rule = compositeByAction.get(semanticAction.action);
  if (rule) return rule.expand(asset, semanticAction.target);
  const entry = mapAssetAction(semanticAction.action);
  return [{ action: entry.dslAction, target: semanticAction.target, capabilityRef: asset.capabilityRefs[0] }];
}

// ============ A1/2/11：Bridge ============

export interface AssertionIntentMapping {
  statement: string;
  userAssertionKind: string;
  semanticTarget?: string;
  expectedValue?: string;
  sourceKnowledgeRef?: string;
  mappingSource: "STRUCTURED" | "PARSER_FALLBACK";
  materializable: boolean;
}

export interface ModelingRequest {
  sourceTestAsset: string;
  requiredCapability: string;
  page?: string;
  missingKnowledge: string[];
  risk: string;
  createdAt: string;
}

export function buildStructuredExecutionIntent(asset: TestAsset): StructuredExecutionIntent {
  const capabilities = [...asset.capabilityRefs];
  const entities = [...new Set(asset.semanticActions.map((a) => a.target).filter(Boolean))];
  const module = capabilities[0]?.split(".")[0] ?? "unknown";
  const action = capabilities[0]?.split(".")[1] ?? "unknown";
  return {
    project: "demo",
    module,
    action,
    operationType: /read|query|filter|list/.test(action) ? "read" : "write",
    capabilities,
    entities,
    data: Object.fromEntries(asset.testDataRequirements.map((d) => [d.dimension, d.value])),
    semanticActions: asset.semanticActions.map((a, i) => ({ action: a.action, target: a.target, sourceActionId: `${asset.testAssetId}-action-${i}` })),
    expectedOutcomes: asset.expectedOutcomes.map((o, i) => ({ statement: o.statement, sourceOutcomeId: `${asset.testAssetId}-outcome-${i}`, groundingKind: o.groundingKind, groundingRef: o.knowledgeId ?? o.factId })),
    preconditions: asset.preconditions.map((p) => ({ statement: p.statement })),
    source: { type: "TEST_ASSET", testAssetId: asset.testAssetId, testAssetVersion: asset.version }
  };
}

/** A11/12：ExpectedOutcome → AssertionIntent（结构化优先，parser fallback 标记）。 */
export function mapExpectedOutcomeToAssertionIntent(outcome: { statement: string; knowledgeId?: string; factId?: string }): AssertionIntentMapping {
  const mapped = mapExpectedOutcome(outcome.statement);
  return {
    statement: outcome.statement,
    userAssertionKind: mapped.assertionKind,
    expectedValue: Array.isArray(mapped.dslAssertion?.expected) ? (mapped.dslAssertion.expected as string[])[0] : undefined,
    sourceKnowledgeRef: outcome.knowledgeId ?? outcome.factId,
    mappingSource: mapped.assertionKind !== "unknown" ? "STRUCTURED" : "PARSER_FALLBACK",
    materializable: mapped.materializable
  };
}

/** A7/8/9/10：Capability→Page + Readiness + Modeling Gap。 */
export function resolveExecutionModel(input: {
  asset: TestAsset;
  capabilityPageResolver?: (capability: string) => string[] | undefined;
  pageModelStatus?: (pageId: string) => { exists: boolean; hasRequiredElements: boolean; supportsInteraction: boolean; hasAssertionCapability: boolean } | undefined;
}): {
  resolvedPages: string[];
  pageHintStale: boolean;
  modelGaps: Array<{ capability: string; semanticAction: string; pageId?: string; missing: Array<"CONTROL" | "INTERACTION" | "ASSERTION" | "STATE"> }>;
  readiness: "READY" | "PARTIAL" | "MISSING";
  modelingRequests: ModelingRequest[];
} {
  const resolution = resolvePagesForAsset(input.asset, input.capabilityPageResolver);
  const modelGaps: Array<{ capability: string; semanticAction: string; pageId?: string; missing: Array<"CONTROL" | "INTERACTION" | "ASSERTION" | "STATE"> }> = [];
  const modelingRequests: ModelingRequest[] = [];
  for (const op of input.asset.semanticActions) {
    const missing: Array<"CONTROL" | "INTERACTION" | "ASSERTION" | "STATE"> = [];
    const pageId = resolution.primaryPage;
    const status = pageId ? input.pageModelStatus?.(pageId) : undefined;
    if (!status?.exists) missing.push("CONTROL");
    if (!status?.supportsInteraction) missing.push("INTERACTION");
    if (op.action === "VERIFY_STATE" && !status?.hasAssertionCapability) missing.push("ASSERTION");
    if (missing.length) {
      modelGaps.push({ capability: input.asset.capabilityRefs[0] ?? "unknown", semanticAction: op.action, pageId, missing });
      modelingRequests.push({
        sourceTestAsset: `${input.asset.testAssetId}@${input.asset.version}`,
        requiredCapability: input.asset.capabilityRefs[0] ?? "unknown",
        page: pageId,
        missingKnowledge: missing.map((m) => `${m}_${op.action}`),
        risk: input.asset.risk.executionRisk,
        createdAt: new Date().toISOString()
      });
    }
  }
  const readiness: "READY" | "PARTIAL" | "MISSING" = modelGaps.length === 0 ? "READY" : resolution.pages.length > 0 ? "PARTIAL" : "MISSING";
  // PAGE_HINT_STALE：routing 生效但结果与 stored hint 冲突（不失败 asset，只标记）
  const storedPages = input.asset.executionPath.pages ?? [];
  const pageHintStale = resolution.resolutionSource === "ROUTING" && storedPages.length > 0 && storedPages.some((p) => !resolution.routingPages.includes(p));
  return { resolvedPages: resolution.pages, pageHintStale, modelGaps, readiness, modelingRequests };
}
