import fs from "fs-extra";
import path from "node:path";
import { chromium } from "@playwright/test";
import { matchHeuristicsForGap, buildExplorationPlan, type GapForMatching } from "../src/core/exploration-planner.js";
import { getHeuristic } from "../src/core/exploration-heuristics.js";
import { executeExplorationPlan } from "../src/core/exploration-executor.js";

/**
 * P3-B12 受控探索：从 dry-run 结果选 3 个 LOW-risk plan 真实执行。
 * 选择标准：无 submit、无资金动作、restore 明确、页面状态可控。
 * 候选（来自 dry-run Top20 的 LOW 项）：
 *   1. contract_fund_flow.asset_filter（select 切换+恢复）
 *   2. contract_fund_flow.type_filter（select 切换+恢复）
 *   3. spot_fund_flow.asset_filter（select 切换+恢复）
 */

const rootDir = process.cwd();

async function main() {
  // 登录（bypassLogin）
  const envFile = await fs.readFile(path.join(rootDir, "configs/projects/demo/env.test.yaml"), "utf8");
  // api baseUrl 在第二个 baseUrl 行（api: 段下）；web 是第一个
  const baseUrls = [...envFile.matchAll(/baseUrl:\s*(\S+)/g)].map((match) => match[1]);
  const apiBaseUrl = baseUrls[1] ?? "http://api.example.com";
  const webBaseUrl = baseUrls[0] ?? "http://www.example.com/zh-hans";
  const discovery = await fs.readJson(path.join(rootDir, "storage/environment-discovery/demo/test.json"));
  const accountResponse = await fetch("http://127.0.0.1:54319/api/accounts?project=demo&env=test").then((response) => response.json()) as { accounts?: Array<Record<string, unknown>> };
  const account = (accountResponse.accounts ?? [])[0];
  const bypass = discovery.bypassLogin;
  if (!bypass?.enabled || !account) throw new Error("bypass login or account missing");

  // 获取 token
  const loginResponse = await fetch(new URL(bypass.path, apiBaseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...(bypass.extraPayload ?? {}),
      [bypass.usernameField]: account.username,
      [bypass.passwordField]: account.password,
      uaTime: new Date().toISOString().replace("T", " ").slice(0, 19)
    })
  });
  const loginBody = await loginResponse.json() as Record<string, unknown>;
  const token = String(bypass.tokenResponsePath.split(".").reduce((current: unknown, key: string) => (current as Record<string, unknown>)?.[key], loginBody));
  if (!token || token === "undefined") throw new Error("token fetch failed");
  console.log("login ok, token:", token.slice(0, 8) + "...");

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    extraHTTPHeaders: { [bypass.tokenHeaderName ?? "token"]: token },
    viewport: { width: 1440, height: 1000 }
  });
  await context.addInitScript(({ tokenValue }) => {
    for (const key of ["token", "exchange-token", "userToken", "accessToken"]) {
      window.localStorage.setItem(key, tokenValue);
    }
  }, { tokenValue: token });
  const page = await context.newPage();

  const store = await fs.readJson(path.join(rootDir, "storage/page-models/demo.json"));
  const modelsByPage = new Map<string, Record<string, unknown>>(store.models.map((m: Record<string, unknown>) => [String(m.pageId), m]));

  // 3 个 LOW-risk 目标（select 类，restore 明确）
  const targets: Array<{ pageId: string; target: string; url: string; controlType: string }> = [
    { pageId: "demo.funds.contract_fund_flow", target: "funds.contract_fund_flow.asset_filter", url: "http://www.example.com/zh-hans/assets/flows/futures-flow", controlType: "select" },
    { pageId: "demo.funds.contract_fund_flow", target: "funds.contract_fund_flow.type_filter", url: "http://www.example.com/zh-hans/assets/flows/futures-flow", controlType: "select" },
    { pageId: "demo.funds.spot_fund_flow", target: "funds.spot_fund_flow.asset_filter", url: "http://www.example.com/zh-hans/assets/flows/spot-flow", controlType: "select" }
  ];

  const results = [];
  for (const target of targets) {
    const gapForMatch: GapForMatching = {
      gapId: `gap:${target.pageId}:element:${target.target}`,
      pageId: target.pageId,
      dimension: "element",
      target: target.target,
      source: "element_unverified",
      controlType: target.controlType,
      hasElementLocator: true
    };
    const pageModel = modelsByPage.get(target.pageId);
    const match = matchHeuristicsForGap(gapForMatch, pageModel);
    // 选 LOW risk 的 heuristic（switch_restore 是 LOW；dependency_observation 是 MEDIUM）
    const lowRiskMatch = match.matched.find((item) => getHeuristic(item.heuristicId)?.riskClass === "LOW" && getHeuristic(item.heuristicId)?.triggerGapSources.includes("element_unverified"));
    const heuristic = lowRiskMatch ? getHeuristic(lowRiskMatch.heuristicId) : undefined;
    if (!heuristic) {
      console.log(`SKIP ${target.target}: 无 LOW heuristic`);
      continue;
    }
    const plan = buildExplorationPlan({ gap: gapForMatch, pageId: target.pageId, heuristic, pageModel });

    console.log(`\n=== 探索 ${target.target} ===`);
    console.log(`heuristic: ${heuristic.id}@${heuristic.version} | risk: ${plan.risk} | steps: ${plan.steps.map(s => s.action).join(" → ")}`);

    await page.goto(target.url, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(async (error) => {
      // Next.js 站点偶发 ERR_ABORTED（重定向竞态）——重试一次
      await page.waitForTimeout(2000);
      await page.goto(target.url, { waitUntil: "domcontentloaded", timeout: 45000 });
    });
    await page.waitForTimeout(2500);

    // locator 解析：从 Page Model 拿第一候选
    const locatorResolver = (elementId: string) => {
      const model = modelsByPage.get(target.pageId);
      const elements = Array.isArray(model?.elements) ? model!.elements as Array<Record<string, unknown>> : [];
      const element = elements.find((e) => String(e.elementId) === elementId);
      const candidates = Array.isArray(element?.locatorCandidates) ? element!.locatorCandidates as Array<Record<string, unknown>> : [];
      const first = candidates[0];
      if (!first) return undefined;
      const strategy = String(first.strategy ?? "");
      const value = String(first.value ?? "");
      if (strategy === "css") return value.replace(/^css=/, "");
      if (strategy === "text") return `text=${value}`;
      return undefined;
    };

    const run = await executeExplorationPlan({ page, plan, rootDir, locatorResolver });
    console.log(`status: ${run.status} | restore: ${run.restoreResult} | steps executed: ${run.steps.filter(s => s.status === "executed").length}/${run.steps.length}`);
    if (run.failure) console.log(`failure: ${run.failure.slice(0, 100)}`);
    results.push({ target: target.target, heuristic: `${heuristic.id}@${heuristic.version}`, status: run.status, restore: run.restoreResult, failure: run.failure });
  }

  await context.close();
  await browser.close();

  console.log("\n=== 受控探索汇总 ===");
  console.log(JSON.stringify(results, null, 1));
  await fs.writeJson(path.join(rootDir, "reports/controlled-exploration-results.json"), results, { spaces: 2 });
}

await main();
