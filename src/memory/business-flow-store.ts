import crypto from "node:crypto";
import path from "node:path";
import fs from "fs-extra";
import type { BusinessFlow, BusinessFlowData, LoadedContext } from "../core/types.js";
import { writeSafeJsonFile } from "../core/safe-file-writer.js";

export class BusinessFlowStore {
  private readonly filePath: string;

  constructor(private readonly context: LoadedContext) {
    this.filePath = path.join(context.rootDir, "storage", "business-flows", `${context.project.projectKey}.json`);
  }

  async load(): Promise<BusinessFlowData> {
    if (!(await fs.pathExists(this.filePath))) return { updatedAt: new Date().toISOString(), flows: [] };
    return (await fs.readJson(this.filePath)) as BusinessFlowData;
  }

  async save(data: BusinessFlowData): Promise<string> {
    data.updatedAt = new Date().toISOString();
    await writeSafeJsonFile(this.filePath, data);
    return this.filePath;
  }

  async upsert(flow: BusinessFlow): Promise<void> {
    const data = await this.load();
    const index = data.flows.findIndex((item) => item.flow_id === flow.flow_id || isSameFlow(item, flow));
    if (index >= 0) {
      const existing = data.flows[index];
      data.flows[index] = {
        ...existing,
        ...flow,
        flow_id: existing.flow_id,
        target_flows: unique([...existing.target_flows, ...flow.target_flows]),
        target_page_ids: unique([...existing.target_page_ids, ...flow.target_page_ids]),
        transition_ids: unique([...existing.transition_ids, ...flow.transition_ids]),
        dsl_case_ids: unique([...existing.dsl_case_ids, ...flow.dsl_case_ids]),
        preconditions: unique([...existing.preconditions, ...flow.preconditions]),
        confidence_score: Math.max(existing.confidence_score, flow.confidence_score),
        updated_at: new Date().toISOString()
      };
    } else {
      data.flows.unshift(flow);
    }
    await this.save(data);
  }
}

export function businessFlowId(parts: unknown[]): string {
  return crypto.createHash("sha1").update(JSON.stringify(parts)).digest("hex").slice(0, 16);
}

function isSameFlow(a: BusinessFlow, b: BusinessFlow): boolean {
  return a.project_id === b.project_id && a.env === b.env && normalize(a.name) === normalize(b.name);
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
