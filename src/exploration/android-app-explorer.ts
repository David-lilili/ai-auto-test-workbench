import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  ExplorationMode,
  LoadedContext,
  PageEdgeMemory,
  PageElementMemory,
  PageNodeMemory
} from "../core/types.js";
import { logger } from "../core/logger.js";
import { PageGraphStore } from "../memory/page-graph-store.js";
import { KnowledgeStore } from "../memory/knowledge-store.js";

const execFileAsync = promisify(execFile);
const RISKY_TEXT = [
  "支付",
  "下单",
  "提交订单",
  "确认交易",
  "提现",
  "转账",
  "删除",
  "注销",
  "关闭账户",
  "confirm",
  "pay",
  "submit order",
  "withdraw",
  "transfer",
  "delete"
];

export interface AndroidExploreOptions {
  deviceId?: string;
  apk?: string;
  appPackage: string;
  appActivity?: string;
  mode: ExplorationMode;
  maxDepth: number;
  maxPages: number;
}

interface AndroidCandidate {
  role: string;
  text?: string;
  selector?: string;
  bounds: string;
  center: { x: number; y: number };
  riskLevel: "low" | "medium" | "high";
}

export class AndroidAppExplorer {
  private readonly store: PageGraphStore;
  private readonly knowledgeStore: KnowledgeStore;

  constructor(private readonly context: LoadedContext) {
    this.store = new PageGraphStore(context);
    this.knowledgeStore = new KnowledgeStore(context);
  }

  async explore(
    options: AndroidExploreOptions
  ): Promise<{ nodes: number; edges: number; graphPath: string; knowledgePath: string; knowledgeChunks: number }> {
    if (options.apk) await this.adb(options, ["install", "-r", options.apk]);
    await this.startApp(options);

    const queue: Array<{ path: AndroidCandidate[]; depth: number; fromPageId?: string; via?: AndroidCandidate }> = [
      { path: [], depth: 0 }
    ];
    const visited = new Set<string>();

    while (queue.length > 0 && visited.size < options.maxPages) {
      const current = queue.shift();
      if (!current) continue;
      await this.replayPath(options, current.path);
      const node = await this.captureNode(options);
      if (visited.has(node.pageId)) continue;
      visited.add(node.pageId);
      await this.store.upsertNode(node);
      logger.info("Explored app screen", { pageId: node.pageId, depth: current.depth, name: node.semanticName });

      if (current.fromPageId && current.via) {
        await this.store.upsertEdge(buildEdge(this.context.project.projectKey, current.fromPageId, node.pageId, current.via));
      }

      if (current.depth >= options.maxDepth) continue;
      for (const candidate of node.elements) {
        if (!candidate.selector) continue;
        const androidCandidate = JSON.parse(candidate.selector) as AndroidCandidate;
        queue.push({
          path: [...current.path, androidCandidate],
          depth: current.depth + 1,
          fromPageId: node.pageId,
          via: androidCandidate
        });
      }
    }

    const graph = await this.store.load();
    const graphPath = await this.store.save(graph);
    const knowledge = await this.knowledgeStore.syncPageGraph(graph);
    return {
      nodes: graph.nodes.length,
      edges: graph.edges.length,
      graphPath,
      knowledgePath: knowledge.knowledgePath,
      knowledgeChunks: knowledge.chunks
    };
  }

  private async startApp(options: AndroidExploreOptions): Promise<void> {
    if (options.appActivity) {
      await this.adb(options, ["shell", "am", "start", "-n", `${options.appPackage}/${options.appActivity}`]);
      return;
    }
    await this.adb(options, ["shell", "monkey", "-p", options.appPackage, "-c", "android.intent.category.LAUNCHER", "1"]);
  }

  private async replayPath(options: AndroidExploreOptions, path: AndroidCandidate[]): Promise<void> {
    await this.adb(options, ["shell", "am", "force-stop", options.appPackage]);
    await this.startApp(options);
    await sleep(1200);
    for (const step of path) {
      await this.adb(options, ["shell", "input", "tap", String(step.center.x), String(step.center.y)]);
      await sleep(800);
    }
  }

  private async captureNode(options: AndroidExploreOptions): Promise<PageNodeMemory> {
    await this.adb(options, ["shell", "uiautomator", "dump", "/sdcard/window_dump.xml"]);
    const xml = (await this.adb(options, ["shell", "cat", "/sdcard/window_dump.xml"])).stdout;
    const activity = await this.currentActivity(options);
    const elements = parseClickableElements(xml);
    const signature = `${activity}|${elements.map((item) => `${item.text}:${item.bounds}`).join("|")}`;
    const now = new Date().toISOString();
    return {
      pageId: stableId(signature),
      project: this.context.project.projectKey,
      platform: "app",
      surface: "mobileApp",
      url: activity,
      urlPattern: activity,
      title: activity,
      semanticName: activity,
      requiredPreconditions: inferPreconditions(elements),
      elements: elements.map((item) => ({
        elementId: stableId(`${signature}|${item.text}|${item.bounds}`),
        role: item.role,
        text: item.text,
        selector: JSON.stringify(item),
        riskLevel: item.riskLevel,
        lastSeenAt: now
      })),
      discoveredBy: "exploration",
      confidence: 0.65,
      visitCount: 1,
      lastSeenAt: now
    };
  }

  private async currentActivity(options: AndroidExploreOptions): Promise<string> {
    const output = (await this.adb(options, ["shell", "dumpsys", "window", "windows"])).stdout;
    const match = output.match(/mCurrentFocus=.*? ([^ ]+\/[^ }\]]+)/) ?? output.match(/mFocusedApp=.*? ([^ ]+\/[^ }\]]+)/);
    return match?.[1] ?? options.appPackage;
  }

  private adb(options: AndroidExploreOptions, args: string[]): Promise<{ stdout: string; stderr: string }> {
    const finalArgs = options.deviceId ? ["-s", options.deviceId, ...args] : args;
    return execFileAsync("adb", finalArgs, { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
  }
}

function parseClickableElements(xml: string): AndroidCandidate[] {
  const matches = xml.matchAll(/<node\b[^>]*>/g);
  const candidates: AndroidCandidate[] = [];
  for (const match of matches) {
    const node = match[0];
    if (!/clickable="true"/.test(node)) continue;
    const text = attr(node, "text") || attr(node, "content-desc") || attr(node, "resource-id");
    const bounds = attr(node, "bounds");
    if (!bounds) continue;
    const center = centerOf(bounds);
    if (!center) continue;
    candidates.push({
      role: attr(node, "class") || "android.view.View",
      text,
      bounds,
      center,
      riskLevel: classifyRisk(text)
    });
  }
  return candidates.slice(0, 80);
}

function buildEdge(project: string, fromPageId: string, toPageId: string, candidate: AndroidCandidate): PageEdgeMemory {
  return {
    edgeId: stableId([fromPageId, toPageId, candidate.text, candidate.bounds].join("|")),
    project,
    platform: "app",
    surface: "mobileApp",
    fromPageId,
    toPageId,
    action: {
      type: "click",
      selector: candidate.bounds,
      text: candidate.text
    },
    preconditions: [],
    riskLevel: candidate.riskLevel,
    successCount: 1,
    failedCount: 0,
    averageDurationMs: 800,
    confidence: 0.7,
    lastVerifiedAt: new Date().toISOString()
  };
}

function attr(node: string, name: string): string | undefined {
  const match = node.match(new RegExp(`${name}="([^"]*)"`));
  return match?.[1] ? decodeXml(match[1]) : undefined;
}

function centerOf(bounds: string): { x: number; y: number } | undefined {
  const match = bounds.match(/\[(\d+),(\d+)]\[(\d+),(\d+)]/);
  if (!match) return undefined;
  const [, left, top, right, bottom] = match.map(Number);
  return { x: Math.round((left + right) / 2), y: Math.round((top + bottom) / 2) };
}

function classifyRisk(text?: string): "low" | "medium" | "high" {
  const value = (text ?? "").toLowerCase();
  if (RISKY_TEXT.some((item) => value.includes(item.toLowerCase()))) return "high";
  if (/submit|save|create|update|edit|申请|保存|创建|修改|提交/i.test(value)) return "medium";
  return "low";
}

function inferPreconditions(elements: AndroidCandidate[]): string[] {
  const text = elements.map((item) => item.text ?? "").join(" ");
  const preconditions: string[] = [];
  if (/登录|login|sign in/i.test(text)) preconditions.push("user.not_logged_in_or_session_expired");
  if (/kyc|身份认证|实名认证/i.test(text)) preconditions.push("user.kyc_required");
  return preconditions;
}

function decodeXml(value: string): string {
  return value
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function stableId(value: string): string {
  return crypto.createHash("sha1").update(value).digest("hex").slice(0, 16);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
