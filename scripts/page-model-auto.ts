import path from "node:path";
import { parseArgs } from "node:util";
import fs from "fs-extra";
import { chromium, type Page } from "@playwright/test";
import { loadContext } from "../src/core/config-loader.js";
import { runModelingSession } from "../src/core/modeling-orchestrator.js";
import { loadModelingSession, listModelingSessions, type ModelingSession } from "../src/core/modeling-session.js";
import { writeSafeJsonFile, writeSafeTextFile } from "../src/core/safe-file-writer.js";

/**
 * P6.12：page-model:auto —— 新页面自动建模 CLI。
 *
 * 用法:
 *   npx tsx scripts/page-model-auto.ts --url <url> [--dry-run] [--max-iterations 5] [--max-plans 5] [--risk-mode safe] [--resume <sessionId>] [--resume-approved]
 *
 * 默认 dry-run（第一版不默认完全自动写回）。
 * 需要已配置的 .env / env.yaml 提供 bypass login（与受控探索共用登录通道）。
 */

const options = parseArgs({
  args: process.argv.slice(2),
  options: {
    url: { type: "string" },
    project: { type: "string", default: "demo" },
    env: { type: "string", default: "test" },
    "dry-run": { type: "boolean", default: true },
    "max-iterations": { type: "string", default: "5" },
    "max-plans": { type: "string", default: "5" },
    "risk-mode": { type: "string", default: "safe" },
    resume: { type: "string" },
    "resume-approved": { type: "boolean", default: false },
    headed: { type: "boolean", default: false }
  },
  allowPositionals: true,
  strict: false
});

const rootDir = path.resolve(".");

/** 与受控探索共用的 bypass login（从 env.yaml + discovery 读取）。 */
async function openAuthenticatedPage(project: string, env: string, url: string, headed: boolean): Promise<Page> {
  const envFile = await fs.readFile(path.join(rootDir, "configs/projects", project, `env.${env}.yaml`), "utf8");
  const baseUrls = [...envFile.matchAll(/baseUrl:\s*(\S+)/g)].map((m) => m[1]);
  const apiBaseUrl = baseUrls[1] ?? `http://api.example.com`;
  const discovery = await fs.readJson(path.join(rootDir, "storage/environment-discovery", project, `${env}.json`));
  const accountResponse = await fetch(`http://127.0.0.1:54319/api/accounts?project=${project}&env=${env}`).then((r) => r.json()) as { accounts?: Array<Record<string, unknown>> };
  const account = (accountResponse.accounts ?? [])[0];
  const bypass = discovery.bypassLogin;
  if (!bypass?.enabled || !account) {
    // 无 bypass 时退化为匿名打开（可能被登录墙拦截；CLI 应优先配置 bypass）
    const browser = await chromium.launch({ headless: !headed });
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    return page;
  }
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
  const token = String(bypass.tokenResponsePath.split(".").reduce((cur: unknown, key: string) => (cur as Record<string, unknown>)?.[key], loginBody));
  if (!token || token === "undefined") throw new Error("bypass login token fetch failed");
  const browser = await chromium.launch({ headless: !headed });
  const ctx = await browser.newContext({ extraHTTPHeaders: { [bypass.tokenHeaderName ?? "token"]: token } });
  await ctx.addInitScript(({ tokenValue }) => {
    for (const key of ["token", "exchange-token", "userToken", "accessToken"]) window.localStorage.setItem(key, tokenValue);
  }, { tokenValue: token });
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(2500);
  return page;
}

async function renderSession(session: ModelingSession): Promise<string> {
  return [
    "# Modeling Session",
    "",
    `- sessionId: ${session.sessionId}`,
    `- url: ${session.startUrl}`,
    `- status: ${session.status}`,
    `- identity: ${session.identityVerdict ?? "(none)"} | canonical: ${session.canonicalPageId ?? "-"}`,
    `- iteration: ${session.iteration}/${session.budgets.maxIterations}`,
    `- dryRun: ${session.dryRun} | riskMode: ${session.riskMode}`,
    `- stopReason: ${session.stopReason ?? "-"}`,
    `- stopDetail: ${session.stopDetail ?? "-"}`,
    "",
    "## Initial Capture",
    "",
    ...(session.initialCapture ? [
      `- interactiveElements: ${session.initialCapture.interactiveElementCount}`,
      `- dialogs: ${session.initialCapture.dialogCount} | tables: ${session.initialCapture.tableCount} | selects: ${session.initialCapture.listCount}`,
      `- domHash: ${session.initialCapture.domHash?.slice(0, 12) ?? "-"}`,
      `- visibleTextHash: ${session.initialCapture.visibleTextHash?.slice(0, 12) ?? "-"}`
    ] : ["- (无 bootstrap)"]) ,
    "",
    "## Progress History",
    "",
    ...session.progressHistory.map((p) => `- iter${p.iteration}: gaps ${p.gapsBefore}→${p.gapsAfter} | matched ${p.matchedBefore}→${p.matchedAfter} | verified ${p.verifiedBefore}→${p.verifiedAfter} | newEvidence ${p.newEvidence} | promoted ${p.promotedKnowledge} | progressed=${p.progressed}`),
    "",
    "## Promotions",
    "",
    ...(session.promotionResults.length ? session.promotionResults.map((r) => `- ${r.ok ? "OK" : "SKIP"} ${r.knowledgeType} ${r.targetId} ${r.action} ${r.reason ?? ""}`) : ["- (无)"]),
    "",
    "## Review Requests",
    "",
    ...(session.reviewRequests.length ? session.reviewRequests.map((r) => `- ${r.reason}`) : ["- (无)"]),
    ""
  ].join("\n");
}

async function main(): Promise<void> {
  const url = typeof options.values.url === "string" ? options.values.url : undefined;
  const project = String(options.values.project ?? "demo");
  const env = String(options.values.env ?? "test");
  const dryRun = options.values["dry-run"] !== false;
  const resume = typeof options.values.resume === "string" ? options.values.resume : undefined;
  const resumeApproved = options.values["resume-approved"] === true;
  const headed = options.values.headed === true;

  if (resume) {
    const session = await loadModelingSession(rootDir, project, resume);
    if (!session) {
      console.error(`session 不存在: ${resume}`);
      process.exit(2);
    }
    if (session.status === "WAITING_FOR_REVIEW" && !resumeApproved) {
      console.log(JSON.stringify({ sessionId: session.sessionId, status: session.status, identity: session.identityVerdict, iteration: session.iteration, message: "等待人工 review；加 --resume-approved 批准后继续" }, null, 2));
      return;
    }
    // P6.11：断点续跑——用 session 记录的 startUrl 重新打开页面，并从已持久化的
    // iteration/executedFingerprints 继续（不重跑已成功 plan）。
    console.log(`=== P6 Resume ===`);
    console.log(`sessionId: ${resume} | status: ${session.status} | identity: ${session.identityVerdict} | iteration: ${session.iteration}`);
    console.log(`重新打开 startUrl: ${session.startUrl}`);
    const page = await openAuthenticatedPage(project, env, session.startUrl, headed);
    const result = await runModelingSession({
      rootDir,
      project,
      env,
      startUrl: session.startUrl,
      page,
      resumeSessionId: resume,
      resumeApproved,
      riskMode: session.riskMode,
      dryRun,
      budgets: session.budgets
    });
    console.log(`\n=== Resume 结果 ===`);
    console.log(`status: ${result.session.status} | stopReason: ${result.stopReason ?? "-"}`);
    console.log(`iterations: ${result.session.iteration} | evidence: ${result.session.evidenceIds.length}`);
    const reportDir = path.join(rootDir, "reports", "modeling-sessions");
    await fs.ensureDir(reportDir);
    await writeSafeJsonFile(path.join(reportDir, `${result.session.sessionId}.json`), result.session);
    return;
  }

  if (!url) {
    console.error("用法: page-model-auto --url <url> [--dry-run] [--max-iterations N] [--max-plans N] [--risk-mode safe]");
    process.exit(2);
  }

  console.log(`=== P6 自动建模 ===`);
  console.log(`url: ${url} | project: ${project} | env: ${env} | dryRun: ${dryRun}`);
  console.log(`登录并打开页面...`);
  const page = await openAuthenticatedPage(project, env, url, headed);

  const result = await runModelingSession({
    rootDir,
    project,
    env,
    startUrl: url,
    page,
    riskMode: (typeof options.values["risk-mode"] === "string" ? options.values["risk-mode"] : "safe") as "safe" | "review",
    dryRun,
    budgets: {
      maxIterations: Number(options.values["max-iterations"] ?? 5),
      maxPlansPerIteration: Number(options.values["max-plans"] ?? 5)
    }
  });

  console.log(`\n=== 结果 ===`);
  console.log(`sessionId: ${result.session.sessionId}`);
  console.log(`status: ${result.session.status} | stopReason: ${result.stopReason ?? "-"}`);
  console.log(`identity: ${result.session.identityVerdict ?? "-"} | canonical: ${result.session.canonicalPageId ?? "-"}`);
  console.log(`iterations: ${result.session.iteration} | evidence: ${result.session.evidenceIds.length}`);
  console.log(`progress: ${result.session.progressHistory.length} 轮`);
  for (const p of result.session.progressHistory) {
    console.log(`  iter${p.iteration}: gaps ${p.gapsBefore}→${p.gapsAfter} | matched ${p.matchedBefore}→${p.matchedAfter} | verified ${p.verifiedBefore}→${p.verifiedAfter} | newEvidence ${p.newEvidence} | promoted ${p.promotedKnowledge}`);
  }
  if (result.session.reviewRequests.length) {
    console.log(`\nREVIEW REQUIRED:`);
    for (const r of result.session.reviewRequests) console.log(`  - ${r.reason}`);
  }
  console.log(`\nstopDetail: ${result.stopDetail ?? "-"}`);

  const reportDir = path.join(rootDir, "reports", "modeling-sessions");
  await fs.ensureDir(reportDir);
  await writeSafeJsonFile(path.join(reportDir, `${result.session.sessionId}.json`), result.session);
  await writeSafeTextFile(path.join(reportDir, `${result.session.sessionId}.md`), await renderSession(result.session));
  console.log(`\n报告: reports/modeling-sessions/${result.session.sessionId}.json / .md`);
  console.log(`resume: npx tsx scripts/page-model-auto.ts --resume ${result.session.sessionId}`);
  if (result.session.status === "WAITING_FOR_REVIEW") {
    console.log(`resume approved: npx tsx scripts/page-model-auto.ts --resume ${result.session.sessionId} --resume-approved`);
  }
}

await main();
