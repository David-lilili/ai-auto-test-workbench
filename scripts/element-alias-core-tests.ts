/**
 * Element Alias / Supersession Core — targeted tests（P16.7）。
 *
 * 只测 schema 类型 / resolver / validator；不写 Market alias、不删 element、
 * 不迁移 evidence、不修改任何 Page Model / Evidence 存储。
 *
 * 运行：npx tsx scripts/element-alias-core-tests.ts
 */
import {
  ElementAliasError,
  resolveCanonicalElementId,
  validateElementAliases,
  ALLOWED_ALIAS_REASONS,
  REJECTED_ALIAS_REASONS
} from "../src/core/element-alias-resolver.js";
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
    const msgOk = messagePart === undefined || String(error instanceof Error ? error.message : error).includes(messagePart);
    if (isAliasError && msgOk) passed += 1;
    else failed += 1;
    console.log(`${isAliasError && msgOk ? "PASS" : "FAIL"} | ${label} | ${error instanceof Error ? error.message : String(error)}`);
  }
}

function alias(aliasElementId: string, canonicalElementId: string, reason: ElementAliasEntry["reason"] = "SAME_SEMANTIC_ELEMENT", extra: Partial<ElementAliasEntry> = {}): ElementAliasEntry {
  return { aliasElementId, canonicalElementId, reason, createdAt: "2026-09-08T00:00:00Z", source: "element-alias-core-tests", ...extra };
}

function model(aliases: ElementAliasEntry[], elementIds: string[]): PageModelWithAliases {
  return {
    elements: elementIds.map((id) => ({ elementId: id, semanticName: id, controlType: "button" })),
    elementAliases: aliases
  };
}

// ============ A: 单级 alias ============
check("A: oldA → canonicalA", resolveCanonicalElementId(model([alias("oldA", "canonicalA")], ["oldA", "canonicalA"]), "oldA"), "canonicalA");

// ============ B: 链式解析 ============
check("B: A → B → C 解析为 C", resolveCanonicalElementId(model([alias("A", "B"), alias("B", "C")], ["A", "B", "C"]), "A"), "C");
check("B2: 中间节点无需存在于 elements", resolveCanonicalElementId(model([alias("A", "B"), alias("B", "C")], ["C"]), "A"), "C");
check("B3: 已指向 canonical 的 id 不再解析", resolveCanonicalElementId(model([alias("A", "B")], ["A", "B"]), "B"), "B");

// ============ C: cycle 拒绝 ============
checkThrows("C: cycle A→B→A 拒绝", () => resolveCanonicalElementId(model([alias("A", "B"), alias("B", "A")], ["A", "B"]), "A"), "环");
const cycleValidation = validateElementAliases(model([alias("A", "B"), alias("B", "A")], ["A", "B"]));
check("C2: validate 报告 cycle 非法", cycleValidation.valid, false);
check("C3: validate errors 含环信息", cycleValidation.errors.some((e) => e.includes("环")), true);

// ============ D: self alias 拒绝 ============
checkThrows("D: self alias A→A 拒绝", () => resolveCanonicalElementId(model([alias("A", "A")], ["A"]), "A"), "self alias");
check("D2: validate 报告 self alias 非法", validateElementAliases(model([alias("A", "A")], ["A"])).valid, false);

// ============ E: canonical target 不存在 → 拒绝 ============
checkThrows("E: canonical target 缺失 拒绝", () => resolveCanonicalElementId(model([alias("X", "Y")], ["X"]), "X"), "不存在");
checkThrows("E2: 链终点缺失 拒绝", () => resolveCanonicalElementId(model([alias("X", "Y"), alias("Y", "Z")], ["X", "Y"]), "X"), "不存在");
check("E3: validate 报告 canonical 缺失", validateElementAliases(model([alias("X", "Y")], ["X"])).valid, false);

// ============ F: 无 alias → 原 id（向后兼容） ============
check("F: 无 elementAliases 字段 → 原 id", resolveCanonicalElementId({ elements: [{ elementId: "el_1" }] }, "el_1"), "el_1");
check("F2: elementAliases 空数组 → 原 id", resolveCanonicalElementId(model([], ["el_1"]), "el_1"), "el_1");

// ============ G: evidence immutable + resolver 解析 ============
const evidence = { evidenceId: "ev-1", pageId: "market.page_market", targetId: "old_element_2", outcome: "success" };
const marketModel = model([alias("old_element_2", "canonical_element")], ["old_element_2", "canonical_element"]);
check("G: evidence.targetId 原样保留", evidence.targetId, "old_element_2");
check("G2: resolver 解析到 canonical element", resolveCanonicalElementId(marketModel, evidence.targetId), "canonical_element");
check("G3: canonical element 真实存在", marketModel.elements?.some((el) => String(el.elementId) === "canonical_element"), true);

// ============ H: verificationHistory 不被修改 ============
const historyModel: PageModelWithAliases = {
  elements: [{ elementId: "canonicalA", semanticName: "BTC 比特币", verificationHistory: [{ promotedAt: "2026-01-01T00:00:00Z", policyId: "locator.v1", action: "append_locator_candidate" }] }],
  elementAliases: [alias("oldA", "canonicalA")]
};
const historySnapshot = JSON.stringify(historyModel);
resolveCanonicalElementId(historyModel, "oldA");
validateElementAliases(historyModel);
check("H: resolve/validate 后 model 对象零修改", JSON.stringify(historyModel), historySnapshot);

// ============ Governance: reason 白名单 ============
for (const bad of REJECTED_ALIAS_REASONS) {
  const badModel = model([alias("oldX", "canonX", bad as ElementAliasEntry["reason"])], ["oldX", "canonX"]);
  const v = validateElementAliases(badModel);
  check(`GOV: reason=${bad} 拒绝`, v.valid, false);
  check(`GOV2: reason=${bad} errors 含非法提示`, v.errors.some((e) => e.includes("非法 reason")), true);
}
check("GOV3: 未知 reason 拒绝", validateElementAliases(model([alias("oldX", "canonX", "WHATEVER" as ElementAliasEntry["reason"])], ["oldX", "canonX"])).valid, false);
const good = validateElementAliases(model([alias("oldA", "canonA", "SAME_SEMANTIC_ELEMENT"), alias("oldB", "canonB", "SUPERSEDED")], ["oldA", "oldB", "canonA", "canonB"]));
check("GOV4: 白名单 reason 全部通过", good.valid, true);
check("GOV5: ALLOWED 集合仅两项", ALLOWED_ALIAS_REASONS.length, 2);
check("GOV6: 缺失 createdAt/source 拒绝", validateElementAliases(model([alias("oldA", "canonA", "SAME_SEMANTIC_ELEMENT", { createdAt: "", source: "" })], ["oldA", "canonA"])).valid, false);
check("GOV7: alias 源重复拒绝", validateElementAliases(model([alias("oldA", "canonA"), alias("oldA", "canonB")], ["oldA", "canonA", "canonB"])).valid, false);

console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
