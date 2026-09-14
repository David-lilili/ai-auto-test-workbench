/**
 * P14.49-57/78/79：Smart Regression Runner + Doctor。
 *
 * runRegressionPlan 只调用 P13 execute（不新建第二套 executor）。
 * 失败不自动扩大 impact（P14.55）；历史 failure/flaky 只作 priority signal（P14.56）。
 */

import type { RegressionPlan, PlanAssetEntry } from "./regression-plan.js";

export type AssetRunStatus =
  | "PASS" | "PRODUCT_FAILURE" | "MODEL_FAILURE" | "TEST_DATA_FAILURE" | "PRECONDITION_FAILURE"
  | "EXECUTION_FAILURE" | "ASSERTION_FAILURE" | "ENVIRONMENT_FAILURE" | "RISK_BLOCKED" | "CANCELLED"
  | "WAITING_AUTHORIZATION" | "BLOCKED" | "SKIPPED_NEEDS_MODELING" | "NOT_EXECUTABLE" | "SKIPPED";

export interface AssetRunOutcome {
  assetId: string;
  status: AssetRunStatus;
  runId?: string;
  error?: string;
  selectionLevel: string;
}

export interface RegressionRun {
  regressionRunId: string;
  planId: string;
  planVersion: string;
  environment: string;
  assetRuns: AssetRunOutcome[];
  summary: { selected: number; executed: number; passed: number; productFailure: number; modelFailure: number; environmentFailure: number; assertionFailure: number; waitingAuthorization: number; needsModeling: number; notExecutable: number; blocked: number };
  startedAt: string;
  finishedAt?: string;
  status: "RUNNING" | "COMPLETED" | "BLOCKED" | "CANCELLED";
}

export interface RunAssetInput {
  assetId: string;
  version: string;
  selectionLevel: string;
  executionRisk: "HIGH" | "MEDIUM" | "LOW" | "FORBIDDEN";
  readiness: "READY" | "NEEDS_MODELING" | "NEEDS_TEST_DATA" | "NEEDS_ACCOUNT_PROFILE" | "NEEDS_SECURITY_APPROVAL" | "BLOCKED_BY_RISK" | "BLOCKED_BY_KNOWLEDGE" | "INVALID_ASSET" | "READY_WITH_REVIEW";
  disposition: string;
  authorization?: { risk: string; expiresAt: string };
  execute: () => Promise<{ result: string; runId?: string; error?: string }>;
}

/** P14.49/50：batch 执行单个 asset（LOW READY → execute；HIGH → WAITING；FORBIDDEN → BLOCKED）。 */
export async function runAssetWithPolicy(input: RunAssetInput): Promise<AssetRunOutcome> {
  if (input.disposition === "UPDATE_REQUIRED" || input.disposition === "REVIEW_REQUIRED") {
    return { assetId: input.assetId, status: "NOT_EXECUTABLE", selectionLevel: input.selectionLevel, error: `disposition ${input.disposition} 需先更新/审查` };
  }
  if (input.executionRisk === "FORBIDDEN") {
    return { assetId: input.assetId, status: "BLOCKED", selectionLevel: input.selectionLevel, error: "FORBIDDEN risk" };
  }
  if (input.executionRisk === "HIGH" && !input.authorization) {
    return { assetId: input.assetId, status: "WAITING_AUTHORIZATION", selectionLevel: input.selectionLevel, error: "HIGH risk 需授权" };
  }
  if (input.readiness === "NEEDS_MODELING" || input.readiness === "BLOCKED_BY_KNOWLEDGE") {
    return { assetId: input.assetId, status: "SKIPPED_NEEDS_MODELING", selectionLevel: input.selectionLevel, error: `readiness=${input.readiness}` };
  }
  if (input.readiness === "NEEDS_TEST_DATA" || input.readiness === "NEEDS_ACCOUNT_PROFILE") {
    return { assetId: input.assetId, status: "SKIPPED", selectionLevel: input.selectionLevel, error: `readiness=${input.readiness}` };
  }
  if (input.readiness === "BLOCKED_BY_RISK" || input.readiness === "INVALID_ASSET") {
    return { assetId: input.assetId, status: "BLOCKED", selectionLevel: input.selectionLevel, error: `readiness=${input.readiness}` };
  }
  const outcome = await input.execute();
  return { assetId: input.assetId, status: outcome.result as AssetRunStatus, runId: outcome.runId, error: outcome.error, selectionLevel: input.selectionLevel };
}

/** P14.49：runRegressionPlan——sequential 执行 selected assets。 */
export async function runRegressionPlan(input: {
  regressionRunId: string;
  plan: RegressionPlan;
  environment: string;
  resolveAsset: (assetId: string) => RunAssetInput | undefined;
  onAssetComplete?: (outcome: AssetRunOutcome) => void;
}): Promise<RegressionRun> {
  const startedAt = new Date().toISOString();
  const assetRuns: AssetRunOutcome[] = [];
  const runnable = input.plan.selectedAssets.filter((s) => s.selectionLevel !== "EXCLUDED" && s.selectionLevel !== "UPDATE_BEFORE_RUN");
  for (const entry of runnable) {
    const resolved = input.resolveAsset(entry.assetId);
    if (!resolved) {
      assetRuns.push({ assetId: entry.assetId, status: "SKIPPED", selectionLevel: entry.selectionLevel, error: "asset 未找到" });
      continue;
    }
    const outcome = await runAssetWithPolicy(resolved);
    assetRuns.push(outcome);
    input.onAssetComplete?.(outcome);
  }
  const summary = summarizeRuns(assetRuns);
  return {
    regressionRunId: input.regressionRunId,
    planId: input.plan.planId,
    planVersion: input.plan.version,
    environment: input.environment,
    assetRuns,
    summary,
    startedAt,
    finishedAt: new Date().toISOString(),
    status: "COMPLETED"
  };
}

export function summarizeRuns(assetRuns: AssetRunOutcome[]): RegressionRun["summary"] {
  const s: RegressionRun["summary"] = { selected: assetRuns.length, executed: 0, passed: 0, productFailure: 0, modelFailure: 0, environmentFailure: 0, assertionFailure: 0, waitingAuthorization: 0, needsModeling: 0, notExecutable: 0, blocked: 0 };
  for (const r of assetRuns) {
    switch (r.status) {
      case "PASS": s.passed += 1; s.executed += 1; break;
      case "PRODUCT_FAILURE": s.productFailure += 1; s.executed += 1; break;
      case "MODEL_FAILURE": s.modelFailure += 1; s.executed += 1; break;
      case "ENVIRONMENT_FAILURE": s.environmentFailure += 1; s.executed += 1; break;
      case "ASSERTION_FAILURE": s.assertionFailure += 1; s.executed += 1; break;
      case "WAITING_AUTHORIZATION": s.waitingAuthorization += 1; break;
      case "SKIPPED_NEEDS_MODELING": s.needsModeling += 1; break;
      case "NOT_EXECUTABLE": s.notExecutable += 1; break;
      case "BLOCKED": s.blocked += 1; break;
      default: s.executed += 1; break;
    }
  }
  return s;
}

// ============ P14.78 Impact Doctor ============

export interface ImpactDoctorReport {
  pass: boolean;
  issues: string[];
  staleRelationshipIndex: string[];
  missingRequirement: string[];
  missingKnowledgeRef: string[];
  activeAssetMissingRelationship: string[];
  criticalChangedFactUncovered: string[];
  planIncludesSupersededAsset: string[];
  planExcludesMandatoryAsset: string[];
  invalidRisk: string[];
  versionCycle: string[];
}

export function runImpactDoctor(input: {
  graphVersion: string;
  expectedGraphVersion: string;
  assets: Array<{ testAssetId: string; status: string; knowledgeRefs: string[]; risk: { executionRisk: string } }>;
  knownRequirements: string[];
  knownKnowledgeIds: string[];
  criticalChangedFactIds: string[];
  coveredFactIds: string[];
  plan?: RegressionPlan;
}): ImpactDoctorReport {
  const report: ImpactDoctorReport = { pass: true, issues: [], staleRelationshipIndex: [], missingRequirement: [], missingKnowledgeRef: [], activeAssetMissingRelationship: [], criticalChangedFactUncovered: [], planIncludesSupersededAsset: [], planExcludesMandatoryAsset: [], invalidRisk: [], versionCycle: [] };
  if (input.graphVersion !== input.expectedGraphVersion) { report.staleRelationshipIndex.push(input.graphVersion); report.pass = false; }
  for (const a of input.assets) {
    if (a.status !== "ACTIVE") continue;
    for (const k of a.knowledgeRefs) if (!input.knownKnowledgeIds.includes(k)) { report.missingKnowledgeRef.push(`${a.testAssetId}:${k}`); report.pass = false; }
    if (!a.knowledgeRefs.length && !a.risk.executionRisk) { report.activeAssetMissingRelationship.push(a.testAssetId); report.pass = false; }
    if (!["HIGH", "MEDIUM", "LOW", "FORBIDDEN"].includes(a.risk.executionRisk)) { report.invalidRisk.push(a.testAssetId); report.pass = false; }
  }
  const uncovered = input.criticalChangedFactIds.filter((f) => !input.coveredFactIds.includes(f));
  if (uncovered.length) { report.criticalChangedFactUncovered = uncovered; report.pass = false; }
  if (input.plan) {
    for (const s of input.plan.selectedAssets) {
      if (s.selectionLevel === "EXCLUDED" && input.plan.selectedAssets.find((x) => x.assetId === s.assetId)?.impactPath.some((p) => p.includes("CRITICAL"))) {
        report.planExcludesMandatoryAsset.push(s.assetId); report.pass = false;
      }
    }
  }
  report.issues = [...report.staleRelationshipIndex, ...report.missingRequirement, ...report.missingKnowledgeRef, ...report.activeAssetMissingRelationship, ...report.criticalChangedFactUncovered, ...report.planIncludesSupersededAsset, ...report.planExcludesMandatoryAsset, ...report.invalidRisk, ...report.versionCycle];
  return report;
}
