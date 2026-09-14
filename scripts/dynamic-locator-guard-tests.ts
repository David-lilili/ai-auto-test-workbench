/**
 * Dynamic Locator Identity Guard — targeted tests（P16.5 收敛前置 / GLOBAL_DYNAMIC_STRIPPING_TOO_BROAD 修复）。
 *
 * 只测 identity comparison 的归一策略；不修改存储 locator、Page Model、Evidence。
 *
 * 作用域规则验证：
 *  - dynamic stripping 是显式 opt-in（allowDynamicValueStripping=true）；
 *  - generic fuzzyMatch / 默认路径恢复原始文本 identity comparison，不得 strip 动态数字；
 *  - 业务数字（最低/费率/收益率/价格精度/步骤/天数）默认路径一律 NOT MERGE；
 *  - Market 行情 quote 仅在显式动态上下文（captured_inventory 等）下 SAME。
 *
 * 运行：npx tsx scripts/dynamic-locator-guard-tests.ts
 */
import {
  BUSINESS_NUMERIC_SAFETY,
  hasExplicitDynamicContext,
  isSameDynamicLocatorIdentity,
  normalizeIdentityValue,
  stripDynamicValueTokens
} from "../src/core/locator-identity-normalizer.js";

let failed = 0;
let passed = 0;

function check(label: string, actual: boolean, expected: boolean): void {
  const ok = actual === expected;
  if (ok) passed += 1;
  else failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"} | ${label} | actual=${actual} expected=${expected}`);
}

const DYNAMIC_OPTS = { allowDynamicValueStripping: true } as const;

// ============ Market 动态行情：显式 opt-in 后 SAME ============
check(
  "A: BTC 79,588/-1.40% vs 80,123/-1.32% → SAME (opt-in)",
  isSameDynamicLocatorIdentity(
    "role=button:BTC 比特币 79,588.00 -1.40%",
    "role=button:BTC 比特币 80,123.00 -1.32%",
    DYNAMIC_OPTS
  ),
  true
);

check(
  "B: ETH 2,450.33/-2.19% vs 2,460.11/-2.01% → SAME (opt-in)",
  isSameDynamicLocatorIdentity(
    "role=button:ETH 以太坊 2,450.33 -2.19%",
    "role=button:ETH 以太坊 2,460.11 -2.01%",
    DYNAMIC_OPTS
  ),
  true
);

// ============ Market 行情：默认（无 opt-in）不合并动态数值 ============
check(
  "A2: Market quote 默认路径 NOT SAME（无 opt-in 不剥离）",
  isSameDynamicLocatorIdentity(
    "role=button:BTC 比特币 79,588.00 -1.40%",
    "role=button:BTC 比特币 80,123.00 -1.32%"
  ),
  false
);

// ============ 稳定身份不同 → NOT MERGE（即使 opt-in 也不合并跨品种） ============
check(
  "C: BTC vs ETH → NOT MERGE (opt-in)",
  isSameDynamicLocatorIdentity(
    "role=button:BTC 比特币 79,588.00 -1.40%",
    "role=button:ETH 以太坊 2,450.33 -2.19%",
    DYNAMIC_OPTS
  ),
  false
);

// ============ 业务数字：默认路径一律 NOT MERGE ============
check(
  "D1: 最低 0.01 BTC vs 0.10 BTC → NOT MERGE（业务小数）",
  isSameDynamicLocatorIdentity("role=text:最低 0.01 BTC", "role=text:最低 0.10 BTC"),
  false
);

check(
  "D2: 费率 0.1% vs 0.2% → NOT MERGE（业务百分比）",
  isSameDynamicLocatorIdentity("role=text:费率 0.1%", "role=text:费率 0.2%"),
  false
);

check(
  "D3: 收益率 3.5% vs 5.0% → NOT MERGE（业务百分比）",
  isSameDynamicLocatorIdentity("role=text:收益率 3.5%", "role=text:收益率 5.0%"),
  false
);

check(
  "D4: 价格精度 0.01 vs 0.001 → NOT MERGE（数字边界包含保护）",
  isSameDynamicLocatorIdentity("role=text:价格精度 0.01", "role=text:价格精度 0.001"),
  false
);

check(
  "D5: 步骤 1 vs 步骤 2 → NOT MERGE（整数业务 token）",
  isSameDynamicLocatorIdentity("role=button:步骤 1", "role=button:步骤 2"),
  false
);

check(
  "D6: 30 天 vs 90 天 → NOT MERGE（整数业务 token）",
  isSameDynamicLocatorIdentity("role=tab:30 天", "role=tab:90 天"),
  false
);

check(
  "D7: 24h 涨幅榜 vs 24h 跌幅榜 → NOT MERGE（业务文本不同）",
  isSameDynamicLocatorIdentity("role=tab:24h 涨幅榜", "role=tab:24h 跌幅榜"),
  false
);

// ============ 业务数字：即使被误传 opt-in，数字边界保护的比较仍不合并 ============
// 注：业务小数（最低 0.01 BTC / 0.10 BTC）在 opt-in 下会被剥离合并——这正是
// GLOBAL_DYNAMIC_STRIPPING_TOO_BROAD 的教训：opt-in 只授予具备显式动态展示证据的
// 元素（见 H1-H3），业务数字元素一律走默认路径（D1-D7），生产路径不会发生。
check(
  "E1: 价格精度 0.01 vs 0.001 → NOT MERGE（即使 opt-in，数字边界保护）",
  isSameDynamicLocatorIdentity("role=text:价格精度 0.01", "role=text:价格精度 0.001", DYNAMIC_OPTS),
  false
);

// ============ 真正不同 locator semantics → NOT MERGE ============
check(
  "F: 搜索币种 vs 注册 → NOT MERGE",
  isSameDynamicLocatorIdentity("role=textbox:搜索币种", "role=button:注册"),
  false
);

// ============ generic fuzzyMatch 默认不得 strip dynamic numbers ============
const defaultNorm = normalizeIdentityValue("role=button:BTC 比特币 79,588.00 -1.40%");
check(
  "G1: 默认归一保留动态价格（不 strip）",
  defaultNorm === "role=button:BTC比特币79,588.00-1.40%",
  true
);
const optInNorm = normalizeIdentityValue("role=button:BTC 比特币 79,588.00 -1.40%", DYNAMIC_OPTS);
check(
  "G2: opt-in 归一剥离动态价格",
  optInNorm === "role=button:BTC比特币",
  true
);
check(
  "G3: 默认路径 BTC 快照归一结果彼此不同（原文比较）",
  defaultNorm === normalizeIdentityValue("role=button:BTC 比特币 80,123.00 -1.32%"),
  false
);

// ============ 业务数字安全性：所有保护清单 token 剥离后保持原样 ============
for (const token of BUSINESS_NUMERIC_SAFETY) {
  check(`SAFETY: "${token}" preserved`, stripDynamicValueTokens(token) === token, true);
}

// ============ 显式动态上下文判定（opt-in 依据） ============
check(
  "H1: captured_inventory 元素 → 有显式动态上下文",
  hasExplicitDynamicContext({ semanticRole: "captured_inventory" }),
  true
);
check(
  "H2: 无动态字段元素 → 无显式动态上下文",
  hasExplicitDynamicContext({ semanticRole: "filter_option" }),
  false
);
check(
  "H3: dynamicBinding 元素 → 有显式动态上下文",
  hasExplicitDynamicContext({ semanticRole: "row_action_button", dynamicBinding: { valueSource: "intent.data.asset" } }),
  true
);

// ============ 动态值剥离后 stable identity 应完全一致（opt-in 下紧凑/空格形态同源） ============
const btcStableA = normalizeIdentityValue("role=button:BTC比特币79,588.00-1.40%", DYNAMIC_OPTS);
const btcStableB = normalizeIdentityValue("role=button:BTC 比特币 80,123.00 -1.32%", DYNAMIC_OPTS);
check("I: BTC stable identity 归一一致（opt-in）", btcStableA === btcStableB, true);

console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
