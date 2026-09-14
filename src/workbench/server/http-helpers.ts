import http from "node:http";
import { TextDecoder } from "node:util";
import { assertCleanTextBoundary, EncodingBoundaryError } from "../../core/text-encoding.js";

export function sendJson(res: http.ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value, null, 2));
}

export function required(value: unknown, name: string): string {
  if (!value) throw new Error(`${name} is required`);
  return String(value);
}

export async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const text = decodeBody(Buffer.concat(chunks));
  const body = text ? JSON.parse(text) : {};
  assertCleanTextBoundary(body, req.url ?? "request-body");
  assertRequestTextNotLost(body, req.url ?? "request-body");
  return body;
}

function decodeBody(data: Buffer): string {
  const utf8 = new TextDecoder("utf-8", { fatal: false }).decode(data);
  if (!/[\uFFFD]|[\u00c0-\u00ff]{2,}/.test(utf8)) return utf8;
  try {
    return new TextDecoder("gb18030", { fatal: false }).decode(data);
  } catch {
    return utf8;
  }
}

function assertRequestTextNotLost(value: unknown, boundaryName: string): void {
  const issues: Array<{ path: string; valuePreview: string; reason: string; codePoints: string[] }> = [];
  collectQuestionLossIssues(value, "$", issues);
  if (issues.length) throw new EncodingBoundaryError(`Encoding boundary rejected question-mark-loss text at ${boundaryName}.`, issues);
}

function collectQuestionLossIssues(value: unknown, pathText: string, issues: Array<{ path: string; valuePreview: string; reason: string; codePoints: string[] }>): void {
  if (issues.length >= 10) return;
  if (typeof value === "string") {
    if (isNaturalLanguageRequestPath(pathText) && /\?{4,}/.test(value)) {
      issues.push({ path: pathText, valuePreview: value.slice(0, 160), reason: "question-mark-loss", codePoints: [...value.slice(0, 80)].map((char) => char.codePointAt(0)?.toString(16) ?? "") });
    }
    return;
  }
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectQuestionLossIssues(item, `${pathText}[${index}]`, issues));
    return;
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) collectQuestionLossIssues(item, `${pathText}.${key}`, issues);
}

function isNaturalLanguageRequestPath(pathText: string): boolean {
  return /\.(message|intent|rawRequest|user_message|detail|reason|target)$/i.test(pathText);
}

export { EncodingBoundaryError };
