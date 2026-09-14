import net from "node:net";
import type { RedisSeed } from "./redis-config.js";

export class SimpleRedisClient {
  private socket?: net.Socket;
  private buffer = "";
  private selectedDb = 0;

  constructor(
    private seed: RedisSeed,
    private readonly password?: string,
    private readonly timeoutMs = 5_000
  ) {}

  async connect(): Promise<void> {
    if (this.socket) return;
    this.socket = await new Promise<net.Socket>((resolve, reject) => {
      const socket = net.createConnection({ host: this.seed.host, port: this.seed.port });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`Redis connect timeout after ${this.timeoutMs}ms: ${this.seed.host}:${this.seed.port}`));
      }, this.timeoutMs);
      socket.setEncoding("utf8");
      socket.on("connect", () => {
        clearTimeout(timer);
        resolve(socket);
      });
      socket.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    this.socket.on("data", (chunk) => {
      this.buffer += chunk;
    });
    if (this.password) await this.command("AUTH", this.password);
  }

  async select(db: number): Promise<void> {
    await this.command("SELECT", String(db));
    this.selectedDb = db;
  }

  async get(key: string): Promise<string | undefined> {
    const response = await this.command("GET", key);
    return response.type === "bulk" ? response.value : undefined;
  }

  async type(key: string): Promise<string> {
    const response = await this.command("TYPE", key);
    return response.value ?? "none";
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    const response = await this.command("HGETALL", key);
    if (response.type !== "array") return {};
    const values = response.values ?? [];
    const result: Record<string, string> = {};
    for (let index = 0; index < values.length; index += 2) {
      const field = values[index]?.value;
      const value = values[index + 1]?.value;
      if (field !== undefined && value !== undefined) result[field] = value;
    }
    return result;
  }

  async lrange(key: string, start = 0, stop = -1): Promise<string[]> {
    const response = await this.command("LRANGE", key, String(start), String(stop));
    if (response.type !== "array") return [];
    return (response.values ?? []).map((item) => item.value).filter((value): value is string => value !== undefined);
  }

  async del(key: string): Promise<number> {
    const response = await this.command("DEL", key);
    return Number(response.value ?? 0);
  }

  async ping(): Promise<string> {
    const response = await this.command("PING");
    return response.value ?? "";
  }

  close(): void {
    this.socket?.end();
    this.socket?.destroy();
    this.socket = undefined;
  }

  private async command(...parts: string[]): Promise<RedisResponse> {
    return this.commandWithRedirect(parts, 0);
  }

  private async commandWithRedirect(parts: string[], redirectCount: number): Promise<RedisResponse> {
    await this.connect();
    const socket = this.socket;
    if (!socket) throw new Error("Redis socket is not connected.");
    socket.write(respArray(parts));
    try {
      return await this.readResponse();
    } catch (error) {
      const target = parseMovedTarget(error);
      if (!target || redirectCount >= 3) throw error;
      this.close();
      this.seed = target;
      await this.connect();
      if (this.selectedDb !== 0 && parts[0].toUpperCase() !== "SELECT") await this.commandWithRedirect(["SELECT", String(this.selectedDb)], redirectCount + 1);
      return this.commandWithRedirect(parts, redirectCount + 1);
    }
  }

  private async readResponse(): Promise<RedisResponse> {
    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      const parsed = parseResp(this.buffer);
      if (parsed) {
        this.buffer = this.buffer.slice(parsed.bytes);
        if (parsed.response.type === "error") throw new Error(parsed.response.value ?? "Redis error");
        return parsed.response;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Redis command timeout after ${this.timeoutMs}ms.`);
  }
}

function parseMovedTarget(error: unknown): RedisSeed | undefined {
  const message = error instanceof Error ? error.message : String(error);
  const match = message.match(/\bMOVED\s+\d+\s+([^:\s]+):(\d+)\b/i);
  if (!match) return undefined;
  return { host: match[1], port: Number(match[2]) };
}

interface RedisResponse {
  type: "simple" | "error" | "integer" | "bulk" | "null" | "array";
  value?: string;
  values?: RedisResponse[];
}

function respArray(values: string[]): string {
  return `*${values.length}\r\n${values.map((value) => `$${Buffer.byteLength(value)}\r\n${value}\r\n`).join("")}`;
}

function parseResp(buffer: string): { response: RedisResponse; bytes: number } | undefined {
  if (!buffer) return undefined;
  const lineEnd = buffer.indexOf("\r\n");
  if (lineEnd < 0) return undefined;
  const prefix = buffer[0];
  const line = buffer.slice(1, lineEnd);
  if (prefix === "+") return { response: { type: "simple", value: line }, bytes: lineEnd + 2 };
  if (prefix === "-") return { response: { type: "error", value: line }, bytes: lineEnd + 2 };
  if (prefix === ":") return { response: { type: "integer", value: line }, bytes: lineEnd + 2 };
  if (prefix === "*") return parseRespArray(buffer, line, lineEnd);
  if (prefix !== "$") throw new Error(`Unsupported Redis response prefix: ${prefix}`);
  const length = Number(line);
  if (length === -1) return { response: { type: "null" }, bytes: lineEnd + 2 };
  const valueStart = lineEnd + 2;
  const valueEnd = valueStart + length;
  if (buffer.length < valueEnd + 2) return undefined;
  return { response: { type: "bulk", value: buffer.slice(valueStart, valueEnd) }, bytes: valueEnd + 2 };
}

function parseRespArray(buffer: string, line: string, lineEnd: number): { response: RedisResponse; bytes: number } | undefined {
  const length = Number(line);
  if (length === -1) return { response: { type: "null" }, bytes: lineEnd + 2 };
  const values: RedisResponse[] = [];
  let offset = lineEnd + 2;
  for (let index = 0; index < length; index += 1) {
    const parsed = parseResp(buffer.slice(offset));
    if (!parsed) return undefined;
    values.push(parsed.response);
    offset += parsed.bytes;
  }
  return { response: { type: "array", values }, bytes: offset };
}
