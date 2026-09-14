import type { InventorySummary } from "../capture/types.js";
import { isSiteNavNoise } from "./modeling-semantic-match.js";
import { classifyPageRegion, isRegionAllowedForAssertion, type RegionInput } from "./modeling-page-region.js";
import { tagAssertionPurposeWithRegion, dedupeAssertions, type AssertionPurpose } from "./modeling-assertion-quality.js";

/**
 * P6.2-3/4/6：Assertion Candidate Scanner + Result Region Detection。
 *
 * 职责：从 bootstrap 采集到的客观页面结构（inventory + visible text）生成
 *   - result region（table/list/emptyState/pagination）
 *   - assertion candidates（映射到 canonical UserAssertionKind）
 *
 * 铁律：
 *   - 只从客观 DOM 结构生成，不推断业务正确性；
 *   - 不生成复杂业务断言（金额等于多少/某规则必然成立/资金变化/KYC 语义）；
 *   - 分类复用 canonical assertion kind（user-assertion-parser 的 taxonomy），不造第二套；
 *   - 无法稳定分类 → 保持 candidate/REVIEW，不硬猜；
 *   - 状态上限 dom_verified（结构明确观察到），绝不写 execution_verified。
 */

export type ResultRegionType = "table" | "list" | "empty_state" | "unknown";

export interface ResultRegion {
  resultRegionId: string;
  type: ResultRegionType;
  columns: string[];
  rowLocator?: string;
  rowCount: number;
  emptyState?: string[];
  pagination?: string[];
  evidence: string[];
}

export interface AssertionCandidate {
  assertionKind: string;
  semanticName: string;
  expectedTexts: string[];
  status: "dom_verified" | "candidate";
  confidence: number;
  source: string;
  evidence: string[];
  /** 对应 canonical UserAssertionKind（用于 DSL materialization）。 */
  canonicalKind: string;
  /** P8.4：断言目的（RESULT_EXISTENCE/EMPTY_STATE/CONTROL_STATE/...）。 */
  purpose?: AssertionPurpose;
  /** P8.2/P8.3：候选来源页面区域（用于门禁与审计）。 */
  regionType?: string;
}

export interface StructureScanResult {
  resultRegions: ResultRegion[];
  assertionCandidates: AssertionCandidate[];
  /** native select 的 option 清单（可直接读，无需打开下拉）。 */
  nativeSelectOptions: Array<{
    parentControlId: string;
    semanticName: string;
    options: Array<{ value?: string; text?: string; disabled?: boolean }>;
    discoveryMode: "native_select";
  }>;
}

/** 稳定结果区域 id：基于页面中检测到的 table 顺序。 */
function resultRegionId(index: number): string {
  return `result_region_${index + 1}`;
}

/** 从 table/list 推断列结构（headers 优先，其次首行单元格）。 */
function inferColumns(table: { columnHeaders?: string[]; firstRowCells?: string[] }): string[] {
  const headers = (table.columnHeaders ?? []).map((h) => h.trim()).filter(Boolean);
  if (headers.length) return headers;
  return (table.firstRowCells ?? []).map((c) => c.trim()).filter(Boolean).slice(0, 12);
}

/**
 * P6.2-6：结果区域识别。只从结构判断（table/list 容器 + 行数 + 列头 + 空状态 + 分页），
 * 不依赖页面业务名称。
 */
export function detectResultRegions(inventory: InventorySummary): ResultRegion[] {
  const regions: ResultRegion[] = [];
  for (let i = 0; i < (inventory.tables ?? []).length; i += 1) {
    const table = inventory.tables[i];
    const columns = inferColumns(table);
    const evidence: string[] = [];
    if (table.role) evidence.push(`role=${table.role}`);
    if (table.tag) evidence.push(`tag=${table.tag}`);
    if (table.rowCount !== undefined) evidence.push(`rows=${table.rowCount}`);
    if (columns.length) evidence.push(`columns=${columns.slice(0, 5).join(",")}`);
    const pagination = (inventory.pagination ?? []).map((p) => p.text ?? `page-${p.index}`).filter(Boolean).slice(0, 4);
    regions.push({
      resultRegionId: resultRegionId(i),
      type: "table",
      columns,
      rowLocator: table.role === "table" || table.role === "grid" ? `[role='${table.role}']` : table.tag === "table" ? "table" : undefined,
      rowCount: table.rowCount ?? 0,
      pagination: pagination.length ? pagination : undefined,
      evidence
    });
  }
  return regions;
}

/**
 * P6.2-3/4：断言候选扫描——从客观结构映射到 canonical kind。
 * 第一批高收益、低歧义：
 *   A. result/table 存在          → record_or_empty_state
 *   B. empty state               → result_empty
 *   C. 稳定页面标题/区块标题       → ui_text_visible（保守，仅当明确 heading 结构）
 *   D. button enabled/disabled   → element_enabled / element_disabled
 *   E. column/header 存在         → table_column_all_equal（列存在断言）
 *   F. dialog 存在               → 不作为 assertion（避免 modal 误判），保留 region 信号
 */
export function scanAssertionCandidates(inventory: InventorySummary, visibleText: string): AssertionCandidate[] {
  const candidates: AssertionCandidate[] = [];
  const emptyStates = inventory.emptyStateTexts?.length
    ? inventory.emptyStateTexts
    : ["暂无数据", "暂无记录", "No data", "Empty", "无记录"].filter((s) => visibleText.includes(s));

  // A. result/table 存在 → record_or_empty_state（region=RESULT_REGION）
  for (const table of inventory.tables ?? []) {
    const columns = inferColumns(table);
    const expectedTexts = ["暂无数据", "暂无记录", ...columns.slice(0, 5)];
    candidates.push({
      assertionKind: "record_or_empty_state",
      semanticName: `结果列表或空状态（table #${table.index + 1}${columns.length ? `，列: ${columns.slice(0, 4).join("/")}` : ""}）`,
      expectedTexts,
      status: "dom_verified",
      confidence: 0.6,
      source: "structure_scan:result_table",
      evidence: [`tag=${table.tag ?? ""}`, `rows=${table.rowCount ?? 0}`, ...(table.role ? [`role=${table.role}`] : [])],
      canonicalKind: "record_or_empty_state",
      regionType: "RESULT_REGION"
    });
  }

  // B. empty state → result_empty
  if (emptyStates.length) {
    candidates.push({
      assertionKind: "result_empty",
      semanticName: `空状态可见文本（${emptyStates.slice(0, 2).join("/")}）`,
      expectedTexts: emptyStates.slice(0, 6),
      status: "dom_verified",
      confidence: 0.7,
      source: "structure_scan:empty_state",
      evidence: emptyStates.map((s) => `empty_text=${s}`),
      canonicalKind: "result_empty",
      regionType: "RESULT_REGION"
    });
  }

  // D. button enabled/disabled → element_enabled / element_disabled
  //    P8.3：nav 噪音（"行情 可点击"/"现货交易 可点击"/"coinmy 可点击"）不得当业务 assertion。
  for (const button of inventory.buttons ?? []) {
    const name = (button.text ?? button.ariaLabel ?? "").trim();
    if (!name || name.length > 30) continue;
    if (isSiteNavNoise({ semanticName: name, elementId: button.id })) continue;
    const region = classifyPageRegion({
      tag: button.tag,
      role: button.role,
      id: button.id,
      classes: button.classes,
      href: button.href,
      text: name,
      linkDensity: button.href ? 1 : 0
    });
    if (!isRegionAllowedForAssertion(region.regionType, "CONTROL_STATE")) continue;
    if (button.disabled) {
      candidates.push({
        assertionKind: "element_disabled",
        semanticName: `${name} 置灰且不可点击`,
        expectedTexts: [name],
        status: "dom_verified",
        confidence: 0.65,
        source: "structure_scan:button_disabled",
        evidence: [`tag=${button.tag ?? ""}`, "disabled=true"],
        canonicalKind: "element_disabled",
        regionType: region.regionType
      });
    } else {
      candidates.push({
        assertionKind: "element_enabled",
        semanticName: `${name} 可点击`,
        expectedTexts: [name],
        status: "dom_verified",
        confidence: 0.6,
        source: "structure_scan:button_enabled",
        evidence: [`tag=${button.tag ?? ""}`, "disabled=false"],
        canonicalKind: "element_enabled",
        regionType: region.regionType
      });
    }
  }

  // P8.4：打 purpose + region gate；P8.5：语义去重。
  const tagged: AssertionCandidate[] = [];
  for (const candidate of candidates) {
    const precomputedRegion = { regionType: (candidate.regionType ?? "UNKNOWN") as Parameters<typeof tagAssertionPurposeWithRegion>[1]["regionType"], confidence: candidate.regionType === "RESULT_REGION" ? 0.85 : 0.6 };
    const taggedCandidate = tagAssertionPurposeWithRegion(candidate, precomputedRegion);
    if (!taggedCandidate.passesGate) continue;
    tagged.push({ ...candidate, purpose: taggedCandidate.purpose, regionType: taggedCandidate.regionType });
  }

  return dedupeAssertions(
    tagged,
    "page",
    (c) => c.purpose ?? "UNKNOWN",
    (c) => c.regionType ?? ""
  ).slice(0, 24);
}

/** P6.2-1A：native select 的 option 直接从 DOM 读（无需打开）。 */
export function scanNativeSelectOptions(inventory: InventorySummary): StructureScanResult["nativeSelectOptions"] {
  return (inventory.selectOptions ?? []).map((select) => ({
    parentControlId: select.id || select.name || `select_${select.index + 1}`,
    semanticName: select.ariaLabel || select.text || `下拉选择 ${select.index + 1}`,
    options: (select.options ?? []).filter((opt) => opt.text && !opt.disabled),
    discoveryMode: "native_select" as const
  })).filter((item) => item.options.length > 0);
}

/** 组装扫描结果。 */
export function scanPageStructure(inventory: InventorySummary, visibleText: string): StructureScanResult {
  return {
    resultRegions: detectResultRegions(inventory),
    assertionCandidates: scanAssertionCandidates(inventory, visibleText),
    nativeSelectOptions: scanNativeSelectOptions(inventory)
  };
}
