import http from "node:http";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createRequire } from "node:module";
import crypto from "node:crypto";
import { TextDecoder } from "node:util";
import fs from "fs-extra";
import { Command } from "commander";
import YAML from "yaml";
import { chromium, type Page } from "@playwright/test";
import { loadContext } from "../src/core/config-loader.js";
import type {
  AutomationCase,
  BusinessFlow,
  DslAssertion,
  DslStep,
  EnvironmentDiscovery,
  ExecutionRun,
  FailureReport,
  KnowledgeChunk,
  LoadedContext,
  PageGraphMemory,
  PageTransition,
  RuntimeOptions,
  TestAccount
} from "../src/core/types.js";
import { PageGraphStore } from "../src/memory/page-graph-store.js";
import { KnowledgeStore } from "../src/memory/knowledge-store.js";
import { AccountStore } from "../src/memory/account-store.js";
import { EnvironmentDiscoveryStore, defaultDiscovery } from "../src/memory/environment-discovery-store.js";
import { logger } from "../src/core/logger.js";
import { assertCleanTextBoundary, EncodingBoundaryError } from "../src/core/text-encoding.js";
import { AIUsageTracker } from "../src/core/ai-usage-tracker.js";
import { ExecutionStore } from "../src/memory/execution-store.js";
import { BootstrapScanStore } from "../src/memory/bootstrap-scan-store.js";
import { BootstrapScanner } from "../src/bootstrap/bootstrap-scanner.js";
import { DslExecutor } from "../src/core/dsl-executor.js";
import { WebDriverAdapter } from "../src/drivers/web-driver-adapter.js";
import type { Platform } from "../src/core/types.js";
import { BusinessFlowStore } from "../src/memory/business-flow-store.js";
import { PageStateStore } from "../src/memory/page-state-store.js";
import { safeArtifactText, writeSafeJsonArtifact } from "../src/core/json-artifact-writer.js";
import { writeSafeJsonFile, writeSafeTextFile } from "../src/core/safe-file-writer.js";
import {
  createLocalAiStageEnvelope,
  type AiStageEnvelope,
  type CoverageExplanation,
  type DslDraft,
  type DslDraftStep,
  type DslReview,
  type EvidenceRef,
  type FailurePackageV1,
  type FailureStage,
  type PreflightDecision,
  type ProviderCallRecord
} from "../src/core/ai-orchestration-schema.js";
import {
  buildBusinessFlowCoverage,
  buildAiDiagnosticLogForFailure,
  detectRedPacketCreateClaimPollution,
  extractCoverageGaps,
  hasVerifiedAssetOverviewEvidence,
  isAssetOverviewIntent,
  isAssetRecordIntent,
  isAssetRecordKnowledge,
  isWeakLayeredEvidence,
  layerEvidenceMetadata,
  rerankKnowledgeHitsForIntent,
  summarizeRetrievalForFailure,
  type CoverageEvidence,
  type KnowledgeRerankAudit,
  type LayeredEvidenceMetadata,
  type PreflightCheck
} from "../src/core/assistant-planning-support.js";
import { applyDslGenerationRulesToDraft } from "../src/core/dsl-rule-dry-run.js";
import { DslGenerationRuleStore } from "../src/core/dsl-generation-rule.js";
import {
  classifyWithDomainVocabulary,
  loadDomainVocabulary,
  summarizeDomainVocabulary,
  type DomainVocabulary,
  type DomainVocabularyEvidence
} from "../src/core/domain-vocabulary.js";
import { applyReadOnlyDslGuard } from "../src/core/read-only-dsl-guard.js";
import {
  planAssistantRequestWithPageModels,
  summarizePageModelRouteForResponse
} from "../src/core/page-model-assistant-route.js";
import { formatLocalizedPageModelGaps } from "../src/core/page-model-gap-localization.js";
import { aiIntentUnderstandingBlockReason, understandPageModelIntentWithAi } from "../src/core/page-model-ai-intent.js";
import { buildPageModelDslAdvisorWithAi, type PageModelDslAdvisorMode } from "../src/core/page-model-dsl-advisor.js";
import {
  buildStructuredCaseContext,
  caseContextToRequest,
  type StructuredCaseContext
} from "../src/core/case-context.js";
import type { AccountFactoryAdapter, AccountFactoryStepResult } from "../src/account-factory/types.js";
import { checkTotpReadiness, classifyTotpReadinessError, readTotpCode } from "../src/core/totp-provider.js";
import { readProjectCapabilityRegistry } from "../src/workbench/project-capabilities.js";
import { registerAllRoutes } from "../src/workbench/server/register-routes.js";
import { envApiKeyFor, normalizeAiModel, normalizeProviderName, readAiProviderSettings, resolveAiRuntime } from "../src/core/ai-provider.js";

const program = new Command();
program.option("--host <host>", "host", "127.0.0.1").option("--port <port>", "port", "54319");
program.parse();
const options = program.opts();
const host = String(options.host);
const port = Number(options.port);
const rootDir = process.cwd();

// .env 加载（仅填空，不覆盖已存在的环境变量）：让看门狗/自启的服务进程
// 也能读到项目根目录 .env 里的 AI Provider 配置（GLM_API_KEY 等）。
{
  const envPath = path.join(rootDir, ".env");
  if (fs.existsSync(envPath)) {
    const envText = await fs.readFile(envPath, "utf8");
    for (const rawLine of envText.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      if (key && process.env[key] === undefined) process.env[key] = value;
    }
  }
}

const require = createRequire(import.meta.url);
const publicDir = path.join(rootDir, "web");
const defaultProject = "demo";
// 意图理解/审查超时：GLM 网关冷路径可达 35s+，默认放宽到 90s，可用环境变量覆盖。
const pageModelDeepSeekTimeoutMs = Math.max(5_000, Number(process.env.PAGE_MODEL_DEEPSEEK_TIMEOUT_MS ?? 150_000));
let runningWebExplore: { child: ChildProcessWithoutNullStreams; startedAt: string; command: string } | undefined;
const routeRegistry = registerAllRoutes();
const assistantExecutionControllers = new Map<string, AbortController>();
const caseDslGenerationControllers = new Map<string, AbortController>();
const caseExecutionControllers = new Map<string, AbortController>();

type WorkbenchCasePriority = "P0" | "P1" | "P2" | "P3";

interface WorkbenchCaseAsset {
  id: string;
  project: string;
  module: string;
  pageModelId?: string;
  title: string;
  priority: WorkbenchCasePriority;
  caseType: string;
  automationCandidate: boolean;
  request: string;
  businessRequest?: string;
  preconditions: string[];
  expectedAssertion: string;
  expectedResults: {
    ui?: string[];
    api?: string[];
    database?: string[];
  };
  source: {
    type: "seed" | "manual" | "generated";
    refs: string[];
  };
  dslByProject?: Record<string, WorkbenchCaseDsl>;
  latestDsl?: WorkbenchCaseDsl;
  latestDslGeneration?: WorkbenchCaseDslGenerationSummary;
  executionHistory?: WorkbenchCaseExecution[];
  createdAt: string;
  updatedAt: string;
}

interface WorkbenchCaseDslGenerationStageSummary {
  id: string;
  title: string;
  status: string;
  detail?: string;
  retryable?: boolean;
  failedStage?: string;
  attempt?: number;
  maxAttempts?: number;
  updatedAt?: string;
}

interface WorkbenchCaseDslGenerationSummary {
  schemaVersion: "workbench-case-dsl-generation-summary.v1";
  project: string;
  env: string;
  caseId: string;
  runId?: string;
  status: "running" | "completed" | "failed" | "cancelled";
  retryable?: boolean;
  failedStage?: string;
  error?: string;
  diagnosticPath?: string;
  proposalPath?: string;
  storePath?: string;
  revision?: number;
  executable?: boolean;
  readiness?: string;
  gaps?: string[];
  blockingGaps?: string[];
  stages: WorkbenchCaseDslGenerationStageSummary[];
  resumeState?: WorkbenchCaseDslGenerationResumeState;
  createdAt: string;
  updatedAt: string;
}

interface WorkbenchCaseDslGenerationResumeState {
  stage: "account_profile_match";
  caseRequest: string;
  pageModelDeepSeekIntent: unknown;
  pageModelRoute: unknown;
  planSummary: unknown;
}

interface WorkbenchCaseDsl {
  schemaVersion: "workbench-case-dsl.v1";
  revision: number;
  generatedAt: string;
  generator: "page-model-assistant-plan";
  sourceCaseHash: string;
  changedSinceGeneration: boolean;
  plan: Record<string, unknown>;
  automationCase?: AutomationCase;
  stepSummaries: string[];
  assertionSummaries: string[];
  readiness?: string;
  executable: boolean;
  gaps: string[];
  blockingGaps: string[];
  assertionContract?: WorkbenchAssertionContractResult;
  accountProfileDecision?: AccountProfileMatchDecision;
  ai?: {
    intent?: unknown;
    dslAdvisor?: unknown;
  };
  deepseek?: {
    intent?: unknown;
    dslAdvisor?: unknown;
  };
}

interface WorkbenchAssertionContractResult {
  passed: boolean;
  expectedAssertion: string;
  materializedAssertions: string[];
  gaps: string[];
}

interface WorkbenchCaseExecution {
  runId?: string;
  executedAt: string;
  project: string;
  env: string;
  account?: string;
  status: string;
  exitCode: number;
  durationMs?: number;
  assertionSummaries: Array<Record<string, unknown>>;
  executionSteps?: Array<Record<string, unknown>>;
  actualResult?: string;
  failurePackagePath?: string;
  failurePromptPath?: string;
  proposalPath?: string;
  caseRunPath?: string;
  observationMode?: boolean;
  observationArtifactPath?: string;
  accountProfileDecision?: AccountProfileMatchDecision;
  profileUpdatedPath?: string;
}

interface AccountProfileDimensionValue {
  status?: string;
  value?: unknown;
  source?: string;
  mappingId?: string;
  updatedAt?: string;
  staleAt?: string;
  evidence?: unknown;
}

interface AccountProfileTagValue {
  tag: string;
  status?: string;
  reason?: string;
}

interface AccountProfileRecord {
  accountId?: string;
  username: string;
  label?: string;
  profileStatus?: string;
  locationTags?: AccountProfileTagValue[];
  dimensions?: Record<string, AccountProfileDimensionValue>;
}

interface AccountProfileStoreData {
  schemaVersion?: string;
  project: string;
  env: string;
  updatedAt?: string;
  profiles: AccountProfileRecord[];
}

interface AccountProfileBundle {
  project: string;
  env: string;
  schema: Record<string, unknown>;
  mapping: Record<string, unknown>;
  profile: AccountProfileStoreData;
}

interface DemoAccountProfileQueryRows {
  ok: true;
  userRows: Array<Record<string, unknown>>;
  kycRows: Array<Record<string, unknown>>;
  spotRows: Array<Record<string, unknown>>;
  spotFlowRows: Array<Record<string, unknown>>;
  spotWithdrawFlowRows: Array<Record<string, unknown>>;
  spotInnerTransferFlowRows: Array<Record<string, unknown>>;
  spotBatchTransferFlowRows: Array<Record<string, unknown>>;
  earnRows: Array<Record<string, unknown>>;
  earnFlowRows: Array<Record<string, unknown>>;
  futuresUserRows: Array<Record<string, unknown>>;
  futuresAccountRows: Array<Record<string, unknown>>;
  futuresFlowRows: Array<Record<string, unknown>>;
  queries: Array<Record<string, unknown>>;
}

interface AccountProfileRefreshBlocked {
  [key: string]: unknown;
  ok: false;
  schemaVersion: "account-profile-refresh-result.v1";
  project: string;
  env: string;
  status: string;
  diagnostics: Record<string, unknown>;
}

interface AccountProfileRequirement {
  dimensionId: string;
  reason: string;
  required: boolean;
  critical?: boolean;
  expected?: unknown;
  source?: "case" | "knowledge" | "ai" | "case_precondition_gap";
  /** any_of 组名：同组要求任一满足即整组通过（如 GA 或手机任一安全验证方式）。 */
  relationGroup?: string;
}

interface AccountProfileMatchDecision {
  schemaVersion: "account-profile-match.v1";
  project: string;
  env: string;
  status: "matched" | "candidate" | "blocked" | "not_configured";
  selectedAccount?: string;
  selectedAccountId?: string;
  operationType: "read" | "write" | "unknown";
  requiredTags: string[];
  requirements: AccountProfileRequirement[];
  profileImpact: string[];
  candidateResults: AccountProfileCandidateResult[];
  chineseSummary: string;
  diagnosticPath?: string;
}

interface AccountProfileCandidateResult {
  username: string;
  accountId?: string;
  score: number;
  status: "matched" | "candidate" | "unmatched";
  matchedTags: string[];
  missingTags: string[];
  matchedDimensions: string[];
  missingDimensions: string[];
  unknownDimensions: string[];
  staleDimensions: string[];
}

interface WorkbenchCaseStoreData {
  schemaVersion: "workbench-case-store.v1";
  project: string;
  updatedAt: string;
  cases: WorkbenchCaseAsset[];
}

interface ProjectKnowledgeMapStoreData {
  schemaVersion: "project-knowledge-map.v1";
  project: string;
  defaultProject?: boolean;
  generatedAt: string;
  updatedAt: string;
  source: {
    generator: "page-model-operation-manual-summary" | "live-project-structure-modeling";
    refs: string[];
  };
  summary: {
    totalNodes: number;
    modeledNodes: number;
    partialNodes: number;
    unmodeledNodes: number;
    staleNodes: number;
  };
  nodes: ProjectKnowledgeMapNode[];
}

interface ProjectKnowledgeMapNode {
  nodeId: string;
  parentId?: string;
  label: string;
  nodeType: "project" | "module" | "page" | "state";
  path: string[];
  modelingStatus: "modeled" | "partial" | "unmodeled" | "stale" | "unknown";
  pageModelId?: string;
  pageName?: string;
  urlPattern?: string;
  navigationPath?: string[];
  modeledAt?: string;
  lastObservedAt?: string;
  description?: string;
  capabilities: string[];
  elements: ProjectKnowledgeElementSummary[];
  actions: ProjectKnowledgeActionSummary[];
  assertions: string[];
  sourceArtifacts: Record<string, unknown>;
  notes: string[];
}

interface ProjectKnowledgeElementSummary {
  elementId?: string;
  name: string;
  type?: string;
  targetField?: string;
  status?: string;
}

interface ProjectKnowledgeActionSummary {
  actionId?: string;
  name: string;
  type?: string;
  targetPageId?: string;
  status?: string;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${host}:${port}`);
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
      return;
    }
    await serveStatic(res, url.pathname === "/" ? "/index.html" : url.pathname);
  } catch (error) {
    if (error instanceof EncodingBoundaryError) {
      logger.warn("Encoding boundary rejected request", { error: error.message, issues: error.issues });
      sendJson(res, 400, { error: error.message, encodingIssues: error.issues });
      return;
    }
    sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

const ACCOUNT_FACTORY_DEFAULT_PASSWORD = "CHANGE_ME";

server.listen(port, host, () => {
  console.log(`Workbench running at http://${host}:${port}`);
});

async function handleApi(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
  if (await routeRegistry.dispatch(req, res, url, { rootDir, defaultProject, defaultEnv: "test" })) return;

  if (req.method === "GET" && url.pathname === "/api/projects") {
    const context = await loadContext({ project: "demo", env: "test" });
    await new AccountStore(context).seedDefaults();
    sendJson(res, 200, { projects: await listProjects() });
    return;
  }

  // ============ P15 Workspace API（projection + command adapter） ============
  if (url.pathname.startsWith("/api/workspace/")) {
    const { WorkspaceProjectionService } = await import("../src/workspace/projection.js");
    const { WorkspaceCommandAdapter } = await import("../src/workspace/command-adapter.js");
    const ws = new WorkspaceProjectionService(rootDir);
    if (req.method === "GET" && url.pathname === "/api/workspace/overview") {
      sendJson(res, 200, await ws.getProductOverview());
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/workspace/release") {
      const releaseId = url.searchParams.get("releaseId") ?? "release-default";
      const requirementId = url.searchParams.get("requirement") ?? "";
      sendJson(res, 200, await ws.getReleaseWorkspace({ releaseId, requirementId }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/workspace/review-queue") {
      sendJson(res, 200, await ws.getReviewQueue());
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/workspace/coverage") {
      sendJson(res, 200, await ws.getCoverage());
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/workspace/search") {
      const q = url.searchParams.get("q") ?? "";
      sendJson(res, 200, await ws.search(q));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/workspace/health") {
      sendJson(res, 200, await ws.getSystemHealth());
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/workspace/command") {
      const body = await readBody(req);
      const adapter = new WorkspaceCommandAdapter(rootDir);
      const result = await adapter.execute(body as never);
      sendJson(res, result.ok ? 200 : 400, result);
      return;
    }
    sendJson(res, 404, { ok: false, error: "unknown workspace api" });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/accounts") {
    const project = url.searchParams.get("project") || undefined;
    const env = url.searchParams.get("env") || undefined;
    const username = url.searchParams.get("username") || undefined;
    const context = await loadContext({ project: project ?? "demo", env: env ?? "test" });
    await new AccountStore(context).seedDefaults();
    sendJson(res, 200, { accounts: await new AccountStore(context).list({ project, env, username }) });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/accounts/totp-readiness") {
    const project = url.searchParams.get("project") ?? defaultProject;
    const env = url.searchParams.get("env") ?? "test";
    const username = url.searchParams.get("username") || undefined;
    sendJson(res, 200, await readAccountTotpReadiness({ project, env, username }));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/accounts/totp") {
    const body = await readBody(req);
    const project = String(body.project ?? defaultProject);
    const env = String(body.env ?? "test");
    const username = required(body.username, "username");
    sendJson(res, 200, await readAccountTotpForDisplay({ project, env, username }));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/account-profiles") {
    const project = url.searchParams.get("project") ?? defaultProject;
    const env = url.searchParams.get("env") ?? "test";
    sendJson(res, 200, await readAccountProfileBundle(project, env));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/account-factory/capabilities") {
    const project = url.searchParams.get("project") ?? defaultProject;
    const env = url.searchParams.get("env") ?? "test";
    sendJson(res, 200, await readAccountFactoryCapabilities(project, env));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/account-profiles/refresh") {
    const body = await readBody(req);
    const project = String(body.project ?? defaultProject);
    const env = String(body.env ?? "test");
    const username = body.username ? String(body.username) : undefined;
    sendJson(res, 200, await refreshAccountProfilesFromDatabase({ project, env, username }));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/database/models") {
    const project = url.searchParams.get("project") ?? defaultProject;
    sendJson(res, 200, await readDatabaseModelStore(project));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/database/schema") {
    const project = url.searchParams.get("project") ?? defaultProject;
    const env = url.searchParams.get("env") ?? "test";
    const force = url.searchParams.get("force") === "true";
    sendJson(res, 200, await readDatabaseWorkbenchSchema({ project, env, force }));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/database/generate-sql") {
    const body = await readBody(req);
    const project = String(body.project ?? defaultProject);
    const env = String(body.env ?? "test");
    const message = required(body.message, "message");
    const sourceId = String(body.sourceId ?? "workbench_sqlite");
    sendJson(res, 200, await generateDatabaseWorkbenchSql({ project, env, message, sourceId }));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/database/execute-sql") {
    const body = await readBody(req);
    const project = String(body.project ?? defaultProject);
    const env = String(body.env ?? "test");
    const sourceId = String(body.sourceId ?? "workbench_sqlite");
    const sql = required(body.sql, "sql");
    sendJson(res, 200, await executeDatabaseWorkbenchSql({ project, env, sourceId, sql }));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/account-factory/provision") {
    const body = await readBody(req);
    sendJson(res, 200, await provisionAccountForRequirements({
      project: String(body.project ?? defaultProject),
      env: String(body.env ?? "test"),
      reason: body.reason ? String(body.reason) : undefined,
      username: body.username ? String(body.username) : undefined,
      password: body.password ? String(body.password) : undefined,
      namingRule: isRecord(body.namingRule) ? body.namingRule : undefined,
      autoSequence: body.autoSequence !== false,
      requirements: Array.isArray(body.requirements) ? body.requirements : []
    }));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/accounts") {
    const body = await readBody(req);
    const context = await loadContext({ project: String(body.project ?? "demo"), env: String(body.env ?? "test") });
    const account = await new AccountStore(context).upsert({
      id: body.id ? String(body.id) : undefined,
      project: String(body.project ?? "demo"),
      env: String(body.env ?? "test"),
      username: required(body.username, "username"),
      password: required(body.password, "password"),
      label: body.label ? String(body.label) : undefined
    });
    sendJson(res, 200, account);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/tasks") {
    sendJson(res, 200, {
      webExplore: runningWebExplore
        ? {
            running: true,
            pid: runningWebExplore.child.pid,
            startedAt: runningWebExplore.startedAt,
            command: runningWebExplore.command
          }
        : { running: false }
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/summary") {
    const project = url.searchParams.get("project") ?? defaultProject;
    const context = await loadContext({ project, env: url.searchParams.get("env") ?? "test" });
    const graph = await new PageGraphStore(context).load();
    const latestResultsPath = path.join(rootDir, "artifacts", "logs", "latest-results.json");
    const latestResults = (await fs.pathExists(latestResultsPath)) ? await fs.readJson(latestResultsPath) : undefined;
    sendJson(res, 200, {
      workspace: context.workspace.workspaceName,
      project: context.project.projectKey,
      env: context.env.env,
      graph: { nodes: graph.nodes.length, edges: graph.edges.length, updatedAt: graph.updatedAt },
      latestResults
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/execution") {
    const project = url.searchParams.get("project") ?? defaultProject;
    const env = url.searchParams.get("env") ?? "test";
    const limit = Number(url.searchParams.get("limit") ?? "50");
    const context = await loadContext({ project, env });
    const data = await new ExecutionStore(context).load();
    const runs = data.runs.filter((item) => !env || item.env === env).slice(0, limit);
    const runIds = new Set(runs.map((item) => item.run_id));
    const aiUsages = data.aiUsages.filter((item) => item.run_id && runIds.has(item.run_id));
    sendJson(res, 200, {
      runs,
      steps: data.steps.filter((item) => runIds.has(item.run_id)).slice(-limit * 20).reverse(),
      failureReports: data.failureReports.filter((item) => runIds.has(item.run_id)).slice(0, limit),
      aiUsages: aiUsages.slice(-limit * 20).reverse(),
      aiSummary: {
        invocations: aiUsages.filter((item) => !item.cache_hit).length,
        promptTokens: aiUsages.reduce((sum, item) => sum + item.prompt_tokens, 0),
        completionTokens: aiUsages.reduce((sum, item) => sum + item.completion_tokens, 0),
        totalTokens: aiUsages.reduce((sum, item) => sum + item.total_tokens, 0),
        estimatedCost: aiUsages.reduce((sum, item) => sum + item.estimated_cost, 0)
      }
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/bootstrap-scans") {
    const project = url.searchParams.get("project") ?? defaultProject;
    const env = url.searchParams.get("env") ?? "test";
    const context = await loadContext({ project, env });
    const data = await new BootstrapScanStore(context).load();
    const runs = data.runs.filter((item) => item.env === env).slice(0, Number(url.searchParams.get("limit") ?? "50"));
    const scanIds = new Set(runs.map((item) => item.scan_id));
    sendJson(res, 200, {
      runs,
      pages: data.pages.filter((item) => scanIds.has(item.scan_id)),
      paths: data.paths.filter((item) => scanIds.has(item.scan_id)),
      elements: data.elements.filter((item) => scanIds.has(item.scan_id)),
      reviewPackages: data.reviewPackages.filter((item) => scanIds.has(item.scan_id)),
      dslCases: data.dslCases.filter((item) => runs.some((run) => item.id.includes(run.scan_id.slice(0, 8))))
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/business-flows") {
    const project = url.searchParams.get("project") ?? defaultProject;
    const env = url.searchParams.get("env") ?? "test";
    const context = await loadContext({ project, env });
    const data = await new BusinessFlowStore(context).load();
    sendJson(res, 200, { flows: data.flows.filter((item) => item.env === env), updatedAt: data.updatedAt });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/app-archives") {
    const project = url.searchParams.get("project") ?? defaultProject;
    const env = url.searchParams.get("env") ?? "test";
    sendJson(res, 200, await readAppArchiveHistory(project, env));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/environment-discovery") {
    const project = url.searchParams.get("project") ?? defaultProject;
    const env = url.searchParams.get("env") ?? "test";
    const context = await loadContext({ project, env });
    const store = new EnvironmentDiscoveryStore(context);
    const discovery = await store.load(project, env);
    sendJson(res, 200, discovery);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/ai-settings") {
    const runtime = await resolveAiRuntime(rootDir);
    sendJson(res, 200, {
      provider: runtime.provider,
      model: runtime.model,
      baseUrl: runtime.baseUrl,
      hasApiKey: Boolean(runtime.apiKey),
      maskedApiKey: maskSecret(runtime.apiKey)
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/ai-settings") {
    const body = await readBody(req);
    const existing = await readAiSettings();
    const provider = normalizeProviderName(body.provider ?? existing.provider);
    const model = normalizeAiModel(provider, String(body.model ?? existing.model ?? "").trim());
    if (!model) {
      sendJson(res, 400, { error: `provider ${provider} 需要显式配置模型名，例如 glm-5.3-tencent。` });
      return;
    }
    const apiKey = String(body.apiKey ?? "").trim();
    const clearApiKey = Boolean(body.clearApiKey);
    const baseUrl = String(body.baseUrl ?? existing.baseUrl ?? "").trim() || undefined;
    const settings: AiSettings = {
      provider,
      model,
      baseUrl,
      apiKey: clearApiKey ? undefined : apiKey || existing.apiKey,
      updatedAt: new Date().toISOString()
    };
    await writeAiSettings(settings);
    sendJson(res, 200, {
      provider: settings.provider,
      model: settings.model,
      baseUrl: settings.baseUrl ?? "",
      hasApiKey: Boolean(settings.apiKey),
      maskedApiKey: maskSecret(settings.apiKey)
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/verifications/lark-settings") {
    const settings = await readLocalSecrets();
    sendJson(res, 200, {
      keyword: settings.larkVerification?.keyword ?? "验证码",
      hasWebhookUrl: Boolean(settings.larkVerification?.webhookUrl),
      maskedWebhookUrl: maskWebhook(settings.larkVerification?.webhookUrl),
      hasSignSecret: Boolean(settings.larkVerification?.signSecret),
      maskedSignSecret: maskSecret(settings.larkVerification?.signSecret),
      receiveMode: "local-inbox",
      receiveEndpoint: "/api/verifications/lark-webhook",
      note: "自定义机器人 webhook 只能向 Lark 群发送消息；收码监听需要 Lark 事件订阅、收码服务或手动模拟转发到 receiveEndpoint。"
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/verifications/lark-settings") {
    const body = await readBody(req);
    const existing = await readLocalSecrets();
    const clearWebhookUrl = Boolean(body.clearWebhookUrl);
    const clearSignSecret = Boolean(body.clearSignSecret);
    const next: LocalSecrets = {
      ...existing,
      larkVerification: {
        webhookUrl: clearWebhookUrl
          ? undefined
          : String(body.webhookUrl ?? "").trim() || existing.larkVerification?.webhookUrl,
        signSecret: clearSignSecret
          ? undefined
          : String(body.signSecret ?? "").trim() || existing.larkVerification?.signSecret,
        keyword: String(body.keyword ?? existing.larkVerification?.keyword ?? "验证码").trim() || "验证码",
        updatedAt: new Date().toISOString()
      }
    };
    await writeLocalSecrets(next);
    sendJson(res, 200, {
      keyword: next.larkVerification?.keyword,
      hasWebhookUrl: Boolean(next.larkVerification?.webhookUrl),
      maskedWebhookUrl: maskWebhook(next.larkVerification?.webhookUrl),
      hasSignSecret: Boolean(next.larkVerification?.signSecret),
      maskedSignSecret: maskSecret(next.larkVerification?.signSecret)
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/verifications/lark-test-send") {
    const body = await readBody(req);
    const result = await sendLarkVerificationTestMessage({
      account: String(body.account ?? ""),
      purpose: String(body.purpose ?? "Workbench 验证码监听测试")
    });
    sendJson(res, result.ok ? 200 : 400, result);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/verifications/inbox") {
    const account = url.searchParams.get("account") || undefined;
    const limit = Number(url.searchParams.get("limit") ?? "20");
    const inbox = await readVerificationInbox();
    const records = inbox.records
      .filter((item) => !account || item.account?.toLowerCase() === account.toLowerCase() || item.rawText.includes(account))
      .slice(0, limit);
    sendJson(res, 200, { records, updatedAt: inbox.updatedAt });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/verifications/lark-webhook") {
    const body = await readBody(req);
    if (typeof body.challenge === "string") {
      sendJson(res, 200, { challenge: body.challenge });
      return;
    }
    const record = await acceptVerificationPayload(body, "lark-webhook");
    sendJson(res, 200, { ok: true, record });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/verifications/simulate") {
    const body = await readBody(req);
    const record = await acceptVerificationPayload(
      {
        account: body.account,
        purpose: body.purpose,
        text: body.text ?? body.rawText,
        code: body.code
      },
      "manual-simulate"
    );
    sendJson(res, 200, { ok: true, record });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/environment-discovery") {
    const body = await readBody(req);
    const project = String(body.project ?? defaultProject);
    const env = String(body.env ?? "test");
    const context = await loadContext({ project, env });
    const discovery = {
      ...defaultDiscovery(project, env),
      domains: parseLines(String(body.domains ?? "")),
      apiEndpoints: parseApiEndpointLines(String(body.apiEndpoints ?? "")),
      bypassLogin: {
        ...defaultDiscovery(project, env).bypassLogin!,
        enabled: Boolean(body.bypassEnabled),
        path: String(body.bypassPath ?? "/spot/api/bypass/captcha/login_in"),
        tokenHeaderName: String(body.tokenHeaderName ?? "token"),
        tokenResponsePath: String(body.tokenResponsePath ?? "data.token"),
        updatedAt: new Date().toISOString()
      },
      authInjection: {
        storageKeys: parseLines(String(body.authStorageKeys ?? "")),
        cookieNames: parseLines(String(body.authCookieNames ?? "")),
        updatedAt: new Date().toISOString()
      },
      notes: body.notes ? String(body.notes) : undefined
    };
    const filePath = await new EnvironmentDiscoveryStore(context).save(discovery);
    sendJson(res, 200, { filePath, discovery });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/elements") {
    const project = url.searchParams.get("project") ?? defaultProject;
    const context = await loadContext({ project, env: url.searchParams.get("env") ?? "test" });
    const graph = await new PageGraphStore(context).load();
    const rows = graph.nodes.flatMap((node) =>
      node.elements
        .filter((element) => element.selector)
        .map((element) => ({
          pageId: node.pageId,
          pageName: node.semanticName ?? node.title ?? node.url ?? node.pageId,
          url: node.url,
          surface: node.surface,
          role: element.role,
          text: element.text,
          selector: element.selector,
          href: element.href,
          inputType: element.inputType,
          name: element.name,
          placeholder: element.placeholder,
          riskLevel: element.riskLevel,
          lastSeenAt: element.lastSeenAt
        }))
    );
    sendJson(res, 200, { elements: rows });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/uploads/app") {
    const body = await readBody(req);
    const project = String(body.project ?? defaultProject);
    const env = String(body.env ?? "test");
    const saved = await saveUploadedApp({
      project,
      env,
      filename: required(body.filename, "filename"),
      contentBase64: required(body.contentBase64, "contentBase64"),
      version: body.version ? String(body.version) : undefined
    });
    sendJson(res, 200, saved);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/cases") {
    const project = url.searchParams.get("project") ?? defaultProject;
    const env = url.searchParams.get("env") ?? "test";
    const data = await readWorkbenchCaseAssetStore();
    sendJson(res, 200, {
      project,
      env,
      caseAssetProject: data.project,
      cases: await Promise.all(data.cases.map((item) => normalizeWorkbenchCaseForResponse(item, project, env)))
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/cases/save") {
    const body = await readBody(req);
    const project = String(body.project ?? defaultProject);
    const result = await saveWorkbenchCase({
      project,
      caseId: required(body.caseId, "caseId"),
      patch: typeof body.patch === "object" && body.patch ? body.patch as Record<string, unknown> : {}
    });
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/cases/generate-dsl") {
    const body = await readBody(req);
    const project = String(body.project ?? defaultProject);
    const env = String(body.env ?? "test");
    const caseIds = Array.isArray(body.caseIds) ? body.caseIds.map(String) : [String(body.caseId ?? "")].filter(Boolean);
    const results: unknown[] = [];
    for (const caseId of caseIds) {
      let stages = workbenchCaseDslGenerationStageSkeleton();
      const createdAt = new Date().toISOString();
      const result = await generateWorkbenchCaseDsl({
        project,
        env,
        caseId,
        resumeFromStage: typeof body.resumeFromStage === "string" && body.resumeFromStage.trim()
          ? body.resumeFromStage.trim()
          : undefined,
        onStage: (stage) => {
          stages = updateWorkbenchCaseDslGenerationStages(stages, stage);
        }
      });
      await writeWorkbenchCaseDslGenerationSummary(buildWorkbenchCaseDslGenerationSummary({
        project,
        env,
        caseId,
        stages,
        result,
        createdAt
      }));
      results.push(result);
    }
    sendJson(res, 200, { project, env, results });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/cases/generate-dsl-stream") {
    const body = await readBody(req);
    const project = String(body.project ?? defaultProject);
    const env = String(body.env ?? "test");
    const caseIds = Array.isArray(body.caseIds) ? body.caseIds.map(String) : [String(body.caseId ?? "")].filter(Boolean);
    const runId = String(body.runId ?? crypto.randomUUID());
    const controller = new AbortController();
    caseDslGenerationControllers.set(runId, controller);
    req.on("close", () => controller.abort());
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive"
    });
    const sendEvent = (event: Record<string, unknown>) => {
      res.write(`data: ${JSON.stringify({ at: new Date().toISOString(), ...event })}\n\n`);
    };
    const heartbeat = setInterval(() => {
      sendEvent({ type: "heartbeat", status: "running", detail: "DSL 生成仍在进行中。" });
    }, 15_000);
    const results: unknown[] = [];
    try {
      sendEvent({ type: "batch", runId, status: "running", total: caseIds.length, completed: 0, detail: `开始生成 ${caseIds.length} 条用例 DSL。` });
      for (let index = 0; index < caseIds.length; index += 1) {
        const caseId = caseIds[index];
        let stages = workbenchCaseDslGenerationStageSkeleton();
        const createdAt = new Date().toISOString();
        if (controller.signal.aborted) {
          const result = caseDslGenerationCancelledResult(caseId, runId);
          await writeWorkbenchCaseDslGenerationSummary(buildWorkbenchCaseDslGenerationSummary({ project, env, caseId, runId, stages, result, createdAt }));
          results.push(result);
          sendEvent({ type: "case", caseId, index, total: caseIds.length, status: "cancelled", result: results[results.length - 1] });
          continue;
        }
        sendEvent({ type: "case", caseId, index, total: caseIds.length, status: "running", detail: "开始生成当前用例 DSL。" });
        const result = await generateWorkbenchCaseDsl({
          project,
          env,
          caseId,
          runId,
          resumeFromStage: typeof body.resumeFromStage === "string" && body.resumeFromStage.trim()
            ? body.resumeFromStage.trim()
            : body.resume === true
              ? "deepseek_intent_understanding"
              : undefined,
          abortSignal: controller.signal,
          onStage: (stage) => {
            stages = updateWorkbenchCaseDslGenerationStages(stages, stage);
            sendEvent({ type: "stage", caseId, index, total: caseIds.length, ...stage });
          }
        });
        results.push(result);
        const resultRecord = result as Record<string, unknown>;
        await writeWorkbenchCaseDslGenerationSummary(buildWorkbenchCaseDslGenerationSummary({ project, env, caseId, runId, stages, result: resultRecord, createdAt }));
        sendEvent({ type: "case", caseId, index, total: caseIds.length, status: resultRecord.ok && resultRecord.executable !== false ? "completed" : "failed", result });
        sendEvent({ type: "batch", runId, status: controller.signal.aborted ? "cancelled" : "running", total: caseIds.length, completed: index + 1, detail: controller.signal.aborted ? `已停止，完成 ${index + 1}/${caseIds.length}。` : `已完成 ${index + 1}/${caseIds.length}。` });
      }
      sendEvent({ type: "complete", result: { project, env, runId, results, cancelled: controller.signal.aborted } });
      clearInterval(heartbeat);
      res.end();
    } catch (error) {
      sendEvent({ type: "error", error: error instanceof Error ? error.message : String(error), results });
      clearInterval(heartbeat);
      res.end();
    } finally {
      caseDslGenerationControllers.delete(runId);
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/cases/generate-dsl-cancel") {
    const body = await readBody(req);
    const runId = String(body.runId ?? "");
    const controller = caseDslGenerationControllers.get(runId);
    if (!runId || !controller) {
      sendJson(res, 404, { ok: false, reason: "case_dsl_generation_run_not_found" });
      return;
    }
    controller.abort();
    sendJson(res, 200, { ok: true, runId, status: "cancelling" });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/project-knowledge-map") {
    const project = url.searchParams.get("project") ?? defaultProject;
    const data = await readProjectKnowledgeMapStore(project);
    sendJson(res, 200, data);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/cases/execute") {
    const body = await readBody(req);
    const project = String(body.project ?? defaultProject);
    const env = String(body.env ?? "test");
    const caseIds = Array.isArray(body.caseIds) ? body.caseIds.map(String) : [String(body.caseId ?? "")].filter(Boolean);
    const runId = String(body.runId ?? crypto.randomUUID());
    const controller = new AbortController();
    caseExecutionControllers.set(runId, controller);
    try {
      const results = caseIds.length > 1
        ? await executeWorkbenchCaseBatch({ project, env, caseIds, observationMode: Boolean(body.observationMode), runId, abortSignal: controller.signal })
        : await Promise.all(caseIds.map((caseId) => executeWorkbenchCase({ project, env, caseId, observationMode: Boolean(body.observationMode), runId, abortSignal: controller.signal })));
      sendJson(res, 200, { project, env, runId, results });
    } finally {
      caseExecutionControllers.delete(runId);
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/cases/execute-stream") {
    const body = await readBody(req);
    const project = String(body.project ?? defaultProject);
    const env = String(body.env ?? "test");
    const caseIds = Array.isArray(body.caseIds) ? body.caseIds.map(String) : [String(body.caseId ?? "")].filter(Boolean);
    const runId = String(body.runId ?? crypto.randomUUID());
    const controller = new AbortController();
    caseExecutionControllers.set(runId, controller);
    req.on("close", () => controller.abort());
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive"
    });
    const sendEvent = (event: Record<string, unknown>) => {
      res.write(`data: ${JSON.stringify({ at: new Date().toISOString(), ...event })}\n\n`);
    };
    const heartbeat = setInterval(() => {
      sendEvent({ type: "heartbeat", runId, status: "running", detail: "用例执行仍在进行中。" });
    }, 10_000);
    try {
      sendEvent({ type: "batch", runId, status: "running", total: caseIds.length, completed: 0, detail: `开始执行 ${caseIds.length} 条用例。` });
      const onStep = (caseId: string) => (event: Record<string, unknown>) => {
        sendEvent({ ...event, type: "step", stepEventType: event.type, caseId });
      };
      const results = caseIds.length > 1
        ? await executeWorkbenchCaseBatch({ project, env, caseIds, observationMode: Boolean(body.observationMode), runId, abortSignal: controller.signal, onStep })
        : await Promise.all(caseIds.map((caseId) => executeWorkbenchCase({ project, env, caseId, observationMode: Boolean(body.observationMode), runId, abortSignal: controller.signal, onStep: onStep(caseId) })));
      sendEvent({ type: "complete", result: { project, env, runId, results, cancelled: controller.signal.aborted } });
      clearInterval(heartbeat);
      res.end();
    } catch (error) {
      sendEvent({ type: "error", error: error instanceof Error ? error.message : String(error) });
      clearInterval(heartbeat);
      res.end();
    } finally {
      caseExecutionControllers.delete(runId);
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/cases/execute-cancel") {
    const body = await readBody(req);
    const runId = String(body.runId ?? "");
    const controller = caseExecutionControllers.get(runId);
    if (!runId || !controller) {
      sendJson(res, 404, { ok: false, reason: "case_execution_run_not_found" });
      return;
    }
    controller.abort();
    sendJson(res, 200, { ok: true, runId, status: "cancelling" });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/assistant/plan") {
    const body = await readBody(req);
    const project = String(body.project ?? defaultProject);
    const message = required(body.message, "message");
    const env = resolveAssistantEnv(String(body.env ?? "test"), message);
    const observationMode = Boolean(body.observationMode);
    const pageModelDeepSeekIntent = await tryUnderstandPageModelIntentWithDeepSeek({ project, env, message });
    const intentBlockReason = deepSeekIntentUnderstandingBlockReason(pageModelDeepSeekIntent);
    if (intentBlockReason) {
      sendJson(res, 200, {
        usedModel: "deepseek",
        trace: [
          { step: "AI 意图理解", status: pageModelDeepSeekIntent.status, detail: intentBlockReason },
          { step: "项目知识检索", status: "blocked", detail: "AI 意图理解未完成，平台不使用本地关键词规则继续物化 DSL。" },
          { step: "DSL 契约校验", status: "blocked", detail: "未生成 DSL。" }
        ],
        plan: blockedDeepSeekIntentPlan(message, intentBlockReason, pageModelDeepSeekIntent),
        knowledgeHits: []
      });
      return;
    }
    const pageModelRoute = await planAssistantRequestWithPageModels({ rootDir, project, env, message, deepSeekIntent: pageModelDeepSeekIntent.parsedOutput });
    if (pageModelRoute.route === "page_model") {
      const pageModelPlan = summarizePageModelRouteForResponse(pageModelRoute.plan);
      const pageModelDeepSeek = await tryBuildDeepSeekPageModelDslAdvisor({
        project,
        env,
        message,
        initialUnderstanding: pageModelDeepSeekIntent.parsedOutput,
        planningContext: pageModelRoute.plan.planningContext,
        plan: pageModelRoute.plan,
        planSummary: pageModelPlan,
        localDslValidation: pageModelRoute.plan.materialization.dslValidation
      });
      const pageModelTraceSteps = pageModelAutomationTraceSteps(pageModelPlan);
      sendJson(res, 200, {
        usedModel: pageModelDeepSeek.status === "completed" ? pageModelDeepSeek.model : "page-model-local",
        trace: [
          { step: "AI 意图理解", status: pageModelDeepSeekIntent.status, detail: pageModelDeepSeekIntent.error ?? "AI returned a structured intent draft." },
          { step: "项目知识检索", status: "completed", detail: pageModelRoute.chineseMessage },
          { step: "AI 压缩审查", status: pageModelDeepSeek.status, detail: pageModelDeepSeek.error ?? "AI reviewed the materialized DSL with compressed context." },
          { step: "生成内容可信度校验", status: pageModelRoute.plan.intentContract.passed ? "completed" : "blocked", detail: pageModelRoute.plan.intentContract.passed ? (pageModelRoute.plan.intentContract.warningGaps?.join(", ") || "Grounded contract validation passed.") : pageModelRoute.plan.intentContract.blockingGaps.join(", ") },
          {
            step: "DSL 契约校验",
            status: pageModelRoute.canExecute ? "completed" : "blocked",
            detail: pageModelRoute.canExecute ? "Page Model 证据充足，可以执行。" : formatLocalizedPageModelGaps(pageModelRoute.plan.gaps)
          },
          ...pageModelTraceSteps
        ],
        plan: {
          intent: `${pageModelRoute.plan.selection.intent.module}.${pageModelRoute.plan.selection.intent.action}`,
          intentSpec: pageModelRoute.plan.selection.intent,
          source: "page_model",
          executable: pageModelRoute.plan.executable,
          readiness: pageModelRoute.plan.readiness,
          gaps: pageModelRoute.plan.gaps,
          blockingGaps: pageModelRoute.plan.blockingGaps,
          recommendedNextAction: pageModelRoute.plan.recommendedNextAction,
          requiresConfirmation: false,
          pageModelDeepSeekIntent,
          pageModelDeepSeek,
          aiIntent: pageModelDeepSeekIntent,
          aiDslAdvisor: pageModelDeepSeek,
          pageModelExecutionPlan: pageModelPlan,
          steps: pageModelPlan.automationCase
        },
        knowledgeHits: []
      });
      return;
    }
    sendJson(res, 200, {
      usedModel: "page-model-local",
      trace: [{ stage: "Page Model Store", status: "blocked", message: pageModelRoute.reason }],
      plan: {
        intent: message,
        source: "page_model",
        executable: false,
        readiness: "missing",
        gaps: ["missing_page_model_store"],
        blockingGaps: ["missing_page_model_store"],
        recommendedNextAction: "model_page_first",
        requiresConfirmation: false,
        pageModelUnavailableReason: pageModelRoute.reason,
        steps: { stepCount: 0, steps: [] }
      },
      knowledgeHits: []
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/assistant/plan-stream") {
    const body = await readBody(req);
    const project = String(body.project ?? defaultProject);
    const message = required(body.message, "message");
    const env = resolveAssistantEnv(String(body.env ?? "test"), message);
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive"
    });
    const sendEvent = (event: Record<string, unknown>) => {
      res.write(`data: ${JSON.stringify({ at: new Date().toISOString(), ...event })}\n\n`);
    };
    try {
      sendEvent({ type: "stage", id: "load_project_knowledge", title: "加载项目知识", status: "running", detail: "确认当前 project/env 的 Page Model 与 Operation Manual 入口。" });
      sendEvent({ type: "stage", id: "load_project_knowledge", title: "加载项目知识", status: "completed", detail: `当前项目：${project}，环境：${env}。` });
      sendEvent({ type: "stage", id: "deepseek_intent_understanding", title: "AI 意图理解", status: "running", detail: "调用 AI 解析自然语言意图。" });
      const pageModelDeepSeekIntent = await tryUnderstandPageModelIntentWithDeepSeek({ project, env, message });
      const intentBlockReason = deepSeekIntentUnderstandingBlockReason(pageModelDeepSeekIntent);
      sendEvent({ type: "stage", id: "deepseek_intent_understanding", title: "AI 意图理解", status: intentBlockReason ? "failed" : "completed", detail: intentBlockReason ?? "AI 已返回结构化意图。" });
      if (intentBlockReason) {
        sendEvent({ type: "stage", id: "project_knowledge_retrieval", title: "项目知识检索", status: "skipped", detail: "AI 意图理解未完成，平台不使用本地关键词规则继续物化 DSL。" });
        sendEvent({ type: "stage", id: "dsl_materialization", title: "DSL 物化", status: "skipped", detail: "未生成 DSL。" });
        sendEvent({ type: "stage", id: "deepseek_grounded_advisory", title: "AI 压缩审查", status: "skipped", detail: "第一轮意图理解已阻断。" });
        sendEvent({ type: "stage", id: "grounded_contract_validation", title: "生成内容可信度校验", status: "skipped", detail: "未生成内容。" });
        sendEvent({ type: "stage", id: "dsl_contract_validation", title: "DSL 契约校验", status: "skipped", detail: "未生成 DSL。" });
        sendEvent({
          type: "complete",
          result: {
            usedModel: "deepseek",
            trace: [
              { step: "AI 意图理解", status: pageModelDeepSeekIntent.status, detail: intentBlockReason },
              { step: "项目知识检索", status: "blocked", detail: "AI 意图理解未完成，平台不使用本地关键词规则继续物化 DSL。" },
              { step: "DSL 契约校验", status: "blocked", detail: "未生成 DSL。" }
            ],
            plan: blockedDeepSeekIntentPlan(message, intentBlockReason, pageModelDeepSeekIntent),
            knowledgeHits: []
          }
        });
        return;
      }

      sendEvent({ type: "stage", id: "project_knowledge_retrieval", title: "项目知识检索", status: "running", detail: "按当前项目检索目标页面、模块能力和操作边界。" });
      const pageModelRoute = await planAssistantRequestWithPageModels({ rootDir, project, env, message, deepSeekIntent: pageModelDeepSeekIntent.parsedOutput });
      sendEvent({ type: "stage", id: "project_knowledge_retrieval", title: "项目知识检索", status: pageModelRoute.route === "page_model" ? "completed" : "failed", detail: pageModelRoute.route === "page_model" ? pageModelRoute.chineseMessage : pageModelRoute.reason });

      if (pageModelRoute.route === "page_model") {
        const planningContext = pageModelRoute.plan.planningContext as Record<string, unknown> | undefined;
        const pageModelContext = planningContext?.retrievedPageModelContext as Record<string, unknown> | undefined;
        const manualContext = planningContext?.retrievedOperationManualContext as Record<string, unknown> | undefined;
        const selectedPageCount = Array.isArray(pageModelContext?.targetPages) ? pageModelContext.targetPages.length : 0;
        const selectedElementCount = Array.isArray(pageModelContext?.executableElements) ? pageModelContext.executableElements.length : 0;
        const selectedAssertionCount = Array.isArray(pageModelContext?.assertions) ? pageModelContext.assertions.length : 0;
        const manualCount = Array.isArray(manualContext?.manuals) ? manualContext.manuals.length : 0;
        const capabilityCount = Array.isArray(manualContext?.capabilities) ? manualContext.capabilities.length : 0;
        sendEvent({ type: "stage", id: "dsl_materialization", title: "DSL 物化", status: pageModelRoute.plan.gaps.length ? "failed" : "completed", detail: `命中页面 ${selectedPageCount} 个、操作手册 ${manualCount} 个、能力 ${capabilityCount} 个；物化元素 ${selectedElementCount} 个、断言 ${selectedAssertionCount} 个；gap ${pageModelRoute.plan.gaps.length} 个。` });
        const pageModelPlan = summarizePageModelRouteForResponse(pageModelRoute.plan);
        sendEvent({ type: "stage", id: "deepseek_grounded_advisory", title: "AI 压缩审查", status: "running", detail: "把本地已物化 DSL 和最小证据集交给 AI 做非阻断审查。" });
        const pageModelDeepSeek = await tryBuildDeepSeekPageModelDslAdvisor({
          project,
          env,
          message,
          initialUnderstanding: pageModelDeepSeekIntent.parsedOutput,
          planningContext: pageModelRoute.plan.planningContext,
          plan: pageModelRoute.plan,
          planSummary: pageModelPlan,
          localDslValidation: pageModelRoute.plan.materialization.dslValidation
        });
        sendEvent({ type: "stage", id: "deepseek_grounded_advisory", title: "AI 压缩审查", status: pageModelDeepSeek.status === "completed" ? "completed" : pageModelDeepSeek.status === "skipped" ? "skipped" : "warning", detail: pageModelDeepSeek.error ?? "AI 已完成压缩上下文 DSL 审查；该阶段不阻断写入。" });

        sendEvent({ type: "stage", id: "grounded_contract_validation", title: "生成内容可信度校验", status: "running", detail: "校验生成内容是否引用真实 Page Model / Operation Manual / Provider 知识。" });
        const pageModelTraceSteps = pageModelAutomationTraceSteps(pageModelPlan);
        const trace = [
          { step: "AI 意图理解", status: pageModelDeepSeekIntent.status, detail: pageModelDeepSeekIntent.error ?? "AI returned a structured intent draft." },
          { step: "项目知识检索", status: "completed", detail: pageModelRoute.chineseMessage },
          { step: "AI 压缩审查", status: pageModelDeepSeek.status, detail: pageModelDeepSeek.error ?? "AI reviewed the materialized DSL with compressed context." },
          { step: "生成内容可信度校验", status: pageModelRoute.plan.intentContract.passed ? "completed" : "blocked", detail: pageModelRoute.plan.intentContract.passed ? (pageModelRoute.plan.intentContract.warningGaps?.join(", ") || "Grounded contract validation passed.") : pageModelRoute.plan.intentContract.blockingGaps.join(", ") },
          {
            step: "DSL 契约校验",
            status: pageModelRoute.canExecute ? "completed" : "blocked",
            detail: pageModelRoute.canExecute ? "Page Model 证据充足，可以执行。" : formatLocalizedPageModelGaps(pageModelRoute.plan.gaps)
          },
          ...pageModelTraceSteps
        ];
        sendEvent({ type: "stage", id: "grounded_contract_validation", title: "生成内容可信度校验", status: pageModelRoute.plan.intentContract.passed ? (pageModelRoute.plan.intentContract.warningGaps?.length ? "warning" : "completed") : "failed", detail: pageModelRoute.plan.intentContract.passed ? (pageModelRoute.plan.intentContract.warningGaps?.join(", ") || "可信度校验通过。") : pageModelRoute.plan.intentContract.blockingGaps.join(", ") });
        sendEvent({ type: "stage", id: "dsl_contract_validation", title: "DSL 契约校验", status: pageModelRoute.canExecute ? "completed" : "failed", detail: pageModelRoute.canExecute ? "Page Model 证据充足，可以执行。" : formatLocalizedPageModelGaps(pageModelRoute.plan.gaps) });
        sendEvent({
          type: "complete",
          result: {
            usedModel: pageModelDeepSeek.status === "completed" ? pageModelDeepSeek.model : "page-model-local",
            trace,
            plan: {
              intent: `${pageModelRoute.plan.selection.intent.module}.${pageModelRoute.plan.selection.intent.action}`,
              intentSpec: pageModelRoute.plan.selection.intent,
              source: "page_model",
              executable: pageModelRoute.plan.executable,
              readiness: pageModelRoute.plan.readiness,
              gaps: pageModelRoute.plan.gaps,
              blockingGaps: pageModelRoute.plan.blockingGaps,
              recommendedNextAction: pageModelRoute.plan.recommendedNextAction,
              requiresConfirmation: false,
              pageModelDeepSeekIntent,
              pageModelDeepSeek,
              aiIntent: pageModelDeepSeekIntent,
              aiDslAdvisor: pageModelDeepSeek,
              pageModelExecutionPlan: pageModelPlan,
              steps: pageModelPlan.automationCase
            },
            knowledgeHits: []
          }
        });
        res.end();
        return;
      }
      sendEvent({ type: "complete", result: { usedModel: "page-model-local", trace: [{ stage: "Page Model Store", status: "blocked", message: pageModelRoute.reason }], plan: { intent: message, source: "page_model", executable: false, readiness: "missing", gaps: ["missing_page_model_store"], blockingGaps: ["missing_page_model_store"], recommendedNextAction: "model_page_first", requiresConfirmation: false, pageModelUnavailableReason: pageModelRoute.reason, steps: { stepCount: 0, steps: [] } }, knowledgeHits: [] } });
      res.end();
    } catch (error) {
      sendEvent({ type: "error", error: error instanceof Error ? error.message : String(error) });
      res.end();
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/assistant/execute") {
    const body = await readBody(req);
    const project = String(body.project ?? defaultProject);
    const plan = body.plan && typeof body.plan === "object" ? (body.plan as Record<string, unknown>) : {};
    const message = String(body.message ?? plan.intent ?? "");
    const env = resolveAssistantEnv(String(body.env ?? "test"), message);
    const observationMode = Boolean(body.observationMode);
    const executionRequestId = String(body.executionRequestId ?? crypto.randomUUID());
    const executionAbortController = new AbortController();
    assistantExecutionControllers.set(executionRequestId, executionAbortController);
    logger.info("Assistant execution requested", {
      project,
      env,
      intent: plan.intent,
      account: plan.account,
      requiresConfirmation: Boolean(plan.requiresConfirmation),
      confirmWrite: Boolean(body.confirmWrite)
    });
    const assistantContext = await loadContext({ project, env });
    const pageModelDeepSeekIntent = await tryUnderstandPageModelIntentWithDeepSeek({ project, env, message });
    const intentBlockReason = deepSeekIntentUnderstandingBlockReason(pageModelDeepSeekIntent);
    if (intentBlockReason) {
      const failure = await recordAssistantPlanningFailure(assistantContext, {
        project,
        env,
        message,
        plan: blockedDeepSeekIntentPlan(message, intentBlockReason, pageModelDeepSeekIntent),
        automation: { source: "none", reason: intentBlockReason },
        readiness: "blocked",
        blockedStage: "planner"
      });
      sendJson(res, 200, {
        exitCode: 2,
        stdout: [
          intentBlockReason,
          "AI 意图理解未完成，平台不使用本地关键词规则继续物化 DSL。",
          `failurePackage=${failure.packagePath}`,
          `failurePrompt=${failure.promptPath}`,
          failure.proposalPath ? `proposal=${failure.proposalPath}` : ""
        ].filter(Boolean).join("\n"),
        stderr: intentBlockReason,
        runId: failure.runId,
        failurePackagePath: failure.packagePath,
        failurePromptPath: failure.promptPath,
        proposalPath: failure.proposalPath
      });
      return;
    }
    const pageModelRoute = await planAssistantRequestWithPageModels({ rootDir, project, env, message, deepSeekIntent: pageModelDeepSeekIntent.parsedOutput });
    if (pageModelRoute.route === "page_model") {
      const pageModelPlan = summarizePageModelRouteForResponse(pageModelRoute.plan);
      const pageModelDeepSeek = await tryBuildDeepSeekPageModelDslAdvisor({
        project,
        env,
        message,
        initialUnderstanding: pageModelDeepSeekIntent.parsedOutput,
        planningContext: pageModelRoute.plan.planningContext,
        plan: pageModelRoute.plan,
        planSummary: pageModelPlan,
        localDslValidation: pageModelRoute.plan.materialization.dslValidation
      });
      logger.info("Assistant execution routed through Page Model Store", {
        project,
        env,
        intent: pageModelRoute.plan.selection.intent,
        readiness: pageModelRoute.plan.readiness,
        executable: pageModelRoute.plan.executable,
        gaps: pageModelRoute.plan.gaps,
        stepCount: pageModelRoute.plan.materialization.case.steps.length
      });
      if (!pageModelRoute.canExecute) {
        const automation: AssistantAutomationBuildResult = {
          source: "page_model",
          reason: pageModelRoute.chineseMessage,
          testCase: pageModelRoute.plan.materialization.case
        };
        const failure = await recordAssistantPlanningFailure(assistantContext, {
          project,
          env,
          message,
          plan: {
            ...plan,
            pageModelDeepSeekIntent,
            pageModelDeepSeek,
            aiIntent: pageModelDeepSeekIntent,
            aiDslAdvisor: pageModelDeepSeek,
            pageModelExecutionPlan: pageModelPlan
          },
          automation,
          readiness: pageModelRoute.plan.readiness,
          blockedStage: "coverage"
        });
        sendJson(res, 200, {
          exitCode: 2,
          stdout: [
            pageModelRoute.chineseMessage,
            `failurePackage=${failure.packagePath}`,
            `failurePrompt=${failure.promptPath}`,
            failure.proposalPath ? `proposal=${failure.proposalPath}` : "",
            failure.caseRunPath ? `caseRun=${failure.caseRunPath}` : ""
          ].filter(Boolean).join("\n"),
          stderr: pageModelRoute.chineseMessage,
          runId: failure.runId,
          failurePackagePath: failure.packagePath,
          failurePromptPath: failure.promptPath,
          proposalPath: failure.proposalPath,
          caseRunPath: failure.caseRunPath,
          pageModelPlan: summarizePageModelRouteForResponse(pageModelRoute.plan)
        });
        assistantExecutionControllers.delete(executionRequestId);
        return;
      }
      const result = await executeAssistantAutomationTask(assistantContext, {
        project,
        env,
        message,
        plan: {
          ...plan,
          pageModelDeepSeekIntent,
          pageModelDeepSeek,
          aiIntent: pageModelDeepSeekIntent,
          aiDslAdvisor: pageModelDeepSeek,
          pageModelExecutionPlan: pageModelPlan
        },
        testCase: pageModelRoute.plan.materialization.case,
        source: "page_model",
        abortSignal: executionAbortController.signal,
        observationMode
      });
      assistantExecutionControllers.delete(executionRequestId);
      sendJson(res, 200, {
        ...result,
        executionRequestId,
        pageModelPlan,
        aiIntent: pageModelDeepSeekIntent,
        aiDslAdvisor: pageModelDeepSeek,
        pageModelDeepSeekIntent,
        pageModelDeepSeek
      });
      return;
    }
    assistantExecutionControllers.delete(executionRequestId);
    const unavailableAutomation: AssistantAutomationBuildResult = {
      source: "page_model",
      reason: pageModelRoute.reason
    };
    const unavailableFailure = await recordAssistantPlanningFailure(assistantContext, {
      project,
      env,
      message,
      plan: {
        ...plan,
        pageModelUnavailableReason: pageModelRoute.reason,
        gaps: ["missing_page_model_store"]
      },
      automation: unavailableAutomation,
      readiness: "missing_page_model_store",
      blockedStage: "coverage"
    });
    sendJson(res, 200, {
      exitCode: 2,
      stdout: [
        pageModelRoute.reason,
        `failurePackage=${unavailableFailure.packagePath}`,
        `failurePrompt=${unavailableFailure.promptPath}`,
        unavailableFailure.proposalPath ? `proposal=${unavailableFailure.proposalPath}` : "",
        unavailableFailure.caseRunPath ? `caseRun=${unavailableFailure.caseRunPath}` : ""
      ].filter(Boolean).join("\n"),
      stderr: pageModelRoute.reason,
      runId: unavailableFailure.runId,
      failurePackagePath: unavailableFailure.packagePath,
      failurePromptPath: unavailableFailure.promptPath,
      proposalPath: unavailableFailure.proposalPath,
      caseRunPath: unavailableFailure.caseRunPath
    });
    return;
    if (Boolean(plan.requiresConfirmation) && !Boolean(body.confirmWrite)) {
      logger.warn("Assistant execution paused for confirmation", { project, env, intent: plan.intent });
      sendJson(res, 200, {
        exitCode: 1,
        stdout: "",
        stderr: "This plan requires confirmation before execution. 当前计划包含写操作或不确定前置条件，暂不自动执行。"
      });
      return;
    }
    const automation = await buildAssistantAutomationCase(assistantContext, { project, env, message, plan });
    logger.info("Assistant execution route decision", {
      project,
      env,
      intent: plan.intent,
      messagePreview: message.slice(0, 200),
      requiresConfirmation: Boolean(plan.requiresConfirmation),
      confirmWrite: Boolean(body.confirmWrite),
      isRegistrationInput: isRegistrationInputIntent(message, plan),
      isWriteIntent: isWriteIntentMessage(message),
      automationSource: automation.source,
      automationCaseId: automation.testCase?.id,
      automationStepCount: automation.testCase?.steps.length ?? 0,
      automationAssertionCount: automation.testCase?.assertions.length ?? 0,
      automationReason: automation.reason
    });
    if (automation.testCase) {
      const automationTestCase = automation.testCase as AutomationCase;
      const preflight = validateAssistantExecutionPreflight(message, plan);
      if (!preflight.ok) {
        const preflightFailure = preflight as { ok: false; reason: string };
        const preflightReason = preflightFailure.reason;
        const readiness = `preflight=${preflightReason}`;
        const failure = await recordAssistantPlanningFailure(assistantContext, {
          project,
          env,
          message,
          plan,
          automation: { ...automation, reason: preflightReason, testCase: automationTestCase },
          readiness,
          blockedStage: "preflight"
        });
        sendJson(res, 200, {
          exitCode: 2,
          stdout: [
            preflightReason,
            `failurePackage=${failure.packagePath}`,
            `failurePrompt=${failure.promptPath}`,
            failure.proposalPath ? `proposal=${failure.proposalPath}` : "",
            failure.caseRunPath ? `caseRun=${failure.caseRunPath}` : ""
          ].filter(Boolean).join("\n"),
          runId: failure.runId,
          failurePackagePath: failure.packagePath,
          failurePromptPath: failure.promptPath,
          proposalPath: failure.proposalPath,
          caseRunPath: failure.caseRunPath,
          stderr: preflightReason
        });
        return;
      }
      const result = await executeAssistantAutomationTask(assistantContext, { project, env, message, plan, testCase: automationTestCase, source: automation.source });
      logger.info("Assistant automation execution response", {
        project,
        env,
        source: automation.source,
        caseId: automationTestCase.id,
        exitCode: result.exitCode,
        runId: result.runId,
        stdoutPreview: result.stdout.slice(0, 500),
        stderrPreview: result.stderr.slice(0, 500)
      });
      sendJson(res, 200, result);
      return;
    }
    if (isRegistrationInputIntent(message, plan)) {
      const context = await loadContext({ project, env });
      const result = await executeRegistrationInputTask(
        context.env.web?.baseUrl,
        extractInputText(message, plan) ?? "admin123"
      );
      sendJson(res, 200, result);
      return;
    }
    if (Boolean(plan.requiresConfirmation) || isWriteIntentMessage(message)) {
      const readiness = await buildAssistantWriteReadiness(assistantContext, message, automation.reason);
      const failure = await recordAssistantPlanningFailure(assistantContext, { project, env, message, plan, automation, readiness, blockedStage: "coverage" });
      logger.warn("Assistant execution blocked because no executable automation case was built", {
        project,
        env,
        intent: plan.intent,
        reason: automation.reason,
        runId: failure.runId,
        failurePackagePath: failure.packagePath
      });
      sendJson(res, 200, {
        exitCode: 2,
        stdout: [
          automation.reason,
          readiness,
          `failurePackage=${failure.packagePath}`,
          `failurePrompt=${failure.promptPath}`,
          failure.proposalPath ? `proposal=${failure.proposalPath}` : "",
          failure.caseRunPath ? `caseRun=${failure.caseRunPath}` : ""
        ].filter(Boolean).join("\n"),
        runId: failure.runId,
        failurePackagePath: failure.packagePath,
        failurePromptPath: failure.promptPath,
        proposalPath: failure.proposalPath,
        caseRunPath: failure.caseRunPath,
        stderr:
          "写操作已被安全阻断：当前 AI 助手还没有把自然语言计划转换为可执行 AutomationCase 并接入 DslExecutor 的完整写操作链路。"
      });
      return;
    }
    const context = await loadContext({ project, env });
    const entryUrl = extractAssistantEntryUrl(plan) || context.env.web?.baseUrl;
    if (!entryUrl) {
      sendJson(res, 200, { exitCode: 1, stdout: "", stderr: "No executable entry URL found in plan or environment." });
      return;
    }
    const entryUrlValue: string = String(entryUrl);
    const holdSeconds = extractHoldSeconds(String(plan.intent ?? body.message ?? "")) || 60;
    await new AccountStore(context).seedDefaults();
    const account = chooseAccount(String(plan.intent ?? body.message ?? ""), await new AccountStore(context).list({ project, env }));
    const args: string[] = [
      "run",
      "explore:web",
      "--",
      "--project",
      project,
      "--env",
      env,
      "--url",
      entryUrlValue,
      "--max-depth",
      "0",
      "--max-pages",
      "1",
      "--surface",
      "site",
      "--login-required",
      "true",
      "--headed"
    ];
    const accountRecord = account as Record<string, string | undefined> | undefined;
    const username = accountRecord?.username;
    const password = accountRecord?.password;
    if (typeof username === "string" && typeof password === "string") args.push("--username", username!, "--password", password!);
    if (holdSeconds > 0) args.push("--hold-seconds", String(holdSeconds));
    const result = await runCommand("npm", args);
    logger.info("Assistant execution command finished", { project, env, exitCode: result.exitCode });
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/assistant/execution-cancel") {
    const body = await readBody(req);
    const executionRequestId = String(body.executionRequestId ?? "");
    const controller = assistantExecutionControllers.get(executionRequestId);
    if (!executionRequestId || !controller) {
      sendJson(res, 404, { ok: false, reason: "execution_request_not_found" });
      return;
    }
    controller.abort();
    assistantExecutionControllers.delete(executionRequestId);
    sendJson(res, 200, { ok: true, executionRequestId });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/actions/run-tests") {
    const body = await readBody(req);
    const args = ["run", "test", "--", "--project", String(body.project ?? defaultProject), "--env", String(body.env ?? "test")];
    if (body.tags) args.push("--tags", String(body.tags));
    if (body.type) args.push("--type", String(body.type));
    if (body.caseId) args.push("--case", String(body.caseId));
    if (body.mode) args.push("--mode", String(body.mode));
    if (body.maxAiCalls) args.push("--max-ai-calls", String(body.maxAiCalls));
    if (body.maxAiTokens) args.push("--max-ai-tokens", String(body.maxAiTokens));
    if (body.maxEstimatedCost) args.push("--max-estimated-cost", String(body.maxEstimatedCost));
    if (body.maxStepHealingLevel) args.push("--max-step-healing-level", String(body.maxStepHealingLevel));
    if (body.dryRun) args.push("--dry-run");
    sendJson(res, 200, await runCommand("npm", args));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/actions/bootstrap-scan") {
    const body = await readBody(req);
    const project = String(body.project ?? defaultProject);
    const env = String(body.env ?? "test");
    const startUrl = String(body.startUrl ?? "");
    const args = [
      "run",
      "bootstrap:scan",
      "--",
      "--project",
      project,
      "--env",
      env,
      "--platform",
      String(body.platform ?? "web")
    ];
    if (startUrl) args.push("--start-url", startUrl);
    if (body.targetFlows) args.push("--target-flows", String(body.targetFlows));
    if (body.maxPages) args.push("--max-pages", String(body.maxPages));
    if (body.maxDepth) args.push("--max-depth", String(body.maxDepth));
    if (body.maxPaths) args.push("--max-paths", String(body.maxPaths));
    if (body.maxDurationMs) args.push("--max-duration-ms", String(body.maxDurationMs));
    if (body.allowedDomains) args.push("--allowed-domains", String(body.allowedDomains));
    if (body.deniedPatterns) args.push("--denied-patterns", String(body.deniedPatterns));
    if (body.deniedActions) args.push("--denied-actions", String(body.deniedActions));
    if (body.maxAiCalls) args.push("--max-ai-calls", String(body.maxAiCalls));
    if (body.maxAiTokens) args.push("--max-ai-tokens", String(body.maxAiTokens));
    if (body.headed) args.push("--headed");
    if (body.allowActions) args.push("--allow-actions");
    if (body.loginRequired) args.push("--login-required");
    if (body.username) args.push("--username", String(body.username));
    if (body.password) args.push("--password", String(body.password));
    if (body.preflight) args.push("--preflight");
    sendJson(res, 200, await runCommand("npm", args));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/bootstrap-scans/replay") {
    const body = await readBody(req);
    const context = await loadContext({ project: String(body.project ?? defaultProject), env: String(body.env ?? "test") });
    sendJson(res, 200, await new BootstrapScanner(context).replay(required(body.scanId, "scanId")));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/bootstrap-scans/approve") {
    const body = await readBody(req);
    const context = await loadContext({ project: String(body.project ?? defaultProject), env: String(body.env ?? "test") });
    const scanId = required(body.scanId, "scanId");
    await new BootstrapScanStore(context).markReviewStatus(scanId, "approved");
    sendJson(res, 200, { scanId, approved: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/bootstrap-scans/promote") {
    const body = await readBody(req);
    const context = await loadContext({ project: String(body.project ?? defaultProject), env: String(body.env ?? "test") });
    sendJson(res, 200, await new BootstrapScanner(context).promote(required(body.scanId, "scanId")));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/bootstrap-scans/import-review") {
    const body = await readBody(req);
    const context = await loadContext({ project: String(body.project ?? defaultProject), env: String(body.env ?? "test") });
    const rawText = body.rawText ? String(body.rawText) : body.filePath ? await fs.readFile(String(body.filePath), "utf8") : "";
    sendJson(
      res,
      200,
      await new BootstrapScanner(context).importCodexReviewResult({
        scanId: required(body.scanId, "scanId"),
        rawText,
        filePath: body.filePath ? String(body.filePath) : undefined
      })
    );
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/actions/explore-web") {
    const body = await readBody(req);
    const args = [
      "run",
      "explore:web",
      "--",
      "--project",
      String(body.project ?? defaultProject),
      "--env",
      String(body.env ?? "test"),
      "--url",
      required(body.url, "url")
    ];
    if (body.maxDepth) args.push("--max-depth", String(body.maxDepth));
    if (body.maxPages) args.push("--max-pages", String(body.maxPages));
    if (body.maxButtonClicksPerPage) args.push("--max-button-clicks-per-page", String(body.maxButtonClicksPerPage));
    if (body.surface) args.push("--surface", String(body.surface));
    if (body.loginRequired !== undefined) args.push("--login-required", String(Boolean(body.loginRequired)));
    if (body.username) args.push("--username", String(body.username));
    if (body.password) args.push("--password", String(body.password));
    if (body.clickButtons) args.push("--click-buttons");
    if (body.headed) args.push("--headed");
    if (body.username && body.password) {
      const context = await loadContext({ project: String(body.project ?? defaultProject), env: String(body.env ?? "test") });
      await new AccountStore(context).upsert({
        project: String(body.project ?? defaultProject),
        env: String(body.env ?? "test"),
        username: String(body.username),
        password: String(body.password)
      });
    }
    const result = await runManagedWebExplore("npm", args);
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/actions/stop-web-explore") {
    if (!runningWebExplore) {
      sendJson(res, 200, { stopped: false, message: "No web exploration is running." });
      return;
    }
    const pid = runningWebExplore.child.pid;
    stopChildTree(runningWebExplore.child);
    logger.warn("Web exploration stop requested", { pid, startedAt: runningWebExplore.startedAt });
    sendJson(res, 200, { stopped: true, pid });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/actions/explore-app") {
    const body = await readBody(req);
    const args = [
      "run",
      "explore:app",
      "--",
      "--project",
      String(body.project ?? defaultProject),
      "--env",
      String(body.env ?? "test"),
      "--app-package",
      required(body.appPackage, "appPackage")
    ];
    if (body.apk) args.push("--apk", String(body.apk));
    if (body.appActivity) args.push("--app-activity", String(body.appActivity));
    if (body.deviceId) args.push("--device-id", String(body.deviceId));
    if (body.maxDepth) args.push("--max-depth", String(body.maxDepth));
    if (body.maxPages) args.push("--max-pages", String(body.maxPages));
    const result = await runCommand("npm", args);
    await appendAppExplorationHistory({
      project: String(body.project ?? defaultProject),
      env: String(body.env ?? "test"),
      apkPath: body.apk ? String(body.apk) : undefined,
      appPackage: required(body.appPackage, "appPackage"),
      appActivity: body.appActivity ? String(body.appActivity) : undefined,
      deviceId: body.deviceId ? String(body.deviceId) : undefined,
      maxDepth: body.maxDepth ? Number(body.maxDepth) : undefined,
      maxPages: body.maxPages ? Number(body.maxPages) : undefined,
      exitCode: result.exitCode
    });
    sendJson(res, 200, result);
    return;
  }

  sendJson(res, 404, { error: "API not found" });
}

function parseLines(value: string): string[] {
  return [...new Set(value.split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean))].sort();
}

function parseApiEndpointLines(value: string): EnvironmentDiscovery["apiEndpoints"] {
  const now = new Date().toISOString();
  return parseLines(value).flatMap((line) => {
    const match = line.match(/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(.+)$/i);
    const method = match?.[1]?.toUpperCase();
    const rawUrl = match?.[2] ?? line;
    try {
      const parsed = new URL(rawUrl);
      return [
        {
          method,
          url: `${parsed.origin}${parsed.pathname}`,
          domain: parsed.hostname,
          path: parsed.pathname,
          source: "manual" as const,
          lastSeenAt: now
        }
      ];
    } catch {
      return [];
    }
  });
}

interface AppArchiveHistory {
  project: string;
  env: string;
  apps: Array<{
    id: string;
    filename: string;
    version?: string;
    filePath: string;
    sizeBytes: number;
    sha256: string;
    uploadedAt: string;
  }>;
  explorations: Array<{
    exploredAt: string;
    apkPath?: string;
    appPackage: string;
    appActivity?: string;
    deviceId?: string;
    maxDepth?: number;
    maxPages?: number;
    exitCode: number | null;
  }>;
}

interface AssistantTraceItem {
  step: string;
  status: "running" | "completed" | "failed" | "needs_confirmation";
  detail: string;
  at: string;
}

interface AssistantPlanStep {
  action: string;
  target?: string;
  value?: unknown;
  source?: string;
  riskLevel?: "low" | "medium" | "high";
  reason?: string;
}

interface AssistantIntentSpec {
  schemaVersion: "intent.v1";
  rawRequest: string;
  project: string;
  env: string;
  language: string;
  module: string;
  submodule?: string;
  action: string;
  operationType: "read" | "write" | "unknown";
  targetPage?: {
    name?: string;
    urlHint?: string;
  };
  entities: Record<string, unknown>;
  preconditions: Array<{
    name: string;
    required: boolean;
    status: "known" | "required" | "unknown" | "missing";
    source?: string;
    evidence?: string;
  }>;
  expectedOutcome: string[];
  retrievalQueries: string[];
  recommendedAutomationLayer: "web-ui" | "api" | "hybrid" | "manual";
  riskLevel: "low" | "medium" | "high";
  confidence: number;
  ambiguities: string[];
  evidence?: DomainVocabularyEvidence[];
}

interface CandidateEvidenceMetadata {
  evidenceLevel?: "verified" | "weak_candidate";
  sourceProposalId?: string;
  status?: "candidate" | "verified" | "deprecated";
  retrievalWeight?: "weak" | "normal" | "strong";
  targetPageStatus?: "unverified" | "verified";
  evidenceSource?: string;
}

interface AssistantRetrievalBundle {
  schemaVersion: "retrieval.v1";
  status: "sufficient" | "partial" | "insufficient" | "candidate_only";
  retrievalQueries: string[];
  pageCandidates: Array<{ id?: string; title?: string; url?: string; urlPattern?: string; score: number; source: "page_graph" | "page_state" | "knowledge" | "env" } & CandidateEvidenceMetadata>;
  elementCandidates: Array<{ text?: string; role?: string; selector?: string; href?: string; score: number; source: "page_graph" | "page_state" | "knowledge" } & CandidateEvidenceMetadata>;
  businessFlowCandidates?: Array<{ flowId: string; name?: string; score: number; source: "business_flow"; evidence: string[] }>;
  knowledgeHits: Array<{ title: string; sourceType: string; surface?: string; confidence: number; content: string } & CandidateEvidenceMetadata>;
  knowledgeAudit?: KnowledgeRerankAudit[];
  coverageEvidence?: CoverageEvidence[];
  preflightChecks?: PreflightCheck[];
  runtimeResolvable?: string[];
  gaps: string[];
  explorationNeeded: boolean;
}

interface AssistantPlan {
  intent: string;
  project: string;
  env: string;
  account?: string;
  steps: AssistantPlanStep[];
  assertions: Array<{ type: string; target?: string; expected?: unknown }>;
  requiresConfirmation: boolean;
  openQuestions: string[];
  intentSpec?: AssistantIntentSpec;
  retrievalBundle?: AssistantRetrievalBundle;
  coverage?: {
    requiredGoals: string[];
    coveredGoals: string[];
    uncoveredGoals: string[];
    evidence?: CoverageEvidence[];
    runtimeResolvable?: string[];
    preflightChecks?: PreflightCheck[];
  };
  aiStages?: AssistantAiStages;
  dslDraft?: DslDraft;
  dslReview?: DslReview;
  coverageExplanation?: CoverageExplanation;
  preflightDecision?: PreflightDecision;
  providerCalls?: ProviderCallRecord[];
}

interface AssistantAiStages {
  requirementUnderstanding: AiStageEnvelope<AssistantIntentSpec>;
  retrievalRerank: AiStageEnvelope<Record<string, unknown>>;
  evidenceFusion: AiStageEnvelope<Record<string, unknown>>;
  dslDraft: AiStageEnvelope<DslDraft>;
  dslReview: AiStageEnvelope<DslReview>;
  coverageExplanation: AiStageEnvelope<CoverageExplanation>;
  preflightDecision: AiStageEnvelope<PreflightDecision>;
  failureAnalysis?: AiStageEnvelope<Record<string, unknown>>;
  memoryUpdateProposal?: AiStageEnvelope<Record<string, unknown>>;
}

interface AiSettings {
  provider: "deepseek" | "openai" | "glm";
  model: string;
  baseUrl?: string;
  apiKey?: string;
  updatedAt?: string;
}

interface LocalSecrets {
  larkVerification?: {
    webhookUrl?: string;
    signSecret?: string;
    keyword?: string;
    updatedAt?: string;
  };
  database?: Record<string, unknown>;
}

interface VerificationInbox {
  updatedAt: string;
  records: VerificationRecord[];
}

interface VerificationRecord {
  id: string;
  source: "lark-webhook" | "manual-simulate";
  channel: "lark";
  account?: string;
  purpose?: string;
  code?: string;
  rawText: string;
  matchedKeyword: boolean;
  receivedAt: string;
  payload?: unknown;
}

async function readAiSettings(): Promise<AiSettings> {
  return await readAiProviderSettings(rootDir);
}

async function writeAiSettings(settings: AiSettings): Promise<void> {
  const filePath = aiSettingsPath();
  await writeSafeJsonFile(filePath, settings);
}

function aiSettingsPath(): string {
  return path.join(rootDir, "storage", "ai-settings.json");
}

async function readLocalSecrets(): Promise<LocalSecrets> {
  const filePath = localSecretsPath();
  if (!(await fs.pathExists(filePath))) return {};
  return (await fs.readJson(filePath)) as LocalSecrets;
}

async function writeLocalSecrets(secrets: LocalSecrets): Promise<void> {
  const filePath = localSecretsPath();
  await writeSafeJsonFile(filePath, secrets);
}

function localSecretsPath(): string {
  return path.join(rootDir, "storage", "secrets.local.json");
}

function readDottedSecret(secrets: LocalSecrets, dottedPath: string): string | undefined {
  const value = dottedPath.split(".").reduce<unknown>((current, key) => {
    return current && typeof current === "object" ? (current as Record<string, unknown>)[key] : undefined;
  }, secrets);
  return typeof value === "string" && value ? value : undefined;
}

function maskSecret(value: string | undefined): string {
  if (!value) return "";
  if (value.length <= 8) return "****";
  return `${value.slice(0, 4)}****${value.slice(-4)}`;
}

function maskWebhook(value: string | undefined): string {
  if (!value) return "";
  const match = value.match(/^(https:\/\/[^/]+\/.+\/hook\/)([^/?#]+)/i);
  if (!match) return maskSecret(value);
  return `${match[1]}${maskSecret(match[2])}`;
}

async function sendLarkVerificationTestMessage(input: { account?: string; purpose?: string }): Promise<{
  ok: boolean;
  status?: number;
  response?: unknown;
  error?: string;
}> {
  const settings = (await readLocalSecrets()).larkVerification;
  if (!settings?.webhookUrl) return { ok: false, error: "未配置 Lark webhook 地址。" };
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const payload: Record<string, unknown> = {
    msg_type: "text",
    content: {
      text: [
        settings.keyword ?? "验证码",
        "Workbench 监听测试",
        input.account ? `账号：${input.account}` : "",
        input.purpose ? `用途：${input.purpose}` : "",
        `时间：${new Date().toLocaleString("zh-CN", { hour12: false })}`
      ]
        .filter(Boolean)
        .join("\n")
    }
  };
  if (settings.signSecret) {
    payload.timestamp = timestamp;
    payload.sign = createLarkBotSign(timestamp, settings.signSecret);
  }
  const response = await fetch(settings.webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = text;
  }
  return { ok: response.ok, status: response.status, response: body };
}

function createLarkBotSign(timestamp: string, secret: string): string {
  const stringToSign = `${timestamp}\n${secret}`;
  return crypto.createHmac("sha256", stringToSign).update("").digest("base64");
}

async function acceptVerificationPayload(payload: Record<string, unknown>, source: VerificationRecord["source"]): Promise<VerificationRecord> {
  const settings = (await readLocalSecrets()).larkVerification;
  const rawText = extractVerificationText(payload);
  const record: VerificationRecord = {
    id: crypto.randomUUID(),
    source,
    channel: "lark",
    account: extractVerificationAccount(payload, rawText),
    purpose: typeof payload.purpose === "string" ? payload.purpose : undefined,
    code: extractVerificationCode(payload, rawText),
    rawText,
    matchedKeyword: rawText.includes(settings?.keyword ?? "验证码"),
    receivedAt: new Date().toISOString(),
    payload
  };
  const inbox = await readVerificationInbox();
  inbox.records.unshift(record);
  inbox.records = inbox.records.slice(0, 200);
  inbox.updatedAt = record.receivedAt;
  await writeVerificationInbox(inbox);
  return record;
}

function extractVerificationText(payload: Record<string, unknown>): string {
  const candidates = [
    payload.text,
    payload.rawText,
    payload.message,
    payload.content,
    (payload.event as Record<string, unknown> | undefined)?.message,
    ((payload.event as Record<string, unknown> | undefined)?.message as Record<string, unknown> | undefined)?.content
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (typeof candidate === "string") {
      try {
        const parsed = JSON.parse(candidate) as Record<string, unknown>;
        if (typeof parsed.text === "string") return parsed.text;
      } catch {
        return candidate;
      }
    }
    if (typeof candidate === "object") {
      const text = (candidate as Record<string, unknown>).text;
      if (typeof text === "string") return text;
      return JSON.stringify(candidate);
    }
  }
  return JSON.stringify(payload);
}

function extractVerificationAccount(payload: Record<string, unknown>, rawText: string): string | undefined {
  if (typeof payload.account === "string" && payload.account.trim()) return payload.account.trim();
  const email = rawText.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0];
  if (email) return email;
  const phone = rawText.match(/(?<!\d)(?:\+?\d{1,3}[- ]?)?\d{8,14}(?!\d)/)?.[0];
  return phone;
}

function extractVerificationCode(payload: Record<string, unknown>, rawText: string): string | undefined {
  if (typeof payload.code === "string" && /^\d{4,8}$/.test(payload.code.trim())) return payload.code.trim();
  return rawText.match(/(?<!\d)\d{4,8}(?!\d)/)?.[0];
}

async function readVerificationInbox(): Promise<VerificationInbox> {
  const filePath = verificationInboxPath();
  if (!(await fs.pathExists(filePath))) return { updatedAt: new Date().toISOString(), records: [] };
  return (await fs.readJson(filePath)) as VerificationInbox;
}

async function writeVerificationInbox(inbox: VerificationInbox): Promise<void> {
  const filePath = verificationInboxPath();
  await writeSafeJsonFile(filePath, inbox);
}

function verificationInboxPath(): string {
  return path.join(rootDir, "storage", "verifications", "lark-inbox.json");
}

async function buildAssistantPlan(input: { project: string; env: string; message: string }): Promise<{
  trace: AssistantTraceItem[];
  plan: AssistantPlan;
  usedModel: string;
  knowledgeHits: Array<{ title: string; sourceType: string; surface?: string; confidence: number; content: string }>;
}> {
  const trace: AssistantTraceItem[] = [];
  const mark = (step: string, status: AssistantTraceItem["status"], detail: string): void => {
    trace.push({ step, status, detail, at: new Date().toISOString() });
  };

  mark("理解需求", "completed", `收到需求：${input.message}`);
  const context = await loadContext({ project: input.project, env: input.env });
  const aiUsageTracker = new AIUsageTracker(context);
  const accountStore = new AccountStore(context);
  await accountStore.seedDefaults();
  const accounts = await accountStore.list({ project: input.project, env: input.env });
  const discovery = await new EnvironmentDiscoveryStore(context).load(input.project, input.env);
  const graph = await new PageGraphStore(context).load();
  const domainVocabulary = await loadDomainVocabulary(context.rootDir, context.project.projectKey);
  const intent = await buildAssistantIntentSpec(input, accounts, discovery, graph, aiUsageTracker, domainVocabulary);
  mark("IntentSpec", "completed", `module=${intent.module}, action=${intent.action}, operation=${intent.operationType}, confidence=${intent.confidence}`);
  mark(
    "读取上下文",
    "completed",
    `项目 ${input.project}/${input.env}，账号 ${accounts.length} 个，页面节点 ${graph.nodes.length} 个，路径 ${graph.edges.length} 条。`
  );

  const knowledgeStore = new KnowledgeStore(context);
  const knowledgeHits = await searchAssistantKnowledge(knowledgeStore, input.message, intent, 12);
  const retrievalBundle = await buildAssistantRetrievalBundle(context, input, intent, graph, knowledgeHits);
  mark(
    "RetrievalBundle",
    retrievalBundle.status === "insufficient" ? "failed" : "completed",
    `status=${retrievalBundle.status}, pages=${retrievalBundle.pageCandidates.length}, elements=${retrievalBundle.elementCandidates.length}, gaps=${retrievalBundle.gaps.join("; ") || "none"}`
  );
  mark("检索知识库", "completed", `命中 ${knowledgeHits.length} 条页面地图/知识库片段。`);

  const fallbackPlan = buildFallbackAssistantPlan(input, accounts, discovery, graph, knowledgeHits, intent, retrievalBundle);
  fallbackPlan.intentSpec = intent;
  fallbackPlan.retrievalBundle = retrievalBundle;
  fallbackPlan.coverage = buildAssistantCoverage(input.message, intent, retrievalBundle);
  fallbackPlan.requiresConfirmation = fallbackPlan.requiresConfirmation || retrievalBundle.status === "insufficient" || retrievalBundle.status === "candidate_only";
  if (retrievalBundle.status === "insufficient" || retrievalBundle.status === "candidate_only") fallbackPlan.openQuestions.push(...retrievalBundle.gaps.map((gap) => `Knowledge gap: ${gap}`));
  const deepSeek = await tryBuildDeepSeekPlan(input, accounts, discovery, graph, knowledgeHits, fallbackPlan, aiUsageTracker, intent, retrievalBundle);
  if (deepSeek.plan) {
    const enrichedPlan = await attachAssistantStageDiagnostics(context, input, deepSeek.plan, "deepseek");
    mark("生成执行步骤", "completed", `DeepSeek 已返回平台 DSL 草案，模型：${deepSeek.model}。`);
    if (enrichedPlan.requiresConfirmation) {
      mark("等待确认", "needs_confirmation", "计划包含写操作、状态变更或前置条件不明确，需要你确认后再执行。");
    }
    return {
      trace,
      plan: enrichedPlan,
      usedModel: deepSeek.model,
      knowledgeHits: summarizeKnowledgeHits(knowledgeHits)
    };
  }

  mark("生成执行步骤", "completed", deepSeek.error ?? "未配置 DeepSeek Key，已使用本地降级规划。");
  const enrichedFallbackPlan = await attachAssistantStageDiagnostics(context, input, fallbackPlan, "local-fallback");
  if (enrichedFallbackPlan.requiresConfirmation) {
    mark("等待确认", "needs_confirmation", "计划包含写操作、状态变更或前置条件不明确，需要你确认后再执行。");
  }
  return {
    trace,
    plan: enrichedFallbackPlan,
    usedModel: "local-fallback",
    knowledgeHits: summarizeKnowledgeHits(knowledgeHits)
  };
}

function buildFallbackAssistantPlan(
  input: { project: string; env: string; message: string },
  accounts: TestAccount[],
  discovery: EnvironmentDiscovery,
  graph: PageGraphMemory,
  knowledgeHits: KnowledgeChunk[],
  intentSpec?: AssistantIntentSpec,
  retrievalBundle?: AssistantRetrievalBundle
): AssistantPlan {
  const account = chooseAccount(input.message, accounts);
  const firstUrl = graph.nodes.find((item) => item.url)?.url;
  const baseUrl = firstUrl ? new URL(firstUrl).origin : undefined;
  const isWriteIntent = intentSpec?.operationType === "write" || isWriteIntentMessage(input.message);
  const steps: AssistantPlanStep[] = [];

  if (account && discovery.bypassLogin?.enabled) {
    steps.push({
      action: "bypassLogin",
      target: discovery.bypassLogin.path,
      value: { username: account.username, tokenHeaderName: discovery.bypassLogin.tokenHeaderName },
      source: "environment-discovery",
      riskLevel: "low",
      reason: "环境配置了测试旁路登录接口，优先降低验证码和人工登录成本。"
    });
  } else if (account) {
    steps.push({
      action: "loginWithAccount",
      target: account.username,
      source: "account-store",
      riskLevel: "medium",
      reason: "未启用旁路登录，使用账号信息走页面登录。"
    });
  } else {
    steps.push({
      action: "manualDecision",
      target: "account",
      riskLevel: "medium",
      reason: "当前项目环境没有可用账号，需要选择或新增账号。"
    });
  }

  steps.push({
    action: "openEntry",
    target: baseUrl ?? "project-env-default-url",
    source: firstUrl ? "page-graph" : "project-config",
    riskLevel: "low"
  });

  for (const hit of knowledgeHits.slice(0, 5)) {
    steps.push({
      action: hit.metadata?.kind === "page_edge" ? "followKnownPath" : "inspectKnownPage",
      target: hit.title,
      source: "knowledge-base",
      riskLevel: "low",
      reason: hit.content.slice(0, 160)
    });
  }

  steps.push({
    action: isWriteIntent ? "prepareWriteOperation" : "executeReadOnlyGoal",
    target: input.message,
    source: "user-intent",
    riskLevel: isWriteIntent ? "high" : "medium",
    reason: isWriteIntent ? "需求包含创建/修改类动作，执行前需要确认数据和影响范围。" : "按知识库命中的页面路径执行读取或验证任务。"
  });

  return {
    intent: intentSpec ? `${intentSpec.module}.${intentSpec.action}` : input.message,
    project: input.project,
    env: input.env,
    account: account?.username,
    steps,
    assertions: [{ type: "uiState", target: input.message, expected: "目标流程完成或页面出现成功状态" }],
    requiresConfirmation: isWriteIntent || !account,
    openQuestions: isWriteIntent ? ["确认是否允许在当前 Test/UAT 环境执行写操作。", "确认创建数据所需字段和取值。"] : []
  };
}

async function tryBuildDeepSeekPlan(
  input: { project: string; env: string; message: string },
  accounts: TestAccount[],
  discovery: EnvironmentDiscovery,
  graph: PageGraphMemory,
  knowledgeHits: KnowledgeChunk[],
  fallbackPlan: AssistantPlan,
  aiUsageTracker: AIUsageTracker,
  intentSpec?: AssistantIntentSpec,
  retrievalBundle?: AssistantRetrievalBundle
): Promise<{ plan?: AssistantPlan; model: string; error?: string }> {
  const runtime = await resolveAiRuntime(rootDir);
  const apiKey = runtime.apiKey;
  const model = runtime.model;
  if (!apiKey) return { model: "local-fallback", error: `未配置 ${runtime.provider} API Key，已跳过远程 AI 调用。` };

  const prompt = buildDeepSeekPrompt(input, accounts, discovery, graph, knowledgeHits, fallbackPlan, intentSpec, retrievalBundle);
  const cacheKey = aiUsageTracker.cacheKey({
    projectId: input.project,
    platform: "web",
    semanticTarget: input.message,
    actionType: "assistant_plan",
    domSignature: crypto.createHash("sha1").update(prompt).digest("hex"),
    promptVersion: "assistant-plan-v1",
    modelName: model,
    purpose: "dsl_generation"
  });
  const cached = await aiUsageTracker.readCache<AssistantPlan>(cacheKey);
  if (cached) {
    await aiUsageTracker.track({
      modelName: model,
      purpose: "dsl_generation",
      prompt,
      response: cached,
      latencyMs: 0,
      cacheHit: true
    });
    return { plan: normalizeAssistantPlan(cached, fallbackPlan, input), model };
  }
  const startedAt = Date.now();
  try {
    const response = await fetch(runtime.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content:
              "你是 AI 自动化测试平台的规划器。只输出 JSON，不输出 Markdown。JSON 必须符合用户提供的平台 DSL 字段。遇到写操作或前置条件不明确时设置 requiresConfirmation=true。"
          },
          { role: "user", content: prompt }
        ]
      })
    });
    if (!response.ok) return { model, error: `AI 调用失败（${runtime.provider}）：HTTP ${response.status}` };
    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    const content = payload.choices?.[0]?.message?.content ?? "";
    await aiUsageTracker.track({
      modelName: model,
      purpose: "dsl_generation",
      prompt,
      response: content,
      promptTokens: payload.usage?.prompt_tokens,
      completionTokens: payload.usage?.completion_tokens,
      latencyMs: Date.now() - startedAt,
      cacheHit: false
    });
    const parsed = parseAssistantPlanJson(content);
    const plan = normalizeAssistantPlan(parsed, fallbackPlan, input);
    await aiUsageTracker.writeCache(cacheKey, plan);
    return { plan, model };
  } catch (error) {
    return { model, error: `AI 调用异常（${runtime.provider}）：${error instanceof Error ? error.message : String(error)}` };
  }
}

async function tryBuildDeepSeekPageModelDslAdvisor(input: {
  project: string;
  env: string;
  message: string;
  initialUnderstanding?: unknown;
  planningContext: Record<string, unknown>;
  plan?: Parameters<typeof buildPageModelDslAdvisorWithAi>[0]["plan"];
  planSummary?: Record<string, unknown>;
  localDslValidation?: unknown;
}): Promise<{ status: "completed" | "skipped" | "failed"; provider?: string; model: string; mode?: PageModelDslAdvisorMode; prompt?: string; parsedOutput?: unknown; rawOutput?: string; error?: string; telemetry?: unknown }> {
  const mode = String(process.env.PAGE_MODEL_AI_ADVISORY_MODE ?? process.env.PAGE_MODEL_DEEPSEEK_ADVISORY_MODE ?? "compressed") === "full" ? "full" : "compressed";
  const result = await buildPageModelDslAdvisorWithAi({
    rootDir,
    project: input.project,
    env: input.env,
    message: input.message,
    initialUnderstanding: input.initialUnderstanding,
    planningContext: input.planningContext,
    plan: input.plan,
    planSummary: input.planSummary,
    localDslValidation: input.localDslValidation,
    timeoutMs: pageModelDeepSeekTimeoutMs,
    mode
  });
  return {
    status: result.status,
    provider: result.provider,
    model: result.model,
    mode: result.mode,
    prompt: result.prompt,
    parsedOutput: result.parsedOutput,
    rawOutput: result.rawOutput,
    error: result.error,
    telemetry: result.telemetry
  };
}

async function tryUnderstandPageModelIntentWithDeepSeek(input: {
  project: string;
  env: string;
  message: string;
  caseContext?: StructuredCaseContext;
}): Promise<{ status: "completed" | "skipped" | "failed"; provider?: string; model: string; prompt?: string; parsedOutput?: unknown; rawOutput?: string; error?: string; telemetry?: unknown }> {
  const result = await understandPageModelIntentWithAi({
    rootDir,
    project: input.project,
    env: input.env,
    message: input.message,
    caseContext: input.caseContext,
    timeoutMs: pageModelDeepSeekTimeoutMs
  });
  return {
    status: result.status,
    provider: result.provider,
    model: result.model,
    prompt: result.prompt,
    parsedOutput: result.parsedOutput,
    rawOutput: result.rawOutput,
    error: result.error,
    telemetry: result.telemetry
  };
}

function deepSeekIntentUnderstandingBlockReason(result: { status: "completed" | "skipped" | "failed"; parsedOutput?: unknown; error?: string }): string | undefined {
  return aiIntentUnderstandingBlockReason(result);
}

function blockedDeepSeekIntentPlan(
  message: string,
  reason: string,
  pageModelDeepSeekIntent: { status: "completed" | "skipped" | "failed"; model: string; prompt?: string; parsedOutput?: unknown; rawOutput?: string; error?: string }
): Record<string, unknown> {
  return {
    intent: message,
    source: "deepseek_intent_understanding",
    executable: false,
    readiness: "blocked",
    gaps: ["deepseek_intent_understanding_failed"],
    blockingGaps: ["deepseek_intent_understanding_failed"],
    recommendedNextAction: "retry_intent_understanding",
    requiresConfirmation: false,
    pageModelDeepSeekIntent,
    blockedStage: "deepseek_intent_understanding",
    blockedReason: reason,
    steps: { stepCount: 0, steps: [] }
  };
}

function redactDeepSeekErrorBody(value: string): string {
  return value
    .replace(/sk-[A-Za-z0-9_-]+/g, "sk-***")
    .slice(0, 800);
}

function buildDeepSeekPrompt(
  input: { project: string; env: string; message: string },
  accounts: TestAccount[],
  discovery: EnvironmentDiscovery,
  graph: PageGraphMemory,
  knowledgeHits: KnowledgeChunk[],
  fallbackPlan: AssistantPlan,
  intentSpec?: AssistantIntentSpec,
  retrievalBundle?: AssistantRetrievalBundle
): string {
  return JSON.stringify(
    {
      task: input.message,
      project: input.project,
      env: input.env,
      planningPolicy: {
        role: "Generate a grounded executable plan draft for the automation platform.",
        rules: [
          "Return JSON only.",
          "Do not invent URLs or selectors when local retrieval has no evidence.",
          "Each concrete click/input/select/assert step should reference retrieved page or element evidence through source/reason/target.",
          "If required page path, locator, account, balance, KYC, language, or test data is missing, set requiresConfirmation=true and add openQuestions.",
          "A navigation-only plan is not complete when the user requested an in-page action."
        ]
      },
      intentSpec,
      retrievalBundle,
      availableAccounts: accounts.map((item) => ({ username: item.username, label: item.label })),
      environment: {
        domains: discovery.domains,
        apiEndpoints: discovery.apiEndpoints.slice(0, 30),
        bypassLogin: discovery.bypassLogin
          ? {
              enabled: discovery.bypassLogin.enabled,
              path: discovery.bypassLogin.path,
              tokenHeaderName: discovery.bypassLogin.tokenHeaderName
            }
          : undefined
      },
      graphSummary: {
        nodes: graph.nodes.length,
        edges: graph.edges.length,
        sampleNodes: graph.nodes.slice(0, 12).map((item) => ({
          pageId: item.pageId,
          name: item.semanticName ?? item.title,
          surface: item.surface,
          url: item.url,
          elements: item.elements.slice(0, 12).map((element) => element.text || element.role || element.href)
        }))
      },
      knowledgeHits: knowledgeHits.map((item) => ({
        title: item.title,
        surface: item.surface,
        content: item.content.slice(0, 600),
        metadata: item.metadata
      })),
      outputSchema: fallbackPlan
    },
    null,
    2
  );
}

async function buildAssistantIntentSpec(
  input: { project: string; env: string; message: string },
  accounts: TestAccount[],
  discovery: EnvironmentDiscovery,
  graph: PageGraphMemory,
  aiUsageTracker: AIUsageTracker,
  domainVocabulary?: DomainVocabulary
): Promise<AssistantIntentSpec> {
  const fallback = buildLocalAssistantIntentSpec(input, accounts, discovery, graph, domainVocabulary);
  const remote = await tryBuildDeepSeekIntentSpec(input, accounts, discovery, graph, fallback, aiUsageTracker, domainVocabulary);
  return normalizeAssistantIntentSpec(remote.intentSpec, fallback) ?? fallback;
}

async function tryBuildDeepSeekIntentSpec(
  input: { project: string; env: string; message: string },
  accounts: TestAccount[],
  discovery: EnvironmentDiscovery,
  graph: PageGraphMemory,
  fallback: AssistantIntentSpec,
  aiUsageTracker: AIUsageTracker,
  domainVocabulary?: DomainVocabulary
): Promise<{ intentSpec?: AssistantIntentSpec; model: string; error?: string }> {
  const runtime = await resolveAiRuntime(rootDir);
  const apiKey = runtime.apiKey;
  const model = runtime.model;
  if (!apiKey) return { model: "local-fallback", error: `${runtime.provider} API key is not configured.` };
  const prompt = JSON.stringify(
    {
      task: "Parse the user request into a strict automation intent JSON.",
      rules: [
        "Return JSON only.",
        "Do not generate executable steps in this phase.",
        "Extract module, action, operationType, target page hint, preconditions, entities, expected outcomes, retrieval queries, risks, and ambiguities.",
        "If a value is unknown, mark it unknown or add it to ambiguities; do not invent test data."
      ],
      userRequest: input.message,
      project: input.project,
      env: input.env,
      accounts: accounts.map((item) => ({ username: item.username, label: item.label })),
      environment: {
        domains: discovery.domains,
        bypassLogin: discovery.bypassLogin
          ? { enabled: discovery.bypassLogin.enabled, path: discovery.bypassLogin.path, tokenHeaderName: discovery.bypassLogin.tokenHeaderName }
          : undefined
      },
      domainVocabulary: summarizeDomainVocabulary(domainVocabulary),
      pageGraphSample: graph.nodes.slice(0, 20).map((node) => ({
        pageId: node.pageId,
        title: node.title ?? node.semanticName,
        url: node.url ?? node.urlPattern,
        elements: node.elements.slice(0, 12).map((element) => element.text || element.role || element.href || element.selector)
      })),
      outputSchema: fallback
    },
    null,
    2
  );
  const cacheKey = aiUsageTracker.cacheKey({
    projectId: input.project,
    platform: "web",
    semanticTarget: input.message,
    actionType: "assistant_intent",
    domSignature: crypto.createHash("sha1").update(prompt).digest("hex"),
    promptVersion: "assistant-intent-v1",
    modelName: model,
    purpose: "dsl_generation"
  });
  const cached = await aiUsageTracker.readCache<AssistantIntentSpec>(cacheKey);
  if (cached) {
    await aiUsageTracker.track({ modelName: model, purpose: "dsl_generation", prompt, response: cached, latencyMs: 0, cacheHit: true });
    return { intentSpec: cached, model };
  }
  const startedAt = Date.now();
  try {
    const response = await fetch(runtime.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        temperature: 0.1,
        messages: [
          { role: "system", content: "You are the requirement-understanding module of an automation test platform. Output JSON only." },
          { role: "user", content: prompt }
        ]
      })
    });
    if (!response.ok) return { model, error: `AI intent call failed (${runtime.provider}): HTTP ${response.status}` };
    const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    const content = payload.choices?.[0]?.message?.content ?? "";
    await aiUsageTracker.track({
      modelName: model,
      purpose: "dsl_generation",
      prompt,
      response: content,
      promptTokens: payload.usage?.prompt_tokens,
      completionTokens: payload.usage?.completion_tokens,
      latencyMs: Date.now() - startedAt,
      cacheHit: false
    });
    const parsed = parseAssistantPlanJson(content);
    const normalized = normalizeAssistantIntentSpec(parsed, fallback);
    if (normalized) await aiUsageTracker.writeCache(cacheKey, normalized);
    return { intentSpec: normalized, model };
  } catch (error) {
    return { model, error: `AI intent call error (${runtime.provider}): ${error instanceof Error ? error.message : String(error)}` };
  }
}

function buildLocalAssistantIntentSpec(
  input: { project: string; env: string; message: string },
  accounts: TestAccount[],
  discovery: EnvironmentDiscovery,
  graph: PageGraphMemory,
  domainVocabulary?: DomainVocabulary
): AssistantIntentSpec {
  const slots = extractAssistantSlots(input.message, { intent: input.message });
  const domainMatch = classifyWithDomainVocabulary(input.message, domainVocabulary);
  if (domainMatch.module) slots.module = domainMatch.module;
  if (domainMatch.action) slots.action = domainMatch.action;
  for (const [key, value] of Object.entries(domainMatch.entities)) {
    slots[key] = value;
  }
  const text = input.message.toLowerCase();
  if (/(\u73b0\u8d27|spot|trade|market|order|\u4e0b\u5355|\u4e70\u5165|\u5356\u51fa)/i.test(text)) {
    slots.module = "spot";
    slots.action = slots.action || "place-order";
  }
  const operationType: AssistantIntentSpec["operationType"] = isWriteIntentMessage(input.message) || slots.action === "place-order" ? "write" : "read";
  const pair = extractSpotPair(input.message, slots);
  const entities: Record<string, unknown> = { ...slots };
  Object.assign(entities, domainMatch.entities);
  if (pair) entities.pair = pair;
  const side = /(\u5356\u51fa|sell)/i.test(input.message) ? "sell" : /(\u4e70\u5165|buy)/i.test(input.message) ? "buy" : undefined;
  if (side) entities.side = side;
  const orderType = /(\u5e02\u4ef7|market)/i.test(input.message) ? "market" : /(\u9650\u4ef7|limit)/i.test(input.message) ? "limit" : undefined;
  if (orderType) entities.orderType = orderType;
  const module = slots.module ?? "unknown";
  const action = slots.action ?? (operationType === "write" ? "write-operation" : "read-page");
  const targetPage = inferIntentTargetPage(input, module, pair);
  const retrievalQueries = [
    input.message,
    `${module} ${action}`,
    targetPage?.urlHint,
    ...domainMatch.retrievalQueries,
    pair ? `spot ${pair}` : undefined,
    module === "spot" ? "\u73b0\u8d27 \u4e0b\u5355 \u4e70\u5165 \u5356\u51fa \u4ea4\u6613" : undefined,
    module === "earn" ? "\u7406\u8d22 \u7533\u8d2d" : undefined,
    module === "withdraw" ? "\u63d0\u73b0 \u63d0\u5e01 \u901a\u8baf\u5f55" : undefined,
    module === "red-packet" && action === "create" ? "\u7ea2\u5305 \u521b\u5efa \u53d1\u653e \u91d1\u989d \u6570\u91cf GA \u90ae\u7bb1 red packet create" : undefined,
    module === "red-packet" && action !== "create" ? "\u7ea2\u5305 \u8bb0\u5f55 \u53e3\u4ee4" : undefined
  ].filter((item): item is string => Boolean(item));
  const preconditions: AssistantIntentSpec["preconditions"] = [
    { name: "user_logged_in", required: true, status: accounts.length ? "known" : "unknown", source: accounts.length ? "account-store" : undefined },
    { name: "environment_available", required: true, status: discovery.domains.length || graph.nodes.length ? "known" : "unknown", source: "environment-discovery" },
    { name: "language_zh_hans", required: true, status: "required" },
    ...(operationType === "write"
      ? [
          { name: "test_balance_sufficient", required: true, status: "unknown" as const },
          { name: "kyc_status_eligible", required: true, status: "unknown" as const }
        ]
      : [])
  ];
  return {
    schemaVersion: "intent.v1",
    rawRequest: input.message,
    project: input.project,
    env: input.env,
    language: "zh-hans",
    module,
    submodule: slots.submodule,
    action,
    operationType,
    targetPage,
    entities,
    preconditions,
    expectedOutcome: inferIntentExpectedOutcomes(module, action, operationType),
    retrievalQueries,
    recommendedAutomationLayer: "web-ui",
    riskLevel: operationType === "write" ? "high" : "low",
    confidence: domainMatch.confidence || (module === "unknown" ? 0.35 : 0.78),
    ambiguities: module === "unknown" ? ["Unable to identify target module from local rules."] : [],
    evidence: domainMatch.evidence.length ? domainMatch.evidence : undefined
  };
}

async function searchAssistantKnowledge(store: KnowledgeStore, message: string, intent: AssistantIntentSpec, limit: number): Promise<KnowledgeChunk[]> {
  const queries = [...new Set([message, ...intent.retrievalQueries, ...assistantIntentAwareRetrievalQueries(intent, message)])].slice(0, 12);
  const ranked = new Map<string, KnowledgeChunk>();
  for (const query of queries) {
    const hits = await store.search(query, Math.max(4, Math.ceil(limit / 2)));
    for (const hit of hits) {
      const key = `${hit.sourceType}:${hit.title}:${hit.content.slice(0, 80)}`;
      const existing = ranked.get(key);
      if (!existing || hit.confidence > existing.confidence) ranked.set(key, hit);
    }
  }
  let candidates = [...ranked.values()];
  let reranked = rerankKnowledgeHitsForIntent(candidates, intent, queries.join(" | "), limit);
  if (detectRedPacketCreateClaimPollution(reranked.hits, intent)) {
    const secondPassQueries = [
      "create_red_packet",
      "red packet create",
      "\u521b\u5efa\u7ea2\u5305",
      "\u53d1\u7ea2\u5305",
      "\u53d1\u653e\u7ea2\u5305",
      "demo_test_create_red_packet"
    ];
    for (const query of secondPassQueries) {
      const hits = await store.search(query, limit);
      for (const hit of hits) {
        const key = `${hit.sourceType}:${hit.title}:${hit.content.slice(0, 80)}`;
        const existing = ranked.get(key);
        if (!existing || hit.confidence > existing.confidence) ranked.set(key, hit);
      }
    }
    candidates = [...ranked.values()];
    reranked = rerankKnowledgeHitsForIntent(candidates, intent, [...queries, ...secondPassQueries].join(" | "), limit);
  }
  return reranked.hits;
}

function assistantIntentAwareRetrievalQueries(intent: AssistantIntentSpec, message: string): string[] {
  if (isAssetOverviewIntent(intent) || /(\u8d44\u4ea7\u4e2d\u5fc3|\u8d44\u4ea7\u603b\u89c8|\u6211\u7684\u8d44\u4ea7|\u8d44\u4ea7\u5217\u8868|USDT\s*\u8d44\u4ea7\u884c)/i.test(message)) {
    const asset = typeof intent.entities.asset === "string" ? intent.entities.asset : undefined;
    return [
      "\u8d44\u4ea7\u603b\u89c8",
      "\u8d44\u4ea7\u4e2d\u5fc3",
      "\u6211\u7684\u8d44\u4ea7",
      "\u8d44\u4ea7\u5217\u8868",
      "\u5e01\u79cd\u7ef4\u5ea6",
      "\u8d26\u6237\u7ef4\u5ea6",
      "asset overview",
      "total assets",
      "asset list",
      "assets total-assets",
      asset ? `asset overview ${asset}` : undefined,
      asset ? `asset list ${asset}` : undefined
    ].filter((item): item is string => Boolean(item));
  }
  if (isAssetRecordIntent(intent) || /(\u8d44\u4ea7|\u94b1\u5305|\u8d22\u52a1|\u8d44\u91d1).{0,12}(\u8bb0\u5f55|\u660e\u7ec6|\u8d26\u5355|\u5217\u8868)|(\u8bb0\u5f55|\u660e\u7ec6|\u8d26\u5355|\u5217\u8868).{0,12}(\u8d44\u4ea7|\u94b1\u5305|\u8d22\u52a1|\u8d44\u91d1)/i.test(message)) {
    const asset = typeof intent.entities.asset === "string" ? intent.entities.asset : undefined;
    return [
      "\u8d44\u4ea7\u8bb0\u5f55",
      "\u94b1\u5305\u8bb0\u5f55",
      "\u8d22\u52a1\u8bb0\u5f55",
      "\u8d44\u91d1\u660e\u7ec6",
      "\u8d26\u5355 \u660e\u7ec6",
      "asset record",
      "wallet record",
      "finance record",
      "transaction history",
      "assets total-assets record",
      asset ? `asset record ${asset}` : undefined
    ].filter((item): item is string => Boolean(item));
  }
  return [];
}

async function buildAssistantRetrievalBundle(
  context: LoadedContext,
  input: { project: string; env: string; message: string },
  intent: AssistantIntentSpec,
  graph: PageGraphMemory,
  knowledgeHits: KnowledgeChunk[]
): Promise<AssistantRetrievalBundle> {
  const terms = assistantSearchTerms([input.message, ...intent.retrievalQueries, intent.module, intent.action].join(" "));
  const [pageData, flowData] = await Promise.all([new PageStateStore(context).load(), new BusinessFlowStore(context).load()]);
  const businessFlowCoverage = buildBusinessFlowCoverage(flowData.flows, pageData.transitions, intent, input.project, input.env);
  const knowledgeAudit = rerankKnowledgeHitsForIntent(knowledgeHits as KnowledgeChunk[], intent, [...new Set([input.message, ...intent.retrievalQueries])].join(" | "), knowledgeHits.length || 1).audit;
  const isAssetOverview = isAssetOverviewIntent(intent);
  const includedWeakCandidateAudits = knowledgeAudit.filter((item) => item.included && item.evidenceLevel === "weak_candidate");
  const businessFlowCandidates = businessFlowCoverage.matchedFlowIds.map((flowId) => {
    const flow = flowData.flows.find((item) => item.flow_id === flowId);
    return {
      flowId,
      name: flow?.name,
      score: flow?.confidence_score ?? 0.8,
      source: "business_flow" as const,
      evidence: [...(flow?.target_flows ?? []), ...(flow?.preconditions ?? [])].slice(0, 12)
    };
  });
  const businessFlowElementCandidates = flowData.flows
    .filter((flow) => businessFlowCoverage.matchedFlowIds.includes(flow.flow_id))
    .flatMap((flow) => flow.transition_ids)
    .flatMap((transitionId) => pageData.transitions.find((transition) => transition.transition_id === transitionId)?.dsl_steps ?? [])
    .filter((step) => ["click", "input", "fill", "type", "select", "confirmWrite"].includes(step.action))
    .map((step) => ({
      text: step.semantic_target ?? step.semanticTarget,
      role: step.action,
      selector: step.primary_locator ?? step.target,
      href: undefined,
      score: step.primary_locator || step.target ? 12 : 8,
      source: "page_state" as const
    }));
  const pageCandidates: AssistantRetrievalBundle["pageCandidates"] = ([
    ...graph.nodes
      .map((node) => ({ node, score: scoreKnowledgeTarget(pageNodeSearchText(node), terms, { module: intent.module, ...stringEntitySlots(intent.entities) }) }))
      .filter((item) => item.score > 0)
      .map((item) => ({ id: item.node.pageId, title: item.node.title ?? item.node.semanticName, url: item.node.url, urlPattern: item.node.urlPattern, score: item.score, source: "page_graph" as const })),
    ...pageData.states
      .map((state) => ({ state, score: scoreKnowledgeTarget(`${state.page_name ?? ""} ${state.title ?? ""} ${state.url_pattern ?? ""} ${state.known_elements.join(" ")}`.toLowerCase(), terms, { module: intent.module, ...stringEntitySlots(intent.entities) }) }))
      .filter((item) => item.score > 0)
      .map((item) => ({ id: item.state.page_id, title: item.state.page_name ?? item.state.title, urlPattern: item.state.url_pattern, score: item.score, source: "page_state" as const, ...pageEvidenceMetadataFromRecord(item.state) }))
  ] as AssistantRetrievalBundle["pageCandidates"])
    .sort((a, b) => b.score - a.score)
    .slice(0, 12);
  const elementCandidates: AssistantRetrievalBundle["elementCandidates"] = ([
    ...graph.nodes.flatMap((node) =>
      node.elements.map((element) => {
        const score = scoreTerms(`${element.text ?? ""} ${element.selector ?? ""} ${element.href ?? ""} ${element.placeholder ?? ""}`.toLowerCase(), terms).score;
        return { text: element.text ?? element.placeholder, role: element.role, selector: element.selector, href: element.href, score, source: "page_graph" as const };
      })
    ),
    ...pageData.states.flatMap((state) =>
      state.known_elements.map((element) => {
        const score = scoreTerms(element.toLowerCase(), terms).score + (isLocatorLike(element) ? 1 : 0);
        return { text: element.startsWith("text=") ? element.slice(5) : undefined, selector: isLocatorLike(element) ? element : undefined, score, source: "page_state" as const, ...pageEvidenceMetadataFromRecord(state) };
      })
    ),
    ...businessFlowElementCandidates
  ] as AssistantRetrievalBundle["elementCandidates"])
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 30);
  const gaps: string[] = [];
  const hasVerifiedAssetOverview = isAssetOverview && hasVerifiedAssetOverviewEvidence({ pageCandidates, elementCandidates });
  const hasWeakPageOrElementCandidate =
    pageCandidates.some((item) => isWeakCandidateRetrievalItem(item)) ||
    elementCandidates.some((item) => isWeakCandidateRetrievalItem(item));
  const hasWeakKnowledgeCandidate = includedWeakCandidateAudits.length > 0;
  const hasWeakCandidate = hasWeakPageOrElementCandidate || (hasWeakKnowledgeCandidate && !hasVerifiedAssetOverview);
  if (isAssetRecordIntent(intent) && !knowledgeHits.some(isAssetRecordKnowledge)) gaps.push("asset_record_knowledge");
  if (isAssetRecordIntent(intent) && !isAssetOverview && hasWeakCandidate) {
    gaps.push("partial_candidate_evidence", "missing_verified_asset_record_page", "missing_asset_filter_locator", "missing_asset_record_assertion");
  }
  const runtimeResolvable = businessFlowCoverage.evidence.filter((item) => item.status === "runtime_resolvable").map((item) => item.item);
  const writeActionEvidence = businessFlowCoverage.evidence.find((item) => item.item === "write_action_locator");
  if (!pageCandidates.length && !intent.targetPage?.urlHint) gaps.push("target_page");
  if (requiresConcreteInteractionIntent(input.message) && !elementCandidates.length) gaps.push("interactive_element_locator");
  if (
    intent.operationType === "write" &&
    writeActionEvidence?.status === "missing" &&
    !elementCandidates.some((item) => /(buy|sell|submit|confirm|order|create|send|\u4e70\u5165|\u5356\u51fa|\u4e0b\u5355|\u786e\u8ba4|\u63d0\u4ea4|\u521b\u5efa|\u53d1\u653e)/i.test(`${item.text ?? ""} ${item.selector ?? ""}`))
  ) {
    gaps.push("write_action_locator");
  }
  const status: AssistantRetrievalBundle["status"] = hasVerifiedAssetOverview
    ? "sufficient"
    : hasWeakCandidate
    ? "candidate_only"
    : gaps.length === 0
      ? "sufficient"
      : pageCandidates.length || elementCandidates.length || knowledgeHits.length
        ? "partial"
        : "insufficient";
  const hasVerifiedTargetPage = pageCandidates.some((item) => item.evidenceLevel === "verified" && item.targetPageStatus !== "unverified");
  const hasVerifiedInteractiveElement = elementCandidates.some((item) => item.evidenceLevel === "verified");
  const targetPageStatus = hasWeakCandidate && !hasVerifiedTargetPage ? "partial" as const : "covered" as const;
  const interactiveStatus = hasWeakCandidate && !hasVerifiedInteractiveElement ? "partial" as const : "covered" as const;
  const weakCandidateIds = includedWeakCandidateAudits.map((item) => item.sourceProposalId).filter((item): item is string => Boolean(item));
  return {
    schemaVersion: "retrieval.v1",
    status,
    retrievalQueries: [...new Set([input.message, ...intent.retrievalQueries])],
    pageCandidates,
    elementCandidates,
    businessFlowCandidates,
    knowledgeHits: summarizeKnowledgeHits(knowledgeHits),
    knowledgeAudit,
    coverageEvidence: [
      ...(pageCandidates.length || intent.targetPage?.urlHint ? [{ item: "target_page", status: targetPageStatus, source: "page_map" as const, evidence: pageCandidates.slice(0, 5).map((item) => ("url" in item ? item.url : undefined) ?? item.urlPattern ?? item.id ?? item.title ?? "target_page"), evidenceLevel: hasVerifiedTargetPage ? "verified" as const : hasWeakCandidate ? "weak_candidate" as const : "verified" as const, sourceProposalId: hasVerifiedTargetPage ? pageCandidates.find((item) => item.evidenceLevel === "verified")?.sourceProposalId : weakCandidateIds[0], targetPageStatus: hasVerifiedTargetPage ? "verified" as const : hasWeakCandidate ? "unverified" as const : "verified" as const }] : []),
      ...(elementCandidates.length ? [{ item: "interactive_elements", status: interactiveStatus, source: "page_map" as const, evidence: elementCandidates.slice(0, 8).map((item) => item.selector ?? item.text ?? ("role" in item ? item.role : undefined) ?? "element"), evidenceLevel: hasVerifiedInteractiveElement ? "verified" as const : hasWeakCandidate ? "weak_candidate" as const : "verified" as const, sourceProposalId: hasVerifiedInteractiveElement ? elementCandidates.find((item) => item.evidenceLevel === "verified")?.sourceProposalId : weakCandidateIds[0], targetPageStatus: hasVerifiedInteractiveElement ? "verified" as const : hasWeakCandidate ? "unverified" as const : "verified" as const }] : []),
      ...(hasVerifiedAssetOverview ? [
        { item: "asset_overview_page", status: "covered" as const, source: "page_map" as const, evidence: pageCandidates.filter((item) => item.evidenceLevel === "verified").slice(0, 3).map((item) => item.id ?? item.title ?? "asset overview page"), evidenceLevel: "verified" as const, sourceProposalId: pageCandidates.find((item) => item.evidenceLevel === "verified")?.sourceProposalId, targetPageStatus: "verified" as const },
        { item: "asset_overview_usdt_row_assertion", status: "covered" as const, source: "page_map" as const, evidence: elementCandidates.filter((item) => item.evidenceLevel === "verified").slice(0, 5).map((item) => item.selector ?? item.text ?? "asset element"), evidenceLevel: "verified" as const, sourceProposalId: elementCandidates.find((item) => item.evidenceLevel === "verified")?.sourceProposalId, targetPageStatus: "verified" as const }
      ] : []),
      ...(hasWeakCandidate && !hasVerifiedAssetOverview ? [
        { item: "partial_candidate_evidence", status: "partial" as const, source: "knowledge" as const, evidence: includedWeakCandidateAudits.map((item) => item.matchedKnowledgeId), evidenceLevel: "weak_candidate" as const, sourceProposalId: weakCandidateIds[0], targetPageStatus: "unverified" as const },
        { item: "missing_verified_asset_record_page", status: "missing" as const, source: "knowledge" as const, evidence: ["candidate evidence available but target page is unverified"], evidenceLevel: "weak_candidate" as const, sourceProposalId: weakCandidateIds[0], targetPageStatus: "unverified" as const },
        { item: "missing_asset_filter_locator", status: "missing" as const, source: "knowledge" as const, evidence: ["USDT filter locator is not verified"], evidenceLevel: "weak_candidate" as const, sourceProposalId: weakCandidateIds[0], targetPageStatus: "unverified" as const },
        { item: "missing_asset_record_assertion", status: "missing" as const, source: "knowledge" as const, evidence: ["list or empty-state assertion is not verified"], evidenceLevel: "weak_candidate" as const, sourceProposalId: weakCandidateIds[0], targetPageStatus: "unverified" as const }
      ] : []),
      ...businessFlowCoverage.evidence
    ],
    preflightChecks: businessFlowCoverage.preflightChecks,
    runtimeResolvable,
    gaps,
    explorationNeeded: status !== "sufficient"
  };
}

function parseAssistantPlanJson(content: string): unknown {
  const trimmed = content.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced ?? trimmed;
  return JSON.parse(candidate);
}

function normalizeAssistantPlan(
  value: unknown,
  fallback: AssistantPlan,
  input: { project: string; env: string; message: string }
): AssistantPlan {
  if (!value || typeof value !== "object") return fallback;
  const raw = value as Partial<AssistantPlan>;
  const normalizedSteps = Array.isArray(raw.steps) && raw.steps.length > 0 ? raw.steps.map(normalizeAssistantStep) : fallback.steps;
  return {
    intent: String(raw.intent ?? input.message),
    project: String(raw.project ?? input.project),
    env: input.env,
    account: raw.account ? String(raw.account) : fallback.account,
    steps: sanitizeAssistantPlanSteps(normalizedSteps, input),
    assertions: Array.isArray(raw.assertions) ? raw.assertions : fallback.assertions,
    requiresConfirmation: shouldAssistantPlanRequireConfirmation(raw, fallback, input),
    openQuestions: [
      ...new Set([
        ...(Array.isArray(raw.openQuestions) ? raw.openQuestions.map(String) : []),
        ...(fallback.requiresConfirmation ? fallback.openQuestions : [])
      ])
    ],
    intentSpec: normalizeAssistantIntentSpec(raw.intentSpec, fallback.intentSpec),
    retrievalBundle: normalizeAssistantRetrievalBundle(raw.retrievalBundle, fallback.retrievalBundle),
    coverage: buildAssistantCoverage(input.message, fallback.intentSpec, fallback.retrievalBundle)
  };
}

function shouldAssistantPlanRequireConfirmation(
  raw: Partial<AssistantPlan>,
  fallback: AssistantPlan,
  input: { message: string }
): boolean {
  const intent = normalizeAssistantIntentSpec(raw.intentSpec, fallback.intentSpec);
  const retrieval = normalizeAssistantRetrievalBundle(raw.retrievalBundle, fallback.retrievalBundle);
  const coverage = buildAssistantCoverage(input.message, intent, retrieval);
  const rawRequires = Boolean(raw.requiresConfirmation ?? fallback.requiresConfirmation) || fallback.requiresConfirmation;
  if (intent?.operationType === "read" && retrieval?.status === "sufficient" && retrieval.gaps.length === 0 && (coverage?.uncoveredGoals.length ?? 0) === 0) {
    return false;
  }
  return rawRequires;
}

function normalizeAssistantIntentSpec(value: unknown, fallback?: AssistantIntentSpec): AssistantIntentSpec | undefined {
  if (!value || typeof value !== "object") return fallback;
  const raw = value as Partial<AssistantIntentSpec>;
  const base = fallback;
  const operationType = raw.operationType === "read" || raw.operationType === "write" || raw.operationType === "unknown" ? raw.operationType : base?.operationType ?? "unknown";
  const normalizedModule = String(raw.module ?? base?.module ?? "unknown");
  const module = normalizedModule === "unknown" && base?.module && base.module !== "unknown" ? base.module : normalizedModule;
  const normalizedAction = String(raw.action ?? base?.action ?? "unknown");
  const action = (normalizedAction === "unknown" || normalizedAction === "read-page") && base?.action && base.action !== "unknown" ? base.action : normalizedAction;
  return {
    schemaVersion: "intent.v1",
    rawRequest: String(raw.rawRequest ?? base?.rawRequest ?? ""),
    project: String(raw.project ?? base?.project ?? ""),
    env: String(raw.env ?? base?.env ?? ""),
    language: String(raw.language ?? base?.language ?? "zh-hans"),
    module,
    submodule: raw.submodule ? String(raw.submodule) : base?.submodule,
    action,
    operationType,
    targetPage:
      raw.targetPage && typeof raw.targetPage === "object"
        ? { name: stringOrUndefined((raw.targetPage as Record<string, unknown>).name), urlHint: stringOrUndefined((raw.targetPage as Record<string, unknown>).urlHint) }
        : base?.targetPage,
    entities: raw.entities && typeof raw.entities === "object" ? (raw.entities as Record<string, unknown>) : base?.entities ?? {},
    preconditions: Array.isArray(raw.preconditions)
      ? (raw.preconditions as unknown[])
          .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
          .map((item) => ({
            name: String(item.name ?? "unknown"),
            required: Boolean(item.required ?? true),
            status: item.status === "known" || item.status === "required" || item.status === "missing" || item.status === "unknown" ? item.status : "unknown",
            source: stringOrUndefined(item.source),
            evidence: stringOrUndefined(item.evidence)
          }))
      : base?.preconditions ?? [],
    expectedOutcome: Array.isArray(raw.expectedOutcome) ? raw.expectedOutcome.map(String) : base?.expectedOutcome ?? [],
    retrievalQueries: Array.isArray(raw.retrievalQueries) ? raw.retrievalQueries.map(String) : base?.retrievalQueries ?? [],
    recommendedAutomationLayer:
      raw.recommendedAutomationLayer === "api" || raw.recommendedAutomationLayer === "hybrid" || raw.recommendedAutomationLayer === "manual" || raw.recommendedAutomationLayer === "web-ui"
        ? raw.recommendedAutomationLayer
        : base?.recommendedAutomationLayer ?? "web-ui",
    riskLevel: raw.riskLevel === "low" || raw.riskLevel === "medium" || raw.riskLevel === "high" ? raw.riskLevel : base?.riskLevel ?? "medium",
    confidence: clampNumber(Number(raw.confidence ?? base?.confidence ?? 0.5), 0, 1),
    ambiguities: module === "unknown" ? (Array.isArray(raw.ambiguities) ? raw.ambiguities.map(String) : base?.ambiguities ?? []) : [],
    evidence: Array.isArray(raw.evidence) ? (raw.evidence as DomainVocabularyEvidence[]) : base?.evidence
  };
}

function normalizeAssistantRetrievalBundle(value: unknown, fallback?: AssistantRetrievalBundle): AssistantRetrievalBundle | undefined {
  if (!value || typeof value !== "object") return fallback;
  const raw = value as Partial<AssistantRetrievalBundle>;
  const status =
    raw.status === "sufficient" || raw.status === "partial" || raw.status === "insufficient" || raw.status === "candidate_only"
      ? raw.status
      : fallback?.status ?? "insufficient";
  return {
    schemaVersion: "retrieval.v1",
    status,
    retrievalQueries: Array.isArray(raw.retrievalQueries) ? raw.retrievalQueries.map(String) : fallback?.retrievalQueries ?? [],
    pageCandidates: Array.isArray(raw.pageCandidates) ? (raw.pageCandidates as AssistantRetrievalBundle["pageCandidates"]) : fallback?.pageCandidates ?? [],
    elementCandidates: Array.isArray(raw.elementCandidates) ? (raw.elementCandidates as AssistantRetrievalBundle["elementCandidates"]) : fallback?.elementCandidates ?? [],
    businessFlowCandidates: Array.isArray(raw.businessFlowCandidates) ? (raw.businessFlowCandidates as AssistantRetrievalBundle["businessFlowCandidates"]) : fallback?.businessFlowCandidates ?? [],
    knowledgeHits: Array.isArray(raw.knowledgeHits) ? (raw.knowledgeHits as AssistantRetrievalBundle["knowledgeHits"]) : fallback?.knowledgeHits ?? [],
    knowledgeAudit: Array.isArray(raw.knowledgeAudit) ? (raw.knowledgeAudit as KnowledgeRerankAudit[]) : fallback?.knowledgeAudit ?? [],
    coverageEvidence: Array.isArray(raw.coverageEvidence) ? (raw.coverageEvidence as CoverageEvidence[]) : fallback?.coverageEvidence ?? [],
    preflightChecks: Array.isArray(raw.preflightChecks) ? (raw.preflightChecks as PreflightCheck[]) : fallback?.preflightChecks ?? [],
    runtimeResolvable: Array.isArray(raw.runtimeResolvable) ? raw.runtimeResolvable.map(String) : fallback?.runtimeResolvable ?? [],
    gaps: Array.isArray(raw.gaps) ? raw.gaps.map(String) : fallback?.gaps ?? [],
    explorationNeeded: Boolean(raw.explorationNeeded ?? fallback?.explorationNeeded ?? status !== "sufficient")
  };
}

function candidateMetadataFromRecord(value: unknown): CandidateEvidenceMetadata {
  return layerEvidenceMetadata(value) as CandidateEvidenceMetadata;
}

function pageEvidenceMetadataFromRecord(value: unknown): CandidateEvidenceMetadata {
  return layerEvidenceMetadata(value, "self") as CandidateEvidenceMetadata;
}

function nestedCandidateMetadataFromRecord(value: unknown): CandidateEvidenceMetadata {
  return layerEvidenceMetadata(value, "nestedCandidate") as CandidateEvidenceMetadata;
}

function candidateEvidenceFields(value: unknown): CandidateEvidenceMetadata {
  const metadata = candidateMetadataFromRecord(value);
  return Object.fromEntries(Object.entries(metadata).filter(([, item]) => item !== undefined)) as CandidateEvidenceMetadata;
}

function isWeakCandidateRetrievalItem(item: CandidateEvidenceMetadata): boolean {
  return isWeakLayeredEvidence(item as LayeredEvidenceMetadata);
}

function retrievalHasWeakCandidate(retrieval: AssistantRetrievalBundle): boolean {
  if (retrieval.status === "sufficient") return false;
  return (
    retrieval.status === "candidate_only" ||
    retrieval.pageCandidates.some(isWeakCandidateRetrievalItem) ||
    retrieval.elementCandidates.some(isWeakCandidateRetrievalItem) ||
    (retrieval.knowledgeHits ?? []).some(isWeakCandidateRetrievalItem) ||
    (retrieval.knowledgeAudit ?? []).some((item) => item.included && item.evidenceLevel === "weak_candidate") ||
    (retrieval.coverageEvidence ?? []).some((item) => item.evidenceLevel === "weak_candidate" || item.status === "partial")
  );
}

function primaryWeakCandidate(retrieval: AssistantRetrievalBundle): CandidateEvidenceMetadata | undefined {
  if (retrieval.status === "sufficient") return undefined;
  return (
    retrieval.pageCandidates.find(isWeakCandidateRetrievalItem) ??
    retrieval.elementCandidates.find(isWeakCandidateRetrievalItem) ??
    (retrieval.knowledgeHits ?? []).find(isWeakCandidateRetrievalItem) ??
    (retrieval.knowledgeAudit ?? []).find((item) => item.included && item.evidenceLevel === "weak_candidate")
  );
}

function buildAssistantCoverage(message: string, intent?: AssistantIntentSpec, retrieval?: AssistantRetrievalBundle): AssistantPlan["coverage"] {
  const requiredGoals = [...new Set([...(intent?.expectedOutcome ?? []), ...deriveMessageGoals(message, intent)])];
  const coveredGoals: string[] = [];
  const hasWeakCandidate = retrieval ? retrievalHasWeakCandidate(retrieval) : false;
  if (!hasWeakCandidate && (retrieval?.pageCandidates.length || intent?.targetPage?.urlHint)) coveredGoals.push("target_page");
  if (!hasWeakCandidate && retrieval?.elementCandidates.length) coveredGoals.push("interactive_elements");
  if (!hasWeakCandidate && intent?.operationType === "read" && (retrieval?.pageCandidates.length || intent.targetPage?.urlHint)) coveredGoals.push("read_goal");
  if (intent?.operationType === "write" && (retrieval?.status === "sufficient" || retrieval?.coverageEvidence?.some((item) => item.item === "write_action_locator" && (item.status === "covered" || item.status === "runtime_resolvable")))) coveredGoals.push("write_goal");
  const uncoveredGoals = [
    ...requiredGoals.filter((goal) => !coveredGoals.includes(goal)),
    ...((hasWeakCandidate ? retrieval?.gaps ?? [] : []).filter((gap) => /partial_candidate|missing_verified|missing_asset/i.test(gap)))
  ].filter((item, index, list) => list.indexOf(item) === index);
  return {
    requiredGoals,
    coveredGoals,
    uncoveredGoals,
    evidence: retrieval?.coverageEvidence ?? [],
    runtimeResolvable: retrieval?.runtimeResolvable ?? [],
    preflightChecks: retrieval?.preflightChecks ?? []
  };
}

async function attachAssistantStageDiagnostics(context: LoadedContext, input: { project: string; env: string; message: string }, plan: AssistantPlan, model: string): Promise<AssistantPlan> {
  const intent = plan.intentSpec ?? buildMinimalAssistantIntent(input, plan);
  const retrieval = plan.retrievalBundle ?? buildEmptyRetrievalBundle();
  const coverage: NonNullable<AssistantPlan["coverage"]> = plan.coverage ?? buildAssistantCoverage(input.message, intent, retrieval) ?? {
    requiredGoals: [],
    coveredGoals: [],
    uncoveredGoals: [],
    evidence: [],
    runtimeResolvable: [],
    preflightChecks: []
  };
  const evidence = collectAssistantEvidence(intent, retrieval);
  const rawDslDraft = applyReadOnlyDslGuard(buildAssistantDslDraft(input, plan, intent, retrieval, evidence));
  const ruleApplication = await applyAssistantDslGenerationRules(context, rawDslDraft);
  const dslDraft = ruleApplication.dsl;
  const dslReview = buildAssistantDslReview(input, dslDraft, coverage, retrieval);
  const coverageExplanation = buildAssistantCoverageExplanation(coverage, retrieval, evidence);
  const preflightDecision = buildAssistantPreflightDecision(retrieval, dslDraft);
  const providerCalls = buildAssistantProviderCallPlaceholders(input, dslDraft);
  const stages: AssistantAiStages = {
    requirementUnderstanding: withStageModel(
      createLocalAiStageEnvelope({
        stage: "requirement_understanding",
        inputSummary: { project: input.project, env: input.env, requestLength: input.message.length },
        parsedOutput: intent,
        evidence,
        confidence: intent.confidence,
        uncertainty: intent.ambiguities
      }),
      model
    ),
    retrievalRerank: withStageModel(
      createLocalAiStageEnvelope({
        stage: "retrieval_rerank",
        inputSummary: { queries: retrieval.retrievalQueries, hitCount: retrieval.knowledgeHits.length },
        parsedOutput: {
          status: retrieval.status,
          audit: retrieval.knowledgeAudit ?? [],
          included: (retrieval.knowledgeAudit ?? []).filter((item) => item.included),
          excludedOrDemoted: (retrieval.knowledgeAudit ?? []).filter((item) => !item.included || /demote/i.test(item.rerankReason))
        },
        evidence,
        confidence: retrieval.status === "sufficient" ? 0.85 : retrieval.status === "partial" ? 0.6 : 0.35,
        uncertainty: retrieval.gaps
      }),
      model
    ),
    evidenceFusion: withStageModel(
      createLocalAiStageEnvelope({
        stage: "evidence_fusion",
        inputSummary: {
          pages: retrieval.pageCandidates.length,
          elements: retrieval.elementCandidates.length,
          businessFlows: retrieval.businessFlowCandidates?.length ?? 0,
          coverageEvidence: retrieval.coverageEvidence?.length ?? 0
        },
        parsedOutput: {
          evidence,
          pageCandidates: retrieval.pageCandidates,
          elementCandidates: retrieval.elementCandidates,
          businessFlowCandidates: retrieval.businessFlowCandidates ?? [],
          conflicts: detectAssistantEvidenceConflicts(intent, retrieval)
        },
        evidence,
        confidence: evidence.length ? 0.75 : 0.3,
        uncertainty: retrieval.gaps
      }),
      model
    ),
    dslDraft: withStageModel(
      createLocalAiStageEnvelope({
        stage: "dsl_draft",
        inputSummary: { module: intent.module, action: intent.action, operationType: intent.operationType, appliedRules: dslDraft.appliedRules ?? [] },
        parsedOutput: dslDraft,
        evidence: dslDraft.steps.flatMap((step) => step.evidence),
        confidence: Math.min(0.9, Math.max(0.35, dslDraft.steps.reduce((sum, step) => sum + step.aiConfidence, 0) / Math.max(1, dslDraft.steps.length))),
        uncertainty: dslReview.blocking
      }),
      model
    ),
    dslReview: withStageModel(
      createLocalAiStageEnvelope({
        stage: "dsl_review",
        inputSummary: { stepCount: dslDraft.steps.length, providerDependencies: dslDraft.providerDependencies },
        parsedOutput: dslReview,
        evidence,
        confidence: dslReview.blocking.length ? 0.45 : 0.8,
        uncertainty: [...dslReview.blocking, ...dslReview.askUser]
      }),
      model
    ),
    coverageExplanation: withStageModel(
      createLocalAiStageEnvelope({
        stage: "coverage_explanation",
        inputSummary: { requiredGoals: coverage.requiredGoals, uncoveredGoals: coverage.uncoveredGoals },
        parsedOutput: coverageExplanation,
        evidence: coverageExplanation.items.flatMap((item) => item.evidence),
        confidence: coverageExplanation.blockingGaps.length ? 0.55 : 0.82,
        uncertainty: coverageExplanation.blockingGaps
      }),
      model
    ),
    preflightDecision: withStageModel(
      createLocalAiStageEnvelope({
        stage: "preflight_decision",
        inputSummary: { preflightChecks: retrieval.preflightChecks ?? [], providerDependencies: dslDraft.providerDependencies },
        parsedOutput: preflightDecision,
        evidence,
        confidence: preflightDecision.decision === "block" ? 0.6 : 0.8,
        uncertainty: preflightDecision.blockingReasons
      }),
      model
    )
  };
  return { ...plan, intentSpec: intent, retrievalBundle: retrieval, coverage, aiStages: stages, dslDraft, dslReview, coverageExplanation, preflightDecision, providerCalls };
}

async function applyAssistantDslGenerationRules(context: LoadedContext, dslDraft: DslDraft): Promise<{ dsl: DslDraft }> {
  try {
    const store = new DslGenerationRuleStore(context);
    const storeData = await store.load();
    return applyDslGenerationRulesToDraft({ dsl: dslDraft, rules: storeData.rules });
  } catch (error) {
    logger.warn("DSL generation rules skipped during assistant planning", {
      project: context.project.projectKey,
      env: context.env.env,
      error: error instanceof Error ? error.message : String(error)
    });
    return { dsl: { ...dslDraft, appliedRules: [] } };
  }
}

function withStageModel<T>(envelope: AiStageEnvelope<T>, model: string): AiStageEnvelope<T> {
  return { ...envelope, model: model === "deepseek" ? "deepseek-or-local-structured" : envelope.model };
}

function buildMinimalAssistantIntent(input: { project: string; env: string; message: string }, plan: AssistantPlan): AssistantIntentSpec {
  return {
    schemaVersion: "intent.v1",
    rawRequest: input.message,
    project: input.project,
    env: input.env,
    language: "zh-hans",
    module: "unknown",
    action: "unknown",
    operationType: isWriteIntentMessage(input.message) ? "write" : "read",
    entities: {},
    preconditions: [],
    expectedOutcome: plan.assertions.length ? ["target_page", "interactive_elements"] : ["target_page"],
    retrievalQueries: assistantSearchTerms(input.message),
    recommendedAutomationLayer: "web-ui",
    riskLevel: "medium",
    confidence: 0.3,
    ambiguities: ["intentSpec missing from plan"]
  };
}

function buildEmptyRetrievalBundle(): AssistantRetrievalBundle {
  return {
    schemaVersion: "retrieval.v1",
    status: "insufficient",
    retrievalQueries: [],
    pageCandidates: [],
    elementCandidates: [],
    businessFlowCandidates: [],
    knowledgeHits: [],
    knowledgeAudit: [],
    coverageEvidence: [],
    preflightChecks: [],
    runtimeResolvable: [],
    gaps: ["retrievalBundle missing from plan"],
    explorationNeeded: true
  };
}

function collectAssistantEvidence(intent: AssistantIntentSpec, retrieval: AssistantRetrievalBundle): EvidenceRef[] {
  const evidence: EvidenceRef[] = [];
  if (intent.confidence > 0) evidence.push({ source: "ai_inferred", id: "intent", quote: `${intent.module}.${intent.action}`, confidence: intent.confidence });
  for (const page of retrieval.pageCandidates.slice(0, 6)) {
    evidence.push({
      source: "page_map",
      id: page.id ?? page.url ?? page.urlPattern,
      quote: page.title ?? page.url ?? page.urlPattern,
      confidence: page.score,
      ...candidateEvidenceFields(page)
    });
  }
  for (const flow of (retrieval.businessFlowCandidates ?? []).slice(0, 6)) {
    evidence.push({ source: "business_flow", id: flow.flowId, quote: flow.name ?? flow.flowId, confidence: flow.score });
  }
  for (const hit of retrieval.knowledgeHits.slice(0, 8)) {
    evidence.push({ source: "knowledge", id: hit.title, quote: hit.content.slice(0, 240), confidence: hit.confidence, ...candidateEvidenceFields(hit) });
  }
  for (const item of retrieval.coverageEvidence ?? []) {
    evidence.push({
      source: mapCoverageEvidenceSource(item.source),
      id: item.item,
      quote: item.evidence.join("; ").slice(0, 240),
      confidence: item.status === "covered" ? 0.9 : item.status === "runtime_resolvable" ? 0.65 : item.status === "partial" ? 0.45 : 0.2,
      ...candidateEvidenceFields(item)
    });
  }
  return evidence;
}

function mapCoverageEvidenceSource(source: CoverageEvidence["source"]): EvidenceRef["source"] {
  if (source === "page_map") return "page_map";
  if (source === "business_flow") return "business_flow";
  if (source === "account_profile") return "account_profile";
  if (source === "config") return "config";
  return "knowledge";
}

function buildAssistantDslDraft(
  input: { project: string; env: string; message: string },
  plan: AssistantPlan,
  intent: AssistantIntentSpec,
  retrieval: AssistantRetrievalBundle,
  evidence: EvidenceRef[]
): DslDraft {
  const slots = extractAssistantSlots(input.message, plan as unknown as Record<string, unknown>);
  const providerDependencies = inferAssistantProviderDependencies(input.message, intent);
  const data: Record<string, unknown> = { ...intent.entities };
  if (slots.asset) data.asset = slots.asset;
  if (slots.amount) data.amount = Number(slots.amount);
  if (slots.count) data.count = Number(slots.count);
  const pageEvidence = evidence.find((item) => item.source === "page_map" || item.source === "business_flow" || item.source === "knowledge");
  const weakCandidate = primaryWeakCandidate(retrieval);
  const candidateEvidence = weakCandidate
    ? evidence.find((item) => item.sourceProposalId === weakCandidate.sourceProposalId) ?? {
        source: "knowledge" as const,
        id: weakCandidate.sourceProposalId,
        quote: "candidate evidence available but unverified",
        confidence: 0.45,
        evidenceLevel: "weak_candidate" as const,
        sourceProposalId: weakCandidate.sourceProposalId,
        status: weakCandidate.status,
        retrievalWeight: weakCandidate.retrievalWeight,
        targetPageStatus: weakCandidate.targetPageStatus
      }
    : undefined;
  const steps: DslDraftStep[] = [];
  if (intent.targetPage?.urlHint || retrieval.pageCandidates.length) {
    const pageCandidate = retrieval.pageCandidates[0];
    steps.push({
      id: "navigate-target-page",
      action: "navigate",
      pageId: pageCandidate?.id,
      semanticLocator: intent.targetPage?.name,
      exactSelector: intent.targetPage?.urlHint,
      inputValue: intent.targetPage?.urlHint ?? pageCandidate?.url ?? pageCandidate?.urlPattern,
      runtimeResolvable: !intent.targetPage?.urlHint,
      evidence: [candidateEvidence ?? pageEvidence ?? { source: "ai_inferred", id: "target-page", quote: intent.targetPage?.name ?? "target page", confidence: 0.45 }],
      evidenceLevel: pageCandidate?.evidenceLevel,
      sourceProposalId: pageCandidate?.sourceProposalId,
      candidateStatus: pageCandidate?.status,
      targetPageStatus: pageCandidate?.targetPageStatus,
      aiConfidence: candidateEvidence ? 0.45 : intent.targetPage?.urlHint ? 0.8 : 0.55
    });
  }
  const flowEvidence = evidence.filter((item) => item.source === "business_flow");
  const elementEvidence = retrieval.elementCandidates.slice(0, 8);
  for (const step of plan.steps.slice(0, 12)) {
    steps.push({
      id: `plan-${steps.length + 1}`,
      action: step.action,
      semanticLocator: step.target,
      exactSelector: isLocatorLike(String(step.target ?? "")) ? String(step.target) : undefined,
      inputValue: step.value,
      runtimeResolvable: !isLocatorLike(String(step.target ?? "")),
      evidence: candidateEvidence && /资金流水|璧勯噾娴佹按|asset|record|流水/i.test(`${step.target ?? ""} ${step.reason ?? ""}`) ? [candidateEvidence] : flowEvidence.length ? flowEvidence.slice(0, 3) : [{ source: "ai_inferred", id: step.action, quote: step.reason ?? step.target ?? step.action, confidence: 0.5 }],
      evidenceLevel: candidateEvidence && /资金流水|璧勯噾娴佹按|asset|record|流水/i.test(`${step.target ?? ""} ${step.reason ?? ""}`) ? "weak_candidate" : undefined,
      sourceProposalId: candidateEvidence && /资金流水|璧勯噾娴佹按|asset|record|流水/i.test(`${step.target ?? ""} ${step.reason ?? ""}`) ? candidateEvidence.sourceProposalId : undefined,
      candidateStatus: candidateEvidence && /资金流水|璧勯噾娴佹按|asset|record|流水/i.test(`${step.target ?? ""} ${step.reason ?? ""}`) ? "candidate" : undefined,
      targetPageStatus: candidateEvidence && /资金流水|璧勯噾娴佹按|asset|record|流水/i.test(`${step.target ?? ""} ${step.reason ?? ""}`) ? "unverified" : undefined,
      aiConfidence: candidateEvidence && /资金流水|璧勯噾娴佹按|asset|record|流水/i.test(`${step.target ?? ""} ${step.reason ?? ""}`) ? 0.45 : step.source === "business_flow" ? 0.85 : 0.55
    });
  }
  if (intent.module === "red-packet" && intent.action === "create" && !steps.some((step) => /create|red|packet|红包|创建|发放/i.test(`${step.semanticLocator ?? ""} ${step.action}`))) {
    steps.push({
      id: "semantic-create-red-packet",
      action: "click",
      semanticLocator: "create red packet button",
      runtimeResolvable: true,
      evidence: flowEvidence.length ? flowEvidence.slice(0, 3) : [{ source: "ai_inferred", id: "red-packet.create", quote: "create red packet semantic action", confidence: 0.55 }],
      aiConfidence: flowEvidence.length ? 0.75 : 0.45
    });
  }
  if (intent.module === "red-packet" && intent.action === "create") {
    ensureRedPacketCreateFieldSteps(steps, data, flowEvidence);
  }
  if (isAssetOverviewIntent(intent)) {
    ensureAssetOverviewReadSteps(steps, data, retrieval, evidence);
  }
  for (const candidate of elementEvidence) {
    if (steps.length >= 16) break;
    steps.push({
      id: `element-${steps.length + 1}`,
      action: candidate.role === "button" ? "click" : "input",
      elementRef: candidate.selector ?? candidate.text,
      semanticLocator: candidate.text,
      exactSelector: candidate.selector,
      runtimeResolvable: !candidate.selector,
      evidence: [{ source: "page_map", id: candidate.selector ?? candidate.text, quote: candidate.text ?? candidate.selector, confidence: candidate.score }],
      aiConfidence: candidate.selector ? 0.8 : 0.6
    });
  }
  for (const provider of providerDependencies) {
    steps.push({
      id: `provider-${provider.replace(/[^a-z0-9]+/gi, "-")}`,
      action: "input",
      providerDependency: provider,
      semanticLocator: provider.includes("redis") ? "email verification code input" : "GA TOTP input",
      runtimeResolvable: true,
      evidence: [{ source: "provider", id: provider, quote: "provider dependency declared by user request", confidence: 0.8 }],
      aiConfidence: 0.8
    });
  }
  return {
    schemaVersion: "dsl-draft.v1",
    project: input.project,
    env: input.env,
    module: intent.module,
    action: intent.action,
    operationType: intent.operationType,
    loginRequired: intent.preconditions.some((item) => /login|登录/i.test(item.name)) || /login|登录/i.test(input.message),
    data,
    providerDependencies,
    steps,
    assertions: plan.assertions.map((item) => ({ ...item })),
    clarificationQuestions: plan.openQuestions
  };
}

function ensureAssetOverviewReadSteps(steps: DslDraftStep[], data: Record<string, unknown>, retrieval: AssistantRetrievalBundle, fallbackEvidence: EvidenceRef[]): void {
  const verifiedPage = retrieval.pageCandidates.find((item) => item.evidenceLevel === "verified" && /asset|total-assets|\u8d44\u4ea7/i.test(`${item.id ?? ""} ${item.title ?? ""} ${item.urlPattern ?? ""} ${item.url ?? ""}`));
  const assetList = retrieval.elementCandidates.find((item) => item.evidenceLevel === "verified" && /asset_list|\u8d44\u4ea7\u5217\u8868|\u5e01\u79cd|text=\u5e01\u79cd/i.test(`${item.text ?? ""} ${item.selector ?? ""}`));
  const usdtRow = retrieval.elementCandidates.find((item) => item.evidenceLevel === "verified" && /usdt|tether/i.test(`${item.text ?? ""} ${item.selector ?? ""}`));
  const pageEvidence = verifiedPage
    ? [{ source: "page_map" as const, id: verifiedPage.id, quote: verifiedPage.title ?? verifiedPage.urlPattern ?? verifiedPage.id, confidence: 0.82, evidenceLevel: "verified" as const, sourceProposalId: verifiedPage.sourceProposalId, targetPageStatus: "verified" as const }]
    : fallbackEvidence.filter((item) => item.source === "page_map").slice(0, 2);
  const assetElementEvidence = [assetList, usdtRow]
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .map((item) => ({ source: "page_map" as const, id: item.selector ?? item.text, quote: item.text ?? item.selector, confidence: Math.min(0.9, item.score / 10), evidenceLevel: "verified" as const, sourceProposalId: item.sourceProposalId, targetPageStatus: "verified" as const }));
  const evidence = assetElementEvidence.length ? assetElementEvidence : pageEvidence.length ? pageEvidence : [{ source: "ai_inferred" as const, id: "asset.overview", quote: "asset overview read steps", confidence: 0.45 }];

  if (!steps.some((step) => step.id === "asset-overview-open-page") && verifiedPage) {
    steps.push({
      id: "asset-overview-open-page",
      action: "navigate",
      pageId: verifiedPage.id,
      semanticName: "\u8d44\u4ea7\u603b\u89c8",
      semanticLocator: "\u8d44\u4ea7\u603b\u89c8",
      inputValue: verifiedPage.url ?? verifiedPage.urlPattern,
      runtimeResolvable: false,
      evidence: pageEvidence.length ? pageEvidence : evidence,
      evidenceLevel: "verified",
      sourceProposalId: verifiedPage.sourceProposalId,
      targetPageStatus: "verified",
      aiConfidence: 0.82
    });
  }
  if (!steps.some((step) => step.id === "asset-overview-check-list")) {
    steps.push({
      id: "asset-overview-check-list",
      action: "assert",
      targetField: "asset_list",
      semanticName: "\u8d44\u4ea7\u5217\u8868",
      semanticLocator: "\u8d44\u4ea7\u5217\u8868",
      exactSelector: assetList?.selector,
      runtimeResolvable: !assetList?.selector,
      assertion: { type: "visible", target: assetList?.selector ?? "\u8d44\u4ea7\u5217\u8868" },
      evidence,
      evidenceLevel: assetList ? "verified" : undefined,
      sourceProposalId: assetList?.sourceProposalId,
      targetPageStatus: assetList ? "verified" : undefined,
      aiConfidence: assetList ? 0.82 : 0.55
    });
  }
  if (!steps.some((step) => step.id === "asset-overview-assert-usdt-row")) {
    const asset = typeof data.asset === "string" ? data.asset : "USDT";
    steps.push({
      id: "asset-overview-assert-usdt-row",
      action: "assert",
      targetField: "asset_row",
      semanticName: `${asset} \u8d44\u4ea7\u884c`,
      semanticLocator: `${asset} \u8d44\u4ea7\u884c`,
      exactSelector: usdtRow?.selector,
      inputValue: asset,
      valueSource: "intent.data.asset",
      runtimeResolvable: !usdtRow?.selector,
      assertion: { type: "list_contains_or_empty_state", target: usdtRow?.selector ?? asset, expected: asset, fallback: "asset_list_empty_state" },
      evidence,
      evidenceLevel: usdtRow ? "verified" : undefined,
      sourceProposalId: usdtRow?.sourceProposalId,
      targetPageStatus: usdtRow ? "verified" : undefined,
      aiConfidence: usdtRow ? 0.84 : 0.58
    });
  }
}

function ensureRedPacketCreateFieldSteps(steps: DslDraftStep[], data: Record<string, unknown>, flowEvidence: EvidenceRef[]): void {
  const evidence = flowEvidence.length ? flowEvidence.slice(0, 3) : [{ source: "ai_inferred" as const, id: "red-packet.create.fields", quote: "red packet create field binding", confidence: 0.55 }];
  if (!steps.some((step) => step.targetField === "red_packet_asset")) {
    steps.push({
      id: "input-red-packet-asset",
      action: "select",
      targetField: "red_packet_asset",
      semanticName: "红包币种",
      semanticLocator: "红包币种",
      inputValue: data.asset,
      valueSource: "intent.data.asset",
      runtimeResolvable: true,
      evidence,
      aiConfidence: 0.72
    });
  }
  if (!steps.some((step) => step.targetField === "red_packet_amount")) {
    steps.push({
      id: "input-red-packet-amount",
      action: "input",
      targetField: "red_packet_amount",
      semanticName: "红包金额",
      semanticLocator: "红包金额",
      inputValue: data.amount,
      valueSource: "intent.data.amount",
      runtimeResolvable: true,
      evidence,
      aiConfidence: 0.72
    });
  }
  if (!steps.some((step) => step.targetField === "red_packet_count")) {
    steps.push({
      id: "input-red-packet-count",
      action: "input",
      targetField: "red_packet_count",
      semanticName: "红包个数",
      semanticLocator: "红包个数",
      inputValue: "DEMO",
      valueSource: "legacy.dsl.step.value",
      runtimeResolvable: true,
      evidence,
      aiConfidence: 0.72
    });
  }
}

function inferAssistantProviderDependencies(message: string, intent: AssistantIntentSpec): string[] {
  const text = `${message} ${JSON.stringify(intent.entities)}`;
  const providers: string[] = [];
  if (/邮箱|email/i.test(text) && /验证码|code|verification/i.test(text)) providers.push("redis:email");
  if (/\bGA\b|Google Authenticator|谷歌|totp|TOTP|动态验证码/i.test(text)) providers.push("keepassxc:totp");
  return [...new Set(providers)];
}

function buildAssistantDslReview(input: { message: string }, dsl: DslDraft, coverage: NonNullable<AssistantPlan["coverage"]>, retrieval: AssistantRetrievalBundle): DslReview {
  const blocking: string[] = [];
  const runtimeResolvable = dsl.steps.filter((step) => step.runtimeResolvable).map((step) => step.id);
  const askUser: string[] = [];
  const assumed: string[] = [];
  if (dsl.steps.length === 0) blocking.push("dsl.steps.empty");
  if (!dsl.assertions.length && /断言|期望|成功|失败|assert|expect/i.test(input.message)) askUser.push("assertion.selector_or_message");
  if (retrievalHasWeakCandidate(retrieval)) {
    askUser.push("verify_candidate_entry", "collect_asset_record_page", "confirm_filter_and_assertion");
  }
  for (const check of retrieval.preflightChecks ?? []) {
    if (/asset\.balance|kyc|permission|权限/i.test(check.name) && check.status === "unknown") {
      assumed.push(`${check.name}:unknown-not-blocking-planner`);
    }
  }
  for (const gap of coverage.uncoveredGoals) {
    if (/balance|kyc|permission|权限/i.test(gap)) assumed.push(`${gap}:planner-assumed`);
  }
  return {
    schemaVersion: "dsl-review.v1",
    blocking,
    runtimeResolvable,
    askUser,
    assumed,
    assertionCandidates: dsl.assertions.length ? dsl.assertions : inferAssistantOutcomeAssertions(input.message, { intent: `${dsl.module}.${dsl.action}` } as Record<string, unknown>).map((item) => ({ ...item })),
    providerDependencies: dsl.providerDependencies
  };
}

function buildAssistantCoverageExplanation(coverage: NonNullable<AssistantPlan["coverage"]>, retrieval: AssistantRetrievalBundle, fallbackEvidence: EvidenceRef[]): CoverageExplanation {
  const items: CoverageExplanation["items"] = [];
  for (const goal of coverage.requiredGoals) {
    const related = (coverage.evidence ?? []).filter((item) => item.item === goal || (goal === "write_goal" && item.item === "write_action_locator"));
    const hasCovered = coverage.coveredGoals.includes(goal) || related.some((item) => item.status === "covered");
    const hasRuntime = related.some((item) => item.status === "runtime_resolvable") || (coverage.runtimeResolvable ?? []).includes(goal);
    const status: "covered" | "partial" | "missing" = hasCovered ? "covered" : hasRuntime ? "partial" : "missing";
    const isPlannerSoftGap = /balance|kyc|permission|权限/i.test(goal);
    const blocking = status === "missing" && !isPlannerSoftGap && goal !== "interactive_elements";
    items.push({
      item: goal,
      status,
      blocking,
      runtimeResolvable: hasRuntime,
      evidence: related.length ? related.flatMap(coverageEvidenceToEvidenceRef) : fallbackEvidence.slice(0, 3),
      explanation: coverageExplanationText(goal, status, blocking, hasRuntime, isPlannerSoftGap)
    });
  }
  for (const item of retrieval.coverageEvidence ?? []) {
    if (items.some((existing) => existing.item === item.item)) continue;
    const status = item.status === "covered" ? "covered" : item.status === "runtime_resolvable" || item.status === "partial" ? "partial" : "missing";
    const blocking = status === "missing" && item.item !== "write_action_locator";
    items.push({
      item: item.item,
      status,
      blocking,
      runtimeResolvable: item.status === "runtime_resolvable" || item.status === "partial",
      evidence: coverageEvidenceToEvidenceRef(item),
      explanation: coverageExplanationText(item.item, status, blocking, item.status === "runtime_resolvable" || item.status === "partial", false)
    });
  }
  return {
    schemaVersion: "coverage-explanation.v1",
    items,
    blockingGaps: items.filter((item) => item.blocking).map((item) => item.item),
    runtimeResolvableGaps: items.filter((item) => item.runtimeResolvable).map((item) => item.item)
  };
}

function coverageEvidenceToEvidenceRef(item: CoverageEvidence): EvidenceRef[] {
  return item.evidence.length
    ? item.evidence.map((text, index) => ({
        source: mapCoverageEvidenceSource(item.source),
        id: `${item.item}:${index}`,
        quote: text,
        confidence: item.status === "covered" ? 0.9 : item.status === "runtime_resolvable" ? 0.65 : item.status === "partial" ? 0.45 : 0.2,
        ...candidateEvidenceFields(item)
      }))
    : [{ source: mapCoverageEvidenceSource(item.source), id: item.item, quote: item.locatorLevel ?? item.status, confidence: item.status === "covered" ? 0.9 : item.status === "partial" ? 0.45 : 0.25, ...candidateEvidenceFields(item) }];
}

function coverageExplanationText(goal: string, status: "covered" | "partial" | "missing", blocking: boolean, runtimeResolvable: boolean, softGap: boolean): string {
  if (status === "covered") return `${goal} is covered by structured evidence.`;
  if (runtimeResolvable) return `${goal} has semantic evidence and can be resolved at runtime; planner must not block.`;
  if (softGap) return `${goal} is a business precondition and is not a planner blocker.`;
  return blocking ? `${goal} is missing required planning evidence.` : `${goal} is missing but not blocking at planning stage.`;
}

function buildAssistantPreflightDecision(retrieval: AssistantRetrievalBundle, dsl: DslDraft): PreflightDecision {
  const warnings: string[] = [];
  const assumed: string[] = [];
  const blockingReasons: string[] = [];
  const hasWeakCandidate = retrievalHasWeakCandidate(retrieval);
  if (hasWeakCandidate) {
    warnings.push(
      "candidate evidence available but unverified",
      "verify_candidate_entry",
      "collect_asset_record_page",
      "confirm_filter_and_assertion"
    );
  }
  for (const check of retrieval.preflightChecks ?? []) {
    if (check.status === "unknown" && check.blocksExecution) {
      blockingReasons.push(check.name);
    } else if (check.status === "unknown") {
      assumed.push(`${check.name}:unknown`);
    } else {
      warnings.push(`${check.name}:${check.status}`);
    }
  }
  for (const provider of dsl.providerDependencies) warnings.push(`${provider}:preflight-required`);
  return {
    schemaVersion: "preflight-decision.v1",
    decision: blockingReasons.length ? "block" : hasWeakCandidate ? "askUser" : warnings.length || assumed.length ? "degradedContinue" : "continue",
    ready: !blockingReasons.length && !hasWeakCandidate,
    recommendedNextAction: hasWeakCandidate ? "verify_candidate_entry" : blockingReasons.length ? "resolve_blocking_preflight" : "continue",
    blockingReasons,
    warnings,
    assumed
  };
}

function buildAssistantProviderCallPlaceholders(input: { project: string; env: string }, dsl: DslDraft): ProviderCallRecord[] {
  return dsl.providerDependencies.map((provider) => {
    const at = new Date().toISOString();
    return {
      provider,
      operation: "preflight_dependency_declared",
      scene: provider.includes("redis") ? "email" : "totp",
      startedAt: at,
      endedAt: at,
      elapsedMs: 0,
      status: "skipped",
      errorCode: "not_executed_in_planning",
      errorMessage: "Provider call is deferred to preflight/execution.",
      requestSummary: { project: input.project, env: input.env, provider }
    };
  });
}

function detectAssistantEvidenceConflicts(intent: AssistantIntentSpec, retrieval: AssistantRetrievalBundle): string[] {
  const conflicts: string[] = [];
  if (intent.module === "red-packet" && intent.action === "create") {
    const claimAudit = (retrieval.knowledgeAudit ?? []).filter((item) => /demote:claim_receive/i.test(item.rerankReason));
    if (claimAudit.length) conflicts.push("red-packet.create request had claim/receive evidence demoted during rerank");
  }
  return conflicts;
}

function deriveMessageGoals(message: string, intent?: AssistantIntentSpec): string[] {
  const goals = ["target_page"];
  if (requiresConcreteInteractionIntent(message)) goals.push("interactive_elements");
  if (intent?.operationType === "write") goals.push("write_goal");
  if (intent?.operationType === "read") goals.push("read_goal");
  return goals;
}

function extractSpotPair(message: string, slots: Record<string, string>): string | undefined {
  const pairMatch = message.match(/\b([A-Z]{2,12})[_/-]?(USDT|USDC|BTC|ETH)\b/i);
  if (pairMatch) return `${pairMatch[1].toUpperCase()}_${pairMatch[2].toUpperCase()}`;
  if (slots.asset && slots.asset !== "USDT" && /\bUSDT\b/i.test(message)) return `${slots.asset}_USDT`;
  return undefined;
}

function inferIntentTargetPage(input: { project: string; env: string }, module: string, pair?: string): AssistantIntentSpec["targetPage"] {
  if (module === "spot") return { name: "spot trading", urlHint: pair ? `/zh-hans/spot/${pair}` : "/zh-hans/spot" };
  if (module === "earn") return { name: "earn", urlHint: "/zh-hans/earn" };
  if (module === "asset" || module === "wallet") return { name: "asset records", urlHint: "/zh-hans/assets/total-assets" };
  if (module === "withdraw") return { name: "withdraw", urlHint: "/zh-hans/assets/withdraw" };
  if (module === "red-packet") return { name: "red packet", urlHint: "/zh-hans/assets/red-packet" };
  return assistantKnownBaseUrl(input) ? { name: "environment base", urlHint: assistantKnownBaseUrl(input) } : undefined;
}

function inferIntentExpectedOutcomes(module: string, action: string, operationType: AssistantIntentSpec["operationType"]): string[] {
  if (module === "spot" && operationType === "write") return ["target_page", "interactive_elements", "write_goal"];
  if (module === "red-packet" && action === "view-record") return ["target_page", "interactive_elements", "read_goal"];
  if (operationType === "write") return ["target_page", "write_goal"];
  return ["target_page", "read_goal"];
}

function stringEntitySlots(entities: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(Object.entries(entities).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function isWriteIntentMessage(message: string): boolean {
  if (isRedPacketRecordIntent(message)) return false;
  if (/(\u73b0\u8d27.{0,20}(\u4e0b\u5355|\u4e70\u5165|\u5356\u51fa)|(\u4e0b\u5355|\u4e70\u5165|\u5356\u51fa).{0,20}\u73b0\u8d27|spot.{0,20}(order|buy|sell)|(order|buy|sell).{0,20}spot)/i.test(message)) return true;
  if (/(\u7ea2\u5305.{0,20}(\u9886\u53d6|\u53e3\u4ee4|\u53d1\u653e|\u521b\u5efa)|(\u9886\u53d6|\u53e3\u4ee4|\u53d1\u653e|\u521b\u5efa).{0,20}\u7ea2\u5305|claim.{0,20}red\s*packet|red\s*packet.{0,20}claim)/i.test(message)) return true;
  if (/(\u521b\u5efa|\u65b0\u589e|\u4fee\u6539|\u5220\u9664|\u63d0\u4ea4|\u53d1\u653e|\u4e0b\u5355|\u914d\u7f6e|\u7ef4\u62a4|\u7533\u8bf7|\u7533\u8d2d|\u8d2d\u4e70|\u8ba4\u8d2d|\u5ba1\u6838|create|add|update|delete|submit|issue|bonus|coupon|campaign|approve|subscribe|purchase|buy)/i.test(message)) return true;
  return /(create|add|update|delete|submit|issue|red\s*packet|bonus|coupon|campaign|approve|subscribe|purchase|buy)/i.test(message);
}

function isRedPacketRecordIntent(message: string): boolean {
  return /\u7ea2\u5305/.test(message) && /(\u8bb0\u5f55|\u660e\u7ec6|\u67e5\u770b|\u70b9\u51fb|record|history|detail)/i.test(message);
}

function resolveAssistantEnv(selectedEnv: string, message: string): string {
  if (/\buat\b/i.test(message)) return "uat";
  if (/\btest\b/i.test(message)) return "test";
  return selectedEnv;
}

function requiresConcreteInteractionIntent(message: string): boolean {
  return isRedPacketRecordIntent(message) || /(\u70b9\u51fb|\u67e5\u770b|\u6253\u5f00|click|open|view).{0,20}(\u8bb0\u5f55|\u660e\u7ec6|record|history|detail)/i.test(message);
}

function sanitizeAssistantPlanSteps(steps: AssistantPlanStep[], input: { project: string; env: string; message: string }): AssistantPlanStep[] {
  if (!isRedPacketRecordIntent(input.message)) return steps;
  const baseUrl = assistantKnownBaseUrl(input);
  const redPacketUrl = baseUrl ? new URL("zh-hans/assets/red-packet", `${baseUrl}/`).toString() : undefined;
  const recordText = "\u7ea2\u5305\u8bb0\u5f55";
  const clickTarget = `xpath=//button[.//*[normalize-space()='${recordText}'] or contains(normalize-space(.), '${recordText}')]`;
  const next = steps.map((step) =>
    /^(openEntry|navigate|openUrl|goto)$/i.test(step.action) && redPacketUrl
      ? { ...step, target: redPacketUrl, source: "knowledge-planner", reason: "Open the inferred red packet page before clicking the record card." }
      : step
  );
  if (!next.some((step) => /^(click|tap|press)$/i.test(step.action) && String(step.target ?? "").includes(recordText))) {
    next.push({
      action: "click",
      target: clickTarget,
      source: "knowledge-planner",
      riskLevel: "low",
      reason: "Click the red packet record card after opening the red packet page."
    });
  }
  return next;
}

function assistantKnownBaseUrl(input: { project: string; env: string }): string | undefined {
  if (input.project === "demo" && input.env === "uat") return "https://www.example.com";
  if (input.project === "demo" && input.env === "test") return "http://www.example.com";
  return undefined;
}

function normalizeAssistantStep(value: unknown): AssistantPlanStep {
  if (!value || typeof value !== "object") return { action: "manualDecision", reason: String(value) };
  const raw = value as Partial<AssistantPlanStep>;
  return {
    action: String(raw.action ?? "unknown"),
    target: raw.target ? String(raw.target) : undefined,
    value: raw.value,
    source: raw.source ? String(raw.source) : undefined,
    riskLevel: raw.riskLevel,
    reason: raw.reason ? String(raw.reason) : undefined
  };
}

function extractAssistantEntryUrl(plan: Record<string, unknown>): string | undefined {
  const steps = Array.isArray(plan.steps) ? plan.steps : [];
  for (const step of steps) {
    if (!step || typeof step !== "object") continue;
    const raw = step as Record<string, unknown>;
    if (String(raw.action ?? "") === "openEntry" && raw.target && /^https?:\/\//i.test(String(raw.target))) {
      return String(raw.target);
    }
  }
  return undefined;
}

function extractHoldSeconds(text: string): number {
  const match = text.match(/(?:停留|等待|hold|wait)\s*(\d+)\s*(?:秒|s|sec|seconds)?/i);
  return match ? Math.min(300, Math.max(0, Number(match[1]))) : 0;
}

function isRegistrationInputIntent(message: string, plan?: Record<string, unknown>): boolean {
  const steps = Array.isArray(plan?.steps) ? plan.steps : [];
  const hasInputStep = steps.some((step) => {
    if (!step || typeof step !== "object") return false;
    const raw = step as Record<string, unknown>;
    return /^(input|fill|type)$/i.test(String(raw.action ?? ""));
  });
  const hasSignupStep = steps.some((step) => {
    if (!step || typeof step !== "object") return false;
    const raw = step as Record<string, unknown>;
    return /注册|signup|sign\s*up|register/i.test(`${String(raw.target ?? "")} ${String(raw.reason ?? "")}`);
  });
  return (
    (/注册|signup|sign\s*up|register/i.test(message) || hasSignupStep) &&
    (/输入|填写|填入|type|fill/i.test(message) || hasInputStep)
  );
}

function extractInputText(message: string, plan?: Record<string, unknown>): string | undefined {
  const steps = Array.isArray(plan?.steps) ? plan.steps : [];
  for (const step of steps) {
    if (!step || typeof step !== "object") continue;
    const raw = step as Record<string, unknown>;
    if (/^(input|fill|type)$/i.test(String(raw.action ?? "")) && raw.value !== undefined) return String(raw.value);
  }
  const patterns = [
    /(?:用户名|账号|邮箱|手机号|手机|user(?:name)?|account|email|mobile)\s*(?:输入|填写|填入|为|=|:|：)\s*([^\s，,。；;]+)/i,
    /(?:输入|填写|填入)\s*([A-Za-z0-9@._+-]{3,})/i
  ];
  for (const pattern of patterns) {
    const match = message.match(pattern);
    if (match?.[1]) return match[1].trim();
  }
  return undefined;
}

async function executeRegistrationInputTask(
  baseUrl: string | undefined,
  inputText: string
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  if (!baseUrl) {
    return { exitCode: 1, stdout: "", stderr: "当前环境没有配置 web.baseUrl，无法打开注册页。" };
  }
  const signupUrl = `${baseUrl.replace(/\/$/, "")}/signup`;
  const startedAt = new Date().toISOString();
  logger.info("Assistant lightweight registration input started", { signupUrl, inputText });
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  const lines: string[] = [];
  try {
    lines.push(`打开注册页：${signupUrl}`);
    await page.goto(signupUrl, { waitUntil: "domcontentloaded", timeout: 20_000 }).catch(async (error) => {
      logger.warn("Registration page domcontentloaded timeout, retrying with commit", {
        signupUrl,
        error: error instanceof Error ? error.message : String(error)
      });
      await page.goto(signupUrl, { waitUntil: "commit", timeout: 10_000 });
      await page.waitForTimeout(1_000);
    });
    await dismissAssistantOverlays(page);
    const filledSelector = await fillFirstRegistrationInput(page, inputText);
    lines.push(`已输入：${inputText}`);
    lines.push(`定位方式：${filledSelector}`);
    const screenshotPath = path.join(rootDir, "artifacts", "assistant", `registration-input-${Date.now()}.png`);
    await fs.ensureDir(path.dirname(screenshotPath));
    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => undefined);
    lines.push(`截图：${screenshotPath}`);
    lines.push("浏览器将停留 60 秒用于人工确认，未点击提交。");
    logger.info("Assistant lightweight registration input completed", {
      signupUrl: page.url(),
      inputText,
      filledSelector,
      screenshotPath,
      startedAt
    });
    await page.waitForTimeout(60_000);
    return { exitCode: 0, stdout: lines.join("\n"), stderr: "" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("Assistant lightweight registration input failed", { signupUrl, inputText, error: message });
    return { exitCode: 1, stdout: lines.join("\n"), stderr: message };
  } finally {
    await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
}

async function fillFirstRegistrationInput(page: Page, inputText: string): Promise<string> {
  const selectors = [
    "input:not([type='password']):not([type='checkbox']):not([type='hidden'])",
    "[role='textbox']",
    "textarea"
  ];
  for (const selector of selectors) {
    const locator = page.locator(selector);
    const count = await locator.count().catch(() => 0);
    for (let index = 0; index < Math.min(count, 10); index += 1) {
      const item = locator.nth(index);
      if (!(await item.isVisible({ timeout: 500 }).catch(() => false))) continue;
      await item.fill(inputText, { timeout: 3_000 });
      let actual = await item.inputValue({ timeout: 1_000 }).catch(() => "");
      if (actual !== inputText) {
        await item.evaluate((element, value) => {
          const input = element as HTMLInputElement | HTMLTextAreaElement;
          const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
          setter?.call(input, value);
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
        }, inputText);
        actual = await item.inputValue({ timeout: 1_000 }).catch(() => "");
      }
      if (actual !== inputText) {
        await item.click({ timeout: 1_000 }).catch(() => undefined);
        await page.keyboard.press("Control+A").catch(() => undefined);
        await page.keyboard.type(inputText, { delay: 20 }).catch(() => undefined);
        actual = await item.inputValue({ timeout: 1_000 }).catch(() => "");
      }
      if (actual !== inputText) throw new Error(`输入框赋值后校验失败，期望 ${inputText}，实际 ${actual || "<empty>"}`);
      return `${selector} nth=${index}`;
    }
  }
  await page.getByText(/手机号|手机|邮箱|账号|用户名/i).first().click({ timeout: 2_000 }).catch(() => undefined);
  for (const selector of selectors) {
    const item = page.locator(selector).first();
    if (!(await item.isVisible({ timeout: 1_000 }).catch(() => false))) continue;
    await item.fill(inputText, { timeout: 3_000 });
    const actual = await item.inputValue({ timeout: 1_000 }).catch(() => "");
    if (actual !== inputText) throw new Error(`输入框赋值后校验失败，期望 ${inputText}，实际 ${actual || "<empty>"}`);
    return `${selector} after-tab`;
  }
  throw new Error("未找到可填写的注册输入框。");
}

async function dismissAssistantOverlays(page: Page): Promise<void> {
  const targets = [
    page.getByRole("button", { name: /^(我已知晓|知道了|我知道了|确认|确定|同意|允许|接受|关闭|OK|Accept|Close)$/i }),
    page.locator("[aria-label='Close'],[aria-label='close'],[aria-label='关闭']"),
    page.locator(".ant-modal-close,.el-dialog__headerbtn,.modal-close,.modal__close,.close-icon,.close")
  ];
  for (const target of targets) {
    const count = await target.count().catch(() => 0);
    for (let index = 0; index < Math.min(count, 3); index += 1) {
      const item = target.nth(index);
      if (!(await item.isVisible({ timeout: 300 }).catch(() => false))) continue;
      await item.click({ timeout: 800 }).catch(() => undefined);
      await page.waitForTimeout(200);
      return;
    }
  }
}

type AssistantAutomationSource = "page_model" | "business_flow" | "assistant_plan" | "knowledge_planner" | "none";

interface AssistantAutomationBuildResult {
  source: AssistantAutomationSource;
  testCase?: AutomationCase;
  reason?: string;
  planner?: AssistantKnowledgePlan;
}

interface AssistantKnowledgePlan {
  intent: string;
  terms: string[];
  slots: Record<string, string>;
  targetPage?: {
    url: string;
    title?: string;
    score: number;
    source: "page_graph" | "page_state" | "env_base";
  };
  candidateElements: Array<{
    role?: string;
    text?: string;
    selector?: string;
    href?: string;
    purpose: "product" | "amount" | "action" | "assertion" | "navigation" | "unknown";
    score: number;
  }>;
  confidence: number;
  gaps: string[];
}

async function buildAssistantAutomationCase(
  context: LoadedContext,
  input: { project: string; env: string; message: string; plan: Record<string, unknown> }
): Promise<AssistantAutomationBuildResult> {
  let fromFlow = await buildAutomationCaseFromBusinessFlow(context, input);
  const flowCoverageGap = fromFlow.testCase ? validateAssistantExecutableCoverage(input, fromFlow.testCase) : undefined;
  if (fromFlow.testCase && !flowCoverageGap) return fromFlow;
  if (flowCoverageGap) fromFlow = { source: "none", reason: `Business flow rejected by coverage validator: ${flowCoverageGap}` };
  let fromPlan = buildAutomationCaseFromAssistantPlan(context, input);
  const planCoverageGap = fromPlan.testCase ? validateAssistantExecutableCoverage(input, fromPlan.testCase) : undefined;
  if (fromPlan.testCase && !planCoverageGap) return fromPlan;
  if (planCoverageGap) fromPlan = { source: "none", reason: `Assistant plan rejected by coverage validator: ${planCoverageGap}` };
  const fromKnowledge = await buildAutomationCaseFromKnowledgePlanner(context, input, [fromFlow.reason, fromPlan.reason].filter(Boolean).join(" "));
  const knowledgeCoverageGap = fromKnowledge.testCase ? validateAssistantExecutableCoverage(input, fromKnowledge.testCase) : undefined;
  if (fromKnowledge.testCase && !knowledgeCoverageGap) return fromKnowledge;
  if (knowledgeCoverageGap) return { source: "none", reason: `Knowledge planner rejected by coverage validator: ${knowledgeCoverageGap}`, planner: fromKnowledge.planner };
  return fromKnowledge.reason ? fromKnowledge : { source: "none", reason: [fromFlow.reason, fromPlan.reason].filter(Boolean).join(" ") };
}

function validateAssistantExecutableCoverage(
  input: { message: string; plan: Record<string, unknown> },
  testCase: AutomationCase
): string | undefined {
  const intent = normalizeAssistantIntentSpec(input.plan.intentSpec, undefined);
  const retrieval = normalizeAssistantRetrievalBundle(input.plan.retrievalBundle, undefined);
  const actions = testCase.steps.map((step) => step.action.toLowerCase());
  const hasNavigation = actions.some((action) => action === "navigate");
  const hasInput = actions.some((action) => ["input", "fill", "type", "select"].includes(action));
  const hasClick = actions.some((action) => ["click", "tap", "press", "confirmwrite"].includes(action));
  const hasAssert = actions.some((action) => action === "assert") || testCase.assertions.length > 0;
  const nonPassiveActions = actions.filter((action) => !["navigate", "wait", "assert"].includes(action));
  if (!testCase.steps.length) return "no executable steps were generated";
  if (intent?.operationType === "write") {
    const blockingRetrievalGaps = (retrieval?.gaps ?? []).filter((gap) => gap !== "test_balance_status" && !(gap === "write_action_locator" && retrieval?.runtimeResolvable?.includes("write_action_locator")));
    const writeEvidence = retrieval?.coverageEvidence?.find((item) => item.item === "write_action_locator");
    if (!retrieval || (blockingRetrievalGaps.length > 0 && writeEvidence?.status !== "covered" && writeEvidence?.status !== "runtime_resolvable")) {
      return `retrieval is not fully grounded for write intent: ${blockingRetrievalGaps.join(", ") || retrieval?.status || "missing retrieval bundle"}`;
    }
    if (!hasInput) return "write intent has no input/select step for test data";
    if (!hasClick) return "write intent has no click/confirm step for submitting or reaching the write action";
  }
  if (requiresConcreteInteractionIntent(input.message) && nonPassiveActions.length === 0) {
    return "request requires an in-page interaction but only passive steps were generated";
  }
  if (intent?.operationType === "read" && !hasNavigation && !hasAssert) return "read intent has no navigation or assertion";
  const coverage = input.plan.coverage && typeof input.plan.coverage === "object" ? (input.plan.coverage as AssistantPlan["coverage"]) : undefined;
  const uncovered = coverage?.uncoveredGoals?.filter((goal) => {
    if (goal === "target_page") return !hasNavigation;
    if (goal === "interactive_elements") return !hasClick && !hasInput;
    if (goal === "write_goal") return intent?.operationType === "write" && (!hasInput || !hasClick);
    if (goal === "read_goal") return intent?.operationType === "read" && !hasAssert && !hasClick;
    return false;
  });
  return uncovered?.length ? `uncovered goals: ${uncovered.join(", ")}` : undefined;
}

async function buildAutomationCaseFromBusinessFlow(
  context: LoadedContext,
  input: { project: string; env: string; message: string; plan: Record<string, unknown> }
): Promise<AssistantAutomationBuildResult> {
  const [flowData, pageData] = await Promise.all([new BusinessFlowStore(context).load(), new PageStateStore(context).load()]);
  const terms = assistantIntentTerms(input.message, input.plan);
  const candidates = flowData.flows
    .filter((flow) => flow.project_id === input.project && flow.env === input.env && flow.platform === "web")
    .map((flow) => ({ flow, score: scoreBusinessFlow(flow, terms, pageData.transitions), explanation: explainBusinessFlowScore(flow, terms, pageData.transitions) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => businessFlowRank(b.flow, b.score) - businessFlowRank(a.flow, a.score) || a.flow.transition_ids.length - b.flow.transition_ids.length);
  logger.info("Assistant business flow candidates", {
    project: input.project,
    env: input.env,
    terms,
    candidates: candidates.slice(0, 8).map((item) => ({
      flowId: item.flow.flow_id,
      name: item.flow.name,
      targetFlows: item.flow.target_flows,
      transitionCount: item.flow.transition_ids.length,
      score: item.score,
      rank: businessFlowRank(item.flow, item.score),
      identityScore: item.explanation.identityScore,
      transitionScore: item.explanation.transitionScore,
      matchedTerms: item.explanation.matchedTerms
    }))
  });
  const selected = candidates
    .filter((item) => item.flow.transition_ids.length <= 20)
    .filter((item) => !rejectAssistantBusinessFlowForRequest(item.flow, input.message))
    [0]?.flow;
  if (!selected) {
    const reason = candidates.length
      ? "Matched only broad exploratory business flows; no short executable business flow is available for this assistant request."
      : "No stored business flow matched the assistant request.";
    return { source: "none", reason };
  }
  const startPage = pageData.states.find((state) => state.page_id === selected.start_page_id);
  const steps: DslStep[] = [];
  if (startPage?.url_pattern) steps.push({ id: `open-${selected.start_page_id}`, action: "navigate", semantic_target: startPage.page_name || "business flow start page", target: startPage.url_pattern, collect_snapshot: true });
  for (const transitionId of selected.transition_ids) {
    const transition = pageData.transitions.find((item) => item.transition_id === transitionId);
    if (transition) steps.push(...transition.dsl_steps.map((step) => materializeAssistantStep(step, input.message, input.plan)));
  }
  const finalizedSteps = steps.map((step) => forceAssistantStructuredInputValues(step, input.plan));
  if (!steps.length) return { source: "none", reason: `Matched business flow ${selected.flow_id}, but it has no DSL steps.` };
  return {
    source: "business_flow",
    testCase: {
      id: `assistant_flow_${selected.flow_id}_${Date.now()}`,
      title: `Assistant flow: ${selected.name}`,
      type: "web",
      project: input.project,
      module: selected.name || "assistant-flow",
      priority: selected.risk_level === "high" ? "P1" : "P2",
      tags: ["assistant", "business-flow", selected.flow_id],
      owner: "ai-assistant",
      env: [input.env],
      steps: finalizedSteps,
      assertions: inferAssistantOutcomeAssertions(input.message, input.plan)
    }
  };
}

function buildAutomationCaseFromAssistantPlan(
  context: LoadedContext,
  input: { project: string; env: string; message: string; plan: Record<string, unknown> }
): AssistantAutomationBuildResult {
  const rawSteps = Array.isArray(input.plan.steps) ? input.plan.steps : [];
  const unsupportedActions = rawSteps
    .map((raw) => (raw && typeof raw === "object" ? String((raw as Record<string, unknown>).action ?? "").toLowerCase() : ""))
    .filter((action) => action && !isAssistantIgnoredPlanAction(action) && !isAssistantSupportedPlanAction(action));
  const steps = rawSteps
    .map((raw, index) => (raw && typeof raw === "object" ? assistantPlanStepToDsl(raw as Record<string, unknown>, index, context) : undefined))
    .filter((step): step is DslStep => Boolean(step))
    .map((step) => forceAssistantStructuredInputValues(materializeAssistantStep(step, input.message, input.plan), input.plan));
  if (unsupportedActions.length) return { source: "none", reason: `Assistant plan contains unsupported actions: ${[...new Set(unsupportedActions)].join(", ")}.` };
  if (!steps.length) return { source: "none", reason: "Assistant plan did not contain executable DSL actions." };
  if (requiresConcreteInteractionIntent(input.message) && !steps.some((step) => ["click", "input"].includes(step.action))) {
    return { source: "none", reason: "Assistant plan only contained navigation for a request that requires an in-page interaction." };
  }
  if ((Boolean(input.plan.requiresConfirmation) || isWriteIntentMessage(input.message)) && !steps.some((step) => ["click", "input", "assert", "wait"].includes(step.action))) {
    return { source: "none", reason: "Assistant plan only contained navigation steps for a write task; concrete DSL actions are missing." };
  }
  return {
    source: "assistant_plan",
    testCase: {
      id: `assistant_plan_${Date.now()}`,
      title: `Assistant plan: ${String(input.plan.intent ?? input.message).slice(0, 80)}`,
      type: "web",
      project: input.project,
      module: "assistant-plan",
      priority: "P2",
      tags: ["assistant", "plan-generated"],
      owner: "ai-assistant",
      env: [input.env],
      steps,
      assertions: [...normalizeAssistantAssertions(input.plan.assertions), ...inferAssistantOutcomeAssertions(input.message, input.plan)]
    }
  };
}

async function buildAutomationCaseFromKnowledgePlanner(
  context: LoadedContext,
  input: { project: string; env: string; message: string; plan: Record<string, unknown> },
  previousReason: string
): Promise<AssistantAutomationBuildResult> {
  const planner = await buildAssistantKnowledgePlan(context, input.message, input.plan);
  if (!planner.targetPage?.url) {
    return {
      source: "none",
      reason: [previousReason, "Knowledge planner could not identify a target page."].filter(Boolean).join(" "),
      planner
    };
  }
  const steps: DslStep[] = [
    {
      id: "knowledge-open-target",
      action: "navigate",
      target: planner.targetPage.url,
      semantic_target: `knowledge planner target: ${planner.targetPage.title ?? planner.targetPage.url}`,
      collect_snapshot: true
    },
    {
      id: "knowledge-observe-target",
      action: "wait",
      semantic_target: "observe target page",
      timeout_ms: 2500,
      collect_snapshot: true
    }
  ];
  steps.push({
    id: "knowledge-assert-target-signal",
    action: "assert",
    semantic_target: "target page signal",
    assertion: { type: "textVisibleAny", target: "target page signal", expected: targetPageSignals(planner) },
    value: {
      planner: {
        intent: planner.intent,
        slots: planner.slots,
        targetPage: planner.targetPage,
        confidence: planner.confidence,
        gaps: planner.gaps,
        candidateElements: planner.candidateElements.slice(0, 12)
      }
    },
    collect_snapshot: true
  });
  const concreteIntentSteps = buildKnowledgeConcreteIntentSteps(planner, input.message);
  steps.push(...concreteIntentSteps);
  if (isWriteIntentMessage(input.message) && concreteIntentSteps.length === 0) {
    steps.push({
      id: "knowledge-missing-concrete-write-flow",
      action: "fail",
      semantic_target: "missing concrete write flow",
      target: input.message,
      value: `Knowledge planner reached the inferred target page, but no approved concrete DSL flow exists for the requested write action: ${input.message}`,
      collect_snapshot: true
    });
  }
  const assertions = inferAssistantOutcomeAssertions(input.message, input.plan);
  return {
    source: "knowledge_planner",
    reason: [previousReason, planner.gaps.join(" ")].filter(Boolean).join(" "),
    planner,
    testCase: {
      id: `assistant_knowledge_${Date.now()}`,
      title: `Knowledge planner: ${input.message.slice(0, 80)}`,
      type: "web",
      project: input.project,
      module: planner.slots.module ?? "knowledge-planner",
      priority: "P2",
      tags: ["assistant", "knowledge-planner", "exploratory-execute"],
      owner: "ai-assistant",
      env: [input.env],
      steps,
      assertions
    }
  };
}

function buildKnowledgeConcreteIntentSteps(planner: AssistantKnowledgePlan, message: string): DslStep[] {
  if (planner.slots.module === "red-packet" && isRedPacketRecordIntent(message)) {
    const recordText = "\u7ea2\u5305\u8bb0\u5f55";
    const detailText = "\u7ea2\u5305\u660e\u7ec6";
    const viewText = "\u67e5\u770b";
    const claimRecordText = "\u9886\u53d6\u8bb0\u5f55";
    const issueRecordText = "\u53d1\u653e\u8bb0\u5f55";
    const primary = `xpath=//button[.//*[normalize-space()='${recordText}'] or contains(normalize-space(.), '${recordText}')]`;
    return [
      {
        id: "knowledge-click-red-packet-record",
        action: "click",
        semantic_target: recordText,
        primary_locator: primary,
        fallback_locators: [
          `role=button:${detailText}${recordText}${viewText}${claimRecordText}\u548c${issueRecordText}${viewText}`,
          `xpath=//button[contains(normalize-space(.), '${recordText}') and contains(normalize-space(.), '${viewText}')]`,
          `text=${recordText}`
        ],
        allow_healing: true,
        max_healing_level: 3,
        collect_snapshot: true,
        timeout_ms: 8000,
        retry_count: 1
      },
      {
        id: "knowledge-assert-red-packet-record-opened",
        action: "assert",
        semantic_target: "\u7ea2\u5305\u8bb0\u5f55\u9875\u9762",
        assertion: {
          type: "textVisibleAny",
          target: "\u7ea2\u5305\u8bb0\u5f55\u9875\u9762\u4fe1\u53f7",
          expected: [recordText, claimRecordText, issueRecordText, detailText]
        },
        collect_snapshot: true
      }
    ];
  }
  return [];
}

async function buildAssistantKnowledgePlan(context: LoadedContext, message: string, plan: Record<string, unknown>): Promise<AssistantKnowledgePlan> {
  const terms = assistantIntentTerms(message, plan);
  const slots = extractAssistantSlots(message, plan);
  logger.info("Assistant knowledge planner parsed intent", {
    project: context.project.projectKey,
    env: context.env.env,
    messagePreview: message.slice(0, 200),
    messageCodePoints: [...message.slice(0, 80)].map((char) => char.codePointAt(0)?.toString(16)).filter(Boolean),
    terms,
    slots,
    isWriteIntent: isWriteIntentMessage(message)
  });
  const [graph, pageData] = await Promise.all([new PageGraphStore(context).load(), new PageStateStore(context).load()]);
  const graphCandidates = graph.nodes
    .filter((node) => node.platform === "web")
    .map((node) => {
      const text = pageNodeSearchText(node);
      const score = scoreKnowledgeTarget(text, terms, slots);
      return { node, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || String(a.node.url ?? "").length - String(b.node.url ?? "").length);
  const stateCandidates = pageData.states
    .map((state) => {
      const text = `${state.page_name ?? ""} ${state.title ?? ""} ${state.url_pattern ?? ""} ${state.known_elements.join(" ")}`.toLowerCase();
      const score = scoreKnowledgeTarget(text, terms, slots);
      return { state, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || String(a.state.url_pattern ?? "").length - String(b.state.url_pattern ?? "").length);
  const bestGraph = graphCandidates[0];
  const bestState = stateCandidates[0];
  const envUrl = inferTargetUrlFromSlots(context, slots);
  const graphUrl = materializeAssistantTargetUrl(context, bestGraph?.node.url ?? bestGraph?.node.urlPattern);
  const stateUrl = materializeAssistantTargetUrl(context, bestState?.state.url_pattern);
  const targetPage =
    envUrl && slots.module
      ? { url: envUrl, title: slots.module, score: Math.max(bestGraph?.score ?? 0, bestState?.score ?? 0, 1), source: "env_base" as const }
      : graphUrl && (!bestState || bestGraph.score >= bestState.score)
      ? { url: graphUrl, title: bestGraph.node.title ?? bestGraph.node.semanticName, score: bestGraph.score, source: "page_graph" as const }
      : stateUrl
        ? { url: stateUrl, title: bestState.state.page_name ?? bestState.state.title, score: bestState.score, source: "page_state" as const }
        : envUrl
          ? { url: envUrl, title: slots.module ?? "environment target", score: 1, source: "env_base" as const }
          : undefined;
  const pageElements = bestGraph?.node.elements ?? [];
  const stateElements = bestState?.state.known_elements.map((item) => ({ text: item.startsWith("text=") ? item.slice(5) : undefined, selector: isLocatorLike(item) ? item : undefined, role: "known", riskLevel: "low" as const, lastSeenAt: new Date().toISOString(), elementId: item })) ?? [];
  const candidateElements = [...pageElements, ...stateElements]
    .map((element) => classifyKnowledgeElement(element, terms, slots))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 30);
  const gaps: string[] = [];
  if (!candidateElements.some((item) => item.purpose === "amount")) gaps.push("No amount input candidate was confidently identified.");
  if (!candidateElements.some((item) => item.purpose === "action")) gaps.push("No subscribe/purchase action candidate was confidently identified.");
  if (!targetPage?.url) gaps.push("No target URL was identified from local knowledge.");
  return {
    intent: String(plan.intent ?? message),
    terms,
    slots,
    targetPage,
    candidateElements,
    confidence: Math.min(1, ((targetPage?.score ?? 0) + candidateElements.length / 10) / 10),
    gaps
  };
}

function assistantPlanStepToDsl(raw: Record<string, unknown>, index: number, context: LoadedContext): DslStep | undefined {
  const action = String(raw.action ?? "").toLowerCase();
  const target = raw.target ? String(raw.target) : undefined;
  const semantic = target ?? String(raw.reason ?? raw.action ?? `step-${index + 1}`);
  if (/^(bypasslogin|loginwithaccount|manualdecision|inspectknownpage|followknownpath|preparewriteoperation|executereadonlygoal)$/i.test(action)) return undefined;
  if (/^(openentry|navigate|openurl|goto)$/i.test(action)) {
    const entry = target && /^https?:\/\//i.test(target) ? target : context.env.web?.baseUrl;
    return entry ? { id: `assistant-step-${index + 1}`, action: "navigate", target: entry, semantic_target: semantic, collect_snapshot: true } : undefined;
  }
  if (/^(input|fill|type|setvalue)$/i.test(action)) {
    const valueFrom = normalizeAssistantValueFrom(raw.valueFrom, raw.value, semantic);
    return {
      id: `assistant-step-${index + 1}`,
      action: "input",
      semantic_target: semantic,
      primary_locator: target && isLocatorLike(target) ? target : undefined,
      value: raw.value,
      valueFrom,
      collect_snapshot: true
    };
  }
  if (/^(click|tap|press)$/i.test(action)) return { id: `assistant-step-${index + 1}`, action: "click", semantic_target: semantic, primary_locator: target && isLocatorLike(target) ? target : undefined, collect_snapshot: true };
  if (/^(wait|waitfortext|waitfor)$/i.test(action)) return { id: `assistant-step-${index + 1}`, action: "wait", semantic_target: semantic, primary_locator: target && isLocatorLike(target) ? target : target ? `text=${target}` : undefined, timeout_ms: 10_000 };
  if (/^(assert|expect|verify)$/i.test(action)) {
    const expected = raw.value ?? (target?.startsWith("text=") ? target.slice(5) : target);
    const assertionTarget = target?.startsWith("text=") ? target.slice(5) : target;
    if (assertionTarget && /\u7ea2\u5305\u8bb0\u5f55|\u7ea2\u5305\u660e\u7ec6|\u9886\u53d6\u8bb0\u5f55|\u53d1\u653e\u8bb0\u5f55/.test(assertionTarget)) {
      return {
        id: `assistant-step-${index + 1}`,
        action: "assert",
        semantic_target: semantic,
        assertion: {
          type: "textVisibleAny",
          target: "\u7ea2\u5305\u8bb0\u5f55\u9875\u9762\u4fe1\u53f7",
          expected: ["\u7ea2\u5305\u8bb0\u5f55", "\u9886\u53d6\u8bb0\u5f55", "\u53d1\u653e\u8bb0\u5f55", "\u7ea2\u5305\u660e\u7ec6"]
        }
      };
    }
    return { id: `assistant-step-${index + 1}`, action: "assert", semantic_target: semantic, assertion: { type: "textVisible", target: assertionTarget, expected } };
  }
  return undefined;
}

function isAssistantIgnoredPlanAction(action: string): boolean {
  return /^(bypasslogin|loginwithaccount|manualdecision|inspectknownpage|followknownpath|preparewriteoperation|executereadonlygoal)$/i.test(action);
}

function isAssistantSupportedPlanAction(action: string): boolean {
  return /^(openentry|navigate|openurl|goto|input|fill|type|setvalue|click|tap|press|wait|waitfortext|waitfor|assert|expect|verify)$/i.test(action);
}

function normalizeAssistantValueFrom(valueFrom: unknown, value: unknown, semantic: string): DslStep["valueFrom"] | undefined {
  if (typeof valueFrom === "string") return valueFrom;
  if (valueFrom && typeof valueFrom === "object") return valueFrom as Record<string, unknown>;
  const text = `${semantic} ${typeof value === "string" ? value : ""}`;
  if (/verification|valid\s*code|otp|email\s*code|sms\s*code|\u9a8c\u8bc1\u7801|\u90ae\u7bb1\u9a8c\u8bc1|\u77ed\u4fe1\u9a8c\u8bc1/i.test(text)) {
    return "redisVerificationCode";
  }
  return undefined;
}

function extractAssistantSlots(message: string, plan: Record<string, unknown>): Record<string, string> {
  const text = `${message} ${String(plan.intent ?? "")}`;
  const normalized = text.toLowerCase();
  const slots: Record<string, string> = {};
  const intentSpec = plan.intentSpec && typeof plan.intentSpec === "object" ? (plan.intentSpec as Record<string, unknown>) : undefined;
  const entities = intentSpec?.entities && typeof intentSpec.entities === "object" ? (intentSpec.entities as Record<string, unknown>) : undefined;
  const amountMatch = text.match(/(?:\u7533\u8d2d\u91d1\u989d|\u8d2d\u4e70\u91d1\u989d|\u91d1\u989d|amount)?\s*([0-9]+(?:\.[0-9]+)?)\s*(?:u|usdt)?/i);
  if (amountMatch) slots.amount = amountMatch[1];
  const assetMatch = text.match(/\b(USDT|USDC|BTC|ETH|TON|TRX|XRP|SOL|AVAX|ZEC|AIVA|AIV)\b/i);
  if (assetMatch) slots.asset = assetMatch[1].toUpperCase();
  const countMatch = text.match(/(?:\u7ea2\u5305\u4e2a\u6570|\u6570\u91cf|\u4e2a\u6570|count)\s*(?:\u4e3a|=|:|is)?\s*([0-9]+)/i);
  if (countMatch) slots.count = countMatch[1];
  if (entities?.amount !== undefined) slots.amount = String(entities.amount);
  if (entities?.count !== undefined) slots.count = String(entities.count);
  if (entities?.asset !== undefined) slots.asset = String(entities.asset).toUpperCase();
  if (/\u7406\u8d22|\u8d5a\u5e01|\u4f59\u5e01\u5b9d|earn|finance|wealth|saving/.test(normalized)) slots.module = "earn";
  if (/\u73b0\u8d27|spot|spot\s*trade|spot\s*order/.test(normalized)) slots.module = "spot";
  if (/\u63d0\u73b0|\u63d0\u5e01|withdraw|withdrawal/.test(normalized)) slots.module = "withdraw";
  if (/\u901a\u8baf\u5f55|\u5730\u5740\u7c3f|\u5730\u5740\u7ba1\u7406|address\s*book|address\s*management/.test(normalized)) slots.submodule = "address-book";
  if (/\u6700\u8fd1\u63d0\u73b0|\u6700\u8fd1\u63d0\u5e01|recent\s*withdraw/.test(normalized)) slots.scope = "recent-withdraw";
  if (/\u7533\u8d2d|\u8ba4\u8d2d|subscribe/.test(normalized)) slots.action = "subscribe";
  else if (/\u8d2d\u4e70|purchase|buy/.test(normalized)) slots.action = "purchase";
  else if (/\u5220\u9664|delete|remove/.test(normalized)) slots.action = "delete";
  if (slots.module === "spot" && /(\u4e0b\u5355|order|place\s*order)/i.test(normalized)) slots.action = "place-order";
  if (/\u7ea2\u5305|red\s*packet|red-packet/.test(normalized)) slots.module = "red-packet";
  if (slots.module === "red-packet" && /(\u521b\u5efa|\u53d1\u653e|\u53d1\u51fa|create|send)/i.test(normalized)) slots.action = "create";
  if (slots.module === "red-packet" && /(\u8bb0\u5f55|\u660e\u7ec6|\u67e5\u770b|record|history|detail)/i.test(normalized)) slots.action = "view-record";
  return slots;
}

function inferTargetUrlFromSlots(context: LoadedContext, slots: Record<string, string>): string | undefined {
  const baseUrl = context.env.web?.baseUrl;
  if (!baseUrl) return undefined;
  if (slots.module === "earn") return new URL("earn", baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();
  if (slots.module === "withdraw") {
    const url = new URL("assets/withdraw", baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
    if (slots.asset) url.searchParams.set("symbol", slots.asset);
    return url.toString();
  }
  if (slots.module === "red-packet") return new URL("assets/red-packet", baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();
  return baseUrl;
}

function materializeAssistantTargetUrl(context: LoadedContext, rawUrl?: string): string | undefined {
  if (!rawUrl) return undefined;
  const baseUrl = context.env.web?.baseUrl;
  if (!baseUrl) return rawUrl;
  try {
    const base = new URL(baseUrl);
    const raw = new URL(rawUrl, base);
    return new URL(`${raw.pathname}${raw.search}${raw.hash}`, base).toString();
  } catch {
    return rawUrl;
  }
}

function targetPageSignals(planner: AssistantKnowledgePlan): string[] {
  const signals = new Set<string>();
  if (planner.slots.module === "withdraw") ["\u63d0\u73b0", "\u63d0\u5e01", "\u5e01\u79cd", "\u666e\u901a\u63d0\u73b0", "\u5730\u5740\u7ba1\u7406", "\u63d0\u5e01\u5730\u5740", "withdraw"].forEach((item) => signals.add(item));
  if (planner.slots.module === "earn") ["\u7406\u8d22", "\u7533\u8d2d", "\u8ba4\u8d2d", "\u6536\u76ca", "\u9884\u671f\u5e74\u5316", "earn", "subscribe"].forEach((item) => signals.add(item));
  if (planner.slots.module === "red-packet") ["\u7ea2\u5305", "\u53e3\u4ee4", "\u9886\u53d6", "\u521b\u5efa", "\u53d1\u653e", "\u7ea2\u5305\u8bb0\u5f55", "\u7ea2\u5305\u660e\u7ec6", "red packet", "create"].forEach((item) => signals.add(item));
  if (planner.slots.asset) signals.add(planner.slots.asset);
  for (const term of planner.terms.filter((term) => !/^\d+$/.test(term)).slice(0, 8)) signals.add(term);
  return [...signals].slice(0, 12);
}

function pageNodeSearchText(node: { url?: string; urlPattern?: string; title?: string; semanticName?: string; elements: Array<{ text?: string; selector?: string; placeholder?: string; role?: string }> }): string {
  return `${node.url ?? ""} ${node.urlPattern ?? ""} ${node.title ?? ""} ${node.semanticName ?? ""} ${node.elements.map((element) => `${element.text ?? ""} ${element.selector ?? ""} ${element.placeholder ?? ""} ${element.role ?? ""}`).join(" ")}`.toLowerCase();
}

function scoreKnowledgeTarget(text: string, terms: string[], slots: Record<string, string>): number {
  let score = 0;
  for (const term of terms) if (text.includes(term)) score += term.includes("/") || term.includes("-") || term.includes(" ") ? 3 : 1;
  if (slots.module === "withdraw" && /\/assets\/withdraw\b|withdraw|提现|提币|地址管理|提币地址/i.test(text)) score += 8;
  if (slots.module === "withdraw" && slots.asset && text.includes(`symbol=${slots.asset.toLowerCase()}`)) score += 4;
  if (slots.module === "earn" && /\/earn\b|理财|earn|预期年化|年化|收益/i.test(text)) score += 6;
  if (slots.module === "red-packet" && /red-packet|红包|绾㈠寘/.test(text)) score += 6;
  if (slots.asset && text.includes(slots.asset.toLowerCase())) score += 2;
  return score;
}

function classifyKnowledgeElement(
  element: { role?: string; text?: string; selector?: string; href?: string; placeholder?: string },
  terms: string[],
  slots: Record<string, string>
): AssistantKnowledgePlan["candidateElements"][number] {
  const text = `${element.text ?? ""} ${element.selector ?? ""} ${element.href ?? ""} ${element.placeholder ?? ""} ${element.role ?? ""}`.toLowerCase();
  let purpose: AssistantKnowledgePlan["candidateElements"][number]["purpose"] = "unknown";
  let score = 0;
  for (const term of terms) if (text.includes(term)) score += 1;
  if (slots.asset && text.includes(slots.asset.toLowerCase())) {
    purpose = "product";
    score += 5;
  }
  if (/amount|金额|数量|申购金额|购买金额|placeholder.*1000|input/.test(text)) {
    purpose = "amount";
    score += 4;
  }
  if (/申购|认购|购买|subscribe|purchase|buy|立即|确认/.test(text)) {
    purpose = purpose === "amount" || purpose === "product" ? purpose : "action";
    score += 4;
  }
  if (/成功|失败|success|failed|error|提示|toast/.test(text)) {
    purpose = "assertion";
    score += 3;
  }
  if (/href|\/earn|理财|导航|menu/.test(text)) {
    purpose = purpose === "unknown" ? "navigation" : purpose;
    score += 1;
  }
  return {
    role: element.role,
    text: element.text ?? element.placeholder,
    selector: element.selector,
    href: element.href,
    purpose,
    score
  };
}

function normalizeAssistantAssertions(value: unknown): DslAssertion[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .map((item) => ({ type: String(item.type ?? "textVisible"), target: item.target ? String(item.target) : undefined, expected: item.expected }))
    .filter((item) => /^(textvisible|textvisibleany|urlcontains|uistate)$/i.test(item.type));
}

function materializeAssistantStep(step: DslStep, message: string, plan: Record<string, unknown>): DslStep {
  const next: DslStep = { ...step, fallback_locators: step.fallback_locators ? [...step.fallback_locators] : step.fallback_locators };
  if (next.action === "input") {
    const slots = extractAssistantSlots(message, plan);
    const targetText = `${next.id ?? ""} ${next.semantic_target ?? ""} ${next.semanticTarget ?? ""} ${next.primary_locator ?? ""} ${next.target ?? ""}`;
    if (slots.amount && /amount|\u91d1\u989d|\u53d1\u653e\u6570\u91cf|red-packet-amount/i.test(targetText)) {
      next.value = slots.amount;
    }
    if (slots.count && /count|\u4e2a\u6570|\u7ea2\u5305\u4e2a\u6570|red-packet-count/i.test(targetText)) {
      next.value = slots.count;
    }
    const replacement = extractCodeLikeValue(message, plan);
    if (replacement && (isCodeInputTarget(targetText) || isCodeLikeValue(next.value))) next.value = replacement;
  }
  return next;
}

function forceAssistantStructuredInputValues(step: DslStep, plan: Record<string, unknown>): DslStep {
  if (step.action !== "input") return step;
  const intentSpec = plan.intentSpec && typeof plan.intentSpec === "object" ? (plan.intentSpec as Record<string, unknown>) : undefined;
  const entities = intentSpec?.entities && typeof intentSpec.entities === "object" ? (intentSpec.entities as Record<string, unknown>) : undefined;
  if (!entities) return step;
  const targetText = `${step.id ?? ""} ${step.semantic_target ?? ""} ${step.semanticTarget ?? ""} ${step.primary_locator ?? ""} ${step.target ?? ""}`;
  if (entities.amount !== undefined && /amount|\u91d1\u989d|\u53d1\u653e\u6570\u91cf|red-packet-amount/i.test(targetText)) {
    return { ...step, value: String(entities.amount) };
  }
  if (entities.count !== undefined && /count|\u4e2a\u6570|\u7ea2\u5305\u4e2a\u6570|red-packet-count/i.test(targetText)) {
    return { ...step, value: String(entities.count) };
  }
  return step;
}

function validateAssistantExecutionPreflight(message: string, plan: Record<string, unknown>): { ok: true } | { ok: false; reason: string } {
  const intent = normalizeAssistantIntentSpec(plan.intentSpec, undefined);
  if (intent?.operationType !== "write") return { ok: true };
  const retrieval = normalizeAssistantRetrievalBundle(plan.retrievalBundle, undefined);
  const checks = retrieval?.preflightChecks ?? [];
  const slots = extractAssistantSlots(message, plan);
  if (slots.asset && /(balance|check balance|verify balance|\u4f59\u989d|\u68c0\u67e5\u4f59\u989d|\u6821\u9a8c\u4f59\u989d)/i.test(`${message} ${JSON.stringify(intent.entities ?? {})}`)) {
    const balance = checks.find((item) => item.name === `asset.balance.${slots.asset}`);
    if (!balance) {
      return { ok: false, reason: `Preflight blocked: asset.balance.${slots.asset} is unknown. Add account profile/runtime asset probe evidence before execution.` };
    }
    if (balance.status === "unknown") {
      return { ok: false, reason: `Preflight blocked: asset.balance.${slots.asset} is unknown.` };
    }
  }
  return { ok: true };
}

function normalizeAssistantFailureStage(blockedStage: "planner" | "retrieval" | "coverage" | "preflight" | "execution", reason?: string): FailureStage {
  if (blockedStage === "retrieval") return "retrieval";
  if (blockedStage === "coverage") return "coverage";
  if (blockedStage === "preflight") return "preflight";
  if (blockedStage === "execution") return "external_interrupt";
  if (/intent|requirement/i.test(reason ?? "")) return "requirement";
  if (/dsl|automationcase|plan/i.test(reason ?? "")) return "dsl";
  return "dsl";
}

function collectAssistantEvidenceForPlan(plan: Record<string, unknown>): EvidenceRef[] {
  const intent = normalizeAssistantIntentSpec(plan.intentSpec, undefined);
  const retrieval = normalizeAssistantRetrievalBundle(plan.retrievalBundle, undefined);
  if (!intent || !retrieval) return [];
  return collectAssistantEvidence(intent, retrieval);
}

function buildAssistantMemoryUpdateProposal(plan: Record<string, unknown>, failureStage: FailureStage, coverageGaps: string[]): Array<Record<string, unknown>> {
  const retrieval = normalizeAssistantRetrievalBundle(plan.retrievalBundle, undefined);
  const proposals: Array<Record<string, unknown>> = [];
  for (const gap of coverageGaps) {
    proposals.push({ type: "coverage_gap", failureStage, gap, source: "assistant_planning_failure" });
  }
  for (const item of retrieval?.coverageEvidence ?? []) {
    if (item.status === "missing") proposals.push({ type: "missing_evidence", item: item.item, source: item.source, suggestedAction: "add page map, element, business flow, or historical DSL evidence" });
  }
  if (proposals.length === 0) proposals.push({ type: "diagnostic", failureStage, suggestedAction: "inspect failure package and decide whether memory update is needed" });
  return proposals;
}

async function executeAssistantAutomationTask(
  context: LoadedContext,
  input: { project: string; env: string; message: string; plan: Record<string, unknown>; testCase: AutomationCase; source: AssistantAutomationSource; abortSignal?: AbortSignal; observationMode?: boolean; account?: TestAccount; onStep?: RuntimeOptions["onStep"] }
): Promise<{ exitCode: number; stdout: string; stderr: string; runId?: string; failurePackagePath?: string; failurePromptPath?: string; proposalPath?: string; caseRunPath?: string; assertionSummaries?: Array<Record<string, unknown>>; executionSteps?: Array<Record<string, unknown>>; observationMode?: boolean; observationArtifactPath?: string }> {
  const lines: string[] = [];
  await new AccountStore(context).seedDefaults();
  const account = input.account ?? chooseAccount(input.message, await new AccountStore(context).list({ project: input.project, env: input.env }));
  const baseUrl = context.env.web?.baseUrl;
  const loginRequired = automationCaseRequiresLogin(input.testCase, input.message);
  if (loginRequired && !account) {
    const error = `登录预检失败：项目 ${input.project}/${input.env} 没有可用账号，无法通过旁路登录接口注入登录态。`;
    lines.push(`source=${input.source}`, `caseId=${input.testCase.id}`, `steps=${input.testCase.steps.length}`, `assertions=${input.testCase.assertions.length}`, error);
    return { exitCode: 1, stdout: lines.join("\n"), stderr: error, observationMode: Boolean(input.observationMode) };
  }
  let authError: string | undefined;
  const auth = account && baseUrl
    ? await buildAssistantWebAuth(context, account).catch((error) => {
        logger.warn("Assistant bypass auth failed", {
          project: input.project,
          env: input.env,
          account: account.username,
          error: error instanceof Error ? error.message : String(error)
        });
        authError = error instanceof Error ? error.message : String(error);
        return undefined;
      })
    : undefined;
  if (loginRequired && !auth) {
    const error = `登录预检失败：项目 ${input.project}/${input.env} 未获得旁路登录 token，已停止执行。${authError ? ` 原因：${authError}` : ""}`;
    lines.push(`source=${input.source}`, `caseId=${input.testCase.id}`, `steps=${input.testCase.steps.length}`, `assertions=${input.testCase.assertions.length}`);
    if (account) lines.push(`account=${account.username}`);
    lines.push(error);
    return { exitCode: 1, stdout: lines.join("\n"), stderr: error, observationMode: Boolean(input.observationMode) };
  }
  const runtime: RuntimeOptions = {
    project: input.project,
    env: input.env,
    tags: [],
    locales: [],
    dryRun: false,
    mode: "heal",
    headed: true,
    observationMode: Boolean(input.observationMode),
    observationProfile: input.observationMode ? "execution" : undefined,
    maxAiCalls: 0,
    maxDurationMs: 90_000,
    abortSignal: input.abortSignal,
    onStep: input.onStep,
    webAuthToken: auth && baseUrl ? { token: auth.token, originUrl: baseUrl, headerName: auth.headerName, storageKeys: auth.storageKeys, cookieNames: auth.cookieNames } : undefined
  };
  const executableCase = account
    ? { ...input.testCase, dataProfile: account.username }
    : input.testCase;
  lines.push(`source=${input.source}`, `caseId=${input.testCase.id}`, `steps=${input.testCase.steps.length}`, `assertions=${input.testCase.assertions.length}`);
  if (account) lines.push(`account=${account.username}`);
  if (auth) lines.push(`auth=injected:${auth.headerName}`);
  const result = await new DslExecutor(context).executeCase({ testCase: executableCase, context, options: runtime });
  const observationArtifactPath = result.runId ? await findRunObservationArtifactPath(context, result.runId) : undefined;
  const assertionSummaries = result.runId ? await collectRunAssertionSummaries(context, result.runId) : [];
  const executionSteps = result.runId ? await collectRunStepSummaries(context, result.runId, executableCase, result.status) : [];
  const failureArtifacts = result.runId ? await findLatestRunFailureArtifacts(context, result.runId) : undefined;
  lines.push(`status=${result.status}`);
  if (result.runId) lines.push(`runId=${result.runId}`);
  if (observationArtifactPath) lines.push(`observation=${observationArtifactPath}`);
  for (const summary of assertionSummaries) {
    lines.push(`assertion=${String(summary.status)} ${String(summary.type ?? "")} ${String(summary.column ?? summary.target ?? "")} expected=${JSON.stringify(summary.expected ?? "")}`);
  }
  if (result.error) lines.push(`error=${result.error}`);
  if (result.status !== "passed" && /timed out|timeout/i.test(result.error ?? "")) {
    const failure = await recordAssistantPlanningFailure(context, {
      project: input.project,
      env: input.env,
      message: input.message,
      plan: {
        ...input.plan,
        executionRunId: result.runId,
        executionError: result.error,
        executionFailureStage: "timeout"
      },
      automation: {
        source: input.source,
        reason: result.error ?? "Execution timed out.",
        testCase: input.testCase
      },
      readiness: "execution_timeout",
      blockedStage: "execution"
    });
    const proposalPath = await writeAssistantKnowledgeProposal(context, {
      project: input.project,
      env: input.env,
      message: input.message,
      runId: failure.runId,
      failurePackagePath: failure.packagePath,
      stage: "execution_timeout",
      reason: result.error ?? "Execution timed out.",
      plan: input.plan,
      testCase: input.testCase,
      assertionSummaries
    });
    const caseRunPath = await writeAssistantCaseRunArtifact(context, {
      project: input.project,
      env: input.env,
      message: input.message,
      runId: failure.runId,
      status: result.status,
      error: result.error,
      plan: input.plan,
      testCase: input.testCase,
      assertionSummaries,
      executionSteps,
      failurePackagePath: failure.packagePath,
      failurePromptPath: failure.promptPath,
      proposalPath,
      observationMode: Boolean(input.observationMode),
      observationArtifactPath
    });
    lines.push(`failurePackage=${failure.packagePath}`, `failurePrompt=${failure.promptPath}`, `proposal=${proposalPath}`, `caseRun=${caseRunPath}`);
    return {
      exitCode: 1,
      stdout: lines.join("\n"),
      stderr: result.error ?? "Execution timed out.",
      runId: result.runId,
      failurePackagePath: failure.packagePath,
      failurePromptPath: failure.promptPath,
      proposalPath,
      caseRunPath,
      assertionSummaries,
      executionSteps,
      observationMode: Boolean(input.observationMode),
      observationArtifactPath
    };
  }
  let proposalPath: string | undefined;
  if (result.status !== "passed") {
    proposalPath = await writeAssistantKnowledgeProposal(context, {
      project: input.project,
      env: input.env,
      message: input.message,
      runId: result.runId,
      failurePackagePath: failureArtifacts?.failurePackagePath,
      failurePromptPath: failureArtifacts?.failurePromptPath,
      stage: failureArtifacts?.category ?? "execution_failed",
      reason: result.error ?? "Execution failed.",
      plan: input.plan,
      testCase: input.testCase,
      assertionSummaries
    });
    if (failureArtifacts?.failurePackagePath) lines.push(`failurePackage=${failureArtifacts.failurePackagePath}`);
    if (failureArtifacts?.failurePromptPath) lines.push(`failurePrompt=${failureArtifacts.failurePromptPath}`);
    lines.push(`proposal=${proposalPath}`);
  }
  const caseRunPath = result.runId ? await writeAssistantCaseRunArtifact(context, {
    project: input.project,
    env: input.env,
    message: input.message,
    runId: result.runId,
    status: result.status,
    error: result.error,
    plan: input.plan,
      testCase: input.testCase,
      assertionSummaries,
      executionSteps,
      failurePackagePath: failureArtifacts?.failurePackagePath,
      failurePromptPath: failureArtifacts?.failurePromptPath,
    proposalPath,
    observationMode: Boolean(input.observationMode),
    observationArtifactPath
  }) : undefined;
  if (caseRunPath) lines.push(`caseRun=${caseRunPath}`);
  return {
    exitCode: result.status === "passed" ? 0 : 1,
    stdout: lines.join("\n"),
    stderr: result.status === "passed" ? "" : result.error ?? "",
    runId: result.runId,
    failurePackagePath: failureArtifacts?.failurePackagePath,
    failurePromptPath: failureArtifacts?.failurePromptPath,
    proposalPath,
    caseRunPath,
    assertionSummaries,
    executionSteps,
    observationMode: Boolean(input.observationMode),
    observationArtifactPath
  };
}

async function findRunObservationArtifactPath(context: LoadedContext, runId: string): Promise<string | undefined> {
  const indexPath = path.join(context.rootDir, "storage", "observation-runs", "index.json");
  const index = await fs.readJson(indexPath).catch(() => undefined);
  const runs = Array.isArray(index?.runs) ? index.runs as Array<Record<string, unknown>> : [];
  const matched = runs.find((item) => item.runId === runId);
  return typeof matched?.artifactPath === "string" ? matched.artifactPath : undefined;
}

async function collectRunStepSummaries(context: LoadedContext, runId: string, testCase?: AutomationCase, status?: string): Promise<Array<Record<string, unknown>>> {
  const steps = await new ExecutionStore(context).listSteps(runId).catch(() => []);
  const storedSteps = steps.map((step, index) => ({
    index,
    stepId: step.step_id,
    dslStepId: step.dsl_step_id,
    action: step.action_type,
    target: step.target_semantic_name,
    status: step.status,
    durationMs: step.duration_ms,
    error: step.error_message
  }));
  if (storedSteps.length) return storedSteps;
  return buildExecutionStepSummariesFromCase(testCase, status);
}

function buildExecutionStepSummariesFromCase(testCase?: AutomationCase, status?: string): Array<Record<string, unknown>> {
  if (!testCase?.steps?.length) return [];
  const passed = status === "passed";
  return testCase.steps.map((step, index) => ({
    index,
    stepId: step.id,
    dslStepId: step.id,
    action: step.action,
    target: step.semantic_target ?? step.semanticTarget ?? step.target,
    status: passed ? "passed" : "unknown",
    source: "dsl_fallback_after_execution"
  }));
}

async function findLatestRunFailureArtifacts(context: LoadedContext, runId: string): Promise<{ failurePackagePath?: string; failurePromptPath?: string; category?: string; errorMessage?: string } | undefined> {
  const data = await new ExecutionStore(context).load().catch(() => undefined);
  const report = data?.failureReports.find((item) => item.run_id === runId);
  if (!report) return undefined;
  return {
    failurePackagePath: report.codex_failure_package_path,
    failurePromptPath: report.codex_prompt_path,
    category: report.category,
    errorMessage: report.error_message
  };
}

async function writeAssistantCaseRunArtifact(context: LoadedContext, input: {
  project: string;
  env: string;
  message: string;
  runId: string;
  status?: string;
  error?: string;
  plan: Record<string, unknown>;
  testCase?: AutomationCase;
  assertionSummaries?: Array<Record<string, unknown>>;
  failurePackagePath?: string;
  failurePromptPath?: string;
  proposalPath?: string;
  observationMode?: boolean;
  observationArtifactPath?: string;
  executionSteps?: Array<Record<string, unknown>>;
}): Promise<string> {
  const filePath = path.join(context.rootDir, "storage", "case-runs", `${input.runId}.json`);
  await writeSafeJsonFile(filePath, {
    schemaVersion: "assistant-case-run.v1",
    createdAt: new Date().toISOString(),
    project: input.project,
    env: input.env,
    runId: input.runId,
    status: input.status,
    error: input.error,
    observationMode: Boolean(input.observationMode),
    userRequest: input.message,
    aiIntent: input.plan.aiIntent ?? input.plan.pageModelDeepSeekIntent,
    aiDslAdvisor: input.plan.aiDslAdvisor ?? input.plan.pageModelDeepSeek,
    deepseekIntent: input.plan.pageModelDeepSeekIntent,
    deepseekDslAdvisor: input.plan.pageModelDeepSeek,
    pageModelExecutionPlan: input.plan.pageModelExecutionPlan,
    dslValidation: (input.plan.pageModelExecutionPlan as Record<string, unknown> | undefined)?.dslValidation,
    automationCase: input.testCase,
    stepExplainTrace: input.testCase?.steps.map((step, index) => ({
      index,
      id: step.id,
      action: step.action,
      semanticTarget: step.semantic_target ?? step.semanticTarget,
      explain: step.explain
    })),
    assertionSummaries: input.assertionSummaries ?? [],
    executionSteps: input.executionSteps ?? [],
    artifacts: {
      failurePackagePath: input.failurePackagePath,
      failurePromptPath: input.failurePromptPath,
      proposalPath: input.proposalPath,
      observationArtifactPath: input.observationArtifactPath
    }
  });
  return path.relative(context.rootDir, filePath);
}

async function writeAssistantKnowledgeProposal(context: LoadedContext, input: {
  project: string;
  env: string;
  message: string;
  runId?: string;
  failurePackagePath?: string;
  failurePromptPath?: string;
  stage: string;
  reason: string;
  plan: Record<string, unknown>;
  testCase?: AutomationCase;
  assertionSummaries?: Array<Record<string, unknown>>;
}): Promise<string> {
  const proposalId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID()}`;
  const filePath = path.join(context.rootDir, "storage", "proposals", "pending", `${proposalId}.json`);
  const failedAssertions = (input.assertionSummaries ?? []).filter((item) => item.status !== "passed");
  await writeSafeJsonFile(filePath, {
    schemaVersion: "knowledge-update-proposal.v1",
    proposalId,
    status: "pending_review",
    createdAt: new Date().toISOString(),
    project: input.project,
    env: input.env,
    runId: input.runId,
    userRequest: input.message,
    source: "assistant_execution",
    failureStage: input.stage,
    reason: input.reason,
    proposalType: inferKnowledgeProposalType(input.stage, input.reason, failedAssertions, input.plan),
    writeBackPolicy: "proposal_only_no_auto_store_write",
    recommendedActions: recommendedKnowledgeProposalActions(input.stage, input.reason, failedAssertions, input.plan),
    evidence: {
      failurePackagePath: input.failurePackagePath,
      failurePromptPath: input.failurePromptPath,
      intent: (input.plan.pageModelExecutionPlan as Record<string, unknown> | undefined)?.intent ?? input.plan.intentSpec ?? input.plan.intent,
      intentArbitration: (input.plan.pageModelExecutionPlan as Record<string, unknown> | undefined)?.intentArbitration
        ?? ((input.plan.pageModelExecutionPlan as Record<string, unknown> | undefined)?.planningContext as Record<string, unknown> | undefined)?.intentArbitration,
      dslValidation: (input.plan.pageModelExecutionPlan as Record<string, unknown> | undefined)?.dslValidation,
      failedAssertions,
      stepExplainTrace: input.testCase?.steps.map((step, index) => ({ index, id: step.id, action: step.action, explain: step.explain }))
    }
  });
  return path.relative(context.rootDir, filePath);
}

function inferKnowledgeProposalType(stage: string, reason: string, failedAssertions: Array<Record<string, unknown>>, plan?: Record<string, unknown>): string {
  const text = `${stage} ${reason}`.toLowerCase();
  const executionPlan = plan?.pageModelExecutionPlan as Record<string, unknown> | undefined;
  const arbitration = executionPlan?.intentArbitration
    ?? (executionPlan?.planningContext as Record<string, unknown> | undefined)?.intentArbitration;
  const arbitrationConflicts = arbitration && typeof arbitration === "object" && Array.isArray((arbitration as Record<string, unknown>).conflicts)
    ? (arbitration as Record<string, unknown>).conflicts as unknown[]
    : [];
  const intent = executionPlan?.intent && typeof executionPlan.intent === "object" ? executionPlan.intent as Record<string, unknown> : {};
  const userRequest = String(plan?.intent ?? executionPlan?.request ?? "");
  const assertionDiagnosticsText = JSON.stringify(failedAssertions.map((item) => item.diagnostics ?? item.actual ?? item.error ?? {})).toLowerCase();
  if (/empty_state_visible|body_ignored|ignoredglobalemptystate/.test(assertionDiagnosticsText)) return "assertion_scope_update";
  if (/intent_arbitration/.test(text) && /manage_|add_|create_|delete_|operationtype:read!=write/i.test(text)) return "intent_hierarchy_update";
  if (/intent_arbitration|intent_boundary|module:|operationtype:/i.test(text) || arbitrationConflicts.length > 0) return "intent_boundary_update";
  if (/现货流水|资金流水|理财流水|合约流水/.test(userRequest) && String(intent.module) === "red-packet") return "intent_boundary_update";
  if (failedAssertions.length || /assert/.test(text)) return "assertion_observable_update";
  if (/dropdown_component|component_contract|selected_value|option_discovery/.test(text)) return "component_contract_update";
  if (/locator|selector|strict mode|element/.test(text)) return "element_locator_update";
  if (/provider|verification|验证码|totp|email/.test(text)) return "provider_flow_model_update";
  if (/bypass auth failed|fetch failed|net::err|timeout|dns|navigation|page.goto/.test(text)) return "environment_preflight_gap";
  if (/already exists|已存在|余额|insufficient|重复|test data|数据/.test(text)) return "test_data_strategy_gap";
  if (/timeout|navigation|page/.test(text)) return "page_state_or_navigation_update";
  return "execution_diagnostic_review";
}

function recommendedKnowledgeProposalActions(stage: string, reason: string, failedAssertions: Array<Record<string, unknown>>, plan?: Record<string, unknown>): string[] {
  const type = inferKnowledgeProposalType(stage, reason, failedAssertions, plan);
  if (type === "assertion_scope_update") return [
    "检查目标断言是否绑定到了正确的结果区域或表格容器，不能使用全局 body 空态覆盖真实表格行。",
    "补充 Page Model 的 resultTable container、emptyState scope、row selector 和 column mapping。",
    "失败包应展示 observedHeaders、rowCount、typeValues、emptyStateScope 和 ignoredGlobalEmptyState，便于判断是否为断言作用域问题。"
  ];
  if (type === "intent_hierarchy_update") return [
    "检查 DeepSeek 第一轮意图中的 pageIntent、businessAction 与本地 operationIntent 是否是父页面和页面内动作关系。",
    "管理页、列表页、详情页可以作为页面上下文；新增、编辑、删除、保存等页面内动作应作为最终 operationIntent。",
    "只有跨模块、跨页面或读写方向真正矛盾时才阻断执行。"
  ];
  if (type === "intent_boundary_update") return [
    "检查 DeepSeek 第一轮结构化意图、本地 Page Model 候选和 Operation Manual capability 是否一致。",
    "补充或修正页面/能力/字段/字段值分层规则，显式页面词必须高于筛选值词。",
    "如果 DeepSeek 与本地候选冲突，先阻断执行并展示中文冲突原因，不允许误执行到其它模块。"
  ];
  if (type === "assertion_observable_update") return [
    "检查断言目标是否来自用户期望或 Operation Manual success policy。",
    "补采或启用页面可观察信号，例如 toast、弹窗、列表新增行、接口响应或空状态。",
    "确认失败包中的 attribution.rootCause、bestSimilarTexts、oppositeMessages 是否能解释真实失败。",
    "审核后再更新 Page Model assertion evidence 或 Operation Manual successEvidencePolicies。"
  ];
  if (type === "component_contract_update") return [
    "补采组件合同：组件类型、稳定触发器、选项发现方式、目标选项、选中值回显和持久化信号。",
    "组件合同未满足时阻断 DSL materialization，不进入执行器。",
    "审核后再更新 Page Model component evidence。"
  ];
  if (type === "element_locator_update") return [
    "检查失败步骤 explain 中的 elementId 与实际页面组件是否一致。",
    "补采组件结构、稳定 locator、fallback locator、下拉选项发现方式和选中值信号。",
    "审核后再更新 Page Model element evidence。"
  ];
  if (type === "provider_flow_model_update") return [
    "核对 Operation Manual provider flow 是否声明触发步骤、输入项和确认项。",
    "补采安全验证弹窗中的发送验证码、GA/TOTP、邮箱/短信验证码、确认按钮。",
    "审核后再更新 provider requirement 与组件 evidence。"
  ];
  if (type === "environment_preflight_gap") return [
    "增加执行前环境预检：baseUrl/API/auth bypass/DNS/网络连通性。",
    "环境不可用时返回 preflight gap，不启动浏览器执行。",
    "将环境问题和建模/定位/断言问题分开归因。"
  ];
  if (type === "test_data_strategy_gap") return [
    "识别测试数据状态：新数据、重复数据、余额/额度/权限前置。",
    "将数据准备策略沉淀到 Operation Manual 或 Test Data Profile。",
    "不要把业务数据冲突误判为 locator 或断言能力问题。"
  ];
  return [
    "查看失败包和 case-run 中的 DeepSeek、知识匹配、DSL 合同校验和执行记录。",
    "判断是否需要补 Page Model、Operation Manual、执行器通用能力或测试数据策略。",
    "只提交待审核知识更新，不自动写入可执行知识库。"
  ];
}

async function collectRunAssertionSummaries(context: LoadedContext, runId: string): Promise<Array<Record<string, unknown>>> {
  const data = await new ExecutionStore(context).load();
  return data.steps
    .filter((step) => step.run_id === runId && step.assertion_summary)
    .map((step) => ({
      stepId: step.dsl_step_id,
      stepIndex: step.assertion_summary?.stepIndex,
      readableText: step.assertion_summary?.readableText,
      status: step.assertion_summary?.status ?? step.status,
      type: step.assertion_summary?.type,
      target: step.assertion_summary?.target,
      table: step.assertion_summary?.table,
      column: step.assertion_summary?.column,
      expected: step.assertion_summary?.expected,
      emptyStateAccepted: step.assertion_summary?.emptyStateAccepted,
      actual: step.assertion_summary?.actual,
      diagnostics: step.assertion_summary?.diagnostics ?? (step.assertion_summary?.actual as Record<string, unknown> | undefined)?.diagnostics,
      error: step.assertion_summary?.error
    }));
}

async function buildAssistantWebAuth(context: LoadedContext, account: TestAccount): Promise<{ token: string; headerName: string; storageKeys?: string[]; cookieNames?: string[] }> {
  const discovery = await new EnvironmentDiscoveryStore(context).load(context.project.projectKey, context.env.env);
  const bypass = discovery.bypassLogin;
  if (!bypass?.enabled) throw new Error("Bypass login is not enabled.");
  if (!context.env.api?.baseUrl) throw new Error("Bypass login requires env.api.baseUrl.");
  const attempts = Math.max(1, (context.env.retry?.apiRetries ?? 1) + 1);
  let body: unknown;
  let status = 0;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(new URL(bypass.path, context.env.api.baseUrl), {
        method: bypass.method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...(bypass.extraPayload ?? {}), [bypass.usernameField]: account.username, [bypass.passwordField]: account.password, uaTime: formatAssistantDateTime(new Date()) })
      });
      status = response.status;
      body = await response.json().catch(async () => ({ raw: await response.text() }));
      if (response.ok) break;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
  }
  if (!body) throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "Bypass login failed."));
  const token = readAssistantJsonPath(body, bypass.tokenResponsePath);
  if (!token) throw new Error(`Bypass login failed: HTTP ${status} ${JSON.stringify(body).slice(0, 500)}`);
  return { token: String(token), headerName: bypass.tokenHeaderName, storageKeys: discovery.authInjection?.storageKeys, cookieNames: discovery.authInjection?.cookieNames };
}

function automationCaseRequiresLogin(testCase: AutomationCase, message = ""): boolean {
  const text = [
    message,
    testCase.dataProfile ?? "",
    ...(testCase.preconditions ?? []),
    ...testCase.steps.flatMap((step) => [
      step.semantic_target ?? "",
      step.semanticTarget ?? "",
      ...(step.preconditions ?? []).flatMap((item) => [item.id, item.source ?? "", item.expected?.join(" ") ?? ""])
    ])
  ].join("\n");
  return /user\.logged_in|logged[_ -]?in|login|required login|已登录|登录|账号可进入|可登录账号/i.test(text);
}

async function recordAssistantPlanningFailure(
  context: LoadedContext,
  input: {
    project: string;
    env: string;
    message: string;
    plan: Record<string, unknown>;
    automation: AssistantAutomationBuildResult;
    readiness: string;
    blockedStage?: "planner" | "retrieval" | "coverage" | "preflight" | "execution";
  }
): Promise<{ runId: string; packagePath: string; promptPath: string; proposalPath?: string; caseRunPath?: string }> {
  const runId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const artifactDir = path.join(context.rootDir, context.workspace.artifactRoot, "codex-failure-packages", runId);
  await fs.ensureDir(artifactDir);
  const packagePath = path.join(artifactDir, "assistant-planning.json");
  const promptPath = path.join(artifactDir, "assistant-planning.prompt.md");
  const isPageModelPlanningFailure = Boolean(input.plan.pageModelExecutionPlan || input.plan.pageModelUnavailableReason);
  const evidence = isPageModelPlanningFailure
    ? buildPageModelPlanningFailureEvidence(input)
    : await buildAssistantPlanningFailureEvidence(context, input);
  const blockedStage = input.blockedStage ?? "coverage";
  const failureStage = normalizeAssistantFailureStage(blockedStage, input.automation.reason);
  const originalUserRequestSafe = safeArtifactText(input.message);
  const retrievalSummary = summarizeRetrievalForFailure(input.plan);
  const coverageGaps = extractCoverageGaps(input.plan);
  const aiDiagnosticLog = buildAiDiagnosticLogForFailure({
    plan: input.plan,
    failureStage,
    blockedStage,
    readiness: input.readiness,
    automationReason: input.automation.reason
  });
  const assistantPlan = input.plan as unknown as Partial<AssistantPlan>;
  const stages = assistantPlan.aiStages;
  const providerCalls = Array.isArray(assistantPlan.providerCalls) ? (assistantPlan.providerCalls ?? []) : [];
  const recommendedMemoryUpdates = createLocalAiStageEnvelope({
    stage: "memory_update_proposal",
    inputSummary: { failureStage, coverageGaps, readiness: input.readiness },
    parsedOutput: {
      updates: buildAssistantMemoryUpdateProposal(input.plan, failureStage, coverageGaps),
      writeBackRequired: false,
      reason: "Stage 1 records proposals only; platform validation writes memory later."
    },
    evidence: collectAssistantEvidenceForPlan(input.plan),
    confidence: coverageGaps.length ? 0.65 : 0.45,
    uncertainty: coverageGaps
  });
  const failureAnalysis = createLocalAiStageEnvelope({
    stage: "failure_analysis",
    inputSummary: { blockedStage, readiness: input.readiness, automationReason: input.automation.reason },
    parsedOutput: {
      failureStage,
      rootCause: input.automation.reason || "No executable AutomationCase could be built.",
      executionStarted: false,
      nextDiagnosticLayer: failureStage
    },
    evidence: collectAssistantEvidenceForPlan(input.plan),
    confidence: 0.75,
    uncertainty: coverageGaps
  });
  if (stages) {
    stages.failureAnalysis = failureAnalysis;
    stages.memoryUpdateProposal = recommendedMemoryUpdates;
  }
  const standardFailurePackage: FailurePackageV1 = {
    schemaVersion: "failure-package.v1",
    runId,
    project: input.project,
    env: input.env,
    originalUserRequest: input.message,
    normalizedUserRequest: originalUserRequestSafe,
    intent: input.plan.intentSpec ?? input.plan.intent,
    deepseekRequirementOutput: stages?.requirementUnderstanding,
    rawRetrievalHits: (input.plan.retrievalBundle as AssistantRetrievalBundle | undefined)?.knowledgeHits ?? [],
    deepseekRerankOutput: stages?.retrievalRerank,
    fusedEvidence: stages?.evidenceFusion,
    dslDraft: stages?.dslDraft,
    dslReview: stages?.dslReview,
    coverageResult: input.plan.coverage,
    deepseekCoverageExplanation: stages?.coverageExplanation,
    preflightResult: (input.plan.retrievalBundle as AssistantRetrievalBundle | undefined)?.preflightChecks ?? [],
    deepseekPreflightDecision: stages?.preflightDecision,
    executionStarted: false,
    failureStage,
    providerCalls,
    recommendedMemoryUpdates
  };
  const payload = {
    ...standardFailurePackage,
    objective: "Analyze why the assistant could not build an executable AutomationCase.",
    failure_type: "assistant_planning_failed",
    project: input.project,
    env: input.env,
    run_id: runId,
    runId,
    created_at: createdAt,
    originalUserRequestRaw: input.message,
    originalUserRequestSafe,
    user_message: input.message,
    detectedIntent: input.plan.intentSpec ?? input.plan.intent,
    retrievalSummary,
    coverageGaps,
    aiDiagnosticLog,
    blockedStage,
    failureStage,
    errorMessage: input.automation.reason || "No executable AutomationCase could be built.",
    intent_spec: input.plan.intentSpec,
    retrieval_bundle: input.plan.retrievalBundle,
    coverage: input.plan.coverage,
    ai_stages: stages,
    providerCalls,
    planning_log: {
      rawUserRequest: input.message,
      safeUserRequest: originalUserRequestSafe,
      detectedIntent: input.plan.intentSpec,
      project: input.project,
      env: input.env,
      module: (input.plan.intentSpec as AssistantIntentSpec | undefined)?.module,
      action: (input.plan.intentSpec as AssistantIntentSpec | undefined)?.action,
      operationType: (input.plan.intentSpec as AssistantIntentSpec | undefined)?.operationType,
      knowledgeRetrieval: {
        queries: (input.plan.retrievalBundle as AssistantRetrievalBundle | undefined)?.retrievalQueries,
        hits: (input.plan.retrievalBundle as AssistantRetrievalBundle | undefined)?.knowledgeHits,
        audit: (input.plan.retrievalBundle as AssistantRetrievalBundle | undefined)?.knowledgeAudit
      },
      pageMapHits: {
        pages: (input.plan.retrievalBundle as AssistantRetrievalBundle | undefined)?.pageCandidates,
        elements: (input.plan.retrievalBundle as AssistantRetrievalBundle | undefined)?.elementCandidates
      },
      businessFlowHits: (input.plan.retrievalBundle as AssistantRetrievalBundle | undefined)?.businessFlowCandidates,
      coverageInput: input.plan.retrievalBundle,
      coverageOutput: input.plan.coverage,
      coverageGaps,
      aiDiagnosticLog,
      runtimeResolvable: (input.plan.retrievalBundle as AssistantRetrievalBundle | undefined)?.runtimeResolvable,
      preflightChecks: (input.plan.retrievalBundle as AssistantRetrievalBundle | undefined)?.preflightChecks,
      deepseekRequirementOutput: stages?.requirementUnderstanding,
      rawRetrievalHits: (input.plan.retrievalBundle as AssistantRetrievalBundle | undefined)?.knowledgeHits,
      deepseekRerankOutput: stages?.retrievalRerank,
      fusedEvidence: stages?.evidenceFusion,
      dslDraft: stages?.dslDraft,
      dslReview: stages?.dslReview,
      deepseekCoverageExplanation: stages?.coverageExplanation,
      deepseekPreflightDecision: stages?.preflightDecision,
      providerCalls,
      blockedStage,
      failureStage,
      blockedReason: input.automation.reason
    },
    assistant_plan: input.plan,
    automation_decision: input.automation,
    readiness: input.readiness,
    evidence,
    expected_response: {
      classification: "missing_business_flow | missing_page_state | missing_transition | missing_locator | unsupported_plan_action | test_data_gap | environment_gap | unknown",
      root_cause: "short explanation",
      open_url: "candidate URL to inspect first, if known",
      screenshot_needed: true,
      missing_assets: ["specific page state / transition / locator / DSL step to add"],
      proposed_dsl_case: "minimal AutomationCase or transition DSL steps",
      knowledge_updates: ["facts that should be written back to local knowledge"],
      needs_human_decision: false
    }
  };
  const safeWrite = await writeSafeJsonArtifact(
    packagePath,
    payload,
    {
      runId,
      project: input.project,
      env: input.env,
      originalUserRequestRaw: input.message,
      originalUserRequestSafe,
      detectedIntent: input.plan.intentSpec ?? input.plan.intent,
      retrievalSummary,
      coverageGaps,
      blockedStage,
      errorMessage: input.automation.reason || "No executable AutomationCase could be built."
    },
    { rawText: JSON.stringify(payload, null, 2) }
  );
  await writeSafeTextFile(promptPath, ["# Assistant Planning Failure Package", "", "Open the candidate URL, take a screenshot, inspect DOM/visible controls, then propose missing local assets.", "", "```json", JSON.stringify(payload, null, 2), "```"].join("\n"));
  const store = new ExecutionStore(context);
  const run: ExecutionRun = { run_id: runId, project_id: input.project, platform: "web", env: input.env, test_case_id: "assistant_planning", dsl_version: "assistant", mode: "debug", start_time: createdAt, end_time: createdAt, status: "failed", total_steps: 0, passed_steps: 0, failed_steps: 1, healed_steps: 0, ai_invocation_count: 0, token_input_total: 0, token_output_total: 0, estimated_cost: 0, duration_ms: 0, error_summary: input.automation.reason || "No executable AutomationCase could be built." };
  const report: FailureReport = { report_id: crypto.randomUUID(), run_id: runId, case_id: "assistant_planning", step_id: "assistant-planning", category: "ai_decision_failed", failed_step: { id: "assistant-planning", action: "prepareWriteOperation", semantic_target: input.message, target: input.message }, failed_layer: 0, error_message: run.error_summary, attempted_locators: evidence.candidate_locators, ai_judgement: "Assistant route could not convert the request into executable DSL.", codex_failure_package_path: packagePath, codex_prompt_path: promptPath, suggested_fix: "Inspect candidate URL/page and add missing PageState, PageTransition, locator, or business flow.", created_at: createdAt };
  await store.upsertRun(run);
  await store.appendFailureReport(report);
  const effectivePackagePath = safeWrite.fallback?.path ?? packagePath;
  const proposalPath = await writeAssistantKnowledgeProposal(context, {
    project: input.project,
    env: input.env,
    message: input.message,
    runId,
    failurePackagePath: effectivePackagePath,
    failurePromptPath: promptPath,
    stage: failureStage,
    reason: input.automation.reason || "No executable AutomationCase could be built.",
    plan: input.plan,
    testCase: input.automation.testCase
  });
  const caseRunPath = await writeAssistantCaseRunArtifact(context, {
    project: input.project,
    env: input.env,
    message: input.message,
    runId,
    status: "failed",
    error: input.automation.reason || "No executable AutomationCase could be built.",
    plan: input.plan,
    testCase: input.automation.testCase,
    failurePackagePath: effectivePackagePath,
    failurePromptPath: promptPath,
    proposalPath
  });
  return { runId, packagePath: effectivePackagePath, promptPath, proposalPath, caseRunPath };
}

async function buildAssistantPlanningFailureEvidence(context: LoadedContext, input: { message: string; plan: Record<string, unknown> }): Promise<{ terms: string[]; candidate_urls: string[]; candidate_locators: string[]; business_flow_candidates: Array<Record<string, unknown>>; knowledge_hits: Array<Record<string, unknown>>; page_state_candidates: Array<Record<string, unknown>>; page_graph_candidates: Array<Record<string, unknown>> }> {
  const terms = assistantIntentTerms(input.message, input.plan);
  const [flowData, pageData, graphData, knowledgeHits] = await Promise.all([new BusinessFlowStore(context).load(), new PageStateStore(context).load(), new PageGraphStore(context).load(), new KnowledgeStore(context).search(input.message, 10)]);
  const business_flow_candidates = flowData.flows.map((flow) => ({ flow, score: scoreBusinessFlow(flow, terms, pageData.transitions), explanation: explainBusinessFlowScore(flow, terms, pageData.transitions) })).filter((item) => item.score > 0).slice(0, 10).map((item) => ({ flow_id: item.flow.flow_id, name: item.flow.name, target_flows: item.flow.target_flows, transition_count: item.flow.transition_ids.length, score: item.score, identity_score: item.explanation.identityScore, transition_score: item.explanation.transitionScore, matched_terms: item.explanation.matchedTerms }));
  const page_state_candidates = pageData.states.map((state) => ({ state, score: terms.reduce((sum, term) => sum + (`${state.page_name} ${state.url_pattern ?? ""} ${state.known_elements.join(" ")}`.toLowerCase().includes(term) ? 1 : 0), 0) })).filter((item) => item.score > 0).slice(0, 8).map((item) => ({ page_id: item.state.page_id, page_name: item.state.page_name ?? item.state.url_pattern ?? item.state.page_id, url_pattern: item.state.url_pattern, known_elements: item.state.known_elements.slice(0, 30), score: item.score }));
  const page_graph_candidates = graphData.nodes
    .map((node) => {
      const haystack = `${node.url ?? ""} ${node.title ?? ""} ${node.semanticName ?? ""} ${node.elements.map((element) => `${element.text ?? ""} ${element.selector ?? ""}`).join(" ")}`.toLowerCase();
      const score = terms.reduce((sum, term) => sum + (haystack.includes(term) ? 1 : 0), 0);
      return { node, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map((item) => ({
      page_id: item.node.pageId,
      title: item.node.title ?? item.node.semanticName ?? item.node.url ?? item.node.pageId,
      url: item.node.url,
      url_pattern: item.node.urlPattern,
      elements: item.node.elements.slice(0, 30).map((element) => ({ text: element.text, selector: element.selector, role: element.role, riskLevel: element.riskLevel })),
      score: item.score
    }));
  const candidate_urls = [...new Set([...page_graph_candidates.map((item) => String(item.url ?? item.url_pattern ?? "")).filter(Boolean), ...page_state_candidates.map((item) => String(item.url_pattern ?? "")).filter(Boolean), context.env.web?.baseUrl].filter(Boolean) as string[])].slice(0, 12);
  const candidate_locators = [...new Set([...page_graph_candidates.flatMap((item) => (item.elements as Array<Record<string, unknown>>).map((element) => String(element.selector ?? ""))), ...page_state_candidates.flatMap((item) => (item.known_elements as string[]))].filter(isLocatorLike).slice(0, 80))];
  return { terms, candidate_urls, candidate_locators, business_flow_candidates, knowledge_hits: knowledgeHits.slice(0, 10).map((item) => ({ title: item.title, sourceType: item.sourceType, confidence: item.confidence, content: item.content.slice(0, 500) })), page_state_candidates, page_graph_candidates };
}

function buildPageModelPlanningFailureEvidence(input: {
  message: string;
  plan: Record<string, unknown>;
}): {
  terms: string[];
  candidate_urls: string[];
  candidate_locators: string[];
  business_flow_candidates: Array<Record<string, unknown>>;
  knowledge_hits: Array<Record<string, unknown>>;
  page_state_candidates: Array<Record<string, unknown>>;
  page_graph_candidates: Array<Record<string, unknown>>;
} {
  const pageModelPlan = input.plan.pageModelExecutionPlan as Record<string, unknown> | undefined;
  const selectedEvidence = Array.isArray(pageModelPlan?.selectedEvidence) ? pageModelPlan.selectedEvidence as Array<Record<string, unknown>> : [];
  const fallbackEvidence = Array.isArray(pageModelPlan?.fallbackEvidence) ? pageModelPlan.fallbackEvidence as Array<Record<string, unknown>> : [];
  return {
    terms: assistantIntentTerms(input.message, { intent: input.message }),
    candidate_urls: selectedEvidence
      .filter((item) => item.kind === "page")
      .map((item) => String(item.pageId ?? item.id ?? ""))
      .filter(Boolean),
    candidate_locators: selectedEvidence
      .filter((item) => item.kind === "element")
      .map((item) => String(item.semanticName ?? item.id ?? ""))
      .filter(Boolean),
    business_flow_candidates: [],
    knowledge_hits: [],
    page_state_candidates: fallbackEvidence.map((item) => ({
      source: "page_model_fallback",
      id: item.id,
      pageId: item.pageId,
      semanticName: item.semanticName,
      status: item.status
    })),
    page_graph_candidates: selectedEvidence.map((item) => ({
      source: "page_model_selected",
      id: item.id,
      pageId: item.pageId,
      semanticName: item.semanticName,
      status: item.status,
      confidence: item.confidence
    }))
  };
}

function assistantIntentTerms(message: string, plan: Record<string, unknown>): string[] {
  return assistantSearchTerms(`${message} ${String(plan.intent ?? "")}`);
}

function assistantSearchTerms(textInput: string): string[] {
  const text = textInput.toLowerCase();
  const terms = new Set<string>();
  for (const match of text.matchAll(/[a-z0-9][a-z0-9/_-]{2,}/gi)) terms.add(match[0].toLowerCase());
  if (/\u7ea2\u5305|red\s*packet|red-packet|packet/.test(text)) ["red packet", "red-packet", "packet", "assets/red-packet", "\u7ea2\u5305"].forEach((term) => terms.add(term));
  if (/(\u521b\u5efa|\u53d1\u653e|\u53d1\u51fa|create|send).{0,16}(\u7ea2\u5305|red\s*packet|red-packet)|(\u7ea2\u5305|red\s*packet|red-packet).{0,16}(\u521b\u5efa|\u53d1\u653e|\u53d1\u51fa|create|send)/i.test(text)) {
    ["create", "send", "\u521b\u5efa", "\u53d1\u653e", "amount", "count"].forEach((term) => terms.add(term));
  }
  if (/(\u7ea2\u5305.{0,12}(\u8bb0\u5f55|\u660e\u7ec6)|(\u8bb0\u5f55|\u660e\u7ec6|\u67e5\u770b).{0,12}\u7ea2\u5305|record|history|detail)/i.test(text)) ["record", "history", "detail"].forEach((term) => terms.add(term));
  if (/\u9886\u53d6|\u53e3\u4ee4|claim|receive|redeem|passphrase/.test(text)) ["claim", "receive", "redeem", "passphrase"].forEach((term) => terms.add(term));
  if (/\u7406\u8d22|\u8d5a\u5e01|\u4f59\u5e01\u5b9d|earn|wealth|finance|saving/.test(text)) ["earn", "finance", "wealth", "saving"].forEach((term) => terms.add(term));
  if (/\u7533\u8d2d|\u8d2d\u4e70|\u8ba4\u8d2d|subscribe|purchase|buy/.test(text)) ["subscribe", "purchase", "buy"].forEach((term) => terms.add(term));
  if (/\u73b0\u8d27|spot|spot\s*trade|spot\s*order/.test(text)) ["spot", "trade", "market", "order", "\u73b0\u8d27", "\u73b0\u8d27\u4ea4\u6613"].forEach((term) => terms.add(term));
  if (/\u4e0b\u5355|\u4e70\u5165|\u5356\u51fa|place\s*order|submit\s*order/.test(text)) ["place order", "submit order", "buy", "sell", "\u4e0b\u5355", "\u4e70\u5165", "\u5356\u51fa"].forEach((term) => terms.add(term));
  if (/\u63d0\u73b0|\u63d0\u5e01|withdraw|withdrawal/.test(text)) ["withdraw", "withdrawal", "assets/withdraw"].forEach((term) => terms.add(term));
  if (/\u901a\u8baf\u5f55|\u5730\u5740\u7c3f|\u5730\u5740\u7ba1\u7406|address\s*book|address\s*management/.test(text)) ["address", "address book", "address management"].forEach((term) => terms.add(term));
  if (/\u6700\u8fd1\u63d0\u73b0|\u6700\u8fd1\u63d0\u5e01|recent\s*withdraw/.test(text)) ["recent withdraw", "recent"].forEach((term) => terms.add(term));
  if (/\u5220\u9664|delete|remove/.test(text)) ["delete", "remove"].forEach((term) => terms.add(term));
  if (/coupon|\u5361\u5238/.test(text)) terms.add("coupon");
  if (/bonus/.test(text)) terms.add("bonus");
  return [...terms].filter((term) => !["test", "uat", "login", "user", "account", "demo"].includes(term));
}

function scoreBusinessFlow(flow: BusinessFlow, terms: string[], transitions: PageTransition[]): number {
  const explanation = explainBusinessFlowScore(flow, terms, transitions);
  if (!explanation.accepted) return 0;
  let score = explanation.identityScore * 3 + explanation.transitionScore;
  if (flow.transition_ids.length > 20) score = explanation.identityScore * 3 + Math.min(explanation.transitionScore, 1);
  if (score <= 0) return 0;
  if (flow.review_status === "approved") score += 1;
  if (flow.replay_status === "passed") score += 1;
  if (flow.promote_status === "promoted") score += 1;
  return score;
}

function explainBusinessFlowScore(flow: BusinessFlow, terms: string[], transitions: PageTransition[]): { identityScore: number; transitionScore: number; accepted: boolean; matchedTerms: string[] } {
  const flowTransitions = transitions.filter((transition) => flow.transition_ids.includes(transition.transition_id));
  const identityHaystack = [flow.name, ...flow.target_flows].join(" ").toLowerCase();
  const transitionHaystack = [
    ...flowTransitions.map((transition) => transition.action_description),
    ...flowTransitions.flatMap((transition) => transition.dsl_steps.map((step) => `${step.action} ${step.semantic_target ?? ""} ${step.target ?? ""} ${step.primary_locator ?? ""}`))
  ].join(" ").toLowerCase();
  const identity = scoreTerms(identityHaystack, terms);
  const transition = scoreTerms(transitionHaystack, terms);
  const accepted = identity.score > 0 || (flow.transition_ids.length <= 20 && transition.score > 0);
  return {
    identityScore: identity.score,
    transitionScore: transition.score,
    accepted,
    matchedTerms: [...new Set([...identity.matchedTerms, ...transition.matchedTerms])].slice(0, 12)
  };
}

function scoreTerms(haystack: string, terms: string[]): { score: number; matchedTerms: string[] } {
  let score = 0;
  const matchedTerms: string[] = [];
  for (const term of terms) {
    if (!haystack.includes(term)) continue;
    score += term.includes("/") || term.includes("-") || term.includes(" ") ? 3 : 1;
    matchedTerms.push(term);
  }
  return { score, matchedTerms };
}

function businessFlowRank(flow: BusinessFlow, score: number): number {
  return score + (flow.review_status === "approved" && flow.replay_status === "passed" ? 0.5 : 0) - Math.log10(Math.max(1, flow.transition_ids.length));
}

function rejectAssistantBusinessFlowForRequest(flow: BusinessFlow, message: string): boolean {
  const text = [flow.name, ...flow.target_flows].join(" ").toLowerCase();
  const request = message.toLowerCase();
  const wantsCreateRedPacket = /(\u521b\u5efa|\u53d1\u653e|\u53d1\u51fa|create|send).{0,16}(\u7ea2\u5305|red\s*packet|red-packet)|(\u7ea2\u5305|red\s*packet|red-packet).{0,16}(\u521b\u5efa|\u53d1\u653e|\u53d1\u51fa|create|send)/i.test(request);
  if (wantsCreateRedPacket) return /claim|passphrase|\u53e3\u4ee4|\u9886\u53d6|receive|redeem/.test(text) && !/create|\u521b\u5efa|\u53d1\u653e|send/.test(text);
  if (!isRedPacketRecordIntent(message)) return false;
  return /claim|passphrase|\u53e3\u4ee4|\u9886\u53d6/.test(text) && !/record|history|detail|\u8bb0\u5f55|\u660e\u7ec6/.test(text);
}

function inferAssistantOutcomeAssertions(message: string, plan?: Record<string, unknown>): DslAssertion[] {
  const text = `${message} ${String(plan?.intent ?? "")}`.toLowerCase();
  const expectsFailure = /(\u671f\u671b|\u5e94\u8be5|expect)?.{0,12}(\u5931\u8d25|\u4e0d\u6210\u529f|\u62d2\u7edd|fail|failed|failure|error)/i.test(text);
  const expectsSuccess = /(\u671f\u671b|\u5e94\u8be5|expect)?.{0,12}(\u6210\u529f|\u5b8c\u6210|success|succeed|passed)/i.test(text);
  if (!expectsFailure && !expectsSuccess) return [];
  const isSubscribe = /\u7533\u8d2d|subscribe|purchase|buy/i.test(text);
  const isCreateRedPacket = /(\u521b\u5efa|\u53d1\u653e|\u53d1\u51fa|create|send).{0,16}(\u7ea2\u5305|red\s*packet|red-packet)|(\u7ea2\u5305|red\s*packet|red-packet).{0,16}(\u521b\u5efa|\u53d1\u653e|\u53d1\u51fa|create|send)/i.test(text);
  const expected = isSubscribe
    ? expectsFailure ? ["\u7533\u8d2d\u5931\u8d25", "\u8d2d\u4e70\u5931\u8d25", "\u64cd\u4f5c\u5931\u8d25", "\u5931\u8d25", "error", "failed"] : ["\u7533\u8d2d\u6210\u529f", "\u8d2d\u4e70\u6210\u529f", "\u64cd\u4f5c\u6210\u529f", "\u6210\u529f", "success"]
    : isCreateRedPacket
      ? expectsFailure ? ["\u521b\u5efa\u5931\u8d25", "\u64cd\u4f5c\u5931\u8d25", "\u5931\u8d25", "error", "failed"] : ["\u521b\u5efa\u6210\u529f", "\u64cd\u4f5c\u6210\u529f", "\u6210\u529f", "success", "Succeed"]
      : expectsFailure ? ["\u9886\u53d6\u5931\u8d25", "\u64cd\u4f5c\u5931\u8d25", "\u5931\u8d25", "error", "failed"] : ["\u9886\u53d6\u6210\u529f", "\u64cd\u4f5c\u6210\u529f", "\u6210\u529f", "success"];
  return [{ type: "textVisibleAny", target: expectsFailure ? "expected failure message" : "expected success message", expected }];
}

function extractCodeLikeValue(message: string, plan?: Record<string, unknown>): string | undefined {
  const parts = [message, String(plan?.intent ?? "")];
  for (const text of parts) {
    for (const match of text.matchAll(/\b[A-Z0-9]{4,20}\b/gi)) {
      const candidate = match[0].trim().toUpperCase();
      if (isCodeLikeValue(candidate)) return candidate;
    }
  }
  return undefined;
}

function isCodeLikeValue(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const candidate = value.trim().toUpperCase();
  return /^[A-Z0-9]{4,20}$/.test(candidate) && !["DEMO", "TEST", "UAT", "RED", "PACKET", "TOKEN", "LOGIN", "USER", "ACCOUNT"].includes(candidate);
}

function isCodeInputTarget(value: string): boolean {
  return /code|token|passphrase|\u53e3\u4ee4|\u9a8c\u8bc1\u7801|\u7ea2\u5305/i.test(value);
}

function isLocatorLike(value: string): boolean {
  return /^(css=|xpath=|role=|text=|textExact=|id=|data-testid=|aria=|input|button|select|textarea|\.|#|\[|\/|\()/i.test(value);
}

function readAssistantJsonPath(value: unknown, pathText: string): unknown {
  return pathText.split(".").reduce<unknown>((current, key) => current && typeof current === "object" && key in current ? (current as Record<string, unknown>)[key] : undefined, value);
}

function formatAssistantDateTime(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function chooseAccount(message: string, accounts: TestAccount[]): TestAccount | undefined {
  const normalized = message.toLowerCase();
  return (
    accounts.find((item) => normalized.includes(item.username.toLowerCase())) ??
    accounts.find((item) => item.label && normalized.includes(item.label.toLowerCase())) ??
    accounts[0]
  );
}

function summarizeKnowledgeHits(chunks: KnowledgeChunk[]): Array<{
  title: string;
  sourceType: string;
  surface?: string;
  confidence: number;
  content: string;
} & CandidateEvidenceMetadata> {
  return chunks.slice(0, 8).map((item) => ({
    title: item.title,
    sourceType: item.sourceType,
    surface: item.surface,
    confidence: item.confidence,
    content: item.content.slice(0, 240),
    ...candidateMetadataFromRecord({ ...item.metadata, sourceType: item.sourceType })
  }));
}

async function buildAssistantWriteReadiness(context: Awaited<ReturnType<typeof loadContext>>, message: string, automationReason?: string): Promise<string> {
  const readinessGraph = await new PageGraphStore(context).load();
  const readinessKnowledgeHits = await new KnowledgeStore(context).search(message, 8);
  const readinessTerms = assistantIntentTerms(message, { intent: message });
  const readinessPages = readinessGraph.nodes
    .map((node) => {
      const text = `${node.url ?? ""} ${node.title ?? ""} ${node.semanticName ?? ""} ${node.elements.map((item) => `${item.text ?? ""} ${item.selector ?? ""}`).join(" ")}`.toLowerCase();
      const score = readinessTerms.reduce((sum, term) => sum + (text.includes(term) ? 1 : 0), 0);
      return { node, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
  const readinessElements = readinessPages.flatMap((item) =>
    item.node.elements
      .filter((element) => {
        const text = `${element.text ?? ""} ${element.selector ?? ""}`.toLowerCase();
        return readinessTerms.some((term) => text.includes(term)) || /amount|count|input|submit|buy|purchase|subscribe|redeem|claim/i.test(text);
      })
      .slice(0, 8)
      .map((element) => `${element.text || element.role || "element"} => ${element.selector ?? element.href ?? ""}`)
  );
  return [
    "Assistant write task was blocked before execution.",
    "",
    "Current diagnosis:",
    `- Route decision: ${automationReason ?? "No executable AutomationCase was built."}`,
    `- Page graph: ${readinessGraph.nodes.length} nodes / ${readinessGraph.edges.length} paths`,
    `- Search terms: ${readinessTerms.join(", ") || "(none)"}`,
    `- Related pages: ${readinessPages.length}`,
    `- Knowledge hits: ${readinessKnowledgeHits.length}`,
    readinessElements.length ? `- Candidate elements: ${readinessElements.slice(0, 10).join("; ")}` : "- Candidate elements: no stable form/action element was confirmed from local page memory",
    "",
    "Missing assets:",
    "- A short executable business flow for this exact module/action, not a broad exploratory flow.",
    "- Concrete DSL steps such as navigate/click/input/select/assert for the target page.",
    "- Stable locators and page prompts for result assertions.",
    "",
    "Expected local follow-up:",
    "- Open the candidate page from the failure package, capture screenshot/visible text/DOM controls, then write the missing PageState, PageTransition, BusinessFlow, and assertion prompts back to local storage."
  ].join("\n");
  const graph = await new PageGraphStore(context).load();
  const knowledgeHits = await new KnowledgeStore(context).search(message, 8);
  const matchingPages = graph.nodes.filter((node) => {
    const url = `${node.url ?? ""}`.toLowerCase();
    if (/red-packet|red_packet|assets\/red-packet|personal\/coupon|futures%20bonus|futures bonus/.test(url)) return true;
    return writeTargetTerms(message).some((term) => url.includes(term));
  });
  const matchingElements = matchingPages.flatMap((page) =>
    page.elements
      .filter((item) => /红包|创建|领取|金额|个数|red\s*packet|bonus|create|amount|count/i.test(`${item.text ?? ""} ${item.selector ?? ""}`))
      .slice(0, 12)
      .map((item) => `${item.text || item.role || "element"} => ${item.selector ?? item.href ?? ""}`)
  );
  return [
    "AI 助手已识别到这是写操作任务，当前没有真正执行。",
    "",
    "已具备：",
    `- 环境允许写操作：${context.env.safety?.writeActionsAllowed === false ? "否" : "是"}（${context.env.env}）`,
    `- 页面地图：${graph.nodes.length} 个节点 / ${graph.edges.length} 条路径`,
    `- 命中相关页面：${matchingPages.length} 个`,
    `- 命中知识块：${knowledgeHits.length} 条`,
    matchingElements.length ? `- 可用候选元素：${matchingElements.slice(0, 8).join("；")}` : "- 可用候选元素：未从页面地图中确认到足够表单字段",
    "",
    "缺少：",
    "- AI plan -> AutomationCase 的转换层：当前步骤仍是 prepareWriteOperation，不是 click/input/select/assert/confirmWrite。",
    "- Assistant execute -> DslExecutor 的桥接：工作台执行按钮没有调用通用 DSL 执行器执行写操作。",
    "- 旁路登录与 DslExecutor 的集成：执行器启动浏览器时还没有自动用账号换 token 并注入登录态。",
    "- 写操作确认闸门：需要按步骤执行到 confirmWrite 前暂停，确认后才允许提交。",
    "- 表单字段推断与补全：例如红包个数、金额等字段需要稳定 locator、输入值映射和提交前断言。",
    "",
    "下一步应先实现一个受控写操作闭环：生成临时 AutomationCase -> 注入登录态 -> 导航到目标页 -> 填字段 -> 停在 confirmWrite，不直接误报成功。"
  ].join("\n");
}

function writeTargetTerms(message: string): string[] {
  const normalized = message.toLowerCase();
  const terms: string[] = [];
  if (/红包|red\s*packet/.test(normalized)) terms.push("红包", "red packet", "red-packet");
  if (/bonus/.test(normalized)) terms.push("bonus");
  if (/coupon|卡券|优惠券/.test(normalized)) terms.push("coupon", "卡券", "优惠券");
  return [...new Set(terms)];
}

async function saveUploadedApp(input: {
  project: string;
  env: string;
  filename: string;
  contentBase64: string;
  version?: string;
}): Promise<{ id: string; filePath: string; uploadedAt: string; sha256: string; sizeBytes: number }> {
  const uploadedAt = new Date().toISOString();
  const bytes = Buffer.from(input.contentBase64, "base64");
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  const id = `${uploadedAt.replace(/[-:.TZ]/g, "").slice(0, 14)}-${sha256.slice(0, 8)}`;
  const archiveDir = appArchiveDir(input.project, input.env, uploadedAt.slice(0, 10));
  const filePath = path.join(archiveDir, `${id}-${safeFileName(input.filename)}`);
  await fs.ensureDir(archiveDir);
  await fs.writeFile(filePath, bytes);

  const history = await readAppArchiveHistory(input.project, input.env);
  history.apps.unshift({
    id,
    filename: input.filename,
    version: input.version,
    filePath,
    sizeBytes: bytes.length,
    sha256,
    uploadedAt
  });
  await writeAppArchiveHistory(history);
  return { id, filePath, uploadedAt, sha256, sizeBytes: bytes.length };
}

async function appendAppExplorationHistory(input: Omit<AppArchiveHistory["explorations"][number], "exploredAt"> & {
  project: string;
  env: string;
}): Promise<void> {
  const history = await readAppArchiveHistory(input.project, input.env);
  history.explorations.unshift({
    exploredAt: new Date().toISOString(),
    apkPath: input.apkPath,
    appPackage: input.appPackage,
    appActivity: input.appActivity,
    deviceId: input.deviceId,
    maxDepth: input.maxDepth,
    maxPages: input.maxPages,
    exitCode: input.exitCode
  });
  await writeAppArchiveHistory(history);
}

async function readWorkbenchCaseStore(project: string): Promise<WorkbenchCaseStoreData> {
  const filePath = workbenchCaseStorePath(project);
  if (!(await fs.pathExists(filePath))) {
    const seeded: WorkbenchCaseStoreData = {
      schemaVersion: "workbench-case-store.v1",
      project,
      updatedAt: new Date().toISOString(),
      cases: seedWorkbenchCases(project)
    };
    await writeWorkbenchCaseStore(seeded);
    return seeded;
  }
  const data = (await fs.readJson(filePath)) as WorkbenchCaseStoreData;
  const migrated = await migrateLegacyWorkbenchCaseRuntimeState(project, data);
  if (project === defaultProject && !data.cases.some((item) => item.module === "资产中心/现货流水")) {
    data.cases.unshift(...seedWorkbenchCases(project));
    await writeWorkbenchCaseStore(data);
  } else if (migrated) {
    await writeWorkbenchCaseStore(data);
  }
  return data;
}

async function writeWorkbenchCaseStore(data: WorkbenchCaseStoreData): Promise<string> {
  data.updatedAt = new Date().toISOString();
  const filePath = workbenchCaseStorePath(data.project);
  await writeSafeJsonFile(filePath, data);
  return filePath;
}

async function readWorkbenchCaseAssetStore(): Promise<WorkbenchCaseStoreData> {
  return readWorkbenchCaseStore(defaultProject);
}

async function writeWorkbenchCaseAssetStore(data: WorkbenchCaseStoreData): Promise<string> {
  return writeWorkbenchCaseStore({ ...data, project: defaultProject });
}

function workbenchCaseStorePath(project: string): string {
  return path.join(rootDir, "storage", "cases", `${safePathSegment(project)}.json`);
}

function workbenchCaseDslStorePath(project: string, caseId: string): string {
  return path.join(rootDir, "storage", "case-dsl", safePathSegment(project), `${safePathSegment(caseId)}.json`);
}

function workbenchCaseDslGenerationSummaryPath(project: string, env: string, caseId: string): string {
  return path.join(rootDir, "storage", "case-dsl-generation-history", safePathSegment(project), safePathSegment(env), `${safePathSegment(caseId)}.json`);
}

function workbenchCaseHistoryStorePath(project: string, caseId: string): string {
  return path.join(rootDir, "storage", "case-history", safePathSegment(project), `${safePathSegment(caseId)}.json`);
}

async function readWorkbenchCaseDsl(project: string, caseId: string): Promise<WorkbenchCaseDsl | undefined> {
  const filePath = workbenchCaseDslStorePath(project, caseId);
  return await fs.pathExists(filePath) ? await fs.readJson(filePath) as WorkbenchCaseDsl : undefined;
}

async function writeWorkbenchCaseDsl(project: string, caseId: string, dsl: WorkbenchCaseDsl): Promise<string> {
  const filePath = workbenchCaseDslStorePath(project, caseId);
  await writeSafeJsonFile(filePath, dsl);
  return filePath;
}

async function readWorkbenchCaseDslGenerationSummary(project: string, env: string, caseId: string): Promise<WorkbenchCaseDslGenerationSummary | undefined> {
  const filePath = workbenchCaseDslGenerationSummaryPath(project, env, caseId);
  return await fs.pathExists(filePath) ? await fs.readJson(filePath) as WorkbenchCaseDslGenerationSummary : undefined;
}

async function writeWorkbenchCaseDslGenerationSummary(summary: WorkbenchCaseDslGenerationSummary): Promise<string> {
  const filePath = workbenchCaseDslGenerationSummaryPath(summary.project, summary.env, summary.caseId);
  await writeSafeJsonFile(filePath, summary);
  return filePath;
}

async function deleteWorkbenchCaseDslGenerationSummariesForCase(project: string, caseId: string): Promise<void> {
  const root = path.join(rootDir, "storage", "case-dsl-generation-history", safePathSegment(project));
  if (!(await fs.pathExists(root))) return;
  const envs = await fs.readdir(root);
  await Promise.all(envs.map((env) => fs.remove(workbenchCaseDslGenerationSummaryPath(project, env, caseId))));
}

async function readWorkbenchCaseExecutionHistory(project: string, caseId: string): Promise<WorkbenchCaseExecution[]> {
  const filePath = workbenchCaseHistoryStorePath(project, caseId);
  if (!(await fs.pathExists(filePath))) return [];
  const data = await fs.readJson(filePath) as { schemaVersion?: string; executions?: WorkbenchCaseExecution[] };
  return Array.isArray(data.executions) ? data.executions : [];
}

async function readAccountProfileBundle(project: string, env: string): Promise<AccountProfileBundle> {
  const schemaPath = path.join(rootDir, "storage", "account-profile-schemas", `${project}.json`);
  const mappingPath = path.join(rootDir, "storage", "account-profile-mappings", `${project}.json`);
  const profilePath = path.join(rootDir, "storage", "account-profiles", project, `${env}.json`);
  const [schema, mapping, profile] = await Promise.all([
    fs.pathExists(schemaPath).then((exists) => exists ? fs.readJson(schemaPath) : undefined),
    fs.pathExists(mappingPath).then((exists) => exists ? fs.readJson(mappingPath) : undefined),
    fs.pathExists(profilePath).then((exists) => exists ? fs.readJson(profilePath) : undefined)
  ]);
  return {
    project,
    env,
    schema: schema ?? { schemaVersion: "account-profile-schema.v1", project, dimensions: [] },
    mapping: mapping ?? { schemaVersion: "account-profile-mapping-store.v1", project, mappings: [] },
    profile: profile ?? { schemaVersion: "account-profile-store.v1", project, env, profiles: [] }
  };
}

async function writeAccountProfileStore(project: string, env: string, profile: AccountProfileStoreData): Promise<string> {
  const filePath = path.join(rootDir, "storage", "account-profiles", safePathSegment(project), `${safePathSegment(env)}.json`);
  profile.project = project;
  profile.env = env;
  profile.updatedAt = new Date().toISOString();
  await writeSafeJsonFile(filePath, profile);
  return filePath;
}

async function readDatabaseModelStore(project: string): Promise<Record<string, unknown>> {
  const filePath = path.join(rootDir, "storage", "database-models", `${safePathSegment(project)}.json`);
  if (!(await fs.pathExists(filePath))) {
    return {
      ok: false,
      schemaVersion: "database-model-store-result.v1",
      project,
      status: "missing",
      models: [],
      message: "Database model store does not exist for this project."
    };
  }
  return {
    ok: true,
    schemaVersion: "database-model-store-result.v1",
    project,
    model: await fs.readJson(filePath)
  };
}

async function refreshAccountProfilesFromDatabase(input: {
  project: string;
  env: string;
  username?: string;
}): Promise<Record<string, unknown>> {
  const databaseModel = await readDatabaseModelStore(input.project);
  if (!databaseModel.ok) {
    return {
      ok: false,
      schemaVersion: "account-profile-refresh-result.v1",
      project: input.project,
      env: input.env,
      status: "blocked_by_missing_database_model",
      diagnostics: {
        stage: "account_profile_refresh",
        reason: "No verified Database Model is available for this project."
      }
    };
  }
  if (input.project !== "demo" || input.env !== "test") {
    return {
      ok: false,
      schemaVersion: "account-profile-refresh-result.v1",
      project: input.project,
      env: input.env,
      status: "blocked_by_missing_project_adapter",
      diagnostics: {
        stage: "account_profile_refresh",
        reason: "The first version only has a verified readonly adapter for demo/test project_spot.",
        requiredNextStep: "Create a project-specific Database Model and Account Profile mapping before enabling refresh."
      }
    };
  }
  const context = await loadContext({ project: input.project, env: input.env });
  const accounts = await new AccountStore(context).list({ project: input.project, env: input.env, username: input.username });
  const usernames = accounts.map((account) => account.username).filter(Boolean);
  if (!usernames.length) {
    return {
      ok: false,
      schemaVersion: "account-profile-refresh-result.v1",
      project: input.project,
      env: input.env,
      status: "blocked_by_no_account",
      diagnostics: {
        stage: "account_profile_refresh",
        reason: "No account is configured for the requested project/env/username."
      }
    };
  }
  const result = await queryDemoAccountProfileRows(input.project, input.env, usernames);
  if (result.ok !== true) return result;
  const bundle = await readAccountProfileBundle(input.project, input.env);
  const profile = mergeDemoAccountProfileRows({
    store: bundle.profile,
    accounts,
    updatedAt: new Date().toISOString(),
    userRows: result.userRows,
    kycRows: result.kycRows,
    spotRows: result.spotRows,
    spotFlowRows: result.spotFlowRows,
    spotWithdrawFlowRows: result.spotWithdrawFlowRows,
    spotInnerTransferFlowRows: result.spotInnerTransferFlowRows,
    spotBatchTransferFlowRows: result.spotBatchTransferFlowRows,
    earnRows: result.earnRows,
    earnFlowRows: result.earnFlowRows,
    futuresUserRows: result.futuresUserRows,
    futuresAccountRows: result.futuresAccountRows,
    futuresFlowRows: result.futuresFlowRows
  });
  const filePath = await writeAccountProfileStore(input.project, input.env, profile);
  return {
    ok: true,
    schemaVersion: "account-profile-refresh-result.v1",
    project: input.project,
    env: input.env,
    sourceId: "multi_source",
    status: "refreshed",
    updatedAt: profile.updatedAt,
    refreshedProfiles: profile.profiles
      .filter((item) => usernames.some((username) => username.toLowerCase() === item.username.toLowerCase()))
      .map((item) => ({
        username: item.username,
        accountId: item.accountId,
        uid: item.dimensions?.["profile.uid"]?.value,
        profileStatus: item.profileStatus,
        dimensionCount: Object.keys(item.dimensions ?? {}).length
      })),
    diagnostics: {
      stage: "account_profile_refresh",
      databaseModelIds: [
        "demo.user.identity.v1",
        "demo.user.kyc_entities.v1",
        "demo.spot.assets.v1",
        "demo.spot.deposit_flow.v1",
        "demo.spot.withdraw_flow.v1",
        "demo.spot.inner_transfer_flow.v1",
        "demo.spot.batch_transfer_flow.v1",
        "demo.earn.assets.v1",
        "demo.futures.user.identity.v1",
        "demo.futures.assets.v1",
        "demo.futures.transaction_flow.v1"
      ],
      queries: result.queries,
      outputPath: path.relative(rootDir, filePath).replace(/\\/g, "/")
    }
  };
}

async function queryDemoAccountProfileRows(project: string, env: string, usernames: string[]): Promise<DemoAccountProfileQueryRows | AccountProfileRefreshBlocked> {
  const inClause = usernames.map(sqlStringLiteral).join(", ");
  const futuresUserSubquery = `SELECT id, origin_uid, email FROM futures.user WHERE email IN (${inClause})`;
  const queries = [
    {
      id: "demo.user.identity.v1",
      sourceId: "project_spot",
      sql: `SELECT id AS uid, email, auth_level, google_authenticator_status, mobile_authenticator_status, login_status, exc_status, withdraw_status, delete_status, mobile_number FROM exchange.user WHERE email IN (${inClause})`
    },
    {
      id: "demo.user.kyc_entities.v1",
      sourceId: "project_spot",
      sql: `SELECT u.id AS uid, u.email, u.auth_level AS userAuthLevel, r.auth_status AS realnameStatus, c.auth_status AS certificateStatus, rr.status AS latestReviewStatus FROM exchange.user u LEFT JOIN exchange.auth_realname r ON r.uid = u.id LEFT JOIN exchange.auth_certificate c ON c.uid = u.id LEFT JOIN (SELECT x.uid, x.status FROM exchange.auth_real_name_record x JOIN (SELECT uid, MAX(id) AS max_id FROM exchange.auth_real_name_record GROUP BY uid) latest ON latest.uid = x.uid AND latest.max_id = x.id) rr ON rr.uid = u.id WHERE u.email IN (${inClause})`
    },
    {
      id: "demo.spot.assets.v1",
      sourceId: "project_spot",
      sql: `SELECT u.id AS uid, u.email, cat.coin_symbol AS coinSymbol, cat.asset_bc AS assetBc, cat.asset_type AS assetType, a.balance FROM exchange.user u JOIN exchange.account a ON a.uid = u.id LEFT JOIN exchange.config_account_type cat ON a.type = cat.asset_type WHERE u.email IN (${inClause})`
    },
    {
      id: "demo.spot.deposit_flow.v1",
      sourceId: "project_spot",
      sql: `SELECT u.id AS uid, u.email, d.symbol AS coinSymbol, COUNT(*) AS recordCount, MAX(d.created_at) AS latestRecordAt FROM exchange.user u JOIN exchange.transaction_deposit_crypto d ON d.uid = u.id WHERE u.email IN (${inClause}) AND d.status = 1 GROUP BY u.id, u.email, d.symbol`
    },
    {
      id: "demo.spot.withdraw_flow.v1",
      sourceId: "project_spot",
      sql: `SELECT u.id AS uid, u.email, CASE WHEN w.symbol = 'BSCUSDT' THEN 'USDT' ELSE w.symbol END AS coinSymbol, COUNT(*) AS recordCount, MAX(w.created_at) AS latestRecordAt FROM exchange.user u JOIN exchange.transaction_withdraw_crypto w ON w.uid = u.id WHERE u.email IN (${inClause}) AND w.status = 5 GROUP BY u.id, u.email, CASE WHEN w.symbol = 'BSCUSDT' THEN 'USDT' ELSE w.symbol END`
    },
    {
      id: "demo.spot.inner_transfer_flow.v1",
      sourceId: "project_spot",
      sql: `SELECT u.id AS uid, u.email, t.coin_symbol AS coinSymbol, SUM(CASE WHEN t.to_uid = u.id AND t.transfer_type = 0 THEN 1 ELSE 0 END) AS innerInCount, SUM(CASE WHEN t.from_uid = u.id AND t.transfer_type = 0 THEN 1 ELSE 0 END) AS innerOutCount, MAX(t.ctime) AS latestRecordAt FROM exchange.user u JOIN exchange.exchange_inner_transfer t ON t.from_uid = u.id OR t.to_uid = u.id WHERE u.email IN (${inClause}) AND t.status = 5 GROUP BY u.id, u.email, t.coin_symbol`
    },
    {
      id: "demo.spot.batch_transfer_flow.v1",
      sourceId: "project_spot",
      sql: `SELECT u.id AS uid, u.email, t.coin_symbol AS coinSymbol, COUNT(*) AS recordCount, MAX(t.ctime) AS latestRecordAt FROM exchange.user u JOIN exchange.exchange_inner_transfer t ON t.from_uid = u.id WHERE u.email IN (${inClause}) AND t.status = 5 AND t.transfer_type = 1 GROUP BY u.id, u.email, t.coin_symbol`
    },
    {
      id: "demo.earn.flow.v1",
      sourceId: "project_spot",
      sql: `SELECT u.id AS uid, u.email, t.coin AS coinSymbol, t.transaction_type AS transactionType, COUNT(*) AS recordCount, MAX(t.created_at) AS latestRecordAt FROM exchange.user u JOIN exchange_earn.earn_transaction t ON t.uid = u.id WHERE u.email IN (${inClause}) AND t.status = "SUCCESS" GROUP BY u.id, u.email, t.coin, t.transaction_type`
    },
    {
      id: "demo.earn.assets.v1",
      sourceId: "project_spot",
      sql: `SELECT u.id AS uid, u.email, e.currency AS coinSymbol, e.total_balance AS positionAmount, e.available_balance AS redeemableAmount, e.frozen_balance AS frozenAmount FROM exchange.user u JOIN exchange_earn.earn_user_account e ON e.user_id = u.id WHERE u.email IN (${inClause})`
    },
    {
      id: "demo.futures.user.identity.v1",
      sourceId: "project_futures",
      sql: `SELECT id AS futuresUid, origin_uid AS spotUid, email, login_status AS loginStatus, exc_status AS tradeStatus, trans_status AS transferStatus, ctime AS createdAt, mtime AS updatedAt FROM futures.user WHERE email IN (${inClause})`
    },
    {
      id: "demo.futures.assets.v1",
      sourceId: "project_futures",
      sql: `SELECT fu.id AS futuresUid, fu.origin_uid AS spotUid, fu.email, ua.symbol AS coinSymbol, ua.balance_total AS balanceTotal, ua.balance_margin AS balanceMargin, ua.balance_lock AS balanceLock, ua.balance_position AS balancePosition, ua.account_mtime AS accountUpdatedAt FROM (${futuresUserSubquery}) fu JOIN futures.user_account ua ON ua.uid = fu.id`
    },
    {
      id: "demo.futures.transaction_flow.v1",
      sourceId: "project_futures",
      sql: `SELECT fu.id AS futuresUid, fu.origin_uid AS spotUid, fu.email, x.scene AS recordType, x.direction, x.accountType, cat.coin_symbol AS coinSymbol, COUNT(*) AS recordCount, MIN(x.ctime) AS earliestRecordAt, MAX(x.ctime) AS latestRecordAt, COUNT(DISTINCT DATE(x.ctime)) AS coveredDays FROM (${futuresUserSubquery}) fu JOIN (SELECT from_uid AS targetUid, scene, 'OUT' AS direction, from_type AS accountType, ctime FROM futures.user_transaction WHERE from_uid IN (SELECT id FROM futures.user WHERE email IN (${inClause})) UNION ALL SELECT to_uid AS targetUid, scene, 'IN' AS direction, to_type AS accountType, ctime FROM futures.user_transaction WHERE to_uid IN (SELECT id FROM futures.user WHERE email IN (${inClause}))) x ON x.targetUid = fu.id LEFT JOIN futures.config_account_type cat ON cat.asset_type = x.accountType GROUP BY fu.id, fu.origin_uid, fu.email, x.scene, x.direction, x.accountType, cat.coin_symbol`
    }
  ];
  const outputs: Record<string, Array<Record<string, unknown>>> = {};
  const audit: Array<Record<string, unknown>> = [];
  for (const query of queries) {
    const output = await executeDatabaseWorkbenchSql({ project, env, sourceId: query.sourceId, sql: query.sql });
    audit.push({ id: query.id, sourceId: query.sourceId, status: output.ok ? "ok" : "failed", rowCount: output.rowCount ?? 0, error: output.error });
    if (!output.ok) {
      return {
        ok: false,
        schemaVersion: "account-profile-refresh-result.v1",
        project,
        env,
        status: "blocked_by_database_query_failed",
        diagnostics: {
          stage: "account_profile_refresh",
          failedQueryId: query.id,
          queries: audit,
          error: output.error
        }
      };
    }
    outputs[query.id] = Array.isArray(output.rows) ? output.rows as Array<Record<string, unknown>> : [];
  }
  return {
    ok: true,
    userRows: outputs["demo.user.identity.v1"] ?? [],
    kycRows: outputs["demo.user.kyc_entities.v1"] ?? [],
    spotRows: outputs["demo.spot.assets.v1"] ?? [],
    spotFlowRows: outputs["demo.spot.deposit_flow.v1"] ?? [],
    spotWithdrawFlowRows: outputs["demo.spot.withdraw_flow.v1"] ?? [],
    spotInnerTransferFlowRows: outputs["demo.spot.inner_transfer_flow.v1"] ?? [],
    spotBatchTransferFlowRows: outputs["demo.spot.batch_transfer_flow.v1"] ?? [],
    earnRows: outputs["demo.earn.assets.v1"] ?? [],
    earnFlowRows: outputs["demo.earn.flow.v1"] ?? [],
    futuresUserRows: outputs["demo.futures.user.identity.v1"] ?? [],
    futuresAccountRows: outputs["demo.futures.assets.v1"] ?? [],
    futuresFlowRows: outputs["demo.futures.transaction_flow.v1"] ?? [],
    queries: audit
  };
}

function mergeDemoAccountProfileRows(input: {
  store: AccountProfileStoreData;
  accounts: TestAccount[];
  updatedAt: string;
  userRows: Array<Record<string, unknown>>;
  kycRows: Array<Record<string, unknown>>;
  spotRows: Array<Record<string, unknown>>;
  spotFlowRows: Array<Record<string, unknown>>;
  spotWithdrawFlowRows: Array<Record<string, unknown>>;
  spotInnerTransferFlowRows: Array<Record<string, unknown>>;
  spotBatchTransferFlowRows: Array<Record<string, unknown>>;
  earnRows: Array<Record<string, unknown>>;
  earnFlowRows: Array<Record<string, unknown>>;
  futuresUserRows: Array<Record<string, unknown>>;
  futuresAccountRows: Array<Record<string, unknown>>;
  futuresFlowRows: Array<Record<string, unknown>>;
}): AccountProfileStoreData {
  const existing = new Map((input.store.profiles ?? []).map((profile) => [profile.username.toLowerCase(), profile]));
  const profiles = new Map(existing);
  const rowsByEmail = new Map(input.userRows.map((row) => [String(row.email ?? "").toLowerCase(), row]));
  const kycByEmail = new Map(input.kycRows.map((row) => [String(row.email ?? "").toLowerCase(), row]));
  const spotByEmail = groupRowsByEmail(input.spotRows);
  const spotFlowByEmail = groupRowsByEmail(input.spotFlowRows);
  const spotWithdrawFlowByEmail = groupRowsByEmail(input.spotWithdrawFlowRows);
  const spotInnerTransferFlowByEmail = groupRowsByEmail(input.spotInnerTransferFlowRows);
  const spotBatchTransferFlowByEmail = groupRowsByEmail(input.spotBatchTransferFlowRows);
  const earnByEmail = groupRowsByEmail(input.earnRows);
  const earnFlowByEmail = groupRowsByEmail(input.earnFlowRows);
  const futuresUserByEmail = new Map(input.futuresUserRows.map((row) => [String(row.email ?? "").toLowerCase(), row]));
  const futuresAccountByEmail = groupRowsByEmail(input.futuresAccountRows);
  const futuresFlowByEmail = groupRowsByEmail(input.futuresFlowRows);
  for (const account of input.accounts) {
    const key = account.username.toLowerCase();
    const previous = profiles.get(key);
    const userRow = rowsByEmail.get(key);
    const dimensions: Record<string, AccountProfileDimensionValue> = { ...(previous?.dimensions ?? {}) };
    if (userRow) applyDemoUserDimensions(dimensions, userRow, input.updatedAt);
    const kycRow = kycByEmail.get(key);
    if (kycRow) applyDemoKycEntityDimensions(dimensions, kycRow, input.updatedAt);
    for (const row of spotByEmail.get(key) ?? []) applyDemoSpotDimensions(dimensions, row, input.updatedAt);
    for (const row of spotFlowByEmail.get(key) ?? []) applyDemoSpotFlowDimensions(dimensions, row, input.updatedAt);
    for (const row of spotWithdrawFlowByEmail.get(key) ?? []) applyDemoSpotWithdrawFlowDimensions(dimensions, row, input.updatedAt);
    for (const row of spotInnerTransferFlowByEmail.get(key) ?? []) applyDemoSpotInnerTransferFlowDimensions(dimensions, row, input.updatedAt);
    for (const row of spotBatchTransferFlowByEmail.get(key) ?? []) applyDemoSpotBatchTransferFlowDimensions(dimensions, row, input.updatedAt);
    for (const row of earnByEmail.get(key) ?? []) applyDemoEarnDimensions(dimensions, row, input.updatedAt);
    const earnFlowRows = earnFlowByEmail.get(key) ?? [];
    if (earnFlowRows.length) applyDemoEarnFlowAggregateDimension(dimensions, earnFlowRows, input.updatedAt);
    for (const row of earnFlowRows) applyDemoEarnFlowDimensions(dimensions, row, input.updatedAt);
    const futuresUserRow = futuresUserByEmail.get(key);
    if (futuresUserRow) applyDemoFuturesUserDimensions(dimensions, futuresUserRow, input.updatedAt);
    for (const row of futuresAccountByEmail.get(key) ?? []) applyDemoFuturesAccountDimensions(dimensions, row, input.updatedAt);
    applyDemoFuturesFlowDimensions(dimensions, futuresFlowByEmail.get(key) ?? [], input.updatedAt);
    profiles.set(key, {
      accountId: account.id ?? previous?.accountId ?? stableAccountProfileId(account.username),
      username: account.username,
      label: account.label ?? previous?.label,
      profileStatus: userRow ? "database_modeled" : previous?.profileStatus ?? "unknown",
      locationTags: buildDemoLocationTags(dimensions),
      dimensions
    });
  }
  return {
    schemaVersion: input.store.schemaVersion ?? "account-profile-store.v1",
    project: input.store.project,
    env: input.store.env,
    updatedAt: input.updatedAt,
    profiles: Array.from(profiles.values()).sort((a, b) => a.username.localeCompare(b.username))
  };
}

function applyDemoUserDimensions(dimensions: Record<string, AccountProfileDimensionValue>, row: Record<string, unknown>, updatedAt: string): void {
  const uid = row.uid;
  writeKnownDimension(dimensions, "profile.uid", uid, updatedAt, { table: "exchange.user", field: "id" });
  writeKnownDimension(dimensions, "identity.kyc", Number(row.auth_level ?? 0) >= 1 ? "passed_level" : "not_started", updatedAt, { table: "exchange.user", field: "auth_level", rawValue: row.auth_level });
  writeKnownDimension(dimensions, "security.emailBound", Boolean(row.email), updatedAt, { table: "exchange.user", field: "email" });
  writeKnownDimension(dimensions, "security.phoneBound", Boolean(row.mobile_number), updatedAt, { table: "exchange.user", field: "mobile_number" });
  writeKnownDimension(dimensions, "security.googleAuthenticatorBound", Number(row.google_authenticator_status ?? 0) === 1, updatedAt, { table: "exchange.user", field: "google_authenticator_status", rawValue: row.google_authenticator_status });
  writeKnownDimension(dimensions, "security.mobileAuthenticatorBound", Number(row.mobile_authenticator_status ?? 0) === 1, updatedAt, { table: "exchange.user", field: "mobile_authenticator_status", rawValue: row.mobile_authenticator_status });
  writeKnownDimension(dimensions, "security.loginEnabled", Number(row.login_status ?? 0) === 1, updatedAt, { table: "exchange.user", field: "login_status", rawValue: row.login_status });
  writeKnownDimension(dimensions, "security.tradeEnabled", Number(row.exc_status ?? 0) === 1, updatedAt, { table: "exchange.user", field: "exc_status", rawValue: row.exc_status });
  writeKnownDimension(dimensions, "security.withdrawEnabled", Number(row.withdraw_status ?? 0) === 1, updatedAt, { table: "exchange.user", field: "withdraw_status", rawValue: row.withdraw_status });
  writeKnownDimension(dimensions, "profile.deleted", Number(row.delete_status ?? 0) === 1, updatedAt, { table: "exchange.user", field: "delete_status", rawValue: row.delete_status });
}

function applyDemoKycEntityDimensions(dimensions: Record<string, AccountProfileDimensionValue>, row: Record<string, unknown>, updatedAt: string): void {
  const userAuthLevel = Number(row.userAuthLevel ?? 0);
  const realnameStatus = Number(row.realnameStatus ?? 0);
  const certificateStatus = Number(row.certificateStatus ?? 0);
  const latestReviewStatus = Number(row.latestReviewStatus ?? 0);
  const passed = userAuthLevel >= 2 && realnameStatus === 1 && certificateStatus === 1 && latestReviewStatus === 1;
  writeKnownDimension(dimensions, "identity.kyc", passed ? "passed_level" : "not_started", updatedAt, {
    table: "exchange.user + exchange.auth_realname + exchange.auth_certificate + exchange.auth_real_name_record",
    uid: row.uid,
    userAuthLevel,
    realnameStatus,
    certificateStatus,
    latestReviewStatus
  });
  writeKnownDimension(dimensions, "identity.kyc.realnameStatus", realnameStatus, updatedAt, { table: "exchange.auth_realname", field: "auth_status", uid: row.uid });
  writeKnownDimension(dimensions, "identity.kyc.certificateStatus", certificateStatus, updatedAt, { table: "exchange.auth_certificate", field: "auth_status", uid: row.uid });
  writeKnownDimension(dimensions, "identity.kyc.latestReviewStatus", latestReviewStatus, updatedAt, { table: "exchange.auth_real_name_record", field: "status", uid: row.uid });
}

function applyDemoSpotDimensions(dimensions: Record<string, AccountProfileDimensionValue>, row: Record<string, unknown>, updatedAt: string): void {
  const asset = normalizeAssetSymbol(row.coinSymbol);
  if (!asset) return;
  const assetBc = String(row.assetBc ?? "");
  const dimension = assetBc === "01"
    ? `assets.spot.${asset}.available`
    : assetBc === "02"
      ? `assets.spot.${asset}.frozen`
      : assetBc === "03"
        ? `assets.spot.${asset}.withdrawPending`
        : `assets.spot.${asset}.rawAccountType.${row.assetType ?? "unknown"}.balance`;
  writeKnownDimension(dimensions, dimension, normalizeDatabaseDecimal(row.balance), updatedAt, {
    table: "exchange.account",
    join: "exchange.config_account_type",
    uid: row.uid,
    coinSymbol: asset,
    assetBc,
    assetType: row.assetType
  });
}

function applyDemoSpotFlowDimensions(dimensions: Record<string, AccountProfileDimensionValue>, row: Record<string, unknown>, updatedAt: string): void {
  const asset = normalizeAssetSymbol(row.coinSymbol);
  const recordCount = Number(row.recordCount ?? 0);
  writeKnownDimension(dimensions, "history.spotFlow.types.DEPOSIT.exists", recordCount > 0, updatedAt, {
    table: "exchange.transaction_deposit_crypto",
    uid: row.uid,
    status: 1,
    recordType: "DEPOSIT",
    recordCount
  });
  if (!asset) return;
  writeKnownDimension(dimensions, `history.spotFlow.DEPOSIT.${asset}.exists`, recordCount > 0, updatedAt, {
    table: "exchange.transaction_deposit_crypto",
    uid: row.uid,
    symbol: asset,
    status: 1,
    recordCount,
    latestRecordAt: row.latestRecordAt
  });
}

function applyDemoSpotWithdrawFlowDimensions(dimensions: Record<string, AccountProfileDimensionValue>, row: Record<string, unknown>, updatedAt: string): void {
  const asset = normalizeAssetSymbol(row.coinSymbol);
  const recordCount = Number(row.recordCount ?? 0);
  writeKnownDimension(dimensions, "history.spotFlow.types.WITHDRAW.exists", recordCount > 0, updatedAt, {
    table: "exchange.transaction_withdraw_crypto",
    uid: row.uid,
    status: 5,
    recordType: "WITHDRAW",
    recordCount
  });
  if (!asset) return;
  writeKnownDimension(dimensions, `history.spotFlow.WITHDRAW.${asset}.exists`, recordCount > 0, updatedAt, {
    table: "exchange.transaction_withdraw_crypto",
    uid: row.uid,
    symbol: asset,
    status: 5,
    recordCount,
    latestRecordAt: row.latestRecordAt
  });
  writeKnownDimension(dimensions, `history.withdraw.ONCHAIN.${asset}.completed.exists`, recordCount > 0, updatedAt, {
    table: "exchange.transaction_withdraw_crypto",
    uid: row.uid,
    symbol: asset,
    status: 5,
    recordCount,
    latestRecordAt: row.latestRecordAt
  });
}

function applyDemoSpotInnerTransferFlowDimensions(dimensions: Record<string, AccountProfileDimensionValue>, row: Record<string, unknown>, updatedAt: string): void {
  const asset = normalizeAssetSymbol(row.coinSymbol);
  const innerInCount = Number(row.innerInCount ?? 0);
  const innerOutCount = Number(row.innerOutCount ?? 0);
  writeKnownDimension(dimensions, "history.spotFlow.types.INNER_IN.exists", innerInCount > 0, updatedAt, {
    table: "exchange.exchange_inner_transfer",
    uid: row.uid,
    status: 5,
    transferType: 0,
    direction: "IN",
    recordCount: innerInCount
  });
  writeKnownDimension(dimensions, "history.spotFlow.types.INNER_OUT.exists", innerOutCount > 0, updatedAt, {
    table: "exchange.exchange_inner_transfer",
    uid: row.uid,
    status: 5,
    transferType: 0,
    direction: "OUT",
    recordCount: innerOutCount
  });
  if (!asset) return;
  writeKnownDimension(dimensions, `history.spotFlow.INNER_IN.${asset}.exists`, innerInCount > 0, updatedAt, {
    table: "exchange.exchange_inner_transfer",
    uid: row.uid,
    symbol: asset,
    status: 5,
    transferType: 0,
    direction: "IN",
    recordCount: innerInCount,
    latestRecordAt: row.latestInnerInAt
  });
  writeKnownDimension(dimensions, `history.spotFlow.INNER_OUT.${asset}.exists`, innerOutCount > 0, updatedAt, {
    table: "exchange.exchange_inner_transfer",
    uid: row.uid,
    symbol: asset,
    status: 5,
    transferType: 0,
    direction: "OUT",
    recordCount: innerOutCount,
    latestRecordAt: row.latestInnerOutAt
  });
  writeKnownDimension(dimensions, `history.withdraw.INTERNAL_TRANSFER.${asset}.completed.exists`, innerOutCount > 0, updatedAt, {
    table: "exchange.exchange_inner_transfer",
    uid: row.uid,
    symbol: asset,
    status: 5,
    transferType: 0,
    direction: "OUT",
    recordCount: innerOutCount,
    latestRecordAt: row.latestInnerOutAt
  });
}

function applyDemoSpotBatchTransferFlowDimensions(dimensions: Record<string, AccountProfileDimensionValue>, row: Record<string, unknown>, updatedAt: string): void {
  const asset = normalizeAssetSymbol(row.coinSymbol);
  const recordCount = Number(row.recordCount ?? 0);
  if (!asset) return;
  writeKnownDimension(dimensions, `history.withdraw.BATCH_TRANSFER.${asset}.completed.exists`, recordCount > 0, updatedAt, {
    table: "exchange.exchange_inner_transfer",
    uid: row.uid,
    symbol: asset,
    status: 5,
    transferType: 1,
    direction: "OUT",
    recordCount,
    latestRecordAt: row.latestRecordAt
  });
}

function applyDemoEarnFlowAggregateDimension(dimensions: Record<string, AccountProfileDimensionValue>, rows: Array<Record<string, unknown>>, updatedAt: string): void {
  const totalCount = rows.reduce((sum, row) => sum + Number(row.recordCount ?? 0), 0);
  writeKnownDimension(dimensions, "history.earnFlow.records", {
    exists: totalCount > 0,
    assets: [...new Set(rows.map((row) => String(row.coinSymbol ?? "")).filter(Boolean))],
    transactionTypes: [...new Set(rows.map((row) => String(row.transactionType ?? "")).filter(Boolean))]
  }, updatedAt, {
    sourceId: "project_spot",
    table: "exchange_earn.earn_transaction",
    uid: rows[0]?.uid,
    totalCount
  });
}

function applyDemoEarnFlowDimensions(dimensions: Record<string, AccountProfileDimensionValue>, row: Record<string, unknown>, updatedAt: string): void {
  const uid = row.uid;
  const asset = String(row.coinSymbol ?? "");
  const transactionType = String(row.transactionType ?? "");
  const recordCount = Number(row.recordCount ?? 0);
  // transaction_type 形如 SUBSCRIBE_TRANSFER / REDEEM_TRANSFER 等；映射到 earnFlow 域的动作词。
  const action = transactionType.split("_")[0];
  if (action) {
    writeKnownDimension(dimensions, `history.earnFlow.types.${action}.exists`, recordCount > 0, updatedAt, {
      table: "exchange_earn.earn_transaction",
      uid,
      transactionType,
      recordCount
    });
  }
  if (asset && action) {
    writeKnownDimension(dimensions, `history.earnFlow.${action}.${asset}.exists`, recordCount > 0, updatedAt, {
      table: "exchange_earn.earn_transaction",
      uid,
      asset,
      transactionType,
      recordCount
    });
  }
}

function applyDemoEarnDimensions(dimensions: Record<string, AccountProfileDimensionValue>, row: Record<string, unknown>, updatedAt: string): void {
  const asset = normalizeAssetSymbol(row.coinSymbol);
  if (!asset) return;
  const positionAmount = normalizeDatabaseDecimal(row.positionAmount);
  const redeemableAmount = normalizeDatabaseDecimal(row.redeemableAmount);
  const frozenAmount = normalizeDatabaseDecimal(row.frozenAmount);
  const hasPosition = Number(positionAmount) > 0 || Number(redeemableAmount) > 0 || Number(frozenAmount) > 0;
  writeKnownDimension(dimensions, `assets.earn.${asset}.positionAmount`, positionAmount, updatedAt, { table: "exchange_earn.earn_user_account", uid: row.uid, coinSymbol: asset, field: "total_balance" });
  writeKnownDimension(dimensions, `assets.earn.${asset}.redeemableAmount`, redeemableAmount, updatedAt, { table: "exchange_earn.earn_user_account", uid: row.uid, coinSymbol: asset, field: "available_balance" });
  writeKnownDimension(dimensions, `assets.earn.${asset}.frozenAmount`, frozenAmount, updatedAt, { table: "exchange_earn.earn_user_account", uid: row.uid, coinSymbol: asset, field: "frozen_balance" });
  writeKnownDimension(dimensions, `earn.position.${asset}.exists`, hasPosition, updatedAt, { table: "exchange_earn.earn_user_account", uid: row.uid, coinSymbol: asset });
  writeKnownDimension(dimensions, `earn.position.${asset}.holdingAmount`, positionAmount, updatedAt, { table: "exchange_earn.earn_user_account", uid: row.uid, coinSymbol: asset, field: "total_balance" });
  writeKnownDimension(dimensions, `earn.position.${asset}.redeemableAmount`, redeemableAmount, updatedAt, { table: "exchange_earn.earn_user_account", uid: row.uid, coinSymbol: asset, field: "available_balance" });
}

function applyDemoFuturesUserDimensions(dimensions: Record<string, AccountProfileDimensionValue>, row: Record<string, unknown>, updatedAt: string): void {
  const enabled = Number(row.loginStatus ?? 0) === 1 && Number(row.tradeStatus ?? 0) === 1 && Number(row.transferStatus ?? 0) === 1;
  writeKnownDimension(dimensions, "feature.contractTrading.enabled", enabled, updatedAt, {
    sourceId: "project_futures",
    table: "futures.user",
    futuresUid: row.futuresUid,
    spotUid: row.spotUid,
    loginStatus: row.loginStatus,
    tradeStatus: row.tradeStatus,
    transferStatus: row.transferStatus
  });
}

function applyDemoFuturesAccountDimensions(dimensions: Record<string, AccountProfileDimensionValue>, row: Record<string, unknown>, updatedAt: string): void {
  const asset = normalizeAssetSymbol(row.coinSymbol);
  if (!asset) return;
  writeKnownDimension(dimensions, `assets.futures.${asset}.total`, normalizeDatabaseDecimal(row.balanceTotal), updatedAt, {
    sourceId: "project_futures",
    table: "futures.user_account",
    futuresUid: row.futuresUid,
    spotUid: row.spotUid,
    field: "balance_total"
  });
  writeKnownDimension(dimensions, `assets.futures.${asset}.margin`, normalizeDatabaseDecimal(row.balanceMargin), updatedAt, {
    sourceId: "project_futures",
    table: "futures.user_account",
    futuresUid: row.futuresUid,
    spotUid: row.spotUid,
    field: "balance_margin"
  });
}

function applyDemoFuturesFlowDimensions(dimensions: Record<string, AccountProfileDimensionValue>, rows: Array<Record<string, unknown>>, updatedAt: string): void {
  if (!rows.length) return;
  const coverage = rows
    .map((row) => ({
      start: row.earliestRecordAt,
      end: row.latestRecordAt,
      continuity: Number(row.coveredDays ?? 0) > 1 ? "sparse" : "unknown",
      count: Number(row.recordCount ?? 0),
      recordType: normalizeDemoFuturesRecordType(row.recordType)
    }))
    .filter((item) => item.start && item.end && item.count > 0);
  const totalCount = coverage.reduce((sum, item) => sum + item.count, 0);
  if (!coverage.length) return;
  writeKnownDimension(dimensions, "history.contractFlow.records", {
    exists: totalCount > 0,
    dateCoverage: coverage
  }, updatedAt, {
    sourceId: "project_futures",
    table: "futures.user_transaction",
    futuresUid: rows[0]?.futuresUid,
    spotUid: rows[0]?.spotUid,
    scenes: rows.map((row) => row.recordType).filter(Boolean)
  });
  for (const row of rows) {
    const recordType = normalizeDemoFuturesRecordType(row.recordType);
    const recordCount = Number(row.recordCount ?? 0);
    const asset = normalizeAssetSymbol(row.coinSymbol);
    if (!recordType) continue;
    writeKnownDimension(dimensions, `history.contractFlow.types.${recordType}.exists`, recordCount > 0, updatedAt, {
      sourceId: "project_futures",
      table: "futures.user_transaction",
      futuresUid: row.futuresUid,
      spotUid: row.spotUid,
      scene: row.recordType,
      direction: row.direction,
      accountType: row.accountType,
      recordCount,
      earliestRecordAt: row.earliestRecordAt,
      latestRecordAt: row.latestRecordAt
    });
    if (asset) {
      writeKnownDimension(dimensions, `history.contractFlow.${recordType}.${asset}.exists`, recordCount > 0, updatedAt, {
        sourceId: "project_futures",
        table: "futures.user_transaction",
        join: "futures.config_account_type.asset_type",
        futuresUid: row.futuresUid,
        spotUid: row.spotUid,
        scene: row.recordType,
        direction: row.direction,
        accountType: row.accountType,
        coinSymbol: asset,
        recordCount,
        earliestRecordAt: row.earliestRecordAt,
        latestRecordAt: row.latestRecordAt
      });
    }
  }
}

function normalizeDemoFuturesRecordType(value: unknown): string {
  const text = String(value ?? "").trim().toLowerCase();
  if (text === "futures_transfer_in") return "transfer_in";
  if (text === "futures_transfer_out") return "transfer_out";
  return text.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function writeKnownDimension(dimensions: Record<string, AccountProfileDimensionValue>, key: string, value: unknown, updatedAt: string, evidence: Record<string, unknown>): void {
  dimensions[key] = {
    status: "known",
    value,
    source: "database_probe",
    mappingId: "demo.database.property-profile.v1",
    updatedAt,
    evidence
  };
}

function buildDemoLocationTags(dimensions: Record<string, AccountProfileDimensionValue>): AccountProfileTagValue[] {
  const hasKnown = (key: string, expected?: unknown) => {
    const item = dimensions[key];
    if (!item || item.status !== "known") return false;
    return expected === undefined ? true : item.value === expected;
  };
  const tags: AccountProfileTagValue[] = [];
  if (hasKnown("profile.uid")) tags.push({ tag: "read_only_query", status: "known", reason: "Database profile has UID and account state." });
  if (Object.keys(dimensions).some((key) => /^assets\.spot\..+\.available$/.test(key))) tags.push({ tag: "write_asset_operation", status: "known", reason: "Spot available balances are present in database profile." });
  if (hasKnown("security.googleAuthenticatorBound", true) && hasKnown("security.emailBound", true)) tags.push({ tag: "provider_verification_ready", status: "known", reason: "Database profile confirms Google authenticator and bound email." });
  if (Object.keys(dimensions).some((key) => /^assets\.earn\..+\.positionAmount$/.test(key))) tags.push({ tag: "earn_position_operation", status: "known", reason: "Earn position balances are present in database profile." });
  if (hasKnown("feature.contractTrading.enabled", true)) tags.push({ tag: "contract_operation", status: "known", reason: "Futures database profile confirms contract trading is enabled." });
  if (Object.keys(dimensions).some((key) => /^history\.contractFlow\./.test(key))) tags.push({ tag: "contract_flow_query", status: "known", reason: "Futures transaction records are present in database profile." });
  if (hasKnown("earn.product.USDT.active.exists", true)) tags.push({ tag: "earn_product_query", status: "known", reason: "Page/database profile confirms an active USDT earn product is available." });
  if (hasKnown("assets.spot.USDT.available", "0") || hasKnown("assets.spot.USDT.available", 0)) tags.push({ tag: "earn_negative_balance", status: "known", reason: "USDT spot available balance is known to be zero for negative subscribe scenarios." });
  return tags;
}

function groupRowsByEmail(rows: Array<Record<string, unknown>>): Map<string, Array<Record<string, unknown>>> {
  const grouped = new Map<string, Array<Record<string, unknown>>>();
  for (const row of rows) {
    const email = String(row.email ?? "").toLowerCase();
    if (!email) continue;
    const bucket = grouped.get(email) ?? [];
    bucket.push(row);
    grouped.set(email, bucket);
  }
  return grouped;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeAssetSymbol(value: unknown): string | undefined {
  const text = String(value ?? "").trim();
  return text ? text.toUpperCase() : undefined;
}

function normalizeDatabaseDecimal(value: unknown): unknown {
  if (value === null || value === undefined) return "0";
  return typeof value === "number" ? String(value) : String(value);
}

function stableAccountProfileId(username: string): string {
  return crypto.createHash("sha1").update(username.toLowerCase()).digest("hex").slice(0, 16);
}

function sqlStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function readAccountFactoryCapabilities(project: string, env: string): Promise<Record<string, unknown>> {
  const configDir = path.join(rootDir, "configs", "projects", safePathSegment(project));
  const projectConfigPath = path.join(configDir, "project.config.yaml");
  const projectConfig = await readYamlRecord(projectConfigPath);
  const context = await loadContext({ project, env });
  const adapter = accountFactoryAdapterFor(context);
  const webReady = Boolean(context.env.web?.baseUrl);
  const apiReady = Boolean(context.env.api?.baseUrl);
  const capabilities = [
    {
      capabilityId: "environment_config",
      name: "环境配置",
      status: webReady || apiReady ? "ready" : "missing",
      reason: "Project environment file exists."
    }
  ].concat(adapter ? await adapter.capabilities(context) : []);
  const registrationReady = capabilities.some((item) => item.capabilityId === "registration_policy" && item.status === "ready");
  const hardBlocked = capabilities.some((item) => ["missing", "blocked"].includes(String(item.status)));
  const status = registrationReady ? hardBlocked ? "partial_ready" : "ready" : "blocked_by_missing_adapter";
  const envAccountFactory = isRecord(context.env.accountFactory) ? context.env.accountFactory : {};
  const configuredNamingRule = isRecord(envAccountFactory.namingRule) ? envAccountFactory.namingRule : {};
  const defaultNamingRule = {
    schemaVersion: "account-naming-rule.v1",
    pattern: String(configuredNamingRule.pattern ?? "userTestA{seq:000}@example.com"),
    fixedSuffix: configuredNamingRule.fixedSuffix ?? true,
    prefix: String(configuredNamingRule.prefix ?? "userTestA"),
    suffix: String(configuredNamingRule.suffix ?? "@example.com"),
    sequence: Number(configuredNamingRule.sequence ?? 1)
  };
  const sequenceAllocation = await allocateAccountFactoryUsername(context, project, env, defaultNamingRule).catch((error) => ({
    username: "",
    sequence: defaultNamingRule.sequence,
    skippedExisting: [],
    error: error instanceof Error ? error.message : String(error)
  }));
  return {
    ok: registrationReady,
    schemaVersion: "account-factory-capabilities.v1",
    project,
    env,
    projectName: typeof projectConfig.projectName === "string" ? projectConfig.projectName : project,
    adapterId: adapter?.adapterId ?? "",
    status,
    namingRule: defaultNamingRule,
    sequenceAllocation,
    capabilities
  };
}

async function readYamlRecord(filePath: string): Promise<Record<string, unknown>> {
  if (!(await fs.pathExists(filePath))) return {};
  const parsed = YAML.parse(await fs.readFile(filePath, "utf8"));
  return isRecord(parsed) ? parsed : {};
}

async function provisionAccountForRequirements(input: {
  project: string;
  env: string;
  reason?: string;
  username?: string;
  password?: string;
  namingRule?: Record<string, unknown>;
  autoSequence?: boolean;
  requirements: unknown[];
}): Promise<Record<string, unknown>> {
  const createdAt = new Date().toISOString();
  const context = await loadContext({ project: input.project, env: input.env });
  const adapter = accountFactoryAdapterFor(context);
  const allocation = input.autoSequence !== false
    ? await allocateAccountFactoryUsername(context, input.project, input.env, input.namingRule, input.username)
    : { username: String(input.username ?? "").trim(), sequence: readAccountFactorySequence(input.namingRule), skippedExisting: [] as string[] };
  const username = allocation.username;
  const password = String(input.password ?? ACCOUNT_FACTORY_DEFAULT_PASSWORD).trim();
  if (!adapter || !username || !password) {
    return {
      ok: false,
      schemaVersion: "account-factory-result.v1",
      project: input.project,
      env: input.env,
      requestedUsername: username,
      status: "blocked_by_missing_adapter",
      createdAt,
      steps: [],
      diagnostics: {
        stage: "account_factory_precheck",
        reason: !adapter ? "No account factory adapter is configured for this project/env." : "Username or password is empty.",
        requestedReason: input.reason ?? "",
        passwordProvided: Boolean(password),
        namingRule: input.namingRule ?? {},
        sequenceAllocation: allocation,
        requirementCount: input.requirements.length,
        missingAdapters: adapter ? [] : ["registration_policy"]
      }
    };
  }
  const provision = await adapter.provision({
    context,
    project: input.project,
    env: input.env,
    username,
    password,
    reason: input.reason,
    namingRule: input.namingRule,
    requirements: input.requirements.map((item) => isRecord(item) ? { type: String(item.type ?? ""), ...item } : { type: String(item) })
  });
  const steps: AccountFactoryStepResult[] = [...provision.steps];
  let account: Awaited<ReturnType<AccountStore["upsert"]>> | undefined;
  let profileRefresh: Record<string, unknown> | undefined;
  let profileUpdatedPath: string | undefined;
  if (provision.ok) {
    const saveStartedAt = new Date().toISOString();
    account = await new AccountStore(context).upsert({
      project: input.project,
      env: input.env,
      username,
      password,
      label: `Account Factory ${new Date().toISOString().slice(0, 10)}`
    });
    steps.push({
      stepId: "save_account_store",
      label: "写入账号管理",
      status: "passed",
      startedAt: saveStartedAt,
      finishedAt: new Date().toISOString(),
      message: "Account saved to AccountStore.",
      diagnostics: { accountId: account.id }
    });
    const shouldRefreshProfile = input.requirements.some((item) => isRecord(item) && item.type === "account_profile_refresh");
    if (shouldRefreshProfile) {
      const refreshStartedAt = new Date().toISOString();
      profileRefresh = await refreshAccountProfilesFromDatabase({ project: input.project, env: input.env, username }).catch((error) => ({
        ok: false,
        status: "profile_refresh_failed",
        diagnostics: { reason: error instanceof Error ? error.message : String(error) }
      }));
      profileUpdatedPath = isRecord(profileRefresh) && typeof profileRefresh.profilePath === "string" ? profileRefresh.profilePath : undefined;
      steps.push({
        stepId: "refresh_account_profile",
        label: "刷新账号画像",
        status: profileRefresh.ok === true ? "passed" : "failed",
        startedAt: refreshStartedAt,
        finishedAt: new Date().toISOString(),
        message: profileRefresh.ok === true ? "Account profile refreshed." : "Account profile refresh failed.",
        diagnostics: profileRefresh
      });
    }
  }
  const failedStep = steps.find((step) => step.status === "failed");
  const skippedSteps = steps.filter((step) => step.status === "skipped");
  return {
    ...provision,
    ok: Boolean(provision.ok && !failedStep),
    status: failedStep ? "failed" : skippedSteps.length ? "partial_created" : provision.status,
    account,
    steps,
    profileUpdatedPath,
    diagnostics: {
      ...provision.diagnostics,
      requestedReason: input.reason ?? "",
      passwordProvided: Boolean(password),
      namingRule: input.namingRule ?? {},
      sequenceAllocation: allocation,
      requirementCount: input.requirements.length,
      accountStoreUpdated: Boolean(account),
      profileUpdatedPath
    }
  };
}

async function readAccountTotpReadiness(input: {
  project: string;
  env: string;
  username?: string;
}): Promise<Record<string, unknown>> {
  const context = await loadContext({ project: input.project, env: input.env });
  const accounts = await new AccountStore(context).list({
    project: input.project,
    env: input.env,
    username: input.username
  });
  const results = [];
  for (const account of accounts) {
    const readiness = await checkTotpReadiness(context, { account: account.username });
    results.push({
      username: account.username,
      ready: readiness.ready,
      status: readiness.status,
      reason: readiness.reason ? sanitizeTotpDisplayError(readiness.reason) : undefined,
      digits: readiness.digits
    });
  }
  return {
    schemaVersion: "account-totp-readiness.v1",
    project: input.project,
    env: input.env,
    accounts: results,
    diagnostics: {
      stage: "account_totp_readiness",
      accountCount: results.length
    }
  };
}

async function readAccountTotpForDisplay(input: {
  project: string;
  env: string;
  username: string;
}): Promise<Record<string, unknown>> {
  const context = await loadContext({ project: input.project, env: input.env });
  const accounts = await new AccountStore(context).list({
    project: input.project,
    env: input.env,
    username: input.username
  });
  const exactAccount = accounts.find((account) => account.username.toLowerCase() === input.username.toLowerCase());
  if (!exactAccount) {
    return {
      ok: false,
      schemaVersion: "account-totp-display.v1",
      project: input.project,
      env: input.env,
      username: input.username,
      status: "account_not_found",
      error: "Account was not found in AccountStore."
    };
  }
  let code: string;
  try {
    code = await readTotpCode(context, { account: exactAccount.username });
  } catch (error) {
    const readiness = classifyTotpReadinessError(error);
    return {
      ok: false,
      schemaVersion: "account-totp-display.v1",
      project: input.project,
      env: input.env,
      username: exactAccount.username,
      status: readiness.status,
      error: readiness.reason ? sanitizeTotpDisplayError(readiness.reason) : "TOTP is not readable for this account."
    };
  }
  return {
    ok: true,
    schemaVersion: "account-totp-display.v1",
    project: input.project,
    env: input.env,
    username: exactAccount.username,
    code,
    digits: code.length,
    expiresInSeconds: 30 - (Math.floor(Date.now() / 1000) % 30)
  };
}

function sanitizeTotpDisplayError(value: string): string {
  return value
    .replace(/\b\d{6}\b/g, "******")
    .replace(/otpauth:\/\/totp\/[^\s]+/gi, "otpauth://totp/<masked>")
    .replace(/\b[A-Z2-7]{16,}\b/g, "<masked-base32>");
}

async function allocateAccountFactoryUsername(
  context: LoadedContext,
  project: string,
  env: string,
  namingRule?: Record<string, unknown>,
  requestedUsername?: string
): Promise<{ username: string; sequence: number; skippedExisting: string[]; requestedUsername?: string }> {
  const prefix = String(namingRule?.prefix ?? "userTestA").trim() || "userTestA";
  const suffix = String(namingRule?.suffix ?? "@example.com").trim() || "@example.com";
  const startSequence = Math.max(1, readAccountFactorySequence(namingRule));
  const accounts = await new AccountStore(context).list({ project, env });
  const existing = new Set(accounts.map((account) => account.username.toLowerCase()));
  for (const username of await readDemoAccountFactoryReservedUsernames(context, project, env, prefix, suffix)) {
    existing.add(username.toLowerCase());
  }
  const existingSequences = accounts
    .map((account) => parseAccountFactorySequence(account.username, prefix, suffix))
    .filter((item): item is number => typeof item === "number");
  let sequence = Math.max(startSequence, existingSequences.length ? Math.max(...existingSequences) + 1 : startSequence);
  const skippedExisting: string[] = [];
  while (sequence <= 999) {
    const candidate = `${prefix}${String(sequence).padStart(3, "0")}${suffix}`;
    if (!existing.has(candidate.toLowerCase())) return { username: candidate, sequence, skippedExisting, requestedUsername };
    skippedExisting.push(candidate);
    sequence += 1;
  }
  throw new Error(`Account Factory sequence exhausted for ${project}/${env}: ${prefix}{001-999}${suffix}`);
}

async function readDemoAccountFactoryReservedUsernames(context: LoadedContext, project: string, env: string, prefix: string, suffix: string): Promise<string[]> {
  if (project !== "demo" || env !== "test") return [];
  const accountFactory = isRecord(context.env.accountFactory) ? context.env.accountFactory : {};
  const assetGrant = isRecord(accountFactory.assetGrant) ? accountFactory.assetGrant : {};
  const serviceId = String(assetGrant.databaseService ?? "spot");
  const database = isRecord(context.env.database) ? context.env.database : {};
  const services = isRecord(database.services) ? database.services : {};
  const service = isRecord(services[serviceId]) ? services[serviceId] : undefined;
  if (!service) return [];
  const host = readString(service.host);
  const usernameSecret = readString(service.usernameSecret);
  const passwordSecret = readString(service.passwordSecret);
  if (!host || !usernameSecret || !passwordSecret) return [];
  const secrets = await readLocalSecrets().catch(() => ({}));
  const username = readDottedSecret(secrets, usernameSecret);
  const password = readDottedSecret(secrets, passwordSecret);
  if (!username || !password) return [];
  const mysql = await import("mysql2/promise");
  const connection = await mysql.createConnection({
    host,
    port: Number(service.port ?? 3306),
    user: username,
    password,
    connectTimeout: 8000
  });
  try {
    const [rows] = await connection.query(
      "SELECT email FROM exchange.user WHERE email LIKE ? LIMIT 1000",
      [`${prefix}%${suffix}`]
    );
    return Array.isArray(rows)
      ? rows.map((row) => readString((row as Record<string, unknown>).email)).filter((item): item is string => Boolean(item))
      : [];
  } catch {
    return [];
  } finally {
    await connection.end().catch(() => undefined);
  }
}

function readAccountFactorySequence(namingRule?: Record<string, unknown>): number {
  const raw = Number(namingRule?.sequence ?? 1);
  return Number.isFinite(raw) ? Math.max(1, Math.min(999, Math.trunc(raw))) : 1;
}

function parseAccountFactorySequence(username: string, prefix: string, suffix: string): number | undefined {
  const lower = username.toLowerCase();
  const lowerPrefix = prefix.toLowerCase();
  const lowerSuffix = suffix.toLowerCase();
  if (!lower.startsWith(lowerPrefix) || !lower.endsWith(lowerSuffix)) return undefined;
  const middle = username.slice(prefix.length, username.length - suffix.length);
  return /^\d{3}$/.test(middle) ? Number(middle) : undefined;
}

function accountFactoryAdapterFor(_context: LoadedContext): AccountFactoryAdapter | undefined {
  // No project adapters are bundled in the public build; wire your own adapter here.
  return undefined;
}

function dslDiagnosticStorePath(project: string, env: string, id: string, createdAt: string): string {
  const stamp = createdAt.replace(/[:.]/g, "-");
  return path.join(rootDir, "storage", "dsl-diagnostics", safePathSegment(project), safePathSegment(env), safePathSegment(id), `${stamp}.json`);
}

async function writeDslDiagnostic(input: {
  project: string;
  env: string;
  caseId: string;
  stage: string;
  chineseSummary: string;
  requestSnapshot?: string;
  accountDecision?: AccountProfileMatchDecision;
  gaps?: string[];
  suggestions?: string[];
  extra?: Record<string, unknown>;
}): Promise<string> {
  const createdAt = new Date().toISOString();
  const diagnostic = {
    schemaVersion: "dsl-diagnostic.v1",
    createdAt,
    project: input.project,
    env: input.env,
    caseId: input.caseId,
    stage: input.stage,
    chineseSummary: input.chineseSummary,
    requestSnapshot: input.requestSnapshot,
    accountDecision: input.accountDecision ? sanitizeAccountProfileDecisionForDiagnostic(input.accountDecision) : undefined,
    gaps: input.gaps ?? [],
    suggestions: input.suggestions ?? [],
    extra: input.extra ?? {}
  };
  const filePath = dslDiagnosticStorePath(input.project, input.env, input.caseId, createdAt);
  await writeSafeJsonFile(filePath, diagnostic);
  await appendDslDiagnosticIndex(input.project, input.env, input.caseId, createdAt, filePath, input.stage, input.chineseSummary);
  return path.relative(rootDir, filePath).replace(/\\/g, "/");
}

async function appendDslDiagnosticIndex(project: string, env: string, caseId: string, createdAt: string, filePath: string, stage: string, chineseSummary: string): Promise<void> {
  const indexPath = path.join(rootDir, "storage", "dsl-diagnostics", "index.json");
  const current = (await fs.pathExists(indexPath)) ? await fs.readJson(indexPath) as Record<string, unknown> : {};
  const items = Array.isArray(current.items) ? current.items as Array<Record<string, unknown>> : [];
  items.unshift({
    createdAt,
    project,
    env,
    caseId,
    stage,
    chineseSummary,
    path: path.relative(rootDir, filePath).replace(/\\/g, "/")
  });
  await writeSafeJsonFile(indexPath, {
    schemaVersion: "dsl-diagnostics-index.v1",
    updatedAt: new Date().toISOString(),
    items: items.slice(0, 200)
  });
}

async function readDatabaseWorkbenchSchema(input: { project: string; env: string; force?: boolean }): Promise<Record<string, unknown>> {
  const context = await loadContext({ project: input.project, env: input.env });
  const sources = await listDatabaseWorkbenchSources(context);
  const schemas: Record<string, unknown>[] = [];
  for (const source of sources) {
    if (source.type === "sqlite" && source.status === "available") {
      schemas.push(await inspectSqliteDatabaseSource(source));
    } else if (source.type === "mysql" && source.status === "available") {
      schemas.push(await readCachedMysqlDatabaseSourceSchema(input.project, input.env, source, input.force === true));
    } else {
      schemas.push({ ...sanitizeDatabaseSourceForResponse(source), databases: [], tables: [], notes: source.notes ?? [] });
    }
  }
  return {
    schemaVersion: "database-workbench-schema.v1",
    project: input.project,
    env: input.env,
    updatedAt: new Date().toISOString(),
    sources: schemas
  };
}

async function readCachedMysqlDatabaseSourceSchema(project: string, env: string, source: Record<string, unknown>, force = false): Promise<Record<string, unknown>> {
  const cachePath = databaseSchemaCachePath(project, env, String(source.sourceId ?? "mysql"));
  if (!force && await fs.pathExists(cachePath)) {
    const cached = await fs.readJson(cachePath) as Record<string, unknown>;
    const cachedAt = Date.parse(String(cached.cachedAt ?? ""));
    if (Number.isFinite(cachedAt) && Date.now() - cachedAt < 24 * 60 * 60 * 1000) {
      return { ...(cached.payload as Record<string, unknown>), cached: true, cachedAt: cached.cachedAt };
    }
  }
  const payload = await inspectMysqlDatabaseSource(source);
  await writeSafeJsonFile(cachePath, {
    schemaVersion: "database-workbench-schema-cache.v1",
    cachedAt: new Date().toISOString(),
    sourceId: source.sourceId,
    payload
  });
  return payload;
}

function databaseSchemaCachePath(project: string, env: string, sourceId: string): string {
  return path.join(rootDir, "storage", "database-schema-cache", safePathSegment(project), safePathSegment(env), `${safePathSegment(sourceId)}.json`);
}

function sanitizeDatabaseSourceForResponse(source: Record<string, unknown>): Record<string, unknown> {
  const next = { ...source };
  delete next.username;
  delete next.password;
  return next;
}

async function listDatabaseWorkbenchSources(context: LoadedContext): Promise<Array<Record<string, unknown>>> {
  const sqliteConfigured = context.workspace.storage?.sqlitePath ?? "storage/workbench.sqlite";
  const workbenchPath = path.join(context.rootDir, sqliteConfigured);
  const databaseConfig = readRecord(context.env.database);
  const secrets = await readLocalSecrets();
  const sources: Array<Record<string, unknown>> = [
    {
      sourceId: "workbench_sqlite",
      displayName: "Workbench SQLite",
      type: "sqlite",
      status: await fs.pathExists(workbenchPath) ? "available" : "missing",
      path: path.relative(context.rootDir, workbenchPath).replace(/\\/g, "/"),
      notes: ["平台本地 SQLite，只用于账号、运行态或平台资产验证，不代表被测业务库。"]
    }
  ];
  if (databaseConfig.enabled === true) {
    const services = readRecord(databaseConfig.services);
    if (Object.keys(services).length) {
      for (const [serviceId, rawService] of Object.entries(services)) {
        const service = readRecord(rawService);
        const type = readString(service.type) ?? readString(service.driver) ?? "unknown";
        const username = readSecretValue(secrets, readString(service.usernameSecret)) ?? readString(service.username);
        const password = readSecretValue(secrets, readString(service.passwordSecret)) ?? readString(service.password);
        const missingSecrets = type === "mysql" && (!username || !password);
        sources.push({
          sourceId: `project_${serviceId}`,
          serviceId,
          displayName: `${context.project.projectKey}/${context.env.env} ${serviceId} 业务库`,
          type,
          status: missingSecrets ? "missing_secret" : type === "mysql" || (type === "sqlite" && readString(service.path)) ? "available" : "unsupported",
          host: readString(service.host),
          port: Number(service.port ?? 3306),
          database: readString(service.database),
          includeDatabases: readStringArray(service.includeDatabases),
          path: readString(service.path),
          usernameSecret: readString(service.usernameSecret),
          passwordSecret: readString(service.passwordSecret),
          purpose: readString(service.purpose) ?? serviceId,
          focus: readStringArray(service.focus),
          username,
          password,
          notes: missingSecrets
            ? ["数据库源已配置，但本地 secret 缺少用户名或密码。"]
            : type === "mysql"
              ? ["项目业务 MySQL，只读取 information_schema 元数据和只读查询。"]
              : type === "sqlite"
                ? ["项目环境已启用 SQLite 数据库。"]
                : ["项目环境已声明数据库，但当前仅支持 SQLite/MySQL 只读探测。"]
        });
      }
    } else {
      const type = readString(databaseConfig.type) ?? readString(databaseConfig.driver) ?? "unknown";
      sources.push({
        sourceId: "project_database",
        displayName: `${context.project.projectKey}/${context.env.env} 业务库`,
        type,
        status: type === "sqlite" && readString(databaseConfig.path) ? "available" : "unsupported",
        path: readString(databaseConfig.path),
        notes: type === "sqlite"
          ? ["项目环境已启用 SQLite 数据库。"]
          : ["项目环境已声明数据库，但当前配置格式缺少 database.services，无法识别具体数据源。"]
      });
    }
  } else {
    sources.push({
      sourceId: "project_database",
      displayName: `${context.project.projectKey}/${context.env.env} 业务库`,
      type: readString(databaseConfig.type) ?? "unknown",
      status: "not_configured",
      notes: ["当前环境 database.enabled=false 或未配置连接信息；无法分析被测业务库表结构。"]
    });
  }
  return sources;
}

async function inspectSqliteDatabaseSource(source: Record<string, unknown>): Promise<Record<string, unknown>> {
  const dbPathValue = readString(source.path);
  const absolutePath = source.sourceId === "workbench_sqlite"
    ? path.join(rootDir, dbPathValue ?? "storage/workbench.sqlite")
    : path.resolve(rootDir, dbPathValue ?? "");
  if (!absolutePath || !(await fs.pathExists(absolutePath))) return { ...source, status: "missing", databases: [], tables: [] };
  const database = openSqliteReadonly(absolutePath);
  try {
    const tables = (database.prepare("SELECT name, type, sql FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY type, name").all() as Array<{ name: string; type: string; sql?: string }>)
      .map((table) => {
        const columns = database.prepare(`PRAGMA table_info(${quoteSqliteIdentifier(table.name)})`).all() as Array<Record<string, unknown>>;
        const foreignKeys = database.prepare(`PRAGMA foreign_key_list(${quoteSqliteIdentifier(table.name)})`).all() as Array<Record<string, unknown>>;
        const rowCount = safeSqliteCount(database, table.name);
        return {
          tableName: table.name,
          tableType: table.type,
          comment: inferDatabaseTableComment(String(table.name), columns),
          rowCount,
          columns: columns.map((column) => ({
            name: String(column.name ?? ""),
            type: String(column.type ?? ""),
            nullable: column.notnull ? false : true,
            primaryKey: Boolean(column.pk),
            defaultValue: column.dflt_value ?? undefined,
            comment: inferDatabaseColumnComment(String(table.name), String(column.name ?? ""), String(column.type ?? ""))
          })),
          foreignKeys: foreignKeys.map((fk) => ({
            from: fk.from,
            toTable: fk.table,
            toColumn: fk.to
          })),
          createSql: table.sql
        };
      });
    return {
      ...sanitizeDatabaseSourceForResponse(source),
      status: "available",
      databases: [{ name: "main", type: "sqlite" }],
      tables
    };
  } finally {
    database.close();
  }
}

async function inspectMysqlDatabaseSource(source: Record<string, unknown>): Promise<Record<string, unknown>> {
  const mysql = await import("mysql2/promise");
  const host = readString(source.host);
  const username = readString(source.username);
  const password = readString(source.password);
  if (!host || !username || !password) {
    return { ...sanitizeDatabaseSourceForResponse(source), status: "missing_secret", databases: [], tables: [], notes: ["缺少 MySQL host、username 或 password。"] };
  }
  const connection = await mysql.createConnection({
    host,
    port: Number(source.port ?? 3306),
    user: username,
    password,
    connectTimeout: 8000
  });
  try {
    const [databaseRows] = await connection.query("SHOW DATABASES");
    const allDatabaseNames = (databaseRows as Array<Record<string, unknown>>)
      .map((row) => readString(row.Database) ?? readString(Object.values(row)[0]))
      .filter((item): item is string => Boolean(item))
      .filter((name) => !/^(information_schema|mysql|performance_schema|sys)$/i.test(name));
    const includeDatabases = readStringArray(source.includeDatabases);
    const configuredDatabase = readString(source.database);
    const databaseNames = includeDatabases.length
      ? allDatabaseNames.filter((name) => includeDatabases.includes(name))
      : configuredDatabase
        ? allDatabaseNames.filter((name) => name === configuredDatabase)
        : allDatabaseNames;
    if (!databaseNames.length) {
      return { ...sanitizeDatabaseSourceForResponse(source), status: "available", databases: [], tables: [], notes: ["连接成功，但未发现可分析业务库。"] };
    }
    const placeholders = databaseNames.map(() => "?").join(",");
    const [tableRows] = await connection.query(
      `SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE, TABLE_ROWS, TABLE_COMMENT
       FROM INFORMATION_SCHEMA.TABLES
       WHERE TABLE_SCHEMA IN (${placeholders})
       ORDER BY TABLE_SCHEMA, TABLE_NAME`,
      databaseNames
    );
    const signalPattern = "^(id|uid|user_id|member_id|account_id|customer_id|wallet_uid|email|mobile|phone|kyc|verify|auth|security|google|ga|totp|mfa|asset|coin|currency|symbol|balance|available|frozen|amount|status|state|type|ctime|mtime|created|updated|time|date)$|(_)(uid|user|member|account|customer|email|mobile|phone|kyc|verify|auth|security|google|ga|totp|mfa|asset|coin|currency|symbol|balance|available|frozen|amount|status|state|type|time|date)(_)";
    const [signalRows] = await connection.query(
      `SELECT DISTINCT TABLE_SCHEMA, TABLE_NAME
       FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA IN (${placeholders}) AND COLUMN_NAME REGEXP ?
       ORDER BY TABLE_SCHEMA, TABLE_NAME`,
      [...databaseNames, signalPattern]
    );
    const signalTableKeys = new Set((signalRows as Array<Record<string, unknown>>).map((row) => `${row.TABLE_SCHEMA}.${row.TABLE_NAME}`));
    const prefilteredTableRows = (tableRows as Array<Record<string, unknown>>).filter((table) => {
      const tableSchema = String(table.TABLE_SCHEMA ?? "");
      const tableName = String(table.TABLE_NAME ?? "");
      return signalTableKeys.has(`${tableSchema}.${tableName}`) || /(^|_)(user|member|account|customer|client|kyc|identity|security|balance|wallet|asset|position|flow|record|history)(_|$)/i.test(tableName);
    });
    const candidateTableNames = [...new Set(prefilteredTableRows.map((table) => String(table.TABLE_NAME ?? "")).filter(Boolean))];
    if (!candidateTableNames.length) {
      return {
        ...sanitizeDatabaseSourceForResponse(source),
        status: "available",
        databases: databaseNames.map((name) => ({ name, type: "mysql" })),
        tables: [],
        summary: {
          totalDatabases: databaseNames.length,
          totalTables: (tableRows as unknown[]).length,
          userRelatedTables: 0,
          focus: source.focus ?? []
        },
        notes: ["连接成功，但未发现用户画像/用户关系相关候选表。"]
      };
    }
    const tableNamePlaceholders = candidateTableNames.map(() => "?").join(",");
    const [columnRows] = await connection.query(
      `SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, DATA_TYPE, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY, COLUMN_DEFAULT, COLUMN_COMMENT, ORDINAL_POSITION
       FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA IN (${placeholders}) AND TABLE_NAME IN (${tableNamePlaceholders})
       ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION`,
      [...databaseNames, ...candidateTableNames]
    );
    const [foreignKeyRows] = await connection.query(
      `SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, REFERENCED_TABLE_SCHEMA, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME
       FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
       WHERE TABLE_SCHEMA IN (${placeholders}) AND TABLE_NAME IN (${tableNamePlaceholders}) AND REFERENCED_TABLE_NAME IS NOT NULL
       ORDER BY TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME`,
      [...databaseNames, ...candidateTableNames]
    );
    const columnsByTable = new Map<string, Array<Record<string, unknown>>>();
    for (const column of columnRows as Array<Record<string, unknown>>) {
      const key = `${column.TABLE_SCHEMA}.${column.TABLE_NAME}`;
      if (!columnsByTable.has(key)) columnsByTable.set(key, []);
      columnsByTable.get(key)?.push(column);
    }
    const foreignKeysByTable = new Map<string, Array<Record<string, unknown>>>();
    for (const fk of foreignKeyRows as Array<Record<string, unknown>>) {
      const key = `${fk.TABLE_SCHEMA}.${fk.TABLE_NAME}`;
      if (!foreignKeysByTable.has(key)) foreignKeysByTable.set(key, []);
      foreignKeysByTable.get(key)?.push(fk);
    }
    const tableCandidates = prefilteredTableRows
      .map((table) => {
        const tableSchema = String(table.TABLE_SCHEMA ?? "");
        const tableName = String(table.TABLE_NAME ?? "");
        const columns = columnsByTable.get(`${tableSchema}.${tableName}`) ?? [];
        const relevance = scoreUserRelationTable(tableName, columns);
        return { table, tableSchema, tableName, columns, relevance };
      })
      .filter((item) => item.relevance.score >= 8)
      .sort((a, b) => b.relevance.score - a.relevance.score || a.tableName.localeCompare(b.tableName))
      .slice(0, 80);
    const tables = tableCandidates.map((item) => {
      const fks = foreignKeysByTable.get(`${item.tableSchema}.${item.tableName}`) ?? [];
      const visibleColumns = coreDatabaseColumnsForResponse(item.columns);
      return {
        databaseName: item.tableSchema,
        tableName: item.tableName,
        tableType: item.table.TABLE_TYPE,
        comment: inferDatabaseTableComment(item.tableName, item.columns),
        rowCount: item.table.TABLE_ROWS,
        relevance: item.relevance,
        profileDimensions: inferProfileDimensionsFromTable(item.tableName, item.columns),
        allColumnCount: item.columns.length,
        columns: visibleColumns.map((column) => ({
          name: String(column.COLUMN_NAME ?? ""),
          type: String(column.COLUMN_TYPE ?? column.DATA_TYPE ?? ""),
          nullable: String(column.IS_NULLABLE ?? "").toUpperCase() === "YES",
          primaryKey: String(column.COLUMN_KEY ?? "").toUpperCase() === "PRI",
          defaultValue: column.COLUMN_DEFAULT ?? undefined,
          comment: readString(column.COLUMN_COMMENT) ?? inferDatabaseColumnComment(item.tableName, String(column.COLUMN_NAME ?? ""), String(column.DATA_TYPE ?? ""))
        })),
        foreignKeys: fks.map((fk) => ({
          from: fk.COLUMN_NAME,
          toDatabase: fk.REFERENCED_TABLE_SCHEMA,
          toTable: fk.REFERENCED_TABLE_NAME,
          toColumn: fk.REFERENCED_COLUMN_NAME
        })),
        relationshipHints: inferRelationshipHints(item.tableName, item.columns, fks)
      };
    });
    return {
      ...sanitizeDatabaseSourceForResponse(source),
      status: "available",
      databases: databaseNames.map((name) => ({ name, type: "mysql" })),
      tables,
      summary: {
        totalDatabases: databaseNames.length,
        totalTables: (tableRows as unknown[]).length,
        userRelatedTables: tables.length,
        focus: source.focus ?? []
      },
      notes: [
        "已连接 MySQL information_schema，当前页面只展示用户画像/用户关系相关表。",
        "行数来自 INFORMATION_SCHEMA.TABLES.TABLE_ROWS，可能是估算值。"
      ]
    };
  } finally {
    await connection.end();
  }
}

function openSqliteReadonly(filePath: string): { prepare(sql: string): { all(): unknown[]; get(): unknown }; close(): void } {
  const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (filename: string, options?: Record<string, unknown>) => { prepare(sql: string): { all(): unknown[]; get(): unknown }; close(): void } };
  return new DatabaseSync(filePath, { readOnly: true });
}

function safeSqliteCount(database: { prepare(sql: string): { get(): unknown } }, tableName: string): number | undefined {
  try {
    const row = database.prepare(`SELECT COUNT(*) AS count FROM ${quoteSqliteIdentifier(tableName)}`).get() as { count?: number };
    return typeof row?.count === "number" ? row.count : undefined;
  } catch {
    return undefined;
  }
}

function quoteSqliteIdentifier(value: string): string {
  return `"${value.replace(/"/g, "\"\"")}"`;
}

function inferDatabaseTableComment(tableName: string, columns: Array<Record<string, unknown>>): string {
  const lower = tableName.toLowerCase();
  if (/account|user/.test(lower)) return "用户或测试账号相关表。";
  if (/case/.test(lower)) return "用例、执行或测试资产相关表。";
  if (/profile/.test(lower)) return "画像或属性维度相关表。";
  if (/order/.test(lower)) return "订单或业务交易记录相关表。";
  if (/asset|balance|wallet|fund/.test(lower)) return "资产、余额、钱包或资金相关表。";
  if (/kyc|verify|auth|security/.test(lower)) return "认证、安全或审核状态相关表。";
  if (columns.some((column) => /created|updated/i.test(String(column.name ?? "")))) return "包含时间字段的业务实体表。";
  return "未识别具体业务含义，需结合项目需求或人工备注确认。";
}

function inferDatabaseColumnComment(tableName: string, columnName: string, type: string): string {
  const lower = columnName.toLowerCase();
  if (lower === "id" || lower.endsWith("_id")) return "主键或关联 ID。";
  if (/user|account|uid/.test(lower)) return "用户、账号或 UID 关联字段。";
  if (/amount|balance|available|frozen|asset/.test(lower)) return "金额、余额、资产或数量字段，使用前需要确认单位和精度。";
  if (/status|state/.test(lower)) return "状态字段，需要结合枚举值确认含义。";
  if (/created|updated|time|date/.test(lower)) return "时间字段。";
  if (/password|secret|token|code|key/.test(lower)) return "敏感或验证相关字段，默认不展示真实值、不用于 prompt。";
  return `${type || "unknown"} 字段，备注待补充。`;
}

function scoreUserRelationTable(tableName: string, columns: Array<Record<string, unknown>>): { score: number; reasons: string[]; category: string } {
  const columnNames = columns.map((column) => String(column.COLUMN_NAME ?? column.name ?? "")).join(" ");
  const text = [
    tableName,
    ...columns.map((column) => `${String(column.COLUMN_NAME ?? column.name ?? "")} ${String(column.COLUMN_COMMENT ?? column.comment ?? "")}`)
  ].join(" ").toLowerCase();
  const tableLower = tableName.toLowerCase();
  const identitySignal = /(^|_)(uid|user_id|member_id|account_id|customer_id|wallet_uid|email|mobile|phone)(_|$)/i.test(columnNames);
  const tableIdentitySignal = /(^|_)(user|member|account|customer|client)(_|$)/i.test(tableLower);
  const profileSignal = /(^|_)(kyc|identity|security|auth|mfa|totp|balance|wallet|asset|position|flow|record|history)(_|$)/i.test(tableLower);
  if (!identitySignal && !tableIdentitySignal && !profileSignal) return { score: 0, reasons: [], category: "unknown" };
  const reasons: string[] = [];
  let score = 0;
  const add = (points: number, reason: string): void => {
    score += points;
    reasons.push(reason);
  };
  if (tableIdentitySignal) add(8, "表名包含用户/账号信号");
  if (identitySignal) add(6, "字段包含用户身份或联系方式");
  if (/(^|_)(kyc|identity|verify|verification|auth|security|google|ga|totp|mfa|login)(_|$)/i.test(columnNames) || /(^|_)(kyc|identity|security)(_|$)/i.test(tableLower)) add(5, "字段包含认证或安全状态");
  if (/(asset|balance|wallet|fund|available|frozen|amount|coin|currency|symbol)/i.test(text)) add(4, "字段包含资产或余额信号");
  if (/(order|trade|flow|record|history|transaction|deposit|withdraw|transfer|subscribe|redeem|earn|position)/i.test(text)) add(3, "字段包含交易或历史记录信号");
  if (/(role|level|status|state|type)/i.test(text)) add(1, "字段包含状态/类型枚举");
  const category = /(kyc|identity|verify|auth|security|google|ga|totp|mfa)/i.test(text)
    ? "account_security"
    : /(asset|balance|wallet|fund|position)/i.test(text)
      ? "asset_or_position"
      : /(order|trade|flow|record|history|transaction|deposit|withdraw|transfer|subscribe|redeem|earn)/i.test(text)
        ? "history_or_transaction"
        : "user_profile";
  return { score, reasons: [...new Set(reasons)], category };
}

function coreDatabaseColumnsForResponse(columns: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const relevant = columns.filter((column) => /(id|uid|user|member|account|email|phone|mobile|kyc|verify|auth|google|ga|totp|mfa|asset|coin|currency|symbol|balance|available|frozen|amount|status|state|type|created|updated|ctime|mtime|time|date)/i.test(String(column.COLUMN_NAME ?? column.name ?? "")));
  return (relevant.length ? relevant : columns)
    .filter((column) => !/(password|secret|token|code|key)/i.test(String(column.COLUMN_NAME ?? column.name ?? "")))
    .slice(0, 32);
}

function inferProfileDimensionsFromTable(tableName: string, columns: Array<Record<string, unknown>>): string[] {
  const text = [tableName, ...columns.map((column) => String(column.COLUMN_NAME ?? column.name ?? ""))].join(" ").toLowerCase();
  const dimensions: string[] = [];
  if (/(email|mail)/i.test(text)) dimensions.push("security.email.bound");
  if (/(mobile|phone|tel)/i.test(text)) dimensions.push("security.phone.bound");
  if (/(google|ga|totp|mfa)/i.test(text)) dimensions.push("security.google.enabled");
  if (/(kyc|identity|real_name|realname|cert|id_card)/i.test(text)) dimensions.push("kyc.status");
  if (/(asset|balance|wallet|available|frozen|coin|currency|symbol)/i.test(text)) dimensions.push("assets.{accountType}.{asset}.available");
  if (/(earn|position|subscribe|redeem)/i.test(text)) dimensions.push("assets.earn.{asset}.positionAmount");
  if (/(flow|record|history|transaction|order|trade)/i.test(text)) dimensions.push("history.{module}.{type}.exists");
  if (/(withdraw|address)/i.test(text)) dimensions.push("history.withdrawAddress.exists");
  return [...new Set(dimensions)];
}

function inferRelationshipHints(tableName: string, columns: Array<Record<string, unknown>>, foreignKeys: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const hints: Array<Record<string, unknown>> = foreignKeys.map((fk) => ({
    type: "foreign_key",
    from: fk.COLUMN_NAME,
    to: `${fk.REFERENCED_TABLE_SCHEMA}.${fk.REFERENCED_TABLE_NAME}.${fk.REFERENCED_COLUMN_NAME}`
  }));
  for (const column of columns) {
    const name = String(column.COLUMN_NAME ?? column.name ?? "");
    if (/^(uid|user_id|member_id|account_id|customer_id)$/i.test(name)) {
      hints.push({
        type: "user_join_candidate",
        from: name,
        note: "用户关联候选字段，需结合主用户表确认。"
      });
    }
    if (/(coin|currency|symbol|asset)$/i.test(name)) {
      hints.push({
        type: "asset_dimension_candidate",
        from: name,
        note: "资产维度候选字段，可用于按币种构建画像。"
      });
    }
  }
  if (!hints.length && scoreUserRelationTable(tableName, columns).score > 0) {
    hints.push({ type: "semantic_relation", note: "未发现外键，但表/字段语义与用户画像相关。" });
  }
  return hints;
}

function readSecretValue(secrets: LocalSecrets, secretPath?: string): string | undefined {
  if (!secretPath) return undefined;
  let current: unknown = secrets;
  for (const part of secretPath.split(".").filter(Boolean)) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return readString(current);
}

async function generateDatabaseWorkbenchSql(input: { project: string; env: string; sourceId: string; message: string }): Promise<Record<string, unknown>> {
  const schema = await readDatabaseWorkbenchSchema({ project: input.project, env: input.env });
  const source = (schema.sources as Array<Record<string, unknown>>).find((item) => item.sourceId === input.sourceId);
  if (!source || source.status !== "available") {
    return { ok: false, error: "当前数据库源不可用，无法生成 SQL。", schema };
  }
  const runtime = await resolveAiRuntime(rootDir);
  const apiKey = runtime.apiKey;
  const model = runtime.model;
  if (!apiKey) {
    return { ok: false, error: `未配置 ${runtime.provider} API Key，不能根据自然语言生成 SQL。`, schema };
  }
  const schemaForPrompt = summarizeDatabaseSchemaForPrompt(source);
  const prompt = JSON.stringify({
    task: "Generate a safe SQL draft from natural language for a test database workbench.",
    rules: [
      "Return JSON only.",
      "Only generate a single read-only SQL statement for this first version.",
      "Allowed SQL starts with SELECT or PRAGMA only.",
      "Do not query password, token, secret, verification code, or other sensitive raw values.",
      "If the request requires writes or data creation, return blocked=true and explain the missing write policy."
    ],
    userRequest: input.message,
    project: input.project,
    env: input.env,
    source: { sourceId: input.sourceId, type: source.type, displayName: source.displayName },
    schema: schemaForPrompt,
    outputSchema: {
      ok: true,
      sql: "SELECT ...",
      explanation: "Chinese explanation",
      risk: "low|blocked",
      blocked: false
    }
  }, null, 2);
  try {
    const response = await fetch(runtime.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        temperature: 0.1,
        messages: [
          { role: "system", content: "You are a cautious SQL generation module. Output JSON only." },
          { role: "user", content: prompt }
        ]
      })
    });
    if (!response.ok) return { ok: false, error: `AI SQL 生成失败（${runtime.provider}）：HTTP ${response.status}`, schema };
    const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = payload.choices?.[0]?.message?.content ?? "";
    const parsed = parseAssistantPlanJson(content) as Record<string, unknown>;
    const sql = readString(parsed.sql) ?? "";
    const validation = validateReadOnlySql(sql);
    return {
      ok: validation.ok && parsed.blocked !== true,
      sourceId: input.sourceId,
      sql,
      explanation: readString(parsed.explanation) ?? "",
      risk: parsed.blocked === true ? "blocked" : "low",
      blocked: parsed.blocked === true || !validation.ok,
      validation,
      raw: parsed
    };
  } catch (error) {
    return { ok: false, error: `AI SQL 生成异常（${runtime.provider}）：${error instanceof Error ? error.message : String(error)}`, schema };
  }
}

function summarizeDatabaseSchemaForPrompt(source: Record<string, unknown>): Record<string, unknown> {
  const tables = Array.isArray(source.tables) ? source.tables as Array<Record<string, unknown>> : [];
  return {
    tables: tables.slice(0, 80).map((table) => ({
      tableName: table.tableName,
      comment: table.comment,
      rowCount: table.rowCount,
      columns: (Array.isArray(table.columns) ? table.columns as Array<Record<string, unknown>> : [])
        .filter((column) => !/password|secret|token|code|key/i.test(String(column.name ?? "")))
        .slice(0, 60)
        .map((column) => ({ name: column.name, type: column.type, comment: column.comment }))
    }))
  };
}

async function executeDatabaseWorkbenchSql(input: { project: string; env: string; sourceId: string; sql: string }): Promise<Record<string, unknown>> {
  const validation = validateReadOnlySql(input.sql);
  if (!validation.ok) return { ok: false, error: validation.reason, validation };
  const context = await loadContext({ project: input.project, env: input.env });
  const source = (await listDatabaseWorkbenchSources(context)).find((item) => item.sourceId === input.sourceId);
  if (!source || source.status !== "available") return { ok: false, error: "当前数据库源不可用，无法执行 SQL。" };
  if (source.type === "mysql") return executeMysqlWorkbenchSql(source, input.sql);
  if (source.type !== "sqlite") return { ok: false, error: "当前只支持 SQLite/MySQL 数据源执行只读 SQL。" };
  const dbPathValue = readString(source.path);
  const absolutePath = source.sourceId === "workbench_sqlite"
    ? path.join(rootDir, dbPathValue ?? "storage/workbench.sqlite")
    : path.resolve(rootDir, dbPathValue ?? "");
  const database = openSqliteReadonly(absolutePath);
  try {
    const rows = database.prepare(input.sql).all() as Array<Record<string, unknown>>;
    return {
      ok: true,
      sourceId: input.sourceId,
      rowCount: rows.length,
      rows: rows.slice(0, 200).map(maskDatabaseRow)
    };
  } finally {
    database.close();
  }
}

async function executeMysqlWorkbenchSql(source: Record<string, unknown>, sql: string): Promise<Record<string, unknown>> {
  const mysql = await import("mysql2/promise");
  const host = readString(source.host);
  const username = readString(source.username);
  const password = readString(source.password);
  if (!host || !username || !password) return { ok: false, error: "MySQL 数据源缺少连接信息或本地 secret。" };
  const connection = await mysql.createConnection({
    host,
    port: Number(source.port ?? 3306),
    user: username,
    password,
    database: readString(source.database),
    connectTimeout: 8000
  });
  try {
    const [rows] = await connection.query(sql);
    const resultRows = Array.isArray(rows) ? rows as Array<Record<string, unknown>> : [];
    return {
      ok: true,
      sourceId: source.sourceId,
      rowCount: resultRows.length,
      rows: resultRows.slice(0, 200).map(maskDatabaseRow)
    };
  } finally {
    await connection.end();
  }
}

function validateReadOnlySql(sql: string): { ok: boolean; reason?: string } {
  const text = sql.trim();
  if (!text) return { ok: false, reason: "SQL 不能为空。" };
  if (text.split(";").map((item) => item.trim()).filter(Boolean).length > 1) return { ok: false, reason: "第一版只允许单条 SQL。" };
  if (!/^(select|pragma)\b/i.test(text)) return { ok: false, reason: "第一版只允许 SELECT 或 PRAGMA 只读 SQL。" };
  if (/\b(insert|update|delete|drop|alter|create|replace|truncate|attach|detach|vacuum|reindex)\b/i.test(text)) return { ok: false, reason: "SQL 包含写入或结构变更关键字，已阻止。" };
  if (/\b(password|secret|token|validcode|verification_code|google_authenticator_key|private_key|api_key)\b/i.test(text)) return { ok: false, reason: "SQL 涉及敏感字段，已阻止。" };
  return { ok: true };
}

function maskDatabaseRow(row: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    next[key] = /password|secret|token|code|key/i.test(key) ? "<masked>" : value;
  }
  return next;
}

function sanitizeAccountProfileDecisionForDiagnostic(decision: AccountProfileMatchDecision): AccountProfileMatchDecision {
  return {
    ...decision,
    selectedAccount: decision.selectedAccount,
    candidateResults: decision.candidateResults.map((item) => ({ ...item }))
  };
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => readString(item)).filter((item): item is string => Boolean(item));
}

async function resolveAccountProfileDecision(input: {
  project: string;
  env: string;
  caseId: string;
  request: string;
  item?: WorkbenchCaseAsset;
  automationCase?: AutomationCase;
  aiIntent?: unknown;
  accounts: TestAccount[];
  writeDiagnosticOnBlocked?: boolean;
}): Promise<AccountProfileMatchDecision> {
  const bundle = await readAccountProfileBundle(input.project, input.env);
  const derived = await deriveAccountProfileRequirements({
    request: input.request,
    item: input.item,
    automationCase: input.automationCase,
    aiIntent: input.aiIntent
  });
  const profiles = bundle.profile.profiles ?? [];
  const profileByUsername = new Map(profiles.map((profile) => [profile.username.toLowerCase(), profile]));
  const candidates = input.accounts.map((account) => scoreAccountProfileCandidate(account, profileByUsername.get(account.username.toLowerCase()), derived.requiredTags, derived.requirements));
  candidates.sort((a, b) => b.score - a.score || a.username.localeCompare(b.username));
  const strict = candidates.find((item) => item.status === "matched");
  const fallback = candidates.find((item) => item.status === "candidate") ?? candidates[0];
  const hasCriticalUnknown = candidates.length > 0 && candidates.every((item) =>
    item.missingDimensions.some((dimension) => derived.requirements.find((req) => req.dimensionId === dimension)?.critical) ||
    item.unknownDimensions.some((dimension) => derived.requirements.find((req) => req.dimensionId === dimension)?.critical) ||
    item.staleDimensions.some((dimension) => derived.requirements.find((req) => req.dimensionId === dimension)?.critical)
  );
  const status: AccountProfileMatchDecision["status"] = !input.accounts.length
    ? "not_configured"
    : strict
      ? "matched"
      : hasCriticalUnknown
        ? "blocked"
        : fallback
          ? "candidate"
          : "blocked";
  const selected = status === "matched"
    ? input.accounts.find((account) => account.username === strict?.username)
    : status === "candidate"
      ? input.accounts.find((account) => account.username === fallback?.username)
      : undefined;
  let decision: AccountProfileMatchDecision = {
    schemaVersion: "account-profile-match.v1",
    project: input.project,
    env: input.env,
    status,
    selectedAccount: selected?.username,
    selectedAccountId: selected?.id,
    operationType: derived.operationType,
    requiredTags: derived.requiredTags,
    requirements: derived.requirements,
    profileImpact: derived.profileImpact,
    candidateResults: candidates,
    chineseSummary: summarizeAccountProfileDecision(status, selected?.username, derived, candidates)
  };
  if ((status === "blocked" || status === "not_configured") && input.writeDiagnosticOnBlocked) {
    const diagnostic = classifyAccountProfileDiagnostic(decision);
    const diagnosticPath = await writeDslDiagnostic({
      project: input.project,
      env: input.env,
      caseId: input.caseId,
      stage: diagnostic.stage,
      chineseSummary: diagnostic.summary,
      requestSnapshot: input.request,
      accountDecision: decision,
      gaps: accountProfileDecisionGaps(decision),
      suggestions: diagnostic.suggestions
    });
    decision = { ...decision, diagnosticPath };
  }
  return decision;
}

async function deriveAccountProfileRequirements(input: {
  request: string;
  item?: WorkbenchCaseAsset;
  automationCase?: AutomationCase;
  aiIntent?: unknown;
}): Promise<{
  operationType: "read" | "write" | "unknown";
  requiredTags: string[];
  requirements: AccountProfileRequirement[];
  profileImpact: string[];
}> {
  const structured = collectStructuredAccountProfileContract(input.item, input.automationCase);
  const knowledgeContracts = await collectKnowledgeBackedAccountProfileContracts(input.item, input.request);
  const aiContracts = collectAiAccountProfileContract(input.aiIntent);
  const operationType = structured.operationType;
  const requiredTags = new Set<string>(structured.requiredTags);
  const requirements = new Map<string, AccountProfileRequirement>();
  for (const requirement of structured.requirements) requirements.set(requirement.dimensionId, requirement);
  for (const requirement of knowledgeContracts.requirements) {
    if (!requirements.has(requirement.dimensionId)) requirements.set(requirement.dimensionId, requirement);
  }
  for (const requirement of aiContracts.requirements) {
    if (!requirements.has(requirement.dimensionId)) requirements.set(requirement.dimensionId, requirement);
  }
  for (const requirement of inferCasePreconditionGapRequirements(input.item, input.request, [...requirements.values()])) {
    if (!requirements.has(requirement.dimensionId)) requirements.set(requirement.dimensionId, requirement);
  }
  const profileImpact = new Set<string>(structured.profileImpact);
  for (const impact of knowledgeContracts.profileImpact) profileImpact.add(impact);
  return {
    operationType: operationType === "unknown" ? knowledgeContracts.operationType : operationType,
    requiredTags: [...requiredTags],
    requirements: [...requirements.values()],
    profileImpact: [...profileImpact]
  };
}

async function collectKnowledgeBackedAccountProfileContracts(item: WorkbenchCaseAsset | undefined, request: string): Promise<{
  operationType: "read" | "write" | "unknown";
  requirements: AccountProfileRequirement[];
  profileImpact: string[];
}> {
  if (!item) return { operationType: "unknown", requirements: [], profileImpact: [] };
  const project = item.project || defaultProject;
  const [manualContract, pageModelContract] = await Promise.all([
    collectOperationManualAccountProfileContract(project, item, request),
    collectPageModelBlockedStateAccountProfileContract(project, item, request)
  ]);
  const operationType = manualContract.operationType !== "unknown" ? manualContract.operationType : pageModelContract.operationType;
  return {
    operationType,
    requirements: dedupeAccountProfileRequirements([...manualContract.requirements, ...pageModelContract.requirements]),
    profileImpact: [...new Set([...manualContract.profileImpact, ...pageModelContract.profileImpact])]
  };
}

async function collectOperationManualAccountProfileContract(project: string, item: WorkbenchCaseAsset, request: string): Promise<{
  operationType: "read" | "write" | "unknown";
  requirements: AccountProfileRequirement[];
  profileImpact: string[];
}> {
  const manualPath = path.join(rootDir, "storage", "operation-manuals", `${safePathSegment(project)}.json`);
  if (!(await fs.pathExists(manualPath))) return { operationType: "unknown", requirements: [], profileImpact: [] };
  const store = await fs.readJson(manualPath) as Record<string, unknown>;
  const manuals = readRecordArray(store.manuals).filter((manual) => {
    const pageId = readString(manual.pageId);
    return !item.pageModelId || pageId === item.pageModelId;
  });
  const requestText = `${item.title}\n${request}`;
  const caseIsNegativeGuard = /negative|guard|block|拦截|失败/i.test(`${item.caseType} ${item.title} ${item.expectedAssertion}`);
  const capabilities = manuals.flatMap((manual) => readRecordArray(manual.capabilities))
    .filter((capability) => capabilityMatchesCaseForAccountProfile(capability, requestText, caseIsNegativeGuard));
  return accountProfileContractFromKnowledgeRecords(capabilities, caseIsNegativeGuard);
}

async function collectPageModelBlockedStateAccountProfileContract(project: string, item: WorkbenchCaseAsset, request: string): Promise<{
  operationType: "read" | "write" | "unknown";
  requirements: AccountProfileRequirement[];
  profileImpact: string[];
}> {
  if (!item.pageModelId) return { operationType: "unknown", requirements: [], profileImpact: [] };
  const pageModelPath = path.join(rootDir, "storage", "page-models", `${safePathSegment(project)}.json`);
  if (!(await fs.pathExists(pageModelPath))) return { operationType: "unknown", requirements: [], profileImpact: [] };
  const store = await fs.readJson(pageModelPath) as Record<string, unknown>;
  const model = readRecordArray(store.models).find((candidate) => readString(candidate.pageId) === item.pageModelId || readString(candidate.id) === item.pageModelId);
  if (!model) return { operationType: "unknown", requirements: [], profileImpact: [] };
  const requestText = `${item.title}\n${request}`;
  const caseIsNegativeGuard = /negative|guard|block|拦截|失败/i.test(`${item.caseType} ${item.title} ${item.expectedAssertion}`);
  const blockedStates = readRecordArray(model.blockedStates)
    .filter((state) => caseIsNegativeGuard || knowledgeRecordTextMatchesRequest(state, requestText));
  return accountProfileContractFromKnowledgeRecords(blockedStates, caseIsNegativeGuard);
}

function capabilityMatchesCaseForAccountProfile(capability: Record<string, unknown>, requestText: string, caseIsNegativeGuard: boolean): boolean {
  const hasProfileDimensions = readRecordArray(capability.requiredAccountProfileDimensions).length > 0;
  if (!hasProfileDimensions) return false;
  const operationType = String(capability.operationType ?? "");
  if (caseIsNegativeGuard && /negative_guard|guard|block/i.test(operationType)) return true;
  return knowledgeRecordTextMatchesRequest(capability, requestText);
}

function knowledgeRecordTextMatchesRequest(record: Record<string, unknown>, requestText: string): boolean {
  const text = normalizeAccountProfileContractText([
    record.capabilityId,
    record.blockId,
    record.blockedStateId,
    record.name,
    record.summary,
    record.trigger,
    record.businessMeaning,
    record.flowId,
    readStringArray(record.naturalLanguageAliases).join(" "),
    readStringArray(record.signals).join(" "),
    readStringArray(record.observableSignals).join(" "),
    readStringArray(record.expectedEffects).join(" ")
  ].filter(Boolean).join(" "));
  if (!text) return false;
  const terms = tokenizeAccountProfileContractText(requestText);
  return terms.some((term) => term.length >= 2 && (text.includes(term) || term.includes(text)));
}

function accountProfileContractFromKnowledgeRecords(records: Array<Record<string, unknown>>, negativeGuard: boolean): {
  operationType: "read" | "write" | "unknown";
  requirements: AccountProfileRequirement[];
  profileImpact: string[];
} {
  const requirements = records.flatMap((record) => {
    const raws = readRecordArray(record.requiredAccountProfileDimensions);
    // 存储中 relation 字段可能只标在组内部分条目上（历史建模不对称）：
    // 同一记录内任一条带 any_of 组名即视为该记录的维度同组（任一满足即可）。
    const group = raws
      .map((raw) => readString(raw.relation))
      .find((relation) => relation && relation.startsWith("any_of"));
    return raws.map((raw) => {
      const requirement = accountProfileRequirementFromKnowledge(raw, negativeGuard);
      return requirement && group ? { ...requirement, relationGroup: group } : requirement;
    });
  }).filter((item): item is AccountProfileRequirement => Boolean(item));
  const profileImpact = records.flatMap((record) => readStringArray(record.profileImpact));
  const hasWrite = records.some((record) => {
    const value = String(record.operationType ?? "");
    return value === "write" || value === "negative_guard";
  });
  return {
    operationType: hasWrite || negativeGuard && requirements.length > 0 ? "write" : "unknown",
    requirements: dedupeAccountProfileRequirements(requirements),
    profileImpact: [...new Set(profileImpact)]
  };
}

function accountProfileRequirementFromKnowledge(raw: Record<string, unknown>, negativeGuard: boolean): AccountProfileRequirement | undefined {
  const dimensionId = readString(raw.dimensionId);
  if (!dimensionId) return undefined;
  const expected = negativeGuard && Object.prototype.hasOwnProperty.call(raw, "blockingWhen")
    ? raw.blockingWhen
    : Object.prototype.hasOwnProperty.call(raw, "requiredValue")
      ? raw.requiredValue
      : raw.expected;
  const relation = readString(raw.relation);
  return {
    dimensionId,
    reason: readString(raw.reason) ?? readString(raw.source) ?? "Operation Manual/Page Model 结构化账号画像要求。",
    required: true,
    critical: true,
    expected,
    source: "knowledge",
    relationGroup: relation && relation.startsWith("any_of") ? relation : undefined
  };
}

function dedupeAccountProfileRequirements(requirements: AccountProfileRequirement[]): AccountProfileRequirement[] {
  const byDimension = new Map<string, AccountProfileRequirement>();
  for (const requirement of requirements) {
    const existing = byDimension.get(requirement.dimensionId);
    byDimension.set(requirement.dimensionId, {
      ...existing,
      ...requirement,
      critical: Boolean(existing?.critical || requirement.critical),
      required: existing?.required !== false && requirement.required !== false,
      relationGroup: requirement.relationGroup ?? existing?.relationGroup
    });
  }
  return [...byDimension.values()];
}

function readRecordArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object") : [];
}

function normalizeAccountProfileContractText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, "");
}

function tokenizeAccountProfileContractText(value: string): string[] {
  return [...new Set(String(value ?? "")
    .toLowerCase()
    .split(/[\s"'“”‘’：:、，,。；;()（）\-_~～|/\\\[\]{}]+/u)
    .map((term) => normalizeAccountProfileContractText(term))
    .filter((term) => term.length >= 2))];
}

function collectAiAccountProfileContract(aiIntent: unknown): { requirements: AccountProfileRequirement[] } {
  const root = readRecord(aiIntent);
  const extracted = readRecord(root.extractedData);
  const rawNeeds = [
    ...readRecordArray(root.accountProfileNeeds),
    ...readRecordArray(extracted.accountProfileNeeds)
  ];
  const requirements = rawNeeds.map(accountProfileRequirementFromAiNeed).filter((item): item is AccountProfileRequirement => Boolean(item));
  return { requirements: dedupeAccountProfileRequirements(requirements) };
}

function accountProfileRequirementFromAiNeed(raw: Record<string, unknown>): AccountProfileRequirement | undefined {
  const needType = readString(raw.needType);
  const domain = readString(raw.domain);
  const dimensionHint = readString(raw.dimensionHint);
  const reason = readString(raw.reason) ?? "AI 意图理解识别出的账号画像需求。";
  if (dimensionHint && /^[a-z][a-zA-Z0-9_.{}-]+$/.test(dimensionHint) && !dimensionHint.includes("{")) {
    return {
      dimensionId: dimensionHint,
      reason,
      required: true,
      critical: true,
      expected: Object.prototype.hasOwnProperty.call(raw, "expected") ? raw.expected : true,
      source: "ai"
    };
  }
  if (needType === "history_record") {
    const recordDomain = normalizeHistoryRecordDomain(domain);
    if (!recordDomain) return undefined;
    const recordPresence = readString(raw.recordPresence) ?? "exists";
    const dateRange = readRecord(raw.dateRange);
    return {
      dimensionId: `history.${recordDomain}.records`,
      reason,
      required: true,
      critical: true,
      expected: {
        exists: recordPresence !== "empty",
        asset: readString(raw.asset),
        recordType: readString(raw.recordType),
        dateRange: {
          start: readString(dateRange.start),
          end: readString(dateRange.end)
        }
      },
      source: "ai"
    };
  }
  return undefined;
}

function inferCasePreconditionGapRequirements(item: WorkbenchCaseAsset | undefined, request: string, requirements: AccountProfileRequirement[]): AccountProfileRequirement[] {
  if (!item) return [];
  if (!isPositiveRecordReturningCase(item, request)) return [];
  if (requirements.some((requirement) => /^history\./.test(requirement.dimensionId))) return [];
  const domain = inferHistoryRecordDomain(item, request);
  if (!domain) return [];
  return [{
    dimensionId: `history.${domain}.records`,
    reason: "正向“返回匹配记录”用例缺少结构化历史记录画像前置；需要先确认目标账号存在满足筛选条件的记录。",
    required: true,
    critical: true,
    expected: { exists: true },
    source: "case_precondition_gap"
  }];
}

function isPositiveRecordReturningCase(item: WorkbenchCaseAsset, request: string): boolean {
  const text = `${item.caseType} ${item.title} ${request} ${item.expectedAssertion}`;
  if (/negative|guard|block|拦截|失败|空列表|返回空|无匹配|暂无数据|为空/i.test(text)) return false;
  return /返回匹配记录|匹配记录|存在.*记录|展示.*流水|仅展示.*流水|列表.*范围内|列表.*均在/.test(text);
}

function inferHistoryRecordDomain(item: WorkbenchCaseAsset, request: string): "spotFlow" | "contractFlow" | "earnFlow" | undefined {
  const text = `${item.pageModelId ?? ""} ${item.module ?? ""} ${item.title ?? ""} ${request}`;
  if (/contract_fund_flow|合约流水|contractFlow/i.test(text)) return "contractFlow";
  if (/spot_fund_flow|现货流水|spotFlow/i.test(text)) return "spotFlow";
  if (/earn_fund_flow|理财流水|earnFlow/i.test(text)) return "earnFlow";
  return undefined;
}

function normalizeHistoryRecordDomain(value: string | undefined): "spotFlow" | "contractFlow" | "earnFlow" | undefined {
  if (!value) return undefined;
  if (/spot/i.test(value)) return "spotFlow";
  if (/contract|future|futures/i.test(value)) return "contractFlow";
  if (/earn|finance/i.test(value)) return "earnFlow";
  return undefined;
}

function collectStructuredAccountProfileContract(item?: WorkbenchCaseAsset, automationCase?: AutomationCase): {
  operationType: "read" | "write" | "unknown";
  requiredTags: string[];
  requirements: AccountProfileRequirement[];
  profileImpact: string[];
} {
  const rawContracts = [
    item ? (item as unknown as Record<string, unknown>).accountProfile : undefined,
    item ? (item as unknown as Record<string, unknown>).accountRequirements : undefined,
    automationCase ? (automationCase as unknown as Record<string, unknown>).accountProfile : undefined,
    automationCase ? (automationCase as unknown as Record<string, unknown>).accountRequirements : undefined
  ].filter(Boolean);
  const operationType = rawContracts
    .map((contract) => readRecord(contract).operationType)
    .find((value): value is "read" | "write" | "unknown" => value === "read" || value === "write" || value === "unknown") ?? "unknown";
  const requiredTags = new Set<string>();
  const requirements: AccountProfileRequirement[] = [];
  const profileImpact = new Set<string>();
  for (const contract of rawContracts) {
    const record = readRecord(contract);
    for (const tag of readStringArray(record.requiredTags ?? record.locationTags)) requiredTags.add(tag);
    for (const impact of readStringArray(record.profileImpact)) profileImpact.add(impact);
    const rawRequirements = Array.isArray(record.requirements) ? record.requirements : [];
    for (const raw of rawRequirements) {
      const req = readRecord(raw);
      const dimensionId = readString(req.dimensionId);
      if (!dimensionId) continue;
      requirements.push({
        dimensionId,
        reason: readString(req.reason) ?? "结构化账号画像要求。",
        required: req.required !== false,
        critical: Boolean(req.critical),
        expected: req.expected,
        source: "case"
      });
    }
  }
  return { operationType, requiredTags: [...requiredTags], requirements, profileImpact: [...profileImpact] };
}

function scoreAccountProfileCandidate(
  account: TestAccount,
  profile: AccountProfileRecord | undefined,
  requiredTags: string[],
  requirements: AccountProfileRequirement[]
): AccountProfileCandidateResult {
  const tags = profile?.locationTags ?? [];
  const tagByName = new Map(tags.map((item) => [item.tag, item]));
  const matchedTags: string[] = [];
  const missingTags: string[] = [];
  for (const tag of requiredTags) {
    const status = tagByName.get(tag)?.status;
    if (isAccountProfilePositiveStatus(status) || status === "candidate") matchedTags.push(tag);
    else missingTags.push(tag);
  }
  const dimensions = profile?.dimensions ?? {};
  const matchedDimensions: string[] = [];
  const missingDimensions: string[] = [];
  const unknownDimensions: string[] = [];
  const staleDimensions: string[] = [];
  const activeRequirements = requirements.filter((item) => item.required);
  // any_of 组：组内任一维度满足即整组通过（其余成员不再计入 missing/unknown）。
  const groupStatus = new Map<string, boolean>();
  for (const group of [...new Set(activeRequirements.map((item) => item.relationGroup).filter(Boolean))]) {
    const members = activeRequirements.filter((item) => item.relationGroup === group);
    groupStatus.set(group!, members.some((requirement) => {
      const value = dimensions[requirement.dimensionId];
      return Boolean(value) && isAccountProfilePositiveStatus(value.status) && accountProfileRequirementSatisfies(dimensions, requirement, value.value);
    }));
  }
  for (const requirement of activeRequirements) {
    const group = requirement.relationGroup;
    if (group && groupStatus.get(group)) {
      // 组已满足：满足者记 matched，其余成员跳过。
      const value = dimensions[requirement.dimensionId];
      if (value && isAccountProfilePositiveStatus(value.status) && accountProfileRequirementSatisfies(dimensions, requirement, value.value)) {
        matchedDimensions.push(requirement.dimensionId);
      }
      continue;
    }
    const value = dimensions[requirement.dimensionId];
    if (!value) {
      unknownDimensions.push(requirement.dimensionId);
    } else if (value.status === "stale") {
      staleDimensions.push(requirement.dimensionId);
    } else if (isAccountProfilePositiveStatus(value.status) && accountProfileRequirementSatisfies(dimensions, requirement, value.value)) {
      matchedDimensions.push(requirement.dimensionId);
    } else if (value.status === "unknown" || value.status === "candidate") {
      unknownDimensions.push(requirement.dimensionId);
    } else {
      missingDimensions.push(requirement.dimensionId);
    }
  }
  const score = matchedTags.length * 5 + matchedDimensions.length * 10 - missingTags.length * 3 - missingDimensions.length * 20 - unknownDimensions.length * 5 - staleDimensions.length * 6;
  const hasRequiredMiss = missingDimensions.length > 0 || requirements.some((req) => req.critical && !req.relationGroup && (unknownDimensions.includes(req.dimensionId) || staleDimensions.includes(req.dimensionId)));
  return {
    username: account.username,
    accountId: account.id,
    score,
    status: hasRequiredMiss ? "unmatched" : (missingTags.length || unknownDimensions.length || staleDimensions.length ? "candidate" : "matched"),
    matchedTags,
    missingTags,
    matchedDimensions,
    missingDimensions,
    unknownDimensions,
    staleDimensions
  };
}

function isAccountProfilePositiveStatus(status: unknown): boolean {
  return status === "known" || status === "matched" || status === "verified";
}

function accountProfileValueSatisfies(value: unknown, expected: unknown): boolean {
  if (expected === undefined) return true;
  if (isRecordCoverageExpectation(expected)) return accountProfileRecordCoverageSatisfies(value, expected);
  if (typeof expected === "boolean") {
    if (isRecordCoverageExpectation(value)) return Boolean(readRecord(value).exists) === expected;
    if (typeof value === "boolean") return value === expected;
    // 资产余额类维度（assets.*.available）的画像值是十进制字符串：
    // expected=true 语义为「余额大于 0」，expected=false 为「余额为 0」。
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric > 0;
    return value === expected;
  }
  return String(value ?? "").toLowerCase() === String(expected).toLowerCase();
}

function accountProfileRequirementSatisfies(
  dimensions: Record<string, AccountProfileDimensionValue>,
  requirement: AccountProfileRequirement,
  value: unknown
): boolean {
  if (isNegativeScopedRecordExpectation(requirement.expected) && /^history\..+\.records$/.test(requirement.dimensionId)) {
    return accountProfileNegativeScopedRecordSatisfies(dimensions, requirement.dimensionId, requirement.expected);
  }
  return accountProfileValueSatisfies(value, requirement.expected);
}

function isNegativeScopedRecordExpectation(value: unknown): value is Record<string, unknown> {
  if (!isRecordCoverageExpectation(value)) return false;
  const record = readRecord(value);
  return record.exists === false && Boolean(readString(record.asset) || readString(record.recordType));
}

function accountProfileNegativeScopedRecordSatisfies(
  dimensions: Record<string, AccountProfileDimensionValue>,
  aggregateDimensionId: string,
  expected: Record<string, unknown>
): boolean {
  const asset = readString(expected.asset);
  const recordType = readString(expected.recordType);
  const namespace = aggregateDimensionId.replace(/\.records$/, "");
  const relevantKeys = Object.keys(dimensions).filter((key) => key.startsWith(`${namespace}.`));
  const contradictory = relevantKeys.some((key) => {
    const normalizedKey = normalizeAccountProfileContractText(key);
    if (asset && !normalizedKey.includes(normalizeAccountProfileContractText(asset))) return false;
    if (recordType && !normalizedKey.includes(normalizeAccountProfileContractText(recordType))) return false;
    const dimension = dimensions[key];
    if (!dimension || !isAccountProfilePositiveStatus(dimension.status)) return false;
    if (dimension.value === false) return false;
    if (isRecordCoverageExpectation(dimension.value)) {
      return accountProfileRecordCoverageSatisfies(dimension.value, { ...expected, exists: true });
    }
    return dimension.value === true || String(dimension.value ?? "").toLowerCase() === "true";
  });
  return !contradictory;
}

function isRecordCoverageExpectation(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && (
    Object.prototype.hasOwnProperty.call(value, "exists") ||
    Object.prototype.hasOwnProperty.call(value, "dateRange") ||
    Object.prototype.hasOwnProperty.call(value, "asset") ||
    Object.prototype.hasOwnProperty.call(value, "recordType")
  );
}

function accountProfileRecordCoverageSatisfies(value: unknown, expected: Record<string, unknown>): boolean {
  const record = readRecord(value);
  const expectedExists = expected.exists === undefined ? true : Boolean(expected.exists);
  const actualExists = record.exists === undefined ? Boolean(record.dateCoverage) : Boolean(record.exists);
  if (actualExists !== expectedExists) return false;
  if (!expectedExists) return true;
  const expectedAsset = readString(expected.asset);
  if (expectedAsset && readString(record.asset) && readString(record.asset)?.toLowerCase() !== expectedAsset.toLowerCase()) return false;
  const expectedType = readString(expected.recordType);
  if (expectedType && readString(record.recordType) && normalizeAccountProfileContractText(readString(record.recordType) ?? "") !== normalizeAccountProfileContractText(expectedType)) return false;
  const expectedRange = readRecord(expected.dateRange);
  const start = readString(expectedRange.start);
  const end = readString(expectedRange.end);
  if (!start && !end) return true;
  const coverage = readRecordArray(record.dateCoverage);
  return coverage.some((item) => dateCoverageIntersects(item, { start, end }));
}

function dateCoverageIntersects(coverage: Record<string, unknown>, range: { start?: string; end?: string }): boolean {
  const coverageStart = parseComparableDate(readString(coverage.start));
  const coverageEnd = parseComparableDate(readString(coverage.end));
  const rangeStart = parseComparableDate(range.start);
  const rangeEnd = parseComparableDate(range.end);
  if (coverageStart === undefined || coverageEnd === undefined) return false;
  if (rangeStart !== undefined && coverageEnd < rangeStart) return false;
  if (rangeEnd !== undefined && coverageStart > rangeEnd) return false;
  return true;
}

function parseComparableDate(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/\//g, "-").replace(" ", "T");
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function summarizeAccountProfileDecision(
  status: AccountProfileMatchDecision["status"],
  selectedAccount: string | undefined,
  derived: { operationType: string; requiredTags: string[]; requirements: AccountProfileRequirement[] },
  candidates: AccountProfileCandidateResult[]
): string {
  if (status === "not_configured") return "DSL生成失败：当前项目/环境没有配置可用账号，请先在账号管理中添加账号。";
  if (status === "blocked") {
    const first = candidates[0];
    const details = first
      ? [...first.missingDimensions, ...first.unknownDimensions, ...first.staleDimensions].slice(0, 4).join("，")
      : "没有候选账号";
    return `DSL生成失败：没有账号满足本用例的账号画像要求。缺失或未知维度：${details || "未知"}。`;
  }
  if (status === "candidate") return `账号画像未完全确认，已选择候选账号 ${selectedAccount ?? "-"}，执行结果会用于后续诊断。`;
  return `账号画像匹配完成，已选择账号 ${selectedAccount ?? "-"}。`;
}

function accountProfileDecisionGaps(decision: AccountProfileMatchDecision): string[] {
  return decision.candidateResults.flatMap((item) => [
    ...item.missingTags.map((value) => `${item.username}:missing_tag:${value}`),
    ...item.missingDimensions.map((value) => `${item.username}:missing_dimension:${value}`),
    ...item.unknownDimensions.map((value) => `${item.username}:unknown_dimension:${value}`),
    ...item.staleDimensions.map((value) => `${item.username}:stale_dimension:${value}`)
  ]);
}

function classifyAccountProfileDiagnostic(decision: AccountProfileMatchDecision): { stage: string; summary: string; suggestions: string[] } {
  if (decision.status === "not_configured") {
    return {
      stage: "account_profile_match",
      summary: decision.chineseSummary,
      suggestions: ["先在当前项目/环境添加账号，再重新生成或执行 DSL。"]
    };
  }
  const businessRequirements = decision.requirements.filter((requirement) =>
    /^(feature|history|earn|assets)\./.test(requirement.dimensionId)
  );
  if (businessRequirements.length > 0) {
    const dimensions = businessRequirements.map((item) => `${item.dimensionId}${item.expected === undefined ? "" : `=${String(item.expected)}`}`).slice(0, 5).join("，");
    return {
      stage: "business_precondition_match",
      summary: `DSL生成阻塞：没有账号满足业务前置或测试数据条件。相关画像维度：${dimensions || "未知"}。这是业务数据/账号状态缺口，不应直接归因为平台执行失败。`,
      suggestions: [
        "先确认用例是否确实要求该业务前置；如果要求正确，补齐账号画像或选择满足条件的账号。",
        "流水、理财持仓、合约开通、安全验证等条件应作为画像维度沉淀，不能靠用例标题正则猜测。",
        "如果页面已经观测到真实业务拦截，把 blockedState 同步写入 Page Model，并在 Operation Manual 标明 requiredAccountProfileDimensions。"
      ]
    };
  }
  return {
    stage: "account_profile_match",
    summary: decision.chineseSummary,
    suggestions: [
      "补齐目标项目/环境的账号画像维度。",
      "如果接口鉴权未打通，先修复 account-profile mapping 或改用 page_probe。",
      "如果该用例需要特定资产或历史数据，提供满足条件的账号或通过画像建模确认当前账号满足。"
    ]
  };
}

function extractProfileAssets(text: string): string[] {
  const matches = text.match(/\b[A-Za-z]{2,12}\b/g) ?? [];
  const ignored = new Set([
    "api", "uid", "dsl", "p0", "p1", "p2", "p3", "test", "uat", "web", "ui", "ga",
    "positive", "negative", "generated", "manual", "seed", "read", "assertion", "state", "recovery",
    "subscribe", "redeem", "insufficient", "balance", "flow", "case", "asset", "earn", "spot"
  ]);
  return [...new Set(matches
    .filter((item) => item === item.toUpperCase() || /(?:币种|产品|资产|申购|赎回)\s*(?:为|是|:|：)?\s*$/u.test(text.slice(Math.max(0, text.indexOf(item) - 12), text.indexOf(item))))
    .map((item) => item.toUpperCase())
    .filter((item) => !ignored.has(item.toLowerCase()) && /^[A-Z]{2,12}$/.test(item)))];
}

function extractKnownProfileFlowType(text: string, candidates: string[]): string | undefined {
  return candidates.find((item) => text.includes(item));
}

async function markAccountProfileImpactsStale(input: {
  project: string;
  env: string;
  username?: string;
  impactDimensions: string[];
  reason: string;
  runId?: string;
}): Promise<string | undefined> {
  if (!input.username || !input.impactDimensions.length) return undefined;
  const bundle = await readAccountProfileBundle(input.project, input.env);
  const profile = bundle.profile.profiles.find((item) => item.username.toLowerCase() === input.username?.toLowerCase());
  if (!profile) return undefined;
  profile.dimensions ??= {};
  const now = new Date().toISOString();
  for (const dimensionId of input.impactDimensions) {
    const current = profile.dimensions[dimensionId] ?? { source: "execution_impact" };
    profile.dimensions[dimensionId] = {
      ...current,
      status: "stale",
      staleAt: now,
      evidence: {
        previousEvidence: current.evidence,
        reason: input.reason,
        runId: input.runId
      }
    };
  }
  profile.profileStatus = "partial";
  return writeAccountProfileStore(input.project, input.env, bundle.profile);
}

async function appendWorkbenchCaseExecution(project: string, caseId: string, execution: WorkbenchCaseExecution): Promise<string> {
  const filePath = workbenchCaseHistoryStorePath(project, caseId);
  const executions = [execution, ...(await readWorkbenchCaseExecutionHistory(project, caseId))].slice(0, 20);
  await writeSafeJsonFile(filePath, {
    schemaVersion: "workbench-case-history.v1",
    project,
    caseId,
    updatedAt: new Date().toISOString(),
    executions
  });
  return filePath;
}

async function deleteWorkbenchCaseDslForAllProjects(caseId: string): Promise<void> {
  const root = path.join(rootDir, "storage", "case-dsl");
  if (!(await fs.pathExists(root))) return;
  const projects = await fs.readdir(root);
  await Promise.all(projects.map((project) => fs.remove(workbenchCaseDslStorePath(project, caseId))));
}

function workbenchCaseDslGenerationStageSkeleton(): WorkbenchCaseDslGenerationStageSummary[] {
  return [
    { id: "load_case", title: "读取用例", detail: "等待读取用例正文、前置条件和断言。", status: "pending" },
    { id: "account_inventory_precheck", title: "账号池预检", detail: "等待加载当前项目/环境账号池；这里不做画像语义匹配。", status: "pending" },
    { id: "deepseek_intent_understanding", title: "AI 意图理解", detail: "等待 AI 解析业务目标和断言；失败会阻断 DSL 生成。", status: "pending" },
    { id: "project_knowledge_retrieval", title: "项目知识检索", detail: "等待检索 Page Model 和操作手册。", status: "pending" },
    { id: "dsl_materialization", title: "DSL 物化", detail: "等待本地把已验证项目知识物化为 AutomationCase。", status: "pending" },
    { id: "grounded_contract_validation", title: "生成内容可信度校验", detail: "等待校验生成内容是否引用真实项目知识。", status: "pending" },
    { id: "account_profile_match", title: "账号画像匹配", detail: "等待基于结构化账号要求匹配账号。", status: "pending" },
    { id: "deepseek_grounded_advisory", title: "AI 压缩审查", detail: "等待 AI 审查已物化 DSL；结构化否决会阻断写入。", status: "pending" },
    { id: "dsl_contract_validation", title: "DSL 契约校验", detail: "等待校验断言、DSL 可执行性和 gap 分类。", status: "pending" },
    { id: "write_result", title: "写入结果", detail: "等待写入当前项目 DSL 或诊断。", status: "pending" }
  ];
}

function normalizeWorkbenchDslGenerationStageStatus(status: unknown): string {
  const value = String(status ?? "").trim().toLowerCase();
  if (["pending", "running", "completed", "failed", "warning", "skipped", "cancelled"].includes(value)) return value;
  if (value === "passed") return "completed";
  return "running";
}

function updateWorkbenchCaseDslGenerationStages(
  stages: WorkbenchCaseDslGenerationStageSummary[],
  event: WorkbenchCaseDslGenerationStageSummary
): WorkbenchCaseDslGenerationStageSummary[] {
  const next = [...stages];
  const id = String(event.id ?? event.title ?? "unknown").trim();
  const index = next.findIndex((item) => item.id === id || item.title === event.title);
  const stage: WorkbenchCaseDslGenerationStageSummary = {
    id,
    title: String(event.title ?? id),
    detail: event.detail ? String(event.detail) : undefined,
    status: normalizeWorkbenchDslGenerationStageStatus(event.status),
    retryable: Boolean(event.retryable),
    failedStage: event.failedStage,
    attempt: event.attempt,
    maxAttempts: event.maxAttempts,
    updatedAt: new Date().toISOString()
  };
  if (index >= 0) next[index] = stage;
  else next.push(stage);
  return next;
}

function buildWorkbenchCaseDslGenerationSummary(input: {
  project: string;
  env: string;
  caseId: string;
  runId?: string;
  stages: WorkbenchCaseDslGenerationStageSummary[];
  result: Record<string, unknown>;
  createdAt?: string;
}): WorkbenchCaseDslGenerationSummary {
  const now = new Date().toISOString();
  const failedStage = typeof input.result.failedStage === "string"
    ? input.result.failedStage
    : input.stages.find((stage) => stage.retryable && stage.status === "failed")?.failedStage;
  const status = input.result.status === "cancelled"
    ? "cancelled"
    : input.result.ok && input.result.executable !== false
      ? "completed"
      : "failed";
  return {
    schemaVersion: "workbench-case-dsl-generation-summary.v1",
    project: input.project,
    env: input.env,
    caseId: input.caseId,
    runId: input.runId,
    status,
    retryable: Boolean(input.result.retryable) || input.stages.some((stage) => stage.retryable && stage.status === "failed"),
    failedStage,
    error: typeof input.result.error === "string" ? input.result.error : undefined,
    diagnosticPath: typeof input.result.diagnosticPath === "string" ? input.result.diagnosticPath : undefined,
    proposalPath: typeof input.result.proposalPath === "string" ? input.result.proposalPath : undefined,
    storePath: typeof input.result.storePath === "string" ? input.result.storePath : undefined,
    revision: typeof input.result.revision === "number" ? input.result.revision : undefined,
    executable: typeof input.result.executable === "boolean" ? input.result.executable : undefined,
    readiness: typeof input.result.readiness === "string" ? input.result.readiness : undefined,
    gaps: Array.isArray(input.result.gaps) ? input.result.gaps.map(String) : undefined,
    blockingGaps: Array.isArray(input.result.blockingGaps) ? input.result.blockingGaps.map(String) : undefined,
    stages: input.stages,
    resumeState: readRecord(input.result.resumeState).stage ? readRecord(input.result.resumeState) as unknown as WorkbenchCaseDslGenerationResumeState : undefined,
    createdAt: input.createdAt ?? now,
    updatedAt: now
  };
}

async function listWorkbenchCaseDslProjects(caseId: string): Promise<string[]> {
  const root = path.join(rootDir, "storage", "case-dsl");
  if (!(await fs.pathExists(root))) return [];
  const projects = await fs.readdir(root);
  const result: string[] = [];
  for (const project of projects) {
    if (await fs.pathExists(workbenchCaseDslStorePath(project, caseId))) result.push(project);
  }
  return result;
}

async function migrateLegacyWorkbenchCaseRuntimeState(project: string, data: WorkbenchCaseStoreData): Promise<boolean> {
  let changed = false;
  for (const item of data.cases) {
    const legacyHistory = Array.isArray(item.executionHistory) ? item.executionHistory : [];
    if (legacyHistory.length) {
      const historyPath = workbenchCaseHistoryStorePath(project, item.id);
      if (!(await fs.pathExists(historyPath))) {
        await writeSafeJsonFile(historyPath, {
          schemaVersion: "workbench-case-history.v1",
          project,
          caseId: item.id,
          updatedAt: new Date().toISOString(),
          executions: legacyHistory.slice(0, 20)
        });
      }
      delete item.executionHistory;
      changed = true;
    }
    const legacyDslByProject = item.dslByProject ?? (item.latestDsl ? { [item.project]: item.latestDsl } : undefined);
    if (legacyDslByProject && Object.keys(legacyDslByProject).length) {
      for (const [dslProject, dsl] of Object.entries(legacyDslByProject)) {
        const dslPath = workbenchCaseDslStorePath(dslProject, item.id);
        if (!(await fs.pathExists(dslPath))) await writeSafeJsonFile(dslPath, dsl);
      }
      delete item.dslByProject;
      delete item.latestDsl;
      changed = true;
    }
    if (item.project !== project) {
      item.project = project;
      changed = true;
    }
  }
  return changed;
}

function seedWorkbenchCases(project: string): WorkbenchCaseAsset[] {
  if (project !== "demo") return [];
  const now = new Date().toISOString();
  return [
    {
      id: "demo-spot-flow-type-red-packet-p0-001",
      project,
      module: "资产中心/现货流水",
      pageModelId: "demo.funds.spot_fund_flow",
      title: "现货流水按类型筛选红包发放",
      priority: "P0",
      caseType: "positive",
      automationCandidate: true,
      request: "进入现货流水页面，类型选择红包发放进行搜索",
      businessRequest: "进入现货流水页面，类型选择红包发放进行搜索",
      preconditions: ["已有可登录的 test 环境账号", "账号可进入资产中心现货流水页面"],
      expectedAssertion: "列表中仅返回类型为红包发放的数据",
      expectedResults: { ui: ["现货流水列表刷新", "类型列所有可见数据均为红包发放，或在无数据时展示页面内结果空状态"] },
      source: { type: "seed", refs: ["storage/page-models/demo.json", "storage/operation-manuals/demo.json"] },
      createdAt: now,
      updatedAt: now
    },
    {
      id: "demo-spot-flow-asset-eth-empty-p1-001",
      project,
      module: "资产中心/现货流水",
      pageModelId: "demo.funds.spot_fund_flow",
      title: "现货流水按币种筛选 ETH 空列表",
      priority: "P1",
      caseType: "read_assertion",
      automationCandidate: true,
      request: "进入现货流水页面，币种下拉框选择“ETH”进行查询",
      businessRequest: "进入现货流水页面，币种下拉框选择“ETH”进行查询",
      preconditions: ["已有可登录的 test 环境账号", "现货流水币种下拉框已建模 ETH 选项"],
      expectedAssertion: "列表返回空",
      expectedResults: { ui: ["现货流水列表刷新后没有数据行，或在结果表格作用域内展示空状态"] },
      source: { type: "seed", refs: ["storage/page-models/demo.json", "storage/operation-manuals/demo.json"] },
      createdAt: now,
      updatedAt: now
    },
    {
      id: "demo-spot-flow-reset-filter-p2-001",
      project,
      module: "资产中心/现货流水",
      pageModelId: "demo.funds.spot_fund_flow",
      title: "现货流水筛选后重置查询条件",
      priority: "P2",
      caseType: "state_recovery",
      automationCandidate: true,
      request: "进入现货流水页面，类型选择红包发放进行搜索，然后点击重置",
      businessRequest: "进入现货流水页面，类型选择红包发放进行搜索，然后点击重置",
      preconditions: ["已有可登录的 test 环境账号", "现货流水页面已建模查询和重置能力"],
      expectedAssertion: "类型筛选条件被清空",
      expectedResults: { ui: ["重置后类型筛选框回到默认状态", "列表按默认条件刷新"] },
      source: { type: "seed", refs: ["storage/page-models/demo.json", "storage/operation-manuals/demo.json"] },
      createdAt: now,
      updatedAt: now
    }
  ];
}

async function normalizeWorkbenchCaseForResponse(item: WorkbenchCaseAsset, activeProject: string, activeEnv: string): Promise<WorkbenchCaseAsset & { dslChangedSinceGeneration: boolean; dslProjects: string[] }> {
  const currentHash = hashWorkbenchCase(item);
  const activeDsl = await workbenchCaseDslForProject(item, activeProject);
  const latestDslGeneration = await readWorkbenchCaseDslGenerationSummary(activeProject, activeEnv, item.id);
  const latestDslGenerationForResponse = latestDslGeneration
    ? { ...latestDslGeneration, resumeState: undefined }
    : undefined;
  const executionHistory = await readWorkbenchCaseExecutionHistory(activeProject, item.id);
  const dslProjects = await listWorkbenchCaseDslProjects(item.id);
  const businessRequest = normalizeWorkbenchCaseBusinessRequest(item);
  return {
    ...item,
    dslByProject: undefined,
    request: businessRequest,
    businessRequest,
    latestDsl: activeDsl
      ? { ...activeDsl, changedSinceGeneration: currentHash !== activeDsl.sourceCaseHash }
      : undefined,
    latestDslGeneration: latestDslGenerationForResponse,
    executionHistory,
    dslChangedSinceGeneration: Boolean(activeDsl && currentHash !== activeDsl.sourceCaseHash),
    dslProjects
  };
}

async function generateWorkbenchCaseDsl(input: {
  project: string;
  env: string;
  caseId: string;
  runId?: string;
  resumeFromStage?: string;
  abortSignal?: AbortSignal;
  onStage?: (stage: { id: string; title: string; status: string; detail?: string; retryable?: boolean; attempt?: number; maxAttempts?: number; failedStage?: string }) => void;
}): Promise<Record<string, unknown>> {
  const emit = (stage: { id: string; title: string; status: string; detail?: string; retryable?: boolean; attempt?: number; maxAttempts?: number; failedStage?: string }) => input.onStage?.(stage);
  if (input.abortSignal?.aborted) return caseDslGenerationCancelledResult(input.caseId, input.runId);
  const resumeFromIntent = input.resumeFromStage === "deepseek_intent_understanding";
  emit({ id: "load_case", title: "读取用例", status: resumeFromIntent ? "completed" : "running", detail: resumeFromIntent ? "复用上一轮已确认的用例上下文。" : "读取用例正文、前置条件和期望断言。" });
  const data = await readWorkbenchCaseAssetStore();
  const target = data.cases.find((item) => item.id === input.caseId);
  if (!target) {
    emit({ id: "load_case", title: "读取用例", status: "failed", detail: "用例不存在。" });
    return { caseId: input.caseId, ok: false, error: "用例不存在。" };
  }
  emit({ id: "load_case", title: "读取用例", status: "completed", detail: target.title });
  const caseContext = buildWorkbenchStructuredCaseContext(target);
  const caseRequest = caseContextToRequest(caseContext, { project: input.project, env: input.env });
  const context = await loadContext({ project: input.project, env: input.env });
  await new AccountStore(context).seedDefaults();
  const accounts = await new AccountStore(context).list({ project: input.project, env: input.env });
  emit({ id: "account_inventory_precheck", title: "账号池预检", status: "completed", detail: accounts.length ? `当前项目/环境已加载 ${accounts.length} 个账号，后续仅在存在结构化账号要求时匹配画像。` : "当前项目/环境未配置账号；若后续 DSL 需要账号画像会在账号画像匹配阶段阻断。" });
  if (input.abortSignal?.aborted) return caseDslGenerationCancelledResult(target.id, input.runId);
  const accountProfileResumeSummary = input.resumeFromStage === "account_profile_match"
    ? await readWorkbenchCaseDslGenerationSummary(input.project, input.env, target.id)
    : undefined;
  const accountProfileResumeState = accountProfileResumeSummary?.resumeState?.stage === "account_profile_match"
    ? accountProfileResumeSummary.resumeState
    : undefined;
  const maxIntentAttempts = 3;
  let pageModelDeepSeekIntent: Awaited<ReturnType<typeof tryUnderstandPageModelIntentWithDeepSeek>> | undefined;
  let pageModelRoute: Awaited<ReturnType<typeof planAssistantRequestWithPageModels>> | undefined;
  let planSummary: ReturnType<typeof summarizePageModelRouteForResponse> | undefined;
  let intentBlockReason: string | undefined;
  if (accountProfileResumeState) {
    pageModelDeepSeekIntent = accountProfileResumeState.pageModelDeepSeekIntent as Awaited<ReturnType<typeof tryUnderstandPageModelIntentWithDeepSeek>>;
    pageModelRoute = accountProfileResumeState.pageModelRoute as Awaited<ReturnType<typeof planAssistantRequestWithPageModels>>;
    planSummary = accountProfileResumeState.planSummary as ReturnType<typeof summarizePageModelRouteForResponse>;
    emit({ id: "deepseek_intent_understanding", title: "AI 意图理解", status: "completed", detail: "从上次账号画像失败摘要复用 AI 意图理解结果，未重新调用 AI。" });
    emit({ id: "project_knowledge_retrieval", title: "项目知识检索", status: "completed", detail: "从上次账号画像失败摘要复用项目知识检索结果。" });
    const resumedStepCount = pageModelRoute?.route === "page_model" ? pageModelRoute.plan.materialization.case.steps.length : 0;
    emit({ id: "dsl_materialization", title: "DSL 物化", status: "completed", detail: `从上次账号画像失败摘要复用 ${resumedStepCount} 个步骤。` });
    emit({
      id: "grounded_contract_validation",
      title: "生成内容可信度校验",
      status: "completed",
      detail: "从上次账号画像失败摘要复用已通过的生成内容可信度校验结果。"
    });
  } else {
    for (let attempt = 1; attempt <= maxIntentAttempts; attempt += 1) {
      emit({ id: "deepseek_intent_understanding", title: "AI 意图理解", status: "running", detail: `调用 AI 解析用例业务目标和断言（第 ${attempt}/${maxIntentAttempts} 次）。`, attempt, maxAttempts: maxIntentAttempts });
      pageModelDeepSeekIntent = await tryUnderstandPageModelIntentWithDeepSeek({
        project: input.project,
        env: input.env,
        message: caseRequest,
        caseContext
      });
      intentBlockReason = deepSeekIntentUnderstandingBlockReason(pageModelDeepSeekIntent);
      if (!intentBlockReason) break;
      if (attempt < maxIntentAttempts) {
        emit({ id: "deepseek_intent_understanding", title: "AI 意图理解", status: "warning", detail: `第 ${attempt}/${maxIntentAttempts} 次失败：${intentBlockReason}，准备自动重试。`, attempt, maxAttempts: maxIntentAttempts });
      }
    }
  }
  if (!pageModelDeepSeekIntent) throw new Error("AI intent understanding did not return a result.");
  if (!accountProfileResumeState) {
    emit({
      id: "deepseek_intent_understanding",
      title: "AI 意图理解",
      status: intentBlockReason ? "failed" : "completed",
      detail: intentBlockReason ? `已自动重试 ${maxIntentAttempts} 次仍失败：${intentBlockReason}` : "AI 已返回结构化意图。",
      retryable: Boolean(intentBlockReason),
      attempt: maxIntentAttempts,
      maxAttempts: maxIntentAttempts,
      failedStage: intentBlockReason ? "deepseek_intent_understanding" : undefined
    });
  }
  if (intentBlockReason) {
    const diagnosticPath = await writeDslDiagnostic({
      project: input.project,
      env: input.env,
      caseId: target.id,
      stage: "deepseek_intent_understanding",
      chineseSummary: `DSL生成失败：AI 意图理解未完成。${intentBlockReason}`,
      requestSnapshot: caseRequest,
      gaps: ["deepseek_intent_understanding_failed"],
      suggestions: [
        "检查 DeepSeek API Key、模型配置、网络连通性和 PAGE_MODEL_DEEPSEEK_TIMEOUT_MS。",
        "重试生成 DSL；平台不会使用本地关键词规则替代 AI 意图理解。"
      ],
      extra: {
        pageModelDeepSeekIntent
      }
    });
    const proposalPath = await writeAssistantKnowledgeProposal(context, {
      project: input.project,
      env: input.env,
      message: caseRequest,
      stage: "deepseek_intent_understanding",
      reason: intentBlockReason,
      plan: blockedDeepSeekIntentPlan(caseRequest, intentBlockReason, pageModelDeepSeekIntent)
    });
    emit({ id: "project_knowledge_retrieval", title: "项目知识检索", status: "skipped", detail: "AI 意图理解未完成，平台不使用本地关键词规则继续物化 DSL。" });
    emit({ id: "dsl_materialization", title: "DSL 物化", status: "skipped", detail: "未生成 DSL，未覆盖当前项目 DSL。" });
    emit({ id: "grounded_contract_validation", title: "生成内容可信度校验", status: "skipped", detail: "未生成内容。" });
    emit({ id: "account_profile_match", title: "账号画像匹配", status: "skipped", detail: "第一轮意图理解已阻断。" });
    emit({ id: "deepseek_grounded_advisory", title: "AI 压缩审查", status: "skipped", detail: "第一轮意图理解已阻断。" });
    emit({ id: "dsl_contract_validation", title: "DSL 契约校验", status: "skipped", detail: "未生成 DSL。" });
    emit({ id: "write_result", title: "写入结果", status: "skipped", detail: "AI 意图理解失败时不写入 DSL，只写入诊断和知识提案。" });
    return {
      caseId: target.id,
      ok: false,
      executable: false,
      error: `DSL生成失败：AI 意图理解未完成。请查看诊断：${diagnosticPath}`,
      gaps: ["deepseek_intent_understanding_failed"],
      blockingGaps: ["deepseek_intent_understanding_failed"],
      failedStage: "deepseek_intent_understanding",
      retryable: true,
      maxAttempts: maxIntentAttempts,
      diagnosticPath,
      proposalPath
    };
  }
  if (input.abortSignal?.aborted) return caseDslGenerationCancelledResult(target.id, input.runId);
  if (!pageModelRoute) {
    emit({ id: "project_knowledge_retrieval", title: "项目知识检索", status: "running", detail: "按当前项目检索 Page Model、Operation Manual 和断言能力。" });
    pageModelRoute = await planAssistantRequestWithPageModels({
      rootDir,
      project: input.project,
      env: input.env,
      message: caseRequest,
      assertions: workbenchCaseExpectedAssertions(target),
      deepSeekIntent: pageModelDeepSeekIntent.parsedOutput
    });
  }
  if (pageModelRoute.route !== "page_model") {
    emit({ id: "project_knowledge_retrieval", title: "项目知识检索", status: "failed", detail: pageModelRoute.reason });
    const diagnosticPath = await writeDslDiagnostic({
      project: input.project,
      env: input.env,
      caseId: target.id,
      stage: "page_model_retrieval",
      chineseSummary: `DSL生成失败：未匹配到足够页面知识。${pageModelRoute.reason ?? ""}`,
      requestSnapshot: caseRequest,
      gaps: [String(pageModelRoute.reason ?? "page_model_route_failed")],
      suggestions: ["补齐 Page Model 或 Operation Manual 后重新生成 DSL。"]
    });
    const proposalPath = await writeAssistantKnowledgeProposal(context, {
      project: input.project,
      env: input.env,
      message: caseRequest,
      stage: "dsl_page_model_retrieval",
      reason: pageModelRoute.reason ?? "page_model_route_failed",
      plan: {
        intent: pageModelDeepSeekIntent.parsedOutput,
        pageModelUnavailableReason: pageModelRoute.reason,
        diagnosticPath
      }
    });
    return { caseId: target.id, ok: false, error: `DSL生成失败：未匹配到足够页面知识。请分析 DSL 失败诊断：${diagnosticPath}`, diagnosticPath, proposalPath };
  }
  if (!planSummary) {
    emit({ id: "project_knowledge_retrieval", title: "项目知识检索", status: "completed", detail: pageModelRoute.chineseMessage });
    planSummary = summarizePageModelRouteForResponse(pageModelRoute.plan);
    emit({
      id: "dsl_materialization",
      title: "DSL 物化",
      status: "completed",
      detail: `已根据项目知识生成 ${pageModelRoute.plan.materialization.case.steps.length} 个步骤。`
    });
    emit({
      id: "grounded_contract_validation",
      title: "生成内容可信度校验",
      status: pageModelRoute.plan.intentContract.passed ? (pageModelRoute.plan.intentContract.warningGaps?.length ? "warning" : "completed") : "failed",
      detail: pageModelRoute.plan.intentContract.passed
        ? pageModelRoute.plan.intentContract.warningGaps?.length
          ? `存在可信度警告，不阻断生成：${formatLocalizedPageModelGaps(pageModelRoute.plan.intentContract.warningGaps)}`
          : `可信度校验通过，检查 ${pageModelRoute.plan.intentContract.checkedRules.length} 条规则。`
        : `生成内容引用了不可执行或不存在的知识：${formatLocalizedPageModelGaps(pageModelRoute.plan.intentContract.blockingGaps.length ? pageModelRoute.plan.intentContract.blockingGaps : pageModelRoute.plan.intentContract.gaps)}`
    });
  }
  if (input.abortSignal?.aborted) return caseDslGenerationCancelledResult(target.id, input.runId);
  if (!pageModelRoute.plan.intentContract.passed) {
    const hardGaps = pageModelRoute.plan.intentContract.blockingGaps.length
      ? pageModelRoute.plan.intentContract.blockingGaps
      : pageModelRoute.plan.intentContract.gaps;
    const diagnosticPath = await writeDslDiagnostic({
      project: input.project,
      env: input.env,
      caseId: target.id,
      stage: "grounded_contract_validation",
      chineseSummary: `DSL生成失败：生成内容可信度校验未通过，存在未落库或不可执行知识：${hardGaps.join(", ") || "unknown"}。`,
      requestSnapshot: caseRequest,
      gaps: hardGaps,
      suggestions: [
        "如果 gap 指向页面、能力、字段、断言或 provider，请按建模手册补齐项目知识后重新生成 DSL。",
        "如果业务意图本身是正确的，不要新增本地标题正则；应补 Page Model、Operation Manual 或用例契约。"
      ],
      extra: {
        intentContract: pageModelRoute.plan.intentContract,
        pageModelExecutionPlan: planSummary
      }
    });
    const proposalPath = await writeAssistantKnowledgeProposal(context, {
      project: input.project,
      env: input.env,
      message: caseRequest,
      stage: "grounded_contract_validation",
      reason: `Grounded contract gap: ${hardGaps.join(", ") || "unknown"}`,
      plan: {
        intent: planSummary.intent,
        readiness: planSummary.readiness,
        gaps: hardGaps,
        blockingGaps: hardGaps,
        diagnosticPath,
        pageModelExecutionPlan: planSummary,
        intentContract: pageModelRoute.plan.intentContract
      }
    });
    emit({ id: "write_result", title: "写入结果", status: "skipped", detail: "可信度硬阻塞时不写入 DSL，只写入诊断和知识提案。" });
    return {
      caseId: target.id,
      ok: false,
      executable: false,
      error: `DSL生成失败：生成内容可信度校验未通过。请查看诊断：${diagnosticPath}`,
      gaps: hardGaps,
      blockingGaps: hardGaps,
      diagnosticPath,
      proposalPath
    };
  }
  emit({ id: "account_profile_match", title: "账号画像匹配", status: "running", detail: "只基于用例、Page Model、Operation Manual 或 AutomationCase 的结构化账号要求匹配账号。" });
  const accountProfileDecision = await resolveAccountProfileDecision({
    project: input.project,
    env: input.env,
    caseId: target.id,
    request: caseRequest,
    item: target,
    automationCase: pageModelRoute.plan.materialization.case,
    aiIntent: pageModelDeepSeekIntent.parsedOutput,
    accounts,
    writeDiagnosticOnBlocked: true
  });
  const accountProfileBlocked = accountProfileDecision.status === "blocked" || accountProfileDecision.status === "not_configured";
  emit({
    id: "account_profile_match",
    title: "账号画像匹配",
    status: accountProfileBlocked ? "failed" : "completed",
    detail: accountProfileDecision.chineseSummary,
    retryable: accountProfileBlocked,
    failedStage: accountProfileBlocked ? "account_profile_match" : undefined
  });
  if (input.abortSignal?.aborted) return caseDslGenerationCancelledResult(target.id, input.runId);
  if (accountProfileBlocked) {
    return {
      caseId: target.id,
      ok: false,
      executable: false,
      error: accountProfileDecision.diagnosticPath
        ? `${accountProfileDecision.chineseSummary} 请前往后台输入“分析DSL失败原因”查看详情：${accountProfileDecision.diagnosticPath}`
        : accountProfileDecision.chineseSummary,
      diagnosticPath: accountProfileDecision.diagnosticPath,
      accountProfileDecision,
      failedStage: "account_profile_match",
      retryable: true,
      resumeState: {
        stage: "account_profile_match",
        caseRequest,
        pageModelDeepSeekIntent,
        pageModelRoute,
        planSummary
      }
    };
  }
  emit({ id: "deepseek_grounded_advisory", title: "AI 压缩审查", status: "running", detail: "把本地已物化 DSL 和最小证据集交给 AI 做结构化一致性审查。" });
  const pageModelDeepSeek = await tryBuildDeepSeekPageModelDslAdvisor({
    project: input.project,
    env: input.env,
    message: caseRequest,
    initialUnderstanding: pageModelDeepSeekIntent.parsedOutput,
    planningContext: pageModelRoute.plan.planningContext,
    plan: pageModelRoute.plan,
    planSummary,
    localDslValidation: pageModelRoute.plan.materialization.dslValidation
  });
  const advisorHardBlock = classifyPageModelDslAdvisorHardBlock(pageModelDeepSeek, { localValidationPassed: pageModelRoute.plan.materialization.dslValidation.passed });
  emit({ id: "deepseek_grounded_advisory", title: "AI 压缩审查", status: advisorHardBlock ? "failed" : pageModelDeepSeek.status === "completed" ? "completed" : pageModelDeepSeek.status === "skipped" ? "skipped" : "warning", detail: advisorHardBlock?.summary ?? pageModelDeepSeek.error ?? "AI 已完成压缩上下文 DSL 审查；调用失败不阻断，结构化否决会阻断写入。" });
  if (input.abortSignal?.aborted) return caseDslGenerationCancelledResult(target.id, input.runId);
  if (advisorHardBlock) {
    const diagnosticPath = await writeDslDiagnostic({
      project: input.project,
      env: input.env,
      caseId: target.id,
      stage: "deepseek_grounded_advisory",
      chineseSummary: advisorHardBlock.summary,
      requestSnapshot: caseRequest,
      accountDecision: accountProfileDecision,
      gaps: advisorHardBlock.gaps,
      suggestions: [
        "优先检查 DSL 物化结果是否多出了用户未要求的步骤。",
        "检查断言是否引用 Page Model 中真实存在的 assertionId，而不是页面 ID 或需求原文。",
        "修正 Page Model 选证、用例描述或 DSL 物化规则后重新生成。"
      ],
      extra: {
        pageModelDeepSeek,
        pageModelExecutionPlan: planSummary,
        accountProfileDecision
      }
    });
    const proposalPath = await writeAssistantKnowledgeProposal(context, {
      project: input.project,
      env: input.env,
      message: caseRequest,
      stage: "deepseek_grounded_advisory",
      reason: advisorHardBlock.summary,
      plan: {
        intent: `${pageModelRoute.plan.selection.intent.module}.${pageModelRoute.plan.selection.intent.action}`,
        intentSpec: pageModelRoute.plan.selection.intent,
        readiness: pageModelRoute.plan.readiness,
        gaps: advisorHardBlock.gaps,
        blockingGaps: advisorHardBlock.gaps,
        diagnosticPath,
        pageModelExecutionPlan: planSummary,
        accountProfileDecision
      },
      testCase: pageModelRoute.plan.materialization.case,
      assertionSummaries: summarizeWorkbenchMaterializedAssertions(pageModelRoute.plan.materialization.case).map((summary, index) => ({ index, summary, status: "failed" }))
    });
    emit({ id: "write_result", title: "写入结果", status: "skipped", detail: `AI 压缩审查已阻断 DSL 写入；诊断：${diagnosticPath}` });
    return {
      caseId: target.id,
      ok: false,
      executable: false,
      error: `${advisorHardBlock.summary} 请前往后台输入“分析DSL失败原因”查看详情：${diagnosticPath}`,
      gaps: advisorHardBlock.gaps,
      blockingGaps: advisorHardBlock.gaps,
      diagnosticPath,
      proposalPath,
      failedStage: "deepseek_grounded_advisory",
      retryable: true
    };
  }
  const previousRevision = (await workbenchCaseDslForProject(target, input.project))?.revision ?? 0;
  const assertionSummaries = summarizeWorkbenchMaterializedAssertions(pageModelRoute.plan.materialization.case);
  const expectedAssertionMissing = Boolean(target.expectedAssertion.trim()) && assertionSummaries.length === 0;
  const assertionContract = validateWorkbenchAssertionContract({
    expectedAssertion: target.expectedAssertion,
    automationCase: pageModelRoute.plan.materialization.case,
    assertionSummaries
  });
  emit({ id: "dsl_contract_validation", title: "DSL 契约校验", status: "running", detail: "校验断言契约、DSL 可执行性和 gap 分类。" });
  const caseGaps = expectedAssertionMissing
    ? [...pageModelRoute.plan.gaps, "case_expected_assertion_not_materialized", ...assertionContract.gaps]
    : [...pageModelRoute.plan.gaps, ...assertionContract.gaps];
  const caseBlockingGaps = expectedAssertionMissing
    ? [...pageModelRoute.plan.blockingGaps, "case_expected_assertion_not_materialized", ...assertionContract.gaps]
    : [...pageModelRoute.plan.blockingGaps, ...assertionContract.gaps];
  const nextDsl: WorkbenchCaseDsl = {
    schemaVersion: "workbench-case-dsl.v1",
    revision: previousRevision + 1,
    generatedAt: new Date().toISOString(),
    generator: "page-model-assistant-plan",
    sourceCaseHash: hashWorkbenchCase(target),
    changedSinceGeneration: false,
    plan: {
      intent: `${pageModelRoute.plan.selection.intent.module}.${pageModelRoute.plan.selection.intent.action}`,
      intentSpec: pageModelRoute.plan.selection.intent,
      source: "page_model",
      executable: pageModelRoute.plan.executable,
      readiness: pageModelRoute.plan.readiness,
      gaps: pageModelRoute.plan.gaps,
      blockingGaps: pageModelRoute.plan.blockingGaps,
      recommendedNextAction: pageModelRoute.plan.recommendedNextAction,
      requiresConfirmation: false,
      pageModelDeepSeekIntent,
      pageModelDeepSeek,
      aiIntent: pageModelDeepSeekIntent,
      aiDslAdvisor: pageModelDeepSeek,
      accountProfileDecision,
      pageModelExecutionPlan: planSummary,
      steps: planSummary.automationCase
    },
    automationCase: pageModelRoute.plan.materialization.case,
    stepSummaries: summarizeWorkbenchDslSteps(pageModelRoute.plan.materialization.case.steps),
    assertionSummaries,
    readiness: pageModelRoute.plan.readiness,
    executable: pageModelRoute.plan.executable && !expectedAssertionMissing && assertionContract.passed,
    gaps: caseGaps,
    blockingGaps: caseBlockingGaps,
    assertionContract,
    accountProfileDecision,
    ai: { intent: pageModelDeepSeekIntent, dslAdvisor: pageModelDeepSeek },
    deepseek: { intent: pageModelDeepSeekIntent, dslAdvisor: pageModelDeepSeek }
  };
  target.updatedAt = new Date().toISOString();
  const dslStorePath = await writeWorkbenchCaseDsl(input.project, target.id, nextDsl);
  await writeWorkbenchCaseAssetStore(data);
  const diagnosticStage = classifyWorkbenchDslDiagnosticStage(nextDsl);
  const diagnosticPath = nextDsl.executable
    ? undefined
    : await writeDslDiagnostic({
        project: input.project,
        env: input.env,
        caseId: target.id,
        stage: diagnosticStage.stage,
        chineseSummary: diagnosticStage.summary,
        requestSnapshot: caseRequest,
        accountDecision: accountProfileDecision,
        gaps: nextDsl.gaps,
        suggestions: diagnosticStage.suggestions,
        extra: {
          readiness: nextDsl.readiness,
          blockingGaps: nextDsl.blockingGaps,
          assertionContract: nextDsl.assertionContract
        }
      });
  const proposalPath = nextDsl.executable
    ? undefined
    : await writeAssistantKnowledgeProposal(context, {
        project: input.project,
        env: input.env,
        message: caseRequest,
        stage: diagnosticStage.stage,
        reason: `DSL gap: ${nextDsl.gaps.join(", ") || "unknown"}`,
        plan: {
          intent: nextDsl.plan.intent,
          intentSpec: nextDsl.plan.intentSpec,
          readiness: nextDsl.readiness,
          gaps: nextDsl.gaps,
          blockingGaps: nextDsl.blockingGaps,
          diagnosticPath,
          pageModelExecutionPlan: nextDsl.plan.pageModelExecutionPlan,
          assertionContract: nextDsl.assertionContract,
          accountProfileDecision: nextDsl.accountProfileDecision
        },
        testCase: nextDsl.automationCase,
        assertionSummaries: nextDsl.assertionSummaries.map((summary, index) => ({ index, summary, status: "failed" }))
      });
  emit({
    id: "dsl_contract_validation",
    title: "DSL 契约校验",
    status: nextDsl.executable ? "completed" : "failed",
    detail: nextDsl.executable ? `DSL r${nextDsl.revision} 可执行。` : `DSL r${nextDsl.revision} 存在 gap：${nextDsl.gaps.join(", ") || "unknown"}${diagnosticPath ? `；诊断：${diagnosticPath}` : ""}`
  });
  emit({ id: "write_result", title: "写入结果", status: "completed", detail: `已写入项目 ${input.project} 的 DSL r${nextDsl.revision}。` });
  return {
    caseId: target.id,
    ok: true,
    revision: nextDsl.revision,
    executable: nextDsl.executable,
    readiness: nextDsl.readiness,
    gaps: nextDsl.gaps,
    blockingGaps: nextDsl.blockingGaps,
    storePath: dslStorePath,
    diagnosticPath,
    proposalPath
  };
}

/**
 * 平台语义 gap：这些否决理由属于平台自身能确定性判断的领域，
 * 不应交给 AI 审查裁量。本地契约校验（dslValidation）已通过时，
 * 仅含此类理由的否决视为误拦，降级为 warning 放行。
 */
const ADVISOR_PLATFORM_SEMANTIC_GAP_PATTERNS: RegExp[] = [
  /未在知识库中预定义/i,
  /用户自定义.*仅作参考/i,
  /缺少登录.*步骤/i,
  /缺少登录.*动作/i,
  /登录未在\s*DSL\s*中显式体现/i,
  /登录.*环境预置/i,
  /DSL\s*缺少登录/i
];

function isPlatformSemanticAdvisoryGap(reason: string): boolean {
  return ADVISOR_PLATFORM_SEMANTIC_GAP_PATTERNS.some((pattern) => pattern.test(reason));
}

function classifyPageModelDslAdvisorHardBlock(advisor: unknown, options?: {
  localValidationPassed?: boolean;
}): { summary: string; gaps: string[] } | undefined {
  if (!isRecord(advisor) || advisor.status !== "completed" || !isRecord(advisor.parsedOutput)) return undefined;
  const parsed = advisor.parsedOutput;
  const semanticAlignment = String(parsed.semanticAlignment ?? "").trim();
  const shouldWriteDsl = parsed.shouldWriteDsl;
  const referencedIdsValid = parsed.referencedIdsValid;
  const shouldBlock = shouldWriteDsl === false || referencedIdsValid === false || semanticAlignment === "has_gap";
  if (!shouldBlock) return undefined;
  const rawReasons = [
    ...stringArrayFromUnknown(parsed.gaps),
    ...stringArrayFromUnknown(parsed.notes)
  ].map((item) => item.trim()).filter(Boolean);
  let reasons = [...new Set(rawReasons)].slice(0, 8);

  // 本地契约校验通过时，剔除平台语义类误拦理由；剩余理由为空则放行（降级为 warning）。
  if (options?.localValidationPassed) {
    const materialReasons = reasons.filter((reason) => !isPlatformSemanticAdvisoryGap(reason));
    if (materialReasons.length !== reasons.length) {
      logger.warn("Advisory veto downgraded: platform-semantic-only gaps with local validation passed", {
        droppedReasons: reasons.filter((reason) => isPlatformSemanticAdvisoryGap(reason))
      });
      reasons = materialReasons;
      if (!reasons.length) return undefined;
    }
  }

  if (semanticAlignment === "has_gap" && !reasons.some((item) => item.includes("semanticAlignment"))) reasons.unshift("semanticAlignment=has_gap");
  if (shouldWriteDsl === false && !reasons.some((item) => item.includes("shouldWriteDsl"))) reasons.unshift("shouldWriteDsl=false");
  if (referencedIdsValid === false && !reasons.some((item) => item.includes("referencedIdsValid"))) reasons.unshift("referencedIdsValid=false");
  // 引用 ID 无效是硬伤，任何时候不因语义过滤而放行。
  if (referencedIdsValid === false && reasons.every((reason) => isPlatformSemanticAdvisoryGap(reason))) {
    reasons.unshift("referencedIdsValid=false");
  }
  const gaps = reasons.length ? reasons : ["deepseek_grounded_advisory_rejected_dsl"];
  return {
    summary: `DSL生成失败：AI 压缩审查发现已物化 DSL 与用例或项目知识不一致，已阻断写入：${gaps.join("；")}。`,
    gaps
  };
}

function stringArrayFromUnknown(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item)).filter(Boolean) : [];
}

function classifyWorkbenchDslDiagnosticStage(dsl: WorkbenchCaseDsl): { stage: string; summary: string; suggestions: string[] } {
  const gaps = [...new Set([...(dsl.blockingGaps ?? []), ...(dsl.gaps ?? [])])];
  const gapText = gaps.join(", ") || "unknown";
  if (gaps.some((gap) => gap.startsWith("intent_arbitration_conflict:"))) {
    return {
      stage: "grounded_contract_validation",
      summary: `DSL生成失败：生成内容可信度校验未通过，存在历史兼容 gap：${gapText}。`,
      suggestions: [
        "优先检查 DeepSeek 结构化意图是否选择了当前项目 Page Model / Operation Manual 中存在的页面、能力、字段和断言。",
        "本地代码只做契约校验，不应继续追加项目标题正则或业务关键词规则。",
        "确认 Page Model / Operation Manual 是否已经覆盖目标页面和动作；缺失时补项目知识资产。"
      ]
    };
  }
  if (gaps.some((gap) => gap.includes("account_profile"))) {
    const accountDiagnostic = dsl.accountProfileDecision ? classifyAccountProfileDiagnostic(dsl.accountProfileDecision) : undefined;
    if (accountDiagnostic?.stage === "business_precondition_match") return accountDiagnostic;
    return {
      stage: "account_profile_match",
      summary: `DSL生成失败：账号画像匹配未通过，存在 gap：${gapText}。`,
      suggestions: [
        "优先检查用例、Operation Manual capability 或 Page Model blockedState 是否提供结构化账号画像要求。",
        "补齐目标项目/环境的账号画像维度，或准备满足前置条件的账号。",
        "不要通过用例标题正则补账号选择逻辑。"
      ]
    };
  }
  if (dsl.assertionContract && !dsl.assertionContract.passed) {
    return {
      stage: "assertion_contract_validation",
      summary: `DSL生成失败：断言契约校验未通过，存在 gap：${gapText}。`,
      suggestions: [
        "优先检查用例期望断言是否单一明确。",
        "检查 Page Model 是否已有可引用断言能力。",
        "必要时补采页面区域、弹窗、toast 或动态行断言。"
      ]
    };
  }
  return {
    stage: "dsl_contract_validation",
    summary: `DSL生成失败：DSL 契约校验未通过，存在 gap：${gapText}。`,
    suggestions: [
      "如果 gap 指向页面字段或元素，按建模手册补采对应页面区域、状态或动态行模板。",
      "如果 gap 指向 provider 或成功证据，检查 Operation Manual 的 provider flow 和 success policy。",
      "如果 gap 指向断言物化，检查 Page Model 断言能力和用例期望。"
    ]
  };
}

function caseDslGenerationCancelledResult(caseId: string, runId?: string): Record<string, unknown> {
  return {
    caseId,
    runId,
    ok: false,
    executable: false,
    status: "cancelled",
    error: "用户已停止批量生成 DSL。"
  };
}

async function executeWorkbenchCase(input: { project: string; env: string; caseId: string; observationMode?: boolean; runId?: string; abortSignal?: AbortSignal; onStep?: RuntimeOptions["onStep"] }): Promise<Record<string, unknown>> {
  if (input.abortSignal?.aborted) return caseExecutionCancelledResult(input.caseId, input.runId);
  const data = await readWorkbenchCaseAssetStore();
  const target = data.cases.find((item) => item.id === input.caseId);
  if (!target) return { caseId: input.caseId, ok: false, error: "用例不存在。" };
  const activeDsl = await workbenchCaseDslForProject(target, input.project);
  const blocked = validateExecutableWorkbenchCase(target, activeDsl, input.project);
  if (blocked) return blocked;
  if (!activeDsl?.automationCase) return { caseId: target.id, ok: false, error: `该用例在项目 ${input.project} 下还没有生成 DSL，不能执行。` };
  const context = await loadContext({ project: input.project, env: input.env });
  await new AccountStore(context).seedDefaults();
  const accounts = await new AccountStore(context).list({ project: input.project, env: input.env });
  const accountProfileDecision = await resolveAccountProfileDecision({
    project: input.project,
    env: input.env,
    caseId: target.id,
    request: buildWorkbenchCaseExecutionRequest({ project: input.project, env: input.env, item: target }),
    item: target,
    automationCase: activeDsl.automationCase,
    aiIntent: readRecord(activeDsl.ai?.intent).parsedOutput ?? readRecord(activeDsl.deepseek?.intent).parsedOutput,
    accounts,
    writeDiagnosticOnBlocked: true
  });
  if (accountProfileDecision.status === "blocked" || accountProfileDecision.status === "not_configured") {
    return {
      caseId: target.id,
      ok: false,
      error: accountProfileDecision.diagnosticPath
        ? `${accountProfileDecision.chineseSummary} 请前往后台输入“分析DSL失败原因”查看详情：${accountProfileDecision.diagnosticPath}`
        : accountProfileDecision.chineseSummary,
      accountProfileDecision
    };
  }
  const selectedAccount = accounts.find((account) => account.username === accountProfileDecision.selectedAccount);
  const started = Date.now();
  let result: Awaited<ReturnType<typeof executeAssistantAutomationTask>>;
  try {
    result = await executeAssistantAutomationTask(context, {
      project: input.project,
      env: input.env,
      message: buildWorkbenchCaseExecutionRequest({ project: input.project, env: input.env, item: target }),
      plan: activeDsl.plan,
      testCase: activeDsl.automationCase,
      source: "page_model",
      account: selectedAccount,
      observationMode: Boolean(input.observationMode),
      abortSignal: input.abortSignal,
      onStep: input.onStep
    });
  } catch (error) {
    if (isCaseExecutionCancelledError(error)) return caseExecutionCancelledResult(target.id, input.runId, selectedAccount?.username);
    throw error;
  }
  const profileUpdatedPath = await markAccountProfileImpactsStale({
    project: input.project,
    env: input.env,
    username: selectedAccount?.username,
    impactDimensions: accountProfileDecision.profileImpact,
    reason: result.exitCode === 0 ? "case_execution_passed" : "case_execution_failed_may_have_partial_impact",
    runId: result.runId
  });
  const execution: WorkbenchCaseExecution = {
    runId: result.runId,
    executedAt: new Date().toISOString(),
    project: input.project,
    env: input.env,
    status: result.exitCode === 0 ? "passed" : "failed",
    exitCode: result.exitCode,
    durationMs: Date.now() - started,
    assertionSummaries: result.assertionSummaries ?? [],
    executionSteps: result.executionSteps ?? [],
    actualResult: result.stderr || result.stdout,
    failurePackagePath: result.failurePackagePath,
    failurePromptPath: result.failurePromptPath,
    proposalPath: result.proposalPath,
    caseRunPath: result.caseRunPath,
    observationMode: result.observationMode,
    observationArtifactPath: result.observationArtifactPath,
    account: selectedAccount?.username,
    accountProfileDecision,
    profileUpdatedPath
  };
  target.updatedAt = new Date().toISOString();
  await appendWorkbenchCaseExecution(input.project, target.id, execution);
  await writeWorkbenchCaseAssetStore(data);
  return { caseId: target.id, ok: true, executionSteps: result.executionSteps ?? [], ...execution };
}

async function executeWorkbenchCaseBatch(input: { project: string; env: string; caseIds: string[]; observationMode?: boolean; runId?: string; abortSignal?: AbortSignal; onStep?: (caseId: string) => RuntimeOptions["onStep"] }): Promise<Record<string, unknown>[]> {
  if (input.observationMode) {
    const results: Record<string, unknown>[] = [];
    for (const caseId of input.caseIds) results.push(input.abortSignal?.aborted ? caseExecutionCancelledResult(caseId, input.runId) : await executeWorkbenchCase({ ...input, caseId, onStep: input.onStep?.(caseId) }));
    return results;
  }
  const data = await readWorkbenchCaseAssetStore();
  const selected = input.caseIds.map((caseId) => data.cases.find((item) => item.id === caseId));
  const missing = input.caseIds
    .filter((caseId, index) => !selected[index])
    .map((caseId) => ({ caseId, ok: false, error: "用例不存在。" }));
  const existing = selected.filter((item): item is WorkbenchCaseAsset => Boolean(item));
  const blockedBeforeLaunch: Record<string, unknown>[] = [];
  const executable: Array<{ target: WorkbenchCaseAsset; activeDsl: WorkbenchCaseDsl }> = [];
  for (const target of existing) {
    const activeDsl = await workbenchCaseDslForProject(target, input.project);
    const blocked = validateExecutableWorkbenchCase(target, activeDsl, input.project);
    if (blocked) blockedBeforeLaunch.push(blocked);
    else if (activeDsl) executable.push({ target, activeDsl });
  }
  if (!executable.length) return input.caseIds.map((caseId) =>
    [...missing, ...blockedBeforeLaunch].find((item) => item.caseId === caseId) ?? { caseId, ok: false, error: "批量执行未返回结果。" }
  );
  const context = await loadContext({ project: input.project, env: input.env });
  await new AccountStore(context).seedDefaults();
  const accounts = await new AccountStore(context).list({ project: input.project, env: input.env });
  const baseUrl = context.env.web?.baseUrl;
  let driver: WebDriverAdapter | undefined;
  const results: Record<string, unknown>[] = [...missing, ...blockedBeforeLaunch];
  let activeDriverAccount: string | undefined;
  let activeRuntime: RuntimeOptions | undefined;
  try {
    const executor = new DslExecutor(context);
    for (const { target, activeDsl } of executable) {
      if (input.abortSignal?.aborted) {
        results.push(caseExecutionCancelledResult(target.id, input.runId));
        continue;
      }
      const started = Date.now();
      const accountProfileDecision = await resolveAccountProfileDecision({
        project: input.project,
        env: input.env,
        caseId: target.id,
        request: buildWorkbenchCaseExecutionRequest({ project: input.project, env: input.env, item: target }),
        item: target,
        automationCase: activeDsl.automationCase,
        aiIntent: readRecord(activeDsl.ai?.intent).parsedOutput ?? readRecord(activeDsl.deepseek?.intent).parsedOutput,
        accounts,
        writeDiagnosticOnBlocked: true
      });
      if (accountProfileDecision.status === "blocked" || accountProfileDecision.status === "not_configured") {
        results.push({
          caseId: target.id,
          ok: false,
          status: "failed",
          error: accountProfileDecision.diagnosticPath
            ? `${accountProfileDecision.chineseSummary} 请前往后台输入“分析DSL失败原因”查看详情：${accountProfileDecision.diagnosticPath}`
            : accountProfileDecision.chineseSummary,
          accountProfileDecision
        });
        continue;
      }
      const account = accounts.find((item) => item.username === accountProfileDecision.selectedAccount);
      const loginRequired = activeDsl.automationCase ? automationCaseRequiresLogin(activeDsl.automationCase) : false;
      if (loginRequired && !account) {
        results.push({ caseId: target.id, ok: false, status: "failed", error: `登录预检失败：项目 ${input.project}/${input.env} 没有可用账号。`, accountProfileDecision });
        continue;
      }
      if (!driver || activeDriverAccount !== account?.username) {
        await driver?.close().catch(() => undefined);
        driver = undefined;
        activeRuntime = await buildWorkbenchBatchRuntimeForAccount({ context, project: input.project, env: input.env, account, baseUrl });
        if (loginRequired && !activeRuntime.webAuthToken) {
          results.push({ caseId: target.id, ok: false, status: "failed", error: `登录预检失败：项目 ${input.project}/${input.env} 未获得旁路登录 token，已停止执行。`, account: account?.username, accountProfileDecision });
          continue;
        }
        driver = await WebDriverAdapter.launch(context, true, {
          extraHTTPHeaders: activeRuntime.webAuthToken?.headerName ? { [activeRuntime.webAuthToken.headerName]: activeRuntime.webAuthToken.token } : undefined,
          authToken: activeRuntime.webAuthToken
        });
        activeDriverAccount = account?.username;
      }
      const executableCase = account && activeDsl?.automationCase
        ? { ...activeDsl.automationCase, dataProfile: account.username }
        : activeDsl?.automationCase;
      if (!activeDsl || !executableCase) {
        results.push({ caseId: target.id, ok: false, error: "当前项目 DSL 不存在或不可执行。" });
        continue;
      }
      const lines = [
        "source=page_model",
        `caseId=${executableCase.id}`,
        `steps=${executableCase.steps.length}`,
        `assertions=${executableCase.assertions.length}`
      ];
      if (account) lines.push(`account=${account.username}`);
      if (activeRuntime?.webAuthToken) lines.push(`auth=injected:${activeRuntime.webAuthToken.headerName}`);
      const runtimeOptions = { ...(activeRuntime ?? buildWorkbenchRuntimeOptions(input.project, input.env)), abortSignal: input.abortSignal, onStep: input.onStep?.(target.id) };
      let result: Awaited<ReturnType<DslExecutor["executeCase"]>>;
      try {
        result = await executor.executeCase({ testCase: executableCase, context, options: runtimeOptions, driver, closeDriver: false });
      } catch (error) {
        if (isCaseExecutionCancelledError(error)) {
          results.push(caseExecutionCancelledResult(target.id, input.runId, account?.username));
          continue;
        }
        throw error;
      }
      const observationArtifactPath = result.runId ? await findRunObservationArtifactPath(context, result.runId) : undefined;
      const assertionSummaries = result.runId ? await collectRunAssertionSummaries(context, result.runId) : [];
      const executionSteps = result.runId ? await collectRunStepSummaries(context, result.runId, executableCase, result.status) : [];
      const failureArtifacts = result.runId ? await findLatestRunFailureArtifacts(context, result.runId) : undefined;
      const profileUpdatedPath = await markAccountProfileImpactsStale({
        project: input.project,
        env: input.env,
        username: account?.username,
        impactDimensions: accountProfileDecision.profileImpact,
        reason: result.status === "passed" ? "case_execution_passed" : "case_execution_failed_may_have_partial_impact",
        runId: result.runId
      });
      lines.push(`status=${result.status}`);
      if (result.runId) lines.push(`runId=${result.runId}`);
      for (const summary of assertionSummaries) {
        lines.push(`assertion=${String(summary.status)} ${String(summary.type ?? "")} ${String(summary.column ?? summary.target ?? "")} expected=${JSON.stringify(summary.expected ?? "")}`);
      }
      if (result.error) lines.push(`error=${result.error}`);
      const execution: WorkbenchCaseExecution = {
        runId: result.runId,
        executedAt: new Date().toISOString(),
        project: input.project,
        env: input.env,
        account: account?.username,
        status: result.status === "passed" ? "passed" : "failed",
        exitCode: result.status === "passed" ? 0 : 1,
        durationMs: Date.now() - started,
        assertionSummaries,
        executionSteps,
        actualResult: lines.join("\n"),
        failurePackagePath: failureArtifacts?.failurePackagePath,
        failurePromptPath: failureArtifacts?.failurePromptPath,
        proposalPath: undefined,
        caseRunPath: result.runId ? path.join("storage", "case-runs", `${result.runId}.json`) : undefined,
        observationMode: false,
        observationArtifactPath,
        accountProfileDecision,
        profileUpdatedPath
      };
      target.updatedAt = new Date().toISOString();
      await appendWorkbenchCaseExecution(input.project, target.id, execution);
      results.push({ caseId: target.id, ok: true, executionSteps, ...execution });
    }
  } finally {
    await driver?.close().catch(() => undefined);
    await writeWorkbenchCaseAssetStore(data);
  }
  return input.caseIds.map((caseId) => results.find((item) => item.caseId === caseId) ?? { caseId, ok: false, error: "批量执行未返回结果。" });
}

function caseExecutionCancelledResult(caseId: string, runId?: string, account?: string): Record<string, unknown> {
  return {
    caseId,
    ok: false,
    runId,
    account,
    status: "cancelled",
    error: "用户已终止批量执行。"
  };
}

function isCaseExecutionCancelledError(error: unknown): boolean {
  return /Execution cancelled|用户已终止|cancelled/i.test(error instanceof Error ? error.message : String(error));
}

function buildWorkbenchRuntimeOptions(project: string, env: string, webAuthToken?: RuntimeOptions["webAuthToken"]): RuntimeOptions {
  return {
    project,
    env,
    tags: [],
    locales: [],
    dryRun: false,
    mode: "heal",
    headed: true,
    observationMode: false,
    maxAiCalls: 0,
    maxDurationMs: 90_000,
    webAuthToken
  };
}

async function buildWorkbenchBatchRuntimeForAccount(input: {
  context: LoadedContext;
  project: string;
  env: string;
  account?: TestAccount;
  baseUrl?: string;
}): Promise<RuntimeOptions> {
  if (!input.account || !input.baseUrl) return buildWorkbenchRuntimeOptions(input.project, input.env);
  const auth = await buildAssistantWebAuth(input.context, input.account).catch((error) => {
    logger.warn("Case batch bypass auth failed", {
      project: input.project,
      env: input.env,
      account: input.account?.username,
      error: error instanceof Error ? error.message : String(error)
    });
    return undefined;
  });
  if (!auth) {
    return buildWorkbenchRuntimeOptions(input.project, input.env);
  }
  return buildWorkbenchRuntimeOptions(input.project, input.env, {
    token: auth.token,
    originUrl: input.baseUrl,
    headerName: auth.headerName,
    storageKeys: auth.storageKeys,
    cookieNames: auth.cookieNames
  });
}

function validateExecutableWorkbenchCase(target: WorkbenchCaseAsset, activeDsl: WorkbenchCaseDsl | undefined, project: string): Record<string, unknown> | undefined {
  if (!activeDsl?.automationCase) return { caseId: target.id, ok: false, error: `该用例在项目 ${project} 下还没有生成 DSL，不能执行。` };
  const advisorBlock = classifyPageModelDslAdvisorHardBlock(activeDsl.ai?.dslAdvisor ?? activeDsl.deepseek?.dslAdvisor ?? activeDsl.plan?.aiDslAdvisor ?? activeDsl.plan?.pageModelDeepSeek, { localValidationPassed: !(activeDsl.blockingGaps ?? []).length });
  if (advisorBlock) {
    return {
      caseId: target.id,
      ok: false,
      status: "failed",
      exitCode: 1,
      error: `当前 DSL 已被 AI 压缩审查否决，拒绝执行：${advisorBlock.gaps.join("；")}`,
      dslAdvisorGaps: advisorBlock.gaps
    };
  }
  if (target.expectedAssertion.trim() && summarizeWorkbenchMaterializedAssertions(activeDsl.automationCase).length === 0) {
    return { caseId: target.id, ok: false, error: "用例有期望断言，但当前 DSL 没有物化断言步骤，请重新生成 DSL 或补齐断言映射能力。", gaps: ["case_expected_assertion_not_materialized"] };
  }
  if (!activeDsl.executable) return { caseId: target.id, ok: false, error: "当前项目 DSL 不可执行，请先查看 gaps 并补齐建模或断言能力。", gaps: activeDsl.gaps, blockingGaps: activeDsl.blockingGaps };
  return undefined;
}

async function saveWorkbenchCase(input: { project: string; caseId: string; patch: Record<string, unknown> }): Promise<Record<string, unknown>> {
  const data = await readWorkbenchCaseAssetStore();
  const target = data.cases.find((item) => item.id === input.caseId);
  if (!target) return { caseId: input.caseId, ok: false, error: "用例不存在。" };
  const textFields = ["title", "module", "caseType", "businessRequest", "request", "expectedAssertion", "pageModelId"] as const;
  for (const field of textFields) {
    if (field in input.patch) {
      const value = input.patch[field];
      if (field === "pageModelId" && value === "") target.pageModelId = undefined;
      else (target as unknown as Record<string, unknown>)[field] = String(value ?? "").trim();
    }
  }
  if ("priority" in input.patch) {
    const priority = String(input.patch.priority ?? "P2");
    if (["P0", "P1", "P2", "P3"].includes(priority)) target.priority = priority as WorkbenchCasePriority;
  }
  if ("automationCandidate" in input.patch) target.automationCandidate = Boolean(input.patch.automationCandidate);
  if ("preconditions" in input.patch) target.preconditions = normalizeCaseTextArray(input.patch.preconditions);
  if ("expectedResultsUi" in input.patch || "expectedResults" in input.patch) {
    target.expectedResults = {
      ...target.expectedResults,
      ui: normalizeCaseTextArray(input.patch.expectedResultsUi ?? (input.patch.expectedResults as Record<string, unknown> | undefined)?.ui)
    };
  }
  target.businessRequest = stripAssertionClauseFromCaseRequest(target.businessRequest || target.request, target.expectedAssertion);
  target.request = target.businessRequest;
  delete target.dslByProject;
  delete target.latestDsl;
  delete target.executionHistory;
  await deleteWorkbenchCaseDslForAllProjects(target.id);
  await deleteWorkbenchCaseDslGenerationSummariesForCase(input.project, target.id);
  target.updatedAt = new Date().toISOString();
  await writeWorkbenchCaseAssetStore(data);
  return { caseId: target.id, ok: true, dslStatus: "未生成", storePath: workbenchCaseStorePath(data.project) };
}

async function workbenchCaseDslForProject(item: WorkbenchCaseAsset, project: string): Promise<WorkbenchCaseDsl | undefined> {
  return await readWorkbenchCaseDsl(project, item.id) ?? item.dslByProject?.[project] ?? (item.project === project ? item.latestDsl : undefined);
}

function buildWorkbenchCaseExecutionRequest(input: { project: string; env: string; item: WorkbenchCaseAsset }): string {
  const businessRequest = normalizeWorkbenchCaseBusinessRequest(input.item);
  const titleRequest = normalizeWorkbenchCaseTitleRequest(input.item);
  const assertionText = input.item.expectedAssertion?.trim();
  const multiline = businessRequest.includes("\n");
  const requestText = titleRequest && !businessRequest.includes(titleRequest)
    ? multiline
      ? `用例标题：${titleRequest}\n业务步骤：\n${businessRequest}`
      : `用例标题：${titleRequest}。业务步骤：${businessRequest}`
    : businessRequest;
  const assertionClause = assertionText
    ? multiline
      ? `\n期望断言：${assertionText}`
      : `，期望断言：${assertionText}`
    : "";
  return `登录 ${input.project} ${input.env} 环境，${requestText}${assertionClause}`;
}

function buildWorkbenchStructuredCaseContext(item: WorkbenchCaseAsset): StructuredCaseContext {
  return buildStructuredCaseContext({
    title: normalizeWorkbenchCaseTitleRequest(item),
    businessRequest: normalizeWorkbenchCaseBusinessRequest(item),
    preconditions: item.preconditions,
    expectedAssertion: item.expectedAssertion,
    expectedResults: item.expectedResults,
    caseType: item.caseType,
    pageModelId: item.pageModelId
  });
}

function normalizeWorkbenchCaseBusinessRequest(item: WorkbenchCaseAsset): string {
  return stripAssertionClauseFromCaseRequest(item.businessRequest ?? item.request, item.expectedAssertion);
}

function normalizeWorkbenchCaseTitleRequest(item: WorkbenchCaseAsset): string {
  const title = stripAssertionClauseFromCaseRequest(item.title ?? "", item.expectedAssertion);
  if (!title || title === item.id) return "";
  return title;
}

function stripExecutionContextFromCaseRequest(value: string): string {
  return String(value ?? "")
    .replace(/^登录\s+[a-zA-Z0-9_-]+\s+[a-zA-Z0-9_-]+\s*环境[，,]\s*/u, "")
    .replace(/^登录\s+[^，,]+环境[，,]\s*/u, "")
    .trim();
}

function stripAssertionClauseFromCaseRequest(value: string, expectedAssertion?: string): string {
  let text = stripExecutionContextFromCaseRequest(value);
  const expected = String(expectedAssertion ?? "").trim();
  if (expected && text.includes(expected)) text = text.replace(expected, "");
  text = text
    .replace(/[，,。；;]?\s*(?:期望断言|期望|断言|预期结果|预期)\s*(?:为|是|：|:)?\s*[^，,。；;]*$/u, "")
    .replace(/[，,。；;]?\s*(?:期望|预期)[^，,。；;]*(?:数据|结果|记录|提示|成功|失败|为空|空列表)[^，,。；;]*$/u, "")
    .replace(/[，,。；;]\s*$/u, "")
    .trim();
  return text;
}

function workbenchCaseExpectedAssertions(item: WorkbenchCaseAsset): string[] {
  const expected = item.expectedAssertion?.trim();
  return expected ? normalizeCaseTextArray(expected) : [];
}

function normalizeCaseTextArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  if (typeof value === "string") return value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  return [];
}

function validateWorkbenchAssertionContract(input: {
  expectedAssertion: string;
  automationCase: AutomationCase;
  assertionSummaries: string[];
}): WorkbenchAssertionContractResult {
  const expected = input.expectedAssertion.trim();
  if (!expected) {
    return { passed: true, expectedAssertion: "", materializedAssertions: input.assertionSummaries, gaps: [] };
  }
  const materialized = collectWorkbenchDslAssertions(input.automationCase);
  const gaps: string[] = [];
  const expectedKind = classifyWorkbenchExpectedAssertion(expected);
  if (expectedKind === "table_value" && materialized.some((item) => item.type === "result_empty")) {
    gaps.push("case_assertion_contract_mismatch:expected_table_value_but_dsl_result_empty");
  }
  if (expectedKind === "empty" && !materialized.some((item) => item.type === "result_empty")) {
    gaps.push("case_assertion_contract_mismatch:expected_empty_but_dsl_not_empty_assertion");
  }
  const expectedValue = extractWorkbenchExpectedValue(expected);
  if (expectedKind === "table_value" && expectedValue) {
    const normalizedExpectedValue = normalizeAssertionContractText(expectedValue);
    const hasExpectedValue = materialized.some((item) => {
      const raw = item.raw ?? {};
      const materializedText = [
        item.expected,
        raw.target,
        raw.semantic_target,
        raw.semanticTarget,
        raw.column,
        raw.table,
        raw.targetElementId,
        raw.targetStateId
      ].map((part) => normalizeAssertionContractText(part)).join(" ");
      return materializedText.includes(normalizedExpectedValue);
    });
    if (!hasExpectedValue) gaps.push(`case_assertion_contract_mismatch:expected_value_not_materialized:${expectedValue}`);
  }
  return {
    passed: gaps.length === 0,
    expectedAssertion: expected,
    materializedAssertions: input.assertionSummaries,
    gaps
  };
}

function collectWorkbenchDslAssertions(testCase: AutomationCase): Array<{ type: string; expected: string; raw: Record<string, unknown> }> {
  const direct = (testCase.assertions ?? []).map((assertion) => ({
    type: String(assertion.type ?? ""),
    expected: assertion.expected === undefined ? "" : displayTraceValue(assertion.expected),
    raw: assertion as unknown as Record<string, unknown>
  }));
  const stepAssertions = (testCase.steps ?? [])
    .filter((step) => step.action === "assert" && step.assertion)
    .map((step) => ({
      type: String(step.assertion?.type ?? ""),
      expected: step.assertion?.expected === undefined ? "" : displayTraceValue(step.assertion.expected),
      raw: step.assertion as unknown as Record<string, unknown>
    }));
  return [...direct, ...stepAssertions];
}

function classifyWorkbenchExpectedAssertion(value: string): "empty" | "table_value" | "message" | "unknown" {
  const text = normalizeAssertionContractText(value);
  if (/(提示|toast|message|alert|弹窗|报错)/i.test(value)) return "message";
  if (/(返回空|为空|空列表|暂无|无数据|没有数据)/u.test(value)) return "empty";
  if (/(仅返回|只返回|均为|都为|为|包含|币种|类型|状态|列表|记录|数据)/u.test(value) && !/(返回空|为空|空列表|暂无|无数据|没有数据)/u.test(value)) return "table_value";
  if (/eth|usdt|btc|红包发放|申购|转入|转出/i.test(text)) return "table_value";
  return "unknown";
}

function extractWorkbenchExpectedValue(value: string): string | undefined {
  const quoted = value.match(/[“"']([^“”"']{1,80})[”"']/u)?.[1];
  if (quoted) return quoted.trim();
  const code = value.match(/\b(ETH|USDT|BTC|USDC|BSC|TRC-20|ERC-20)\b/i)?.[1];
  if (code) return code.toUpperCase();
  const fieldValue = value.match(/(?:类型|币种|状态|交易类型|产品类型)(?:列)?(?:均为|都为|都是|为|是)\s*([^，,。；;\s]+?)(?:的(?:数据|记录|结果)?|数据|记录|结果)?$/u)?.[1];
  if (fieldValue) return fieldValue.trim();
  const onlyReturnValue = value.match(/(?:仅返回|只返回)[^，,。；;]*?(?:类型|币种|状态|交易类型|产品类型)(?:列)?(?:为|是)?\s*([^，,。；;\s]+?)(?:的(?:数据|记录|结果)?|数据|记录|结果)?$/u)?.[1];
  if (onlyReturnValue) return onlyReturnValue.trim();
  const afterAs = value.match(/(?:为|是|仅返回|只返回|类型为|币种为)\s*([^，,。；;\s]+?)(?:的(?:数据|记录|结果)?|数据|记录|结果)?$/u)?.[1];
  return afterAs?.trim();
}

function normalizeAssertionContractText(value: unknown): string {
  return String(value ?? "").toLowerCase().replace(/\s+/g, "");
}

function hashWorkbenchCase(item: WorkbenchCaseAsset): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify({
      title: item.title,
      priority: item.priority,
      caseType: item.caseType,
      request: item.businessRequest ?? stripExecutionContextFromCaseRequest(item.request),
      preconditions: item.preconditions,
      expectedAssertion: item.expectedAssertion,
      expectedResults: item.expectedResults,
      pageModelId: item.pageModelId
    }))
    .digest("hex");
}

function summarizeWorkbenchDslSteps(steps: DslStep[]): string[] {
  return steps.map((step, index) => {
    const target = step.semantic_target ?? step.semanticTarget ?? step.target ?? step.id ?? "-";
    const value = step.value !== undefined ? `：${displayTraceValue(step.value)}` : "";
    return `${index + 1}. ${step.action} ${target}${value}`;
  });
}

function summarizeWorkbenchDslAssertions(assertions: DslAssertion[]): string[] {
  return assertions.map((assertion, index) => {
    const target = assertion.column ?? assertion.target ?? assertion.table ?? assertion.type;
    const expected = assertion.expected !== undefined ? `，期望=${displayTraceValue(assertion.expected)}` : "";
    return `${index + 1}. ${assertion.type} ${target}${expected}`;
  });
}

function summarizeWorkbenchMaterializedAssertions(testCase: AutomationCase): string[] {
  const direct = summarizeWorkbenchDslAssertions(testCase.assertions ?? []);
  const stepAssertions = (testCase.steps ?? [])
    .filter((step) => step.action === "assert")
    .map((step, index) => {
      const assertion = step.assertion;
      const target = assertion?.column ?? assertion?.target ?? assertion?.table ?? step.semantic_target ?? step.semanticTarget ?? step.id ?? "assertion";
      const expected = assertion?.expected !== undefined ? `，期望=${displayTraceValue(assertion.expected)}` : "";
      return `${direct.length + index + 1}. ${assertion?.type ?? "assert"} ${target}${expected}`;
    });
  return [...direct, ...stepAssertions];
}

async function readProjectKnowledgeMapStore(project: string): Promise<ProjectKnowledgeMapStoreData> {
  const filePath = projectKnowledgeMapStorePath(project);
  if (await fs.pathExists(filePath)) {
    return await fs.readJson(filePath) as ProjectKnowledgeMapStoreData;
  }
  const generated = await buildProjectKnowledgeMapFromStores(project);
  await writeProjectKnowledgeMapStore(generated);
  return generated;
}

async function writeProjectKnowledgeMapStore(data: ProjectKnowledgeMapStoreData): Promise<string> {
  data.updatedAt = new Date().toISOString();
  data.summary = summarizeProjectKnowledgeNodes(data.nodes);
  const filePath = projectKnowledgeMapStorePath(data.project);
  await writeSafeJsonFile(filePath, data);
  return filePath;
}

function projectKnowledgeMapStorePath(project: string): string {
  return path.join(rootDir, "storage", "project-knowledge-maps", `${safePathSegment(project)}.json`);
}

async function buildProjectKnowledgeMapFromStores(project: string): Promise<ProjectKnowledgeMapStoreData> {
  const pageModelPath = path.join(rootDir, "storage", "page-models", `${safePathSegment(project)}.json`);
  const manualPath = path.join(rootDir, "storage", "operation-manuals", `${safePathSegment(project)}.json`);
  const pageModelStore = await fs.pathExists(pageModelPath) ? await fs.readJson(pageModelPath) as Record<string, unknown> : {};
  const manualStore = await fs.pathExists(manualPath) ? await fs.readJson(manualPath) as Record<string, unknown> : {};
  const models = Array.isArray(pageModelStore.models) ? pageModelStore.models as Array<Record<string, unknown>> : [];
  const manuals = Array.isArray(manualStore.manuals) ? manualStore.manuals as Array<Record<string, unknown>> : [];
  const manualByPageId = new Map(manuals.map((manual) => [String(manual.pageId ?? ""), manual]));
  const nodes = new Map<string, ProjectKnowledgeMapNode>();
  const projectNode: ProjectKnowledgeMapNode = {
    nodeId: `project.${project}`,
    label: project,
    nodeType: "project",
    path: [project],
    modelingStatus: models.length ? "partial" : "unmodeled",
    capabilities: [],
    elements: [],
    actions: [],
    assertions: [],
    sourceArtifacts: {},
    notes: ["项目根节点，由 Page Model Store 和 Operation Manual Store 汇总生成。"]
  };
  nodes.set(projectNode.nodeId, projectNode);

  for (const model of models) {
    const pageId = String(model.pageId ?? model.id ?? "");
    if (!pageId) continue;
    const manual = manualByPageId.get(pageId);
    const navPath = normalizeNavigationPath(manual?.entry, model);
    let parentId = projectNode.nodeId;
    const pathParts = navPath.length ? navPath : [String(model.pageName ?? pageId)];
    for (let index = 0; index < Math.max(0, pathParts.length - 1); index += 1) {
      const modulePath = pathParts.slice(0, index + 1);
      const nodeId = `module.${stableTextId([project, ...modulePath].join("|"))}`;
      if (!nodes.has(nodeId)) {
        nodes.set(nodeId, {
          nodeId,
          parentId,
          label: modulePath.at(-1) ?? "模块",
          nodeType: "module",
          path: [project, ...modulePath],
          modelingStatus: "partial",
          capabilities: [],
          elements: [],
          actions: [],
          assertions: [],
          sourceArtifacts: {},
          notes: []
        });
      }
      parentId = nodeId;
    }
    const pageNode = projectKnowledgeNodeFromModel(project, model, manual, parentId, pathParts);
    nodes.set(pageNode.nodeId, pageNode);
  }

  return {
    schemaVersion: "project-knowledge-map.v1",
    project,
    defaultProject: project === "demo",
    generatedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    source: {
      generator: "page-model-operation-manual-summary",
      refs: [
        ...(await fs.pathExists(pageModelPath) ? [path.relative(rootDir, pageModelPath).replace(/\\/g, "/")] : []),
        ...(await fs.pathExists(manualPath) ? [path.relative(rootDir, manualPath).replace(/\\/g, "/")] : [])
      ]
    },
    summary: summarizeProjectKnowledgeNodes([...nodes.values()]),
    nodes: [...nodes.values()]
  };
}

function projectKnowledgeNodeFromModel(
  project: string,
  model: Record<string, unknown>,
  manual: Record<string, unknown> | undefined,
  parentId: string,
  pathParts: string[]
): ProjectKnowledgeMapNode {
  const pageId = String(model.pageId ?? model.id ?? "");
  const manualSummary = manual?.pageSummary as Record<string, unknown> | undefined;
  const manualCapabilities = Array.isArray(manual?.capabilities) ? manual.capabilities as Array<Record<string, unknown>> : [];
  const modelCapabilities = Array.isArray(model.capabilities) ? model.capabilities as Array<Record<string, unknown>> : [];
  const elements = Array.isArray(model.elements) ? model.elements as Array<Record<string, unknown>> : [];
  const actions = Array.isArray(model.actions) ? model.actions as Array<Record<string, unknown>> : [];
  const assertions = Array.isArray(model.assertions) ? model.assertions as Array<Record<string, unknown>> : [];
  const status = String(model.status ?? "unknown");
  return {
    nodeId: `page.${pageId}`,
    parentId,
    label: String(model.pageName ?? manual?.pageName ?? pageId),
    nodeType: "page",
    path: [project, ...pathParts],
    modelingStatus: classifyProjectKnowledgeModelingStatus(status, elements, manualCapabilities),
    pageModelId: pageId,
    pageName: String(model.pageName ?? manual?.pageName ?? pageId),
    urlPattern: String((manual?.entry as Record<string, unknown> | undefined)?.urlPattern ?? model.urlPattern ?? model.url ?? ""),
    navigationPath: normalizeNavigationPath(manual?.entry, model),
    modeledAt: String(model.updatedAt ?? readObjectField(model.evidence, "observedAt") ?? model.sourceScanId ?? ""),
    description: String(manualSummary?.description ?? model.expectedCapability ?? model.pageType ?? ""),
    capabilities: [
      ...manualCapabilities.map((item) => String(item.capabilityId ?? item.name ?? item.flowId ?? "")).filter(Boolean),
      ...modelCapabilities.map((item) => String(item.capabilityId ?? item.name ?? item.semanticName ?? "")).filter(Boolean)
    ].slice(0, 16),
    elements: elements.slice(0, 80).map((item) => ({
      elementId: String(item.elementId ?? ""),
      name: String(item.semanticName ?? item.name ?? item.text ?? item.elementId ?? ""),
      type: String(item.controlType ?? item.role ?? item.semanticRole ?? ""),
      targetField: String(item.targetField ?? ""),
      status: String(item.status ?? "")
    })).filter((item) => item.name),
    actions: actions.slice(0, 40).map((item) => ({
      actionId: String(item.actionId ?? ""),
      name: String(item.semanticName ?? item.name ?? item.action ?? item.actionType ?? item.actionId ?? ""),
      type: String(item.actionType ?? item.action ?? ""),
      targetPageId: String(item.targetPageId ?? ""),
      status: String(item.status ?? "")
    })).filter((item) => item.name),
    assertions: assertions.slice(0, 30).map((item) => String(item.semanticName ?? item.assertionId ?? item.assertionKind ?? "")).filter(Boolean),
    sourceArtifacts: model.sourceArtifacts && typeof model.sourceArtifacts === "object" ? model.sourceArtifacts as Record<string, unknown> : {},
    notes: buildProjectKnowledgeNodeNotes(model, manual)
  };
}

function normalizeNavigationPath(entry: unknown, model: Record<string, unknown>): string[] {
  const entryObject = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
  const pageId = String(model.pageId ?? model.id ?? "");
  const pageName = String(model.pageName ?? "").trim();
  if (Array.isArray(entryObject.navigationPath)) {
    return normalizeProjectKnowledgeNavigationPath(String(model.project ?? ""), pageId, pageName, entryObject.navigationPath.map(String).filter(Boolean));
  }
  const howToReach = Array.isArray(model.howToReach) ? model.howToReach.map(String).filter(Boolean) : [];
  if (howToReach.length) return normalizeProjectKnowledgeNavigationPath(String(model.project ?? ""), pageId, pageName, howToReach);
  const module = String(model.module ?? "").trim();
  return normalizeProjectKnowledgeNavigationPath(String(model.project ?? ""), pageId, pageName, [module, pageName].filter(Boolean));
}

function normalizeProjectKnowledgeNavigationPath(project: string, pageId: string, pageName: string, pathParts: string[]): string[] {
  const normalized = pathParts.map((item) => String(item).trim()).filter(Boolean);
  const lowerId = pageId.toLowerCase();
  if (project === "demo" || pageId.startsWith("demo.")) {
    if (/earn\.product_center/.test(lowerId) || pageName === "更多-理财") return ["首页", "顶部导航", "更多", "理财"];
    if (/funds\.finance_account/.test(lowerId) || pageName === "资产中心-理财账户" || pageName === "理财账户") return ["首页", "顶部资产入口", "资产中心", "理财账户"];
  }
  return normalized;
}

function classifyProjectKnowledgeModelingStatus(status: string, elements: unknown[], capabilities: unknown[]): ProjectKnowledgeMapNode["modelingStatus"] {
  if (/deprecated|blocked/i.test(status)) return "partial";
  if (/execution_verified|click_observed|input_observed|dom_verified/i.test(status) && elements.length && capabilities.length) return "modeled";
  if (/dom_verified|screenshot_verified|click_observed|input_observed/i.test(status) || elements.length || capabilities.length) return "partial";
  return "unknown";
}

function buildProjectKnowledgeNodeNotes(model: Record<string, unknown>, manual: Record<string, unknown> | undefined): string[] {
  const notes: string[] = [];
  if (!manual) notes.push("缺少 Page Operation Manual，页面元素存在但业务说明不完整。");
  if (!Array.isArray(model.elements) || model.elements.length === 0) notes.push("缺少元素摘要，不能判断页面关键控件是否完整建模。");
  if (!Array.isArray(model.actions) || model.actions.length === 0) notes.push("缺少动作摘要，跳转和按钮行为覆盖可能不足。");
  return notes;
}

function readObjectField(value: unknown, key: string): unknown {
  return value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
}

function summarizeProjectKnowledgeNodes(nodes: ProjectKnowledgeMapNode[]): ProjectKnowledgeMapStoreData["summary"] {
  return {
    totalNodes: nodes.length,
    modeledNodes: nodes.filter((item) => item.modelingStatus === "modeled").length,
    partialNodes: nodes.filter((item) => item.modelingStatus === "partial").length,
    unmodeledNodes: nodes.filter((item) => item.modelingStatus === "unmodeled").length,
    staleNodes: nodes.filter((item) => item.modelingStatus === "stale").length
  };
}

function stableTextId(value: string): string {
  return crypto.createHash("sha1").update(value).digest("hex").slice(0, 12);
}

async function readAppArchiveHistory(project: string, env: string): Promise<AppArchiveHistory> {
  const historyPath = appArchiveHistoryPath(project, env);
  if (!(await fs.pathExists(historyPath))) {
    return { project, env, apps: [], explorations: [] };
  }
  return (await fs.readJson(historyPath)) as AppArchiveHistory;
}

async function writeAppArchiveHistory(history: AppArchiveHistory): Promise<void> {
  const historyPath = appArchiveHistoryPath(history.project, history.env);
  await writeSafeJsonFile(historyPath, history);
}

function appArchiveRoot(): string {
  return path.join(rootDir, "storage", "app-archives");
}

function appArchiveDir(project: string, env: string, date: string): string {
  return path.join(appArchiveRoot(), safePathSegment(project), safePathSegment(env), date);
}

function appArchiveHistoryPath(project: string, env: string): string {
  return path.join(appArchiveRoot(), safePathSegment(project), safePathSegment(env), "history.json");
}

function safeFileName(value: string): string {
  return path.basename(value).replace(/[^\w.-]+/g, "_");
}

function safePathSegment(value: string): string {
  return value.replace(/[^\w.-]+/g, "_");
}

async function listProjects(): Promise<
  Array<{
    key: string;
    name: string;
    defaultEnv: string;
    envs: Array<{ key: string; name: string; webBaseUrl?: string; spotAdminBaseUrl?: string }>;
  }>
> {
  const projectsDir = path.join(rootDir, "configs", "projects");
  const entries = await fs.readdir(projectsDir, { withFileTypes: true });
  const projects = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const configDir = path.join(projectsDir, entry.name);
        const projectConfig = YAML.parse(
          await fs.readFile(path.join(configDir, "project.config.yaml"), "utf8")
        ) as { projectKey?: string; projectName?: string; defaultEnv?: string };
        const envFiles = (await fs.readdir(configDir)).filter((file) => /^env\..+\.ya?ml$/i.test(file));
        const envs = await Promise.all(
          envFiles.map(async (file) => {
            const envConfig = YAML.parse(await fs.readFile(path.join(configDir, file), "utf8")) as {
              env?: string;
              displayName?: string;
              web?: {
                baseUrl?: string;
                spotAdminBaseUrl?: string;
                adminBaseUrl?: string;
              };
            };
            const key = envConfig.env ?? file.replace(/^env\./i, "").replace(/\.ya?ml$/i, "");
            return {
              key,
              name: envConfig.displayName ?? formatEnvName(key),
              webBaseUrl: envConfig.web?.baseUrl,
              spotAdminBaseUrl: envConfig.web?.spotAdminBaseUrl ?? envConfig.web?.adminBaseUrl
            };
          })
        );
        return {
          key: projectConfig.projectKey ?? entry.name,
          name: projectConfig.projectName ?? entry.name,
          defaultEnv: projectConfig.defaultEnv ?? envs[0]?.key ?? "test",
          envs: envs.sort((a, b) => envOrder(a.key) - envOrder(b.key) || a.name.localeCompare(b.name))
        };
      })
  );
  return projects.sort((a, b) => a.name.localeCompare(b.name));
}

function formatEnvName(env: string): string {
  if (env.toLowerCase() === "test") return "Test";
  if (env.toLowerCase() === "uat") return "UAT";
  return env;
}

function envOrder(env: string): number {
  const order: Record<string, number> = { test: 10, uat: 20, staging: 30, "prod.readonly": 40 };
  return order[env.toLowerCase()] ?? 100;
}

async function serveStatic(res: http.ServerResponse, requestPath: string): Promise<void> {
  const filePath = path.resolve(publicDir, `.${decodeURIComponent(requestPath)}`);
  if (!filePath.startsWith(publicDir) || !(await fs.pathExists(filePath))) {
    sendJson(res, 404, { error: "Not found" });
    return;
  }
  const ext = path.extname(filePath);
  const type = ext === ".js" ? "text/javascript" : ext === ".css" ? "text/css" : "text/html";
  // 本地开发工作台：禁用静态资源缓存，避免前端更新后浏览器继续用旧 JS。
  res.writeHead(200, { "content-type": `${type}; charset=utf-8`, "cache-control": "no-cache, no-store, must-revalidate" });
  res.end(await fs.readFile(filePath));
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const text = decodeOutput(Buffer.concat(chunks));
  const body = text ? JSON.parse(text) : {};
  assertCleanTextBoundary(body, req.url ?? "request-body");
  assertRequestTextNotLost(body, req.url ?? "request-body");
  return body;
}

function assertRequestTextNotLost(value: unknown, boundaryName: string): void {
  const issues: Array<{ path: string; valuePreview: string; reason: string; codePoints: string[] }> = [];
  collectQuestionLossIssues(value, "$", issues);
  if (issues.length) throw new EncodingBoundaryError(`Encoding boundary rejected question-mark-loss text at ${boundaryName}.`, issues);
}

function collectQuestionLossIssues(value: unknown, pathText: string, issues: Array<{ path: string; valuePreview: string; reason: string; codePoints: string[] }>): void {
  if (issues.length >= 10) return;
  if (typeof value === "string") {
    if (isNaturalLanguageRequestPath(pathText) && /\?{4,}/.test(value)) {
      issues.push({ path: pathText, valuePreview: value.slice(0, 160), reason: "question-mark-loss", codePoints: [...value.slice(0, 80)].map((char) => char.codePointAt(0)?.toString(16) ?? "") });
    }
    return;
  }
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectQuestionLossIssues(item, `${pathText}[${index}]`, issues));
    return;
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) collectQuestionLossIssues(item, `${pathText}.${key}`, issues);
}

function isNaturalLanguageRequestPath(pathText: string): boolean {
  return /\.(message|intent|rawRequest|user_message|detail|reason|target)$/i.test(pathText);
}

function runCommand(command: string, args: string[]): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    logger.info("Command started", { command, args });
    const child = spawn(command, args, { cwd: rootDir, shell: process.platform === "win32" });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => (stdout += decodeOutput(data)));
    child.stderr.on("data", (data) => (stderr += decodeOutput(data)));
    child.on("close", (exitCode) => {
      logger.info("Command finished", { command, args, exitCode, stdoutBytes: stdout.length, stderrBytes: stderr.length });
      resolve({ exitCode, stdout, stderr });
    });
  });
}

function runManagedWebExplore(
  command: string,
  args: string[]
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    if (runningWebExplore) {
      resolve({ exitCode: 1, stdout: "", stderr: "A web exploration task is already running." });
      return;
    }
    logger.info("Managed web exploration started", { command, args });
    const child = spawn(command, args, { cwd: rootDir, shell: process.platform === "win32" });
    runningWebExplore = {
      child,
      startedAt: new Date().toISOString(),
      command: [command, ...args].join(" ")
    };
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => {
      const text = decodeOutput(data);
      stdout += text;
      logger.info("Web exploration stdout", { text: text.trim().slice(0, 1000) });
    });
    child.stderr.on("data", (data) => {
      const text = decodeOutput(data);
      stderr += text;
      logger.warn("Web exploration stderr", { text: text.trim().slice(0, 1000) });
    });
    child.on("close", (exitCode) => {
      logger.info("Managed web exploration finished", { exitCode, stdoutBytes: stdout.length, stderrBytes: stderr.length });
      runningWebExplore = undefined;
      resolve({ exitCode, stdout, stderr });
    });
  });
}

function stopChildTree(child: ChildProcessWithoutNullStreams): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { shell: true });
    return;
  }
  child.kill("SIGTERM");
}

function decodeOutput(data: Buffer): string {
  const utf8 = new TextDecoder("utf-8", { fatal: false }).decode(data);
  if (!/[\uFFFD]|[\u00c0-\u00ff]{2,}/.test(utf8)) return utf8;
  try {
    return new TextDecoder("gb18030", { fatal: false }).decode(data);
  } catch {
    return utf8;
  }
}

async function readRecentLogs(input: { limit: number; level?: string; query?: string }): Promise<unknown[]> {
  const logDir = path.join(rootDir, "artifacts", "logs");
  if (!(await fs.pathExists(logDir))) return [];
  const files = (await fs.readdir(logDir))
    .filter((file) => /^workbench-\d{4}-\d{2}-\d{2}\.jsonl$/.test(file))
    .sort()
    .reverse()
    .slice(0, 7);
  const rows: unknown[] = [];
  for (const file of files) {
    const text = await fs.readFile(path.join(logDir, file), "utf8").catch(() => "");
    for (const line of text.split(/\r?\n/).filter(Boolean).reverse()) {
      try {
        const record = JSON.parse(line) as { level?: string; message?: string; meta?: unknown };
        const haystack = JSON.stringify(record).toLowerCase();
        if (input.level && record.level !== input.level) continue;
        if (input.query && !haystack.includes(input.query.toLowerCase())) continue;
        rows.push(record);
        if (rows.length >= input.limit) return rows;
      } catch {
        continue;
      }
    }
  }
  return rows;
}

function required(value: unknown, name: string): string {
  if (!value) throw new Error(`${name} is required`);
  return String(value);
}

function sendJson(res: http.ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value, null, 2));
}

function pageModelAutomationTraceSteps(plan: Record<string, unknown>): Array<Record<string, string>> {
  const automationCase = plan.automationCase && typeof plan.automationCase === "object"
    ? plan.automationCase as Record<string, unknown>
    : {};
  const steps = Array.isArray(automationCase.steps) ? automationCase.steps : [];
  return steps.map((raw, index) => {
    const step = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    const action = String(step.action ?? "unknown");
    return {
      step: action === "assert" ? readablePageModelAssertionTraceStep(step, index) : `Step ${index + 1}: ${action}`,
      status: "completed",
      detail: [
        step.semanticTarget ? String(step.semanticTarget) : undefined,
        step.value !== undefined ? `value=${displayTraceValue(step.value)}` : undefined,
        step.pageModelId ? `pageModelId=${String(step.pageModelId)}` : undefined,
        step.elementId ? `elementId=${String(step.elementId)}` : undefined,
        step.assertionId ? `assertionId=${String(step.assertionId)}` : undefined,
        traceComponentDetail(step),
        tracePostconditionDetail(step)
      ].filter(Boolean).join(" | ")
    };
  });
}

function traceComponentDetail(step: Record<string, unknown>): string | undefined {
  const component = step.component && typeof step.component === "object" ? step.component as Record<string, unknown> : undefined;
  if (!component) return undefined;
  return [
    component.type ? `component=${String(component.type)}` : undefined,
    component.targetField ? `field=${String(component.targetField)}` : undefined,
    component.optionDiscoveryMode ? `optionDiscovery=${String(component.optionDiscoveryMode)}` : undefined
  ].filter(Boolean).join(",");
}

function tracePostconditionDetail(step: Record<string, unknown>): string | undefined {
  const postconditions = Array.isArray(step.postconditions) ? step.postconditions : [];
  if (!postconditions.length) return undefined;
  return `postconditions=${postconditions.length}`;
}

function readablePageModelAssertionTraceStep(step: Record<string, unknown>, index: number): string {
  const assertion = step.assertion && typeof step.assertion === "object" ? step.assertion as Record<string, unknown> : {};
  const intent = assertion.intent && typeof assertion.intent === "object" ? assertion.intent as Record<string, unknown> : {};
  const column = assertion.column ?? intent.field;
  const expected = assertion.expected ?? intent.expected;
  if (column && expected !== undefined) return `步骤 ${index + 1} 断言：${String(column)}列仅返回 ${displayTraceValue(expected)}`;
  if (assertion.emptyStateAccepted) return `步骤 ${index + 1} 断言：列表为空或符合预期`;
  return `步骤 ${index + 1} 断言`;
}

function displayTraceValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(String).join(" / ");
  if (value && typeof value === "object") return JSON.stringify(value);
  return String(value);
}
