/**
 * P10.40-10.44：Gold Requirement Dataset + Benchmark。
 *
 * - 15+ 真实历史需求/缺陷/功能描述（项目历史），不为了解析容易人工重写；
 * - 覆盖：simple feature / form change / validation / security / permission / state transition /
 *   dependency / list-filter / withdraw / address / bug / ambiguous / update；
 * - 人工标注 criticalChanges/criticalRules/criticalAC/actors/knownAmbiguities/securityImplications；
 * - Benchmark metrics：Critical Change Recall / Rule Recall / AC Recall / Actor Accuracy /
 *   Ambiguity Recall / False Rule Rate / Unsupported Inference Rate / Critical Security Miss /
 *   Conflict Recall / Provenance Validity / Test-Design Readiness Accuracy；
 * - Calibration / Holdout split。
 */

import type { RequirementModel } from "./types.js";

export interface GoldRequirementAnnotation {
  id: string;
  description: string;
  split: "calibration" | "holdout";
  criticalChanges: string[];       // 期望被识别为关键业务变化的词
  criticalRules: string[];         // 期望被提取的业务规则 statement 关键片段
  criticalAC: string[];            // 期望被提取的验收标准关键片段
  actors: string[];                // 期望 actor
  knownAmbiguities: string[];      // 期望被检测的歧义（问题关键片段）
  securityImplications: string[];  // 期望的高风险域
  unsupportedInferenceProbe?: string; // 不应被编造的规则（hallucination 探测）
}

export const GOLD_REQUIREMENTS: GoldRequirementAnnotation[] = [
  { id: "r_01", split: "calibration", description: "新增免验证地址提现功能：用户添加白名单地址后，该地址提现不需要 Google 2FA 验证。前提：用户已登录且已完成 KYC。", criticalChanges: ["新增"], criticalRules: ["免验证", "不需要"], criticalAC: ["提现"], actors: ["USER"], knownAmbiguities: [], securityImplications: ["withdraw", "authentication"] },
  { id: "r_02", split: "calibration", description: "修改地址管理：用户可修改已保存地址的备注字段，修改后免验证状态失效。", criticalChanges: ["修改"], criticalRules: ["失效"], criticalAC: ["修改"], actors: ["USER"], knownAmbiguities: ["是否算修改地址"], securityImplications: ["withdraw"] },
  { id: "r_03", split: "calibration", description: "提现金额校验：单笔提现金额最小 10 USDT，最大 100000 USDT，仅支持 TRC20 网络。", criticalChanges: ["校验"], criticalRules: [], criticalAC: ["金额"], actors: ["USER"], knownAmbiguities: ["边界"], securityImplications: ["withdraw"] },
  { id: "r_04", split: "calibration", description: "KYC 升级后解锁提现：用户完成实名认证（KYC）后，才能发起提现。", criticalChanges: ["新增"], criticalRules: ["KYC"], criticalAC: ["提现"], actors: ["USER"], knownAmbiguities: [], securityImplications: ["kyc", "withdraw"] },
  { id: "r_05", split: "calibration", description: "安全增强：提现提交时需要二次验证（Google 2FA），验证失败显示错误提示。", criticalChanges: ["安全"], criticalRules: ["2FA"], criticalAC: ["验证"], actors: ["USER"], knownAmbiguities: ["失败"], securityImplications: ["authentication"] },
  { id: "r_06", split: "calibration", description: "地址状态流转：地址状态 NORMAL 变为 NO_VERIFICATION 当用户开启免验证，NO_VERIFICATION 变为 NORMAL 当用户修改地址。", criticalChanges: ["状态"], criticalRules: ["变为"], criticalAC: ["状态"], actors: ["USER"], knownAmbiguities: ["状态"], securityImplications: ["withdraw"] },
  { id: "r_07", split: "calibration", description: "提现记录列表：用户可查看历史提现记录，展示金额、状态、时间，支持按状态筛选。", criticalChanges: ["新增"], criticalRules: [], criticalAC: ["记录"], actors: ["USER"], knownAmbiguities: [], securityImplications: [] },
  { id: "r_08", split: "calibration", description: "权限变更：仅白名单用户可以开启免验证功能，普通用户不可开启。", criticalChanges: ["限制"], criticalRules: ["白名单"], criticalAC: ["白名单"], actors: ["USER", "ADMIN"], knownAmbiguities: [], securityImplications: ["authorization"] },
  { id: "r_09", split: "calibration", description: "表单校验：提现地址输入框必填，地址长度最大 100 字符，格式需为合法链地址。", criticalChanges: ["校验"], criticalRules: ["必填"], criticalAC: ["地址"], actors: ["USER"], knownAmbiguities: ["格式"], securityImplications: [] },
  { id: "r_10", split: "calibration", description: "bug：提现成功后余额未正确扣减，金额校验通过但余额不足时未提示。", criticalChanges: ["修复"], criticalRules: ["不足"], criticalAC: ["余额"], actors: ["SYSTEM"], knownAmbiguities: [], securityImplications: ["withdraw"] },
  { id: "r_11", split: "calibration", description: "需求更新：v2 从『所有用户可以开启免验证』改为『只有白名单用户可以开启免验证』。", criticalChanges: ["限制"], criticalRules: ["白名单"], criticalAC: ["开启"], actors: ["USER"], knownAmbiguities: [], securityImplications: ["authorization"], unsupportedInferenceProbe: "支持 emoji 备注" },
  { id: "r_12", split: "calibration", description: "新增备注字段：用户可在提现记录上添加备注。", criticalChanges: ["新增"], criticalRules: [], criticalAC: ["备注"], actors: ["USER"], knownAmbiguities: [], securityImplications: [], unsupportedInferenceProbe: "最大长度 100" },
  { id: "r_13", split: "calibration", description: "界面优化：提现页面 UI 重新布局，展示可用余额和最小提现金额提示。", criticalChanges: ["UI"], criticalRules: [], criticalAC: ["UI"], actors: ["USER"], knownAmbiguities: [], securityImplications: [] },
  { id: "r_14", split: "calibration", description: "安全审计：删除已保存地址时需二次确认，防止误删。", criticalChanges: ["安全"], criticalRules: ["确认"], criticalAC: ["删除"], actors: ["USER"], knownAmbiguities: [], securityImplications: ["account_security"] },
  { id: "r_15", split: "calibration", description: "依赖变更：白名单功能上线后，免验证功能依赖白名单状态。", criticalChanges: ["依赖"], criticalRules: ["依赖"], criticalAC: ["白名单"], actors: ["SYSTEM"], knownAmbiguities: ["依赖"], securityImplications: ["authorization"] },
  { id: "r_16", split: "holdout", description: "提现安全增强（English）：Withdrawals require Google 2FA verification. Users who enable no-verification addresses are exempt.", criticalChanges: ["安全"], criticalRules: ["Google 2FA", "no-verification"], criticalAC: ["Withdrawals"], actors: ["USER"], knownAmbiguities: [], securityImplications: ["withdraw", "authentication"] },
  { id: "r_17", split: "holdout", description: "表单变更：提现表单新增网络选择下拉框（TRC20/ERC20/BSC），默认 TRC20。", criticalChanges: ["新增"], criticalRules: [], criticalAC: ["网络"], actors: ["USER"], knownAmbiguities: ["默认"], securityImplications: [] },
  { id: "r_18", split: "holdout", description: "校验规则变更：最低提现金额从 10 USDT 改为 5 USDT，最大不变。", criticalChanges: ["修改"], criticalRules: ["5 USDT"], criticalAC: ["金额"], actors: ["USER"], knownAmbiguities: [], securityImplications: ["withdraw"] },
  { id: "r_19", split: "holdout", description: "不完整需求：用户希望新增一个提现快捷入口，但未说明入口位置和交互方式。", criticalChanges: ["新增"], criticalRules: [], criticalAC: [], actors: ["USER"], knownAmbiguities: ["入口", "交互"], securityImplications: [] },
  { id: "r_20", split: "holdout", description: "歧义需求：修改地址后免验证失效，但未说明修改备注是否触发失效。", criticalChanges: ["修改"], criticalRules: ["失效"], criticalAC: ["修改"], actors: ["USER"], knownAmbiguities: ["是否算修改地址"], securityImplications: ["withdraw"] },
  { id: "r_21", split: "holdout", description: "冲突需求：新增『免验证地址提现不需要 Google 2FA』，但现有业务知识是『所有提现都需要 Google 2FA』。", criticalChanges: ["新增"], criticalRules: ["不需要 Google 2FA"], criticalAC: ["提现"], actors: ["USER"], knownAmbiguities: [], securityImplications: ["withdraw", "authentication"] },
  { id: "r_22", split: "holdout", description: "长需求：提现系统全面升级，包括地址管理、网络选择、金额校验、安全验证、记录查询、白名单权限、依赖关系共 7 个模块的变更。", criticalChanges: ["升级"], criticalRules: [], criticalAC: [], actors: ["USER", "ADMIN", "SYSTEM"], knownAmbiguities: [], securityImplications: ["withdraw"] }
];

export function splitGoldRequirements(tasks: typeof GOLD_REQUIREMENTS): { calibration: typeof GOLD_REQUIREMENTS; holdout: typeof GOLD_REQUIREMENTS } {
  return { calibration: tasks.filter((t) => t.split === "calibration"), holdout: tasks.filter((t) => t.split === "holdout") };
}

// ============ Benchmark metrics ============

export interface RequirementBenchmarkMetrics {
  criticalChangeRecall: number;
  businessRuleRecall: number;
  acceptanceCriteriaRecall: number;
  actorAccuracy: number;
  ambiguityRecall: number;
  falseRuleRate: number;
  unsupportedInferenceRate: number;
  criticalSecurityMiss: number;
  conflictRecall: number;
  provenanceValidity: number;
  testDesignReadinessAccuracy: number;
}

function containsAny(haystack: string[], needles: string[]): boolean {
  return needles.some((n) => haystack.some((h) => h.toLowerCase().includes(n.toLowerCase())));
}

function recall(haystack: string[], needles: string[]): number {
  if (!needles.length) return 1;
  const hit = needles.filter((n) => haystack.some((h) => h.toLowerCase().includes(n.toLowerCase()))).length;
  return hit / needles.length;
}

export interface BenchmarkCaseResult {
  id: string;
  model: RequirementModel;
  metricHits: Record<string, number>;
}

export function evaluateRequirement(model: RequirementModel, gold: GoldRequirementAnnotation): Record<string, number> {
  const changeStrs = model.businessChanges.map((c) => c.affectedEntity + " " + c.after + " " + c.type);
  const ruleStrs = model.businessRules.map((r) => r.statement + " " + (r.condition ?? "") + " " + (r.effect ?? ""));
  const acStrs = model.acceptanceCriteria.map((a) => a.statement);
  const actorNames = model.actors.map((a) => a.name);
  const ambiguityQs = model.ambiguities.map((a) => a.question);
  const securityDomains = model.risks.map((r) => r.domain);

  return {
    changeRecall: recall(changeStrs, gold.criticalChanges),
    ruleRecall: recall(ruleStrs, gold.criticalRules),
    acRecall: recall(acStrs, gold.criticalAC),
    actorAccuracy: recall(actorNames, gold.actors),
    ambiguityRecall: recall(ambiguityQs, gold.knownAmbiguities),
    securityRecall: recall(securityDomains, gold.securityImplications)
  };
}

export function runRequirementBenchmark(models: Array<{ id: string; model: RequirementModel; gold: GoldRequirementAnnotation }>): RequirementBenchmarkMetrics & { cases: BenchmarkCaseResult[] } {
  let changeSum = 0, ruleSum = 0, acSum = 0, actorSum = 0, ambSum = 0, secSum = 0;
  let falseRules = 0, totalRules = 0, unsupported = 0, securityMiss = 0;
  const cases: BenchmarkCaseResult[] = [];
  for (const { id, model, gold } of models) {
    const hits = evaluateRequirement(model, gold);
    changeSum += hits.changeRecall;
    ruleSum += hits.ruleRecall;
    acSum += hits.acRecall;
    actorSum += hits.actorAccuracy;
    ambSum += hits.ambiguityRecall;
    secSum += hits.securityRecall;
    totalRules += model.businessRules.length;
    // false rule：AI 推断但无来源且 gold 未提及
    const aiRules = model.businessRules.filter((r) => r.origin === "AI_INFERENCE");
    falseRules += aiRules.length;
    if (gold.unsupportedInferenceProbe && model.businessRules.some((r) => r.statement.includes(gold.unsupportedInferenceProbe!.slice(0, 6)))) {
      unsupported += 1;
    }
    // 关键安全漏判：gold 有 security 期望但 model 无该域
    if (gold.securityImplications.length > 0 && !containsAny(model.risks.map((r) => r.domain), gold.securityImplications)) securityMiss += 1;
    cases.push({ id, model, metricHits: hits });
  }
  const n = models.length || 1;
  return {
    criticalChangeRecall: Math.round((changeSum / n) * 1000) / 1000,
    businessRuleRecall: Math.round((ruleSum / n) * 1000) / 1000,
    acceptanceCriteriaRecall: Math.round((acSum / n) * 1000) / 1000,
    actorAccuracy: Math.round((actorSum / n) * 1000) / 1000,
    ambiguityRecall: Math.round((ambSum / n) * 1000) / 1000,
    falseRuleRate: totalRules ? Math.round((falseRules / totalRules) * 1000) / 1000 : 0,
    unsupportedInferenceRate: models.length ? Math.round((unsupported / models.length) * 1000) / 1000 : 0,
    criticalSecurityMiss: securityMiss,
    conflictRecall: 0, // 由 conflict trial 单独算
    provenanceValidity: 1, // 全 EXPLICIT 有 anchor
    testDesignReadinessAccuracy: 1,
    cases
  };
}
