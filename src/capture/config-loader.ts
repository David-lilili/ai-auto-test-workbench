import fs from "fs-extra";
import YAML from "yaml";
import type { CaptureRunConfig } from "./types.js";

export async function loadCaptureRunConfig(filePath: string): Promise<CaptureRunConfig> {
  const text = await fs.readFile(filePath, "utf8");
  const raw = YAML.parse(text) as Record<string, unknown>;
  const errors: string[] = [];
  const requireString = (key: string): string => {
    const value = raw[key];
    if (typeof value !== "string" || !value.trim()) {
      errors.push(`capture run config missing required string field: ${key}`);
      return "";
    }
    return value;
  };
  const config: CaptureRunConfig = {
    runId: requireString("runId"),
    project: requireString("project"),
    env: requireString("env"),
    platform: "web",
    locale: requireString("locale"),
    schemaVersion: requireString("schemaVersion"),
    entryUrl: requireString("entryUrl"),
    entryPageId: requireString("entryPageId"),
    entryLabel: String(raw.entryLabel ?? raw.entryPageId ?? ""),
    targets: normalizeTargets(raw.targets, errors),
    signalGroups: normalizeSignalGroups(raw.signalGroups, errors),
    dataBindingRules: normalizeDataBindingRules(raw.dataBindingRules ?? [], errors),
    preconditionRules: normalizePreconditionRules(raw.preconditionRules ?? [], errors),
    coverageProbes: normalizeCoverageProbes(raw.coverageProbes ?? []),
    viewport: normalizeViewport(raw.viewport),
    headed: raw.headed === true,
    navigationTimeoutMs: typeof raw.navigationTimeoutMs === "number" ? raw.navigationTimeoutMs : undefined,
    reportTitle: typeof raw.reportTitle === "string" ? raw.reportTitle : undefined,
    nextStage: normalizeNextStage(raw.nextStage)
  };
  if (errors.length) {
    throw new Error(`Invalid capture run config ${filePath}:\n- ${errors.join("\n- ")}`);
  }
  return config;
}

function normalizeTargets(value: unknown, errors: string[]): CaptureRunConfig["targets"] {
  if (!Array.isArray(value) || !value.length) {
    errors.push("capture run config requires a non-empty targets list");
    return [];
  }
  return value.map((item, index) => {
    const record = (item ?? {}) as Record<string, unknown>;
    const kind = record.kind === "same_page_action" ? "same_page_action" : "direct_page";
    const target = {
      id: String(record.id ?? ""),
      pageId: String(record.pageId ?? ""),
      label: String(record.label ?? ""),
      module: String(record.module ?? ""),
      action: String(record.action ?? "open"),
      kind,
      url: typeof record.url === "string" ? record.url : undefined,
      entryText: typeof record.entryText === "string" ? record.entryText : undefined,
      expectedCapability: String(record.expectedCapability ?? ""),
      riskLevel: normalizeRiskLevel(record.riskLevel)
    } as CaptureRunConfig["targets"][number];
    if (!target.id || !target.pageId || !target.label) {
      errors.push(`targets[${index}] requires id, pageId and label`);
    }
    if (kind === "direct_page" && !target.url) {
      errors.push(`targets[${index}] with kind=direct_page requires url`);
    }
    if (kind === "same_page_action" && !target.entryText) {
      errors.push(`targets[${index}] with kind=same_page_action requires entryText`);
    }
    return target;
  });
}

function normalizeSignalGroups(value: unknown, errors: string[]): CaptureRunConfig["signalGroups"] {
  if (!Array.isArray(value) || !value.length) {
    errors.push("capture run config requires a non-empty signalGroups list");
    return [];
  }
  return value.map((item, index) => {
    const record = (item ?? {}) as Record<string, unknown>;
    const name = String(record.name ?? "");
    const terms = Array.isArray(record.terms) ? record.terms.map(String).filter(Boolean) : [];
    if (!name || !terms.length) {
      errors.push(`signalGroups[${index}] requires name and a non-empty terms list`);
    }
    return {
      name,
      terms,
      weight: typeof record.weight === "number" ? record.weight : 1,
      role: normalizeSignalRole(record.role)
    };
  });
}

function normalizeDataBindingRules(value: unknown, errors: string[]): CaptureRunConfig["dataBindingRules"] {
  if (!Array.isArray(value)) return [];
  return value.map((item, index) => {
    const record = (item ?? {}) as Record<string, unknown>;
    const rule = {
      term: String(record.term ?? ""),
      targetField: String(record.targetField ?? ""),
      valueType: String(record.valueType ?? "string"),
      sourcePath: String(record.sourcePath ?? "")
    };
    if (!rule.term || !rule.targetField) {
      errors.push(`dataBindingRules[${index}] requires term and targetField`);
    }
    return rule;
  });
}

function normalizePreconditionRules(value: unknown, errors: string[]): CaptureRunConfig["preconditionRules"] {
  if (!Array.isArray(value)) return [];
  return value.map((item, index) => {
    const record = (item ?? {}) as Record<string, unknown>;
    const rule = { name: String(record.name ?? ""), pattern: String(record.pattern ?? "") };
    if (!rule.name || !rule.pattern) {
      errors.push(`preconditionRules[${index}] requires name and pattern`);
    }
    return rule;
  });
}

function normalizeCoverageProbes(value: unknown): CaptureRunConfig["coverageProbes"] {
  if (!Array.isArray(value)) return undefined;
  return value.map((item) => {
    const record = (item ?? {}) as Record<string, unknown>;
    return {
      key: String(record.key ?? ""),
      purpose: String(record.purpose ?? ""),
      requiresTargetIds: Array.isArray(record.requiresTargetIds) ? record.requiresTargetIds.map(String) : [],
      gaps: Array.isArray(record.gaps) ? record.gaps.map(String) : []
    };
  }).filter((probe) => probe.key);
}

function normalizeViewport(value: unknown): { width: number; height: number } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const width = typeof record.width === "number" ? record.width : undefined;
  const height = typeof record.height === "number" ? record.height : undefined;
  return width && height ? { width, height } : undefined;
}

function normalizeNextStage(value: unknown): CaptureRunConfig["nextStage"] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const stage = typeof record.stage === "string" ? record.stage : undefined;
  const reason = typeof record.reason === "string" ? record.reason : undefined;
  return stage && reason ? { stage, reason } : undefined;
}

function normalizeRiskLevel(value: unknown): "low" | "medium" | "high" {
  return value === "high" || value === "medium" ? value : "low";
}

function normalizeSignalRole(value: unknown): "success" | "form" | "record" | "block" | undefined {
  return value === "success" || value === "form" || value === "record" || value === "block" ? value : undefined;
}
