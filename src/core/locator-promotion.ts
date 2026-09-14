import fs from "fs-extra";
import path from "node:path";
import crypto from "node:crypto";
import { writeSafeJsonFile } from "./safe-file-writer.js";
import { logger } from "./logger.js";
import { isSameDynamicLocatorIdentity, hasExplicitDynamicContext, type IdentityNormalizeOptions } from "./locator-identity-normalizer.js";

/**
 * P4-B13：Writeback Safety——AUTO_PROMOTE 的原子安全写入。
 * 规则：不删除旧知识、不 silent overwrite、不降级 execution_verified、
 * 不修改不相关 element；写入 mutation diff + backup + verificationHistory +
 * source evidence IDs + policy 版本 + before/after hash。
 */

export interface LocatorPromotionInput {
  pageId: string;
  elementId: string;
  /** semantic target（用于锁定元素，不改变语义）。 */
  semanticName: string;
  /** 旧 locator 候选列表（原样保留）。 */
  oldLocatorCandidates: Array<Record<string, unknown>>;
  /** 新修复 locator（追加为候选，不删除旧值）。 */
  healedLocator: { strategy: string; value: string; confidence: number; source: string };
  evidenceIds: string[];
  policyId: string;
  policyVersion: number;
  sourceRunIds: string[];
  successCount: number;
}

export interface LocatorPromotionResult {
  ok: boolean;
  elementId: string;
  pageId: string;
  action: "appended_locator_candidate" | "noop" | "error";
  mutationDiff?: {
    field: "locatorCandidates";
    before: number;
    after: number;
    added: Array<Record<string, unknown>>;
  };
  backupPath?: string;
  rollback?: {
    method: "restore_backup";
    backupPath: string;
  };
  verificationHistoryEntry?: Record<string, unknown>;
  error?: string;
}

export async function promoteLocatorCandidate(rootDir: string, project: string, input: LocatorPromotionInput): Promise<LocatorPromotionResult> {
  const storePath = path.join(rootDir, "storage", "page-models", `${project}.json`);
  if (!(await fs.pathExists(storePath))) {
    return { ok: false, elementId: input.elementId, pageId: input.pageId, action: "error", error: "store 不存在" };
  }

  // 原子性：先读全量 → 修改内存 → backup 原文 → 一次性写回
  const store = await fs.readJson(storePath) as Record<string, unknown>;
  const models = Array.isArray(store.models) ? store.models as Array<Record<string, unknown>> : [];
  const model = models.find((item) => String(item.pageId) === input.pageId);
  if (!model) {
    return { ok: false, elementId: input.elementId, pageId: input.pageId, action: "error", error: `页面 ${input.pageId} 不存在` };
  }
  const elements = Array.isArray(model.elements) ? model.elements as Array<Record<string, unknown>> : [];
  const element = elements.find((item) => String(item.elementId) === input.elementId);
  if (!element) {
    return { ok: false, elementId: input.elementId, pageId: input.pageId, action: "error", error: `元素 ${input.elementId} 不存在（semantic target 未建模）` };
  }

  // 锁定 semantic target：semanticName 不匹配则拒绝（不改变语义）。
  // 仅当元素具备显式动态展示证据（captured_inventory / dynamicBinding / currentValue）
  // 才允许剥离动态价格/涨跌幅；其余一律原始文本比较。
  const currentSemanticName = String(element.semanticName ?? "");
  if (currentSemanticName && input.semanticName && !fuzzySemanticMatch(currentSemanticName, input.semanticName, { allowDynamicValueStripping: hasExplicitDynamicContext(element) })) {
    return { ok: false, elementId: input.elementId, pageId: input.pageId, action: "error", error: `semantic target 不匹配：store='${currentSemanticName}' vs candidate='${input.semanticName}'` };
  }

  const existingCandidates = Array.isArray(element.locatorCandidates) ? element.locatorCandidates as Array<Record<string, unknown>> : [];
  // 幂等：同 value 候选已存在则 noop
  const alreadyExists = existingCandidates.some((candidate) => String(candidate.value) === input.healedLocator.value);
  if (alreadyExists) {
    return { ok: true, elementId: input.elementId, pageId: input.pageId, action: "noop" };
  }

  // 不得降级 execution_verified：只在 locatorCandidates 追加，元素 status 不动
  const beforeCount = existingCandidates.length;
  const newCandidate: Record<string, unknown> = {
    strategy: input.healedLocator.strategy,
    value: input.healedLocator.value,
    confidence: input.healedLocator.confidence,
    source: input.healedLocator.source,
    promotedBy: "knowledge_promotion_pipeline",
    policyId: input.policyId,
    policyVersion: input.policyVersion,
    evidenceIds: input.evidenceIds,
    sourceRunIds: input.sourceRunIds,
    promotedAt: new Date().toISOString(),
    successCount: input.successCount
  };
  element.locatorCandidates = [...existingCandidates, newCandidate];

  // verificationHistory（provenance）
  const historyEntry = {
    promotedAt: new Date().toISOString(),
    policyId: input.policyId,
    policyVersion: input.policyVersion,
    knowledgeType: "LOCATOR",
    action: "appended_locator_candidate",
    evidenceIds: input.evidenceIds,
    sourceRunIds: input.sourceRunIds,
    healedLocator: input.healedLocator,
    successCount: input.successCount
  };
  element.verificationHistory = Array.isArray(element.verificationHistory)
    ? [...(element.verificationHistory as Array<Record<string, unknown>>), historyEntry]
    : [historyEntry];
  model.updatedAt = new Date().toISOString();

  // before/after hash
  const beforeHash = crypto.createHash("sha256").update(JSON.stringify(store)).digest("hex").slice(0, 16);

  // backup（不覆盖已有）
  const backupDir = path.join(rootDir, "storage", "page-models");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const backupPath = path.join(backupDir, `backup-${project}-pre-locator-promotion-${timestamp}.json`);
  if (!(await fs.pathExists(backupPath))) {
    await fs.writeFile(backupPath, JSON.stringify(store, null, 2) + "\n");
  }

  // 原子写回（safe writer：写后回读校验 + fallback）
  await writeSafeJsonFile(storePath, store);
  const afterHash = crypto.createHash("sha256").update(JSON.stringify(await fs.readJson(storePath))).digest("hex").slice(0, 16);

  logger.info("Locator candidate promoted", {
    elementId: input.elementId,
    policyId: input.policyId,
    candidatesBefore: beforeCount,
    candidatesAfter: beforeCount + 1,
    beforeHash,
    afterHash
  });

  return {
    ok: true,
    elementId: input.elementId,
    pageId: input.pageId,
    action: "appended_locator_candidate",
    mutationDiff: {
      field: "locatorCandidates",
      before: beforeCount,
      after: beforeCount + 1,
      added: [newCandidate]
    },
    backupPath: path.relative(rootDir, backupPath).replace(/\\/g, "/"),
    rollback: { method: "restore_backup", backupPath: path.relative(rootDir, backupPath).replace(/\\/g, "/") },
    verificationHistoryEntry: historyEntry
  };
}

/** 语义模糊匹配（目标锁定）：一方包含另一方核心词即认为同 target。默认原始文本比较，仅显式动态上下文 opt-in。 */
function fuzzySemanticMatch(a: string, b: string, options: IdentityNormalizeOptions = {}): boolean {
  return isSameDynamicLocatorIdentity(a, b, options);
}
