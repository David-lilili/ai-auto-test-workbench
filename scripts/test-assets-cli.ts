/**
 * P12.27/50/73/75：Test Assets CLI。
 *
 *   npm run test-assets:ingest -- --requirement R001 [--auto-approve]
 *   npm run test-assets:review-list
 *   npm run test-assets:review-show -- --asset TA-001
 *   npm run test-assets:approve -- --asset TA-001 --reviewer david --reason "..."
 *   npm run test-assets:reject -- --asset TA-001 --reviewer david --reason "..."
 *   npm run test-assets:edit -- --asset TA-001 --field title --value "..." --reviewer david
 *   npm run test-assets:merge -- --asset TA-001 --merge-with TA-002 --reviewer david
 *   npm run test-assets:history -- --asset TA-001
 *   npm run test-assets:trace -- --asset TA-001 | --requirement R001
 *   npm run test-assets:doctor
 *   npm run test-assets:audit
 *   npm run test-assets:rollback -- --backup <file>
 *   npm run test-assets:dashboard
 *   npm run test-assets:query -- --requirement R001
 */

import fs from "fs-extra";
import path from "node:path";
import { parseArgs } from "node:util";
import { TestAssetService } from "../src/test-assets/service.js";
import { TestAssetStore, listAssetBackups, rollbackAssets } from "../src/test-assets/store.js";
import { runAssetDoctor } from "../src/test-assets/doctor.js";
import { auditAssets, auditToMarkdown, buildCoverageDashboard } from "../src/test-assets/audit.js";
import { buildTestAssetSnapshot, testAssetSnapshotFingerprint } from "../src/test-assets/snapshot.js";
import { buildExecutionPreparationPackage } from "../src/test-assets/handoff.js";
import { loadRequirementStore } from "../src/requirements/engine.js";
import { loadKnowledgeStore } from "../src/requirements/knowledge-store.js";
import { loadCandidateStore } from "../src/test-design/engine.js";
import { writeSafeJsonFile } from "../src/core/safe-file-writer.js";

const ROOT = process.cwd();
const REPORT_DIR = "reports/test-assets";

const parsed = parseArgs({
  options: {
    requirement: { type: "string" },
    asset: { type: "string" },
    "merge-with": { type: "string" },
    reviewer: { type: "string", default: "david" },
    reason: { type: "string", default: "" },
    field: { type: "string" },
    value: { type: "string" },
    backup: { type: "string" },
    "auto-approve": { type: "boolean", default: false },
    environment: { type: "string" },
    authorize: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    json: { type: "boolean", default: false }
  },
  allowPositionals: true,
  strict: false
});
const opts = parsed.values as Record<string, string | boolean | undefined>;
const command = parsed.positionals[0] ?? "review-list";
const str = (v: string | boolean | undefined): string | undefined => (typeof v === "string" ? v : undefined);

async function depsFor() {
  const reqStore = await loadRequirementStore(ROOT);
  const kb = await loadKnowledgeStore(ROOT);
  const candidateStore = await loadCandidateStore(ROOT);
  return {
    knownRequirements: reqStore.models.map((m) => m.requirementId),
    knownBusinessRules: reqStore.models.flatMap((m) => m.businessRules.map((r) => r.ruleId)),
    knownCapabilities: [],
    knownKnowledgeIds: kb.knowledge.map((k) => k.knowledgeId),
    reqStore,
    kb,
    candidateStore
  };
}

async function ingest() {
  const reqId = str(opts.requirement);
  if (!reqId) { console.error("需 --requirement"); process.exit(1); }
  const deps = await depsFor();
  const service = new TestAssetService(ROOT, { knownRequirements: deps.knownRequirements, knownBusinessRules: deps.knownBusinessRules, knownCapabilities: deps.knownCapabilities });
  const model = deps.reqStore.models.find((m) => m.requirementId === reqId);
  if (!model) { console.error(`未找到 requirement ${reqId}`); process.exit(1); }
  const candidates = deps.candidateStore.candidates.filter((c) => c.requirementId === reqId);
  if (candidates.length === 0) { console.error(`无 candidates（先 test-design:generate）`); process.exit(1); }
  const results = [];
  for (const c of candidates) {
    const r = await service.ingestCandidate({
      candidate: c,
      requirementId: reqId,
      requirementVersion: model.version,
      creationMode: "SYSTEMATIC_BASELINE",
      reviewer: str(opts.reviewer),
      autoApprove: opts["auto-approve"] === true
    });
    results.push({ candidateId: c.candidateId, eligibility: r.eligibility.status, assetId: r.asset?.testAssetId, match: r.match?.kind, reasons: r.eligibility.reasons });
  }
  await fs.ensureDir(REPORT_DIR);
  await writeSafeJsonFile(path.join(REPORT_DIR, `${reqId}-assets.json`), results);
  for (const r of results) console.log(`  ${r.candidateId} eligibility=${r.eligibility} asset=${r.assetId ?? "-"} match=${r.match ?? "-"} ${r.reasons.join(";")}`);
}

async function reviewList() {
  const service = new TestAssetService(ROOT, { knownRequirements: [], knownBusinessRules: [], knownCapabilities: [] });
  const store = await service.load();
  const pending = store.assets.filter((a) => ["DRAFT", "IN_REVIEW"].includes(a.status));
  console.log(`review queue: ${pending.length} pending / ${store.assets.length} total`);
  for (const a of pending) {
    console.log(`  ${a.testAssetId}@${a.version} [${a.status}/${a.risk.designPriority}/${a.risk.executionRisk}] ${a.title.slice(0, 60)}`);
  }
}

async function reviewShow() {
  const assetId = str(opts.asset);
  if (!assetId) { console.error("需 --asset"); process.exit(1); }
  const service = new TestAssetService(ROOT, { knownRequirements: [], knownBusinessRules: [], knownCapabilities: [] });
  const store = await service.load();
  const store2 = new TestAssetStore(ROOT);
  const asset = store2.currentVersion(store, assetId);
  if (!asset) { console.error(`asset not found: ${assetId}`); process.exit(1); }
  console.log(JSON.stringify(asset, null, 2));
}

async function approve() {
  const assetId = str(opts.asset);
  if (!assetId) { console.error("需 --asset"); process.exit(1); }
  const service = new TestAssetService(ROOT, { knownRequirements: [], knownBusinessRules: [], knownCapabilities: [] });
  const r = await service.review(assetId, "APPROVE", { reviewer: str(opts.reviewer) ?? "david", reason: str(opts.reason) ?? "approved" });
  if (r.error) { console.error(r.error); process.exit(1); }
  console.log(`approved ${assetId}@${r.asset?.version} -> ${r.asset?.status}`);
}

async function reject() {
  const assetId = str(opts.asset);
  if (!assetId) { console.error("需 --asset"); process.exit(1); }
  const service = new TestAssetService(ROOT, { knownRequirements: [], knownBusinessRules: [], knownCapabilities: [] });
  const r = await service.review(assetId, "REJECT", { reviewer: str(opts.reviewer) ?? "david", reason: str(opts.reason) ?? "rejected" });
  if (r.error) { console.error(r.error); process.exit(1); }
  console.log(`rejected ${assetId}@${r.asset?.version}`);
}

async function edit() {
  const assetId = str(opts.asset);
  const field = str(opts.field);
  const value = str(opts.value);
  if (!assetId || !field || !value) { console.error("需 --asset --field --value"); process.exit(1); }
  const service = new TestAssetService(ROOT, { knownRequirements: [], knownBusinessRules: [], knownCapabilities: [] });
  const store = await service.load();
  const current = new TestAssetStore(ROOT).currentVersion(store, assetId);
  if (!current) { console.error("asset not found"); process.exit(1); }
  const edits = { field: field as import("../src/test-assets/types.js").ReviewableField, value: field === "title" || field === "objective" ? value : JSON.parse(value) };
  const r = await service.review(assetId, "EDIT_AND_APPROVE", { reviewer: str(opts.reviewer) ?? "david", reason: str(opts.reason) ?? `human edit ${field}` }, edits);
  if (r.error) { console.error(r.error); process.exit(1); }
  console.log(`edited ${assetId}@${r.asset?.version} field=${field} humanAuthoredFields=${r.asset?.humanAuthoredFields.join(",")}`);
}

async function merge() {
  const assetId = str(opts.asset);
  const mergeWith = str(opts["merge-with"]);
  if (!assetId || !mergeWith) { console.error("需 --asset --merge-with"); process.exit(1); }
  const service = new TestAssetService(ROOT, { knownRequirements: [], knownBusinessRules: [], knownCapabilities: [] });
  const r = await service.merge(assetId, mergeWith, { reviewer: str(opts.reviewer) ?? "david", reason: str(opts.reason) ?? "merge duplicates" });
  if (r.error) { console.error(r.error); process.exit(1); }
  console.log(`merged ${mergeWith} into ${assetId} (refs=${r.target?.requirementRefs.join(",")})`);
}

async function history() {
  const assetId = str(opts.asset);
  if (!assetId) { console.error("需 --asset"); process.exit(1); }
  const service = new TestAssetService(ROOT, { knownRequirements: [], knownBusinessRules: [], knownCapabilities: [] });
  const store = await service.load();
  for (const a of store.assets.filter((x) => x.testAssetId === assetId).sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }))) {
    console.log(`## ${a.testAssetId}@${a.version} [${a.status}]`);
    for (const rv of a.reviewHistory) console.log(`  ${rv.timestamp} ${rv.decision} by ${rv.reviewer}: ${rv.reason}`);
  }
}

async function trace() {
  const assetId = str(opts.asset);
  const reqId = str(opts.requirement);
  const service = new TestAssetService(ROOT, { knownRequirements: [], knownBusinessRules: [], knownCapabilities: [] });
  const store = await service.load();
  if (reqId) {
    const assets = store.assets.filter((a) => a.requirementRefs.includes(reqId) && a.status !== "REJECTED");
    console.log(`Requirement ${reqId} -> ${assets.length} assets:`);
    for (const a of assets) console.log(`  ${a.testAssetId}@${a.version} [${a.status}] ${a.title.slice(0, 50)}`);
    return;
  }
  if (!assetId) { console.error("需 --asset 或 --requirement"); process.exit(1); }
  const versions = store.assets.filter((a) => a.testAssetId === assetId).sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
  const a = versions[0];
  if (!a) { console.error("asset not found"); process.exit(1); }
  console.log(`TestAsset ${a.testAssetId}@${a.version}`);
  console.log(`  Requirement: ${a.requirementRefs.join(", ")}`);
  console.log(`  Business Rules: ${a.businessRuleRefs.join(", ") || "-"}`);
  console.log(`  AC: ${a.acceptanceCriterionRefs.join(", ") || "-"}`);
  console.log(`  Capabilities: ${a.capabilityRefs.join(", ") || "-"}`);
  console.log(`  Obligations: ${a.coverageObligationRefs.join(", ") || "-"}`);
  console.log(`  Knowledge: ${a.knowledgeRefs.join(", ") || "-"}`);
  console.log(`  Manual: ${a.manualRuleRefs.join(", ") || "-"}`);
  console.log(`  Review: ${a.reviewHistory.map((r) => `${r.decision}@${r.timestamp.slice(0, 10)}`).join(" -> ") || "none"}`);
  console.log(`  CreationMode: ${a.creationMode}`);
}

async function doctor() {
  const deps = await depsFor();
  const store = new TestAssetStore(ROOT);
  const file = await store.load();
  const report = runAssetDoctor({
    store: file,
    knownRequirements: deps.knownRequirements,
    knownBusinessRules: deps.knownBusinessRules,
    knownCapabilities: [],
    knownKnowledgeIds: deps.knownKnowledgeIds,
    criticalObligationRefs: deps.candidateStore.testDesignInputs.flatMap((i) => [] as string[])
  });
  await fs.ensureDir(REPORT_DIR);
  await writeSafeJsonFile(path.join(REPORT_DIR, "doctor.json"), report);
  console.log(`test-assets:doctor pass=${report.pass}`);
  report.issues.forEach((i) => console.log(`  - ${i}`));
}

async function audit() {
  const store = new TestAssetStore(ROOT);
  const file = await store.load();
  const stats = auditAssets(file);
  await fs.ensureDir(REPORT_DIR);
  await writeSafeJsonFile(path.join(REPORT_DIR, "audit.json"), stats);
  console.log(auditToMarkdown(stats));
}

async function rollback() {
  const backup = str(opts.backup);
  if (!backup) { console.error("需 --backup <file>"); process.exit(1); }
  const r = await rollbackAssets(ROOT, backup);
  if (!r.ok) { console.error(r.error); process.exit(1); }
  console.log(`rolled back to ${backup}`);
}

async function dashboard() {
  const deps = await depsFor();
  const store = new TestAssetStore(ROOT);
  const file = await store.load();
  const { buildCoverageObligations } = await import("../src/test-design/obligations.js");
  const obligations: Awaited<ReturnType<typeof buildCoverageObligations>> = [];
  for (const entry of deps.candidateStore.testDesignInputs) {
    obligations.push(...buildCoverageObligations(entry.input as never));
  }
  const criticalRefs = obligations.filter((o) => o.criticality === "CRITICAL").map((o) => o.obligationId);
  const totalRefs = obligations.map((o) => o.obligationId);
  const dashboardData = buildCoverageDashboard({ store: file, requirementCount: deps.knownRequirements.length, criticalObligationRefs: criticalRefs, totalObligationRefs: totalRefs });
  await fs.ensureDir(REPORT_DIR);
  await writeSafeJsonFile(path.join(REPORT_DIR, "dashboard.json"), dashboardData);
  console.log(JSON.stringify(dashboardData, null, 2));
}

async function query() {
  const reqId = str(opts.requirement);
  const service = new TestAssetService(ROOT, { knownRequirements: [], knownBusinessRules: [], knownCapabilities: [] });
  const assets = await service.query(reqId);
  console.log(`assets: ${assets.length}`);
  for (const a of assets) console.log(`  ${a.testAssetId}@${a.version} [${a.status}] ${a.title.slice(0, 60)}`);
}

async function prep() {
  const assetId = str(opts.asset);
  if (!assetId) { console.error("需 --asset"); process.exit(1); }
  const store = new TestAssetStore(ROOT);
  const file = await store.load();
  const asset = store.currentVersion(file, assetId);
  if (!asset) { console.error("asset not found"); process.exit(1); }
  const pkg = buildExecutionPreparationPackage(asset);
  await fs.ensureDir(REPORT_DIR);
  await writeSafeJsonFile(path.join(REPORT_DIR, `${assetId}-prep.json`), pkg);
  console.log(JSON.stringify({ packageId: pkg.packageId, actions: pkg.semanticActions.length, pages: pkg.pageRefs, risk: pkg.executionRisk }, null, 2));
}

async function snapshotCmd() {
  const reqId = str(opts.requirement);
  const store = new TestAssetStore(ROOT);
  const file = await store.load();
  const snap = buildTestAssetSnapshot({ store: file, domain: "withdraw", requirementIds: reqId ? [reqId] : undefined, budgetLimit: 20 });
  const fp = testAssetSnapshotFingerprint(snap);
  console.log(JSON.stringify({ assets: snap.assets.map((a) => `${a.testAssetId}@${a.version}`), fingerprint: fp, budget: snap.budget }, null, 2));
}

async function trials() {
  const {
    runReviewTrial, runSecurityTrial, runHighRiskTrial, runDuplicateTrial, runHumanEditTrial,
    runReqV2Trial, runKnowledgeSupersessionTrial, runPageChangeTrial, runManualVersionTrial,
    runReviewBenchmark, runCandidateStaleTrial
  } = await import("./test-assets-trials.js");
  const results = {
    review: await runReviewTrial(),
    security: await runSecurityTrial(),
    highRisk: await runHighRiskTrial(),
    duplicate: await runDuplicateTrial(),
    humanEdit: await runHumanEditTrial(),
    reqV2: await runReqV2Trial(),
    knowledgeSupersession: await runKnowledgeSupersessionTrial(),
    pageChange: await runPageChangeTrial(),
    manualVersion: await runManualVersionTrial(),
    reviewBenchmark: runReviewBenchmark(),
    candidateStale: await runCandidateStaleTrial()
  };
  await fs.ensureDir(REPORT_DIR);
  await writeSafeJsonFile(path.join(REPORT_DIR, "trials.json"), results);
  for (const [k, v] of Object.entries(results)) {
    const r = v as { pass?: boolean; detail?: string };
    console.log(`${k}: ${r.pass === true ? "PASS" : r.pass === false ? "FAIL" : "?"} ${r.detail ?? ""}`);
  }
}

async function prepare() {
  // P13.43：test-assets:prepare --asset TA-001
  const assetId = str(opts.asset);
  if (!assetId) { console.error("需 --asset"); process.exit(1); }
  const { TestAssetExecutionService } = await import("../src/test-assets/execution-service.js");
  const store = new TestAssetStore(ROOT);
  const file = await store.load();
  const asset = store.currentVersion(file, assetId);
  if (!asset) { console.error(`asset not found: ${assetId}`); process.exit(1); }
  const svc = new TestAssetExecutionService({ rootDir: ROOT, project: "demo", env: "test", environment: "UAT" });
  const prep = await svc.prepare(asset);
  await fs.ensureDir(REPORT_DIR);
  await writeSafeJsonFile(path.join(REPORT_DIR, `${assetId}-prep.json`), prep);
  console.log(JSON.stringify({
    readiness: prep.readiness,
    blockReasons: prep.blockReasons,
    pages: prep.pageModelRefs,
    testData: prep.resolvedTestData.map((d) => `${d.dimension}=${d.value}(${d.source})`),
    profile: prep.resolvedAccountProfile,
    risk: prep.executionRisk
  }, null, 2));
}

async function materialize() {
  // P13.44：test-assets:materialize --asset TA-001（只生成 DSL，不执行）
  const assetId = str(opts.asset);
  if (!assetId) { console.error("需 --asset"); process.exit(1); }
  const { TestAssetExecutionService } = await import("../src/test-assets/execution-service.js");
  const store = new TestAssetStore(ROOT);
  const file = await store.load();
  const asset = store.currentVersion(file, assetId);
  if (!asset) { console.error(`asset not found: ${assetId}`); process.exit(1); }
  const svc = new TestAssetExecutionService({ rootDir: ROOT, project: "demo", env: "test", environment: "UAT" });
  const m = svc.materialize(asset);
  await fs.ensureDir(REPORT_DIR);
  await writeSafeJsonFile(path.join(REPORT_DIR, `${assetId}-materialized.json`), m);
  console.log(JSON.stringify({
    semanticCompleteness: m.semanticCompleteness,
    completenessDetail: m.completenessDetail,
    sourceRef: m.sourceRef,
    fingerprint: m.fingerprint,
    steps: m.testCase.steps.map((s) => `${s.action}:${s.semantic_target ?? ""}`),
    assertions: m.testCase.assertions.map((a) => `${a.type}:${String(a.expected ?? a.target)}`),
    warnings: m.warnings
  }, null, 2));
}

async function execute() {
  // P13.45：test-assets:execute --asset TA-001 [--dry-run] [--environment UAT] [--authorize]
  const assetId = str(opts.asset);
  if (!assetId) { console.error("需 --asset"); process.exit(1); }
  const { TestAssetExecutionService } = await import("../src/test-assets/execution-service.js");
  const { loadContext } = await import("../src/core/config-loader.js");
  const store = new TestAssetStore(ROOT);
  const file = await store.load();
  const asset = store.currentVersion(file, assetId);
  if (!asset) { console.error(`asset not found: ${assetId}`); process.exit(1); }
  const environment = str(opts.environment) as "LOCAL" | "DEV" | "UAT" | "PRODUCTION" ?? "UAT";
  const svc = new TestAssetExecutionService({ rootDir: ROOT, project: "demo", env: "test", environment });
  const authorization = opts.authorize === true
    ? { risk: asset.risk.executionRisk, expiresAt: new Date(Date.now() + 3600_000).toISOString() }
    : undefined;
  const gate = svc.gate(asset, authorization);
  if (opts["dry-run"] === true) {
    console.log(JSON.stringify({ dryRun: true, gate, prep: (await svc.prepare(asset)).readiness }, null, 2));
    return;
  }
  if (!gate.allowed) { console.log(`BLOCK: ${gate.reason}`); process.exit(1); }
  const context = await loadContext({ project: "demo", env: "test" });
  const outcome = await svc.execute(asset, {
    context,
    options: { project: "demo", env: "test", tags: [], locales: [], dryRun: false, mode: "heal", maxAiCalls: 0, maxDurationMs: 120_000 },
    authorization
  });
  console.log(JSON.stringify(outcome, null, 2));
}

async function executionDoctor() {
  // P13.47：test-assets:execution-doctor
  const { TestAssetExecutionService } = await import("../src/test-assets/execution-service.js");
  const store = new TestAssetStore(ROOT);
  const file = await store.load();
  const svc = new TestAssetExecutionService({ rootDir: ROOT, project: "demo", env: "test", environment: "UAT" });
  const issues: string[] = [];
  const active = file.assets.filter((a) => a.status === "ACTIVE");
  for (const a of active) {
    const prep = await svc.prepare(a);
    if (prep.readiness !== "READY") issues.push(`${a.testAssetId}@${a.version}: ${prep.readiness} (${prep.blockReasons.join(";")})`);
  }
  console.log(`test-assets:execution-doctor active=${active.length} issues=${issues.length}`);
  issues.forEach((i) => console.log(`  - ${i}`));
}

async function executionAudit() {
  // P13.48：test-assets:execution-audit
  const { TestAssetExecutionService } = await import("../src/test-assets/execution-service.js");
  const store = new TestAssetStore(ROOT);
  const file = await store.load();
  const svc = new TestAssetExecutionService({ rootDir: ROOT, project: "demo", env: "test", environment: "UAT" });
  const byStatus: Record<string, number> = {};
  const active = file.assets.filter((a) => a.status === "ACTIVE");
  for (const a of active) {
    const prep = await svc.prepare(a);
    byStatus[prep.readiness] = (byStatus[prep.readiness] ?? 0) + 1;
  }
  const result = { active: active.length, byReadiness: byStatus };
  await fs.ensureDir(REPORT_DIR);
  await writeSafeJsonFile(path.join(REPORT_DIR, "execution-audit.json"), result);
  console.log(JSON.stringify(result, null, 2));
}

async function runHistoryCmd() {
  const assetId = str(opts.asset);
  if (!assetId) { console.error("需 --asset"); process.exit(1); }
  const { loadRunHistory, runSummary } = await import("../src/test-assets/execution-runner.js");
  const runs = await loadRunHistory(ROOT, assetId);
  console.log(`runs: ${runs.length}`);
  for (const r of runs) console.log(`  ${r.runId?.slice(0, 8)} ${r.result} attempts=${r.attempts.length} flaky=${r.flaky} ${r.createdAt}`);
  console.log(`summary: ${JSON.stringify(runSummary(runs))}`);
}

async function executionTrials() {
  const {
    runRealPassTrial, runProductFailureTrial, runModelFailureTrial, runTestDataFailureTrial, runRiskBlockTrial,
    runPageChangeTrial, runBusinessRuleChangeTrial, runOldDslIndependenceTrial, runColdStartTrial,
    runRetryPolicyTrial, runCapabilityCoverageTrial, runPreconditionTrial, runExecutionHistoryTrial, runFingerprintTrial
  } = await import("./test-assets-execution-trials.js");
  const results = {
    realPass: await runRealPassTrial(),
    productFailure: await runProductFailureTrial(),
    modelFailure: await runModelFailureTrial(),
    testDataFailure: await runTestDataFailureTrial(),
    riskBlock: await runRiskBlockTrial(),
    pageChange: await runPageChangeTrial(),
    businessRuleChange: await runBusinessRuleChangeTrial(),
    oldDslIndependence: await runOldDslIndependenceTrial(),
    coldStart: await runColdStartTrial(),
    retryPolicy: await runRetryPolicyTrial(),
    capabilityCoverage: await runCapabilityCoverageTrial(),
    precondition: runPreconditionTrial(),
    executionHistory: await runExecutionHistoryTrial(),
    fingerprint: runFingerprintTrial()
  };
  await fs.ensureDir(REPORT_DIR);
  await writeSafeJsonFile(path.join(REPORT_DIR, "execution-trials.json"), results);
  for (const [k, v] of Object.entries(results)) {
    const r = v as { pass?: boolean; detail?: string };
    console.log(`${k}: ${r.pass === true ? "PASS" : r.pass === false ? "FAIL" : "?"} ${r.detail ?? ""}`);
  }
}

switch (command) {
  case "ingest": await ingest(); break;
  case "review-list": await reviewList(); break;
  case "review-show": await reviewShow(); break;
  case "approve": await approve(); break;
  case "reject": await reject(); break;
  case "edit": await edit(); break;
  case "merge": await merge(); break;
  case "history": await history(); break;
  case "trace": await trace(); break;
  case "doctor": await doctor(); break;
  case "audit": await audit(); break;
  case "rollback": await rollback(); break;
  case "dashboard": await dashboard(); break;
  case "query": await query(); break;
  case "prep": await prep(); break;
  case "snapshot": await snapshotCmd(); break;
  case "trials": await trials(); break;
  case "prepare": await prepare(); break;
  case "materialize": await materialize(); break;
  case "execute": await execute(); break;
  case "execution-doctor": await executionDoctor(); break;
  case "execution-audit": await executionAudit(); break;
  case "run-history": await runHistoryCmd(); break;
  case "execution-trials": await executionTrials(); break;
  default: console.log(`未知命令 ${command}`); break;
}
