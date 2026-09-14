/**
 * P15.61-64：Workspace Projection Layer + Command Adapter。
 *
 * 只读 read-model：聚合现有 store（Requirement / KB / Capability / Page Model /
 * TestAsset / Impact / RegressionPlan / Execution），不建立第二套 source of truth。
 * 写操作（command）全部委托现有 service。
 */

import path from "node:path";
import fs from "fs-extra";
import { TestAssetStore } from "../test-assets/store.js";
import { loadRequirementStore } from "../requirements/engine.js";
import { loadKnowledgeStore } from "../requirements/knowledge-store.js";
import { buildRelationshipGraph, type ImpactGraph } from "../test-assets/impact/graph.js";
import { loadRunHistory } from "../test-assets/execution-runner.js";
import { loadCandidateStore } from "../test-design/engine.js";
import { TestAssetService } from "../test-assets/service.js";
import { buildRegressionPlan, reviewRegressionPlan, type RegressionPlan } from "../test-assets/impact/regression-plan.js";
import { TestAssetExecutionService } from "../test-assets/execution-service.js";
import { runRegressionPlan } from "../test-assets/impact/regression-runner.js";

export interface CapabilityProjection {
  capabilityId: string;
  name: string;
  requirements: string[];
  businessRules: string[];
  pages: string[];
  states: string[];
  testAssets: string[];
  coverage: { activeAssets: number; executionReady: number; executed: number; passed: number };
  lastRun?: string;
  health: "HEALTHY" | "NEEDS_ATTENTION" | "UNKNOWN";
}

export interface ProductStructureProjection {
  product: string;
  domains: string[];
  modules: string[];
  capabilities: CapabilityProjection[];
  unclassifiedCapabilities: string[];
  generatedAt: string;
  fingerprint: string;
}

export interface ReleaseWorkspaceView {
  releaseId: string;
  requirements: string[];
  requirementStatus: string;
  knowledgeStatus: string;
  changeSummary: { added: string[]; changed: string[]; removed: string[] };
  impactSummary: { impactedAssets: number; newTests: number; updates: number; excluded: number };
  testDesignStatus: string;
  assetReviewStatus: string;
  regressionPlan?: RegressionPlan;
  executionSummary: { selected: number; executed: number; passed: number; waitingAuth: number };
  blockingItems: string[];
  warnings: string[];
  recommendedNextAction: string;
  timeline: Array<{ at: string; what: string; why: string; source: string }>;
  generatedAt: string;
}

export class WorkspaceProjectionService {
  private readonly assetStore: TestAssetStore;

  constructor(private readonly rootDir: string) {
    this.assetStore = new TestAssetStore(rootDir);
  }

  async getRelationshipGraph(): Promise<ImpactGraph> {
    const base = await this.loadBase();
    return buildRelationshipGraph({
      requirements: base.reqStore.models.map((m) => ({ requirementId: m.requirementId, factIds: [...m.businessRules.map((r) => r.ruleId), ...m.acceptanceCriteria.map((a) => a.acId)], capabilityIds: m.affectedCapabilities.map((c) => c.capabilityId) })),
      knowledge: base.kb.knowledge.map((k) => ({ knowledgeId: k.knowledgeId, requirementRefs: k.requirementRefs, capability: k.scope?.capability })),
      capabilities: [],
      assets: base.assets.map((a) => ({ testAssetId: a.testAssetId, requirementRefs: a.requirementRefs, businessRuleRefs: a.businessRuleRefs, capabilityRefs: a.capabilityRefs, knowledgeRefs: a.knowledgeRefs, pages: a.executionPath.pages, manualRuleRefs: a.manualRuleRefs })),
      pages: [],
      manualRules: []
    });
  }

  private async loadBase() {
    const assetsFile = await this.assetStore.load();
    const reqStore = await loadRequirementStore(this.rootDir);
    const kb = await loadKnowledgeStore(this.rootDir);
    const candidateStore = await loadCandidateStore(this.rootDir);
    return { assets: assetsFile.assets, reqStore, kb, candidateStore };
  }

  async getProductOverview(): Promise<ProductStructureProjection> {
    const base = await this.loadBase();
    const capabilities = new Map<string, CapabilityProjection>();
    const unclassified: string[] = [];
    for (const a of base.assets) {
      for (const cap of a.capabilityRefs) {
        let entry = capabilities.get(cap);
        if (!entry) {
          entry = { capabilityId: cap, name: cap, requirements: [], businessRules: [], pages: [], states: [], testAssets: [], coverage: { activeAssets: 0, executionReady: 0, executed: 0, passed: 0 }, health: "UNKNOWN" };
          capabilities.set(cap, entry);
        }
        entry.requirements.push(...a.requirementRefs);
        entry.businessRules.push(...a.businessRuleRefs);
        entry.pages.push(...a.executionPath.pages);
        entry.testAssets.push(a.testAssetId);
        if (a.status === "ACTIVE") entry.coverage.activeAssets += 1;
        if (a.executionPath.status === "KNOWN") entry.coverage.executionReady += 1;
      }
    }
    // 需求中的 capabilities 也纳入（即使无资产）
    for (const m of base.reqStore.models) {
      for (const cap of m.affectedCapabilities.map((c) => c.capabilityId)) {
        if (!capabilities.has(cap)) {
          capabilities.set(cap, { capabilityId: cap, name: cap, requirements: [m.requirementId], businessRules: [], pages: [], states: [], testAssets: [], coverage: { activeAssets: 0, executionReady: 0, executed: 0, passed: 0 }, health: "NEEDS_ATTENTION" });
        } else {
          capabilities.get(cap)!.requirements.push(m.requirementId);
        }
      }
    }
    const modules = new Set<string>();
    const domains = new Set<string>();
    for (const cap of capabilities.keys()) {
      const parts = cap.split(".");
      if (parts.length >= 2) { modules.add(parts[0]); domains.add(parts[0]); }
      else unclassified.push(cap);
    }
    // run history 聚合 lastRun/passed
    for (const cap of capabilities.values()) {
      let executed = 0;
      let passed = 0;
      let lastRun: string | undefined;
      for (const assetId of cap.testAssets) {
        const runs = await loadRunHistory(this.rootDir, assetId);
        if (runs.length) {
          executed += runs.filter((r) => r.result === "PASS" || r.result.includes("FAILURE")).length;
          passed += runs.filter((r) => r.result === "PASS").length;
          const latest = runs[runs.length - 1];
          if (latest && (!lastRun || latest.createdAt > lastRun)) lastRun = latest.createdAt;
        }
      }
      cap.coverage.executed = executed;
      cap.coverage.passed = passed;
      cap.lastRun = lastRun;
      cap.health = cap.testAssets.length === 0 ? "NEEDS_ATTENTION" : executed > 0 && passed / Math.max(1, executed) >= 0.8 ? "HEALTHY" : "NEEDS_ATTENTION";
    }
    const fingerprint = JSON.stringify([...capabilities.keys()].sort());
    return {
      product: "demo",
      domains: [...domains].sort(),
      modules: [...modules].sort(),
      capabilities: [...capabilities.values()].sort((a, b) => a.capabilityId.localeCompare(b.capabilityId)),
      unclassifiedCapabilities: unclassified,
      generatedAt: new Date().toISOString(),
      fingerprint
    };
  }

  /** P15.12/13：Release Workspace View（聚合 + timeline + next action）。 */
  async getReleaseWorkspace(input: { releaseId: string; requirementId: string }): Promise<ReleaseWorkspaceView> {
    const base = await this.loadBase();
    const model = base.reqStore.models.find((m) => m.requirementId === input.requirementId);
    const planPath = path.join(this.rootDir, "storage", "test-assets", "regression-plans", `RP-${input.requirementId}.json`);
    const plan: RegressionPlan | undefined = await fs.pathExists(planPath) ? await fs.readJson(planPath) : undefined;
    const blockingItems: string[] = [];
    const warnings: string[] = [];
    if (!model) blockingItems.push("Requirement 未分析");
    if (plan) {
      if (plan.newTestRequests.length) blockingItems.push(`${plan.newTestRequests.length} New Test 未 review`);
      if (plan.updateRequiredAssets.length) blockingItems.push(`${plan.updateRequiredAssets.length} Asset 需更新`);
      if (plan.riskSummary.needsAuthorization) blockingItems.push(`${plan.riskSummary.needsAuthorization} Runs 等待授权`);
    }
    const assets = base.assets.filter((a) => a.requirementRefs.includes(input.requirementId));
    const runs = [];
    for (const a of assets) {
      const r = await loadRunHistory(this.rootDir, a.testAssetId);
      for (const run of r) runs.push(run);
    }
    const executionSummary = {
      selected: plan?.selectedAssets.filter((s) => s.selectionLevel !== "EXCLUDED").length ?? 0,
      executed: runs.length,
      passed: runs.filter((r) => r.result === "PASS").length,
      waitingAuth: plan?.riskSummary.needsAuthorization ?? 0
    };
    const recommendedNextAction = plan ? (plan.newTestRequests.length ? "Review Generated Tests" : plan.updateRequiredAssets.length ? "Approve Test Asset Updates" : plan.status === "READY_FOR_REVIEW" || plan.status === "APPROVED" ? "Run Ready Tests" : "Review Regression Plan") : "Analyze Requirement";
    const timeline = [
      ...(model ? [{ at: model.updatedAt, what: "Requirement analyzed", why: `V${model.version}`, source: `requirements/${model.requirementId}` }] : []),
      ...(plan ? [{ at: plan.updatedAt, what: "Regression plan", why: plan.version, source: `regression-plans/RP-${input.requirementId}.json` }] : []),
      ...runs.map((r) => ({ at: r.createdAt, what: `Run ${r.result}`, why: r.testAssetId, source: `test-assets/runs/${r.testAssetId}.json` }))
    ].sort((a, b) => a.at.localeCompare(b.at));
    return {
      releaseId: input.releaseId,
      requirements: [input.requirementId],
      requirementStatus: model ? "ANALYZED" : "NOT_ANALYZED",
      knowledgeStatus: "CURRENT",
      changeSummary: { added: [], changed: [], removed: [] },
      impactSummary: { impactedAssets: plan?.selectedAssets.filter((s) => s.selectionLevel !== "EXCLUDED").length ?? 0, newTests: plan?.newTestRequests.length ?? 0, updates: plan?.updateRequiredAssets.length ?? 0, excluded: plan?.excludedAssets.length ?? 0 },
      testDesignStatus: plan ? plan.status : "NOT_STARTED",
      assetReviewStatus: plan && plan.reviewRequiredAssets.length ? "NEEDS_REVIEW" : "OK",
      regressionPlan: plan,
      executionSummary,
      blockingItems,
      warnings,
      recommendedNextAction,
      timeline,
      generatedAt: new Date().toISOString()
    };
  }

  /** P15.32/33：统一 Review Queue（只引用 sourceRef，不复制数据）。 */
  async getReviewQueue(): Promise<Array<{ type: string; priority: string; release: string; reason: string; createdAt: string; sourceRef: string }>> {
    const base = await this.loadBase();
    const items: Array<{ type: string; priority: string; release: string; reason: string; createdAt: string; sourceRef: string }> = [];
    for (const a of base.assets) {
      if (a.status === "IN_REVIEW" || a.status === "DRAFT") {
        items.push({ type: "TEST_ASSET_REVIEW", priority: a.risk.designPriority, release: a.requirementRefs[0] ?? "", reason: `${a.testAssetId}@${a.version} 待审查`, createdAt: a.createdAt, sourceRef: `test-assets/${a.testAssetId}` });
      }
    }
    for (const entry of base.kb.reviewQueue.filter((q) => q.status === "PENDING")) {
      items.push({ type: "KNOWLEDGE_REVIEW", priority: "MEDIUM", release: entry.requirementId, reason: entry.reason, createdAt: entry.createdAt, sourceRef: `knowledge-review/${entry.queueId}` });
    }
    const planDir = path.join(this.rootDir, "storage", "test-assets", "regression-plans");
    if (await fs.pathExists(planDir)) {
      for (const f of await fs.readdir(planDir)) {
        if (!f.endsWith(".json")) continue;
        const plan = (await fs.readJson(path.join(planDir, f))) as RegressionPlan;
        if (plan.status === "READY_FOR_REVIEW" || plan.status === "DRAFT") {
          items.push({ type: "REGRESSION_PLAN", priority: "HIGH", release: plan.changeSetRefs.join(","), reason: `${plan.planId} 待审批`, createdAt: plan.createdAt, sourceRef: `regression-plans/${plan.planId}` });
        }
      }
    }
    return items.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** P15.44-46：Coverage（Test Design 与 Execution 分离）。 */
  async getCoverage(): Promise<{ testDesign: Record<string, number>; execution: Record<string, number> }> {
    const base = await this.loadBase();
    const testDesign: Record<string, number> = { acceptanceCriteria: 0, businessRules: 0, security: 0, state: 0, dependency: 0, capability: 0 };
    const execution: Record<string, number> = { activeAssets: 0, executionReady: 0, executed: 0, passed: 0, needsModeling: 0, riskBlocked: 0 };
    for (const a of base.assets) {
      if (a.status !== "ACTIVE") continue;
      execution.activeAssets += 1;
      if (a.executionPath.status === "KNOWN") execution.executionReady += 1;
      if (a.executionPath.status === "UNKNOWN") execution.needsModeling += 1;
      if (a.risk.executionRisk === "HIGH" || a.risk.executionRisk === "FORBIDDEN") execution.riskBlocked += 1;
      testDesign.acceptanceCriteria += a.acceptanceCriterionRefs.length;
      testDesign.businessRules += a.businessRuleRefs.length;
      testDesign.capability += a.capabilityRefs.length;
      if (/sec|2fa|kyc/i.test(a.businessRuleRefs.join(" ")) || a.risk.designPriority === "CRITICAL") testDesign.security += 1;
      if (a.scenarioType === "STATE_TRANSITION") testDesign.state += 1;
      if (a.scenarioType === "DEPENDENCY") testDesign.dependency += 1;
      const runs = await loadRunHistory(this.rootDir, a.testAssetId);
      execution.executed += runs.length;
      execution.passed += runs.filter((r) => r.result === "PASS").length;
    }
    return { testDesign, execution };
  }

  /** P15.53/54：deterministic search（关键词 → 分组结果）。 */
  async search(query: string): Promise<Record<string, string[]>> {
    const q = query.toLowerCase();
    const base = await this.loadBase();
    const result: Record<string, string[]> = { requirements: [], businessRules: [], capabilities: [], pages: [], testAssets: [], runs: [] };
    for (const m of base.reqStore.models) {
      if (m.requirementId.toLowerCase().includes(q) || m.summary.toLowerCase().includes(q)) result.requirements.push(m.requirementId);
      for (const r of m.businessRules) if (r.statement.toLowerCase().includes(q)) result.businessRules.push(r.ruleId);
    }
    for (const a of base.assets) {
      if (a.testAssetId.toLowerCase().includes(q) || a.title.toLowerCase().includes(q)) result.testAssets.push(a.testAssetId);
      for (const c of a.capabilityRefs) if (c.toLowerCase().includes(q)) result.capabilities.push(c);
      for (const p of a.executionPath.pages) if (p.toLowerCase().includes(q)) result.pages.push(p);
    }
    for (const c of result.testAssets) {
      const runs = await loadRunHistory(this.rootDir, c);
      runs.forEach((r) => result.runs.push(r.runId));
    }
    return result;
  }

  /** P15.79：System Health 聚合（doctor 们）。 */
  async getSystemHealth(): Promise<Record<string, { pass: boolean; issues: string[] }>> {
    const { runAssetDoctor } = await import("../test-assets/doctor.js");
    const { runImpactDoctor } = await import("../test-assets/impact/regression-runner.js");
    const base = await this.loadBase();
    const graph = await this.getRelationshipGraph();
    const assetDoctor = runAssetDoctor({
      store: { schemaVersion: "test-assets.v1", assets: base.assets, versionSequence: {}, updatedAt: "" },
      knownRequirements: base.reqStore.models.map((m) => m.requirementId),
      knownBusinessRules: base.reqStore.models.flatMap((m) => m.businessRules.map((r) => r.ruleId)),
      knownCapabilities: [],
      knownKnowledgeIds: base.kb.knowledge.map((k) => k.knowledgeId),
      criticalObligationRefs: []
    });
    const impactDoctor = runImpactDoctor({
      graphVersion: graph.version(),
      expectedGraphVersion: graph.version(),
      assets: base.assets,
      knownRequirements: base.reqStore.models.map((m) => m.requirementId),
      knownKnowledgeIds: base.kb.knowledge.map((k) => k.knowledgeId),
      criticalChangedFactIds: [],
      coveredFactIds: base.assets.flatMap((a) => a.businessRuleRefs)
    });
    return {
      testAsset: { pass: assetDoctor.pass, issues: assetDoctor.issues.slice(0, 5) },
      impact: { pass: impactDoctor.pass, issues: impactDoctor.issues.slice(0, 5) }
    };
  }
}
