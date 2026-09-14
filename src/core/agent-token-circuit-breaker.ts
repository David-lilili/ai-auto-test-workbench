/**
 * Token / Tool-Loop 熔断器（AI Development Token Efficiency Hardening, items 19/20）。
 *
 * item 19：Task Token Budget —— warning 20M raw prompt / critical 35M raw prompt（可配置）；
 *   singleCall input > 300K → context rollover 信号；high-similarity 连续 >= 3 → investigate/short circuit。
 * item 20：Tool Loop Circuit Breaker —— 同一 command + 同一 errorSignature 重复 >= 2 次
 *   必须 STOP LOOP → reasoning once，不能每次 run 都调用 LLM（与 agent-dedup-guard 配合）。
 */

export const TOKEN_CIRCUIT_DEFAULTS = {
  /** 任务累计 raw prompt warning 阈值。 */
  warningRawPrompt: 20_000_000,
  /** 任务累计 raw prompt critical 阈值。 */
  criticalRawPrompt: 35_000_000,
  /** 单次调用 input hard 上限（触发 rollover）。 */
  singleCallHardInput: 300_000,
  /** 连续 high-similarity 调用次数达到该值 → short circuit。 */
  consecutiveSimilarLimit: 3
};

export interface TokenCircuitConfig {
  warningRawPrompt?: number;
  criticalRawPrompt?: number;
  singleCallHardInput?: number;
  consecutiveSimilarLimit?: number;
}

export function tokenCircuitConfig(env: NodeJS.ProcessEnv = process.env, overrides: TokenCircuitConfig = {}): typeof TOKEN_CIRCUIT_DEFAULTS {
  const read = (envName: string, fallback: number, override?: number): number => {
    const raw = override ?? env[envName];
    const parsed = typeof raw === "number" ? raw : Number.parseInt(String(raw ?? ""), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };
  return {
    warningRawPrompt: read("DEV_AGENT_TASK_BUDGET_WARN", TOKEN_CIRCUIT_DEFAULTS.warningRawPrompt, overrides.warningRawPrompt),
    criticalRawPrompt: read("DEV_AGENT_TASK_BUDGET_CRITICAL", TOKEN_CIRCUIT_DEFAULTS.criticalRawPrompt, overrides.criticalRawPrompt),
    singleCallHardInput: read("DEV_AGENT_SINGLE_CALL_HARD", TOKEN_CIRCUIT_DEFAULTS.singleCallHardInput, overrides.singleCallHardInput),
    consecutiveSimilarLimit: read("DEV_AGENT_SIMILAR_LIMIT", TOKEN_CIRCUIT_DEFAULTS.consecutiveSimilarLimit, overrides.consecutiveSimilarLimit)
  };
}

export type CircuitLevel = "ok" | "warning" | "critical";

export interface CircuitStatus {
  level: CircuitLevel;
  action: "continue" | "investigate" | "short_circuit" | "rollover";
  signals: string[];
}

export interface CallSnapshot {
  taskId: string;
  inputTokens: number;
  cacheReadTokens: number;
  /** 该调用是否与上一调用高相似（同一工具结果重放）。 */
  highSimilar: boolean;
}

/** item 19：Task Token Budget 熔断。 */
export class TokenCircuitBreaker {
  private readonly totals = new Map<string, { rawPrompt: number; calls: number }>();

  constructor(private readonly config: typeof TOKEN_CIRCUIT_DEFAULTS = tokenCircuitConfig()) {}

  addCall(snapshot: CallSnapshot): CircuitStatus {
    const total = this.totals.get(snapshot.taskId) ?? { rawPrompt: 0, calls: 0 };
    total.rawPrompt += snapshot.inputTokens;
    total.calls += 1;
    this.totals.set(snapshot.taskId, total);
    return this.status(snapshot.taskId);
  }

  status(taskId: string): CircuitStatus {
    const total = this.totals.get(taskId) ?? { rawPrompt: 0, calls: 0 };
    const signals: string[] = [];
    if (total.rawPrompt >= this.config.criticalRawPrompt) signals.push(`task ${taskId} raw prompt ${total.rawPrompt} >= critical ${this.config.criticalRawPrompt}`);
    else if (total.rawPrompt >= this.config.warningRawPrompt) signals.push(`task ${taskId} raw prompt ${total.rawPrompt} >= warning ${this.config.warningRawPrompt}`);
    if (signals.length === 0) return { level: "ok", action: "continue", signals };
    const critical = signals.some((signal) => signal.includes("critical"));
    return { level: critical ? "critical" : "warning", action: critical ? "short_circuit" : "investigate", signals };
  }

  /** item 19 续：单次调用 input 超限 → 强制 rollover 信号（不静默继续）。 */
  evaluateSingleCall(inputTokens: number): CircuitStatus {
    if (inputTokens >= this.config.singleCallHardInput) {
      return { level: "critical", action: "rollover", signals: [`single call input ${inputTokens} >= hard ${this.config.singleCallHardInput}`] };
    }
    return { level: "ok", action: "continue", signals: [] };
  }

  reset(taskId: string): void {
    this.totals.delete(taskId);
  }
}

/** item 19 续 / item 20：连续 high-similarity 检测（>= limit → short circuit，先 investigate）。 */
export class SimilarityCircuitBreaker {
  private consecutive = 0;

  constructor(private readonly limit: number = TOKEN_CIRCUIT_DEFAULTS.consecutiveSimilarLimit) {}

  add(highSimilar: boolean): { consecutiveSimilar: number; action: "continue" | "investigate" | "short_circuit" } {
    if (highSimilar) {
      this.consecutive += 1;
    } else {
      this.consecutive = 0;
    }
    if (this.consecutive >= this.limit) {
      return { consecutiveSimilar: this.consecutive, action: "short_circuit" };
    }
    if (this.consecutive >= this.limit - 1) {
      return { consecutiveSimilar: this.consecutive, action: "investigate" };
    }
    return { consecutiveSimilar: this.consecutive, action: "continue" };
  }

  reset(): void {
    this.consecutive = 0;
  }
}

/**
 * item 20：Tool Loop Circuit Breaker —— 同一 command + 同一 errorSignature 的执行计数。
 * 与 agent-dedup-guard 语义一致（MAX_EXECUTIONS_PER_COMMAND_STATE = 2）：
 * 同命令 + 同签名最多执行 2 次，第 3 次起 STOP LOOP（reasoning once，由
 * ReasoningDedupGuard / InvocationLedger 决定是否真的调用模型）。
 */
export class ToolLoopBreaker {
  private readonly state = new Map<string, { signature: string; repeats: number }>();

  /** @returns allowLoop=false 表示同命令+同签名已执行 >= 2 次，必须 STOP LOOP。 */
  tryRun(command: string, errorSignature: string): { allowLoop: boolean; repeats: number } {
    const key = command;
    const current = this.state.get(key);
    if (!current || current.signature !== errorSignature) {
      this.state.set(key, { signature: errorSignature, repeats: 1 });
      return { allowLoop: true, repeats: 1 };
    }
    current.repeats += 1;
    return { allowLoop: current.repeats <= 2, repeats: current.repeats };
  }
}
