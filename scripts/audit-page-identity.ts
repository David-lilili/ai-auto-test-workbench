import fs from "fs-extra";
import path from "node:path";
import { scoreIdentityPair, type PageIdentitySignal } from "../src/core/page-identity-resolver.js";

/**
 * P1 dry-run audit：对历史 Page Model 做两两身份审计，输出疑似重复页面组。
 * 只读不改：不合并、不写库、不生成 proposal。
 */

async function main(): Promise<void> {
  const rootDir = process.cwd();
  const storePath = path.join(rootDir, "storage", "page-models", "demo.json");
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

  console.log(`Page Model 总数: ${models.length}`);
  console.log("");

  // 两两配对（i<j），收集所有得分 >= 0.3 的 pair
  const pairs: Array<{
    a: string;
    b: string;
    score: number;
    verdict: string;
    matched: string[];
    conflicts: string[];
  }> = [];
  const corpus = signals as Array<import("../src/core/page-identity-resolver.js").PageIdentitySignal>;
  // pair 级审计（非全库对比）：B vs A 单独判，corpus 只用于 IDF 通用词降权。
  for (let i = 0; i < signals.length; i += 1) {
    for (let j = i + 1; j < signals.length; j += 1) {
      const forward = scoreIdentityPair(signals[j], signals[i], corpus);
      const backward = scoreIdentityPair(signals[i], signals[j], corpus);
      const score = Math.max(forward.score, backward.score);
      if (score < 0.3) continue;
      const best = forward.score >= backward.score ? forward : backward;
      // pair 级 verdict 映射（与 resolver 单对语义一致）：
      // pageId 精确匹配不会出现在两两审计（同 pageId 只有一个模型）；
      // 状态/页面类型不一致 → CONFLICT；≥0.75 → SAME_PAGE；≥0.3 → POSSIBLE。
      const stateA = looksLikeState(signals[i].pageId);
      const stateB = looksLikeState(signals[j].pageId);
      const urlMatched = best.urlMatch;
      const verdict = (stateA !== stateB || (stateA && stateB)) && urlMatched
        ? "RELATED_STATE_MODEL"
        : score >= 0.75
          ? "SAME_PAGE"
          : best.conflicts.length >= 2
            ? "CONFLICT"
            : "POSSIBLE_SAME_PAGE";
      pairs.push({
        a: signals[i].pageId,
        b: signals[j].pageId,
        score,
        verdict,
        matched: best.matched.map((item) => `${item.signal}: ${item.detail}`),
        conflicts: best.conflicts.map((item) => `${item.signal}: ${item.detail}`)
      });
    }
  }
  pairs.sort((x, y) => y.score - x.score);

  const verdictSummary: Record<string, number> = {};
  for (const pair of pairs) verdictSummary[pair.verdict] = (verdictSummary[pair.verdict] ?? 0) + 1;
  console.log(`疑似关联页面组（score ≥ 0.3 或 CONFLICT）: ${pairs.length} 组`);
  console.log(`verdict 分布: ${JSON.stringify(verdictSummary)}`);
  console.log("");
  const duplicates = pairs.filter((pair) => pair.verdict === "POSSIBLE_SAME_PAGE" || pair.verdict === "SAME_PAGE" || pair.verdict === "CONFLICT");
  const related = pairs.filter((pair) => pair.verdict === "RELATED_STATE_MODEL");
  console.log("=== 疑似/确认重复页面（需人工处理）===");
  for (const pair of duplicates) {
    console.log(`[${pair.verdict}] score=${pair.score.toFixed(2)}`);
    console.log(`  A: ${pair.a}`);
    console.log(`  B: ${pair.b}`);
    pair.matched.slice(0, 3).forEach((item) => console.log(`    ✓ ${item}`));
    pair.conflicts.slice(0, 2).forEach((item) => console.log(`    ✗ ${item}`));
  }
  console.log("");
  console.log(`=== 合法状态族关系（RELATED_STATE_MODEL，无需处理）: ${related.length} 组 ===`);
  const relatedGroups = new Map<string, string[]>();
  for (const pair of related) {
    const key = [pair.a, pair.b].sort().join(" + ");
    relatedGroups.set(key, [pair.a, pair.b]);
  }
  const stateFamilyByPage = new Map<string, Set<string>>();
  for (const pair of related) {
    for (const pageId of [pair.a, pair.b]) {
      if (!stateFamilyByPage.has(pageId)) stateFamilyByPage.set(pageId, new Set());
      stateFamilyByPage.get(pageId)!.add(pair.a === pageId ? pair.b : pair.a);
    }
  }
  for (const [pageId, family] of stateFamilyByPage) {
    console.log(`  ${pageId} ↔ ${[...family].join(", ")}`);
  }
  console.log("");
  for (const pair of pairs.filter((p) => !duplicates.includes(p) && !related.includes(p))) {
    console.log(`[${pair.verdict}] score=${pair.score.toFixed(2)}`);
    console.log(`  A: ${pair.a}`);
    console.log(`  B: ${pair.b}`);
    pair.matched.slice(0, 4).forEach((item) => console.log(`    ✓ ${item}`));
    pair.conflicts.slice(0, 2).forEach((item) => console.log(`    ✗ ${item}`));
    console.log("");
  }

  // 写审计报告（只读产物）
  const reportPath = path.join(rootDir, "reports", "page-identity-audit.json");
  await fs.writeJson(reportPath, {
    schemaVersion: "page-identity-audit.v1",
    generatedAt: new Date().toISOString(),
    totalModels: models.length,
    totalPairs: pairs.length,
    pairs
  }, { spaces: 2 });
  console.log(`审计报告: ${path.relative(rootDir, reportPath).replace(/\\/g, "/")}`);
}

function looksLikeState(pageId: string): boolean {
  return /(_entry|_state|_dimension|_modal|_drawer|_tab)$|\.state\./i.test(pageId);
}

await main();
