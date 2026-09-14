import { callConfiguredAiJson, type AiCallTelemetry } from "./ai-provider.js";
import { buildCompressedPageModelDslAdvisoryContext } from "./page-model-dsl-advisory-context.js";
import type { PageModelExecutionPlan } from "./page-model-execution-planner.js";

/** P3-A8：advisor prompt 稳定版本。 */
export const PROMPT_VERSION = "advisor.v1";

export type PageModelDslAdvisorMode = "compressed" | "full";

export interface PageModelDslAdvisorResult {
  status: "completed" | "skipped" | "failed";
  provider: string;
  model: string;
  mode: PageModelDslAdvisorMode;
  prompt?: string;
  parsedOutput?: unknown;
  rawOutput?: string;
  error?: string;
  telemetry: AiCallTelemetry & {
    mode: PageModelDslAdvisorMode;
    originalPromptChars?: number;
    compressedPromptChars?: number;
    promptCharReductionPercent?: number;
    estimatedPromptTokenReductionPercent?: number;
    blocking: false;
  };
}

export async function buildPageModelDslAdvisorWithAi(input: {
  rootDir: string;
  project: string;
  env: string;
  message: string;
  initialUnderstanding?: unknown;
  planningContext: Record<string, unknown>;
  plan?: PageModelExecutionPlan;
  planSummary?: Record<string, unknown>;
  localDslValidation?: unknown;
  timeoutMs: number;
  mode?: PageModelDslAdvisorMode;
}): Promise<PageModelDslAdvisorResult> {
  const fullPrompt = buildFullAdvisorPrompt(input);
  const requestedMode = input.mode ?? "compressed";
  const canCompress = Boolean(input.plan && input.planSummary);
  const mode: PageModelDslAdvisorMode = requestedMode === "compressed" && canCompress ? "compressed" : "full";
  const compressed = mode === "compressed"
    ? buildCompressedPageModelDslAdvisoryContext({
      project: input.project,
      env: input.env,
      request: input.message,
      initialUnderstanding: input.initialUnderstanding,
      plan: input.plan as PageModelExecutionPlan,
      planSummary: input.planSummary as Record<string, unknown>,
      originalPromptChars: fullPrompt.length
    })
    : undefined;
  const prompt = compressed?.prompt ?? fullPrompt;
  const result = await callConfiguredAiJson({
    rootDir: input.rootDir,
    promptVersion: PROMPT_VERSION,
    system: mode === "compressed"
      ? "You are a grounded DSL reviewer. Return compact JSON only. Use only IDs present in selectedKnowledge and materializedDsl. Return shouldWriteDsl=false when the DSL should be blocked."
      : "You are the Page Model DSL generation advisor of an automation platform. Return JSON only. Use only IDs present in planningContext.",
    prompt,
    timeoutMs: input.timeoutMs,
    temperature: 0.1,
    maxTokens: mode === "compressed" ? 1600 : undefined
  });
  const estimatedOldTokens = compressed?.originalPromptChars ? Math.ceil(compressed.originalPromptChars / 4) : undefined;
  const estimatedPromptTokenReductionPercent = estimatedOldTokens && result.telemetry.promptTokens
    ? Math.round((1 - result.telemetry.promptTokens / estimatedOldTokens) * 1000) / 10
    : undefined;
  return {
    status: result.status,
    provider: result.provider,
    model: result.model,
    mode,
    prompt: result.prompt,
    parsedOutput: result.parsedOutput,
    rawOutput: result.rawOutput,
    error: result.error,
    telemetry: {
      ...result.telemetry,
      mode,
      originalPromptChars: compressed?.originalPromptChars,
      compressedPromptChars: compressed?.promptChars,
      promptCharReductionPercent: compressed?.promptCharReductionPercent,
      estimatedPromptTokenReductionPercent,
      blocking: false
    }
  };
}

function buildFullAdvisorPrompt(input: {
  project: string;
  env: string;
  message: string;
  initialUnderstanding?: unknown;
  planningContext: Record<string, unknown>;
  localDslValidation?: unknown;
}): string {
  return JSON.stringify({
    task: "Generate a Page Model and Operation Manual grounded DSL consistency review. Return shouldExecute/shouldWriteDsl as false when the DSL should be blocked. Do not invent knowledge.",
    project: input.project,
    env: input.env,
    userRequest: input.message,
    initialUnderstanding: input.initialUnderstanding,
    planningContext: input.planningContext,
    localDslValidation: input.localDslValidation,
    requiredReasoningBoundaries: [
      "Use operation manuals to infer implicit business steps, provider requirements, and success evidence.",
      "Use Page Model context for executable page, element, provider, and assertion IDs.",
      "For provider verification, output business-visible steps such as send code if present, input Google/TOTP code, input email code if present, and click confirm if present.",
      "For verification inputs, use credentialType/providerRequirementId only. Do not describe Redis keys, KeePassXC entries, polling, code retrieval, or secret handling.",
      "If a needed flow/provider/assertion is only described but not executable in Page Model, return a gap.",
      "Never invent locators, URLs, providers, page states, or option values."
    ],
    outputSchema: {
      intentCheck: {
        module: "string",
        action: "string",
        operationType: "read|write",
        extractedData: {}
      },
      selectedRefs: {
        targetPageIds: ["existing targetPageId only"],
        targetElementIds: ["existing targetElementId only"],
        assertionIds: ["existing assertionId only"],
        providerRequirementIds: ["existing providerRequirementId only"]
      },
      dslSteps: [
        {
          action: "navigate|click|input|select|assert|provider",
          targetPageId: "existing page id",
          targetElementId: "existing element id for click/input/select",
          value: "only user-provided or Page Model option value",
          valueFrom: { type: "verificationCredential", credentialType: "email_code|sms_code|totp" },
          providerRequirementId: "existing providerRequirementId only for verification inputs",
          postconditions: ["existing observable state ids or plain description grounded in Page Model"]
        }
      ],
      gaps: ["knowledge or modeling gaps only"],
      shouldExecute: false
    }
  }, null, 2);
}
