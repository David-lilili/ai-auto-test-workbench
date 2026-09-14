/**
 * P9.0：Context Inventory Audit（只读）。
 *
 * 扫描全仓库可能承担 AI context 的内容，输出：
 *   reports/context-audit/document-inventory.json
 *   reports/context-audit/document-inventory.md
 *
 * 每条记录：path / title / purpose / audience / lastModified / gitCommit / approx size /
 * currently referenced by / possible source-of-truth domain / possible duplicate / possible stale。
 */

import fs from "fs-extra";
import path from "node:path";
import { execSync } from "node:child_process";

const ROOT = process.cwd();
const OUT_DIR = "reports/context-audit";

interface InventoryItem {
  path: string;
  title: string;
  type: string;
  sizeBytes: number;
  lastModified: string;
  gitCommit?: string;
  status: "active_context" | "historical_report" | "runtime_artifact" | "reference";
  purpose: string;
  audience: string;
  sourceOfTruthDomain?: string;
  duplicateOf?: string;
  staleRisk: string;
}

function gitCommitOf(file: string): string | undefined {
  try {
    return execSync(`git log -1 --format=%h -- "${file}"`, { cwd: ROOT, encoding: "utf8" }).trim() || undefined;
  } catch {
    return undefined;
  }
}

function titleOf(file: string): string {
  try {
    const head = fs.readFileSync(file, "utf8").split("\n").slice(0, 8).join("\n");
    const m = head.match(/^#\s+(.+)$/m);
    return m ? m[1].trim() : path.basename(file, path.extname(file));
  } catch {
    return path.basename(file, path.extname(file));
  }
}

function classifyType(p: string): string {
  if (/AI_START_HERE|START_PROTOCOL/.test(p)) return "BOOTSTRAP_GUIDE";
  if (/architecture|design-decisions|platform-design/.test(p)) return "ARCHITECTURE";
  if (/playbook|workflow|guide|playbook/.test(p)) return "PLAYBOOK_OR_GUIDE";
  if (/handoff|current-context|current-state|current-status/.test(p)) return "CURRENT_STATE_OR_HANDOFF";
  if (/policy|risk|promotion|governance|secrets/.test(p)) return "POLICY";
  if (/schema/.test(p)) return "SCHEMA";
  if (/troubleshooting|mcp|redis|totp|database|encoding/.test(p)) return "RUNTIME_REFERENCE";
  if (/^P\d|legacy|milestone|stage|phase/.test(path.basename(p))) return "PHASE_REPORT";
  if (/benchmark|baseline|mutation/.test(p)) return "BENCHMARK";
  if (/README|CHANGELOG|product-design|case-authoring/.test(p)) return "PROJECT_REFERENCE";
  return "REFERENCE";
}

function walkMd(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "archive") continue;
      walkMd(full, acc);
    } else if (entry.name.endsWith(".md")) {
      acc.push(full);
    }
  }
  return acc;
}

async function main(): Promise<void> {
  await fs.ensureDir(OUT_DIR);
  const files = new Set<string>();
  // 顶层 + docs + reports（md 为主；json 报告列入 historical/runtime 标注）
  if (fs.pathExistsSync("docs")) for (const f of walkMd("docs")) files.add(f);
  if (fs.pathExistsSync("reports")) for (const f of walkMd("reports")) files.add(f);
  for (const f of ["README.md", "CHANGELOG.md", "UI_GUIDE.md"]) if (fs.pathExistsSync(f)) files.add(f);

  const items: InventoryItem[] = [];
  for (const file of [...files].sort()) {
    const rel = path.relative(ROOT, file).replace(/\\/g, "/");
    const stat = fs.statSync(file);
    const type = classifyType(rel);
    const isHistorical = type === "PHASE_REPORT" || /reports\/.*\.(json|md)$/.test(rel) && !/modeling-benchmark|context-audit/.test(rel);
    const staleRisk = type === "PHASE_REPORT"
      ? "historical phase report: 默认不加载，仅 debug 历史回归按需读取"
      : /handoff|current/.test(rel)
        ? "high-churn: 每次 phase 更新，需确认 freshness"
        : /README|architecture/.test(rel)
          ? "medium: 与代码可能漂移，doctor 检测 hash 变化"
          : "low";
    items.push({
      path: rel,
      title: titleOf(file),
      type,
      sizeBytes: stat.size,
      lastModified: stat.mtime.toISOString(),
      gitCommit: gitCommitOf(rel),
      status: isHistorical ? "historical_report" : type === "RUNTIME_REFERENCE" || type === "PROJECT_REFERENCE" ? "reference" : "active_context",
      purpose: type,
      audience: "AI Agent / developer",
      sourceOfTruthDomain: type === "ARCHITECTURE" ? "platform_architecture" : type === "POLICY" ? "policy" : type === "SCHEMA" ? "page_model_schema" : undefined,
      duplicateOf: type === "PHASE_REPORT" ? "superseded by CURRENT_STATE + latest handoff" : undefined,
      staleRisk
    });
  }

  const summary = {
    total: items.length,
    byType: items.reduce((acc, i) => { acc[i.type] = (acc[i.type] ?? 0) + 1; return acc; }, {} as Record<string, number>),
    activeContext: items.filter((i) => i.status === "active_context").length,
    historicalReport: items.filter((i) => i.status === "historical_report").length,
    staleCandidates: items.filter((i) => i.staleRisk.startsWith("historical")).length,
    possibleDuplicates: items.filter((i) => i.duplicateOf).length
  };

  await fs.writeJson(path.join(OUT_DIR, "document-inventory.json"), { generatedAt: new Date().toISOString(), summary, items }, { spaces: 2 });

  const md = [
    "# Context Inventory Audit（P9.0）",
    "",
    `- generatedAt: ${new Date().toISOString()}`,
    `- total: ${summary.total}`,
    `- active context: ${summary.activeContext} | historical report: ${summary.historicalReport}`,
    "",
    "## byType",
    "",
    ...Object.entries(summary.byType).map(([k, v]) => `- ${k}: ${v}`),
    "",
    "## Items",
    "",
    ...items.map((i) => [
      `### ${i.path}`,
      `- title: ${i.title} | type: ${i.type} | status: ${i.status}`,
      `- size: ${i.sizeBytes}B | lastModified: ${i.lastModified.slice(0, 10)} | commit: ${i.gitCommit ?? "-"}`,
      `- SoT domain: ${i.sourceOfTruthDomain ?? "-"} | duplicate: ${i.duplicateOf ?? "-"}`,
      `- stale risk: ${i.staleRisk}`,
      ""
    ]).flat(),
    ""
  ].join("\n");
  await fs.writeFile(path.join(OUT_DIR, "document-inventory.md"), md, "utf8");

  console.log(`盘点完成: ${summary.total} 份文档`);
  console.log(`  分类: ${JSON.stringify(summary.byType)}`);
  console.log(`  历史报告: ${summary.historicalReport} | 可能重复: ${summary.possibleDuplicates}`);
  console.log(`  输出: ${OUT_DIR}/document-inventory.json / .md`);
}

await main();
