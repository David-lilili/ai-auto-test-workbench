/**
 * P12.49/75：Asset Audit + Dashboard Data。
 */

import type { TestAssetStoreFile, TestAsset } from "./types.js";
import { computeAssetCoverage } from "./coverage.js";

export interface AuditStats {
  total: number;
  byStatus: Record<string, number>;
  byScenarioType: Record<string, number>;
  byRisk: Record<string, number>;
  byCreationMode: Record<string, number>;
  byCapability: Record<string, number>;
}

export function auditAssets(store: TestAssetStoreFile): AuditStats {
  const stats: AuditStats = { total: store.assets.length, byStatus: {}, byScenarioType: {}, byRisk: {}, byCreationMode: {}, byCapability: {} };
  const inc = (m: Record<string, number>, k: string) => { m[k] = (m[k] ?? 0) + 1; };
  for (const a of store.assets) {
    inc(stats.byStatus, a.status);
    inc(stats.byScenarioType, a.scenarioType);
    inc(stats.byRisk, `${a.risk.designPriority}/${a.risk.executionRisk}`);
    inc(stats.byCreationMode, a.creationMode);
    a.capabilityRefs.forEach((c) => inc(stats.byCapability, c));
  }
  return stats;
}

/** P12.75：coverage dashboard（JSON/Markdown）。 */
export function buildCoverageDashboard(input: {
  store: TestAssetStoreFile;
  requirementCount: number;
  criticalObligationRefs: string[];
  totalObligationRefs: string[];
}): Record<string, unknown> {
  const coverage = computeAssetCoverage(input.store);
  const covered = new Set(coverage.map((c) => c.factId));
  const execStatus = { READY: 0, PARTIAL: 0, UNKNOWN: 0 };
  for (const a of input.store.assets) {
    if (a.status !== "ACTIVE") continue;
    if (a.executionPath.status === "KNOWN") execStatus.READY += 1;
    else if (a.executionPath.status === "PARTIAL") execStatus.PARTIAL += 1;
    else execStatus.UNKNOWN += 1;
  }
  return {
    requirements: input.requirementCount,
    activeAssets: input.store.assets.filter((a) => a.status === "ACTIVE").length,
    criticalAcCoverage: input.criticalObligationRefs.length ? +(input.criticalObligationRefs.filter((r) => covered.has(r)).length / input.criticalObligationRefs.length).toFixed(3) : 1,
    businessRuleCoverage: input.totalObligationRefs.length ? +(input.totalObligationRefs.filter((r) => covered.has(r)).length / input.totalObligationRefs.length).toFixed(3) : 1,
    securityCoverage: "见 criticalAcCoverage",
    executionReady: execStatus.READY,
    executionPartial: execStatus.PARTIAL,
    executionUnknown: execStatus.UNKNOWN
  };
}

/** P12.49 markdown 摘要。 */
export function auditToMarkdown(stats: AuditStats): string {
  const lines = [`# Test Asset Audit`, `total: ${stats.total}`];
  const fmt = (m: Record<string, number>) => Object.entries(m).sort((a, b) => b[1] - a[1]).map(([k, v]) => `- ${k}: ${v}`).join("\n");
  lines.push(`## byStatus\n${fmt(stats.byStatus)}`, `## byScenarioType\n${fmt(stats.byScenarioType)}`, `## byRisk\n${fmt(stats.byRisk)}`, `## byCreationMode\n${fmt(stats.byCreationMode)}`);
  return lines.join("\n\n");
}
