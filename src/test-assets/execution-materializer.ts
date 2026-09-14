/**
 * P13.19-27：ExpectedOutcome Mapping + Structured Materializer + Semantic Completeness。
 *
 * 复用：user-assertion-parser（ExpectedOutcome → UserAssertionKind）、
 * DslExecutor 的 semantic locator 解析（semantic_target，不产生 locator）、
 * DSL 契约（AutomationCase/DslStep/DslAssertion）。
 */

import crypto from "node:crypto";
import type { TestAsset } from "./types.js";
import type { AutomationCase, DslAssertion, DslStep } from "../core/types.js";
import { parseUserAssertions } from "../core/user-assertion-parser.js";
import { mapAssetAction } from "./action-registry.js";
import type { ExecutionIntent } from "./execution-types.js";
import { buildExecutionIntent } from "./execution-intent.js";
import type { SemanticCompleteness } from "./execution-types.js";

export interface OutcomeMappingResult {
  statement: string;
  assertionKind: string;
  materializable: boolean;
  dslAssertion?: DslAssertion;
}

/** P13.19/20：ExpectedOutcome → UserAssertionKind（复用现有 parser）。 */
export function mapExpectedOutcome(statement: string): OutcomeMappingResult {
  const parsed = parseUserAssertions({ assertions: [statement] });
  const assertion = parsed.assertions[0];
  const kind = assertion?.kind ?? "unknown";
  // 能力缺口（assertion_capability_missing）→ 需要 page model assertion capability，但 DSL 断言仍可发出
  const capabilityGaps = parsed.gaps.filter((g) => g.startsWith("assertion_capability_missing"));
  const materializable = kind !== "unknown";
  // expectedTexts 过短（如 "可见"）会形成假阳性断言——用完整 statement 作为 expected
  const rawExpected = assertion?.expectedTexts ?? [];
  const expected = rawExpected.some((t) => t.length >= 4) ? rawExpected : [statement];
  // success_message/failure_message 在 driver assertState 无分支会静默通过 → 归一化到 message_visible_exact
  const driverKind = kind === "success_message" || kind === "failure_message" ? "message_visible_exact" : kind;
  const dslAssertion: DslAssertion | undefined = materializable
    ? {
        type: driverKind,
        target: assertion.rawText,
        expected,
        source: "test-asset"
      }
    : undefined;
  return { statement, assertionKind: kind, materializable, dslAssertion };
}

export interface MaterializationInput {
  asset: TestAsset;
  intent?: ExecutionIntent;
  baseUrl?: string;
  pageId?: string;
  caseId?: string;
}

export interface MaterializationResult {
  testCase: AutomationCase;
  sourceType: "TEST_ASSET";
  sourceRef: string;
  semanticCompleteness: SemanticCompleteness;
  completenessDetail: string[];
  assertionMappings: OutcomeMappingResult[];
  fingerprint: string;
  warnings: string[];
}

/** P13.21/23：Structured materializer——不产生 locator，语义动作交给 executor 解析。 */
export function materializeTestAssetDsl(input: MaterializationInput): MaterializationResult {
  const intent = input.intent ?? buildExecutionIntent(input.asset);
  const warnings: string[] = [];
  const steps: DslStep[] = [];

  // navigate（P13.9 page resolution hint；LOGIN_PAGE → executor 落 env.web.baseUrl）
  if (input.pageId) {
    steps.push({
      id: "step-navigate",
      action: "navigate",
      target: "LOGIN_PAGE",
      semantic_target: input.pageId,
      expectedPageAfterAction: input.pageId,
      riskLevel: "low"
    });
  }

  // 语义动作 → DSL steps（semantic_target，无 locator；P13.8 禁止 click(locator)）
  const dataBindings = Object.fromEntries(input.asset.testDataRequirements.map((d) => [d.dimension, d.value]));
  const bindingForTarget = (target: string): string | undefined => {
    if (dataBindings[target] !== undefined) return dataBindings[target];
    // 目标语义与维度关键词对应（金额→amount、网络→network、地址→address、资产→asset）
    const keywords: Array<[string, string]> = [["金额", "amount"], ["网络", "network"], ["地址", "address"], ["资产", "asset"], ["数量", "amount"]];
    for (const [kw, dim] of keywords) {
      if (target.includes(kw) && dataBindings[dim] !== undefined) return dataBindings[dim];
    }
    return undefined;
  };
  for (const op of intent.operations) {
    const entry = mapAssetAction(op.action);
    if (entry.status === "UNSUPPORTED") {
      warnings.push(`UNSUPPORTED action: ${op.action}`);
      continue;
    }
    if (entry.status === "NEEDS_MAPPING") {
      warnings.push(`NEEDS_MAPPING action: ${op.action} (materialized as click)`);
    }
    const step: DslStep = {
      id: `step-${steps.length + 1}`,
      action: entry.dslAction,
      target: op.target,
      semantic_target: op.target,
      riskLevel: input.asset.risk.executionRisk === "HIGH" ? "high" : input.asset.risk.executionRisk === "MEDIUM" ? "medium" : "low"
    };
    // test data binding 注入 value（P13-C：value 来自 resolver，非 AI 编造）
    if (op.value !== undefined) step.value = op.value;
    else {
      const binding = bindingForTarget(op.target);
      if (binding !== undefined) step.value = binding;
    }
    steps.push(step);
  }

  // expectedOutcomes → assertions（复用 user-assertion-parser）
  const assertionMappings = input.asset.expectedOutcomes.map((o) => mapExpectedOutcome(o.statement));
  const assertions: DslAssertion[] = [];
  for (const m of assertionMappings) {
    if (m.materializable && m.dslAssertion) {
      assertions.push({ ...m.dslAssertion, source: "test-asset" });
    } else {
      warnings.push(`UNMATERIALIZABLE expectation: ${m.statement} (kind=${m.assertionKind})`);
    }
  }

  // P13.26：semantic completeness
  const operationsMaterialized = intent.operations.length === 0 ? 0 : intent.operations.filter((op) => mapAssetAction(op.action).status !== "UNSUPPORTED").length;
  const outcomesMaterialized = assertionMappings.filter((m) => m.materializable).length;
  const completenessDetail = [
    `operations ${operationsMaterialized}/${intent.operations.length}`,
    `outcomes ${outcomesMaterialized}/${assertionMappings.length}`
  ];
  let semanticCompleteness: SemanticCompleteness;
  if (intent.operations.length > 0 && operationsMaterialized < intent.operations.length) semanticCompleteness = "PARTIAL";
  else if (intent.operations.length > 0 && assertions.length === 0) semanticCompleteness = "SHALLOW";
  else if (assertions.length > 0 && outcomesMaterialized === assertionMappings.length) semanticCompleteness = "FULL";
  else semanticCompleteness = "PARTIAL";

  const testCase: AutomationCase = {
    id: input.caseId ?? `TA-${input.asset.testAssetId}@${input.asset.version}`,
    title: input.asset.title,
    type: "web",
    project: "demo",
    module: "withdraw",
    priority: input.asset.risk.designPriority === "CRITICAL" ? "P0" : input.asset.risk.designPriority === "HIGH" ? "P1" : "P2",
    tags: ["test-asset"],
    owner: "p13",
    env: ["test"],
    steps,
    assertions
  };

  // P13.24：DSL fingerprint
  const fingerprintPayload = JSON.stringify({
    testAssetVersion: input.asset.version,
    pageId: input.pageId,
    steps: steps.map((s) => `${s.action}:${s.semantic_target ?? ""}`),
    assertions: assertions.map((a) => `${a.type}:${String(a.expected ?? a.target)}`)
  });
  const fingerprint = crypto.createHash("sha256").update(fingerprintPayload).digest("hex").slice(0, 16);

  return {
    testCase,
    sourceType: "TEST_ASSET",
    sourceRef: `${input.asset.testAssetId}@${input.asset.version}`,
    semanticCompleteness,
    completenessDetail,
    assertionMappings,
    fingerprint,
    warnings
  };
}
