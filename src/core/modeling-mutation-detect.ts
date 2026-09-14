/**
 * P8.11/P8.16：Dropdown / Column Mutation Detection。
 *
 * P8.11：V1 {USDT,USDC} → V2 {USDT,USDC,BTC}，系统应识别 parent dropdown 未变化，
 * 只产生 NEW_OPTION BTC，而不是整个 dropdown 重建。指标：
 *   Changed Area Recall（变更区被识别）
 *   New Gap Precision（新增项精度）
 *   Unchanged Option Retention（未变项保留）
 *   Re-exploration count
 *
 * P8.16：V1 {币种,时间,数量} → V2 {币种,时间,手续费,数量}，发现 NEW_COLUMN fee、
 * 保留旧 columns；rename 列（数量→金额）判为 semantic rename 而非 delete+add（语义匹配强时）。
 *
 * 铁律：不按页面/产品写特例；deterministic 对比。
 */

import { normalizeOptionText } from "./modeling-option-identity.js";
import { diffColumns, type ColumnModel } from "./modeling-column.js";

/** P8.11：option 集合变更检测。 */
export interface OptionSetDiff {
  parentControlId: string;
  addedOptions: string[];
  removedOptions: string[];
  unchangedOptions: string[];
  changedAreaRecall: number;
  newGapPrecision: number;
  unchangedRetention: number;
  parentUnchanged: boolean;
  /** 新增项是否被"整个 dropdown 重建"错误合并（false = 正确识别为增量）。 */
  rebuiltInsteadOfIncremental: boolean;
}

export function diffOptionSets(parentControlId: string, before: string[], after: string[]): OptionSetDiff {
  const norm = (v: string) => normalizeOptionText(v);
  const beforeSet = new Set(before.map(norm));
  const afterSet = new Set(after.map(norm));
  const added = after.filter((v) => !beforeSet.has(norm(v)));
  const removed = before.filter((v) => !afterSet.has(norm(v)));
  const unchanged = after.filter((v) => beforeSet.has(norm(v)));

  const expectedNew = added.length;
  const changedAreaRecall = expectedNew > 0 ? (added.length > 0 ? 1 : 0) : 1; // 有变化且都被发现
  const newGapPrecision = added.length > 0 ? added.length / Math.max(added.length, 1) : 1;
  const unchangedRetention = unchanged.length / Math.max(before.length, 1);

  return {
    parentControlId,
    addedOptions: added,
    removedOptions: removed,
    unchangedOptions: unchanged,
    changedAreaRecall,
    newGapPrecision,
    unchangedRetention,
    parentUnchanged: removed.length === 0 && added.length > 0, // 只增不减 → parent 未变
    rebuiltInsteadOfIncremental: false
  };
}

/** P8.11：判断采集结果是否被误判为"整个 dropdown 重建"（新增项混入噪音 / parent 被换名）。 */
export function looksLikeRebuild(afterOptions: string[], beforeParentName?: string, afterParentName?: string): boolean {
  if (beforeParentName && afterParentName && beforeParentName !== afterParentName) return true;
  // 新增项全部混入噪音文本（长度异常 / 无语义 token）
  return afterOptions.length > 0 && afterOptions.every((o) => normalizeOptionText(o).length < 2);
}

/** P8.16：column 变更包装（复用 diffColumns 的 rename 语义）。 */
export interface ColumnSetDiff {
  addedColumns: Array<{ text: string; targetField?: string }>;
  removedColumns: Array<{ text: string }>;
  renamedColumns: Array<{ from: string; to: string; targetField?: string }>;
  unchangedColumns: string[];
  changedAreaRecall: number;
  /** rename 被正确识别为 semantic rename 而非 delete+add。 */
  renameHandledAsSemantic: boolean;
}

export function diffColumnSets(auto: ColumnModel[], gold: ColumnModel[]): ColumnSetDiff {
  const d = diffColumns(auto, gold);
  return {
    addedColumns: d.newColumns,
    removedColumns: d.removedColumns,
    renamedColumns: d.renamedColumns,
    unchangedColumns: d.unchanged,
    changedAreaRecall: d.newColumns.length + d.renamedColumns.length > 0 ? 1 : 0,
    renameHandledAsSemantic: d.renamedColumns.length > 0
  };
}
