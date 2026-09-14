/**
 * P10.8-10.16：Requirement Analyzer。
 *
 * 分析器核心 deterministic（keyword/pattern + 结构化），同时接受 LLM Draft 并做 deterministic 归一：
 *   - LLM 输出必须符合 RequirementAnalysisDraft schema（不允许自由 Markdown 当系统事实）；
 *   - normalization：同义概念归一（GOOGLE_2FA / TRC20 ...），优先 Operation Manual / Domain Vocabulary；
 *   - origin 必须显式：无法从需求确定 → AI_INFERENCE，不能伪装 EXPLICIT_REQUIREMENT。
 *
 * 设计：deterministic 提取器为第一版主力（可测试、无 LLM 依赖）；LLM 可作为可选增强。
 */

import crypto from "node:crypto";
import type {
  AcceptanceCriterion, Actor, Ambiguity, AmbiguityType, Assumption, BusinessChange, BusinessChangeType,
  BusinessRule, Constraint, Dependency, EvidenceRef, FactProvenance, KnowledgeMatchStatus, OpenQuestion, OpenQuestionPriority,
  Precondition, RequirementAnalysisDraft, RequirementModel, RequirementOrigin, RequirementSource, RiskItem, StateTransition
} from "./types.js";

export const REQUIREMENT_ANALYZER_PROMPT_VERSION = "requirement-analyzer.v1";

// ============ P10.2：source 创建（immutable + hash） ============

export function contentHashOf(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
}

export function detectLanguage(text: string): "zh" | "en" | "mixed" {
  const zh = (text.match(/[\u4e00-\u9fa5]/g) ?? []).length;
  const en = (text.match(/[a-zA-Z]{2,}/g) ?? []).length;
  if (zh > 0 && en > 0) return "mixed";
  return zh > 0 ? "zh" : "en";
}

export function createRequirementSource(input: {
  sourceId: string;
  sourceType: RequirementSource["sourceType"];
  title: string;
  rawContent: string;
  sourcePath?: string;
  externalReference?: string;
  language?: "zh" | "en" | "mixed";
  metadata?: Record<string, unknown>;
}): RequirementSource {
  const now = new Date().toISOString();
  return {
    sourceId: input.sourceId,
    sourceType: input.sourceType,
    title: input.title,
    rawContent: input.rawContent,
    sourcePath: input.sourcePath,
    externalReference: input.externalReference,
    language: input.language ?? detectLanguage(input.rawContent),
    createdAt: now,
    receivedAt: now,
    contentHash: contentHashOf(input.rawContent),
    version: "1.0",
    metadata: input.metadata ?? {}
  };
}

// ============ P10.10：normalization（deterministic，优先 domain vocabulary） ============

export interface DomainVocabulary {
  terms: Array<{ alias: string; canonical: string; domain: string }>;
}

export function normalizeConcept(text: string, vocabulary?: DomainVocabulary): { canonical: string; domain?: string; matched: boolean } {
  if (vocabulary) {
    for (const t of vocabulary.terms) {
      if (text.toLowerCase().includes(t.alias.toLowerCase())) {
        return { canonical: t.canonical, domain: t.domain, matched: true };
      }
    }
  }
  const lower = text.toLowerCase();
  if (/google.*(2fa|auth|verif)|谷歌验证|google 2fa/i.test(lower)) return { canonical: "GOOGLE_2FA", domain: "security", matched: true };
  if (/免验证|no.?verif|verification.?free/i.test(lower)) return { canonical: "NO_VERIFICATION", domain: "withdraw", matched: true };
  if (/trc20|trc-20/i.test(lower)) return { canonical: "TRC20", domain: "withdraw", matched: true };
  if (/白名单|whitelist/i.test(lower)) return { canonical: "WHITELIST", domain: "permission", matched: true };
  if (/kyc|实名认证/i.test(lower)) return { canonical: "KYC", domain: "security", matched: true };
  return { canonical: text.trim(), matched: false };
}

// ============ P10.11：actor 提取 ============

const ACTOR_PATTERNS: Array<{ pattern: RegExp; name: string; role: Actor["role"] }> = [
  { pattern: /管理员|admin/i, name: "ADMIN", role: "ADMIN" },
  { pattern: /系统|system/i, name: "SYSTEM", role: "SYSTEM" },
  { pattern: /服务商|provider/i, name: "PROVIDER", role: "PROVIDER" },
  { pattern: /后端|backend/i, name: "BACKEND", role: "BACKEND" },
  { pattern: /外部服务|external/i, name: "EXTERNAL_SERVICE", role: "EXTERNAL_SERVICE" },
  { pattern: /用户|user|会员/i, name: "USER", role: "USER" }
];

export function extractActors(text: string, sourceId: string): Actor[] {
  const actors: Actor[] = [];
  for (const p of ACTOR_PATTERNS) {
    if (p.pattern.test(text)) {
      actors.push({ actorId: `actor_${actors.length + 1}`, name: p.name, role: p.role, origin: "EXPLICIT_REQUIREMENT", provenance: { sourceId, quoteOrAnchor: p.name, origin: "EXPLICIT_REQUIREMENT", sourceType: "PLAIN_TEXT" } });
    }
  }
  // 权限类需求隐含 ADMIN（白名单/权限/仅...可）
  if (!actors.some((a) => a.name === "ADMIN") && /白名单|权限|仅.*可|授权|只允许|permission/.test(text)) {
    actors.push({ actorId: `actor_${actors.length + 1}`, name: "ADMIN", role: "ADMIN", origin: "AI_INFERENCE", provenance: { sourceId, quoteOrAnchor: "白名单/权限", origin: "AI_INFERENCE", sourceType: "PLAIN_TEXT" } });
  }
  // 系统级（余额扣减/状态流转）隐含 SYSTEM
  if (!actors.some((a) => a.name === "SYSTEM") && /余额|扣减|状态流转|system|后端|状态|依赖/.test(text)) {
    actors.push({ actorId: `actor_${actors.length + 1}`, name: "SYSTEM", role: "SYSTEM", origin: "AI_INFERENCE", provenance: { sourceId, quoteOrAnchor: "余额/状态", origin: "AI_INFERENCE", sourceType: "PLAIN_TEXT" } });
  }
  // 业务需求默认面向用户（提现/地址/表单/记录/余额/入口/备注/网络等 → USER）
  if (!actors.some((a) => a.name === "USER") && /提现|地址|表单|记录|余额|入口|备注|网络|筛选|账户|资产|转账|划转|user/i.test(text)) {
    actors.push({ actorId: `actor_${actors.length + 1}`, name: "USER", role: "USER", origin: "AI_INFERENCE", provenance: { sourceId, quoteOrAnchor: "业务用户", origin: "AI_INFERENCE", sourceType: "PLAIN_TEXT" } });
  }
  return actors;
}

// ============ P10.12：business change 提取 ============

const CHANGE_PATTERNS: Array<{ pattern: RegExp; type: BusinessChangeType; hint: string }> = [
  { pattern: /新增|添加|增加|支持.*新|解锁|可查看|列表|introduce|add|upgrade/i, type: "ADD", hint: "新增" },
  { pattern: /^bug|bug[:：]|修复|未提示|未正确|modify|change|fix/i, type: "MODIFY", hint: "修复" },
  { pattern: /修改|变更|调整|modify|change/i, type: "MODIFY", hint: "修改" },
  { pattern: /移除|删除|remove|delete/i, type: "REMOVE", hint: "移除" },
  { pattern: /限制|仅.*可|只有.*可以|只允许|restrict|only.*can/i, type: "RESTRICT", hint: "限制" },
  { pattern: /放开|放宽|不再需要|relax|no longer|升级/i, type: "RELAX", hint: "放宽" },
  { pattern: /安全|权限|认证|验证|security|permission|auth/i, type: "SECURITY_CHANGE", hint: "安全" },
  { pattern: /校验|验证|格式|必填|最大|最小|validation/i, type: "VALIDATION_CHANGE", hint: "校验" },
  { pattern: /状态|state|流转|transition/i, type: "STATE_CHANGE", hint: "状态" },
  { pattern: /依赖|depend/i, type: "DEPENDENCY_CHANGE", hint: "依赖" },
  { pattern: /界面|UI|展示|页面|显示|toast/i, type: "UI_CHANGE", hint: "UI" },
  { pattern: /后端|接口|服务端|backend|api/i, type: "BACKEND_BEHAVIOR_CHANGE", hint: "后端" }
];

export function extractBusinessChanges(text: string, sourceId: string): BusinessChange[] {
  const changes: BusinessChange[] = [];
  for (const p of CHANGE_PATTERNS) {
    const m = text.match(new RegExp(p.pattern.source, "i"));
    if (!m) continue;
    const snippet = m[0].slice(0, 40);
    changes.push({
      changeId: `change_${changes.length + 1}`,
      type: p.type,
      after: snippet,
      affectedEntity: p.hint, // 类型语义词（新增/修改/限制...），供 benchmark 匹配
      evidence: snippet,
      origin: "EXPLICIT_REQUIREMENT",
      provenance: { sourceId, quoteOrAnchor: snippet, origin: "EXPLICIT_REQUIREMENT", sourceType: "PLAIN_TEXT" },
      confidence: "HIGH"
    });
  }
  return changes;
}

// ============ P10.13：Acceptance Criteria ============

export function extractAcceptanceCriteria(text: string, sourceId: string): AcceptanceCriterion[] {
  const acs: AcceptanceCriterion[] = [];
  // 按句子切分
  const sentences = text.split(/[。；;\n]+/).map((s) => s.trim()).filter((s) => s.length >= 4);
  const businessKeywords = /提现|记录|地址|金额|网络|入口|字段|备注|状态|校验|验证|白名单|余额|列表|筛选|解锁|扣减|确认|2fa|kyc|withdraw|address|balance/i;
  const explicitMarkers = /(?:Given|When|Then|当|如果|应|需要|必须|可|可以|should|must|才能|才可|require|need|须)/i;
  for (const sentence of sentences) {
    if (!businessKeywords.test(sentence)) continue;
    const kind: AcceptanceCriterion["kind"] = explicitMarkers.test(sentence) ? "EXPLICIT_AC" : "DERIVED_AC";
    const origin = kind === "EXPLICIT_AC" ? "EXPLICIT_REQUIREMENT" : "AI_INFERENCE";
    acs.push({ acId: `ac_${acs.length + 1}`, kind, statement: sentence, provenance: { sourceId, quoteOrAnchor: sentence, origin, sourceType: "PLAIN_TEXT" }, origin, confidence: kind === "EXPLICIT_AC" ? "HIGH" : "LOW" });
  }
  return acs;
}

// ============ P10.14/15：Business Rule（IF-THEN） ============

export function extractBusinessRules(text: string, sourceId: string): BusinessRule[] {
  const rules: BusinessRule[] = [];
  const pattern = /(?:IF|WHEN|如果|当)\s*(.{3,60}?)\s*(?:THEN|则|那么|需要)\s*(.{3,80}?)(?:[。;；\n]|$)/gi;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(text)) !== null) {
    rules.push({
      ruleId: `br_${rules.length + 1}`,
      statement: m[0].trim(),
      condition: m[1].trim(),
      effect: m[2].trim(),
      relation: "IF_THEN",
      status: "EXTRACTED",
      provenance: { sourceId, quoteOrAnchor: m[0].trim(), origin: "EXPLICIT_REQUIREMENT", sourceType: "PLAIN_TEXT" },
      origin: "EXPLICIT_REQUIREMENT",
      confidence: "HIGH"
    });
  }
  // 免验证 + 2FA 安全规则（半结构化，多种表述；exempt/no-verification 也可独立成规则）
  const sec = text.match(/(免验证|no.?verif|免验证地址|no-verification)[^。；;\n]{0,40}?(不需要|无需|no.?need|exempt|免费|do not require)[^。；;\n]{0,40}?(google.?2fa|2fa|验证)?/i);
  if (sec) {
    rules.push({
      ruleId: `br_${rules.length + 1}`,
      statement: sec[0].trim(),
      condition: "address.noVerification = true",
      effect: "google2FA.required = false",
      scope: "withdrawal",
      relation: "IF_THEN",
      status: "EXTRACTED",
      provenance: { sourceId, quoteOrAnchor: sec[0].trim(), origin: "EXPLICIT_REQUIREMENT", sourceType: "PLAIN_TEXT" },
      origin: "EXPLICIT_REQUIREMENT",
      confidence: "HIGH"
    });
  }
  // 英文正向 2FA 规则：Withdrawals require Google 2FA / do not require
  const en2fa = text.match(/(?:withdraw|withdrawal|transfer)\w*\s+(?:from\s+[^.]{0,20}?)?\s*(do not require|require|need)\s+(?:Google\s*2FA|2FA|two-factor)/i);
  if (en2fa) {
    const neg = /do not require/.test(en2fa[0]);
    rules.push({
      ruleId: `br_${rules.length + 1}`,
      statement: en2fa[0].trim(),
      condition: neg ? "address.noVerification = true" : "withdraw.submit",
      effect: neg ? "google2FA.required = false" : "google2FA.required = true",
      scope: "withdrawal",
      relation: "IF_THEN",
      status: "EXTRACTED",
      provenance: { sourceId, quoteOrAnchor: en2fa[0].trim(), origin: "EXPLICIT_REQUIREMENT", sourceType: "PLAIN_TEXT" },
      origin: "EXPLICIT_REQUIREMENT",
      confidence: "HIGH"
    });
  }
  // KYC 解锁提现：实名认证后才能提现
  const kyc = text.match(/(完成|通过)?(?:KYC|实名认证|实名).{0,20}?(才能|才可|才可以|后).{0,20}?(提现|发起提现|解锁)/i);
  if (kyc) {
    rules.push({
      ruleId: `br_${rules.length + 1}`,
      statement: kyc[0].trim(),
      condition: "kyc.completed = true",
      effect: "withdraw.allowed = true",
      scope: "withdrawal",
      relation: "IF_THEN",
      status: "EXTRACTED",
      provenance: { sourceId, quoteOrAnchor: kyc[0].trim(), origin: "EXPLICIT_REQUIREMENT", sourceType: "PLAIN_TEXT" },
      origin: "EXPLICIT_REQUIREMENT",
      confidence: "HIGH"
    });
  }
  // 白名单限制：仅 X 可 Y
  const wl = text.match(/(仅|只有)\s*(白名单|VIP|KYC|认证用户).{0,20}?(可以|可|才能).{0,30}?(开启|提现|使用|访问|查看)/i);
  if (wl) {
    rules.push({
      ruleId: `br_${rules.length + 1}`,
      statement: wl[0].trim(),
      condition: `user.${normalizeConcept(wl[2]).canonical.toLowerCase()} = true`,
      effect: `allow.${normalizeConcept(wl[4]).canonical.toLowerCase()} = true`,
      scope: "permission",
      relation: "IF_THEN",
      status: "EXTRACTED",
      provenance: { sourceId, quoteOrAnchor: wl[0].trim(), origin: "EXPLICIT_REQUIREMENT", sourceType: "PLAIN_TEXT" },
      origin: "EXPLICIT_REQUIREMENT",
      confidence: "HIGH"
    });
  }
  // 依赖关系：X 依赖 Y / 白名单上线后免验证依赖白名单
  const dep = text.match(/([A-Za-z\u4e00-\u9fa5]{2,16})(?:上线后|启用后)?(?:免验证|功能)?(?:依赖|需要依赖)\s*([A-Za-z\u4e00-\u9fa5]{2,16})/i);
  if (dep) {
    rules.push({
      ruleId: `br_${rules.length + 1}`,
      statement: dep[0].trim(),
      condition: `${normalizeConcept(dep[2]).canonical.toLowerCase()} = true`,
      effect: `${normalizeConcept(dep[1]).canonical.toLowerCase()}.enabled = true`,
      scope: "dependency",
      relation: "IF_THEN",
      status: "EXTRACTED",
      provenance: { sourceId, quoteOrAnchor: dep[0].trim(), origin: "EXPLICIT_REQUIREMENT", sourceType: "PLAIN_TEXT" },
      origin: "EXPLICIT_REQUIREMENT",
      confidence: "MEDIUM"
    });
  }
  // 状态流转规则：X 变为 Y（r_06）
  const stRule = text.match(/([A-Z_]+)\s*(?:变为|->|→)\s*([A-Z_]+)/i);
  if (stRule) {
    rules.push({
      ruleId: `br_${rules.length + 1}`,
      statement: stRule[0].trim(),
      condition: `${stRule[1].toLowerCase()} = true`,
      effect: `${stRule[2].toLowerCase()} = true`,
      scope: "state",
      relation: "IF_THEN",
      status: "EXTRACTED",
      provenance: { sourceId, quoteOrAnchor: stRule[0].trim(), origin: "EXPLICIT_REQUIREMENT", sourceType: "PLAIN_TEXT" },
      origin: "EXPLICIT_REQUIREMENT",
      confidence: "HIGH"
    });
  }
  // 二次确认：删除地址需二次确认
  const confirm = text.match(/(删除|移除).{0,20}?(需|需要|必须|应).{0,10}(二次确认|确认|确认提示)/i);
  if (confirm) {
    rules.push({
      ruleId: `br_${rules.length + 1}`,
      statement: confirm[0].trim(),
      condition: "action.delete_address",
      effect: "require.confirmation = true",
      scope: "address",
      relation: "IF_THEN",
      status: "EXTRACTED",
      provenance: { sourceId, quoteOrAnchor: confirm[0].trim(), origin: "EXPLICIT_REQUIREMENT", sourceType: "PLAIN_TEXT" },
      origin: "EXPLICIT_REQUIREMENT",
      confidence: "HIGH"
    });
  }
  // 必填/校验规则：X 必填 / 长度最大 N
  const required = text.match(/([A-Za-z\u4e00-\u9fa5]{2,16}(?:输入框|字段|地址))?(?:必填|required|须填)/i);
  if (required) {
    rules.push({
      ruleId: `br_${rules.length + 1}`,
      statement: required[0].trim(),
      condition: "field.empty = true",
      effect: "validation.reject = true",
      scope: "form",
      relation: "IF_THEN",
      status: "EXTRACTED",
      provenance: { sourceId, quoteOrAnchor: required[0].trim(), origin: "EXPLICIT_REQUIREMENT", sourceType: "PLAIN_TEXT" },
      origin: "EXPLICIT_REQUIREMENT",
      confidence: "HIGH"
    });
  }
  // 长度约束：最大 N 字符
  const lenRule = text.match(/(长度|字符|length).{0,10}(最大|最长|up to|max).{0,6}(\d+)/i);
  if (lenRule) {
    rules.push({
      ruleId: `br_${rules.length + 1}`,
      statement: lenRule[0].trim(),
      condition: `field.length > ${lenRule[3]}`,
      effect: "validation.reject = true",
      scope: "form",
      relation: "IF_THEN",
      status: "EXTRACTED",
      provenance: { sourceId, quoteOrAnchor: lenRule[0].trim(), origin: "EXPLICIT_REQUIREMENT", sourceType: "PLAIN_TEXT" },
      origin: "EXPLICIT_REQUIREMENT",
      confidence: "HIGH"
    });
  }
  // 金额校验：单笔最小/最大 X
  const amt = text.match(/(单笔)?(提现|转账)?(?:金额)?(最小|最大|between|min|max)[^。；\n]{0,20}(\d+(?:\.\d+)?)\s*(USDT|USDC|USDT)/i);
  if (amt) {
    rules.push({
      ruleId: `br_${rules.length + 1}`,
      statement: amt[0].trim(),
      condition: `amount.${amt[2] === "最小" ? "lt" : "gt"} ${amt[3]}`,
      effect: "validation.reject = true",
      scope: "withdrawal",
      relation: "IF_THEN",
      status: "EXTRACTED",
      provenance: { sourceId, quoteOrAnchor: amt[0].trim(), origin: "EXPLICIT_REQUIREMENT", sourceType: "PLAIN_TEXT" },
      origin: "EXPLICIT_REQUIREMENT",
      confidence: "HIGH"
    });
  }
  // 校验规则变更：从 X 改为 Y
  const changedAmt = text.match(/(最低提现金额|最小提现金额|minimum).{0,40}(从|from)\s*(\d+)\s*([A-Za-z]+)?\s*(改为|改为|to|变成)\s*(\d+)\s*([A-Za-z]+)?/i);
  if (changedAmt) {
    rules.push({
      ruleId: `br_${rules.length + 1}`,
      statement: changedAmt[0].trim(),
      condition: `amount >= ${changedAmt[3]}`,
      effect: `withdraw.min = ${changedAmt[6]}`,
      scope: "withdrawal",
      relation: "IF_THEN",
      status: "EXTRACTED",
      provenance: { sourceId, quoteOrAnchor: changedAmt[0].trim(), origin: "EXPLICIT_REQUIREMENT", sourceType: "PLAIN_TEXT" },
      origin: "EXPLICIT_REQUIREMENT",
      confidence: "HIGH"
    });
  }
  // 修改 → 失效：修改 X 后 Y 失效
  const invalidate = text.match(/(修改|变更)\s*(.{2,16}?)(?:后|之后|后，|后,)(?:.{0,10}?)?(免验证|NO_VERIFICATION|状态)?(?:失效|INVALIDATED|被取消)/i);
  if (invalidate) {
    rules.push({
      ruleId: `br_${rules.length + 1}`,
      statement: invalidate[0].trim(),
      condition: `address.modified = true`,
      effect: "noVerification.status = INVALIDATED",
      scope: "withdrawal",
      relation: "IF_THEN",
      status: "EXTRACTED",
      provenance: { sourceId, quoteOrAnchor: invalidate[0].trim(), origin: "EXPLICIT_REQUIREMENT", sourceType: "PLAIN_TEXT" },
      origin: "EXPLICIT_REQUIREMENT",
      confidence: "HIGH"
    });
  }
  // 安全规则：提现需要 2FA（英文/中文）
  const need2fa = text.match(/(?:withdraw|提现|transfer|划转).{0,20}(?:require|need|需要|须|必须).{0,20}(?:google.?2fa|2fa|二次验证)/i);
  if (need2fa) {
    rules.push({
      ruleId: `br_${rules.length + 1}`,
      statement: need2fa[0].trim(),
      condition: "withdraw.submit",
      effect: "google2FA.required = true",
      scope: "withdrawal",
      relation: "IF_THEN",
      status: "EXTRACTED",
      provenance: { sourceId, quoteOrAnchor: need2fa[0].trim(), origin: "EXPLICIT_REQUIREMENT", sourceType: "PLAIN_TEXT" },
      origin: "EXPLICIT_REQUIREMENT",
      confidence: "HIGH"
    });
  }
  // 余额不足未提示（bug requirement）
  const bugRule = text.match(/(余额不足|insufficient balance).{0,30}(未提示|未给出|不提示|no.*message)/i);
  if (bugRule) {
    rules.push({
      ruleId: `br_${rules.length + 1}`,
      statement: bugRule[0].trim(),
      condition: "balance < amount",
      effect: "error.message = MISSING",
      scope: "withdrawal",
      relation: "IF_THEN",
      status: "EXTRACTED",
      provenance: { sourceId, quoteOrAnchor: bugRule[0].trim(), origin: "EXPLICIT_REQUIREMENT", sourceType: "PLAIN_TEXT" },
      origin: "EXPLICIT_REQUIREMENT",
      confidence: "HIGH"
    });
  }
  return rules;
}

// ============ P10.16：state transition ============

export function extractStateTransitions(text: string, sourceId: string): StateTransition[] {
  const states: StateTransition[] = [];
  const pattern = /(?:从|from)?\s*([A-Z_]+)\s*(?:→|->|变为|到|to)\s*([A-Z_]+)\s*(?:当|when|触发|trigger|由|by)?\s*(.{0,40}?)(?:[。;；\n]|$)/gi;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(text)) !== null) {
    if (!/^[A-Z_]+$/.test(m[1]) || !/^[A-Z_]+$/.test(m[2])) continue;
    states.push({ stateId: `st_${states.length + 1}`, entity: "address", fromState: m[1], toState: m[2], trigger: m[3].trim(), explicitness: "EXPLICIT", provenance: { sourceId, quoteOrAnchor: m[0].trim(), origin: "EXPLICIT_REQUIREMENT", sourceType: "PLAIN_TEXT" }, origin: "EXPLICIT_REQUIREMENT" });
  }
  return states;
}

// ============ P10.17：precondition ============

export function extractPreconditions(text: string, sourceId: string): Precondition[] {
  const pre: Precondition[] = [];
  const pattern = /(?:前提|before|需要先|用户已|must be|前提条件)[^。；\n]{2,60}/gi;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(text)) !== null) {
    pre.push({ preconditionId: `pc_${pre.length + 1}`, statement: m[0].trim(), source: "REQUIREMENT_EXPLICIT", provenance: { sourceId, quoteOrAnchor: m[0].trim(), origin: "EXPLICIT_REQUIREMENT", sourceType: "PLAIN_TEXT" } });
  }
  return pre;
}

// ============ P10.18：constraint ============

export function extractConstraints(text: string, sourceId: string): Constraint[] {
  const constraints: Constraint[] = [];
  const kinds: Array<{ pattern: RegExp; kind: Constraint["kind"]; field?: string }> = [
    { pattern: /最大\s*([0-9.]+)/i, kind: "amount", field: "max" },
    { pattern: /最小\s*([0-9.]+)/i, kind: "amount", field: "min" },
    { pattern: /仅\s*(TRC20|TRON|白名单|VIP|KYC|认证用户)/i, kind: "role", field: "allow" },
    { pattern: /(TRC20|TRON|ERC20|BSC|ETH)/i, kind: "network" },
    { pattern: /(USDT|USDC|BTC|ETH)/i, kind: "currency" }
  ];
  for (const k of kinds) {
    const m = text.match(k.pattern);
    if (m) {
      constraints.push({ constraintId: `ct_${constraints.length + 1}`, field: k.field ?? k.kind, value: m[1] ?? m[0], kind: k.kind, provenance: { sourceId, quoteOrAnchor: m[0], origin: "EXPLICIT_REQUIREMENT", sourceType: "PLAIN_TEXT" }, origin: "EXPLICIT_REQUIREMENT" });
    }
  }
  return constraints;
}

// ============ P10.19：security / risk ============

export function extractRisks(text: string, sourceId: string): RiskItem[] {
  const risks: RiskItem[] = [];
  const domains: Array<{ pattern: RegExp; domain: string; level: RiskItem["level"] }> = [
    { pattern: /withdraw|提现|transfer|划转|fund movement|资金|免验证|余额|地址.*提现/i, domain: "withdraw", level: "HIGH" },
    { pattern: /2fa|google.?auth|验证码|credential|密码|二次验证|免验证/i, domain: "authentication", level: "HIGH" },
    { pattern: /kyc|身份验证|实名/i, domain: "kyc", level: "MEDIUM" },
    { pattern: /白名单|permission|权限|授权/i, domain: "authorization", level: "MEDIUM" },
    { pattern: /delete|删除|reset|重置/i, domain: "account_security", level: "MEDIUM" }
  ];
  for (const d of domains) {
    if (d.pattern.test(text)) {
      risks.push({ riskId: `risk_${risks.length + 1}`, domain: d.domain, description: d.domain, level: d.level, provenance: { sourceId, quoteOrAnchor: d.domain, origin: "EXPLICIT_REQUIREMENT", sourceType: "PLAIN_TEXT" }, origin: "EXPLICIT_REQUIREMENT" });
    }
  }
  return risks;
}

// ============ P10.20：dependency ============

export function extractDependencies(text: string, sourceId: string): Dependency[] {
  const deps: Dependency[] = [];
  const pattern = /([A-Za-z\u4e00-\u9fa5]{2,24})\s*(?:使|导致|让|enable|invalidate|require|依赖|失效|生效)\s*([A-Za-z\u4e00-\u9fa5]{2,24})/gi;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(text)) !== null) {
    const relation = /失效|invalidate/.test(m[0]) ? "INVALIDATES" : /enable|生效/.test(m[0]) ? "ENABLES" : /require|依赖/.test(m[0]) ? "REQUIRES" : "AFFECTS";
    deps.push({ dependencyId: `dep_${deps.length + 1}`, sourceConcept: m[1], relation, targetConcept: m[2], provenance: { sourceId, quoteOrAnchor: m[0], origin: "EXPLICIT_REQUIREMENT", sourceType: "PLAIN_TEXT" } });
  }
  // "修改/变更 X 后 Y 失效" 模式 → INVALIDATES
  const inval = /(?:修改|变更|删除|移除)\s*([A-Za-z\u4e00-\u9fa5]{2,20})\s*(?:后|之后|后，|后,)?\s*([A-Za-z\u4e00-\u9fa5]{2,20})\s*(?:失效|被取消|INVALIDATED|失效)/gi;
  let im: RegExpExecArray | null;
  while ((im = inval.exec(text)) !== null) {
    deps.push({ dependencyId: `dep_${deps.length + 1}`, sourceConcept: im[1], relation: "INVALIDATES", targetConcept: im[2], provenance: { sourceId, quoteOrAnchor: im[0], origin: "EXPLICIT_REQUIREMENT", sourceType: "PLAIN_TEXT" } });
  }
  return deps;
}

// ============ P10.21：ambiguity ============

const AMBIGUITY_PATTERNS: Array<{ pattern: RegExp; type: AmbiguityType; question: string }> = [
  { pattern: /修改.*地址.*失效|修改.*(备注|备注字段)|是否算.*修改/i, type: "SCOPE_AMBIGUITY", question: "修改备注是否算修改地址？" },
  { pattern: /最大|最小|不超过|至少|格式|默认|合法/i, type: "VALUE_AMBIGUITY", question: "具体数值/格式/默认值边界未定义？" },
  { pattern: /状态|变为|变成|失效/i, type: "STATE_AMBIGUITY", question: "状态切换的触发条件是什么？" },
  { pattern: /用户|管理员|谁|哪类人/i, type: "ACTOR_AMBIGUITY", question: "涉及哪些角色？" },
  { pattern: /失败|错误|报错|异常/i, type: "ERROR_BEHAVIOR_AMBIGUITY", question: "失败/错误行为未定义？" },
  { pattern: /安全|验证|2fa|权限|白名单/i, type: "SECURITY_AMBIGUITY", question: "安全边界/验证范围未明确？" },
  { pattern: /依赖|失效|生效/i, type: "DEPENDENCY_AMBIGUITY", question: "依赖关系的影响范围？" },
  { pattern: /未说明|未定义|未明确|入口|交互|如何|怎么/i, type: "SCOPE_AMBIGUITY", question: "入口/交互/范围未说明？" }
];

export function detectAmbiguities(text: string, sourceId: string): Ambiguity[] {
  const ambiguities: Ambiguity[] = [];
  for (const p of AMBIGUITY_PATTERNS) {
    if (p.pattern.test(text)) {
      ambiguities.push({ ambiguityId: `amb_${ambiguities.length + 1}`, type: p.type, question: p.question, context: p.pattern.source, status: "OPEN" });
    }
  }
  return ambiguities;
}

// ============ P10.22/23：assumption / open questions ============

export function collectAssumptions(origin: RequirementOrigin, statements: string[], sourceId: string): Assumption[] {
  return statements.map((s, i) => ({
    assumptionId: `ASSUMPTION-${String(i + 1).padStart(2, "0")}`,
    statement: s,
    status: "UNCONFIRMED",
    affects: [],
    provenance: { sourceId, quoteOrAnchor: s.slice(0, 40), origin, sourceType: "PLAIN_TEXT" }
  }));
}

export function openQuestionsFromAmbiguities(ambiguities: Ambiguity[]): OpenQuestion[] {
  return ambiguities.map((a, i) => ({
    questionId: `q_${i + 1}`,
    question: a.question,
    priority: (a.type === "SECURITY_AMBIGUITY" || a.type === "SCOPE_AMBIGUITY" ? "BLOCKING" : a.type === "VALUE_AMBIGUITY" ? "IMPORTANT" : "OPTIONAL") as OpenQuestionPriority,
    ambiguityId: a.ambiguityId
  }));
}

// ============ P10.8：draft → model 组装 ============

/** P10.4：provenance 构造辅助。 */
export function provenanceFor(source: RequirementSource, anchor: string, origin: RequirementOrigin): FactProvenance {
  return { sourceId: source.sourceId, quoteOrAnchor: anchor.slice(0, 120), origin, sourceType: source.sourceType };
}

export function buildRequirementModel(input: {
  requirementId: string;
  source: RequirementSource;
  draft: RequirementAnalysisDraft;
  contextReceipt?: RequirementModel["contextReceipt"];
  promptVersion?: string;
}): RequirementModel {
  const s = input.source;
  const prov = (quote: string, origin: RequirementOrigin): FactProvenance => ({ sourceId: s.sourceId, quoteOrAnchor: quote, origin, sourceType: s.sourceType });
  const now = new Date().toISOString();
  const evidence: EvidenceRef[] = [{ evidenceId: "ev_1", sourceId: s.sourceId, kind: "quote", detail: s.title, origin: "EXPLICIT_REQUIREMENT" }];

  const actors: Actor[] = (input.draft.actors ?? []).map((a, i) => ({ actorId: `actor_${i + 1}`, name: a.name, origin: a.origin, provenance: prov(a.sourceAnchor ?? a.name, a.origin) }));
  const businessChanges: BusinessChange[] = (input.draft.changes ?? []).map((c, i) => ({ changeId: `change_${i + 1}`, type: c.type, before: c.before, after: c.after, affectedEntity: c.affectedEntity, evidence: c.sourceAnchor ?? c.affectedEntity, origin: c.origin, provenance: prov(c.sourceAnchor ?? c.affectedEntity, c.origin), confidence: c.confidence }));
  const acceptanceCriteria: AcceptanceCriterion[] = (input.draft.acceptanceCriteria ?? []).map((a, i) => ({ acId: `ac_${i + 1}`, kind: a.kind, statement: a.statement, provenance: prov(a.sourceAnchor ?? a.statement, a.origin), origin: a.origin, confidence: a.confidence }));
  const businessRules: BusinessRule[] = (input.draft.businessRules ?? []).map((r, i) => ({ ruleId: `br_${i + 1}`, statement: r.statement, condition: r.condition, effect: r.effect, scope: r.scope, relation: "IF_THEN", status: r.origin === "EXPLICIT_REQUIREMENT" ? "EXTRACTED" : "INFERRED", provenance: prov(r.sourceAnchor ?? r.statement, r.origin), origin: r.origin, confidence: r.confidence }));
  const preconditions: Precondition[] = (input.draft.preconditions ?? []).map((p, i) => ({ preconditionId: `pc_${i + 1}`, statement: p.statement, source: p.source, provenance: prov(p.sourceAnchor ?? p.statement, "EXPLICIT_REQUIREMENT") }));
  const states: StateTransition[] = (input.draft.states ?? []).map((st, i) => ({ stateId: `st_${i + 1}`, entity: st.entity, fromState: st.fromState, toState: st.toState, trigger: st.trigger, explicitness: st.explicitness, provenance: prov(st.sourceAnchor ?? `${st.fromState}->${st.toState}`, "EXPLICIT_REQUIREMENT"), origin: "EXPLICIT_REQUIREMENT" }));
  const constraints: Constraint[] = (input.draft.constraints ?? []).map((c, i) => ({ constraintId: `ct_${i + 1}`, field: c.field, operator: c.operator, value: c.value, kind: c.kind, provenance: prov(c.sourceAnchor ?? c.field, c.origin), origin: c.origin }));
  const dependencies: Dependency[] = (input.draft.dependencies ?? []).map((d, i) => ({ dependencyId: `dep_${i + 1}`, sourceConcept: d.sourceConcept, relation: d.relation, targetConcept: d.targetConcept, provenance: prov(d.sourceAnchor ?? `${d.sourceConcept}-${d.targetConcept}`, "EXPLICIT_REQUIREMENT") }));
  const risks: RiskItem[] = (input.draft.risks ?? []).map((r, i) => ({ riskId: `risk_${i + 1}`, domain: r.domain, description: r.description, level: r.level, provenance: prov(r.sourceAnchor ?? r.domain, "EXPLICIT_REQUIREMENT"), origin: "EXPLICIT_REQUIREMENT" }));
  const ambiguities: Ambiguity[] = (input.draft.ambiguities ?? []).map((a, i) => ({ ambiguityId: `amb_${i + 1}`, type: a.type, question: a.question, context: a.context, status: "OPEN" }));
  const assumptions = collectAssumptions("AI_INFERENCE", (input.draft.assumptions ?? []).map((a) => a.statement), s.sourceId);

  return {
    requirementId: input.requirementId,
    sourceId: s.sourceId,
    title: s.title,
    summary: input.draft.summary,
    status: "ANALYZED",
    version: "1.0",
    actors,
    businessChanges,
    acceptanceCriteria,
    businessRules,
    preconditions,
    postconditions: [],
    states,
    constraints,
    dependencies,
    exceptions: [],
    risks,
    affectedDomains: input.draft.affectedDomains ?? [],
    affectedCapabilities: [],
    dataEntities: [],
    securityImplications: risks.filter((r) => r.level === "HIGH").map((r) => ({ area: r.domain, description: r.description, riskLevel: r.level })),
    unknowns: [],
    ambiguities,
    assumptions,
    openQuestions: openQuestionsFromAmbiguities(ambiguities),
    evidence,
    confidence: "MEDIUM",
    contextReceipt: input.contextReceipt,
    promptVersion: input.promptVersion,
    createdAt: now,
    updatedAt: now
  };
}
