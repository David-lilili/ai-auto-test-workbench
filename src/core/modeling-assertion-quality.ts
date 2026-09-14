/**
 * P8.4/P8.5：Assertion Value Model + Deduplication。
 *
 * P8.4：assertion candidate 不能只按 DOM 元素"看见就生成"。给候选加 assertionPurpose，
 * 不同 purpose 有不同最低 evidence 条件，避免泛文本直接变 assertion。
 *
 * P8.5：建立稳定 assertionSemanticKey（pageId + purpose + targetRegion + targetElement/field +
 * normalized expected semantics），防止同义候选（"结果表可见"/"记录列表存在"/"查询结果区域存在"）
 * 生成多条重复 assertion。
 *
 * 铁律：
 *   - 全部 deterministic；
 *   - 不做页面特例；
 *   - 不降低 status 上限（仍 dom_verified / candidate，绝不 execution_verified）；
 *   - 无法稳定分类 → UNKNOWN + 保守过滤。
 */

import type { AssertionCandidate } from "./modeling-structure-scanner.js";
import { classifyPageRegion, isRegionAllowedForAssertion, type PageRegionType, type RegionInput } from "./modeling-page-region.js";

export type AssertionPurpose =
  | "RESULT_EXISTENCE"
  | "EMPTY_STATE"
  | "FIELD_VALIDATION"
  | "CONTROL_STATE"
  | "COLUMN_EXISTENCE"
  | "DIALOG_STATE"
  | "NAVIGATION_STATE"
  | "RECORD_CONTENT"
  | "VALUE_STATE"
  | "UNKNOWN";

/** 各 purpose 的最低 evidence 条件（不满足 → 过滤）。 */
export const PURPOSE_MIN_EVIDENCE: Record<AssertionPurpose, { requireRegion: PageRegionType[] | null; minEvidenceCount: number; note: string }> = {
  RESULT_EXISTENCE: { requireRegion: ["RESULT_REGION", "BUSINESS_MAIN", "FILTER_REGION"], minEvidenceCount: 1, note: "必须来自 result/filter/business 区域" },
  EMPTY_STATE: { requireRegion: ["RESULT_REGION", "BUSINESS_MAIN"], minEvidenceCount: 1, note: "必须来自 result/business 区域" },
  FIELD_VALIDATION: { requireRegion: ["FORM_REGION"], minEvidenceCount: 2, note: "必须有 field association" },
  CONTROL_STATE: { requireRegion: ["BUSINESS_MAIN", "FORM_REGION", "FILTER_REGION", "RESULT_REGION", "MODAL", "DRAWER", "UTILITY", "UNKNOWN"], minEvidenceCount: 1, note: "必须是业务区域控件（utility/unknown 仅 control-state，nav 噪音由名称过滤）" },
  COLUMN_EXISTENCE: { requireRegion: ["RESULT_REGION"], minEvidenceCount: 1, note: "必须来自 table/grid header" },
  DIALOG_STATE: { requireRegion: ["MODAL", "DRAWER"], minEvidenceCount: 1, note: "必须来自 modal/drawer 区域" },
  NAVIGATION_STATE: { requireRegion: ["GLOBAL_NAV", "HEADER"], minEvidenceCount: 1, note: "仅用于显式导航断言，默认不自动生成" },
  RECORD_CONTENT: { requireRegion: ["RESULT_REGION"], minEvidenceCount: 2, note: "记录内容断言需结果区域 + 列证据" },
  VALUE_STATE: { requireRegion: null, minEvidenceCount: 1, note: "值状态断言需明确 DOM value 证据" },
  UNKNOWN: { requireRegion: null, minEvidenceCount: 0, note: "无法稳定分类 → 默认不自动生成" }
};

/** 从 canonicalKind 映射默认 purpose。 */
export function defaultPurposeForKind(canonicalKind: string): AssertionPurpose {
  switch (canonicalKind) {
    case "result_empty": return "EMPTY_STATE";
    case "record_or_empty_state": return "RESULT_EXISTENCE";
    case "record_contains": return "RECORD_CONTENT";
    case "table_column_all_equal":
    case "table_column_all_equal_or_empty":
    case "table_column_date_between": return "COLUMN_EXISTENCE";
    case "element_enabled":
    case "element_disabled":
    case "control_state_readable": return "CONTROL_STATE";
    case "message_visible_exact":
    case "success_message":
    case "failure_message": return "VALUE_STATE";
    case "ui_text_visible": return "UNKNOWN";
    case "tab_active":
    case "list_row_present": return "RESULT_EXISTENCE";
    case "field_value": return "FIELD_VALIDATION";
    default: return "UNKNOWN";
  }
}

/** P8.4：给 assertion candidate 打 purpose + 区域门禁 + 最低 evidence 校验。 */
export interface PurposeTaggedAssertion {
  candidate: AssertionCandidate;
  purpose: AssertionPurpose;
  regionType: PageRegionType;
  regionConfidence: number;
  /** 该候选是否通过 purpose 最低 evidence 门禁。 */
  passesGate: boolean;
  gateReasons: string[];
}

export function tagAssertionPurpose(
  candidate: AssertionCandidate,
  regionInput: RegionInput,
  purposeOverride?: AssertionPurpose
): PurposeTaggedAssertion {
  return tagAssertionPurposeWithRegion(candidate, classifyPageRegion(regionInput), purposeOverride);
}

/** 使用预计算的区域分类（避免二次分类不一致）。 */
export function tagAssertionPurposeWithRegion(
  candidate: AssertionCandidate,
  region: { regionType: PageRegionType; confidence: number; evidence?: string[] },
  purposeOverride?: AssertionPurpose
): PurposeTaggedAssertion {
  const purpose = purposeOverride ?? defaultPurposeForKind(candidate.canonicalKind ?? "");
  const gateReasons: string[] = [];
  const regionRequirement = PURPOSE_MIN_EVIDENCE[purpose];
  const evidenceCount = candidate.evidence?.length ?? 0;

  if (purpose === "UNKNOWN") {
    gateReasons.push(`purpose=UNKNOWN（kind=${candidate.canonicalKind}）`);
    return { candidate, purpose, regionType: region.regionType, regionConfidence: region.confidence, passesGate: false, gateReasons };
  }

  if (regionRequirement.requireRegion && !regionRequirement.requireRegion.includes(region.regionType)) {
    gateReasons.push(`region=${region.regionType} 不在 ${purpose} 允许列表`);
  } else if (!isRegionAllowedForAssertion(region.regionType, purpose)) {
    gateReasons.push(`region=${region.regionType} 被默认排除（nav/header/footer/utility）`);
  }

  if (evidenceCount < regionRequirement.minEvidenceCount) {
    gateReasons.push(`evidence=${evidenceCount} < ${regionRequirement.minEvidenceCount}`);
  }

  const passesGate = gateReasons.length === 0;
  return { candidate, purpose, regionType: region.regionType, regionConfidence: region.confidence, passesGate, gateReasons };
}

/** P8.5：归一化语义文本（去停用词 + 去"可观察/存在/显示"等弱词 + 同义短语映射）。 */
export function normalizeAssertionSemantics(semanticName: string): string {
  const cleaned = String(semanticName ?? "")
    .replace(/[（(].*?[)）]/g, "") // 去括号（列明细等）
    .replace(/可观察|可见|存在|显示|出现|处于|已|的|后|时/g, "")
    .replace(/\s+/g, "")
    .toLowerCase();
  // 同义短语归一（确定性、有限集合）：结果区域/记录列表/查询结果 表达同一 assertion
  return cleaned
    .replace(/结果列表或空状态|查询结果区域|结果列表|记录列表|结果区域|结果表|列表或空状态/g, "result_list")
    .replace(/空状态|暂无数据|无记录/g, "empty_state");
}

/** P8.5：稳定 assertionSemanticKey。 */
export interface AssertionSemanticKeyInput {
  pageId: string;
  purpose: AssertionPurpose;
  targetRegion?: string;
  targetElement?: string;
  semanticName: string;
}

export function buildAssertionSemanticKey(input: AssertionSemanticKeyInput): string {
  const region = String(input.targetRegion ?? "").trim();
  const element = String(input.targetElement ?? "").trim();
  const norm = normalizeAssertionSemantics(input.semanticName);
  return [String(input.pageId), input.purpose, region, element, norm].filter(Boolean).join("|");
}

/** 批量去重：同 key 只保留第一个（evidence 最丰富优先）。 */
export function dedupeAssertions<T extends AssertionCandidate>(candidates: T[], pageId: string, purposeOf: (c: T) => AssertionPurpose, regionOf: (c: T) => string): T[] {
  const seen = new Map<string, T>();
  const order: string[] = [];
  for (const candidate of candidates) {
    const key = buildAssertionSemanticKey({
      pageId,
      purpose: purposeOf(candidate),
      targetRegion: regionOf(candidate),
      semanticName: candidate.semanticName ?? ""
    });
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, candidate);
      order.push(key);
      continue;
    }
    // 保留 evidence 更丰富的
    if ((candidate.evidence?.length ?? 0) > (existing.evidence?.length ?? 0)) seen.set(key, candidate);
  }
  return order.map((k) => seen.get(k)!).filter((c): c is T => Boolean(c));
}
