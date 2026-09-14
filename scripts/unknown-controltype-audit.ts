import fs from "node:fs";
import path from "node:path";

/**
 * P4-A1：unknown controlType 归因审计（只读）。
 * 对 147 个 controlType=unknown/缺失的元素分类归因：
 *   A capture 没采到 tag/role
 *   B semanticName 有信息但 mapper 不认识
 *   C component 类型特殊
 *   D dropdown option 被当独立 element
 *   E text/link 不应参与交互建模
 *   F 历史粗采集（p4/c2 等批量编号命名）
 *   G 其他
 */

const rootDir = process.cwd();

function classify(element: Record<string, unknown>): { cause: string; detail: string } {
  const elementId = String(element.elementId ?? "");
  const semanticName = String(element.semanticName ?? "");
  const role = String(element.role ?? "");
  const locatorCandidates = Array.isArray(element.locatorCandidates) ? element.locatorCandidates as Array<Record<string, unknown>> : [];
  const component = element.component as Record<string, unknown> | undefined;

  // D: dropdown option（ID/语义名特征）
  if (/option|_bsc_|_usdt_option/i.test(elementId) || component?.optionDiscoveryMode || /option/i.test(String(component?.popupScope ?? ""))) {
    return { cause: "D_dropdown_option_as_element", detail: "option 被当独立元素（应归属父 dropdown）" };
  }
  // F: 历史粗采集（p4/c2/c4 编号前缀）
  if (/^(p4|c\d+(_\d+)?)\./i.test(elementId) || /_\d+$/.test(elementId)) {
    return { cause: "F_legacy_bulk_capture", detail: "批量编号命名（粗采集无 tag/role）" };
  }
  // E: text/link 不应交互
  if (/text|label|标题|说明|提示/.test(semanticName) && !/input|输入/.test(semanticName)) {
    return { cause: "E_non_interactive", detail: "text/label 类不应参与交互建模" };
  }
  // B: semanticName 有信号
  if (/输入|input/i.test(semanticName)) return { cause: "B_semantic_signal_unmapped", detail: "semanticName 含输入信号但 mapper 未识别" };
  if (/下拉|选择|筛选.*下拉|dropdown|select/i.test(semanticName)) return { cause: "B_semantic_signal_unmapped", detail: "semanticName 含下拉/筛选信号" };
  if (/按钮|button/i.test(semanticName)) return { cause: "B_semantic_signal_unmapped", detail: "semanticName 含按钮信号" };
  if (/tab|标签页/i.test(semanticName)) return { cause: "B_semantic_signal_unmapped", detail: "semanticName 含 tab 信号" };
  // A: 有 locator 但无 tag/role（capture 缺失）
  if (locatorCandidates.length && !role) {
    return { cause: "A_capture_missing_tag_role", detail: "有 locator 候选但无 role/tag" };
  }
  // G/C
  if (component) return { cause: "C_special_component", detail: `component=${String(component.type ?? "?")}` };
  return { cause: "G_other", detail: "无结构性证据" };
}

const store = JSON.parse(fs.readFileSync(path.join(rootDir, "storage/page-models/demo.json"), "utf8"));
const cases = JSON.parse(fs.readFileSync(path.join(rootDir, "storage/cases/demo.json"), "utf8")).cases;
const dslDir = path.join(rootDir, "storage/case-dsl/demo");
const dslRefs = new Set<string>();
for (const file of fs.readdirSync(dslDir).filter(f => f.endsWith(".json"))) {
  const content = fs.readFileSync(path.join(dslDir, file), "utf8");
  for (const element of store.models.flatMap((m: Record<string, unknown>) => (m.elements ?? []) as Array<Record<string, unknown>>)) {
    if (content.includes(String(element.elementId ?? ""))) dslRefs.add(String(element.elementId));
  }
}

const unknowns: Array<Record<string, unknown>> = [];
const distribution: Record<string, number> = {};
for (const model of store.models) {
  for (const element of (model.elements ?? []) as Array<Record<string, unknown>>) {
    const controlType = String(element.controlType ?? "");
    if (controlType && controlType !== "unknown") continue;
    const result = classify(element);
    distribution[result.cause] = (distribution[result.cause] ?? 0) + 1;
    unknowns.push({
      elementId: element.elementId,
      pageId: model.pageId,
      semanticName: element.semanticName,
      role: element.role ?? "-",
      locatorCount: (element.locatorCandidates as unknown[] | undefined)?.length ?? 0,
      component: element.component ? String((element.component as Record<string, unknown>).type ?? "?") : "-",
      dslReferenced: dslRefs.has(String(element.elementId)),
      cause: result.cause,
      detail: result.detail
    });
  }
}

console.log("=== P4-A1：Unknown ControlType 归因审计 ===");
console.log(`总数: ${unknowns.length}`);
console.log("\n归因分布:");
Object.entries(distribution).sort((a, b) => b[1] - a[1]).forEach(([cause, count]) => {
  console.log(`  ${cause}: ${count} (${(count / unknowns.length * 100).toFixed(0)}%)`);
});
console.log("\n各归因样例（前 3 条/类）:");
for (const cause of Object.keys(distribution)) {
  console.log(`\n[${cause}]`);
  unknowns.filter(u => u.cause === cause).slice(0, 3).forEach(u => {
    console.log(`  ${u.elementId} | ${String(u.semanticName).slice(0, 25)} | role=${u.role} | dslRef=${u.dslReferenced}`);
  });
}
console.log(`\nDSL 引用率: ${unknowns.filter(u => u.dslReferenced).length}/${unknowns.length}`);

fs.writeFileSync(path.join(rootDir, "reports/unknown-controltype-audit.json"), JSON.stringify({ total: unknowns.length, distribution, unknowns }, null, 2));
console.log("\n报告: reports/unknown-controltype-audit.json");
