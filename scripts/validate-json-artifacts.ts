import fs from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";

interface Finding {
  file: string;
  issue: string;
  detail: string;
}

const DEFAULT_ROOTS = [
  "configs",
  "storage",
  "artifacts",
  "reports",
  "projects",
  ".codex",
  "package.json",
  "tsconfig.json"
];

const SKIP_DIRS = new Set([".git", ".venv", "node_modules", "dist", "build", "__pycache__", ".pytest_cache"]);
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

const roots = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_ROOTS;
const codexCatalog = path.join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".codex", "cc-switch-model-catalog.json");
if (codexCatalog && (await exists(codexCatalog))) roots.push(codexCatalog);
const findings: Finding[] = [];

for (const item of roots) {
  const absolute = path.resolve(process.cwd(), item);
  if (!(await exists(absolute))) continue;
  const stat = await fs.stat(absolute);
  if (stat.isFile()) {
    if (absolute.endsWith(".json")) await validateJsonFile(absolute);
    continue;
  }
  await walk(absolute);
}

if (findings.length > 0) {
  for (const finding of findings) {
    console.log(`${relative(finding.file)}: ${finding.issue}: ${finding.detail}`);
  }
  console.log(`\nJSON artifact validation failed: ${findings.length} issue(s).`);
  process.exit(1);
}

console.log("JSON artifact validation passed: all scanned JSON files are UTF-8 no BOM and parseable.");

async function walk(directory: string): Promise<void> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await walk(fullPath);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".json")) await validateJsonFile(fullPath);
  }
}

async function validateJsonFile(filePath: string): Promise<void> {
  try {
    const data = await fs.readFile(filePath);
    if (data.subarray(0, 3).equals(UTF8_BOM)) {
      findings.push({ file: filePath, issue: "utf8_bom", detail: "UTF-8 BOM is not allowed." });
      return;
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(data);
    JSON.parse(text);
  } catch (error) {
    findings.push({
      file: filePath,
      issue: "invalid_json_artifact",
      detail: error instanceof Error ? error.message : String(error)
    });
  }
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
