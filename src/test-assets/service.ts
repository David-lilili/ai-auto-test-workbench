/**
 * P12 服务层：candidate→asset 全流程、review 应用、版本化、查询、trace。
 */

import type { TestDesignCandidate } from "../test-design/types.js";
import { TestAssetStore, assetContentFingerprint } from "./store.js";
import { convertCandidateToTestAsset, nextAssetId } from "./convert.js";
import { applyReview, mergeAssets, isBatchReviewEligible, buildUpdateProposal, type ReviewSnapshot } from "./review.js";
import { matchCandidateToAssets } from "./semantic-key.js";
import { evaluateCandidateForAsset } from "./eligibility.js";
import type { TestAsset, TestAssetStoreFile, ReviewDecision, ReviewableField } from "./types.js";

export interface ReviewContext {
  reviewer: string;
  reason: string;
  requirementVersion?: string;
  knowledgeFingerprint?: string;
  manualVersions?: Record<string, string>;
  contextFingerprint?: string;
  candidateHash?: string;
}

export interface AssetServiceDeps {
  knownRequirements: string[];
  knownBusinessRules: string[];
  knownCapabilities: string[];
  pageRefsByAsset?: Map<string, string[]>;
}

export class TestAssetService {
  private readonly store: TestAssetStore;

  constructor(
    private readonly rootDir: string,
    private readonly deps: AssetServiceDeps
  ) {
    this.store = new TestAssetStore(rootDir);
  }

  async load(): Promise<TestAssetStoreFile> { return this.store.load(); }

  async persist(store: TestAssetStoreFile, reason: string): Promise<void> { await this.store.save(store, reason); }

  /** P12.12/61：candidate → asset（先匹配已有 asset，避免重复生成）。 */
  async ingestCandidate(input: {
    candidate: TestDesignCandidate;
    requirementId: string;
    requirementVersion: string;
    contextFingerprint?: string;
    creationMode?: TestAsset["creationMode"];
    reviewer?: string;
    autoApprove?: boolean;
  }): Promise<{ asset?: TestAsset; eligibility: ReturnType<typeof evaluateCandidateForAsset>; match?: ReturnType<typeof matchCandidateToAssets>; store: TestAssetStoreFile }> {
    const store = await this.load();
    const eligibility = evaluateCandidateForAsset(input.candidate, { requirementActive: this.deps.knownRequirements.includes(input.requirementId) });
    if (eligibility.status === "REJECT" || eligibility.status === "BLOCKED") {
      return { eligibility, store };
    }
    const match = matchCandidateToAssets({
      businessRuleRefs: input.candidate.coveredBusinessRuleIds ?? [],
      acceptanceCriterionRefs: input.candidate.coveredACIds ?? [],
      scenarioType: input.candidate.scenarioType,
      preconditions: input.candidate.preconditions,
      semanticActions: input.candidate.semanticActions,
      expectedOutcomes: input.candidate.expectedOutcomes
    }, store.assets.filter((a) => a.status !== "REJECTED" && a.status !== "SUPERSEDED" && a.status !== "DEPRECATED"));
    if (match.kind === "SAME" || match.kind === "DUPLICATE") {
      return { eligibility, match, store };
    }
    const asset = convertCandidateToTestAsset({
      candidate: input.candidate,
      requirementId: input.requirementId,
      requirementVersion: input.requirementVersion,
      contextFingerprint: input.contextFingerprint,
      creationMode: input.creationMode,
      pageRefs: this.deps.pageRefsByAsset?.get(input.candidate.candidateId)
    });
    asset.testAssetId = nextAssetId(store.assets.map((a) => a.testAssetId));
    // P12.26：即使 batch-eligible 也需要 human confirm，不自动 ACTIVE
    if (input.autoApprove && isBatchReviewEligible(asset)) {
      const approved = applyReview({ asset, decision: "APPROVE", reviewer: input.reviewer ?? "system", reason: "batch review (auto-eligible)" });
      store.assets.push(approved);
    } else {
      store.assets.push(asset);
    }
    await this.persist(store, `ingest candidate ${input.candidate.candidateId} -> ${asset.testAssetId}`);
    return { asset, eligibility, match, store };
  }

  /** P12.7：approve / reject / block / request-clarification。 */
  async review(assetId: string, decision: ReviewDecision, ctx: ReviewContext, edits?: { field: ReviewableField; value: unknown }): Promise<{ asset?: TestAsset; store: TestAssetStoreFile; error?: string }> {
    const store = await this.load();
    const asset = this.store.currentVersion(store, assetId);
    if (!asset) return { store, error: `asset not found: ${assetId}` };
    const snapshot: ReviewSnapshot = {
      requirementVersion: ctx.requirementVersion,
      knowledgeFingerprint: ctx.knowledgeFingerprint,
      manualVersions: ctx.manualVersions,
      candidateHash: ctx.candidateHash,
      contextFingerprint: ctx.contextFingerprint
    };
    const updated = applyReview({ asset, decision, reviewer: ctx.reviewer, reason: ctx.reason, snapshot, edits });
    const idx = store.assets.findIndex((a) => a.testAssetId === assetId && a.version === asset.version);
    store.assets[idx] = updated;
    await this.persist(store, `review ${decision} on ${assetId}@${asset.version} by ${ctx.reviewer}`);
    return { asset: updated, store };
  }

  /** P12.7 merge：target + source → 1 个 asset，多 requirement refs。 */
  async merge(targetId: string, sourceId: string, ctx: ReviewContext): Promise<{ target?: TestAsset; store: TestAssetStoreFile; error?: string }> {
    const store = await this.load();
    const target = this.store.currentVersion(store, targetId);
    const source = this.store.currentVersion(store, sourceId);
    if (!target || !source) return { store, error: "asset not found" };
    const snapshot: ReviewSnapshot = { requirementVersion: ctx.requirementVersion, knowledgeFingerprint: ctx.knowledgeFingerprint, manualVersions: ctx.manualVersions, contextFingerprint: ctx.contextFingerprint };
    const { target: merged, source: updatedSource } = mergeAssets(target, source, ctx.reviewer, ctx.reason, snapshot);
    const idx = store.assets.findIndex((a) => a.testAssetId === targetId && a.version === target.version);
    const sidx = store.assets.findIndex((a) => a.testAssetId === sourceId && a.version === source.version);
    store.assets[idx] = merged;
    store.assets[sidx] = updatedSource;
    await this.persist(store, `merge ${sourceId} into ${targetId} by ${ctx.reviewer}`);
    return { target: merged, store };
  }

  /** P12.8/9：AI 更新 → UPDATE_PROPOSAL，human 字段优先。 */
  async proposeUpdate(assetId: string, proposed: Partial<TestAsset>): Promise<{ proposal: Partial<TestAsset>; conflictingHumanFields: string[]; allowed: boolean; error?: string }> {
    const store = await this.load();
    const asset = this.store.currentVersion(store, assetId);
    if (!asset) return { proposal: {}, conflictingHumanFields: [], allowed: false, error: `asset not found: ${assetId}` };
    const result = buildUpdateProposal(asset, proposed);
    return result;
  }

  /** P12.31：Requirement V2 导致修改 → 新版本 vN+1，旧版本 SUPERSEDED。 */
  async newVersion(assetId: string, changes: Partial<TestAsset>, ctx: ReviewContext, changeReason: string): Promise<{ asset?: TestAsset; store: TestAssetStoreFile; error?: string }> {
    const store = await this.load();
    const current = this.store.currentVersion(store, assetId);
    if (!current) return { store, error: `asset not found: ${assetId}` };
    // 版本号基于当前版本递增（v1 → v2），并更新 sequence
    const currentNum = Number(current.version.replace(/^v/, "")) || 1;
    const versionNum = currentNum + 1;
    const oldVersion = { ...current, status: "SUPERSEDED" as const, updatedAt: new Date().toISOString() };
    const newAsset: TestAsset = {
      ...current, ...changes,
      version: `v${versionNum}`,
      status: "IN_REVIEW",
      createdAt: current.createdAt,
      updatedAt: new Date().toISOString(),
      reviewHistory: [],
      humanAuthoredFields: [...current.humanAuthoredFields],
      contentFingerprint: ""
    };
    newAsset.contentFingerprint = assetContentFingerprint(newAsset);
    store.versionSequence[assetId] = versionNum;
    const idx = store.assets.findIndex((a) => a.testAssetId === assetId && a.version === current.version);
    store.assets[idx] = oldVersion;
    store.assets.push(newAsset);
    await this.persist(store, `new version ${assetId} v${versionNum}: ${changeReason}`);
    return { asset: newAsset, store };
  }

  /** P12.44/80：按 requirement/capability 查询 ACTIVE assets。 */
  async query(requirementId?: string, capability?: string, status?: string): Promise<TestAsset[]> {
    const store = await this.load();
    let assets = store.assets;
    if (status) assets = assets.filter((a) => a.status === status);
    else assets = assets.filter((a) => ["ACTIVE", "APPROVED"].includes(a.status));
    if (requirementId) assets = assets.filter((a) => a.requirementRefs.includes(requirementId));
    if (capability) assets = assets.filter((a) => a.capabilityRefs.includes(capability));
    return assets;
  }
}
