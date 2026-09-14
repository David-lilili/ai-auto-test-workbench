import type { AIUsage, DslStep, LoadedContext } from "./types.js";
import { AIUsageTracker } from "./ai-usage-tracker.js";
import { normalizeAiModel, resolveAiRuntime } from "./ai-provider.js";

export interface LocalReplanInput {
  runId: string;
  stepId?: string;
  step: DslStep;
  semanticTarget?: string;
  currentState: {
    urlOrActivity?: string;
    pageTitle?: string;
    domOrPageSource?: string;
    accessibilityTree?: unknown;
  };
  attemptedLocators: string[];
}

export interface LocalReplanResult {
  model: string;
  locators: string[];
  steps: DslStep[];
  judgement?: string;
  usage?: AIUsage;
  error?: string;
}

export async function requestLocalReplan(context: LoadedContext, input: LocalReplanInput): Promise<LocalReplanResult> {
  const runtime = await resolveAiRuntime(context.rootDir);
  const apiKey = runtime.apiKey;
  const model = runtime.model;
  if (!apiKey) return { model, locators: [], steps: [], error: `${runtime.provider} API key is not configured.` };

  const tracker = new AIUsageTracker(context);
  const prompt = buildPrompt(input);
  const cacheKey = tracker.cacheKey({
    projectId: context.project.projectKey,
    platform: "web",
    pageSignature: String(input.currentState.urlOrActivity ?? ""),
    semanticTarget: input.semanticTarget,
    actionType: input.step.action,
    domSignature: input.currentState.domOrPageSource?.slice(0, 4000),
    promptVersion: "local-replan-v2",
    modelName: model,
    purpose: "path_planning"
  });
  const cached = await tracker.readCache<LocalReplanResult>(cacheKey);
  if (cached) {
    const usage = await tracker.track({
      runId: input.runId,
      stepId: input.stepId,
      modelName: model,
      purpose: "path_planning",
      prompt,
      response: cached,
      latencyMs: 0,
      cacheHit: true
    });
    return { ...cached, usage };
  }

  const startedAt = Date.now();
  try {
    const response = await fetch(runtime.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        temperature: 0.1,
        messages: [
          {
            role: "system",
            content:
              "You are a test automation self-healing planner. Return JSON only: {\"locators\": string[], \"steps\": array, \"judgement\": string}. Prefer stable CSS, role, text, data-testid locators. Do not invent destructive actions."
          },
          { role: "user", content: prompt }
        ]
      })
    });
    if (!response.ok) return { model, locators: [], steps: [], error: `AI replan call failed (${runtime.provider}): HTTP ${response.status}` };
    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const content = payload.choices?.[0]?.message?.content ?? "{}";
    const parsed = normalizeReplan(JSON.parse(stripJsonFence(content)));
    const usage = await tracker.track({
      runId: input.runId,
      stepId: input.stepId,
      modelName: model,
      purpose: "path_planning",
      prompt,
      response: parsed,
      promptTokens: payload.usage?.prompt_tokens,
      completionTokens: payload.usage?.completion_tokens,
      latencyMs: Date.now() - startedAt,
      cacheHit: false
    });
    await tracker.writeCache(cacheKey, { ...parsed, model });
    return { ...parsed, model, usage };
  } catch (error) {
    return { model, locators: [], steps: [], error: error instanceof Error ? error.message : String(error) };
  }
}

function buildPrompt(input: LocalReplanInput): string {
  return JSON.stringify(
    {
      failedStep: input.step,
      semanticTarget: input.semanticTarget,
      attemptedLocators: input.attemptedLocators,
      currentState: {
        urlOrActivity: input.currentState.urlOrActivity,
        pageTitle: input.currentState.pageTitle,
        domOrPageSource: input.currentState.domOrPageSource?.slice(0, 16000),
        accessibilityTree: input.currentState.accessibilityTree
      },
      instruction: "Find replacement locators or a short local DSL path to complete the failed step."
    },
    null,
    2
  );
}

function normalizeReplan(value: unknown): Omit<LocalReplanResult, "model" | "usage"> {
  if (!value || typeof value !== "object") return { locators: [], steps: [], judgement: String(value ?? "") };
  const raw = value as { locators?: unknown; steps?: unknown; judgement?: unknown };
  return {
    locators: Array.isArray(raw.locators) ? raw.locators.map(String).filter(Boolean).slice(0, 10) : [],
    steps: Array.isArray(raw.steps) ? (raw.steps.filter((item) => item && typeof item === "object") as DslStep[]).slice(0, 5) : [],
    judgement: raw.judgement ? String(raw.judgement).slice(0, 1000) : undefined
  };
}

function stripJsonFence(value: string): string {
  return value.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
}
