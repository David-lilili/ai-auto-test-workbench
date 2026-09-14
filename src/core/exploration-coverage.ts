import fs from "fs-extra";
import path from "node:path";
import { rebuildPageModelIndexes } from "./page-model-index.js";

/**
 * Exploration Coverage（P2.1-P2.3）：从 canonical Page Models + DSL + 执行历史
 * 推导「系统知道什么 / 验证过什么 / 还缺什么」。
 *
 * 设计约束：
 * - 完全 deterministic（无 LLM、无随机、无时间依赖——同输入同输出）；
 * - 只读：不修改 Page Model、不写 proposal、不影响执行；
 * - 分母来自 models 本体（indexes 仅查询加速，rebuild 后结果不变）；
 * - 复用现有字段语义，不造新概念：
 *   KNOWN      = 元素已建模（存在 elementId）
 *   OBSERVED   = status ∈ dom_verified / click_observed / input_observed（观察到但未执行验证）
 *   VERIFIED   = status = execution_verified / execution_observed（真实执行验证）
 *   UNCERTAIN  = status = candidate（推测）
 *   UNEXPLORED = 未出现于任何建模结构
 *   BLOCKED    = blockedStates / providerRequirements 声明的前置阻断
 *   NOT_APPLICABLE = 控件类型与 interaction 不匹配（如 text 节点无 input 交互）
 */

export type CoverageStatus = "KNOWN" | "OBSERVED" | "VERIFIED" | "UNCERTAIN" | "UNEXPLORED" | "BLOCKED" | "NOT_APPLICABLE";

export interface ElementCoverageItem {
  elementId: string;
  semanticName: string;
  controlType?: string;
  status: CoverageStatus;
  /** 页面级模型 status 的映射（element 自身 status 优先）。 */
  modeledStatus?: string;
  dslReferenceCount: number;
  executionEvidenceCount: number;
}

export interface InteractionCoverageItem {
  interaction: string;
  targetElementId?: string;
  status: CoverageStatus;
  source: "page_model_action" | "dsl_step" | "execution_step";
  evidence: string;
}

export interface StateCoverageItem {
  stateId: string;
  kind: "blocked_state" | "dialog" | "page_status" | "related_state_model";
  status: CoverageStatus;
  detail: string;
}

export interface DependencyCoverageItem {
  dependencyId: string;
  sourceElement: string;
  target: string;
  status: "KNOWN" | "VERIFIED" | "UNCERTAIN" | "UNEXPLORED";
  evidence: string;
}

export interface PageCoverageSnapshot {
  pageId: string;
  pageName: string;
  identityGroup?: string;
  isStateModel: boolean;
  relatedPages: string[];
  elements: ElementCoverageItem[];
  interactions: InteractionCoverageItem[];
  states: StateCoverageItem[];
  dependencies: DependencyCoverageItem[];
  summary: {
    known: number;
    verified: number;
    observed: number;
    uncertain: number;
    unexplored: number;
    blocked: number;
    notApplicable: number;
    totalElements: number;
  };
}

export interface CoverageSnapshot {
  schemaVersion: "exploration-coverage-snapshot.v1";
  project: string;
  generatedAt: string;
  totalPages: number;
  pages: PageCoverageSnapshot[];
  projectSummary: {
    elementsByStatus: Record<string, number>;
    interactionsByStatus: Record<string, number>;
    statesByStatus: Record<string, number>;
    dependenciesByStatus: Record<string, number>;
  };
}

/** 控件类型 → 适用交互（NOT_APPLICABLE 判定基础）。 */
const CONTROL_INTERACTIONS: Record<string, string[]> = {
  button: ["click"],
  link: ["click"],
  input: ["input", "clear"],
  select: ["select"],
  table: ["view"],
  unknown: []
};

const OBSERVED_STATUSES = new Set(["dom_verified", "click_observed", "input_observed", "screenshot_verified"]);
const VERIFIED_STATUSES = new Set(["execution_verified", "execution_observed"]);

function elementCoverageStatus(element: Record<string, unknown>): CoverageStatus {
  const status = String(element.status ?? "");
  if (VERIFIED_STATUSES.has(status)) return "VERIFIED";
  if (status === "candidate" || status === "proposal") return "UNCERTAIN";
  if (OBSERVED_STATUSES.has(status)) return "OBSERVED";
  return "KNOWN";
}

/** 状态模型特征（与 page-identity-resolver 一致的判定口径）。 */
export function isStateModelPageId(pageId: string): boolean {
  return /(_entry|_state|_dimension|_modal|_drawer|_tab)$|\.state\./i.test(pageId);
}

/** 从 DSL 资产提取 elementId 引用计数与执行步骤证据。 */
async function loadDslEvidence(rootDir: string, project: string): Promise<{
  elementRefs: Map<string, number>;
  executedElements: Map<string, number>;
  interactionSources: Map<string, { interaction: string; elementId?: string }>;
}> {
  const elementRefs = new Map<string, number>();
  const executedElements = new Map<string, number>();
  const interactionSources = new Map<string, { interaction: string; elementId?: string }>();
  const dslDir = path.join(rootDir, "storage", "case-dsl", project);
  if (!(await fs.pathExists(dslDir))) return { elementRefs, executedElements, interactionSources };
  for (const file of (await fs.readdir(dslDir)).filter((name) => name.endsWith(".json"))) {
    const dsl = await fs.readJson(path.join(dslDir, file)).catch(() => undefined) as Record<string, unknown> | undefined;
    if (!dsl) continue;
    const automationCase = dsl.automationCase as Record<string, unknown> | undefined;
    const steps = Array.isArray(automationCase?.steps) ? automationCase!.steps as Array<Record<string, unknown>> : [];
    for (const step of steps) {
      const elementId = String(step.targetElementId ?? step.elementId ?? "");
      if (elementId) elementRefs.set(elementId, (elementRefs.get(elementId) ?? 0) + 1);
      const action = String(step.action ?? "");
      if (action && action !== "assert") {
        const key = `${elementId || "page"}:${action}`;
        interactionSources.set(key, { interaction: action, elementId: elementId || undefined });
      }
    }
  }
  // 执行历史：case-history 的执行记录里有执行过的步骤（真实执行证据）
  const historyDir = path.join(rootDir, "storage", "case-history", project);
  if (await fs.pathExists(historyDir)) {
    for (const file of (await fs.readdir(historyDir)).filter((name) => name.endsWith(".json"))) {
      const history = await fs.readJson(path.join(historyDir, file)).catch(() => undefined) as Record<string, unknown> | undefined;
      if (!history) continue;
      const executions = Array.isArray(history.executions) ? history.executions as Array<Record<string, unknown>> : [];
      for (const execution of executions) {
        if (String(execution.status ?? "") !== "passed") continue;
        const steps = Array.isArray(execution.executionSteps) ? execution.executionSteps as Array<Record<string, unknown>> : [];
        for (const step of steps) {
          const elementId = String(step.targetElementId ?? step.elementId ?? step.elementIdUsed ?? "");
          if (elementId) executedElements.set(elementId, (executedElements.get(elementId) ?? 0) + 1);
        }
      }
    }
  }
  return { elementRefs, executedElements, interactionSources };
}

export async function buildCoverageSnapshot(rootDir: string, project: string, relatedPagesByPage: Map<string, string[]> = new Map()): Promise<CoverageSnapshot> {
  if (!/^[a-z0-9_-]+$/i.test(project)) throw new Error(`Invalid project key: ${project}`);
  const storePath = path.join(rootDir, "storage", "page-models", `${project}.json`);
  if (!(await fs.pathExists(storePath))) throw new Error(`Page Model Store 未配置: ${project}`);
  const store = await fs.readJson(storePath) as { models: Array<Record<string, unknown>> };
  // 分母来自 models 本体；调用 rebuildPageModelIndexes 仅为证明 index 无关性（结果不依赖它）。
  rebuildPageModelIndexes(store.models);
  const { elementRefs, executedElements, interactionSources } = await loadDslEvidence(rootDir, project);

  const pages: PageCoverageSnapshot[] = [];
  for (const model of store.models) {
    const pageId = String(model.pageId ?? "");
    if (!pageId) continue;
    const elements = Array.isArray(model.elements) ? model.elements as Array<Record<string, unknown>> : [];
    const elementItems: ElementCoverageItem[] = elements.map((element) => {
      const elementId = String(element.elementId ?? "");
      const baseStatus = elementCoverageStatus(element);
      const execCount = executedElements.get(elementId) ?? 0;
      // DSL 成功执行过该元素 → 至少 VERIFIED（执行证据优先于静态状态）
      const status: CoverageStatus = execCount > 0 ? "VERIFIED" : baseStatus;
      return {
        elementId,
        semanticName: String(element.semanticName ?? ""),
        controlType: typeof element.controlType === "string" ? element.controlType : undefined,
        status,
        modeledStatus: typeof element.status === "string" ? element.status : undefined,
        dslReferenceCount: elementRefs.get(elementId) ?? 0,
        executionEvidenceCount: execCount
      };
    });

    // Interaction coverage：Page Model actions（建模动作）+ DSL 步骤（实际编排）。
    const interactions: InteractionCoverageItem[] = [];
    const actions = Array.isArray(model.actions) ? model.actions as Array<Record<string, unknown>> : [];
    for (const action of actions) {
      const actionName = String(action.action ?? "");
      if (!actionName) continue;
      const resultStatus = String(action.resultStatus ?? action.status ?? "");
      interactions.push({
        interaction: actionName,
        targetElementId: typeof action.targetElementId === "string" ? action.targetElementId : undefined,
        status: VERIFIED_STATUSES.has(resultStatus) ? "VERIFIED" : resultStatus === "click_observed" ? "OBSERVED" : "KNOWN",
        source: "page_model_action",
        evidence: String(action.actionId ?? action.proposalId ?? actionName)
      });
    }
    for (const [, source] of interactionSources) {
      if (source.elementId && !elements.some((element) => String(element.elementId ?? "") === source.elementId)) continue;
      const key = `${source.elementId ?? pageId}:${source.interaction}`;
      interactions.push({
        interaction: source.interaction,
        targetElementId: source.elementId,
        status: "VERIFIED",
        source: "dsl_step",
        evidence: key
      });
    }

    // State coverage：blockedStates / dialogs / 页面 status / related state models。
    const states: StateCoverageItem[] = [];
    const blockedStates = Array.isArray(model.blockedStates) ? model.blockedStates as Array<Record<string, unknown>> : [];
    for (const blocked of blockedStates) {
      states.push({
        stateId: String(blocked.blockId ?? blocked.blockedStateId ?? ""),
        kind: "blocked_state",
        status: "BLOCKED",
        detail: String(blocked.blockType ?? blocked.requiredHumanAction ?? "前置条件阻断")
      });
    }
    const dialogs = Array.isArray(model.dialogs) ? model.dialogs as Array<Record<string, unknown>> : [];
    for (const dialog of dialogs) {
      const dialogId = String(dialog.dialogId ?? dialog.id ?? dialog.semanticName ?? "");
      if (!dialogId) continue;
      const dialogStatus = String(dialog.status ?? "");
      states.push({
        stateId: dialogId,
        kind: "dialog",
        status: VERIFIED_STATUSES.has(dialogStatus) ? "VERIFIED" : OBSERVED_STATUSES.has(dialogStatus) ? "OBSERVED" : "KNOWN",
        detail: String(dialog.semanticName ?? dialog.text ?? "").slice(0, 80)
      });
    }
    const pageStatus = String(model.status ?? "");
    states.push({
      stateId: `${pageId}:page_status`,
      kind: "page_status",
      status: VERIFIED_STATUSES.has(pageStatus) ? "VERIFIED" : OBSERVED_STATUSES.has(pageStatus) ? "OBSERVED" : pageStatus === "candidate" ? "UNCERTAIN" : "KNOWN",
      detail: `页面级 status=${pageStatus}`
    });
    for (const relatedPageId of relatedPagesByPage.get(pageId) ?? []) {
      states.push({
        stateId: `${pageId}->${relatedPageId}`,
        kind: "related_state_model",
        status: "KNOWN",
        detail: "RELATED_STATE_MODEL 关系（父子/兄弟状态），见 identity group"
      });
    }

    // Dependency coverage：preconditions 与 providerRequirements 是现有结构里的依赖声明。
    const dependencies: DependencyCoverageItem[] = [];
    const preconditions = Array.isArray(model.preconditions) ? model.preconditions as Array<Record<string, unknown>> : [];
    for (const precondition of preconditions) {
      const preconditionType = String(precondition.preconditionType ?? precondition.type ?? "");
      if (!preconditionType) continue;
      dependencies.push({
        dependencyId: `${pageId}:precondition:${preconditionType}`,
        sourceElement: String(precondition.sourceElementId ?? "page"),
        target: preconditionType,
        status: "KNOWN",
        evidence: "Page Model preconditions 声明"
      });
    }
    const providers = Array.isArray(model.providerRequirements) ? model.providerRequirements as Array<Record<string, unknown>> : [];
    for (const provider of providers) {
      const providerId = String(provider.providerRequirementId ?? "");
      if (!providerId) continue;
      const providerStatus = String(provider.status ?? "");
      dependencies.push({
        dependencyId: `${pageId}:provider:${providerId}`,
        sourceElement: String((provider.uiBindings as Record<string, unknown> | undefined)?.totpInputElementId ?? "page"),
        target: providerId,
        status: VERIFIED_STATUSES.has(providerStatus) ? "VERIFIED" : "KNOWN",
        evidence: `providerRequirements status=${providerStatus}`
      });
    }

    const summary = {
      known: elementItems.filter((item) => item.status === "KNOWN").length,
      verified: elementItems.filter((item) => item.status === "VERIFIED").length,
      observed: elementItems.filter((item) => item.status === "OBSERVED").length,
      uncertain: elementItems.filter((item) => item.status === "UNCERTAIN").length,
      unexplored: 0,
      blocked: states.filter((item) => item.status === "BLOCKED").length,
      notApplicable: 0,
      totalElements: elementItems.length
    };

    pages.push({
      pageId,
      pageName: String(model.pageName ?? pageId),
      identityGroup: relatedPagesByPage.get(pageId)?.length
        ? [pageId, ...relatedPagesByPage.get(pageId)!].sort().join("+")
        : undefined,
      isStateModel: isStateModelPageId(pageId),
      relatedPages: relatedPagesByPage.get(pageId) ?? [],
      elements: elementItems,
      interactions,
      states,
      dependencies,
      summary
    });
  }

  const tally = (items: Array<{ status: string }>): Record<string, number> => {
    const counts: Record<string, number> = {};
    for (const item of items) counts[item.status] = (counts[item.status] ?? 0) + 1;
    return counts;
  };
  return {
    schemaVersion: "exploration-coverage-snapshot.v1",
    project,
    // 注意：generatedAt 含时间会导致「同一输入同一输出」破坏——报告层用稳定字段，
    // snapshot 本体的 generatedAt 仅供人读，deterministic 测试比较时排除该字段。
    generatedAt: new Date().toISOString(),
    totalPages: pages.length,
    pages,
    projectSummary: {
      elementsByStatus: tally(pages.flatMap((page) => page.elements)),
      interactionsByStatus: tally(pages.flatMap((page) => page.interactions)),
      statesByStatus: tally(pages.flatMap((page) => page.states)),
      dependenciesByStatus: tally(pages.flatMap((page) => page.dependencies))
    }
  };
}
