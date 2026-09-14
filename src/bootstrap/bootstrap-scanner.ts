import crypto from "node:crypto";
import path from "node:path";
import fs from "fs-extra";
import type {
  AutomationCase,
  BootstrapInteractiveElement,
  BootstrapReviewPackage,
  BootstrapScanElement,
  BootstrapScanPage,
  BootstrapScanPath,
  BootstrapScanRun,
  DslStep,
  LoadedContext,
  Platform
} from "../core/types.js";
import type { DriverAdapter } from "../core/driver-adapter.js";
import { WebDriverAdapter } from "../drivers/web-driver-adapter.js";
import { MobileDriverAdapter } from "../drivers/mobile-driver-adapter.js";
import { BootstrapScanStore, bootstrapId } from "../memory/bootstrap-scan-store.js";
import { logger } from "../core/logger.js";
import { AccountStore } from "../memory/account-store.js";
import { EnvironmentDiscoveryStore } from "../memory/environment-discovery-store.js";
import { writeSafeJsonFile, writeSafeTextFile } from "../core/safe-file-writer.js";
import {
  classifyBootstrapRisk,
  expandTargetFlowTerms,
  inferSemanticElement,
  inferSemanticPage,
  suggestAssertions
} from "./bootstrap-intelligence.js";

export interface BootstrapScanOptions {
  projectId: string;
  platform: Platform;
  env: string;
  startUrl?: string;
  startActivity?: string;
  appiumServerUrl?: string;
  appiumSessionId?: string;
  targetFlows: string[];
  maxPages: number;
  maxDepth: number;
  maxPaths: number;
  maxDurationMs?: number;
  allowedDomains: string[];
  deniedPatterns: string[];
  deniedActions: string[];
  maxAiCalls?: number;
  maxAiTokens?: number;
  dryRunOnly: boolean;
  requireHumanApprovalBeforeSubmit: boolean;
  headed: boolean;
  loginRequired?: boolean;
  username?: string;
  password?: string;
}

export class BootstrapScanner {
  private readonly store: BootstrapScanStore;

  constructor(private readonly context: LoadedContext) {
    this.store = new BootstrapScanStore(context);
  }

  async scan(options: BootstrapScanOptions): Promise<{
    run: BootstrapScanRun;
    reviewPackage: BootstrapReviewPackage;
    storagePath: string;
  }> {
    const startedAt = Date.now();
    const scanId = crypto.randomUUID();
    const run: BootstrapScanRun = {
      scan_id: scanId,
      project_id: this.context.project.projectKey,
      platform: options.platform,
      env: this.context.env.env,
      start_url: options.startUrl,
      start_activity: options.startActivity,
      target_flows: options.targetFlows,
      mode: "bootstrap_scan",
      status: "running",
      max_pages: options.maxPages,
      max_depth: options.maxDepth,
      max_paths: options.maxPaths,
      max_duration_ms: options.maxDurationMs,
      visited_pages: 0,
      generated_paths: 0,
      generated_elements: 0,
      generated_dsl_cases: 0,
      ai_invocation_count: 0,
      token_input_total: 0,
      token_output_total: 0,
      estimated_cost: 0,
      safety_config: {
        allowed_domains: options.allowedDomains,
        denied_patterns: options.deniedPatterns,
        denied_actions: options.deniedActions,
        dry_run_only: options.dryRunOnly,
        require_human_approval_before_submit: options.requireHumanApprovalBeforeSubmit,
        max_ai_calls: options.maxAiCalls,
        max_ai_tokens: options.maxAiTokens
      },
      target_flow_coverage: options.targetFlows.map((flow) => ({
        flow,
        matched_pages: 0,
        matched_paths: 0,
        matched_elements: 0
      })),
      blocked_actions: [],
      started_at: new Date().toISOString(),
      review_status: "pending",
      promote_status: "pending"
    };
    await this.store.upsertRun(run);
    logger.info("Bootstrap scan started", {
      scanId,
      project: options.projectId,
      env: options.env,
      platform: options.platform,
      startUrl: options.startUrl,
      maxPages: options.maxPages,
      maxDepth: options.maxDepth
    });

    let driver: DriverAdapter | undefined;
    try {
      driver = await this.createDriver(options);
      if (options.platform === "web" && options.startUrl && "navigate" in driver) {
        await (driver as WebDriverAdapter).navigate(options.startUrl);
      }
      const visited = new Set<string>();
      const queuedUrls = new Set<string>();
      await driver.dismissSystemOverlays?.().catch(() => undefined);
      await driver.switchToWebView?.().catch(() => undefined);
      const queue: Array<{ url?: string; depth: number; fromPage?: BootstrapScanPage; trigger?: BootstrapInteractiveElement }> = [
        { url: options.startUrl, depth: 0 }
      ];
      if (options.startUrl) queuedUrls.add(normalizeQueueUrl(options.startUrl));
      const deadline = options.maxDurationMs ? startedAt + options.maxDurationMs : Number.POSITIVE_INFINITY;
      while (queue.length && run.visited_pages < options.maxPages && Date.now() < deadline) {
        const current = queue.shift()!;
        if (current.url && options.platform === "web" && "navigate" in driver) {
          if (!isAllowedUrl(current.url, options)) continue;
          await (driver as WebDriverAdapter).navigate(current.url).catch((error) => {
            logger.warn("Bootstrap scan navigation failed", { url: current.url, error: error instanceof Error ? error.message : String(error) });
          });
        }
        const state = await driver.getCurrentPageState();
        const key = normalizeQueueUrl(state.url_pattern ?? state.activity_name ?? state.route_name ?? state.page_id);
        if (visited.has(key)) continue;
        visited.add(key);

        await driver.dismissSystemOverlays?.().catch(() => undefined);
        await driver.switchToWebView?.().catch(() => undefined);
        const page = await this.capturePage(scanId, driver, state.page_id);
        await this.store.appendPage(page);
        run.visited_pages += 1;

        for (const element of this.buildElements(scanId, page)) {
          await this.store.appendElement(element);
          run.generated_elements += 1;
        }
        run.target_flow_coverage = updateCoverage(run.target_flow_coverage ?? [], page);

        if (current.fromPage && current.trigger && run.generated_paths < options.maxPaths) {
          const scanPath = this.buildPath(scanId, current.fromPage, page, current.trigger, options);
          await this.store.appendPath(scanPath);
          await this.store.appendDslCase(this.buildDslCase(scanId, scanPath));
          run.generated_paths += 1;
          run.generated_dsl_cases += 1;
          run.target_flow_coverage = updateCoverageForPath(run.target_flow_coverage ?? [], scanPath);
        }

        if (current.depth < options.maxDepth) {
          run.blocked_actions = [
            ...(run.blocked_actions ?? []),
            ...blockedCandidates(page, options).map((item) => ({
              text: [item.text, item.ariaLabel, item.placeholder, item.href, item.selector].filter(Boolean).join(" ").slice(0, 160),
              selector: item.selector,
              reason: classifyBootstrapRisk([item.text, item.ariaLabel, item.placeholder, item.href, item.selector].filter(Boolean).join(" ")) === "high" ? "high_risk" : "requires_human_approval"
            }))
          ].slice(-200);
          for (const next of this.nextCandidates(page, options)) {
            if (queue.length + run.generated_paths >= options.maxPaths) break;
            const nextUrlKey = next.href ? normalizeQueueUrl(next.href) : "";
            if (next.href && !visited.has(nextUrlKey) && !queuedUrls.has(nextUrlKey)) {
              queuedUrls.add(nextUrlKey);
              queue.push({ url: next.href, depth: current.depth + 1, fromPage: page, trigger: next });
            }
            else if (!next.href && !options.dryRunOnly && next.selector && isSafeAction(next, options)) {
              await driver.click(next.selector).catch((error) => {
                logger.warn("Bootstrap scan click candidate failed", {
                  selector: next.selector,
                  text: next.text,
                  error: error instanceof Error ? error.message : String(error)
                });
              });
              await driver.dismissSystemOverlays?.().catch(() => undefined);
              await driver.switchToWebView?.().catch(() => undefined);
              queue.push({ depth: current.depth + 1, fromPage: page, trigger: next });
            } else if (!next.href && run.generated_paths < options.maxPaths) {
              const candidatePath = this.buildPath(scanId, page, page, next, options);
              await this.store.appendPath(candidatePath);
              await this.store.appendDslCase(this.buildDslCase(scanId, candidatePath));
              run.generated_paths += 1;
              run.generated_dsl_cases += 1;
              run.target_flow_coverage = updateCoverageForPath(run.target_flow_coverage ?? [], candidatePath);
            }
          }
        }
        await this.store.upsertRun(run);
      }
      run.status = Date.now() >= deadline ? "partial" : "completed";
      run.summary = `Visited ${run.visited_pages} pages, generated ${run.generated_paths} paths, ${run.generated_elements} elements, ${run.generated_dsl_cases} DSL drafts.`;
    } catch (error) {
      run.status = run.visited_pages > 0 ? "partial" : "failed";
      run.summary = error instanceof Error ? error.message : String(error);
    } finally {
      await driver?.close().catch(() => undefined);
      run.ended_at = new Date().toISOString();
      await this.store.upsertRun(run);
    }

    const reviewPackage = await this.writeReviewPackage(run.scan_id);
    run.review_package_id = reviewPackage.package_id;
    await this.store.upsertRun(run);
    const storagePath = await this.store.save(await this.store.load());
    return { run, reviewPackage, storagePath };
  }

  async replay(scanId: string): Promise<{ passed: number; failed: number; total: number }> {
    return this.store.replay(scanId);
  }

  async promote(scanId: string): Promise<{ pages: number; paths: number; elements: number; dslCases: number; files: string[] }> {
    return this.store.promote(scanId);
  }

  async importCodexReviewResult(input: { scanId: string; rawText: string; filePath?: string }): Promise<{ imported: boolean; updated: number }> {
    return this.store.importReviewResult(input);
  }

  async preflight(options: BootstrapScanOptions): Promise<{
    ok: boolean;
    checks: Array<{ name: string; status: "passed" | "warning" | "failed"; message: string }>;
    recommendedCommand: string;
  }> {
    const checks: Array<{ name: string; status: "passed" | "warning" | "failed"; message: string }> = [];
    if (options.platform === "web") {
      if (!options.startUrl) checks.push({ name: "entry", status: "failed", message: "Web bootstrap_scan requires startUrl." });
      else checks.push({ name: "entry", status: "passed", message: options.startUrl });
      if (options.startUrl && /^https?:\/\//i.test(options.startUrl)) {
        const hostname = new URL(options.startUrl).hostname;
        if (options.allowedDomains.length && !options.allowedDomains.includes(hostname)) {
          checks.push({ name: "allowedDomains", status: "warning", message: `Entry domain ${hostname} is not explicitly listed.` });
        } else {
          checks.push({ name: "allowedDomains", status: "passed", message: hostname });
        }
      }
    }
    if (options.platform !== "web") {
      checks.push({
        name: "appium",
        status: options.appiumServerUrl && options.appiumSessionId ? "passed" : "failed",
        message: options.appiumServerUrl && options.appiumSessionId ? "Appium session configured." : "App bootstrap_scan requires appium server url and session id."
      });
    }
    const accounts = await new AccountStore(this.context).list({ project: this.context.project.projectKey, env: this.context.env.env }).catch(() => []);
    checks.push({
      name: "accounts",
      status: accounts.length ? "passed" : "warning",
      message: accounts.length ? `${accounts.length} saved account(s) for ${this.context.project.projectKey}/${this.context.env.env}.` : "No saved account for current project/env."
    });
    const discovery = await new EnvironmentDiscoveryStore(this.context).load().catch(() => undefined);
    checks.push({
      name: "environmentDiscovery",
      status: discovery?.domains?.length || discovery?.apiEndpoints?.length ? "passed" : "warning",
      message: discovery ? `${discovery.domains.length} domain(s), ${discovery.apiEndpoints.length} api endpoint(s).` : "No environment discovery data."
    });
    if (options.platform === "web" && options.loginRequired) {
      checks.push({
        name: "bypassLogin",
        status: discovery?.bypassLogin?.enabled && this.context.env.api?.baseUrl && (options.username || accounts.length) ? "passed" : "warning",
        message:
          discovery?.bypassLogin?.enabled && this.context.env.api?.baseUrl
            ? `Bypass login configured; ${options.username ? "selected account provided" : `${accounts.length} saved account(s) available`}.`
            : "Login is required but bypass login is not fully configured."
      });
    }
    checks.push({
      name: "targetFlows",
      status: options.targetFlows.length ? "passed" : "warning",
      message: options.targetFlows.length ? options.targetFlows.join(", ") : "No target flow specified; scan will be less focused."
    });
    checks.push({
      name: "safety",
      status: options.dryRunOnly ? "passed" : "warning",
      message: options.dryRunOnly ? "dry_run_only enabled." : "Safe click actions are allowed; confirm denied actions before scanning."
    });
    if (!options.deniedActions.length) checks.push({ name: "deniedActions", status: "warning", message: "No denied actions configured." });
    else checks.push({ name: "deniedActions", status: "passed", message: options.deniedActions.join(", ") });
    const ok = checks.every((item) => item.status !== "failed");
    return {
      ok,
      checks,
      recommendedCommand: buildRecommendedCommand(this.context.project.projectKey, this.context.env.env, options)
    };
  }

  private async createDriver(options: BootstrapScanOptions): Promise<DriverAdapter> {
    if (options.platform === "web") {
      const auth = await this.buildWebAuth(options);
      return WebDriverAdapter.launch(this.context, options.headed, auth);
    }
    if (!options.appiumServerUrl || !options.appiumSessionId) {
      throw new Error("App bootstrap_scan requires --appium-server-url and --appium-session-id.");
    }
    return new MobileDriverAdapter({
      serverUrl: options.appiumServerUrl,
      sessionId: options.appiumSessionId,
      projectId: this.context.project.projectKey,
      platform: options.platform
    });
  }

  private async buildWebAuth(options: BootstrapScanOptions): Promise<Parameters<typeof WebDriverAdapter.launch>[2]> {
    if (!options.loginRequired) return undefined;
    const discovery = await new EnvironmentDiscoveryStore(this.context).load();
    const bypass = discovery.bypassLogin;
    if (!bypass?.enabled) {
      logger.warn("Bootstrap scan login requested but bypass login is not enabled.");
      return undefined;
    }
    if (!this.context.env.api?.baseUrl) throw new Error("Bootstrap bypass login requires env.api.baseUrl.");
    const accounts = await new AccountStore(this.context).list({
      project: this.context.project.projectKey,
      env: this.context.env.env
    });
    const attempts = [
      ...(options.username && options.password ? [{ username: options.username, password: options.password, source: "selected" }] : []),
      ...accounts
        .filter((account) => account.username !== options.username)
        .sort((a, b) => accountScore(b) - accountScore(a))
        .map((account) => ({ username: account.username, password: account.password, source: account.label ? `saved:${account.label}` : "saved" }))
    ];
    if (!attempts.length) throw new Error("Bootstrap scan login is required, but no username/password or saved account is available.");
    const failures: string[] = [];
    for (const attempt of attempts) {
      const result = await requestBypassToken({
        username: attempt.username,
        password: attempt.password,
        bypass,
        apiBaseUrl: this.context.env.api.baseUrl
      });
      if (result.token) {
        logger.info("Bootstrap bypass login succeeded", {
          username: attempt.username,
          source: attempt.source,
          loginUrl: result.loginUrl,
          headerName: bypass.tokenHeaderName
        });
        return {
          extraHTTPHeaders: { [bypass.tokenHeaderName]: String(result.token) },
          authToken: {
            token: String(result.token),
            originUrl: options.startUrl ?? this.context.env.web?.baseUrl ?? this.context.env.api.baseUrl,
            headerName: bypass.tokenHeaderName,
            storageKeys: discovery.authInjection?.storageKeys,
            cookieNames: discovery.authInjection?.cookieNames
          }
        };
      }
      failures.push(`${attempt.username}: ${result.status} ${JSON.stringify(result.body)}`);
    }
    throw new Error(["Bootstrap bypass login failed for all available accounts.", ...failures].join("\n"));
  }

  private async capturePage(scanId: string, driver: DriverAdapter, pageStateId: string): Promise<BootstrapScanPage> {
    const artifactDir = path.join(this.context.rootDir, this.context.workspace.artifactRoot, "bootstrap-scans", scanId);
    await fs.ensureDir(artifactDir);
    const state = await driver.getCurrentPageState();
    const urlOrActivity = await driver.getCurrentUrlOrActivity();
    const pageSignature = bootstrapId([state.url_pattern, state.activity_name, state.dom_signature, state.page_source_signature, urlOrActivity]);
    const screenshotPath = path.join(artifactDir, `${pageSignature}.png`);
    const domPath = path.join(artifactDir, `${pageSignature}.source.txt`);
    const accessibilityPath = path.join(artifactDir, `${pageSignature}.accessibility.json`);
    await driver.takeScreenshot(screenshotPath).catch(() => undefined);
    const dom = await driver.getDomOrPageSource().catch(() => "");
    await writeSafeTextFile(domPath, dom);
    await writeSafeJsonFile(accessibilityPath, await driver.getAccessibilityTree().catch(() => ({})));
    const interactive = ((await driver.getInteractiveElements?.()) ?? []).slice(0, 500);
    const semantic = inferSemanticPage({ title: state.title, urlOrActivity, elements: interactive });
    return {
      scan_page_id: bootstrapId([scanId, pageSignature, pageStateId]),
      scan_id: scanId,
      page_signature: pageSignature,
      url_or_activity: urlOrActivity,
      title: state.title,
      screenshot_path: screenshotPath,
      dom_or_page_source_path: domPath,
      accessibility_tree_path: accessibilityPath,
      interactive_elements: interactive,
      detected_semantic_page_name: semantic.name,
      detected_page_type: semantic.type,
      suggested_assertions: semantic.assertions,
      candidate_page_state: {
        ...state,
        page_name: state.page_name ?? semantic.name,
        known_elements: [...new Set([...state.known_elements, ...interactive.map((item) => item.selector ?? item.text ?? "").filter(Boolean)])],
        confidence_score: Math.max(state.confidence_score ?? 0.5, semantic.confidence)
      },
      confidence_score: semantic.confidence,
      review_status: "pending"
    };
  }

  private buildElements(scanId: string, page: BootstrapScanPage): BootstrapScanElement[] {
    return page.interactive_elements
      .filter((item) => item.selector || item.text || item.placeholder || item.ariaLabel)
      .map((item) => {
        const semantic = inferSemanticElement(item, page);
        const semanticName = semantic.name;
        return {
          scan_element_id: bootstrapId([scanId, page.scan_page_id, semanticName, item.selector]),
          scan_id: scanId,
          scan_page_id: page.scan_page_id,
          semantic_name: semanticName,
          semantic_role: semantic.role,
          element_type: item.elementType ?? "unknown",
          primary_locator: item.selector,
          fallback_locators: fallbackLocators(item),
          text_candidates: [item.text, item.placeholder, item.ariaLabel, item.name, item.id].filter(Boolean) as string[],
          nearby_texts: [page.title, page.detected_semantic_page_name].filter(Boolean) as string[],
          bounding_box: item.boundingBox,
          visual_signature: page.screenshot_path,
          confidence_score: Math.max(item.selector ? 0.75 : 0.55, semantic.confidence),
          review_status: "pending"
        };
      });
  }

  private buildPath(
    scanId: string,
    from: BootstrapScanPage,
    to: BootstrapScanPage,
    trigger: BootstrapInteractiveElement,
    options: BootstrapScanOptions
  ): BootstrapScanPath {
    const steps = this.stepsFromTrigger(trigger, to);
    const targetFlowScore = scoreCandidate(trigger, options.targetFlows.join(" "));
    const assertions = suggestAssertions({
      title: to.title,
      urlOrActivity: to.url_or_activity,
      pageType: to.detected_page_type,
      elements: to.interactive_elements
    });
    return {
      scan_path_id: bootstrapId([scanId, from.scan_page_id, to.scan_page_id, trigger.selector, trigger.text]),
      scan_id: scanId,
      from_scan_page_id: from.scan_page_id,
      to_scan_page_id: to.scan_page_id,
      action_description: `${trigger.href ? "navigate" : "click"}:${semanticNameOf(trigger)}`,
      trigger_element: trigger,
      candidate_transition: {
        transition_id: bootstrapId([from.candidate_page_state.page_id, to.candidate_page_state.page_id, trigger.selector, trigger.href]),
        from_page_id: from.candidate_page_state.page_id,
        to_page_id: to.candidate_page_state.page_id,
        action_description: `${trigger.href ? "navigate" : "click"}:${semanticNameOf(trigger)}`,
        trigger_element_id: undefined,
        dsl_steps: steps,
        success_count: 0,
        failure_count: 0,
        average_duration_ms: 0,
        confidence_score: 0.6
      },
      candidate_dsl_steps: steps,
      suggested_assertions: assertions,
      replay_status: "pending",
      target_flow_score: targetFlowScore,
      confidence_score: Math.min(0.95, (trigger.selector || trigger.href ? 0.7 : 0.45) + Math.min(0.2, targetFlowScore / 200)),
      review_status: "pending"
    };
  }

  private buildDslCase(scanId: string, scanPath: BootstrapScanPath): AutomationCase {
    return {
      id: `bootstrap_${scanId.slice(0, 8)}_${scanPath.scan_path_id}`,
      title: `Bootstrap path: ${scanPath.action_description}`,
      type: "web",
      project: this.context.project.projectKey,
      module: "bootstrap",
      priority: "P2",
      tags: ["bootstrap_scan", ...scanPath.action_description.split(/[:\s]+/).filter(Boolean).slice(0, 3), ...(scanPath.target_flow_score ? ["target_flow_hit"] : [])],
      owner: "qa",
      env: [this.context.env.env],
      automationCandidate: true,
      suggestedLayer: "web",
      steps: scanPath.candidate_dsl_steps,
      assertions: scanPath.suggested_assertions?.length ? scanPath.suggested_assertions : [{ type: "urlContains", expected: "" }]
    };
  }

  private stepsFromTrigger(trigger: BootstrapInteractiveElement, to: BootstrapScanPage): DslStep[] {
    const target = semanticNameOf(trigger);
    if (trigger.href) {
      return [
        {
          action: "navigate",
          semantic_target: target,
          target: trigger.href,
          primary_locator: trigger.href,
          allow_healing: false,
          collect_snapshot: true,
          timeout_ms: 15_000,
          retry_count: 1,
          expected_page_after_action: to.detected_semantic_page_name
        }
      ];
    }
    return [
      {
        action: trigger.elementType === "input" ? "input" : "click",
        semantic_target: target,
        primary_locator: trigger.selector,
        fallback_locators: fallbackLocators(trigger),
        allow_healing: true,
        max_healing_level: 3,
        collect_snapshot: true,
        timeout_ms: 8_000,
        retry_count: 1,
        expected_page_after_action: to.detected_semantic_page_name,
        assertion: to.suggested_assertions?.[0] ?? { type: "urlContains", expected: "" }
      }
    ];
  }

  private nextCandidates(page: BootstrapScanPage, options: BootstrapScanOptions): BootstrapInteractiveElement[] {
    const flowText = options.targetFlows.join(" ");
    const candidates = page.interactive_elements
      .filter((item) => item.href || item.selector)
      .filter((item) => isVisibleCandidate(item))
      .filter((item) => !isNoiseCandidate(item))
      .filter((item) => isSafeAction(item, options))
      .sort((a, b) => scoreCandidate(b, flowText) - scoreCandidate(a, flowText));
    if (!options.targetFlows.length) return candidates.slice(0, Math.max(1, options.maxPaths));
    const matched = candidates.filter((item) => scoreCandidate(item, flowText) > 15);
    const fallback = candidates.filter((item) => scoreCandidate(item, flowText) <= 15);
    return [...matched, ...fallback].slice(0, Math.max(1, options.maxPaths));
  }

  private async writeReviewPackage(scanId: string): Promise<BootstrapReviewPackage> {
    const data = await this.store.load();
    const pages = data.pages.filter((item) => item.scan_id === scanId);
    const paths = data.paths.filter((item) => item.scan_id === scanId);
    const elements = data.elements.filter((item) => item.scan_id === scanId);
    const dslCases = data.dslCases.filter((item) => item.id.includes(scanId.slice(0, 8)));
    const reviewDir = path.join(this.context.rootDir, this.context.workspace.artifactRoot, "bootstrap-review-packages", scanId);
    await fs.ensureDir(reviewDir);
    const packagePath = path.join(reviewDir, "review-package.json");
    const promptPath = path.join(reviewDir, "prompt.md");
    const payload = {
      scan_id: scanId,
      project: this.context.project.projectKey,
      env: this.context.env.env,
      summary: {
        pages: pages.length,
        paths: paths.length,
        elements: elements.length,
        dsl_cases: dslCases.length,
        failed_paths: paths.filter((item) => item.replay_status === "failed").length,
        target_flows: data.runs.find((item) => item.scan_id === scanId)?.target_flows ?? [],
        target_flow_coverage: data.runs.find((item) => item.scan_id === scanId)?.target_flow_coverage ?? [],
        safety_config: data.runs.find((item) => item.scan_id === scanId)?.safety_config,
        blocked_actions: data.runs.find((item) => item.scan_id === scanId)?.blocked_actions ?? [],
      page_types: pages.reduce<Record<string, number>>((summary, page) => {
        const key = page.detected_page_type ?? "unknown";
        summary[key] = (summary[key] ?? 0) + 1;
        return summary;
      }, {})
      },
      pages,
      paths,
      elements,
      dsl_cases: dslCases
    };
    await writeSafeJsonFile(packagePath, payload);
    await writeSafeTextFile(promptPath, buildReviewPrompt(payload));
    const reviewPackage: BootstrapReviewPackage = {
      package_id: crypto.randomUUID(),
      scan_id: scanId,
      package_path: packagePath,
      prompt_md_path: promptPath,
      screenshots: pages.map((item) => item.screenshot_path).filter(Boolean) as string[],
      dom_snapshots: pages.map((item) => item.dom_or_page_source_path).filter(Boolean) as string[],
      candidate_assets: {
        pages: pages.length,
        paths: paths.length,
        elements: elements.length,
        dsl_cases: dslCases.length
      },
      generated_at: new Date().toISOString(),
      imported: false
    };
    await this.store.appendReviewPackage(reviewPackage);
    return reviewPackage;
  }
}

function semanticNameOf(item: BootstrapInteractiveElement): string {
  const value = item.text || item.ariaLabel || item.placeholder || item.name || item.id || item.href || item.selector || "unknown element";
  const suffix = item.elementType && item.elementType !== "unknown" ? item.elementType : "element";
  return `${value}`.trim().slice(0, 80) || suffix;
}

function fallbackLocators(item: BootstrapInteractiveElement): string[] {
  const locators = [item.selector];
  if (item.text) locators.push(`text=${item.text}`);
  if (item.ariaLabel) locators.push(`[aria-label*="${escapeCss(item.ariaLabel)}"]`);
  if (item.placeholder) locators.push(`${item.tag ?? "input"}[placeholder*="${escapeCss(item.placeholder)}"]`);
  if (item.id) locators.push(`#${escapeCss(item.id)}`);
  return [...new Set(locators.filter(Boolean) as string[])];
}

function detectPageName(title: string | undefined, urlOrActivity: string, elements: BootstrapInteractiveElement[]): string {
  if (title?.trim()) return title.trim();
  const strongText = elements.find((item) => item.text && item.text.length > 1 && item.text.length < 40)?.text;
  if (strongText) return strongText;
  try {
    const parsed = new URL(urlOrActivity);
    return parsed.pathname === "/" ? parsed.hostname : parsed.pathname;
  } catch {
    return urlOrActivity || "unknown page";
  }
}

function isAllowedUrl(url: string, options: BootstrapScanOptions): boolean {
  try {
    const parsed = new URL(url);
    if (options.allowedDomains.length && !options.allowedDomains.some((domain) => parsed.hostname === domain || parsed.hostname.endsWith(`.${domain}`))) return false;
    return !options.deniedPatterns.some((pattern) => new RegExp(pattern, "i").test(url));
  } catch {
    return false;
  }
}

function normalizeQueueUrl(value: string): string {
  try {
    const parsed = new URL(value);
    parsed.hash = "";
    const keepSearch = parsed.searchParams.toString();
    parsed.search = keepSearch ? `?${keepSearch}` : "";
    parsed.pathname = parsed.pathname
      .replace(/\/(?:spot|futures)\/[A-Z0-9]+_[A-Z0-9]+(?=\/|$)/gi, (match) => match.replace(/\/[^/]+$/, "/:symbol_pair"))
      .replace(/\/+$/, "") || "/";
    return parsed.toString();
  } catch {
    return value.replace(/[?#].*$/, "").replace(/\/+$/, "");
  }
}

function isSafeAction(item: BootstrapInteractiveElement, options: BootstrapScanOptions): boolean {
  const text = [item.text, item.ariaLabel, item.placeholder, item.href, item.selector].filter(Boolean).join(" ");
  if (options.deniedActions.some((pattern) => new RegExp(pattern, "i").test(text))) return false;
  if (item.riskLevel === "high" || classifyBootstrapRisk(text) === "high") return false;
  if (options.requireHumanApprovalBeforeSubmit && classifyBootstrapRisk(text) !== "low") return false;
  return true;
}

function blockedCandidates(page: BootstrapScanPage, options: BootstrapScanOptions): BootstrapInteractiveElement[] {
  return page.interactive_elements
    .filter((item) => item.href || item.selector)
    .filter((item) => isVisibleCandidate(item))
    .filter((item) => !isSafeAction(item, options))
    .slice(0, 50);
}

function isVisibleCandidate(item: BootstrapInteractiveElement): boolean {
  if (!item.boundingBox) return true;
  return item.boundingBox.width > 4 && item.boundingBox.height > 4;
}

function isNoiseCandidate(item: BootstrapInteractiveElement): boolean {
  const text = [item.text, item.ariaLabel, item.placeholder, item.href, item.selector].filter(Boolean).join(" ").trim();
  if (!text) return true;
  if (/^(?:\d+|[+-]?\d+(?:\.\d+)?%?)$/.test(text)) return true;
  return /download app|下载APP|open menu|scroll left|scroll right|language|语言|go to next page|more$/i.test(text);
}

function scoreCandidate(item: Partial<BootstrapInteractiveElement>, flowText: string): number {
  const haystack = [item.text, item.ariaLabel, item.placeholder, item.href, item.selector].filter(Boolean).join(" ").toLowerCase();
  const flowTerms = flowText
    .toLowerCase()
    .split(/[,\s，、/|]+/)
    .flatMap((term) => expandTargetFlowTerms(term))
    .filter(Boolean);
  const exactFlowScore = flowText && haystack.includes(flowText.toLowerCase()) ? 60 : 0;
  return exactFlowScore + flowTerms.reduce((sum, term) => sum + (haystack.includes(term) ? 20 : 0), 0) + (item.href ? 10 : 0) + (item.selector ? 5 : 0);
}

function escapeCss(value: string): string {
  return value.replace(/"/g, '\\"');
}

function updateCoverage(
  coverage: NonNullable<BootstrapScanRun["target_flow_coverage"]>,
  page: BootstrapScanPage
): NonNullable<BootstrapScanRun["target_flow_coverage"]> {
  return coverage.map((item) => {
    const terms = expandTargetFlowTerms(item.flow);
    const pageText = [
      page.title,
      page.url_or_activity,
      page.detected_semantic_page_name,
      ...page.interactive_elements.flatMap((element) => [element.text, element.ariaLabel, element.placeholder, element.href, element.selector])
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    const matchedElements = page.interactive_elements.filter((element) => scoreCandidate(element, item.flow) > 15).length;
    const matchedPage = terms.some((term) => pageText.includes(term));
    return {
      ...item,
      matched_pages: item.matched_pages + (matchedPage ? 1 : 0),
      matched_paths: item.matched_paths,
      matched_elements: item.matched_elements + matchedElements
    };
  });
}

function updateCoverageForPath(
  coverage: NonNullable<BootstrapScanRun["target_flow_coverage"]>,
  scanPath: BootstrapScanPath
): NonNullable<BootstrapScanRun["target_flow_coverage"]> {
  return coverage.map((item) => ({
    ...item,
    matched_paths: item.matched_paths + (scoreCandidate(scanPath.trigger_element ?? {}, item.flow) > 15 ? 1 : 0)
  }));
}

function expandFlowTerm(term: string): string[] {
  const cleaned = term.trim().toLowerCase();
  const aliases: Record<string, string[]> = {
    login: ["login", "sign in", "signin", "log in", "登录", "登陆"],
    register: ["register", "signup", "sign up", "注册"],
    red: ["red", "packet", "red packet", "红包"],
    packet: ["packet", "red packet", "红包"],
    kyc: ["kyc", "identity", "身份", "实名", "认证"],
    order: ["order", "下单", "订单"],
    withdraw: ["withdraw", "提现"],
    deposit: ["deposit", "充值"],
    spot: ["spot", "现货"],
    admin: ["admin", "后台", "管理"]
  };
  return [...new Set([cleaned, ...(aliases[cleaned] ?? [])])].filter(Boolean);
}

function buildReviewPrompt(payload: unknown): string {
  return [
    "# Bootstrap Scan Review",
    "",
    "请基于下面的 bootstrap_scan staging 结果，审查页面语义、元素 locator、业务路径和 DSL 草稿。",
    "",
    "请输出一个 JSON，格式如下：",
    "",
    "```json",
    "{",
    "  \"elements\": [",
    "    {\"scan_element_id\": \"...\", \"semantic_name\": \"登录按钮\", \"primary_locator\": \"...\", \"fallback_locators\": [\"...\"]}",
    "  ],",
    "  \"dsl_cases\": [",
    "    {\"id\": \"...\", \"title\": \"...\", \"type\": \"web\", \"project\": \"...\", \"module\": \"...\", \"priority\": \"P2\", \"tags\": [\"bootstrap_scan\"], \"owner\": \"qa\", \"env\": [\"test\"], \"steps\": [], \"assertions\": []}",
    "  ],",
    "  \"notes\": [\"需要人工确认的风险或前置条件\"]",
    "}",
    "```",
    "",
    "重点检查：",
    "- locator 是否稳定，优先 data-testid/id/name/role，避免脆弱 xpath。",
    "- DSL 是否包含 semantic_target、primary_locator、fallback_locators、assertion。",
    "- 高风险动作只生成草稿，不建议真实执行。",
    "- 页面跳转和断言是否符合业务语义。",
    "",
    "扫描结果：",
    "",
    "```json",
    JSON.stringify(payload, null, 2),
    "```"
  ].join("\n");
}

function buildRecommendedCommand(project: string, env: string, options: BootstrapScanOptions): string {
  const args = [
    "npm run bootstrap:scan --",
    "--project",
    project,
    "--env",
    env,
    "--platform",
    options.platform
  ];
  if (options.startUrl) args.push("--start-url", quoteArg(options.startUrl));
  if (options.targetFlows.length) args.push("--target-flows", quoteArg(options.targetFlows.join(",")));
  args.push("--max-pages", String(options.maxPages), "--max-depth", String(options.maxDepth), "--max-paths", String(options.maxPaths));
  if (options.allowedDomains.length) args.push("--allowed-domains", quoteArg(options.allowedDomains.join(",")));
  if (options.deniedPatterns.length) args.push("--denied-patterns", quoteArg(options.deniedPatterns.join(",")));
  if (options.deniedActions.length) args.push("--denied-actions", quoteArg(options.deniedActions.join(",")));
  return args.join(" ");
}

function quoteArg(value: string): string {
  return value.includes(" ") || value.includes(",") ? `"${value.replace(/"/g, '\\"')}"` : value;
}

async function requestBypassToken(input: {
  username: string;
  password: string;
  bypass: {
    method: "POST";
    path: string;
    usernameField: string;
    passwordField: string;
    tokenResponsePath: string;
    extraPayload: Record<string, unknown>;
  };
  apiBaseUrl: string;
}): Promise<{ loginUrl: string; status: number; body: unknown; token?: unknown }> {
  const loginUrl = new URL(input.bypass.path, input.apiBaseUrl).toString();
  const payload = {
    ...input.bypass.extraPayload,
    [input.bypass.usernameField]: input.username,
    [input.bypass.passwordField]: input.password,
    uaTime: formatDateTime(new Date())
  };
  const response = await fetch(loginUrl, {
    method: input.bypass.method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  const body = (await response.json().catch(() => undefined)) as unknown;
  return {
    loginUrl,
    status: response.status,
    body,
    token: response.ok ? readPath(body, input.bypass.tokenResponsePath) : undefined
  };
}

function readPath(value: unknown, pathExpression: string): unknown {
  return pathExpression.split(".").reduce<unknown>((current, part) => {
    if (!current || typeof current !== "object") return undefined;
    return (current as Record<string, unknown>)[part];
  }, value);
}

function formatDateTime(value: Date): string {
  const pad = (input: number) => String(input).padStart(2, "0");
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`;
}

function accountScore(account: { username: string; label?: string }): number {
  const value = `${account.username} ${account.label ?? ""}`.toLowerCase();
  if (value.includes("bypass")) return 100;
  if (value.includes("test")) return 30;
  if (value.includes("uat")) return 20;
  return 0;
}
