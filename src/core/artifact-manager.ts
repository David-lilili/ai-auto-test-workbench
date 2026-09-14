import path from "node:path";
import fs from "fs-extra";
import type { LoadedContext } from "./types.js";
import { writeSafeJsonFile } from "./safe-file-writer.js";

export class ArtifactManager {
  private readonly currentRunId = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);

  constructor(private readonly context: LoadedContext) {}

  runId(): string {
    return `${this.currentRunId}-${process.pid}`;
  }

  async ensureBaseDirs(): Promise<void> {
    const root = path.join(this.context.rootDir, this.context.workspace.artifactRoot);
    await Promise.all([
      fs.ensureDir(path.join(root, "screenshots")),
      fs.ensureDir(path.join(root, "videos")),
      fs.ensureDir(path.join(root, "traces")),
      fs.ensureDir(path.join(root, "logs")),
      fs.ensureDir(path.join(root, "network")),
      fs.ensureDir(path.join(root, "html-snapshots")),
      fs.ensureDir(path.join(root, "device-logs")),
      fs.ensureDir(path.join(root, "api-dumps"))
    ]);
  }

  async writeJson(relativePath: string, value: unknown): Promise<string> {
    const filePath = path.join(this.context.rootDir, this.context.workspace.artifactRoot, relativePath);
    await writeSafeJsonFile(filePath, value);
    return filePath;
  }
}
