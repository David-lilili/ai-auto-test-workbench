import type { BenchmarkPageCase } from "./modeling-benchmark-harness.js";

/**
 * P7.4：Benchmark Dataset——从成熟模型中选 8 个代表页面（覆盖 6 类型）。
 *
 * 硬隔离要求：AUTO 建模绝不读 gold store；gold 只在建模后用于 comparison。
 * 这些页面不新增任何页面特例。
 */

const GOLD_STORE = "storage/page-models/demo.json";

export const BENCHMARK_PAGES: BenchmarkPageCase[] = [
  {
    benchmarkCaseId: "spot_fund_flow",
    url: "http://www.example.com/zh-hans/assets/flows/spot-flow",
    canonicalPageId: "demo.funds.spot_fund_flow",
    pageType: "flow_list",
    goldStorePath: GOLD_STORE,
    project: "demo",
    env: "test",
    safeRiskMode: "safe",
    expectedCapabilities: ["查看现货流水列表", "筛选币种/类型", "时间范围筛选", "结果列表或空状态"],
    nlProbes: [
      { id: "s1", request: "查看现货流水列表", expectedIntent: "open+view", risk: "LOW" },
      { id: "s2", request: "筛选币种为 USDT 的现货流水记录", expectedIntent: "open+filter+assert", risk: "LOW" },
      { id: "s3", request: "点击查询按钮，确认现货流水列表时间列均在最近日期范围内", expectedIntent: "open+filter+assert", risk: "LOW" }
    ]
  },
  {
    benchmarkCaseId: "earn_fund_flow",
    url: "http://www.example.com/zh-hans/assets/flows/earn-flow",
    canonicalPageId: "demo.funds.earn_fund_flow",
    pageType: "flow_list",
    goldStorePath: GOLD_STORE,
    project: "demo",
    env: "test",
    safeRiskMode: "safe",
    expectedCapabilities: ["查看理财流水列表", "筛选理财流水类型"],
    nlProbes: [
      { id: "e1", request: "查看理财流水列表", expectedIntent: "open+view", risk: "LOW" },
      { id: "e2", request: "筛选理财流水中类型为申购的记录", expectedIntent: "open+filter+assert", risk: "LOW" }
    ]
  },
  {
    benchmarkCaseId: "contract_fund_flow",
    url: "http://www.example.com/zh-hans/assets/flows/futures-flow",
    canonicalPageId: "demo.funds.contract_fund_flow",
    pageType: "flow_list",
    goldStorePath: GOLD_STORE,
    project: "demo",
    env: "test",
    safeRiskMode: "safe",
    expectedCapabilities: ["查看合约流水列表", "筛选合约流水类型/币种"],
    nlProbes: [
      { id: "c1", request: "查看合约流水列表", expectedIntent: "open+view", risk: "LOW" },
      { id: "c2", request: "筛选合约流水中类型为开仓的记录", expectedIntent: "open+filter+assert", risk: "LOW" }
    ]
  },
  {
    benchmarkCaseId: "withdraw",
    url: "http://www.example.com/zh-hans/assets/withdraw",
    canonicalPageId: "demo.funds.withdraw",
    pageType: "form",
    goldStorePath: GOLD_STORE,
    project: "demo",
    env: "test",
    safeRiskMode: "review",
    expectedCapabilities: ["选择币种与链", "输入提现地址与数量", "安全验证码"],
    nlProbes: [
      { id: "w1", request: "打开提现页面", expectedIntent: "open+view", risk: "LOW" },
      { id: "w2", request: "查看提现币种与链选择器", expectedIntent: "open+view", risk: "LOW" }
    ]
  },
  {
    benchmarkCaseId: "red_packet",
    url: "http://www.example.com/zh-hans/assets/red-packet",
    canonicalPageId: "demo.funds.red_packet",
    pageType: "modal_heavy",
    goldStorePath: GOLD_STORE,
    project: "demo",
    env: "test",
    safeRiskMode: "review",
    expectedCapabilities: ["查看红包记录", "创建/领取红包入口"],
    nlProbes: [
      { id: "r1", request: "打开红包页面", expectedIntent: "open+view", risk: "LOW" },
      { id: "r2", request: "查看红包创建入口", expectedIntent: "open+view", risk: "LOW" }
    ]
  },
  {
    benchmarkCaseId: "total_assets",
    url: "http://www.example.com/zh-hans/assets/total-assets",
    canonicalPageId: "demo.asset.total_assets",
    pageType: "simple_navigation",
    goldStorePath: GOLD_STORE,
    project: "demo",
    env: "test",
    safeRiskMode: "safe",
    expectedCapabilities: ["查看资产总览", "切换到币种/账户维度"],
    nlProbes: [
      { id: "t1", request: "查看资产总览页面", expectedIntent: "open+view", risk: "LOW" },
      { id: "t2", request: "切换到币种维度视图", expectedIntent: "open+tab", risk: "LOW" }
    ]
  },
  {
    benchmarkCaseId: "personal_api",
    url: "http://www.example.com/zh-hans/personal/api-management",
    canonicalPageId: "demo.personal.api_management",
    pageType: "security_provider",
    goldStorePath: GOLD_STORE,
    project: "demo",
    env: "test",
    safeRiskMode: "review",
    expectedCapabilities: ["查看 API 管理", "创建 API key"],
    nlProbes: [
      { id: "a1", request: "打开 API 管理页面", expectedIntent: "open+view", risk: "LOW" },
      { id: "a2", request: "查看创建 API key 入口", expectedIntent: "open+view", risk: "LOW" }
    ]
  },
  {
    benchmarkCaseId: "personal_account",
    url: "http://www.example.com/zh-hans/personal/account",
    canonicalPageId: "demo.personal.account",
    pageType: "security_provider",
    goldStorePath: GOLD_STORE,
    project: "demo",
    env: "test",
    safeRiskMode: "review",
    expectedCapabilities: ["查看账号信息", "修改邮箱/密码入口"],
    nlProbes: [
      { id: "p1", request: "打开个人账号页面", expectedIntent: "open+view", risk: "LOW" },
      { id: "p2", request: "查看修改登录密码入口", expectedIntent: "open+view", risk: "LOW" }
    ]
  }
];

export function getBenchmarkPages(ids?: string[]): BenchmarkPageCase[] {
  if (!ids?.length) return BENCHMARK_PAGES;
  return BENCHMARK_PAGES.filter((p) => ids.includes(p.benchmarkCaseId));
}
