import { sendJson } from "../http-helpers.js";
import type { RequestContext, WorkbenchRoute } from "../router.js";
import { readProjectCapabilityRegistry } from "../../project-capabilities.js";

export function createProjectCapabilityRoutes(): WorkbenchRoute[] {
  return [
    {
      method: "GET",
      path: "/api/project-capabilities",
      description: "读取项目能力索引",
      async handler(ctx: RequestContext): Promise<void> {
        const project = ctx.url.searchParams.get("project") ?? ctx.server.defaultProject;
        sendJson(ctx.res, 200, await readProjectCapabilityRegistry({ rootDir: ctx.server.rootDir, project }));
      }
    }
  ];
}
