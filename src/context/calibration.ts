import type { ContextDocument, ContextPack, ContextTaskType, DocumentRegistryFile, TaskProfileFile } from "./types.js";
import { classifyContextTask, resolveContextRequirements } from "./task-context.js";
import { contextRecall, contextPrecision, missingContextSeverities, type GoldTaskContext } from "./quality.js";
import { buildContextPack } from "./pack.js";

/**
 * P9.5-2 / P9.5-3：Expanded Gold Dataset（30+ 真实历史任务）+ Calibration/Holdout Split。
 *
 * - 30+ 任务必须来自真实项目历史，覆盖 19 个 task 域；
 * - 至少 5 跨领域、5 模糊、5 changed-file/error-only、5 历史真实 bug；
 * - 固定拆 70/30（calibration / holdout），holdout 不可用于调参。
 */

/** P9.5-2：Expanded Gold Dataset（36 个真实历史任务）。 */
export const GOLD_TASKS_V2: Array<GoldTaskContext & { split: "calibration" | "holdout"; notes?: string[] }> = [
  // ===== PAGE MODELING =====
  { taskId: "g_01", taskType: "PAGE_MODELING", split: "calibration", description: "对资金中心现货流水页建立 Page Model", mustKnow: ["PAGE_MODEL_SCHEMA", "PAGE_MODEL_MODELING_PLAYBOOK", "CURRENT_PROJECT_STATE", "KNOWLEDGE_PROMOTION_POLICY"], useful: ["OPERATION_MANUAL", "RISK_POLICY"], irrelevant: ["P3_PHASE_REPORT", "P5_PHASE_REPORT"], dangerousToMiss: ["CURRENT_PROJECT_STATE"] },
  { taskId: "g_02", taskType: "PAGE_MODELING", split: "calibration", description: "建 withdraw 提现表单页模型（含链选择器）", mustKnow: ["PAGE_MODEL_SCHEMA", "PAGE_MODEL_MODELING_PLAYBOOK", "OPERATION_MANUAL", "CURRENT_PROJECT_STATE"], useful: ["KNOWLEDGE_PROMOTION_POLICY", "RISK_POLICY"], irrelevant: ["P8_PHASE_REPORT"], dangerousToMiss: ["OPERATION_MANUAL"] },
  { taskId: "g_03", taskType: "PAGE_MODELING", split: "calibration", description: "为理财 earn 页面 bootstrap 建模并物化", mustKnow: ["PAGE_MODEL_SCHEMA", "PAGE_MODEL_MODELING_PLAYBOOK", "CURRENT_PROJECT_STATE", "KNOWLEDGE_PROMOTION_POLICY"], useful: ["MODELING_BENCHMARK_LATEST"], irrelevant: ["P4_PHASE_REPORT"], dangerousToMiss: ["KNOWLEDGE_PROMOTION_POLICY"] },
  { taskId: "g_04", taskType: "PAGE_MODELING", split: "holdout", description: "创建 red_packet 弹窗页模型（modal 交互）", mustKnow: ["PAGE_MODEL_SCHEMA", "PAGE_MODEL_MODELING_PLAYBOOK", "CURRENT_PROJECT_STATE"], useful: ["RISK_POLICY"], irrelevant: ["P1_PHASE_REPORT"], dangerousToMiss: ["RISK_POLICY"] },
  { taskId: "g_05", taskType: "PAGE_MODELING", split: "holdout", description: "为个人中心 API 管理页建模（含安全操作按钮）", mustKnow: ["PAGE_MODEL_SCHEMA", "PAGE_MODEL_MODELING_PLAYBOOK", "CURRENT_PROJECT_STATE", "RISK_POLICY"], useful: ["KNOWLEDGE_PROMOTION_POLICY"], irrelevant: ["P2_PHASE_REPORT"], dangerousToMiss: ["RISK_POLICY"] },
  { taskId: "g_06", taskType: "PAGE_MODELING", split: "calibration", description: "建立 result region 正式写回（table/list/columns）", mustKnow: ["PAGE_MODEL_SCHEMA", "PAGE_MODEL_MODELING_PLAYBOOK", "KNOWLEDGE_PROMOTION_POLICY", "CURRENT_PROJECT_STATE"], useful: ["OPERATION_MANUAL"], irrelevant: ["P5_PHASE_REPORT"], dangerousToMiss: ["KNOWLEDGE_PROMOTION_POLICY"] },

  // ===== PAGE MODEL DEBUG =====
  { taskId: "g_07", taskType: "PAGE_MODEL_DEBUG", split: "calibration", description: "修复 page identity duplicate bug（同一 URL 重复建模）", mustKnow: ["PAGE_MODEL_SCHEMA", "PAGE_MODEL_MODELING_PLAYBOOK", "CURRENT_PROJECT_STATE", "RISK_POLICY"], useful: ["KNOWLEDGE_PROMOTION_POLICY"], irrelevant: ["P3_PHASE_REPORT", "P6_BENCHMARK_HISTORICAL"], dangerousToMiss: ["RISK_POLICY", "CURRENT_PROJECT_STATE"] },
  { taskId: "g_08", taskType: "PAGE_MODEL_DEBUG", split: "calibration", description: "修复 dropdown option 语义污染（父 accessible name 拼接）", mustKnow: ["PAGE_MODEL_SCHEMA", "PAGE_MODEL_MODELING_PLAYBOOK", "KNOWLEDGE_PROMOTION_POLICY", "RISK_POLICY", "CURRENT_PROJECT_STATE"], useful: ["MODELING_BENCHMARK_LATEST"], irrelevant: ["P2_PHASE_REPORT", "P4_PHASE_REPORT"], dangerousToMiss: ["KNOWLEDGE_PROMOTION_POLICY", "RISK_POLICY"] },
  { taskId: "g_09", taskType: "PAGE_MODEL_DEBUG", split: "calibration", description: "修复 assertion 候选被 site nav 噪音污染", mustKnow: ["PAGE_MODEL_SCHEMA", "PAGE_MODEL_MODELING_PLAYBOOK", "KNOWLEDGE_PROMOTION_POLICY"], useful: ["OPERATION_MANUAL", "RISK_POLICY"], irrelevant: ["P5_PHASE_REPORT", "P1_PHASE_REPORT"], dangerousToMiss: ["KNOWLEDGE_PROMOTION_POLICY"] },
  { taskId: "g_10", taskType: "PAGE_MODEL_DEBUG", split: "calibration", description: "现货流水模型里 type_filter 列不匹配问题", mustKnow: ["PAGE_MODEL_SCHEMA", "PAGE_MODEL_MODELING_PLAYBOOK", "CURRENT_PROJECT_STATE", "KNOWLEDGE_PROMOTION_POLICY"], useful: ["OPERATION_MANUAL"], irrelevant: ["P4_PHASE_REPORT"], dangerousToMiss: ["CURRENT_PROJECT_STATE"] },
  { taskId: "g_11", taskType: "PAGE_MODEL_DEBUG", split: "calibration", description: "combobox 被错误映射成 input 导致选项无法探索", mustKnow: ["PAGE_MODEL_SCHEMA", "PAGE_MODEL_MODELING_PLAYBOOK", "CURRENT_PROJECT_STATE", "RISK_POLICY"], useful: ["KNOWLEDGE_PROMOTION_POLICY"], irrelevant: ["P2_PHASE_REPORT"], dangerousToMiss: ["RISK_POLICY"] },

  // ===== EXPLORATION / HEURISTIC =====
  { taskId: "g_12", taskType: "EXPLORATION", split: "calibration", description: "现货流水页探索时 restore 失败（dropdown 无法关闭）", mustKnow: ["PAGE_MODEL_MODELING_PLAYBOOK", "CURRENT_PROJECT_STATE", "RISK_POLICY"], useful: ["PAGE_MODEL_SCHEMA"], irrelevant: ["P1_PHASE_REPORT"], dangerousToMiss: ["RISK_POLICY"] },
  { taskId: "g_13", taskType: "HEURISTIC_CHANGE", split: "calibration", description: "新增 select.option_discovery heuristic 版本", mustKnow: ["PAGE_MODEL_MODELING_PLAYBOOK", "CURRENT_PROJECT_STATE", "RISK_POLICY"], useful: ["MODELING_BENCHMARK_LATEST"], irrelevant: ["P3_PHASE_REPORT"], dangerousToMiss: ["RISK_POLICY"] },
  { taskId: "g_14", taskType: "EXPLORATION", split: "holdout", description: "candidate_stale 触发源扩展（增加 visibility_change 监听）", mustKnow: ["PAGE_MODEL_MODELING_PLAYBOOK", "CURRENT_PROJECT_STATE", "RISK_POLICY"], useful: ["MODELING_BENCHMARK_LATEST"], irrelevant: ["P4_PHASE_REPORT"], dangerousToMiss: ["RISK_POLICY"] },

  // ===== DSL =====
  { taskId: "g_15", taskType: "DSL_DEBUG", split: "calibration", description: "DSL PARTIAL 排查（筛选后断言缺失）", mustKnow: ["DSL_ARCHITECTURE", "PAGE_MODEL_SCHEMA", "CURRENT_PROJECT_STATE", "OPERATION_MANUAL"], useful: ["MODELING_BENCHMARK_LATEST"], irrelevant: ["P7_PHASE_REPORT", "P8_PHASE_REPORT"], dangerousToMiss: ["CURRENT_PROJECT_STATE"] },
  { taskId: "g_16", taskType: "DSL_DEBUG", split: "calibration", description: "修复 DSL semantic completeness（READY 不等于完整）", mustKnow: ["DSL_ARCHITECTURE", "PAGE_MODEL_SCHEMA", "CURRENT_PROJECT_STATE", "OPERATION_MANUAL"], useful: ["MODELING_BENCHMARK_LATEST"], irrelevant: ["P3_PHASE_REPORT"], dangerousToMiss: ["OPERATION_MANUAL"] },
  { taskId: "g_17", taskType: "DSL_GENERATION", split: "calibration", description: "为现货流水筛选意图生成 DSL（含查询按钮点击）", mustKnow: ["DSL_ARCHITECTURE", "PAGE_MODEL_SCHEMA", "CURRENT_PROJECT_STATE", "OPERATION_MANUAL"], useful: ["PAGE_MODEL_MODELING_PLAYBOOK"], irrelevant: ["P2_PHASE_REPORT"], dangerousToMiss: ["PAGE_MODEL_SCHEMA"] },
  { taskId: "g_18", taskType: "DSL_DEBUG", split: "holdout", description: "intent_contract_page_missing 错误：页面缺建模导致 DSL 无法物化", mustKnow: ["DSL_ARCHITECTURE", "PAGE_MODEL_SCHEMA", "CURRENT_PROJECT_STATE", "OPERATION_MANUAL"], useful: ["PAGE_MODEL_MODELING_PLAYBOOK"], irrelevant: ["P5_PHASE_REPORT"], dangerousToMiss: ["PAGE_MODEL_SCHEMA"] },
  { taskId: "g_19", taskType: "DSL_DEBUG", split: "calibration", description: "筛选后 DSL 少了 APPLY_FILTER 步骤", mustKnow: ["DSL_ARCHITECTURE", "PAGE_MODEL_SCHEMA", "CURRENT_PROJECT_STATE", "OPERATION_MANUAL"], useful: ["MODELING_BENCHMARK_LATEST"], irrelevant: ["P4_PHASE_REPORT"], dangerousToMiss: ["OPERATION_MANUAL"] },

  // ===== EXECUTION / RISK =====
  { taskId: "g_20", taskType: "EXECUTION_DEBUG", split: "calibration", description: "修复 risk gate 词边界误判（enabled 被当 enable）", mustKnow: ["RISK_POLICY", "CURRENT_PROJECT_STATE", "DSL_ARCHITECTURE"], useful: ["ARCHITECTURE_DECISIONS"], irrelevant: ["P1_PHASE_REPORT", "P2_PHASE_REPORT"], dangerousToMiss: ["RISK_POLICY"] },
  { taskId: "g_21", taskType: "EXECUTION_DEBUG", split: "calibration", description: "locator 解析失败：自定义 dropdown 触发按钮定位", mustKnow: ["RISK_POLICY", "CURRENT_PROJECT_STATE", "DSL_ARCHITECTURE", "OPERATION_MANUAL"], useful: ["TROUBLESHOOTING"], irrelevant: ["P3_PHASE_REPORT"], dangerousToMiss: ["RISK_POLICY"] },
  { taskId: "g_22", taskType: "EXECUTION_DEBUG", split: "holdout", description: "提现提交时 provider 验证步骤超时", mustKnow: ["RISK_POLICY", "CURRENT_PROJECT_STATE", "OPERATION_MANUAL", "DSL_ARCHITECTURE"], useful: ["TROUBLESHOOTING"], irrelevant: ["P4_PHASE_REPORT"], dangerousToMiss: ["RISK_POLICY", "OPERATION_MANUAL"] },

  // ===== KNOWLEDGE =====
  { taskId: "g_23", taskType: "KNOWLEDGE_PROMOTION", split: "calibration", description: "修复 promotion fan-out（同 sourceRun 重复写 verificationHistory）", mustKnow: ["KNOWLEDGE_PROMOTION_POLICY", "RISK_POLICY", "CURRENT_PROJECT_STATE"], useful: ["PAGE_MODEL_SCHEMA", "KNOWLEDGE_REVIEW_WORKFLOW"], irrelevant: ["P5_PHASE_REPORT"], dangerousToMiss: ["RISK_POLICY", "KNOWLEDGE_PROMOTION_POLICY"] },
  { taskId: "g_24", taskType: "KNOWLEDGE_PROMOTION", split: "calibration", description: "option 写回幂等（重复写同一 option 跳过）", mustKnow: ["KNOWLEDGE_PROMOTION_POLICY", "PAGE_MODEL_SCHEMA", "RISK_POLICY", "CURRENT_PROJECT_STATE"], useful: ["KNOWLEDGE_REVIEW_WORKFLOW"], irrelevant: ["P6_BENCHMARK_HISTORICAL"], dangerousToMiss: ["KNOWLEDGE_PROMOTION_POLICY", "RISK_POLICY"] },
  { taskId: "g_25", taskType: "KNOWLEDGE_AUDIT", split: "calibration", description: "知识飞轮审计：evidence sink 是否落盘", mustKnow: ["KNOWLEDGE_PROMOTION_POLICY", "KNOWLEDGE_REVIEW_WORKFLOW", "CURRENT_PROJECT_STATE"], useful: ["RISK_POLICY"], irrelevant: ["P3_PHASE_REPORT"], dangerousToMiss: ["KNOWLEDGE_PROMOTION_POLICY"] },
  { taskId: "g_26", taskType: "KNOWLEDGE_AUDIT", split: "calibration", description: "检查自愈证据是否进入 unified sink（P5.3 修复验证）", mustKnow: ["KNOWLEDGE_PROMOTION_POLICY", "KNOWLEDGE_REVIEW_WORKFLOW", "CURRENT_PROJECT_STATE"], useful: ["RISK_POLICY"], irrelevant: ["P4_PHASE_REPORT"], dangerousToMiss: ["KNOWLEDGE_PROMOTION_POLICY"] },
  { taskId: "g_27", taskType: "KNOWLEDGE_PROMOTION", split: "holdout", description: "evidence 去重后 review candidate 投影", mustKnow: ["KNOWLEDGE_PROMOTION_POLICY", "KNOWLEDGE_REVIEW_WORKFLOW", "RISK_POLICY", "CURRENT_PROJECT_STATE"], useful: ["PAGE_MODEL_SCHEMA"], irrelevant: ["P5_PHASE_REPORT"], dangerousToMiss: ["RISK_POLICY"] },

  // ===== BENCHMARK =====
  { taskId: "g_28", taskType: "BENCHMARK_CHANGE", split: "calibration", description: "修复 modeling benchmark metric 虚高（71/71 自召回 bug）", mustKnow: ["MODELING_BENCHMARK_CONTRACT", "MODELING_BENCHMARK_LATEST", "CURRENT_PROJECT_STATE"], useful: ["PAGE_MODEL_SCHEMA"], irrelevant: ["P3_PHASE_REPORT", "P6_BENCHMARK_HISTORICAL"], dangerousToMiss: ["MODELING_BENCHMARK_CONTRACT"] },
  { taskId: "g_29", taskType: "BENCHMARK_CHANGE", split: "calibration", description: "assertion PR 越界修复（recall>1 口径）", mustKnow: ["MODELING_BENCHMARK_CONTRACT", "MODELING_BENCHMARK_LATEST", "CURRENT_PROJECT_STATE"], useful: ["PAGE_MODEL_SCHEMA"], irrelevant: ["P4_PHASE_REPORT"], dangerousToMiss: ["MODELING_BENCHMARK_CONTRACT"] },
  { taskId: "g_30", taskType: "BENCHMARK_CHANGE", split: "holdout", description: "mutation benchmark 增加 ADD_DROPDOWN_OPTION 场景", mustKnow: ["MODELING_BENCHMARK_CONTRACT", "MODELING_BENCHMARK_LATEST", "P7_BASELINE", "CURRENT_PROJECT_STATE"], useful: ["PAGE_MODEL_SCHEMA"], irrelevant: ["P5_PHASE_REPORT"], dangerousToMiss: ["MODELING_BENCHMARK_CONTRACT"] },
  { taskId: "g_31", taskType: "BENCHMARK_RUN", split: "calibration", description: "跑 8 页标准 benchmark 出报告", mustKnow: ["MODELING_BENCHMARK_LATEST", "P7_BASELINE", "CURRENT_PROJECT_STATE"], useful: ["MODELING_BENCHMARK_CONTRACT"], irrelevant: ["P3_PHASE_REPORT"], dangerousToMiss: ["MODELING_BENCHMARK_CONTRACT"] },

  // ===== BUG FIX / REFACTOR / DOCS =====
  { taskId: "g_32", taskType: "BUG_FIX", split: "calibration", description: "修复 writeback backup 文件生成失败", mustKnow: ["CURRENT_PROJECT_STATE", "KNOWLEDGE_PROMOTION_POLICY", "ARCHITECTURE_DECISIONS"], useful: ["TROUBLESHOOTING", "PAGE_MODEL_SCHEMA"], irrelevant: ["P2_PHASE_REPORT"], dangerousToMiss: ["KNOWLEDGE_PROMOTION_POLICY"] },
  { taskId: "g_33", taskType: "REFACTOR", split: "holdout", description: "把 option 采集逻辑从 capture 脚本抽到 modeling-option-identity", mustKnow: ["PROJECT_ARCHITECTURE", "ARCHITECTURE_DECISIONS", "CURRENT_PROJECT_STATE"], useful: ["PAGE_MODEL_SCHEMA", "RISK_POLICY"], irrelevant: ["P4_PHASE_REPORT"], dangerousToMiss: ["RISK_POLICY"] },
  { taskId: "g_34", taskType: "DOCUMENTATION", split: "calibration", description: "更新 modeling playbook 补充 option identity 章节", mustKnow: ["CURRENT_PROJECT_STATE", "CONTEXT_SYSTEM_DESIGN"], useful: ["README", "PAGE_MODEL_MODELING_PLAYBOOK"], irrelevant: ["P5_PHASE_REPORT"], dangerousToMiss: ["CURRENT_PROJECT_STATE"] },

  // ===== 跨领域（cross-domain）=====
  { taskId: "g_35", taskType: "PAGE_MODEL_DEBUG", split: "calibration", description: "修改 option promotion 后 DSL 还是 PARTIAL（跨模型+知识+DSL）", mustKnow: ["PAGE_MODEL_SCHEMA", "PAGE_MODEL_MODELING_PLAYBOOK", "KNOWLEDGE_PROMOTION_POLICY", "DSL_ARCHITECTURE", "CURRENT_PROJECT_STATE"], useful: ["OPERATION_MANUAL", "RISK_POLICY"], irrelevant: ["P5_PHASE_REPORT"], dangerousToMiss: ["KNOWLEDGE_PROMOTION_POLICY", "RISK_POLICY"], notes: ["cross_domain"] },
  { taskId: "g_36", taskType: "EXECUTION_DEBUG", split: "holdout", description: "断言执行失败 + 知识写回链路排查（跨执行+知识）", mustKnow: ["RISK_POLICY", "KNOWLEDGE_PROMOTION_POLICY", "CURRENT_PROJECT_STATE", "DSL_ARCHITECTURE"], useful: ["OPERATION_MANUAL"], irrelevant: ["P3_PHASE_REPORT"], dangerousToMiss: ["RISK_POLICY", "KNOWLEDGE_PROMOTION_POLICY"], notes: ["cross_domain"] },
  { taskId: "g_37", taskType: "BENCHMARK_CHANGE", split: "holdout", description: "建模质量提升后更新 benchmark 基线（跨建模+基准）", mustKnow: ["MODELING_BENCHMARK_CONTRACT", "MODELING_BENCHMARK_LATEST", "P7_BASELINE", "CURRENT_PROJECT_STATE", "PAGE_MODEL_SCHEMA"], useful: ["PAGE_MODEL_MODELING_PLAYBOOK"], irrelevant: ["P4_PHASE_REPORT"], dangerousToMiss: ["MODELING_BENCHMARK_CONTRACT"], notes: ["cross_domain"] },

  // ===== 模糊（ambiguous）=====
  { taskId: "g_38", taskType: "PAGE_MODEL_DEBUG", split: "calibration", description: "修 dropdown DSL", mustKnow: ["PAGE_MODEL_SCHEMA", "PAGE_MODEL_MODELING_PLAYBOOK", "DSL_ARCHITECTURE", "CURRENT_PROJECT_STATE", "KNOWLEDGE_PROMOTION_POLICY"], useful: ["RISK_POLICY"], irrelevant: ["P2_PHASE_REPORT"], dangerousToMiss: ["CURRENT_PROJECT_STATE"], notes: ["ambiguous"] },
  { taskId: "g_39", taskType: "EXECUTION_DEBUG", split: "calibration", description: "处理验证失败", mustKnow: ["RISK_POLICY", "CURRENT_PROJECT_STATE", "OPERATION_MANUAL", "DSL_ARCHITECTURE"], useful: ["TROUBLESHOOTING"], irrelevant: ["P4_PHASE_REPORT"], dangerousToMiss: ["RISK_POLICY"], notes: ["ambiguous"] },
  { taskId: "g_40", taskType: "PAGE_MODEL_DEBUG", split: "holdout", description: "更新页面规则", mustKnow: ["PAGE_MODEL_SCHEMA", "PAGE_MODEL_MODELING_PLAYBOOK", "CURRENT_PROJECT_STATE"], useful: ["RISK_POLICY"], irrelevant: ["P3_PHASE_REPORT"], dangerousToMiss: ["CURRENT_PROJECT_STATE"], notes: ["ambiguous"] },
  { taskId: "g_41", taskType: "PAGE_MODEL_DEBUG", split: "holdout", description: "页面建模有点问题", mustKnow: ["PAGE_MODEL_SCHEMA", "PAGE_MODEL_MODELING_PLAYBOOK", "CURRENT_PROJECT_STATE", "KNOWLEDGE_PROMOTION_POLICY"], useful: ["RISK_POLICY"], irrelevant: ["P1_PHASE_REPORT"], dangerousToMiss: ["CURRENT_PROJECT_STATE"], notes: ["ambiguous"] },

  // ===== changed-file / error-only =====
  { taskId: "g_42", taskType: "KNOWLEDGE_PROMOTION", split: "calibration", description: "knowledge-writeback-dispatcher.ts 出错", mustKnow: ["KNOWLEDGE_PROMOTION_POLICY", "RISK_POLICY", "CURRENT_PROJECT_STATE"], useful: ["PAGE_MODEL_SCHEMA"], irrelevant: ["P4_PHASE_REPORT"], dangerousToMiss: ["RISK_POLICY", "KNOWLEDGE_PROMOTION_POLICY"], notes: ["changed_file"] },
  { taskId: "g_43", taskType: "DSL_DEBUG", split: "calibration", description: "page-model-dsl-builder.ts 生成步骤不对", mustKnow: ["DSL_ARCHITECTURE", "PAGE_MODEL_SCHEMA", "CURRENT_PROJECT_STATE", "OPERATION_MANUAL"], useful: ["MODELING_BENCHMARK_LATEST"], irrelevant: ["P5_PHASE_REPORT"], dangerousToMiss: ["PAGE_MODEL_SCHEMA"], notes: ["changed_file"] },
  { taskId: "g_44", taskType: "EXPLORATION", split: "holdout", description: "exploration-executor.ts restore 失败日志", mustKnow: ["PAGE_MODEL_MODELING_PLAYBOOK", "CURRENT_PROJECT_STATE", "RISK_POLICY"], useful: ["PAGE_MODEL_SCHEMA"], irrelevant: ["P2_PHASE_REPORT"], dangerousToMiss: ["RISK_POLICY"], notes: ["changed_file"] },
  { taskId: "g_45", taskType: "BENCHMARK_RUN", split: "calibration", description: "benchmark:modeling 命令失败", mustKnow: ["MODELING_BENCHMARK_LATEST", "P7_BASELINE", "CURRENT_PROJECT_STATE"], useful: ["MODELING_BENCHMARK_CONTRACT"], irrelevant: ["P6_BENCHMARK_HISTORICAL"], dangerousToMiss: ["MODELING_BENCHMARK_CONTRACT"], notes: ["command"] }
];

/** P9.5-3：固定 split（calibration ≈70%，holdout ≈30%）。 */
export function splitGoldDataset(tasks: typeof GOLD_TASKS_V2): { calibration: typeof GOLD_TASKS_V2; holdout: typeof GOLD_TASKS_V2 } {
  return {
    calibration: tasks.filter((t) => t.split === "calibration"),
    holdout: tasks.filter((t) => t.split === "holdout")
  };
}

/** P9.5-30：holdout 一次性评估（禁止为了单条任务调关键词）。 */
export function evaluateHoldout(input: {
  tasks: typeof GOLD_TASKS_V2;
  registry: DocumentRegistryFile;
  profiles: TaskProfileFile;
  rootDir: string;
  sourceCommit: string;
  currentPhase: string;
  sourceOfTruthDomains: string[];
}): { classificationAccuracy: number; primaryAccuracy: number; mandatoryRecall: number; criticalRecall: number; precision: number; packTokens: number[]; results: Array<Record<string, unknown>> } {
  const results: Array<Record<string, unknown>> = [];
  let classAcc = 0;
  let primaryAcc = 0;
  let recallSum = 0;
  let critSum = 0;
  let precSum = 0;
  const tokens: number[] = [];
  for (const gold of input.tasks) {
    const classification = classifyContextTask({ text: gold.description });
    const pack = buildContextPack({ task: classification, registry: input.registry, profiles: input.profiles, rootDir: input.rootDir, sourceCommit: input.sourceCommit, currentPhase: input.currentPhase, sourceOfTruthDomains: input.sourceOfTruthDomains });
    const recall = contextRecall(pack, gold);
    const precision = contextPrecision(pack, gold);
    const sev = missingContextSeverities(pack, gold);
    const critical = sev.filter((s) => s.severity === "CRITICAL");
    if (classification.primaryTask === gold.taskType) { classAcc += 1; primaryAcc += 1; }
    recallSum += recall.recall;
    precSum += precision.precision;
    critSum += critical.length === 0 ? 1 : 0;
    tokens.push(pack.budget.estimatedTokens);
    results.push({ id: gold.taskId, taskType: gold.taskType, classified: classification.primaryTask, secondary: classification.secondaryTasks, confidence: classification.confidence, recall: recall.recall, precision: precision.precision, criticalMisses: critical.map((c) => c.documentId), packTokens: pack.budget.estimatedTokens });
  }
  const n = input.tasks.length;
  const sorted = [...tokens].sort((a, b) => a - b);
  const p50 = sorted[Math.floor(n * 0.5)] ?? 0;
  const p90 = sorted[Math.floor(n * 0.9)] ?? 0;
  const p95 = sorted[Math.floor(n * 0.95)] ?? 0;
  return {
    classificationAccuracy: Math.round((classAcc / n) * 1000) / 1000,
    primaryAccuracy: Math.round((primaryAcc / n) * 1000) / 1000,
    mandatoryRecall: Math.round((recallSum / n) * 1000) / 1000,
    criticalRecall: Math.round((critSum / n) * 1000) / 1000,
    precision: Math.round((precSum / n) * 1000) / 1000,
    packTokens: [p50, p90, p95, Math.max(...sorted, 0)],
    results
  };
}
