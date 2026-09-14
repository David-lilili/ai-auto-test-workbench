import readline from "node:readline";

/**
 * MCP stdio 传输层：JSON-RPC 2.0，按行分帧（LSP 风格的 Content-Length 头不用于 MCP stdio）。
 * 协议版本：2025-06-18。实现最小闭环：initialize / tools/list / tools/call / notifications。
 */
export const MCP_PROTOCOL_VERSION = "2025-06-18";

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: number | string;
  result: unknown;
}

export interface JsonRpcError {
  jsonrpc: "2.0";
  id: number | string | null;
  error: { code: number; message: string; data?: unknown };
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcSuccess | JsonRpcError;

export function parseMessage(line: string): JsonRpcRequest | JsonRpcNotification | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const record = parsed as Record<string, unknown>;
  if (record.jsonrpc !== "2.0" || typeof record.method !== "string") return undefined;
  return parsed as JsonRpcRequest | JsonRpcNotification;
}

export function encodeMessage(message: JsonRpcSuccess | JsonRpcError | JsonRpcNotification): string {
  return `${JSON.stringify(message)}\n`;
}

/** 从 stdin 逐行读取并回调；返回关闭函数。 */
export function attachLineReader(input: NodeJS.ReadableStream, onLine: (line: string) => void): () => void {
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  rl.on("line", onLine);
  return () => rl.close();
}

export function successResponse(id: number | string, result: unknown): JsonRpcSuccess {
  return { jsonrpc: "2.0", id, result };
}

export function errorResponse(id: number | string | null, code: number, message: string, data?: unknown): JsonRpcError {
  return { jsonrpc: "2.0", id, error: { code, message, data } };
}

export const JsonRpcErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603
} as const;
