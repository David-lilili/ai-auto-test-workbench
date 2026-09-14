import fs from "fs-extra";
import path from "node:path";
import { loadAllKnowledgeEvidence } from "./knowledge-evidence-sink.js";
import type { KnowledgeEvidence } from "./knowledge-promotion-policy.js";

/**
 * Unified Evidence Collector（P5.4）：把知识飞轮的全部证据来源聚成一份 evidence 视图，
 * 供 promotion-audit 与 writeback dispatcher 共用——避免两处各算一遍导致口径漂移。
 *
 * 来源：
 *  1. unified evidence sink（storage/knowledge-evidence/...，SELF_HEALING / NORMALIZATION / CONTROLLED_EXPLORATION）
 *  2. pending proposals（storage/proposals/pending/...，FAILURE_DIAGNOSIS——locator 修复型候选的"原 locator 失败"证据）
 *  3. P4-A normalization 派生（CONTROL_TYPE，只补标 unknown）
 *  4. P3-B exploration runs（CONTROLLED_EXPLORATION）
 *
 * 铁律：只读。本模块不做任何写回；写回由 dispatcher 按 policy + caps 执行。
 */

export interface CollectedEvidence {
  evidenceList: KnowledgeEvidence[];
  /** 各来源条目数（诊断用）。 */
  sourceCounts: {
    sink: number;
    proposals: number;
    normalization: number;
    explorationRuns: number;
  };
}

function extractPageId(proposal: Record<string, unknown>): string {
  const evidence = proposal.evidence as Record<string, unknown> | undefined;
  const intent = evidence?.intent as Record<string, unknown> | undefined;
  const dslValidation = evidence?.dslValidation as Record<string, unknown> | undefined;
  const text = JSON.stringify({ intent, dslValidation });
  const match = text.match(/"(demo\.[a-z_.]+)"/);
  return match ? match[1] : "(unknown-page)";
}

function extractTargetId(proposal: Record<string, unknown>): string {
  const text = JSON.stringify(proposal);
  const match = text.match(/"((?:funds|c\d+|asset|earn|personal|t\d+_?\d*)\.[a-z0-9_.]+)"/i);
  return match ? match[1] : "(unknown-target)";
}

export function proposalToEvidence(proposal: Record<string, unknown>): KnowledgeEvidence | undefined {
  const proposalType = String(proposal.proposalType ?? "");
  const typeMap: Record<string, string> = {
    element_locator_update: "LOCATOR",
    assertion_observable_update: "ASSERTION",
    assertion_contract_or_observable_update: "ASSERTION",
    page_state_or_navigation_update: "STATE",
    provider_flow_model_update: "SECURITY_REQUIREMENT",
    intent_boundary_update: "BUSINESS_RULE",
    intent_hierarchy_update: "BUSINESS_RULE",
    execution_diagnostic_review: "STATE",
    environment_preflight_gap: "STATE",
    page_model_ingest: "CONTROL_TYPE",
    page_identity_conflict: "STATE"
  };
  const knowledgeType = typeMap[proposalType];
  if (!knowledgeType) return undefined;
  return {
    evidenceId: String(proposal.proposalId ?? ""),
    knowledgeType: knowledgeType as KnowledgeEvidence["knowledgeType"],
    pageId: extractPageId(proposal),
    targetId: extractTargetId(proposal),
    sourceType: "FAILURE_DIAGNOSIS",
    sourceRunId: typeof proposal.runId === "string" ? proposal.runId : undefined,
    observation: { reason: proposal.reason, failureStage: proposal.failureStage },
    confidence: "LOW",
    timestamp: String(proposal.createdAt ?? new Date().toISOString()),
    environment: String(proposal.env ?? ""),
    // proposal 本身是"失败的诊断"——outcome 取决于失败阶段
    observedValue: String(proposal.reason ?? proposal.proposalId ?? "").slice(0, 120),
    outcome: /locator_failed|assertion_failed/.test(String(proposal.failureStage ?? "")) ? "failure" : "success"
  };
}

/** 从 page-model store 派生 CONTROL_TYPE 归一化证据（只补标 unknown，与 normalize-audit 口径一致）。 */
function normalizationEvidence(storePath: string): KnowledgeEvidence[] {
  if (!fs.pathExistsSync(storePath)) return [];
  const store = fs.readJsonSync(storePath) as { models?: Array<Record<string, unknown>> };
  const evidenceList: KnowledgeEvidence[] = [];
  for (const model of store.models ?? []) {
    for (const element of (model.elements ?? []) as Array<Record<string, unknown>>) {
      const current = String(element.controlType ?? "unknown");
      if (current !== "unknown") continue;
      const resolution = resolveControlTypeFromElement(element);
      if (!resolution) continue;
      evidenceList.push({
        evidenceId: `norm:${String(element.elementId ?? "")}`,
        knowledgeType: "CONTROL_TYPE",
        pageId: String(model.pageId ?? ""),
        targetId: String(element.elementId ?? ""),
        sourceType: "NORMALIZATION",
        observation: { resolvedType: resolution.type, evidence: resolution.evidence, source: resolution.source },
        confidence: resolution.confidence,
        timestamp: new Date().toISOString(),
        observedValue: resolution.type,
        outcome: "success"
      });
    }
  }
  return evidenceList;
}

interface ElementResolution {
  type: string;
  confidence: "HIGH" | "MEDIUM" | "LOW";
  evidence: string[];
  source: string;
}

/** 轻量版 ControlType 判定（与 page-model-normalizer 同源规则，供证据收集用，避免双向依赖）。 */
function resolveControlTypeFromElement(element: Record<string, unknown>): ElementResolution | undefined {
  const role = String(element.role ?? "").toLowerCase();
  const tag = String(element.tag ?? "").toLowerCase();
  const strongRole: Record<string, string> = {
    option: "dropdown_option",
    combobox: "select",
    listbox: "select",
    textbox: "input",
    spinbutton: "number_input",
    tab: "tab",
    button: "button",
    link: "link"
  };
  if (strongRole[role]) {
    return { type: strongRole[role], confidence: "HIGH", evidence: [`role=${role}`], source: "role" };
  }
  const strongTag: Record<string, string> = { input: "input", textarea: "input", select: "select", button: "button" };
  if (strongTag[tag]) {
    return { type: strongTag[tag], confidence: "HIGH", evidence: [`tag=${tag}`], source: "tag" };
  }
  const component = element.component as Record<string, unknown> | undefined;
  if (component?.type) {
    return { type: String(component.type), confidence: "HIGH", evidence: [`component.type=${component.type}`], source: "component" };
  }
  // 弱信号（MEDIUM/LOW）——按 P4-A 只用于归一化视图，不驱动写回
  const semanticName = String(element.semanticName ?? "");
  const elementId = String(element.elementId ?? "");
  const signals: Array<{ type: string; text: string }> = [];
  if (/输入|input|_field/i.test(semanticName) || /input|_field/i.test(elementId)) signals.push({ type: "input", text: "语义/ID 含输入" });
  if (/下拉|筛选|选择器|dropdown|selector/i.test(semanticName) || /selector|dropdown/i.test(elementId)) signals.push({ type: "select", text: "语义/ID 含下拉" });
  if (/按钮|button/i.test(semanticName) || /btn|button/i.test(elementId)) signals.push({ type: "button", text: "语义/ID 含按钮" });
  if (/tab|标签页/i.test(semanticName) || /tab/i.test(elementId)) signals.push({ type: "tab", text: "语义/ID 含 tab" });
  if (signals.length === 0) return undefined;
  const confidence = signals.length >= 2 ? "MEDIUM" : "LOW";
  return { type: signals[0].type, confidence, evidence: signals.map((s) => s.text), source: "semantic_pattern" };
}

export async function collectAllKnowledgeEvidence(rootDir: string, project: string): Promise<CollectedEvidence> {
  const evidenceList: KnowledgeEvidence[] = [];
  const sourceCounts = { sink: 0, proposals: 0, normalization: 0, explorationRuns: 0 };

  // 1. evidence sink
  const sinkEvidence = await loadAllKnowledgeEvidence(rootDir, project);
  evidenceList.push(...sinkEvidence);
  sourceCounts.sink = sinkEvidence.length;

  // 2. pending proposals
  const pendingDir = path.join(rootDir, "storage/proposals/pending");
  if (fs.pathExistsSync(pendingDir)) {
    for (const file of fs.readdirSync(pendingDir).filter((f) => f.endsWith(".json"))) {
      const proposal = fs.readJsonSync(path.join(pendingDir, file)) as Record<string, unknown>;
      const evidence = proposalToEvidence(proposal);
      if (evidence) {
        evidenceList.push(evidence);
        sourceCounts.proposals++;
      }
    }
  }

  // 3. P4-A normalization 派生
  const storePath = path.join(rootDir, "storage", "page-models", `${project}.json`);
  const normEvidence = normalizationEvidence(storePath);
  evidenceList.push(...normEvidence);
  sourceCounts.normalization = normEvidence.length;

  // 4. exploration runs
  const runsDir = path.join(rootDir, "storage/exploration-runs");
  if (fs.pathExistsSync(runsDir)) {
    for (const file of fs.readdirSync(runsDir).filter((f) => f.endsWith(".json"))) {
      const run = fs.readJsonSync(path.join(runsDir, file)) as Record<string, unknown>;
      sourceCounts.explorationRuns++;
      evidenceList.push({
        evidenceId: `explore:${String(run.runId ?? "")}`,
        knowledgeType: "INTERACTION",
        pageId: String(run.pageId ?? ""),
        targetId: String(run.gapId ?? "").includes(":element:") ? String(run.gapId).split(":element:")[1] : String(run.gapId ?? ""),
        sourceType: "CONTROLLED_EXPLORATION",
        sourceRunId: typeof run.runId === "string" ? run.runId : undefined,
        sourceGapId: typeof run.gapId === "string" ? run.gapId : undefined,
        heuristicId: typeof run.heuristicId === "string" ? run.heuristicId : undefined,
        heuristicVersion: typeof run.heuristicVersion === "number" ? run.heuristicVersion : undefined,
        observation: {
          status: run.status,
          restore: run.restoreResult,
          steps: Array.isArray(run.steps) ? (run.steps as Array<Record<string, unknown>>).map((s) => s.action) : []
        },
        confidence: run.status === "COMPLETED_CLEANLY" ? "HIGH" : "MEDIUM",
        timestamp: new Date().toISOString(),
        observedValue: `interaction:${String(run.heuristicId ?? "unknown")}`,
        outcome: run.status === "COMPLETED_CLEANLY" ? "success" : "failure"
      });
    }
  }

  return { evidenceList, sourceCounts };
}
