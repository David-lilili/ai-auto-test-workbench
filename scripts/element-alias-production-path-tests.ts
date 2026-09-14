/**
 * Element Alias Production Path Closure — targeted tests（P16.7 Phase 1）。
 *
 * 覆盖三条 production path（与 dispatchKnowledgeWritebacks 同口径 alias-aware）：
 *   A. modeling-orchestrator     —— aggregateEvidence/buildLocatorTargets 收 pageModels；
 *                                  LOCATOR branch 最终 element identity 一律 canonical。
 *   B. knowledge-review-lifecycle—— 同上；人工 APPROVED LOCATOR 写 canonical 元素。
 *   C. review-candidate-projection—— alias 聚合 → 单一 canonical review candidate。
 *   D. 无 alias 回归 + E. evidence 不可变（字节级）。
 *
 * 边界：全部使用 os.tmpdir 临时目录；不写 Market alias、不删元素、不改 evidence。
 *
 * 运行：npx tsx scripts/element-alias-production-path-tests.ts
 */
import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import { aggregateEvidence, buildKnowledgeKey, type KnowledgeEvidence, type KnowledgeType } from "../src/core/knowledge-promotion-policy.js";
import { collectAllKnowledgeEvidence } from "../src/core/knowledge-evidence-collector.js";
import { buildLocatorTargets } from "../src/core/knowledge-writeback-dispatcher.js";
import { buildReviewProjection } from "../src/core/review-candidate-projection.js";
import { applyApprovedReviews, recordReviewDecision } from "../src/core/knowledge-review-lifecycle.js";
import { runIteration } from "../src/core/modeling-orchestrator.js";
import { pageModelsOf } from "../src/core/element-alias-wiring.js";
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

const PAGE = "prod.alias_page";
const PROJECT = "alias_prod_path";
const OLD_A = "oldA_el";
const CANON = "canonicalA_el";
const LOCATOR_VALUE = "text:收敛按钮";
const TS = "2026-09-07T00:00:00.000Z";

const ALIAS: ElementAliasEntry = {
  aliasElementId: OLD_A,
  canonicalElementId: CANON,
  reason: "SAME_SEMANTIC_ELEMENT",
  createdAt: "2026-09-08T00:00:00.000Z",
  source: "element-alias-production-path-tests"
};

function aliasModel(): PageModelWithAliases {
  return {
    pageId: PAGE,
    // oldA 刻意放在数组首位：验证 canonical 定位不依赖元素顺序。
    elements: [
      { elementId: OLD_A, semanticName: "收敛按钮", controlType: "button", status: "execution_verified" },
      { elementId: CANON, semanticName: "收敛按钮", controlType: "button", status: "execution_verified" }
    ],
    elementAliases: [ALIAS]
  };
}

function plainModel(): PageModelWithAliases {
  return {
    pageId: PAGE,
    elements: [{ elementId: "converge_btn", semanticName: "收敛按钮", controlType: "button", status: "execution_verified" }]
  };
}

function locEvidence(id: string, targetId: string, outcome: "success" | "failure"): KnowledgeEvidence {
  return {
    evidenceId: id,
    knowledgeType: "LOCATOR",
    pageId: PAGE,
    targetId,
    sourceType: outcome === "failure" ? "FAILURE_DIAGNOSIS" : "SELF_HEALING",
    sourceRunId: `run_${id}`,
    observation: outcome === "failure"
      ? { reason: "locator failed", failureStage: "locator_failed" }
      : { oldLocator: "css:.old", newLocator: LOCATOR_VALUE, fallbackLevel: 1 },
    confidence: "HIGH",
    timestamp: TS,
    observedValue: LOCATOR_VALUE,
    outcome
  };
}

function writeStore(tmp: string, model: PageModelWithAliases): string {
  const dir = path.join(tmp, "storage", "page-models");
  fs.mkdirpSync(dir);
  const storePath = path.join(dir, `${PROJECT}.json`);
  fs.writeJsonSync(storePath, { schemaVersion: "1", project: PROJECT, models: [model], updatedAt: TS });
  return storePath;
}

function writeSinkRecord(tmp: string, type: KnowledgeType, key: string, targetId: string, evidence: KnowledgeEvidence[]): void {
  const dir = path.join(tmp, "storage", "knowledge-evidence", PROJECT, type);
  fs.mkdirpSync(dir);
  fs.writeFileSync(
    path.join(dir, `${key}.json`),
    JSON.stringify({ knowledgeKey: key, knowledgeType: type, pageId: PAGE, targetId, normalizedValue: LOCATOR_VALUE, evidence }, null, 2) + "\n"
  );
}

function writeLocatorEvidence(tmp: string): { oldKey: string; canonKey: string } {
  const oldKey = buildKnowledgeKey("LOCATOR", PAGE, OLD_A, LOCATOR_VALUE);
  const canonKey = buildKnowledgeKey("LOCATOR", PAGE, CANON, LOCATOR_VALUE);
  writeSinkRecord(tmp, "LOCATOR", oldKey, OLD_A, [locEvidence("ev-a1", OLD_A, "success"), locEvidence("ev-a2", OLD_A, "success"), locEvidence("ev-a3", OLD_A, "failure")]);
  writeSinkRecord(tmp, "LOCATOR", canonKey, CANON, [locEvidence("ev-a4", CANON, "success"), locEvidence("ev-a5", CANON, "success")]);
  return { oldKey, canonKey };
}

function snapshotEvidenceBytes(tmp: string): Map<string, Buffer> {
  const root = path.join(tmp, "storage", "knowledge-evidence");
  const out = new Map<string, Buffer>();
  if (!fs.existsSync(root)) return out;
  // 布局：knowledge-evidence/<project>/<knowledgeType>/<knowledgeKey>.json
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
  check(`${label} evidence 文件字节级不变`, after.size, before.size);
  let allSame = true;
  for (const [rel, buf] of before) {
    const afterBuf = after.get(rel);
    if (!afterBuf || !afterBuf.equals(buf)) allSame = false;
  }
  checkTrue(`${label} evidence 内容逐字节一致`, allSame);
}

function buildSession(): ModelingSession {
  return {
    sessionId: "ms_prod_path_test",
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
    // ============ A1/A2 + E1：modeling-orchestrator 真实聚合 + LOCATOR canonical writeback ============
    {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "alias-prod-modeling-"));
      tmpDirs.push(tmp);
      const model = aliasModel();
      writeStore(tmp, model);
      writeLocatorEvidence(tmp);
      const evidenceBefore = snapshotEvidenceBytes(tmp);

      // A1：aggregateEvidence 经 pageModels 把 oldA + canonicalA 证据合并为单一 canonical candidate。
      const collected = await collectAllKnowledgeEvidence(tmp, PROJECT);
      const pageModels = pageModelsOf({ models: [model] });
      const candidates = aggregateEvidence(collected.evidenceList, pageModels);
      check("A1 建模聚合：1 个 canonical candidate", candidates.size, 1);
      const candidate = [...candidates.values()][0];
      check("A1 建模聚合：canonicalTargetId=canonicalA", candidate.canonicalTargetId, CANON);
      check("A1 建模聚合：5 条证据全部合并", candidate.evidence.length, 5);
      check("A1 建模聚合：successCount 跨 alias 合并=4", candidate.successCount, 4);
      const targets = buildLocatorTargets(collected.evidenceList, pageModels);
      check("A1 建模聚合：buildLocatorTargets 1 个 target", targets.length, 1);
      check("A1 建模聚合：target 为 canonical", targets[0]?.targetId, CANON);

      // A2：真实 runIteration 路径——LOCATOR 只晋升一次且写入 canonicalA。
      const iteration = await runIteration(tmp, PROJECT, "test", buildSession(), undefined, "https://example.test");
      const locResults = iteration.promotionResults.filter((r) => r.knowledgeType === "LOCATOR");
      check("A2 建模 promotion：仅 1 条 LOCATOR promotion", locResults.length, 1);
      checkTrue("A2 建模 promotion：ok", locResults[0]?.ok === true, JSON.stringify(locResults[0]));
      checkTrue("A2 建模 promotion：targetId 保留 source（provenance）", locResults[0] ? [OLD_A, CANON].includes(locResults[0].targetId) : false);

      const storeAfter = readStore(tmp);
      const canonEl = elementOf(storeAfter, CANON);
      const oldEl = elementOf(storeAfter, OLD_A);
      const canonCandidates = Array.isArray(canonEl?.locatorCandidates) ? (canonEl!.locatorCandidates as Array<Record<string, unknown>>) : [];
      check("A2 canonicalA 追加 locator 候选", canonCandidates[0]?.value, LOCATOR_VALUE);
      check("A2 oldA 未追加 locator", oldEl?.locatorCandidates, undefined);
      check("A2 oldA 无 verificationHistory", oldEl?.verificationHistory, undefined);
      checkEvidenceImmutable(tmp, evidenceBefore, "A2");
    }

    // ============ B1：review lifecycle 聚合（人工批准 canonical key 能找到合并候选） ============
    {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "alias-prod-review-ct-"));
      tmpDirs.push(tmp);
      // CONTROL_TYPE：两个 unknown 元素（role=button）→ 归一化证据 oldA + canonicalA，
      // 经 pageModels 合并为同一 canonical candidate；人工批准 canonical-based knowledgeKey。
      const model: PageModelWithAliases = {
        pageId: PAGE,
        elements: [
          { elementId: OLD_A, semanticName: "收敛按钮", controlType: "unknown", role: "button", status: "execution_verified" },
          { elementId: CANON, semanticName: "收敛按钮", controlType: "unknown", role: "button", status: "execution_verified" }
        ],
        elementAliases: [ALIAS]
      };
      writeStore(tmp, model);
      await recordReviewDecision(tmp, PROJECT, {
        knowledgeKey: buildKnowledgeKey("CONTROL_TYPE", PAGE, CANON, "button"),
        knowledgeType: "CONTROL_TYPE",
        pageId: PAGE,
        targetId: OLD_A,
        normalizedValue: "button",
        decision: "APPROVED",
        decidedBy: "human"
      });
      const result = await applyApprovedReviews(tmp, PROJECT);
      check("B1 review 批准：fill_control_type 已应用", result.applied[0]?.action, "fill_control_type");
      checkTrue("B1 review 批准：ok", result.applied[0]?.ok === true);
      check("B1 review 批准：blocked 为空", result.blocked.length, 0);
      const storeAfter = readStore(tmp);
      check("B1 canonicalA controlType=button", elementOf(storeAfter, CANON)?.controlType, "button");
      check("B1 oldA controlType 保持 unknown（未改写）", elementOf(storeAfter, OLD_A)?.controlType, "unknown");
    }

    // ============ B2 + E1：review APPROVED LOCATOR → 写 canonicalA，oldA 不动 ============
    {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "alias-prod-review-loc-"));
      tmpDirs.push(tmp);
      writeStore(tmp, aliasModel());
      writeLocatorEvidence(tmp);
      const evidenceBefore = snapshotEvidenceBytes(tmp);
      await recordReviewDecision(tmp, PROJECT, {
        knowledgeKey: buildKnowledgeKey("LOCATOR", PAGE, CANON, LOCATOR_VALUE),
        knowledgeType: "LOCATOR",
        pageId: PAGE,
        targetId: OLD_A, // 人工批准的是 oldA 来源的 locator 候选
        normalizedValue: LOCATOR_VALUE,
        decision: "APPROVED",
        decidedBy: "human"
      });
      const result = await applyApprovedReviews(tmp, PROJECT);
      check("B2 review LOCATOR：appended_locator_candidate 已应用", result.applied[0]?.action, "appended_locator_candidate");
      checkTrue("B2 review LOCATOR：ok", result.applied[0]?.ok === true);
      check("B2 review LOCATOR：targetId 保留 source（provenance）", result.applied[0]?.targetId, OLD_A);
      const storeAfter = readStore(tmp);
      const canonCandidates = elementOf(storeAfter, CANON)?.locatorCandidates as Array<Record<string, unknown>> | undefined;
      check("B2 canonicalA 追加 locator 候选", canonCandidates?.[0]?.value, LOCATOR_VALUE);
      check("B2 oldA 未追加 locator", elementOf(storeAfter, OLD_A)?.locatorCandidates, undefined);
      checkEvidenceImmutable(tmp, evidenceBefore, "B2");
    }

    // ============ C1：review projection 单一 canonical candidate ============
    {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "alias-prod-proj-"));
      tmpDirs.push(tmp);
      writeStore(tmp, aliasModel());
      // 无 failure 证据 → LOCATOR 恒 REVIEW；oldA + canonicalA 各一条成功证据。
      const oldKey = buildKnowledgeKey("LOCATOR", PAGE, OLD_A, LOCATOR_VALUE);
      const canonKey = buildKnowledgeKey("LOCATOR", PAGE, CANON, LOCATOR_VALUE);
      writeSinkRecord(tmp, "LOCATOR", oldKey, OLD_A, [locEvidence("ev-c1", OLD_A, "success")]);
      writeSinkRecord(tmp, "LOCATOR", canonKey, CANON, [locEvidence("ev-c2", CANON, "success")]);

      // 判别器：无 pageModels 时是 2 个独立候选（旧行为），有 pageModels 时 1 个 canonical 候选。
      const collected = await collectAllKnowledgeEvidence(tmp, PROJECT);
      const rawCandidates = aggregateEvidence(collected.evidenceList);
      check("C1 判别器：无 pageModels → 2 个独立候选", rawCandidates.size, 2);

      const projection = await buildReviewProjection(tmp, PROJECT);
      check("C1 projection 仅 1 条 review candidate", projection.items.length, 1);
      const item = projection.items[0];
      check("C1 candidate knowledgeType=LOCATOR", item?.knowledgeType, "LOCATOR");
      check("C1 candidate canonicalTargetId=canonicalA", item?.canonicalTargetId, CANON);
      check("C1 candidate knowledgeKey 为 canonical 聚合键", item?.knowledgeKey, canonKey);
      check("C1 candidate evidence 合并 2 条", item?.evidenceSummary.total, 2);
      checkTrue("C1 targetId 保留 source（provenance）", item ? [OLD_A, CANON].includes(item.targetId) : false);
    }

    // ============ D1：无 elementAliases → 行为与修改前一致 ============
    {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "alias-prod-plain-"));
      tmpDirs.push(tmp);
      const model = plainModel();
      writeStore(tmp, model);
      // semantic-name 风格 targetId（真实生产数据形态），2 success + 1 failure。
      const key = buildKnowledgeKey("LOCATOR", PAGE, "收敛按钮", LOCATOR_VALUE);
      writeSinkRecord(tmp, "LOCATOR", key, "收敛按钮", [locEvidence("ev-d1", "收敛按钮", "success"), locEvidence("ev-d2", "收敛按钮", "success"), locEvidence("ev-d3", "收敛按钮", "failure")]);

      const collected = await collectAllKnowledgeEvidence(tmp, PROJECT);
      const pageModels = pageModelsOf({ models: [model] });
      const withModels = aggregateEvidence(collected.evidenceList, pageModels);
      const without = aggregateEvidence(collected.evidenceList);
      check("D1 聚合不变量：有/无 pageModels 候选数一致", withModels.size, without.size);
      check("D1 聚合不变量：knowledgeKey 一致", [...withModels.keys()][0], [...without.keys()][0]);

      const iteration = await runIteration(tmp, PROJECT, "test", buildSession(), undefined, "https://example.test");
      const locResults = iteration.promotionResults.filter((r) => r.knowledgeType === "LOCATOR");
      check("D1 promotion：1 条 LOCATOR promotion", locResults.length, 1);
      checkTrue("D1 promotion：ok", locResults[0]?.ok === true, JSON.stringify(locResults[0]));
      const storeAfter = readStore(tmp);
      check("D1 locator 写入原元素（converge_btn）", (elementOf(storeAfter, "converge_btn")?.locatorCandidates as Array<Record<string, unknown>> | undefined)?.[0]?.value, LOCATOR_VALUE);
      check("D1 未产生 elementAliases", storeAfter.models[0].elementAliases, undefined);
    }
  } finally {
    for (const dir of tmpDirs) fs.removeSync(dir);
  }
}

run().then(() => {
  console.log(`\n===== Element Alias Production Path Tests: ${passed} passed, ${failed} failed =====`);
  process.exitCode = failed > 0 ? 1 : 0;
}).catch((error) => {
  console.error("测试执行异常:", error);
  process.exitCode = 1;
});
