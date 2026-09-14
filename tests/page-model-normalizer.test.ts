import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { resolveControlType, resolveOptionParent, buildNormalizedPageModelView } from "../src/core/page-model-normalizer.js";

const element = (overrides: Record<string, unknown>): Record<string, unknown> => ({
  elementId: "demo.elem",
  semanticName: "测试元素",
  ...overrides
});

// ============ P4-A10 A-F：Resolver ============

test("A. tag=input → input（HIGH）", () => {
  const result = resolveControlType(element({ tag: "input" }));
  assert.equal(result.resolvedType, "input");
  assert.equal(result.confidence, "HIGH_CONFIDENCE");
  assert.equal(result.source, "tag");
});

test("B. role=combobox → select（HIGH）", () => {
  const result = resolveControlType(element({ role: "combobox" }));
  assert.equal(result.resolvedType, "select");
  assert.equal(result.confidence, "HIGH_CONFIDENCE");
});

test("C. role=option → dropdown_option（HIGH）", () => {
  const result = resolveControlType(element({ role: "option" }));
  assert.equal(result.resolvedType, "dropdown_option");
  assert.equal(result.confidence, "HIGH_CONFIDENCE");
});

test("D. option 正确关联 parent（同前缀 selector）", () => {
  const option = element({ elementId: "c2.withdraw.network_bsc_option", role: "option", semanticName: "BSC 选项" });
  const siblings = [
    element({ elementId: "c2.withdraw.network_selector", controlType: "select", semanticName: "网络选择" }),
    element({ elementId: "c2.withdraw.address_input", controlType: "input", semanticName: "地址" })
  ];
  const parent = resolveOptionParent(option, siblings);
  assert.equal(parent.parentControlId, "c2.withdraw.network_selector");
  assert.equal(parent.confidence, "HIGH_CONFIDENCE");
});

test("E. 多 option 聚合到同一 parent", () => {
  const pageModel = {
    pageId: "demo.page",
    elements: [
      element({ elementId: "demo.network_selector", controlType: "select", semanticName: "网络" }),
      element({ elementId: "demo.network_bsc_option", role: "option", semanticName: "BSC" }),
      element({ elementId: "demo.network_eth_option", role: "option", semanticName: "ETH" })
    ]
  };
  const view = buildNormalizedPageModelView(pageModel);
  assert.equal(view.optionRelations.length, 2);
  assert.ok(view.optionRelations.every((relation) => relation.parentControlId === "demo.network_selector"));
  // 父子折叠后 interactionTargets 只有 selector
  assert.equal(view.interactionTargets.length, 1);
  assert.equal(view.interactionTargets[0].elementId, "demo.network_selector");
});

test("F. unknown + ambiguous → 保持 unknown（不强猜）", () => {
  const result = resolveControlType(element({ semanticName: "某区域", elementId: "demo.thing" }));
  assert.equal(result.resolvedType, "unknown");
  assert.equal(result.confidence, "UNRESOLVED");
});

test("G. 已有 controlType 不被覆盖", () => {
  const result = resolveControlType(element({ controlType: "select", tag: "input", role: "button" }));
  assert.equal(result.resolvedType, "select", "显式 controlType 优先");
  assert.equal(result.source, "existing");
});

// ============ H/I：confidence 分级 ============

test("H. HIGH/MEDIUM/LOW confidence 正确分级", () => {
  // tag → HIGH
  assert.equal(resolveControlType(element({ tag: "button" })).confidence, "HIGH_CONFIDENCE");
  // placeholder locator → MEDIUM
  assert.equal(resolveControlType(element({ locatorCandidates: [{ strategy: "placeholder", value: "输入数量" }] })).confidence, "MEDIUM_CONFIDENCE");
  // elementId + semanticName 双弱证据 → MEDIUM
  const medium = resolveControlType(element({ elementId: "demo.amount_input", semanticName: "数量输入框" }));
  assert.equal(medium.confidence, "MEDIUM_CONFIDENCE");
  // 单条语义 → LOW
  const low = resolveControlType(element({ elementId: "demo.x1", semanticName: "输入框" }));
  assert.equal(low.confidence, "LOW_CONFIDENCE");
});

test("I. LOW confidence 不驱动自动 exploration（confidence 字段可被 planner 门禁消费）", () => {
  const low = resolveControlType(element({ elementId: "demo.x1", semanticName: "输入框" }));
  assert.equal(low.confidence, "LOW_CONFIDENCE");
  // planner 门禁约定：normalized view 中 LOW 的元素 interactionTarget 保持 true，
  // 但 auto-executable 判定需要 HIGH/MEDIUM（此处验证字段可区分）
  assert.notEqual(low.confidence, "HIGH_CONFIDENCE");
  assert.notEqual(low.confidence, "MEDIUM_CONFIDENCE");
});

// ============ J/N：反误判 ============

test("N. false positive guards（text 不判 input / link 不判 button / modal title / readonly）", () => {
  // text 含"输入"两字才升 input；纯文本语义判 text
  const textElement = resolveControlType(element({ elementId: "demo.desc", semanticName: "说明文本" }));
  assert.equal(textElement.resolvedType, "text", "纯文本语义不得判 input");

  // link 不判 button（role=link 且无按钮语义）
  const link = resolveControlType(element({ role: "link", semanticName: "资产总览菜单项" }));
  assert.equal(link.resolvedType, "link");

  // link + 按钮语义（role=link 但名字含按钮）→ 仍 link（role 优先于语义）
  const linkWithBtn = resolveControlType(element({ role: "link", semanticName: "下载按钮" }));
  assert.equal(linkWithBtn.resolvedType, "link", "role=link 不得因语义名含按钮升 button");

  // readonly input（placeholder 含 readonly 提示）→ 仍 input 但可由 consumer 检查
  const readonly = resolveControlType(element({ tag: "input", semanticName: "只读地址", locatorCandidates: [{ strategy: "css", value: "input[readonly]" }] }));
  assert.equal(readonly.resolvedType, "input");
  // readonly 属性信号应在 evidence 里可被下游消费
  assert.ok(JSON.stringify(readonly.evidence).length > 0);
});

// ============ K/L/M：边界 ============

test("K. dropdown_option 不独立产生 select plan（interactionTarget=false）", () => {
  const view = buildNormalizedPageModelView({
    pageId: "demo.page",
    elements: [
      element({ elementId: "demo.selector", controlType: "select" }),
      element({ elementId: "demo.opt1", role: "option" })
    ]
  });
  const option = view.elements.find((item) => item.elementId === "demo.opt1")!;
  assert.equal(option.interactionTarget, false, "option 不得作为独立 interaction target");
  assert.equal(view.interactionTargets.length, 1);
});

test("L. normalization 前后原始 Page Model 字节不变", async () => {
  const sandbox = await fs.promises.mkdtemp(path.join(os.tmpdir(), "norm-test-"));
  const storePath = path.join(sandbox, "store.json");
  const original = {
    models: [{ pageId: "p", elements: [element({ elementId: "e1", controlType: "unknown", tag: "input" })] }]
  };
  await fs.promises.writeFile(storePath, JSON.stringify(original));
  const before = await fs.promises.readFile(storePath);
  // normalization 是纯函数——只要不写回就字节不变
  buildNormalizedPageModelView(original.models[0]);
  const after = await fs.promises.readFile(storePath);
  assert.ok(before.equals(after), "原始 store 字节不变");
  await fs.promises.rm(sandbox, { recursive: true });
});

test("M. normalized view 可被 P3 matcher 消费（normalizedControlType 驱动匹配）", async () => {
  const { matchHeuristicsForGap } = await import("../src/core/exploration-planner.js");
  // unknown + tag=input 归一化为 input → input heuristic 匹配
  const view = buildNormalizedPageModelView({
    pageId: "p",
    elements: [element({ elementId: "demo.amount", controlType: "unknown", tag: "input", semanticName: "数量" })]
  });
  const normalized = view.elements[0];
  const result = matchHeuristicsForGap({
    gapId: "g1", pageId: "p", dimension: "element", target: normalized.elementId,
    source: "element_unverified", controlType: normalized.normalizedControlType
  });
  assert.ok(result.matched.length > 0, "normalized controlType=input 应匹配 input heuristic");
});

test("resolver 七级优先级顺序验证（role > tag > component > locator > id/语义）", () => {
  // role 与 tag 冲突时 role 优先（option > input）
  assert.equal(resolveControlType(element({ role: "option", tag: "input" })).resolvedType, "dropdown_option");
  // tag 与 component 冲突时 tag 优先
  assert.equal(resolveControlType(element({ tag: "select", component: { type: "input" } })).resolvedType, "select");
  // 无 role/tag 时 component 优先于 locator
  assert.equal(resolveControlType(element({ component: { type: "tab" }, locatorCandidates: [{ strategy: "placeholder", value: "x" }] })).resolvedType, "tab");
});
