import path from "node:path";
import fs from "fs-extra";
import { chromium } from "@playwright/test";
import { writeSafeJsonFile, writeSafeTextFile } from "../core/safe-file-writer.js";
import { injectAuthState, readCaptureAuthContext, requestBypassLogin, waitSettled } from "./auth.js";
import { capturePage, clickEntry, toRelativePath } from "./evidence.js";
import { buildBlockIfNeeded, buildProposal, renderReport } from "./proposal.js";
import type { CaptureRunConfig, CaptureTargetResult } from "./types.js";

export interface CaptureRunOutcome {
  reportPath: string;
  jsonPath: string;
  artifactDir: string;
  pageModels: number;
  navigationEdges: number;
  elements: number;
  assertions: number;
  actionResults: number;
  blockPackages: number;
}

export async function runCapture(input: {
  rootDir: string;
  config: CaptureRunConfig;
}): Promise<CaptureRunOutcome> {
  const { rootDir, config } = input;
  const artifactDir = path.join(rootDir, "artifacts", config.runId);
  await fs.ensureDir(artifactDir);
  const reportPath = path.join(rootDir, "reports", `${config.runId}-scan.md`);
  const jsonPath = path.join(rootDir, "reports", `${config.runId}-scan.json`);
  const auth = await readCaptureAuthContext(rootDir, config.project, config.env);
  const navigationTimeoutMs = config.navigationTimeoutMs ?? 45_000;

  const browser = await chromium.launch({ headless: !config.headed });
  const context = await browser.newContext({
    viewport: config.viewport ?? { width: 1440, height: 1000 }
  });
  const authHeaders = await requestBypassLogin(auth);
  if (authHeaders?.token) {
    await injectAuthState(context, auth.webBaseUrl || config.entryUrl, authHeaders.token, authHeaders.headerName, auth.authInjection);
  }
  const page = await context.newPage();
  if (authHeaders?.headers && Object.keys(authHeaders.headers).length) {
    await page.route("**/*", (route) => route.continue({ headers: { ...route.request().headers(), ...authHeaders.headers } }));
  }

  const captures: CaptureTargetResult[] = [];
  try {
    for (const target of config.targets) {
      if (target.kind === "direct_page") {
        await page.goto(target.url ?? config.entryUrl, { waitUntil: "domcontentloaded", timeout: navigationTimeoutMs });
        await waitSettled(page);
        const capture = await capturePage(page, rootDir, artifactDir, target.id, target, config);
        captures.push({ target, capture, block: buildBlockIfNeeded(config, target, capture, undefined) });
        continue;
      }
      await page.goto(config.entryUrl, { waitUntil: "domcontentloaded", timeout: navigationTimeoutMs });
      await waitSettled(page);
      const before = await capturePage(page, rootDir, artifactDir, `${target.id}_before`, { ...target, id: `${target.id}_before`, pageId: config.entryPageId }, config);
      const actionResult = await clickEntry(page, target.entryText ?? target.label);
      await waitSettled(page);
      const capture = await capturePage(page, rootDir, artifactDir, target.id, target, config);
      captures.push({ target, before, capture, actionResult, block: buildBlockIfNeeded(config, target, capture, actionResult) });
    }
  } finally {
    await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }

  const proposal = buildProposal(config, auth, captures, toRelativePath(rootDir, artifactDir));
  await writeSafeJsonFile(jsonPath, proposal);
  await writeSafeTextFile(reportPath, renderReport(proposal));
  const proposals = proposal.proposals as Record<string, Array<Record<string, unknown>>>;
  return {
    reportPath: toRelativePath(rootDir, reportPath),
    jsonPath: toRelativePath(rootDir, jsonPath),
    artifactDir: toRelativePath(rootDir, artifactDir),
    pageModels: proposals.pageModels.length,
    navigationEdges: proposals.navigationEdges.length,
    elements: proposals.elementInventories.length,
    assertions: proposals.assertionModels.length,
    actionResults: proposals.actionResults.length,
    blockPackages: proposals.blockPackages.length
  };
}
