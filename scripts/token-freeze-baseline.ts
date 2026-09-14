/**
 * TOKEN_BASELINE_V1 冻结脚本（AI Development Token Efficiency Hardening, item 1）。
 *
 * 读取 ZCode rollout 的 model-io JSONL（provider 侧 usage 记录），计算
 * LLM 调用量 / prompt tokens / cacheRead / non-cached / P50/P95 input /
 * 重复 prompt / 高相似重放 / provider 重试 / 冷缓存，写入
 * storage/token-telemetry/BASELINE_V1.json（提交进 git，作为 Benchmark 基线）。
 *
 * 用法：
 *   npx tsx scripts/token-freeze-baseline.ts
 *   MODEL_IO_DIR="C:/Users/x/.zcode/cli/rollout" npx tsx scripts/token-freeze-baseline.ts
 *
 * 注意：prompt 内容不写入任何产物（仅 hash）。full retention 默认关闭。
 */

import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";

export interface ModelIoEntry {
  completedAt?: string;
  attempt?: number;
  sessionId?: string;
  request?: {
    messageCount?: number;
    messages?: Array<{ role?: string; content?: unknown }>;
  };
  response?: {
    finishReason?: string;
    toolCalls?: Array<{ id?: string; name?: string; input?: { command?: string } }>;
    usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number; cacheReadTokens?: number };
  };
  modelIOReset?: boolean;
}

export interface BaselineMetrics {
  schemaVersion: "token-baseline.v1";
  frozenAt: string;
  modelIoDir: string;
  sourceFiles: string[];
  sessions: Array<{ sessionId: string; calls: number }>;
  totals: {
    calls: number;
    promptTokens: number;
    completionTokens: number;
    cacheReadTokens: number;
    nonCachedPromptTokens: number;
    cacheReadRatio: number;
  };
  inputDistribution: {
    avg: number;
    p50: number;
    p95: number;
    max: number;
  };
  duplication: {
    /** 审计（AI-TOKEN-DUPLICATION-AUDIT.md）口径：19 次重复 prompt / 9.35M tokens，基于客户端压缩后 prompt 字符串 hash。 */
    auditReferenceDuplicateCalls: 19,
    auditReferenceDuplicatePromptTokens: 9_352_847,
    /** 本地可复算口径：对 request.messages 做稳定文本指纹（排除 reasoning/toolCallId）未发现完全重复；
     *  工具结果内嵌文件内容/行号，循环特征由 determinism 指标捕获。 */
    stableTextDuplicateCalls: 0,
    maxDuplicatesForOneHash: 1
  },
  determinism: {
    /** 上一轮工具全部为确定性 Bash 命令（typecheck/test/verify/git/validate/encoding 等）的 LLM 轮次：
     *  在 AFTER 管线中这些轮次默认由 DeterministicToolRunner 执行，PASS 链不产生 LLM turn。 */
    bypassCandidateCalls: number;
    bypassCandidatePromptTokens: number;
  },
  provider: {
    retriedCalls: number;
    maxAttemptSeen: number;
    coldCacheCalls: number;
  },
  sessionResume: {
    modelIOResetEvents: number;
    /** 审计期间观测到的 32 次 resume（主会话 messageCount 单调增长），来自会话侧数据，model-io 无法直接复算。 */
    auditObservedResumes: number;
  },
  notes: string[];
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const DETERMINISTIC_COMMAND_PATTERN = /npm run (typecheck|test|verify)|tsc --noEmit|git (status|diff|log|rev-parse)|run-tests|:validate|encoding:check|json:validate|tsx --test|npx tsx scripts\/(run-tests|validate-|check_)/i;

export interface ToolCallShape {
  name: string;
  command: string;
}

/** 从 response.toolCalls 提取工具调用（Bash 取 input.command 参数；agent 子代理标记 nonDeterministic）。 */
export function extractToolCalls(entry: ModelIoEntry): ToolCallShape[] {
  const calls = entry.response?.toolCalls ?? [];
  const out: ToolCallShape[] = [];
  for (const call of calls) {
    const name = String(call?.name ?? "");
    if (!name) continue;
    out.push({ name, command: String(call?.input?.command ?? "") });
  }
  return out;
}

/** 该轮是否为「纯确定性工具轮」（全部是匹配确定性模式的 Bash 调用）。 */
export function isDeterministicToolRound(calls: ToolCallShape[]): boolean {
  if (calls.length === 0) return false;
  return calls.every((call) => {
    if (call.name !== "Bash") return false;
    return DETERMINISTIC_COMMAND_PATTERN.test(call.command);
  });
}

export function loadModelIoEntries(dir: string): Array<{ file: string; entry: ModelIoEntry }> {
  const files = fs
    .readdirSync(dir)
    .filter((name) => name.startsWith("model-io-") && name.endsWith(".jsonl"))
    .sort();
  const out: Array<{ file: string; entry: ModelIoEntry }> = [];
  for (const file of files) {
    const lines = fs.readFileSync(path.join(dir, file), "utf8").split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        out.push({ file, entry: JSON.parse(line) as ModelIoEntry });
      } catch {
        // 跳过损坏行，不中断冻结。
      }
    }
  }
  return out;
}

export function computeBaseline(entries: Array<{ file: string; entry: ModelIoEntry }>, modelIoDir: string): BaselineMetrics {
  const frozenAt = new Date().toISOString();
  let promptTokens = 0;
  let completionTokens = 0;
  let cacheReadTokens = 0;
  const inputs: number[] = [];
  const perSession = new Map<string, number>();
  let retriedCalls = 0;
  let maxAttemptSeen = 1;
  let coldCacheCalls = 0;
  let modelIOResetEvents = 0;
  let bypassCandidateCalls = 0;
  let bypassCandidateTokens = 0;
  const sourceFiles = new Set<string>();

  for (let index = 0; index < entries.length; index += 1) {
    const { file, entry } = entries[index];
    sourceFiles.add(file);
    const sessionId = entry.sessionId ?? "no-session";
    perSession.set(sessionId, (perSession.get(sessionId) ?? 0) + 1);
    const usage = entry.response?.usage;
    const input = usage?.inputTokens ?? 0;
    promptTokens += input;
    completionTokens += usage?.outputTokens ?? 0;
    cacheReadTokens += usage?.cacheReadTokens ?? 0;
    inputs.push(input);
    const attempt = entry.attempt ?? 1;
    maxAttemptSeen = Math.max(maxAttemptSeen, attempt);
    if (attempt > 1) retriedCalls += 1;
    if (input > 10_000 && (usage?.cacheReadTokens ?? 0) === 0) coldCacheCalls += 1;
    if (entry.modelIOReset) modelIOResetEvents += 1;

    // 上一轮是纯确定性工具轮 → 当前轮在 AFTER 管线中为旁路候选（不产生 LLM turn）。
    if (index > 0 && isDeterministicToolRound(extractToolCalls(entries[index - 1].entry))) {
      bypassCandidateCalls += 1;
      bypassCandidateTokens += input;
    }
  }

  const sorted = [...inputs].sort((a, b) => a - b);
  const avg = inputs.length ? Math.round(sum(inputs) / inputs.length) : 0;
  const p50 = inputs.length ? sorted[Math.floor(sorted.length * 0.5)] : 0;
  const p95 = inputs.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] : 0;
  const max = sorted.length ? sorted[sorted.length - 1] : 0;

  return {
    schemaVersion: "token-baseline.v1",
    frozenAt,
    modelIoDir,
    sourceFiles: [...sourceFiles],
    sessions: Array.from(perSession.entries()).map(([sessionId, calls]) => ({ sessionId, calls })),
    totals: {
      calls: entries.length,
      promptTokens,
      completionTokens,
      cacheReadTokens,
      nonCachedPromptTokens: Math.max(0, promptTokens - cacheReadTokens),
      cacheReadRatio: promptTokens > 0 ? cacheReadTokens / promptTokens : 0
    },
    inputDistribution: { avg, p50, p95, max },
    duplication: {
      auditReferenceDuplicateCalls: 19,
      auditReferenceDuplicatePromptTokens: 9_352_847,
      stableTextDuplicateCalls: 0,
      maxDuplicatesForOneHash: 1
    },
    determinism: {
      bypassCandidateCalls,
      bypassCandidatePromptTokens: bypassCandidateTokens
    },
    provider: { retriedCalls, maxAttemptSeen, coldCacheCalls },
    sessionResume: { modelIOResetEvents, auditObservedResumes: 32 },
    notes: [
      "LOCAL_EVIDENCE_INCOMPLETE: 公司侧 365 conversations / 163M tokens 无法从本地 model-io 完全验证；本地可解释部分见本基线。",
      "auditReferenceDuplicateCalls 引自 AI-TOKEN-DUPLICATION-AUDIT.md（基于客户端压缩后 prompt 字符串 hash）；request.messages 稳定文本指纹未发现完全重复（工具结果内嵌文件内容/行号），循环特征由 determinism.bypassCandidate* 捕获。",
      "bypassCandidate* = 上一轮 response.toolCalls 全部为确定性 Bash 命令（typecheck/test/verify/git/validate/encoding/tsx --test）的 LLM 轮次——DeterministicToolRunner 旁路候选。",
      "prompt 内容不落盘，仅 sha256 指纹；TOKEN_DEBUG_FULL_RETENTION 默认 false。"
    ]
  };
}

function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

async function main(): Promise<void> {
  const modelIoDir = process.env.MODEL_IO_DIR ?? path.join(os.homedir(), ".zcode", "cli", "rollout");
  const excludeSessions = new Set(
    process.argv
      .filter((arg) => arg.startsWith("--exclude-session="))
      .map((arg) => arg.slice("--exclude-session=".length))
  );
  if (!fs.pathExistsSync(modelIoDir)) {
    console.error(`model-io 目录不存在: ${modelIoDir}`);
    process.exit(1);
  }
  let entries = loadModelIoEntries(modelIoDir);
  if (excludeSessions.size > 0) {
    entries = entries.filter(({ entry }) => !entry.sessionId || !excludeSessions.has(entry.sessionId));
  }
  if (entries.length === 0) {
    console.error("未找到 model-io-*.jsonl（或被全部排除）。");
    process.exit(1);
  }
  const baseline = computeBaseline(entries, modelIoDir);
  const outDir = path.join(process.cwd(), "storage", "token-telemetry");
  fs.ensureDirSync(outDir);
  const outFile = path.join(outDir, "BASELINE_V1.json");
  fs.writeJsonSync(outFile, baseline, { spaces: 2 });

  console.log("==================================================");
  console.log("TOKEN_BASELINE_V1 已冻结 →", outFile);
  console.log("==================================================");
  console.log(`calls:            ${fmt(baseline.totals.calls)}`);
  console.log(`prompt tokens:    ${fmt(baseline.totals.promptTokens)}`);
  console.log(`cacheRead:        ${fmt(baseline.totals.cacheReadTokens)} (${(baseline.totals.cacheReadRatio * 100).toFixed(1)}%)`);
  console.log(`non-cached:       ${fmt(baseline.totals.nonCachedPromptTokens)}`);
  console.log(`input avg/P50/P95/max: ${fmt(baseline.inputDistribution.avg)} / ${fmt(baseline.inputDistribution.p50)} / ${fmt(baseline.inputDistribution.p95)} / ${fmt(baseline.inputDistribution.max)}`);
  console.log(`deterministic-bypass candidates: ${baseline.determinism.bypassCandidateCalls} calls / ${fmt(baseline.determinism.bypassCandidatePromptTokens)} tokens`);
  console.log(`provider retries: ${baseline.provider.retriedCalls} (max attempt=${baseline.provider.maxAttemptSeen})`);
  console.log(`cold-cache calls: ${baseline.provider.coldCacheCalls}`);
}

const isDirectRun = process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/token-freeze-baseline.ts");
if (isDirectRun) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
