/**
 * Development Agent 去重守卫（P16 审计收敛项）。
 *
 * - ReasoningDedupGuard：相同 errorSignature 最多允许 2 次 LLM reasoning，
 *   第 3 次起禁止调用模型，输出 DUPLICATE_REASONING_BLOCKED。
 * - DeterministicCommandGuard：同一 deterministic command 在无状态变化
 *   （repoHead + diffHash 指纹不变）时最多执行 2 次，禁止 run -> run -> run 循环。
 */

export const MAX_REASONING_PER_SIGNATURE = 2;
export const MAX_EXECUTIONS_PER_COMMAND_STATE = 2;
export const DUPLICATE_REASONING_BLOCKED = "DUPLICATE_REASONING_BLOCKED";

/** 相同 errorSignature 的 reasoning 计数守卫。 */
export class ReasoningDedupGuard {
  private readonly counts = new Map<string, number>();

  /**
   * @returns allowed=true 时允许本轮 LLM reasoning（1st/2nd）；
   *          allowed=false 表示已是第 3 次相同签名，blockedOutput = DUPLICATE_REASONING_BLOCKED。
   */
  tryReason(errorSignature: string): { allowed: boolean; reasoningCount: number; blockedOutput: string | null } {
    const reasoningCount = (this.counts.get(errorSignature) ?? 0) + 1;
    this.counts.set(errorSignature, reasoningCount);
    if (reasoningCount > MAX_REASONING_PER_SIGNATURE) {
      return { allowed: false, reasoningCount, blockedOutput: DUPLICATE_REASONING_BLOCKED };
    }
    return { allowed: true, reasoningCount, blockedOutput: null };
  }

  reset(errorSignature: string): void {
    this.counts.delete(errorSignature);
  }
}

/**
 * 同一 deterministic command 的执行计数守卫。
 * 状态指纹变化（repoHead/diffHash 变化）视为新情形，计数重置。
 */
export class DeterministicCommandGuard {
  private readonly state = new Map<string, { fingerprint: string; executions: number }>();

  /**
   * @param stateFingerprint 命令执行时的仓库状态指纹（repoHead + diffHash）。
   * @returns allowed=true 表示允许执行（1st/2nd）；false 表示无状态变化下已执行 2 次，需先改变状态。
   */
  tryExecute(command: string, stateFingerprint: string): { allowed: boolean; executions: number } {
    const current = this.state.get(command);
    if (!current || current.fingerprint !== stateFingerprint) {
      this.state.set(command, { fingerprint: stateFingerprint, executions: 1 });
      return { allowed: true, executions: 1 };
    }
    if (current.executions >= MAX_EXECUTIONS_PER_COMMAND_STATE) {
      return { allowed: false, executions: current.executions };
    }
    current.executions += 1;
    return { allowed: true, executions: current.executions };
  }
}
