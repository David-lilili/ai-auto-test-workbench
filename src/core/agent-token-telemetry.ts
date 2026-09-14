/**
 * Development Agent 每次 LLM 调用的 token telemetry（AI Development Token Efficiency Hardening, items 17/18）。
 *
 * item 17：每个 LLM call 保存 callId / timestamp / taskId / phase / sessionId / repoHead / stepId /
 *   promptHash / inputTokens / cacheReadTokens / nonCachedTokens / completionTokens / attempt / reason /
 *   toolBefore / toolAfter / errorSignature —— 但默认不保存 full prompt content。
 * item 18：modelIoFullRetentionEnabled 不得默认长期开启；TOKEN_DEBUG_FULL_RETENTION 默认 false，
 *   只有显式 Debug 且符合公司 policy 才开启。
 *
 * 落盘：.runtime/agent-state/telemetry/calls.jsonl（逐条 append，不入 git）。
 */

import fs from "fs-extra";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { AGENT_STATE_DIR } from "./agent-task-checkpoint.js";

export const FULL_RETENTION_ENV = "TOKEN_DEBUG_FULL_RETENTION";

/** 默认关闭 full retention；仅当 env 显式为 "true"/"1" 且 debug 模式开启时允许记录 prompt 内容。 */
export function fullRetentionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = String(env[FULL_RETENTION_ENV] ?? "").toLowerCase();
  return value === "true" || value === "1";
}

export interface DevAgentCallRecord {
  callId: string;
  timestamp: string;
  taskId: string;
  phase: string;
  sessionId: string;
  repoHead: string;
  stepId: string;
  promptHash: string;
  inputTokens: number;
  cacheReadTokens: number;
  nonCachedTokens: number;
  completionTokens: number;
  attempt: number;
  reason: string;
  toolBefore: string[];
  toolAfter: string[];
  errorSignature: string | null;
  /** 仅 TOKEN_DEBUG_FULL_RETENTION=true 时写入。 */
  promptContent?: string;
}

export function promptHashFor(promptText: string): string {
  return createHash("sha256").update(promptText).digest("hex");
}

export class DevAgentTelemetry {
  private readonly file: string;

  constructor(rootDir: string) {
    this.file = path.join(rootDir, AGENT_STATE_DIR, "telemetry", "calls.jsonl");
  }

  /** 追加一条调用记录；promptContent 只在 full retention 开启时保存。 */
  async record(input: Omit<DevAgentCallRecord, "callId" | "timestamp" | "promptHash" | "promptContent"> & { promptText?: string }): Promise<DevAgentCallRecord> {
    const retention = fullRetentionEnabled();
    const record: DevAgentCallRecord = {
      callId: randomUUID(),
      timestamp: new Date().toISOString(),
      taskId: input.taskId,
      phase: input.phase,
      sessionId: input.sessionId,
      repoHead: input.repoHead,
      stepId: input.stepId,
      promptHash: input.promptText ? promptHashFor(input.promptText) : "",
      inputTokens: input.inputTokens,
      cacheReadTokens: input.cacheReadTokens,
      nonCachedTokens: input.nonCachedTokens,
      completionTokens: input.completionTokens,
      attempt: input.attempt,
      reason: input.reason,
      toolBefore: input.toolBefore,
      toolAfter: input.toolAfter,
      errorSignature: input.errorSignature
    };
    if (retention && input.promptText) record.promptContent = input.promptText;
    fs.ensureDirSync(path.dirname(this.file));
    await fs.appendFile(this.file, `${JSON.stringify(record)}\n`, "utf8");
    return record;
  }

  async readAll(): Promise<DevAgentCallRecord[]> {
    if (!(await fs.pathExists(this.file))) return [];
    const text = await fs.readFile(this.file, "utf8");
    const records: DevAgentCallRecord[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line) as DevAgentCallRecord);
      } catch {
        // 跳过损坏行。
      }
    }
    return records;
  }

  async summarize(): Promise<{
    calls: number;
    totalPromptTokens: number;
    totalCacheReadTokens: number;
    totalNonCachedTokens: number;
    avgInput: number;
    p95Input: number;
    retentionEnabled: boolean;
  }> {
    const records = await this.readAll();
    if (records.length === 0) {
      return { calls: 0, totalPromptTokens: 0, totalCacheReadTokens: 0, totalNonCachedTokens: 0, avgInput: 0, p95Input: 0, retentionEnabled: fullRetentionEnabled() };
    }
    const inputs = records.map((record) => record.inputTokens).sort((a, b) => a - b);
    const totalPrompt = records.reduce((sum, record) => sum + record.inputTokens, 0);
    const totalCache = records.reduce((sum, record) => sum + record.cacheReadTokens, 0);
    return {
      calls: records.length,
      totalPromptTokens: totalPrompt,
      totalCacheReadTokens: totalCache,
      totalNonCachedTokens: Math.max(0, totalPrompt - totalCache),
      avgInput: Math.round(totalPrompt / records.length),
      p95Input: inputs[Math.min(inputs.length - 1, Math.floor(inputs.length * 0.95))],
      retentionEnabled: fullRetentionEnabled()
    };
  }
}
