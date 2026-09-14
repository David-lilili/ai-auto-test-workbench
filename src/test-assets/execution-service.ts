/**
 * P13 执行服务：prepare → materialize → risk gate → execute → history。
 */

import path from "node:path";
import { TestAssetStore } from "./store.js";
import type { TestAsset } from "./types.js";
import type { ExecutionPreparationPackage, ExecutionReadinessStatus } from "./execution-types.js";
import { evaluateExecutionReadiness } from "./execution-readiness.js";
import { resolveTestDataRequirements, resolveAccountProfileRequirements, loadAccountProfiles, classifyPrecondition } from "./execution-resolvers.js";
import { buildExecutionIntent, resolvePagesForAsset } from "./execution-intent.js";
import { materializeTestAssetDsl, type MaterializationResult } from "./execution-materializer.js";
import { executionRiskGate, environmentGate, createExecutionAuthorization, type ExecutionEnvironment } from "./execution-risk-gate.js";
import { runTestAsset, loadRunHistory, runSummary, type RunInput, type RunOutcome } from "./execution-runner.js";
import { loadKnowledgeStore } from "../requirements/knowledge-store.js";
import { knowledgeVersionFingerprint } from "../requirements/knowledge-context.js";
import { buildStructuredExecutionIntent, resolveExecutionModel, mapExpectedOutcomeToAssertionIntent, expandExecutableOperations } from "./structured-bridge.js";
import type { LoadedContext, RuntimeOptions } from "../core/types.js";

export interface ExecutionContextInput {
  rootDir: string;
  project: string;
  env: string;
  environment: ExecutionEnvironment;
  knowledgeRefsActive?: (ids: string[]) => boolean;
  pageModelStatus?: (pageId: string) => { exists: boolean; superseded: boolean; fresh: boolean; hasRequiredElements: boolean } | undefined;
  capabilityPageResolver?: (capability: string) => string[] | undefined;
  staticFixtures?: Record<string, string>;
  accountProfiles?: Array<Record<string, unknown>>;
  baseUrl?: string;
  pageIdOverride?: string;
}

export class TestAssetExecutionService {
  private readonly store: TestAssetStore;

  constructor(private readonly ctx: ExecutionContextInput) {
    this.store = new TestAssetStore(ctx.rootDir);
  }

  /** P13.2/3/5：Execution Preparation。 */
  async prepare(asset: TestAsset): Promise<ExecutionPreparationPackage> {
    const kb = await loadKnowledgeStore(this.ctx.rootDir);
    const kbFingerprint = knowledgeVersionFingerprint(kb);
    const knowledgeIds = new Set(kb.knowledge.map((k) => k.knowledgeId));
    const knowledgeRefsActive = this.ctx.knowledgeRefsActive ?? ((ids: string[]) => ids.every((id) => knowledgeIds.has(id)));
    const pageResolution = resolvePagesForAsset(asset, this.ctx.capabilityPageResolver);
    const pages = pageResolution.pages;
    const pageModelsAvailable = (ps: string[]) => {
      if (!this.ctx.pageModelStatus) return ps.length === 0;
      return ps.every((p) => this.ctx.pageModelStatus!(p)?.exists);
    };
    const testData = resolveTestDataRequirements(asset.testDataRequirements, {
      staticFixtures: this.ctx.staticFixtures,
      accountProfiles: this.ctx.accountProfiles ?? [],
      envConfig: undefined,
      businessKnowledge: undefined,
      userProvided: undefined
    });
    const profiles = this.ctx.accountProfiles ?? await loadAccountProfiles(this.ctx.rootDir, this.ctx.project, this.ctx.env);
    const profile = resolveAccountProfileRequirements(asset.accountProfileRequirements, profiles);

    const outcomeMaterializable = asset.expectedOutcomes.every((o) => !o.groundingKind || o.groundingKind !== "TESTING_TECHNIQUE");
    const intent = buildExecutionIntent(asset);
    const semanticActionsMaterializable = intent.operations.every((op) => op.mappedTo !== undefined);
    const riskGate = executionRiskGate({ asset, environment: this.ctx.environment, actionText: asset.title });

    // P13-A15：Structured Execution Bridge 字段
    const structuredIntent = buildStructuredExecutionIntent(asset);
    const modelResolution = resolveExecutionModel({
      asset,
      capabilityPageResolver: this.ctx.capabilityPageResolver,
      pageModelStatus: this.ctx.pageModelStatus as never
    });
    const assertionIntents = asset.expectedOutcomes.map((o) => {
      const m = mapExpectedOutcomeToAssertionIntent({ statement: o.statement, knowledgeId: o.knowledgeId, factId: o.factId });
      return { statement: m.statement, userAssertionKind: m.userAssertionKind, mappingSource: m.mappingSource, materializable: m.materializable };
    });
    const executionOperations = asset.semanticActions.flatMap((a) => expandExecutableOperations(asset, a));

    const readinessResult = evaluateExecutionReadiness({
      asset,
      knowledgeRefsActive,
      pageModelsAvailable,
      semanticActionsMaterializable,
      expectedOutcomesMaterializable: outcomeMaterializable,
      testDataResolved: testData.status === "RESOLVED",
      accountProfileResolved: profile.matched,
      riskPermitted: riskGate.allowed,
      blockingAmbiguity: 0,
      executionPathKnown: asset.executionPath.status === "KNOWN",
      staleCriticalKnowledge: asset.knowledgeRefs.some((k) => !knowledgeIds.has(k)) && asset.risk.designPriority === "CRITICAL"
    });

    return {
      executionPreparationId: `prep-${asset.testAssetId}-${Date.now()}`,
      testAssetId: asset.testAssetId,
      testAssetVersion: asset.version,
      requirementRefs: asset.requirementRefs,
      businessRuleRefs: asset.businessRuleRefs,
      capabilityRefs: asset.capabilityRefs,
      semanticActions: asset.semanticActions,
      expectedOutcomes: asset.expectedOutcomes,
      pageModelRefs: pages,
      testDataRequirements: asset.testDataRequirements,
      resolvedTestData: testData.resolved,
      accountProfileRequirements: asset.accountProfileRequirements,
      resolvedAccountProfile: profile,
      executionRisk: asset.risk.executionRisk,
      assetFreshness: asset.assetFreshness,
      executionFreshness: asset.executionFreshness,
      knowledgeFingerprint: kbFingerprint,
      pageModelFingerprint: undefined,
      contextFingerprint: asset.contextFingerprint,
      readiness: readinessResult.status,
      blockReasons: readinessResult.reasons,
      createdAt: new Date().toISOString(),
      structuredIntent,
      resolvedCapabilities: asset.capabilityRefs,
      resolvedPages: modelResolution.resolvedPages,
      executionOperations,
      assertionIntents,
      modelGaps: modelResolution.modelGaps,
      riskAssessment: { riskLevel: riskGate.riskLevel, needsAuthorization: riskGate.needsAuthorization, reason: riskGate.reason },
      materializationInputs: { baseUrl: this.ctx.baseUrl, pageId: this.ctx.pageIdOverride ?? asset.executionPath.pages[0] }
    };
  }

  /** P13-A18：Structured Planner Adapter——TestAsset → 现有 planner（不复制 planner）。 */
  async planTestAssetExecution(asset: TestAsset, input: { pageModelStorePath: string; operationManualStorePath?: string }): Promise<import("../core/page-model-execution-planner.js").PageModelExecutionPlan> {
    const structuredIntent = buildStructuredExecutionIntent(asset);
    const { planPageModelExecution } = await import("../core/page-model-execution-planner.js");
    return planPageModelExecution({
      structuredIntent,
      pageModelStorePath: input.pageModelStorePath,
      operationManualStorePath: input.operationManualStorePath,
      assertions: asset.expectedOutcomes.map((o) => o.statement)
    });
  }

  /** P13.21-27：materialize（只生成 DSL，不执行）。 */
  materialize(asset: TestAsset): MaterializationResult {
    const prepPage = asset.executionPath.pages[0];
    return materializeTestAssetDsl({
      asset,
      baseUrl: this.ctx.baseUrl,
      pageId: this.ctx.pageIdOverride ?? prepPage,
      caseId: `${asset.testAssetId}@${asset.version}`
    });
  }

  /** P13.28-30：risk gate + authorization。 */
  gate(asset: TestAsset, authorization?: { risk: string; expiresAt: string }): { allowed: boolean; reason: string; riskLevel: string; needsAuthorization: boolean } {
    const env = environmentGate({ environment: this.ctx.environment });
    if (!env.allowed) return { allowed: false, reason: env.reason, riskLevel: "ENVIRONMENT", needsAuthorization: true };
    return executionRiskGate({ asset, environment: this.ctx.environment, authorization });
  }

  /** P13.31-40：execute（经 runner）。 */
  async execute(asset: TestAsset, input: { context: LoadedContext; options: RuntimeOptions; authorization?: { risk: string; expiresAt: string }; maxAttempts?: number }): Promise<RunOutcome> {
    const prep = await this.prepare(asset);
    if (prep.readiness === "BLOCKED_BY_RISK" || prep.readiness === "INVALID_ASSET" || prep.readiness === "BLOCKED_BY_KNOWLEDGE") {
      return { result: "RISK_BLOCKED", attempts: [{ attempt: 1, status: "RISK_BLOCKED", error: prep.blockReasons.join(";") }], retried: false, flaky: false, durationMs: 0, detail: prep.blockReasons.join(";") };
    }
    const gate = this.gate(asset, input.authorization);
    if (!gate.allowed) {
      return { result: "RISK_BLOCKED", attempts: [{ attempt: 1, status: "RISK_BLOCKED", error: gate.reason }], retried: false, flaky: false, durationMs: 0, detail: gate.reason };
    }
    const materialized = this.materialize(asset);
    const runInput: RunInput = {
      testCase: materialized.testCase,
      context: input.context,
      options: input.options,
      testAssetId: asset.testAssetId,
      testAssetVersion: asset.version,
      executionPreparationId: prep.executionPreparationId,
      materializationFingerprint: materialized.fingerprint,
      accountProfileId: prep.resolvedAccountProfile?.profileId,
      environment: this.ctx.environment,
      maxAttempts: input.maxAttempts
    };
    return runTestAsset(runInput);
  }

  async history(assetId: string) {
    return loadRunHistory(this.ctx.rootDir, assetId);
  }

  async summary(assetId: string) {
    return runSummary(await this.history(assetId));
  }
}
