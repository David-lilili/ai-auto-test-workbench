import type { Page } from "@playwright/test";
import type { InventorySummary } from "./types.js";

const INVENTORY_SCRIPT = String.raw`
  (() => {
    const compact = (value, max = 120) => {
      const text = String(value || "").replace(/\s+/g, " ").trim();
      return text ? text.slice(0, max) : undefined;
    };
    const locatorSeed = (element) => {
      const html = element;
      const input = element;
      return {
        tag: html.tagName.toLowerCase(),
        role: html.getAttribute("role") || undefined,
        text: compact(html.innerText || html.textContent),
        ariaLabel: html.getAttribute("aria-label") || undefined,
        placeholder: input.placeholder || undefined,
        name: input.name || undefined,
        id: html.id || undefined,
        href: element.href || undefined,
        type: input.type || undefined,
        disabled: Boolean(input.disabled || html.getAttribute("aria-disabled") === "true"),
        classes: compact(html.className ? String(html.className) : undefined, 80)
      };
    };
    const clickables = Array.from(document.querySelectorAll("a,button,[role='button'],[role='link'],input,select,textarea,[tabindex]")).slice(0, 220).map((node, index) => ({ index, ...locatorSeed(node) }));
    const fields = Array.from(document.querySelectorAll("input,select,textarea,[contenteditable='true'],[role='combobox'],[role='textbox'],[role='spinbutton']")).slice(0, 100).map((node, index) => {
      const input = node;
      const labelByFor = input.id ? document.querySelector('label[for="' + CSS.escape(input.id) + '"]') : undefined;
      return {
        index,
        ...locatorSeed(node),
        label: compact((labelByFor && labelByFor.textContent) || (node.closest("label") && node.closest("label").textContent)),
        valuePresent: Boolean(input.value)
      };
    });
    const buttons = Array.from(document.querySelectorAll("button,[role='button'],input[type='button'],input[type='submit'],a")).slice(0, 160).map((node, index) => ({ index, ...locatorSeed(node) }));
    const tables = Array.from(document.querySelectorAll("table,[role='table'],[role='grid'],[class*='table'],[class*='list'],[class*='Table'],[class*='List']")).slice(0, 40).map((node, index) => {
      const rows = Array.from(node.querySelectorAll("tr,[role='row'],li,[class*='row'],[class*='Row']")).slice(0, 40);
      const headers = Array.from(node.querySelectorAll("th,[role='columnheader'],thead [class*='th'],thead [class*='head']")).slice(0, 20).map((h) => compact(h.innerText || h.textContent, 40)).filter(Boolean);
      return {
        index,
        tag: node.tagName.toLowerCase(),
        role: node.getAttribute("role") || undefined,
        text: compact(node.innerText || node.textContent, 300),
        rowCount: rows.length,
        columnHeaders: headers,
        firstRowCells: rows[0] ? Array.from(rows[0].querySelectorAll("td,[role='cell'],th,[role='columnheader']")).slice(0, 10).map((c) => compact(c.innerText || c.textContent, 40)).filter(Boolean) : []
      };
    });
    // native select options（P6.2-1A：native select 的 option 可直接读）
    const selectOptions = Array.from(document.querySelectorAll("select")).slice(0, 20).map((select, index) => ({
      index,
      id: select.id || undefined,
      name: select.name || undefined,
      ariaLabel: select.getAttribute("aria-label") || undefined,
      text: compact(select.innerText || select.textContent, 200),
      options: Array.from(select.options || []).slice(0, 50).map((opt) => ({
        value: opt.value !== undefined ? String(opt.value).slice(0, 60) : undefined,
        text: compact(opt.textContent, 60),
        disabled: Boolean(opt.disabled)
      }))
    }));
    // empty-state 信号（P6.2-3B：结构化空状态文本）
    const emptyStateTexts = (() => {
      const signals = ["暂无数据", "暂无记录", "没有数据", "无数据", "No data", "Empty", "无记录", "还没有", "空空如也", "no results", "no data"];
      const bodyText = (document.body && document.body.innerText) || "";
      return signals.filter((s) => bodyText.includes(s)).slice(0, 8);
    })();
    // pagination 信号（P6.2-6：分页区域）
    const pagination = Array.from(document.querySelectorAll("[class*='pagination'],[class*='Pagination'],[class*='page'],ul[class*='page']")).slice(0, 10).map((node, index) => ({
      index,
      text: compact(node.innerText || node.textContent, 120),
      items: node.querySelectorAll("li,button,a,[role='button']").length
    }));
    const dialogs = Array.from(document.querySelectorAll("[role='dialog'],[aria-modal='true'],[class*='modal'],[class*='Modal'],[class*='drawer'],[class*='Drawer'],[class*='popover'],[class*='Popover']")).slice(0, 40).map((node, index) => ({ index, ...locatorSeed(node), text: compact(node.innerText || node.textContent, 300) }));
    const iframes = Array.from(document.querySelectorAll("iframe")).slice(0, 20).map((node, index) => ({
      index,
      src: node.src || undefined,
      title: node.title || undefined
    }));
    const selectLike = Array.from(document.querySelectorAll("select,[role='combobox'],[aria-haspopup='listbox'],[class*='select'],[class*='Select']")).slice(0, 80).map((node, index) => ({ index, ...locatorSeed(node), text: compact(node.innerText || node.textContent, 200) }));
    return { clickables, fields, buttons, tables, dialogs, iframes, selectLike, selectOptions, emptyStateTexts, pagination };
  })()
`;

export async function collectInventory(page: Page): Promise<InventorySummary> {
  return (await page.evaluate(INVENTORY_SCRIPT)) as InventorySummary;
}
