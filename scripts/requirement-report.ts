/**
 * P10.39：Requirement Analysis Report（Markdown 给人看）。
 * 输出：reports/requirements/<id>/analysis.md
 */
import fs from "fs-extra";
import path from "node:path";
import { analyzeRequirement } from "../src/requirements/pipeline.js";
import { computeTestDesignReadiness } from "../src/requirements/engine.js";

const id = "R001";
const raw = await fs.readFile(path.join(process.cwd(), "reports/requirements", id, "analysis.json"), "utf8").catch(() => "");
if (raw) {
  const m = JSON.parse(raw);
  const readiness = computeTestDesignReadiness(m);
  const md = [
    `# Requirement ${m.requirementId}`,
    "",
    `- 标题: ${m.title} | 状态: ${m.status} | 版本: ${m.version} | prompt: ${m.promptVersion}`,
    `- contextFingerprint: ${m.contextReceipt?.contextFingerprint ?? "-"}`,
    "",
    "## SUMMARY",
    `- ${m.summary}`,
    "",
    "## WHAT CHANGED",
    ...m.businessChanges.map((c: { type: string; affectedEntity: string; after?: string }) => `- [${c.type}] ${c.affectedEntity} ${c.after ?? ""}`),
    "",
    "## ACTORS",
    ...m.actors.map((a: { name: string; origin: string }) => `- ${a.name} (${a.origin})`),
    "",
    "## ACCEPTANCE CRITERIA",
    ...m.acceptanceCriteria.map((a: { kind: string; statement: string }) => `- [${a.kind}] ${a.statement}`),
    "",
    "## BUSINESS RULES",
    ...m.businessRules.map((r: { ruleId: string; statement: string; origin: string; confidence: string }) => `- ${r.ruleId} [${r.origin}/${r.confidence}] ${r.statement}`),
    "",
    "## PRECONDITIONS",
    ...m.preconditions.map((p: { statement: string }) => `- ${p.statement}`),
    "",
    "## STATES / TRANSITIONS",
    ...m.states.map((s: { entity: string; fromState: string; toState: string; trigger: string }) => `- ${s.entity}: ${s.fromState} → ${s.toState} (${s.trigger})`),
    "",
    "## DEPENDENCIES",
    ...m.dependencies.map((d: { sourceConcept: string; relation: string; targetConcept: string }) => `- ${d.sourceConcept} ${d.relation} ${d.targetConcept}`),
    "",
    "## SECURITY / RISK",
    ...m.risks.map((r: { domain: string; level: string }) => `- ${r.domain}: ${r.level}`),
    "",
    "## AMBIGUITIES",
    ...m.ambiguities.map((a: { ambiguityId: string; type: string; question: string; status: string }) => `- ${a.ambiguityId} [${a.type}/${a.status}] ${a.question}`),
    "",
    "## ASSUMPTIONS",
    ...m.assumptions.map((a: { assumptionId: string; statement: string; status: string }) => `- ${a.assumptionId} [${a.status}] ${a.statement}`),
    "",
    "## OPEN QUESTIONS",
    ...m.openQuestions.map((q: { priority: string; question: string }) => `- [${q.priority}] ${q.question}`),
    "",
    "## TEST DESIGN READINESS",
    `- status: ${readiness.status}`,
    ...readiness.blockingIssues.map((b) => `- BLOCK: ${b}`),
    ...readiness.warningIssues.map((w) => `- WARN: ${w}`),
    ""
  ].join("\n");
  await fs.writeFile(path.join(process.cwd(), "reports/requirements", id, "analysis.md"), md, "utf8");
  console.log(`报告: reports/requirements/${id}/analysis.md (readiness=${readiness.status})`);
} else {
  console.log("无 analysis.json，先跑 requirement:analyze");
}
