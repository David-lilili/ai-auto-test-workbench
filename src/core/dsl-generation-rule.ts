import path from "node:path";
import fs from "fs-extra";
import type { DataBindingUpdateProposal, EvidenceRef, FailureDiagnosisSidecar } from "./failure-diagnosis.js";
import type { LoadedContext } from "./types.js";
import { writeSafeJsonFile } from "./safe-file-writer.js";

export interface DslGenerationRule {
  schemaVersion: "dsl-generation-rule.v1";
  ruleId: string;
  project: string;
  module: string;
  action: string;
  targetField: string;
  semanticName: string;
  valueSource: string;
  fallbackSources: string[];
  valueType: "string" | "number" | "boolean" | "asset" | "amount" | "count" | "code" | "unknown";
  validation?: {
    required?: boolean;
    type?: "string" | "number" | "boolean";
    min?: number;
    integer?: boolean;
  };
  evidence: EvidenceRef[];
  sourceProposalId: string;
  sourceRunId?: string;
  enabled: boolean;
  createdAt: string;
  createdBy: "manual-confirmation";
  updatedAt: string;
  disabledAt?: string;
  disabledReason?: string;
}

export interface DslGenerationRuleStoreData {
  schemaVersion: "dsl-generation-rule-store.v1";
  project: string;
  updatedAt: string;
  rules: DslGenerationRule[];
}

export interface DslGenerationRuleDiff {
  semanticName: string;
  before: {
    value: unknown;
    valueSource?: string;
  };
  after: {
    value: unknown;
    valueSource: string;
    ruleId: string;
  };
}

export class DslGenerationRuleStore {
  readonly filePath: string;

  constructor(private readonly context: LoadedContext) {
    this.filePath = path.join(context.rootDir, "storage", "dsl-generation-rules", `${context.project.projectKey}.json`);
  }

  async load(): Promise<DslGenerationRuleStoreData> {
    if (!(await fs.pathExists(this.filePath))) {
      return {
        schemaVersion: "dsl-generation-rule-store.v1",
        project: this.context.project.projectKey,
        updatedAt: new Date().toISOString(),
        rules: []
      };
    }
    return (await fs.readJson(this.filePath)) as DslGenerationRuleStoreData;
  }

  async save(data: DslGenerationRuleStoreData): Promise<string> {
    data.updatedAt = new Date().toISOString();
    await writeSafeJsonFile(this.filePath, data);
    return this.filePath;
  }

  async upsert(rule: DslGenerationRule): Promise<string> {
    const data = await this.load();
    const index = data.rules.findIndex((item) => item.ruleId === rule.ruleId || item.sourceProposalId === rule.sourceProposalId);
    if (index >= 0) {
      const existing = data.rules[index];
      data.rules[index] = {
        ...existing,
        ...rule,
        ruleId: existing.ruleId,
        createdAt: existing.createdAt,
        updatedAt: new Date().toISOString()
      };
    } else {
      data.rules.unshift(rule);
    }
    return this.save(data);
  }

  async disableByRuleId(ruleId: string, reason: string): Promise<boolean> {
    const data = await this.load();
    const rule = data.rules.find((item) => item.ruleId === ruleId);
    if (!rule) return false;
    rule.enabled = false;
    rule.disabledAt = new Date().toISOString();
    rule.disabledReason = reason;
    rule.updatedAt = new Date().toISOString();
    await this.save(data);
    return true;
  }
}

export function dataBindingProposalFromSidecar(sidecar: FailureDiagnosisSidecar): DataBindingUpdateProposal {
  const proposal = sidecar.proposals.find((item) => item.proposalType === "DataBindingUpdateProposal");
  if (!proposal || proposal.proposalType !== "DataBindingUpdateProposal") {
    throw new Error("DataBindingUpdateProposal not found in diagnosis sidecar.");
  }
  return proposal;
}

export function buildDslGenerationRuleFromProposal(input: {
  project: string;
  sourceRunId?: string;
  proposal: DataBindingUpdateProposal;
  createdAt?: string;
}): DslGenerationRule {
  const at = input.createdAt ?? new Date().toISOString();
  return {
    schemaVersion: "dsl-generation-rule.v1",
    ruleId: ruleIdFor(input.project, input.proposal),
    project: input.project,
    module: input.proposal.module,
    action: input.proposal.action,
    targetField: input.proposal.targetField,
    semanticName: input.proposal.semanticName,
    valueSource: input.proposal.newBinding.sourcePath ?? "intent.data.value",
    fallbackSources: fallbackSourcesFor(input.proposal),
    valueType: input.proposal.newBinding.valueType,
    validation: validationFor(input.proposal.newBinding.valueType),
    evidence: input.proposal.evidence,
    sourceProposalId: input.proposal.proposalId,
    sourceRunId: input.sourceRunId,
    enabled: true,
    createdAt: at,
    createdBy: "manual-confirmation",
    updatedAt: at
  };
}

export function buildDslGenerationRuleDiff(input: {
  proposal: DataBindingUpdateProposal;
  rule: DslGenerationRule;
}): DslGenerationRuleDiff {
  return {
    semanticName: input.proposal.semanticName,
    before: {
      value: input.proposal.oldBinding?.value,
      valueSource: input.proposal.oldBinding?.sourcePath
    },
    after: {
      value: input.proposal.newBinding.value,
      valueSource: input.rule.valueSource,
      ruleId: input.rule.ruleId
    }
  };
}

function ruleIdFor(project: string, proposal: DataBindingUpdateProposal): string {
  return `${project}.${proposal.module.replace(/-/g, "_")}.${proposal.action}.${proposal.targetField}.intent_count`;
}

function fallbackSourcesFor(proposal: DataBindingUpdateProposal): string[] {
  if (proposal.targetField === "red_packet_count") return ["intent.data.quantity"];
  return [];
}

function validationFor(valueType: DslGenerationRule["valueType"]): DslGenerationRule["validation"] {
  if (valueType === "count") {
    return {
      required: true,
      type: "number",
      min: 1,
      integer: true
    };
  }
  if (valueType === "amount") return { required: true, type: "number", min: 0 };
  if (valueType === "string" || valueType === "code" || valueType === "asset") return { required: true, type: "string" };
  return { required: true };
}
