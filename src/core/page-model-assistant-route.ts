import fs from "fs-extra";
import path from "node:path";
import { planPageModelExecution, type PageModelExecutionPlan } from "./page-model-execution-planner.js";
import { formatLocalizedPageModelGaps, localizePageModelGaps } from "./page-model-gap-localization.js";

export interface PageModelAssistantRouteResult {
  route: "page_model";
  storePath: string;
  plan: PageModelExecutionPlan;
  canExecute: boolean;
  chineseMessage: string;
}

export interface PageModelAssistantRouteUnavailable {
  route: "unavailable";
  reason: string;
}

export type PageModelAssistantRouteDecision = PageModelAssistantRouteResult | PageModelAssistantRouteUnavailable;

export async function planAssistantRequestWithPageModels(input: {
  rootDir: string;
  project: string;
  env: string;
  message: string;
  assertions?: string[];
  deepSeekIntent?: unknown;
}): Promise<PageModelAssistantRouteDecision> {
  const storePath = path.join(input.rootDir, "storage", "page-models", `${input.project}.json`);
  const operationManualStorePath = path.join(input.rootDir, "storage", "operation-manuals", `${input.project}.json`);
  if (!(await fs.pathExists(storePath))) {
    return {
      route: "unavailable",
      reason: `\u9879\u76ee ${input.project} \u5c1a\u672a\u5efa\u7acb Page Model Store\u3002`
    };
  }

  const plan = await planPageModelExecution({
    request: input.message,
    pageModelStorePath: storePath,
    operationManualStorePath,
    project: input.project,
    env: input.env,
    assertions: input.assertions,
    deepSeekIntent: input.deepSeekIntent
  });
  applyAssistantRouteEvidenceHygiene(plan);

  return {
    route: "page_model",
    storePath,
    plan,
    canExecute: plan.executable,
    chineseMessage: renderChineseReadinessMessage(plan)
  };
}

function applyAssistantRouteEvidenceHygiene(plan: PageModelExecutionPlan): void {
  const intent = plan.selection.intent;
  if (intent.module !== "asset" || intent.action !== "spot_fund_flow_filter" || typeof intent.data.type !== "string") {
    return;
  }
  const requestedType = normalizeEvidenceText(intent.data.type);
  plan.selection.fallbackEvidence = plan.selection.fallbackEvidence.filter((item) => {
    const text = normalizeEvidenceText(`${item.id} ${item.semanticName ?? ""}`);
    if (text.includes(requestedType)) return true;
    if (requestedType !== normalizeEvidenceText("\u8d60\u5e01") && (text.includes("gift") || text.includes("\u8d60\u5e01"))) return false;
    if (requestedType !== normalizeEvidenceText("\u7ea2\u5305\u53d1\u653e") && text.includes("\u7ea2\u5305\u53d1\u653e")) return false;
    return true;
  });
}

function normalizeEvidenceText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, "");
}

export function renderChineseReadinessMessage(plan: PageModelExecutionPlan): string {
  const intent = plan.selection.intent;
  if (plan.executable) {
    return `Page Model \u89c4\u5212\u901a\u8fc7\uff1amodule=${intent.module}, action=${intent.action}, operationType=${intent.operationType}\uff0c\u53ef\u751f\u6210\u5e76\u6267\u884c DSL\u3002`;
  }
  if (intent.module === "unknown") {
    return [
      "\u5f53\u524d\u9700\u6c42\u6ca1\u6709\u5339\u914d\u5230\u5df2\u5efa\u6a21\u6a21\u5757\u3002",
      "\u5e73\u53f0\u5df2\u963b\u6b62\u56de\u843d\u5230\u65e7\u4e1a\u52a1\u6d41\uff0c\u907f\u514d\u6267\u884c\u9519\u8bef\u6a21\u5757\u3002",
      "\u8bf7\u5148\u8865\u5145\u8be5\u6a21\u5757\u7684 Page Model / NavigationEdge / Element / ObservableSignal\u3002"
    ].join("\n");
  }
  return [
    `\u5f53\u524d\u9700\u6c42\u5df2\u8bc6\u522b\u4e3a module=${intent.module}, action=${intent.action}, operationType=${intent.operationType}\uff0c\u4f46 Page Model \u8bc1\u636e\u4e0d\u8db3\u3002`,
    plan.gaps.length ? `\u7f3a\u53e3\uff1a${formatLocalizedPageModelGaps(plan.gaps)}` : "\u7f3a\u53e3\uff1a\u672a\u660e\u786e\uff0c\u9700\u8981\u68c0\u67e5 Page Model evidence\u3002",
    plan.blockingGaps.length ? `\u963b\u585e\u7f3a\u53e3\uff1a${formatLocalizedPageModelGaps(plan.blockingGaps)}` : "\u963b\u585e\u7f3a\u53e3\uff1a\u65e0\u3002",
    "\u5e73\u53f0\u5df2\u751f\u6210\u5931\u8d25/\u7f3a\u53e3\u5305\uff0c\u540e\u7eed\u53ef\u57fa\u4e8e\u8be5\u5305\u8865\u91c7\u5efa\u6a21\u3002"
  ].join("\n");
}

export function summarizePageModelRouteForResponse(plan: PageModelExecutionPlan): Record<string, unknown> {
  return {
    schemaVersion: plan.schemaVersion,
    request: plan.request,
    project: plan.project,
    env: plan.env,
    intent: plan.selection.intent,
    intentArbitration: plan.selection.intentArbitration,
    intentContract: plan.intentContract,
    readiness: plan.readiness,
    executable: plan.executable,
    gaps: plan.gaps,
    blockingGaps: plan.blockingGaps,
    localizedGaps: localizePageModelGaps(plan.gaps),
    localizedBlockingGaps: localizePageModelGaps(plan.blockingGaps),
    recommendedNextAction: plan.recommendedNextAction,
    planningContext: plan.planningContext,
    selectedEvidence: plan.selection.selectedEvidence.map((item) => ({
      kind: item.kind,
      id: item.id,
      pageId: item.pageId,
      semanticName: item.semanticName,
      status: item.status,
      confidence: item.confidence
    })),
    fallbackEvidence: plan.selection.fallbackEvidence.map((item) => ({
      kind: item.kind,
      id: item.id,
      pageId: item.pageId,
      semanticName: item.semanticName,
      status: item.status,
      confidence: item.confidence
    })),
    excludedEvidenceCount: plan.selection.excludedEvidence.length,
    userAssertions: plan.userAssertions.assertions,
    automationCase: {
      id: plan.materialization.case.id,
      title: plan.materialization.case.title,
      module: plan.materialization.case.module,
      stepCount: plan.materialization.case.steps.length,
      steps: plan.materialization.case.steps.map((step) => {
        const record = step as unknown as Record<string, unknown>;
        return {
          id: step.id,
          action: step.action,
          semanticTarget: step.semantic_target ?? step.semanticTarget,
          value: record.value,
          target: record.target,
          primary_locator: record.primary_locator,
          primaryLocator: record.primaryLocator,
          fallback_locators: record.fallback_locators,
          fallbackLocators: record.fallbackLocators,
          component: record.component,
          postconditions: record.postconditions,
          dataBinding: record.dataBinding,
          scopeGuard: record.scopeGuard,
          negativeLocatorHints: record.negativeLocatorHints,
          preconditions: record.preconditions,
          targetPageId: record.targetPageId,
          targetElementId: record.targetElementId,
          pageModelId: record.pageModelId,
          elementId: record.elementId,
          actionResultId: record.actionResultId,
          assertionId: record.assertionId,
          assertion: record.assertion,
          evidenceId: record.evidenceId,
          source: record.source,
          explain: record.explain
        };
      })
    },
    dslValidation: plan.materialization.dslValidation
  };
}
