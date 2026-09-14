import path from "node:path";
import fs from "fs-extra";
import type { AutomationCase, CaseResult, RuntimeOptions } from "./types.js";
import { loadContext, readCaseFile } from "./config-loader.js";
import { ArtifactManager } from "./artifact-manager.js";
import { matchesRuntimeFilter } from "./tag-manager.js";
import { logger } from "./logger.js";
import { reviewFailure } from "./ai-assistant.js";
import { DslExecutor } from "./dsl-executor.js";
import { BootstrapScanner } from "../bootstrap/bootstrap-scanner.js";

async function discoverCaseFiles(rootDir: string, project: string): Promise<string[]> {
  const projectDir = path.join(rootDir, "projects", project);
  const files: string[] = [];
  async function walk(dir: string): Promise<void> {
    if (!(await fs.pathExists(dir))) return;
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(fullPath);
      if (entry.isFile() && /\.(case|dsl)\.(ya?ml|json)$/i.test(entry.name)) files.push(fullPath);
    }
  }
  await walk(projectDir);
  return files;
}

function validateSafety(testCase: AutomationCase, options: RuntimeOptions): void {
  const riskyStep = testCase.steps.find((step) => step.riskLevel === "high");
  if (!riskyStep) return;
  if (options.env === "prod.readonly") {
    throw new Error(`High-risk step is forbidden in prod.readonly: ${testCase.id}`);
  }
  logger.warn(`High-risk step is allowed in non-prod execution: ${testCase.id}`, {
    action: riskyStep.action,
    target: riskyStep.target,
    env: options.env
  });
}

async function executeDslCase(
  testCase: AutomationCase,
  options: RuntimeOptions,
  context: Awaited<ReturnType<typeof loadContext>>
): Promise<CaseResult> {
  const start = Date.now();
  validateSafety(testCase, options);
  if (options.dryRun) {
    return { id: testCase.id, status: "skipped", durationMs: Date.now() - start };
  }
  logger.info(`Execute DSL case: ${testCase.id}`, {
    type: testCase.type,
    module: testCase.module,
    steps: testCase.steps.length,
    assertions: testCase.assertions.length
  });
  const executor = new DslExecutor(context);
  return executor.executeCase({ testCase, context, options });
}

export async function runTests(options: RuntimeOptions): Promise<CaseResult[]> {
  const context = await loadContext({ project: options.project, env: options.env });
  const artifactManager = new ArtifactManager(context);
  await artifactManager.ensureBaseDirs();

  if (options.mode === "bootstrap_scan") {
    const startUrl = options.startUrl ?? context.env.web?.baseUrl;
    const scanner = new BootstrapScanner(context);
    const result = await scanner.scan({
      projectId: context.project.projectKey,
      platform: options.type === "app" ? "android" : "web",
      env: context.env.env,
      startUrl,
      startActivity: options.startActivity,
      targetFlows: options.targetFlows ?? [],
      maxPages: options.maxPages ?? 20,
      maxDepth: options.maxDepth ?? 2,
      maxPaths: options.maxPaths ?? 30,
      maxDurationMs: options.maxDurationMs,
      allowedDomains: options.allowedDomains ?? (startUrl ? [new URL(startUrl).hostname] : []),
      deniedPatterns: options.deniedPatterns ?? [],
      deniedActions:
        options.deniedActions ??
        ["withdraw", "payment", "pay", "delete", "transfer", "submit order", "place order", "提现", "支付", "删除", "转账", "提交订单", "下单"],
      maxAiCalls: options.maxAiCalls,
      maxAiTokens: options.maxAiTokens,
      dryRunOnly: options.dryRunOnly ?? true,
      requireHumanApprovalBeforeSubmit: options.requireHumanApprovalBeforeSubmit ?? true,
      headed: false
    });
    return [
      {
        id: result.run.scan_id,
        status: result.run.status === "failed" ? "failed" : "skipped",
        durationMs: result.run.ended_at ? Date.parse(result.run.ended_at) - Date.parse(result.run.started_at) : 0,
        error: result.run.status === "failed" ? result.run.summary : undefined,
        artifacts: [result.reviewPackage.package_path, result.reviewPackage.prompt_md_path]
      }
    ];
  }

  const caseFiles = await discoverCaseFiles(context.rootDir, options.project);
  const loadedCases = await Promise.all(caseFiles.map((file) => readCaseFile<AutomationCase>(file)));
  const selectedCases = loadedCases.filter((item) => matchesRuntimeFilter(item, options));

  logger.info(`Selected ${selectedCases.length}/${loadedCases.length} cases`, {
    project: options.project,
    env: options.env,
    type: options.type,
    tags: options.tags,
    caseId: options.caseId
  });

  const results: CaseResult[] = [];
  for (const item of selectedCases) {
    try {
      results.push(await executeDslCase(item, options, context));
    } catch (error) {
      const failedResult: CaseResult = {
        id: item.id,
        status: "failed",
        durationMs: 0,
        error: error instanceof Error ? error.message : String(error)
      };
      failedResult.aiReview = reviewFailure(failedResult);
      results.push(failedResult);
    }
  }

  const failureReviews = results
    .filter((item) => item.status === "failed")
    .map((item) => ({ id: item.id, review: item.aiReview ?? reviewFailure(item) }));

  await artifactManager.writeJson(`logs/latest-results.json`, {
    runId: artifactManager.runId(),
    options,
    results
  });
  if (failureReviews.length > 0) {
    await artifactManager.writeJson(`logs/latest-ai-failure-review.json`, {
      runId: artifactManager.runId(),
      reviews: failureReviews
    });
  }
  return results;
}
