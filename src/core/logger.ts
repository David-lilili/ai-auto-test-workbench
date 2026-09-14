import fs from "node:fs";
import path from "node:path";
import { summarizeEncodingIssues } from "./text-encoding.js";

type Level = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

export class Logger {
  constructor(
    private readonly minLevel: Level = "info",
    private readonly logDir = path.join(process.cwd(), "artifacts", "logs")
  ) {}

  debug(message: string, meta?: unknown): void {
    this.write("debug", message, meta);
  }

  info(message: string, meta?: unknown): void {
    this.write("info", message, meta);
  }

  warn(message: string, meta?: unknown): void {
    this.write("warn", message, meta);
  }

  error(message: string, meta?: unknown): void {
    this.write("error", message, meta);
  }

  private write(level: Level, message: string, meta?: unknown): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.minLevel]) return;
    const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${message}`;
    const record = {
      at: new Date().toISOString(),
      level,
      message,
      meta,
      encoding: summarizeEncodingIssues({ message, meta }, 5)
    };
    if (meta === undefined) {
      console.log(line);
      this.writeFile(line, record);
      return;
    }
    const lineWithMeta = `${line} ${JSON.stringify(meta, null, 2)}`;
    console.log(lineWithMeta);
    this.writeFile(lineWithMeta, record);
  }

  private writeFile(line: string, record: unknown): void {
    try {
      fs.mkdirSync(this.logDir, { recursive: true });
      const date = new Date().toISOString().slice(0, 10);
      fs.appendFileSync(path.join(this.logDir, `workbench-${date}.log`), `${line}\n`, "utf8");
      fs.appendFileSync(path.join(this.logDir, `workbench-${date}.jsonl`), `${JSON.stringify(record)}\n`, "utf8");
    } catch {
      return;
    }
  }
}

export const logger = new Logger((process.env.LOG_LEVEL as Level | undefined) ?? "info");
