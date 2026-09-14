/**
 * P13.28-30：Execution Risk Gate + Authorization + Environment Gate。
 *
 * Asset Human Approved ≠ Run Approved。HIGH 需显式 execution approval；
 * FORBIDDEN 即使 authorize 也 BLOCK。复用 exploration-risk-policy 唯一词表。
 */

import { classifyRisk } from "../core/exploration-risk-policy.js";
import type { TestAsset } from "./types.js";
import type { ExecutionAuthorization } from "./execution-types.js";

export type ExecutionEnvironment = "LOCAL" | "DEV" | "UAT" | "PRODUCTION";

export interface RiskGateInput {
  asset: TestAsset;
  environment: ExecutionEnvironment;
  authorization?: Pick<ExecutionAuthorization, "risk" | "expiresAt">;
  actionText?: string;
}

export interface RiskGateResult {
  allowed: boolean;
  reason: string;
  riskLevel: string;
  needsAuthorization: boolean;
}

export function executionRiskGate(input: RiskGateInput): RiskGateResult {
  const text = input.actionText ?? `${input.asset.title} ${input.asset.semanticActions.map((a) => a.action + " " + a.target).join(" ")}`;
  const risk = classifyRisk(text);
  // FORBIDDEN：即使 authorize 也 BLOCK
  if (risk === "forbidden") {
    return { allowed: false, reason: `FORBIDDEN risk（${text.slice(0, 60)}）——即使授权也不允许执行`, riskLevel: "FORBIDDEN", needsAuthorization: false };
  }
  if (risk === "high") {
    const authorized = input.authorization && new Date(input.authorization.expiresAt) > new Date() && input.authorization.risk === "high";
    return { allowed: Boolean(authorized), reason: authorized ? "high risk authorized" : "HIGH risk 需显式 execution approval", riskLevel: "HIGH", needsAuthorization: !authorized };
  }
  if (risk === "medium") {
    // MEDIUM：按 policy——默认需要 authorization 或显式确认；LOCAL 可放宽
    if (input.environment === "PRODUCTION") {
      return { allowed: false, reason: "PRODUCTION 环境默认禁止 medium 以上 autonomous execution", riskLevel: "MEDIUM", needsAuthorization: true };
    }
    const authorized = input.authorization && new Date(input.authorization.expiresAt) > new Date();
    return { allowed: Boolean(authorized) || input.environment === "LOCAL", reason: authorized ? "medium risk authorized" : "MEDIUM risk 需授权（LOCAL 可执行）", riskLevel: "MEDIUM", needsAuthorization: !authorized && input.environment !== "LOCAL" };
  }
  // LOW：可自动 execute
  return { allowed: true, reason: "LOW risk 允许自动执行", riskLevel: "LOW", needsAuthorization: false };
}

/** P13.30：environment gate——PRODUCTION 默认禁止 autonomous。 */
export function environmentGate(input: { environment: ExecutionEnvironment; explicitPolicy?: boolean }): { allowed: boolean; reason: string } {
  if (input.environment === "PRODUCTION" && !input.explicitPolicy) {
    return { allowed: false, reason: "PRODUCTION 默认禁止 autonomous execution（除非现有政策明确支持）" };
  }
  return { allowed: true, reason: `${input.environment} 允许` };
}

export function createExecutionAuthorization(input: {
  assetId: string;
  assetVersion: string;
  environment: string;
  risk: string;
  approvedBy: string;
  ttlHours?: number;
}): ExecutionAuthorization {
  const now = new Date();
  const expires = new Date(now.getTime() + (input.ttlHours ?? 24) * 3600_000);
  return {
    authorizationId: `auth-${input.assetId}-${Date.now()}`,
    assetId: input.assetId,
    assetVersion: input.assetVersion,
    runScope: "single",
    environment: input.environment,
    risk: input.risk,
    approvedBy: input.approvedBy,
    expiresAt: expires.toISOString(),
    createdAt: now.toISOString()
  };
}
