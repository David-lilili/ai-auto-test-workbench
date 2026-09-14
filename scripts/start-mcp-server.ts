import { startMcpServer } from "../src/mcp/server.js";

await startMcpServer({ rootDir: process.cwd() });
