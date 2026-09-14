/**
 * Element Alias Invalid Resolution Fail-Closed — targeted tests（P16.7 Phase 2）。
 *
 * 目标：invalid alias（cycle / self alias / missing canonical / broken chain）必须
 * target-level fail-closed——
 *   - 不得以 sourceTargetId 作为伪 canonical 参与 promotion 聚合；
 *   - 不得形成可写 old source element 的 LOCATOR target；
 *   - dispatcher / modeling-orchestrator / review-lifecycle / review-projection
 *     全部遵守相同语义，且留下确定性的 INVALID_ALIAS 诊断（不静默吞掉）；
 *   - 同批其他合法证据继续正常聚合 / promotion（整批不 crash）。
 *
 * 覆盖：
 *   A  aggregateEvidence（A1 cycle / A2 self / A3 missing canonical / A4 broken chain / A5 mixed batch）
 *   B  buildLocatorTargets（invalid 全拒入 + 合法 alias 继续 canonical 聚合）
 *   C  Dispatcher（oldA 在 elements[] 中且 alias 非法——最关键的回归场景）
 *   D  Modeling Orchestrator（真实 production modeling path）
 *   E  Review Lifecycle（human APPROVED 也不能绕过 alias integrity）
 *   F  Review Projection（invalid alias 不投影为可批准候选，暴露诊断）
 *   G  Valid Alias Regression（oldA → canonicalA 全部保持 Phase 1 行为）
 *   H  No Alias Regression（无 alias Page Model 行为完全不变）
 *   I  Evidence Immutability（数量不减少、targetId 不变、字节级不变）
 *
 * 边界：全部使用 os.tmpdir 临时目录；不写 Market alias、不删元素、不改 evidence。
 *
 * 运行：npx tsx scripts/invalid-alias-fail-closed-tests.ts
 */
import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import { aggregateEvidence, buildKnowledgeKey, decidePromotion, type KnowledgeEvidence, type KnowledgeType } from "../src/core/knowledge-promotion-policy.js";
import { collectAllKnowledgeEvidence } from "../src/core/knowledge-evidence-collector.js";
import { buildLocatorTargets, dispatchKnowledgeWritebacks } from "../src/core/knowledge-writeback-dispatcher.js";
import { buildReviewProjection, renderReviewReport } from "../src/core/review-candidate-projection.js";
import { applyApprovedReviews, recordReviewDecision } from "../src/core/knowledge-review-lifecycle.js";
import { runIteration } from "../src/core/modeling-orchestrator.js";
import { pageModelsOf, resolveTargetIdsSafe, type InvalidAliasBlockedEvidence } from "../src/core/element-alias-wiring.js";
import { DEFAULT_MODELING_BUDGETS, type ModelingSession } from "../src/core/modeling-session.js";
import type { ElementAliasEntry, PageModelWithAliases } from "../src/core/page-model-types.js";

let failed = 0;
let passed = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = actual === expected;
  if (ok) passed += 1;
  else failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"} | ${label} | actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
}

function checkTrue(label: string, actual: boolean, detail?: string): void {
  check(label, actual, true);
  if (!actual && detail) console.log(`      detail: ${detail}`);
}

// ============ fixtures ============

const PAGE = "fc.alias_page";
const PROJECT = "invalid_alias_fc";
/** invalid alias 源：存在于 elements[]，alias 链非法。 */
const BAD = "oldA_bad";
/** 合法 alias 源。 */
const GOOD = "oldB_good";
/** 合法 canonical（GOOD 的收敛目标，不参与任何环）。 */
const CANON = "canonicalB";
/** 与 BAD 构成 cycle 的环伙伴（避免把合法 CANON 卷进环）。 */
const CYCLE_PARTNER = "cycle_partner_el";
const LOC = "text:收敛按钮";
const TS = "2026-09-08T00:00:00.000Z";

function aliasEntry(aliasElementId: string, canonicalElementId: string, reason: ElementAliasEntry["reason"] = "SUPERSEDED"): ElementAliasEntry {
  return { aliasElementId, canonicalElementId, reason, createdAt: TS, source: "invalid-alias-fail-closed-tests" };
}

/** cycle：BAD → CYCLE_PARTNER → BAD（CANON 不在环中）。 */
function cycleModel(): PageModelWithAliases {
  return {
    pageId: PAGE,
    elements: [
      { elementId: BAD, semanticName: "坏元素A", controlType: "button" },
      { elementId: CYCLE_PARTNER, semanticName: "环伙伴", controlType: "button" }
    ],
    elementAliases: [aliasEntry(BAD, CYCLE_PARTNER), aliasEntry(CYCLE_PARTNER, BAD)]
  };
}

/** A5 专用：BAD 在环中，CANON 为独立合法元素（controlType 已建模，避免 normalization 派生额外证据）。 */
function mixedBatchModel(): PageModelWithAliases {
  return {
    pageId: PAGE,
    elements: [
      { elementId: BAD, semanticName: "坏元素A", controlType: "button" },
      { elementId: CYCLE_PARTNER, semanticName: "环伙伴", controlType: "button" },
      { elementId: CANON, semanticName: "收敛按钮B", controlType: "button" }
    ],
    elementAliases: [aliasEntry(BAD, CYCLE_PARTNER), aliasEntry(CYCLE_PARTNER, BAD)]
  };
}

/** self alias：BAD → BAD。 */
function selfModel(): PageModelWithAliases {
  return { pageId: PAGE, elements: [{ elementId: BAD, semanticName: "坏元素A" }], elementAliases: [aliasEntry(BAD, BAD)] };
}

/** missing canonical：BAD → GHOST（elements[] 中不存在）。 */
function missingModel(): PageModelWithAliases {
  return { pageId: PAGE, elements: [{ elementId: BAD, semanticName: "坏元素A" }], elementAliases: [aliasEntry(BAD, "ghost_missing_el")] };
}

/** broken chain：BAD → MID → GHOST（链终点不存在）。 */
function brokenChainModel(): PageModelWithAliases {
  return {
    pageId: PAGE,
    elements: [{ elementId: BAD, semanticName: "坏元素A" }, { elementId: "mid_el", semanticName: "中间元素" }],
    elementAliases: [aliasEntry(BAD, "mid_el"), aliasEntry("mid_el", "ghost_missing_el")]
  };
}

/** 合法 alias：GOOD → CANON。 */
function validModel(): PageModelWithAliases {
  return {
    pageId: PAGE,
    elements: [
      { elementId: GOOD, semanticName: "收敛按钮B", controlType: "button" },
      { elementId: CANON, semanticName: "收敛按钮B", controlType: "button" }
    ],
    elementAliases: [aliasEntry(GOOD, CANON, "SAME_SEMANTIC_ELEMENT")]
  };
}

/**
 * 混合生产场景：BAD（invalid cycle alias，且存在于 elements[] 并带历史写回）+ GOOD（合法 alias）。
 * C（dispatcher）/ D（orchestrator）/ E（review lifecycle）共用。
 */
function mixedStore(): PageModelWithAliases {
  return {
    pageId: PAGE,
    elements: [
      {
        elementId: BAD,
        semanticName: "坏元素A",
        controlType: "button",
        locatorCandidates: [{ strategy: "css", value: "css:.old-bad", confidence: 0.9, source: "original" }],
        verificationHistory: [{ promotedAt: "2026-01-01T00:00:00.000Z", policyId: "locator.v1", knowledgeType: "LOCATOR", action: "appended_locator_candidate", evidenceIds: ["ev-hist-1"] }]
      },
      { elementId: CYCLE_PARTNER, semanticName: "环伙伴", controlType: "button" },
      { elementId: GOOD, semanticName: "收敛按钮B", controlType: "button" },
      { elementId: CANON, semanticName: "收敛按钮B", controlType: "button" }
    ],
    elementAliases: [aliasEntry(BAD, CYCLE_PARTNER), aliasEntry(CYCLE_PARTNER, BAD), aliasEntry(GOOD, CANON, "SAME_SEMANTIC_ELEMENT")]
  };
}

function locEvidence(id: string, targetId: string, outcome: "success" | "failure" = "success", observedValue: string = LOC): KnowledgeEvidence {
  return {
    evidenceId: id,
    knowledgeType: "LOCATOR",
    pageId: PAGE,
    targetId,
    sourceType: outcome === "failure" ? "FAILURE_DIAGNOSIS" : "SELF_HEALING",
    sourceRunId: `run_${id}`,
    observation: outcome === "failure"
      ? { reason: "locator failed", failureStage: "locator_failed" }
      : { oldLocator: "css:.old", newLocator: observedValue, fallbackLevel: 1 },
    confidence: "HIGH",
    timestamp: TS,
    observedValue,
    outcome
  };
}

function writeStore(tmp: string, model: PageModelWithAliases): void {
  const dir = path.join(tmp, "storage", "page-models");
  fs.mkdirpSync(dir);
  fs.writeJsonSync(path.join(dir, `${PROJECT}.json`), { schemaVersion: "1", project: PROJECT, models: [model], updatedAt: TS });
}

function writeSinkRecord(tmp: string, type: KnowledgeType, key: string, targetId: string, evidence: KnowledgeEvidence[]): void {
  const dir = path.join(tmp, "storage", "knowledge-evidence", PROJECT, type);
  fs.mkdirpSync(dir);
  fs.writeFileSync(
    path.join(dir, `${key}.json`),
    JSON.stringify({ knowledgeKey: key, knowledgeType: type, pageId: PAGE, targetId, normalizedValue: LOC, evidence }, null, 2) + "\n"
  );
}

/** 2× invalid BAD 修复型 success + 合法 GOOD 2× success + 1× failure（修复型配对完整）。 */
function writeMixedEvidence(tmp: string): void {
  writeSinkRecord(tmp, "LOCATOR", buildKnowledgeKey("LOCATOR", PAGE, BAD, LOC), BAD, [locEvidence("ev-mix-bad-1", BAD), locEvidence("ev-mix-bad-2", BAD)]);
  writeSinkRecord(tmp, "LOCATOR", buildKnowledgeKey("LOCATOR", PAGE, GOOD, LOC), GOOD, [locEvidence("ev-mix-good-1", GOOD), locEvidence("ev-mix-good-2", GOOD), locEvidence("ev-mix-good-3", GOOD, "failure")]);
}

function pageModelsOfOne(model: PageModelWithAliases): Map<string, PageModelWithAliases> {
  return new Map([[PAGE, model]]);
}

function snapshotEvidenceBytes(tmp: string): Map<string, Buffer> {
  const root = path.join(tmp, "storage", "knowledge-evidence");
  const out = new Map<string, Buffer>();
  if (!fs.existsSync(root)) return out;
  for (const projectDir of fs.readdirSync(root)) {
    const projectPath = path.join(root, projectDir);
    if (!fs.statSync(projectPath).isDirectory()) continue;
    for (const typeDir of fs.readdirSync(projectPath)) {
      const typePath = path.join(projectPath, typeDir);
      for (const file of fs.readdirSync(typePath).filter((f) => f.endsWith(".json"))) {
        out.set(path.join(projectDir, typeDir, file), fs.readFileSync(path.join(typePath, file)));
      }
    }
  }
  return out;
}

function checkEvidenceImmutable(tmp: string, before: Map<string, Buffer>, label: string): void {
  const after = snapshotEvidenceBytes(tmp);
  check(`${label} evidence 文件数量不减少`, after.size, before.size);
  let allSame = true;
  for (const [rel, buf] of before) {
    const afterBuf = after.get(rel);
    if (!afterBuf || !afterBuf.equals(buf)) allSame = false;
  }
  checkTrue(`${label} evidence 内容逐字节一致`, allSame);
}

function buildSession(): ModelingSession {
  return {
    sessionId: "ms_invalid_alias_fc",
    project: PROJECT,
    startUrl: "https://example.test",
    status: "MODELING",
    startedAt: TS,
    updatedAt: TS,
    iteration: 1,
    budgets: { ...DEFAULT_MODELING_BUDGETS, maxPlansPerIteration: 2 },
    riskMode: "safe",
    dryRun: false,
    canonicalPageId: PAGE,
    initialCapture: {
      url: "https://example.test",
      normalizedUrl: "https://example.test",
      interactiveElementCount: 2,
      dialogCount: 0,
      tableCount: 0,
      listCount: 0,
      hasCapturedDom: false,
      hasScreenshot: false,
      capturedAt: TS
    },
    coverageSnapshots: [],
    lastGaps: [],
    lastPlans: [],
    executedFingerprints: [],
    evidenceIds: [],
    promotionResults: [],
    progressHistory: [],
    reviewRequests: [],
    blockedPages: [],
    pageSignatures: []
  };
}

function readStore(tmp: string): { models: Array<Record<string, unknown>> } {
  return fs.readJsonSync(path.join(tmp, "storage", "page-models", `${PROJECT}.json`)) as { models: Array<Record<string, unknown>> };
}

function elementOf(store: { models: Array<Record<string, unknown>> }, elementId: string): Record<string, unknown> | undefined {
  return (store.models[0].elements as Array<Record<string, unknown>>).find((e) => String(e.elementId) === elementId);
}

async function run(): Promise<void> {
  const tmpDirs: string[] = [];
  try {
    // ============ A0：resolveTargetIdsSafe 语义基线（invalid alias 无伪 canonical） ============
    const safeResolved = resolveTargetIdsSafe(pageModelsOfOne(cycleModel()).get(PAGE), BAD);
    check("A0 safe 解析：resolved=false", safeResolved.resolved, false);
    check("A0 safe 解析：无伪 canonicalTargetId", safeResolved.canonicalTargetId, undefined);
    checkTrue("A0 safe 解析：resolutionIssue 非空", Boolean(safeResolved.resolutionIssue));
    const safeIdentity = resolveTargetIdsSafe(pageModelsOfOne(mixedBatchModel()).get(PAGE), CANON);
    check("A0 safe 解析：合法 id 仍 resolved=true", safeIdentity.resolved, true);
    check("A0 safe 解析：合法 canonical 正常返回", safeIdentity.canonicalTargetId, CANON);

    // ============ A1-A4：invalid alias 证据不产生正常 promotion candidate ============
    const invalidModels: Array<{ label: string; model: PageModelWithAliases; issuePart: string }> = [
      { label: "cycle", model: cycleModel(), issuePart: "环" },
      { label: "self alias", model: selfModel(), issuePart: "self alias" },
      { label: "missing canonical", model: missingModel(), issuePart: "不存在" },
      { label: "broken chain", model: brokenChainModel(), issuePart: "不存在" }
    ];
    for (const { label, model, issuePart } of invalidModels) {
      const ev = locEvidence(`ev-agg-${label}-1`, BAD);
      const blocked: InvalidAliasBlockedEvidence[] = [];
      const candidates = aggregateEvidence([ev], pageModelsOfOne(model), blocked);
      check(`A [${label}] 不产生正常 promotion candidate`, candidates.size, 0);
      check(`A [${label}] blocked 诊断记录 1 条`, blocked.length, 1);
      check(`A [${label}] blocked.reason=INVALID_ALIAS`, blocked[0]?.reason, "INVALID_ALIAS");
      check(`A [${label}] blocked.evidenceId 保留`, blocked[0]?.evidenceId, ev.evidenceId);
      check(`A [${label}] blocked.targetId 保留 source`, blocked[0]?.targetId, BAD);
      checkTrue(`A [${label}] resolutionIssue 含明确原因`, blocked[0]?.resolutionIssue?.includes(issuePart) === true, blocked[0]?.resolutionIssue);
      // 判别器：无 pageModels 时旧行为会以 source id 形成候选——证明 fail-closed 在起作用。
      const baseline = aggregateEvidence([ev]);
      check(`A [${label}] 判别器：无 pageModels 时旧行为会形成候选`, baseline.size, 1);
    }

    // ============ A5：mixed batch——invalid 被 block，valid 继续正常 candidate，整批不 crash ============
    {
      const badEv = locEvidence("ev-agg-mixed-bad", BAD);
      const goodEv = locEvidence("ev-agg-mixed-good", CANON);
      const blocked: InvalidAliasBlockedEvidence[] = [];
      const candidates = aggregateEvidence([badEv, goodEv], pageModelsOfOne(mixedBatchModel()), blocked);
      check("A5 混合批：仅 1 个候选（合法 evidence）", candidates.size, 1);
      const candidate = [...candidates.values()][0];
      check("A5 混合批：candidate.targetId=canonicalB", candidate.targetId, CANON);
      check("A5 混合批：candidate 只含合法 evidence", candidate.evidence.length, 1);
      check("A5 混合批：successCount 只计合法 evidence", candidate.successCount, 1);
      check("A5 混合批：blocked 含 invalid evidence", blocked.length, 1);
      check("A5 混合批：blocked.evidenceId=bad 证据", blocked[0]?.evidenceId, badEv.evidenceId);
      const decision = decidePromotion(candidate);
      check("A5 混合批：合法 candidate 正常决策（不 crash）", decision.decision, "REVIEW");
    }

    // ============ B：buildLocatorTargets——invalid 全拒入，合法 alias 继续 canonical 聚合 ============
    for (const { label, model } of invalidModels) {
      const blocked: InvalidAliasBlockedEvidence[] = [];
      const targets = buildLocatorTargets(
        [locEvidence(`ev-loc-${label}-1`, BAD), locEvidence(`ev-loc-${label}-2`, BAD)],
        pageModelsOfOne(model),
        blocked
      );
      check(`B [${label}] 不生成 locator target`, targets.length, 0);
      check(`B [${label}] blocked 诊断记录 2 条`, blocked.length, 2);
      check(`B [${label}] 无 target 指向 old source`, targets.some((t) => t.targetId === BAD), false);
    }
    {
      const goodTargets = buildLocatorTargets(
        [locEvidence("ev-loc-good-1", GOOD), locEvidence("ev-loc-good-2", GOOD)],
        pageModelsOfOne(validModel())
      );
      check("B 合法 alias：1 个 canonical target", goodTargets.length, 1);
      check("B 合法 alias：targetId=canonicalB", goodTargets[0]?.targetId, CANON);
      check("B 合法 alias：successCount 跨 alias 合并=2", goodTargets[0]?.successCount, 2);
    }

    // ============ C：Dispatcher——oldA 在 elements[] 中且 alias 非法（最关键的回归场景） ============
    {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "alias-fc-dispatcher-"));
      tmpDirs.push(tmp);
      writeStore(tmp, mixedStore());
      writeMixedEvidence(tmp);
      const evidenceBefore = snapshotEvidenceBytes(tmp);
      const badElementBefore = JSON.stringify(elementOf(readStore(tmp), BAD));

      const result = await dispatchKnowledgeWritebacks({ rootDir: tmp, project: PROJECT, caps: { locator: 5 } });

      // invalid 拒入审计（聚合 + LOCATOR target 两路径去重后仍包含 bad 证据）
      checkTrue("C invalidAliasBlocked 包含 bad 证据", result.invalidAliasBlocked.some((b) => b.evidenceId === "ev-mix-bad-1" || b.evidenceId === "ev-mix-bad-2"), JSON.stringify(result.invalidAliasBlocked));
      check("C locatorTargets 不含 bad 伪 target", result.locatorTargets.some((t) => t.targetId === BAD), false);
      // oldA 完全不变
      const storeAfter = readStore(tmp);
      check("C oldA locatorCandidates 字节级不变", JSON.stringify(elementOf(storeAfter, BAD)), badElementBefore);
      check("C oldA verificationHistory 不变", (elementOf(storeAfter, BAD)?.verificationHistory as Array<Record<string, unknown>> | undefined)?.length, 1);
      checkTrue("C 无任何 plan/applied 写 oldA", ![...result.planned, ...result.applied].some((a) => a.elementId === BAD || a.targetId === BAD), JSON.stringify([...result.planned, ...result.applied]));
      // 其他合法 target 继续处理
      checkTrue("C 合法 canonicalB 被 promotion", result.applied.some((a) => a.action === "append_locator_candidate" && a.elementId === CANON), JSON.stringify(result.applied));
      const canonCandidates = elementOf(storeAfter, CANON)?.locatorCandidates as Array<Record<string, unknown>> | undefined;
      check("C canonicalB 追加 locator 候选", canonCandidates?.[0]?.value, LOC);
      check("C locatorTargets 含合法 canonicalB target", result.locatorTargets.some((t) => t.targetId === CANON), true);
      checkEvidenceImmutable(tmp, evidenceBefore, "C");
      const afterEvidence = await collectAllKnowledgeEvidence(tmp, PROJECT);
      checkTrue("C evidence.targetId 保持原始 source", afterEvidence.evidenceList.every((e) => e.targetId === BAD || e.targetId === GOOD), "");
    }

    // ============ D：Modeling Orchestrator——真实 production modeling path ============
    {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "alias-fc-orchestrator-"));
      tmpDirs.push(tmp);
      writeStore(tmp, mixedStore());
      writeMixedEvidence(tmp);
      const evidenceBefore = snapshotEvidenceBytes(tmp);
      const badElementBefore = JSON.stringify(elementOf(readStore(tmp), BAD));

      const iteration = await runIteration(tmp, PROJECT, "test", buildSession(), undefined, "https://example.test");
      const locResults = iteration.promotionResults.filter((r) => r.knowledgeType === "LOCATOR");
      checkTrue("D promotionResults 含 blocked_invalid_alias 诊断", iteration.promotionResults.some((r) => r.action === "blocked_invalid_alias" && r.targetId === BAD), JSON.stringify(iteration.promotionResults));
      checkTrue("D 无 LOCATOR promotion 到 oldA", !locResults.some((r) => r.ok && r.targetId === BAD), JSON.stringify(locResults));
      const storeAfter = readStore(tmp);
      check("D oldA 元素未修改（含 locatorCandidates/verificationHistory）", JSON.stringify(elementOf(storeAfter, BAD)), badElementBefore);
      const canonCandidates = elementOf(storeAfter, CANON)?.locatorCandidates as Array<Record<string, unknown>> | undefined;
      check("D canonicalB 追加 locator 候选", canonCandidates?.[0]?.value, LOC);
      check("D canonical 不伪造（无 BAD 伪 canonical promotion）", locResults.some((r) => r.ok && r.targetId === BAD), false);
      checkEvidenceImmutable(tmp, evidenceBefore, "D");
    }

    // ============ E：Review Lifecycle——human APPROVED 也不能绕过 alias integrity ============
    {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "alias-fc-review-"));
      tmpDirs.push(tmp);
      writeStore(tmp, mixedStore());
      writeMixedEvidence(tmp);
      const evidenceBefore = snapshotEvidenceBytes(tmp);
      const badElementBefore = JSON.stringify(elementOf(readStore(tmp), BAD));
      await recordReviewDecision(tmp, PROJECT, {
        knowledgeKey: buildKnowledgeKey("LOCATOR", PAGE, BAD, LOC),
        knowledgeType: "LOCATOR",
        pageId: PAGE,
        targetId: BAD, // 人工批准的是来源于 invalid alias 的 locator 候选
        normalizedValue: LOC,
        decision: "APPROVED",
        decidedBy: "human"
      });
      const result = await applyApprovedReviews(tmp, PROJECT);
      checkTrue("E blocked 含 INVALID_ALIAS 诊断", result.blocked.some((b) => b.reason.includes("INVALID_ALIAS")), JSON.stringify(result.blocked));
      checkTrue("E 无任何 append_locator_candidate 写回", !result.applied.some((a) => a.action === "append_locator_candidate"), JSON.stringify(result.applied));
      const storeAfter = readStore(tmp);
      check("E oldA 元素未修改", JSON.stringify(elementOf(storeAfter, BAD)), badElementBefore);
      checkEvidenceImmutable(tmp, evidenceBefore, "E");
    }

    // ============ F：Review Projection——invalid alias 不投影为可批准候选，暴露诊断 ============
    {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "alias-fc-projection-"));
      tmpDirs.push(tmp);
      writeStore(tmp, mixedStore());
      writeSinkRecord(tmp, "LOCATOR", buildKnowledgeKey("LOCATOR", PAGE, BAD, LOC), BAD, [locEvidence("ev-proj-bad", BAD)]);
      writeSinkRecord(tmp, "LOCATOR", buildKnowledgeKey("LOCATOR", PAGE, GOOD, LOC), GOOD, [locEvidence("ev-proj-good", GOOD)]);
      const projection = await buildReviewProjection(tmp, PROJECT);
      check("F items 不含 bad 伪候选", projection.items.some((i) => i.targetId === BAD), false);
      check("F items 含合法候选", projection.items.some((i) => i.canonicalTargetId === CANON), true);
      check("F invalidAliasBlocked 诊断 1 条", projection.invalidAliasBlocked.length, 1);
      check("F blocked.evidenceId=ev-proj-bad", projection.invalidAliasBlocked[0]?.evidenceId, "ev-proj-bad");
      check("F blocked.reason=INVALID_ALIAS", projection.invalidAliasBlocked[0]?.reason, "INVALID_ALIAS");
      const report = renderReviewReport(projection);
      checkTrue("F render 暴露 Invalid Alias Blocked 区块", report.includes("Invalid Alias Blocked"), "");
      checkTrue("F render 含 resolutionIssue", report.includes(projection.invalidAliasBlocked[0]?.resolutionIssue ?? "@@missing@@"), "");
    }

    // ============ G：Valid Alias Regression——合法 alias 全部保持 Phase 1 行为 ============
    {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "alias-fc-valid-"));
      tmpDirs.push(tmp);
      writeStore(tmp, validModel());
      writeSinkRecord(tmp, "LOCATOR", buildKnowledgeKey("LOCATOR", PAGE, GOOD, LOC), GOOD, [locEvidence("ev-g1", GOOD), locEvidence("ev-g2", GOOD), locEvidence("ev-g4", GOOD, "failure")]);
      writeSinkRecord(tmp, "LOCATOR", buildKnowledgeKey("LOCATOR", PAGE, CANON, LOC), CANON, [locEvidence("ev-g3", CANON)]);
      const collected = await collectAllKnowledgeEvidence(tmp, PROJECT);
      const pageModels = pageModelsOf({ models: [validModel()] });
      const candidates = aggregateEvidence(collected.evidenceList, pageModels);
      check("G 聚合 1 个 canonical candidate", candidates.size, 1);
      check("G canonicalTargetId=canonicalB", [...candidates.values()][0]?.canonicalTargetId, CANON);
      check("G 4 条证据全部合并", [...candidates.values()][0]?.evidence.length, 4);
      const targets = buildLocatorTargets(collected.evidenceList, pageModels);
      check("G buildLocatorTargets 1 个 canonical target", targets.length, 1);
      check("G targetId=canonicalB", targets[0]?.targetId, CANON);
      check("G successCount 跨 alias 合并=3", targets[0]?.successCount, 3);
      check("G provenance 保留 sourceTargetIds", JSON.stringify(targets[0]?.sourceTargetIds), JSON.stringify([GOOD, GOOD, CANON]));
      const iteration = await runIteration(tmp, PROJECT, "test", buildSession(), undefined, "https://example.test");
      const locResults = iteration.promotionResults.filter((r) => r.knowledgeType === "LOCATOR" && r.action !== "blocked_invalid_alias");
      checkTrue("G promotion ok", locResults.some((r) => r.ok), JSON.stringify(locResults));
      const storeAfter = readStore(tmp);
      check("G canonicalB 追加 locator 候选", (elementOf(storeAfter, CANON)?.locatorCandidates as Array<Record<string, unknown>> | undefined)?.[0]?.value, LOC);
      check("G oldB 未追加 locator", elementOf(storeAfter, GOOD)?.locatorCandidates, undefined);
      check("G 无 blocked 误报", iteration.promotionResults.some((r) => r.action === "blocked_invalid_alias"), false);
    }

    // ============ H：No Alias Regression——无 alias Page Model 行为完全不变 ============
    {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "alias-fc-plain-"));
      tmpDirs.push(tmp);
      const model: PageModelWithAliases = { pageId: PAGE, elements: [{ elementId: "converge_btn", semanticName: "收敛按钮" }] };
      writeStore(tmp, model);
      writeSinkRecord(tmp, "LOCATOR", buildKnowledgeKey("LOCATOR", PAGE, "converge_btn", LOC), "converge_btn", [locEvidence("ev-h1", "converge_btn"), locEvidence("ev-h2", "converge_btn"), locEvidence("ev-h3", "converge_btn", "failure")]);
      const collected = await collectAllKnowledgeEvidence(tmp, PROJECT);
      const pageModels = pageModelsOf({ models: [model] });
      const withModels = aggregateEvidence(collected.evidenceList, pageModels);
      const without = aggregateEvidence(collected.evidenceList);
      check("H 有/无 pageModels 候选数一致", withModels.size, without.size);
      check("H knowledgeKey 一致", [...withModels.keys()][0], [...without.keys()][0]);
      check("H canonicalTargetId=原 id（恒等解析）", [...withModels.values()][0]?.canonicalTargetId, "converge_btn");
      const iteration = await runIteration(tmp, PROJECT, "test", buildSession(), undefined, "https://example.test");
      const locResults = iteration.promotionResults.filter((r) => r.knowledgeType === "LOCATOR" && r.action !== "blocked_invalid_alias");
      checkTrue("H promotion ok", locResults.some((r) => r.ok), JSON.stringify(locResults));
      const storeAfter = readStore(tmp);
      check("H locator 写入原元素", (elementOf(storeAfter, "converge_btn")?.locatorCandidates as Array<Record<string, unknown>> | undefined)?.[0]?.value, LOC);
      check("H 未产生 elementAliases", storeAfter.models[0].elementAliases, undefined);
      check("H 无 blocked 误报", iteration.promotionResults.some((r) => r.action === "blocked_invalid_alias"), false);
    }

    // ============ I：Evidence Immutability（独立复查：数量 / targetId / 字节） ============
    {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "alias-fc-immut-"));
      tmpDirs.push(tmp);
      writeStore(tmp, mixedStore());
      writeMixedEvidence(tmp);
      const before = snapshotEvidenceBytes(tmp);
      check("I 前置：4 条 LOCATOR evidence 文件", before.size, 2); // 2 个 record 文件（bad/good 各一）
      const blocked: InvalidAliasBlockedEvidence[] = [];
      const collected = await collectAllKnowledgeEvidence(tmp, PROJECT);
      aggregateEvidence(collected.evidenceList, pageModelsOf({ models: [mixedStore()] }), blocked);
      check("I invalid alias 流程执行后：文件数量不减少", snapshotEvidenceBytes(tmp).size, before.size);
      const afterEvidence = await collectAllKnowledgeEvidence(tmp, PROJECT);
      check("I evidence.targetId 不变", JSON.stringify(afterEvidence.evidenceList.map((e) => e.targetId).sort()), JSON.stringify([BAD, BAD, GOOD, GOOD, GOOD]));
      checkEvidenceImmutable(tmp, before, "I");
    }
  } finally {
    for (const dir of tmpDirs) fs.removeSync(dir);
  }
}

run().then(() => {
  console.log(`\n===== Invalid Alias Fail-Closed Tests: ${passed} passed, ${failed} failed =====`);
  process.exitCode = failed > 0 ? 1 : 0;
}).catch((error) => {
  console.error("测试执行异常:", error);
  process.exitCode = 1;
});
