/**
 * P10.5-16：Business Knowledge CLI。
 *
 *   npm run requirement:knowledge-proposals -- --id R001   # 生成已批准事实的 proposals
 *   npm run requirement:knowledge-approve  -- --id R001     # 全部 eligible fact → promotion
 *   npm run requirement:knowledge-review   -- --queue q_xxx --decision APPROVE
 *   npm run business-knowledge:show       -- --id KB-xxx
 *   npm run business-knowledge:history    -- --domain withdraw
 *   npm run business-knowledge:query      -- --domain withdraw --concept no_verification
 *   npm run business-knowledge:audit
 *   npm run business-knowledge:doctor
 */

import fs from "fs-extra";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadRequirementStore } from "../src/requirements/engine.js";
import { loadKnowledgeStore, promoteFactToKnowledge, listPendingReviews, resolveReview, findBusinessKnowledge, saveKnowledgeStore } from "../src/requirements/knowledge-store.js";
import { runKnowledgeDoctor, traceForward, traceReverse, knowledgeFingerprint } from "../src/requirements/knowledge-doctor.js";
import { buildRequirementModel, createRequirementSource } from "../src/requirements/analyzer.js";
import { analyzeDeterministic } from "../src/requirements/pipeline.js";
import { writeSafeJsonFile } from "../src/core/safe-file-writer.js";

const ROOT = process.cwd();

const parsed = parseArgs({
  options: {
    id: { type: "string" },
    queue: { type: "string" },
    decision: { type: "string", default: "APPROVE" },
    reviewer: { type: "string", default: "cli" },
    domain: { type: "string" },
    concept: { type: "string", multiple: true },
    knowledge: { type: "string" },
    json: { type: "boolean", default: false }
  },
  allowPositionals: true,
  strict: false
});
const opts = parsed.values as Record<string, string | boolean | string[] | undefined>;
const command = parsed.positionals[0] ?? "audit";

function str(v: string | boolean | string[] | undefined): string | undefined { return typeof v === "string" ? v : undefined; }
function strs(v: string | boolean | string[] | undefined): string[] | undefined { if (Array.isArray(v)) return v.map(String); if (typeof v === "string") return [v]; return undefined; }

/** 从 requirement model 生成 ApprovedRequirementFact（模拟人工批准：explicit 已批，security/inference 待批）。 */

function normalizeScope(raw?: string): string {
  const v = (raw ?? "withdraw").toLowerCase();
  const map: Record<string, string> = { withdrawal: "WITHDRAW", withdraw: "WITHDRAW", address: "ADDRESS", permission: "PERMISSION", form: "FORM", state: "STATE", dependency: "DEPENDENCY", security: "SECURITY" };
  return map[v] ?? v.toUpperCase().replace(/\s+/g, "_");
}

function factsFromModel(requirementId: string, model: ReturnType<typeof buildRequirementModel>): Array<{ fact: import("../src/requirements/knowledge-activation.js").ApprovedRequirementFact; scope: { module: string }; relation?: "IF_THEN" | "INVALIDATES" | "FORBIDS" | "ALLOWS" | "DEFAULTS_TO" | "REQUIRES"; condition?: string; effect?: string; humanConfirmed: boolean }> {
  const now = new Date().toISOString();
  const facts: Array<{ fact: import("../src/requirements/knowledge-activation.js").ApprovedRequirementFact; scope: { module: string }; relation?: "IF_THEN" | "INVALIDATES" | "FORBIDS" | "ALLOWS" | "DEFAULTS_TO" | "REQUIRES"; condition?: string; effect?: string; humanConfirmed: boolean }> = [];
  for (const r of model.businessRules) {
    const isSecurity = /2fa|验证|security|白名单|withdraw|提现|kyc/i.test(`${r.scope ?? ""} ${r.statement}`);
    facts.push({
      fact: {
        factId: r.ruleId, requirementId, requirementVersion: model.version,
        factType: isSecurity ? "SECURITY_REQUIREMENT" : "BUSINESS_RULE",
        canonicalStatement: r.statement, structuredValue: { condition: r.condition, effect: r.effect, scope: r.scope },
        origin: r.origin, confidence: r.confidence,
        reviewStatus: r.origin === "EXPLICIT_REQUIREMENT" && !isSecurity ? "APPROVED" : "PENDING_REVIEW",
        provenance: { sourceId: model.sourceId, sourceAnchor: r.statement, requirementVersion: model.version },
        isSecurity, status: "PENDING_REVIEW", createdAt: now, updatedAt: now
      },
      scope: { module: normalizeScope(r.scope) },
      relation: "IF_THEN", condition: r.condition, effect: r.effect,
      humanConfirmed: r.origin === "EXPLICIT_REQUIREMENT" && !isSecurity
    });
  }
  for (const a of model.acceptanceCriteria) {
    facts.push({
      fact: {
        factId: a.acId, requirementId, requirementVersion: model.version,
        factType: "ACCEPTANCE_CRITERION", canonicalStatement: a.statement, structuredValue: { statement: a.statement },
        origin: a.origin, confidence: a.confidence, reviewStatus: a.origin === "EXPLICIT_REQUIREMENT" ? "APPROVED" : "PENDING_REVIEW",
        provenance: { sourceId: model.sourceId, sourceAnchor: a.statement, requirementVersion: model.version },
        isSecurity: false, status: "PENDING_REVIEW", createdAt: now, updatedAt: now
      },
      scope: { module: "GENERAL" }, humanConfirmed: a.origin === "EXPLICIT_REQUIREMENT"
    });
  }
  return facts;
}

async function activate() {
  const id = str(opts.id);
  if (!id) { console.error("需 --id"); process.exit(1); }
  const store = await loadRequirementStore(ROOT);
  const model = store.models.find((m) => m.requirementId === id);
  if (!model) { console.error(`未找到 ${id}`); process.exit(1); }
  // 从 model 重建 facts（模拟 review 后）
  const facts = factsFromModel(id, model as never);
  const kb = await loadKnowledgeStore(ROOT);
  const promoted: string[] = [];
  const blocked: string[] = [];
  for (const f of facts) {
    const outcome = promoteFactToKnowledge(ROOT, kb, f.fact, { scope: f.scope, relation: f.relation, condition: f.condition, effect: f.effect, humanConfirmed: f.humanConfirmed });
    if (outcome.outcome === "promoted" || outcome.outcome === "merged") promoted.push(`${f.fact.factId}→${outcome.knowledgeId}`);
    else blocked.push(`${f.fact.factId}:${outcome.outcome}`);
  }
  await saveKnowledgeStore(ROOT, kb, "activation");
  const report = { requirementId: id, promoted, blocked, pendingReview: listPendingReviews(kb) };
  await writeSafeJsonFile(path.join(ROOT, "reports/requirements", id, "knowledge-activation.json"), report);
  console.log(`activation ${id}: promoted=${promoted.length} blocked=${blocked.length}`);
  promoted.forEach((p) => console.log(`  + ${p}`));
  blocked.forEach((b) => console.log(`  - ${b}`));
  if (listPendingReviews(kb).length) console.log(`pending review: ${listPendingReviews(kb).length}`);
}

async function review() {
  const queueId = str(opts.queue);
  const decision = str(opts.decision) ?? "APPROVE";
  const reviewer = str(opts.reviewer) ?? "cli";
  const kb = await loadKnowledgeStore(ROOT);
  const ok = resolveReview(kb, queueId ?? "", decision, reviewer);
  if (ok) { await saveKnowledgeStore(ROOT, kb, "review"); console.log(`review ${queueId} → ${decision}`); }
  else console.log(`queue ${queueId} 不存在或已解决`);
}

async function show() {
  const id = str(opts.id) ?? str(opts.knowledge);
  const kb = await loadKnowledgeStore(ROOT);
  const k = kb.knowledge.find((x) => x.knowledgeId === id);
  if (!k) { console.error(`未找到 ${id}`); process.exit(1); }
  if (opts.json) console.log(JSON.stringify(k, null, 2));
  else console.log(`${k.knowledgeId} [${k.status}/${k.authority}] ${k.canonicalConcept}\n  scope=${JSON.stringify(k.scope)}\n  value=${JSON.stringify(k.structuredValue)}\n  provenance=${JSON.stringify(k.provenance)}\n  refs=${k.requirementRefs.join(",")}`);
}

async function history() {
  const domain = str(opts.domain);
  const kb = await loadKnowledgeStore(ROOT);
  const items = kb.knowledge.filter((k) => !domain || k.scope.module === domain.toUpperCase());
  console.log(`history (${domain ?? "all"}): ${items.length} items`);
  for (const k of items) console.log(`  ${k.knowledgeId} [${k.status}] v${k.version} ${k.canonicalConcept.slice(0, 50)}${k.supersedes ? ` supersedes=${k.supersedes}` : ""}${k.supersededBy ? ` supersededBy=${k.supersededBy}` : ""}`);
}

async function query() {
  const domain = str(opts.domain);
  const concepts = strs(opts.concept);
  const kb = await loadKnowledgeStore(ROOT);
  const results = findBusinessKnowledge(kb, { domain, concepts, status: "ACTIVE" });
  if (opts.json) console.log(JSON.stringify(results, null, 2));
  else {
    console.log(`query domain=${domain} concepts=${concepts?.join(",")} → ${results.length}`);
    for (const r of results) console.log(`  ${r.knowledgeId} [${r.authority}] ${r.canonicalConcept.slice(0, 60)} scope=${r.scope.module}`);
  }
}

async function audit() {
  const kb = await loadKnowledgeStore(ROOT);
  const byStatus = kb.knowledge.reduce((acc, k) => { acc[k.status] = (acc[k.status] ?? 0) + 1; return acc; }, {} as Record<string, number>);
  const byDomain = kb.knowledge.reduce((acc, k) => { const d = k.scope.module; acc[d] = (acc[d] ?? 0) + 1; return acc; }, {} as Record<string, number>);
  const byType = kb.knowledge.reduce((acc, k) => { acc[k.knowledgeType] = (acc[k.knowledgeType] ?? 0) + 1; return acc; }, {} as Record<string, number>);
  const byAuthority = kb.knowledge.reduce((acc, k) => { acc[k.authority] = (acc[k.authority] ?? 0) + 1; return acc; }, {} as Record<string, number>);
  const report = { total: kb.knowledge.length, byStatus, byDomain, byType, byAuthority, pendingReview: listPendingReviews(kb).length, fingerprint: knowledgeFingerprint(kb) };
  console.log(JSON.stringify(report, null, 2));
}

async function doctor() {
  const store = await loadRequirementStore(ROOT);
  const kb = await loadKnowledgeStore(ROOT);
  const knownReqIds = store.models.map((m) => m.requirementId);
  const report = runKnowledgeDoctor(kb, knownReqIds);
  await writeSafeJsonFile(path.join(ROOT, "reports/requirements/knowledge-doctor.json"), report);
  console.log(`business-knowledge:doctor pass=${report.pass}`);
  report.issues.forEach((i) => console.log(`  - ${i}`));
}

switch (command) {
  case "activate": await activate(); break;
  case "review": await review(); break;
  case "show": await show(); break;
  case "history": await history(); break;
  case "query": await query(); break;
  case "audit": await audit(); break;
  case "doctor": await doctor(); break;
  default: console.log(`未知命令 ${command}`); break;
}
