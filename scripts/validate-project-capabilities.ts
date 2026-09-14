import fs from "node:fs/promises";
import path from "node:path";

const ALLOWED_TYPES = new Set([
  "platform_pattern",
  "page_model",
  "operation_manual",
  "project_knowledge_map",
  "case_asset",
  "account_profile",
  "database_model",
  "account_factory_adapter",
  "provider",
  "modeling_script",
  "validation_script",
  "project_workflow",
  "project_operation_guide"
]);

const ALLOWED_STATUSES = new Set(["verified", "candidate", "blocked", "deprecated"]);
const ALLOWED_REUSE_SCOPES = new Set(["project_only", "project_env_only", "pattern_only", "platform_generic"]);

interface Finding {
  file: string;
  issue: string;
  detail: string;
}

const roots = process.argv.slice(2).length ? process.argv.slice(2) : ["storage/project-capabilities"];
const findings: Finding[] = [];

for (const root of roots) {
  const absolute = path.resolve(process.cwd(), root);
  if (!(await exists(absolute))) continue;
  const stat = await fs.stat(absolute);
  if (stat.isFile()) {
    await validateRegistry(absolute);
    continue;
  }
  await walk(absolute);
}

if (findings.length) {
  for (const finding of findings) {
    console.log(`${relative(finding.file)}: ${finding.issue}: ${finding.detail}`);
  }
  console.log(`\nProject capability validation failed: ${findings.length} issue(s).`);
  process.exit(1);
}

console.log("Project capability validation passed.");

async function walk(directory: string): Promise<void> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await walk(fullPath);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".json")) await validateRegistry(fullPath);
  }
}

async function validateRegistry(filePath: string): Promise<void> {
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    add(filePath, "invalid_json", error instanceof Error ? error.message : String(error));
    return;
  }

  const registry = record(raw);
  if (registry.schemaVersion !== "project-capability-registry.v1") {
    add(filePath, "invalid_schema_version", "schemaVersion must be project-capability-registry.v1.");
  }
  const project = stringValue(registry.project);
  if (!project) add(filePath, "missing_project", "project is required.");
  if (!stringValue(registry.updatedAt)) add(filePath, "missing_updated_at", "updatedAt is required.");

  const capabilities = Array.isArray(registry.capabilities) ? registry.capabilities : undefined;
  if (!capabilities?.length) {
    add(filePath, "missing_capabilities", "capabilities must be a non-empty array.");
    return;
  }

  const ids = new Set<string>();
  for (let index = 0; index < capabilities.length; index += 1) {
    const capability = record(capabilities[index]);
    const prefix = `capabilities[${index}]`;
    const id = stringValue(capability.capabilityId);
    if (!id) {
      add(filePath, "missing_capability_id", `${prefix}.capabilityId is required.`);
    } else {
      if (ids.has(id)) add(filePath, "duplicate_capability_id", id);
      ids.add(id);
      if (project && !id.startsWith(`${project}.`) && !id.startsWith("platform.")) {
        add(filePath, "capability_id_project_mismatch", `${id} should start with ${project}. or platform.`);
      }
    }
    if (!stringValue(capability.name)) add(filePath, "missing_capability_name", `${prefix}.name is required.`);
    validateEnum(filePath, `${prefix}.type`, capability.type, ALLOWED_TYPES);
    validateEnum(filePath, `${prefix}.status`, capability.status, ALLOWED_STATUSES);
    validateEnum(filePath, `${prefix}.reuseScope`, capability.reuseScope, ALLOWED_REUSE_SCOPES);
    validateStringArray(filePath, `${prefix}.envs`, capability.envs, { allowEmpty: true });
    validateStringArray(filePath, `${prefix}.entrypoints`, capability.entrypoints, { allowEmpty: false });
    validateStringArray(filePath, `${prefix}.knowledgeAssets`, capability.knowledgeAssets, { allowEmpty: true });
    validateStringArray(filePath, `${prefix}.outputs`, capability.outputs, { allowEmpty: true });
    validateStringArray(filePath, `${prefix}.dependsOn`, capability.dependsOn, { allowEmpty: true });
    validateProjectScriptEntrypoints(filePath, prefix, capability);
    if (!stringValue(capability.handoffNotes)) add(filePath, "missing_handoff_notes", `${prefix}.handoffNotes is required.`);
  }

  for (let index = 0; index < capabilities.length; index += 1) {
    const capability = record(capabilities[index]);
    const dependsOn = Array.isArray(capability.dependsOn) ? capability.dependsOn : [];
    for (const dependency of dependsOn) {
      const value = stringValue(dependency);
      if (!value || isExternalReference(value) || ids.has(value)) continue;
      add(filePath, "unknown_capability_dependency", `${capability.capabilityId ?? `capabilities[${index}]`} depends on ${value}.`);
    }
  }
}

function validateProjectScriptEntrypoints(filePath: string, prefix: string, capability: Record<string, unknown>): void {
  const type = stringValue(capability.type);
  if (type !== "modeling_script" && type !== "validation_script") return;
  const entrypoints = Array.isArray(capability.entrypoints) ? capability.entrypoints : [];
  for (const entrypoint of entrypoints) {
    const value = stringValue(entrypoint);
    if (!value || !value.endsWith(".ts")) continue;
    if (!value.startsWith("scripts/projects/")) {
      add(
        filePath,
        "project_script_entrypoint_not_project_scoped",
        `${prefix}.entrypoints must use scripts/projects/<project>/... for project-scoped scripts: ${value}`
      );
    }
  }
}

function validateEnum(filePath: string, field: string, value: unknown, allowed: Set<string>): void {
  const text = stringValue(value);
  if (!text || !allowed.has(text)) add(filePath, "invalid_enum", `${field} must be one of: ${[...allowed].join(", ")}.`);
}

function validateStringArray(filePath: string, field: string, value: unknown, options: { allowEmpty: boolean }): void {
  if (!Array.isArray(value)) {
    add(filePath, "invalid_array", `${field} must be an array.`);
    return;
  }
  if (!options.allowEmpty && value.length === 0) add(filePath, "empty_array", `${field} must not be empty.`);
  value.forEach((item, index) => {
    if (!stringValue(item)) add(filePath, "invalid_array_item", `${field}[${index}] must be a non-empty string.`);
  });
}

function isExternalReference(value: string): boolean {
  return (
    value.includes("/") ||
    value.includes("\\") ||
    /^(GET|POST|PUT|PATCH|DELETE)\s+\//.test(value) ||
    /^[a-z]+:\/\//i.test(value)
  );
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function add(file: string, issue: string, detail: string): void {
  findings.push({ file, issue, detail });
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function relative(filePath: string): string {
  return path.relative(process.cwd(), filePath) || filePath;
}
