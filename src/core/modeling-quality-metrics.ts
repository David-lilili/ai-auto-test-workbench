/**
 * P7.1：Modeling Quality Metric Contract（单一事实源）。
 *
 * 所有 benchmark metric 必须在这里定义 numerator/denominator/matching rule/ignored cases，
 * 不允许各脚本自行定义 metric。
 *
 * 关键修正（P7 首要任务）：
 *   旧口径 element recall = AUTO matched / AUTO total（71/71=100%）是错的。
 *   正确 recall = AUTO correctly matched / GOLD relevant elements。
 *
 * 指标族：
 *   ELEMENT / OPTION / ASSERTION / RESULT_REGION / INTERACTION / STATE / DEPENDENCY
 *   → precision / recall / F1
 *   CONTROL TYPE → accuracy / coverage / confusion matrix
 *   DSL → readiness rate / execution pass rate / avg materialized steps / semantic completeness
 *   INCREMENTAL → changed-area recall / unchanged re-exploration / new-gap precision / retention / churn
 *   COST → browser actions / LLM calls / elapsed / tokens / manual actions / custom code lines
 */

// ============ 基础容器 ============

export interface MetricDefinition {
  metric: string;
  numerator: string;
  denominator: string;
  matchingRule: string;
  ignoredCases: string[];
  confidence: "HIGH" | "MEDIUM" | "LOW";
}

export interface PrecisionRecall {
  precision: number; // TP / (TP + FP)
  recall: number;    // TP / GOLD_RELEVANT
  f1: number;
  tp: number;
  fp: number;
  fn: number;
  goldRelevant: number;
}

export interface BinaryCounts {
  tp: number;
  fp: number;
  fn: number;
  goldRelevant: number;
}

/** 统一 PR 计算。 */
export function computePR(input: BinaryCounts): PrecisionRecall {
  const precision = input.tp + input.fp > 0 ? input.tp / (input.tp + input.fp) : 0;
  const recall = input.goldRelevant > 0 ? input.tp / input.goldRelevant : 0;
  const f1 = precision + recall > 0 ? 2 * precision * recall / (precision + recall) : 0;
  return {
    precision: round(precision),
    recall: round(recall),
    f1: round(f1),
    tp: input.tp,
    fp: input.fp,
    fn: input.fn,
    goldRelevant: input.goldRelevant
  };
}

export function round(value: number, digits = 3): number {
  return Number(value.toFixed(digits));
}

// ============ ELEMENT ============

export const ELEMENT_METRIC: MetricDefinition = {
  metric: "element.precision_recall",
  numerator: "TP = AUTO elements matched to gold elements",
  denominator: "precision: TP+FP (all AUTO elements); recall: GOLD relevant elements",
  matchingRule: "P7.2 semantic matching EXACT/STRONG count as TP; POSSIBLE counts as 0.5 TP (半计)",
  ignoredCases: ["site-wide nav noise (AUTO EXTRA but not gold)", "p4.* placeholder elements"],
  confidence: "MEDIUM"
};

// ============ CONTROL TYPE ============

export interface ControlTypeMatrix {
  accuracy: number;   // correct ctrl / matched pairs
  coverage: number;   // matched pairs / gold relevant elements
  confusion: Array<{ gold: string; auto: string; count: number }>;
  matchedPairs: number;
  goldRelevant: number;
  correct: number;
}

/** ControlType 归一化：dropdown_option→select（等价语义）。 */
export function normalizeControlType(value: string): string {
  const v = String(value ?? "unknown").toLowerCase().trim();
  if (v === "dropdown_option") return "select";
  if (v === "button") return "button";
  if (v === "link") return "link";
  if (v === "input" || v === "text_input" || v === "number_input" || v === "otp_input") return "input";
  if (v === "select" || v === "dropdown") return "select";
  if (v === "tab") return "tab";
  if (v === "checkbox") return "checkbox";
  if (v === "toggle" || v === "switch") return "toggle";
  if (v === "modal_trigger" || v === "dialog") return "dialog";
  if (v === "table" || v === "grid" || v === "list") return "table";
  if (v === "text" || v === "label") return "text";
  return v;
}

/** ControlType confusion matrix（matched pairs 上计算）。 */
export function computeControlTypeMatrix(pairs: Array<{ gold: string; auto: string }>): ControlTypeMatrix {
  const confusionMap = new Map<string, number>();
  let correct = 0;
  for (const pair of pairs) {
    const gold = normalizeControlType(pair.gold);
    const auto = normalizeControlType(pair.auto);
    const key = `${gold}→${auto}`;
    confusionMap.set(key, (confusionMap.get(key) ?? 0) + 1);
    if (gold === auto) correct++;
  }
  const confusion = [...confusionMap.entries()].map(([key, count]) => {
    const [gold, auto] = key.split("→");
    return { gold, auto, count };
  }).sort((a, b) => b.count - a.count);
  return {
    accuracy: round(pairs.length ? correct / pairs.length : 0),
    coverage: 0, // 由调用方填 goldRelevant 后重算
    confusion,
    matchedPairs: pairs.length,
    goldRelevant: pairs.length,
    correct
  };
}

// ============ OPTION / ASSERTION / 其他类型共用 PR ============

export const OPTION_METRIC: MetricDefinition = {
  metric: "option.precision_recall",
  numerator: "TP = AUTO optionValue matched to gold optionValue",
  denominator: "precision: all AUTO options; recall: GOLD options",
  matchingRule: "normalized optionValue 相等（大小写/空白归一）",
  ignoredCases: ["gold 历史过期 option（由 gold projection 过滤）", "remote/virtualized 未采样 option 不计 FN（记 SAMPLED）"],
  confidence: "MEDIUM"
};

export const ASSERTION_METRIC: MetricDefinition = {
  metric: "assertion.precision_recall",
  numerator: "TP = AUTO assertion canonicalKind+语义匹配 gold assertion",
  denominator: "precision: all AUTO assertions; recall: GOLD assertions",
  matchingRule: "canonicalKind 相同 或 语义名互相包含",
  ignoredCases: ["gold 过度建模（需业务知识才合理）不计 FN", "HIGH-risk 断言（不期望自动发现）"],
  confidence: "MEDIUM"
};

export const RESULT_REGION_METRIC: MetricDefinition = {
  metric: "result_region.precision_recall",
  numerator: "TP = AUTO 检测到 result region 且类型匹配",
  denominator: "precision: all AUTO result regions; recall: GOLD result regions",
  matchingRule: "type（TABLE/LIST/GRID）+ 列结构交集",
  ignoredCases: ["页面无 table/list 时 GOLD 也无 region"],
  confidence: "MEDIUM"
};

// ============ DSL ============

export interface DslMetrics {
  readinessRate: number;          // READY / probes
  executionPassRate: number;      // PASS / executed
  avgMaterializedSteps: number;
  semanticCompleteness: number;   // FULL 或加权
}

export const DSL_METRIC: MetricDefinition = {
  metric: "dsl.quality",
  numerator: "readiness: READY probes; pass: PASS executions; completeness: 语义完整 steps",
  denominator: "probes / executions / expected intent steps",
  matchingRule: "readiness = plan.materialization.executable；pass = executeCase status==='passed'；completeness 见 P7.13",
  ignoredCases: ["HIGH-risk probe 不执行（只生成）", "环境不可达跳过"],
  confidence: "MEDIUM"
};

// ============ INCREMENTAL ============

export interface IncrementalMetrics {
  changedAreaRecall: number;          // V2 新发现 / V2 真变化元素
  unchangedReexplorationRate: number; // V2 重探索 / V1 已知区（越低越好）
  newGapPrecision: number;            // V2 新元素 / V2 模型元素
  knowledgeRetention: number;         // V1 元素在 V2 保留率
  modelChurn: number;                 // V2 模型相对 V1 新增+删除占比
}

export const INCREMENTAL_METRIC: MetricDefinition = {
  metric: "incremental.quality",
  numerator: "changed-area TP / unchanged re-explored / retained elements",
  denominator: "changed gold elements / V1 known elements / V1 elements",
  matchingRule: "见 P7.19/P7.12",
  ignoredCases: ["页面级重排（非业务变化）", "cosmetic 变化"],
  confidence: "MEDIUM"
};

// ============ COST ============

export interface CostMetrics {
  browserActions: number;
  llmCalls: number;
  elapsedMs: number;
  tokens: number;
  manualActions: number;
  customCodeLines: number;
}

export const COST_METRIC: MetricDefinition = {
  metric: "modeling.cost",
  numerator: "实际计数",
  denominator: "每次建模会话",
  matchingRule: "从 session/report 聚合",
  ignoredCases: [],
  confidence: "HIGH"
};

// ============ 聚合 ============

export interface MacroWeighted {
  macroPrecision: number;
  macroRecall: number;
  macroF1: number;
  weightedPrecision: number;
  weightedRecall: number;
  weightedF1: number;
}

/** macro / weighted 聚合（按 goldRelevant 加权）。 */
export function aggregatePR(perPage: Array<PrecisionRecall>): MacroWeighted {
  if (!perPage.length) return { macroPrecision: 0, macroRecall: 0, macroF1: 0, weightedPrecision: 0, weightedRecall: 0, weightedF1: 0 };
  const macroP = perPage.reduce((s, x) => s + x.precision, 0) / perPage.length;
  const macroR = perPage.reduce((s, x) => s + x.recall, 0) / perPage.length;
  const totalRelevant = perPage.reduce((s, x) => s + x.goldRelevant, 0) || 1;
  const weightedP = perPage.reduce((s, x) => s + x.precision * x.goldRelevant, 0) / totalRelevant;
  const weightedR = perPage.reduce((s, x) => s + x.recall * x.goldRelevant, 0) / totalRelevant;
  return {
    macroPrecision: round(macroP),
    macroRecall: round(macroR),
    macroF1: round(2 * macroP * macroR / (macroP + macroR || 1)),
    weightedPrecision: round(weightedP),
    weightedRecall: round(weightedR),
    weightedF1: round(2 * weightedP * weightedR / (weightedP + weightedR || 1))
  };
}

/** 全部 metric definition 注册表（供 dashboard / 审计枚举）。 */
export const MODELING_METRIC_REGISTRY: MetricDefinition[] = [
  ELEMENT_METRIC,
  OPTION_METRIC,
  ASSERTION_METRIC,
  RESULT_REGION_METRIC,
  DSL_METRIC,
  INCREMENTAL_METRIC,
  COST_METRIC
];
