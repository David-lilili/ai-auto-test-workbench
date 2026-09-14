import path from "node:path";
import crypto from "node:crypto";
import fs from "fs-extra";
import type {
  AutomationCase,
  BusinessFlow,
  KnowledgeBase,
  KnowledgeChunk,
  LoadedContext,
  PageEdgeMemory,
  PageGraphMemory,
  PageNodeMemory,
  PageState,
  PageTransition,
  SmartElement
} from "../core/types.js";
import { writeSafeJsonFile } from "../core/safe-file-writer.js";

export class KnowledgeStore {
  private readonly knowledgePath: string;

  constructor(private readonly context: LoadedContext) {
    const configured = context.workspace.storage?.knowledgePath ?? "storage/knowledge";
    this.knowledgePath = path.join(context.rootDir, configured, `${context.project.projectKey}.json`);
  }

  async load(): Promise<KnowledgeBase> {
    if (!(await fs.pathExists(this.knowledgePath))) {
      return {
        project: this.context.project.projectKey,
        updatedAt: new Date().toISOString(),
        chunks: []
      };
    }
    return (await fs.readJson(this.knowledgePath)) as KnowledgeBase;
  }

  async save(base: KnowledgeBase): Promise<string> {
    base.updatedAt = new Date().toISOString();
    await writeSafeJsonFile(this.knowledgePath, base);
    return this.knowledgePath;
  }

  async syncPageGraph(graph: PageGraphMemory): Promise<{ knowledgePath: string; chunks: number }> {
    const base = await this.load();
    const nonGraphChunks = base.chunks.filter((item) => item.sourceType !== "page_graph");
    const graphChunks = buildPageGraphChunks(graph);
    base.chunks = [...nonGraphChunks, ...graphChunks];
    const knowledgePath = await this.save(base);
    return { knowledgePath, chunks: graphChunks.length };
  }

  async syncFormalAssets(input: {
    pages: PageState[];
    transitions: PageTransition[];
    elements: SmartElement[];
    dslCases: AutomationCase[];
    sourceScanId?: string;
  }): Promise<{ knowledgePath: string; chunks: number }> {
    const base = await this.load();
    const sourceIds = new Set<string>([
      ...input.pages.map((item) => item.page_id),
      ...input.transitions.map((item) => item.transition_id),
      ...input.elements.map((item) => item.element_id),
      ...input.dslCases.map((item) => item.id)
    ]);
    const retained = base.chunks.filter((item) => item.sourceType !== "formal_asset" || !sourceIds.has(item.sourceId));
    const updatedAt = new Date().toISOString();
    const chunks = [
      ...input.pages.map((item) => formalPageChunk(item, updatedAt, input.sourceScanId)),
      ...input.transitions.map((item) => formalTransitionChunk(item, input.pages, updatedAt, input.sourceScanId)),
      ...input.elements.map((item) => formalElementChunk(item, updatedAt, input.sourceScanId)),
      ...input.dslCases.map((item) => formalDslChunk(item, updatedAt, input.sourceScanId))
    ];
    base.chunks = [...retained, ...chunks];
    const knowledgePath = await this.save(base);
    return { knowledgePath, chunks: chunks.length };
  }

  async syncBusinessFlows(flows: BusinessFlow[]): Promise<{ knowledgePath: string; chunks: number }> {
    const base = await this.load();
    const ids = new Set(flows.map((item) => item.flow_id));
    const retained = base.chunks.filter((item) => item.sourceType !== "business_flow" || !ids.has(item.sourceId));
    const updatedAt = new Date().toISOString();
    const chunks = flows.map((item) => businessFlowChunk(item, updatedAt));
    base.chunks = [...retained, ...chunks];
    const knowledgePath = await this.save(base);
    return { knowledgePath, chunks: chunks.length };
  }

  async search(query: string, limit = 20): Promise<KnowledgeChunk[]> {
    const base = await this.load();
    const terms = tokenize(query);
    return base.chunks
      .map((chunk) => ({ chunk, score: scoreChunk(chunk, terms) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || b.chunk.updatedAt.localeCompare(a.chunk.updatedAt))
      .slice(0, limit)
      .map((item) => item.chunk);
  }
}

function businessFlowChunk(flow: BusinessFlow, updatedAt: string): KnowledgeChunk {
  const title = `业务流：${flow.name}`;
  const content = [
    `项目 ${flow.project_id} ${flow.env} 的业务流资产。`,
    `目标：${flow.target_flows.join("、")}`,
    flow.preconditions.length ? `前置条件：${flow.preconditions.join("、")}` : undefined,
    `路径数：${flow.transition_ids.length}，DSL 用例数：${flow.dsl_case_ids.length}`,
    `风险等级：${flow.risk_level}，置信度：${flow.confidence_score}`,
    `Replay：${flow.replay_status}，Review：${flow.review_status}，Promote：${flow.promote_status}`
  ]
    .filter(Boolean)
    .join("\n");
  return {
    chunkId: stableId(`business_flow|${flow.project_id}|${flow.flow_id}`),
    project: flow.project_id,
    sourceType: "business_flow",
    sourceId: flow.flow_id,
    platform: flow.platform === "web" ? "web" : "app",
    title,
    content,
    keywords: uniqueKeywords([title, content, flow.name, ...flow.target_flows, ...flow.preconditions]),
    confidence: flow.confidence_score,
    updatedAt,
    metadata: { kind: "business_flow", sourceScanId: flow.source_scan_id, flow }
  };
}

function formalPageChunk(page: PageState, updatedAt: string, sourceScanId?: string): KnowledgeChunk {
  const title = `正式页面：${page.page_name ?? page.title ?? page.url_pattern ?? page.activity_name ?? page.page_id}`;
  const content = [
    `项目 ${page.project_id} 的正式页面资产。`,
    `页面名称：${page.page_name ?? page.title ?? page.page_id}`,
    page.page_type ? `页面类型：${page.page_type}` : undefined,
    page.url_pattern ? `URL 模式：${page.url_pattern}` : undefined,
    page.activity_name ? `Activity：${page.activity_name}` : undefined,
    page.required_preconditions?.length ? `前置条件：${page.required_preconditions.join("、")}` : undefined,
    page.known_elements.length ? `关键元素：${page.known_elements.slice(0, 30).join("、")}` : undefined,
    `置信度：${page.confidence_score ?? 0}，访问次数：${page.visit_count ?? 0}`
  ]
    .filter(Boolean)
    .join("\n");
  return {
    chunkId: stableId(`formal_page|${page.project_id}|${page.page_id}`),
    project: page.project_id,
    sourceType: "formal_asset",
    sourceId: page.page_id,
    platform: page.platform === "web" ? "web" : "app",
    title,
    content,
    keywords: uniqueKeywords([title, content, page.page_type, page.url_pattern, page.activity_name, ...(page.known_elements ?? [])]),
    confidence: page.confidence_score ?? 0.7,
    updatedAt,
    metadata: { kind: "formal_page", sourceScanId, page }
  };
}

function formalTransitionChunk(
  transition: PageTransition,
  pages: PageState[],
  updatedAt: string,
  sourceScanId?: string
): KnowledgeChunk {
  const from = pages.find((item) => item.page_id === transition.from_page_id);
  const to = pages.find((item) => item.page_id === transition.to_page_id);
  const project = from?.project_id ?? to?.project_id ?? "";
  const title = `正式路径：${from?.page_name ?? transition.from_page_id} -> ${to?.page_name ?? transition.to_page_id}`;
  const content = [
    `从 ${from?.page_name ?? transition.from_page_id} 到 ${to?.page_name ?? transition.to_page_id}`,
    `动作：${transition.action_description}`,
    `成功 ${transition.success_count} 次，失败 ${transition.failure_count} 次，平均耗时 ${transition.average_duration_ms}ms`,
    `置信度：${transition.confidence_score}`
  ].join("\n");
  return {
    chunkId: stableId(`formal_transition|${project}|${transition.transition_id}`),
    project,
    sourceType: "formal_asset",
    sourceId: transition.transition_id,
    platform: from?.platform === "web" ? "web" : "app",
    title,
    content,
    keywords: uniqueKeywords([title, content, transition.action_description]),
    confidence: transition.confidence_score,
    updatedAt,
    metadata: { kind: "formal_transition", sourceScanId, transition }
  };
}

function formalElementChunk(element: SmartElement, updatedAt: string, sourceScanId?: string): KnowledgeChunk {
  const title = `正式元素：${element.semantic_name}`;
  const content = [
    `元素语义：${element.semantic_name}`,
    element.semantic_role ? `语义角色：${element.semantic_role}` : undefined,
    `元素类型：${element.element_type}`,
    element.primary_locator ? `主定位：${element.primary_locator}` : undefined,
    element.fallback_locators.length ? `备用定位：${element.fallback_locators.join("、")}` : undefined,
    element.text_candidates.length ? `候选文本：${element.text_candidates.join("、")}` : undefined,
    `成功 ${element.success_count} 次，失败 ${element.failure_count} 次，置信度 ${element.confidence_score}`
  ]
    .filter(Boolean)
    .join("\n");
  return {
    chunkId: stableId(`formal_element|${element.project_id}|${element.element_id}`),
    project: element.project_id,
    sourceType: "formal_asset",
    sourceId: element.element_id,
    platform: element.platform === "web" ? "web" : "app",
    title,
    content,
    keywords: uniqueKeywords([title, content, element.semantic_name, element.semantic_role, element.primary_locator, ...element.fallback_locators]),
    confidence: element.confidence_score,
    updatedAt,
    metadata: { kind: "formal_element", sourceScanId, element }
  };
}

function formalDslChunk(testCase: AutomationCase, updatedAt: string, sourceScanId?: string): KnowledgeChunk {
  const title = `正式 DSL：${testCase.title}`;
  const content = [
    `用例：${testCase.id}`,
    `模块：${testCase.module}`,
    `标签：${testCase.tags.join("、")}`,
    `步骤：${testCase.steps.map((item) => `${item.action}:${item.semantic_target ?? item.target ?? item.primary_locator ?? ""}`).join(" -> ")}`,
    `断言：${testCase.assertions.map((item) => `${item.type}:${item.target ?? item.expected ?? ""}`).join("、")}`
  ].join("\n");
  return {
    chunkId: stableId(`formal_dsl|${testCase.project}|${testCase.id}`),
    project: testCase.project,
    sourceType: "formal_asset",
    sourceId: testCase.id,
    platform: testCase.type === "web" ? "web" : "app",
    title,
    content,
    keywords: uniqueKeywords([title, content, testCase.module, ...testCase.tags]),
    confidence: 0.8,
    updatedAt,
    metadata: { kind: "formal_dsl", sourceScanId, testCase }
  };
}

function buildPageGraphChunks(graph: PageGraphMemory): KnowledgeChunk[] {
  const nodesById = new Map(graph.nodes.map((node) => [node.pageId, node]));
  return [
    ...graph.nodes.map((node) => nodeChunk(node, graph.updatedAt)),
    ...graph.edges.map((edge) => edgeChunk(edge, nodesById, graph.updatedAt))
  ];
}

function nodeChunk(node: PageNodeMemory, updatedAt: string): KnowledgeChunk {
  const topElements = node.elements
    .slice(0, 30)
    .map((item) => item.text || item.href || item.selector || item.role)
    .filter(Boolean);
  const locatorElements = node.elements
    .filter((item) => item.selector)
    .slice(0, 50)
    .map((item) => ({
      role: item.role,
      text: item.text,
      selector: item.selector,
      href: item.href,
      inputType: item.inputType,
      name: item.name,
      placeholder: item.placeholder,
      riskLevel: item.riskLevel
    }));
  const inputElements = node.elements
    .filter((item) => ["input", "textarea", "select", "textbox", "combobox"].includes(item.role) || item.name || item.placeholder)
    .slice(0, 30)
    .map((item) => `${item.role}${item.name ? `[name=${item.name}]` : ""}${item.placeholder ? `[placeholder=${item.placeholder}]` : ""}${item.selector ? ` => ${item.selector}` : ""}`);
  const executableLocators = locatorElements
    .slice(0, 30)
    .map((item) => `${item.role}${item.text ? `:${item.text}` : ""}${item.name ? `[name=${item.name}]` : ""}${item.placeholder ? `[placeholder=${item.placeholder}]` : ""} => ${item.selector}`);
  const title = `${surfaceName(node.surface)}页面：${node.semanticName ?? node.title ?? node.url ?? node.pageId}`;
  const content = [
    `项目 ${node.project} 的 ${surfaceName(node.surface)} ${node.platform} 页面。`,
    `页面名称：${node.semanticName ?? node.title ?? node.pageId}。`,
    node.url ? `地址或 Activity：${node.url}。` : undefined,
    node.urlPattern ? `地址模式：${node.urlPattern}。` : undefined,
    node.requiredPreconditions.length > 0 ? `前置条件：${node.requiredPreconditions.join("、")}。` : undefined,
    topElements.length > 0 ? `主要可交互元素：${topElements.join("、")}。` : undefined,
    inputElements.length > 0 ? `表单/输入元素：${inputElements.join("、")}。` : undefined,
    executableLocators.length > 0 ? `可执行定位：${executableLocators.join("、")}。` : undefined,
    `探索次数：${node.visitCount}，置信度：${node.confidence}。`
  ]
    .filter(Boolean)
    .join("\n");

  return {
    chunkId: stableId(`page_graph_node|${node.project}|${node.pageId}`),
    project: node.project,
    sourceType: "page_graph",
    sourceId: node.pageId,
    platform: node.platform,
    surface: node.surface,
    title,
    content,
    keywords: uniqueKeywords([
      node.semanticName,
      node.title,
      node.url,
      node.urlPattern,
      node.surface,
      ...node.requiredPreconditions,
      ...topElements,
      ...locatorElements.map((item) => item.selector)
    ]),
    confidence: node.confidence,
    updatedAt,
    metadata: {
      kind: "page_node",
      pageId: node.pageId,
      url: node.url,
      urlPattern: node.urlPattern,
      elementCount: node.elements.length,
      locators: locatorElements,
      visitCount: node.visitCount
    }
  };
}

function edgeChunk(edge: PageEdgeMemory, nodesById: Map<string, PageNodeMemory>, updatedAt: string): KnowledgeChunk {
  const from = nodesById.get(edge.fromPageId);
  const to = nodesById.get(edge.toPageId);
  const actionText = edge.action.text || edge.action.href || edge.action.selector || edge.action.type;
  const title = `${surfaceName(edge.surface)}路径：${from?.semanticName ?? edge.fromPageId} -> ${
    to?.semanticName ?? edge.toPageId
  }`;
  const content = [
    `项目 ${edge.project} 的 ${surfaceName(edge.surface)} ${edge.platform} 路径。`,
    `从 ${from?.semanticName ?? edge.fromPageId} 到 ${to?.semanticName ?? edge.toPageId}。`,
    `触发动作：${edge.action.type} ${actionText ?? ""}。`,
    edge.preconditions.length > 0 ? `前置条件：${edge.preconditions.join("、")}。` : undefined,
    `风险等级：${edge.riskLevel}。成功 ${edge.successCount} 次，失败 ${edge.failedCount} 次，平均耗时 ${edge.averageDurationMs}ms，置信度 ${edge.confidence}。`
  ]
    .filter(Boolean)
    .join("\n");

  return {
    chunkId: stableId(`page_graph_edge|${edge.project}|${edge.edgeId}`),
    project: edge.project,
    sourceType: "page_graph",
    sourceId: edge.edgeId,
    platform: edge.platform,
    surface: edge.surface,
    title,
    content,
    keywords: uniqueKeywords([
      from?.semanticName,
      to?.semanticName,
      from?.url,
      to?.url,
      edge.surface,
      edge.action.text,
      edge.action.href,
      edge.action.selector,
      edge.riskLevel,
      ...edge.preconditions
    ]),
    confidence: edge.confidence,
    updatedAt,
    metadata: {
      kind: "page_edge",
      edgeId: edge.edgeId,
      fromPageId: edge.fromPageId,
      toPageId: edge.toPageId,
      action: edge.action,
      successCount: edge.successCount,
      failedCount: edge.failedCount
    }
  };
}

function scoreChunk(chunk: KnowledgeChunk, terms: string[]): number {
  if (terms.length === 0) return 0;
  const haystack = `${chunk.title}\n${chunk.content}\n${chunk.keywords.join("\n")}`.toLowerCase();
  return terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
}

function tokenize(text: string): string[] {
  return [
    ...new Set(
      text
        .toLowerCase()
        .split(/[^\p{L}\p{N}_-]+/u)
        .map((item) => item.trim())
        .filter((item) => item.length >= 2)
    )
  ];
}

function uniqueKeywords(values: Array<unknown>): string[] {
  return [...new Set(values.flatMap((value) => tokenize(String(value ?? ""))))].slice(0, 80);
}

function stableId(value: string): string {
  return crypto.createHash("sha1").update(value).digest("hex").slice(0, 16);
}

function surfaceName(surface: unknown): string {
  if (surface === "spotAdmin") return "现货后台";
  if (surface === "site") return "用户站点";
  if (surface === "mobileApp") return "App";
  return "未知站点";
}
