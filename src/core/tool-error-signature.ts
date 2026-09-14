/**
 * 工具失败 errorSignature（P16 审计收敛项）。
 *
 * errorSignature = sha256(command + exitCode + normalized stderr + repoHead + diffHash)。
 * 相同 errorSignature 意味着「同一命令、同一退出码、同一（归一化后）stderr、同一仓库状态」，
 * 用于 ReasoningDedupGuard / DeterministicCommandGuard 的幂等短路。
 */

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * stderr 归一化：去掉 ANSI 转义、时间戳、栈内行号、hex 地址与无关空白，
 * 使同一错误的两次输出（仅时间/地址/行号不同）产生相同签名。
 */
export function normalizeStderr(stderr: string): string {
  let value = String(stderr ?? "");
  value = value.replace(/\x1b\[[0-9;]*m/g, "");
  value = value.replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/g, "<ts>");
  value = value.replace(/\b\d{1,2}:\d{2}:\d{2}(?:\.\d+)?\b/g, "<ts>");
  value = value.replace(/\b0x[0-9a-fA-F]+\b/g, "<hex>");
  value = value.replace(/(\d+\.\d+)s\b/g, "<dur>s");
  value = value.replace(/(\([^():]*):\d+(?::\d+)?\)/g, "$1)");
  value = value.replace(/[ \t]+/g, " ");
  const lines = value.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
  const capped = lines.slice(0, 200);
  let joined = capped.join("\n");
  if (joined.length > 8000) joined = `${joined.slice(0, 8000)}\n<stderr-truncated>`;
  return joined;
}

export interface ToolFailureContext {
  command: string;
  exitCode: number | null;
  stderr: string;
  repoHead: string;
  diffHash: string;
}

/** 构建工具失败签名：sha256(command + exitCode + normalized stderr + repoHead + diffHash)。 */
export function buildErrorSignature(context: ToolFailureContext): string {
  return sha256Hex(
    [
      String(context.command),
      String(context.exitCode ?? "null"),
      normalizeStderr(context.stderr),
      String(context.repoHead ?? ""),
      String(context.diffHash ?? "")
    ].join("\n")
  );
}

export interface RepoState {
  repoHead: string;
  diffHash: string;
}

/** 读取仓库状态指纹：repoHead = HEAD commit，diffHash = 工作树/暂存区相对 HEAD 的变更哈希。 */
export async function computeRepoState(rootDir: string): Promise<RepoState> {
  const run = async (file: string, args: string[]): Promise<string> => {
    try {
      const { stdout } = await execFileAsync(file, args, { cwd: rootDir, timeout: 10_000, encoding: "utf8" });
      return stdout.trim();
    } catch {
      return "";
    }
  };
  const repoHead = await run("git", ["rev-parse", "HEAD"]);
  const status = await run("git", ["status", "--porcelain=v1"]);
  const diff = await run("git", ["diff", "--no-ext-diff", "HEAD"]);
  const diffHash = repoHead ? sha256Hex(`${status}\n${diff}`) : "";
  return { repoHead, diffHash };
}
