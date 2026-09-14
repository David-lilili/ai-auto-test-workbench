#!/usr/bin/env node
/**
 * evidence:doctor — Evidence Governance Doctor
 *
 * 检查 storage/knowledge-evidence/**（canonical append-only evidence sink）的治理不变量：
 *  1. duplicate_overwrite         同 record 内重复 evidenceId / 稳定 ID 与内容不匹配（内容被覆盖或伪造）
 *  2. broken_reference            evidence 引用的 sourceRunId 源文件缺失（源保留策略外的悬空引用）
 *  3. missing_evidence_file       manifest / git 基线中存在的 record 文件在磁盘上消失（物理删除）
 *  4. illegal_delete_replace      manifest 对比：文件级删除 / entry 级删除 / 内容哈希变更（替换）
 *  5. dangling_verification_history  page-model verificationHistory 引用的 ev_* evidenceId 在 sink 中不存在
 *
 * 用法：
 *   tsx scripts/evidence-governance-doctor.ts [--snapshot] [--project <name>]
 *   --snapshot  写入基线快照（storage/knowledge-evidence/.governance/manifest.json），不判定。
 *   退出码：有 FAIL 为 1，否则 0（WARN 不失败）。
 */

import fs from "fs-extra";
import path from "node:path";
import { execSync } from "node:child_process";
import { EVIDENCE_ROOT, EVIDENCE_GOVERNANCE_DIR, evidenceContentHash, loadEvidenceRecordIndex, type EvidenceRecordLocation } from "../src/core/evidence-immutability-guard.js";
import { deriveStableEvidenceId } from "../src/core/knowledge-evidence-sink.js";
import { buildKnowledgeKey, type KnowledgeEvidence } from "../src/core/knowledge-promotion-policy.js";

const ROOT = process.cwd();
const EVIDENCE_ABS = path.join(ROOT, EVIDENCE_ROOT);
const MANIFEST_PATH = path.join(EVIDENCE_ABS, EVIDENCE_GOVERNANCE_DIR, "manifest.json");
const SINK_ID_PREFIX = "ev_";

interface CheckResult {
  check: string;
  status: "PASS" | "WARN" | "FAIL";
  detail: string;
  count: number;
}

const results: CheckResult[] = [];

function report(check: string, status: CheckResult["status"], detail: string, count = 0): void {
  results.push({ check, status, detail, count });
  console.log(`${status.padEnd(4)} ${check}${count ? ` (${count})` : ""} — ${detail}`);
}

function projectsUnder(): string[] {
  if (!fs.existsSync(EVIDENCE_ABS)) return [];
  return fs.readdirSync(EVIDENCE_ABS).filter((name) => name !== EVIDENCE_GOVERNANCE_DIR && fs.statSync(path.join(EVIDENCE_ABS, name)).isDirectory());
}

function gitTrackedEvidenceFiles(): string[] {
  try {
    const out = execSync(`git ls-files "${EVIDENCE_ROOT}"`, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return out.split(/\r?\n/).filter(Boolean).map((p) => p.replace(/\//g, path.sep));
  } catch {
    return [];
  }
}

async function collectAllLocations(): Promise<Map<string, EvidenceRecordLocation>> {
  const byId = new Map<string, EvidenceRecordLocation>();
  for (const project of projectsUnder()) {
    for (const loc of await loadEvidenceRecordIndex(ROOT, project)) {
      for (const entry of loc.record.evidence) byId.set(entry.evidenceId, loc);
    }
  }
  return byId;
}

async function checkDuplicateOverwrite(allLocations: Map<string, EvidenceRecordLocation>): Promise<void> {
  const issues: string[] = [];
  let scanned = 0;
  for (const [evidenceId, loc] of allLocations) {
    const entries = loc.record.evidence.filter((e) => e.evidenceId === evidenceId);
    scanned++;
    if (entries.length > 1) {
      issues.push(`duplicate evidenceId ${evidenceId} in ${path.relative(ROOT, loc.storePath)}`);
      continue;
    }
    const entry = entries[0];
    const expected = deriveStableEvidenceId(entry.sourceRunId, buildKnowledgeKey(entry.knowledgeType, entry.pageId, entry.targetId, entry.observedValue), entry.observedValue, entry.outcome);
    if (expected !== entry.evidenceId) {
      issues.push(`stable id mismatch for ${evidenceId} in ${path.relative(ROOT, loc.storePath)} — content overwritten or id forged`);
    }
  }
  if (issues.length) report("duplicate_overwrite", "FAIL", issues.slice(0, 3).join("; "), issues.length);
  else report("duplicate_overwrite", "PASS", `scanned ${scanned} evidence entries, all ids consistent`);
}

async function checkBrokenReference(): Promise<void> {
  const runDir = path.join(ROOT, "storage", "exploration-runs");
  const hasRunDir = await fs.pathExists(runDir);
  const missing: string[] = [];
  let explored = 0;
  for (const project of projectsUnder()) {
    for (const loc of await loadEvidenceRecordIndex(ROOT, project)) {
      for (const entry of loc.record.evidence) {
        if (!entry.sourceRunId) continue;
        // 只对 exploration-run 格式的 sourceRunId 校验源文件；
        // UUID（modeling session 等）归属其它 provenance store / 保留策略，不在此判定。
        if (!/^explore_/i.test(entry.sourceRunId)) continue;
        explored++;
        if (!hasRunDir) { missing.push(entry.sourceRunId); continue; }
        const candidates = [
          path.join(runDir, `${entry.sourceRunId}.json`),
          path.join(runDir, entry.sourceRunId)
        ];
        if (!candidates.some((c) => fs.existsSync(c))) missing.push(entry.sourceRunId);
      }
    }
  }
  if (missing.length) report("broken_reference", "WARN", `${missing.length} explore_* sourceRunId 源文件不在 storage/exploration-runs（源保留策略外，仅告警）`, missing.length);
  else report("broken_reference", "PASS", `${explored} explore_* sourceRunId references all resolve`);
}

async function checkMissingEvidenceFile(byId: Map<string, EvidenceRecordLocation>): Promise<void> {
  const issues: string[] = [];
  // git 基线：已提交的 record 文件必须仍在磁盘（历史物理删除的直接证据面）。
  for (const tracked of gitTrackedEvidenceFiles()) {
    const abs = path.join(ROOT, tracked);
    if (!fs.existsSync(abs)) issues.push(`git-tracked evidence file deleted from disk: ${tracked}`);
  }
  if (issues.length) report("missing_evidence_file", "FAIL", issues.slice(0, 3).join("; "), issues.length);
  else report("missing_evidence_file", "PASS", `${gitTrackedEvidenceFiles().length} git-tracked evidence files present on disk`);
}

async function checkIllegalDeleteReplace(): Promise<void> {
  if (!fs.existsSync(MANIFEST_PATH)) {
    report("illegal_delete_replace", "WARN", "no baseline manifest — run with --snapshot to arm baseline comparison");
    return;
  }
  const manifest = await fs.readJson(MANIFEST_PATH) as { createdAt: string; projects: Record<string, { files: Record<string, { evidenceIds: string[]; hashes: Record<string, string> }> }> };
  const issues: string[] = [];
  let baselineFiles = 0;
  for (const [project, projectState] of Object.entries(manifest.projects ?? {})) {
    for (const [relFile, fileState] of Object.entries(projectState.files ?? {})) {
      baselineFiles++;
      const abs = path.join(ROOT, EVIDENCE_ROOT, project, relFile);
      if (!fs.existsSync(abs)) {
        issues.push(`file deleted since baseline: ${EVIDENCE_ROOT}/${project}/${relFile}`);
        continue;
      }
      const record = await fs.readJson(abs).catch(() => undefined) as { evidence?: KnowledgeEvidence[] } | undefined;
      for (const [evidenceId, hash] of Object.entries(fileState.hashes ?? {})) {
        const entry = record?.evidence?.find((e) => e.evidenceId === evidenceId);
        if (!entry) {
          issues.push(`evidence entry deleted since baseline: ${evidenceId} in ${EVIDENCE_ROOT}/${project}/${relFile}`);
          continue;
        }
        const current = evidenceContentHash(entry);
        if (current !== hash) issues.push(`evidence content replaced since baseline: ${evidenceId} in ${EVIDENCE_ROOT}/${project}/${relFile}`);
      }
    }
  }
  if (issues.length) report("illegal_delete_replace", "FAIL", issues.slice(0, 3).join("; "), issues.length);
  else report("illegal_delete_replace", "PASS", `${baselineFiles} baseline files intact, no delete/replace detected (baseline ${manifest.createdAt})`);
}

async function checkDanglingVerificationHistory(byId: Map<string, EvidenceRecordLocation>): Promise<void> {
  const pageModelDir = path.join(ROOT, "storage", "page-models");
  if (!(await fs.pathExists(pageModelDir))) {
    report("dangling_verification_history", "PASS", "no page-models directory");
    return;
  }
  const dangling: string[] = [];
  let referenced = 0;
  for (const file of await fs.readdir(pageModelDir)) {
    if (!file.endsWith(".json")) continue;
    const store = await fs.readJson(path.join(pageModelDir, file)).catch(() => undefined) as { models?: Array<{ elements?: Array<{ verificationHistory?: Array<{ evidenceIds?: string[] }> }> }> } | undefined;
    for (const model of store?.models ?? []) {
      for (const element of model.elements ?? []) {
        for (const history of element.verificationHistory ?? []) {
          for (const id of history.evidenceIds ?? []) {
            if (!id.startsWith(SINK_ID_PREFIX)) continue; // norm:*/P4-* 为派生 id，非 canonical sink 条目
            referenced++;
            if (!byId.has(id)) dangling.push(`${id} (${file})`);
          }
        }
      }
    }
  }
  if (dangling.length) report("dangling_verification_history", "FAIL", `${dangling.slice(0, 3).join("; ")} — verificationHistory 引用 ev_* evidenceId 在 sink 中不存在`, dangling.length);
  else report("dangling_verification_history", "PASS", `${referenced} ev_* verificationHistory references all resolve in sink`);
}

async function writeSnapshot(): Promise<void> {
  const snapshot: Record<string, { files: Record<string, { evidenceIds: string[]; hashes: Record<string, string> }> }> = {};
  let totalFiles = 0;
  let totalEntries = 0;
  for (const project of projectsUnder()) {
    const projectState: Record<string, { evidenceIds: string[]; hashes: Record<string, string> }> = {};
    for (const loc of await loadEvidenceRecordIndex(ROOT, project)) {
      const rel = path.relative(path.join(EVIDENCE_ABS, project), loc.storePath).replace(/\\/g, "/");
      const hashes: Record<string, string> = {};
      for (const entry of loc.record.evidence) hashes[entry.evidenceId] = evidenceContentHash(entry);
      projectState[rel] = { evidenceIds: loc.record.evidence.map((e) => e.evidenceId), hashes };
      totalFiles++;
      totalEntries += loc.record.evidence.length;
    }
    snapshot[project] = { files: projectState };
  }
  await fs.ensureDir(path.dirname(MANIFEST_PATH));
  await fs.writeJson(MANIFEST_PATH, { version: 1, createdAt: new Date().toISOString(), projects: snapshot }, { spaces: 2 });
  console.log(`Snapshot written: ${MANIFEST_PATH} (${totalFiles} files, ${totalEntries} evidence entries)`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const snapshotMode = args.includes("--snapshot");
  const byId = await collectAllLocations();

  if (snapshotMode) {
    await writeSnapshot();
    console.log("EVIDENCE_GOVERNANCE_DOCTOR: snapshot done (no checks run)");
    return;
  }

  await checkDuplicateOverwrite(byId);
  await checkBrokenReference();
  await checkMissingEvidenceFile(byId);
  await checkIllegalDeleteReplace();
  await checkDanglingVerificationHistory(byId);

  const fails = results.filter((r) => r.status === "FAIL").length;
  const warns = results.filter((r) => r.status === "WARN").length;
  console.log(`\nEVIDENCE_GOVERNANCE_DOCTOR: ${results.length} checks, ${fails} FAIL, ${warns} WARN, ${results.length - fails - warns} PASS`);
  process.exit(fails > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error("evidence:doctor crashed:", error);
  process.exit(2);
});
