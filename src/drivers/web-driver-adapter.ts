import crypto from "node:crypto";
import path from "node:path";
import type { Browser, Locator, Page } from "@playwright/test";
import fs from "fs-extra";
import type { DriverAdapter, VisualTargetCandidate } from "../core/driver-adapter.js";
import type { BootstrapInteractiveElement, DslAssertion, LoadedContext, PageState } from "../core/types.js";
import { matchSemanticLocators, type SemanticLocatorCandidate } from "../core/semantic-locator-matcher.js";
import { launchBrowserRuntime, resolveBrowserRuntimeConfig, type BrowserRuntimeSession } from "../core/browser-runtime.js";

export class WebDriverAdapter implements DriverAdapter {
  private pageModelTableContracts?: PageModelDataTableContract[];

  private constructor(
    private readonly context: LoadedContext,
    private readonly runtime: BrowserRuntimeSession,
    private readonly page: Page
  ) {}

  static async launch(context: LoadedContext, headed: boolean, options?: WebDriverLaunchOptions): Promise<WebDriverAdapter> {
    const runtime = await launchBrowserRuntime(resolveBrowserRuntimeConfig({
      headed,
      extraHTTPHeaders: options?.extraHTTPHeaders,
      authToken: options?.authToken,
      recordVideoDir: options?.recordVideoDir
    }));
    const browserContext = runtime.context;
    const page = await browserContext.newPage();
    return new WebDriverAdapter(context, runtime, page);
  }

  async getCurrentPageState(): Promise<PageState> {
    const url = this.page.url();
    const title = await this.page.title().catch(() => "");
    const dom = await this.getDomOrPageSource().catch(() => "");
    const controls = await this.readControlSummary().catch(() => []);
    const textSnippets = await this.readVisibleTextSnippets().catch(() => []);
    return {
      page_id: signature([this.context.project.projectKey, "web", normalizeUrl(url), title]),
      project_id: this.context.project.projectKey,
      platform: "web",
      page_name: title || normalizeUrl(url),
      url_pattern: normalizeUrl(url),
      title,
      dom_signature: signature([dom.slice(0, 20_000)]),
      known_elements: [
        ...controls.map((item) => item.selector ?? item.text ?? item.placeholder ?? "").filter(Boolean),
        ...textSnippets.map((item) => `text=${item}`)
      ],
      outgoing_transitions: [],
      visit_count: 1,
      confidence_score: 0.5,
      last_seen_at: new Date().toISOString()
    };
  }

  async getDomOrPageSource(): Promise<string> {
    return this.page.content();
  }

  async getAccessibilityTree(): Promise<unknown> {
    return { text: await this.page.locator("body").evaluate((body) => (body as HTMLElement).innerText.slice(0, 10_000)), controls: await this.readControlSummary() };
  }

  async takeScreenshot(filePath?: string): Promise<string | Buffer> {
    if (filePath) {
      await this.page.screenshot({ path: filePath, fullPage: true });
      return filePath;
    }
    return this.page.screenshot({ fullPage: true });
  }

  async findElement(locator: string, timeoutMs = 5_000): Promise<Locator> {
    const item = locator.startsWith("rowScoped=")
      ? await this.resolveRowScopedLocator(locator, timeoutMs)
      : this.resolveLocator(locator).first();
    await item.waitFor({ state: "visible", timeout: timeoutMs });
    return item;
  }

  async click(target: string): Promise<void> {
    const timeoutMs = target.startsWith("rowScoped=") ? 15_000 : 5_000;
    await (await this.findElement(target, timeoutMs)).click();
  }

  async input(target: string, text: string): Promise<void> {
    const item = target.startsWith("fieldRelative=")
      ? await this.resolveFieldRelativeLocator(target, "input")
      : await this.findElement(target);
    await item.fill(text);
    await dispatchInputEvents(item);
    if (await locatorValueEquals(item, text)) return;

    await item.click();
    await this.page.keyboard.press("Control+A");
    await this.page.keyboard.type(text);
    await dispatchInputEvents(item);
    if (await locatorValueEquals(item, text)) return;

    throw new Error("Input value did not persist after fill/type.");
  }

  async setDateRange(target: string, value: unknown, options?: { timeoutMs?: number }): Promise<Record<string, unknown>> {
    const range = normalizeDateRangeInput(value);
    if (!range.start || !range.end) throw new Error(`Date range action requires start and end values. Received: ${JSON.stringify(value)}`);
    const timeoutMs = Math.max(3_000, options?.timeoutMs ?? 5_000);
    const trace: Record<string, unknown> = {
      action: "setDateRange",
      target,
      start: range.start,
      end: range.end,
      opened: false,
      strategy: undefined,
      verified: false
    };
    try {
      const trigger = await this.resolveDateRangeTrigger(target, timeoutMs);
      trace.valueBefore = await displayValueOf(trigger).catch(() => undefined);
      trace.opened = await this.openDateRangePopup(trigger, timeoutMs, trace);
      await this.page.waitForTimeout(200);

      const popupInputs = this.visibleDateRangeInputs();
      if (await popupInputs.first().isVisible({ timeout: Math.min(timeoutMs, 2_000) }).catch(() => false)) {
        const count = await popupInputs.count().catch(() => 0);
        const startInput = popupInputs.nth(0);
        const endInput = popupInputs.nth(Math.min(1, Math.max(0, count - 1)));
        await fillDateInput(startInput, range.start);
        await fillDateInput(endInput, range.end);
        trace.strategy = "popup_inputs";
        trace.inputCount = count;
        await this.confirmActiveDatePicker(timeoutMs, trace);
      } else if (await this.tryCalendarDateRangeSelection(range, timeoutMs, trace)) {
        trace.strategy = "calendar_buttons";
        await this.confirmActiveDatePicker(timeoutMs, trace);
      } else {
        const rangeText = `${datePart(range.start)} - ${datePart(range.end)}`;
        await trigger.click();
        await this.page.keyboard.press("Control+A");
        await this.page.keyboard.type(rangeText);
        await this.page.keyboard.press("Enter");
        trace.strategy = "trigger_keyboard";
        trace.typed = rangeText;
      }

      await this.page.waitForTimeout(300);
      const valueAfter = await displayValueOf(trigger).catch(() => "");
      trace.valueAfter = valueAfter;
      trace.verified = dateRangeDisplayMatches(valueAfter, range) || Boolean(trace.confirmed);
      if (!trace.verified) {
        const visibleText = await this.page.locator("body").evaluate((body) => (body as HTMLElement).innerText || "").catch(() => "");
        trace.visibleTextSample = visibleText.slice(0, 600);
        throw actionExecutionError(`Date range value was not applied. Expected ${range.start} to ${range.end}, observed ${valueAfter || "empty"}.`, trace);
      }
      return trace;
    } catch (error) {
      if (isActionExecutionError(error)) throw error;
      trace.innerError = error instanceof Error ? error.message : String(error);
      throw actionExecutionError(`Date range action failed. Expected ${range.start} to ${range.end}.`, trace);
    }
  }

  async selectDropdownOption(target: string, value: string, options?: { component?: unknown; postconditions?: unknown; timeoutMs?: number }): Promise<Record<string, unknown>> {
    const expected = value.trim();
    if (!expected) throw new Error("Dropdown select requires a non-empty value.");
    const timeoutMs = Math.max(3_000, options?.timeoutMs ?? 5_000);
    const trace: Record<string, unknown> = {
      action: "selectDropdownOption",
      target,
      expected,
      opened: false,
      matchedOption: undefined,
      selectedValueAfter: undefined,
      verified: false
    };
    const trigger = await this.resolveDropdownTrigger(target, options?.component, timeoutMs, trace);
    trace.valueBefore = await displayValueOf(trigger).catch(() => undefined);
    await trigger.click();
    trace.opened = true;
    let popup = await this.waitForDropdownPopup(expected, timeoutMs);
    if (!popup.materialized) {
      trace.reopenAttempted = true;
      await trigger.click().catch(() => undefined);
      popup = await this.waitForDropdownPopup(expected, Math.min(timeoutMs, 2_000));
    }
    trace.popupMaterialized = popup.materialized;
    trace.popupSignals = popup.signals;

    const exactOption = this.resolveDropdownOptionLocator(expected, true).last();
    const partialOption = this.resolveDropdownOptionLocator(expected, false).last();
    if (await exactOption.isVisible({ timeout: Math.min(timeoutMs, 2_000) }).catch(() => false)) {
      await exactOption.click();
      trace.matchedOption = { strategy: "dropdown_option_exact", text: expected };
    } else if (popup.materialized && await partialOption.isVisible({ timeout: Math.min(timeoutMs, 2_000) }).catch(() => false)) {
      await partialOption.click();
      trace.matchedOption = { strategy: "dropdown_option_partial", text: expected };
    } else if (await this.trySearchDropdownOption(expected, options?.component, timeoutMs, trace)) {
      trace.matchedOption = { strategy: "search_input_exact_option", text: expected };
    } else {
      trace.visibleTexts = await this.readVisibleTextSnippets().catch(() => []);
      if (!popup.materialized) trace.rootCause = "dropdown_popup_not_materialized";
      throw actionExecutionError(`Dropdown option was not found. Expected ${expected}.`, trace);
    }

    await this.page.waitForTimeout(250);
    await this.page.locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden),[role='listbox']").first().waitFor({ state: "hidden", timeout: 1_000 }).catch(() => undefined);
    const selected = await this.readDropdownSelectedValue(trigger, expected);
    trace.selectedValueAfter = selected.value;
    trace.selectedValueSamples = selected.samples;
    trace.selectedValueReadStrategy = selected.strategy;
    trace.verified = dropdownDisplayMatches(selected.value, expected);
    if (!trace.verified) {
      throw actionExecutionError(`Dropdown value was not applied. Expected ${expected}, observed ${selected.value || "empty"}.`, trace);
    }
    return trace;
  }

  private async readDropdownSelectedValue(trigger: Locator, expected: string): Promise<{ value: string; samples: string[]; strategy: string }> {
    const triggerValue = await quickDisplayValueOf(trigger).catch(() => "");
    const samples = [triggerValue].filter(Boolean);
    if (dropdownDisplayMatches(triggerValue, expected)) return { value: triggerValue, samples, strategy: "trigger_display" };

    const rootValue = await withShortTimeout(trigger.evaluate((element) => {
        const root = element.closest(".ant-select,[data-slot='select-trigger'],[role='combobox']") ?? element.parentElement;
        const nodes = root
          ? Array.from(root.querySelectorAll([
            ".ant-select-selection-item",
            ".ant-select-selection-search-input",
            "[data-slot='select-value']",
            "[aria-selected='true']"
          ].join(",")))
          : [];
        const values = nodes.map((node) => {
          const input = node as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
          const value = "value" in input ? input.value : "";
          const text = (node.textContent || "").replace(/\s+/g, " ").trim();
          const title = node.getAttribute("title") ?? "";
          const aria = node.getAttribute("aria-label") ?? "";
          return [value, text, title, aria].filter(Boolean).join(" ").trim();
        }).filter(Boolean);
        const rootText = root ? (root.textContent || "").replace(/\s+/g, " ").trim() : "";
        return [...values, rootText].filter(Boolean).join(" ").trim();
      }), 800, "")
      .catch(() => "");
    if (rootValue) samples.push(rootValue);
    if (dropdownDisplayMatches(rootValue, expected)) return { value: rootValue, samples, strategy: "component_root" };

    const activeLocator = this.page.locator([
      ".ant-select-focused .ant-select-selection-item",
      ".ant-select .ant-select-selection-item[title]",
      "[role='option'][aria-selected='true']",
      ".ant-select-item-option-selected"
    ].join(",")).last();
    const activeValue = await activeLocator.isVisible({ timeout: 500 }).catch(() => false)
      ? await quickDisplayValueOf(activeLocator, 500).catch(() => "")
      : "";
    if (activeValue) samples.push(activeValue);
    if (dropdownDisplayMatches(activeValue, expected)) return { value: activeValue, samples, strategy: "active_selected_option" };

    const filterRegionValue = await this.readDropdownValueFromFilterRegion(expected).catch(() => "");
    if (filterRegionValue) samples.push(filterRegionValue);
    if (dropdownDisplayMatches(filterRegionValue, expected)) return { value: filterRegionValue, samples, strategy: "visible_filter_region" };

    return { value: samples.find((item) => item.trim()) ?? "", samples, strategy: "unmatched_samples" };
  }

  private async readDropdownValueFromFilterRegion(expected: string): Promise<string> {
    const lines = await this.readVisibleTextSnippets();
    const filterLines = lines.slice(0, firstTableHeaderRunStart(lines));
    const expectedIndex = filterLines.findIndex((line) => normalizeAssertionCell(line) === normalizeAssertionCell(expected));
    if (expectedIndex < 0) return "";
    const afterExpected = filterLines.slice(expectedIndex + 1, expectedIndex + 4);
    const beforeExpected = filterLines.slice(Math.max(0, expectedIndex - 3), expectedIndex);
    if ([...afterExpected, ...beforeExpected].some((line) => /^(查询|重置|搜索|筛选|Search|Reset)$/i.test(line.trim()))) return expected;
    return "";
  }

  private async trySearchDropdownOption(expected: string, component: unknown, timeoutMs: number, trace: Record<string, unknown>): Promise<boolean> {
    const searchInput = readComponentSearchInput(component);
    const input = searchInput
      ? this.resolveLocator(searchInput).last()
      : this.resolveActiveDropdownSearchInput().last();
    if (!(await input.isVisible({ timeout: Math.min(timeoutMs, 1_500) }).catch(() => false))) {
      const fallbackInput = searchInput ? this.resolveActiveDropdownSearchInput().last() : undefined;
      if (!fallbackInput || !(await fallbackInput.isVisible({ timeout: Math.min(timeoutMs, 1_500) }).catch(() => false))) {
        trace.searchInputVisible = false;
        return false;
      }
      trace.searchInputVisible = true;
      trace.searchInputLocator = "active_dropdown_search_input";
      await fallbackInput.fill(expected);
      await dispatchInputEvents(fallbackInput);
      await this.page.waitForTimeout(250);
      const exactFallbackText = this.resolveDropdownOptionLocator(expected, true).last();
      if (!(await exactFallbackText.isVisible({ timeout: Math.min(timeoutMs, 2_000) }).catch(() => false))) {
        trace.optionVisibleAfterSearch = false;
        await this.page.keyboard.press("Enter");
        await this.page.waitForTimeout(250);
        trace.searchSelectionFallback = "keyboard_enter";
        return true;
      }
      await exactFallbackText.click();
      return true;
    }
    trace.searchInputVisible = true;
    trace.searchInputLocator = searchInput ?? "active_dropdown_search_input";
    await input.fill(expected);
    await dispatchInputEvents(input);
    await this.page.waitForTimeout(250);
    const exactText = this.resolveDropdownOptionLocator(expected, true).last();
    if (!(await exactText.isVisible({ timeout: Math.min(timeoutMs, 2_000) }).catch(() => false))) {
      trace.optionVisibleAfterSearch = false;
      await this.page.keyboard.press("Enter");
      await this.page.waitForTimeout(250);
      trace.searchSelectionFallback = "keyboard_enter";
      return true;
    }
    await exactText.click();
    return true;
  }

  private async waitForDropdownPopup(expected: string, timeoutMs: number): Promise<{ materialized: boolean; signals: string[] }> {
    const deadline = Date.now() + Math.min(timeoutMs, 4_000);
    const signals = new Set<string>();
    while (Date.now() < deadline) {
      if (await this.page.getByText(expected, { exact: true }).last().isVisible({ timeout: 120 }).catch(() => false)) {
        signals.add("expected_text_visible");
        return { materialized: true, signals: [...signals] };
      }
      const popupCount = await this.page.locator([
        "[role='listbox']",
        "[role='option']",
        ".ant-select-dropdown:not(.ant-select-dropdown-hidden)",
        ".ant-select-item-option",
        ".select-dropdown",
        ".dropdown-menu",
        "[data-radix-popper-content-wrapper]:visible",
        "[data-slot='popover-content']:visible",
        "[cmdk-list]:visible",
        "[cmdk-item]:visible"
      ].join(",")).count().catch(() => 0);
      if (popupCount > 0) {
        signals.add(`popup_nodes:${popupCount}`);
        return { materialized: true, signals: [...signals] };
      }
      await this.page.waitForTimeout(150);
    }
    return { materialized: false, signals: [...signals] };
  }

  private async resolveDropdownTrigger(target: string, component: unknown, timeoutMs: number, trace: Record<string, unknown>): Promise<Locator> {
    const candidates = preferSemanticDropdownTriggers(target, readComponentTriggerCandidates(component));
    const seen = new Set<string>();
    for (const candidate of candidates) {
      if (!candidate || seen.has(candidate) || candidate.startsWith("visual:")) continue;
      seen.add(candidate);
      try {
        const locator = candidate.startsWith("fieldRelative=")
          ? await this.resolveFieldRelativeLocator(candidate, "combobox")
          : this.resolveDropdownCandidateLocator(candidate).first();
        if (await locator.isVisible({ timeout: Math.min(timeoutMs, 1_500) }).catch(() => false)) {
          trace.triggerLocator = candidate;
          return locator;
        }
      } catch (error) {
        trace.triggerErrors = [...(Array.isArray(trace.triggerErrors) ? trace.triggerErrors : []), { locator: candidate, error: error instanceof Error ? error.message : String(error) }];
      }
    }
    throw actionExecutionError(`Dropdown trigger was not found. Target ${target}.`, trace);
  }

  private resolveDropdownCandidateLocator(candidate: string): Locator {
    const exactText = candidate.startsWith("textExact=") ? candidate.slice("textExact=".length).trim() : undefined;
    const fuzzyText = !exactText && candidate.startsWith("text=") ? candidate.slice("text=".length).trim() : undefined;
    const text = exactText || fuzzyText;
    if (text && !text.startsWith("visual:")) {
      return this.page.locator("button,[role='combobox'],[data-slot='popover-trigger']").filter({ hasText: text });
    }
    return this.resolveLocator(candidate);
  }

  private resolveDropdownOptionLocator(text: string, exact: boolean): Locator {
    const escapedValue = cssEscape(text);
    const roleOption = this.page.getByRole("option", { name: text, exact });
    const valueOption = this.page.locator(`[role='option'][data-value="${escapedValue}"],[cmdk-item][data-value="${escapedValue}"]`);
    const scopedOption = this.page.locator([
      ".ant-select-item-option",
      ".select-dropdown *",
      ".dropdown-menu *",
      "[role='listbox'] *",
      "[data-radix-popper-content-wrapper] *",
      "[data-slot='popover-content'] *",
      "[cmdk-item]"
    ].join(",")).filter({ hasText: text });
    return exact ? valueOption.or(roleOption).or(scopedOption) : scopedOption.or(roleOption);
  }

  private resolveActiveDropdownSearchInput(): Locator {
    return this.page.locator([
      "input[cmdk-input]:visible",
      "[data-slot='command-input']:visible",
      "input[role='combobox'][aria-expanded='true']:visible",
      "[data-radix-popper-content-wrapper] input:visible",
      "[data-slot='popover-content'] input:visible",
      "[role='dialog'] input:visible",
      "[role='listbox'] input:visible",
      "input[placeholder*='搜索']:visible",
      "input[placeholder*='Search']:visible"
    ].join(","));
  }

  private visibleDateRangeInputs(): Locator {
    return this.page.locator([
      "[data-radix-popper-content-wrapper] input:visible",
      "[data-slot='popover-content'] input:visible",
      "[role='dialog'] input:visible",
      ".ant-picker-dropdown input:visible",
      ".ant-picker-panel-container input:visible",
      "input[placeholder*='开始']:visible",
      "input[placeholder*='结束']:visible",
      "input[placeholder*='Start']:visible",
      "input[placeholder*='End']:visible",
      "input[placeholder*='YYYY']:visible",
      "input[placeholder*='yyyy']:visible"
    ].join(","));
  }

  private async resolveDateRangeTrigger(target: string, timeoutMs: number): Promise<Locator> {
    const preferred = this.page.locator([
      "button#date:visible",
      "button[data-slot='popover-trigger']:visible",
      "button[aria-haspopup='dialog']:visible"
    ].join(",")).filter({ hasText: /开始日期|结束日期|Start Date|End Date/i }).first();
    if (await preferred.isVisible({ timeout: Math.min(timeoutMs, 1_500) }).catch(() => false)) return preferred;
    const calendarTrigger = this.page.locator("button:visible").filter({ has: this.page.locator("svg.lucide-calendar") }).first();
    if (await calendarTrigger.isVisible({ timeout: Math.min(timeoutMs, 1_000) }).catch(() => false)) return calendarTrigger;
    return target.startsWith("fieldRelative=")
      ? await this.resolveFieldRelativeLocator(target, "combobox")
      : await this.findElement(target, timeoutMs);
  }

  private async openDateRangePopup(trigger: Locator, timeoutMs: number, trace: Record<string, unknown>): Promise<boolean> {
    const strategies: Array<{ name: string; run: () => Promise<void> }> = [
      { name: "trigger_click", run: () => trigger.click() },
      { name: "calendar_icon_click", run: async () => { await trigger.locator("svg").last().click({ force: true }); } },
      { name: "dom_click", run: async () => { await trigger.evaluate((element) => (element as HTMLElement).click()); } },
      { name: "mouse_center_click", run: async () => {
        const box = await trigger.boundingBox();
        if (!box) throw new Error("date trigger bounding box unavailable");
        await this.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      } }
    ];
    const errors: Array<{ strategy: string; error: string }> = [];
    for (const strategy of strategies) {
      try {
        await strategy.run();
        await this.page.waitForTimeout(150);
        if (await this.dateRangePopupOpened(trigger, timeoutMs)) {
          trace.openStrategy = strategy.name;
          return true;
        }
      } catch (error) {
        errors.push({ strategy: strategy.name, error: error instanceof Error ? error.message : String(error) });
      }
    }
    trace.openErrors = errors;
    return false;
  }

  private async dateRangePopupOpened(trigger: Locator, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + Math.min(timeoutMs, 2_500);
    while (Date.now() < deadline) {
      const expanded = await trigger.getAttribute("aria-expanded").catch(() => undefined);
      if (expanded === "true") return true;
      const popup = this.page.locator([
        "[data-radix-popper-content-wrapper]",
        "[data-slot='popover-content']",
        "[data-slot='calendar']",
        "[role='dialog']",
        ".ant-picker-dropdown",
        ".ant-picker-panel-container"
      ].join(",")).last();
      if (await popup.isVisible({ timeout: 120 }).catch(() => false)) return true;
      if (await this.page.getByText(/\d{4}年\d{2}月/).first().isVisible({ timeout: 120 }).catch(() => false)) return true;
      const calendarButtons = this.page.locator([
        "button:has-text('确定')",
        "button:has-text('取消')",
        "button:has-text('OK')",
        "button:has-text('Apply')"
      ].join(","));
      if (await calendarButtons.first().isVisible({ timeout: 120 }).catch(() => false)) return true;
      if (await this.visibleDateRangeInputs().first().isVisible({ timeout: 120 }).catch(() => false)) return true;
      await this.page.waitForTimeout(100);
    }
    return false;
  }

  private async tryCalendarDateRangeSelection(range: NormalizedDateRange, timeoutMs: number, trace: Record<string, unknown>): Promise<boolean> {
    const clickedStart = await this.clickCalendarDate(range.start, timeoutMs, trace, "start");
    if (!clickedStart) return false;
    await this.page.waitForTimeout(250);
    const clickedEnd = await this.clickCalendarDate(range.end, timeoutMs, trace, "end");
    if (!clickedEnd) return false;
    trace.clickedDays = [datePart(range.start), datePart(range.end)];
    return true;
  }

  private async clickCalendarDate(dateTime: string, timeoutMs: number, trace: Record<string, unknown>, boundary: "start" | "end"): Promise<boolean> {
    const target = calendarDateParts(dateTime);
    if (!target) return false;
    const events: Array<Record<string, unknown>> = [];
    const deadline = Date.now() + Math.min(timeoutMs, 4_000);
    while (Date.now() < deadline) {
      const clicked = await this.page.evaluate(({ monthLabel, day }) => {
        const isVisible = (element: Element): boolean => {
          const node = element as HTMLElement;
          const rect = node.getBoundingClientRect();
          const style = window.getComputedStyle(node);
          return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
        };
        const targetMonthVisible = (document.body.innerText || "").includes(monthLabel);
        const buttons = [...document.querySelectorAll("button")]
          .filter((button) => button.textContent?.trim() === day && !button.hasAttribute("disabled") && isVisible(button));
        if (targetMonthVisible && buttons[0]) {
          (buttons[0] as HTMLElement).click();
          return true;
        }
        for (const button of buttons) {
          let parent: Element | null = button;
          for (let depth = 0; parent && depth < 20; depth += 1, parent = parent.parentElement) {
            const text = parent.textContent || "";
            if (text.includes(monthLabel)) {
              (button as HTMLElement).click();
              return true;
            }
          }
        }
        return false;
      }, target).catch(() => false);
      if (clicked) {
        trace.calendarSelection = [...(Array.isArray(trace.calendarSelection) ? trace.calendarSelection : []), { boundary, target, events, clicked: true }];
        return true;
      }
      const monthVisible = await this.page.getByText(target.monthLabel, { exact: true }).first().isVisible({ timeout: 100 }).catch(() => false);
      if (monthVisible) {
        const dayButton = this.page.locator("[data-slot='calendar'] button")
          .filter({ hasText: new RegExp(`^\\s*${escapeRegExp(target.day)}\\s*$`) })
          .first();
        if (await dayButton.isVisible({ timeout: 300 }).catch(() => false)) {
          await dayButton.click({ force: true });
          trace.calendarSelection = [...(Array.isArray(trace.calendarSelection) ? trace.calendarSelection : []), { boundary, target, events, clicked: true, clickStrategy: "playwright_day_button" }];
          return true;
        }
      }
      const shift = await this.shiftCalendarTowardMonth(target.monthLabel);
      events.push(shift);
      await this.page.waitForTimeout(150);
    }
    trace.calendarSelection = [...(Array.isArray(trace.calendarSelection) ? trace.calendarSelection : []), { boundary, target, events, clicked: false }];
    return false;
  }

  private async shiftCalendarTowardMonth(monthLabel: string): Promise<Record<string, unknown>> {
    const decision = await this.page.evaluate((targetLabel) => {
      const target = calendarMonthNumber(targetLabel);
      if (!target) return { direction: "", visibleMonths: [] };
      const text = document.body.innerText || "";
      const visibleMonths = [...text.matchAll(/(\d{4})年(\d{2})月/g)]
        .map((match) => Number(match[1]) * 12 + Number(match[2]))
        .filter((item) => Number.isFinite(item));
      if (!visibleMonths.length || visibleMonths.includes(target)) return { direction: "", visibleMonths };
      const minMonth = Math.min(...visibleMonths);
      const maxMonth = Math.max(...visibleMonths);
      return { direction: target > maxMonth ? "right" : target < minMonth ? "left" : "", visibleMonths };

      function calendarMonthNumber(label: string): number | undefined {
        const match = label.match(/^(\d{4})年(\d{2})月$/);
        if (!match) return undefined;
        return Number(match[1]) * 12 + Number(match[2]);
      }
    }, monthLabel).catch(() => ({ direction: "", visibleMonths: [], error: "month_decision_failed" }));
    const direction = decision.direction;
    if (direction !== "right" && direction !== "left") return { ...decision, clicked: false };
    const navButton = this.page.locator("[data-slot='calendar'] button")
      .filter({ has: this.page.locator(`svg.lucide-chevron-${direction}`) })
      .last();
    if (await navButton.isVisible({ timeout: 500 }).catch(() => false)) {
      const box = await navButton.boundingBox().catch(() => null);
      await navButton.click({ force: true }).catch(async () => {
        if (box) await this.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      });
      return { ...decision, clicked: true, box: box ? { x: box.x, y: box.y, width: box.width, height: box.height } : null };
    }
    return { ...decision, clicked: false, navVisible: false };
  }

  private async confirmActiveDatePicker(timeoutMs: number, trace: Record<string, unknown>): Promise<void> {
    const confirm = this.page.locator([
      "[data-radix-popper-content-wrapper] button",
      "[data-slot='popover-content'] button",
      "[role='dialog'] button",
      ".ant-picker-dropdown button",
      ".ant-picker-panel-container button"
    ].join(",")).filter({ hasText: /确定|确认|应用|完成|OK|Apply|Confirm/i }).last();
    if (await confirm.isVisible({ timeout: Math.min(timeoutMs, 1_500) }).catch(() => false)) {
      await confirm.click();
      trace.confirmed = true;
      trace.confirmStrategy = "button";
      return;
    }
    await this.page.keyboard.press("Enter");
    trace.confirmed = true;
    trace.confirmStrategy = "keyboard_enter";
  }

  async swipe(): Promise<void> {
    await this.page.mouse.wheel(0, 700);
  }

  async waitFor(condition: unknown, timeoutMs = 1_000): Promise<void> {
    if (typeof condition === "string" && condition) {
      await this.findElement(condition);
      return;
    }
    await this.page.waitForTimeout(timeoutMs);
  }

  async assertState(assertion: DslAssertion): Promise<void> {
    if (assertion.type === "result_empty") {
      await this.assertResultEmpty(assertion);
      return;
    }
    if (assertion.type === "table_column_all_equal" || assertion.type === "table_column_all_equal_or_empty") {
      await this.assertTableColumnAllEqual(assertion);
      return;
    }
    if (assertion.type === "table_column_date_between") {
      await this.assertTableColumnDateBetween(assertion);
      return;
    }
    if (assertion.type === "message_visible_exact") {
      await this.assertMessageVisibleExact(assertion);
      return;
    }
    if (assertion.type === "element_disabled") {
      await this.assertElementDisabled(assertion);
      return;
    }
    if (assertion.type === "element_enabled") {
      await this.assertElementEnabled(assertion);
      return;
    }
    if (assertion.type === "textVisible" && assertion.target) {
      await this.page.getByText(assertion.target, { exact: false }).first().waitFor({ state: "visible", timeout: 5_000 });
      return;
    }
    if (assertion.type === "textVisibleAny") {
      const candidates = assertionCandidates(assertion);
      const deadline = Date.now() + 8_000;
      let lastError: unknown;
      while (Date.now() < deadline) {
        const visibleText = await this.page.locator("body").evaluate((body) => (body as HTMLElement).innerText || "").catch(() => "");
        if (candidates.some((candidate) => visibleText.includes(candidate))) return;
        for (const candidate of candidates) {
          try {
            await this.page.getByText(candidate, { exact: false }).first().waitFor({ state: "visible", timeout: 500 });
            return;
          } catch (error) {
            lastError = error;
          }
        }
        await this.page.waitForTimeout(250);
      }
      throw new Error(`None of expected texts became visible: ${candidates.join(" | ")}. Last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
    }
    if (assertion.type === "urlContains" && typeof assertion.expected === "string") {
      const url = this.page.url();
      if (!url.includes(assertion.expected)) throw new Error(`URL does not contain ${assertion.expected}: ${url}`);
    }
  }

  private async assertMessageVisibleExact(assertion: DslAssertion): Promise<void> {
    const expected = String(assertion.expected ?? assertion.target ?? "").trim();
    if (!expected) throw new Error("Message assertion expected text is empty.");
    const normalizedExpected = normalizeMessageText(expected);
    const deadline = Date.now() + Math.max(500, Math.min(Number(assertion.observeWindowMs ?? 3_000), 10_000));
    const seen = new Map<string, MessageCandidate>();
    const collectionErrors: string[] = [];
    let matched: MessageCandidate | undefined;
    const observe = (candidate: { text: string; source: string }): void => {
      const normalizedCandidate = normalizeMessageText(candidate.text);
      const similarity = messageSimilarity(normalizedExpected, normalizedCandidate);
      const key = `${candidate.source}:${normalizedCandidate}`;
      const next = { ...candidate, similarity };
      seen.set(key, next);
      if (!matched && messageExactMatch(normalizedExpected, normalizedCandidate)) matched = next;
    };
    while (Date.now() <= deadline) {
      const candidates = await this.collectVisibleMessageCandidates().catch(async (error) => {
        collectionErrors.push(error instanceof Error ? error.message : String(error));
        return this.collectVisibleBodyTextCandidates(80).catch((fallbackError) => {
          collectionErrors.push(fallbackError instanceof Error ? fallbackError.message : String(fallbackError));
          return [];
        });
      });
      for (const candidate of candidates) {
        observe(candidate);
        if (matched) break;
      }
      if (matched) break;
      await this.page.waitForTimeout(200);
    }
    if (!matched) {
      const finalCandidates = await this.collectVisibleMessageCandidates({ includeFullBodyText: true }).catch(async (error) => {
        collectionErrors.push(error instanceof Error ? error.message : String(error));
        return [];
      });
      for (const candidate of finalCandidates) observe(candidate);
    }
    if (!matched) {
      const fullBodyCandidates = await this.collectVisibleBodyTextCandidates(300).catch((error) => {
        collectionErrors.push(error instanceof Error ? error.message : String(error));
        return [];
      });
      for (const candidate of fullBodyCandidates) observe(candidate);
    }
    const { observedMessages, bestCandidates, attribution } = buildMessageAssertionDiagnostics(expected, matched, [...seen.values()]);
    assertion.actual = { expected, matched: Boolean(matched), matchedText: matched?.text, observedMessages, bestCandidates, attribution };
    assertion.diagnostics = { assertionType: "message_visible_exact", expected, rootCause: attribution.rootCause, bestCandidates, observedMessageCount: observedMessages.length, collectionErrors, attribution };
    if (!matched) {
      throw new Error(`Expected message was not visible exactly: ${expected}. Similar visible messages: ${bestCandidates.map((item) => item.text).join(" | ") || "none"}.`);
    }
  }

  private async assertElementDisabled(assertion: DslAssertion): Promise<void> {
    const locators = [
      typeof assertion.locator === "string" ? assertion.locator : undefined,
      typeof assertion.target === "string" ? assertion.target : undefined,
      ...(Array.isArray(assertion.fallbackLocators) ? assertion.fallbackLocators : [])
    ].filter((item): item is string => Boolean(item && item.trim()));
    if (!locators.length) throw new Error("Element disabled assertion has no locator.");
    const errors: string[] = [];
    for (const locator of locators) {
      try {
        const element = await this.findElement(locator, 2_000);
        const state = await readDisabledState(element);
        assertion.actual = { locator, ...state };
        assertion.diagnostics = {
          assertionType: "element_disabled",
          locator,
          targetElementId: assertion.targetElementId,
          targetStateId: assertion.targetStateId,
          rootCause: state.disabled ? "element_disabled_matched" : "element_enabled"
        };
        if (state.disabled) return;
        throw new Error(`Element is enabled. text=${state.text || "empty"}`);
      } catch (error) {
        errors.push(`${locator}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    throw new Error(`Expected element to be disabled, but no locator matched disabled state. ${errors.join(" | ")}`);
  }

  private async assertElementEnabled(assertion: DslAssertion): Promise<void> {
    const locators = [
      typeof assertion.locator === "string" ? assertion.locator : undefined,
      typeof assertion.target === "string" ? assertion.target : undefined,
      ...(Array.isArray(assertion.fallbackLocators) ? assertion.fallbackLocators : [])
    ].filter((item): item is string => Boolean(item && item.trim()));
    if (!locators.length) throw new Error("Element enabled assertion has no locator.");
    const errors: string[] = [];
    for (const locator of locators) {
      try {
        const element = await this.findElement(locator, 2_000);
        const state = await readDisabledState(element);
        assertion.actual = { locator, ...state, enabled: !state.disabled };
        assertion.diagnostics = {
          assertionType: "element_enabled",
          locator,
          targetElementId: assertion.targetElementId,
          targetStateId: assertion.targetStateId,
          rootCause: state.disabled ? "element_disabled" : "element_enabled_matched"
        };
        if (!state.disabled) return;
        throw new Error(`Element is disabled. text=${state.text || "empty"} reason=${state.reason}`);
      } catch (error) {
        errors.push(`${locator}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    throw new Error(`Expected element to be enabled, but no locator matched enabled state. ${errors.join(" | ")}`);
  }

  private async resolveRowScopedLocator(locator: string, timeoutMs: number): Promise<Locator> {
    const spec = parseRowScopedLocator(locator);
    const hasRowCondition = Boolean(spec.value) || Object.keys(spec.conditions).length > 0;
    if (!hasRowCondition || !spec.actionText) throw new Error(`Invalid rowScoped locator: ${locator}`);
    const deadline = Date.now() + Math.max(500, Math.min(timeoutMs, 15_000));
    let lastDiagnostic: Record<string, unknown> = {};
    let expandClickCount = 0;
    while (Date.now() <= deadline) {
      const snapshot = await this.collectRowScopedDomCandidates(spec).catch((error) => ({
        rows: [],
        expanders: [],
        error: error instanceof Error ? error.message : String(error)
      }));
      const rows = snapshot.rows;
      const expanders = snapshot.expanders ?? [];
      const conditionMatchedRows = rows.filter((row) => row.conditionMatched);
      const matchedRows = rows.filter((row) => row.matched && typeof row.actionIndex === "number");
      const actionableRows = matchedRows.filter((row) => {
        if (spec.actionState === "enabled") return row.actionEnabled !== false;
        if (spec.actionState === "disabled") return row.actionEnabled === false;
        return true;
      });
      lastDiagnostic = {
        value: spec.value,
        conditions: spec.conditions,
        actionText: spec.actionText,
        actionState: spec.actionState,
        expandText: spec.expandText,
        match: spec.match,
        expandClickCount,
        visibleRowCount: rows.length,
        conditionMatchedRowCount: conditionMatchedRows.length,
        matchedRowCount: matchedRows.length,
        actionableRowCount: actionableRows.length,
        visibleExpandControlCount: expanders.length,
        candidateError: "error" in snapshot ? snapshot.error : undefined,
        rowSamples: rows.slice(0, 12),
        expandSamples: expanders.slice(0, 4)
      };
      const chosen = actionableRows
        .sort((left, right) => {
          const leftEnabled = left.actionEnabled === false ? 1 : 0;
          const rightEnabled = right.actionEnabled === false ? 1 : 0;
          const leftTextLength = String(left.text || "").length;
          const rightTextLength = String(right.text || "").length;
          const leftArea = left.width * left.height;
          const rightArea = right.width * right.height;
          return leftEnabled - rightEnabled ||
            leftTextLength - rightTextLength ||
            leftArea - rightArea ||
            left.y - right.y ||
            left.x - right.x;
        })[0];
      if (chosen) {
        const actionIndex = chosen.actionIndex;
        if (typeof actionIndex !== "number") continue;
        const marker = `row-scoped-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        const mark = new Function("payload", `
          function interactiveAncestor(element) {
            let node = element;
            for (let depth = 0; node && depth < 6; depth += 1, node = node.parentElement) {
              const tag = String(node.tagName || "").toLowerCase();
              const role = node.getAttribute("role") || "";
              const className = String(node.className || "");
              const style = window.getComputedStyle(node);
              if (tag === "button" || tag === "a" || role === "button" || node.getAttribute("onclick") || node.getAttribute("tabindex") || style.cursor === "pointer" || /button|btn|cursor-pointer|clickable/i.test(className)) {
                return node;
              }
            }
            return element;
          }
          const element = document.querySelectorAll("*")[payload.index];
          if (element) {
            const control = interactiveAncestor(element);
            control.setAttribute("data-atw-row-scoped-match", payload.marker);
            control.scrollIntoView({ block: "center", inline: "center" });
          }
        `) as (payload: { index: number; marker: string }) => void;
        await this.page.evaluate(mark, { index: actionIndex, marker });
        const matched = this.page.locator(`[data-atw-row-scoped-match="${marker}"]`).first();
        await matched.waitFor({ state: "visible", timeout: Math.min(timeoutMs, 5_000) });
        return matched;
      }
      if (spec.expandText && expandClickCount < 3) {
        const expander = chooseRowScopedExpander(expanders, rows);
        if (expander) {
          const marker = `row-scoped-expand-${Date.now()}-${Math.random().toString(16).slice(2)}`;
          const mark = new Function("payload", `
            function interactiveAncestor(element) {
              let node = element;
              for (let depth = 0; node && depth < 6; depth += 1, node = node.parentElement) {
                const tag = String(node.tagName || "").toLowerCase();
                const role = node.getAttribute("role") || "";
                const className = String(node.className || "");
                const style = window.getComputedStyle(node);
                if (tag === "button" || tag === "a" || role === "button" || node.getAttribute("onclick") || node.getAttribute("tabindex") || style.cursor === "pointer" || /button|btn|cursor-pointer|clickable/i.test(className)) {
                  return node;
                }
              }
              return element;
            }
            const element = document.querySelectorAll("*")[payload.index];
            if (element) {
              const control = interactiveAncestor(element);
              control.setAttribute("data-atw-row-scoped-expand", payload.marker);
              control.scrollIntoView({ block: "center", inline: "center" });
            }
          `) as (payload: { index: number; marker: string }) => void;
          await this.page.evaluate(mark, { index: expander.index, marker });
          const expandControl = this.page.locator(`[data-atw-row-scoped-expand="${marker}"]`).first();
          await expandControl.click({ timeout: Math.min(timeoutMs, 5_000) });
          expandClickCount += 1;
          await this.page.waitForTimeout(500);
          continue;
        }
      }
      await this.page.waitForTimeout(150);
    }
    const rootCause = (lastDiagnostic.conditionMatchedRowCount as number | undefined) && spec.actionState === "enabled"
      ? "row_action_state_not_matched"
      : "row_condition_or_action_not_matched";
    throw actionExecutionError(`Row scoped action was not found. ${JSON.stringify(spec.conditions || {}) || spec.value} -> ${spec.actionText}.`, {
      action: "resolveRowScopedLocator",
      locator,
      ...lastDiagnostic,
      rootCause
    });
  }

  private async collectRowScopedDomCandidates(spec: RowScopedLocatorSpec): Promise<{
    rows: Array<{
      rowIndex: number;
      rowElementIndex: number;
      actionIndex?: number;
      x: number;
      y: number;
      width: number;
      height: number;
      text: string;
      fields: Record<string, string>;
      actionText?: string;
      actionEnabled?: boolean;
      conditionMatched: boolean;
      matched: boolean;
      mismatchReasons: string[];
    }>;
    expanders: Array<{ index: number; x: number; y: number; width: number; height: number; text: string }>;
  }> {
    const collect = new Function("payload", `
      const value = payload.value || "";
      const conditions = payload.conditions || {};
      const actionText = payload.actionText;
      const expandText = payload.expandText || "";
      const match = payload.match || "exact";
      const actionState = payload.actionState || "any";
      function normalized(text) {
        return String(text || "").replace(/\s+/g, " ").trim();
      }
      function textCandidates(element) {
        const candidates = [
          element.textContent || "",
          element.getAttribute("aria-label") || "",
          element.getAttribute("title") || "",
          element.getAttribute("alt") || "",
          element.getAttribute("placeholder") || ""
        ];
        for (const media of Array.from(element.querySelectorAll ? element.querySelectorAll("img,[alt],[title],[aria-label]") : [])) {
          candidates.push(media.getAttribute("alt") || "");
          candidates.push(media.getAttribute("title") || "");
          candidates.push(media.getAttribute("aria-label") || "");
        }
        return candidates.map(normalized).filter(Boolean);
      }
      function accessibleText(element) {
        return normalized(textCandidates(element).join(" "));
      }
      function ownText(element) {
        return Array.from(element.childNodes || [])
          .filter((node) => node.nodeType === Node.TEXT_NODE)
          .map((node) => normalized(node.textContent || ""))
          .filter(Boolean)
          .join(" ");
      }
      function visible(element) {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      }
      function boxOf(element, index) {
        const rect = element.getBoundingClientRect();
        return {
          index,
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
          width: rect.width,
          height: rect.height,
          text: accessibleText(element)
        };
      }
      function distanceBetween(left, right) {
        const dx = (left.x || 0) - (right.x || 0);
        const dy = (left.y || 0) - (right.y || 0);
        return Math.sqrt(dx * dx + dy * dy);
      }
      function isControl(element) {
        const style = window.getComputedStyle(element);
        const role = element.getAttribute("role") || "";
        const tag = element.tagName.toLowerCase();
        const className = String(element.className || "");
        return tag === "button" ||
          tag === "a" ||
          role === "button" ||
          style.cursor === "pointer" ||
          /button|btn|cursor-pointer|clickable/i.test(className) ||
          Boolean(element.closest("button,a,[role='button']"));
      }
      function controlDisabled(element) {
        const control = element.closest("button,a,[role='button'],input,textarea,select") || element;
        const disabledProperty = "disabled" in control ? Boolean(control.disabled) : false;
        const ariaDisabled = control.getAttribute("aria-disabled") === "true";
        const disabledAttr = control.getAttribute("disabled") !== null;
        const className = String(control.className || "");
        const style = window.getComputedStyle(control);
        return disabledProperty || ariaDisabled || disabledAttr || /disabled|cursor-not-allowed|opacity-50/i.test(className) || style.pointerEvents === "none";
      }
      function matchesText(actual, expected) {
        const left = normalized(actual).toLowerCase();
        const right = normalized(expected).toLowerCase();
        if (!right) return true;
        if (match === "contains") return left.includes(right);
        return left === right;
      }
      function rowFields(row) {
        const rowText = normalized(row.innerText || accessibleText(row));
        const mediaLabels = Array.from(row.querySelectorAll("img,[alt],[title],[aria-label]"))
          .flatMap((node) => [node.getAttribute("alt"), node.getAttribute("title"), node.getAttribute("aria-label")])
          .map(normalized)
          .filter(Boolean);
        const directCells = Array.from(row.children || [])
          .filter(visible)
          .map((child) => normalized(child.innerText || accessibleText(child)))
          .filter(Boolean);
        const ownTexts = Array.from(row.querySelectorAll("*"))
          .map((child) => ownText(child))
          .filter(Boolean);
        const exactTextCandidates = Array.from(new Set([
          ownText(row),
          ...directCells,
          ...ownTexts,
          ...mediaLabels
        ].filter(Boolean)));
        const firstCellText = directCells[0] || "";
        const firstMedia = mediaLabels[0] || "";
        const asset = firstMedia || (firstCellText.match(/\\b[A-Za-z][A-Za-z0-9]{1,15}\\b/) || [])[0] || "";
        const status = directCells.find((text) => /(进行中|已结束|已下架|可用|不可用|启用|禁用|成功|失败|处理中|待处理|可申购|申购中)/.test(text)) || "";
        return {
          text: rowText,
          exactTextCandidates: exactTextCandidates.join(" || "),
          asset,
          coin: asset,
          symbol: asset,
          productName: firstCellText,
          name: firstCellText,
          status
        };
      }
      function conditionMatches(fields, key, expected) {
        if (!expected) return true;
        const normalizedKey = String(key || "").replace(/[_-]/g, "").toLowerCase();
        const candidates = [];
        if (normalizedKey === "asset" || normalizedKey === "coin" || normalizedKey === "symbol") {
          candidates.push(fields.asset, fields.coin, fields.symbol);
        } else if (normalizedKey === "productname" || normalizedKey === "name") {
          candidates.push(fields.productName, fields.name);
        } else if (normalizedKey === "status" || normalizedKey === "state") {
          candidates.push(fields.status);
        } else if (normalizedKey === "text" || normalizedKey === "value") {
          candidates.push(fields.text);
        }
        candidates.push(fields[normalizedKey], fields.text);
        if ((normalizedKey === "text" || normalizedKey === "value") && fields.exactTextCandidates) {
          candidates.push(...String(fields.exactTextCandidates).split(" || "));
        }
        return candidates.filter(Boolean).some((candidate) => matchesText(candidate, expected));
      }
      function conditionAnchorBoxes(row, explicitConditions) {
        const anchors = [];
        const descendants = Array.from(row.querySelectorAll ? row.querySelectorAll("*") : []);
        for (const element of [row, ...descendants]) {
          if (!visible(element)) continue;
          const box = boxOf(element, allElements.indexOf(element));
          if (!box.text || box.text.length > 160) continue;
          const fields = rowFields(element);
          const matched = Object.keys(explicitConditions).some((key) => conditionMatches(fields, key, explicitConditions[key]));
          if (matched) anchors.push({ ...box, area: box.width * box.height, textLength: box.text.length });
        }
        return anchors.sort((left, right) => left.textLength - right.textLength || left.area - right.area).slice(0, 8);
      }
      const normalizedValue = normalized(value).toLowerCase();
      const normalizedAction = normalized(actionText).toLowerCase();
      const normalizedExpand = normalized(expandText).toLowerCase();
      const allElements = Array.from(document.querySelectorAll("*"));
      const controls = allElements;
      const actionControls = controls
        .map((element, index) => ({ element, index }))
        .filter(({ element }) => {
          if (!visible(element)) return false;
          const text = accessibleText(element);
          if (!text || text.length > 24 || !text.toLowerCase().includes(normalizedAction)) return false;
          return isControl(element);
        });
      const expanders = !normalizedExpand ? [] : controls
        .map((element, index) => ({ element, index }))
        .filter(({ element }) => {
          if (!visible(element)) return false;
          const text = accessibleText(element);
          if (!text || text.length > 32 || !text.toLowerCase().includes(normalizedExpand)) return false;
          return isControl(element);
        })
        .map(({ element, index }) => boxOf(element, index));
      const actionControlSet = new Set(actionControls.map((item) => item.element));
      const rowElements = allElements
        .map((element, index) => ({ element, index }))
        .filter(({ element }) => {
          if (!visible(element)) return false;
          const text = normalized(element.innerText || accessibleText(element));
          if (!text || text.length < 2 || text.length > 900 || !text.toLowerCase().includes(normalizedAction)) return false;
          const tag = element.tagName.toLowerCase();
          const role = element.getAttribute("role") || "";
          const className = String(element.className || "");
          const childCount = Array.from(element.children || []).filter(visible).length;
          if (tag === "tr" || role === "row") return true;
          if (/(row|list-item|table-row|grid|card|item)/i.test(className) && childCount >= 2) return true;
          if (/(security|setting|profile|account|field|form|info|cell|line)/i.test(className) && childCount >= 2) return true;
          return childCount >= 3 && actionControls.some(({ element: action }) => element !== action && element.contains(action));
        });
      const rows = rowElements.map(({ element, index }, rowIndex) => {
        const rect = element.getBoundingClientRect();
        const fields = rowFields(element);
        const explicitConditions = Object.assign({}, conditions);
        if (value && !Object.keys(explicitConditions).length) explicitConditions.value = value;
        const anchors = conditionAnchorBoxes(element, explicitConditions);
        const action = actionControls
          .filter(({ element: control }) => element.contains(control))
          .map(({ element: control, index: controlIndex }) => {
            const box = boxOf(control, controlIndex);
            const anchorDistance = anchors.length ? Math.min(...anchors.map((anchor) => distanceBetween(box, anchor))) : Number.POSITIVE_INFINITY;
            return { element: control, index: controlIndex, box, anchorDistance };
          })
          .sort((left, right) => {
            if (anchors.length) return left.anchorDistance - right.anchorDistance || left.box.x - right.box.x;
            return right.box.x - left.box.x;
          })[0];
        const conditionMismatchReasons = [];
        for (const key of Object.keys(explicitConditions)) {
          if (!conditionMatches(fields, key, explicitConditions[key])) conditionMismatchReasons.push(key + ":" + explicitConditions[key]);
        }
        const mismatchReasons = conditionMismatchReasons.slice();
        if (actionState === "enabled" && action && controlDisabled(action.element)) mismatchReasons.push("actionState:disabled");
        if (actionState === "disabled" && action && !controlDisabled(action.element)) mismatchReasons.push("actionState:enabled");
        return {
          rowIndex,
          rowElementIndex: index,
          actionIndex: action ? action.index : undefined,
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
          width: rect.width,
          height: rect.height,
          text: fields.text,
          fields,
          actionText: action ? action.box.text : undefined,
          actionEnabled: action ? !controlDisabled(action.element) : undefined,
          actionAnchorDistance: action && Number.isFinite(action.anchorDistance) ? Math.round(action.anchorDistance) : undefined,
          conditionMatched: conditionMismatchReasons.length === 0,
          matched: mismatchReasons.length === 0 && Boolean(action),
          mismatchReasons
        };
      });
      return { rows, expanders };
    `) as (payload: RowScopedLocatorSpec) => {
      rows: Array<{
        rowIndex: number;
        rowElementIndex: number;
        actionIndex?: number;
        x: number;
        y: number;
        width: number;
        height: number;
        text: string;
        fields: Record<string, string>;
        actionText?: string;
        actionEnabled?: boolean;
        conditionMatched: boolean;
        matched: boolean;
        mismatchReasons: string[];
      }>;
      expanders: Array<{ index: number; x: number; y: number; width: number; height: number; text: string }>;
    };
    return this.page.evaluate(collect, spec);
  }

  private async collectVisibleMessageCandidates(options: { includeFullBodyText?: boolean } = {}): Promise<Array<{ text: string; source: string }>> {
    const collect = new Function("evaluateOptions", `
      const body = document.body;
      if (!body) return [];
      function textOf(element) {
        return ((element && element.textContent) || "").replace(/\\s+/g, " ").trim();
      }
      function visible(element) {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      }
      function sourceOf(element) {
        const className = String(element.className || "");
        if (/toast|message|notification|notice|alert/i.test(className)) return "toast_or_message";
        if (element.closest("[role='dialog'],.modal,.ant-modal")) return "modal";
        return element.getAttribute("role") || "visible_text";
      }
      const selectors = [
        "[role='alert']",
        "[role='status']",
        "[aria-live]",
        ".ant-message-notice",
        ".ant-notification-notice",
        ".ant-alert",
        ".toast",
        ".message",
        ".notification",
        "[role='dialog']"
      ];
      const elements = Array.from(body.querySelectorAll(selectors.join(","))).filter(visible);
      const candidates = elements
        .map((element) => ({ text: textOf(element), source: sourceOf(element) }))
        .filter((item) => item.text && item.text.length <= 160);
      const includeFullBodyText = Boolean(evaluateOptions && evaluateOptions.includeFullBodyText);
      const bodyLines = (body.innerText || "")
        .split(/\\n+/)
        .map((item) => item.trim())
        .filter((item) => item.length >= 2 && item.length <= 80)
        .slice(includeFullBodyText ? 0 : -30)
        .map((text) => ({ text, source: "visible_text" }));
      const seen = new Set();
      return candidates.concat(bodyLines).filter((item) => {
        const key = item.source + ":" + item.text;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }).slice(0, includeFullBodyText ? 300 : 80);
    `) as (evaluateOptions: { includeFullBodyText: boolean }) => Array<{ text: string; source: string }>;
    return this.page.evaluate(collect, { includeFullBodyText: Boolean(options.includeFullBodyText) });
  }

  private async collectVisibleBodyTextCandidates(limit: number): Promise<Array<{ text: string; source: string }>> {
    const collect = new Function("maxLines", `
      const body = document.body;
      if (!body) return [];
      const lines = (body.innerText || "")
        .split(/\\n+/)
        .map((item) => item.trim())
        .filter((item) => item.length >= 2 && item.length <= 80);
      const selected = lines.slice(-Math.max(1, maxLines));
      const seen = new Set();
      return selected
        .map((text) => ({ text, source: "visible_text" }))
        .filter((item) => {
          if (seen.has(item.text)) return false;
          seen.add(item.text);
          return true;
        });
    `) as (maxLines: number) => Array<{ text: string; source: string }>;
    return this.page.evaluate(collect, limit);
  }

  private async assertResultEmpty(assertion: DslAssertion): Promise<void> {
    const deadline = Date.now() + 10_000;
    let lastSnapshot: FundFlowTableSnapshot | undefined;
    while (Date.now() < deadline) {
      const snapshot = await this.readDomTableSnapshot({ ...assertion, column: assertion.column ?? "" }).catch(async () => {
        const visibleText = await this.page.locator("body").evaluate((body) => (body as HTMLElement).innerText || "").catch(() => "");
        return readFundFlowTableSnapshot(visibleText, assertion, await this.resolveDataTableContract(assertion));
      });
      lastSnapshot = snapshot;
      assertion.actual = { rowCount: snapshot.diagnostics.tableReadiness?.rowCount, empty: snapshot.empty, diagnostics: snapshot.diagnostics };
      assertion.diagnostics = snapshot.diagnostics;
      if (snapshot.loading || snapshot.diagnostics.rootCause === "headers_ready_rows_pending") {
        await this.page.waitForTimeout(300);
        continue;
      }
      const rowCount = Number(snapshot.diagnostics.tableReadiness?.rowCount ?? 0);
      if (snapshot.empty || rowCount === 0) return;
      throw new Error(`Expected result table to be empty, but observed ${rowCount} row(s). Sample: ${snapshot.diagnostics.rowSample.slice(0, 12).join(" | ") || "none"}.`);
    }
    throw new Error(`Timed out waiting for empty result assertion. Last diagnostics: ${lastSnapshot?.diagnostics.rootCause ?? "unknown"}.`);
  }

  private async assertTableColumnAllEqual(assertion: DslAssertion): Promise<void> {
    const expected = String(assertion.expected ?? "").trim();
    if (!expected) throw new Error("table_column_all_equal assertion requires expected value.");
    const emptyAccepted = assertion.type === "table_column_all_equal_or_empty" || Boolean(assertion.emptyStateAccepted);
    const deadline = Date.now() + 10_000;
    let lastSnapshot: FundFlowTableSnapshot | undefined;
    while (Date.now() < deadline) {
      const snapshot = await this.readDomTableSnapshot(assertion).catch(async () => {
        const visibleText = await this.page.locator("body").evaluate((body) => (body as HTMLElement).innerText || "").catch(() => "");
        return readFundFlowTableSnapshot(visibleText, assertion, await this.resolveDataTableContract(assertion));
      });
      lastSnapshot = snapshot;
      if (snapshot.loading) {
        await this.page.waitForTimeout(300);
        continue;
      }
      assertion.actual = { typeValues: snapshot.typeValues, empty: snapshot.empty, diagnostics: snapshot.diagnostics };
      assertion.diagnostics = snapshot.diagnostics;
      if (snapshot.empty) {
        if (emptyAccepted) return;
        throw new Error(`Result table is empty, but assertion expected every ${assertion.column ?? "column"} value to equal ${expected}.`);
      }
      if (!snapshot.typeValues.length) {
        if (snapshot.diagnostics.rootCause === "assertion_column_not_observable") {
          throw new Error(`Assertion column is not observable in result table: ${snapshot.diagnostics.requestedColumn}. Observed headers: ${snapshot.diagnostics.observedHeaders.join(" | ") || "none"}. Selected filters: ${snapshot.diagnostics.selectedFilters.map((item) => `${item.label}=${item.value}`).join(" | ") || "none"}.`);
        }
        await this.page.waitForTimeout(300);
        continue;
      }
      const mismatched = snapshot.typeValues.filter((value) => normalizeAssertionCell(value) !== normalizeAssertionCell(expected));
      if (!mismatched.length) return;
      throw new Error(`Expected all ${assertion.column ?? "table"} values to equal ${expected}, but found: ${[...new Set(mismatched)].join(" | ")}.`);
    }
    throw new Error(`Timed out waiting for table assertion ${assertion.type}. Last observed values: ${(lastSnapshot?.typeValues ?? []).join(" | ") || "none"}. Diagnostics: ${lastSnapshot?.diagnostics.rootCause ?? "unknown"}.`);
  }

  private async assertTableColumnDateBetween(assertion: DslAssertion): Promise<void> {
    const range = normalizeDateRangeInput(assertion.expected ?? assertion.intent?.expected);
    if (!range.start || !range.end) throw new Error("table_column_date_between assertion requires expected start and end.");
    const startMs = parseDateTimeMs(range.start, "start");
    const endMs = parseDateTimeMs(range.end, "end");
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) throw new Error(`Invalid expected date range: ${range.start}~${range.end}.`);
    const deadline = Date.now() + 10_000;
    let lastSnapshot: FundFlowTableSnapshot | undefined;
    while (Date.now() < deadline) {
      const snapshot = await this.readDomTableSnapshot(assertion).catch(async () => {
        const visibleText = await this.page.locator("body").evaluate((body) => (body as HTMLElement).innerText || "").catch(() => "");
        return readFundFlowTableSnapshot(visibleText, assertion, await this.resolveDataTableContract(assertion));
      });
      lastSnapshot = snapshot;
      if (snapshot.loading) {
        await this.page.waitForTimeout(300);
        continue;
      }
      assertion.actual = { typeValues: snapshot.typeValues, empty: snapshot.empty, diagnostics: snapshot.diagnostics };
      assertion.diagnostics = snapshot.diagnostics;
      if (snapshot.empty) throw new Error(`Result table is empty, but assertion expected ${assertion.column ?? "date column"} values between ${range.start} and ${range.end}.`);
      if (!snapshot.typeValues.length) {
        if (snapshot.diagnostics.rootCause === "assertion_column_not_observable") {
          throw new Error(`Assertion column is not observable in result table: ${snapshot.diagnostics.requestedColumn}. Observed headers: ${snapshot.diagnostics.observedHeaders.join(" | ") || "none"}.`);
        }
        await this.page.waitForTimeout(300);
        continue;
      }
      const datedValues = snapshot.typeValues.filter((value) => Number.isFinite(parseDateTimeMs(value, "actual")));
      assertion.actual = {
        typeValues: datedValues,
        rawTypeValues: snapshot.typeValues,
        ignoredNonDateValues: [...new Set(snapshot.typeValues.filter((value) => !Number.isFinite(parseDateTimeMs(value, "actual"))))],
        empty: snapshot.empty,
        diagnostics: snapshot.diagnostics
      };
      if (!datedValues.length) {
        await this.page.waitForTimeout(300);
        continue;
      }
      const invalid = datedValues.filter((value) => {
        const actualMs = parseDateTimeMs(value, "actual");
        return actualMs < startMs || actualMs > endMs;
      });
      if (!invalid.length) return;
      throw new Error(`Expected all ${assertion.column ?? "date column"} values between ${range.start} and ${range.end}, but found: ${[...new Set(invalid)].join(" | ")}.`);
    }
    throw new Error(`Timed out waiting for table date range assertion. Last observed values: ${(lastSnapshot?.typeValues ?? []).join(" | ") || "none"}. Diagnostics: ${lastSnapshot?.diagnostics.rootCause ?? "unknown"}.`);
  }

  private async readDomTableSnapshot(assertion: DslAssertion): Promise<FundFlowTableSnapshot> {
    const requestedColumn = String(assertion.column ?? assertion.intent?.field ?? "").trim();
    const expected = assertion.expected === undefined ? undefined : String(assertion.expected);
    const tableContract = await this.resolveDataTableContract(assertion);
    const snapshot = await this.page.locator("body").evaluate(
      (body, input) => {
        const normalize = (value: string): string => value.replace(/\s+/g, "").trim();
        const normalizeField = (value: string): string => normalize(value).toLowerCase();
        const textOf = (element: Element | null | undefined): string => (element?.textContent || "").replace(/\s+/g, " ").trim();
        const isVisible = (element: Element): boolean => {
          const html = element as HTMLElement;
          const rect = html.getBoundingClientRect();
          const style = window.getComputedStyle(html);
          return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
        };
        const isAmountLike = (value: string): boolean => /^[+-]?\d+(?:\.\d+)?$/.test(value.replace(/,/g, "").trim());
        const isAction = (value: string): boolean => /^(查看|查看详情|详情|操作|View|Details)$/i.test(value.trim());
        const isStatus = (value: string): boolean => /^(成功|已完成|失败|处理中|待审核|Success|Completed|Failed|Pending)$/i.test(value.trim());
        const isDateTime = (value: string): boolean => /^\d{4}[-/]\d{1,2}[-/]\d{1,2}\s+\d{1,2}:\d{2}(?::\d{2})?$/.test(value.trim());
        const rowBlocksFromVisibleText = (visibleText: string, headers: string[], contract?: PageModelDataTableContractInput): string[][] => {
          if (!headers.length) return [];
          const lines = visibleText.split(/\n+/).map((line) => line.trim()).filter(Boolean);
          const headerStart = lines.findIndex((line, index) => headers.every((header, offset) => normalize(lines[index + offset] || "") === normalize(header)));
          const dataLines = lines.slice(headerStart >= 0 ? headerStart + headers.length : 0)
            .filter((line) => !headers.some((header) => normalize(header) === normalize(line)))
            .filter((line) => line !== "查询" && line !== "重置");
          const columns = contract?.columns ?? headers.map((label) => ({ label, field: label, cellType: "text" }));
          const amountIndex = columns.findIndex((column) => ["amount", "number"].includes(String(column.cellType ?? "").toLowerCase()) || ["数量", "金额"].includes(column.label));
          const statusIndex = columns.findIndex((column) => String(column.cellType ?? "").toLowerCase() === "status" || normalize(column.label) === normalize("状态"));
          if (amountIndex < 0) return [];
          const blocks: string[][] = [];
          for (let index = 0; index < dataLines.length; index += 1) {
            if (!isAmountLike(dataLines[index])) continue;
            if (statusIndex > amountIndex && !isStatus(dataLines[index + (statusIndex - amountIndex)] || "")) continue;
            const amountLineIndex = index;
            const start = Math.max(0, amountLineIndex - amountIndex - 2);
            const end = Math.min(dataLines.length, amountLineIndex + Math.max(2, columns.length - amountIndex + 1));
            const block = dataLines.slice(start, end).filter((line) => !isAction(line));
            if (block.length >= Math.max(2, columns.length - 2) && (block.some(isDateTime) || block.some(isStatus))) blocks.push(block);
          }
          return blocks;
        };
        const extractContractValue = (row: string[], column: PageModelDataTableColumnInput, columns: PageModelDataTableColumnInput[]): string => {
          const label = column.label || column.field;
          const normalizedLabel = normalizeField(label);
          const normalizedField = normalizeField(column.field || label);
          const cellType = String(column.cellType ?? "").toLowerCase();
          if (cellType === "asset_identity" || normalizedField === "asset" || normalizedLabel === normalizeField("币种")) {
            const codePattern = /^[A-Z0-9]{2,12}$/;
            return row.find((cell) => codePattern.test(cell) && !isStatus(cell)) ?? "";
          }
          if (cellType === "datetime" || normalizedLabel === normalizeField("时间")) return row.find(isDateTime) ?? "";
          if (cellType === "amount" || cellType === "number" || normalizedLabel === normalizeField("数量") || normalizedLabel === normalizeField("金额")) return row.find(isAmountLike) ?? "";
          if (cellType === "status" || normalizedLabel === normalizeField("状态")) return row.find(isStatus) ?? "";
          const amountIndex = row.findIndex(isAmountLike);
          const targetIndex = columns.findIndex((item) => normalizeField(item.label || item.field) === normalizedLabel || normalizeField(item.field || item.label) === normalizedField);
          const amountColumnIndex = columns.findIndex((item) => {
            const itemType = String(item.cellType ?? "").toLowerCase();
            const itemLabel = normalizeField(item.label || item.field);
            return itemType === "amount" || itemType === "number" || itemLabel === normalizeField("数量") || itemLabel === normalizeField("金额");
          });
          if (amountIndex >= 0 && targetIndex >= 0 && amountColumnIndex >= 0) {
            const offset = amountColumnIndex - targetIndex;
            const value = row[amountIndex - offset];
            if (value && !isAction(value)) return value;
          }
          return "";
        };
        const emptyPattern = /暂无|无记录|暂无数据|No records|No data/i;
        const collectTable = (root: Element) => {
          const headers = Array.from(root.querySelectorAll("thead th,[role='columnheader'],[data-slot='table-head'],.ant-table-thead th"))
            .filter(isVisible)
            .map(textOf)
            .filter(Boolean);
          const rows = Array.from(root.querySelectorAll("tbody tr,[role='row'],[data-slot='table-row']"))
            .filter(isVisible)
            .filter((row) => !row.closest("thead") && !row.querySelector("th,[role='columnheader'],[data-slot='table-head']"))
            .map((row) => Array.from(row.querySelectorAll("td,[role='cell'],[data-slot='table-cell'],.ant-table-cell"))
              .filter(isVisible)
              .map(textOf)
              .filter(Boolean))
            .filter((cells) => cells.length > 0);
          const emptyTexts = Array.from(root.querySelectorAll(".ant-empty,.ant-table-placeholder,[data-slot='empty'],[role='status'],[aria-live]"))
            .filter(isVisible)
            .map(textOf)
            .filter((text) => emptyPattern.test(text));
          return { headers, rows, scopedEmptyText: emptyTexts[0] ?? "" };
        };
        const roots = Array.from(body.querySelectorAll("table,[role='table'],[role='grid'],[data-slot='table-container'],.ant-table,.ant-table-container,.ant-table-wrapper"))
          .filter(isVisible);
        const snapshots = roots.map(collectTable).filter((item) => item.headers.length || item.rows.length || item.scopedEmptyText);
        const requested = normalize(input.requestedColumn);
        const contract = input.tableContract;
        const contractHeaders = Array.isArray(contract?.columns) ? contract.columns.map((column) => column.label).filter(Boolean) : [];
        const selected = snapshots.find((item) => item.headers.some((header) => normalize(header) === requested))
          ?? snapshots.find((item) => item.headers.length && item.rows.length)
          ?? snapshots[0];
        const selectedHeaders = selected?.headers.length ? selected.headers : contractHeaders;
        if (!selected && !contract) return undefined;
        const matchedContractColumn = contract?.columns?.find((column) => normalize(column.label) === requested || normalize(column.field) === requested || (column.subFields ?? []).some((field) => normalize(field) === requested));
        const columnIndex = selectedHeaders.findIndex((header) => normalize(header) === requested);
        const contractRows = contract
          ? rowBlocksFromVisibleText(textOf(body), selectedHeaders, contract)
          : [];
        const values = matchedContractColumn
          ? contractRows.map((row) => extractContractValue(row, matchedContractColumn, contract?.columns ?? [])).filter(Boolean)
          : columnIndex >= 0 && selected
            ? selected.rows.map((row) => row[columnIndex] ?? "").map((value) => value.trim()).filter(Boolean)
            : [];
        const globalEmptyVisible = emptyPattern.test(textOf(body));
        const rowCount = contractRows.length || selected?.rows.length || 0;
        const scopedEmptyText = selected?.scopedEmptyText ?? "";
        const empty = values.length > 0 ? false : rowCount === 0 && Boolean(scopedEmptyText);
        const loading = !empty && Boolean(body.querySelector("[data-slot='skeleton'],.ant-skeleton,.skeleton,[aria-busy='true']"));
        const rootCause = values.length
          ? "values_extracted"
          : empty
            ? "empty_state_visible"
            : loading
              ? "table_loading"
              : contract && matchedContractColumn && contractRows.length
                ? "contract_values_not_extracted"
              : contract && !matchedContractColumn
                ? "contract_column_not_mapped"
              : columnIndex < 0
                ? "assertion_column_not_observable"
                : selectedHeaders.length && !rowCount
                  ? "headers_ready_rows_pending"
                  : "table_values_not_extracted";
        return {
          typeValues: values,
          empty,
          loading,
          diagnostics: {
            requestedColumn: input.requestedColumn,
            expected: input.expected,
            observedHeaders: selectedHeaders,
            selectedFilters: [],
            rowSample: (contractRows.length ? contractRows : selected?.rows ?? []).slice(0, 5).flat().slice(0, 40),
            extractionStrategy: contract ? "page_model_data_table_contract" : "dom_table_headers_and_cells",
            emptyStateScope: scopedEmptyText ? "selected_table_container" : globalEmptyVisible ? "body_ignored" : "none",
            emptyStateText: scopedEmptyText || undefined,
            ignoredGlobalEmptyState: values.length > 0 && globalEmptyVisible,
            tableReadiness: {
              loading,
              headersReady: selectedHeaders.length > 0,
              rowsReady: rowCount > 0,
              rowCount
            },
            columnResolution: {
              requestedColumn: input.requestedColumn,
              matchedHeaderIndex: columnIndex,
              matchedContractField: matchedContractColumn?.field,
              matchedContractCellType: matchedContractColumn?.cellType,
              tableContractId: contract?.regionId || contract?.componentId,
              observedHeaders: selectedHeaders
            },
            rootCause
          }
        };
      },
      { requestedColumn, expected, tableContract }
    );
    if (!snapshot) throw new Error("No observable result table was found in DOM.");
    return snapshot;
  }

  private async resolveDataTableContract(assertion: DslAssertion): Promise<PageModelDataTableContract | undefined> {
    const contracts = await this.loadPageModelTableContracts();
    const requestedTable = normalizeContractKey(String(assertion.table ?? ""));
    const requestedColumn = normalizeContractKey(String(assertion.column ?? assertion.intent?.field ?? ""));
    return contracts.find((contract) => {
      const contractKeys = [contract.regionId, contract.componentId, contract.tableId, contract.semanticName].map((item) => normalizeContractKey(item ?? ""));
      const tableMatched = !requestedTable || contractKeys.some((key) => key && (key === requestedTable || key.endsWith(requestedTable) || requestedTable.endsWith(key)));
      const columnMatched = !requestedColumn || contract.columns.some((column) => {
        const keys = [column.label, column.field, ...(column.aliases ?? []), ...(column.subFields ?? [])].map((item) => normalizeContractKey(item ?? ""));
        return keys.some((key) => key === requestedColumn);
      });
      return tableMatched && columnMatched;
    });
  }

  private async loadPageModelTableContracts(): Promise<PageModelDataTableContract[]> {
    if (this.pageModelTableContracts) return this.pageModelTableContracts;
    const filePath = path.join(this.context.rootDir, "storage", "page-models", `${this.context.project.projectKey}.json`);
    const data = await fs.readJson(filePath).catch(() => undefined) as { pages?: Array<Record<string, unknown>>; models?: Array<Record<string, unknown>>; pageModels?: Array<Record<string, unknown>> } | undefined;
    const contracts: PageModelDataTableContract[] = [];
    const pageModels = data?.pages ?? data?.models ?? data?.pageModels ?? [];
    for (const page of pageModels) {
      const regions = Array.isArray(page.regions) ? page.regions as Array<Record<string, unknown>> : [];
      const components = Array.isArray(page.components) ? page.components as Array<Record<string, unknown>> : [];
      for (const item of [...regions, ...components]) {
        const type = String(item.type ?? item.componentType ?? item.regionType ?? "").toLowerCase();
        if (type !== "data_table" && type !== "table" && type !== "list_table") continue;
        const columns = Array.isArray(item.columns) ? normalizeDataTableColumns(item.columns as Array<Record<string, unknown>>) : [];
        if (!columns.length) continue;
        contracts.push({
          regionId: String(item.regionId ?? item.id ?? item.componentId ?? ""),
          componentId: String(item.componentId ?? item.id ?? item.regionId ?? ""),
          tableId: String(item.tableId ?? item.table ?? ""),
          semanticName: String(item.semanticName ?? item.name ?? ""),
          columns
        });
      }
    }
    this.pageModelTableContracts = contracts;
    return contracts;
  }

  async getCurrentUrlOrActivity(): Promise<string> {
    return this.page.url();
  }

  async getPageTitle(): Promise<string> {
    return this.page.title();
  }

  async getVisibleTextSnapshot(): Promise<{ capturedAt: string; url: string; title: string; visibleTexts: string[] }> {
    return {
      capturedAt: new Date().toISOString(),
      url: this.page.url(),
      title: await this.page.title().catch(() => ""),
      visibleTexts: await this.readVisibleTextSnippets().catch(() => [])
    };
  }

  async getInteractiveElements(): Promise<BootstrapInteractiveElement[]> {
    return (await this.readControlSummaryWithBoxes()).map((item) => ({
      tag: item.tag,
      role: item.role,
      text: item.text,
      placeholder: item.placeholder,
      ariaLabel: item.ariaLabel,
      name: item.name,
      id: item.id,
      href: item.href,
      selector: item.selector,
      elementType: elementTypeFromTag(item.tag, item.role, item.href),
      riskLevel: classifyElementRisk([item.text, item.ariaLabel, item.placeholder, item.href].filter(Boolean).join(" ")),
      boundingBox: {
        x: Math.round(item.x - item.width / 2),
        y: Math.round(item.y - item.height / 2),
        width: Math.round(item.width),
        height: Math.round(item.height)
      }
    }));
  }

  async navigate(url: string): Promise<void> {
    await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  }

  async close(): Promise<void> {
    await this.runtime.close();
  }

  async semanticLocator(target: string, elementType?: string): Promise<string | undefined> {
    const candidates = [
      ...(await this.findSemanticLocators(target, elementType === "input" ? "input" : "click")).map((item) => item.locator),
      ...semanticCandidates(target, elementType)
    ];
    for (const candidate of [...new Set(candidates)]) {
      const count = await this.resolveLocator(candidate).count().catch(() => 0);
      if (count > 0) return candidate;
    }
    return undefined;
  }

  async findSemanticLocators(semanticTarget: string, actionType: string): Promise<SemanticLocatorCandidate[]> {
    return matchSemanticLocators({
      semanticTarget,
      actionType,
      platform: "web",
      pageStructure: { controls: await this.readControlSummary() }
    });
  }

  async findVisualTargets(semanticTarget: string, actionType: string): Promise<VisualTargetCandidate[]> {
    const target = normalizeText(semanticTarget);
    const controls = await this.readControlSummaryWithBoxes();
    return controls
      .map((control) => {
        const values = [control.text, control.placeholder, control.ariaLabel, control.name, control.id, control.testId].filter(Boolean) as string[];
        const haystack = normalizeText(values.join(" "));
        const textScore = haystack === target ? 100 : haystack.includes(target) ? 70 : target.split(/\s+/).reduce((sum, term) => sum + (haystack.includes(term) ? 10 : 0), 0);
        const actionScore =
          actionType === "input" && ["input", "textarea", "select"].includes(control.tag) ? 30 : actionType === "click" && ["button", "a"].includes(control.tag) ? 25 : 0;
        return {
          x: control.x,
          y: control.y,
          width: control.width,
          height: control.height,
          score: textScore + actionScore,
          reason: `Visual target matched by ${values.join(" / ")}`.slice(0, 240),
          locator: control.selector,
          textCandidates: values.slice(0, 10),
          nearbyTexts: [control.href].filter(Boolean) as string[]
        };
      })
      .filter((item) => item.score > 0 && item.width > 0 && item.height > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8);
  }

  async clickAt(x: number, y: number): Promise<void> {
    await this.page.mouse.click(x, y);
  }

  async inputAt(x: number, y: number, text: string): Promise<void> {
    await this.page.mouse.click(x, y);
    await this.page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A").catch(() => undefined);
    await this.page.keyboard.type(text);
  }

  private async readControlSummary(): Promise<
    Array<{
      tag: string;
      text?: string;
      placeholder?: string;
      ariaLabel?: string;
      role?: string;
      id?: string;
      name?: string;
      testId?: string;
      href?: string;
      selector?: string;
    }>
  > {
    return this.page.locator("body").evaluate((body) =>
      Array.from(body.querySelectorAll("button,a,input,textarea,select,[role='button'],[role='textbox'],[role='combobox']"))
        .slice(0, 500)
        .map((item) => {
          const element = item as HTMLElement;
          const tag = element.tagName.toLowerCase();
          const id = element.getAttribute("id") ?? undefined;
          const name = element.getAttribute("name") ?? undefined;
          const testId = element.getAttribute("data-testid") ?? element.getAttribute("data-test") ?? element.getAttribute("data-qa") ?? undefined;
          const placeholder = element.getAttribute("placeholder") ?? undefined;
          const ariaLabel = element.getAttribute("aria-label") ?? undefined;
          const text = (element.innerText || element.textContent || "").trim().slice(0, 120) || undefined;
          return {
            tag,
            text,
            placeholder,
            ariaLabel,
            role: element.getAttribute("role") ?? undefined,
            id,
            name,
            testId,
            href: element instanceof HTMLAnchorElement ? element.href : element.getAttribute("href") ?? undefined,
            selector: testId
              ? `[data-testid="${testId.replace(/"/g, '\\"')}"]`
              : id
                ? `#${id.replace(/([ #;?%&,.+*~':"!^$[\]()=>|/@])/g, "\\$1")}`
                : name
                  ? `${tag}[name="${name.replace(/"/g, '\\"')}"]`
                  : placeholder
                    ? `${tag}[placeholder*="${placeholder.replace(/"/g, '\\"')}"]`
                    : ariaLabel
                      ? `[aria-label*="${ariaLabel.replace(/"/g, '\\"')}"]`
                      : tag === "button" && text
                        ? `role=button:${text}`
                        : text
                          ? `text=${text}`
                          : undefined
          };
        })
    );
  }

  private async readVisibleTextSnippets(): Promise<string[]> {
    return this.page.locator("body").evaluate((body) => {
      const raw = (body as HTMLElement).innerText || "";
      return Array.from(
        new Set(
          raw
            .split(/\n+/)
            .map((item) => item.trim())
            .filter((item) => item.length >= 2 && item.length <= 80)
        )
      ).slice(0, 120);
    });
  }

  private async readControlSummaryWithBoxes(): Promise<
    Array<{
      tag: string;
      text?: string;
      placeholder?: string;
      ariaLabel?: string;
      role?: string;
      id?: string;
      name?: string;
      testId?: string;
      href?: string;
      selector?: string;
      x: number;
      y: number;
      width: number;
      height: number;
    }>
  > {
    return this.page.locator("body").evaluate((body) =>
      Array.from(body.querySelectorAll("button,a,input,textarea,select,[role='button'],[role='textbox'],[role='combobox']"))
        .slice(0, 500)
        .map((item) => {
          const element = item as HTMLElement;
          const rect = element.getBoundingClientRect();
          const tag = element.tagName.toLowerCase();
          const id = element.getAttribute("id") ?? undefined;
          const name = element.getAttribute("name") ?? undefined;
          const testId = element.getAttribute("data-testid") ?? element.getAttribute("data-test") ?? element.getAttribute("data-qa") ?? undefined;
          const placeholder = element.getAttribute("placeholder") ?? undefined;
          const ariaLabel = element.getAttribute("aria-label") ?? undefined;
          const text = (element.innerText || element.textContent || "").trim().slice(0, 120) || undefined;
          const href = element instanceof HTMLAnchorElement ? element.href : element.getAttribute("href") ?? undefined;
          const selector = testId
            ? `[data-testid="${testId.replace(/"/g, '\\"')}"]`
            : id
              ? `#${id.replace(/([ #;?%&,.+*~':"!^$[\]()=>|/@])/g, "\\$1")}`
              : name
                ? `${tag}[name="${name.replace(/"/g, '\\"')}"]`
                : placeholder
                  ? `${tag}[placeholder*="${placeholder.replace(/"/g, '\\"')}"]`
                  : ariaLabel
                    ? `[aria-label*="${ariaLabel.replace(/"/g, '\\"')}"]`
                    : tag === "button" && text
                      ? `role=button:${text}`
                      : text
                        ? `text=${text}`
                        : undefined;
          return {
            tag,
            text,
            placeholder,
            ariaLabel,
            role: element.getAttribute("role") ?? undefined,
            id,
            name,
            testId,
            href,
            selector,
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
            width: rect.width,
            height: rect.height
          };
        })
    );
  }

  private resolveLocator(locator: string): Locator {
    if (/^scope:dialog\s*>>\s*first visible amount input$/i.test(locator.trim())) {
      return this.page.locator("xpath=(//*[@role='dialog'])[last()]//*[self::input or self::textarea or @role='textbox'][not(@disabled)]").first();
    }
    if (locator.startsWith("fieldRelative=")) {
      const role = parseFieldRelativeLocator(locator).role;
      return this.page.locator(role === "combobox" ? "[role='combobox'],select,input" : "input,textarea,[role='textbox']").first();
    }
    const nthMatch = locator.match(/^(.*?)(?:\s*>>\s*nth=(\d+))$/);
    if (nthMatch) {
      return this.resolveLocator(nthMatch[1].trim()).nth(Number(nthMatch[2]));
    }
    if (locator.startsWith("css=")) return this.page.locator(locator.slice("css=".length));
    if (locator.startsWith("role=")) {
      const [, roleAndName] = locator.split("=", 2);
      const [role, name] = roleAndName.split(":");
      return this.page.getByRole(role.trim() as never, name ? { name: new RegExp(escapeRegExp(name.trim()), "i") } : undefined);
    }
    if (locator.startsWith("textExact=")) return this.page.getByText(locator.slice("textExact=".length), { exact: true });
    if (locator.startsWith("text=")) return this.page.getByText(locator.slice(5), { exact: false });
    if (locator.startsWith("xpath=")) return this.page.locator(locator);
    return this.page.locator(locator);
  }

  private async resolveFieldRelativeLocator(locator: string, fallbackRole: "input" | "combobox"): Promise<Locator> {
    const spec = parseFieldRelativeLocator(locator);
    const role = spec.role || fallbackRole;
    const label = spec.label?.trim();
    const controlXPath = role === "combobox"
      ? "*[@role='combobox' or self::select or self::input]"
      : "*[self::input or self::textarea or @role='textbox']";
    const scopePrefix = spec.scope === "dialog"
      ? "(//*[@role='dialog' or contains(concat(' ', normalize-space(@class), ' '), ' modal ') or contains(@class, 'ant-modal')])[last()]"
      : "//*";
    const candidates = label
      ? [
          `xpath=${scopePrefix}//*[contains(normalize-space(.), ${xpathStringLiteral(label)})]/following::${controlXPath}[1]`,
          `xpath=(//*[contains(normalize-space(.), ${xpathStringLiteral(label)})]/following::${controlXPath}[1])[last()]`
        ]
      : [];
    for (const candidate of candidates) {
      const item = this.resolveLocator(candidate).first();
      if (await item.isVisible({ timeout: 1_000 }).catch(() => false)) return item;
    }
    if (spec.scope === "dialog") {
      const dialogControls = this.page.locator(
        role === "combobox"
          ? "xpath=(//*[@role='dialog' or contains(concat(' ', normalize-space(@class), ' '), ' modal ') or contains(@class, 'ant-modal')])[last()]//*[@role='combobox' or self::select or self::input]"
          : "xpath=(//*[@role='dialog' or contains(concat(' ', normalize-space(@class), ' '), ' modal ') or contains(@class, 'ant-modal')])[last()]//*[self::input or self::textarea or @role='textbox'][not(@disabled)]"
      );
      if (await dialogControls.first().isVisible({ timeout: 1_000 }).catch(() => false)) return dialogControls.first();
      throw new Error(`No visible ${role} matched fieldRelative locator inside dialog: ${locator}`);
    }
    const controls = this.page.locator(role === "combobox" ? "[role='combobox'],select,input" : "input,textarea,[role='textbox']");
    return controls.first();
  }
}

interface FundFlowTableSnapshot {
  typeValues: string[];
  empty: boolean;
  loading: boolean;
  diagnostics: {
    requestedColumn: string;
    expected?: string;
    observedHeaders: string[];
    selectedFilters: Array<Record<string, unknown>>;
    rowSample: string[];
    extractionStrategy: string;
    tableReadiness?: Record<string, unknown>;
    columnResolution?: Record<string, unknown>;
    emptyStateScope?: string;
    emptyStateText?: string;
    ignoredGlobalEmptyState?: boolean;
    rootCause: string;
  };
}

interface PageModelDataTableColumn {
  field: string;
  label: string;
  cellType?: string;
  aliases?: string[];
  subFields?: string[];
}

interface PageModelDataTableContract {
  regionId?: string;
  componentId?: string;
  tableId?: string;
  semanticName?: string;
  columns: PageModelDataTableColumn[];
}

type PageModelDataTableColumnInput = PageModelDataTableColumn;
type PageModelDataTableContractInput = PageModelDataTableContract;

export function readFundFlowTableSnapshot(
  visibleText: string,
  assertion?: Pick<DslAssertion, "column" | "expected" | "intent" | "runtimeSelectedFilters">,
  tableContract?: PageModelDataTableContract
): FundFlowTableSnapshot {
  const lines = visibleText
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const tableStart = Math.max(
    lines.findIndex((line) => line === "币种"),
    0
  );
  const tableLines = lines.slice(tableStart);
  const emptyTextVisible = /暂无|无记录|暂无数据|No records|No data/i.test(visibleText);
  const loading = !emptyTextVisible && /币种/.test(visibleText) && tableLines.some((line) => /^[-\u2013\u2014_]{3,}$/.test(line));
  const observedHeaders = extractObservedTableHeaders(lines);
  const requestedColumn = String(assertion?.column ?? assertion?.intent?.field ?? "").trim();
  const knownTypes = new Set([
    "外部充值",
    "内部转入",
    "提现记录",
    "内部转出",
    "邀请奖励",
    "赠币",
    "合约划转",
    "杠杆划转",
    "交易",
    "经纪人返佣",
    "手续费",
    "活动",
    "卡片",
    "红包发放",
    "红包领取",
    "红包退款",
    "理财划转",
    "提现",
    "申购",
    "转入",
    "转出",
    "划转",
    "充值"
  ]);
  const typeValues = tableLines.filter((line) => knownTypes.has(line) || /^账户划转[-：]?(?:转入|转出)$/.test(line));
  const anchoredValues = extractColumnValuesByAmountAnchor(tableLines, observedHeaders, requestedColumn);
  if (anchoredValues.length) typeValues.splice(0, typeValues.length, ...anchoredValues);
  const contractRows = extractVisibleTextRowsByAmountAnchor(visibleText, observedHeaders.length ? observedHeaders : tableContract?.columns.map((item) => item.label).filter(Boolean) ?? [], tableContract ?? { columns: [] });
  const contractValues = tableContract
    ? extractVisibleTextValuesByDataTableContract(visibleText, observedHeaders, requestedColumn, tableContract)
    : [];
  if (contractValues.length) typeValues.splice(0, typeValues.length, ...contractValues);
  const uniqueTypeValues = [...new Set(typeValues)];
  const empty = uniqueTypeValues.length > 0 ? false : emptyTextVisible;
  const diagnostics = buildTableAssertionDiagnostics({
    lines,
    tableLines,
    typeValues: uniqueTypeValues,
    empty,
    loading,
    assertion,
    tableContract,
    extractionStrategy: contractValues.length ? "page_model_data_table_contract" : undefined,
    observedRowCount: contractRows.length || undefined
  });
  return { typeValues: uniqueTypeValues, empty, loading, diagnostics };
}

function extractVisibleTextValuesByDataTableContract(visibleText: string, headers: string[], requestedColumn: string, contract?: PageModelDataTableContract): string[] {
  if (!contract?.columns?.length || !requestedColumn) return [];
  const requested = normalizeContractKey(requestedColumn);
  const column = contract.columns.find((item) => {
    const keys = [item.label, item.field, ...(item.aliases ?? []), ...(item.subFields ?? [])].map((value) => normalizeContractKey(value));
    return keys.includes(requested);
  });
  if (!column) return [];
  const contractHeaders = headers.length ? headers : contract.columns.map((item) => item.label).filter(Boolean);
  const rows = extractVisibleTextRowsByAmountAnchor(visibleText, contractHeaders, contract);
  return rows.map((row) => extractContractColumnValue(row, column, contract.columns)).filter(Boolean);
}

function extractVisibleTextRowsByAmountAnchor(visibleText: string, headers: string[], contract: PageModelDataTableContract): string[][] {
  if (!headers.length) return [];
  const lines = visibleText.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const headerStart = lines.findIndex((line, index) => headers.every((header, offset) => normalizeAssertionCell(lines[index + offset] || "") === normalizeAssertionCell(header)));
  const dataLines = lines.slice(headerStart >= 0 ? headerStart + headers.length : firstTableHeaderRunStart(lines))
    .filter((line) => !headers.some((header) => normalizeAssertionCell(header) === normalizeAssertionCell(line)))
    .filter((line) => line !== "查询" && line !== "重置")
    .filter((line) => !isLikelyActionCell(line));
  const amountColumnIndex = contract.columns.findIndex((item) => {
    const type = String(item.cellType ?? "").toLowerCase();
    const label = normalizeAssertionCell(item.label);
    return type === "amount" || type === "number" || label === normalizeAssertionCell("数量") || label === normalizeAssertionCell("金额");
  });
  const statusColumnIndex = contract.columns.findIndex((item) => {
    const type = String(item.cellType ?? "").toLowerCase();
    const label = normalizeAssertionCell(item.label);
    return type === "status" || label === normalizeAssertionCell("状态");
  });
  if (amountColumnIndex < 0) return [];
  const rows: string[][] = [];
  for (let index = 0; index < dataLines.length; index += 1) {
    if (!isAmountLikeCell(dataLines[index])) continue;
    if (statusColumnIndex > amountColumnIndex && !isStatusLikeCell(dataLines[index + (statusColumnIndex - amountColumnIndex)] || "")) continue;
    const start = Math.max(0, index - amountColumnIndex - 2);
    const end = Math.min(dataLines.length, index + Math.max(2, contract.columns.length - amountColumnIndex + 1));
    const row = dataLines.slice(start, end);
    if (row.length >= Math.max(2, contract.columns.length - 2) && (row.some(isDateTimeLikeCell) || row.some(isStatusLikeCell))) rows.push(row);
  }
  return rows;
}

function extractContractColumnValue(row: string[], column: PageModelDataTableColumn, columns: PageModelDataTableColumn[]): string {
  const normalizedLabel = normalizeContractKey(column.label);
  const normalizedField = normalizeContractKey(column.field);
  const cellType = String(column.cellType ?? "").toLowerCase();
  if (cellType === "asset_identity" || normalizedField === "asset" || normalizedLabel === normalizeContractKey("币种")) {
    return row.find((cell) => /^[A-Z0-9]{2,12}$/.test(cell) && !isStatusLikeCell(cell)) ?? "";
  }
  if (cellType === "datetime" || normalizedLabel === normalizeContractKey("时间")) return row.find(isDateTimeLikeCell) ?? "";
  if (cellType === "amount" || cellType === "number" || normalizedLabel === normalizeContractKey("数量") || normalizedLabel === normalizeContractKey("金额")) return row.find(isAmountLikeCell) ?? "";
  if (cellType === "status" || normalizedLabel === normalizeContractKey("状态")) return row.find(isStatusLikeCell) ?? "";
  const amountIndex = row.findIndex(isAmountLikeCell);
  const targetIndex = columns.findIndex((item) => normalizeContractKey(item.label) === normalizedLabel || normalizeContractKey(item.field) === normalizedField);
  const amountColumnIndex = columns.findIndex((item) => {
    const type = String(item.cellType ?? "").toLowerCase();
    const label = normalizeContractKey(item.label);
    return type === "amount" || type === "number" || label === normalizeContractKey("数量") || label === normalizeContractKey("金额");
  });
  if (amountIndex >= 0 && targetIndex >= 0 && amountColumnIndex >= 0) {
    const value = row[amountIndex - (amountColumnIndex - targetIndex)];
    if (value && !isLikelyActionCell(value)) return value;
  }
  return "";
}

function extractObservedTableHeaders(lines: string[]): string[] {
  const headerRuns: string[][] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (isCommonTableHeader(line)) {
      current.push(line);
      continue;
    }
    if (current.length >= 3) headerRuns.push(current);
    current = [];
  }
  if (current.length >= 3) headerRuns.push(current);
  const actionRun = [...headerRuns].reverse().find((run) => run.some(isTableActionHeader));
  return actionRun ?? headerRuns[headerRuns.length - 1] ?? [];
}

function extractColumnValuesByAmountAnchor(tableLines: string[], headers: string[], requestedColumn: string): string[] {
  const targetIndex = headers.findIndex((header) => normalizeAssertionCell(header) === normalizeAssertionCell(requestedColumn));
  const amountIndex = headers.findIndex((header) => {
    const normalized = normalizeAssertionCell(header);
    return normalized === normalizeAssertionCell("数量") || normalized === normalizeAssertionCell("金额");
  });
  if (targetIndex < 0 || amountIndex < 0 || targetIndex === amountIndex) return [];
  const headerEnd = findHeaderEndIndex(tableLines, headers);
  const dataLines = tableLines.slice(headerEnd + 1).filter((line) => !isCommonTableHeader(line));
  const offsetFromAmount = amountIndex - targetIndex;
  const values: string[] = [];
  for (let index = 0; index < dataLines.length; index += 1) {
    if (!isAmountLikeCell(dataLines[index])) continue;
    const value = dataLines[index - offsetFromAmount];
    if (value && !isAmountLikeCell(value) && !isCommonTableHeader(value) && !isLikelyActionCell(value)) values.push(value);
  }
  return values;
}

function findHeaderEndIndex(tableLines: string[], headers: string[]): number {
  if (!headers.length) return -1;
  for (let index = 0; index < tableLines.length; index += 1) {
    if (normalizeAssertionCell(tableLines[index]) !== normalizeAssertionCell(headers[0])) continue;
    let cursor = index;
    let matched = 0;
    for (const header of headers) {
      while (cursor < tableLines.length && normalizeAssertionCell(tableLines[cursor]) !== normalizeAssertionCell(header)) cursor += 1;
      if (cursor >= tableLines.length) break;
      matched += 1;
      cursor += 1;
    }
    if (matched === headers.length) return cursor - 1;
  }
  return headers.length - 1;
}

function isAmountLikeCell(value: string): boolean {
  return /^[+-]?\d+(?:\.\d+)?$/.test(value.replace(/,/g, "").trim());
}

function isDateTimeLikeCell(value: string): boolean {
  return /^\d{4}[-/]\d{1,2}[-/]\d{1,2}\s+\d{1,2}:\d{2}(?::\d{2})?$/.test(value.trim());
}

function isStatusLikeCell(value: string): boolean {
  return /^(成功|已完成|失败|处理中|待审核|Success|Completed|Failed|Pending)$/i.test(value.trim());
}

function isLikelyActionCell(value: string): boolean {
  return /^(查看|查看详情|详情|操作|View|Details)$/i.test(value.trim());
}

function extractSelectedFilters(lines: string[]): Array<{ label: string; value: string }> {
  const labels = new Set(["时间", "币种", "类型", "产品类型", "交易类型", "状态"]);
  const stops = new Set(["查询", "重置"]);
  const filters: Array<{ label: string; value: string }> = [];
  const searchLines = lines.slice(0, firstTableHeaderRunStart(lines));
  for (let index = 0; index < searchLines.length - 1; index += 1) {
    const label = searchLines[index];
    const value = searchLines[index + 1];
    if (!labels.has(label) || labels.has(value) || stops.has(value) || isCommonTableHeader(value)) continue;
    filters.push({ label, value });
  }
  return filters;
}

function isCommonTableHeader(value: string): boolean {
  return new Set(["时间", "币种", "类型", "产品类型", "产品名称", "数量", "金额", "状态", "操作"]).has(value);
}

function firstTableHeaderRunStart(lines: string[]): number {
  let currentStart = -1;
  let currentLength = 0;
  for (let index = 0; index < lines.length; index += 1) {
    if (isCommonTableHeader(lines[index])) {
      if (currentStart < 0) currentStart = index;
      currentLength += 1;
      continue;
    }
    if (currentLength >= 3) return currentStart;
    currentStart = -1;
    currentLength = 0;
  }
  return currentLength >= 3 ? currentStart : lines.length;
}

function isTableActionHeader(value: string): boolean {
  return value === "操作";
}

function buildTableAssertionDiagnostics(input: {
  lines: string[];
  tableLines: string[];
  typeValues: string[];
  empty: boolean;
  loading: boolean;
  assertion?: Pick<DslAssertion, "column" | "expected" | "intent" | "runtimeSelectedFilters">;
  tableContract?: PageModelDataTableContract;
  extractionStrategy?: string;
  observedRowCount?: number;
}): FundFlowTableSnapshot["diagnostics"] {
  const observedHeaders = extractObservedTableHeaders(input.lines);
  const selectedFilters = mergeSelectedFilters(
    extractSelectedFilters(input.lines),
    Array.isArray(input.assertion?.runtimeSelectedFilters) ? input.assertion.runtimeSelectedFilters : []
  );
  const requestedColumn = String(input.assertion?.column ?? input.assertion?.intent?.field ?? "").trim();
  const expected = input.assertion?.expected === undefined ? undefined : String(input.assertion.expected);
  const normalizedRequested = normalizeAssertionCell(requestedColumn);
  const requestedColumnMissing = Boolean(normalizedRequested && observedHeaders.length && !observedHeaders.some((header) => normalizeAssertionCell(header) === normalizedRequested));
  const rootCause = requestedColumnMissing
    ? "assertion_column_not_observable"
    : input.typeValues.length
      ? "values_extracted"
      : !input.empty && !input.loading && normalizedRequested && !observedHeaders.some((header) => normalizeAssertionCell(header) === normalizedRequested)
      ? "assertion_column_not_observable"
      : !input.empty && !input.loading && !input.typeValues.length
        ? "table_values_not_extracted"
        : input.empty
          ? "empty_state_visible"
          : input.loading
            ? "table_loading"
            : "values_extracted";
  const rowStart = observedHeaders.length ? firstTableHeaderRunStart(input.tableLines) + observedHeaders.length : 0;
  return {
    requestedColumn,
    expected,
    observedHeaders,
    selectedFilters,
    rowSample: input.tableLines.slice(rowStart, rowStart + 30),
    extractionStrategy: input.extractionStrategy ?? "visible_text_table_headers_and_known_fund_flow_types",
    tableReadiness: {
      loading: input.loading,
      headersReady: observedHeaders.length > 0,
      rowsReady: input.typeValues.length > 0,
      rowCount: input.observedRowCount ?? input.typeValues.length
    },
    rootCause
  };
}

function mergeSelectedFilters(
  observed: Array<{ label: string; value: string }>,
  runtime: Array<{ label?: string; field?: string; value: string; elementId?: string; selectedValueAfter?: string; verified?: boolean }>
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [...observed.map((item) => ({ ...item, source: "visible_text" }))];
  const seen = new Set(out.map((item) => `${item.label ?? ""}:${item.value ?? ""}`.toLowerCase()));
  for (const item of runtime) {
    const value = String(item.value ?? "").trim();
    if (!value) continue;
    const label = String(item.label ?? item.field ?? item.elementId ?? "runtime_filter").trim();
    const key = `${label}:${value}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      label,
      field: item.field,
      value,
      elementId: item.elementId,
      selectedValueAfter: item.selectedValueAfter,
      verified: item.verified,
      source: "runtime_step_trace"
    });
  }
  return out;
}

function normalizeAssertionCell(value: string): string {
  return value.replace(/\s+/g, "").trim();
}

function normalizeDataTableColumns(columns: Array<Record<string, unknown>>): PageModelDataTableColumn[] {
  return columns
    .map((column) => {
      const field = String(column.field ?? column.semanticField ?? column.key ?? column.label ?? "").trim();
      const label = String(column.label ?? column.header ?? column.name ?? field).trim();
      const subFields = Array.isArray(column.subFields)
        ? column.subFields.map((item) => String(item).trim()).filter(Boolean)
        : Array.isArray(column.subfields)
          ? column.subfields.map((item) => String(item).trim()).filter(Boolean)
          : [];
      const aliases = Array.isArray(column.aliases)
        ? column.aliases.map((item) => String(item).trim()).filter(Boolean)
        : [];
      return {
        field,
        label,
        cellType: column.cellType ? String(column.cellType) : column.type ? String(column.type) : undefined,
        aliases,
        subFields
      };
    })
    .filter((column) => column.field || column.label);
}

function normalizeContractKey(value: string): string {
  return value.replace(/\s+/g, "").trim().toLowerCase();
}

function dropdownDisplayMatches(actual: unknown, expected: string): boolean {
  return normalizeAssertionCell(String(actual ?? "")).includes(normalizeAssertionCell(expected));
}

function actionExecutionError(message: string, actionResult: Record<string, unknown>): Error {
  const error = new Error(message);
  (error as Error & { actionResult?: unknown }).actionResult = actionResult;
  return error;
}

function isActionExecutionError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "actionResult" in error);
}

async function displayValueOf(locator: Locator): Promise<string> {
  return locator.evaluate((element) => {
    const input = element as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
    const value = "value" in input ? input.value : "";
    const aria = element.getAttribute("aria-label") ?? "";
    const title = element.getAttribute("title") ?? "";
    const text = (element.textContent || "").replace(/\s+/g, " ").trim();
    return [value, text, aria, title].filter(Boolean).join(" ").trim();
  });
}

async function quickDisplayValueOf(locator: Locator, timeoutMs = 700): Promise<string> {
  const values = await Promise.all([
    locator.inputValue({ timeout: timeoutMs }).catch(() => ""),
    locator.textContent({ timeout: timeoutMs }).catch(() => ""),
    locator.getAttribute("aria-label", { timeout: timeoutMs }).catch(() => ""),
    locator.getAttribute("title", { timeout: timeoutMs }).catch(() => "")
  ]);
  return values
    .map((item) => String(item ?? "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join(" ")
    .trim();
}

async function withShortTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function parseFieldRelativeLocator(locator: string): { scope?: string; label?: string; role?: string; relation?: string } {
  const raw = locator.slice("fieldRelative=".length);
  const result: { scope?: string; label?: string; role?: string; relation?: string } = {};
  for (const segment of raw.split("|")) {
    const [key, ...rest] = segment.split(":");
    const value = rest.join(":").trim();
    if (!key || !value) continue;
    if (key === "scope") result.scope = value;
    else if (key === "label") result.label = value;
    else if (key === "role") result.role = value;
    else if (key === "relation") result.relation = value;
  }
  return result;
}

type RowScopedMatchMode = "exact" | "contains";

type RowScopedLocatorSpec = {
  value?: string;
  conditions: Record<string, string>;
  actionText?: string;
  actionState: "enabled" | "disabled" | "any";
  expandText?: string;
  match: RowScopedMatchMode;
};

function parseRowScopedLocator(locator: string): RowScopedLocatorSpec {
  const raw = locator.slice("rowScoped=".length);
  const result: RowScopedLocatorSpec = { conditions: {}, actionState: "any", match: "exact" };
  for (const segment of raw.split("|")) {
    const [key, ...rest] = segment.split(":");
    const value = rest.join(":").trim();
    if (!key || !value) continue;
    if (key === "value") result.value = value;
    else if (key === "actionText") result.actionText = value;
    else if (key === "actionState") result.actionState = value === "enabled" || value === "disabled" ? value : "any";
    else if (key === "expandText") result.expandText = value;
    else if (key === "match") result.match = value === "contains" ? "contains" : "exact";
    else result.conditions[key.trim()] = value;
  }
  return result;
}

function chooseRowScopedExpander(
  expanders: Array<{ index: number; x: number; y: number; width: number; height: number; text: string }>,
  rows: Array<{ x: number; y: number }>
): { index: number; x: number; y: number; width: number; height: number; text: string } | undefined {
  if (!expanders.length) return undefined;
  if (!rows.length) return expanders[0];
  const minActionY = Math.min(...rows.map((item) => item.y));
  const maxActionY = Math.max(...rows.map((item) => item.y));
  const inListBand = expanders
    .filter((item) => item.y >= minActionY && item.y <= maxActionY + 360)
    .sort((left, right) => Math.abs(left.y - maxActionY) - Math.abs(right.y - maxActionY));
  return inListBand[0] ?? expanders[0];
}

async function visibleLocatorBoxes(locator: Locator): Promise<Array<{ index: number; x: number; y: number; width: number; height: number; text: string }>> {
  const count = await locator.count().catch(() => 0);
  const results: Array<{ index: number; x: number; y: number; width: number; height: number; text: string }> = [];
  for (let index = 0; index < Math.min(count, 80); index += 1) {
    const item = locator.nth(index);
    if (!(await item.isVisible({ timeout: 80 }).catch(() => false))) continue;
    const box = await item.boundingBox().catch(() => null);
    if (!box || box.width <= 0 || box.height <= 0) continue;
    const text = await item.evaluate((element) => (element.textContent || "").replace(/\s+/g, " ").trim()).catch(() => "");
    results.push({
      index,
      x: box.x + box.width / 2,
      y: box.y + box.height / 2,
      width: box.width,
      height: box.height,
      text
    });
  }
  return results;
}

async function readDisabledState(locator: Locator): Promise<{ disabled: boolean; text: string; reason: string; attributes: Record<string, string | null> }> {
  return locator.evaluate((element) => {
    const control = element.closest("button,[role='button'],input,textarea,select") ?? element;
    const htmlControl = control as HTMLButtonElement | HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
    const disabledProperty = "disabled" in htmlControl ? Boolean(htmlControl.disabled) : false;
    const ariaDisabled = control.getAttribute("aria-disabled");
    const disabledAttr = control.getAttribute("disabled");
    const className = String((control as HTMLElement).className || "");
    const disabledClass = /(^|\s)(is-disabled|disabled|cursor-not-allowed|opacity-50)(\s|$)/i.test(className);
    const disabled = disabledProperty || ariaDisabled === "true" || disabledAttr !== null || disabledClass;
    const reason = disabledProperty
      ? "disabled_property"
      : ariaDisabled === "true"
        ? "aria_disabled"
        : disabledAttr !== null
          ? "disabled_attribute"
          : disabledClass
            ? "disabled_class"
            : "not_disabled";
    return {
      disabled,
      text: ((control.textContent || element.textContent || "") as string).replace(/\s+/g, " ").trim(),
      reason,
      attributes: {
        disabled: disabledAttr,
        ariaDisabled,
        className
      }
    };
  });
}

function readComponentTriggerCandidates(component: unknown): string[] {
  if (!component || typeof component !== "object") return [];
  const raw = component as Record<string, unknown>;
  const values = Array.isArray(raw.triggerCandidates) ? raw.triggerCandidates : [];
  return values
    .map((item) => {
      if (typeof item === "string") return item;
      if (!item || typeof item !== "object") return undefined;
      const record = item as Record<string, unknown>;
      return typeof record.value === "string" ? record.value : undefined;
    })
    .filter((item): item is string => Boolean(item && item.trim()));
}

function readComponentSearchInput(component: unknown): string | undefined {
  if (!component || typeof component !== "object") return undefined;
  const raw = component as Record<string, unknown>;
  return typeof raw.searchInput === "string" && raw.searchInput.trim() ? raw.searchInput.trim() : undefined;
}

function xpathStringLiteral(value: string): string {
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes("\"")) return `"${value}"`;
  return `concat(${value.split("'").map((part) => `'${part}'`).join(`, "\"'\"", `)})`;
}

export interface MessageCandidate {
  text: string;
  source: string;
  similarity: number;
}

function normalizeMessageText(value: string): string {
  return value
    .replace(/[\u201c\u201d]/g, "\"")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/^(?:提示|错误|通知|消息|系统提示|操作提示)\s*[:：]?\s*/i, "")
    .replace(/\s+/g, "")
    .replace(/[「」『』。，；：!?'"`]/g, "")
    .toLowerCase()
    .trim();
}

function messageExactMatch(expected: string, candidate: string): boolean {
  if (!expected || !candidate) return false;
  if (candidate === expected) return true;
  return candidate.length <= expected.length + 6 && candidate.includes(expected);
}

function messageSimilarity(expected: string, candidate: string): number {
  if (!expected || !candidate) return 0;
  if (messageExactMatch(expected, candidate)) return 1;
  const distance = levenshteinDistance(expected, candidate);
  const maxLength = Math.max(expected.length, candidate.length, 1);
  return Math.max(0, Math.min(1, 1 - distance / maxLength));
}

export function buildMessageAssertionDiagnostics(
  expected: string,
  matched: MessageCandidate | undefined,
  candidates: MessageCandidate[]
): { observedMessages: MessageCandidate[]; bestCandidates: MessageCandidate[]; attribution: Record<string, unknown> } {
  const observedMessages = candidates
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, 20);
  const bestCandidates = observedMessages
    .filter((candidate) => candidate.similarity >= 0.5)
    .slice(0, 8);
  const attribution = buildMessageAssertionAttribution(expected, matched, observedMessages, bestCandidates);
  return { observedMessages, bestCandidates, attribution };
}

function buildMessageAssertionAttribution(
  expected: string,
  matched: MessageCandidate | undefined,
  observedMessages: MessageCandidate[],
  bestCandidates: MessageCandidate[]
): Record<string, unknown> {
  const oppositeMessages = observedMessages.filter((candidate) =>
    /失败|错误|异常|已存在|不存在|failed|fail|error|exist/i.test(candidate.text)
  ).slice(0, 6);
  const successLikeMessages = observedMessages.filter((candidate) =>
    /成功|已保存|已创建|success|saved|created/i.test(candidate.text)
  ).slice(0, 6);
  const rootCause = matched
    ? "message_exact_matched"
    : oppositeMessages.length
      ? "opposite_or_failure_message_seen"
      : bestCandidates.length
        ? "expected_message_not_seen_similar_message_seen"
        : observedMessages.length
          ? "expected_message_not_seen_other_messages_seen"
          : "expected_message_not_seen_no_message_candidates";
  return {
    schemaVersion: "assertion-attribution.v1",
    assertionType: "message_visible_exact",
    expected,
    rootCause,
    matched: Boolean(matched),
    matchedText: matched?.text,
    bestSimilarTexts: bestCandidates,
    oppositeMessages,
    successLikeMessages,
    missingEvidence: [
      "network_response_summary_not_available",
      "before_after_list_snapshot_not_available_for_message_assertion"
    ]
  };
}

function levenshteinDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  const current = Array.from({ length: right.length + 1 }, () => 0);
  for (let i = 1; i <= left.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
    }
    for (let j = 0; j <= right.length; j += 1) previous[j] = current[j];
  }
  return previous[right.length] ?? 0;
}

export interface WebDriverLaunchOptions {
  extraHTTPHeaders?: Record<string, string>;
  authToken?: {
    token: string;
    originUrl: string;
    headerName?: string;
    storageKeys?: string[];
    cookieNames?: string[];
  };
  recordVideoDir?: string;
}

function semanticCandidates(target: string, elementType?: string): string[] {
  const text = target.trim();
  if (!text) return [];
  const values = [text, text.replace(/_/g, " "), text.toLowerCase()];
  const unique = [...new Set(values)].filter(Boolean);
  const locators: string[] = [];
  for (const value of unique) {
    if (!elementType || elementType === "button") locators.push(`role=button:${value}`, `button:has-text("${cssEscape(value)}")`);
    if (!elementType || elementType === "input") {
      locators.push(`input[placeholder*="${cssEscape(value)}"]`, `textarea[placeholder*="${cssEscape(value)}"]`);
    }
    locators.push(`text=${value}`);
  }
  return locators;
}

function assertionCandidates(assertion: DslAssertion): string[] {
  const values = Array.isArray(assertion.expected) ? assertion.expected : assertion.expected ? [assertion.expected] : [];
  return [...new Set([...values.map(String), assertion.target].filter((item): item is string => Boolean(item && item.trim())))];
}

interface NormalizedDateRange {
  start: string;
  end: string;
}

function normalizeDateRangeInput(value: unknown): NormalizedDateRange {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const raw = value as Record<string, unknown>;
    const directStart = typeof raw.start === "string" ? raw.start : typeof raw.from === "string" ? raw.from : undefined;
    const directEnd = typeof raw.end === "string" ? raw.end : typeof raw.to === "string" ? raw.to : undefined;
    if (directStart && directEnd) return { start: normalizeDateTimeBoundary(directStart, "start"), end: normalizeDateTimeBoundary(directEnd, "end") };
    if (typeof raw.raw === "string") return normalizeDateRangeInput(raw.raw);
  }
  const text = String(value ?? "");
  const matches = [...text.matchAll(/\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?/g)].map((match) => match[0].replace(/\//g, "-").replace(/\s+/g, " ").trim());
  return {
    start: matches[0] ? normalizeDateTimeBoundary(matches[0], "start") : "",
    end: matches[1] ? normalizeDateTimeBoundary(matches[1], "end") : ""
  };
}

function normalizeDateTimeBoundary(value: string, boundary: "start" | "end"): string {
  const normalized = value.replace(/\//g, "-").replace(/\s+/g, " ").trim();
  if (/\d{1,2}:\d{2}/.test(normalized)) return normalized;
  return `${normalized} ${boundary === "start" ? "00:00:00" : "23:59:59"}`;
}

function datePart(value: string): string {
  return value.match(/\d{4}-\d{1,2}-\d{1,2}/)?.[0] ?? value;
}

function calendarDateParts(value: string): { monthLabel: string; day: string } | undefined {
  const match = datePart(value).match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!match) return undefined;
  const [, year, month, day] = match;
  return {
    monthLabel: `${year}年${String(Number(month)).padStart(2, "0")}月`,
    day: String(Number(day))
  };
}

function dayPart(value: string): string {
  const day = datePart(value).split("-").pop() ?? "";
  return String(Number(day));
}

function parseDateTimeMs(value: string, boundary: "start" | "end" | "actual"): number {
  const normalized = normalizeDateTimeBoundary(value, boundary === "end" ? "end" : "start");
  const match = normalized.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (!match) return Number.NaN;
  const [, year, month, day, hour = boundary === "end" ? "23" : "0", minute = boundary === "end" ? "59" : "0", second = boundary === "end" ? "59" : "0"] = match;
  return new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)).getTime();
}

function dateRangeDisplayMatches(value: string, range: NormalizedDateRange): boolean {
  const text = value.replace(/\//g, "-");
  return text.includes(datePart(range.start)) && text.includes(datePart(range.end));
}

async function fillDateInput(locator: Locator, value: string): Promise<void> {
  const dateValue = datePart(value);
  await locator.click();
  await locator.fill(dateValue).catch(async () => {
    await locator.press("Control+A");
    await locator.type(dateValue);
  });
  await dispatchInputEvents(locator);
}

function preferSemanticDropdownTriggers(target: string, componentCandidates: string[]): string[] {
  const candidates = [target, ...componentCandidates].filter(Boolean);
  const scored = candidates.map((candidate, index) => ({ candidate, index, score: dropdownTriggerScore(candidate) }));
  return scored
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map((item) => item.candidate);
}

function dropdownTriggerScore(locator: string): number {
  const value = locator.trim();
  if (/^fieldRelative=/i.test(value)) return 90;
  if (/^(textExact=|role=)/i.test(value)) return 80;
  if (/^text=/i.test(value)) return 70;
  if (/\[role=["']?combobox["']?\]|data-slot=["']?popover-trigger["']?/i.test(value)) return 60;
  if (/nth=\d+/i.test(value)) return 10;
  return 40;
}

function normalizeUrl(url: string): string {
  return url
    .replace(/[?#].*$/, "")
    .replace(/\/(?:spot|futures)\/[A-Z0-9]+_[A-Z0-9]+(?=\/|$)/gi, (match) => match.replace(/\/[^/]+$/, "/:symbol_pair"))
    .replace(/\/\d+(?=\/|$)/g, "/:id");
}

function signature(value: unknown): string {
  return crypto.createHash("sha1").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

function cssEscape(value: string): string {
  return value.replace(/"/g, '\\"');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function elementTypeFromTag(tag: string, role?: string, href?: string): BootstrapInteractiveElement["elementType"] {
  if (["input", "textarea", "select"].includes(tag) || role === "textbox" || role === "combobox") return "input";
  if (tag === "a" || href) return "link";
  if (role === "tab") return "tab";
  if (tag === "button" || role === "button") return "button";
  return "unknown";
}

function classifyElementRisk(value: string): "low" | "medium" | "high" {
  const text = value.toLowerCase();
  if (/withdraw|payment|pay|delete|transfer|submit order|place order|提现|支付|删除|转账|提交订单|下单/.test(text)) return "high";
  if (/submit|save|create|update|edit|confirm|申请|保存|创建|修改|提交|确认/.test(text)) return "medium";
  return "low";
}

async function locatorValueEquals(locator: Locator, expected: string): Promise<boolean> {
  const value = await locator
    .evaluate((element) => {
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) return element.value;
      if ((element as HTMLElement).isContentEditable) return (element as HTMLElement).innerText;
      return element.textContent ?? "";
    })
    .catch(() => undefined);
  return String(value ?? "") === expected;
}

async function dispatchInputEvents(locator: Locator): Promise<void> {
  await locator
    .evaluate((element) => {
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
    })
    .catch(() => undefined);
}
