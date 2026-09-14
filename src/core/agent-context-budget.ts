/**
 * Development Agent 上下文预算与路由（AI Development Token Efficiency Hardening, items 4/5/16/21）。
 *
 * - DevelopmentContextBudget：普通 LLM call 目标 input <= 200K / warning >= 250K / hard >= 300K；
 *   超过 hard 不继续堆积旧 conversation，执行 CHECKPOINT → HANDOFF → NEW DEVELOPMENT SESSION。
 * - SessionRolloverDecision：input > 300K / message count 超限 / phase 边界 / 长时间 idle + 预测 cache miss 触发。
 * - DevContextRouter：L0（task identity + next action）/ L1（relevant specs + changed files）/ L2（deep docs），
 *   默认 L0 + minimal L1，只有必要时加载 L2。
 *
 * 阈值默认值可配置（DEV_AGENT_INPUT_TARGET / DEV_AGENT_INPUT_WARN / DEV_AGENT_INPUT_HARD /
 * DEV_AGENT_MAX_MESSAGES / DEV_AGENT_IDLE_CACHE_MISS_MS），全部按 token 计。
 */

export const DEV_CONTEXT_DEFAULTS = {
  /** 普通 LLM call 的 input 目标上限。 */
  targetInputTokens: 200_000,
  /** 达到 warning 后应主动开始压缩/准备 checkpoint。 */
  warningInputTokens: 250_000,
  /** 达到 hard 后禁止继续堆旧 conversation，强制 rollover。 */
  hardInputTokens: 300_000,
  /** 单会话消息数上限（超出触发 rollover）。 */
  maxMessages: 500,
  /** 超过该 idle 时长视为预测 cache miss（审计：8.3h 间隙后 cacheRead=0 全价重读 630K）。 */
  idleCacheMissMs: 4 * 60 * 60 * 1000
};

export interface DevContextBudgetConfig {
  targetInputTokens?: number;
  warningInputTokens?: number;
  hardInputTokens?: number;
  maxMessages?: number;
  idleCacheMissMs?: number;
}

export function devContextBudget(env: NodeJS.ProcessEnv = process.env, overrides: DevContextBudgetConfig = {}): typeof DEV_CONTEXT_DEFAULTS {
  const ENV_MAP: Record<keyof DevContextBudgetConfig, string> = {
    targetInputTokens: "DEV_AGENT_INPUT_TARGET",
    warningInputTokens: "DEV_AGENT_INPUT_WARN",
    hardInputTokens: "DEV_AGENT_INPUT_HARD",
    maxMessages: "DEV_AGENT_MAX_MESSAGES",
    idleCacheMissMs: "DEV_AGENT_IDLE_CACHE_MISS_MS"
  };
  const read = (name: keyof DevContextBudgetConfig, fallback: number): number => {
    const raw = overrides[name] ?? env[ENV_MAP[name]];
    const parsed = typeof raw === "number" ? raw : Number.parseInt(String(raw ?? ""), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };
  return {
    targetInputTokens: read("targetInputTokens", DEV_CONTEXT_DEFAULTS.targetInputTokens),
    warningInputTokens: read("warningInputTokens", DEV_CONTEXT_DEFAULTS.warningInputTokens),
    hardInputTokens: read("hardInputTokens", DEV_CONTEXT_DEFAULTS.hardInputTokens),
    maxMessages: read("maxMessages", DEV_CONTEXT_DEFAULTS.maxMessages),
    idleCacheMissMs: read("idleCacheMissMs", DEV_CONTEXT_DEFAULTS.idleCacheMissMs)
  };
}

export type ContextLevel = "ok" | "warning" | "hard";
export type ContextAction = "continue" | "prepare_checkpoint" | "force_rollover";

export interface BudgetDecision {
  level: ContextLevel;
  action: ContextAction;
  inputTokens: number;
  targetInputTokens: number;
  hardInputTokens: number;
}

/** item 5：单次 LLM call 的 context budget 判定。 */
export function decideContextBudget(inputTokens: number, budget: typeof DEV_CONTEXT_DEFAULTS = devContextBudget()): BudgetDecision {
  if (inputTokens >= budget.hardInputTokens) {
    return { level: "hard", action: "force_rollover", inputTokens, targetInputTokens: budget.targetInputTokens, hardInputTokens: budget.hardInputTokens };
  }
  if (inputTokens >= budget.warningInputTokens) {
    return { level: "warning", action: "prepare_checkpoint", inputTokens, targetInputTokens: budget.targetInputTokens, hardInputTokens: budget.hardInputTokens };
  }
  return { level: "ok", action: "continue", inputTokens, targetInputTokens: budget.targetInputTokens, hardInputTokens: budget.hardInputTokens };
}

export interface RolloverSignal {
  rollover: boolean;
  reasons: string[];
}

/** item 6/16：会话 rollover 触发判定。触发条件至少满足其一即 rollover。 */
export function decideSessionRollover(input: {
  inputTokens: number;
  messageCount: number;
  phaseBoundary: boolean;
  idleMs: number;
}, budget: typeof DEV_CONTEXT_DEFAULTS = devContextBudget()): RolloverSignal {
  const reasons: string[] = [];
  if (input.inputTokens >= budget.hardInputTokens) reasons.push(`input ${input.inputTokens} >= hard ${budget.hardInputTokens}`);
  if (input.messageCount > budget.maxMessages) reasons.push(`messageCount ${input.messageCount} > max ${budget.maxMessages}`);
  if (input.phaseBoundary) reasons.push("phase boundary");
  if (input.idleMs >= budget.idleCacheMissMs) reasons.push(`idle ${Math.round(input.idleMs / 3600_000)}h >= ${Math.round(budget.idleCacheMissMs / 3600_000)}h (predicted cache miss)`);
  return { rollover: reasons.length > 0, reasons };
}

/** item 16：是否预测 cache miss（长时间 idle 后恢复，前缀缓存大概率失效）。 */
export function predictsCacheMiss(idleMs: number, budget: typeof DEV_CONTEXT_DEFAULTS = devContextBudget()): boolean {
  return idleMs >= budget.idleCacheMissMs;
}

/**
 * item 4/21：Development Context Router。
 * 大型 Phase Spec 只在任务开始时解析一次生成 PhaseExecutionPlan；
 * 后续 LLM request 默认不得重新加载完整 Phase Spec。
 */
export interface RouterInput {
  taskIdentity: string;
  nextAction: string;
  stepSpecification?: string;
  relevantErrors?: string[];
  changedFiles?: string[];
  criticalInvariants?: string[];
  deepDocs?: string[];
}

export interface RoutedContext {
  /** 默认装配：L0 + minimal L1。 */
  content: string;
  loadedLayers: Array<"L0" | "L1" | "L2">;
  estimatedInputTokens: number;
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 3.5));
}

export function buildL0(taskIdentity: string, nextAction: string): string {
  return `## L0 — Task Identity & Next Action\n\n${taskIdentity}\n\nNext Action: ${nextAction}`;
}

export function buildL1(input: Pick<RouterInput, "stepSpecification" | "relevantErrors" | "changedFiles" | "criticalInvariants">): string {
  const sections: string[] = ["## L1 — Current Step Context"];
  if (input.stepSpecification) sections.push(`\n### Step Specification\n\n${input.stepSpecification}`);
  if (input.changedFiles && input.changedFiles.length > 0) sections.push(`\n### Changed Files\n\n${input.changedFiles.join("\n")}`);
  if (input.relevantErrors && input.relevantErrors.length > 0) sections.push(`\n### Relevant Errors\n\n${input.relevantErrors.join("\n")}`);
  if (input.criticalInvariants && input.criticalInvariants.length > 0) sections.push(`\n### Critical Invariants\n\n${input.criticalInvariants.map((item) => `- ${item}`).join("\n")}`);
  return sections.join("\n");
}

export function buildL2(deepDocs: string[]): string {
  return `## L2 — Deep Documents (paths only, opened on demand)\n\n${deepDocs.join("\n")}`;
}

/** 默认加载 L0 + minimal L1；deepDocs 仅在显式需要时附加（loadL2=true）。 */
export function routeDevContext(input: RouterInput, options: { loadL2?: boolean } = {}): RoutedContext {
  const loadedLayers: Array<"L0" | "L1" | "L2"> = ["L0"];
  const parts = [buildL0(input.taskIdentity, input.nextAction)];
  if (input.stepSpecification || input.changedFiles?.length || input.relevantErrors?.length || input.criticalInvariants?.length) {
    parts.push(buildL1(input));
    loadedLayers.push("L1");
  }
  if (options.loadL2 && input.deepDocs && input.deepDocs.length > 0) {
    parts.push(buildL2(input.deepDocs));
    loadedLayers.push("L2");
  }
  const content = parts.join("\n\n");
  return { content, loadedLayers, estimatedInputTokens: estimateTokens(content) };
}
