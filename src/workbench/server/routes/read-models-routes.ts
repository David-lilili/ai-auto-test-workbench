import fs from "fs-extra";
import path from "node:path";
import { sendJson } from "../http-helpers.js";
import type { RequestContext, WorkbenchRoute } from "../router.js";
import { loadContext } from "../../../core/config-loader.js";
import { PageGraphStore } from "../../../memory/page-graph-store.js";
import { KnowledgeStore } from "../../../memory/knowledge-store.js";

export async function readRecentLogs(rootDir: string, input: { limit: number; level?: string; query?: string }): Promise<unknown[]> {
  const logDir = path.join(rootDir, "artifacts", "logs");
  if (!(await fs.pathExists(logDir))) return [];
  const files = (await fs.readdir(logDir))
    .filter((file) => /^workbench-\d{4}-\d{2}-\d{2}\.jsonl$/.test(file))
    .sort()
    .reverse()
    .slice(0, 7);
  const rows: unknown[] = [];
  for (const file of files) {
    const text = await fs.readFile(path.join(logDir, file), "utf8").catch(() => "");
    for (const line of text.split(/\r?\n/).filter(Boolean).reverse()) {
      try {
        const record = JSON.parse(line) as { level?: string; message?: string; meta?: unknown };
        const haystack = JSON.stringify(record).toLowerCase();
        if (input.level && record.level !== input.level) continue;
        if (input.query && !haystack.includes(input.query.toLowerCase())) continue;
        rows.push(record);
        if (rows.length >= input.limit) return rows;
      } catch {
        continue;
      }
    }
  }
  return rows;
}

export function createReadModelRoutes(): WorkbenchRoute[] {
  return [
    {
      method: "GET",
      path: "/api/page-graph",
      description: "读取页面图",
      async handler(ctx: RequestContext): Promise<void> {
        const project = ctx.url.searchParams.get("project") ?? ctx.server.defaultProject;
        const context = await loadContext({ rootDir: ctx.server.rootDir, project, env: ctx.url.searchParams.get("env") ?? ctx.server.defaultEnv });
        sendJson(ctx.res, 200, await new PageGraphStore(context).load());
      }
    },
    {
      method: "GET",
      path: "/api/knowledge",
      description: "检索知识块",
      async handler(ctx: RequestContext): Promise<void> {
        const project = ctx.url.searchParams.get("project") ?? ctx.server.defaultProject;
        const env = ctx.url.searchParams.get("env") ?? ctx.server.defaultEnv;
        const query = ctx.url.searchParams.get("q") ?? "";
        const limit = Number(ctx.url.searchParams.get("limit") ?? "20");
        const context = await loadContext({ rootDir: ctx.server.rootDir, project, env });
        const store = new KnowledgeStore(context);
        const base = await store.load();
        sendJson(ctx.res, 200, {
          project,
          updatedAt: base.updatedAt,
          total: base.chunks.length,
          chunks: query ? await store.search(query, limit) : base.chunks.slice(0, limit)
        });
      }
    },
    {
      method: "GET",
      path: "/api/latest-results",
      description: "读取最近一次批量执行结果",
      async handler(ctx: RequestContext): Promise<void> {
        const filePath = path.join(ctx.server.rootDir, "artifacts", "logs", "latest-results.json");
        sendJson(ctx.res, 200, (await fs.pathExists(filePath)) ? await fs.readJson(filePath) : { results: [] });
      }
    },
    {
      method: "GET",
      path: "/api/logs",
      description: "读取最近工作台日志",
      async handler(ctx: RequestContext): Promise<void> {
        const limit = Number(ctx.url.searchParams.get("limit") ?? "200");
        const level = ctx.url.searchParams.get("level") || undefined;
        const query = ctx.url.searchParams.get("q") || undefined;
        sendJson(ctx.res, 200, { logs: await readRecentLogs(ctx.server.rootDir, { limit, level, query }) });
      }
    }
  ];
}
