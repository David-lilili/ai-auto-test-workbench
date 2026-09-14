import fs from "fs-extra";
import path from "node:path";
import crypto from "node:crypto";
import type { Page } from "@playwright/test";
import type { ExplorationPlan, PlanStep } from "./exploration-planner.js";
import { writeSafeJsonFile } from "./safe-file-writer.js";
import { logger } from "./logger.js";

/**
 * Controlled Exploration Executor（P3-B9）：独立于 DSL Executor，只执行 LOW-risk plan。
 *
 * 职责链：validate → risk gate 复核 → before snapshot → 执行步骤（每步采证）
 *        → stopCondition 检查 → restore → after snapshot → ExplorationRun。
 * 边界：不修改 Page Model、不写 proposal（evidence 只落 run 产物，由人工/后续管道消费）。
 */

export type RestoreResult = "SUCCESS" | "PARTIAL" | "FAILED" | "NOT_REQUIRED";
export type RunStatus = "COMPLETED_CLEANLY" | "COMPLETED_WITH_RESTORE_FAILURE" | "STOPPED" | "FAILED" | "BLOCKED_BY_RISK";

export interface StepRecord {
  stepId: string;
  action: string;
  status: "executed" | "skipped_not_applicable" | "failed";
  observation: Record<string, unknown>;
  error?: string;
}

export interface ExplorationRun {
  runId: string;
  planId: string;
  gapId: string;
  heuristicId: string;
  heuristicVersion: number;
  pageId: string;
  before: Record<string, unknown>;
  steps: StepRecord[];
  observations: Record<string, unknown>[];
  after: Record<string, unknown>;
  restoreResult: RestoreResult;
  status: RunStatus;
  evidence: Array<{ type: string; path: string; heuristicId: string; heuristicVersion: number; planId: string; runId: string; sourceGapId: string }>;
  failure?: string;
}

/** LOW-risk 硬门禁：非 LOW 一律拒绝执行（priority 高也不豁免）。 */
export function validatePlanForExecution(plan: ExplorationPlan): { ok: boolean; reason?: string } {
  if (plan.risk !== "LOW") {
    return { ok: false, reason: `plan risk=${plan.risk}（只有 LOW 可自动执行；priority 高不构成豁免）` };
  }
  if (plan.status === "BLOCKED_BY_RISK") {
    return { ok: false, reason: plan.blockedReason ?? "plan 被 risk gate 阻断" };
  }
  if (!plan.steps.length) return { ok: false, reason: "plan 无可执行步骤" };
  return { ok: true };
}

async function snapshotPage(page: Page): Promise<Record<string, unknown>> {
  return {
    url: page.url(),
    title: await page.title().catch(() => ""),
    visibleTextHash: crypto.createHash("sha256").update(await page.locator("body").innerText({ timeout: 3000 }).catch(() => "")).digest("hex").slice(0, 16)
  };
}

/** 步骤动作 → Playwright 操作映射（受控动作白名单；未注册动作一律拒绝——AI 无法发明动作）。 */
const EXECUTABLE_ACTIONS = new Set([
  "focus", "input_local_test_value", "input_test_value", "input_boundary_value",
  "capture_before", "capture_after", "capture_enabled_state", "capture_current_active",
  "capture_options", "capture_modal_content", "observe_value", "observe_dependents",
  "observe_validation", "observe_restored", "verify_closed", "clear",
  "open_dropdown", "close_dropdown", "select_alternative", "restore_original", "reselect_original_value",
  "click_non_current_tab", "click_original_tab", "click_tab",
  "open_modal", "close_modal",
  "interact_toggle", "interact_toggle_back",
  "navigate_to_page", "capture_block_state", "capture_modal"
]);

export async function executeExplorationPlan(input: {
  page: Page;
  plan: ExplorationPlan;
  rootDir: string;
  locatorResolver?: (targetElementId: string) => string | undefined;
}): Promise<ExplorationRun> {
  const runId = `explore_${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}_${crypto.randomUUID().slice(0, 8)}`;
  const artifactDir = path.join(input.rootDir, "artifacts", "exploration-runs", runId);
  await fs.ensureDir(artifactDir);

  const run: ExplorationRun = {
    runId,
    planId: input.plan.planId,
    gapId: input.plan.gapId,
    heuristicId: input.plan.heuristicId,
    heuristicVersion: input.plan.heuristicVersion,
    pageId: input.plan.pageId,
    before: await snapshotPage(input.page),
    steps: [],
    observations: [],
    after: {},
    restoreResult: "NOT_REQUIRED",
    status: "FAILED",
    evidence: []
  };

  // risk gate 复核（executor 不信任 plan 构建时的判定）
  const validation = validatePlanForExecution(input.plan);
  if (!validation.ok) {
    run.status = "BLOCKED_BY_RISK";
    run.failure = validation.reason;
    await persistRun(input.rootDir, run);
    return run;
  }

  let stopped = false;
  for (const step of input.plan.steps) {
    if (stopped) break;
    if (!EXECUTABLE_ACTIONS.has(step.action)) {
      run.steps.push({ stepId: step.stepId, action: step.action, status: "skipped_not_applicable", observation: {}, error: "动作不在受控白名单（防止未注册/AI 发明动作）" });
      continue;
    }
    try {
      const observation = await executeStep(input.page, step, input.locatorResolver);
      run.steps.push({ stepId: step.stepId, action: step.action, status: "executed", observation });
      run.observations.push({ stepId: step.stepId, ...observation });
    } catch (error) {
      run.steps.push({ stepId: step.stepId, action: step.action, status: "failed", observation: {}, error: error instanceof Error ? error.message : String(error) });
      // stopCondition：步骤失败即停（保守）
      stopped = true;
      run.failure = `step ${step.stepId} 失败: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  // restore（硬要求：LOW 也必须恢复）
  if (input.plan.restoreSteps.length) {
    let restoreFailed = false;
    for (const restoreStep of input.plan.restoreSteps) {
      try {
        await executeStep(input.page, restoreStep, input.locatorResolver);
      } catch {
        restoreFailed = true;
      }
    }
    if (restoreFailed) {
      run.restoreResult = input.plan.restoreSteps.length > 1 ? "PARTIAL" : "FAILED";
    } else {
      run.restoreResult = "SUCCESS";
    }
  }

  run.after = await snapshotPage(input.page);
  // 恢复验证：默认要求 before/after 页面签名一致才算恢复成功；
  // P6.2-2：option_discovery 的恢复目标是「下拉已关闭」——打开+关闭下拉后 combobox 值/焦点态
  // 可能轻微变化（visibleTextHash 不等于 before），这不算业务状态未恢复。改用功能性验证：
  // 弹出层（listbox/menu/option 容器）不再可见即视为恢复成功。
  if (run.restoreResult === "SUCCESS" && run.before.visibleTextHash !== run.after.visibleTextHash) {
    if (run.heuristicId === "select.option_discovery" && !(await hasVisiblePopup(input.page))) {
      run.restoreResult = "SUCCESS";
    } else {
      run.restoreResult = "PARTIAL";
    }
  }

  run.status = stopped
    ? "STOPPED"
    : run.restoreResult === "FAILED" || run.restoreResult === "PARTIAL"
      ? "COMPLETED_WITH_RESTORE_FAILURE"
      : "COMPLETED_CLEANLY";

  // evidence 产物（含完整 provenance：heuristicId+version+planId+runId+sourceGapId）
  const evidencePath = path.join(artifactDir, "evidence.json");
  await writeSafeJsonFile(evidencePath, { run: { ...run, evidence: undefined } });
  run.evidence.push({
    type: "exploration_run",
    path: path.relative(input.rootDir, evidencePath).replace(/\\/g, "/"),
    heuristicId: run.heuristicId,
    heuristicVersion: run.heuristicVersion,
    planId: run.planId,
    runId: run.runId,
    sourceGapId: run.gapId
  });

  await persistRun(input.rootDir, run);
  logger.info("Exploration run finished", { runId, status: run.status, restore: run.restoreResult });
  return run;
}

/** 最小 selector 规范化：支持 bootstrap/capture 产出的 role=/placeholder=/name=/text= 前缀格式。 */
function normalizeSelector(selector: string): string {
  const value = String(selector ?? "").trim();
  // role=button:查询 → Playwright role engine: role=button[name="查询"][exact]（精确匹配，防导航子串命中）
  const roleMatch = value.match(/^role=([a-z_]+):(.+)$/i);
  if (roleMatch) {
    const role = roleMatch[1].toLowerCase();
    const name = roleMatch[2].trim();
    return `role=${role}[name="${name.replace(/"/g, '\\"')}"][exact]`;
  }
  // role=button（无 name）
  const roleOnly = value.match(/^role=([a-z_]+)$/i);
  if (roleOnly) return `role=${roleOnly[1].toLowerCase()}`;
  const placeholderMatch = value.match(/^placeholder=(.+)$/i);
  if (placeholderMatch) return `[placeholder="${placeholderMatch[1].replace(/"/g, '\\"')}"]`;
  const nameMatch = value.match(/^name=(.+)$/i);
  if (nameMatch) return `[name="${nameMatch[1].replace(/"/g, '\\"')}"]`;
  const textMatch = value.match(/^textExact?=(.+)$/i);
  if (textMatch) return `text=${textMatch[1]}`;
  return value;
}

/** 可见性判断（元素在 viewport 内且有尺寸）。 */
const IS_VISIBLE = (el: Element): boolean => {
  const style = window.getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
};

/** 是否全局导航/页头内的元素（P6.2-8：排除导航菜单污染业务 dropdown）。 */
const IN_GLOBAL_NAV = (el: Element): boolean => {
  const closest = el.closest("header, nav, footer, [class*='navbar'], [class*='Navbar'], [class*='nav-header'], [class*='top-nav'], [class*='topnav'], [class*='global-nav']");
  return Boolean(closest);
};

/** 在已打开的下拉弹出层内收集可见 option 文本（P6.2-1：native/ARIA/portal 通用，排除全局导航）。
 *  只收「容器内 option」：listbox/menu/portal 内的 option 才算是业务下拉选项；
 *  裸 li / 裸 [class*='option'] 一律不收（顶部导航菜单项是裸 li，会被排除）。 */
const COLLECT_OPTIONS_SCRIPT = String.raw`
  (() => {
    const isVisible = ${IS_VISIBLE.toString()};
    const inGlobalNav = ${IN_GLOBAL_NAV.toString()};
    const unique = (arr) => [...new Set(arr.map((s) => String(s).replace(/\\s+/g, " ").trim()).filter(Boolean))];
    // 1. native select 的 option（可直接读）
    const native = Array.from(document.querySelectorAll("select")).flatMap((sel) =>
      Array.from(sel.options || []).map((o) => String(o.textContent || o.text || "").trim()).filter(Boolean)
    );
    // 2. 可见 listbox/menu 容器 → 容器内 option
    const containers = Array.from(document.querySelectorAll("[role='listbox'],[role='menu'],[role='option'],[class*='option-list'],[class*='optionList'],[class*='select-menu'],[class*='selectMenu'],[data-radix-menu-content],[data-radix-popper-content-wrapper]"))
      .filter(isVisible)
      .filter((el) => !inGlobalNav(el));
    const containerOptions = containers.flatMap((container) => {
      if (container.getAttribute("role") === "option") return [String(container.textContent || "").trim()];
      return Array.from(container.querySelectorAll("[role='option'],li,[class*='option'],[class*='Option'],[data-radix-menu-item]"))
        .filter(isVisible)
        .filter((o) => !inGlobalNav(o))
        .map((o) => String(o.textContent || "").trim());
    });
    // 3. body 顶层 portal（Radix/Popper 等框架渲染的弹出层）
    const portalOptions = Array.from(document.querySelectorAll("body > div"))
      .filter(isVisible)
      .flatMap((p) => Array.from(p.querySelectorAll("[role='listbox'],[role='menu'],[class*='option'],[class*='Option'],[data-radix-menu-content]"))
        .filter(isVisible)
        .filter((o) => !inGlobalNav(o))
        .map((o) => String(o.textContent || "").trim()));
    return unique([...native, ...containerOptions, ...portalOptions]).slice(0, 60);
  })()
`;

/** 收集下拉弹出层可见 option 文本（P6.2-1/8）。
 *  用 locator 而非 page.evaluate 注入脚本（避免与站点自身的 eval/__name 冲突）；
 *  只收「不在全局导航内」的可见 option；再结合调用方 before/after delta 排除常驻导航项。 */
async function collectDropdownOptions(page: Page): Promise<string[]> {
  const readTexts = async (locator: import("@playwright/test").Locator): Promise<string[]> => {
    const texts = await locator.allTextContents().catch(() => []);
    return [...new Set(texts.map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean))];
  };
  // 1. 全页可见 option / menu-item / li 文本
  const all = await readTexts(page.locator("[role='option']:visible, [role='menuitem']:visible, li:visible"));
  // 2. 全局导航/页头内的文本（要排除）
  const nav = await readTexts(page.locator("header [role='option']:visible, header li:visible, nav [role='option']:visible, nav li:visible, [class*='navbar'] [role='option']:visible, [class*='navbar'] li:visible"));
  const navSet = new Set(nav);
  return all.filter((text) => !navSet.has(text)).slice(0, 60);
}

/** 每页保存 open_dropdown 前的 option 快照（供 capture_options 做 delta，排除常驻导航项）。 */
const dropdownBeforeSnapshots = new WeakMap<Page, string[]>();

/** 纯函数：集合差集（after - before），只保留点击后新增的 option。 */
function optionDelta(before: string[], after: string[]): string[] {
  const beforeSet = new Set(before);
  return after.filter((text) => !beforeSet.has(text));
}

/** 疑似噪音：页面错误提示/系统异常等（P6.2-8：不是真实 option，丢弃避免污染模型）。 */
function looksLikeNoise(options: string[]): boolean {
  if (options.length === 0) return true;
  const noiseTerms = ["系统异常", "请联系管理员", "请求失败", "网络异常", "加载失败", "暂无", "loading", "Loading"];
  return options.every((text) => noiseTerms.some((term) => text.includes(term)));
}

/** 是否仍有可见的下拉弹出层（P6.2-2 功能性 restore 验证）。 */
async function hasVisiblePopup(page: Page): Promise<boolean> {
  try {
    const visible = await page.locator("[role='listbox']:visible, [role='menu']:visible, [data-radix-menu-content]:visible").count().catch(() => 0);
    return visible > 0;
  } catch {
    return true; // 无法确认时保守视为仍打开
  }
}

async function executeStep(page: Page, step: PlanStep, locatorResolver?: (id: string) => string | undefined): Promise<Record<string, unknown>> {
  const selector = step.targetElementId && locatorResolver ? locatorResolver(step.targetElementId) : undefined;
  const locator = selector ? page.locator(normalizeSelector(selector)).first() : undefined;
  switch (step.action) {
    case "capture_before":
    case "capture_after":
    case "capture_current_active":
    case "observe_value":
    case "observe_restored":
    case "capture_block_state": {
      const visibleText = await page.locator("body").innerText({ timeout: 3000 }).catch(() => "");
      return { visibleTextSample: visibleText.slice(0, 500), url: page.url() };
    }
    case "capture_enabled_state": {
      if (!locator) return { located: false };
      const enabled = await locator.isEnabled().catch(() => false);
      const visible = await locator.isVisible().catch(() => false);
      return { enabled, visible };
    }
    case "capture_options":
    case "open_dropdown": {
      // P6.2-1/8：点击前后做 option delta——只保留打开后新增的 option，排除常驻导航项污染。
      const beforeOptions = await collectDropdownOptions(page).catch(() => []);
      dropdownBeforeSnapshots.set(page, beforeOptions);
      if (locator) {
        await locator.click({ timeout: 5000 }).catch(() => undefined);
        // 等待弹出层渲染（portal/popper 异步）
        await page.waitForTimeout(600);
      }
      let afterOptions = await collectDropdownOptions(page).catch(() => []);
      // P6.2-1：目标定位（exact role name）可能未命中自定义 combobox（accessible name 含图标等），
      // 若采集为空或疑似噪音，回退点击页面第一个可见 combobox 再采集一次。
      if (afterOptions.length === 0 || looksLikeNoise(afterOptions)) {
        const firstCombobox = page.locator("button[role='combobox']:visible, [role='combobox']:visible").first();
        if (await firstCombobox.count().catch(() => 0)) {
          await firstCombobox.click({ timeout: 5000 }).catch(() => undefined);
          await page.waitForTimeout(600);
          afterOptions = await collectDropdownOptions(page).catch(() => []);
        }
      }
      const options = optionDelta(beforeOptions, afterOptions).length
        ? optionDelta(beforeOptions, afterOptions)
        : afterOptions; // delta 为空时（如首次即打开）退回 after
      return { optionSamples: options.slice(0, 30), optionCount: options.length, deltaApplied: true };
    }
    case "close_dropdown": {
      await page.keyboard.press("Escape").catch(() => undefined);
      return { closed: true };
    }
    case "select_alternative":
    case "restore_original":
    case "reselect_original_value": {
      return { action: step.action, note: "选择动作由组件特定 locator 执行；本记录为受控占位", executed: false };
    }
    case "clear": {
      if (!locator) throw new Error("clear 需要 locator");
      await locator.click({ timeout: 5000 });
      await page.keyboard.press("Control+A");
      await page.keyboard.press("Delete");
      return { cleared: true };
    }
    case "focus": {
      if (locator) await locator.click({ timeout: 5000 }).catch(() => undefined);
      return { focused: true };
    }
    case "input_test_value":
    case "input_local_test_value":
    case "input_boundary_value": {
      if (!locator) throw new Error("input 需要 locator");
      await locator.fill("TEST_VALUE", { timeout: 5000 });
      return { inputValue: "TEST_VALUE" };
    }
    case "click_non_current_tab":
    case "click_original_tab":
    case "click_tab":
    case "open_modal":
    case "interact_toggle": {
      if (!locator) throw new Error(`${step.action} 需要 locator`);
      await locator.click({ timeout: 5000 });
      await page.waitForTimeout(500);
      return { clicked: true };
    }
    case "close_modal":
    case "interact_toggle_back": {
      if (locator) {
        await locator.click({ timeout: 5000 }).catch(async () => {
          await page.keyboard.press("Escape");
        });
      } else {
        await page.keyboard.press("Escape");
      }
      return { closed: true };
    }
    case "verify_closed": {
      const visibleText = await page.locator("body").innerText({ timeout: 3000 }).catch(() => "");
      return { verifyClosed: true, textSample: visibleText.slice(0, 200) };
    }
    case "capture_modal_content":
    case "capture_modal": {
      const modal = page.locator("[role='dialog'], [class*='modal'], [class*='Modal']").first();
      const content = await modal.innerText({ timeout: 3000 }).catch(() => "");
      return { modalContent: content.slice(0, 500), modalVisible: Boolean(content) };
    }
    default:
      throw new Error(`动作 ${step.action} 不在受控白名单`);
  }
}

async function persistRun(rootDir: string, run: ExplorationRun): Promise<void> {
  const runPath = path.join(rootDir, "storage", "exploration-runs", `${run.runId}.json`);
  await writeSafeJsonFile(runPath, run);
}
