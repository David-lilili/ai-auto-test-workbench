import type { LoadedContext, TestAccount } from "../core/types.js";

export type AccountFactoryCapabilityStatus = "ready" | "warning" | "missing" | "blocked" | "not_enabled";

export interface AccountFactoryRequirement {
  type: string;
  [key: string]: unknown;
}

export interface AccountFactoryNamingRule {
  schemaVersion?: string;
  pattern?: string;
  prefix?: string;
  suffix?: string;
  sequence?: number;
  fixedSuffix?: boolean;
  [key: string]: unknown;
}

export interface AccountFactoryCapability {
  capabilityId: string;
  name: string;
  status: AccountFactoryCapabilityStatus;
  reason: string;
}

export interface AccountFactoryStepResult {
  stepId: string;
  label: string;
  status: "passed" | "failed" | "skipped" | "blocked";
  startedAt: string;
  finishedAt: string;
  message: string;
  diagnostics?: Record<string, unknown>;
}

export interface AccountFactoryProvisionInput {
  context: LoadedContext;
  project: string;
  env: string;
  username: string;
  password: string;
  reason?: string;
  namingRule?: AccountFactoryNamingRule;
  requirements: AccountFactoryRequirement[];
}

export interface AccountFactoryVerificationArtifact {
  artifactType: "database_check" | "ui_check" | "profile_refresh" | "blocked_gap";
  status: "passed" | "failed" | "blocked" | "skipped";
  target: string;
  summary: string;
  evidence?: Record<string, unknown>;
}

export interface AccountFactoryProvisionResult {
  ok: boolean;
  schemaVersion: "account-factory-result.v1";
  project: string;
  env: string;
  requestedUsername: string;
  status: "created" | "partial_created" | "blocked_by_missing_adapter" | "failed";
  createdAt: string;
  account?: TestAccount;
  steps: AccountFactoryStepResult[];
  verificationArtifacts?: AccountFactoryVerificationArtifact[];
  diagnostics: Record<string, unknown>;
}

export interface AccountFactoryAdapter {
  adapterId: string;
  capabilities(context: LoadedContext): Promise<AccountFactoryCapability[]>;
  provision(input: AccountFactoryProvisionInput): Promise<AccountFactoryProvisionResult>;
}
