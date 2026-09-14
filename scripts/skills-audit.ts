import fs from "node:fs";
import path from "node:path";
import { HEURISTIC_REGISTRY, validateHeuristicRegistry } from "../src/core/exploration-heuristics.js";
import { selectProfileDimensions, collectRequiredDimensions } from "../src/core/account-profile-catalog.js";
import fsExtra from "fs-extra";

/**
 * Skill/Heuristic Traceability 报告（P3-A5）：只读。
 * 输出每条 heuristic 的溯源（ID/版本/来源规则/适用控件/触发 gap/风险），
 * 并检查 orphan heuristic / orphan playbook rule / 重复 ID / 重复 source 映射。
 */

interface PlaybookRuleMarker {
  line: number;
  heuristicIds: string[];
}

/** 从 playbook 提取 "Runtime heuristic: xxx@v1" 反向引用标记。 */
function extractPlaybookMarkers(playbookPath: string): Map<number, PlaybookRuleMarker> {
  const markers = new Map<number, PlaybookRuleMarker>();
  if (!fs.existsSync(playbookPath)) return markers;
  const lines = fs.readFileSync(playbookPath, "utf8").split(/\r?\n/);
  let currentRuleLine = -1;
  lines.forEach((line, index) => {
    const ruleMatch = line.match(/^[-\s]*(?:必填|数值|业务状态|列表|筛选|日期|弹窗|二次确认|Tab|下拉|低风险|高风险|如果|规则|样本|断言能力)/);
    if (ruleMatch) currentRuleLine = index + 1;
    const heuristicMatch = line.match(/Runtime heuristic:\s*(.+)/);
    if (heuristicMatch) {
      const ids = heuristicMatch[1].split(/[,，]/).map((value) => value.trim()).filter(Boolean);
      if (currentRuleLine > 0) {
        const existing = markers.get(currentRuleLine);
        if (existing) existing.heuristicIds.push(...ids);
        else markers.set(currentRuleLine, { line: currentRuleLine, heuristicIds: ids });
      }
    }
  });
  return markers;
}

async function main(): Promise<void> {
  const rootDir = process.cwd();
  const playbookPath = path.join(rootDir, "docs", "page-model-modeling-playbook.md");
  const markers = extractPlaybookMarkers(playbookPath);

  // ===== P3-A.1：Profile Catalog 选择审计 =====
  console.log("## Profile Catalog 选择\n");
  const schema = await fsExtra.readJson(path.join(rootDir, "storage", "account-profile-schemas", "demo.json")).catch(() => undefined);
  const manual = await fsExtra.readJson(path.join(rootDir, "storage", "operation-manuals", "demo.json")).catch(() => undefined);
  if (schema) {
    const selection = selectProfileDimensions(schema, collectRequiredDimensions(manual));
    console.log(`- schema dimensions: ${schema.dimensions?.length ?? 0}`);
    console.log(`- selected: ${selection.selectedDimensions.length} / omitted: ${selection.omittedDimensions.length}`);
    console.log(`- required-but-omitted: ${selection.requiredButOmitted.length}${selection.requiredButOmitted.length === 0 ? " ✓" : " ✗ 违规"}`);
    const byPriority: Record<string, number> = {};
    for (const reason of selection.selectionReasons) {
      if (selection.selectedDimensions.some((entry) => entry.dimension === reason.dimension)) {
        byPriority[reason.priority] = (byPriority[reason.priority] ?? 0) + 1;
      }
    }
    console.log(`- 选择优先级分布: ${JSON.stringify(byPriority)}`);
  } else {
    console.log("- schema 未配置，跳过");
  }
  console.log("");

  console.log("# Skill / Heuristic Traceability 报告\n");
  console.log(`Heuristic 总数: ${HEURISTIC_REGISTRY.length}\n`);
  console.log("| Heuristic ID | Version | Source Rule | Applicable Controls | Trigger Gap Sources | Risk | Tests |");
  console.log("|---|---|---|---|---|---|---|");
  for (const heuristic of HEURISTIC_REGISTRY) {
    console.log(`| ${heuristic.id} | ${heuristic.version} | ${heuristic.sourceRule} | ${heuristic.appliesTo.join(", ")} | ${heuristic.triggerGapSources.join(", ")} | ${heuristic.riskClass} | see tests/skill-foundation.test.ts |`);
  }

  // 检查 1：orphan heuristic（无 sourceRule）——validateHeuristicRegistry 覆盖
  const issues = validateHeuristicRegistry();
  console.log(`\n## Registry 校验\n`);
  console.log(issues.length ? issues.map((issue) => `- ✗ ${issue}`).join("\n") : "- ✓ 无 orphan heuristic、无重复 ID、schema 完整");

  // ===== P3-A.1：稳定 Rule ID 双向校验 =====
  const playbookText = fs.readFileSync(playbookPath, "utf8");
  const playbookRuleIds = [...new Set([...playbookText.matchAll(/\[PMH\.[A-Z0-9_.]+\]/g)].map((match) => match[0].slice(1, -1)))];
  const heuristicRuleIds = new Set(HEURISTIC_REGISTRY.map((heuristic) => heuristic.sourceRule.replace("playbook:", "")));
  const orphanRules = playbookRuleIds.filter((id) => id.startsWith("PMH.") && !/RUNTIME/.test(id) && !heuristicRuleIds.has(id));
  const ruleIdIssues: string[] = [];
  // heuristic sourceRule → playbook 规则 ID 必须唯一解析
  for (const heuristic of HEURISTIC_REGISTRY) {
    const ruleId = heuristic.sourceRule.replace("playbook:", "");
    if (ruleId.startsWith("PMH.") && !playbookRuleIds.includes(ruleId)) {
      ruleIdIssues.push(`${heuristic.id}: sourceRule ${heuristic.sourceRule} 无法解析到 playbook 规则 ID`);
    }
  }
  console.log("## Playbook 稳定 Rule ID\n");
  console.log(`- playbook 规则 ID 总数: ${playbookRuleIds.length}（${playbookRuleIds.join(", ")}）`);
  console.log(`- 已编译为 heuristic 的规则: ${heuristicRuleIds.size}`);
  if (ruleIdIssues.length) console.log(`✗ 解析失败:
${ruleIdIssues.map((issue) => "- " + issue).join("\n")}`);
  else console.log("✓ 所有 heuristic sourceRule 解析到唯一 playbook 规则 ID");
  if (new Set(playbookRuleIds).size !== playbookRuleIds.length) console.log("✗ playbook 规则 ID 存在重复");
  else console.log("✓ playbook 规则 ID 无重复");
  if (orphanRules.length) console.log(`⚠ runtime-capable 规则未编译: ${orphanRules.join(", ")}`);
  else console.log("✓ 无 orphan 规则（所有 PMH.* 均已编译或非 runtime-capable）");
  console.log("");

  // 检查 2：orphan playbook rule（标记了 runtime heuristic 但 registry 里没有）
  const registryIds = new Set(HEURISTIC_REGISTRY.map((heuristic) => heuristic.id));
  const orphanMarkers: string[] = [];
  for (const [, marker] of markers) {
    for (const id of marker.heuristicIds) {
      const bare = id.split("@")[0];
      if (!registryIds.has(bare)) orphanMarkers.push(`playbook:L${marker.line} 引用了不存在的 heuristic: ${id}`);
    }
  }
  // 检查 4：重复 source 映射
  const sourceCount = new Map<string, string[]>();
  for (const heuristic of HEURISTIC_REGISTRY) {
    if (!sourceCount.has(heuristic.sourceRule)) sourceCount.set(heuristic.sourceRule, []);
    sourceCount.get(heuristic.sourceRule)!.push(heuristic.id);
  }
  const duplicates = [...sourceCount.entries()].filter(([, ids]) => ids.length > 1);

  console.log(`\n## Playbook 反向引用\n`);
  console.log(`已标记 runtime heuristic 的 playbook 规则: ${markers.size} 处`);
  if (orphanMarkers.length) {
    console.log("\n✗ Orphan playbook 引用:");
    orphanMarkers.forEach((issue) => console.log(`- ${issue}`));
  } else {
    console.log("✓ 所有反向引用均能解析到 registry");
  }

  if (duplicates.length) {
    console.log(`\n## 多对一 source 映射（同源多 heuristic，合法但需知悉）\n`);
    duplicates.forEach(([source, ids]) => console.log(`- ${source} → ${ids.join(", ")}`));
  }

  // 检查 3：重复 heuristic id 已在 issues 内
  const reportPath = path.join(rootDir, "reports", "skills-audit.json");
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify({
    schemaVersion: "skills-audit.v1",
    generatedAt: new Date().toISOString(),
    totalHeuristics: HEURISTIC_REGISTRY.length,
    heuristics: HEURISTIC_REGISTRY.map((heuristic) => ({
      id: heuristic.id,
      version: heuristic.version,
      sourceRule: heuristic.sourceRule,
      appliesTo: heuristic.appliesTo,
      triggerGapSources: heuristic.triggerGapSources,
      riskClass: heuristic.riskClass
    })),
    issues,
    orphanPlaybookReferences: orphanMarkers,
    playbookMarkerCount: markers.size
  }, null, 2));
  console.log(`\n报告: ${path.relative(rootDir, reportPath).replace(/\\/g, "/")}`);
}

await main();
