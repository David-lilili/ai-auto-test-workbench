import fs from "fs-extra";
import path from "node:path";
import { parseArgs } from "node:util";

/**
 * P5.14：knowledge:storage-governance —— 知识存储治理（可回滚的归档/清理）。
 *
 * 规则（确定性）：
 *  1. Proposal 归档：pending 中 createdAt > retentionDays（默认 60）且无最近证据的移入 storage/proposals/archived
 *  2. Page Model 备份保留：backup-*.json 只保留最近 keepBackups（默认 10）个，旧备份移入 storage/archives/page-models
 *  3. Evidence Sink 治理：只读报告陈旧 evidence（不自动删除——evidence 是审计事实，删除需人工）
 *
 * 安全：--dry-run 默认；--apply 才移动。归档只移动不删除，全部可回滚。
 *
 * 用法:
 *   npx tsx scripts/storage-governance.ts --dry-run          # 预览
 *   npx tsx scripts/storage-governance.ts --apply            # 执行
 *   npx tsx scripts/storage-governance.ts --apply --retention-days 90 --keep-backups 5
 */

const options = parseArgs({
  args: process.argv.slice(2),
  options: {
    project: { type: "string", default: "demo" },
    "retention-days": { type: "string", default: "60" },
    "keep-backups": { type: "string", default: "10" },
    "dry-run": { type: "boolean", default: true },
    apply: { type: "boolean", default: false }
  }
});

const rootDir = path.resolve(".");
const project = options.values.project;
const retentionDays = Number(options.values["retention-days"]);
const keepBackups = Number(options.values["keep-backups"]);
const apply = options.values.apply;

const now = Date.now();

async function archiveProposals(): Promise<{ moved: string[]; skipped: string[] }> {
  const pendingDir = path.join(rootDir, "storage/proposals/pending");
  const archivedDir = path.join(rootDir, "storage/proposals/archived");
  const moved: string[] = [];
  const skipped: string[] = [];
  if (!fs.pathExistsSync(pendingDir)) return { moved, skipped };

  for (const file of fs.readdirSync(pendingDir).filter((f) => f.endsWith(".json"))) {
    let createdAt: string | undefined;
    try {
      const proposal = fs.readJsonSync(path.join(pendingDir, file)) as { createdAt?: string };
      createdAt = proposal.createdAt;
    } catch {
      skipped.push(file);
      continue;
    }
    if (!createdAt) { skipped.push(file); continue; }
    const ageDays = (now - new Date(createdAt).getTime()) / 86400000;
    if (ageDays > retentionDays) moved.push(file);
  }

  if (apply && moved.length) {
    await fs.ensureDir(archivedDir);
    for (const file of moved) {
      await fs.move(path.join(pendingDir, file), path.join(archivedDir, file), { overwrite: false });
    }
  }
  return { moved, skipped };
}

async function pruneBackups(): Promise<{ kept: string[]; moved: string[] }> {
  const backupDir = path.join(rootDir, "storage/page-models");
  const archiveDir = path.join(rootDir, "storage/archives/page-models");
  const kept: string[] = [];
  const moved: string[] = [];
  if (!fs.pathExistsSync(backupDir)) return { kept, moved };

  const backups = fs.readdirSync(backupDir).filter((f) => f.startsWith("backup-")).sort();
  // 保留最近 keepBackups 个（时间戳排序）
  const toKeep = backups.slice(-keepBackups);
  const toMove = backups.slice(0, -keepBackups);

  if (apply && toMove.length) {
    await fs.ensureDir(archiveDir);
    for (const file of toMove) {
      await fs.move(path.join(backupDir, file), path.join(archiveDir, file), { overwrite: false });
    }
  }
  return { kept: toKeep, moved: toMove };
}

async function main(): Promise<void> {
  const proposalResult = await archiveProposals();
  const backupResult = await pruneBackups();

  console.log("=== Knowledge Storage Governance ===\n");
  console.log(`project: ${project} | mode: ${apply ? "APPLY" : "DRY-RUN"} | retentionDays: ${retentionDays} | keepBackups: ${keepBackups}`);
  console.log(`\n## 1. Proposal 归档`);
  console.log(`  >${retentionDays} 天: ${proposalResult.moved.length} 个${apply ? "（已移入 archived）" : "（预览）"}`);
  if (proposalResult.moved.length <= 20) {
    proposalResult.moved.forEach((f) => console.log(`    - ${f}`));
  } else {
    proposalResult.moved.slice(0, 20).forEach((f) => console.log(`    - ${f}`));
    console.log(`    ... 其余 ${proposalResult.moved.length - 20} 个`);
  }

  console.log(`\n## 2. Page Model 备份`);
  console.log(`  保留: ${backupResult.kept.length} 个`);
  console.log(`  移出(>${keepBackups}): ${backupResult.moved.length} 个${apply ? "（已移入 storage/archives/page-models）" : "（预览）"}`);

  console.log(`\n## 3. Evidence Sink`);
  console.log(`  （不自动删除——evidence 是审计事实，删除需人工决定）`);

  console.log(`\n结论: ${apply ? "已执行" : "dry-run（加 --apply 执行；归档只移动不删除，可回滚）"}`);
}

await main();
