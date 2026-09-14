import path from "node:path";
import fs from "fs-extra";

export interface ProjectCapabilityRegistryResponse {
  schemaVersion: "project-capability-registry.v1";
  project: string;
  exists: boolean;
  filePath?: string;
  updatedAt?: string;
  summary?: Record<string, unknown>;
  capabilities: Array<Record<string, unknown>>;
  nonAuthoritativeEvidence: Array<Record<string, unknown>>;
  warnings: string[];
}

export async function readProjectCapabilityRegistry(options: {
  rootDir: string;
  project: string;
}): Promise<ProjectCapabilityRegistryResponse> {
  const project = normalizeProject(options.project);
  const filePath = path.join(options.rootDir, "storage", "project-capabilities", `${project}.json`);
  if (!(await fs.pathExists(filePath))) {
    return {
      schemaVersion: "project-capability-registry.v1",
      project,
      exists: false,
      capabilities: [],
      nonAuthoritativeEvidence: [],
      warnings: [`Project capability registry is not configured for ${project}.`]
    };
  }

  const raw = await fs.readJson(filePath);
  const registry = isRecord(raw) ? raw : {};
  return {
    schemaVersion: "project-capability-registry.v1",
    project: String(registry.project ?? project),
    exists: true,
    filePath: path.relative(options.rootDir, filePath).replace(/\\/g, "/"),
    updatedAt: stringValue(registry.updatedAt),
    summary: isRecord(registry.summary) ? registry.summary : undefined,
    capabilities: Array.isArray(registry.capabilities) ? registry.capabilities.filter(isRecord) : [],
    nonAuthoritativeEvidence: Array.isArray(registry.nonAuthoritativeEvidence)
      ? registry.nonAuthoritativeEvidence.filter(isRecord)
      : [],
    warnings: []
  };
}

function normalizeProject(project: string): string {
  const value = project.trim() || "demo";
  if (!/^[a-z0-9_-]+$/i.test(value)) throw new Error(`Invalid project key: ${project}`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
