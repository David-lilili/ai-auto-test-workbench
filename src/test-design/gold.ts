/**
 * P11.49-55：Gold Test Design Dataset + Scenario Matcher + Benchmark Metrics。
 *
 * - 12+ 真实 Requirements，配 QA Gold Scenario Set（人工整理，非 AI 生成）。
 * - Scenario matcher：deterministic 结构信号（covered rule/AC/actor/state/action/expected/type），文本辅助。
 * - Gold 分类：CRITICAL/HIGH/NORMAL + SOURCE_DERIVED/TESTING_TECHNIQUE/HISTORICAL_BUG。
 * - AI Extra 分类：VALID_NEW_SCENARIO/DUPLICATE/UNSUPPORTED/LOW_VALUE/INVALID/NEEDS_REVIEW。
 * - Explainable Scenario Recall + Test Design Knowledge Ceiling。
 */

import type { TestCoverageObligation, TestDesignCandidate, TestDesignInput } from "./types.js";

export interface GoldScenario {
  id: string;
  title: string;
  scenarioType: string;
  coveredRule?: string;       // 对应 ruleId 或 rule 关键词
  coveredAC?: string;
  actor?: string;
  preconditions: string[];
  actionKeywords: string[];
  expectedKeywords: string[];
  criticality: "CRITICAL" | "HIGH" | "NORMAL";
  source: "SOURCE_DERIVED" | "TESTING_TECHNIQUE" | "HISTORICAL_BUG";
}

export interface GoldRequirement {
  id: string;
  split: "calibration" | "holdout";
  requirementText: string;
  goldScenarios: GoldScenario[];
}

export const GOLD_TEST_DESIGN: GoldRequirement[] = [
  {
    id: "gtd_01", split: "calibration",
    requirementText: "新增免验证地址提现功能：用户添加白名单地址后，该地址提现不需要 Google 2FA 验证。前提：用户已登录且已完成 KYC。",
    goldScenarios: [
      { id: "g01_s1", title: "白名单地址提现无需 2FA", scenarioType: "POSITIVE", coveredRule: "免验证", actor: "USER", preconditions: ["已登录", "KYC 完成", "地址免验证"], actionKeywords: ["提现"], expectedKeywords: ["2FA 不出现"], criticality: "CRITICAL", source: "SOURCE_DERIVED" },
      { id: "g01_s2", title: "非白名单地址提现需 2FA", scenarioType: "SECURITY", coveredRule: "免验证", actor: "USER", preconditions: ["已登录", "KYC 完成"], actionKeywords: ["提现"], expectedKeywords: ["2FA 要求"], criticality: "CRITICAL", source: "SOURCE_DERIVED" },
      { id: "g01_s3", title: "未完成 KYC 不能提现", scenarioType: "SECURITY", coveredRule: "KYC", actor: "USER", preconditions: ["已登录"], actionKeywords: ["提现"], expectedKeywords: ["KYC 提示"], criticality: "CRITICAL", source: "SOURCE_DERIVED" },
      { id: "g01_s4", title: "添加白名单地址成功", scenarioType: "POSITIVE", coveredRule: "白名单", actor: "USER", preconditions: ["已登录"], actionKeywords: ["添加地址"], expectedKeywords: ["保存成功"], criticality: "HIGH", source: "SOURCE_DERIVED" }
    ]
  },
  {
    id: "gtd_02", split: "calibration",
    requirementText: "修改地址管理：用户可修改已保存地址的备注字段，修改后免验证状态失效。",
    goldScenarios: [
      { id: "g02_s1", title: "修改备注后免验证失效", scenarioType: "STATE_TRANSITION", coveredRule: "失效", actor: "USER", preconditions: ["地址免验证"], actionKeywords: ["修改备注"], expectedKeywords: ["免验证失效"], criticality: "CRITICAL", source: "SOURCE_DERIVED" },
      { id: "g02_s2", title: "修改备注后再提现需 2FA", scenarioType: "DEPENDENCY", coveredRule: "失效", actor: "USER", preconditions: ["已修改备注"], actionKeywords: ["提现"], expectedKeywords: ["2FA 要求"], criticality: "HIGH", source: "SOURCE_DERIVED" },
      { id: "g02_s3", title: "未修改地址主体仅改备注不算主体变化", scenarioType: "BOUNDARY", coveredRule: "备注", actor: "USER", preconditions: [], actionKeywords: ["修改备注"], expectedKeywords: ["主体未变"], criticality: "HIGH", source: "TESTING_TECHNIQUE" }
    ]
  },
  {
    id: "gtd_03", split: "calibration",
    requirementText: "提现金额校验：单笔提现金额最小 10 USDT，最大 100000 USDT，仅支持 TRC20 网络。",
    goldScenarios: [
      { id: "g03_s1", title: "提现 10 USDT 成功（下限）", scenarioType: "BOUNDARY", coveredRule: "最小", actor: "USER", preconditions: ["余额足够"], actionKeywords: ["提现"], expectedKeywords: ["成功"], criticality: "HIGH", source: "SOURCE_DERIVED" },
      { id: "g03_s2", title: "提现 9.99 USDT 被拒（低于下限）", scenarioType: "BOUNDARY", coveredRule: "最小", actor: "USER", preconditions: [], actionKeywords: ["提现"], expectedKeywords: ["最低 10"], criticality: "HIGH", source: "SOURCE_DERIVED" },
      { id: "g03_s3", title: "提现 100000 USDT 成功（上限）", scenarioType: "BOUNDARY", coveredRule: "最大", actor: "USER", preconditions: [], actionKeywords: ["提现"], expectedKeywords: ["成功"], criticality: "HIGH", source: "SOURCE_DERIVED" },
      { id: "g03_s4", title: "提现 100001 USDT 被拒（超上限）", scenarioType: "BOUNDARY", coveredRule: "最大", actor: "USER", preconditions: [], actionKeywords: ["提现"], expectedKeywords: ["最大 100000"], criticality: "HIGH", source: "SOURCE_DERIVED" },
      { id: "g03_s5", title: "选择 ERC20 网络提现被拒", scenarioType: "NEGATIVE", coveredRule: "TRC20", actor: "USER", preconditions: [], actionKeywords: ["选择网络"], expectedKeywords: ["仅 TRC20"], criticality: "HIGH", source: "SOURCE_DERIVED" }
    ]
  },
  {
    id: "gtd_04", split: "calibration",
    requirementText: "KYC 升级后解锁提现：用户完成实名认证（KYC）后，才能发起提现。",
    goldScenarios: [
      { id: "g04_s1", title: "KYC 完成可提现", scenarioType: "POSITIVE", coveredRule: "KYC", actor: "USER", preconditions: ["KYC 完成"], actionKeywords: ["提现"], expectedKeywords: ["成功"], criticality: "CRITICAL", source: "SOURCE_DERIVED" },
      { id: "g04_s2", title: "未 KYC 提现被拦", scenarioType: "SECURITY", coveredRule: "KYC", actor: "USER", preconditions: [], actionKeywords: ["提现"], expectedKeywords: ["KYC 提示"], criticality: "CRITICAL", source: "SOURCE_DERIVED" }
    ]
  },
  {
    id: "gtd_05", split: "calibration",
    requirementText: "安全增强：提现提交时需要二次验证（Google 2FA），验证失败显示错误提示。",
    goldScenarios: [
      { id: "g05_s1", title: "正确 2FA 提现成功", scenarioType: "SECURITY", coveredRule: "2FA", actor: "USER", preconditions: ["2FA 可用"], actionKeywords: ["提交 2FA"], expectedKeywords: ["成功"], criticality: "CRITICAL", source: "SOURCE_DERIVED" },
      { id: "g05_s2", title: "错误 2FA 提现失败", scenarioType: "SECURITY", coveredRule: "2FA", actor: "USER", preconditions: [], actionKeywords: ["提交 2FA"], expectedKeywords: ["错误提示"], criticality: "CRITICAL", source: "SOURCE_DERIVED" }
    ]
  },
  {
    id: "gtd_06", split: "calibration",
    requirementText: "地址状态流转：地址状态 NORMAL 变为 NO_VERIFICATION 当用户开启免验证，NO_VERIFICATION 变为 NORMAL 当用户修改地址。",
    goldScenarios: [
      { id: "g06_s1", title: "开启免验证后状态为 NO_VERIFICATION", scenarioType: "STATE_TRANSITION", coveredRule: "状态", actor: "USER", preconditions: [], actionKeywords: ["开启免验证"], expectedKeywords: ["NO_VERIFICATION"], criticality: "HIGH", source: "SOURCE_DERIVED" },
      { id: "g06_s2", title: "修改地址后状态回 NORMAL", scenarioType: "STATE_TRANSITION", coveredRule: "状态", actor: "USER", preconditions: ["NO_VERIFICATION"], actionKeywords: ["修改地址"], expectedKeywords: ["NORMAL"], criticality: "HIGH", source: "SOURCE_DERIVED" },
      { id: "g06_s3", title: "重新开启免验证后状态再转 NO_VERIFICATION", scenarioType: "STATE_TRANSITION", coveredRule: "状态", actor: "USER", preconditions: ["NORMAL"], actionKeywords: ["开启免验证"], expectedKeywords: ["NO_VERIFICATION"], criticality: "NORMAL", source: "SOURCE_DERIVED" }
    ]
  },
  {
    id: "gtd_07", split: "calibration",
    requirementText: "提现记录列表：用户可查看历史提现记录，展示金额、状态、时间，支持按状态筛选。",
    goldScenarios: [
      { id: "g07_s1", title: "查看提现记录列表", scenarioType: "POSITIVE", coveredRule: "列表", actor: "USER", preconditions: ["有记录"], actionKeywords: ["查看"], expectedKeywords: ["记录展示"], criticality: "HIGH", source: "SOURCE_DERIVED" },
      { id: "g07_s2", title: "按状态筛选记录", scenarioType: "POSITIVE", coveredRule: "筛选", actor: "USER", preconditions: [], actionKeywords: ["筛选"], expectedKeywords: ["匹配记录"], criticality: "HIGH", source: "SOURCE_DERIVED" },
      { id: "g07_s3", title: "无记录时显示空状态", scenarioType: "ERROR_HANDLING", coveredRule: "列表", actor: "USER", preconditions: [], actionKeywords: ["查看"], expectedKeywords: ["空状态"], criticality: "NORMAL", source: "SOURCE_DERIVED" }
    ]
  },
  {
    id: "gtd_08", split: "calibration",
    requirementText: "权限变更：仅白名单用户可以开启免验证功能，普通用户不可开启。",
    goldScenarios: [
      { id: "g08_s1", title: "白名单用户可开启免验证", scenarioType: "PERMISSION", coveredRule: "白名单", actor: "WHITELIST_USER", preconditions: ["白名单"], actionKeywords: ["开启"], expectedKeywords: ["成功"], criticality: "CRITICAL", source: "SOURCE_DERIVED" },
      { id: "g08_s2", title: "普通用户开启被拒", scenarioType: "PERMISSION", coveredRule: "白名单", actor: "NORMAL_USER", preconditions: [], actionKeywords: ["开启"], expectedKeywords: ["无权限"], criticality: "CRITICAL", source: "SOURCE_DERIVED" }
    ]
  },
  {
    id: "gtd_09", split: "calibration",
    requirementText: "表单校验：提现地址输入框必填，地址长度最大 100 字符，格式需为合法链地址。",
    goldScenarios: [
      { id: "g09_s1", title: "空地址提交被拒", scenarioType: "NEGATIVE", coveredRule: "必填", actor: "USER", preconditions: [], actionKeywords: ["提交"], expectedKeywords: ["地址必填"], criticality: "HIGH", source: "SOURCE_DERIVED" },
      { id: "g09_s2", title: "地址超 100 字符被拒", scenarioType: "BOUNDARY", coveredRule: "长度", actor: "USER", preconditions: [], actionKeywords: ["输入地址"], expectedKeywords: ["长度限制"], criticality: "HIGH", source: "SOURCE_DERIVED" },
      { id: "g09_s3", title: "非法链地址被拒", scenarioType: "NEGATIVE", coveredRule: "格式", actor: "USER", preconditions: [], actionKeywords: ["输入地址"], expectedKeywords: ["格式错误"], criticality: "HIGH", source: "SOURCE_DERIVED" }
    ]
  },
  {
    id: "gtd_10", split: "holdout",
    requirementText: "提现安全增强（English）：Withdrawals require Google 2FA verification. Users who enable no-verification addresses are exempt.",
    goldScenarios: [
      { id: "g10_s1", title: "普通提现需 2FA", scenarioType: "SECURITY", coveredRule: "2FA", actor: "USER", preconditions: [], actionKeywords: ["withdraw"], expectedKeywords: ["2FA"], criticality: "CRITICAL", source: "SOURCE_DERIVED" },
      { id: "g10_s2", title: "免验证地址提现豁免 2FA", scenarioType: "SECURITY", coveredRule: "no-verification", actor: "USER", preconditions: ["no-verification"], actionKeywords: ["withdraw"], expectedKeywords: ["no 2FA"], criticality: "CRITICAL", source: "SOURCE_DERIVED" }
    ]
  },
  {
    id: "gtd_11", split: "holdout",
    requirementText: "表单变更：提现表单新增网络选择下拉框（TRC20/ERC20/BSC），默认 TRC20。",
    goldScenarios: [
      { id: "g11_s1", title: "选择不同网络后提现", scenarioType: "POSITIVE", coveredRule: "网络", actor: "USER", preconditions: [], actionKeywords: ["选择网络"], expectedKeywords: ["提现成功"], criticality: "HIGH", source: "SOURCE_DERIVED" },
      { id: "g11_s2", title: "默认网络为 TRC20", scenarioType: "POSITIVE", coveredRule: "默认", actor: "USER", preconditions: [], actionKeywords: ["打开表单"], expectedKeywords: ["TRC20 选中"], criticality: "NORMAL", source: "SOURCE_DERIVED" }
    ]
  },
  {
    id: "gtd_12", split: "holdout",
    requirementText: "需求更新：v2 从『所有用户可以开启免验证』改为『只有白名单用户可以开启免验证』。",
    goldScenarios: [
      { id: "g12_s1", title: "白名单用户仍可开启", scenarioType: "PERMISSION", coveredRule: "白名单", actor: "WHITELIST_USER", preconditions: ["白名单"], actionKeywords: ["开启"], expectedKeywords: ["成功"], criticality: "CRITICAL", source: "SOURCE_DERIVED" },
      { id: "g12_s2", title: "原普通用户开启权限被收回", scenarioType: "PERMISSION", coveredRule: "白名单", actor: "NORMAL_USER", preconditions: [], actionKeywords: ["开启"], expectedKeywords: ["无权限"], criticality: "CRITICAL", source: "SOURCE_DERIVED" }
    ]
  },
  {
    id: "gtd_13", split: "holdout",
    requirementText: "不完整需求：用户希望新增一个提现快捷入口，但未说明入口位置和交互方式。",
    goldScenarios: [
      { id: "g13_s1", title: "快捷入口可访问", scenarioType: "POSITIVE", coveredRule: "入口", actor: "USER", preconditions: [], actionKeywords: ["进入入口"], expectedKeywords: ["可访问"], criticality: "NORMAL", source: "SOURCE_DERIVED" }
    ]
  },
  {
    id: "gtd_14", split: "holdout",
    requirementText: "依赖变更：白名单功能上线后，免验证功能依赖白名单状态。",
    goldScenarios: [
      { id: "g14_s1", title: "取消白名单后免验证失效", scenarioType: "DEPENDENCY", coveredRule: "依赖", actor: "USER", preconditions: ["白名单"], actionKeywords: ["取消白名单"], expectedKeywords: ["免验证失效"], criticality: "HIGH", source: "SOURCE_DERIVED" }
    ]
  }
];

export function splitGoldTestDesign(): { calibration: GoldRequirement[]; holdout: GoldRequirement[] } {
  return { calibration: GOLD_TEST_DESIGN.filter((g) => g.split === "calibration"), holdout: GOLD_TEST_DESIGN.filter((g) => g.split === "holdout") };
}

/**
 * P11.5-14：Blind Holdout（5 条全新 requirement，开发期不查看/不调优）。
 * 与 GOLD_TEST_DESIGN 完全隔离；benchmark --mode blind 一次性打开对比。
 */
export const GOLD_BLIND_HOLDOUT: GoldRequirement[] = [
  {
    id: "bh_01", split: "holdout",
    requirementText: "新增提现到邮箱地址功能：用户可将 USDT 提现到已验证邮箱地址，每个邮箱地址每天最多提现 500 USDT。前提：用户已完成 KYC 且邮箱已验证。超过单日限额时提示错误。",
    goldScenarios: [
      { id: "bh01_s1", title: "已验证邮箱地址提现成功", scenarioType: "POSITIVE", coveredRule: "邮箱地址", actor: "USER", preconditions: ["KYC 完成", "邮箱已验证"], actionKeywords: ["提现"], expectedKeywords: ["成功"], criticality: "HIGH", source: "SOURCE_DERIVED" },
      { id: "bh01_s2", title: "单日累计 500 USDT 为上限", scenarioType: "BOUNDARY", coveredRule: "最多提现", preconditions: ["邮箱已验证"], actionKeywords: ["提现"], expectedKeywords: ["500"], criticality: "HIGH", source: "SOURCE_DERIVED" },
      { id: "bh01_s3", title: "超过单日限额提示错误", scenarioType: "NEGATIVE", coveredRule: "单日限额", preconditions: ["已达限额"], actionKeywords: ["提现"], expectedKeywords: ["错误"], criticality: "HIGH", source: "SOURCE_DERIVED" },
      { id: "bh01_s4", title: "未完成 KYC 被拦截", scenarioType: "SECURITY", coveredRule: "KYC", actor: "USER", preconditions: ["未完成 KYC"], actionKeywords: ["提现"], expectedKeywords: ["拦截"], criticality: "CRITICAL", source: "SOURCE_DERIVED" }
    ]
  },
  {
    id: "bh_02", split: "holdout",
    requirementText: "钱包地址备注功能：用户可为白名单地址添加备注（最长 20 字），修改备注后原免验证资格不变。备注为必填。",
    goldScenarios: [
      { id: "bh02_s1", title: "白名单地址添加备注成功", scenarioType: "POSITIVE", coveredRule: "备注", actor: "USER", preconditions: ["白名单地址"], actionKeywords: ["添加"], expectedKeywords: ["保存"], criticality: "HIGH", source: "SOURCE_DERIVED" },
      { id: "bh02_s2", title: "备注最长 20 字", scenarioType: "BOUNDARY", coveredRule: "最长", preconditions: ["白名单地址"], actionKeywords: ["备注"], expectedKeywords: ["20"], criticality: "HIGH", source: "SOURCE_DERIVED" },
      { id: "bh02_s3", title: "修改备注后免验证资格不变", scenarioType: "PERSISTENCE", coveredRule: "免验证", preconditions: ["免验证地址"], actionKeywords: ["修改"], expectedKeywords: ["不变"], criticality: "CRITICAL", source: "SOURCE_DERIVED" },
      { id: "bh02_s4", title: "备注为必填", scenarioType: "NEGATIVE", coveredRule: "必填", preconditions: ["白名单地址"], actionKeywords: ["添加"], expectedKeywords: ["必填"], criticality: "NORMAL", source: "SOURCE_DERIVED" }
    ]
  },
  {
    id: "bh_03", split: "holdout",
    requirementText: "免验证地址移除功能：用户移除白名单地址后，该地址立即恢复需要 2FA。移除需要二次确认，且移除后 24 小时内可恢复。",
    goldScenarios: [
      { id: "bh03_s1", title: "移除后该地址立即恢复需要 2FA", scenarioType: "SECURITY", coveredRule: "移除", actor: "USER", preconditions: ["白名单地址"], actionKeywords: ["移除"], expectedKeywords: ["2FA"], criticality: "CRITICAL", source: "SOURCE_DERIVED" },
      { id: "bh03_s2", title: "移除需要二次确认", scenarioType: "NEGATIVE", coveredRule: "确认", preconditions: ["移除操作"], actionKeywords: ["移除"], expectedKeywords: ["确认"], criticality: "HIGH", source: "SOURCE_DERIVED" },
      { id: "bh03_s3", title: "移除后 24 小时内可恢复", scenarioType: "RECOVERY", coveredRule: "恢复", preconditions: ["已移除"], actionKeywords: ["恢复"], expectedKeywords: ["24"], criticality: "HIGH", source: "SOURCE_DERIVED" }
    ]
  },
  {
    id: "bh_04", split: "holdout",
    requirementText: "提现网络选择功能：用户提现时可选 TRC20 或 ERC20 网络，TRC20 最低 10 USDT，ERC20 最低 20 USDT。选错网络时提示网络不匹配。",
    goldScenarios: [
      { id: "bh04_s1", title: "TRC20 网络提现 10 USDT 成功", scenarioType: "POSITIVE", coveredRule: "TRC20", actor: "USER", preconditions: ["已登录"], actionKeywords: ["提现"], expectedKeywords: ["10"], criticality: "HIGH", source: "SOURCE_DERIVED" },
      { id: "bh04_s2", title: "ERC20 最低 20 USDT", scenarioType: "BOUNDARY", coveredRule: "最低", preconditions: ["已登录"], actionKeywords: ["提现"], expectedKeywords: ["20"], criticality: "HIGH", source: "SOURCE_DERIVED" },
      { id: "bh04_s3", title: "低于网络下限提示错误", scenarioType: "NEGATIVE", coveredRule: "最低", preconditions: ["已登录"], actionKeywords: ["提现"], expectedKeywords: ["错误"], criticality: "HIGH", source: "SOURCE_DERIVED" },
      { id: "bh04_s4", title: "选错网络提示网络不匹配", scenarioType: "ERROR_HANDLING", coveredRule: "不匹配", preconditions: ["已登录"], actionKeywords: ["提现"], expectedKeywords: ["不匹配"], criticality: "NORMAL", source: "SOURCE_DERIVED" }
    ]
  },
  {
    id: "bh_05", split: "holdout",
    requirementText: "KYC 升级通知功能：用户从 KYC1 升级到 KYC2 后，单笔提现限额从 1000 提升到 5000 USDT。升级前发起的提现不受影响。",
    goldScenarios: [
      { id: "bh05_s1", title: "KYC2 后单笔限额提升到 5000", scenarioType: "STATE_TRANSITION", coveredRule: "升级", actor: "USER", preconditions: ["KYC2"], actionKeywords: ["提现"], expectedKeywords: ["5000"], criticality: "HIGH", source: "SOURCE_DERIVED" },
      { id: "bh05_s2", title: "升级前限额仍为 1000", scenarioType: "BOUNDARY", coveredRule: "1000", preconditions: ["KYC1"], actionKeywords: ["提现"], expectedKeywords: ["1000"], criticality: "HIGH", source: "SOURCE_DERIVED" },
      { id: "bh05_s3", title: "升级前发起的提现不受影响", scenarioType: "DEPENDENCY", coveredRule: "不受影响", preconditions: ["升级前发起"], actionKeywords: ["提现"], expectedKeywords: ["不受影响"], criticality: "HIGH", source: "SOURCE_DERIVED" }
    ]
  }
];

// ============ P11.50/51：Scenario Semantic Matcher ============

export interface ScenarioMatchResult {
  matched: boolean;
  goldId?: string;
  score: number;
  signals: string[];
}

const norm = (s: string) => String(s ?? "").toLowerCase().replace(/[^a-z0-9_\u4e00-\u9fa5]/g, "");

// P11.51：中英同义词映射（覆盖 rule/expected/action 关键词）
const SYNONYMS: Record<string, string[]> = {
  "最小": ["min", "minimum", "下限"],
  "最大": ["max", "maximum", "上限"],
  "必填": ["required", "requiredfield"],
  "长度": ["maxlength", "length"],
  "格式": ["format", "pattern", "valid"],
  "失效": ["invalidates", "invalidated", "失效", "expired"],
  "列表": ["list", "table", "record"],
  "筛选": ["filter", "applyfilter"],
  "2fa": ["2fa", "google2fa", "二次验证", "验证"],
  "kyc": ["kyc", "实名", "认证"],
  "白名单": ["whitelist", "permission"],
  "网络": ["network", "trc20", "erc20", "bsc"],
  "金额": ["amount", "数量", "money"],
  "空": ["empty", "emptyresult", "空状态"]
};

function synonymNorm(text: string): string[] {
  const t = norm(text);
  const out = [t];
  for (const [zh, ens] of Object.entries(SYNONYMS)) {
    if (t.includes(norm(zh))) out.push(...ens.map(norm));
  }
  return [...new Set(out)];
}

export function matchCandidateToGold(candidate: TestDesignCandidate, gold: GoldScenario): ScenarioMatchResult {
  const signals: string[] = [];
  let score = 0;
  // 1. covered rule 匹配（中英同义）
  const candText = norm([candidate.objective, ...candidate.expectedOutcomes.map((e) => e.statement), ...candidate.preconditions.map((p) => p.statement)].join(" "));
  const candRuleSynonyms = synonymNorm(candidate.objective + " " + candidate.expectedOutcomes.map((e) => e.statement).join(" "));
  const goldRule = norm(gold.coveredRule ?? "");
  const goldRuleSynonyms = synonymNorm(gold.coveredRule ?? "");
  if (goldRule && (candText.includes(goldRule) || goldRuleSynonyms.some((s) => candRuleSynonyms.includes(s)))) { score += 3; signals.push("rule"); }
  if (goldRule && /no.?verif|免验证/.test(goldRule) && /免验证|no.?verif/.test(candText)) { score += 2; signals.push("no-verif"); }
  // 2. expected 匹配（同义）
  const goldExp = gold.expectedKeywords.map(norm);
  const goldExpSyn = gold.expectedKeywords.flatMap((e) => synonymNorm(e));
  for (const e of goldExp) {
    if (e && (candText.includes(e) || candRuleSynonyms.some((c) => e && c.includes(e)))) { score += 2; signals.push(`expected:${e}`); }
  }
  for (const e of goldExpSyn) {
    if (e && candRuleSynonyms.includes(e)) { score += 1; signals.push(`expected-syn:${e}`); }
  }
  // 3. action 匹配
  const goldAct = gold.actionKeywords.map(norm);
  const goldActSyn = gold.actionKeywords.flatMap((a) => synonymNorm(a));
  for (const a of goldAct) {
    if (a && (candText.includes(a) || candRuleSynonyms.includes(a))) { score += 1; signals.push(`action:${a}`); }
  }
  for (const a of goldActSyn) {
    if (a && candRuleSynonyms.includes(a)) { score += 1; signals.push(`action-syn:${a}`); }
  }
  // 4. scenario type
  if (gold.scenarioType === candidate.scenarioType) { score += 1; signals.push("type"); }
  // 5. actor
  if (gold.actor && candidate.preconditions.some((p) => norm(p.statement).includes(norm(gold.actor ?? "")))) { score += 1; signals.push("actor"); }

  const matched = score >= 4 && signals.length >= 2 || score >= 5 || (score >= 3 && (signals.includes("rule") || signals.some((s) => s.startsWith("expected"))) && signals.length >= 2);
  return { matched, goldId: matched ? gold.id : undefined, score, signals };
}

export function matchCandidatesToGold(candidates: TestDesignCandidate[], gold: GoldScenario[]): Array<{ candidateId: string; matchedGold?: string; score: number }> {
  const results: Array<{ candidateId: string; matchedGold?: string; score: number }> = [];
  for (const c of candidates) {
    let best: ScenarioMatchResult = { matched: false, score: 0, signals: [] };
    for (const g of gold) {
      const m = matchCandidateToGold(c, g);
      if (m.score > best.score) best = m;
    }
    results.push({ candidateId: c.candidateId, matchedGold: best.matched ? best.goldId : undefined, score: best.score });
  }
  return results;
}

// ============ P11.52-55：Gold Coverage + AI Extra + Metrics ============

export type AiExtraCategory = "VALID_NEW_SCENARIO" | "DUPLICATE" | "UNSUPPORTED" | "LOW_VALUE" | "INVALID" | "NEEDS_REVIEW";

export function classifyAiExtra(candidate: TestDesignCandidate, goldMatched: boolean, unsupported: boolean): AiExtraCategory {
  if (unsupported) return "UNSUPPORTED";
  if (goldMatched) return "DUPLICATE";
  if (candidate.risk.designPriority === "LOW") return "LOW_VALUE";
  if (candidate.reviewStatus === "NEEDS_SECURITY_REVIEW") return "NEEDS_REVIEW";
  return "VALID_NEW_SCENARIO";
}

export interface TestDesignBenchmarkMetrics {
  criticalScenarioRecall: number;
  overallScenarioRecall: number;
  acCoverage: number;
  businessRuleCoverage: number;
  stateCoverage: number;
  dependencyCoverage: number;
  securityCoverage: number;
  boundaryCoverage: number;
  unsupportedScenarioRate: number;
  unsupportedExpectationRate: number;
  duplicateRate: number;
  invalidScenarioRate: number;
  validNewScenarioRate: number;
  averageCandidatesPerRequirement: number;
  explainableScenarioRecall: number;
  testDesignKnowledgeCeiling: number;
}

export function computeTestDesignMetrics(input: {
  gold: GoldRequirement[];
  candidatesByRequirement: Array<{ requirementId: string; candidates: TestDesignCandidate[] }>;
  obligationsByRequirement: Array<{ requirementId: string; obligations: TestCoverageObligation[] }>;
  groundIssues: number;
}): TestDesignBenchmarkMetrics & { perRequirement: Array<Record<string, unknown>> } {
  const perRequirement: Array<Record<string, unknown>> = [];
  let criticalHit = 0, criticalTotal = 0, totalHit = 0, totalGold = 0;
  let unsupportedScenarios = 0, totalCandidates = 0, duplicateCount = 0, invalidCount = 0, validNew = 0;
  let acCovered = 0, acTotal = 0, ruleCovered = 0, ruleTotal = 0, stateCovered = 0, stateTotal = 0, depCovered = 0, depTotal = 0, secCovered = 0, secTotal = 0, bndCovered = 0, bndTotal = 0;

  for (const g of input.gold) {
    const cand = input.candidatesByRequirement.find((c) => c.requirementId === g.id)?.candidates ?? [];
    const obls = input.obligationsByRequirement.find((o) => o.requirementId === g.id)?.obligations ?? [];
    // P11.55：gold 场景覆盖 = 存在任一 candidate 匹配（不依赖 best 分配，避免一 gold 被多个 candidate 抢占导致另一 gold 漏）
    const matchedGoldIds = new Set<string>();
    for (const gs of g.goldScenarios) {
      if (cand.some((c) => matchCandidateToGold(c, gs).matched)) matchedGoldIds.add(gs.id);
    }
    for (const gs of g.goldScenarios) {
      totalGold++;
      if (gs.criticality === "CRITICAL") criticalTotal++;
      if (matchedGoldIds.has(gs.id)) {
        totalHit++;
        if (gs.criticality === "CRITICAL") criticalHit++;
      }
    }
    // AI extra 分类
    for (const c of cand) {
      totalCandidates++;
      const matched = c.coveredObligationIds.length > 0 && g.goldScenarios.some((gs) => matchCandidateToGold(c, gs).matched);
      if (!matched) {
        const unsup = c.expectedOutcomes.some((e) => e.grounding.kind === "TESTING_TECHNIQUE");
        const cat = classifyAiExtra(c, false, unsup);
        if (cat === "UNSUPPORTED") unsupportedScenarios++;
        if (cat === "DUPLICATE") duplicateCount++;
        if (cat === "INVALID") invalidCount++;
        if (cat === "VALID_NEW_SCENARIO") validNew++;
      }
    }
    // coverage by obligation
    const covered = new Set<string>();
    for (const c of cand) for (const id of c.coveredObligationIds) covered.add(id);
    for (const o of obls) {
      const isCovered = covered.has(o.obligationId);
      if (o.type === "ACCEPTANCE_CRITERION") { acTotal++; if (isCovered) acCovered++; }
      if (o.type === "BUSINESS_RULE") { ruleTotal++; if (isCovered) ruleCovered++; }
      if (o.type === "STATE_TRANSITION") { stateTotal++; if (isCovered) stateCovered++; }
      if (o.type === "DEPENDENCY") { depTotal++; if (isCovered) depCovered++; }
      if (o.isSecurity) { secTotal++; if (isCovered) secCovered++; }
      if (o.type === "CONSTRAINT") { bndTotal++; if (isCovered) bndCovered++; }
    }
    perRequirement.push({ id: g.id, candidates: cand.length, goldScenarios: g.goldScenarios.length, matchedGold: matchedGoldIds.size });
  }

  const unsupportedRate = totalCandidates ? unsupportedScenarios / totalCandidates : 0;
  const duplicateRate = totalCandidates ? duplicateCount / totalCandidates : 0;
  const r = (a: number, b: number) => (b ? a / b : 1);
  return {
    criticalScenarioRecall: r(criticalHit, criticalTotal),
    overallScenarioRecall: r(totalHit, totalGold),
    acCoverage: r(acCovered, acTotal),
    businessRuleCoverage: r(ruleCovered, ruleTotal),
    stateCoverage: r(stateCovered, stateTotal),
    dependencyCoverage: r(depCovered, depTotal),
    securityCoverage: r(secCovered, secTotal),
    boundaryCoverage: r(bndCovered, bndTotal),
    unsupportedScenarioRate: unsupportedRate,
    unsupportedExpectationRate: totalCandidates ? input.groundIssues / totalCandidates : 0,
    duplicateRate,
    invalidScenarioRate: totalCandidates ? invalidCount / totalCandidates : 0,
    validNewScenarioRate: totalCandidates ? validNew / totalCandidates : 0,
    averageCandidatesPerRequirement: input.candidatesByRequirement.length ? totalCandidates / input.candidatesByRequirement.length : 0,
    explainableScenarioRecall: 0,
    testDesignKnowledgeCeiling: 0,
    perRequirement
  };
}

// ============ P11.87/88：Explainable Recall + Ceiling ============

export function explainableScenarioRecall(gold: GoldRequirement[], candidates: TestDesignCandidate[]): { explainableRecall: number; totalRecall: number; ceiling: number } {
  // explainable = gold scenario 有 rule/AC/state/dep 关键词（可被 obligation 表达）
  const explainable = gold.flatMap((g) => g.goldScenarios.filter((s) => s.source !== "HISTORICAL_BUG"));
  const all = gold.flatMap((g) => g.goldScenarios);
  const matchedIds = new Set<string>();
  for (const c of candidates) {
    for (const g of explainable) {
      if (matchCandidateToGold(c, g).matched) matchedIds.add(g.id);
    }
  }
  return {
    explainableRecall: explainable.length ? matchedIds.size / explainable.length : 1,
    totalRecall: all.length ? matchedIds.size / all.length : 1,
    ceiling: all.length ? explainable.length / all.length : 1
  };
}
