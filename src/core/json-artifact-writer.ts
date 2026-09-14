import type { SafeJsonWriteResult } from "./safe-file-writer.js";
import { safeArtifactText, validateJsonFile, writeSafeJsonFile } from "./safe-file-writer.js";

export { safeArtifactText, validateJsonFile };

export interface SafeJsonWriteFallback {
  path: string;
  reason: string;
  rawPath?: string;
}

export async function writeSafeJsonArtifact(
  filePath: string,
  payload: unknown,
  fallbackPayload: Record<string, unknown>,
  options: { rawText?: string; spaces?: number } = {}
): Promise<SafeJsonWriteResult> {
  return writeSafeJsonFile(filePath, payload, {
    rawText: options.rawText,
    spaces: options.spaces,
    fallbackPayload
  });
}
