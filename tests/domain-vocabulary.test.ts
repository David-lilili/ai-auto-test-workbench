import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyWithDomainVocabulary, type DomainVocabulary } from "../src/core/domain-vocabulary.js";

const vocabulary: DomainVocabulary = {
  schemaVersion: "domain-vocabulary.v1",
  project: "demo",
  modules: [
    {
      module: "asset",
      aliases: ["资产", "钱包", "财务", "资金"],
      actions: [
        {
          action: "record",
          operationType: "read",
          aliases: ["资产记录", "钱包记录", "财务记录", "资金记录", "明细", "账单", "记录"]
        }
      ],
      entities: [
        {
          name: "asset",
          aliases: ["币种", "币种筛选", "筛选币种"],
          valuePattern: "\\b(USDT|USDC|BTC|ETH|TON)\\b"
        }
      ]
    }
  ]
};

test("classifies asset record query from domain vocabulary", () => {
  const result = classifyWithDomainVocabulary(
    "登录 demo test 环境，进入资产记录页面，筛选币种 USDT，查看记录列表，期望页面展示 USDT 相关资产记录或空状态。",
    vocabulary
  );

  assert.equal(result.module, "asset");
  assert.equal(result.action, "record");
  assert.equal(result.operationType, "read");
  assert.equal(result.entities.asset, "USDT");
  assert.ok(result.confidence >= 0.7);
  assert.ok(result.evidence.some((item) => item.source === "domain_vocabulary" && item.matchedAlias === "资产记录"));
});

test("does not classify unrelated red packet request as asset", () => {
  const result = classifyWithDomainVocabulary("登录 demo test 环境，创建一个 TON 红包，金额 10，数量 1。", vocabulary);

  assert.equal(result.module, undefined);
  assert.equal(result.action, undefined);
  assert.equal(result.entities.asset, undefined);
});
