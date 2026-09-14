import type { ModelElementLike } from "./modeling-semantic-match.js";
import { isSiteNavNoise } from "./modeling-semantic-match.js";

/**
 * P7.3：Gold Projection——把成熟 Page Model 投影为 benchmark gold。
 *
 * 成熟模型可能有历史噪音/重复 option/旧 locator/无效 assertion/手写过度建模，
 * 不能无脑当 gold。投影过滤：
 *   - obsolete candidate（长期未验证）
 *   - stale locator-only noise
 *   - site-wide navigation noise
 *   - duplicate option
 *   - historical temporary elements（p4.* clickable 占位）
 *
 * 保留：
 *   - execution_verified / dom_verified / click_observed / execution_observed
 *   - 被 DSL 引用的模型项
 *   - verified assertion
 *   - confirmed states / dependencies
 *
 * 所有规则 deterministic + 可审计（输出每条过滤原因）。
 */

export interface GoldProjectionResult {
  goldElements: ModelElementLike[];
  goldOptions: ModelElementLike[];
  goldAssertions: Array<Record<string, unknown>>;
  goldStates: Array<Record<string, unknown>>;
  goldDependencies: Array<Record<string, unknown>>;
  filtered: Array<{ id: string; reason: string }>;
  kept: Array<{ id: string; reason: string }>;
}

/** P8.0：gold projection 版本标识（冻结/对比 baseline 用）。 */
export const GOLD_PROJECTION_VERSION = "gold-projection.v1";

/**
 * 断言是否属于本页面域。
 * 历史建模常把其他模块（transfer/withdraw 等）的 assertion 挂到流水页面上，
 * 这些对「本页面」benchmark 是噪音（VALID_BUT_NOT_GOLD）——gold projection 应过滤。
 * 判定：assertionId 前缀与页面 module 相关 或 语义名提到本页能力。
 */
function isPageScopedAssertion(assertionId: string, semanticName: string, pageId: string): boolean {
  const id = String(assertionId ?? "");
  const pageDomain = String(pageId ?? "").split(".").slice(2, 4).join("."); // e.g. spot_fund_flow
  if (id.includes(pageDomain)) return true;
  // 明确属于其他模块的断言 → 非本页 gold
  const otherModuleIds = ["t2_5.transfer", "t2.transfer", "c3.withdraw", "c4.withdraw", "c5.withdraw", "c2.withdraw", "t3.", "t4.", "t5."];
  if (otherModuleIds.some((prefix) => id.startsWith(prefix))) return false;
  // 语义名提到页面能力关键词 → 保留
  const name = String(semanticName ?? "");
  if (/流水|筛选|列表|空状态|现货|查询|重置|类型|币种|时间/.test(name)) return true;
  return true; // 默认保守保留
}

const VERIFIED_STATUSES = new Set(["execution_verified", "dom_verified", "click_observed", "execution_observed", "screenshot_verified"]);

function isNavNoise(name: string, id: string): boolean {
  return isSiteNavNoise({ semanticName: name, elementId: id });
}

function isTemporaryPlaceholder(id: string): boolean {
  return /^p4\.|clickable_\d+|\.modeling_candidate/.test(String(id ?? ""));
}

/** 元素是否被 DSL 引用（通过 verificationHistory / evidence 中 policyId 判断）。 */
function isDslReferenced(element: Record<string, unknown>): boolean {
  const history = element.verificationHistory as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(history) && history.length) return true;
  const evidence = element.evidence as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(evidence) && evidence.length) return true;
  return String(element.status ?? "") === "execution_verified";
}

/**
 * 从成熟 Page Model 投影 gold sets。
 * @param model Page Model（含 elements / assertions / blockedStates / dependencies）
 */
export function buildGoldModelProjection(model: Record<string, unknown>): GoldProjectionResult {
  const goldElements: ModelElementLike[] = [];
  const goldOptions: ModelElementLike[] = [];
  const goldAssertions: Array<Record<string, unknown>> = [];
  const goldStates: Array<Record<string, unknown>> = [];
  const goldDependencies: Array<Record<string, unknown>> = [];
  const filtered: Array<{ id: string; reason: string }> = [];
  const kept: Array<{ id: string; reason: string }> = [];
  const pageId = String(model.pageId ?? "");

  // ============ Elements / Options ============
  const elements = Array.isArray(model.elements) ? model.elements as Array<Record<string, unknown>> : [];
  const seenOptionValues = new Set<string>();
  for (const element of elements) {
    const id = String(element.elementId ?? "");
    const name = String(element.semanticName ?? "");
    const status = String(element.status ?? "");
    const controlType = String(element.controlType ?? "unknown");

    // 过滤临时占位（p4.* clickable）
    if (isTemporaryPlaceholder(id)) {
      filtered.push({ id, reason: "temporary_placeholder（p4.*/clickable 占位）" });
      continue;
    }
    // 过滤全站导航噪音
    if (isNavNoise(name, id)) {
      filtered.push({ id, reason: "site_nav_noise" });
      continue;
    }
    // 过滤未验证 + 未被 DSL 引用
    if (!VERIFIED_STATUSES.has(status) && !isDslReferenced(element)) {
      filtered.push({ id, reason: `unverified_not_dsl_referenced（status=${status || "none"}）` });
      continue;
    }

    // 重复 option 去重（同 parent + 同 optionValue）
    if (controlType === "dropdown_option") {
      const parent = String(element.parentElementId ?? "");
      const value = String(element.optionValue ?? "");
      const dedupeKey = `${parent}|${value.toLowerCase()}`;
      if (seenOptionValues.has(dedupeKey)) {
        filtered.push({ id, reason: "duplicate_option" });
        continue;
      }
      seenOptionValues.add(dedupeKey);
      goldOptions.push({
        elementId: id,
        semanticName: name,
        controlType,
        targetField: String(element.targetField ?? ""),
        optionValue: value,
        role: String(element.role ?? ""),
        parentElementId: parent,
        region: String(element.region ?? ""),
        locatorCandidates: Array.isArray(element.locatorCandidates) ? element.locatorCandidates as Array<{ value?: string; strategy?: string }> : []
      });
      kept.push({ id, reason: "verified_option" });
      continue;
    }

    goldElements.push({
      elementId: id,
      semanticName: name,
      controlType,
      targetField: String(element.targetField ?? ""),
      role: String(element.role ?? ""),
      tag: String(element.tag ?? ""),
      region: String(element.region ?? ""),
      parentElementId: String(element.parentElementId ?? ""),
      locatorCandidates: Array.isArray(element.locatorCandidates) ? element.locatorCandidates as Array<{ value?: string; strategy?: string }> : []
    });
    kept.push({ id, reason: `verified_element（status=${status}）` });
  }

  // ============ Assertions ============
  const assertions = Array.isArray(model.assertions) ? model.assertions as Array<Record<string, unknown>> : [];
  for (const assertion of assertions) {
    const id = String(assertion.assertionId ?? "");
    const status = String(assertion.status ?? "");
    // P7.3：跨模块历史 assertion（其他模块挂到本页）不计入本页 gold
    if (!isPageScopedAssertion(id, String(assertion.semanticName ?? ""), pageId)) {
      filtered.push({ id, reason: "cross_module_assertion（VALID_BUT_NOT_GOLD for this page）" });
      continue;
    }
    if (VERIFIED_STATUSES.has(status) || isDslReferenced(assertion)) {
      goldAssertions.push(assertion);
      kept.push({ id, reason: `verified_assertion（status=${status}）` });
    } else {
      filtered.push({ id, reason: `unverified_assertion（status=${status || "none"}）` });
    }
  }

  // ============ States（blockedStates / dialogs 等） ============
  const blockedStates = Array.isArray(model.blockedStates) ? model.blockedStates as Array<Record<string, unknown>> : [];
  for (const state of blockedStates) {
    const id = String(state.stateId ?? state.blockedStateId ?? "");
    const status = String(state.status ?? "dom_verified");
    if (VERIFIED_STATUSES.has(status)) {
      goldStates.push(state);
      kept.push({ id, reason: "verified_state" });
    } else {
      filtered.push({ id, reason: "unverified_state" });
    }
  }

  // ============ Dependencies ============
  const dependencies = Array.isArray(model.dependencies) ? model.dependencies as Array<Record<string, unknown>> : [];
  for (const dependency of dependencies) {
    const id = String(dependency.dependencyId ?? `${dependency.sourceElement ?? ""}→${dependency.target ?? ""}`);
    const status = String(dependency.status ?? "known");
    if (status === "verified" || status === "execution_verified" || VERIFIED_STATUSES.has(status)) {
      goldDependencies.push(dependency);
      kept.push({ id, reason: `verified_dependency（status=${status}）` });
    } else {
      filtered.push({ id, reason: `unverified_dependency（status=${status}）` });
    }
  }

  return { goldElements, goldOptions, goldAssertions, goldStates, goldDependencies, filtered, kept };
}
