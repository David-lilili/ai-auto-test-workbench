/**
 * 工具结果压缩与 Diff 上下文（AI Development Token Efficiency Hardening, items 13/14）。
 *
 * item 13：禁止默认把完整 stdout / test logs / browser DOM / 完整 diff 加入下一轮 context。
 *   保存 raw artifact，LLM 只加载 command / status / error summary / relevant lines / artifact reference。
 * item 14：代码修改后下一轮默认加载 changed files + relevant hunks，不是整个 repository snapshot。
 */

import fs from "fs-extra";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";

const execFileAsync = promisify(execFile);

export interface ToolResultInput {
  command: string;
  status: "ok" | "fail" | "error";
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  logs?: string;
  dom?: string;
  diff?: string;
}

export interface CompressedToolResult {
  command: string;
  status: string;
  exitCode: number | null;
  errorSummary: string;
  relevantLines: string[];
  artifactRef: string;
  charsBefore: number;
  charsAfter: number;
  ratio: number;
}

/** 常见噪音行：进度条、重复分隔线、纯空白、时间戳前缀、依赖安装日志等。 */
const NOISE_PATTERN = /^\s*(?:>|✔|✖|✓|·|─|-{3,}|=+|\d+%|⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏|Installing|Downloading|npm warn|warning: (?!.*(error|fail))|Timing:|\[?\d{2}:\d{2}(?::\d{2})?\]?)\s*/;

/** 失败相关行优先保留（error / fail / assertion / TS 编号 / test 摘要）。 */
const RELEVANT_PATTERN = /error|fail|assert|TS\d{4}|✗|not ok|expected|received|Exception|at \S+:\d+|Cannot|Unable|缺失|失败/i;

export function summarizeText(text: string | undefined, maxLines: number): string {
  if (!text) return "";
  const lines = text.split("\n");
  const kept: string[] = [];
  for (const line of lines) {
    if (kept.length >= maxLines) break;
    if (NOISE_PATTERN.test(line)) continue;
    kept.push(line.trimEnd());
  }
  return kept.join("\n");
}

export function extractRelevantLines(text: string | undefined, maxLines: number): string[] {
  if (!text) return [];
  const lines = text.split("\n");
  const hits: string[] = [];
  for (const line of lines) {
    if (hits.length >= maxLines) break;
    if (RELEVANT_PATTERN.test(line) && !NOISE_PATTERN.test(line)) hits.push(line.trim().slice(0, 300));
  }
  return hits;
}

/** item 13：把完整工具输出压缩为 LLM 可见的最小上下文。raw artifact 由调用方另行保存。 */
export function compressToolResult(input: ToolResultInput, options: { maxSummaryLines?: number; maxRelevantLines?: number } = {}): CompressedToolResult {
  const maxSummaryLines = options.maxSummaryLines ?? 20;
  const maxRelevantLines = options.maxRelevantLines ?? 8;
  const rawParts = [input.stdout, input.stderr, input.logs, input.dom, input.diff];
  const charsBefore = rawParts.reduce((sum, part) => sum + (part?.length ?? 0), 0);

  const failureSource = input.status === "ok" ? "" : [input.stderr, input.stdout, input.logs].filter(Boolean).join("\n");
  const errorSummary = input.status === "ok" ? "" : summarizeText(failureSource, maxSummaryLines);
  const relevantLines = extractRelevantLines(failureSource || input.stdout, maxRelevantLines);

  const ref = createHash("sha1").update(`${input.command}\n${charsBefore}\n${input.status}`).digest("hex").slice(0, 12);
  const artifactRef = `artifacts/tool-results/${ref}.raw.txt`;
  const charsAfter = errorSummary.length + relevantLines.join("\n").length;
  return {
    command: input.command,
    status: input.status,
    exitCode: input.exitCode ?? null,
    errorSummary,
    relevantLines,
    artifactRef,
    charsBefore,
    charsAfter,
    ratio: charsBefore > 0 ? charsAfter / charsBefore : 1
  };
}

/** 把压缩结果渲染为下一轮 context 片段。 */
export function renderCompressedToolResult(compressed: CompressedToolResult): string {
  const lines = [
    `- command: ${compressed.command}`,
    `- status: ${compressed.status} (exit ${compressed.exitCode})`,
    `- artifact: ${compressed.artifactRef}`
  ];
  if (compressed.errorSummary) lines.push(`- error summary:\n\`\`\`\n${compressed.errorSummary}\n\`\`\``);
  if (compressed.relevantLines.length > 0) lines.push(`- relevant lines:\n\`\`\`\n${compressed.relevantLines.join("\n")}\n\`\`\``);
  return lines.join("\n");
}

export interface DiffSummary {
  changedFiles: string[];
  statLines: string[];
  diffHash: string;
}

async function runGit(rootDir: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd: rootDir, timeout: 15_000, encoding: "utf8" });
    return stdout;
  } catch {
    return "";
  }
}

/** item 14：changed files + stat（默认不加载完整 diff 内容）。 */
export async function gitDiffSummary(rootDir: string, maxFiles = 15): Promise<DiffSummary> {
  const nameStatus = await runGit(rootDir, ["diff", "--name-status", "HEAD"]);
  const stat = await runGit(rootDir, ["diff", "--stat", "-M", "HEAD"]);
  const changedFiles = nameStatus
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, maxFiles);
  const statLines = stat.split("\n").filter((line) => line.trim().length > 0).slice(0, maxFiles + 4);
  const diffHash = createHash("sha256").update(nameStatus).digest("hex");
  return { changedFiles, statLines, diffHash };
}

/** 读取指定文件的 relevant hunks（限制行数，供 LLM 修复上下文）。 */
export async function readHunksForFiles(rootDir: string, files: string[], maxTotalLines = 400): Promise<string> {
  if (files.length === 0) return "";
  const chunks: string[] = [];
  let used = 0;
  for (const file of files) {
    if (used >= maxTotalLines) break;
    const diff = await runGit(rootDir, ["diff", "--no-ext-diff", "-U8", "--", file]);
    if (!diff.trim()) continue;
    const lines = diff.split("\n");
    const budget = maxTotalLines - used;
    const take = lines.slice(0, budget);
    chunks.push(take.join("\n"));
    used += take.length;
  }
  return chunks.join("\n---\n");
}

/** 项目内相对路径转绝对（用于 artifact 引用一致性）。 */
export function artifactRefFor(rootDir: string, name: string): string {
  return path.join(rootDir, "artifacts", "tool-results", name);
}

export async function saveRawToolResult(rootDir: string, compressed: CompressedToolResult, raw: ToolResultInput): Promise<void> {
  const full = path.join(rootDir, compressed.artifactRef);
  fs.ensureDirSync(path.dirname(full));
  const content = [
    `command: ${raw.command}`,
    `status: ${raw.status}`,
    `--- stdout ---`,
    raw.stdout ?? "",
    `--- stderr ---`,
    raw.stderr ?? "",
    `--- logs ---`,
    raw.logs ?? "",
    `--- dom ---`,
    raw.dom ?? "",
    `--- diff ---`,
    raw.diff ?? ""
  ].join("\n");
  await fs.writeFile(full, content, "utf8");
}
