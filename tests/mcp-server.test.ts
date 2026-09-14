import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeMessage, errorResponse, parseMessage, successResponse } from "../src/mcp/protocol.js";
import { createMcpTools, toolNotFoundError } from "../src/mcp/tools.js";

const ctx = { rootDir: process.cwd(), defaultProject: "demo", defaultEnv: "test" };

test("parseMessage accepts valid requests and rejects garbage", () => {
  const request = parseMessage('{"jsonrpc":"2.0","id":1,"method":"tools/list"}');
  assert.equal(request?.method, "tools/list");
  assert.equal(parseMessage("not json"), undefined);
  assert.equal(parseMessage('{"jsonrpc":"1.0","method":"x"}'), undefined);
  assert.equal(parseMessage('{"jsonrpc":"2.0","params":{}}'), undefined);
});

test("encodeMessage frames responses as newline-terminated JSON", () => {
  const encoded = encodeMessage(successResponse(7, { ok: true }));
  assert.ok(encoded.endsWith("\n"));
  assert.deepEqual(JSON.parse(encoded), { jsonrpc: "2.0", id: 7, result: { ok: true } });
  const errorEncoded = encodeMessage(errorResponse(7, -32601, "nope"));
  assert.equal(JSON.parse(errorEncoded).error.code, -32601);
});

test("tools registry exposes 8 read-only tools with schemas", () => {
  const tools = createMcpTools();
  assert.equal(tools.length, 8);
  for (const tool of tools) {
    assert.ok(tool.name);
    assert.ok(tool.description.length > 10);
    assert.equal(tool.inputSchema.type, "object");
  }
});

test("unknown tool returns isError result instead of throwing", () => {
  const result = toolNotFoundError("does_not_exist");
  assert.equal(result.isError, true);
  assert.ok(result.content[0].text.includes("does_not_exist"));
});

test("read_project_capabilities reports unconfigured project gracefully", async () => {
  const tool = createMcpTools().find((item) => item.name === "read_project_capabilities");
  const result = await tool!.handler({}, ctx);
  assert.ok(!result.isError);
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.project, "demo");
  assert.equal(payload.exists, false);
});

test("read_page_models degrades gracefully without project data", async () => {
  const tool = createMcpTools().find((item) => item.name === "read_page_models");
  const result = await tool!.handler({}, ctx);
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.exists, false);
  assert.ok(Array.isArray(payload.models));
  assert.equal(payload.models.length, 0);
});

test("list_dsl_diagnostics degrades gracefully for unconfigured project", async () => {
  const tool = createMcpTools().find((item) => item.name === "list_dsl_diagnostics");
  const result = await tool!.handler({ project: "not-configured-project" }, ctx);
  const payload = JSON.parse(result.content[0].text);
  assert.deepEqual(payload.diagnostics, []);
  assert.ok(!result.isError);
});

test("read_case_execution_history returns history list", async () => {
  const tool = createMcpTools().find((item) => item.name === "read_case_execution_history");
  const result = await tool!.handler({}, ctx);
  const payload = JSON.parse(result.content[0].text);
  assert.ok(Array.isArray(payload.histories));
});

test("list_knowledge_proposals exposes pending review queue", async () => {
  const tool = createMcpTools().find((item) => item.name === "list_knowledge_proposals");
  const result = await tool!.handler({ project: "demo", scope: "pending", limit: 5 }, ctx);
  const payload = JSON.parse(result.content[0].text);
  assert.ok(Array.isArray(payload.proposals));
  assert.ok(payload.total >= 0);
  assert.ok(payload.proposals.every((item) => item.status === "pending_review"));
  assert.ok(payload.proposals.length <= 5);
});
