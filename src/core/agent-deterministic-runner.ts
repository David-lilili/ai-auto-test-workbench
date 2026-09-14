/**
 * Deterministic Tool Runner（AI Development Token Efficiency Hardening, items 7/8/9）。
 *
 * item 7：以下步骤默认不调用 LLM，由 DeterministicToolRunner 直接执行：
 *   typecheck / lint / unit tests / npm verify / known scripts / git status / git diff summary /
 *   file existence / doctor / format checks。
 * item 8：Tool Result State Machine——patch 后自动执行 typecheck → test → doctor 链，
 *   PASS 就继续下一个确定性验证，不回 LLM；只有整条 deterministic chain 完成才把 compact summary 交回 LLM。
 * item 9：Failure Escalation——工具失败先确定性分类，只有需要代码 reasoning 的错误才触发 LLM。
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type DeterministicCommandKind =
  | "typecheck"
  | "lint"
  | "unit_test"
  | "npm_verify"
  | "known_script"
  | "git_status"
  | "git_diff_summary"
  | "file_existence"
  | "format_check"
  | "doctor"
  | "unknown";

const KIND_PATTERNS: Array<{ kind: Exclude<DeterministicCommandKind, "unknown">; pattern: RegExp }> = [
  { kind: "typecheck", pattern: /tsc --noEmit|npm run typecheck|typecheck/ },
  { kind: "lint", pattern: /npm run lint|\beslint\b/ },
  { kind: "unit_test", pattern: /tsx --test|vitest|jest|npm test|npm run test\b|run-tests\.ts/ },
  { kind: "npm_verify", pattern: /npm run verify/ },
  { kind: "git_status", pattern: /git status/ },
  { kind: "git_diff_summary", pattern: /git diff( |$)|git log --oneline/ },
  { kind: "file_existence", pattern: /test -[efd]|\[ -[efd]|pathExists|ls -l (?!.*node_modules)/ },
  { kind: "format_check", pattern: /encoding:check|prettier --check|format:check/ },
  { kind: "doctor", pattern: /doctor|:doctor\b/ },
  { kind: "known_script", pattern: /npm run [a-z0-9:_-]+|npx tsx scripts\/[a-zA-Z0-9._-]+\.ts/ }
];

/** 判定命令是否属于「确定性工具」（不需要 LLM reasoning 就能执行并解释结果）。 */
export function classifyDeterministicCommand(command: string): DeterministicCommandKind {
  const trimmed = String(command ?? "").trim();
  if (!trimmed) return "unknown";
  for (const { kind, pattern } of KIND_PATTERNS) {
    if (pattern.test(trimmed)) return kind;
  }
  return "unknown";
}

export function isDeterministicCommand(command: string): boolean {
  return classifyDeterministicCommand(command) !== "unknown";
}

export interface DeterministicRunResult {
  kind: DeterministicCommandKind;
  command: string;
  exitCode: number | null;
  status: "pass" | "fail" | "error";
  /** 失败/错误时给 LLM 的压缩摘要；PASS 时为空串（不回 LLM）。 */
  summary: string;
  stdoutSummary: string;
  stderrSummary: string;
  elapsedMs: number;
}

export interface DeterministicRunnerOptions {
  cwd: string;
  timeoutMs?: number;
  /** 供测试注入的命令执行器；默认走系统 shell。 */
  exec?: (command: string, cwd: string, timeoutMs: number) => Promise<{ stdout: string; stderr: string; code: number | null }>;
}

const defaultExec = async (command: string, cwd: string, timeoutMs: number): Promise<{ stdout: string; stderr: string; code: number | null }> => {
  const shell = process.platform === "win32" ? "bash" : "sh";
  try {
    const { stdout, stderr } = await execFileAsync(shell, ["-lc", command], { cwd, timeout: timeoutMs, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; code?: number | string; killed?: boolean };
    return {
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? String(error instanceof Error ? error.message : error),
      code: typeof err.code === "number" ? err.code : err.killed ? null : 1
    };
  }
};

function head(text: string, maxLines: number): string {
  return String(text ?? "").split("\n").slice(0, maxLines).join("\n");
}

/** item 7：确定性工具执行器。执行结果以压缩摘要返回，PASS 路径不产生 LLM 轮次。 */
export class DeterministicToolRunner {
  private readonly exec: NonNullable<DeterministicRunnerOptions["exec"]>;

  constructor(private readonly options: DeterministicRunnerOptions) {
    this.exec = options.exec ?? defaultExec;
  }

  async run(command: string): Promise<DeterministicRunResult> {
    const kind = classifyDeterministicCommand(command);
    const startedAt = Date.now();
    if (kind === "unknown") {
      return {
        kind,
        command,
        exitCode: null,
        status: "error",
        summary: `non-deterministic command: ${command}`,
        stdoutSummary: "",
        stderrSummary: "",
        elapsedMs: 0
      };
    }
    const { stdout, stderr, code } = await this.exec(command, this.options.cwd, this.options.timeoutMs ?? 120_000);
    const exitCode = code;
    const status = exitCode === 0 ? "pass" : exitCode === null ? "error" : "fail";
    const summary = status === "pass" ? "" : summarizeFailure(kind, stdout, stderr);
    return {
      kind,
      command,
      exitCode,
      status,
      summary,
      stdoutSummary: head(stdout, 20),
      stderrSummary: head(stderr, 20),
      elapsedMs: Date.now() - startedAt
    };
  }
}

/**
 * item 9：工具失败确定性分类。
 * - KNOWN_TRANSIENT：超时/网络抖动/资源争用 → 确定性重试，不触发 LLM。
 * - KNOWN_FORMAT_ERROR：格式/编码问题 → 确定性修复路径，不触发 LLM。
 * - KNOWN_TYPE_ERROR：TypeScript 类型错误 → 需要代码 reasoning，触发 LLM。
 * - KNOWN_TEST_ASSERTION：测试断言失败 → 需要代码 reasoning，触发 LLM。
 * - ENVIRONMENT_ERROR：环境/依赖缺失 → 确定性处理（install/doctor），不触发 LLM。
 * - UNKNOWN：→ 触发 LLM。
 */
export type ToolFailureKind = "KNOWN_TRANSIENT" | "KNOWN_FORMAT_ERROR" | "KNOWN_TYPE_ERROR" | "KNOWN_TEST_ASSERTION" | "ENVIRONMENT_ERROR" | "UNKNOWN";

export interface FailureContext {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

const TRANSIENT_PATTERN = /ETIMEDOUT|ECONNRESET|ECONNREFUSED|socket hang up|timeout|aborted|EAGAIN|EPIPE|request failed|502|503|504/i;
const FORMAT_PATTERN = /encoding|charset|invalid utf|illegal character|BOM|prettier|format error|line endings|CRLF/i;
const TYPE_PATTERN = /error TS\d+|type error|typecheck|TS\d{4}|is not assignable|cannot find module|property .* does not exist/i;
const TEST_PATTERN = /AssertionError|assert\.|test.*failed|# fail|✖|not ok \d|expected .* to (equal|deepEqual)|Received|✓.*✗|tests.*fail/i;
const ENV_PATTERN = /command not found|Cannot find module|MODULE_NOT_FOUND|ENOENT|EACCES|not installed|npm ERR! (?!code)/i;

export function classifyToolFailure(context: FailureContext): ToolFailureKind {
  const message = `${context.stdout ?? ""}\n${context.stderr ?? ""}`;
  if (TRANSIENT_PATTERN.test(message)) return "KNOWN_TRANSIENT";
  if (FORMAT_PATTERN.test(message)) return "KNOWN_FORMAT_ERROR";
  if (TYPE_PATTERN.test(message)) return "KNOWN_TYPE_ERROR";
  if (TEST_PATTERN.test(message)) return "KNOWN_TEST_ASSERTION";
  if (ENV_PATTERN.test(message)) return "ENVIRONMENT_ERROR";
  return "UNKNOWN";
}

/** 只有需要代码 reasoning 的失败才升级给 LLM。 */
export function shouldEscalateToLlm(kind: ToolFailureKind): boolean {
  return kind === "KNOWN_TYPE_ERROR" || kind === "KNOWN_TEST_ASSERTION" || kind === "UNKNOWN";
}

function summarizeFailure(kind: DeterministicCommandKind, stdout: string, stderr: string): string {
  const failureKind = classifyToolFailure({ command: "", exitCode: 1, stdout, stderr });
  const source = (stderr || stdout).trim();
  return `[${failureKind}] ${head(source, 6)}`;
}

/**
 * item 8：确定性验证链状态机。
 * chain = ["typecheck", "unit_test", "doctor"]；PASS 自动执行下一项，不回 LLM；
 * FAIL 且需要 reasoning 才升级 LLM；整个 chain 完成后才把 compact summary 交回 LLM。
 */
export class ToolResultStateMachine {
  constructor(
    private readonly chain: DeterministicCommandKind[],
    private readonly runner: DeterministicToolRunner
  ) {}

  /** 按链顺序执行确定性验证；返回每个步骤结果与最终动作。 */
  async executeChain(commands: Record<DeterministicCommandKind, string | undefined>): Promise<{
    results: DeterministicRunResult[];
    action: "chain_complete_return_to_llm" | "escalate_to_llm" | "deterministic_retry";
    failureKind: ToolFailureKind | null;
  }> {
    const results: DeterministicRunResult[] = [];
    for (const kind of this.chain) {
      const command = commands[kind];
      if (!command) continue;
      const result = await this.runner.run(command);
      results.push(result);
      if (result.status === "pass") continue;
      const failureKind = classifyToolFailure({ command, exitCode: result.exitCode, stdout: result.stdoutSummary, stderr: result.stderrSummary });
      if (failureKind === "KNOWN_TRANSIENT") return { results, action: "deterministic_retry", failureKind };
      if (shouldEscalateToLlm(failureKind)) return { results, action: "escalate_to_llm", failureKind };
      // KNOWN_FORMAT_ERROR / ENVIRONMENT_ERROR：确定性处理（如 auto-fix / doctor），链继续前先返回处理信号。
      return { results, action: "deterministic_retry", failureKind };
    }
    return { results, action: "chain_complete_return_to_llm", failureKind: null };
  }
}
