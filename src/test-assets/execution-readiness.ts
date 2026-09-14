/**
 * P13.3/4：Execution Readiness Gate。
 *
 * Asset Ready 与 Execution Ready 严格分离：
 * Asset ACTIVE/FRESH ≠ 可执行；缺 Page Model → NEEDS_MODELING，不改 Asset。
 */

import type { TestAsset } from "./types.js";
import type { ExecutionReadinessStatus } from "./execution-types.js";

export interface ExecutionReadinessInput {
  asset: TestAsset;
  knowledgeRefsActive: (ids: string[]) => boolean;
  pageModelsAvailable: (pages: string[]) => boolean;
  semanticActionsMaterializable: boolean;
  expectedOutcomesMaterializable: boolean;
  testDataResolved: boolean;
  accountProfileResolved: boolean;
  riskPermitted: boolean;
  blockingAmbiguity: number;
  executionPathKnown: boolean;
  staleCriticalKnowledge: boolean;
}

export interface ExecutionReadinessResult {
  status: ExecutionReadinessStatus;
  reasons: string[];
}

export function evaluateExecutionReadiness(input: ExecutionReadinessInput): ExecutionReadinessResult {
  const reasons: string[] = [];
  // INVALID_ASSET
  if (input.asset.status !== "ACTIVE") { reasons.push("asset 非 ACTIVE"); return { status: "INVALID_ASSET", reasons }; }
  if (input.asset.assetFreshness === "INVALID") { reasons.push("asset freshness INVALID"); return { status: "INVALID_ASSET", reasons }; }
  // BLOCKED_BY_KNOWLEDGE
  if (input.staleCriticalKnowledge) { reasons.push("critical knowledge STALE"); return { status: "BLOCKED_BY_KNOWLEDGE", reasons }; }
  if (!input.knowledgeRefsActive(input.asset.knowledgeRefs)) { reasons.push("knowledge refs 非 ACTIVE"); return { status: "BLOCKED_BY_KNOWLEDGE", reasons }; }
  // BLOCKED_BY_RISK
  if (!input.riskPermitted) { reasons.push("risk 不允许执行"); return { status: "BLOCKED_BY_RISK", reasons }; }
  // NEEDS_ACCOUNT_PROFILE
  if (input.asset.accountProfileRequirements.length > 0 && !input.accountProfileResolved) { reasons.push("account profile 未解析"); return { status: "NEEDS_ACCOUNT_PROFILE", reasons }; }
  // NEEDS_TEST_DATA
  if (!input.testDataResolved) { reasons.push("test data 未解析"); return { status: "NEEDS_TEST_DATA", reasons }; }
  // NEEDS_MODELING
  if (!input.pageModelsAvailable(input.asset.executionPath.pages)) { reasons.push("page model 缺失"); return { status: "NEEDS_MODELING", reasons }; }
  if (!input.semanticActionsMaterializable) { reasons.push("semantic actions 不可物化"); return { status: "NEEDS_MODELING", reasons }; }
  if (!input.expectedOutcomesMaterializable) { reasons.push("expected outcomes 不可物化"); return { status: "NEEDS_MODELING", reasons }; }
  // NEEDS_SECURITY_APPROVAL
  if (input.asset.risk.designPriority === "CRITICAL" || input.asset.risk.executionRisk === "HIGH") { reasons.push("security/high risk 需显式授权"); return { status: "NEEDS_SECURITY_APPROVAL", reasons }; }
  // READY_WITH_REVIEW
  if (input.blockingAmbiguity > 0) { reasons.push(`blocking ambiguity=${input.blockingAmbiguity}`); return { status: "READY_WITH_REVIEW", reasons }; }
  if (!input.executionPathKnown) { reasons.push("execution path PARTIAL/UNKNOWN"); return { status: "READY_WITH_REVIEW", reasons }; }
  return { status: "READY", reasons };
}
