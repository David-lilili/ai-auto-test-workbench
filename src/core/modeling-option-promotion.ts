import fs from "fs-extra";
import path from "node:path";
import crypto from "node:crypto";
import { writeSafeJsonFile } from "./safe-file-writer.js";
import { logger } from "./logger.js";
import type { ExplorationRun } from "./exploration-executor.js";
import { buildOptionIdentity, type OptionCaptureContext } from "./modeling-option-identity.js";

/**
 * P6.2-1/2：Dropdown Option Promotion。
 *
 * 职责：Controlled Exploration 的 select.option_discovery run 成功（COMPLETED_CLEANLY）后，
 * 把观察到的 option 以 dropdown_option 元素写回 Page Model（OPTION_EXISTS 层，dom_verified）。
 *
 * 铁律：
 *   - 只挂 parent control（不产生独立 option gap）；
 *   - 一次 discovery 可写多个 option（聚合）；
 *   - close/restore 失败（非 COMPLETED_CLEANLY）不晋升；
 *   - 状态上限 dom_verified（OPTION_EXISTS）；绝不写 execution_verified / OPTION_EFFECT_VERIFIED；
 *   - 去重：已存在同 optionValue 的 option 不再重复写。
 */

export type OptionTier = "OPTION_EXISTS" | "OPTION_SELECTABLE" | "OPTION_EFFECT_VERIFIED";

export interface OptionPromotionResult {
  ok: boolean;
  action: "appended_options" | "noop" | "skipped" | "error";
  parentElementId: string;
  addedOptions: number;
  skippedOptions: number;
  reason?: string;
  backupPath?: string;
}

/** 从 exploration run 提取发现的 option 文本（去重、清洗）。 */
export function extractOptionsFromRun(run: ExplorationRun): string[] {
  const samples: string[] = [];
  for (const observation of run.observations) {
    const optionSamples = (observation as Record<string, unknown>).optionSamples;
    if (Array.isArray(optionSamples)) samples.push(...optionSamples.map(String));
  }
  return [...new Set(
    samples
      .map((s) => s.replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .filter((s) => s.length <= 40)
  )].slice(0, 40);
}

/** 是否 option_discovery run 且成功。 */
export function isOptionDiscoveryRun(run: ExplorationRun): boolean {
  return run.heuristicId === "select.option_discovery" && run.status === "COMPLETED_CLEANLY";
}

/**
 * 把发现的 options 写回 Page Model（受控写回：backup + verificationHistory + 溯源）。
 * parentElementId 未建模时跳过（不自动新建父控件）。
 */
export async function promoteDiscoveredOptions(rootDir: string, project: string, input: {
  pageId: string;
  parentElementId: string;
  options: string[];
  sourceRunId?: string;
  sourceGapId?: string;
  heuristicVersion?: number;
  /** P8.8：触发控件当前显示文本（用于过滤"当前选中值/占位符"被当成 option 的污染）。 */
  triggerDisplayText?: string;
}): Promise<OptionPromotionResult> {
  if (!input.options.length) {
    return { ok: false, action: "skipped", parentElementId: input.parentElementId, addedOptions: 0, skippedOptions: 0, reason: "无 option" };
  }
  const storePath = path.join(rootDir, "storage", "page-models", `${project}.json`);
  if (!(await fs.pathExists(storePath))) {
    return { ok: false, action: "error", parentElementId: input.parentElementId, addedOptions: 0, skippedOptions: 0, reason: "page-model store 不存在" };
  }
  const store = await fs.readJson(storePath) as Record<string, unknown>;
  const models = Array.isArray(store.models) ? store.models as Array<Record<string, unknown>> : [];
  const model = models.find((m) => String(m.pageId) === input.pageId);
  if (!model) {
    return { ok: false, action: "error", parentElementId: input.parentElementId, addedOptions: 0, skippedOptions: 0, reason: `页面 ${input.pageId} 未建模` };
  }
  const elements = Array.isArray(model.elements) ? model.elements as Array<Record<string, unknown>> : [];
  const parent = elements.find((el) => String(el.elementId) === input.parentElementId);
  if (!parent) {
    return { ok: false, action: "skipped", parentElementId: input.parentElementId, addedOptions: 0, skippedOptions: 0, reason: `父控件 ${input.parentElementId} 未建模，不自动新建` };
  }
  const base = String(model.pageId ?? "").split(".").slice(1).join(".");
  const existingValues = new Set(
    elements
      .filter((el) => String(el.controlType) === "dropdown_option" && String(el.parentElementId) === input.parentElementId)
      .map((el) => String(el.optionValue ?? ""))
  );

  // P8.8/P8.10：构建 option identity（分离父语义，过滤 trigger 显示值污染，记录 coverage mode）。
  const captureCtx: OptionCaptureContext = {
    triggerDisplayText: input.triggerDisplayText,
    popupContainers: [],
    rawOptionTexts: input.options,
    captureMechanism: "portal_delta",
    scrolledToEnd: false
  };

  const beforeHash = crypto.createHash("sha256").update(JSON.stringify(store)).digest("hex").slice(0, 16);
  let added = 0;
  let skipped = 0;
  for (const rawText of input.options) {
    const identity = buildOptionIdentity(input.parentElementId, rawText, captureCtx);
    if (identity.optionValue === undefined || identity.status !== "dom_verified") {
      skipped += 1; // 当前值/占位符/噪音 → 不写回
      continue;
    }
    const text = identity.optionValue;
    if (existingValues.has(text)) {
      skipped += 1;
      continue;
    }
    const optionId = `${base}.${input.parentElementId.split(".").pop()}.option.${text.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, "_")}`;
    const optionElement: Record<string, unknown> = {
      elementId: optionId,
      pageId: input.pageId,
      semanticName: `${identity.visibleText} 选项`, // P8.8：<visibleText> 选项，不含父级/当前值
      semanticRole: "filter_option",
      role: "option",
      controlType: "dropdown_option",
      targetField: String(parent.targetField ?? "asset"),
      optionValue: text,
      parentElementId: input.parentElementId,
      region: String(parent.region ?? "dropdown_layer"),
      status: "dom_verified", // P6.2-2：OPTION_EXISTS 层（DOM 观察）
      optionTier: "OPTION_EXISTS",
      coverageMode: "PARTIAL", // P8.10：portal_delta 未确认滚动到底 → PARTIAL
      locatorCandidates: [
        { strategy: "role_option", value: text, confidence: 0.7, source: "controlled_exploration_option_discovery" },
        { strategy: "text_exact", value: `textExact=${text}`, confidence: 0.6, source: "visible_text" }
      ],
      sourceCaptureRun: input.sourceRunId ?? "exploration",
      verificationHistory: [{
        promotedAt: new Date().toISOString(),
        policyId: "interaction.v1",
        policyVersion: input.heuristicVersion ?? 1,
        knowledgeType: "INTERACTION",
        action: "option_discovery_promotion",
        optionTier: "OPTION_EXISTS",
        evidenceIds: [input.sourceRunId ?? ""].filter(Boolean),
        sourceGapId: input.sourceGapId,
        observedOptions: [text]
      }],
      ingestedAt: new Date().toISOString()
    };
    elements.push(optionElement);
    existingValues.add(text);
    added += 1;
  }
  if (!added) {
    return { ok: true, action: "noop", parentElementId: input.parentElementId, addedOptions: 0, skippedOptions: skipped, reason: "全部 option 已存在（幂等）" };
  }
  model.elements = elements;
  model.updatedAt = new Date().toISOString();

  const backupDir = path.join(rootDir, "storage", "page-models");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const backupPath = path.join(backupDir, `backup-${project}-pre-option-promotion-${timestamp}.json`);
  if (!(await fs.pathExists(backupPath))) await fs.writeFile(backupPath, JSON.stringify(store, null, 2) + "\n");

  await writeSafeJsonFile(storePath, store);
  logger.info("Dropdown options promoted", { pageId: input.pageId, parentElementId: input.parentElementId, added, skipped, tier: "OPTION_EXISTS" });

  return {
    ok: true,
    action: "appended_options",
    parentElementId: input.parentElementId,
    addedOptions: added,
    skippedOptions: skipped,
    backupPath: path.relative(rootDir, backupPath).replace(/\\/g, "/")
  };
}
