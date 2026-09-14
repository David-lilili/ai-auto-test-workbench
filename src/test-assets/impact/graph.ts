/**
 * P14.10-17：ImpactNode / Relationship Graph / Reverse Index / Traversal。
 *
 * deterministic graph traversal——不用 LLM 猜"可能影响"。
 * 深度预算：direct = depth 0；critical neighbor = depth 1；禁止无限传播（P14.38）。
 */

import { createHash } from "node:crypto";
import type { RequirementChangeSet, KnowledgeChangeSet, PageChangeSet } from "./change-event.js";

export type ImpactNodeType = "REQUIREMENT" | "REQUIREMENT_FACT" | "BUSINESS_KNOWLEDGE" | "CAPABILITY" | "PAGE" | "PAGE_STATE" | "TEST_ASSET" | "MANUAL_RULE" | "EXECUTION_RUN";

export interface ImpactGraphEdge {
  from: string;
  to: string;
  relation: string;
  confidence: "HIGH" | "MEDIUM" | "LOW";
}

/** P14.11：轻量关系图（JSON，非 Neo4j）。 */
export class ImpactGraph {
  readonly edges: ImpactGraphEdge[] = [];

  addEdge(from: string, to: string, relation: string, confidence: "HIGH" | "MEDIUM" | "LOW" = "HIGH"): void {
    this.edges.push({ from, to, relation, confidence });
  }

  outgoing(nodeId: string): ImpactGraphEdge[] {
    return this.edges.filter((e) => e.from === nodeId);
  }

  incoming(nodeId: string): ImpactGraphEdge[] {
    return this.edges.filter((e) => e.to === nodeId);
  }

  /** P14.12：反向索引（BusinessRule/Capability/Page → TestAssets）。 */
  reverseIndex(toType: string): Record<string, string[]> {
    const idx: Record<string, string[]> = {};
    for (const e of this.edges) {
      if (e.to.startsWith(toType)) (idx[e.to] ??= []).push(e.from);
    }
    return idx;
  }

  version(): string {
    const payload = JSON.stringify(this.edges.map((e) => `${e.from}->${e.to}:${e.confidence}`).sort());
    return createHash("sha256").update(payload).digest("hex").slice(0, 12);
  }
}

export function buildRelationshipGraph(input: {
  requirements: Array<{ requirementId: string; factIds: string[]; capabilityIds: string[] }>;
  knowledge: Array<{ knowledgeId: string; requirementRefs: string[]; capability?: string }>;
  capabilities: Array<{ capabilityId: string; pageIds?: string[] }>;
  assets: Array<{ testAssetId: string; requirementRefs: string[]; businessRuleRefs: string[]; capabilityRefs: string[]; knowledgeRefs: string[]; pages: string[]; manualRuleRefs: string[]; runs?: string[] }>;
  pages: Array<{ pageId: string }>;
  manualRules: Array<{ ruleId: string }>;
}): ImpactGraph {
  const g = new ImpactGraph();
  for (const r of input.requirements) {
    g.addEdge(`REQUIREMENT:${r.requirementId}`, `REQUIREMENT_FACT:${r.requirementId}`, "owns_facts");
    for (const f of r.factIds) g.addEdge(`REQUIREMENT_FACT:${r.requirementId}`, f, "has_fact");
    for (const c of r.capabilityIds) g.addEdge(`REQUIREMENT:${r.requirementId}`, `CAPABILITY:${c}`, "requires_capability");
  }
  for (const k of input.knowledge) {
    for (const ref of k.requirementRefs) g.addEdge(`REQUIREMENT:${ref}`, `BUSINESS_KNOWLEDGE:${k.knowledgeId}`, "derived_from", "HIGH");
    if (k.capability) g.addEdge(`BUSINESS_KNOWLEDGE:${k.knowledgeId}`, `CAPABILITY:${k.capability}`, "supports_capability", "MEDIUM");
  }
  for (const cap of input.capabilities) {
    for (const p of cap.pageIds ?? []) g.addEdge(`CAPABILITY:${cap.capabilityId}`, `PAGE:${p}`, "mapped_to_page", "HIGH");
  }
  for (const a of input.assets) {
    g.addEdge(`TEST_ASSET:${a.testAssetId}`, `REQUIREMENT:${a.requirementRefs[0] ?? ""}`, "verifies_requirement", "HIGH");
    for (const r of a.businessRuleRefs) g.addEdge(`TEST_ASSET:${a.testAssetId}`, r, "covers_rule", "HIGH");
    for (const k of a.knowledgeRefs) g.addEdge(`TEST_ASSET:${a.testAssetId}`, `BUSINESS_KNOWLEDGE:${k}`, "grounded_in", "HIGH");
    for (const c of a.capabilityRefs) g.addEdge(`TEST_ASSET:${a.testAssetId}`, `CAPABILITY:${c}`, "covers_capability", "HIGH");
    for (const p of a.pages) g.addEdge(`TEST_ASSET:${a.testAssetId}`, `PAGE:${p}`, "executes_on", "MEDIUM");
    for (const m of a.manualRuleRefs) g.addEdge(`TEST_ASSET:${a.testAssetId}`, `MANUAL_RULE:${m}`, "uses_manual", "MEDIUM");
    for (const run of a.runs ?? []) g.addEdge(`TEST_ASSET:${a.testAssetId}`, `EXECUTION_RUN:${run}`, "has_run", "HIGH");
  }
  return g;
}

// ============ P14.13-17：Impact Traversal ============

export type ImpactClassification = "DIRECT_BUSINESS_IMPACT" | "INDIRECT_BUSINESS_IMPACT" | "EXECUTION_ONLY_IMPACT" | "TEST_METHOD_IMPACT" | "POSSIBLE_IMPACT" | "NO_IMPACT";

export interface ImpactCandidate {
  testAssetId: string;
  impactType: ImpactClassification;
  impactPath: string[];
  reasonCode: string;
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  confidence: "HIGH" | "MEDIUM" | "LOW";
}

export interface ImpactAnalysisResult {
  graphVersion: string;
  candidates: ImpactCandidate[];
  criticalUncovered: string[];
  changedFactIds: string[];
}

export function analyzeChangeImpact(input: {
  graph: ImpactGraph;
  requirementChange?: RequirementChangeSet;
  knowledgeChange?: KnowledgeChangeSet[];
  pageChange?: PageChangeSet[];
  assets: Array<{ testAssetId: string; status: string; risk: { designPriority: string }; knowledgeRefs: string[]; businessRuleRefs: string[]; acceptanceCriterionRefs: string[]; capabilityRefs: string[]; pages: string[]; manualRuleRefs: string[] }>;
  criticalFactIds: string[];
}): ImpactAnalysisResult {
  const candidates: ImpactCandidate[] = [];
  const changedFactIds = new Set<string>([
    ...(input.requirementChange?.changedFactIds ?? []),
    ...(input.knowledgeChange ?? []).map((k) => k.knowledgeId),
    ...(input.pageChange ?? []).map((p) => p.pageId)
  ]);

  for (const asset of input.assets) {
    if (asset.status !== "ACTIVE") continue;
    const assetPages = (asset as { pages?: string[]; executionPath?: { pages: string[] } }).pages ?? (asset as { executionPath?: { pages: string[] } }).executionPath?.pages ?? [];
    const paths: string[] = [];
    let classification: ImpactClassification = "NO_IMPACT";
    let severity: ImpactCandidate["severity"] = "LOW";
    let confidence: ImpactCandidate["confidence"] = "HIGH";
    let reasonCode = "NO_RELATION_TO_CHANGE";

    // Direct business impact：requirement fact / knowledge / rule / AC 变化
    const reqChange = input.requirementChange;
    const directRuleHit = asset.businessRuleRefs.filter((r) => changedFactIds.has(r));
    const directAcHit = asset.acceptanceCriterionRefs.filter((r) => changedFactIds.has(r));
    const directKnowledgeHit = asset.knowledgeRefs.filter((k) => input.knowledgeChange?.some((kc) => kc.knowledgeId === k));
    if (reqChange) {
      for (const r of directRuleHit) {
        paths.push(`${reqChange.requirementId}:${reqChange.fromVersion}->${reqChange.toVersion} -> ${r} changed`);
      }
    }
    for (const k of directKnowledgeHit) {
      paths.push(`KB ${k} superseded`);
    }
    if (directRuleHit.length || directAcHit.length || directKnowledgeHit.length) {
      classification = "DIRECT_BUSINESS_IMPACT";
      reasonCode = directRuleHit.length ? "REFERENCED_RULE_CHANGED" : directAcHit.length ? "REFERENCED_AC_CHANGED" : "REFERENCED_KNOWLEDGE_CHANGED";
      severity = input.criticalFactIds.some((c) => directRuleHit.includes(c) || directAcHit.includes(c) || directKnowledgeHit.includes(c)) ? "CRITICAL" : "HIGH";
      if (directAcHit.length) paths.push(`AC ${directAcHit.join(",")} changed`);
    }

    // Capability 影响（indirect business）
    const capabilityHit = input.requirementChange
      ? asset.capabilityRefs.filter((c) => input.requirementChange!.changedFactIds.some((f) => f.includes(c)) || input.requirementChange!.securityChanges.length || input.requirementChange!.dependencyChanges.length)
      : [];
    if (classification === "NO_IMPACT" && capabilityHit.length) {
      classification = "INDIRECT_BUSINESS_IMPACT";
      reasonCode = "CAPABILITY_CHANGE";
      severity = "MEDIUM";
      paths.push(`capability ${capabilityHit.join(",")} impacted`);
    }

    // Page-only impact（execution）
    if (input.pageChange?.length) {
      const pageHit = input.pageChange.filter((pc) => assetPages.includes(pc.pageId));
      if (pageHit.length) {
        const locatorOnly = pageHit.every((pc) => pc.locatorOnly);
        if (classification === "NO_IMPACT") {
          classification = "EXECUTION_ONLY_IMPACT";
          reasonCode = locatorOnly ? "PAGE_LOCATOR_CHANGED" : "PAGE_EXECUTION_CHANGE";
          severity = locatorOnly ? "LOW" : "MEDIUM";
          confidence = "HIGH";
        }
        paths.push(`page ${pageHit.map((p) => p.pageId).join(",")} ${locatorOnly ? "locator-only" : "semantic"} changed`);
      }
    }

    // Manual change → TEST_METHOD_IMPACT
    if (input.requirementChange && asset.manualRuleRefs.length) {
      // manual-only change 不产生 business impact（P14.9）
    }

    if (classification !== "NO_IMPACT") {
      candidates.push({ testAssetId: asset.testAssetId, impactType: classification, impactPath: paths, reasonCode, severity, confidence });
    }
  }

  // P14.42：critical changed fact 无 ACTIVE asset 覆盖 → criticalUncovered
  const coveredFacts = new Set<string>();
  for (const a of input.assets) {
    if (a.status !== "ACTIVE") continue;
    a.businessRuleRefs.forEach((r) => coveredFacts.add(r));
    a.acceptanceCriterionRefs.forEach((r) => coveredFacts.add(r));
    a.knowledgeRefs.forEach((k) => coveredFacts.add(k));
  }
  const criticalUncovered = input.criticalFactIds.filter((c) => changedFactIds.has(c) && !coveredFacts.has(c));

  return { graphVersion: input.graph.version(), candidates, criticalUncovered, changedFactIds: [...changedFactIds] };
}
