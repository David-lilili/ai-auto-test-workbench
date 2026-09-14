/**
 * P5.3 re-audit：把执行历史里真实发生的自愈成功（status=healed 且 fallback>0）
 * 回放到 unified evidence sink——与 executor 运行时完全相同的写入路径，
 * 保留真实 run_id 溯源。用于：
 *  1) 验证 guard 修复后 page-model 步骤的自愈证据可以落盘；
 *  2) 为知识飞轮补上历史自愈样本（幂等，可重复执行）。
 *
 * 用法: npx tsx scripts/replay-healed-evidence.ts [--project demo] [--dry-run]
 */

import fs from "fs-extra";
import path from "node:path";
import { parseArgs } from "node:util";
import { recordKnowledgeEvidence } from "../src/core/knowledge-evidence-sink.js";
import { logger } from "../src/core/logger.js";

const options = parseArgs({
  args: process.argv.slice(2),
  options: {
    project: { type: "string", default: "demo" },
    "dry-run": { type: "boolean", default: false }
  }
});

const project = options.values.project;
const dryRun = options.values["dry-run"];
const rootDir = path.resolve(".");

interface HealedStep {
  step_id: string;
  run_id: string;
  dsl_step_id: string;
  action_type: string;
  target_semantic_name?: string;
  primary_locator?: string;
  actual_locator_used?: string;
  fallback_level_used: number;
  status: string;
  attempted_locators?: string[];
}

function loadJson(rel: string): unknown {
  const p = path.join(rootDir, rel);
  return fs.pathExistsSync(p) ? fs.readJsonSync(p) : undefined;
}

/** 从 page model 构建 safeId(element.id) -> { pageId, semanticName } 索引（与 DSL builder 同构）。 */
function buildElementIndex(): Map<string, { pageId: string; semanticName: string; elementId: string }> {
  const index = new Map<string, { pageId: string; semanticName: string; elementId: string }>();
  const store = loadJson(`storage/page-models/${project}.json`) as { models?: Array<Record<string, unknown>> } | undefined;
  const models = store?.models ?? [];
  for (const model of models) {
    const pageId = String(model.pageId ?? model.id ?? "");
    const elements = (model.elements as Array<Record<string, unknown>>) ?? [];
    for (const el of elements) {
      const elementId = String(el.elementId ?? el.id ?? "");
      const semanticName = String(el.semanticName ?? "");
      const safe = elementId.replace(/[^a-z0-9_-]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();
      if (safe) index.set(safe, { pageId, semanticName, elementId });
    }
  }
  return index;
}

/** 语义名模糊匹配（与 writeback dispatcher 同规则）。 */
function fuzzySemanticMatch(a: string, b: string): boolean {
  const normalize = (value: string) => value.replace(/[\s（）()点击按钮]/g, "");
  const na = normalize(a);
  const nb = normalize(b);
  return na === nb || (na.length > 0 && nb.length > 0 && (na.includes(nb) || nb.includes(na)));
}

/** 优先 safeId 精确匹配；失败时按语义名跨页面模糊匹配（覆盖 -expand-list 复合 id）。 */
function resolveElement(
  elementIndex: Map<string, { pageId: string; semanticName: string; elementId: string }>,
  safeElementId: string,
  semanticName: string
): { pageId: string; semanticName: string; elementId: string } | undefined {
  const exact = elementIndex.get(safeElementId);
  if (exact) return exact;
  // 复合 id（如 ...-expand-list）先去掉尾部 -expand-list 再试一次
  if (safeElementId.endsWith("-expand-list")) {
    const stripped = elementIndex.get(safeElementId.slice(0, -"-expand-list".length));
    if (stripped) return stripped;
  }
  if (!semanticName) return undefined;
  let best: { pageId: string; semanticName: string; elementId: string } | undefined;
  for (const entry of elementIndex.values()) {
    if (fuzzySemanticMatch(entry.semanticName, semanticName)) {
      if (!best || entry.semanticName.length >= best.semanticName.length) best = entry;
    }
  }
  return best;
}

async function main(): Promise<void> {
  const execution = loadJson(`storage/execution/${project}.json`) as { steps?: HealedStep[] } | undefined;
  const steps = execution?.steps ?? [];
  const healed = steps.filter((s): s is HealedStep & { actual_locator_used: string } =>
    s.status === "healed" && s.fallback_level_used > 0 && Boolean(s.actual_locator_used));
  const elementIndex = buildElementIndex();

  logger.info("Replay self-healing evidence", { project, totalHealed: healed.length, dryRun });

  let recorded = 0;
  let skipped = 0;
  let unresolved = 0;
  const byTarget = new Map<string, number>();

  for (const step of healed) {
    // dsl_step_id 形如 click-earn_product_center-product_type_tab-current，
    // 去掉动作前缀后即 safeId(element.id)。
    const actionPrefix = `${step.action_type}-`;
    const safeElementId = step.dsl_step_id.startsWith(actionPrefix)
      ? step.dsl_step_id.slice(actionPrefix.length)
      : step.dsl_step_id;
    const element = resolveElement(elementIndex, safeElementId, step.target_semantic_name ?? "");
    const pageId = element?.pageId ?? "(unknown)";
    const semanticName = element?.semanticName ?? step.target_semantic_name ?? safeElementId;

    if (!element) unresolved++;
    byTarget.set(semanticName, (byTarget.get(semanticName) ?? 0) + 1);

    if (dryRun) {
      console.log(`[dry-run] ${step.dsl_step_id} -> ${semanticName} @ ${pageId} (fl=${step.fallback_level_used})`);
      continue;
    }

    try {
      const result = await recordKnowledgeEvidence(rootDir, {
        project,
        knowledgeType: "LOCATOR",
        pageId,
        targetId: semanticName,
        sourceType: "SELF_HEALING",
        sourceRunId: step.run_id,
        observation: {
          oldLocator: step.primary_locator ?? null,
          newLocator: step.actual_locator_used,
          fallbackLevel: step.fallback_level_used,
          attemptedLocators: step.attempted_locators ?? []
        },
        confidence: "HIGH",
        environment: "test",
        observedValue: step.actual_locator_used,
        outcome: "success"
      });
      recorded++;
      if (result.deduplicated) skipped++;
    } catch (error) {
      logger.warn("Replay failed for step", { stepId: step.step_id, error: error instanceof Error ? error.message : String(error) });
    }
  }

  console.log(JSON.stringify({
    project,
    dryRun,
    totalHealed: healed.length,
    recorded,
    deduplicated: skipped,
    unresolvedPageModel: unresolved,
    distinctTargets: [...byTarget.entries()].map(([t, n]) => ({ target: t, count: n }))
  }, null, 2));
}

await main();
