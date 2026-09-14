import { sendJson, readJsonBody, required } from "../http-helpers.js";
import type { RequestContext, WorkbenchRoute } from "../router.js";
import { listKnowledgeProposals, previewKnowledgeProposalWriteBack, readKnowledgeProposalDetail, reviewKnowledgeProposal } from "../../knowledge-proposal-review.js";
import { ingestCaptureRunReport } from "../../capture-proposal-ingest.js";
import { RuntimeStore } from "../../runtime-store.js";

export function createKnowledgeProposalRoutes(): WorkbenchRoute[] {
  return [
    {
      method: "GET",
      path: "/api/knowledge-proposals",
      description: "列出知识更新 proposal（支持 project/scope/proposalType/limit 过滤）",
      async handler(ctx: RequestContext): Promise<void> {
        const project = ctx.url.searchParams.get("project") ?? undefined;
        const scopeParam = ctx.url.searchParams.get("scope") ?? "pending";
        const scope = scopeParam === "approved" || scopeParam === "rejected" || scopeParam === "all" ? scopeParam : "pending";
        const proposalType = ctx.url.searchParams.get("type") ?? undefined;
        const limitParam = Number(ctx.url.searchParams.get("limit") ?? "100");
        sendJson(ctx.res, 200, await listKnowledgeProposals(ctx.server.rootDir, {
          project,
          scope,
          proposalType,
          limit: Number.isFinite(limitParam) ? limitParam : undefined
        }));
      }
    },
    {
      method: "GET",
      path: "/api/knowledge-proposals/detail",
      description: "读取单个 proposal 完整内容与审核记录",
      async handler(ctx: RequestContext): Promise<void> {
        const proposalId = ctx.url.searchParams.get("proposalId") ?? "";
        if (!proposalId) {
          sendJson(ctx.res, 400, { error: "proposalId is required" });
          return;
        }
        const detail = await readKnowledgeProposalDetail(ctx.server.rootDir, proposalId);
        if (!detail) {
          sendJson(ctx.res, 404, { error: `Proposal not found: ${proposalId}` });
          return;
        }
        sendJson(ctx.res, 200, detail);
      }
    },
    {
      method: "GET",
      path: "/api/knowledge-proposals/write-back-diff",
      description: "预览 capture ingest proposal 批准后的受控写回 diff（只读，不写库）",
      async handler(ctx: RequestContext): Promise<void> {
        const proposalId = ctx.url.searchParams.get("proposalId") ?? "";
        if (!proposalId) {
          sendJson(ctx.res, 400, { error: "proposalId is required" });
          return;
        }
        try {
          sendJson(ctx.res, 200, await previewKnowledgeProposalWriteBack(ctx.server.rootDir, proposalId));
        } catch (error) {
          sendJson(ctx.res, 404, { error: error instanceof Error ? error.message : String(error) });
        }
      }
    },
    {
      method: "POST",
      path: "/api/knowledge-proposals/ingest-capture-run",
      description: "把采集扫描报告按页拆成 page_model_ingest proposal 进入审核队列",
      async handler(ctx: RequestContext): Promise<void> {
        const body = await readJsonBody(ctx.req);
        const reportPath = required(body.reportPath, "reportPath");
        const project = typeof body.project === "string" && body.project.trim() ? body.project.trim() : undefined;
        const env = typeof body.env === "string" && body.env.trim() ? body.env.trim() : undefined;
        sendJson(ctx.res, 200, await ingestCaptureRunReport(ctx.server.rootDir, { reportPath, project, env }));
      }
    },
    {
      method: "GET",
      path: "/api/runtime/proposal-stats",
      description: "运行态 proposal 状态统计（来自 runtime.sqlite 镜像，可触发文件同步）",
      async handler(ctx: RequestContext): Promise<void> {
        const project = ctx.url.searchParams.get("project") ?? undefined;
        const sync = ctx.url.searchParams.get("sync") === "true";
        const runtime = new RuntimeStore(ctx.server.rootDir);
        if (sync) {
          await runtime.syncProposalsFromFiles();
        }
        sendJson(ctx.res, 200, {
          schemaVersion: "runtime-proposal-stats.v1",
          project: project ?? "all",
          synced: sync,
          statusCounts: await runtime.countProposalsByStatus(project)
        });
      }
    },
    {
      method: "GET",
      path: "/api/runtime/review-log",
      description: "读取审核审计日志（来自 runtime.sqlite 镜像）",
      async handler(ctx: RequestContext): Promise<void> {
        const proposalId = ctx.url.searchParams.get("proposalId") ?? undefined;
        const limitParam = Number(ctx.url.searchParams.get("limit") ?? "50");
        const runtime = new RuntimeStore(ctx.server.rootDir);
        sendJson(ctx.res, 200, {
          schemaVersion: "runtime-review-log.v1",
          entries: await runtime.listReviewLog({ proposalId, limit: Number.isFinite(limitParam) ? limitParam : undefined })
        });
      }
    },
    {
      method: "POST",
      path: "/api/knowledge-proposals/review",
      description: "审核 proposal（approve / reject）；capture ingest 类批准时执行受控写回",
      async handler(ctx: RequestContext): Promise<void> {
        const body = await readJsonBody(ctx.req);
        const proposalId = required(body.proposalId, "proposalId");
        const action = String(body.action ?? "");
        if (action !== "approve" && action !== "reject") {
          sendJson(ctx.res, 400, { error: "action must be approve or reject" });
          return;
        }
        const note = typeof body.note === "string" ? body.note : undefined;
        const reviewedBy = typeof body.reviewedBy === "string" ? body.reviewedBy : undefined;
        sendJson(ctx.res, 200, await reviewKnowledgeProposal(ctx.server.rootDir, { proposalId, action, note, reviewedBy }));
      }
    }
  ];
}
