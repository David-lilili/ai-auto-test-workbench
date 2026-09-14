/**
 * P15.62：Workspace Command Adapter。
 *
 * 所有写操作经 workspaceCommand() 委托现有 service：
 *   APPROVE_ASSET / REJECT_ASSET / EDIT_ASSET → P12 TestAssetService
 *   APPROVE_REGRESSION / EXCLUDE_ASSET / INCLUDE_ASSET → P14 reviewRegressionPlan
 *   RUN_REGRESSION → P14 runRegressionPlan（内部调 P13 execute）
 *   ANALYZE_REQUIREMENT → P10 pipeline
 * 禁止 workspace 直接写 store。
 */

import path from "node:path";
import fs from "fs-extra";
import { TestAssetService } from "../test-assets/service.js";
import { TestAssetStore, assetContentFingerprint } from "../test-assets/store.js";
import { analyzeRequirement } from "../requirements/pipeline.js";
import { buildCoverageObligations, systematicDesigner } from "../test-design/obligations.js";
import { convertCandidateToTestAsset } from "../test-assets/convert.js";
import { reviewRegressionPlan, type RegressionPlan, type PlanReviewRecord } from "../test-assets/impact/regression-plan.js";
import { runRegressionPlan } from "../test-assets/impact/regression-runner.js";
import { refreshRegressionPlan, newTestRequestKey } from "../test-assets/impact/cross-phase.js";
import { TestAssetExecutionService } from "../test-assets/execution-service.js";
import { loadRequirementStore } from "../requirements/engine.js";
import { writeSafeJsonFile } from "../core/safe-file-writer.js";

export interface WorkspaceCommand {
  type: "APPROVE_ASSET" | "REJECT_ASSET" | "EDIT_ASSET" | "APPROVE_REGRESSION" | "EXCLUDE_ASSET" | "INCLUDE_ASSET" | "RUN_REGRESSION" | "ANALYZE_REQUIREMENT"
    | "GENERATE_TEST_DESIGN" | "REFRESH_PLAN" | "APPROVE_ASSET_UPDATE" | "GENERATE_IMPACT" | "GENERATE_PLAN"
    | "CANDIDATE_APPROVE" | "ASSET_UPDATE_PREVIEW" | "CREATE_ISSUE_DRAFT" | "CREATE_MODELING_REQUEST";
  assetId?: string;
  planId?: string;
  requirementId?: string;
  requirementText?: string;
  reviewer?: string;
  reason?: string;
  edits?: { field: string; value: unknown };
  environment?: string;
  candidateIndex?: number;
}

export interface WorkspaceCommandResult {
  ok: boolean;
  result?: unknown;
  error?: string;
}

/** P11 输入构造（从 RequirementModel）。 */
function buildDesignInput(model: import("../requirements/types.js").RequirementModel) {
  return {
    testDesignInputId: `tdi_${model.requirementId}`, requirementId: model.requirementId, requirementVersion: model.version, requirementSummary: model.summary,
    approvedFacts: [], acceptanceCriteria: model.acceptanceCriteria.map((a) => ({ acId: a.acId, statement: a.statement, origin: a.origin })),
    businessRules: model.businessRules.map((r) => ({ ruleId: r.ruleId, statement: r.statement, condition: r.condition, effect: r.effect, scope: r.scope, origin: r.origin })),
    states: model.states.map((s) => ({ entity: s.entity, fromState: s.fromState, toState: s.toState, trigger: s.trigger, explicitness: s.explicitness })),
    transitions: model.states.map((s) => ({ entity: s.entity, fromState: s.fromState, toState: s.toState, trigger: s.trigger })),
    dependencies: model.dependencies.map((d) => ({ sourceConcept: d.sourceConcept, relation: d.relation, targetConcept: d.targetConcept })),
    constraints: model.constraints.map((c) => ({ field: c.field, operator: c.operator, value: c.value, kind: c.kind })),
    securityRequirements: model.securityImplications.map((s) => ({ statement: s.description, domain: s.area })),
    affectedCapabilities: [], relevantBusinessKnowledgeRefs: [], knownUnknowns: [], resolvedAmbiguities: [], remainingNonBlockingAmbiguities: [],
    riskSummary: model.risks.map((r) => ({ domain: r.domain, level: r.level })), contextFingerprint: "fp", knowledgeSnapshotFingerprint: "ks"
  };
}

export class WorkspaceCommandAdapter {
  constructor(private readonly rootDir: string) {}

  async execute(command: WorkspaceCommand): Promise<WorkspaceCommandResult> {
    const reviewer = command.reviewer ?? "workspace";
    try {
      switch (command.type) {
        case "APPROVE_ASSET": {
          if (!command.assetId) return { ok: false, error: "assetId required" };
          const svc = new TestAssetService(this.rootDir, { knownRequirements: [], knownBusinessRules: [], knownCapabilities: [] });
          const r = await svc.review(command.assetId, "APPROVE", { reviewer, reason: command.reason ?? "workspace approve" });
          return { ok: !r.error, result: { assetId: command.assetId, status: r.asset?.status }, error: r.error };
        }
        case "REJECT_ASSET": {
          if (!command.assetId) return { ok: false, error: "assetId required" };
          const svc = new TestAssetService(this.rootDir, { knownRequirements: [], knownBusinessRules: [], knownCapabilities: [] });
          const r = await svc.review(command.assetId, "REJECT", { reviewer, reason: command.reason ?? "workspace reject" });
          return { ok: !r.error, result: { assetId: command.assetId, status: r.asset?.status }, error: r.error };
        }
        case "EDIT_ASSET": {
          if (!command.assetId || !command.edits) return { ok: false, error: "assetId + edits required" };
          const svc = new TestAssetService(this.rootDir, { knownRequirements: [], knownBusinessRules: [], knownCapabilities: [] });
          const r = await svc.review(command.assetId, "EDIT_AND_APPROVE", { reviewer, reason: command.reason ?? "workspace edit" }, { field: command.edits.field as never, value: command.edits.value });
          return { ok: !r.error, result: { assetId: command.assetId, status: r.asset?.status }, error: r.error };
        }
        case "APPROVE_REGRESSION": {
          if (!command.planId) return { ok: false, error: "planId required" };
          const p = await this.loadPlan(command.planId);
          if (!p) return { ok: false, error: `plan not found: ${command.planId}` };
          const record: PlanReviewRecord = { reviewId: `rev-${Date.now()}`, action: "APPROVE_PLAN", reviewer, timestamp: new Date().toISOString(), reason: command.reason ?? "workspace approve plan" };
          const updated = reviewRegressionPlan(p, record);
          await this.savePlan(updated);
          return { ok: true, result: { planId: command.planId, version: updated.version, status: updated.status } };
        }
        case "EXCLUDE_ASSET":
        case "INCLUDE_ASSET": {
          if (!command.planId || !command.assetId) return { ok: false, error: "planId + assetId required" };
          const p = await this.loadPlan(command.planId);
          if (!p) return { ok: false, error: `plan not found: ${command.planId}` };
          const record: PlanReviewRecord = {
            reviewId: `rev-${Date.now()}`,
            action: command.type === "EXCLUDE_ASSET" ? "EXCLUDE_ASSET" : "INCLUDE_ASSET",
            assetId: command.assetId,
            reviewer,
            timestamp: new Date().toISOString(),
            reason: command.reason ?? (command.type === "EXCLUDE_ASSET" ? "workspace exclude" : "workspace include")
          };
          const updated = reviewRegressionPlan(p, record);
          await this.savePlan(updated);
          const last = updated.reviewHistory[updated.reviewHistory.length - 1];
          return { ok: true, result: { planId: command.planId, assetId: command.assetId, warning: last.warning } };
        }
        case "ANALYZE_REQUIREMENT": {
          if (!command.requirementId || !command.requirementText) return { ok: false, error: "requirementId + text required" };
          const model = analyzeRequirement({ sourceId: command.requirementId, title: command.requirementId, rawContent: command.requirementText });
          // 写入官方 requirement store（P10 pipeline），release view 通过 store 读取
          const { appendRequirementModel } = await import("../requirements/engine.js");
          const updated = await appendRequirementModel(this.rootDir, model);
          const exists = updated.models.some((m) => m.requirementId === command.requirementId);
          return { ok: true, result: { requirementId: command.requirementId, version: model.version, rules: model.businessRules.length, acs: model.acceptanceCriteria.length, existed: true } };
        }
        case "GENERATE_IMPACT": {
          // P15.5 STEP 2：UI 触发 impact 分析（P14 analyzeChangeImpact）
          if (!command.requirementId) return { ok: false, error: "requirementId required" };
          const reqStore = await loadRequirementStore(this.rootDir);
          const model = reqStore.models.find((m) => m.requirementId === command.requirementId);
          if (!model) return { ok: false, error: `requirement not found: ${command.requirementId}` };
          const { buildRelationshipGraph, analyzeChangeImpact } = await import("../test-assets/impact/graph.js");
          const assetStore = new TestAssetStore(this.rootDir);
          const sfile = await assetStore.load();
          const graph = buildRelationshipGraph({
            requirements: [{ requirementId: model.requirementId, factIds: [...model.businessRules.map((r) => r.ruleId), ...model.acceptanceCriteria.map((a) => a.acId)], capabilityIds: model.affectedCapabilities.map((c) => c.capabilityId) }],
            knowledge: [], capabilities: [],
            assets: sfile.assets.map((a) => ({ testAssetId: a.testAssetId, requirementRefs: a.requirementRefs, businessRuleRefs: a.businessRuleRefs, capabilityRefs: a.capabilityRefs, knowledgeRefs: a.knowledgeRefs, pages: a.executionPath.pages, manualRuleRefs: a.manualRuleRefs })),
            pages: [], manualRules: []
          });
          const allFactIds = [...model.businessRules.map((r) => r.ruleId), ...model.acceptanceCriteria.map((a) => a.acId)];
          const criticalFactIds = allFactIds.filter((f) => {
            const ruleText = model.businessRules.find((r) => r.ruleId === f)?.statement ?? "";
            const acText = model.acceptanceCriteria.find((a) => a.acId === f)?.statement ?? "";
            return /sec|kyc|2fa|withdraw|提现|验证|白名单/i.test(ruleText + acText);
          });
          const changeSet = { requirementId: model.requirementId, fromVersion: "v1", toVersion: model.version, addedRules: [], removedRules: [], changedRules: [], addedAC: [], removedAC: [], changedAC: [], actorChanges: [], stateChanges: [], dependencyChanges: [], securityChanges: [], constraintChanges: [], changedFactIds: allFactIds, removedFactIds: [] };
          const impact = analyzeChangeImpact({ graph, requirementChange: changeSet, assets: sfile.assets.map((a) => ({ testAssetId: a.testAssetId, status: a.status, risk: a.risk, knowledgeRefs: a.knowledgeRefs, businessRuleRefs: a.businessRuleRefs, acceptanceCriterionRefs: a.acceptanceCriterionRefs, capabilityRefs: a.capabilityRefs, pages: a.executionPath.pages, manualRuleRefs: a.manualRuleRefs })), criticalFactIds });
          const impactDir = path.join(this.rootDir, "reports", "test-assets", "impact");
          await fs.ensureDir(impactDir);
          await writeSafeJsonFile(path.join(impactDir, `${command.requirementId}-impact.json`), { changeSet, impact, generatedAt: new Date().toISOString() });
          return { ok: true, result: { impacted: impact.candidates.length, criticalUncovered: impact.criticalUncovered } };
        }
        case "GENERATE_PLAN": {
          // P15.5 STEP 5/7：UI 触发 regression plan 生成（P14 buildRegressionPlan）
          if (!command.requirementId) return { ok: false, error: "requirementId required" };
          const reqStore = await loadRequirementStore(this.rootDir);
          const model = reqStore.models.find((m) => m.requirementId === command.requirementId);
          if (!model) return { ok: false, error: `requirement not found: ${command.requirementId}` };
          const { buildRegressionPlan } = await import("../test-assets/impact/regression-plan.js");
          const impactFile = path.join(this.rootDir, "reports", "test-assets", "impact", `${command.requirementId}-impact.json`);
          const impactData = await fs.pathExists(impactFile) ? await fs.readJson(impactFile) : { impact: { candidates: [], criticalUncovered: [] } };
          const assetStore = new TestAssetStore(this.rootDir);
          const sfile = await assetStore.load();
          const plan = buildRegressionPlan({
            planId: `RP-${command.requirementId}`,
            changeSetRefs: [command.requirementId],
            environment: command.environment ?? "UAT",
            impactCandidates: impactData.impact.candidates ?? [],
            assets: sfile.assets.filter((a) => a.status === "ACTIVE").map((a) => ({ testAssetId: a.testAssetId, version: a.version, status: a.status, risk: a.risk, critical: a.risk.designPriority === "CRITICAL" })),
            criticalChangedFactIds: impactData.changeSet?.changedFactIds ?? [],
            criticalNeighborAssetIds: [], flakyAssetIds: [], previouslyFailedAssetIds: [],
            newTestRequests: (impactData.impact.criticalUncovered ?? []).map((f: string) => ({ requestId: `NTR-${f}`, reason: `critical fact ${f} 无覆盖`, changedFactId: f }))
          });
          const planDir = path.join(this.rootDir, "storage", "test-assets", "regression-plans");
          await fs.ensureDir(planDir);
          await writeSafeJsonFile(path.join(planDir, `${plan.planId}.json`), plan);
          return { ok: true, result: { planId: plan.planId, status: plan.status, selected: plan.selectedAssets.filter((s) => s.selectionLevel !== "EXCLUDED").length, newTests: plan.newTestRequests.length } };
        }
        case "GENERATE_TEST_DESIGN": {
          // P15.6-1：UI 点击 Generate Test Design → P11 pipeline → 候选暂存（不直接 ACTIVE）
          if (!command.requirementId) return { ok: false, error: "requirementId required" };
          const reqStore = await loadRequirementStore(this.rootDir);
          const model = reqStore.models.find((m) => m.requirementId === command.requirementId);
          if (!model) return { ok: false, error: `requirement not found: ${command.requirementId}` };
          const input = buildDesignInput(model);
          const obligations = buildCoverageObligations(input);
          const designed = systematicDesigner(input, obligations, [], { maxCandidates: 12 });
          const candidates = designed.candidates.filter((c) => c.reviewStatus !== "NEEDS_SECURITY_REVIEW").slice(0, 4);
          // 幂等：候选存 pending-candidates/<req>.json（P15.6-4）
          const pendingDir = path.join(this.rootDir, "storage", "test-assets", "pending-candidates");
          await fs.ensureDir(pendingDir);
          const pendingPath = path.join(pendingDir, `${command.requirementId}.json`);
          const existing = await fs.pathExists(pendingPath) ? (await fs.readJson(pendingPath)) as unknown[] : [];
          const newOnes = candidates.filter((c) => !existing.some((e) => (e as { candidateId: string }).candidateId === c.candidateId));
          if (newOnes.length) await writeSafeJsonFile(pendingPath, [...existing, ...newOnes]);
          const all = await fs.pathExists(pendingPath) ? (await fs.readJson(pendingPath)) as unknown[] : [];
          return { ok: true, result: { candidates: all.slice(0, 6).map((c) => ({ candidateId: (c as { candidateId: string }).candidateId, title: (c as { title: string }).title, objective: (c as { objective: string }).objective, risk: (c as { risk: { designPriority: string } }).risk?.designPriority })), generated: newOnes.length, total: all.length } };
        }
        case "CANDIDATE_APPROVE": {
          // P15.6-2：从 pending 候选 EDIT_AND_APPROVE → P12 convert → ACTIVE TestAsset（humanAuthoredFields 保留）
          if (!command.requirementId || command.candidateIndex === undefined) return { ok: false, error: "requirementId + candidateIndex required" };
          const pendingPath = path.join(this.rootDir, "storage", "test-assets", "pending-candidates", `${command.requirementId}.json`);
          if (!(await fs.pathExists(pendingPath))) return { ok: false, error: "no pending candidates" };
          const pending = (await fs.readJson(pendingPath)) as Array<Record<string, unknown>>;
          const candidate = pending[command.candidateIndex];
          if (!candidate) return { ok: false, error: `candidate index out of range: ${command.candidateIndex}` };
          const reqStore = await loadRequirementStore(this.rootDir);
          const model = reqStore.models.find((m) => m.requirementId === command.requirementId);
          const asset = convertCandidateToTestAsset({ candidate: candidate as never, requirementId: command.requirementId, requirementVersion: model?.version ?? "v1", creationMode: "SYSTEMATIC_BASELINE" });
          if (command.edits?.field === "title" && typeof command.edits.value === "string") { asset.title = command.edits.value; asset.humanAuthoredFields = [...asset.humanAuthoredFields, "title"]; }
          if (command.edits?.field === "objective" && typeof command.edits.value === "string") { asset.objective = command.edits.value; asset.humanAuthoredFields = [...asset.humanAuthoredFields, "objective"]; }
          asset.testAssetId = `TA-${command.requirementId}-${Date.now() % 100000}`;
          asset.status = "ACTIVE";
          asset.reviewHistory = [{ reviewId: `rev-${Date.now()}`, assetId: asset.testAssetId, assetVersion: "v1", decision: "EDIT_AND_APPROVE", reviewer, timestamp: new Date().toISOString(), reason: command.reason ?? "workspace candidate approve" }];
          const store = new TestAssetStore(this.rootDir);
          const sfile = await store.load();
          sfile.assets.push(asset);
          await store.save(sfile, `workspace candidate approve ${asset.testAssetId}`);
          // 从 pending 移除（幂等：批准后不再重复生成）
          const remaining = pending.filter((_, i) => i !== command.candidateIndex);
          await writeSafeJsonFile(pendingPath, remaining);
          return { ok: true, result: { testAssetId: asset.testAssetId, humanAuthoredFields: asset.humanAuthoredFields, status: asset.status } };
        }
        case "ASSET_UPDATE_PREVIEW": {
          // P15.6-5：OLD vs PROPOSED 对比（高亮 preconditions/actions/expected/risk/data）
          if (!command.assetId) return { ok: false, error: "assetId required" };
          const store = new TestAssetStore(this.rootDir);
          const sfile = await store.load();
          const old = sfile.assets.find((a) => a.testAssetId === command.assetId && a.status === "ACTIVE");
          if (!old) return { ok: false, error: `active asset not found: ${command.assetId}` };
          const versionNum = store.nextVersionNumber(sfile, command.assetId);
          const proposed = { ...old, version: `v${versionNum}`, updatedAt: new Date().toISOString() };
          return { ok: true, result: { old: { version: old.version, preconditions: old.preconditions, actions: old.semanticActions, expected: old.expectedOutcomes, risk: old.risk, data: old.testDataRequirements }, proposed: { version: proposed.version, preconditions: proposed.preconditions, actions: proposed.semanticActions, expected: proposed.expectedOutcomes, risk: proposed.risk, data: proposed.testDataRequirements } } };
        }
        case "APPROVE_ASSET_UPDATE": {
          // P15.6-6/8：old SUPERSEDED + new ACTIVE；stale 版本校验（P15.6-8）
          if (!command.assetId) return { ok: false, error: "assetId required" };
          const store = new TestAssetStore(this.rootDir);
          const sfile = await store.load();
          const idx = sfile.assets.findIndex((a) => a.testAssetId === command.assetId && a.status === "ACTIVE");
          if (idx < 0) return { ok: false, error: `active asset not found: ${command.assetId}` };
          const old = sfile.assets[idx];
          // P15.6-8：浏览器 A 持有旧版本视图，浏览器 B 已批准新版本 → A 的批准必须 STALE_VERSION/CONFLICT
          const expectedVersion = (command as { expectedVersion?: string }).expectedVersion;
          if (expectedVersion && expectedVersion !== old.version) {
            return { ok: false, error: `STALE_VERSION / CONFLICT: expected ${expectedVersion} but current is ${old.version}` };
          }
          const versionNum = store.nextVersionNumber(sfile, command.assetId);
          const newAsset = { ...old, version: `v${versionNum}`, status: "ACTIVE" as const, updatedAt: new Date().toISOString(), reviewHistory: [], contentFingerprint: "" };
          newAsset.contentFingerprint = assetContentFingerprint(newAsset);
          sfile.assets[idx] = { ...old, status: "SUPERSEDED" as const, updatedAt: new Date().toISOString() };
          sfile.versionSequence[command.assetId] = versionNum;
          sfile.assets.push(newAsset);
          await store.save(sfile, `workspace approve asset update ${command.assetId}`);
          return { ok: true, result: { oldVersion: old.version, newVersion: newAsset.version, newAssetId: command.assetId } };
        }
        case "CREATE_ISSUE_DRAFT": {
          // P15.6-10：Product Failure → Issue Draft（不提交外部系统）
          if (!command.assetId) return { ok: false, error: "assetId required" };
          const draftDir = path.join(this.rootDir, "reports", "test-assets", "issue-drafts");
          await fs.ensureDir(draftDir);
          const draftId = `ISSUE-${command.assetId}-${Date.now()}`;
          const draft = {
            draftId, title: `Product failure: ${command.assetId}`, steps: ["Run TestAsset from Regression Plan"],
            expected: "expected outcome per Business Rule", actual: "observed mismatch", evidenceRefs: [],
            requirement: command.requirementId ?? "", testAsset: command.assetId, run: command.planId ?? "", createdAt: new Date().toISOString()
          };
          await writeSafeJsonFile(path.join(draftDir, `${draftId}.json`), draft);
          return { ok: true, result: { draftId } };
        }
        case "CREATE_MODELING_REQUEST": {
          // P15.6-12：Model Failure → ModelingRequest（不直接编辑 locator）
          if (!command.assetId) return { ok: false, error: "assetId required" };
          const reqDir = path.join(this.rootDir, "reports", "test-assets", "modeling-requests");
          await fs.ensureDir(reqDir);
          const requestId = `MR-${command.assetId}-${Date.now()}`;
          const request = {
            requestId, sourceTestAsset: command.assetId, requiredCapability: "unknown", page: undefined,
            missingKnowledge: ["CONTROL/INTERACTION/ASSERTION"], risk: "LOW", createdAt: new Date().toISOString(), status: "OPEN"
          };
          await writeSafeJsonFile(path.join(reqDir, `${requestId}.json`), request);
          return { ok: true, result: { requestId, status: "OPEN" } };
        }
        case "RUN_REGRESSION": {
          if (!command.planId) return { ok: false, error: "planId required" };
          const p = await this.loadPlan(command.planId);
          if (!p) return { ok: false, error: `plan not found: ${command.planId}` };
          const environment = command.environment ?? "UAT";
          const service = new TestAssetExecutionServiceProxy(this.rootDir, environment);
          const run = await service.executePlan(p);
          return { ok: true, result: run };
        }
        default:
          return { ok: false, error: `unknown command: ${(command as { type: string }).type}` };
      }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async loadPlan(planId: string): Promise<RegressionPlan | undefined> {
    const p = path.join(this.rootDir, "storage", "test-assets", "regression-plans", `${planId}.json`);
    if (!(await fs.pathExists(p))) return undefined;
    return (await fs.readJson(p)) as RegressionPlan;
  }

  private async savePlan(plan: RegressionPlan): Promise<void> {
    await writeSafeJsonFile(path.join(this.rootDir, "storage", "test-assets", "regression-plans", `${plan.planId}.json`), plan);
  }
}

/** P15.36：Run Regression 委托（复用 TestAssetExecutionService + runRegressionPlan）。 */
class TestAssetExecutionServiceProxy {
  constructor(private readonly rootDir: string, private readonly environment: string) {}

  private async fixtureBaseUrl(): Promise<string | undefined> {
    const overridePath = path.join(this.rootDir, "storage", "test-assets", "execution-override.json");
    if (!(await fs.pathExists(overridePath))) return undefined;
    try {
      const data = (await fs.readJson(overridePath)) as { baseUrl?: string };
      return data.baseUrl;
    } catch {
      return undefined;
    }
  }

  async executePlan(plan: RegressionPlan): Promise<unknown> {
    const store = new TestAssetStore(this.rootDir);
    const file = await store.load();
    const service = new TestAssetExecutionService({ rootDir: this.rootDir, project: "demo", env: "test", environment: this.environment as never });
    const run = await runRegressionPlan({
      regressionRunId: `RR-${plan.planId}-${Date.now()}`,
      plan,
      environment: this.environment,
      resolveAsset: (assetId) => {
        // 优先当前 ACTIVE 版本（SUPERSEDED 旧版不可执行）
        const asset = file.assets.find((a) => a.testAssetId === assetId && a.status === "ACTIVE") ?? file.assets.find((a) => a.testAssetId === assetId);
        if (!asset) return undefined;
        const entry = plan.selectedAssets.find((s) => s.assetId === assetId);
        return {
          assetId,
          version: asset.version,
          selectionLevel: entry?.selectionLevel ?? "EXCLUDED",
          executionRisk: asset.risk.executionRisk,
          readiness: "READY",
          disposition: entry?.disposition ?? "UNCHANGED",
          execute: async () => {
            const baseContext = await import("../core/config-loader.js").then((m) => m.loadContext({ rootDir: this.rootDir, project: "demo", env: "test" }));
            const fixtureUrl = await this.fixtureBaseUrl();
            const context = fixtureUrl ? { ...baseContext, env: { ...baseContext.env, web: { ...(baseContext.env.web ?? {}), baseUrl: fixtureUrl } } as typeof baseContext.env } : baseContext;
            const outcome = await service.execute(asset, {
              context,
              options: { project: "demo", env: "test", tags: [], locales: [], dryRun: false, mode: "heal", maxAiCalls: 0, maxDurationMs: 60_000 },
              maxAttempts: 1
            });
            return { result: outcome.result, runId: outcome.runId, error: outcome.detail };
          }
        };
      }
    });
    return run;
  }
}
