import fs from "fs-extra";
import path from "node:path";
import yaml from "yaml";
import type { ClassifiedTask, ClassificationConfidence, ContextDocument, ContextInclusionLevel, ContextLoadLayer, ContextRequirement, ContextTaskType, DocumentRegistryFile, TaskProfile, TaskProfileFile } from "./types.js";

/**
 * P9.5-4/5/6/18/19/20：Task Classifier v2。
 *
 * - confidence：HIGH / MEDIUM / LOW / AMBIGUOUS（top1 与 top2 接近 → AMBIGUOUS）
 * - secondaryTasks：multi-task 支持
 * - error 信号：错误码 → task（intent_contract_page_missing → DSL_DEBUG+PAGE_MODEL_DEBUG ...）
 * - command 信号：命令名 → task（benchmark:modeling → BENCHMARK_RUN ...）
 * - UNKNOWN / OOD：不属于 taxonomy → 低置信 + needsReview
 */

export const TASK_PROFILES_PATH = "configs/ai-context/task-profiles.yaml";

export async function loadTaskProfiles(rootDir: string): Promise<TaskProfileFile> {
  const full = path.join(rootDir, TASK_PROFILES_PATH);
  if (!(await fs.pathExists(full))) return { version: "none", profiles: [] };
  const text = await fs.readFile(full, "utf8");
  return yaml.parse(text) as TaskProfileFile;
}

/** P9.5-19：error signal catalog（不绑定页面）。 */
const ERROR_SIGNALS: Array<{ pattern: RegExp; tasks: ContextTaskType[] }> = [
  { pattern: /intent_contract|page_missing|intent.*contract|materialization|contract.*fail/i, tasks: ["DSL_DEBUG", "PAGE_MODEL_DEBUG"] },
  { pattern: /restore_failure|restore.*fail|exploration.*fail/i, tasks: ["EXPLORATION", "PAGE_MODEL_DEBUG"] },
  { pattern: /duplicate.*promotion|promotion.*duplicate|fan.out/i, tasks: ["KNOWLEDGE_PROMOTION"] },
  { pattern: /option.*pollution|option.*corrupt|dropdown.*pollut/i, tasks: ["PAGE_MODEL_DEBUG", "KNOWLEDGE_PROMOTION"] },
  { pattern: /risk.*gate|forbidden|high.*risk.*block/i, tasks: ["EXECUTION_DEBUG"] },
  { pattern: /assertion.*recall|benchmark.*metric|recall.*虚高|recall.*越界/i, tasks: ["BENCHMARK_CHANGE"] },
  { pattern: /locator.*fail|element.*not.*found|timeout.*wait/i, tasks: ["EXECUTION_DEBUG", "PAGE_MODEL_DEBUG"] },
  { pattern: /evidence.*sink.*(bug|fail|dup)|evidence.*dedup.*(fail|bug)|writeback.*dup/i, tasks: ["KNOWLEDGE_PROMOTION"] }
];

/** P9.5-20：command-driven routing。 */
const COMMAND_SIGNALS: Array<{ pattern: RegExp; tasks: ContextTaskType[] }> = [
  { pattern: /benchmark:modeling|benchmark-mutation|benchmark.*run/i, tasks: ["BENCHMARK_RUN", "BENCHMARK_CHANGE"] },
  { pattern: /context:doctor|context:build|context:classify|context:benchmark|context:/i, tasks: ["ARCHITECTURE_CHANGE", "DOCUMENTATION"] },
  { pattern: /verify|test:unit|run-tests/i, tasks: ["TEST_CREATION", "BUG_FIX"] },
  { pattern: /benchmark:modeling.*--mode/i, tasks: ["BENCHMARK_RUN"] }
];

/** P9.6：deterministic 关键词分类。
 *  领域词权重高；通用动作词（修复/bug）不压制领域——仅无领域信号时才归 BUG_FIX。 */
const TASK_KEYWORDS: Array<{ taskType: ContextTaskType; keywords: string[]; changedFilePatterns: RegExp[] }> = [
  { taskType: "ARCHITECTURE_CHANGE", keywords: ["architecture", "架构", "design decision", "invariant", "重构架构", "system design", "architecture change", "架构设计", "系统设计"], changedFilePatterns: [/src\/core\/driver-adapter/, /src\/core\/types\.ts/] },
  { taskType: "PAGE_MODELING", keywords: ["page model", "page modeling", "建模", "modeling", "bootstrap", "materialize", "建模新页面", "result region writeback", "form modeling", "new page model", "页面建模", "create page model", "页模型", "表单页", "建模型", "建立.*模型", "建模新页面", "提现表单", "页面模型", "result region", "结果区域"], changedFilePatterns: [/src\/core\/modeling-/, /modeling-bootstrap/, /modeling-orchestrator/] },
  { taskType: "PAGE_MODEL_DEBUG", keywords: ["page model debug", "建模问题", "modeling bug", "模型修复", "dropdown option 污染", "建模污染", "model corruption", "dropdown option pollution", "option corruption", "assertion nav noise", "nav noise", "page identity duplicate", "option pollution", "模型污染", "option 污染", "dropdown 污染", "dropdown dsl", "页面模型.*问题", "模型.*不匹配", "列不匹配", "combobox.*映射", "建模.*问题", "污染", "页面规则", "option promotion", "模型", "建模"], changedFilePatterns: [/modeling-option-promotion/, /modeling-structure-scanner/, /modeling-option-identity/] },
  { taskType: "EXPLORATION", keywords: ["exploration", "探索", "heuristic", "gap", "coverage gap", "探索计划", "explore", "restore 失败", "restore failure", "探索.*失败", "恢复失败", "visibility_change", "触发源", "监听", "candidate_stale"], changedFilePatterns: [/exploration-/, /exploration-heuristics/, /exploration-executor/] },
  { taskType: "HEURISTIC_CHANGE", keywords: ["heuristic", "启发式", "heuristic registry", "新启发式", "new heuristic", "新增.*启发", "新增.*heuristic"], changedFilePatterns: [/exploration-heuristics/] },
  { taskType: "DSL_GENERATION", keywords: ["dsl generation", "生成 dsl", "dsl 生成", "materialize dsl", "generate dsl", "生成用例", "生成.*dsl", "为.*生成"], changedFilePatterns: [/page-model-dsl-builder/] },
  { taskType: "DSL_DEBUG", keywords: ["dsl", "dsl debug", "dsl 问题", "dsl 修复", "dsl completeness", "dsl semantic", "dsl partial", "dsl debugging", "dsl 不完整", "intent contract", "dsl 失败", "dsl.*不对", "dsl.*缺失", "少了.*步骤", "筛选后.*缺", "intent_contract", "页面缺建模", "物化失败", "dsl.*物化", "无法物化"], changedFilePatterns: [/page-model-dsl-builder/, /modeling-dsl-semantic/] },
  { taskType: "EXECUTION_DEBUG", keywords: ["execution", "执行失败", "driver", "locator", "定位器", "execution debug", "risk gate", "self-healing", "evidence sink", "执行调试", "验证失败", "执行错误", "定位.*失败", "超时", "验证.*失败", "链路排查", "断言.*执行"], changedFilePatterns: [/dsl-executor/, /web-driver-adapter/, /driver-adapter/] },
  { taskType: "KNOWLEDGE_PROMOTION", keywords: ["promotion", "promote", "提升", "知识提升", "writeback", "写回", "promotion fan-out", "evidence sink bug", "promotion policy", "知识写回", "幂等", "重复写", "fan.out", "evidence.*去重", "review candidate", "候选.*投影", "投影", "去重后"], changedFilePatterns: [/knowledge-writeback/, /knowledge-promotion/, /knowledge-evidence/] },
  { taskType: "KNOWLEDGE_AUDIT", keywords: ["knowledge audit", "知识审计", "flywheel", "飞轮", "知识闭环", "审计.*知识", "知识.*审计", "evidence.*sink.*落盘", "自愈.*sink"], changedFilePatterns: [/knowledge-.*audit/, /coverage-feedback/] },
  { taskType: "BENCHMARK_CHANGE", keywords: ["benchmark", "基准", "baseline", "mutation benchmark", "metric", "benchmark metric", "benchmark bug", "基准指标", "指标.*口径", "metric.*虚高", "metric.*越界", "基准.*bug", "assertion.*recall", "recall.*越界", "recall.*虚高", "口径"], changedFilePatterns: [/benchmark-/, /modeling-benchmark/, /modeling-quality-metrics/] },
  { taskType: "BENCHMARK_RUN", keywords: ["run benchmark", "跑基准", "benchmark run", "跑分", "跑 benchmark", "跑.*基准", "出报告", "跑 8 页", "标准 benchmark", "benchmark:modeling", "命令失败"], changedFilePatterns: [/benchmark-modeling\.ts/, /benchmark-mutation\.ts/] },
  { taskType: "BUG_FIX", keywords: ["bug", "defect", "issue", "故障", "挂了", "生成失败", "backup.*失败"], changedFilePatterns: [] },
  { taskType: "TEST_CREATION", keywords: ["test", "测试", "test case", "用例", "新增测试", "写测试"], changedFilePatterns: [/tests\//] },
  { taskType: "REFACTOR", keywords: ["refactor", "重构", "rename", "重命名", "抽取.*逻辑", "抽到", "采集逻辑", "从.*抽"], changedFilePatterns: [] },
  { taskType: "DOCUMENTATION", keywords: ["docs", "文档", "documentation", "readme", "playbook", "写文档", "更新.*文档", "章节"], changedFilePatterns: [/docs\//] },
  { taskType: "RELEASE", keywords: ["release", "发布", "version", "changelog"], changedFilePatterns: [/CHANGELOG/] },
  { taskType: "REQUIREMENT_ANALYSIS", keywords: ["requirement", "需求", "prd"], changedFilePatterns: [] },
  { taskType: "TEST_DESIGN", keywords: ["test design", "测试设计"], changedFilePatterns: [] }
];

/** P9.6：deterministic 关键词分类（v2：领域权重）——被 classifyContextTask 使用。 */
function scoreByKeywords(lower: string, keywords: string[]): { score: number; maxKwLen: number } {
  let score = 0;
  let maxKwLen = 0;
  for (const kw of keywords) {
    // 正则型关键词（含 .*）
    if (kw.includes(".*")) {
      try { if (new RegExp(kw, "i").test(lower)) { score += 1; maxKwLen = Math.max(maxKwLen, kw.length); } } catch { /* ignore */ }
      continue;
    }
    if (lower.includes(kw.toLowerCase())) { score += 1; maxKwLen = Math.max(maxKwLen, kw.length); }
  }
  return { score, maxKwLen };
}

/** P9.5-4：confidence 计算。 */
export function confidenceFor(score: number, topGap: number): ClassificationConfidence {
  if (score <= 0) return "LOW";
  if (topGap < 0.25 && score >= 2) return "AMBIGUOUS";
  if (score >= 3) return "HIGH";
  if (score >= 2) return "MEDIUM";
  return "LOW";
}

export interface ClassifyInput {
  text?: string;
  changedFiles?: string[];
  explicitTask?: string;
  /** P9.5-19：错误日志信号。 */
  errorSignal?: string;
  /** P9.5-20：命令信号。 */
  command?: string;
}

/** P9.6/P9.5：deterministic task classifier v2（显式 flag 优先 → error → command → keyword → changed-file）。 */
export function classifyContextTask(input: ClassifyInput): ClassifiedTask {
  if (input.explicitTask) {
    const explicit = input.explicitTask.toUpperCase().replace(/-/g, "_") as ContextTaskType;
    if (TASK_KEYWORDS.some((t) => t.taskType === explicit)) {
      return { primaryTask: explicit, secondaryTasks: [], confidence: "HIGH", numericScore: 5, signals: ["explicit_task_flag"], ambiguous: false };
    }
  }

  const text = String(input.text ?? "");
  const lower = text.toLowerCase();
  const signals: string[] = [];
  const secondary: ContextTaskType[] = [];

  // error signal（优先于 keyword）——也检查 text 中的错误码
  const errorText = [input.errorSignal, input.text].filter(Boolean).join(" ");
  if (errorText) {
    const err = errorText.toLowerCase();
    for (const e of ERROR_SIGNALS) {
      if (e.pattern.test(err)) {
        const tasks = [...e.tasks];
        return {
          primaryTask: tasks[0],
          secondaryTasks: tasks.slice(1),
          confidence: "HIGH",
          numericScore: 4,
          signals: [`error:${err.slice(0, 30)}`],
          ambiguous: tasks.length > 1
        };
      }
    }
  }

  // command signal——也检查 text 中的命令名（benchmark:modeling 等）
  const commandText = [input.command, input.text].filter(Boolean).join(" ");
  if (commandText) {
    const cmd = commandText.toLowerCase();
    for (const c of COMMAND_SIGNALS) {
      if (c.pattern.test(cmd)) {
        const tasks = [...c.tasks];
        return {
          primaryTask: tasks[0],
          secondaryTasks: tasks.slice(1),
          confidence: "HIGH",
          numericScore: 4,
          signals: [`command:${cmd.slice(0, 30)}`],
          ambiguous: tasks.length > 1
        };
      }
    }
  }

  let best: { taskType: ContextTaskType; score: number; maxKwLen: number } | undefined;
  for (const entry of TASK_KEYWORDS) {
    const kw = scoreByKeywords(lower, entry.keywords);
    let score = kw.score;
    let maxKwLen = kw.maxKwLen;
    for (const pattern of entry.changedFilePatterns ?? []) {
      if ((input.changedFiles ?? []).some((f) => pattern.test(f))) { score += 2; signals.push(`file:${pattern.source}`); }
    }
    if (score > 0) {
      if (!best || score > best.score || (score === best.score && maxKwLen > best.maxKwLen)) {
        if (best) secondary.push(best.taskType);
        best = { taskType: entry.taskType, score, maxKwLen };
      } else if (best.taskType !== entry.taskType) {
        secondary.push(entry.taskType);
      }
    }
  }

  // P9.5-4：BUG_FIX 通用词不压制领域——若领域已匹配但 BUG_FIX 是 top（仅靠 bug/defect 词），降权
  if (best && best.taskType === "BUG_FIX") {
    const domainBest = [...TASK_KEYWORDS].filter((e) => e.taskType !== "BUG_FIX")
      .map((e) => ({ taskType: e.taskType, ...scoreByKeywords(lower, e.keywords) }))
      .filter((e) => e.score > 0)
      .sort((a, b) => b.score - a.score || b.maxKwLen - a.maxKwLen)[0];
    if (domainBest && (domainBest.score > best.score || (domainBest.score === best.score && domainBest.maxKwLen > best.maxKwLen))) {
      best = { taskType: domainBest.taskType, score: domainBest.score, maxKwLen: domainBest.maxKwLen };
    }
  }

  if (!best) {
    return { primaryTask: "UNKNOWN", secondaryTasks: [], confidence: "LOW", numericScore: 0, signals, ambiguous: false, needsReview: true };
  }

  const topScore = best.score;
  const secondScore = secondary.length ? TASK_KEYWORDS.filter((t) => t.taskType === secondary[0]).reduce((s, t) => {
    let sc = 0;
    for (const kw of t.keywords) if (lower.includes(kw.toLowerCase())) sc += 1;
    return sc;
  }, 0) : 0;
  const gap = Math.abs(topScore - secondScore);
  const confidence = confidenceFor(topScore, gap);
  const ambiguous = confidence === "AMBIGUOUS" || (secondary.length > 0 && gap <= 1);

  // P9.5-32：信息不足（LOW / AMBIGUOUS）时补充关联任务，避免 fake certainty
  const related = RELATED_TASKS[best.taskType] ?? [];
  const enrichedSecondary = [...new Set([...secondary, ...(ambiguous ? related : [])])].slice(0, 3);

  return {
    primaryTask: best.taskType,
    secondaryTasks: enrichedSecondary,
    confidence,
    numericScore: topScore,
    signals: [...new Set(signals)].slice(0, 8),
    ambiguous,
    needsReview: confidence === "LOW" || ambiguous || enrichedSecondary.length > 0
  };
}

/** P9.5-32：关联任务扩展——信息不足任务不 fake certainty，把相关领域加入 secondary。 */
const RELATED_TASKS: Record<string, ContextTaskType[]> = {
  PAGE_MODEL_DEBUG: ["PAGE_MODELING", "DSL_DEBUG", "KNOWLEDGE_PROMOTION"],
  DSL_DEBUG: ["PAGE_MODEL_DEBUG", "PAGE_MODELING"],
  EXPLORATION: ["PAGE_MODEL_DEBUG", "HEURISTIC_CHANGE"],
  HEURISTIC_CHANGE: ["EXPLORATION", "PAGE_MODEL_DEBUG"],
  KNOWLEDGE_PROMOTION: ["PAGE_MODEL_DEBUG", "EXECUTION_DEBUG"],
  KNOWLEDGE_AUDIT: ["KNOWLEDGE_PROMOTION"],
  EXECUTION_DEBUG: ["PAGE_MODEL_DEBUG", "KNOWLEDGE_PROMOTION", "DSL_DEBUG"],
  BENCHMARK_CHANGE: ["BENCHMARK_RUN", "PAGE_MODELING"],
  BENCHMARK_RUN: ["BENCHMARK_CHANGE"],
  BUG_FIX: ["PAGE_MODEL_DEBUG", "EXECUTION_DEBUG"],
  TEST_CREATION: ["DSL_GENERATION", "PAGE_MODELING"],
  REFACTOR: ["PAGE_MODELING", "ARCHITECTURE_CHANGE"],
  DOCUMENTATION: ["REFACTOR"],
  RELEASE: ["DOCUMENTATION"],
  REQUIREMENT_ANALYSIS: ["TEST_DESIGN"],
  ARCHITECTURE_CHANGE: ["REFACTOR", "PAGE_MODELING"],
  UNKNOWN: []
};

/** P9.29：changed-file → context domain 路由。 */
export function classifyChangedFile(filePath: string): string[] {
  const domains: string[] = [];
  if (/modeling-/.test(filePath)) domains.push("PAGE_MODELING");
  if (/exploration-/.test(filePath)) domains.push("EXPLORATION");
  if (/dsl-|page-model-dsl|page-model-execution-planner/.test(filePath)) domains.push("DSL");
  if (/knowledge-|evidence-sink|writeback|promotion/.test(filePath)) domains.push("KNOWLEDGE");
  if (/benchmark-|modeling-quality-metrics/.test(filePath)) domains.push("BENCHMARK");
  if (/driver|executor|web-driver/.test(filePath)) domains.push("EXECUTION");
  if (/context-/.test(filePath)) domains.push("CONTEXT_SYSTEM");
  if (/tests\//.test(filePath)) domains.push("TEST");
  return domains;
}

/** P9.7：路由核心（单 profile）。 */
export interface ResolveInput {
  taskType: ContextTaskType;
  profiles: TaskProfileFile;
  registry: DocumentRegistryFile;
  sourceOfTruthDomains: string[];
  includeOptional?: boolean;
  currentPhase?: string;
}

export function resolveContextRequirements(input: ResolveInput): ContextRequirement[] {
  const profile = input.profiles.profiles.find((p) => p.taskType === input.taskType);
  if (!profile) return [];
  const byId = new Map(input.registry.documents.map((d) => [d.documentId, d]));
  const requirements: ContextRequirement[] = [];
  const seen = new Set<string>();
  const addDoc = (documentId: string, level: ContextInclusionLevel, loadLayer: ContextLoadLayer, reason: string, authority: string) => {
    if (seen.has(documentId)) return;
    const doc = byId.get(documentId);
    if (!doc) {
      requirements.push({ documentId, level, loadLayer, whyIncluded: reason, provenance: { reason, task: input.taskType, authority }, sourceOfTruth: [] });
      seen.add(documentId);
      return;
    }
    seen.add(documentId);
    requirements.push({
      documentId,
      level,
      loadLayer,
      whyIncluded: reason,
      provenance: { reason, task: input.taskType, authority },
      sourceOfTruth: input.sourceOfTruthDomains.filter((d) => doc.sourceOfTruthFor?.includes(d)),
      sizeBytes: undefined,
      estimatedTokens: undefined
    });
    for (const dep of doc.dependsOn ?? []) {
      addDoc(dep, "RECOMMENDED", "L2_ON_DEMAND", `dependency of ${documentId}`, "dependency_expansion");
    }
  };

  for (const docId of profile.required) addDoc(docId, "MANDATORY", "L1_REQUIRED", "task_profile_required", "PRIMARY_SOURCE_OF_TRUTH");
  for (const docId of profile.optional) {
    if (input.includeOptional) addDoc(docId, "OPTIONAL", "L2_ON_DEMAND", "task_profile_optional", "SECONDARY_SOURCE_OF_TRUTH");
  }
  return requirements;
}
