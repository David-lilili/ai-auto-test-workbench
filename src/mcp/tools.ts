import fs from "fs-extra";
import path from "node:path";
import { readProjectCapabilityRegistry } from "../workbench/project-capabilities.js";
import { listKnowledgeProposals } from "../workbench/knowledge-proposal-review.js";

export interface McpToolContext {
  rootDir: string;
  defaultProject: string;
  defaultEnv: string;
}

export interface McpToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler(args: Record<string, unknown>, ctx: McpToolContext): Promise<McpToolResult>;
}

function textResult(value: unknown, isError = false): McpToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], isError };
}

function stringValue(args: Record<string, unknown>, key: string, fallback: string): string {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function numberValue(args: Record<string, unknown>, key: string, fallback: number): number {
  const value = Number(args[key]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function projectDirName(project: string): string {
  if (!/^[a-z0-9_-]+$/i.test(project)) throw new Error(`Invalid project key: ${project}`);
  return project;
}

/** storage/dsl-diagnostics/<project>/<env>/<caseId>/<timestamp>.json，按时间倒序。 */
async function listDslDiagnostics(ctx: McpToolContext, project: string, env: string, limit: number): Promise<Array<Record<string, unknown>>> {
  const dir = path.join(ctx.rootDir, "storage", "dsl-diagnostics", projectDirName(project), env);
  if (!(await fs.pathExists(dir))) return [];
  const caseDirs = await fs.readdir(dir);
  const records: Array<Record<string, unknown> & { createdAt?: string }> = [];
  for (const caseDir of caseDirs) {
    const casePath = path.join(dir, caseDir);
    const files = (await fs.readdir(casePath)).filter((file) => file.endsWith(".json")).sort();
    const latest = files[files.length - 1];
    if (!latest) continue;
    const record = await fs.readJson(path.join(casePath, latest)).catch(() => undefined);
    if (record) records.push(record);
  }
  records.sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")));
  return records.slice(0, limit);
}

export function createMcpTools(): McpToolDefinition[] {
  return [
    {
      name: "list_dsl_diagnostics",
      description: "列出最近的 DSL 生成失败诊断记录（按项目/环境过滤），包含阶段、中文摘要、gap 和建议。用于归因分析 '为什么 DSL 生成失败/被阻断'。",
      inputSchema: {
        type: "object",
        properties: {
          project: { type: "string", description: "项目 key，默认取工作台配置" },
          env: { type: "string", description: "环境，默认 test" },
          limit: { type: "number", description: "返回条数，默认 10" }
        }
      },
      async handler(args, ctx) {
        const project = stringValue(args, "project", ctx.defaultProject);
        const env = stringValue(args, "env", ctx.defaultEnv);
        const limit = numberValue(args, "limit", 10);
        const records = await listDslDiagnostics(ctx, project, env, limit);
        return textResult({
          project,
          env,
          total: records.length,
          diagnostics: records.map((record) => ({
            caseId: record.caseId,
            stage: record.stage,
            createdAt: record.createdAt,
            chineseSummary: record.chineseSummary,
            gaps: record.gaps,
            suggestions: record.suggestions
          }))
        });
      }
    },
    {
      name: "read_case_execution_history",
      description: "读取某项目下用例的执行历史（状态、耗时、失败摘要），可按 caseId 过滤。用于回归分析和失败追因。",
      inputSchema: {
        type: "object",
        properties: {
          project: { type: "string" },
          caseId: { type: "string", description: "可选，只看这条用例" },
          limit: { type: "number", description: "返回的用例数，默认 20" }
        }
      },
      async handler(args, ctx) {
        const project = stringValue(args, "project", ctx.defaultProject);
        const caseId = typeof args.caseId === "string" && args.caseId.trim() ? args.caseId.trim() : undefined;
        const limit = numberValue(args, "limit", 20);
        const dir = path.join(ctx.rootDir, "storage", "case-history", projectDirName(project));
        if (!(await fs.pathExists(dir))) return textResult({ project, histories: [], note: "该项目暂无用例执行历史。" });
        let files = (await fs.readdir(dir)).filter((file) => file.endsWith(".json")).sort();
        if (caseId) files = files.filter((file) => file === `${caseId}.json`);
        files = files.slice(-limit);
        const histories = [];
        for (const file of files) {
          const data = await fs.readJson(path.join(dir, file)).catch(() => undefined);
          if (!data) continue;
          const executions = Array.isArray(data.executions) ? data.executions : [];
          histories.push({
            caseId: data.caseId,
            updatedAt: data.updatedAt,
            totalExecutions: executions.length,
            latest: executions[executions.length - 1]
          });
        }
        return textResult({ project, histories });
      }
    },
    {
      name: "read_page_models",
      description: "读取项目的 Page Model Store 摘要：页面列表、模块、状态、元素数和断言能力。执行级知识只来自这里。",
      inputSchema: {
        type: "object",
        properties: {
          project: { type: "string" },
          pageId: { type: "string", description: "可选，只看这个页面模型" }
        }
      },
      async handler(args, ctx) {
        const project = stringValue(args, "project", ctx.defaultProject);
        const pageId = typeof args.pageId === "string" && args.pageId.trim() ? args.pageId.trim() : undefined;
        const filePath = path.join(ctx.rootDir, "storage", "page-models", `${projectDirName(project)}.json`);
        if (!(await fs.pathExists(filePath))) return textResult({ project, exists: false, models: [], note: `Page Model Store 未配置: ${project}` });
        const store = await fs.readJson(filePath) as Record<string, unknown>;
        const models = Array.isArray(store.models) ? store.models as Array<Record<string, unknown>> : [];
        const filtered = pageId ? models.filter((model) => model.pageId === pageId) : models;
        return textResult({
          project,
          schemaVersion: store.schemaVersion,
          updatedAt: store.updatedAt,
          total: filtered.length,
          models: filtered.map((model) => ({
            pageId: model.pageId,
            pageName: model.pageName,
            module: model.module,
            status: model.status,
            confidence: model.confidence,
            elementCount: Array.isArray(model.elements) ? model.elements.length : undefined,
            assertionCount: Array.isArray(model.assertions) ? model.assertions.length : undefined,
            providerRequirementCount: Array.isArray(model.providerRequirements) ? model.providerRequirements.length : undefined
          }))
        });
      }
    },
    {
      name: "read_operation_manuals",
      description: "读取项目的 Operation Manual Store：页面在哪、能做什么、需要什么数据、操作后效果。不含 locator。",
      inputSchema: {
        type: "object",
        properties: {
          project: { type: "string" },
          pageId: { type: "string", description: "可选，只看这个页面的操作手册" }
        }
      },
      async handler(args, ctx) {
        const project = stringValue(args, "project", ctx.defaultProject);
        const pageId = typeof args.pageId === "string" && args.pageId.trim() ? args.pageId.trim() : undefined;
        const filePath = path.join(ctx.rootDir, "storage", "operation-manuals", `${projectDirName(project)}.json`);
        if (!(await fs.pathExists(filePath))) return textResult({ project, exists: false, manuals: [], note: `Operation Manual Store 未配置: ${project}` });
        const store = await fs.readJson(filePath) as Record<string, unknown>;
        const manuals = Array.isArray(store.manuals) ? store.manuals as Array<Record<string, unknown>> : [];
        const filtered = pageId ? manuals.filter((manual) => manual.pageId === pageId) : manuals;
        return textResult({
          project,
          schemaVersion: store.schemaVersion,
          updatedAt: store.updatedAt,
          total: filtered.length,
          manuals: filtered.map((manual) => ({
            pageId: manual.pageId,
            pageName: manual.pageName,
            capabilities: Array.isArray(manual.capabilities) ? manual.capabilities.map((capability) => ({
              capabilityId: capability.capabilityId,
              action: capability.action,
              description: capability.description,
              dataRequirements: capability.dataRequirements,
              providerFlows: capability.providerFlows
            })) : undefined
          }))
        });
      }
    },
    {
      name: "read_project_capabilities",
      description: "读取项目能力索引：该项目已具备的 adapter、模型、画像、provider、脚本和资产入口。做项目相关开发前先看这个。",
      inputSchema: {
        type: "object",
        properties: {
          project: { type: "string" }
        }
      },
      async handler(args, ctx) {
        const project = stringValue(args, "project", ctx.defaultProject);
        return textResult(await readProjectCapabilityRegistry({ rootDir: ctx.rootDir, project }));
      }
    },
    {
      name: "read_project_knowledge_map",
      description: "读取项目知识地图：模块树、页面建模状态、页面说明，用于判断项目有哪些模块、哪些页面已建模。",
      inputSchema: {
        type: "object",
        properties: {
          project: { type: "string" }
        }
      },
      async handler(args, ctx) {
        const project = stringValue(args, "project", ctx.defaultProject);
        const filePath = path.join(ctx.rootDir, "storage", "project-knowledge-maps", `${projectDirName(project)}.json`);
        if (!(await fs.pathExists(filePath))) return textResult({ project, exists: false, nodes: [], note: `项目知识地图未配置: ${project}` });
        const store = await fs.readJson(filePath) as Record<string, unknown>;
        const nodes = Array.isArray(store.nodes) ? store.nodes as Array<Record<string, unknown>> : [];
        return textResult({
          project,
          updatedAt: store.updatedAt,
          summary: store.summary,
          total: nodes.length,
          nodes: nodes.map((node) => ({
            pageId: node.pageId,
            pageName: node.pageName,
            module: node.module,
            modelingStatus: node.modelingStatus,
            description: node.description
          }))
        });
      }
    },
    {
      name: "list_case_assets",
      description: "列出项目的用例资产（用例设计、断言期望、自动化候选状态）。用例资产不保存 DSL 和执行历史。",
      inputSchema: {
        type: "object",
        properties: {
          project: { type: "string" },
          limit: { type: "number", description: "默认 30" }
        }
      },
      async handler(args, ctx) {
        const project = stringValue(args, "project", ctx.defaultProject);
        const limit = numberValue(args, "limit", 30);
        const filePath = path.join(ctx.rootDir, "storage", "cases", `${projectDirName(project)}.json`);
        if (!(await fs.pathExists(filePath))) return textResult({ project, cases: [], note: `用例资产库未配置: ${project}` });
        const store = await fs.readJson(filePath) as Record<string, unknown>;
        const cases = Array.isArray(store.cases) ? store.cases as Array<Record<string, unknown>> : [];
        return textResult({
          project,
          updatedAt: store.updatedAt,
          total: cases.length,
          cases: cases.slice(0, limit).map((item) => ({
            id: item.id,
            title: item.title,
            module: item.module,
            priority: item.priority,
            automationCandidate: item.automationCandidate,
            request: item.request,
            expectedAssertion: item.expectedAssertion
          }))
        });
      }
    },
    {
      name: "list_knowledge_proposals",
      description: "列出待审核的知识更新 proposal（执行链路产生的知识改进建议：断言/定位/意图边界等），含类型分布与失败阶段。审核决策在工作台 Web 的「知识审核」视图完成，MCP 侧只读。",
      inputSchema: {
        type: "object",
        properties: {
          project: { type: "string" },
          scope: { type: "string", enum: ["pending", "approved", "rejected", "all"], description: "默认 pending" },
          proposalType: { type: "string", description: "可选，按 proposalType 过滤" },
          limit: { type: "number", description: "默认 50" }
        }
      },
      async handler(args, ctx) {
        const project = stringValue(args, "project", ctx.defaultProject);
        const scopeValue = typeof args.scope === "string" ? args.scope : "pending";
        const scope = scopeValue === "approved" || scopeValue === "rejected" || scopeValue === "all" ? scopeValue : "pending";
        const proposalType = typeof args.proposalType === "string" && args.proposalType.trim() ? args.proposalType.trim() : undefined;
        const limit = numberValue(args, "limit", 50);
        const response = await listKnowledgeProposals(ctx.rootDir, { project, scope, proposalType, limit });
        return textResult(response);
      }
    }
  ];
}

export function toolNotFoundError(toolName: string): McpToolResult {
  return {
    content: [{ type: "text", text: `Unknown tool: ${toolName}` }],
    isError: true
  };
}

export function toolErrorResult(error: unknown): McpToolResult {
  return {
    content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
    isError: true
  };
}
