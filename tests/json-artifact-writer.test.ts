import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "fs-extra";
import { safeArtifactText, validateJsonFile, writeSafeJsonArtifact } from "../src/core/json-artifact-writer.js";

test("writes valid UTF-8 JSON for Chinese, special characters, newlines, emoji and mojibake-like input", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "artifact-json-"));
  const filePath = path.join(dir, "assistant-planning.json");
  const payload = {
    runId: "run-1",
    message: "登录 demo test 环境\n创建 TON 红包 \"金额\" 10 😀",
    suspicious: String.fromCodePoint(0x934f, 0x20, 0x95b8, 0x20, 0x7ecb, 0x20, 0x9225),
    nested: { text: "line1\nline2", quote: "\"quoted\"" }
  };

  await writeSafeJsonArtifact(filePath, payload, { runId: "run-1", project: "demo", env: "test" });

  const text = await fs.readFile(filePath, "utf8");
  assert.notEqual(text.charCodeAt(0), 0xfeff);
  assert.deepEqual(await validateJsonFile(filePath), { ok: true });
  assert.equal(JSON.parse(text).message, payload.message);
});

test("sanitizes unpaired surrogates for fallback-safe text fields", () => {
  assert.equal(safeArtifactText("abc\uD800def"), "abc\uFFFDdef");
});

test("detects invalid JSON files during validation", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "artifact-json-invalid-"));
  const filePath = path.join(dir, "assistant-planning.json");
  await fs.writeFile(filePath, "{\"broken\":", "utf8");
  const result = await validateJsonFile(filePath);
  assert.equal(result.ok, false);
});
