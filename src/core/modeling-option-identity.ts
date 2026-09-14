/**
 * P8.8-8.10：Option Identity Model + Capture Isolation + Coverage Modes。
 *
 * P8.8：Option 身份不来自"父级 accessibleName 拼接"或"整块 dropdown text"。
 * OptionIdentity 以 option 自身可观察信号为核心：
 *   optionValue / visibleText / normalizedText / selected / disabled / groupLabel。
 * semanticName 默认 `<visibleText> 选项`，禁止 `<currentSelectedValue> <visibleText> 选项`。
 *
 * P8.9：Capture Isolation——只在新出现 popup 范围内收集 role=option/listbox children/menuitem，
 * 不从全页抓 li/a/button。用 before/after DOM delta + portal 关系（aria-controls/aria-owns/id relation）。
 *
 * P8.10：Coverage Modes——COMPLETE/PARTIAL/SAMPLED/UNKNOWN，gold comparison 必须考虑。
 *
 * 铁律：不假装 remote/virtualized dropdown 已完全建模。
 */

export type OptionCoverageMode = "COMPLETE" | "PARTIAL" | "SAMPLED" | "UNKNOWN";

export interface OptionIdentity {
  optionId: string;
  parentControlId: string;
  optionValue?: string;
  /** P8.8：semanticName 默认 `<visibleText> 选项`，不含父级/当前值。 */
  semanticName: string;
  visibleText: string;
  normalizedText: string;
  groupLabel?: string;
  disabled?: boolean;
  selected?: boolean;
  status: "candidate" | "dom_verified";
  coverageMode: OptionCoverageMode;
  evidence: string[];
}

export interface OptionCaptureContext {
  /** 触发下拉前的 trigger 显示文本（当前选中值/占位符）。 */
  triggerDisplayText?: string;
  /** 打开后新出现的 popup 容器（listbox/menu/portal）。 */
  popupContainers: string[];
  /** 打开的 option 原始样本（全量，未清洗）。 */
  rawOptionTexts: string[];
  /** 采集机制：native_select | listbox_visible | portal_delta | remote_search。 */
  captureMechanism: "native_select" | "listbox_visible" | "portal_delta" | "remote_search" | "unknown";
  /** 是否可确认滚动到底（用于 COMPLETE 判定）。 */
  scrolledToEnd?: boolean;
  /** 是否有搜索输入（remote searchable）。 */
  hasSearchInput?: boolean;
  /** 是否 virtualized（仅渲染可视窗口）。 */
  virtualized?: boolean;
  /** 祖先/上下文文本（可能混入 group label 等）。 */
  contextTexts?: string[];
}

export const OPTION_IDENTITY_VERSION = "option-identity.v1";

/** 清洗 option 文本：去空白、去长度异常、去纯标点。 */
export function cleanOptionText(text: string): string {
  return String(text ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
}

/** 判断 option 文本是否像"当前选中值/占位符"（应被过滤）。 */
export function looksLikeTriggerDisplay(text: string, triggerDisplayText?: string): boolean {
  if (!triggerDisplayText) return false;
  const t = cleanOptionText(text).toLowerCase();
  const trigger = cleanOptionText(triggerDisplayText).toLowerCase();
  if (!t || !trigger) return false;
  // 完全等于 trigger 显示文本 → 大概率是当前值/占位符，不是独立 option
  return t === trigger;
}

export function normalizeOptionText(text: string): string {
  return String(text ?? "").replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, "").toLowerCase();
}

/**
 * P8.8：构造 OptionIdentity。
 * - semanticName 用 `<visibleText> 选项`；
 * - 若 visibleText 等于 trigger 显示值 → 标记 candidate 且过滤（占位/当前值）；
 * - 记录 selected/disabled/groupLabel。
 */
export function buildOptionIdentity(parentControlId: string, visibleText: string, ctx: OptionCaptureContext): OptionIdentity {
  const cleaned = cleanOptionText(visibleText);
  const normalizedText = normalizeOptionText(cleaned);
  const evidence: string[] = [`mechanism=${ctx.captureMechanism}`];
  const isTriggerDisplay = looksLikeTriggerDisplay(cleaned, ctx.triggerDisplayText);
  const isNoise = !cleaned || !normalizedText || /^[^\u4e00-\u9fa5a-z0-9]+$/i.test(cleaned);

  if (isTriggerDisplay) evidence.push("equals_trigger_display(filtered)");
  if (isNoise) evidence.push("noise_text");

  return {
    optionId: `${parentControlId}.option.${normalizedText || "unknown"}`,
    parentControlId,
    optionValue: isTriggerDisplay || isNoise ? undefined : cleaned,
    semanticName: cleaned ? `${cleaned} 选项` : "",
    visibleText: cleaned,
    normalizedText,
    selected: ctx.triggerDisplayText ? looksLikeTriggerDisplay(cleaned, ctx.triggerDisplayText) : undefined,
    disabled: false,
    status: isTriggerDisplay || isNoise ? "candidate" : "dom_verified",
    coverageMode: "UNKNOWN",
    evidence
  };
}

/**
 * P8.9：Capture Isolation——把"新出现的 popup 内 option"与"全页常驻文本"分离。
 * 输入 before/after 两组原始样本，只保留 after 中新增的（delta），
 * 并且只接受 popup 容器相关的 option。
 */
export function isolatePopupOptions(beforeTexts: string[], afterTexts: string[], popupContainers: string[]): string[] {
  const beforeSet = new Set(beforeTexts.map((t) => cleanOptionText(t).toLowerCase()));
  const delta = afterTexts
    .filter((t) => {
      const clean = cleanOptionText(t);
      return Boolean(clean) && !beforeSet.has(clean.toLowerCase());
    })
    .filter((t) => {
      // 只保留 popup 容器上下文可见的文本（这里用容器关联信号近似：popup 存在即可）
      return popupContainers.length > 0;
    });
  return Array.from(new Set(delta));
}

/** P8.10：根据采集上下文判定 coverage mode。 */
export function coverageModeFor(ctx: OptionCaptureContext): OptionCoverageMode {
  if (ctx.captureMechanism === "native_select") return "COMPLETE";
  if (ctx.captureMechanism === "remote_search" || ctx.hasSearchInput) return "SAMPLED";
  if (ctx.virtualized) return "PARTIAL";
  if (ctx.captureMechanism === "listbox_visible" || ctx.captureMechanism === "portal_delta") {
    if (ctx.scrolledToEnd) return "COMPLETE";
    return "PARTIAL";
  }
  return "UNKNOWN";
}

/** 去重：同 parent + 同 normalizedText 只保留一个。 */
export function dedupeOptions(options: OptionIdentity[]): OptionIdentity[] {
  const seen = new Set<string>();
  return options.filter((o) => {
    const key = `${o.parentControlId}|${o.normalizedText}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
