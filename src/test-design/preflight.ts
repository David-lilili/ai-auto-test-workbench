/**
 * P11.5-5/20：TEST_DESIGN Context Preflight。
 *
 * TEST_DESIGN runtime 缺任一 CRITICAL Context（Test Design Manual / Approved
 * Requirement / Business Knowledge Snapshot / Risk Policy / Current State）
 * 必须 BLOCK，不得进入 designer。
 *
 * 内部 SYSTEMATIC_BASELINE（trials/benchmark）允许绕过（显式传 preflight=false）。
 */

import fs from "fs-extra";
import path from "node:path";
import type { RequirementModel } from "../requirements/types.js";
import { loadKnowledgeStore } from "../requirements/knowledge-store.js";

export interface TestDesignPreflightCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface TestDesignPreflightResult {
  pass: boolean;
  checks: TestDesignPreflightCheck[];
  missing: string[];
}

export async function runTestDesignPreflight(rootDir: string, model: RequirementModel, kb?: Awaited<ReturnType<typeof loadKnowledgeStore>>): Promise<TestDesignPreflightResult> {
  const checks: TestDesignPreflightCheck[] = [];

  // TEST_DESIGN_MANUAL：docs/ai-manuals/test-design/*.md ≥ 1
  const manualDir = path.join(rootDir, "docs", "ai-manuals", "test-design");
  const manualCount = fs.pathExistsSync(manualDir)
    ? fs.readdirSync(manualDir).filter((f) => f.endsWith(".md")).length
    : 0;
  checks.push({ name: "TEST_DESIGN_MANUAL", ok: manualCount >= 1, detail: `${manualCount} manuals` });

  // APPROVED_REQUIREMENT：需求已分析且含可覆盖事实
  const factCount = model.businessRules.length + model.acceptanceCriteria.length + model.states.length + model.dependencies.length + model.constraints.length;
  checks.push({ name: "APPROVED_REQUIREMENT", ok: factCount >= 1, detail: `${factCount} facts` });

  // BUSINESS_KNOWLEDGE_SNAPSHOT：knowledge store 有 ACTIVE 知识
  const store = kb ?? await loadKnowledgeStore(rootDir);
  const activeCount = store.knowledge.filter((k) => k.status === "ACTIVE").length;
  checks.push({ name: "BUSINESS_KNOWLEDGE_SNAPSHOT", ok: activeCount >= 1, detail: `${activeCount} ACTIVE knowledge` });

  // RISK_POLICY：registry 指向 docs/platform-design-decisions.md
  const riskOk = fs.pathExistsSync(path.join(rootDir, "docs", "platform-design-decisions.md"));
  checks.push({ name: "RISK_POLICY", ok: riskOk });

  // CURRENT_STATE：configs/ai-context/current-state.json
  const stateOk = fs.pathExistsSync(path.join(rootDir, "configs", "ai-context", "current-state.json"));
  checks.push({ name: "CURRENT_STATE", ok: stateOk });

  const missing = checks.filter((c) => !c.ok).map((c) => c.name);
  return { pass: missing.length === 0, checks, missing };
}
