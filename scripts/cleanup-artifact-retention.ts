import path from "node:path";
import fs from "fs-extra";

interface RetentionConfig {
  observationRunsHours?: number;
  failedObservationRunsDays?: number;
  failurePackagesDays?: number;
  tempArtifactsHours?: number;
}

const rootDir = process.cwd();
const configPath = path.join(rootDir, "config", "artifact-retention.json");
const config = await fs.readJson(configPath).catch(() => ({})) as RetentionConfig;
const observationHours = Number(config.observationRunsHours ?? 24);
const failedObservationDays = Number(config.failedObservationRunsDays ?? 7);
const now = Date.now();
const observationRoot = path.join(rootDir, "artifacts", "observations", "execution-runs");
const indexPath = path.join(rootDir, "storage", "observation-runs", "index.json");

const index = await fs.readJson(indexPath).catch(() => ({ schemaVersion: "observation-run-index.v1", runs: [] }));
const runs = Array.isArray(index.runs) ? index.runs as Array<Record<string, unknown>> : [];
const keptRuns: Array<Record<string, unknown>> = [];
let removed = 0;

for (const run of runs) {
  const artifactPath = typeof run.artifactPath === "string" ? run.artifactPath : "";
  const fullPath = artifactPath ? path.join(rootDir, artifactPath) : "";
  const status = String(run.status ?? "");
  const createdAt = Date.parse(String(run.completedAt ?? run.createdAt ?? ""));
  const maxAgeMs = status === "passed"
    ? observationHours * 60 * 60 * 1000
    : failedObservationDays * 24 * 60 * 60 * 1000;
  const expired = Number.isFinite(createdAt) && now - createdAt > maxAgeMs;
  if (fullPath && expired && await fs.pathExists(fullPath)) {
    await fs.remove(fullPath);
    removed += 1;
    continue;
  }
  if (!fullPath || await fs.pathExists(fullPath)) keptRuns.push(run);
}

if (await fs.pathExists(observationRoot)) {
  for (const name of await fs.readdir(observationRoot)) {
    const fullPath = path.join(observationRoot, name);
    const stat = await fs.stat(fullPath).catch(() => undefined);
    if (!stat?.isDirectory()) continue;
    const referenced = keptRuns.some((run) => path.normalize(path.join(rootDir, String(run.artifactPath ?? ""))) === path.normalize(fullPath));
    if (referenced) continue;
    const ageMs = now - stat.mtimeMs;
    if (ageMs > observationHours * 60 * 60 * 1000) {
      await fs.remove(fullPath);
      removed += 1;
    }
  }
}

await fs.ensureDir(path.dirname(indexPath));
await fs.writeJson(indexPath, {
  schemaVersion: "observation-run-index.v1",
  updatedAt: new Date().toISOString(),
  runs: keptRuns.slice(0, 200)
}, { spaces: 2 });

console.log(`Artifact retention cleanup completed. removed=${removed}, keptObservationRuns=${keptRuns.length}`);
