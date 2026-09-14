/**
 * P12.28/71/72/73：TestAsset Store（controlled writeback）。
 *
 * - 所有写入必须经过 TestAssetStore（禁止直接改 assets.json，P12.72）。
 * - 写入前 backup（P12.73）；支持 rollback。
 * - contentFingerprint 完整性（P12.71），silent mutation 检测。
 * - 版本化：TA-001 v1 → v2，旧版本 SUPERSEDED（P12.31）。
 * - 关系索引 + coverage 持久化（P12.29/30/39）。
 */

import crypto from "node:crypto";
import fs from "fs-extra";
import path from "node:path";
import { writeSafeJsonFile } from "../core/safe-file-writer.js";
import type { TestAsset, TestAssetStatus, TestAssetStoreFile, RelationshipIndex } from "./types.js";

export function assetContentFingerprint(asset: TestAsset): string {
  const payload = JSON.stringify({
    title: asset.title, objective: asset.objective,
    requirementRefs: [...asset.requirementRefs].sort(),
    businessRuleRefs: [...asset.businessRuleRefs].sort(),
    acceptanceCriterionRefs: [...asset.acceptanceCriterionRefs].sort(),
    capabilityRefs: [...asset.capabilityRefs].sort(),
    scenarioType: asset.scenarioType,
    preconditions: asset.preconditions, semanticActions: asset.semanticActions,
    expectedOutcomes: asset.expectedOutcomes, testDataRequirements: asset.testDataRequirements,
    risk: asset.risk, manualRuleRefs: [...asset.manualRuleRefs].sort(), knowledgeRefs: [...asset.knowledgeRefs].sort(),
    executionPath: asset.executionPath
  });
  return crypto.createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

export function assetStorePath(rootDir: string): string {
  return path.join(rootDir, "storage", "test-assets", "assets.json");
}

export function assetHistoryDir(rootDir: string): string {
  return path.join(rootDir, "storage", "test-assets", "history");
}

export class TestAssetStore {
  constructor(private readonly rootDir: string) {}

  async load(): Promise<TestAssetStoreFile> {
    const p = assetStorePath(this.rootDir);
    if (!(await fs.pathExists(p))) {
      return { schemaVersion: "test-assets.v1", assets: [], versionSequence: {}, updatedAt: new Date().toISOString() };
    }
    try {
      return (await fs.readJson(p)) as TestAssetStoreFile;
    } catch {
      return { schemaVersion: "test-assets.v1", assets: [], versionSequence: {}, updatedAt: new Date().toISOString() };
    }
  }

  private async backupBeforeWrite(store: TestAssetStoreFile, reason: string): Promise<string> {
    const dir = assetHistoryDir(this.rootDir);
    await fs.ensureDir(dir);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = path.join(dir, `${stamp}-${crypto.randomUUID().slice(0, 6)}.json`);
    await writeSafeJsonFile(file, { reason, snapshot: store, backedUpAt: new Date().toISOString() });
    return file;
  }

  async save(store: TestAssetStoreFile, reason: string): Promise<string> {
    const backupPath = await this.backupBeforeWrite(store, reason);
    await fs.ensureDir(path.dirname(assetStorePath(this.rootDir)));
    await writeSafeJsonFile(assetStorePath(this.rootDir), store);
    return backupPath;
  }

  /** 只读查询辅助。 */
  byId(store: TestAssetStoreFile, assetId: string): TestAsset | undefined {
    return store.assets.find((a) => a.testAssetId === assetId);
  }

  currentVersion(store: TestAssetStoreFile, assetId: string): TestAsset | undefined {
    const versions = store.assets.filter((a) => a.testAssetId === assetId);
    return versions.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }))[0];
  }

  nextVersionNumber(store: TestAssetStoreFile, assetId: string): number {
    return (store.versionSequence[assetId] ?? 0) + 1;
  }

  /** P12.71：完整性校验——silent mutation 检测。 */
  integrityCheck(store: TestAssetStoreFile): string[] {
    return store.assets.filter((a) => assetContentFingerprint(a) !== a.contentFingerprint).map((a) => `${a.testAssetId}@${a.version}`);
  }

  /** P12.29：关系索引。 */
  buildRelationshipIndex(store: TestAssetStoreFile, pageRefs: Map<string, string[]>): RelationshipIndex {
    const idx: RelationshipIndex = { byRequirement: {}, byCapability: {}, byBusinessRule: {}, byPage: {}, byStatus: {}, byRisk: {}, byScenarioType: {} };
    for (const a of store.assets) {
      const put = (map: Record<string, string[]>, key: string) => { (map[key] ??= []).push(`${a.testAssetId}@${a.version}`); };
      a.requirementRefs.forEach((r) => put(idx.byRequirement, r));
      a.capabilityRefs.forEach((c) => put(idx.byCapability, c));
      a.businessRuleRefs.forEach((r) => put(idx.byBusinessRule, r));
      (pageRefs.get(a.testAssetId) ?? a.executionPath.pages).forEach((p) => put(idx.byPage, p));
      put(idx.byStatus, a.status);
      put(idx.byRisk, `${a.risk.designPriority}/${a.risk.executionRisk}`);
      put(idx.byScenarioType, a.scenarioType);
    }
    return idx;
  }
}

/** 历史备份列表（rollback 用）。 */
export async function listAssetBackups(rootDir: string): Promise<string[]> {
  const dir = assetHistoryDir(rootDir);
  if (!(await fs.pathExists(dir))) return [];
  return (await fs.readdir(dir)).filter((f) => f.endsWith(".json")).sort();
}

/** P12.73：回滚到指定备份。 */
export async function rollbackAssets(rootDir: string, backupFile: string): Promise<{ ok: boolean; error?: string }> {
  const dir = assetHistoryDir(rootDir);
  const p = path.join(dir, backupFile);
  if (!(await fs.pathExists(p))) return { ok: false, error: `backup not found: ${backupFile}` };
  const backup = (await fs.readJson(p)) as { snapshot: TestAssetStoreFile };
  await fs.ensureDir(path.dirname(assetStorePath(rootDir)));
  await writeSafeJsonFile(assetStorePath(rootDir), backup.snapshot);
  return { ok: true };
}
