/**
 * 工具结果压缩与 Diff 上下文测试（agent-tool-result-compress）。
 * 覆盖：压缩比率 / 噪音行过滤 / relevant lines / diff summary / hunks。
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  compressToolResult,
  renderCompressedToolResult,
  summarizeText,
  extractRelevantLines,
  gitDiffSummary,
  saveRawToolResult
} from "../src/core/agent-tool-result-compress.js";

test("1. 压缩：大输出 → 小上下文，保留 error summary 与 relevant lines", () => {
  const stdout = Array.from({ length: 500 }, (_, i) => `line ${i} normal output`).join("\n");
  const stderr = "error TS2304: Cannot find name 'x'\n    at src/main.ts:12:3\n";
  const compressed = compressToolResult({ command: "npm run typecheck", status: "fail", exitCode: 1, stdout, stderr });
  assert.ok(compressed.charsBefore > 10_000);
  assert.ok(compressed.charsAfter < 2_000);
  assert.ok(compressed.ratio < 0.2);
  assert.ok(compressed.errorSummary.includes("TS2304"));
  assert.ok(compressed.relevantLines.some((line) => line.includes("TS2304")));
  assert.ok(compressed.artifactRef.startsWith("artifacts/tool-results/"));
});

test("2. PASS 输出压缩后 errorSummary 为空", () => {
  const compressed = compressToolResult({ command: "npm run typecheck", status: "ok", exitCode: 0, stdout: "ok\n".repeat(100) });
  assert.equal(compressed.errorSummary, "");
  assert.equal(compressed.relevantLines.length, 0);
});

test("3. summarizeText：过滤噪音行（进度/警告/时间戳）并截断", () => {
  const text = [
    "⠋ installing",
    "npm warn deprecated foo",
    "> ai-auto-test-workbench@0.1.0 typecheck",
    "10% building",
    "real error line",
    "",
    "  ",
    "---",
    "========",
    "last line"
  ].join("\n");
  const summary = summarizeText(text, 20);
  assert.ok(summary.includes("real error line"));
  assert.ok(summary.includes("last line"));
  assert.ok(!summary.includes("npm warn deprecated"));
  assert.ok(!summary.includes("10% building"));
});

test("4. extractRelevantLines：只保留失败相关行", () => {
  const lines = extractRelevantLines("ok line\nerror TS2322: type mismatch\nassert expected 1 to equal 2\nrandom noise\n✗ test failed\n", 8);
  assert.equal(lines.length, 3);
  assert.ok(lines.every((line) => /error|assert|✗/.test(line)));
});

test("5. renderCompressedToolResult 输出紧凑片段", () => {
  const compressed = compressToolResult({ command: "git status", status: "ok", exitCode: 0, stdout: "M src/core/x.ts" });
  const rendered = renderCompressedToolResult(compressed);
  assert.ok(rendered.includes("command: git status"));
  assert.ok(rendered.includes("artifacts/tool-results/"));
});

test("6. gitDiffSummary：本仓库返回 changed files 与 diffHash", async () => {
  const summary = await gitDiffSummary(process.cwd());
  assert.match(summary.diffHash, /^[0-9a-f]{64}$/);
  assert.ok(Array.isArray(summary.changedFiles));
  assert.ok(Array.isArray(summary.statLines));
});

test("7. saveRawToolResult：raw artifact 落盘且可读回", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "toolraw-"));
  try {
    const compressed = compressToolResult({ command: "npm test", status: "fail", exitCode: 1, stdout: "out", stderr: "boom" });
    await saveRawToolResult(root, compressed, { command: "npm test", status: "fail", exitCode: 1, stdout: "out", stderr: "boom" });
    const full = path.join(root, compressed.artifactRef);
    assert.ok(fs.existsSync(full));
    const content = fs.readFileSync(full, "utf8");
    assert.ok(content.includes("--- stdout ---"));
    assert.ok(content.includes("boom"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
