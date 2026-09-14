import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "fs-extra";
import {
  buildLocatorTargets,
  dispatchKnowledgeWritebacks,
  resolveCaps,
  writeControlType,
  writeInteraction
} from "../src/core/knowledge-writeback-dispatcher.js";
import { recordKnowledgeEvidence } from "../src/core/knowledge-evidence-sink.js";
import type { KnowledgeEvidence } from "../src/core/knowledge-promotion-policy.js";

/**
 * P5.4-P5.6：unified writeback dispatcher 回归测试。
 * 核心保证：
 *   - LOCATOR 修复型配对只在「原 locator 失败 + 新 locator 成功 ≥2」时 auto；
 *   - caps 硬性生效（locator ≤5、controlType ≤10、interaction ≤10）；
 *   - CONTROL_TYPE 只补标 unknown、只接受 HIGH 结构证据、不覆盖已有；
 *   - 写回全部带 backup + verificationHistory（可回滚可审计）。
 */

async function seedPageModel(rootDir: string, elements: Array<Record<string, unknown>>): Promise<void> {
  const store = {
    schemaVersion: 1,
    project: "demo",
    models: [
      {
        pageId: "demo.funds.contract_fund_flow",
        elements: [
          { elementId: "funds.contract_fund_flow.asset_filter", semanticName: "合约流水币种下拉框", role: "combobox" },
          ...elements
        ]
      }
    ],
    updatedAt: new Date().toISOString()
  };
  await fs.ensureDir(path.join(rootDir, "storage/page-models"));
  await fs.writeJson(path.join(rootDir, "storage/page-models/demo.json"), store);
}

function evidence(overrides: Partial<KnowledgeEvidence>): KnowledgeEvidence {
  return {
    evidenceId: `ev-${Math.random().toString(36).slice(2, 8)}`,
    knowledgeType: "LOCATOR",
    pageId: "demo.funds.contract_fund_flow",
    targetId: "合约流水币种下拉框",
    sourceType: "SELF_HEALING",
    observation: { oldLocator: "role=combobox:币种", fallbackLevel: 1 },
    confidence: "HIGH",
    timestamp: new Date().toISOString(),
    observedValue: "textExact=USDT",
    outcome: "success",
    ...overrides
  };
}

test("resolveCaps 使用默认硬上限（locator=5 controlType=10 interaction=10）", () => {
  const caps = resolveCaps();
  assert.equal(caps.locator, 5);
  assert.equal(caps.controlType, 10);
  assert.equal(caps.interaction, 10);
});

test("buildLocatorTargets 只在成功 ≥2 且为修复型时进入 auto 候选", () => {
  const list = [
    evidence({ sourceRunId: "r1" }),
    evidence({ sourceRunId: "r2" }),
    evidence({ sourceRunId: "r3" }),
    // 非修复型：无 oldLocator / fallbackLevel
    evidence({ sourceRunId: "r4", observation: {}, sourceType: "DSL_EXECUTION" })
  ];
  const targets = buildLocatorTargets(list);
  assert.equal(targets.length, 1);
  assert.equal(targets[0].successCount, 3);
  assert.equal(targets[0].fixType, true);
  assert.equal(targets[0].newLocator, "textExact=USDT");
});

test("buildLocatorTargets 矛盾（多 locator 无主导）不产生唯一 winner", () => {
  const list = [
    evidence({ observedValue: "textExact=USDT" }),
    evidence({ observedValue: "textExact=USDT" }),
    evidence({ observedValue: "textExact=USDC" }),
    evidence({ observedValue: "textExact=USDC" })
  ];
  const targets = buildLocatorTargets(list);
  // dominantRatio = 0.5 < 0.8 → 无唯一新 locator；这里仍会产生 target 但 successCount=2，
  // 交给 dispatcher 按 policy 判定（此处仅验证不因矛盾崩溃且成功数正确）。
  assert.equal(targets.length, 1);
  assert.equal(targets[0].successCount, 2);
});

test("dispatchKnowledgeWritebacks dry-run 不写回", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "wb-dry-"));
  await seedPageModel(rootDir, []);
  const result = await dispatchKnowledgeWritebacks({ rootDir, project: "demo", dryRun: true });
  assert.equal(result.dryRun, true);
  assert.equal(result.applied.length, 0);
  const store = fs.readJsonSync(path.join(rootDir, "storage/page-models/demo.json"));
  assert.equal((store.models[0].elements[0] as Record<string, unknown>).controlType, undefined);
});

test("CONTROL_TYPE 只补标 unknown，已有值不覆盖", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "wb-ctl-"));
  await seedPageModel(rootDir, [
    { elementId: "funds.contract_fund_flow.type_filter", semanticName: "合约流水类型下拉框", role: "combobox" }
  ]);
  // 页面已有显式 controlType 的元素
  const storePath = path.join(rootDir, "storage/page-models/demo.json");
  const store = fs.readJsonSync(storePath);
  const typeFilter = (store.models[0].elements as Array<Record<string, unknown>>).find((el) => el.elementId === "funds.contract_fund_flow.type_filter");
  typeFilter!.controlType = "dropdown";
  fs.writeJsonSync(storePath, store);

  const candidate: KnowledgeEvidence[] = [
    { ...evidence({ knowledgeType: "CONTROL_TYPE", targetId: "funds.contract_fund_flow.type_filter", observedValue: "select", sourceType: "NORMALIZATION", confidence: "HIGH" }) }
  ];
  const result = await writeControlType(rootDir, "demo", {
    knowledgeType: "CONTROL_TYPE",
    pageId: "demo.funds.contract_fund_flow",
    targetId: "funds.contract_fund_flow.type_filter",
    normalizedValue: "select",
    evidence: candidate,
    successCount: 1,
    failureCount: 0,
    contradictionCount: 0,
    firstObservedAt: new Date().toISOString(),
    lastObservedAt: new Date().toISOString(),
    pageSignatures: [],
    freshness: "FRESH",
    evidenceConfidence: "HIGH",
    knowledgeKey: "k"
  });
  assert.equal(result.action, "skipped_unmatched");
  assert.match(result.reason, /已存在/);
});

test("INTERACTION 写回 verificationHistory 且保留原字段", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "wb-int-"));
  await seedPageModel(rootDir, []);
  const storePath = path.join(rootDir, "storage/page-models/demo.json");
  const store = fs.readJsonSync(storePath);
  store.models[0].elements[0].dropdown = { trigger: [{ strategy: "css", value: "css=main", confidence: 0.5 }] };
  fs.writeJsonSync(storePath, store);

  const candidate: KnowledgeEvidence[] = [
    { ...evidence({ knowledgeType: "INTERACTION", targetId: "funds.contract_fund_flow.asset_filter", observedValue: "interaction:select.option_discovery", sourceType: "CONTROLLED_EXPLORATION", sourceGapId: "gap:...", confidence: "HIGH" }) },
    { ...evidence({ knowledgeType: "INTERACTION", targetId: "funds.contract_fund_flow.asset_filter", observedValue: "interaction:select.option_discovery", sourceType: "CONTROLLED_EXPLORATION", confidence: "HIGH" }) }
  ];
  const result = await writeInteraction(rootDir, "demo", {
    knowledgeType: "INTERACTION",
    pageId: "demo.funds.contract_fund_flow",
    targetId: "funds.contract_fund_flow.asset_filter",
    normalizedValue: "interaction:select.option_discovery",
    evidence: candidate,
    successCount: 2,
    failureCount: 0,
    contradictionCount: 0,
    firstObservedAt: new Date().toISOString(),
    lastObservedAt: new Date().toISOString(),
    pageSignatures: [],
    freshness: "FRESH",
    evidenceConfidence: "MEDIUM",
    knowledgeKey: "k"
  });
  assert.equal(result.action, "record_interaction");
  const after = fs.readJsonSync(storePath);
  const element = after.models[0].elements[0];
  assert.ok(Array.isArray(element.verificationHistory));
  assert.equal(element.verificationHistory.length, 1);
  assert.equal(element.verificationHistory[0].knowledgeType, "INTERACTION");
  // 原字段保留
  assert.ok(element.dropdown);
});

test("写回产生 backup 文件（可回滚）", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "wb-bak-"));
  await seedPageModel(rootDir, []);
  const result = await writeInteraction(rootDir, "demo", {
    knowledgeType: "INTERACTION",
    pageId: "demo.funds.contract_fund_flow",
    targetId: "funds.contract_fund_flow.asset_filter",
    normalizedValue: "interaction:x",
    evidence: [evidence({ knowledgeType: "INTERACTION", observedValue: "interaction:x", sourceType: "CONTROLLED_EXPLORATION" })],
    successCount: 1,
    failureCount: 0,
    contradictionCount: 0,
    firstObservedAt: new Date().toISOString(),
    lastObservedAt: new Date().toISOString(),
    pageSignatures: [],
    freshness: "FRESH",
    evidenceConfidence: "MEDIUM",
    knowledgeKey: "k"
  });
  assert.ok(result.detail?.backupPath);
  const backupAbs = path.join(rootDir, ...String(result.detail.backupPath).split("/"));
  assert.ok(fs.pathExistsSync(backupAbs));
});

test("P6.2-13: INTERACTION 写回幂等——同 sourceRun 重复 promote 不重复写 verificationHistory", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "wb-fanout-"));
  await seedPageModel(rootDir, []);
  const storePath = path.join(rootDir, "storage/page-models/demo.json");

  const candidate = {
    knowledgeType: "INTERACTION",
    pageId: "demo.funds.contract_fund_flow",
    targetId: "funds.contract_fund_flow.asset_filter",
    normalizedValue: "interaction:select.option_discovery",
    evidence: [
      { ...evidence({ knowledgeType: "INTERACTION", targetId: "funds.contract_fund_flow.asset_filter", sourceType: "CONTROLLED_EXPLORATION", sourceRunId: "run-fanout-1", confidence: "HIGH" }) },
      { ...evidence({ knowledgeType: "INTERACTION", targetId: "funds.contract_fund_flow.asset_filter", sourceType: "CONTROLLED_EXPLORATION", sourceRunId: "run-fanout-2", confidence: "HIGH" }) }
    ] as KnowledgeEvidence[],
    successCount: 2,
    failureCount: 0,
    contradictionCount: 0,
    firstObservedAt: new Date().toISOString(),
    lastObservedAt: new Date().toISOString(),
    pageSignatures: [],
    freshness: "FRESH",
    evidenceConfidence: "HIGH",
    knowledgeKey: "k-fanout"
  };

  // 第一次：record_interaction
  const first = await writeInteraction(rootDir, "demo", candidate);
  assert.equal(first.action, "record_interaction");
  const afterFirst = fs.readJsonSync(storePath);
  assert.equal(afterFirst.models[0].elements[0].verificationHistory.length, 1);

  // 第二次（orchestrator 下一轮迭代）：同 sourceRun → noop，不重复写
  const second = await writeInteraction(rootDir, "demo", candidate);
  assert.equal(second.action, "noop");
  const afterSecond = fs.readJsonSync(storePath);
  assert.equal(afterSecond.models[0].elements[0].verificationHistory.length, 1, "fan-out 修复：同 sourceRun 不得重复写 verificationHistory");
});

