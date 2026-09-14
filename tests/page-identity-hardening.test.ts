import assert from "node:assert/strict";
import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { resolvePageIdentity, type PageIdentitySignal } from "../src/core/page-identity-resolver.js";
import { buildPageModelWriteBackDiff, applyPageModelWriteBack } from "../src/workbench/page-model-writeback.js";
import { ingestCaptureRunReport } from "../src/workbench/capture-proposal-ingest.js";

let sandbox: string;

beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "p11-hardening-"));
});

afterEach(async () => {
  await fs.remove(sandbox);
});

const redPacketElements = ["红包口令输入框", "领取按钮", "红包记录", "创建红包", "红包金额输入", "邀请码领取"];
const totalAssetsElements = ["资产总览菜单项", "顶部充值按钮", "顶部提现按钮", "顶部划转按钮", "资金流水入口", "订单入口", "币种维度 tab", "账户维度 tab", "资产搜索框", "隐藏小额资产复选框"];

function signal(overrides: Partial<PageIdentitySignal> & { pageId: string }): PageIdentitySignal {
  return { semanticNames: [], ...overrides } as PageIdentitySignal;
}

/** 构造一个带 identityVerdict=SAME_PAGE 的 capture ingest proposal（模拟 P1 ingest 产物）。 */
function buildSamePageProposal(incomingPageId: string, canonicalPageId: string, elements: string[]): Record<string, unknown> {
  return {
    proposalId: "test-proposal-same-page",
    proposalType: "page_model_ingest",
    project: "demo",
    captureIngest: {
      runId: "test-run",
      sourceReport: "reports/test-scan.json",
      pageModel: {
        pageId: incomingPageId,
        pageName: "资产总览",
        url: "http://x.com/assets/total-assets",
        module: "asset",
        status: "dom_verified",
        confidence: 0.7
      },
      elements: elements.map((name, index) => ({
        proposalId: `e${index}`,
        semanticName: name,
        role: "button",
        locatorCandidates: [{ strategy: "text", value: name, confidence: 0.6 }],
        confidence: 0.6
      })),
      assertionModels: [],
      identity: { url: "http://x.com/assets/total-assets", semanticNames: elements },
      identityVerdict: {
        verdict: "SAME_PAGE",
        score: 0.8,
        reasons: ["URL + 语义元素组合得分 0.8 ≥ 0.75，判定同一页面"],
        matchedSignals: [],
        conflictingSignals: [],
        candidatePageIds: [canonicalPageId]
      }
    }
  };
}

async function seedStoreWithHash(): Promise<void> {
  const storePath = path.join(sandbox, "storage", "page-models", "demo.json");
  await fs.ensureDir(path.dirname(storePath));
  await fs.writeJson(storePath, {
    schemaVersion: "page-model-store.v1",
    project: "demo",
    models: [{
      schemaVersion: "page-model.v1",
      pageId: "demo.asset.total_assets",
      pageName: "资产总览",
      url: "http://x.com/assets/total-assets",
      status: "dom_verified",
      elements: totalAssetsElements.slice(0, 5).map((name, index) => ({
        elementId: `asset.elem.${index}`,
        semanticName: name,
        controlType: "button",
        status: "dom_verified",
        confidence: 0.8,
        locatorCandidates: []
      })),
      assertions: []
    }],
    indexes: { byPageId: { "demo.asset.total_assets": 0 } }
  });
}

test("A. SAME_PAGE + targetPageId 存在 → resolver 输出 canonical targetPageId", () => {
  // domHash 完全一致是决定性证据（同页面的重新采集），允许自动 canonical 重定向。
  const incoming = signal({
    pageId: "other.namespace.total_assets",
    url: "http://x.com/assets/total-assets",
    pageName: "资产总览",
    semanticNames: totalAssetsElements,
    domHash: "dom-hash-abc123"
  });
  const existing = [signal({
    pageId: "demo.asset.total_assets",
    url: "http://x.com/assets/total-assets",
    pageName: "资产总览",
    semanticNames: totalAssetsElements,
    domHash: "dom-hash-abc123"
  })];
  const result = resolvePageIdentity(incoming, existing);
  assert.equal(result.verdict, "SAME_PAGE");
  assert.equal(result.targetPageId, "demo.asset.total_assets", "必须给出 canonical 目标");
  assert.equal(result.remapEvidence, "dom_hash_match");
});

test("A+. 纯 URL+语义（无 pageId/hash 决定性证据）→ 停在 POSSIBLE，不自动重定向", () => {
  // 安全边界：asset/funds.total_assets 这类"同 URL 同页面名"但无 hash 的场景，
  // 组合得分上限 0.70 < 0.75，必须人工审核——防止把合法新建页误并入既有模型。
  const incoming = signal({
    pageId: "other.namespace.total_assets",
    url: "http://x.com/assets/total-assets",
    pageName: "资产总览",
    semanticNames: totalAssetsElements
  });
  const existing = [signal({
    pageId: "demo.asset.total_assets",
    url: "http://x.com/assets/total-assets",
    pageName: "资产总览",
    semanticNames: totalAssetsElements
  })];
  const result = resolvePageIdentity(incoming, existing);
  assert.equal(result.verdict, "POSSIBLE_SAME_PAGE");
  assert.equal(result.targetPageId, undefined, "无决定性证据不得自动重定向");
});

test("A. POSSIBLE_SAME_PAGE 不提供 targetPageId（禁止 remap）", () => {
  const incoming = signal({
    pageId: "demo.fund.red_packet",
    url: "http://x.com/red-packet",
    pageName: "红包",
    semanticNames: redPacketElements
  });
  const existing = [signal({
    pageId: "demo.funds.red_packet",
    url: "http://x.com/red-packet",
    pageName: "红包",
    semanticNames: redPacketElements
  })];
  const result = resolvePageIdentity(incoming, existing);
  assert.equal(result.verdict, "POSSIBLE_SAME_PAGE");
  assert.equal(result.targetPageId, undefined, "POSSIBLE 不得携带 canonical 目标");
});

test("A. SAME_PAGE 写回：Store 页面数不增，元素只进 canonical 模型，不创建 incoming pageId 页面", async () => {
  await seedStoreWithHash();
  const proposal = buildSamePageProposal("other.namespace.total_assets", "demo.asset.total_assets", totalAssetsElements.slice(5));
  // 先验证 diff
  const diff = await buildPageModelWriteBackDiff(sandbox, "demo", proposal);
  assert.equal(diff.pageId, "demo.asset.total_assets", "diff 必须指向 canonical 目标");
  assert.ok(diff.identityRemap, "diff 必须记录 identityRemap");
  assert.equal(diff.identityRemap?.incomingPageId, "other.namespace.total_assets");
  assert.equal(diff.identityRemap?.resolvedTargetPageId, "demo.asset.total_assets");
  assert.notEqual(diff.action, "add_page", "不得因 incoming pageId 不同而新建页面");
  // 再执行写回
  const result = await applyPageModelWriteBack(sandbox, "demo", proposal, { reviewedBy: "p11-test" });
  assert.equal(result.applied, true);
  const store = await fs.readJson(path.join(sandbox, "storage", "page-models", "demo.json"));
  assert.equal(store.models.length, 1, "Store 页面数量不得增加");
  assert.ok(!store.models.some((model: Record<string, unknown>) => String(model.pageId) === "other.namespace.total_assets"), "不得创建 incoming pageId 对应的新页面");
  const canonical = store.models[0];
  const addedCount = (canonical.elements as Array<Record<string, unknown>>).length;
  assert.equal(addedCount, totalAssetsElements.length, `新增元素应并入 canonical（5 既有 + ${totalAssetsElements.length - 5} 新增）`);
  // 审计可追踪
  const ingestLog = store.captureIngests as Array<Record<string, unknown>>;
  assert.ok(ingestLog[0].identityRemap, "审计日志必须记录 remap");
  assert.equal((ingestLog[0].identityRemap as Record<string, unknown>).resolvedTargetPageId, "demo.asset.total_assets");
});

test("A. SAME_PAGE 但 targetPageId 不在 store → 不重定向，按 incoming pageId 处理（防 resolver 幻觉目标）", async () => {
  await seedStoreWithHash();
  const proposal = buildSamePageProposal("other.namespace.total_assets", "ghost.page.not.exists", totalAssetsElements.slice(5));
  const diff = await buildPageModelWriteBackDiff(sandbox, "demo", proposal);
  assert.equal(diff.pageId, "other.namespace.total_assets", "目标不存在时回落 incoming pageId");
  assert.equal(diff.identityRemap, undefined, "不得记录幻觉目标的 remap");
});

test("B. RELATED_STATE_MODEL：同 URL 页面级 vs 状态级 → 合法关系，非冲突", () => {
  const incoming = signal({
    pageId: "demo.funds.transfer_entry",
    url: "http://x.com/assets/total-assets",
    semanticNames: ["划转弹窗", "转出账户", "转入账户", "划转数量", "确认划转"]
  });
  const existing = [signal({
    pageId: "demo.asset.total_assets",
    url: "http://x.com/assets/total-assets",
    semanticNames: totalAssetsElements
  })];
  const result = resolvePageIdentity(incoming, existing);
  assert.equal(result.verdict, "RELATED_STATE_MODEL");
  assert.deepEqual(result.conflictingSignals, [], "合法关系不带冲突信号");
  assert.equal(result.targetPageId, undefined, "状态模型绝不重定向合并");
  assert.deepEqual(result.candidatePageIds, []);
});

test("B. 两个状态模型（entry vs entry）同 URL → 也是 RELATED 而非 CONFLICT", () => {
  const incoming = signal({
    pageId: "demo.funds.transfer_entry",
    url: "http://x.com/assets/total-assets",
    semanticNames: ["划转弹窗", "确认划转"]
  });
  const existing = [signal({
    pageId: "demo.funds.fund_flow_entry",
    url: "http://x.com/assets/total-assets",
    semanticNames: ["资金流水弹窗", "筛选条件"]
  })];
  const result = resolvePageIdentity(incoming, existing);
  assert.equal(result.verdict, "RELATED_STATE_MODEL", `实际 ${result.verdict}`);
});

test("C. 重复 capture 同一冲突对 → 只生成一条 identity conflict proposal", async () => {
  // 构造一个会产生 POSSIBLE_SAME_PAGE 的 scan 报告（demo 拼写 vs 已有 demo 模型）
  await seedStoreWithHash();
  // seedStore 只有 total_assets；补一个 red_packet 页面
  const storePath = path.join(sandbox, "storage", "page-models", "demo.json");
  const store = await fs.readJson(storePath);
  store.models.push({
    schemaVersion: "page-model.v1",
    pageId: "demo.funds.red_packet",
    pageName: "红包",
    url: "http://x.com/red-packet",
    status: "dom_verified",
    elements: redPacketElements.slice(0, 3).map((name, index) => ({ elementId: `rp.${index}`, semanticName: name, locatorCandidates: [] })),
    assertions: []
  });
  store.indexes.byPageId["demo.funds.red_packet"] = 1;
  await fs.writeJson(storePath, store);

  const reportPath = path.join(sandbox, "reports", "dup-scan.json");
  await fs.ensureDir(path.dirname(reportPath));
  const pageModel = {
    pageId: "demo.fund.red_packet",
    pageName: "红包",
    url: "http://x.com/red-packet",
    status: "dom_verified",
    confidence: 0.7
  };
  await fs.writeJson(reportPath, {
    runId: "dup-run",
    project: "demo",
    env: "test",
    captures: [{ pageId: "demo.funds.red_packet", url: "http://x.com/red-packet", domHash: "hash1", visibleTextHash: "th1" }],
    proposals: {
      pageModels: [pageModel],
      elementInventories: redPacketElements.slice(0, 3).map((name, index) => ({
        pageId: "demo.funds.red_packet", semanticName: name, role: "button", locatorCandidates: [], confidence: 0.6
      })),
      assertionModels: []
    }
  });

  const relativeReport = path.relative(sandbox, reportPath).replace(/\\/g, "/");
  // 第一次 ingest
  const first = await ingestCaptureRunReport(sandbox, { reportPath: relativeReport });
  assert.equal(first.identityConflicts.length, 1, "首次应产生 1 条冲突");
  // 第二次 ingest 同一报告
  const second = await ingestCaptureRunReport(sandbox, { reportPath: relativeReport });
  // 去重后第二次不应再为同一 (incoming, candidate, verdict) 生成新 conflict proposal
  const pendingDir = path.join(sandbox, "storage", "proposals", "pending");
  const conflictFiles = (await fs.readdir(pendingDir))
    .filter((file) => file.endsWith(".json"))
    .map((file) => fs.readJson(path.join(pendingDir, file)));
  const conflictProposals = (await Promise.all(conflictFiles)).filter((record: Record<string, unknown>) => String(record.proposalType) === "page_identity_conflict");
  assert.equal(conflictProposals.length, 1, `第二次 ingest 不得重复生成 conflict proposal，实际 ${conflictProposals.length}`);
});
