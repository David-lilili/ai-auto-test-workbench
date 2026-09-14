import { sendJson, readJsonBody } from "../http-helpers.js";
import type { RequestContext, WorkbenchRoute } from "../router.js";
import {
  createModelingSession,
  saveModelingSession,
  loadModelingSession,
  listModelingSessions,
  assertTransition
} from "../../../core/modeling-session.js";

/**
 * P6.13：Modeling Session API（薄封装，不执行建模；CLI 才是执行入口）。
 *
 *   POST /api/modeling-sessions?project=<p>      创建 session（dry-run 默认；真正执行走 CLI page-model:auto）
 *   GET  /api/modeling-sessions?project=<p>      列出项目 sessions
 *   GET  /api/modeling-sessions/load?id=<id>     读取单个 session
 *   POST /api/modeling-sessions/resume?id=<id>   人工批准 review 后 resume（WAITING_FOR_REVIEW → MODELING）
 *   POST /api/modeling-sessions/cancel?id=<id>   取消（→ CANCELLED）
 *
 * 不在此实现 orchestrator 浏览器执行：避免在服务端常驻 Playwright/登录态。
 */

function projectOf(ctx: RequestContext): string {
  return ctx.url.searchParams.get("project") ?? ctx.server.defaultProject ?? "demo";
}

export function createModelingSessionRoutes(): WorkbenchRoute[] {
  return [
    {
      method: "POST",
      path: "/api/modeling-sessions",
      description: "创建 Modeling Session（薄封装，执行走 CLI）",
      async handler(ctx: RequestContext): Promise<void> {
        const body = await readJsonBody(ctx.req);
        const project = projectOf(ctx);
        const startUrl = String(body?.startUrl ?? "");
        if (!startUrl) {
          sendJson(ctx.res, 400, { ok: false, error: "startUrl 必填" });
          return;
        }
        const session = createModelingSession(ctx.server.rootDir, {
          project,
          startUrl,
          riskMode: body?.riskMode === "review" ? "review" : "safe",
          dryRun: body?.dryRun === false ? false : true,
          budgets: typeof body?.maxIterations === "number" ? { maxIterations: body.maxIterations } : undefined
        });
        await saveModelingSession(ctx.server.rootDir, session);
        sendJson(ctx.res, 201, { ok: true, sessionId: session.sessionId, status: session.status });
      }
    },
    {
      method: "GET",
      path: "/api/modeling-sessions",
      description: "列出项目 Modeling Sessions",
      async handler(ctx: RequestContext): Promise<void> {
        const project = projectOf(ctx);
        const sessions = await listModelingSessions(ctx.server.rootDir, project);
        sendJson(ctx.res, 200, {
          project,
          total: sessions.length,
          sessions: sessions.map((s) => ({
            sessionId: s.sessionId,
            startUrl: s.startUrl,
            status: s.status,
            identityVerdict: s.identityVerdict ?? null,
            canonicalPageId: s.canonicalPageId ?? null,
            iteration: s.iteration,
            startedAt: s.startedAt,
            updatedAt: s.updatedAt,
            stopReason: s.stopReason ?? null
          }))
        });
      }
    },
    {
      method: "GET",
      path: "/api/modeling-sessions/load",
      description: "读取单个 Modeling Session",
      async handler(ctx: RequestContext): Promise<void> {
        const project = projectOf(ctx);
        const sessionId = ctx.url.searchParams.get("id") ?? "";
        const session = await loadModelingSession(ctx.server.rootDir, project, sessionId);
        if (!session) {
          sendJson(ctx.res, 404, { ok: false, error: `session ${sessionId} 不存在` });
          return;
        }
        sendJson(ctx.res, 200, session);
      }
    },
    {
      method: "POST",
      path: "/api/modeling-sessions/resume",
      description: "人工批准 review 后 resume（WAITING_FOR_REVIEW → MODELING）",
      async handler(ctx: RequestContext): Promise<void> {
        const project = projectOf(ctx);
        const sessionId = ctx.url.searchParams.get("id") ?? "";
        const session = await loadModelingSession(ctx.server.rootDir, project, sessionId);
        if (!session) {
          sendJson(ctx.res, 404, { ok: false, error: `session ${sessionId} 不存在` });
          return;
        }
        if (session.status !== "WAITING_FOR_REVIEW" && session.status !== "BLOCKED") {
          sendJson(ctx.res, 409, { ok: false, error: `session 状态 ${session.status} 不可 resume（需 WAITING_FOR_REVIEW 或 BLOCKED）` });
          return;
        }
        try {
          assertTransition(session, "MODELING", "resume after review approved");
          session.stopReason = undefined;
          session.stopDetail = undefined;
          await saveModelingSession(ctx.server.rootDir, session);
          sendJson(ctx.res, 200, { ok: true, sessionId, status: session.status });
        } catch (error) {
          sendJson(ctx.res, 409, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      }
    },
    {
      method: "POST",
      path: "/api/modeling-sessions/cancel",
      description: "取消 Modeling Session",
      async handler(ctx: RequestContext): Promise<void> {
        const project = projectOf(ctx);
        const sessionId = ctx.url.searchParams.get("id") ?? "";
        const session = await loadModelingSession(ctx.server.rootDir, project, sessionId);
        if (!session) {
          sendJson(ctx.res, 404, { ok: false, error: `session ${sessionId} 不存在` });
          return;
        }
        try {
          assertTransition(session, "CANCELLED", "user cancel");
          session.stopReason = "user_cancelled";
          session.stopDetail = "user cancelled via API";
          await saveModelingSession(ctx.server.rootDir, session);
          sendJson(ctx.res, 200, { ok: true, sessionId, status: session.status });
        } catch (error) {
          sendJson(ctx.res, 409, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      }
    }
  ];
}
