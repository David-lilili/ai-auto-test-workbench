/**
 * Element Alias Wiring — targeted tests（P16.7）。
 *
 * 只测 wiring 接入：alias-aware 证据聚合 / dispatcher 写回 / evidence 不可变 /
 * 无 alias 恒等 / 异常 alias 拒绝 / sourceTargetId provenance。
 *
 * 边界：不写 Market alias、不删 element、不改真实 Model / Evidence 存储
 * （page-model store 与 evidence 文件全部使用 os.tmpdir 临时目录）。
 *
 * 运行：npx tsx scripts/element-alias-wiring-tests.ts
 */
import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import { ElementAliasError, resolveCanonicalElementId, validateElementAliases } from "../src/core/element-alias-resolver.js";
import { collectEvidenceForCanonical, resolveTargetIds } from "../src/core/element-alias-wiring.js";
import { aggregateEvidence, buildKnowledgeKey, type KnowledgeCandidate, type KnowledgeEvidence, type KnowledgeType } from "../src/core/knowledge-promotion-policy.js";
import { buildLocatorTargets, writeInteraction } from "../src/core/knowledge-writeback-dispatcher.js";
import type { ElementAliasEntry, PageModelWithAliases } from "../src/core/page-model-types.js";

let failed = 0;
let passed = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = actual === expected;
  if (ok) passed += 1;
  else failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"} | ${label} | actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
}

function checkThrows(label: string, fn: () => unknown, messagePart?: string): void {
  try {
    fn();
    failed += 1;
    console.log(`FAIL | ${label} | 未抛错（应拒绝）`);
  } catch (error) {
    const isAliasError = error instanceof ElementAliasError;
    const msgOk = messagePart === undefined || String(error instanceof Error ? error.message : String(error)).includes(messagePart);
    if (isAliasError && msgOk) passed += 1;
    else failed += 1;
    console.log(`${isAliasError && msgOk ? "PASS" : "FAIL"} | ${label} | ${error instanceof Error ? error.message : String(error)}`);
  }
}

// ============ fixtures ============

const OLD_A = "old_element_a";
const OLD_B = "old_element_b";
const CANON = "canonical_element";
const PAGE = "alias_wiring_test_page";
const PROJECT = "alias_wiring_test";
const OBSERVED = "interact_ok";

const TWO_ALIASES: ElementAliasEntry[] = [
  { aliasElementId: OLD_A, canonicalElementId: CANON, reason: "SAME_SEMANTIC_ELEMENT", createdAt: "2026-09-08T00:00:00.000Z", source: "alias-wiring-tests" },
  { aliasElementId: OLD_B, canonicalElementId: CANON, reason: "SUPERSEDED", createdAt: "2026-09-08T00:00:00.000Z", source: "alias-wiring-tests" }
];

function modelWithAliases(): PageModelWithAliases {
  return {
    pageId: PAGE,
    elements: [
      { elementId: OLD_A, semanticName: "旧元素 A" },
      { elementId: OLD_B, semanticName: "旧元素 B" },
      { elementId: CANON, semanticName: "收敛元素" }
    ],
    elementAliases: TWO_ALIASES
  };
}

function plainModel(): PageModelWithAliases {
  return { pageId: PAGE, elements: [{ elementId: OLD_A, semanticName: "旧元素 A" }, { elementId: CANON, semanticName: "收敛元素" }] };
}

function makeEvidence(targetId: string, id: string, kind: KnowledgeType = "INTERACTION", observedValue = OBSERVED): KnowledgeEvidence {
  return {
    evidenceId: id,
    knowledgeType: kind,
    pageId: PAGE,
    targetId,
    sourceType: kind === "LOCATOR" ? "SELF_HEALING" : "DSL_EXECUTION",
    observation: kind === "LOCATOR" ? { oldLocator: "css:.old", fallbackLevel: 1 } : {},
    confidence: "HIGH",
    timestamp: "2026-09-08T00:00:00.000Z",
    observedValue,
    outcome: "success"
  };
}

function candidateFor(targetId: string, evidenceList: KnowledgeEvidence[]): KnowledgeCandidate {
  return {
    knowledgeKey: buildKnowledgeKey("INTERACTION", PAGE, targetId, OBSERVED),
    knowledgeType: "INTERACTION",
    pageId: PAGE,
    targetId,
    normalizedValue: OBSERVED,
    evidence: evidenceList,
    successCount: evidenceList.filter((e) => e.outcome === "success").length,
    failureCount: 0,
    contradictionCount: 0,
    firstObservedAt: "2026-09-08T00:00:00.000Z",
    lastObservedAt: "2026-09-08T00:00:00.000Z",
    pageSignatures: [],
    freshness: "FRESH",
    evidenceConfidence: "HIGH"
  };
}

function writeModelStore(tmp: string, model: PageModelWithAliases): string {
  const storeDir = path.join(tmp, "storage", "page-models");
  fs.mkdirpSync(storeDir);
  const storePath = path.join(storeDir, `${PROJECT}.json`);
  fs.writeJsonSync(storePath, { schemaVersion: "1", project: PROJECT, models: [model], updatedAt: "2026-09-08T00:00:00.000Z" });
  return storePath;
}

async function run(): Promise<void> {
  const model = modelWithAliases();
  const tmpDirs: string[] = [];
  try {
    // ============ A：oldA evidence → 查询 canonicalA → FOUND ============
    const foundA = collectEvidenceForCanonical(model, [makeEvidence(OLD_A, "ev-a"), makeEvidence(CANON, "ev-a2")], CANON);
    check("A1 查询 canonicalA 找到 oldA evidence（2 组）", foundA.length, 2);

    // ============ B：oldA + oldB + canonicalA 三种 evidence 全部聚合 ============
    const foundB = collectEvidenceForCanonical(model, [makeEvidence(OLD_A, "ev-b1"), makeEvidence(OLD_B, "ev-b2"), makeEvidence(CANON, "ev-b3")], CANON);
    check("B1 三种 targetId evidence 全部聚合到 canonicalA", foundB.length, 3);

    // policy 聚合路径：pageModels 提供时旧 id 与 canonical 合并为单一 candidate
    const merged = aggregateEvidence([makeEvidence(OLD_A, "ev-b1"), makeEvidence(OLD_B, "ev-b2"), makeEvidence(CANON, "ev-b3")], new Map([[PAGE, model]]));
    check("B2 aggregateEvidence 合并为 1 candidate", merged.size, 1);
    const mergedCandidate = [...merged.values()][0];
    check("B3 candidate.targetId 保留首个 source", mergedCandidate.targetId, OLD_A);
    check("B4 candidate.canonicalTargetId=canonicalA", mergedCandidate.canonicalTargetId, CANON);
    check("B5 三组 evidence 全部进入 candidate", mergedCandidate.evidence.length, 3);

    // dispatcher 聚合路径：LOCATOR 按 canonical 归组计数
    const locTargets = buildLocatorTargets(
      [makeEvidence(OLD_A, "ev-loc-a", "LOCATOR", "text:收敛按钮"), makeEvidence(OLD_B, "ev-loc-b", "LOCATOR", "text:收敛按钮")],
      new Map([[PAGE, model]])
    );
    check("B6 buildLocatorTargets 聚合为 1 target", locTargets.length, 1);
    check("B7 成功计数跨 alias 合并", locTargets[0]?.successCount, 2);
    check("B8 targetId 为 canonical", locTargets[0]?.targetId, CANON);

    // ============ C：Evidence.targetId 前后字节级不变 ============
    const tmpC = fs.mkdtempSync(path.join(os.tmpdir(), "alias-wiring-immut-"));
    tmpDirs.push(tmpC);
    writeModelStore(tmpC, model);
    const evRecord = {
      knowledgeKey: buildKnowledgeKey("INTERACTION", PAGE, OLD_A, OBSERVED),
      knowledgeType: "INTERACTION",
      pageId: PAGE,
      targetId: OLD_A,
      normalizedValue: OBSERVED,
      evidence: [makeEvidence(OLD_A, "ev-c")]
    };
    const evDir = path.join(tmpC, "storage", "knowledge-evidence", PROJECT, "INTERACTION");
    fs.mkdirpSync(evDir);
    const evPath = path.join(evDir, `${evRecord.knowledgeKey}.json`);
    fs.writeFileSync(evPath, JSON.stringify(evRecord, null, 2) + "\n");
    const bytesBefore = fs.readFileSync(evPath);
    const foundC = collectEvidenceForCanonical(model, [makeEvidence(OLD_A, "ev-c")], CANON);
    check("C1 查询 canonicalA 找到 oldA evidence", foundC.length, 1);
    await writeInteraction(tmpC, PROJECT, candidateFor(OLD_A, [makeEvidence(OLD_A, "ev-c")]));
    const bytesAfter = fs.readFileSync(evPath);
    check("C2 evidence 文件字节级不变", bytesAfter.equals(bytesBefore), true);

    // ============ D：writeInteraction(oldA) → 写入 canonical element ============
    const tmpD = fs.mkdtempSync(path.join(os.tmpdir(), "alias-wiring-wb-"));
    tmpDirs.push(tmpD);
    const storePath = writeModelStore(tmpD, model);
    const result = await writeInteraction(tmpD, PROJECT, candidateFor(OLD_A, [makeEvidence(OLD_A, "ev-d")]));
    check("D1 action=record_interaction", result.action, "record_interaction");
    check("D2 elementId=canonical（写入收敛元素）", result.elementId, CANON);
    check("D3 targetId 保留 source（provenance）", result.targetId, OLD_A);
    check("D4 detail.canonicalTargetId 可审计", (result.detail as { canonicalTargetId?: string } | undefined)?.canonicalTargetId, CANON);

    // ============ E：verificationHistory 追加到 canonical element ============
    const storeAfter = fs.readJsonSync(storePath) as { models: Array<Record<string, unknown>> };
    const elements = storeAfter.models[0].elements as Array<Record<string, unknown>>;
    const canonEl = elements.find((el) => String(el.elementId) === CANON);
    const canonHistory = Array.isArray(canonEl?.verificationHistory) ? canonEl?.verificationHistory as Array<Record<string, unknown>> : [];
    check("E1 canonical element 追加 verificationHistory", canonHistory.length, 1);
    check("E2 history knowledgeType=INTERACTION", canonHistory[0]?.knowledgeType, "INTERACTION");
    const oldEl = elements.find((el) => String(el.elementId) === OLD_A);
    check("E3 旧元素无 verificationHistory（不改写旧元素）", oldEl?.verificationHistory, undefined);

    // ============ F：无 alias 行为完全不变 ============
    const plain = plainModel();
    check("F1 resolveTargetIds 无 alias 恒等", resolveTargetIds(plain, OLD_A).canonicalTargetId, OLD_A);
    const raw = aggregateEvidence([makeEvidence(OLD_A, "ev-f1"), makeEvidence(CANON, "ev-f2")]);
    check("F2 aggregateEvidence 无 pageModels 保持原分组（2 candidates）", raw.size, 2);
    const tmpF = fs.mkdtempSync(path.join(os.tmpdir(), "alias-wiring-plain-"));
    tmpDirs.push(tmpF);
    writeModelStore(tmpF, plain);
    const resultF = await writeInteraction(tmpF, PROJECT, candidateFor(OLD_A, [makeEvidence(OLD_A, "ev-f3")]));
    check("F3 无 alias 写回原元素（elementId=oldA）", resultF.elementId, OLD_A);

    // ============ G：cycle / invalid alias 继续拒绝 ============
    const cycleModel: PageModelWithAliases = {
      pageId: PAGE,
      elements: [{ elementId: OLD_A, semanticName: "a" }, { elementId: CANON, semanticName: "c" }],
      elementAliases: [
        { aliasElementId: OLD_A, canonicalElementId: CANON, reason: "SUPERSEDED", createdAt: "2026-09-08T00:00:00.000Z", source: "alias-wiring-tests" },
        { aliasElementId: CANON, canonicalElementId: OLD_A, reason: "SUPERSEDED", createdAt: "2026-09-08T00:00:00.000Z", source: "alias-wiring-tests" }
      ]
    };
    checkThrows("G1 wiring 层环解析拒绝", () => resolveTargetIds(cycleModel, OLD_A), "环");
    check("G2 validateElementAliases 拒绝环", validateElementAliases(cycleModel).valid, false);
    checkThrows("G3 核心 resolveCanonicalElementId 拒绝环", () => resolveCanonicalElementId(cycleModel, OLD_A), "环");

    // ============ H：sourceTargetId 仍可用于 provenance ============
    const resolved = resolveTargetIds(model, OLD_A);
    check("H1 sourceTargetId 字节级原样", resolved.sourceTargetId, OLD_A);
    check("H2 canonicalTargetId 解析为 canonical", resolved.canonicalTargetId, CANON);
    check("H3 locator 聚合保留 sourceTargetIds", JSON.stringify(locTargets[0]?.sourceTargetIds), JSON.stringify([OLD_A, OLD_B]));
  } finally {
    for (const dir of tmpDirs) fs.removeSync(dir);
  }
}

run().then(() => {
  console.log(`\n===== Element Alias Wiring Tests: ${passed} passed, ${failed} failed =====`);
  process.exitCode = failed > 0 ? 1 : 0;
}).catch((error) => {
  console.error("测试执行异常:", error);
  process.exitCode = 1;
});
