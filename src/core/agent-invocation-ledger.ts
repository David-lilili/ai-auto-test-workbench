/**
 * LLM 调用幂等账本（AI Development Token Efficiency Hardening, item 11）。
 *
 * LLMInvocationKey = taskId + stepId + repoHead + fileDiffHash + errorSignature + contextPurpose。
 * 若完全相同：返回已有 reasoning/result reference，不调用模型（输出已记录引用）。
 *
 * 账本持久化在 .runtime/agent-state/ledger/<taskId>.json，只保存 result reference
 * （artifact 路径 / 摘要），禁止保存 full prompt。
 */

import fs from "fs-extra";
import path from "node:path";
import { createHash } from "node:crypto";
import { AGENT_STATE_DIR } from "./agent-task-checkpoint.js";

export interface LlmInvocationKey {
  taskId: string;
  stepId: string;
  repoHead: string;
  fileDiffHash: string;
  errorSignature: string | null;
  contextPurpose: string;
}

export function llmInvocationKeyString(key: LlmInvocationKey): string {
  return createHash("sha256")
    .update(
      [
        key.taskId,
        key.stepId,
        key.repoHead,
        key.fileDiffHash,
        key.errorSignature ?? "no-error-signature",
        key.contextPurpose
      ].join("\n")
    )
    .digest("hex");
}

export interface LedgerEntry {
  keyHash: string;
  resultReference: string;
  recordedAt: string;
  inputTokensSaved: number;
}

const MAX_ENTRIES_PER_TASK = 500;

export class InvocationLedger {
  private readonly dir: string;

  constructor(rootDir: string) {
    this.dir = path.join(rootDir, AGENT_STATE_DIR, "ledger");
  }

  private fileFor(taskId: string): string {
    const safe = taskId.replace(/[^A-Za-z0-9._-]/g, "_");
    return path.join(this.dir, `${safe}.json`);
  }

  private async readEntries(taskId: string): Promise<LedgerEntry[]> {
    const file = this.fileFor(taskId);
    if (!(await fs.pathExists(file))) return [];
    try {
      const data = (await fs.readJson(file)) as { entries?: LedgerEntry[] };
      return Array.isArray(data.entries) ? data.entries : [];
    } catch {
      return [];
    }
  }

  /** 命中返回已记录的 result reference；未命中返回 null（调用方继续调用模型）。 */
  async lookup(key: LlmInvocationKey): Promise<LedgerEntry | null> {
    const keyHash = llmInvocationKeyString(key);
    const entries = await this.readEntries(key.taskId);
    return entries.find((entry) => entry.keyHash === keyHash) ?? null;
  }

  /** 记录一次调用的 result reference（不存 prompt 内容）。 */
  async record(key: LlmInvocationKey, resultReference: string, inputTokensSaved = 0): Promise<void> {
    const entries = await this.readEntries(key.taskId);
    const entry: LedgerEntry = {
      keyHash: llmInvocationKeyString(key),
      resultReference,
      recordedAt: new Date().toISOString(),
      inputTokensSaved
    };
    const next = [...entries.filter((existing) => existing.keyHash !== entry.keyHash), entry];
    // 容量上限：超出时丢弃最旧条目。
    const trimmed = next.length > MAX_ENTRIES_PER_TASK ? next.slice(next.length - MAX_ENTRIES_PER_TASK) : next;
    fs.ensureDirSync(this.dir);
    await fs.writeJson(this.fileFor(key.taskId), { entries: trimmed }, { spaces: 2 });
  }

  async size(taskId: string): Promise<number> {
    return (await this.readEntries(taskId)).length;
  }
}
