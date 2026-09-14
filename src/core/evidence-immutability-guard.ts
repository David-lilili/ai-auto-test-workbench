import fs from "fs-extra";
import path from "node:path";
import crypto from "node:crypto";
import { writeSafeJsonFile } from "./safe-file-writer.js";
import { logger } from "./logger.js";
import type { KnowledgeEvidence } from "./knowledge-promotion-policy.js";

/**
 * Evidence Immutability Guard（EIG）
 *
 * 铁律：storage/knowledge-evidence/** 是 canonical append-only evidence sink。
 *   - 证据一旦写入，禁止 physical delete / overwrite（含通过 OS rm / 直接改写文件）。
 *   - 无效证据不删除：保留原记录，仅通过 invalidateKnowledgeEvidence() 标记
 *     INVALIDATED / REJECTED / SUPERSEDED（复用证据自身状态字段，不造第二套 store）。
 *   - 同 evidenceId 内容不一致视为非法 overwrite：拒绝写入并告警。
 *
 * 本模块提供：
 *   - EVIDENCE_PROTECTED_ROOTS / isProtectedEvidencePath / assertProtectedPathAllowed：
 *     工具链护栏用的受保护 canonical 路径判定（delete/overwrite 一律拒绝）。
 *   - invalidateKnowledgeEvidence()：唯一的失效入口，只追加状态字段，不改内容字段。
 *   - evidenceContentHash()：不可变内容哈希（doctor 检测 duplicate overwrite 用）。
 *   - loadEvidenceRecordIndex()：evidenceId → record 文件的索引（doctor 用）。
 */

export const EVIDENCE_ROOT = "storage/knowledge-evidence";
/** doctor 快照目录（EVIDENCE_ROOT 之下；loadAllKnowledgeEvidence 只扫 project 子目录，不受影响）。 */
export const EVIDENCE_GOVERNANCE_DIR = ".governance";

export type EvidenceStatus = "ACTIVE" | "INVALIDATED" | "REJECTED" | "SUPERSEDED";

export const EVIDENCE_STATUS_VALUES: EvidenceStatus[] = ["ACTIVE", "INVALIDATED", "REJECTED", "SUPERSEDED"];

/** protected canonical paths：Agent 不得通过正常工具链对其执行 rm/delete/物理覆盖。 */
export const EVIDENCE_PROTECTED_ROOTS: string[] = [EVIDENCE_ROOT];

export function isProtectedEvidencePath(targetPath: string): boolean {
  const normalized = targetPath.replace(/\\/g, "/");
  return EVIDENCE_PROTECTED_ROOTS.some(
    (root) => normalized === root || normalized.startsWith(`${root}/`)
  );
}

/** 工具链护栏入口：对受保护路径的 destructive 操作一律拒绝（read/append 放行）。 */
export function assertProtectedPathAllowed(
  operation: "delete" | "overwrite" | "read" | "append",
  targetPath: string
): void {
  if ((operation === "delete" || operation === "overwrite") && isProtectedEvidencePath(targetPath)) {
    throw new Error(
      `EVIDENCE_IMMUTABILITY: ${operation} on protected canonical path is forbidden: ${targetPath}. ` +
        `Evidence 一旦写入禁止删除/覆盖；如需失效请调用 invalidateKnowledgeEvidence() 标记 INVALIDATED/REJECTED/SUPERSEDED。`
    );
  }
}

/** 不可变内容字段（status 系列为可变治理字段，不参与内容哈希）。 */
export function evidenceContentHash(evidence: KnowledgeEvidence): string {
  const content = {
    knowledgeType: evidence.knowledgeType,
    pageId: evidence.pageId,
    targetId: evidence.targetId,
    sourceType: evidence.sourceType,
    sourceRunId: evidence.sourceRunId ?? null,
    sourceGapId: evidence.sourceGapId ?? null,
    heuristicId: evidence.heuristicId ?? null,
    heuristicVersion: evidence.heuristicVersion ?? null,
    observation: evidence.observation,
    confidence: evidence.confidence,
    timestamp: evidence.timestamp,
    pageSignature: evidence.pageSignature ?? null,
    environment: evidence.environment ?? null,
    observedValue: evidence.observedValue,
    outcome: evidence.outcome
  };
  return crypto.createHash("sha256").update(JSON.stringify(content)).digest("hex");
}

export interface EvidenceRecordFile {
  knowledgeKey: string;
  knowledgeType: string;
  pageId: string;
  targetId: string;
  normalizedValue: string;
  evidence: KnowledgeEvidence[];
}

export interface EvidenceRecordLocation {
  project: string;
  knowledgeType: string;
  storePath: string;
  record: EvidenceRecordFile;
}

/** 索引：project 下所有 record 文件及其 evidenceId → 位置（doctor 与失效查找共用）。 */
export async function loadEvidenceRecordIndex(rootDir: string, project: string): Promise<EvidenceRecordLocation[]> {
  const projectDir = path.join(rootDir, EVIDENCE_ROOT, project);
  if (!(await fs.pathExists(projectDir))) return [];
  const locations: EvidenceRecordLocation[] = [];
  for (const typeDir of await fs.readdir(projectDir)) {
    const typePath = path.join(projectDir, typeDir);
    if (!(await fs.stat(typePath)).isDirectory()) continue;
    for (const file of await fs.readdir(typePath)) {
      if (!file.endsWith(".json")) continue;
      const storePath = path.join(typePath, file);
      const record = await fs.readJson(storePath).catch(() => undefined) as EvidenceRecordFile | undefined;
      if (record?.evidence) locations.push({ project, knowledgeType: typeDir, storePath, record });
    }
  }
  return locations;
}

export function findEvidenceLocation(locations: EvidenceRecordLocation[], evidenceId: string): EvidenceRecordLocation | undefined {
  return locations.find((loc) => loc.record.evidence.some((e) => e.evidenceId === evidenceId));
}

export interface InvalidateEvidenceInput {
  evidenceId: string;
  status: Exclude<EvidenceStatus, "ACTIVE">;
  reason: string;
  supersededBy?: string;
}

export interface InvalidateEvidenceResult {
  ok: boolean;
  evidenceId: string;
  status: Exclude<EvidenceStatus, "ACTIVE">;
  storePath: string;
  alreadyMarked: boolean;
}

/**
 * 唯一的证据失效入口：不删除、不覆盖内容字段，只对目标条目追加状态字段。
 * - evidenceId 不存在 → 抛错（绝不静默新建）。
 * - 已标记同一状态 → 幂等返回。
 * - 状态迁移（如 INVALIDATED → SUPERSEDED）允许，但内容字段永不改动。
 */
export async function invalidateKnowledgeEvidence(
  rootDir: string,
  project: string,
  input: InvalidateEvidenceInput
): Promise<InvalidateEvidenceResult> {
  assertProtectedPathAllowed("append", path.join(rootDir, EVIDENCE_ROOT, project));
  const locations = await loadEvidenceRecordIndex(rootDir, project);
  const location = findEvidenceLocation(locations, input.evidenceId);
  if (!location) {
    throw new Error(`EVIDENCE_GOVERNANCE: evidence ${input.evidenceId} not found in project ${project} — 未找到则拒绝操作，绝不创建新记录。`);
  }
  const entry = location.record.evidence.find((e) => e.evidenceId === input.evidenceId)!;
  if (entry.status === input.status) {
    return { ok: true, evidenceId: input.evidenceId, status: input.status, storePath: location.storePath, alreadyMarked: true };
  }
  if (entry.status && entry.status !== "ACTIVE" && entry.status !== input.status) {
    logger.warn("Evidence status transition", { evidenceId: input.evidenceId, from: entry.status, to: input.status, reason: input.reason });
  }
  entry.status = input.status;
  entry.statusReason = input.reason;
  entry.statusAt = new Date().toISOString();
  if (input.supersededBy) entry.supersededBy = input.supersededBy;
  await writeSafeJsonFile(location.storePath, location.record);
  logger.info("Evidence marked", { evidenceId: input.evidenceId, status: input.status, reason: input.reason });
  return { ok: true, evidenceId: input.evidenceId, status: input.status, storePath: location.storePath, alreadyMarked: false };
}
