import fs from "fs-extra";
import path from "node:path";
import crypto from "node:crypto";
import { writeSafeJsonFile } from "./safe-file-writer.js";
import { logger } from "./logger.js";
import type { ExplorationGap } from "./exploration-gaps.js";
import type { ExplorationPlan } from "./exploration-planner.js";
import type { KnowledgeEvidence } from "./knowledge-promotion-policy.js";

/**
 * ModelingSession（P6.1）：一次「从 URL 开始的自动建模任务」的一等概念。
 *
 * 与普通 ExecutionRun 的区别：
 * - ExecutionRun 是一次用例执行；ModelingSession 是「未知页面 → Page Model」的建模闭环；
 * - 状态机覆盖 bootstrap / explore / promote / review / resume；
 * - 可持久化、可断点续跑、可取消；每轮进度与 stopReason 全量记录。
 *
 * 持久化：storage/modeling-sessions/<project>/<sessionId>.json（safe-writer，可审计）。
 * 状态迁移：
 *   CREATED → BOOTSTRAPPING → MODELING → (EXPLORING → PROMOTING)* → COMPLETED
 *          ↘ POSSIBLE/CONFLICT/需要 review → WAITING_FOR_REVIEW → (resume → MODELING)
 *   PARTIAL / BLOCKED / FAILED / CANCELLED 为终止态。
 */

export type ModelingSessionStatus =
  | "CREATED"
  | "BOOTSTRAPPING"
  | "MODELING"
  | "EXPLORING"
  | "PROMOTING"
  | "WAITING_FOR_REVIEW"
  | "COMPLETED"
  | "PARTIAL"
  | "BLOCKED"
  | "FAILED"
  | "CANCELLED";

export type ModelingRiskMode = "safe" | "review";

export type IdentityVerdict = "SAME_PAGE" | "POSSIBLE_SAME_PAGE" | "RELATED_STATE_MODEL" | "NEW_PAGE" | "CONFLICT";

export type StopReason =
  | "no_plannable_low_risk"
  | "no_progress"
  | "no_new_evidence"
  | "only_medium_high_forbidden"
  | "review_required"
  | "budget_reached"
  | "restore_failure"
  | "identity_conflict"
  | "page_signature_changed"
  | "user_cancelled"
  | "completed"
  | "failed";

export interface ModelingBudgets {
  maxIterations: number;
  maxPlansPerIteration: number;
  maxExplorationRuns: number;
  maxDurationMs: number;
  maxPageMutations: number;
  maxPromotionWrites: number;
  maxFailures: number;
}

export const DEFAULT_MODELING_BUDGETS: ModelingBudgets = {
  maxIterations: 5,
  maxPlansPerIteration: 5,
  maxExplorationRuns: 12,
  maxDurationMs: 15 * 60 * 1000,
  maxPageMutations: 20,
  maxPromotionWrites: 10,
  maxFailures: 3
};

export interface ModelingProgress {
  iteration: number;
  gapsBefore: number;
  gapsAfter: number;
  matchedBefore: number;
  matchedAfter: number;
  verifiedBefore: number;
  verifiedAfter: number;
  newEvidence: number;
  promotedKnowledge: number;
  reviewCandidates: number;
  unresolvedUnknown: number;
  riskBlocked: number;
  /** 本轮是否出现任一真实改善（P6.6 iterationProgress）。 */
  progressed: boolean;
  exploredPlans: string[];
}

export interface ModelingReviewRequest {
  reason: string;
  details: string[];
  candidateEvidence: Array<Pick<KnowledgeEvidence, "evidenceId" | "knowledgeType" | "targetId" | "observedValue" | "confidence" | "outcome">>;
  suggestedDecision?: "approve" | "reject" | "keep_pending";
}

export interface InitialCaptureSummary {
  url: string;
  normalizedUrl: string;
  title?: string;
  domHash?: string;
  visibleTextHash?: string;
  interactiveElementCount: number;
  dialogCount: number;
  tableCount: number;
  listCount: number;
  hasCapturedDom: boolean;
  hasScreenshot: boolean;
  capturedAt: string;
  /** P6.2：结构扫描摘要（result regions / assertion candidates / native options）。 */
  resultRegions?: number;
  assertionCandidates?: number;
  nativeSelectOptions?: number;
}

export interface ModelingSession {
  sessionId: string;
  project: string;
  startUrl: string;
  canonicalPageId?: string;
  /** P1.1 identity verdict（SAME/POSSIBLE/RELATED/NEW/CONFLICT）。 */
  identityVerdict?: IdentityVerdict;
  /** 若 POSSIBLE/CONFLICT 时的候选页面 id。 */
  possibleTargetPageId?: string;
  status: ModelingSessionStatus;
  startedAt: string;
  updatedAt: string;
  iteration: number;
  budgets: ModelingBudgets;
  riskMode: ModelingRiskMode;
  dryRun: boolean;
  initialCapture?: InitialCaptureSummary;
  /** 每轮 coverage/gap 快照引用（相对路径）。 */
  coverageSnapshots: string[];
  lastGaps: ExplorationGap[];
  lastPlans: ExplorationPlan[];
  /** 已执行成功的 plan fingerprint（resume 去重）。 */
  executedFingerprints: string[];
  evidenceIds: string[];
  promotionResults: Array<{ knowledgeType: string; targetId: string; action: string; ok: boolean; reason?: string }>;
  progressHistory: ModelingProgress[];
  reviewRequests: ModelingReviewRequest[];
  blockedPages: string[];
  pageSignatures: string[];
  stopReason?: StopReason;
  stopDetail?: string;
  error?: string;
  /** 终止前的部分完成标记。 */
  partialReason?: string;
}

export interface CreateModelingSessionInput {
  project: string;
  startUrl: string;
  riskMode?: ModelingRiskMode;
  dryRun?: boolean;
  budgets?: Partial<ModelingBudgets>;
}

export function sessionStoreDir(rootDir: string, project: string): string {
  return path.join(rootDir, "storage", "modeling-sessions", project);
}

export function sessionStorePath(rootDir: string, project: string, sessionId: string): string {
  return path.join(sessionStoreDir(rootDir, project), `${sessionId}.json`);
}

export function createModelingSession(rootDir: string, input: CreateModelingSessionInput): ModelingSession {
  const sessionId = `ms_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  return {
    sessionId,
    project: input.project,
    startUrl: input.startUrl,
    status: "CREATED",
    startedAt: now,
    updatedAt: now,
    iteration: 0,
    budgets: { ...DEFAULT_MODELING_BUDGETS, ...(input.budgets ?? {}) },
    riskMode: input.riskMode ?? "safe",
    dryRun: input.dryRun ?? true,
    coverageSnapshots: [],
    lastGaps: [],
    lastPlans: [],
    executedFingerprints: [],
    evidenceIds: [],
    promotionResults: [],
    progressHistory: [],
    reviewRequests: [],
    blockedPages: [],
    pageSignatures: []
  };
}

export async function saveModelingSession(rootDir: string, session: ModelingSession): Promise<string> {
  session.updatedAt = new Date().toISOString();
  const filePath = sessionStorePath(rootDir, session.project, session.sessionId);
  await fs.ensureDir(path.dirname(filePath));
  await writeSafeJsonFile(filePath, session);
  return path.relative(rootDir, filePath).replace(/\\/g, "/");
}

export async function loadModelingSession(rootDir: string, project: string, sessionId: string): Promise<ModelingSession | undefined> {
  const filePath = sessionStorePath(rootDir, project, sessionId);
  if (!(await fs.pathExists(filePath))) return undefined;
  try {
    return await fs.readJson(filePath) as ModelingSession;
  } catch (error) {
    logger.warn("Failed to load modeling session", { sessionId, error: error instanceof Error ? error.message : String(error) });
    return undefined;
  }
}

export async function listModelingSessions(rootDir: string, project: string): Promise<ModelingSession[]> {
  const dir = sessionStoreDir(rootDir, project);
  if (!(await fs.pathExists(dir))) return [];
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".json"));
  const sessions: ModelingSession[] = [];
  for (const file of files) {
    try {
      sessions.push(await fs.readJson(path.join(dir, file)) as ModelingSession);
    } catch {
      // 跳过损坏会话
    }
  }
  return sessions.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/** 状态机：合法迁移校验（防非法状态跳跃）。 */
export function canTransition(from: ModelingSessionStatus, to: ModelingSessionStatus): boolean {
  if (to === "CANCELLED" || to === "FAILED") return true; // 任何状态可取消/失败
  const transitions: Record<ModelingSessionStatus, ModelingSessionStatus[]> = {
    CREATED: ["BOOTSTRAPPING"],
    BOOTSTRAPPING: ["MODELING", "WAITING_FOR_REVIEW", "BLOCKED", "FAILED"],
    MODELING: ["EXPLORING", "PROMOTING", "WAITING_FOR_REVIEW", "COMPLETED", "PARTIAL", "BLOCKED"],
    EXPLORING: ["PROMOTING", "MODELING", "WAITING_FOR_REVIEW", "BLOCKED", "FAILED"],
    PROMOTING: ["MODELING", "WAITING_FOR_REVIEW", "COMPLETED", "PARTIAL", "BLOCKED"],
    WAITING_FOR_REVIEW: ["MODELING", "PARTIAL", "CANCELLED"], // resume → MODELING
    COMPLETED: [],
    PARTIAL: [],
    BLOCKED: ["MODELING", "WAITING_FOR_REVIEW"], // 解锁后可 resume
    FAILED: [],
    CANCELLED: []
  };
  return transitions[from]?.includes(to) ?? false;
}

export function assertTransition(session: ModelingSession, to: ModelingSessionStatus, context: string): void {
  if (!canTransition(session.status, to)) {
    throw new Error(`ModelingSession 非法状态迁移 ${session.status} → ${to}（${context}）`);
  }
  session.status = to;
  session.updatedAt = new Date().toISOString();
}
