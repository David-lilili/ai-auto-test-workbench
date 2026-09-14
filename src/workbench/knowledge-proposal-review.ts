import fs from "fs-extra";
import path from "node:path";
import { writeSafeJsonFile } from "../core/safe-file-writer.js";
import { logger } from "../core/logger.js";
import { CAPTURE_INGEST_PROPOSAL_TYPE } from "./capture-proposal-ingest.js";
import { applyPageModelWriteBack, buildPageModelWriteBackDiff } from "./page-model-writeback.js";
import { RuntimeStore } from "./runtime-store.js";

/**
 * 知识更新 proposal 审核闭环（v1）。
 *
 * 数据源：storage/proposals/pending/<proposalId>.json（knowledge-update-proposal.v1）。
 * 审核动作：
 *   - approve: 决策与目标 store 记录进 review-log，proposal 移入 approved/；
 *     v1 不自动改写 Page Model / Operation Manual store（防止误写执行级知识），
 *     后续按 proposalType 逐类接入受控写回。
 *   - reject: 决策记录进 review-log，proposal 移入 rejected/。
 * 审计：storage/proposals/review-log.json 追加式记录每次决策（人、时间、理由、快照引用）。
 */

export interface KnowledgeProposalSummary {
  proposalId: string;
  status: string;
  createdAt: string;
  project: string;
  env: string;
  proposalType: string;
  failureStage?: string;
  reason?: string;
  userRequest?: string;
  reviewedAt?: string;
  reviewedBy?: string;
  reviewNote?: string;
}

export interface KnowledgeProposalListResponse {
  schemaVersion: "knowledge-proposal-review-list.v1";
  project: string;
  scope: "pending" | "approved" | "rejected" | "all";
  total: number;
  typeDistribution: Record<string, number>;
  proposals: KnowledgeProposalSummary[];
}

export interface KnowledgeProposalDetailResponse {
  schemaVersion: "knowledge-proposal-review-detail.v1";
  proposal: Record<string, unknown>;
  reviewLog?: Record<string, unknown>;
}

export interface KnowledgeProposalReviewRequest {
  proposalId: string;
  action: "approve" | "reject";
  reviewedBy?: string;
  note?: string;
}

export interface KnowledgeProposalReviewResponse {
  schemaVersion: "knowledge-proposal-review-result.v1";
  proposalId: string;
  action: "approve" | "reject";
  previousStatus: string;
  newStatus: string;
  movedTo: string;
  reviewedAt: string;
  reviewedBy: string;
  note?: string;
  writeBack: {
    policy: string;
    applied: boolean;
    note: string;
    detail?: unknown;
  };
}

export interface ProposalReviewLogEntry {
  reviewedAt: string;
  proposalId: string;
  project: string;
  env: string;
  proposalType: string;
  action: "approve" | "reject";
  reviewedBy: string;
  note?: string;
  previousStatus: string;
  newStatus: string;
}

const PENDING_STATUS = "pending_review";
const APPROVED_STATUS = "approved";
const REJECTED_STATUS = "rejected";

function proposalsRoot(rootDir: string): string {
  return path.join(rootDir, "storage", "proposals");
}

function stateDir(rootDir: string, scope: "pending" | "approved" | "rejected"): string {
  return path.join(proposalsRoot(rootDir), scope);
}

function reviewLogPath(rootDir: string): string {
  return path.join(proposalsRoot(rootDir), "review-log.json");
}

function isValidProposalId(proposalId: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(proposalId);
}

async function readProposalRecord(rootDir: string, scope: "pending" | "approved" | "rejected", proposalId: string): Promise<Record<string, unknown> | undefined> {
  if (!isValidProposalId(proposalId)) return undefined;
  const filePath = path.join(stateDir(rootDir, scope), `${proposalId}.json`);
  if (!(await fs.pathExists(filePath))) return undefined;
  const record = await fs.readJson(filePath).catch(() => undefined);
  return record && typeof record === "object" ? record as Record<string, unknown> : undefined;
}

function summarizeProposal(record: Record<string, unknown>): KnowledgeProposalSummary {
  return {
    proposalId: String(record.proposalId ?? ""),
    status: String(record.status ?? PENDING_STATUS),
    createdAt: String(record.createdAt ?? ""),
    project: String(record.project ?? ""),
    env: String(record.env ?? ""),
    proposalType: String(record.proposalType ?? "unknown"),
    failureStage: typeof record.failureStage === "string" ? record.failureStage : undefined,
    reason: typeof record.reason === "string" ? record.reason : undefined,
    userRequest: typeof record.userRequest === "string" ? record.userRequest : undefined,
    reviewedAt: typeof record.reviewedAt === "string" ? record.reviewedAt : undefined,
    reviewedBy: typeof record.reviewedBy === "string" ? record.reviewedBy : undefined,
    reviewNote: typeof record.reviewNote === "string" ? record.reviewNote : undefined
  };
}

async function appendReviewLog(rootDir: string, entry: ProposalReviewLogEntry): Promise<void> {
  const filePath = reviewLogPath(rootDir);
  const existing = (await fs.readJson(filePath).catch(() => undefined)) as { entries?: ProposalReviewLogEntry[] } | undefined;
  const entries = Array.isArray(existing?.entries) ? existing!.entries! : [];
  entries.push(entry);
  await writeSafeJsonFile(filePath, {
    schemaVersion: "knowledge-proposal-review-log.v1",
    updatedAt: entry.reviewedAt,
    totalDecisions: entries.length,
    entries
  });
}

export async function listKnowledgeProposals(rootDir: string, input: {
  project?: string;
  scope?: "pending" | "approved" | "rejected" | "all";
  proposalType?: string;
  limit?: number;
}): Promise<KnowledgeProposalListResponse> {
  const project = input.project?.trim() || undefined;
  const scope = input.scope ?? "pending";
  const limit = Math.max(1, Math.min(input.limit ?? 100, 500));
  const scopes: Array<"pending" | "approved" | "rejected"> = scope === "all" ? ["pending", "approved", "rejected"] : [scope];
  const summaries: KnowledgeProposalSummary[] = [];
  for (const currentScope of scopes) {
    const dir = stateDir(rootDir, currentScope);
    if (!(await fs.pathExists(dir))) continue;
    const files = (await fs.readdir(dir)).filter((file) => file.endsWith(".json")).sort().reverse();
    for (const file of files) {
      const record = await fs.readJson(path.join(dir, file)).catch(() => undefined);
      if (!record || typeof record !== "object") continue;
      const typed = record as Record<string, unknown>;
      if (project && String(typed.project ?? "") !== project) continue;
      if (input.proposalType && String(typed.proposalType ?? "") !== input.proposalType) continue;
      summaries.push(summarizeProposal(typed));
      if (summaries.length >= limit) break;
    }
    if (summaries.length >= limit) break;
  }
  const typeDistribution: Record<string, number> = {};
  for (const item of summaries) {
    typeDistribution[item.proposalType] = (typeDistribution[item.proposalType] ?? 0) + 1;
  }
  return {
    schemaVersion: "knowledge-proposal-review-list.v1",
    project: project ?? "all",
    scope,
    total: summaries.length,
    typeDistribution,
    proposals: summaries
  };
}

export async function readKnowledgeProposalDetail(rootDir: string, proposalId: string): Promise<KnowledgeProposalDetailResponse | undefined> {
  for (const scope of ["pending", "approved", "rejected"] as const) {
    const record = await readProposalRecord(rootDir, scope, proposalId);
    if (!record) continue;
    const logEntry = await findReviewLogEntry(rootDir, proposalId);
    return { schemaVersion: "knowledge-proposal-review-detail.v1", proposal: record, reviewLog: logEntry };
  }
  return undefined;
}

async function findReviewLogEntry(rootDir: string, proposalId: string): Promise<Record<string, unknown> | undefined> {
  const log = (await fs.readJson(reviewLogPath(rootDir)).catch(() => undefined)) as { entries?: ProposalReviewLogEntry[] } | undefined;
  const entries = Array.isArray(log?.entries) ? log!.entries! : [];
  return entries.find((entry) => entry.proposalId === proposalId) as Record<string, unknown> | undefined;
}

export async function reviewKnowledgeProposal(rootDir: string, input: KnowledgeProposalReviewRequest): Promise<KnowledgeProposalReviewResponse> {
  const record = await readProposalRecord(rootDir, "pending", input.proposalId);
  if (!record) {
    throw new Error(`Pending proposal not found: ${input.proposalId}`);
  }
  const reviewedAt = new Date().toISOString();
  const reviewedBy = input.reviewedBy?.trim() || "workbench-reviewer";
  const newStatus = input.action === "approve" ? APPROVED_STATUS : REJECTED_STATUS;

  // 受控写回：仅 capture ingest 类 proposal 在批准时写 Page Model Store。
  // 写回失败则抛错，proposal 留在 pending 可重试，不产生半写状态。
  let writeBack: KnowledgeProposalReviewResponse["writeBack"];
  let writeBackResult: Record<string, unknown> | undefined;
  if (input.action === "approve" && String(record.proposalType ?? "") === CAPTURE_INGEST_PROPOSAL_TYPE) {
    const project = String(record.project ?? "");
    const applied = await applyPageModelWriteBack(rootDir, project, record, { reviewedBy, note: input.note });
    writeBackResult = applied as unknown as Record<string, unknown>;
    writeBack = {
      policy: String(record.writeBackPolicy ?? "review_then_write_page_model_store_candidate_only"),
      applied: true,
      note: `已写入 ${applied.storePath}：${applied.action}，新增元素 ${applied.addedElements} 个、断言候选 ${applied.addedAssertions} 个；状态上限 candidate，未触碰既有条目。`,
      detail: applied
    };
  } else {
    writeBack = {
      policy: String(record.writeBackPolicy ?? "proposal_only_no_auto_store_write"),
      applied: false,
      note: "v1 审核闭环仅记录决策并移动 proposal；执行级知识写回需按 proposalType 接入受控写回通道后再启用。"
    };
  }

  const updated: Record<string, unknown> = {
    ...record,
    status: newStatus,
    reviewedAt,
    reviewedBy,
    reviewNote: input.note?.trim() || undefined,
    ...(writeBackResult ? { writeBackResult } : {})
  };
  const targetDir = stateDir(rootDir, input.action === "approve" ? "approved" : "rejected");
  await fs.ensureDir(targetDir);
  await writeSafeJsonFile(path.join(targetDir, `${input.proposalId}.json`), updated);
  await fs.remove(path.join(stateDir(rootDir, "pending"), `${input.proposalId}.json`));
  await appendReviewLog(rootDir, {
    reviewedAt,
    proposalId: input.proposalId,
    project: String(updated.project ?? ""),
    env: String(updated.env ?? ""),
    proposalType: String(updated.proposalType ?? "unknown"),
    action: input.action,
    reviewedBy,
    note: input.note?.trim() || undefined,
    previousStatus: String(record.status ?? PENDING_STATUS),
    newStatus
  });
  // 运行态镜像：JSON 为准，sqlite 同步更新（失败不阻断审核主流程）。
  try {
    const runtime = new RuntimeStore(rootDir);
    await runtime.upsertProposal({
      proposalId: input.proposalId,
      status: newStatus,
      createdAt: String(updated.createdAt ?? ""),
      project: String(updated.project ?? ""),
      env: String(updated.env ?? ""),
      proposalType: String(updated.proposalType ?? "unknown"),
      failureStage: typeof updated.failureStage === "string" ? updated.failureStage : null,
      reason: typeof updated.reason === "string" ? updated.reason : null,
      userRequest: typeof updated.userRequest === "string" ? updated.userRequest : null,
      reviewedAt,
      reviewedBy,
      reviewNote: input.note?.trim() || null,
      sourceFile: path.relative(rootDir, path.join(targetDir, `${input.proposalId}.json`)).replace(/\\/g, "/")
    });
    await runtime.appendReviewLog({
      reviewedAt,
      proposalId: input.proposalId,
      project: String(updated.project ?? ""),
      env: String(updated.env ?? ""),
      proposalType: String(updated.proposalType ?? "unknown"),
      action: input.action,
      reviewedBy,
      note: input.note?.trim() || null,
      previousStatus: String(record.status ?? PENDING_STATUS),
      newStatus
    });
  } catch (error) {
    logger.warn("Runtime store mirror failed (review still recorded in JSON)", { proposalId: input.proposalId, error: error instanceof Error ? error.message : String(error) });
  }
  logger.info("Knowledge proposal reviewed", { proposalId: input.proposalId, action: input.action, reviewedBy });
  return {
    schemaVersion: "knowledge-proposal-review-result.v1",
    proposalId: input.proposalId,
    action: input.action,
    previousStatus: String(record.status ?? PENDING_STATUS),
    newStatus,
    movedTo: path.relative(rootDir, path.join(targetDir, `${input.proposalId}.json`)).replace(/\\/g, "/"),
    reviewedAt,
    reviewedBy,
    note: input.note?.trim() || undefined,
    writeBack
  };
}

/** 审核前预览受控写回 diff（目前仅 capture ingest 类 proposal 支持）。 */
export async function previewKnowledgeProposalWriteBack(rootDir: string, proposalId: string): Promise<Record<string, unknown>> {
  const record = await readProposalRecord(rootDir, "pending", proposalId);
  if (!record) {
    throw new Error(`Pending proposal not found: ${proposalId}`);
  }
  if (String(record.proposalType ?? "") !== CAPTURE_INGEST_PROPOSAL_TYPE) {
    return {
      schemaVersion: "page-model-write-back-diff.v1",
      proposalId,
      supported: false,
      note: "该 proposalType 暂无受控写回通道，批准仅记录决策。"
    };
  }
  const diff = await buildPageModelWriteBackDiff(rootDir, String(record.project ?? ""), record);
  return { ...diff as unknown as Record<string, unknown>, supported: true };
}
