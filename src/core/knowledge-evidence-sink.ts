import fs from "fs-extra";
import path from "node:path";
import crypto from "node:crypto";
import { writeSafeJsonFile } from "./safe-file-writer.js";
import { buildKnowledgeKey, type KnowledgeEvidence, type EvidenceSourceType, type KnowledgeType } from "./knowledge-promotion-policy.js";
import { EVIDENCE_ROOT, assertProtectedPathAllowed, evidenceContentHash } from "./evidence-immutability-guard.js";
import { logger } from "./logger.js";

/**
 * Unified Evidence Sink（P5.1）：所有 knowledge evidence 的统一入口。
 *
 * 职责：validate → 稳定 evidenceId → 幂等去重 → 持久化 → provenance → 供 aggregation。
 * 不做 promotion、不写 Page Model。
 *
 * 幂等键：sourceRunId + knowledgeKey + observedValue + outcome。
 * 同键重复 record 不产生新 evidence（返回已有 evidenceId）。
 *
 * 存储：storage/knowledge-evidence/<project>/<knowledgeType>/<knowledgeKey>.json
 * ——每 candidate 一个文件（evidence 数组追加），aggregation 直接读目录。
 */

export interface RecordEvidenceInput {
  project: string;
  knowledgeType: KnowledgeType;
  pageId: string;
  targetId: string;
  sourceType: EvidenceSourceType;
  sourceRunId?: string;
  sourceGapId?: string;
  heuristicId?: string;
  heuristicVersion?: number;
  observation: Record<string, unknown>;
  confidence: "HIGH" | "MEDIUM" | "LOW";
  pageSignature?: string;
  environment?: string;
  observedValue: string;
  outcome: "success" | "failure" | "contradiction";
  timestamp?: string;
}

export interface RecordEvidenceResult {
  evidenceId: string;
  deduplicated: boolean;
  knowledgeKey: string;
  storePath: string;
}

export function evidenceStorePath(rootDir: string, project: string, knowledgeType: string, knowledgeKey: string): string {
  return path.join(rootDir, EVIDENCE_ROOT, project, knowledgeType, `${knowledgeKey}.json`);
}

export function validateEvidenceInput(input: RecordEvidenceInput): string[] {
  const errors: string[] = [];
  if (!input.project || !/^[a-z0-9_-]+$/i.test(input.project)) errors.push("invalid project");
  if (!input.pageId) errors.push("missing pageId");
  if (!input.targetId) errors.push("missing targetId");
  if (!input.observedValue) errors.push("missing observedValue");
  if (!["success", "failure", "contradiction"].includes(input.outcome)) errors.push("invalid outcome");
  if (!input.observation || typeof input.observation !== "object") errors.push("missing observation");
  return errors;
}

/** 稳定 evidenceId：幂等键的 hash（同键同 ID——天然去重）。 */
function stableEvidenceId(input: RecordEvidenceInput, knowledgeKey: string): string {
  return deriveStableEvidenceId(input.sourceRunId, knowledgeKey, input.observedValue, input.outcome);
}

/** 导出给 evidence doctor：重算既有条目的稳定 ID，检测非法 overwrite（ID 不匹配 = 内容被篡改）。 */
export function deriveStableEvidenceId(
  sourceRunId: string | undefined,
  knowledgeKey: string,
  observedValue: string,
  outcome: string
): string {
  const raw = JSON.stringify({
    run: sourceRunId ?? "",
    key: knowledgeKey,
    value: observedValue,
    outcome
  });
  return `ev_${crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16)}`;
}

export async function recordKnowledgeEvidence(rootDir: string, input: RecordEvidenceInput): Promise<RecordEvidenceResult> {
  assertProtectedPathAllowed("append", path.join(rootDir, EVIDENCE_ROOT, input.project));
  const errors = validateEvidenceInput(input);
  if (errors.length) throw new Error(`Invalid evidence: ${errors.join("; ")}`);

  const knowledgeKey = buildKnowledgeKey(input.knowledgeType, input.pageId, input.targetId, input.observedValue);
  const evidenceId = stableEvidenceId(input, knowledgeKey);
  const storePath = evidenceStorePath(rootDir, input.project, input.knowledgeType, knowledgeKey);

  // 幂等：同 evidenceId 已存在则不追加
  let record: { knowledgeKey: string; knowledgeType: KnowledgeType; pageId: string; targetId: string; normalizedValue: string; evidence: KnowledgeEvidence[] } =
    (await fs.pathExists(storePath))
      ? await fs.readJson(storePath)
      : { knowledgeKey, knowledgeType: input.knowledgeType, pageId: input.pageId, targetId: input.targetId, normalizedValue: input.observedValue, evidence: [] };

  if (record.evidence.some((item) => item.evidenceId === evidenceId)) {
    // 幂等命中：同 evidenceId 但内容哈希不一致 = 非法 overwrite 企图 → 拒绝覆盖并告警。
    const existing = record.evidence.find((item) => item.evidenceId === evidenceId)!;
    const incoming: KnowledgeEvidence = {
      evidenceId, knowledgeType: input.knowledgeType, pageId: input.pageId, targetId: input.targetId,
      sourceType: input.sourceType, sourceRunId: input.sourceRunId, sourceGapId: input.sourceGapId,
      heuristicId: input.heuristicId, heuristicVersion: input.heuristicVersion, observation: input.observation,
      confidence: input.confidence, timestamp: input.timestamp ?? new Date().toISOString(),
      pageSignature: input.pageSignature, environment: input.environment,
      observedValue: input.observedValue, outcome: input.outcome
    };
    if (evidenceContentHash(existing) !== evidenceContentHash(incoming)) {
      logger.warn("EVIDENCE_IMMUTABILITY: duplicate evidenceId with different content — overwrite blocked, existing record kept", { evidenceId, storePath: path.relative(rootDir, storePath).replace(/\\/g, "/") });
    }
    return { evidenceId, deduplicated: true, knowledgeKey, storePath: path.relative(rootDir, storePath).replace(/\\/g, "/") };
  }

  const evidence: KnowledgeEvidence = {
    evidenceId,
    knowledgeType: input.knowledgeType,
    pageId: input.pageId,
    targetId: input.targetId,
    sourceType: input.sourceType,
    sourceRunId: input.sourceRunId,
    sourceGapId: input.sourceGapId,
    heuristicId: input.heuristicId,
    heuristicVersion: input.heuristicVersion,
    observation: input.observation,
    confidence: input.confidence,
    timestamp: input.timestamp ?? new Date().toISOString(),
    pageSignature: input.pageSignature,
    environment: input.environment,
    observedValue: input.observedValue,
    outcome: input.outcome
  };
  record.evidence.push(evidence);
  record.evidence.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  await writeSafeJsonFile(storePath, record);
  logger.info("Knowledge evidence recorded", { evidenceId, knowledgeType: input.knowledgeType, targetId: input.targetId, outcome: input.outcome, deduplicated: false });
  return { evidenceId, deduplicated: false, knowledgeKey, storePath: path.relative(rootDir, storePath).replace(/\\/g, "/") };
}

/** 读取全部 evidence（aggregation 消费入口）。 */
export async function loadAllKnowledgeEvidence(rootDir: string, project: string): Promise<KnowledgeEvidence[]> {
  const projectDir = path.join(rootDir, EVIDENCE_ROOT, project);
  if (!(await fs.pathExists(projectDir))) return [];
  const all: KnowledgeEvidence[] = [];
  for (const typeDir of (await fs.readdir(projectDir))) {
    const typePath = path.join(projectDir, typeDir);
    for (const file of (await fs.readdir(typePath)).filter(name => name.endsWith(".json"))) {
      const record = await fs.readJson(path.join(typePath, file)).catch(() => undefined);
      if (record?.evidence) all.push(...record.evidence);
    }
  }
  return all;
}
