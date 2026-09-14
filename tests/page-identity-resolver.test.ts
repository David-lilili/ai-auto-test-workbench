import assert from "node:assert/strict";
import { test } from "node:test";
import {
  normalizePageId,
  normalizeUrl,
  resolvePageIdentity,
  scoreIdentityPair,
  semanticKeywords,
  type PageIdentitySignal
} from "../src/core/page-identity-resolver.js";

const redPacketElements = ["红包口令输入框", "领取按钮", "红包记录", "创建红包", "红包金额输入", "邀请码领取"];
const totalAssetsElements = ["资产总览菜单项", "顶部充值按钮", "顶部提现按钮", "顶部划转按钮", "资金流水入口", "订单入口", "币种维度 tab", "账户维度 tab", "资产搜索框", "隐藏小额资产复选框"];
// P4 采集风格：粗糙编号命名
const p4TotalAssetsElements = ["USDT合约以USDT结算的合约", "下载APP", "语言", "资金流水", "订单", "充值", "提现", "资产总览列表或表格"];

function signal(overrides: Partial<PageIdentitySignal> & { pageId: string }): PageIdentitySignal {
  return { semanticNames: [], ...overrides } as PageIdentitySignal;
}

test("A. pageId 完全相同 → SAME_PAGE（exact identity 可走既有增量 writeback）", () => {
  const incoming = signal({ pageId: "demo.funds.red_packet", url: "http://x.com/red-packet", semanticNames: redPacketElements });
  const existing = [signal({ pageId: "demo.funds.red_packet", url: "http://x.com/red-packet", semanticNames: redPacketElements })];
  const result = resolvePageIdentity(incoming, existing);
  assert.equal(result.verdict, "SAME_PAGE");
  assert.ok(result.reasons.some((reason) => reason.includes("精确匹配")));
});

test("H. demo/demo 红包页历史案例回归：拼写不同但 URL/元素一致 → 疑似同页（不自动合并）", () => {
  const incoming = signal({
    pageId: "demo.fund.red_packet",
    url: "http://www.example.com/zh-hans/assets/red-packet",
    pageName: "红包",
    semanticNames: redPacketElements
  });
  const existing = [
    signal({
      pageId: "demo.funds.red_packet",
      url: "http://www.example.com/zh-hans/assets/red-packet",
      pageName: "红包",
      semanticNames: redPacketElements
    })
  ];
  const result = resolvePageIdentity(incoming, existing);
  assert.notEqual(result.verdict, "SAME_PAGE", "pageId 不同时不得自动判定同页");
  assert.equal(result.verdict, "POSSIBLE_SAME_PAGE");
  assert.ok(result.candidatePageIds.includes("demo.funds.red_packet"));
  assert.ok(result.score >= 0.3 && result.score < 0.75);
});

test("B+. 历史真实案例：asset.total_assets vs funds.total_assets（同 URL 同页面、元素命名风格不同）→ 疑似同页", () => {
  const incoming = signal({
    pageId: "demo.funds.total_assets",
    url: "http://www.example.com/zh-hans/assets/total-assets",
    pageName: "资产总览",
    semanticNames: p4TotalAssetsElements
  });
  const existing = [
    signal({
      pageId: "demo.asset.total_assets",
      url: "http://www.example.com/zh-hans/assets/total-assets",
      pageName: "资产总览",
      semanticNames: totalAssetsElements
    })
  ];
  const result = resolvePageIdentity(incoming, existing);
  assert.notEqual(result.verdict, "NEW_PAGE", "同 URL 同页面名应至少识别为疑似");
  assert.ok(["POSSIBLE_SAME_PAGE", "CONFLICT"].includes(result.verdict), `实际: ${result.verdict}`);
  assert.ok(result.candidatePageIds.includes("demo.asset.total_assets"));
});

test("C. URL 相同但 modal/state 模型不同 → 不得判为 SAME_PAGE", () => {
  const incoming = signal({
    pageId: "demo.funds.transfer_entry",
    url: "http://www.example.com/zh-hans/assets/total-assets",
    semanticNames: ["划转弹窗", "转出账户", "转入账户", "划转数量", "确认划转"]
  });
  const existing = [
    signal({
      pageId: "demo.asset.total_assets",
      url: "http://www.example.com/zh-hans/assets/total-assets",
      semanticNames: totalAssetsElements
    })
  ];
  const result = resolvePageIdentity(incoming, existing);
  assert.notEqual(result.verdict, "SAME_PAGE", "同 URL 的状态模型不得与页面级模型合并");
});

test("D. DOM 小幅变化仍属同页面（hash 缺失时靠 URL+语义；hash 存在但不匹配时语义兜底）", () => {
  const incoming = signal({
    pageId: "demo.funds.red_packet",
    url: "http://x.com/red-packet",
    semanticNames: redPacketElements,
    domHash: "new-dom-hash-after-minor-change"
  });
  const existing = [
    signal({
      pageId: "demo.funds.red_packet",
      url: "http://x.com/red-packet",
      semanticNames: redPacketElements,
      domHash: "old-dom-hash"
    })
  ];
  const result = resolvePageIdentity(incoming, existing);
  assert.equal(result.verdict, "SAME_PAGE", "pageId 精确匹配时 DOM 变化不改变同页判定");
});

test("E. 完全不同页面 → NEW_PAGE", () => {
  const incoming = signal({
    pageId: "demo.personal.kyc",
    url: "http://x.com/personal/kyc",
    semanticNames: ["国家选择", "身份认证表单", "上传证件"]
  });
  const existing = [
    signal({ pageId: "demo.funds.red_packet", url: "http://x.com/red-packet", semanticNames: redPacketElements }),
    signal({ pageId: "demo.personal.account", url: "http://x.com/personal/account", semanticNames: ["UID 展示", "安全设置", "邀请码"] })
  ];
  const result = resolvePageIdentity(incoming, existing);
  assert.equal(result.verdict, "NEW_PAGE");
  assert.deepEqual(result.candidatePageIds, []);
});

test("F. hash 全部缺失时降级使用 URL + 语义 + pageId 归一化信号", () => {
  const incoming = signal({
    pageId: "DEMO.Funds.Red_Packet",
    url: "http://x.com/red-packet/",
    semanticNames: redPacketElements
  });
  const existing = [
    signal({
      pageId: "demo.funds.redpacket",
      url: "http://x.com/red-packet",
      semanticNames: redPacketElements
    })
  ];
  // 无 hash、无 pageName，仅靠归一化 pageId + URL + 语义
  const result = resolvePageIdentity(incoming, existing);
  assert.notEqual(result.verdict, "NEW_PAGE", "归一化后同 pageId + 同 URL 应识别出关联");
  assert.ok(result.candidatePageIds.includes("demo.funds.redpacket"));
});

test("G. resolver 不改变写回边界：page_identity_conflict 不属于 capture ingest 类型", async () => {
  // 验证审核服务的写回门卫：只有 page_model_ingest 类型触发写回。
  // 这里直接验证类型常量不匹配（不启动服务器）。
  const { CAPTURE_INGEST_PROPOSAL_TYPE } = await import("../src/workbench/capture-proposal-ingest.js");
  assert.equal(CAPTURE_INGEST_PROPOSAL_TYPE, "page_model_ingest");
  assert.notEqual("page_identity_conflict", CAPTURE_INGEST_PROPOSAL_TYPE, "identity conflict 类型必须不在自动写回白名单");
});

test("工具函数：pageId/URL 归一化与语义关键词", () => {
  assert.equal(normalizePageId("DEMO.Funds.Red_Packet"), normalizePageId("demo.funds.redpacket"));
  assert.equal(normalizeUrl("http://X.com/a/?t=1#h"), normalizeUrl("http://x.com/a"));
  const keywords = semanticKeywords("资金流水入口 fund_flow");
  assert.ok(keywords.includes("fund_flow"));
  assert.ok(keywords.includes("资金"));
  assert.ok(keywords.includes("流水"));
});

test("scoreIdentityPair 输出 matched/conflicting 信号明细", () => {
  // demo/demo 是字母序拼写差异（非分隔符风格），归一化 pageId 不覆盖；
  // 该场景由 URL + pageName + 语义元素组合识别（H 用例验证四态判定）。
  const pair = scoreIdentityPair(
    signal({ pageId: "demo.funds.red_packet", url: "http://x.com/rp", semanticNames: redPacketElements, pageName: "红包" }),
    signal({ pageId: "demo.funds.red_packet", url: "http://x.com/rp", semanticNames: redPacketElements, pageName: "红包" })
  );
  assert.equal(pair.pageIdNormalized, false, "字母序拼写差异不属于归一化范围");
  assert.ok(pair.urlMatch, "URL 应精确匹配");
  assert.ok(pair.matched.some((item) => item.signal === "url"));
  assert.ok(pair.matched.some((item) => item.signal === "semanticElements"), "语义元素应高重叠");
  assert.ok(pair.matched.some((item) => item.signal === "pageName"));
  assert.ok(pair.score >= 0.6, `组合得分应达疑似阈值以上，实际 ${pair.score}`);
});

test("分隔符/大小写风格差异的 pageId 命中归一化匹配", () => {
  const pair = scoreIdentityPair(
    signal({ pageId: "DEMO.Funds.Red_Packet", url: "http://x.com/rp", semanticNames: redPacketElements }),
    signal({ pageId: "demo.funds.redpacket", url: "http://x.com/rp", semanticNames: redPacketElements })
  );
  assert.ok(pair.pageIdNormalized, "分隔符与大小写差异应命中归一化");
  assert.ok(pair.matched.some((item) => item.signal === "pageId(normalized)"));
});
