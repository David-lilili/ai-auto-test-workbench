import { readProjectDefaults } from "../core/project-defaults.js";
import { attachLineReader, encodeMessage, errorResponse, JsonRpcErrorCode, MCP_PROTOCOL_VERSION, parseMessage, successResponse, type JsonRpcNotification, type JsonRpcRequest } from "./protocol.js";
import { createMcpTools, toolErrorResult, toolNotFoundError, type McpToolContext, type McpToolDefinition, type McpToolResult } from "./tools.js";

const SERVER_INFO = {
  name: "ai-auto-test-workbench",
  version: "0.1.0"
};

/**
 * MCP stdio Server：把工作台的知识资产（Page Model / Operation Manual /
 * 项目能力索引 / 知识地图 / 用例资产）和诊断数据（DSL 诊断 / 执行历史）
 * 暴露为只读 MCP tools，供 Claude/Cursor/Codex 等客户端结构化驱动。
 *
 * 边界：全部工具只读，不写知识库、不执行 DSL；写操作仍走工作台的
 * proposal 审核闭环。这是刻意设计，不是能力缺口。
 */
export async function startMcpServer(input: { rootDir?: string }): Promise<void> {
  const rootDir = input.rootDir ?? process.cwd();
  const defaults = await readProjectDefaults(rootDir);
  const tools: McpToolDefinition[] = createMcpTools();
  const toolMap = new Map(tools.map((tool) => [tool.name, tool]));
  const toolContext: McpToolContext = {
    rootDir,
    defaultProject: defaults.defaultProject,
    defaultEnv: defaults.defaultEnv
  };
  let initialized = false;
  let shutdownRequested = false;

  const write = (message: string): void => {
    process.stdout.write(message);
  };

  const handleRequest = async (request: JsonRpcRequest): Promise<void> => {
    const id = request.id;
    switch (request.method) {
      case "initialize":
        initialized = true;
        write(encodeMessage(successResponse(id ?? 0, {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: "AI 自动化测试工作台只读工具集。先 read_project_capabilities 了解项目能力，再 read_page_models / read_operation_manuals 获取执行级知识；分析失败用 list_dsl_diagnostics 和 read_case_execution_history。所有工具均不写库，知识更新走工作台的 proposal 审核闭环。"
        })));
        return;
      case "notifications/initialized":
        return;
      case "ping":
        write(encodeMessage(successResponse(id ?? 0, {})));
        return;
      case "tools/list":
        write(encodeMessage(successResponse(id ?? 0, {
          tools: tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema
          }))
        })));
        return;
      case "tools/call": {
        const params = request.params ?? {};
        const name = typeof params.name === "string" ? params.name : "";
        const tool = toolMap.get(name);
        if (!tool) {
          const result = toolNotFoundError(name);
          write(encodeMessage(successResponse(id ?? 0, result)));
          return;
        }
        const callArgs = params.arguments && typeof params.arguments === "object" ? params.arguments as Record<string, unknown> : {};
        try {
          const result: McpToolResult = await tool.handler(callArgs, toolContext);
          write(encodeMessage(successResponse(id ?? 0, result)));
        } catch (error) {
          write(encodeMessage(successResponse(id ?? 0, toolErrorResult(error))));
        }
        return;
      }
      default:
        if (id !== undefined) {
          write(encodeMessage(errorResponse(id, JsonRpcErrorCode.MethodNotFound, `Method not found: ${request.method}`)));
        }
        return;
    }
  };

  const handleLine = (line: string): void => {
    const message = parseMessage(line);
    if (!message) return;
    const request = message as JsonRpcRequest;
    if (request.id === undefined || request.id === null) {
      const notification = message as JsonRpcNotification;
      if (notification.method === "notifications/initialized") return;
      if (notification.method === "exit" || notification.method === "shutdown") shutdownRequested = true;
      return;
    }
    if (!initialized && request.method !== "initialize") {
      write(encodeMessage(errorResponse(request.id, JsonRpcErrorCode.InvalidRequest, "Server not initialized: send initialize first.")));
      return;
    }
    void handleRequest(request).catch(() => {
      write(encodeMessage(errorResponse(request.id ?? null, JsonRpcErrorCode.InternalError, "Internal error")));
    });
  };

  const closeReader = attachLineReader(process.stdin, handleLine);
  await new Promise<void>((resolve) => {
    process.stdin.on("close", () => {
      shutdownRequested = true;
      resolve();
    });
    process.on("SIGINT", () => {
      shutdownRequested = true;
      closeReader();
      resolve();
    });
    process.on("SIGTERM", () => {
      shutdownRequested = true;
      closeReader();
      resolve();
    });
  });
}
