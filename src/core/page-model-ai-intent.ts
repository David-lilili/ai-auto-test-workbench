import { callConfiguredAiJson, type AiChatResult } from "./ai-provider.js";
import { buildAccountProfileCatalogFromSchema, loadAccountProfileSchema, loadOperationManualStore, type AccountProfileCatalogEntry } from "./account-profile-catalog.js";

/** P3-A8：intent prompt 稳定版本。行为变更时 bump（进入 telemetry/cache metadata）。 */
export const PROMPT_VERSION = "intent.v1";
import type { StructuredCaseContext } from "./case-context.js";

export interface PageModelAiIntentResult {
  status: "completed" | "skipped" | "failed";
  provider: string;
  model: string;
  prompt?: string;
  parsedOutput?: unknown;
  rawOutput?: string;
  error?: string;
  telemetry: AiChatResult["telemetry"];
}

export async function understandPageModelIntentWithAi(input: {
  rootDir: string;
  project: string;
  env: string;
  message: string;
  caseContext?: StructuredCaseContext;
  timeoutMs: number;
}): Promise<PageModelAiIntentResult> {
  // P3-A.1：schema 为事实源，Operation Manual 的 required 维度经 selector 一级优先入选。
  const profileSchema = await loadAccountProfileSchema(input.rootDir, input.project);
  const operationManual = await loadOperationManualStore(input.rootDir, input.project);
  const prompt = buildPageModelIntentPrompt({ ...input, profileSchema, operationManual });
  const result = await callConfiguredAiJson({
    rootDir: input.rootDir,
    promptVersion: PROMPT_VERSION,
    system: "You are the first-stage intent analyst of an automation platform. Return compact JSON only. Extract user assertions precisely. Use targetObject=message and operator=visible_exact only when the user explicitly expects prompt/message/toast/alert text. For broad success outcomes such as created successfully, saved successfully, or claim methods are visible, use targetObject=page or result_table with operator=visible/contains. Do not generate selectors or executable DSL.",
    prompt,
    timeoutMs: input.timeoutMs,
    temperature: 0.1
  });
  return {
    status: result.status,
    provider: result.provider,
    model: result.model,
    prompt: result.prompt,
    parsedOutput: result.parsedOutput,
    rawOutput: result.rawOutput,
    error: result.error,
    telemetry: result.telemetry
  };
}

export function buildPageModelIntentPrompt(input: { project: string; env: string; message: string; caseContext?: StructuredCaseContext; profileSchema?: unknown; operationManual?: unknown }): string {
  // P3-A.1：dimension catalog 单一事实源 + relevance selection
  //（OM required 一级优先；不依赖 schema 数组物理顺序）。
  const dimensionCatalog: AccountProfileCatalogEntry[] = buildAccountProfileCatalogFromSchema(input.profileSchema as never, input.operationManual as never);
  return JSON.stringify({
    task: "Understand the user's automation goal before local knowledge retrieval. Return JSON only.",
    project: input.project,
    env: input.env,
    userRequest: input.message,
    caseContext: input.caseContext,
    interpretationRules: [
      "When caseContext is present, businessSteps are the user-visible actions that must be preserved.",
      "Preconditions describe account profile, data, or environment requirements; do not turn preconditions into executable UI steps.",
      "ExpectedAssertions are independent assertions. Keep tab/page state assertions separate from list/table row assertions.",
      "If the user explicitly clicks or switches multiple tabs/options, preserve each requested action in extractedData.explicitActions.",
      "When the scenario depends on account state or historical records, return accountProfileNeeds as requirements; do not choose a concrete account."
    ],
    accountProfileDimensionCatalog: dimensionCatalog,
    outputSchema: {
      pageIntent: "short page or module description",
      businessAction: "what user wants to do",
      operationType: "read|write|unknown",
      extractedData: {},
      expectedOutcome: "success, empty result, filtered rows, visible page, etc.",
      assertions: [
        {
          sourceText: "original user text that expresses the assertion",
          targetObject: "message|result_table|page|tab",
          operator: "visible_exact|all_equal|empty|contains|visible|active|selected",
          expected: "exact expected user-facing text or value",
          field: "table/list field name when applicable",
          emptyStateAccepted: false,
          confidence: 0.0
        }
      ],
      accountProfileNeeds: [
        {
          domain: "spotFlow|contractFlow|earnFlow|earnProduct|earnPosition|asset|security|unknown",
          needType: "feature_enabled|history_record|balance|position|product|security_state",
          dimensionHint: "known dimension id from accountProfileDimensionCatalog when available",
          expected: true,
          recordPresence: "exists|empty|unknown",
          asset: "asset symbol when specified, otherwise null",
          recordType: "business record type when specified, otherwise null",
          dateRange: { start: "YYYY-MM-DD or full datetime when specified", end: "YYYY-MM-DD or full datetime when specified" },
          reason: "why this account profile condition is needed"
        }
      ],
      implicitNeeds: ["provider verification, success assertion, page modeling, etc."],
      missingUserData: ["required data that user did not provide"],
      confidence: 0.0
    }
  }, null, 2);
}

export function aiIntentUnderstandingBlockReason(result: { status: "completed" | "skipped" | "failed"; parsedOutput?: unknown; error?: string }): string | undefined {
  if (result.status !== "completed") {
    return result.error ?? "AI intent understanding did not complete.";
  }
  if (!result.parsedOutput || typeof result.parsedOutput !== "object") {
    return "AI intent understanding returned no parseable structured intent.";
  }
  return undefined;
}
