import type { CaseResult, FailureReview } from "./types.js";

export function reviewFailure(result: CaseResult): FailureReview {
  const error = result.error ?? "";
  if (/timeout/i.test(error)) {
    return {
      conclusion: "用例执行超时",
      category: "flaky_watch",
      likelyCause: "环境响应慢、等待条件不准确或页面元素变化",
      evidence: collectEvidence(result),
      nextAction: "先重跑一次；若复现，检查等待条件和失败 trace",
      ownerHint: "qa",
      shouldRerun: true,
      shouldMarkFlaky: false,
      decisionRequired: false
    };
  }
  if (/401|403|unauthorized|forbidden/i.test(error)) {
    return {
      conclusion: "鉴权失败",
      category: "environment",
      likelyCause: "账号、token、权限或环境配置异常",
      evidence: collectEvidence(result),
      nextAction: "检查账号配置与环境 baseUrl，避免把生产/测试 token 混用",
      ownerHint: "qa",
      shouldRerun: false,
      shouldMarkFlaky: false,
      decisionRequired: false
    };
  }
  if (/selector|locator|strict mode|element.*not found|waiting for .*locator/i.test(error)) {
    return {
      conclusion: "页面元素定位失败",
      category: "automation_script",
      likelyCause: "页面结构或文案变化，页面地图和用例选择器可能需要更新",
      evidence: collectEvidence(result),
      nextAction: "优先查看 DOM 快照和 trace；若页面确实变更，更新页面元素记忆并影响分析相关用例",
      ownerHint: "qa",
      shouldRerun: false,
      shouldMarkFlaky: false,
      decisionRequired: false
    };
  }
  if (/ECONN|ENOTFOUND|ETIMEDOUT|net::|socket|network/i.test(error)) {
    return {
      conclusion: "网络或依赖服务异常",
      category: "network_or_device",
      likelyCause: "网络不可达、服务不可用、DNS 或设备链路异常",
      evidence: collectEvidence(result),
      nextAction: "检查环境健康状态和接口链路；确认恢复后可重跑",
      ownerHint: "devops",
      shouldRerun: true,
      shouldMarkFlaky: false,
      decisionRequired: false
    };
  }
  return {
    conclusion: "需要人工确认的失败",
    category: "needs_human_decision",
    likelyCause: "产品缺陷、脚本问题、测试数据或环境问题均可能",
    evidence: collectEvidence(result),
    nextAction: "AI 证据不足，需要你在产品缺陷、脚本修复、数据重置、环境排查之间做选择",
    ownerHint: "manual_decision",
    shouldRerun: false,
    shouldMarkFlaky: false,
    decisionRequired: true
  };
}

function collectEvidence(result: CaseResult): string[] {
  return [
    ...(result.artifacts ?? []),
    result.error ? `error:${result.error}` : undefined
  ].filter((item): item is string => Boolean(item));
}
