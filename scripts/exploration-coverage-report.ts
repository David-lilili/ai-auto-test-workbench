import fs from "fs-extra";
import path from "node:path";
import { buildCoverageSnapshot } from "../src/core/exploration-coverage.js";
import { buildExplorationGaps } from "../src/core/exploration-gaps.js";
import { scoreIdentityPair, type PageIdentitySignal } from "../src/core/page-identity-resolver.js";

/**
 * Exploration Coverage 报告（P2.4）：
 * 项目级摘要 + 每页 snapshot + exploration gaps + 状态分布。
 * 只读、deterministic、不写 proposal、不改 Page Model。
 */

function looksLikeState(pageId: string): boolean {
  return /(_entry|_state|_dimension|_modal|_drawer|_tab)$|\.state\./i.test(pageId);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const projectIndex = args.indexOf("--project");
  const project = projectIndex >= 0 ? args[projectIndex + 1] : "demo";
  const rootDir = process.cwd();

  // 1. 从 Page Model 读取身份信号，推导 RELATED_STATE_MODEL 关系（identity group）
  const storePath = path.join(rootDir, "storage", "page-models", `${project}.json`);
  const store = await fs.readJson(storePath) as Record<string, unknown>;
  const models = Array.isArray(store.models) ? store.models as Array<Record<string, unknown>> : [];
  const signals: Array<PageIdentitySignal & { pageId: string }> = models.map((model) => ({
    pageId: String(model.pageId ?? ""),
    url: typeof model.url === "string" ? model.url : undefined,
    pageName: typeof model.pageName === "string" ? model.pageName : undefined,
    semanticNames: Array.isArray(model.elements)
      ? (model.elements as Array<Record<string, unknown>>).map((element) => String(element.semanticName ?? "")).filter(Boolean)
      : []
  }));
  const corpus = signals as PageIdentitySignal[];
  const relatedByPage = new Map<string, string[]>();
  for (let i = 0; i < signals.length; i += 1) {
    for (let j = i + 1; j < signals.length; j += 1) {
      const pair = scoreIdentityPair(signals[j], signals[i], corpus);
      if (!pair.urlMatch) continue;
      const stateA = looksLikeState(signals[i].pageId);
      const stateB = looksLikeState(signals[j].pageId);
      if (stateA === stateB && !(stateA && stateB)) continue; // 非状态族（页面级对页面级）不在 coverage 展示为 related
      if (!relatedByPage.has(signals[i].pageId)) relatedByPage.set(signals[i].pageId, []);
      if (!relatedByPage.has(signals[j].pageId)) relatedByPage.set(signals[j].pageId, []);
      relatedByPage.get(signals[i].pageId)!.push(signals[j].pageId);
      relatedByPage.get(signals[j].pageId)!.push(signals[i].pageId);
    }
  }

  // 2. Coverage Snapshot
  const snapshot = await buildCoverageSnapshot(rootDir, project, relatedByPage);
  // 3. Exploration Gaps
  const gapReport = await buildExplorationGaps(rootDir, project, snapshot);

  // 4. 渲染报告
  const lines: string[] = [
    `# Exploration Coverage 报告（${project}）`,
    "",
    `## 项目级摘要`,
    "",
    `- Page Model 总数：${snapshot.totalPages}（页面级 ${snapshot.pages.filter((page) => !page.isStateModel).length} / 状态级 ${snapshot.pages.filter((page) => page.isStateModel).length}）`,
    `- 元素状态分布：${JSON.stringify(snapshot.projectSummary.elementsByStatus)}`,
    `- 交互状态分布：${JSON.stringify(snapshot.projectSummary.interactionsByStatus)}`,
    `- 状态维度分布：${JSON.stringify(snapshot.projectSummary.statesByStatus)}`,
    `- 依赖维度分布：${JSON.stringify(snapshot.projectSummary.dependenciesByStatus)}`,
    `- Exploration Gaps：${gapReport.totalGaps}（${JSON.stringify(gapReport.byPriority)}）`,
    `- Gap 来源分布：${JSON.stringify(gapReport.bySource)}`,
    "",
    `## Identity Groups（状态族关系，非重复页面）`,
    ""
  ];
  const groups = new Map<string, string[]>();
  for (const page of snapshot.pages) {
    if (!page.identityGroup) continue;
    if (!groups.has(page.identityGroup)) groups.set(page.identityGroup, []);
    groups.get(page.identityGroup)!.push(page.isStateModel ? `${page.pageId} [状态]` : `${page.pageId} [页面]`);
  }
  if (groups.size) {
    for (const [group, members] of groups) {
      lines.push(`- ${group.replace(/\+/g, " + ")}`);
      members.forEach((member) => lines.push(`  - ${member}`));
    }
  } else {
    lines.push("- 无状态族关系。");
  }

  lines.push("", `## 每页 Coverage Snapshot`, "");
  for (const page of snapshot.pages) {
    lines.push(`### ${page.pageName}（${page.pageId}）${page.isStateModel ? " [状态模型]" : ""}`);
    lines.push(`- 元素：${page.summary.totalElements} 个 = VERIFIED ${page.summary.verified} / OBSERVED ${page.summary.observed} / KNOWN ${page.summary.known} / UNCERTAIN ${page.summary.uncertain}`);
    lines.push(`- 交互：${page.interactions.length} 项（VERIFIED ${page.interactions.filter((item) => item.status === "VERIFIED").length}）`);
    lines.push(`- 状态：${page.states.length} 项（含 BLOCKED ${page.summary.blocked}）`);
    lines.push(`- 依赖：${page.dependencies.length} 项`);
    if (page.relatedPages.length) lines.push(`- 状态族：${page.relatedPages.join(", ")}`);
    lines.push("");
  }

  lines.push(`## Top 20 Exploration Gaps（deterministic priority）`, "");
  const top = gapReport.gaps.slice(0, 20);
  top.forEach((gap, index) => {
    lines.push(`${index + 1}. [${gap.priority}] ${gap.source} | ${gap.pageId} | ${gap.dimension}:${gap.target}`);
    lines.push(`   证据：${gap.evidence}`);
    lines.push(`   原因：${gap.reason}`);
  });
  if (!top.length) lines.push("- 无 gap。");

  lines.push("", "## 说明", "");
  lines.push("- 状态口径：VERIFIED=真实执行验证；OBSERVED=dom/click 观察未执行；KNOWN=已建模无执行；UNCERTAIN=candidate；BLOCKED=前置阻断；NOT_APPLICABLE=控件不适用。");
  lines.push("- Gap 只来自明确来源（元素未验证/交互无证据/状态族无路径/诊断缺失/能力声明缺证据/candidate 陈旧），不枚举不存在的组合。");
  lines.push("- 本报告只读：不改 Page Model、不写 proposal、不影响执行。");

  const reportPath = path.join(rootDir, "reports", `exploration-coverage-${project}.md`);
  const jsonPath = path.join(rootDir, "reports", `exploration-coverage-${project}.json`);
  await fs.ensureDir(path.dirname(reportPath));
  await fs.writeFile(reportPath, `${lines.join("\n")}\n`, "utf8");
  await fs.writeJson(jsonPath, { snapshot, gapReport }, { spaces: 2 });
  console.log(lines.join("\n").slice(0, 4000));
  console.log(`\n报告: ${path.relative(rootDir, reportPath).replace(/\\/g, "/")}`);
  console.log(`数据: ${path.relative(rootDir, jsonPath).replace(/\\/g, "/")}`);
}

await main();
