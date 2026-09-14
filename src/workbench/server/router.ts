import http from "node:http";
import { EncodingBoundaryError } from "../../core/text-encoding.js";
import { logger } from "../../core/logger.js";
import { sendJson } from "./http-helpers.js";

export interface ServerContext {
  rootDir: string;
  defaultProject: string;
  defaultEnv: string;
}

export interface RequestContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  server: ServerContext;
}

export interface WorkbenchRoute {
  method: "GET" | "POST";
  path: string;
  description: string;
  handler: (ctx: RequestContext) => Promise<void>;
}

/**
 * 路由注册表：新式路由模块在此注册，start-workbench 的 legacy handleApi 未命中时回退。
 * 这是绞杀者模式（strangler fig）的迁移轨道：每迁移一个域，legacy 分支就少一个端点。
 */
export class RouteRegistry {
  private readonly routes = new Map<string, WorkbenchRoute>();

  register(route: WorkbenchRoute): void {
    const key = routeKey(route.method, route.path);
    if (this.routes.has(key)) {
      throw new Error(`Duplicate route registration: ${key}`);
    }
    this.routes.set(key, route);
  }

  list(): WorkbenchRoute[] {
    return [...this.routes.values()];
  }

  async dispatch(req: http.IncomingMessage, res: http.ServerResponse, url: URL, server: ServerContext): Promise<boolean> {
    const route = this.routes.get(routeKey(req.method ?? "GET", url.pathname));
    if (!route) return false;
    try {
      await route.handler({ req, res, url, server });
    } catch (error) {
      if (error instanceof EncodingBoundaryError) {
        logger.warn("Encoding boundary rejected request", { error: error.message, issues: error.issues });
        sendJson(res, 400, { error: error.message, encodingIssues: error.issues });
        return true;
      }
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }
}

function routeKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}

export function createRouteRegistry(): RouteRegistry {
  return new RouteRegistry();
}
