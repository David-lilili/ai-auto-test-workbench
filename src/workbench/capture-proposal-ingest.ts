import crypto from "node:crypto";
import fs from "fs-extra";
import path from "node:path";
import { writeSafeJsonFile } from "../core/safe-file-writer.js";
import { logger } from "../core/logger.js";
import { RuntimeStore } from "./runtime-store.js";
import { resolvePageIdentity, loadPageIdentitySignals } from "../core/page-identity-resolver.js";

/**
 * Capture run 产物接入知识审核闭环（M1 写回通道的入口）。
 *
 * 把 reports/<runId>-scan.json（声明式采集框架产物）按页拆成
 * proposalType = page_model_ingest 的 knowledge-update-proposal，
 * 写入 storage/proposals/pending/，复用既有审核视图 / HTTP 路由 / MCP 工具。
 *
 * 边界：只做拆分与登记，不写 Page Model Store；写回发生在审核批准时
 * （见 page-model-writeback.ts），且状态上限为 candidate。
 */

export const CAPTURE_INGEST_PROPOSAL_TYPE = "page_model_ingest";

export interface CaptureIngestElement {
  proposalId: string;
  semanticName: string;
  role: string;
  locatorCandidates: Array<Record<string, unknown>>;
  confidence: number;
  /** P6.2：显式 controlType（option 元素为 dropdown_option，不用 role 推断）。 */
  controlType?: string;
  /** P6.2-1/2：dropdown option 元数据。 */
  targetField?: string;
  optionValue?: string;
  parentElementId?: string;
  /** P6.2-5：结构观察状态（dom_verified）或默认 candidate。 */
  status?: "dom_verified" | "candidate";
  /** P6.2-2：OPTION_EXISTS / OPTION_SELECTABLE。 */
  optionTier?: "OPTION_EXISTS" | "OPTION_SELECTABLE";
}

export interface CaptureIngestAssertionModel {
  proposalId: string;
  assertionKind: string;
  candidates: Array<Record<string, unknown>>;
  /** P6.2-3/4：canonical UserAssertionKind + 断言语义名 + 状态。 */
  canonicalKind?: string;
  semanticName?: string;
  confidence?: number;
  status?: "dom_verified" | "candidate";
}

export interface CaptureIngestPayload {
  runId: string;
  sourceReport: string;
  pageModel: Record<string, unknown>;
  elements: CaptureIngestElement[];
  assertionModels: CaptureIngestAssertionModel[];
  /** 页面身份信号（P1）：供写回前 Page Identity Resolver 判定重复建模。 */
  identity?: {
    url?: string;
    pageName?: string;
    domHash?: string;
    visibleTextHash?: string;
    semanticNames: string[];
  };
  /** P1 resolver 判定结果（ingest 时计算并随 proposal 持久化，审核时可见）。 */
  identityVerdict?: {
    verdict: string;
    score: number;
    reasons: string[];
    matchedSignals: unknown[];
    conflictingSignals: unknown[];
    candidatePageIds: string[];
  };
  /** P8.12/8.14：结果区域 + 列模型（结构级，candidate/dom_verified）。 */
  resultRegions?: Array<{
    resultRegionId: string;
    type: string;
    columns?: string[];
    rowLocator?: string;
    emptyState?: string[];
    pagination?: string[];
    evidence?: string[];
    status?: "candidate" | "dom_verified";
  }>;
}

export interface CaptureIngestResult {
  runId: string;
  sourceReport: string;
  project: string;
  env: string;
  pagesFound: number;
  proposalsCreated: number;
  proposalIds: string[];
  identityConflicts: Array<{ pageId: string; verdict: string; score: number; reasons: string[]; candidatePageIds: string[] }>;
  skipped: Array<{ pageId: string; reason: string }>;
}

export async function ingestCaptureRunReport(rootDir: string, input: {
  reportPath: string;
  project?: string;
  env?: string;
}): Promise<CaptureIngestResult> {
  const reportPath = path.resolve(rootDir, input.reportPath);
  if (!(await fs.pathExists(reportPath))) {
    throw new Error(`Capture run report not found: ${input.reportPath}`);
  }
  const report = await fs.readJson(reportPath) as Record<string, unknown>;
  const proposals = report.proposals as Record<string, Array<Record<string, unknown>>> | undefined;
  const pageModels = Array.isArray(proposals?.pageModels) ? proposals!.pageModels : [];
  if (!pageModels.length) {
    throw new Error(`Capture run report has no pageModel proposals: ${input.reportPath}`);
  }
  const project = input.project ?? String(report.project ?? "");
  const env = input.env ?? String(report.env ?? "test");
  if (!project) throw new Error("Capture run report is missing project and none was provided.");
  const runId = String(report.runId ?? path.basename(reportPath).replace(/-scan\.json$/, ""));
  const elementInventories = Array.isArray(proposals?.elementInventories) ? proposals!.elementInventories : [];
  const assertionModels = Array.isArray(proposals?.assertionModels) ? proposals!.assertionModels : [];

  const result: CaptureIngestResult = {
    runId,
    sourceReport: path.relative(rootDir, reportPath).replace(/\\/g, "/"),
    project,
    env,
    pagesFound: pageModels.length,
    proposalsCreated: 0,
    proposalIds: [],
    identityConflicts: [],
    skipped: []
  };

  const pendingDir = path.join(rootDir, "storage", "proposals", "pending");
  await fs.ensureDir(pendingDir);
  const createdAt = new Date().toISOString();
  // P1：加载已有 Page Model 身份信号，用于判定本次采集页面是否重复建模。
  const existingSignals = await loadPageIdentitySignals(rootDir, project).catch(() => []);
  // 本次 ingest 内新增的页面也进入信号集（同一扫描内页间查重）。
  const ingestedSignals: Array<{ pageId: string; url?: string; pageName?: string; semanticNames: string[] }> = [];

  for (const pageModel of pageModels) {
    const pageId = String(pageModel.pageId ?? "");
    if (!pageId) {
      result.skipped.push({ pageId: "", reason: "missing_page_id" });
      continue;
    }
    const proposalId = `${createdAt.replace(/[:.]/g, "-")}-${crypto.randomUUID()}`;
    // P1：从采集报告 captures 里取该页面的身份信号（domHash/visibleTextHash 在 captures 层）。
    const captureMeta = (Array.isArray(report.captures) ? report.captures as Array<Record<string, unknown>> : [])
      .find((item) => String(item.pageId ?? "") === pageId || String(item.id ?? "") === pageId);
    const pageElements = elementInventories
      .filter((item) => String(item.pageId ?? "") === pageId)
      .map((item) => String(item.semanticName ?? ""))
      .filter(Boolean);
    const identitySignal = {
      pageId,
      url: typeof pageModel.url === "string" ? pageModel.url : (typeof captureMeta?.url === "string" ? captureMeta.url : undefined),
      pageName: typeof pageModel.pageName === "string" ? pageModel.pageName : undefined,
      domHash: typeof captureMeta?.domHash === "string" ? captureMeta.domHash : undefined,
      visibleTextHash: typeof captureMeta?.visibleTextHash === "string" ? captureMeta.visibleTextHash : undefined,
      semanticNames: pageElements
    };
    const identityVerdict = resolvePageIdentity(identitySignal, [...existingSignals, ...ingestedSignals]);
    const payload: CaptureIngestPayload = {
      runId,
      sourceReport: result.sourceReport,
      pageModel,
      identity: {
        url: identitySignal.url,
        pageName: identitySignal.pageName,
        domHash: identitySignal.domHash,
        visibleTextHash: identitySignal.visibleTextHash,
        semanticNames: pageElements
      },
      identityVerdict: {
        verdict: identityVerdict.verdict,
        score: identityVerdict.score,
        reasons: identityVerdict.reasons,
        matchedSignals: identityVerdict.matchedSignals,
        conflictingSignals: identityVerdict.conflictingSignals,
        candidatePageIds: identityVerdict.candidatePageIds
      },
      elements: elementInventories
        .filter((item) => String(item.pageId ?? "") === pageId)
        .map((item) => ({
          proposalId: String(item.proposalId ?? ""),
          semanticName: String(item.semanticName ?? ""),
          role: String(item.role ?? "unknown"),
          locatorCandidates: Array.isArray(item.locatorCandidates) ? item.locatorCandidates : [],
          confidence: Number(item.confidence ?? 0.4)
        })),
      assertionModels: assertionModels
        .filter((item) => String(item.pageId ?? "") === pageId)
        .map((item) => ({
          proposalId: String(item.proposalId ?? ""),
          assertionKind: String(item.assertionKind ?? ""),
          candidates: Array.isArray(item.candidates) ? item.candidates : []
        }))
    };
    await writeSafeJsonFile(path.join(pendingDir, `${proposalId}.json`), {
      schemaVersion: "knowledge-update-proposal.v1",
      proposalId,
      status: "pending_review",
      createdAt,
      project,
      env,
      runId,
      source: "capture_run_ingest",
      reason: `采集扫描 ${runId} 产出页面 ${pageId}（${String(pageModel.pageName ?? "")}）的建模 proposal，共 ${payload.elements.length} 个元素清单和 ${payload.assertionModels.length} 组断言候选。审核批准后以 candidate 状态写入 Page Model Store。`,
      proposalType: CAPTURE_INGEST_PROPOSAL_TYPE,
      writeBackPolicy: "review_then_write_page_model_store_candidate_only",
      recommendedActions: [
        "检查写回预览：新页面或仅新增元素/断言候选，不得改动既有 execution_verified 内容。",
        "确认页面归属 module 与 url 正确。",
        "批准后执行受控写回；拒绝则仅归档不写库。"
      ],
      captureIngest: payload
    });
    result.proposalsCreated += 1;
    result.proposalIds.push(proposalId);
    // P1：同批采集内查重——新页面信号进入集合供后续页面对比。
    ingestedSignals.push({
      pageId,
      url: identitySignal.url,
      pageName: identitySignal.pageName,
      semanticNames: pageElements
    });
    // P1.1：RELATED_STATE_MODEL 是合法已解释关系（页面级 vs 状态级共享 URL），
    // 不 merge、不生成 conflict proposal，仅记录关系 telemetry。
    if (identityVerdict.verdict === "RELATED_STATE_MODEL") {
      logger.info("Page identity related state model recorded", {
        incomingPageId: pageId,
        relatedPageIds: identityVerdict.matchedSignals.map((item) => item.modelPageId).filter((value, index, array) => array.indexOf(value) === index).slice(0, 3),
        sourceCaptureRun: runId
      });
    }
    // P1：疑似同页/身份冲突 → 生成独立的 page_identity_conflict proposal 供人工审核。
    if (identityVerdict.verdict === "POSSIBLE_SAME_PAGE" || identityVerdict.verdict === "CONFLICT") {
      // P1.1 去重：同一 (incomingPageId, primary candidate, verdict) 已有 pending proposal 时不重复生成。
      const primaryCandidate = identityVerdict.candidatePageIds[0] ?? "";
      const dedupeKey = `pageIdentityConflict:${pageId}->${primaryCandidate}:${identityVerdict.verdict}`;
      // 读 pending 目录检查同 key proposal（proposal 级去重，不覆盖已有审核历史）：
      let deduped = false;
      for (const file of await fs.readdir(pendingDir).catch(() => [] as string[])) {
        if (!file.endsWith(".json")) continue;
        const record = await fs.readJson(path.join(pendingDir, file)).catch(() => undefined) as Record<string, unknown> | undefined;
        if (!record || String(record.proposalType ?? "") !== "page_identity_conflict") continue;
        const existingIdentity = record.pageIdentity as Record<string, unknown> | undefined;
        if (!existingIdentity) continue;
        if (String(existingIdentity.incomingPageId ?? "") === pageId
          && String((existingIdentity.candidatePageIds as string[] | undefined)?.[0] ?? "") === primaryCandidate
          && String(existingIdentity.verdict ?? "") === identityVerdict.verdict) {
          deduped = true;
          break;
        }
      }
      if (deduped) {
        logger.info("Page identity conflict proposal deduped", { pageId, primaryCandidate, verdict: identityVerdict.verdict });
      } else {
      const conflictProposalId = `${createdAt.replace(/[:.]/g, "-")}-${crypto.randomUUID()}`;
      await writeSafeJsonFile(path.join(pendingDir, `${conflictProposalId}.json`), {
        schemaVersion: "knowledge-update-proposal.v1",
        proposalId: conflictProposalId,
        status: "pending_review",
        createdAt,
        project,
        env,
        runId,
        source: "page_identity_resolver",
        reason: `采集页面 ${pageId}（${String(pageModel.pageName ?? "")}）与已有 Page Model ${identityVerdict.candidatePageIds.join("、") || "（无明确候选）"} 疑似重复（${identityVerdict.verdict}，score=${identityVerdict.score}）：${identityVerdict.reasons.join("；")}`,
        proposalType: "page_identity_conflict",
        writeBackPolicy: "manual_review_only_no_auto_merge",
        recommendedActions: [
          identityVerdict.verdict === "CONFLICT"
            ? "存在冲突信号：确认是否为同 URL 下的不同交互状态（entry/state 类模型不应合并）。"
            : "疑似同一页面：确认后应将新元素并入既有模型，而非新建页面。",
          "确认后手工合并或拒绝本 proposal；本类型 proposal 不执行自动写回。"
        ],
        pageIdentity: {
          incomingPageId: pageId,
          verdict: identityVerdict.verdict,
          score: identityVerdict.score,
          reasons: identityVerdict.reasons,
          matchedSignals: identityVerdict.matchedSignals,
          conflictingSignals: identityVerdict.conflictingSignals,
          candidatePageIds: identityVerdict.candidatePageIds,
          sourceCaptureRun: runId
        }
      });
      result.identityConflicts.push({
        pageId,
        verdict: identityVerdict.verdict,
        score: identityVerdict.score,
        reasons: identityVerdict.reasons,
        candidatePageIds: identityVerdict.candidatePageIds
      });
      logger.warn("Page identity conflict proposal created", { pageId, verdict: identityVerdict.verdict, score: identityVerdict.score, candidates: identityVerdict.candidatePageIds });
      }
    }
    // 运行态镜像（失败不阻断 ingest 主流程）。
    try {
      const runtime = new RuntimeStore(rootDir);
      await runtime.upsertProposal({
        proposalId,
        status: "pending_review",
        createdAt,
        project,
        env,
        proposalType: CAPTURE_INGEST_PROPOSAL_TYPE,
        failureStage: null,
        reason: `采集扫描 ${runId} 产出页面 ${pageId}`,
        userRequest: null,
        reviewedAt: null,
        reviewedBy: null,
        reviewNote: null,
        sourceFile: path.join("storage", "proposals", "pending", `${proposalId}.json`).replace(/\\/g, "/")
      });
    } catch (error) {
      logger.warn("Runtime store mirror failed during ingest", { proposalId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  logger.info("Capture run ingested into review queue", { runId, project, proposalsCreated: result.proposalsCreated });
  return result;
}
