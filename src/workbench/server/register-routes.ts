import { createRouteRegistry, type RouteRegistry } from "./router.js";
import { createProjectCapabilityRoutes } from "./routes/project-capabilities-routes.js";
import { createReadModelRoutes } from "./routes/read-models-routes.js";
import { createKnowledgeProposalRoutes } from "./routes/knowledge-proposal-routes.js";
import { createModelingSessionRoutes } from "./routes/modeling-session-routes.js";

/**
 * 注册全部新式路由模块。新增域时在此追加 create<XxxRoutes()。
 * 迁移完成的端点应同步从 scripts/start-workbench.ts 的 legacy handleApi 中删除。
 */
export function registerAllRoutes(): RouteRegistry {
  const registry = createRouteRegistry();
  for (const route of [...createProjectCapabilityRoutes(), ...createReadModelRoutes(), ...createKnowledgeProposalRoutes(), ...createModelingSessionRoutes()]) {
    registry.register(route);
  }
  return registry;
}
