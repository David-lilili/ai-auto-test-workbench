import path from "node:path";
import fs from "fs-extra";
import type { LoadedContext, PageEdgeMemory, PageGraphMemory, PageNodeMemory } from "../core/types.js";
import { writeSafeJsonFile } from "../core/safe-file-writer.js";

export class PageGraphStore {
  private readonly graphPath: string;

  constructor(private readonly context: LoadedContext) {
    const configured = context.workspace.storage?.pageGraphPath ?? "storage/page-graphs";
    this.graphPath = path.join(context.rootDir, configured, `${context.project.projectKey}.json`);
  }

  async load(): Promise<PageGraphMemory> {
    if (!(await fs.pathExists(this.graphPath))) {
      return {
        project: this.context.project.projectKey,
        updatedAt: new Date().toISOString(),
        nodes: [],
        edges: []
      };
    }
    return (await fs.readJson(this.graphPath)) as PageGraphMemory;
  }

  async save(graph: PageGraphMemory): Promise<string> {
    graph.updatedAt = new Date().toISOString();
    await writeSafeJsonFile(this.graphPath, graph);
    return this.graphPath;
  }

  async upsertNode(node: PageNodeMemory): Promise<void> {
    const graph = await this.load();
    const index = graph.nodes.findIndex((item) => item.pageId === node.pageId);
    if (index >= 0) {
      graph.nodes[index] = mergeNode(graph.nodes[index], node);
    } else {
      graph.nodes.push(node);
    }
    await this.save(graph);
  }

  async upsertEdge(edge: PageEdgeMemory): Promise<void> {
    const graph = await this.load();
    const index = graph.edges.findIndex((item) => item.edgeId === edge.edgeId);
    if (index >= 0) {
      graph.edges[index] = mergeEdge(graph.edges[index], edge);
    } else {
      graph.edges.push(edge);
    }
    await this.save(graph);
  }
}

function mergeNode(existing: PageNodeMemory, next: PageNodeMemory): PageNodeMemory {
  const elements = new Map(existing.elements.map((item) => [item.elementId, item]));
  for (const element of next.elements) elements.set(element.elementId, element);
  return {
    ...existing,
    ...next,
    elements: [...elements.values()],
    visitCount: existing.visitCount + 1,
    confidence: Math.min(0.99, Math.max(existing.confidence, next.confidence)),
    requiredPreconditions: [...new Set([...existing.requiredPreconditions, ...next.requiredPreconditions])]
  };
}

function mergeEdge(existing: PageEdgeMemory, next: PageEdgeMemory): PageEdgeMemory {
  const successCount = existing.successCount + next.successCount;
  const failedCount = existing.failedCount + next.failedCount;
  const totalSuccess = Math.max(1, successCount);
  return {
    ...existing,
    ...next,
    successCount,
    failedCount,
    averageDurationMs: Math.round(
      (existing.averageDurationMs * existing.successCount + next.averageDurationMs * next.successCount) /
        totalSuccess
    ),
    confidence: Math.min(0.99, successCount / Math.max(1, successCount + failedCount))
  };
}
