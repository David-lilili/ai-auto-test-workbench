import crypto from "node:crypto";
import path from "node:path";
import fs from "fs-extra";
import type {
  AutomationCase,
  CaseResult,
  DslStep,
  ExecutionMode,
  ExecutionRun,
  ExecutionStatus,
  FallbackLevel,
  LoadedContext,
  RuntimeOptions,
  StepExecution
} from "./types.js";
import { WebDriverAdapter } from "../drivers/web-driver-adapter.js";
import { ExecutionStore } from "../memory/execution-store.js";
import { SmartElementStore } from "../memory/smart-element-store.js";
import { PageStateStore, pageStateId } from "../memory/page-state-store.js";
import { AIUsageTracker } from "./ai-usage-tracker.js";
import { logger } from "./logger.js";
import { requestLocalReplan } from "./ai-replanner.js";
import { writeCodexFailurePackage } from "./codex-failure-package.js";
import { getVerificationCode } from "./verification-code-provider.js";
import { writeSafeJsonFile, writeSafeTextFile } from "./safe-file-writer.js";
import type { ProviderCallRecord } from "./ai-orchestration-schema.js";

const TEMP_OPERATION_DELAY_MS = 0;

interface ExecuteInput {
  testCase: AutomationCase;
  context: LoadedContext;
  options: RuntimeOptions;
  driver?: WebDriverAdapter;
  closeDriver?: boolean;
}

interface ObservationContext {
  enabled: boolean;
  profile: string;
  artifactDir: string;
  videoDir: string;
  relativeArtifactDir: string;
}

interface StepOutcome {
  status: ExecutionStatus;
  locator?: string;
  fallbackLevel: FallbackLevel;
  error?: string;
  actionResult?: unknown;
  aiUsed?: boolean;
  tokenInput?: number;
  tokenOutput?: number;
  estimatedCost?: number;
  attemptedLocators?: string[];
}

export class DslExecutor {
  private readonly executionStore: ExecutionStore;
  private readonly smartElementStore: SmartElementStore;
  private readonly pageStateStore: PageStateStore;
  private readonly aiUsageTracker: AIUsageTracker;
  private readonly lastPageStateByRun = new Map<string, string>();
  private readonly providerCallsByRun = new Map<string, ProviderCallRecord[]>();
  private readonly selectedFiltersByRun = new Map<string, RuntimeSelectedFilter[]>();

  constructor(private readonly context: LoadedContext) {
    this.executionStore = new ExecutionStore(context);
    this.smartElementStore = new SmartElementStore(context);
    this.pageStateStore = new PageStateStore(context);
    this.aiUsageTracker = new AIUsageTracker(context);
  }

  async executeCase(input: ExecuteInput): Promise<CaseResult> {
    const startedAt = Date.now();
    const mode = input.options.mode ?? "strict";
    const maxDurationMs = input.options.maxDurationMs ?? 120_000;
    const runId = crypto.randomUUID();
    const observation = buildObservationContext(input.context, input.options, runId);
    const run: ExecutionRun = {
      run_id: runId,
      project_id: input.context.project.projectKey,
      platform: platformOf(input.testCase.type),
      env: input.context.env.env,
      test_case_id: input.testCase.id,
      dsl_version: "1",
      mode,
      observation_mode: observation.enabled,
      observation_profile: observation.enabled ? observation.profile : undefined,
      observation_artifact_path: observation.enabled ? observation.relativeArtifactDir : undefined,
      start_time: new Date().toISOString(),
      status: "partial",
      total_steps: input.testCase.steps.length + input.testCase.assertions.length,
      passed_steps: 0,
      failed_steps: 0,
      healed_steps: 0,
      ai_invocation_count: 0,
      token_input_total: 0,
      token_output_total: 0,
      estimated_cost: 0,
      duration_ms: 0
    };
    await this.executionStore.upsertRun(run);

    let driver: WebDriverAdapter | undefined = input.driver;
    const artifacts: string[] = [];
    let currentStep: DslStep | undefined;
    let currentStepIndex = 0;
    try {
      if (input.testCase.type === "web" && !driver) {
        const headed = input.options.headed ?? (mode === "debug" || mode === "explore" || observation.enabled);
        driver = await WebDriverAdapter.launch(input.context, headed, {
          extraHTTPHeaders: input.options.webAuthToken?.headerName
            ? { [input.options.webAuthToken.headerName]: input.options.webAuthToken.token }
            : undefined,
          authToken: input.options.webAuthToken,
          recordVideoDir: observation.enabled ? observation.videoDir : undefined
        });
      }

      for (const [index, step] of input.testCase.steps.entries()) {
        ensureExecutionNotCancelled(input.options.abortSignal, run.run_id);
        currentStep = step;
        currentStepIndex = index;
        ensureExecutionBudget(startedAt, maxDurationMs, run.run_id);
        await emitExecutionStepProgress(input.options, {
          type: "step_start",
          runId: run.run_id,
          stepIndex: index,
          totalSteps: input.testCase.steps.length + input.testCase.assertions.length,
          dslStepId: step.id ?? `${index + 1}`,
          action: step.action,
          target: semanticTargetOf(step)
        });
        const stepResult = await withTimeout(
          this.executeStep({ step, index, runId: run.run_id, mode, driver, input, observation }),
          remainingExecutionBudget(startedAt, maxDurationMs),
          `Execution timed out after ${maxDurationMs}ms for run ${run.run_id}.`
        );
        updateRunFromStep(run, stepResult);
        await this.executionStore.upsertRun(run);
        ensureExecutionNotCancelled(input.options.abortSignal, run.run_id);
        if (stepResult.status === "failed") throw new Error(stepResult.error_message ?? `Step failed: ${step.action}`);
      }

      for (const [index, assertion] of input.testCase.assertions.entries()) {
        ensureExecutionNotCancelled(input.options.abortSignal, run.run_id);
        ensureExecutionBudget(startedAt, maxDurationMs, run.run_id);
        const step: DslStep = { id: `assertion-${index + 1}`, action: "assert", assertion, target: assertion.target };
        currentStep = step;
        currentStepIndex = input.testCase.steps.length + index;
        await emitExecutionStepProgress(input.options, {
          type: "step_start",
          runId: run.run_id,
          stepIndex: currentStepIndex,
          totalSteps: input.testCase.steps.length + input.testCase.assertions.length,
          dslStepId: step.id ?? `${currentStepIndex + 1}`,
          action: step.action,
          target: semanticTargetOf(step)
        });
        const stepResult = await withTimeout(
          this.executeStep({
            step,
            index: input.testCase.steps.length + index,
            runId: run.run_id,
            mode,
            driver,
            input,
            observation
          }),
          remainingExecutionBudget(startedAt, maxDurationMs),
          `Execution timed out after ${maxDurationMs}ms for run ${run.run_id}.`
        );
        updateRunFromStep(run, stepResult);
        await this.executionStore.upsertRun(run);
        ensureExecutionNotCancelled(input.options.abortSignal, run.run_id);
        if (stepResult.status === "failed") throw new Error(stepResult.error_message ?? `Assertion failed: ${assertion.type}`);
      }

      run.status = run.healed_steps > 0 ? "healed" : "passed";
      return {
        id: input.testCase.id,
        status: "passed",
        durationMs: Date.now() - startedAt,
        artifacts,
        runId: run.run_id,
        healedSteps: run.healed_steps,
        aiInvocationCount: run.ai_invocation_count
      };
    } catch (error) {
      run.status = isExecutionCancelledError(error) ? "skipped" : run.passed_steps > 0 || run.healed_steps > 0 ? "partial" : "failed";
      const needsSyntheticFailure = run.failed_steps === 0;
      if (needsSyntheticFailure) run.failed_steps = 1;
      run.error_summary = error instanceof Error ? error.message : String(error);
      if (needsSyntheticFailure && currentStep) {
        await this.writeSyntheticFailureStep({
          step: currentStep,
          index: currentStepIndex,
          runId: run.run_id,
          error: run.error_summary,
          caseId: input.testCase.id
        }).catch((writeError) => {
          logger.warn("Failed to write synthetic timeout failure step", { error: writeError instanceof Error ? writeError.message : String(writeError) });
        });
      }
      return {
        id: input.testCase.id,
        status: "failed",
        durationMs: Date.now() - startedAt,
        error: run.error_summary,
        artifacts,
        runId: run.run_id,
        healedSteps: run.healed_steps,
        aiInvocationCount: run.ai_invocation_count
      };
    } finally {
      if (input.closeDriver !== false) await driver?.close().catch(() => undefined);
      if (observation.enabled) {
        await finalizeObservationRun(input.context, input.options, run, observation, input.testCase).catch((error) => {
          logger.warn("Failed to finalize observation run", { runId: run.run_id, error: error instanceof Error ? error.message : String(error) });
        });
      }
      const providerCalls = this.providerCallsByRun.get(run.run_id) ?? [];
      if (providerCalls.length) {
        const artifactDir = path.join(this.context.rootDir, this.context.workspace.artifactRoot, "execution", run.run_id);
        await fs.ensureDir(artifactDir);
        await writeSafeJsonFile(path.join(artifactDir, "provider-calls.json"), {
          schemaVersion: "provider-calls.v1",
          runId: run.run_id,
          project: input.context.project.projectKey,
          env: input.context.env.env,
          calls: providerCalls
        }).catch((error) => {
          logger.warn("Failed to write provider calls artifact", { runId: run.run_id, error: error instanceof Error ? error.message : String(error) });
        });
      }
      const usages = await this.executionStore.listAIUsage(run.run_id);
      run.ai_invocation_count = usages.filter((item) => !item.cache_hit).length;
      run.token_input_total = usages.reduce((sum, item) => sum + item.prompt_tokens, 0);
      run.token_output_total = usages.reduce((sum, item) => sum + item.completion_tokens, 0);
      run.estimated_cost = usages.reduce((sum, item) => sum + item.estimated_cost, 0);
      run.end_time = new Date().toISOString();
      run.duration_ms = Date.now() - startedAt;
      await this.executionStore.upsertRun(run);
    }
  }

  private async executeStep(input: {
    step: DslStep;
    index: number;
    runId: string;
    mode: ExecutionMode;
    driver?: WebDriverAdapter;
    input: ExecuteInput;
    observation: ObservationContext;
  }): Promise<StepExecution> {
    const startedAt = Date.now();
    const { step, mode, driver } = input;
    const stepId = step.id ?? `${input.index + 1}`;
    const semanticTarget = semanticTargetOf(step);
    const primaryLocator = primaryLocatorOf(step);
    const snapshot = shouldCollectSnapshot(step, mode, input.observation);
    const artifactDir = input.observation.enabled
      ? path.join(input.observation.artifactDir, "steps")
      : path.join(this.context.rootDir, this.context.workspace.artifactRoot, "execution", input.runId);
    await fs.ensureDir(artifactDir);
    const operationTracePath = path.join(artifactDir, "operation-trace.jsonl");
    const beforeScreenshotPath = snapshot && driver ? path.join(artifactDir, `${stepId}-before.png`) : undefined;
    const domSnapshotPath = snapshot && driver ? path.join(artifactDir, `${stepId}-dom.html`) : undefined;

    if (beforeScreenshotPath) await driver?.takeScreenshot(beforeScreenshotPath).catch(() => undefined);
    if (domSnapshotPath && driver) await writeSafeTextFile(domSnapshotPath, await driver.getDomOrPageSource().catch(() => ""));
    await this.appendOperationTrace(operationTracePath, {
      event: "step.before_delay",
      runId: input.runId,
      stepIndex: input.index + 1,
      stepId,
      action: step.action,
      semanticTarget,
      primaryLocator,
      target: step.target,
      value: summarizeStepValue(step),
      delayMs: TEMP_OPERATION_DELAY_MS,
      beforeScreenshotPath,
      domSnapshotPath,
      at: new Date().toISOString()
    });
    await delay(TEMP_OPERATION_DELAY_MS);

    const outcome = await this.tryExecuteWithFallback(input);
    this.recordRuntimeSelectedFilter(input.runId, step, outcome);
    await this.appendOperationTrace(operationTracePath, {
      event: "step.after_action_before_delay",
      runId: input.runId,
      stepIndex: input.index + 1,
      stepId,
      action: step.action,
      semanticTarget,
      primaryLocator,
      status: outcome.status,
      locator: outcome.locator,
      fallbackLevel: outcome.fallbackLevel,
      error: outcome.error,
      attemptedLocators: outcome.attemptedLocators,
      actionResult: summarizeActionResult(outcome.actionResult),
      delayMs: TEMP_OPERATION_DELAY_MS,
      elapsedMs: Date.now() - startedAt,
      at: new Date().toISOString()
    });
    await delay(TEMP_OPERATION_DELAY_MS);
    const assertionFailure = step.action === "assert" && outcome.status === "failed";
    const actionFailure = outcome.status === "failed";
    const afterScreenshotPath = (snapshot || assertionFailure || actionFailure) && driver ? path.join(artifactDir, `${stepId}-${snapshot ? "after" : "failure"}.png`) : undefined;
    if (afterScreenshotPath) await driver?.takeScreenshot(afterScreenshotPath).catch(() => undefined);
    const assertionAfterDomPath = actionFailure && driver ? path.join(artifactDir, `${stepId}-${assertionFailure ? "after" : "failure"}-dom.html`) : undefined;
    const visibleTextSnapshotPath = actionFailure && driver ? path.join(artifactDir, `${stepId}-visible-text-snapshot.json`) : undefined;
    const assertionEvidencePath = assertionFailure && driver ? path.join(artifactDir, `${stepId}-assertion-evidence.json`) : undefined;
    const finalVisibleTextSnapshot = actionFailure && driver ? await driver.getVisibleTextSnapshot().catch(() => undefined) : undefined;
    if (assertionAfterDomPath && driver) await writeSafeTextFile(assertionAfterDomPath, await driver.getDomOrPageSource().catch(() => ""));
    if (visibleTextSnapshotPath && finalVisibleTextSnapshot) await writeSafeJsonFile(visibleTextSnapshotPath, finalVisibleTextSnapshot);
    const expectedAssertions = assertionFailure ? assertionExpectationCandidates(step) : [];
    const matchedAssertions = finalVisibleTextSnapshot ? expectedAssertions.filter((item) => finalVisibleTextSnapshot.visibleTexts.some((text) => text.includes(item))) : [];
    const unmatchedAssertions = expectedAssertions.filter((item) => !matchedAssertions.includes(item));
    if (assertionEvidencePath && finalVisibleTextSnapshot) {
      await writeSafeJsonFile(assertionEvidencePath, {
        expectedAssertions,
        matchedAssertions,
        unmatchedAssertions,
        assertionWaitMs: Date.now() - startedAt,
        assertionError: outcome.error,
        assertionActual: step.assertion?.actual,
        assertionDiagnostics: step.assertion?.diagnostics,
        afterScreenshotPath,
        afterDomPath: assertionAfterDomPath,
        visibleTextSnapshotPath,
        capturedAt: new Date().toISOString()
      });
    }

    const record: StepExecution = {
      step_id: crypto.randomUUID(),
      run_id: input.runId,
      dsl_step_id: stepId,
      action_type: step.action,
      target_semantic_name: semanticTarget,
      primary_locator: primaryLocator,
      actual_locator_used: outcome.locator,
      fallback_level_used: outcome.fallbackLevel,
      status: outcome.status,
      before_screenshot_path: beforeScreenshotPath,
      after_screenshot_path: afterScreenshotPath,
      dom_snapshot_path: domSnapshotPath,
      assertion_after_dom_path: assertionAfterDomPath,
      visible_text_snapshot_path: visibleTextSnapshotPath,
      assertion_evidence_path: assertionEvidencePath,
      observation_artifact_path: input.observation.enabled ? input.observation.relativeArtifactDir : undefined,
      final_url: finalVisibleTextSnapshot?.url,
      final_title: finalVisibleTextSnapshot?.title,
      final_visible_texts: finalVisibleTextSnapshot?.visibleTexts,
      network_summary: assertionFailure
        ? {
            enabled: false,
            requests: [],
            matchedBusinessApis: [],
            limitations: ["network listener is not available in current executor"]
          }
        : undefined,
      error_message: outcome.error,
      duration_ms: Date.now() - startedAt,
      ai_used: Boolean(outcome.aiUsed),
      token_input: outcome.tokenInput ?? 0,
      token_output: outcome.tokenOutput ?? 0,
      estimated_cost: outcome.estimatedCost ?? 0,
      attempted_locators: outcome.attemptedLocators,
      action_result: outcome.actionResult,
      assertion_summary: step.action === "assert" && step.assertion
        ? {
            stepIndex: input.index + 1,
            stepId,
            readableText: readableAssertionSummary(step, input.index),
            type: step.assertion.type,
            target: step.assertion.target,
            table: step.assertion.table,
            column: step.assertion.column,
            expected: step.assertion.expected,
            emptyStateAccepted: step.assertion.emptyStateAccepted,
            status: outcome.status,
            actual: step.assertion.actual,
            diagnostics: step.assertion.diagnostics,
            error: outcome.error
          }
        : undefined
    };
    await this.executionStore.appendStep(record);
    await emitExecutionStepProgress(input.input.options, {
      type: "step_end",
      runId: input.runId,
      stepIndex: input.index,
      totalSteps: input.input.testCase.steps.length + input.input.testCase.assertions.length,
      dslStepId: stepId,
      action: step.action,
      target: semanticTarget,
      status: record.status,
      step: summarizeStepExecutionForProgress(record)
    });
    await this.appendOperationTrace(operationTracePath, {
      event: "step.recorded",
      runId: input.runId,
      stepIndex: input.index + 1,
      stepId,
      action: step.action,
      status: record.status,
      durationMs: record.duration_ms,
      beforeScreenshotPath,
      afterScreenshotPath,
      domSnapshotPath,
      actionResult: summarizeActionResult(record.action_result),
      at: new Date().toISOString()
    });

    if (record.status === "failed") await this.writeFailureReport({ step: input.step, runId: input.runId, driver: input.driver, testCase: input.input.testCase }, record, input.input.testCase.id);
    return record;
  }

  private async tryExecuteWithFallback(input: {
    step: DslStep;
    index: number;
    runId: string;
    mode: ExecutionMode;
    driver?: WebDriverAdapter;
    input: ExecuteInput;
  }): Promise<StepOutcome> {
    const { step, driver, mode } = input;
    const semanticTarget = semanticTargetOf(step);
    const primaryLocator = primaryLocatorOf(step);
    const allowHealing = mode !== "strict" && (step.allow_healing ?? step.allowHealing ?? true);
    const wantsVisualStrategy = (step.locator_strategy ?? step.locatorStrategy) === "image";
    const stepConfiguredMaxLevel = step.max_healing_level ?? step.maxHealingLevel;
    const modeDefaultMaxLevel = mode === "heal" ? 3 : 4;
    const configuredMaxLevel = stepConfiguredMaxLevel ?? modeDefaultMaxLevel;
    const maxLevel =
      mode === "strict"
        ? 0
        : (Math.min(configuredMaxLevel, input.input.options.maxStepHealingLevel ?? configuredMaxLevel) as FallbackLevel);
    const attemptedLocators: string[] = [];
    const actionResults: unknown[] = [];

    if (input.input.testCase.type === "api") return this.executeApiStep(step, input.input.context);
    if (!driver) return { status: "skipped", fallbackLevel: 0, error: "No driver for this platform.", attemptedLocators };

    if (step.action === "fail") {
      const error = typeof step.value === "string" ? step.value : step.target ? String(step.target) : "Execution intentionally stopped.";
      return { status: "failed", fallbackLevel: 0, error, attemptedLocators };
    }

    if (step.action === "input" && isRedisVerificationValueFrom(step.valueFrom)) {
      try {
        const code = await this.resolveRedisVerificationValue(step, input.input, input.runId);
        const resolvedStep: DslStep = { ...step, value: code, valueFrom: undefined };
        return this.tryExecuteWithFallback({ ...input, step: resolvedStep });
      } catch (error) {
        return {
          status: "failed",
          fallbackLevel: 0,
          error: error instanceof Error ? error.message : String(error),
          attemptedLocators
        };
      }
    }

    if (step.action === "input" && isTotpValueFrom(step.valueFrom)) {
      try {
        const code = await this.resolveTotpValue(step, input.input, input.runId);
        const resolvedStep: DslStep = { ...step, value: code, valueFrom: undefined };
        return this.tryExecuteWithFallback({ ...input, step: resolvedStep });
      } catch (error) {
        return {
          status: "failed",
          fallbackLevel: 0,
          error: error instanceof Error ? error.message : String(error),
          attemptedLocators
        };
      }
    }

    if (step.action === "navigate") {
      const targetUrl = navigationTarget(step, this.context);
      if (!targetUrl) return { status: "skipped", fallbackLevel: 0, error: `Unresolved navigation target: ${step.target ?? ""}`, attemptedLocators };
      await driver.navigate(targetUrl);
      await this.recordCurrentPage(driver, input.runId, step, targetUrl, true, 0);
      return { status: "passed", fallbackLevel: 0, locator: targetUrl, attemptedLocators: [targetUrl] };
    }

    const preconditionError = await this.checkStepPreconditions(driver, step).catch((error) => error instanceof Error ? error.message : String(error));
    if (preconditionError) {
      return {
        status: "failed",
        fallbackLevel: 0,
        error: `Precondition failed for ${semanticTarget ?? step.id ?? step.action}: ${preconditionError}`,
        attemptedLocators
      };
    }

    if (step.action === "wait" && !primaryLocator && !step.target) {
      const timeoutMs = step.timeout_ms ?? step.timeoutMs ?? 1_000;
      await driver.waitFor(undefined, timeoutMs);
      await this.recordCurrentPage(driver, input.runId, step, `wait:${timeoutMs}`, true, timeoutMs);
      return { status: "passed", fallbackLevel: 0, locator: `wait:${timeoutMs}`, attemptedLocators: [`wait:${timeoutMs}`] };
    }

    if (step.action === "assert" && step.assertion && !primaryLocator && fallbackLocatorsOf(step).length === 0) {
      const assertion = withRuntimeSelectedFilters(step.assertion, this.selectedFiltersByRun.get(input.runId) ?? []);
      try {
        await driver.assertState(assertion);
        step.assertion.actual = assertion.actual;
        step.assertion.diagnostics = assertion.diagnostics;
        await this.recordCurrentPage(driver, input.runId, step, "assertion", true, 0);
        return { status: "passed", fallbackLevel: 0, locator: "assertion", attemptedLocators: ["assertion"] };
      } catch (error) {
        step.assertion.actual = assertion.actual;
        step.assertion.diagnostics = assertion.diagnostics;
        return {
          status: "failed",
          fallbackLevel: 0,
          error: error instanceof Error ? error.message : String(error),
          attemptedLocators: ["assertion"]
        };
      }
    }

    const componentSelect = isComponentSelectStep(step);
    const directLocators = uniqueLocators([primaryLocator, ...fallbackLocatorsOf(step)].filter(Boolean) as string[])
      .filter((locator) => !componentSelect || isComponentTriggerLocator(locator))
      .sort((left, right) => componentSelect ? componentTriggerPriority(right) - componentTriggerPriority(left) : 0);
    for (const locator of directLocators) {
      attemptedLocators.push(locator);
      if (isLocatorForbiddenByStepGuard(step, locator)) continue;
      const outcome = await this.tryLocatorAction(driver, step, locator, directLocators.indexOf(locator) === 0 ? 0 : 1, input.runId);
      if (outcome.status === "passed" || outcome.status === "healed") {
        await this.recordElementSuccess(step, locator, outcome.fallbackLevel, driver, undefined, input.runId);
        return { ...outcome, attemptedLocators };
      }
      if (outcome.actionResult !== undefined) actionResults.push({ locator, fallbackLevel: outcome.fallbackLevel, result: outcome.actionResult });
      if (componentFailureDiagnosis(outcome.actionResult) === "scope_lost") break;
      if (!allowHealing || maxLevel < 1) break;
    }

    if (!wantsVisualStrategy && allowHealing && maxLevel >= 1 && semanticTarget && !isPageModelStep(step)) {
      const candidates = await this.smartElementStore.findCandidates({
        platform: "web",
        semanticName: semanticTarget,
        elementType: elementTypeOf(step)
      });
      for (const candidate of candidates.slice(0, 5)) {
        for (const locator of uniqueLocators([candidate.last_success_locator, candidate.primary_locator, ...candidate.fallback_locators].filter(Boolean) as string[])) {
          attemptedLocators.push(locator);
          if (isLocatorForbiddenByStepGuard(step, locator)) continue;
          const outcome = await this.tryLocatorAction(driver, step, locator, 1, input.runId);
          if (outcome.status === "passed" || outcome.status === "healed") {
            await this.recordElementSuccess(step, locator, 1, driver, undefined, input.runId);
            return { ...outcome, status: "healed", fallbackLevel: 1, attemptedLocators };
          }
          if (outcome.actionResult !== undefined) actionResults.push({ locator, fallbackLevel: outcome.fallbackLevel, result: outcome.actionResult });
        }
      }
    }

    if (!wantsVisualStrategy && allowHealing && maxLevel >= 2 && semanticTarget) {
      const candidates = isCriticalProviderStep(step)
        ? []
        : uniqueSemanticCandidates((await driver.findSemanticLocators?.(semanticTarget, step.action)) ?? []);
      for (const candidate of candidates) {
        attemptedLocators.push(candidate.locator);
        if (componentSelect && !isComponentTriggerLocator(candidate.locator)) continue;
        if (isLocatorForbiddenByStepGuard(step, candidate.locator)) continue;
        const outcome = await this.tryLocatorAction(driver, step, candidate.locator, 2, input.runId);
        if (outcome.status === "passed" || outcome.status === "healed") {
          await this.recordElementSuccess(step, candidate.locator, 2, driver, candidate, input.runId);
          return { ...outcome, status: "healed", fallbackLevel: 2, attemptedLocators };
        }
        if (outcome.actionResult !== undefined) actionResults.push({ locator: candidate.locator, fallbackLevel: outcome.fallbackLevel, result: outcome.actionResult });
      }
    }

    if (allowHealing && maxLevel >= 3) {
      const visualOutcome = await this.tryVisualHealing(input, attemptedLocators);
      if (visualOutcome.status === "passed" || visualOutcome.status === "healed") return visualOutcome;
    }

    if (allowHealing && maxLevel >= 4 && mode !== "heal" && (await this.canUseAi(input.runId, input.input.options))) {
      const replanOutcome = await this.tryAiReplan(input, attemptedLocators);
      if (replanOutcome.status === "passed" || replanOutcome.status === "healed") return replanOutcome;
    }

    if (semanticTarget && !isPageModelStep(step)) await this.smartElementStore.recordFailure({ platform: "web", semanticName: semanticTarget, locator: primaryLocator });
    return {
      status: "failed",
      fallbackLevel: Math.min(maxLevel, 5) as FallbackLevel,
      error: `Unable to execute ${step.action} on ${semanticTarget ?? step.target ?? primaryLocator ?? "unknown target"}.`,
      attemptedLocators,
      actionResult: actionResults.length ? { attempts: actionResults } : undefined
    };
  }

  private async resolveRedisVerificationValue(step: DslStep, input: ExecuteInput, runId: string): Promise<string> {
    const account = readRedisVerificationAccount(step, input);
    if (!account) throw new Error("redisVerificationCode requires an account from step.valueFrom.account, step.value.account, testCase.dataProfile, or runtime account context.");
    const options = readRedisVerificationOptions(step.valueFrom);
    const hardTimeoutMs = Math.max(1_000, options.timeoutMs ?? step.timeout_ms ?? step.timeoutMs ?? 20_000);
    const startedAt = Date.now();
    const requestSummary = {
      project: this.context.project.projectKey,
      env: this.context.env.env,
      service: options.service ?? "spot",
      network: options.network ?? "external",
      scene: options.scene,
      codeType: options.codeType,
      account: maskRedisVerificationKey(account)
    };
    let providerCallRecorded = false;
    try {
      const result = await withTimeout(
        getVerificationCode(this.context, {
        provider: "redis",
        account,
        scene: options.scene,
        codeType: options.codeType,
        service: options.service,
        network: options.network,
        timeoutMs: options.timeoutMs ?? hardTimeoutMs
        }),
        hardTimeoutMs + 1_000,
        `Redis verification code provider timed out after ${hardTimeoutMs}ms.`
      );
      this.recordProviderCall(runId, {
        provider: "redis",
        operation: "get_verification_code",
        scene: options.scene ?? options.codeType ?? "verification",
        startedAt: new Date(startedAt).toISOString(),
        endedAt: new Date().toISOString(),
        elapsedMs: Date.now() - startedAt,
        status: result.success && result.code ? "success" : "failed",
        errorCode: result.errorCode,
        errorMessage: result.errorMessage,
        requestSummary
      });
      providerCallRecorded = true;
      if (!result.success || !result.code) throw new Error(result.errorMessage ?? "Verification code fetch failed.");
      logger.info("Resolved Redis verification code", {
        project: this.context.project.projectKey,
        env: this.context.env.env,
        service: options.service ?? "spot",
        network: options.network ?? "external",
        account,
        key: result.metadata?.key,
        templateName: result.metadata?.keyPatternName,
        code: "******"
      });
      return result.code;
    } catch (error) {
      if (!providerCallRecorded) {
        this.recordProviderCall(runId, {
          provider: "redis",
          operation: "get_verification_code",
          scene: options.scene ?? options.codeType ?? "verification",
          startedAt: new Date(startedAt).toISOString(),
          endedAt: new Date().toISOString(),
          elapsedMs: Date.now() - startedAt,
          status: "failed",
          errorCode: "provider_error",
          errorMessage: error instanceof Error ? error.message : String(error),
          requestSummary
        });
      }
      throw error;
    }
  }

  private async checkStepPreconditions(driver: WebDriverAdapter, step: DslStep): Promise<string | undefined> {
    const preconditions = step.preconditions ?? [];
    for (const precondition of preconditions) {
      const id = precondition.id || precondition.type;
      if (precondition.type === "textVisibleAny") {
        const expected = precondition.expected ?? [];
        if (!expected.length) continue;
        try {
          await driver.assertState({ type: "textVisibleAny", expected });
        } catch {
          return `${id} expected visible text: ${expected.join(" | ")}`;
        }
      }
      if (precondition.type === "textNotVisible") {
        const expected = precondition.expected ?? [];
        if (!expected.length) continue;
        const snapshot = await driver.getVisibleTextSnapshot().catch(() => undefined);
        const visible = snapshot?.visibleTexts.join("\n") ?? "";
        const matched = expected.find((item) => visible.includes(item));
        if (matched) return `${id} forbidden text is visible: ${matched}`;
      }
      if (precondition.type === "locatorVisible") {
        if (!precondition.locator) continue;
        try {
          await driver.findElement(precondition.locator);
        } catch {
          return `${id} locator is not visible: ${precondition.locator}`;
        }
      }
      if (precondition.type === "locatorEnabled") {
        if (!precondition.locator) continue;
        try {
          const locator = await driver.findElement(precondition.locator);
          const enabled = await (locator as unknown as { isEnabled?: () => Promise<boolean> }).isEnabled?.();
          if (enabled === false) return `${id} locator is disabled: ${precondition.locator}`;
        } catch {
          return `${id} locator is not enabled: ${precondition.locator}`;
        }
      }
    }
    return undefined;
  }

  private async resolveTotpValue(step: DslStep, input: ExecuteInput, runId: string): Promise<string> {
    const options = readTotpOptions(step.valueFrom);
    const account = options.account ?? readDynamicCodeAccount(step, input);
    const target = account ?? options.entry ?? "totp";
    const startedAt = Date.now();
    const requestSummary = {
      project: this.context.project.projectKey,
      env: this.context.env.env,
      provider: options.provider ?? "keepassxc",
      account: account ? maskRedisVerificationKey(account) : undefined,
      entry: options.entry ? maskTotpEntry(options.entry) : undefined,
      scene: options.scene ?? "totp"
    };
    let providerCallRecorded = false;
    try {
      const result = await getVerificationCode(this.context, {
        provider: "totp",
        account: target,
        scene: options.scene ?? "totp",
        codeType: "totp",
        entry: options.entry,
        entryRoot: options.entryRoot,
        cliPath: options.cliPath,
        databasePath: options.databasePath,
        timeoutMs: options.timeoutMs
      });
      this.recordProviderCall(runId, {
        provider: "keepassxc",
        operation: "get_totp",
        scene: options.scene ?? "totp",
        startedAt: new Date(startedAt).toISOString(),
        endedAt: new Date().toISOString(),
        elapsedMs: Date.now() - startedAt,
        status: result.success && result.code ? "success" : "failed",
        errorCode: result.errorCode,
        errorMessage: result.errorMessage,
        requestSummary
      });
      providerCallRecorded = true;
      if (!result.success || !result.code) throw new Error(result.errorMessage ?? "TOTP verification code fetch failed.");
      logger.info("Resolved TOTP code", {
        project: this.context.project.projectKey,
        env: this.context.env.env,
        provider: options.provider ?? "keepassxc",
        account,
        entry: options.entry ? maskTotpEntry(options.entry) : undefined,
        code: "******"
      });
      return result.code;
    } catch (error) {
      if (!providerCallRecorded) {
        this.recordProviderCall(runId, {
          provider: "keepassxc",
          operation: "get_totp",
          scene: options.scene ?? "totp",
          startedAt: new Date(startedAt).toISOString(),
          endedAt: new Date().toISOString(),
          elapsedMs: Date.now() - startedAt,
          status: "failed",
          errorCode: "provider_error",
          errorMessage: error instanceof Error ? error.message : String(error),
          requestSummary
        });
      }
      throw error;
    }
  }

  private async tryLocatorAction(
    driver: WebDriverAdapter,
    step: DslStep,
    locator: string,
    fallbackLevel: FallbackLevel,
    runId: string
  ): Promise<StepOutcome> {
    const startedAt = Date.now();
    const actionTimeoutMs = Math.max(1_000, step.timeout_ms ?? step.timeoutMs ?? 5_000);
    const tracePath = path.join(this.context.rootDir, this.context.workspace.artifactRoot, "execution", runId, "operation-trace.jsonl");
    await this.appendOperationTrace(tracePath, {
      event: "locator_action.start",
      runId,
      stepId: step.id,
      action: step.action,
      semanticTarget: semanticTargetOf(step),
      locator,
      fallbackLevel,
      timeoutMs: actionTimeoutMs,
      at: new Date().toISOString()
    });
    try {
      if (step.action === "click") {
        await withTimeout(driver.click(locator), actionTimeoutMs + 500, `Step ${step.id} click timed out after ${actionTimeoutMs}ms.`);
        await this.verifyActionPostconditions(driver, step, actionTimeoutMs, tracePath, runId, locator);
      }
      else if (step.action === "input") {
        await withTimeout(driver.input(locator, String(step.value ?? "")), actionTimeoutMs + 500, `Step ${step.id} input timed out after ${actionTimeoutMs}ms.`);
        await this.verifyActionPostconditions(driver, step, actionTimeoutMs, tracePath, runId, locator);
      }
      else if (step.action === "setDateRange") {
        if (!driver.setDateRange) return { status: "skipped", fallbackLevel, locator, error: "Driver does not support setDateRange." };
        const result = await withTimeout(driver.setDateRange(locator, step.value, { timeoutMs: actionTimeoutMs }), actionTimeoutMs + 1_000, `Step ${step.id} setDateRange timed out after ${actionTimeoutMs}ms.`);
        await this.recordCurrentPage(driver, runId, redactSensitiveStep(step), locator, true, Date.now() - startedAt);
        await this.appendOperationTrace(tracePath, {
          event: "locator_action.end",
          runId,
          stepId: step.id,
          action: step.action,
          locator,
          fallbackLevel,
          status: fallbackLevel > 0 ? "healed" : "passed",
          actionResult: summarizeActionResult(result),
          elapsedMs: Date.now() - startedAt,
          at: new Date().toISOString()
        });
        return { status: fallbackLevel > 0 ? "healed" : "passed", fallbackLevel, locator, actionResult: result };
      }
      else if (step.action === "select") {
        const result = await withTimeout(driver.selectDropdownOption(locator, String(step.value ?? ""), {
          component: (step as unknown as Record<string, unknown>).component,
          postconditions: (step as unknown as Record<string, unknown>).postconditions,
          timeoutMs: actionTimeoutMs
        }), actionTimeoutMs + 1_000, `Step ${step.id} select timed out after ${actionTimeoutMs}ms.`);
        await this.recordCurrentPage(driver, runId, redactSensitiveStep(step), locator, true, Date.now() - startedAt);
        await this.appendOperationTrace(tracePath, {
          event: "locator_action.end",
          runId,
          stepId: step.id,
          action: step.action,
          locator,
          fallbackLevel,
          status: fallbackLevel > 0 ? "healed" : "passed",
          actionResult: summarizeActionResult(result),
          elapsedMs: Date.now() - startedAt,
          at: new Date().toISOString()
        });
        return { status: fallbackLevel > 0 ? "healed" : "passed", fallbackLevel, locator, actionResult: result };
      }
      else if (step.action === "assert" && step.assertion) {
        const assertion = withRuntimeSelectedFilters(step.assertion, this.selectedFiltersByRun.get(runId) ?? []);
        await withTimeout(driver.assertState(assertion), actionTimeoutMs + 500, `Step ${step.id} assertion timed out after ${actionTimeoutMs}ms.`);
        step.assertion.actual = assertion.actual;
        step.assertion.diagnostics = assertion.diagnostics;
      }
      else if (step.action === "wait") await driver.waitFor(locator, step.timeout_ms ?? step.timeoutMs);
      else return { status: "skipped", fallbackLevel, locator, error: `Unsupported action: ${step.action}` };
      await this.recordCurrentPage(driver, runId, redactSensitiveStep(step), locator, true, Date.now() - startedAt);
      await this.appendOperationTrace(tracePath, {
        event: "locator_action.end",
        runId,
        stepId: step.id,
        action: step.action,
        locator,
        fallbackLevel,
        status: fallbackLevel > 0 ? "healed" : "passed",
        elapsedMs: Date.now() - startedAt,
        at: new Date().toISOString()
      });
      return { status: fallbackLevel > 0 ? "healed" : "passed", fallbackLevel, locator };
    } catch (error) {
      await this.recordTransitionFailure(driver, runId, redactSensitiveStep(step), locator, Date.now() - startedAt);
      await this.appendOperationTrace(tracePath, {
        event: "locator_action.end",
        runId,
        stepId: step.id,
        action: step.action,
        locator,
        fallbackLevel,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
        actionResult: summarizeActionResult(error && typeof error === "object" && "actionResult" in error
          ? (error as { actionResult?: unknown }).actionResult
          : undefined),
        elapsedMs: Date.now() - startedAt,
        at: new Date().toISOString()
      });
      return {
        status: "failed",
        fallbackLevel,
        locator,
        error: error instanceof Error ? error.message : String(error),
        actionResult: error && typeof error === "object" && "actionResult" in error
          ? (error as { actionResult?: unknown }).actionResult
          : undefined
      };
    }
  }

  private async verifyActionPostconditions(
    driver: WebDriverAdapter,
    step: DslStep,
    actionTimeoutMs: number,
    tracePath: string,
    runId: string,
    locator: string
  ): Promise<void> {
    const postconditions = Array.isArray((step as unknown as Record<string, unknown>).postconditions)
      ? (step as unknown as { postconditions: Array<Record<string, unknown>> }).postconditions
      : [];
    for (const postcondition of postconditions) {
      const assertion = postcondition.assertion;
      if (!assertion || typeof assertion !== "object" || typeof (assertion as Record<string, unknown>).type !== "string") continue;
      const startedAt = Date.now();
      await this.appendOperationTrace(tracePath, {
        event: "postcondition.start",
        runId,
        stepId: step.id,
        locator,
        postconditionId: postcondition.id,
        postconditionType: postcondition.type,
        at: new Date().toISOString()
      });
      try {
        await withTimeout(driver.assertState(assertion as Parameters<WebDriverAdapter["assertState"]>[0]), Math.min(actionTimeoutMs, 5_000) + 500, `Postcondition ${postcondition.id ?? "unknown"} timed out.`);
        await this.appendOperationTrace(tracePath, {
          event: "postcondition.end",
          runId,
          stepId: step.id,
          locator,
          postconditionId: postcondition.id,
          postconditionType: postcondition.type,
          status: "passed",
          elapsedMs: Date.now() - startedAt,
          at: new Date().toISOString()
        });
      } catch (error) {
        await this.appendOperationTrace(tracePath, {
          event: "postcondition.end",
          runId,
          stepId: step.id,
          locator,
          postconditionId: postcondition.id,
          postconditionType: postcondition.type,
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
          elapsedMs: Date.now() - startedAt,
          at: new Date().toISOString()
        });
        const actionResult = {
          rootCause: "action_postcondition_failed",
          locator,
          postconditionId: postcondition.id,
          postconditionType: postcondition.type,
          assertion,
          error: error instanceof Error ? error.message : String(error)
        };
        const wrapped = new Error(`Action postcondition failed for ${semanticTargetOf(step) ?? step.id}: ${postcondition.id ?? postcondition.type ?? "unknown"}`);
        (wrapped as Error & { actionResult?: unknown }).actionResult = actionResult;
        throw wrapped;
      }
    }
  }

  private async executeApiStep(step: DslStep, context: LoadedContext): Promise<StepOutcome> {
    if (step.action !== "apiGet") return { status: "skipped", fallbackLevel: 0, error: `Unsupported API action: ${step.action}` };
    const baseUrl = context.env.api?.baseUrl;
    if (!baseUrl || !step.target) return { status: "skipped", fallbackLevel: 0, error: "API baseUrl or target is missing." };
    const response = await fetch(new URL(step.target, baseUrl));
    return response.ok
      ? { status: "passed", fallbackLevel: 0, locator: response.url }
      : { status: "failed", fallbackLevel: 0, locator: response.url, error: `HTTP ${response.status}` };
  }

  private async tryVisualHealing(input: {
    step: DslStep;
    index: number;
    runId: string;
    mode: ExecutionMode;
    driver?: WebDriverAdapter;
    input: ExecuteInput;
  }, attemptedLocators: string[]): Promise<StepOutcome> {
    const { step, driver } = input;
    const semanticTarget = semanticTargetOf(step);
    if (!driver || !semanticTarget || !driver.findVisualTargets || !driver.clickAt) {
      return { status: "failed", fallbackLevel: 3, attemptedLocators };
    }
    const artifactDir = path.join(this.context.rootDir, this.context.workspace.artifactRoot, "execution", input.runId);
    await fs.ensureDir(artifactDir);
    const screenshotPath = path.join(artifactDir, `${step.id ?? input.index + 1}-visual.png`);
    await driver.takeScreenshot(screenshotPath).catch(() => undefined);
    const candidates = await driver.findVisualTargets(semanticTarget, step.action).catch(() => []);
    for (const candidate of candidates) {
      const locator = candidate.locator ?? `visual:${Math.round(candidate.x)},${Math.round(candidate.y)}`;
      attemptedLocators.push(locator);
      if (isLocatorForbiddenByStepGuard(step, locator)) continue;
      try {
        if (step.action === "click") await driver.clickAt(candidate.x, candidate.y);
        else if (step.action === "input" && driver.inputAt) await driver.inputAt(candidate.x, candidate.y, String(step.value ?? ""));
        else continue;
        await this.recordCurrentPage(driver, input.runId, redactSensitiveStep(step), locator, true, 0);
        await this.recordElementSuccess(redactSensitiveStep(step), locator, 3, driver, {
          elementType: elementTypeOf(step),
          textCandidates: candidate.textCandidates,
          nearbyTexts: candidate.nearbyTexts,
          screenRegion: {
            x: Math.round(candidate.x - candidate.width / 2),
            y: Math.round(candidate.y - candidate.height / 2),
            width: Math.round(candidate.width),
            height: Math.round(candidate.height)
          },
          visualSignature: path.relative(this.context.rootDir, screenshotPath)
        }, input.runId);
        return { status: "healed", fallbackLevel: 3, locator, attemptedLocators };
      } catch (error) {
        logger.warn("Visual healing candidate failed", { locator, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return { status: "failed", fallbackLevel: 3, attemptedLocators };
  }

  private async tryAiReplan(input: {
    step: DslStep;
    index: number;
    runId: string;
    mode: ExecutionMode;
    driver?: WebDriverAdapter;
    input: ExecuteInput;
  }, attemptedLocators: string[]): Promise<StepOutcome> {
    const { step, driver } = input;
    if (!driver) return { status: "failed", fallbackLevel: 4, attemptedLocators };
    const replan = await requestLocalReplan(this.context, {
      runId: input.runId,
      stepId: step.id,
      step: redactSensitiveStep(step),
      semanticTarget: semanticTargetOf(step),
      currentState: {
        urlOrActivity: await driver.getCurrentUrlOrActivity().catch(() => undefined),
        pageTitle: (await driver.getCurrentPageState().catch(() => undefined))?.title,
        domOrPageSource: await driver.getDomOrPageSource().catch(() => undefined),
        accessibilityTree: await driver.getAccessibilityTree().catch(() => undefined)
      },
      attemptedLocators
    });
    if (replan.error) logger.warn("AI local replan skipped or failed", { model: replan.model, error: replan.error });
    for (const locator of uniqueLocators(replan.locators)) {
      attemptedLocators.push(locator);
      if (isLocatorForbiddenByStepGuard(step, locator)) continue;
      const outcome = await this.tryLocatorAction(driver, step, locator, 4, input.runId);
      if (outcome.status === "passed" || outcome.status === "healed") {
        await this.recordElementSuccess(step, locator, 4, driver, { textCandidates: [semanticTargetOf(step) ?? ""], nearbyTexts: [replan.judgement ?? ""] }, input.runId);
        return {
          ...outcome,
          status: "healed",
          fallbackLevel: 4,
          attemptedLocators,
          aiUsed: Boolean(replan.usage),
          tokenInput: replan.usage?.prompt_tokens,
          tokenOutput: replan.usage?.completion_tokens,
          estimatedCost: replan.usage?.estimated_cost
        };
      }
    }
    return {
      status: "failed",
      fallbackLevel: 4,
      attemptedLocators,
      aiUsed: Boolean(replan.usage),
      tokenInput: replan.usage?.prompt_tokens,
      tokenOutput: replan.usage?.completion_tokens,
      estimatedCost: replan.usage?.estimated_cost,
      error: replan.error ?? replan.judgement
    };
  }

  private async recordCurrentPage(
    driver: WebDriverAdapter,
    runId: string,
    step: DslStep,
    locator: string,
    success: boolean,
    durationMs: number
  ): Promise<void> {
    if (isPageModelStep(step)) return;
    const state = await driver.getCurrentPageState().catch(() => undefined);
    if (!state) return;
    await this.pageStateStore.upsertState(state);
    const previousPageId = this.lastPageStateByRun.get(runId);
    if (previousPageId && previousPageId !== state.page_id) {
      const transitionId = pageStateId([previousPageId, state.page_id, step.action, locator]);
      await this.pageStateStore.recordTransition(
        {
          transition_id: transitionId,
          from_page_id: previousPageId,
          to_page_id: state.page_id,
          action_description: `${step.action}:${semanticTargetOf(step) ?? locator}`,
          dsl_steps: [step],
          success_count: 0,
          failure_count: 0,
          average_duration_ms: 0,
          confidence_score: 0
        },
        success,
        durationMs
      );
    }
    this.lastPageStateByRun.set(runId, state.page_id);
  }

  private async recordTransitionFailure(
    driver: WebDriverAdapter,
    runId: string,
    step: DslStep,
    locator: string,
    durationMs: number
  ): Promise<void> {
    if (isPageModelStep(step)) return;
    const current = await driver.getCurrentPageState().catch(() => undefined);
    const previousPageId = this.lastPageStateByRun.get(runId);
    if (!current || !previousPageId) return;
    await this.pageStateStore.recordTransition(
      {
        transition_id: pageStateId([previousPageId, current.page_id, step.action, locator]),
        from_page_id: previousPageId,
        to_page_id: current.page_id,
        action_description: `${step.action}:${semanticTargetOf(step) ?? locator}`,
        dsl_steps: [step],
        success_count: 0,
        failure_count: 0,
        average_duration_ms: 0,
        confidence_score: 0
      },
      false,
      durationMs
    );
  }

  private async recordElementSuccess(
    step: DslStep,
    locator: string,
    fallbackLevel: FallbackLevel,
    driver: WebDriverAdapter,
    candidate?: {
      elementType?: string;
      textCandidates?: string[];
      nearbyTexts?: string[];
      screenRegion?: Parameters<SmartElementStore["recordSuccess"]>[0]["screenRegion"];
      visualSignature?: string;
    },
    runId?: string
  ): Promise<void> {
    const semanticTarget = semanticTargetOf(step);
    if (!semanticTarget || step.action === "navigate" || step.action === "assert") return;

    // P5.2：自愈成功直接进 unified evidence sink——对所有来源步骤生效（含 page-model DSL 步骤）。
    // 旧 smartElementStore 记录仅对非 page-model 步骤保留，但 evidence sink 是知识飞轮的输入，
    // 不能被 isPageModelStep guard 拦掉。
    if (fallbackLevel > 0) {
      logger.info("Self-healing locator recorded", { semanticTarget, locator, fallbackLevel });
      try {
        const { recordKnowledgeEvidence } = await import("./knowledge-evidence-sink.js");
        const state = await driver.getCurrentPageState().catch(() => undefined);
        await recordKnowledgeEvidence(this.context.rootDir, {
          project: this.context.project.projectKey,
          knowledgeType: "LOCATOR",
          pageId: state?.page_id ?? "(unknown)",
          targetId: semanticTarget,
          sourceType: "SELF_HEALING",
          sourceRunId: runId,
          observation: { oldLocator: step.primary_locator ?? step.locator_strategy, newLocator: locator, fallbackLevel, attemptedLocators: step.fallback_locators ?? [] },
          confidence: "HIGH",
          pageSignature: state?.dom_signature,
          environment: this.context.env.env,
          observedValue: locator,
          outcome: "success"
        });
      } catch (error) {
        logger.warn("Self-healing evidence sink failed (non-blocking)", { semanticTarget, error: error instanceof Error ? error.message : String(error) });
      }
    }

    if (isPageModelStep(step)) return;
    const state = await driver.getCurrentPageState().catch(() => undefined);
    await this.smartElementStore.recordSuccess({
      projectId: this.context.project.projectKey,
      platform: "web",
      pageId: state?.page_id,
      semanticName: semanticTarget,
      elementType: candidate?.elementType === undefined ? elementTypeOf(step) : (candidate.elementType as ReturnType<typeof elementTypeOf>),
      locator,
      textCandidates: [...new Set([semanticTarget, step.target ?? "", ...(candidate?.textCandidates ?? [])].filter(Boolean))],
      nearbyTexts: candidate?.nearbyTexts,
      screenRegion: candidate?.screenRegion,
      visualSignature: candidate?.visualSignature
    });
  }

  private async writeFailureReport(input: { step: DslStep; runId: string; driver?: WebDriverAdapter; testCase?: AutomationCase }, record: StepExecution, caseId: string): Promise<void> {
    const aiUsages = await this.executionStore.listAIUsage(input.runId);
    const previousSteps = await this.executionStore.listSteps(input.runId).catch(() => [record]);
    const safeStep = redactSensitiveStep(input.step);
    const baseReport = {
      run_id: input.runId,
      case_id: caseId,
      step_id: record.step_id,
      category: classifyFailure(record.error_message, safeStep, record),
      failed_step: safeStep,
      failed_layer: record.fallback_level_used,
      error_message: record.error_message,
      screenshot_path: record.after_screenshot_path ?? record.before_screenshot_path,
      dom_snapshot_path: record.dom_snapshot_path,
      page_source_path: record.page_source_path,
      attempted_locators: uniqueLocators([record.primary_locator, record.actual_locator_used, ...(record.attempted_locators ?? [])].filter(Boolean) as string[]),
      ai_usage_ids: aiUsages.filter((item) => !record.step_id || item.step_id === record.dsl_step_id || item.step_id === record.step_id).map((item) => item.usage_id),
      ai_judgement: record.ai_used ? "AI assisted fallback was attempted." : undefined,
      suggested_fix: suggestFix(record, safeStep)
    };
    const codexPackage = await writeCodexFailurePackage({
      context: this.context,
      runId: input.runId,
      caseId,
      step: safeStep,
      record,
      report: baseReport,
      providerCalls: this.providerCallsByRun.get(input.runId) ?? [],
      previousSteps,
      automationCase: input.testCase,
      domOrPageSource: record.dom_snapshot_path ? await fs.readFile(record.dom_snapshot_path, "utf8").catch(() => undefined) : undefined
    }).catch((error) => {
      logger.warn("Failed to write Codex failure package", { error: error instanceof Error ? error.message : String(error) });
      return undefined;
    });
    await this.executionStore.appendFailureReport({
      report_id: crypto.randomUUID(),
      ...baseReport,
      codex_failure_package_path: codexPackage?.packagePath,
      codex_prompt_path: codexPackage?.promptPath,
      created_at: new Date().toISOString()
    });
  }

  private async writeSyntheticFailureStep(input: { step: DslStep; index: number; runId: string; error: string; caseId: string }): Promise<void> {
    const stepId = input.step.id ?? `${input.index + 1}`;
    const record: StepExecution = {
      step_id: crypto.randomUUID(),
      run_id: input.runId,
      dsl_step_id: stepId,
      action_type: input.step.action,
      target_semantic_name: semanticTargetOf(input.step),
      primary_locator: primaryLocatorOf(input.step),
      fallback_level_used: 0,
      status: "failed",
      error_message: input.error,
      duration_ms: 0,
      ai_used: false,
      token_input: 0,
      token_output: 0,
      estimated_cost: 0,
      attempted_locators: []
    };
    await this.executionStore.appendStep(record);
    await this.writeFailureReport({ step: input.step, runId: input.runId }, record, input.caseId);
  }

  private async canUseAi(runId: string, options: RuntimeOptions): Promise<boolean> {
    const usages = await this.executionStore.listAIUsage(runId);
    if (options.maxAiCalls !== undefined && usages.filter((item) => !item.cache_hit).length >= options.maxAiCalls) return false;
    const tokens = usages.reduce((sum, item) => sum + item.total_tokens, 0);
    if (options.maxAiTokens !== undefined && tokens >= options.maxAiTokens) return false;
    const cost = usages.reduce((sum, item) => sum + item.estimated_cost, 0);
    if (options.maxEstimatedCost !== undefined && cost >= options.maxEstimatedCost) return false;
    return true;
  }

  private recordProviderCall(runId: string, call: ProviderCallRecord): void {
    const calls = this.providerCallsByRun.get(runId) ?? [];
    calls.push(call);
    this.providerCallsByRun.set(runId, calls);
  }

  private recordRuntimeSelectedFilter(runId: string, step: DslStep, outcome: StepOutcome): void {
    if (step.action !== "select") return;
    if (outcome.status !== "passed" && outcome.status !== "healed") return;
    const value = step.value === undefined ? undefined : String(step.value).trim();
    if (!value) return;
    const record = step as unknown as Record<string, any>;
    const actionResult = outcome.actionResult && typeof outcome.actionResult === "object"
      ? outcome.actionResult as Record<string, unknown>
      : {};
    const field = String(record.targetField ?? record.dataBinding?.targetField ?? record.component?.targetField ?? "").trim() || undefined;
    const label = String(record.dataBinding?.filterField ?? record.semantic_target ?? record.semanticTarget ?? "").trim() || undefined;
    const filter: RuntimeSelectedFilter = {
      label,
      field,
      value,
      elementId: typeof record.elementId === "string" ? record.elementId : undefined,
      selectedValueAfter: typeof actionResult.selectedValueAfter === "string" ? actionResult.selectedValueAfter : undefined,
      verified: typeof actionResult.verified === "boolean" ? actionResult.verified : undefined
    };
    const existing = this.selectedFiltersByRun.get(runId) ?? [];
    const key = filter.field ?? filter.elementId ?? filter.label ?? filter.value;
    const next = existing.filter((item) => (item.field ?? item.elementId ?? item.label ?? item.value) !== key);
    next.push(filter);
    this.selectedFiltersByRun.set(runId, next);
  }

  private async appendOperationTrace(filePath: string, event: Record<string, unknown>): Promise<void> {
    await fs.ensureDir(path.dirname(filePath));
    await fs.appendFile(filePath, `${JSON.stringify(event)}\n`, "utf8").catch((error) => {
      logger.warn("Failed to append operation trace", { filePath, error: error instanceof Error ? error.message : String(error) });
    });
  }
}

interface RuntimeSelectedFilter {
  label?: string;
  field?: string;
  value: string;
  elementId?: string;
  selectedValueAfter?: string;
  verified?: boolean;
}

function withRuntimeSelectedFilters(assertion: NonNullable<DslStep["assertion"]>, filters: RuntimeSelectedFilter[]): NonNullable<DslStep["assertion"]> {
  if (filters.length === 0) return assertion;
  return { ...assertion, runtimeSelectedFilters: filters };
}

function isCriticalProviderStep(step: DslStep): boolean {
  const raw = step as unknown as Record<string, unknown>;
  const text = `${step.id ?? ""} ${step.semantic_target ?? step.semanticTarget ?? ""} ${raw.targetField ?? ""} ${step.providerRequirementId ?? ""}`;
  const critical = Boolean(step.scopeGuard?.critical);
  return critical && /provider|verification|email_code|sms_code|totp|send_email_code|confirm_verification|\u9a8c\u8bc1\u7801|\u5b89\u5168\u9a8c\u8bc1/i.test(text);
}

function updateRunFromStep(run: ExecutionRun, step: StepExecution): void {
  if (step.status === "passed" || step.status === "skipped") run.passed_steps += 1;
  if (step.status === "healed") {
    run.passed_steps += 1;
    run.healed_steps += 1;
  }
  if (step.status === "failed") run.failed_steps += 1;
}

function semanticTargetOf(step: DslStep): string | undefined {
  return step.semantic_target ?? step.semanticTarget ?? step.target;
}

function summarizeStepValue(step: DslStep): unknown {
  if (step.value === undefined && step.valueFrom === undefined) return undefined;
  if (step.action === "input" && typeof step.value === "string") {
    return { kind: "input_text", length: step.value.length, preview: step.value.length <= 8 ? step.value : `${step.value.slice(0, 4)}...${step.value.slice(-4)}` };
  }
  if (step.valueFrom) return { valueFrom: step.valueFrom };
  return step.value;
}

function summarizeActionResult(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const raw = value as Record<string, unknown>;
  if (Array.isArray(raw.attempts)) {
    return {
      attempts: raw.attempts.map((attempt) => {
        const item = attempt && typeof attempt === "object" ? attempt as Record<string, unknown> : {};
        return {
          locator: item.locator,
          fallbackLevel: item.fallbackLevel,
          result: summarizeActionResult(item.result)
        };
      })
    };
  }
  return {
    requestedValue: raw.requestedValue,
    popupOpened: raw.popupOpened,
    matchedOption: raw.matchedOption,
    selectedValueBefore: raw.selectedValueBefore,
    selectedValueAfter: raw.selectedValueAfter,
    selectedValueSamples: raw.selectedValueSamples,
    verified: raw.verified,
    alreadySelected: raw.alreadySelected,
    triggerOpened: raw.triggerOpened,
    triggerLocatorUsed: raw.triggerLocatorUsed,
    keyboardSelectionAttempted: raw.keyboardSelectionAttempted,
    keyboardOptionCandidates: raw.keyboardOptionCandidates,
    scopeStillVisibleWhenAlreadySelected: raw.scopeStillVisibleWhenAlreadySelected,
    scopeStillVisibleAfterOptionClick: raw.scopeStillVisibleAfterOptionClick,
    scopeStillVisibleAfterValueVerification: raw.scopeStillVisibleAfterValueVerification,
    postVerificationScope: raw.postVerificationScope,
    resolution: raw.resolution,
    preResolutionScope: raw.preResolutionScope,
    valueLength: raw.valueLength,
    valueBefore: raw.valueBefore,
    valueAfterFill: raw.valueAfterFill,
    valueAfterType: raw.valueAfterType,
    error: raw.error
  };
}

async function emitExecutionStepProgress(options: RuntimeOptions, event: Parameters<NonNullable<RuntimeOptions["onStep"]>>[0]): Promise<void> {
  if (!options.onStep) return;
  try {
    await options.onStep(event);
  } catch (error) {
    logger.warn("Execution progress callback failed", { error: error instanceof Error ? error.message : String(error) });
  }
}

function summarizeStepExecutionForProgress(record: StepExecution): Partial<StepExecution> {
  return {
    step_id: record.step_id,
    run_id: record.run_id,
    dsl_step_id: record.dsl_step_id,
    action_type: record.action_type,
    target_semantic_name: record.target_semantic_name,
    primary_locator: record.primary_locator,
    actual_locator_used: record.actual_locator_used,
    fallback_level_used: record.fallback_level_used,
    status: record.status,
    error_message: record.error_message,
    duration_ms: record.duration_ms,
    attempted_locators: record.attempted_locators,
    action_result: summarizeActionResult(record.action_result),
    assertion_summary: record.assertion_summary
  };
}

function readableAssertionSummary(step: DslStep, index: number): string {
  const assertion = step.assertion as NonNullable<DslStep["assertion"]>;
  if (assertion.type === "message_visible_exact") {
    return `步骤 ${String(index + 1).padStart(2, "0")} 断言：页面提示精确匹配 ${displayAssertionValue(assertion.expected)}`;
  }
  if (assertion.type === "element_disabled") {
    return `步骤 ${String(index + 1).padStart(2, "0")} 断言：目标控件置灰且不可点击`;
  }
  if (assertion.type === "element_enabled") {
    return `步骤 ${String(index + 1).padStart(2, "0")} 断言：目标控件高亮且可点击`;
  }
  if (assertion.type === "table_column_date_between") {
    return `步骤 ${String(index + 1).padStart(2, "0")} 断言：${assertion.column ?? assertion.intent?.field ?? "时间"}列在 ${displayAssertionValue(assertion.expected)} 范围内`;
  }
  const column = assertion.column ?? assertion.intent?.field;
  const expected = assertion.expected ?? assertion.intent?.expected;
  const prefix = `步骤 ${String(index + 1).padStart(2, "0")} 断言`;
  if (column && expected !== undefined) return `${prefix}：${column}列仅返回 ${displayAssertionValue(expected)}`;
  if (assertion.emptyStateAccepted) return `${prefix}：列表为空或符合预期`;
  return `${prefix}：${assertion.target ?? semanticTargetOf(step) ?? assertion.type ?? "结果符合预期"}`;
}

function displayAssertionValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(String).join(" / ");
  if (value && typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function isPageModelStep(step: DslStep | Record<string, unknown>): boolean {
  const record = step as Record<string, unknown>;
  return record.source === "page_model" || Boolean(record.evidenceId && record.pageId);
}

function primaryLocatorOf(step: DslStep): string | undefined {
  return step.primary_locator ?? step.primaryLocator ?? locatorFromLegacyTarget(step.target);
}

function fallbackLocatorsOf(step: DslStep): string[] {
  return step.fallback_locators ?? step.fallbackLocators ?? [];
}

function uniqueLocators(locators: string[]): string[] {
  return [...new Set(locators.filter(Boolean))];
}

function isComponentSelectStep(step: DslStep): boolean {
  const record = step as unknown as Record<string, unknown>;
  const component = record.component && typeof record.component === "object" ? record.component as Record<string, unknown> : undefined;
  return step.action === "select" && component?.type === "dropdown";
}

function isComponentTriggerLocator(locator: string): boolean {
  const value = locator.trim();
  if (!value) return false;
  if (/^(visual:|text=visual:)/i.test(value)) return false;
  if (/^(text=|textExact=)/i.test(value)) return true;
  if (/^fieldRelative=/i.test(value)) return true;
  if (/^(css=|xpath=|role=)/i.test(value)) return true;
  return /(\[role=["']?combobox["']?\]|select|button|input|\.[\w-]*select|dropdown)/i.test(value);
}

function componentTriggerPriority(locator: string): number {
  const value = locator.trim();
  if (/^fieldRelative=/i.test(value)) return 90;
  if (/^(textExact=|role=)/i.test(value)) return 80;
  if (/^text=/i.test(value)) return 70;
  if (/\[role=["']?combobox["']?\]|data-slot=["']?popover-trigger["']?/i.test(value)) return 60;
  if (/nth=\d+/i.test(value)) return 10;
  return 40;
}

function uniqueSemanticCandidates<T extends { locator: string }>(candidates: T[]): T[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    if (seen.has(candidate.locator)) return false;
    seen.add(candidate.locator);
    return true;
  });
}

export function isLocatorForbiddenByStepGuard(step: Pick<DslStep, "scopeGuard" | "negativeLocatorHints">, locator: string): boolean {
  const patterns = [
    ...(step.scopeGuard?.forbiddenLocatorPatterns ?? []),
    ...(step.negativeLocatorHints ?? [])
  ].filter(Boolean);
  return patterns.some((pattern) => matchesLocatorGuardPattern(locator, pattern));
}

function matchesLocatorGuardPattern(locator: string, pattern: string): boolean {
  if (!pattern) return false;
  const ariaContains = pattern.match(/^\[aria-label\*=(?:"|')(.+?)(?:"|')\]$/);
  if (ariaContains) return new RegExp(`\\[aria-label\\*=(?:"|')[^"']*${escapeRegExp(ariaContains[1])}[^"']*(?:"|')\\]`, "i").test(locator);
  if (pattern.startsWith("/") && pattern.endsWith("/") && pattern.length > 2) {
    try {
      return new RegExp(pattern.slice(1, -1), "i").test(locator);
    } catch {
      return locator.toLowerCase().includes(pattern.toLowerCase());
    }
  }
  return locator.toLowerCase().includes(pattern.toLowerCase());
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildObservationContext(context: LoadedContext, options: RuntimeOptions, runId: string): ObservationContext {
  const enabled = Boolean(options.observationMode);
  const profile = options.observationProfile ?? "execution";
  const relativeArtifactDir = path.join("artifacts", "observations", "execution-runs", runId);
  const artifactDir = path.join(context.rootDir, relativeArtifactDir);
  return {
    enabled,
    profile,
    artifactDir,
    videoDir: path.join(artifactDir, "videos"),
    relativeArtifactDir: relativeArtifactDir.replace(/\\/g, "/")
  };
}

async function finalizeObservationRun(
  context: LoadedContext,
  options: RuntimeOptions,
  run: ExecutionRun,
  observation: ObservationContext,
  testCase: AutomationCase
): Promise<void> {
  await fs.ensureDir(observation.artifactDir);
  const videoFiles = await listFilesIfExists(observation.videoDir);
  const keepVideos = run.status !== "passed";
  if (!keepVideos && videoFiles.length) await fs.emptyDir(observation.videoDir).catch(() => undefined);
  const stepDir = path.join(observation.artifactDir, "steps");
  const stepFiles = await listFilesIfExists(stepDir);
  const summary = {
    schemaVersion: "execution-observation.v1",
    runId: run.run_id,
    project: context.project.projectKey,
    env: context.env.env,
    testCaseId: testCase.id,
    status: run.status,
    profile: observation.profile,
    createdAt: run.start_time,
    completedAt: run.end_time ?? new Date().toISOString(),
    retention: {
      observationRun: "24h",
      assertionEvidence: "7d",
      failedVideo: "7d"
    },
    policy: {
      normalExecutionScreenshots: false,
      snapshotScope: "observation-mode-only",
      videoPolicy: keepVideos ? "failed-run-video-retained" : "passed-run-video-not-retained",
      keyFramePolicy: "deterministic-hit-or-boundary-frame-no-business-regex"
    },
    artifacts: {
      stepsDir: relativeFromRoot(context, stepDir),
      videoDir: keepVideos ? relativeFromRoot(context, observation.videoDir) : undefined,
      stepFileCount: stepFiles.length,
      videoFileCount: keepVideos ? videoFiles.length : 0
    },
    runtimeOptions: {
      mode: options.mode,
      observationMode: options.observationMode,
      observationProfile: options.observationProfile
    }
  };
  const summaryPath = path.join(observation.artifactDir, "observation-summary.json");
  await writeSafeJsonFile(summaryPath, summary);
  await appendObservationIndex(context, {
    runId: run.run_id,
    project: context.project.projectKey,
    env: context.env.env,
    testCaseId: testCase.id,
    status: run.status,
    profile: observation.profile,
    artifactPath: observation.relativeArtifactDir,
    summaryPath: relativeFromRoot(context, summaryPath),
    createdAt: run.start_time,
    completedAt: summary.completedAt
  });
}

async function appendObservationIndex(context: LoadedContext, entry: Record<string, unknown>): Promise<void> {
  const indexPath = path.join(context.rootDir, "storage", "observation-runs", "index.json");
  await fs.ensureDir(path.dirname(indexPath));
  const current = await fs.readJson(indexPath).catch(() => ({ schemaVersion: "observation-run-index.v1", updatedAt: "", runs: [] }));
  const runs = Array.isArray(current.runs) ? current.runs : [];
  await writeSafeJsonFile(indexPath, {
    schemaVersion: "observation-run-index.v1",
    updatedAt: new Date().toISOString(),
    runs: [entry, ...runs.filter((item: Record<string, unknown>) => item.runId !== entry.runId)].slice(0, 200)
  });
}

async function listFilesIfExists(dir: string): Promise<string[]> {
  if (!(await fs.pathExists(dir))) return [];
  const items = await fs.readdir(dir).catch(() => []);
  return items;
}

function relativeFromRoot(context: LoadedContext, filePath: string): string {
  return path.relative(context.rootDir, filePath).replace(/\\/g, "/");
}

function locatorFromLegacyTarget(target?: string): string | undefined {
  if (!target) return undefined;
  if (/^(css=|xpath=|text=|role=|\.|#|\[|\/\/|input|button|textarea|select)/.test(target)) return target;
  return undefined;
}

function elementTypeOf(step: DslStep): "button" | "input" | "tab" | "text" | "list_item" | "link" | "unknown" {
  if (step.action === "click") return "button";
  if (step.action === "input") return "input";
  return "unknown";
}

function shouldCollectSnapshot(step: DslStep, mode: ExecutionMode, observation: ObservationContext): boolean {
  if (step.sensitive) return false;
  if (isSensitiveValueFrom(step.valueFrom)) return false;
  if (observation.enabled) return true;
  return mode === "debug" && Boolean(step.collect_snapshot ?? step.collectSnapshot);
}

function navigationTarget(step: DslStep, context: LoadedContext): string | undefined {
  const target = step.primary_locator ?? step.primaryLocator ?? step.target;
  if (target && /^https?:\/\//i.test(target)) return target;
  if (target && target.startsWith("/")) return new URL(target, context.env.web?.baseUrl).toString();
  if (target === "LOGIN_PAGE" || !target) return context.env.web?.baseUrl;
  return undefined;
}

function isRedisVerificationValueFrom(valueFrom: unknown): boolean {
  if (typeof valueFrom === "string") return valueFrom === "redisVerificationCode";
  if (!valueFrom || typeof valueFrom !== "object") return false;
  const raw = valueFrom as Record<string, unknown>;
  if (raw.type === "verificationCredential") return raw.credentialType === "email_code" || raw.credentialType === "sms_code";
  return raw.type === "redisVerificationCode" || (raw.type === "verificationCode" && (raw.provider === undefined || raw.provider === "redis"));
}

function isTotpValueFrom(valueFrom: unknown): boolean {
  if (typeof valueFrom === "string") return ["totp", "totpCode", "keepassxcTotp"].includes(valueFrom);
  if (!valueFrom || typeof valueFrom !== "object") return false;
  const raw = valueFrom as Record<string, unknown>;
  if (raw.type === "verificationCredential") return raw.credentialType === "totp";
  return raw.type === "totp" || raw.type === "totpCode" || raw.type === "keepassxcTotp";
}

function isSensitiveValueFrom(valueFrom: unknown): boolean {
  return isRedisVerificationValueFrom(valueFrom) || isTotpValueFrom(valueFrom);
}

function readRedisVerificationOptions(valueFrom: unknown): { service?: string; network?: "external" | "internal"; timeoutMs?: number; scene?: string; codeType?: "sms" | "email" | "totp" } {
  if (!valueFrom || typeof valueFrom !== "object") return {};
  const raw = valueFrom as Record<string, unknown>;
  return {
    service: typeof raw.service === "string" ? raw.service : undefined,
    network: raw.network === "internal" ? "internal" : raw.network === "external" ? "external" : undefined,
    timeoutMs: raw.timeoutMs === undefined ? undefined : Number(raw.timeoutMs),
    scene: typeof raw.scene === "string" ? raw.scene : undefined,
    codeType: raw.codeType === "sms" || raw.codeType === "email" || raw.codeType === "totp"
      ? raw.codeType
      : raw.credentialType === "sms_code"
        ? "sms"
        : raw.credentialType === "email_code"
          ? "email"
          : undefined
  };
}

function readRedisVerificationAccount(step: DslStep, input: ExecuteInput): string | undefined {
  return readDynamicCodeAccount(step, input);
}

function readDynamicCodeAccount(step: DslStep, input: ExecuteInput): string | undefined {
  const valueFrom = step.valueFrom;
  if (valueFrom && typeof valueFrom === "object" && typeof (valueFrom as Record<string, unknown>).account === "string") {
    return String((valueFrom as Record<string, unknown>).account);
  }
  if (step.value && typeof step.value === "object" && typeof (step.value as Record<string, unknown>).account === "string") {
    return String((step.value as Record<string, unknown>).account);
  }
  if (input.testCase.dataProfile && /@/.test(input.testCase.dataProfile)) return input.testCase.dataProfile;
  return undefined;
}

function readTotpOptions(valueFrom: unknown): {
  provider?: "keepassxc" | "bitwarden" | "onepassword" | "vault";
  account?: string;
  scene?: string;
  entry?: string;
  entryRoot?: string;
  cliPath?: string;
  databasePath?: string;
  timeoutMs?: number;
} {
  if (!valueFrom || typeof valueFrom !== "object") return {};
  const raw = valueFrom as Record<string, unknown>;
  return {
    provider:
      raw.provider === "keepassxc" || raw.provider === "bitwarden" || raw.provider === "onepassword" || raw.provider === "vault"
        ? raw.provider
        : undefined,
    account: typeof raw.account === "string" ? raw.account : undefined,
    scene: typeof raw.scene === "string" ? raw.scene : undefined,
    entry: typeof raw.entry === "string" ? raw.entry : typeof raw.totpEntry === "string" ? raw.totpEntry : undefined,
    entryRoot: typeof raw.entryRoot === "string" ? raw.entryRoot : undefined,
    cliPath: typeof raw.cliPath === "string" ? raw.cliPath : undefined,
    databasePath: typeof raw.databasePath === "string" ? raw.databasePath : undefined,
    timeoutMs: raw.timeoutMs === undefined ? undefined : Number(raw.timeoutMs)
  };
}

function redactSensitiveStep(step: DslStep): DslStep {
  if (!isSensitiveValueFrom(step.valueFrom)) return step;
  return { ...step, value: step.value === undefined ? undefined : "******" };
}

function maskRedisVerificationKey(key: string): string {
  return key.replace(/([A-Z0-9._%+-]{2})[A-Z0-9._%+-]*(@[A-Z0-9.-]+\.[A-Z]{2,})/gi, "$1***$2");
}

function maskTotpEntry(entry: string): string {
  const parts = entry.split("/");
  const tail = parts.pop();
  if (!tail) return "***";
  return [...parts, tail.length <= 2 ? "***" : `${tail.slice(0, 2)}***`].join("/");
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function remainingExecutionBudget(startedAt: number, maxDurationMs: number): number {
  return Math.max(1, maxDurationMs - (Date.now() - startedAt));
}

function ensureExecutionBudget(startedAt: number, maxDurationMs: number, runId: string): void {
  if (Date.now() - startedAt > maxDurationMs) {
    throw new Error(`Execution timed out after ${maxDurationMs}ms for run ${runId}.`);
  }
}

function ensureExecutionNotCancelled(signal: AbortSignal | undefined, runId: string): void {
  if (signal?.aborted) throw new Error(`Execution cancelled for run ${runId}.`);
}

function isExecutionCancelledError(error: unknown): boolean {
  return /Execution cancelled/i.test(error instanceof Error ? error.message : String(error));
}

function platformOf(type: string): "web" | "android" | "app" {
  if (type === "web") return "web";
  if (type === "app") return "android";
  return "app";
}

function classifyFailure(
  message?: string,
  step?: DslStep,
  record?: StepExecution
): "locator_failed" | "page_transition_failed" | "assertion_failed" | "test_data_failed" | "environment_failed" | "ai_decision_failed" | "unknown" {
  const text = (message ?? "").toLowerCase();
  if (step?.action === "assert") return "assertion_failed";
  if (step?.action === "navigate") return "page_transition_failed";
  const componentDiagnosis = componentFailureDiagnosis(record?.action_result);
  if (componentDiagnosis === "page_not_ready") return "page_transition_failed";
  if (componentDiagnosis === "scope_lost") return "page_transition_failed";
  if (componentDiagnosis === "option_not_found") return "test_data_failed";
  if (componentDiagnosis === "value_not_applied") return "assertion_failed";
  if (componentDiagnosis === "trigger_not_opened") return "locator_failed";
  if (["click", "input", "select", "wait"].includes(step?.action ?? "") && ((record?.attempted_locators?.length ?? 0) > 0 || record?.primary_locator)) {
    return "locator_failed";
  }
  if (text.includes("assert") || text.includes("expected")) return "assertion_failed";
  if (text.includes("timeout") || text.includes("locator") || text.includes("visible")) return "locator_failed";
  if (text.includes("http") || text.includes("network")) return "environment_failed";
  if (text.includes("unresolved navigation")) return "page_transition_failed";
  if (text.includes("data") || text.includes("account")) return "test_data_failed";
  if (text.includes("ai")) return "ai_decision_failed";
  return "unknown";
}

function suggestFix(record: StepExecution, step: DslStep): string {
  const target = record.target_semantic_name ?? step.target ?? step.action;
  const componentDiagnosis = componentFailureDiagnosis(record.action_result);
  if (componentDiagnosis === "page_not_ready") {
    return `Add a page readiness contract before component actions for target: ${target}`;
  }
  if (componentDiagnosis === "scope_lost") {
    return `Fix the component action postcondition for target: ${target}; the field scope disappeared after the action and should not be treated as a successful locator match`;
  }
  if (componentDiagnosis === "option_not_found") {
    return `Validate dropdown option inventory in Page Model Store and model option discovery for target: ${target}`;
  }
  if (componentDiagnosis === "value_not_applied") {
    return `Fix dropdown selected-value postcondition mapping for target: ${target}`;
  }
  if (componentDiagnosis === "trigger_not_opened") {
    return `Add a semantic dropdown trigger binding for target: ${target}; avoid index-only combobox locators as primary execution evidence`;
  }
  if (record.status === "failed" && record.fallback_level_used <= 2) {
    return `Check page state and add a stable primary_locator or fallback_locators for semantic target: ${target}`;
  }
  if (step.action === "assert") return `Check assertion definition and current page state for target: ${target}`;
  if (step.action === "navigate") return `Check expected page path or environment entry URL for target: ${target}`;
  return `Review failed step and update DSL or SmartElement memory for target: ${target}`;
}

function componentFailureDiagnosis(actionResult: unknown): "page_not_ready" | "trigger_not_opened" | "option_not_found" | "value_not_applied" | "scope_lost" | undefined {
  const attempts = actionResult && typeof actionResult === "object" && Array.isArray((actionResult as Record<string, unknown>).attempts)
    ? (actionResult as { attempts: Array<Record<string, unknown>> }).attempts
    : actionResult && typeof actionResult === "object"
      ? [{ result: actionResult as Record<string, unknown> }]
      : [];
  for (const attempt of attempts) {
    const result = attempt.result && typeof attempt.result === "object" ? attempt.result as Record<string, unknown> : {};
    const readiness = result.readiness && typeof result.readiness === "object" ? result.readiness as Record<string, unknown> : {};
    if (readiness.ready === false || Number(readiness.skeletonCount ?? 0) > 0 || Number(readiness.busyCount ?? 0) > 0) return "page_not_ready";
    if (
      result.scopeStillVisibleAfterOptionClick === false ||
      result.scopeStillVisibleAfterValueVerification === false ||
      result.scopeStillVisibleWhenAlreadySelected === false ||
      result.scopeStillVisibleWhenAlreadySelectedAfterOpen === false
    ) return "scope_lost";
    const visibleOptions = Array.isArray(result.visibleOptionsAfterOpen) ? result.visibleOptionsAfterOpen : undefined;
    if (result.popupOpened === false && Array.isArray(result.triggerAttempts)) return "trigger_not_opened";
    if (result.popupMaterialized === false || result.rootCause === "dropdown_popup_not_materialized") return "trigger_not_opened";
    if (visibleOptions && visibleOptions.length > 0 && !result.matchedOption) return "option_not_found";
    if (result.matchedOption && result.verified === false) return "value_not_applied";
  }
  return undefined;
}

function assertionExpectationCandidates(step: DslStep): string[] {
  const assertion = step.assertion;
  if (!assertion) return [];
  const expected = Array.isArray(assertion.expected) ? assertion.expected : assertion.expected === undefined ? [] : [assertion.expected];
  return [...new Set([...expected.map(String), assertion.target].filter((item): item is string => Boolean(item && item.trim())))];
}
