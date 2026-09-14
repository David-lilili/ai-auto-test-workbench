import path from "node:path";
import fs from "fs-extra";
import { summarizeEncodingIssues } from "./text-encoding.js";

export interface SafeJsonWriteFallback {
  path: string;
  reason: string;
  rawPath?: string;
}

export interface SafeJsonWriteResult {
  path: string;
  fallback?: SafeJsonWriteFallback;
}

export interface SafeJsonWriteOptions {
  spaces?: number;
  rawText?: string;
  fallbackPayload?: Record<string, unknown>;
}

export async function writeSafeTextFile(filePath: string, content: string): Promise<string> {
  await fs.ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, normalizeText(content), { encoding: "utf8" });
  return filePath;
}

export async function writeSafeJsonFile(
  filePath: string,
  payload: unknown,
  options: SafeJsonWriteOptions = {}
): Promise<SafeJsonWriteResult> {
  const spaces = options.spaces ?? 2;
  let json = "";
  try {
    json = `${JSON.stringify(payload, null, spaces)}\n`;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return writeFallbackJson(filePath, payload, options, reason, spaces);
  }

  await writeSafeTextFile(filePath, json);
  const validation = await validateJsonFile(filePath);
  if (validation.ok) return { path: filePath };

  return writeFallbackJson(filePath, payload, options, validation.error, spaces, json);
}

export async function validateJsonFile(filePath: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const data = await fs.readFile(filePath);
    if (data.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) {
      return { ok: false, error: "UTF-8 BOM detected" };
    }
    JSON.parse(data.toString("utf8"));
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function safeArtifactText(value: unknown, maxChars = 20_000): string {
  const text = typeof value === "string" ? value : safeJsonPreview(value);
  return normalizeText(text).slice(0, maxChars);
}

function normalizeText(content: string): string {
  return content
    .replace(/^\uFEFF/, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "\uFFFD")
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, "\uFFFD")
    .replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD");
}

async function writeFallbackJson(
  filePath: string,
  payload: unknown,
  options: SafeJsonWriteOptions,
  reason: string,
  spaces: number,
  rawText?: string
): Promise<SafeJsonWriteResult> {
  const rawPath = filePath.replace(/\.json$/i, ".raw.txt");
  const fallbackPath = filePath.replace(/\.json$/i, ".fallback.json");
  const fallback = {
    ...(options.fallbackPayload ?? {}),
    safeWriter: {
      originalPath: filePath,
      rawPath,
      validationError: reason,
      encodingSummary: summarizeEncodingIssues(payload)
    }
  };
  await writeSafeTextFile(rawPath, options.rawText ?? rawText ?? safeArtifactText(payload));
  await writeSafeTextFile(fallbackPath, `${JSON.stringify(fallback, null, spaces)}\n`);
  const fallbackValidation = await validateJsonFile(fallbackPath);
  if (!fallbackValidation.ok) {
    throw new Error(`SafeJsonWriter fallback JSON is invalid: ${fallbackValidation.error}`);
  }
  return { path: filePath, fallback: { path: fallbackPath, rawPath, reason } };
}

function safeJsonPreview(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}
