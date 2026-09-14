import crypto from "node:crypto";
import path from "node:path";
import fs from "fs-extra";
import type { AIUsage, AIPurpose, LoadedContext } from "./types.js";
import { ExecutionStore } from "../memory/execution-store.js";
import { writeSafeJsonFile } from "./safe-file-writer.js";

interface TrackInput {
  runId?: string;
  stepId?: string;
  modelName: string;
  purpose: AIPurpose;
  prompt?: unknown;
  response?: unknown;
  promptTokens?: number;
  completionTokens?: number;
  latencyMs: number;
  cacheHit?: boolean;
}

interface CacheInput {
  projectId: string;
  platform: string;
  pageSignature?: string;
  semanticTarget?: string;
  actionType?: string;
  domSignature?: string;
  screenshotSignature?: string;
  promptVersion: string;
  modelName: string;
  purpose: AIPurpose;
}

export class AIUsageTracker {
  private readonly executionStore: ExecutionStore;
  private readonly cacheDir: string;

  constructor(private readonly context: LoadedContext) {
    this.executionStore = new ExecutionStore(context);
    this.cacheDir = path.join(context.rootDir, "storage", "ai-cache");
  }

  async track(input: TrackInput): Promise<AIUsage> {
    const promptTokens = input.promptTokens ?? estimateTokens(input.prompt);
    const completionTokens = input.completionTokens ?? estimateTokens(input.response);
    const usage: AIUsage = {
      usage_id: crypto.randomUUID(),
      run_id: input.runId,
      step_id: input.stepId,
      model_name: input.modelName,
      purpose: input.purpose,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
      estimated_cost: estimateCost(input.modelName, promptTokens, completionTokens),
      latency_ms: input.latencyMs,
      cache_hit: Boolean(input.cacheHit),
      created_at: new Date().toISOString()
    };
    await this.executionStore.appendAIUsage(usage);
    return usage;
  }

  cacheKey(input: CacheInput): string {
    return crypto.createHash("sha1").update(JSON.stringify(input)).digest("hex");
  }

  async readCache<T>(key: string): Promise<T | undefined> {
    const filePath = path.join(this.cacheDir, `${key}.json`);
    if (!(await fs.pathExists(filePath))) return undefined;
    const data = (await fs.readJson(filePath)) as { value: T };
    return data.value;
  }

  async writeCache<T>(key: string, value: T): Promise<void> {
    await writeSafeJsonFile(path.join(this.cacheDir, `${key}.json`), { updatedAt: new Date().toISOString(), value });
  }
}

export function estimateTokens(value: unknown): number {
  if (value === undefined || value === null) return 0;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return Math.max(1, Math.ceil(text.length / 4));
}

function estimateCost(modelName: string, promptTokens: number, completionTokens: number): number {
  const name = modelName.toLowerCase();
  if (name.includes("deepseek")) {
    return roundUsd((promptTokens / 1_000_000) * 0.14 + (completionTokens / 1_000_000) * 0.28);
  }
  if (name.includes("gpt-4o") || name.includes("gpt-4.1")) {
    return roundUsd((promptTokens / 1_000_000) * 2.5 + (completionTokens / 1_000_000) * 10);
  }
  if (name.includes("gpt-5")) {
    return roundUsd((promptTokens / 1_000_000) * 1.25 + (completionTokens / 1_000_000) * 10);
  }
  return 0;
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
