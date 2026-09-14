import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { buildAccountProfileCatalogFromSchema, selectProfileDimensions, collectRequiredDimensions, PROFILE_CATALOG_MAX_ENTRIES } from "../src/core/account-profile-catalog.js";
import { buildPageModelIntentPrompt } from "../src/core/page-model-ai-intent.js";

test("catalog 从 schema 生成：deterministic、meaning 来自 label（P3-A.1 按优先级排序）", () => {
  const schema = {
    dimensions: [
      { dimensionId: "security.phoneBound", label: "Phone bound", valueType: "boolean" },
      { dimensionId: "assets.spot.USDT.available", label: "Spot available asset", valueType: "decimal" },
      { dimensionId: "history.earnFlow.records", label: "Earn flow records" }
    ]
  };
  const first = buildAccountProfileCatalogFromSchema(schema);
  const second = buildAccountProfileCatalogFromSchema(schema);
  assert.deepEqual(first, second, "同输入同输出");
  // P3-A.1：顺序 = 优先级（P2 业务域 assets + records 聚合 > P3 security），域内字母序
  assert.deepEqual(first.map((item) => item.dimension).sort(), ["assets.spot.USDT.available", "history.earnFlow.records", "security.phoneBound"], "全部维度入选（未达上限不截断）");
  const phoneBound = first.find((item) => item.dimension === "security.phoneBound")!;
  assert.equal(phoneBound.meaning, "Phone bound");
});

test("schema 新增 dimension 后 catalog 自动获得（单一事实源）", () => {
  const before = buildAccountProfileCatalogFromSchema({ dimensions: [{ dimensionId: "a.b", label: "AB" }] });
  const after = buildAccountProfileCatalogFromSchema({ dimensions: [{ dimensionId: "a.b", label: "AB" }, { dimensionId: "c.d", label: "CD" }] });
  assert.equal(before.length, 1);
  assert.equal(after.length, 2);
  assert.ok(after.some((item) => item.dimension === "c.d"), "新增维度自动出现在 catalog");
});

test("超长 schema 截断到上限（确定性：按优先级+域内字母序填充，不再依赖物理顺序）", () => {
  const dimensions = Array.from({ length: 40 }, (_, index) => ({ dimensionId: `domain.dim${index}`, label: `Dim ${index}` }));
  const catalog = buildAccountProfileCatalogFromSchema({ dimensions });
  assert.equal(catalog.length, PROFILE_CATALOG_MAX_ENTRIES, "上限截断");
  // domain.* 是 P4 补充域：域内字母序填充（dim0, dim1, dim10, dim11... 字母序）
  const allFromP4 = catalog.every((entry) => entry.dimension.startsWith("domain.dim"));
  assert.ok(allFromP4, "无更高优先级域时按字母序填充");
});

test("schema 缺失/空时 catalog 为空数组（不抛错，prompt 仍可构建）", () => {
  assert.deepEqual(buildAccountProfileCatalogFromSchema(undefined), []);
  assert.deepEqual(buildAccountProfileCatalogFromSchema({ dimensions: [] }), []);
  assert.deepEqual(buildAccountProfileCatalogFromSchema({ dimensions: [{ label: "no-id" }] }), []);
});

test("prompt builder 消费 schema catalog：intent contract 字段不变", () => {
  const schema = { dimensions: [{ dimensionId: "security.phoneBound", label: "Phone bound" }] };
  const prompt = buildPageModelIntentPrompt({
    project: "demo", env: "test", message: "测试",
    profileSchema: schema
  });
  const parsed = JSON.parse(prompt);
  assert.ok(parsed.accountProfileDimensionCatalog.some((item: { dimension: string }) => item.dimension === "security.phoneBound"), "schema 维度进入 prompt");
  // intent contract 关键字段不因 A1 改变
  assert.ok(parsed.interpretationRules, "interpretationRules 保留");
  assert.ok(parsed.outputSchema.assertions, "outputSchema.assertions 保留");
  assert.equal(parsed.task.includes("Understand"), true);
  assert.ok(parsed.outputSchema.accountProfileNeeds || JSON.stringify(parsed.outputSchema).includes("dimensionHint"), "dimensionHint 契约保留");
});

test("历史硬编码 8 维度已被 schema 源取代（防双轨回潮）", () => {
  // 旧硬编码的 8 条必须不再出现在代码里（以模块源码静态检查）
  const source = fs.readFileSync("src/core/page-model-ai-intent.ts", "utf8");
  assert.ok(!source.includes('"feature.contractTrading.enabled", meaning'), "硬编码 catalog 已删除");
  assert.ok(source.includes("buildAccountProfileCatalogFromSchema"), "改用 schema 生成");
});

test("P3-A.1：selector 不依赖 schema 数组物理顺序（required 后置也能入选）", () => {
  // required 维度排在 schema 末尾（旧截断法会丢失）——selector 一级优先必须选中
  const schema = {
    dimensions: [
      ...Array.from({ length: 30 }, (_, index) => ({ dimensionId: `filler.dim${index}`, label: `Filler ${index}` })),
      { dimensionId: "security.phoneBound", label: "Phone bound" },
      { dimensionId: "feature.contractTrading.enabled", label: "Contract trading" }
    ]
  };
  const manual = {
    manuals: [{ capabilities: [{ requiredAccountProfileDimensions: [{ dimensionId: "security.phoneBound" }, { dimensionId: "feature.contractTrading.enabled" }] }] }]
  };
  
  const catalog = buildAccountProfileCatalogFromSchema(schema as never, manual as never);
  const dimensions = catalog.map((entry) => entry.dimension);
  assert.ok(dimensions.includes("security.phoneBound"), "排在末尾的 required 维度必须入选");
  assert.ok(dimensions.includes("feature.contractTrading.enabled"), "required 业务维度必须入选");
});

test("P3-A.1：OM required 实例经模板匹配回 schema 模板（asset 通配）", () => {
  const schema = {
    dimensions: [
      { dimensionId: "history.spotFlow.DEPOSIT.{asset}.exists", label: "Deposit flow" },
      { dimensionId: "filler.other", label: "Other" }
    ]
  };
  const manual = {
    manuals: [{ capabilities: [{ requiredAccountProfileDimensions: [{ dimensionId: "history.spotFlow.DEPOSIT.USDT.exists" }] }] }]
  };
  
  const catalog = buildAccountProfileCatalogFromSchema(schema as never, manual as never);
  assert.ok(catalog.some((entry) => entry.dimension === "history.spotFlow.DEPOSIT.{asset}.exists"), "实例 USDT 命中模板 {asset}");
});

test("P3-A.1：required-but-omitted 恒为 0（上限不牺牲 required）", () => {
  const schema = {
    dimensions: Array.from({ length: 40 }, (_, index) => ({ dimensionId: `domain${index % 3}.dim${index}`, label: `D${index}` }))
  };
  const manual = {
    manuals: [{ capabilities: [{ requiredAccountProfileDimensions: [{ dimensionId: "domain0.dim0" }] }] }]
  };
  
  const result = selectProfileDimensions(schema as never, collectRequiredDimensions(manual as never));
  assert.equal(result.requiredButOmitted.length, 0);
  assert.ok(result.selectedDimensions.some((entry) => entry.dimension === "domain0.dim0"), "required 模板必须出现在 selected");
  assert.ok(result.selectionReasons.some((reason) => reason.priority === "P1_OM_REQUIRED"), "required 有选择理由记录");
});

test("P3-A.1：选择输出含 selected/omitted/selectionReasons 三件套", () => {
  const schema = { dimensions: [{ dimensionId: "security.emailBound", label: "Email" }, { dimensionId: "cards.uCard.exists", label: "UCard" }] };
  const result = selectProfileDimensions(schema as never, []);
  assert.ok(Array.isArray(result.selectedDimensions));
  assert.ok(Array.isArray(result.omittedDimensions));
  assert.ok(Array.isArray(result.selectionReasons));
  assert.ok(result.selectionReasons.every((reason) => ["P1_OM_REQUIRED", "P2_BUSINESS_DOMAIN", "P3_CORE_ACCOUNT", "P4_SUPPLEMENTARY"].includes(reason.priority)));
});
