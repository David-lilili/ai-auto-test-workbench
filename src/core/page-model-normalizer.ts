import type { PageModelIndexes } from "./page-model-index.js";

/**
 * Page Model Semantic Normalization（P4-A2/A3/A4）：
 * ControlType Resolver + Dropdown 父子关系 + Normalized View。
 *
 * 原则：
 * - 只读派生：原始 Page Model 是唯一事实源，本模块输出 normalized view
 *   供 P2 Coverage / P3 Matcher / Planner 消费，不写回 store；
 * - 只补标 unknown：已有非 unknown controlType 一律不覆盖；
 * - 确定性：无 LLM；ambiguous 保持 UNKNOWN 不强猜；
 * - confidence 分级：HIGH（tag/role 强证据）/ MEDIUM（多条弱证据一致）/
 *   LOW（单条文本推断）/ UNRESOLVED。LOW 不驱动自动 exploration。
 */

export type ResolutionConfidence = "HIGH_CONFIDENCE" | "MEDIUM_CONFIDENCE" | "LOW_CONFIDENCE" | "UNRESOLVED";

export interface ControlTypeResolution {
  resolvedType: string;
  confidence: ResolutionConfidence;
  evidence: string[];
  reason: string;
  source: "existing" | "tag" | "role" | "component" | "locator" | "elementId_pattern" | "semanticName_pattern";
}

export interface NormalizedElement {
  elementId: string;
  semanticName: string;
  controlType: string;
  /** 归一化后的控件类型（unknown 时为 resolver 结果，仍无法判定则 unknown）。 */
  normalizedControlType: string;
  resolution?: ControlTypeResolution;
  /** dropdown option 的父控件归属（P4-A3）。 */
  parentControlId?: string;
  optionOf?: string;
  /** 该元素是否应作为 interaction target（option 归父后自身不再是独立 target）。 */
  interactionTarget: boolean;
}

export interface NormalizedPageModelView {
  pageId: string;
  elements: NormalizedElement[];
  /** 聚合后的交互控件（option 已折叠进父控件）。 */
  interactionTargets: NormalizedElement[];
  /** option → parent 关系表。 */
  optionRelations: Array<{ optionElementId: string; parentControlId: string; confidence: ResolutionConfidence; evidence: string }>;
}

/** P4-A2：ControlType Resolver（七级优先，纯结构证据）。 */
export function resolveControlType(element: Record<string, unknown>, context?: { siblingElementIds?: string[] }): ControlTypeResolution {
  // 1. 显式已有 controlType（非 unknown 直接信任）
  const existing = String(element.controlType ?? "");
  if (existing && existing !== "unknown") {
    return { resolvedType: existing, confidence: "HIGH_CONFIDENCE", evidence: [`controlType=${existing}`], reason: "已有显式 controlType", source: "existing" };
  }

  const evidence: string[] = [];

  // 2. HTML tag（元素记录的 tag 或 locator 里的 tag 信号）
  const tag = String(element.tag ?? "").toLowerCase();
  // 3. ARIA role
  const role = String(element.role ?? "").toLowerCase();

  if (role === "option") {
    evidence.push("role=option");
    return { resolvedType: "dropdown_option", confidence: "HIGH_CONFIDENCE", evidence, reason: "ARIA role=option", source: "role" };
  }
  if (role === "combobox" || role === "listbox") {
    evidence.push(`role=${role}`);
    return { resolvedType: "select", confidence: "HIGH_CONFIDENCE", evidence, reason: `ARIA role=${role}`, source: "role" };
  }
  if (role === "textbox" || role === "spinbutton") {
    evidence.push(`role=${role}`);
    return { resolvedType: role === "spinbutton" ? "number_input" : "input", confidence: "HIGH_CONFIDENCE", evidence, reason: `ARIA role=${role}`, source: "role" };
  }
  if (role === "tab") {
    evidence.push("role=tab");
    return { resolvedType: "tab", confidence: "HIGH_CONFIDENCE", evidence, reason: "ARIA role=tab", source: "role" };
  }
  if (role === "button") {
    evidence.push("role=button");
    return { resolvedType: "button", confidence: "HIGH_CONFIDENCE", evidence, reason: "ARIA role=button", source: "role" };
  }
  if (role === "link") {
    // 反误判：role=link 严格判 link——语义名含按钮不得升级（视觉按钮可能是 a 标签但交互是导航）
    evidence.push("role=link");
    return { resolvedType: "link", confidence: "HIGH_CONFIDENCE", evidence, reason: "ARIA role=link（语义名不改变 role 判定）", source: "role" };
  }

  if (tag === "input" || tag === "textarea") {
    evidence.push(`tag=${tag}`);
    return { resolvedType: "input", confidence: "HIGH_CONFIDENCE", evidence, reason: `HTML tag=${tag}`, source: "tag" };
  }
  if (tag === "select") {
    evidence.push("tag=select");
    return { resolvedType: "select", confidence: "HIGH_CONFIDENCE", evidence, reason: "HTML tag=select", source: "tag" };
  }
  if (tag === "button") {
    evidence.push("tag=button");
    return { resolvedType: "button", confidence: "HIGH_CONFIDENCE", evidence, reason: "HTML tag=button", source: "tag" };
  }

  // 4. component metadata
  const component = element.component as Record<string, unknown> | undefined;
  if (component?.type) {
    const componentType = String(component.type);
    evidence.push(`component.type=${componentType}`);
    return { resolvedType: componentType, confidence: "HIGH_CONFIDENCE", evidence, reason: "Page Model component metadata", source: "component" };
  }
  if (component?.optionDiscoveryMode || component?.popupScope) {
    evidence.push("component.optionDiscoveryMode/popupScope 存在");
    return { resolvedType: "select", confidence: "HIGH_CONFIDENCE", evidence, reason: "组件元数据含下拉特征", source: "component" };
  }

  // 5. locator 策略信号
  const locators = Array.isArray(element.locatorCandidates) ? element.locatorCandidates as Array<Record<string, unknown>> : [];
  for (const locator of locators) {
    const value = String(locator.value ?? "");
    const strategy = String(locator.strategy ?? "");
    if (strategy === "placeholder" || /placeholder=/i.test(value)) {
      evidence.push(`locator.placeholder=${value.slice(0, 30)}`);
      return { resolvedType: "input", confidence: "MEDIUM_CONFIDENCE", evidence, reason: "placeholder locator 指向输入框", source: "locator" };
    }
    if (/\[role='?option'?\]/i.test(value) || /option/i.test(strategy)) {
      evidence.push("locator 命中 option");
      return { resolvedType: "dropdown_option", confidence: "MEDIUM_CONFIDENCE", evidence, reason: "locator 含 option 特征", source: "locator" };
    }
  }

  // 6. elementId pattern（与 7 semanticName 联合取 MEDIUM/LOW）
  const elementId = String(element.elementId ?? "");
  const semanticName = String(element.semanticName ?? "");
  const idSignals: string[] = [];
  const nameSignals: string[] = [];
  if (/option/i.test(elementId)) idSignals.push("elementId 含 option");
  if (/input|_field/i.test(elementId)) idSignals.push("elementId 含 input/field");
  if (/selector|dropdown|_filter$/i.test(elementId)) idSignals.push("elementId 含 selector/filter");
  if (/tab/i.test(elementId)) idSignals.push("elementId 含 tab");
  if (/btn|button/i.test(elementId)) idSignals.push("elementId 含 btn");

  // 反误判：text/label 语义不含输入信号时不得判 input（P4-A6）
  const looksLikeNonInteractive = /文本|标题|说明|提示|label|title/i.test(semanticName) && !/输入|input/i.test(semanticName);
  if (looksLikeNonInteractive) {
    evidence.push(`semanticName=${semanticName.slice(0, 20)} 呈非交互特征`);
    return { resolvedType: "text", confidence: "MEDIUM_CONFIDENCE", evidence, reason: "语义名为纯文本类", source: "semanticName_pattern" };
  }

  if (/输入|input/i.test(semanticName)) nameSignals.push("semanticName 含输入");
  if (/下拉|筛选|选择器|dropdown/i.test(semanticName)) nameSignals.push("semanticName 含下拉/筛选");
  if (/按钮|button/i.test(semanticName)) nameSignals.push("semanticName 含按钮");
  if (/tab|标签页/i.test(semanticName)) nameSignals.push("semanticName 含 tab");

  const totalSignals = [...idSignals, ...nameSignals];
  if (totalSignals.length >= 2) {
    // 多条弱证据一致（P4-A7 MEDIUM）
    evidence.push(...totalSignals);
    const type = nameSignals.some(s => s.includes("输入")) || idSignals.some(s => s.includes("input"))
      ? "input"
      : nameSignals.some(s => s.includes("下拉")) || idSignals.some(s => s.includes("selector"))
        ? "select"
        : nameSignals.some(s => s.includes("tab")) || idSignals.some(s => s.includes("tab"))
          ? "tab"
          : "button";
    return { resolvedType: type, confidence: "MEDIUM_CONFIDENCE", evidence, reason: `${totalSignals.length} 条弱证据一致`, source: idSignals.length ? "elementId_pattern" : "semanticName_pattern" };
  }
  if (totalSignals.length === 1) {
    // 单条文本推断（LOW——不驱动自动 exploration）
    evidence.push(totalSignals[0]);
    const type = totalSignals[0].includes("输入") || totalSignals[0].includes("input")
      ? "input" : totalSignals[0].includes("下拉") || totalSignals[0].includes("selector")
        ? "select" : totalSignals[0].includes("tab") ? "tab" : "button";
    return { resolvedType: type, confidence: "LOW_CONFIDENCE", evidence, reason: "单条文本推断", source: "semanticName_pattern" };
  }

  return { resolvedType: "unknown", confidence: "UNRESOLVED", evidence: evidence.length ? evidence : ["无结构性证据"], reason: "证据不足，保持 unknown", source: "semanticName_pattern" };
}

/** P4-A3：dropdown option → parent 关联。 */
export function resolveOptionParent(
  option: Record<string, unknown>,
  pageElements: Array<Record<string, unknown>>
): { parentControlId?: string; confidence: ResolutionConfidence; evidence: string } {
  const optionId = String(option.elementId ?? "");

  // 策略 1：elementId 前缀共享（c2.withdraw.network_bsc_option → c2.withdraw.network_selector）
  const prefix = optionId.split(".").slice(0, -1).join(".");
  const prefixSibling = pageElements.find((element) => {
    const elementId = String(element.elementId ?? "");
    return elementId !== optionId && elementId.startsWith(`${prefix}.`) && /selector|dropdown|filter/i.test(elementId);
  });
  if (prefixSibling) {
    return {
      parentControlId: String(prefixSibling.elementId),
      confidence: "HIGH_CONFIDENCE",
      evidence: `同前缀 ${prefix}.* 且父含 selector/dropdown 命名`
    };
  }

  // 策略 2：任意 selector/dropdown 同页元素（唯一时）
  const selectors = pageElements.filter((element) => /selector|dropdown|_filter$/i.test(String(element.elementId ?? "")));
  if (selectors.length === 1) {
    return {
      parentControlId: String(selectors[0].elementId),
      confidence: "MEDIUM_CONFIDENCE",
      evidence: `页面唯一 selector 类控件 ${selectors[0].elementId}`
    };
  }

  // 策略 3：semanticName 语义匹配（如"BSC 选项"→"网络选择"）
  const optionName = String(option.semanticName ?? "");
  const nameMatch = pageElements.find((element) => {
    const elementId = String(element.elementId ?? "");
    return elementId !== optionId && /selector|dropdown/i.test(elementId) && optionName.includes(String(element.semanticName ?? "").slice(0, 2));
  });
  if (nameMatch) {
    return {
      parentControlId: String(nameMatch.elementId),
      confidence: "MEDIUM_CONFIDENCE",
      evidence: `语义名与 ${nameMatch.elementId} 关联`
    };
  }

  return { parentControlId: undefined, confidence: "UNRESOLVED", evidence: "无父控件关联证据" };
}

/** P4-A4：Normalized View 构建（只读派生，原始 store 不变）。 */
export function buildNormalizedPageModelView(pageModel: Record<string, unknown>): NormalizedPageModelView {
  const elements = (Array.isArray(pageModel.elements) ? pageModel.elements : []) as Array<Record<string, unknown>>;
  const normalized: NormalizedElement[] = elements.map((element) => {
    const resolution = resolveControlType(element);
    const isOption = resolution.resolvedType === "dropdown_option";
    return {
      elementId: String(element.elementId ?? ""),
      semanticName: String(element.semanticName ?? ""),
      controlType: String(element.controlType ?? "unknown"),
      normalizedControlType: resolution.resolvedType,
      resolution,
      interactionTarget: !isOption
    };
  });

  // option → parent 关联
  const optionRelations: NormalizedPageModelView["optionRelations"] = [];
  for (const element of elements) {
    const resolution = resolveControlType(element);
    if (resolution.resolvedType !== "dropdown_option") continue;
    const parent = resolveOptionParent(element, elements);
    if (parent.parentControlId) {
      const normalizedOption = normalized.find((item) => item.elementId === String(element.elementId));
      if (normalizedOption) {
        normalizedOption.parentControlId = parent.parentControlId;
        normalizedOption.optionOf = parent.parentControlId;
      }
      optionRelations.push({
        optionElementId: String(element.elementId),
        parentControlId: parent.parentControlId,
        confidence: parent.confidence,
        evidence: parent.evidence
      });
    }
  }

  const interactionTargets = normalized.filter((item) => item.interactionTarget);
  return {
    pageId: String(pageModel.pageId ?? ""),
    elements: normalized,
    interactionTargets,
    optionRelations
  };
}
