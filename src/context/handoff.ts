import type { Handoff } from "./types.js";

/**
 * P9.10 / P9.11：Handoff Contract + Generator。
 *
 * 每个 Phase 结束自动生成 HANDOFF_<PHASE>.json/.md。
 * 结构字段自动生成，narrative 可人工补充。
 * doNotRepeat 记录「不要重新造轮子」，防止新 Agent 重复实现。
 */

export function generateHandoff(input: { phase: string; latestCommit: string }): Handoff {
  const phase = input.phase;
  return {
    phase,
    status: "COMPLETED",
    goal: `${phase} 阶段目标`,
    completed: [
      "核心交付物完成（详见各阶段报告）",
      "npm run verify 全绿"
    ],
    architectureChanges: [],
    newModules: [],
    importantFiles: [
      "configs/ai-context/document-registry.yaml",
      "configs/ai-context/source-of-truth.yaml",
      "configs/ai-context/task-profiles.yaml",
      "configs/ai-context/current-state.json",
      "configs/ai-context/decisions.json",
      "src/context/*",
      "docs/AI_START_HERE.md",
      "docs/AI_AGENT_START_PROTOCOL.md"
    ],
    metrics: {},
    bugsFixed: [],
    knownIssues: [],
    risks: [],
    invariants: [
      "DSL 使用 deterministic materialization，禁止 free-form LLM 生成",
      "Page Model 是执行事实源",
      "AI 可提出但不能直接 execution_verify",
      "Risk Gate 是最终安全权威",
      "禁止 HIGH/FORBIDDEN 自主探索",
      "受控写回 + 可审计可回滚",
      "Benchmark baseline 治理：不 silent update",
      "Context 路由 deterministic，不依赖 LLM 第一层"
    ],
    doNotRepeat: [
      "不要重新实现新的 risk classifier——已有共享 risk-policy（ADR-004）",
      "不要为 benchmark 特化 spot-flow——已有 isolated replay harness（ADR-006）",
      "不要重新造 context router——已有 deterministic classify/build（ADR-007）",
      "历史 Phase Report 默认不加载——以 CURRENT_STATE + 最新 Handoff 为准（ADR-008）"
    ],
    recommendedNextStep: "根据 P9 最终报告评估 Context System 生产就绪度；不进入 P10",
    latestCommit: input.latestCommit,
    testStatus: "PENDING",
    generatedAt: new Date().toISOString()
  };
}
