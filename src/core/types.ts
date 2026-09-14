export type TestType = "web" | "api" | "app";

export type Priority = "P0" | "P1" | "P2" | "P3";

export type Platform = "web" | "android" | "ios" | "app";
export type ExecutionMode = "strict" | "heal" | "explore" | "debug" | "bootstrap_scan";
export type ExecutionStatus = "passed" | "failed" | "healed" | "partial" | "skipped";
export type FallbackLevel = 0 | 1 | 2 | 3 | 4 | 5;
export type AIPurpose =
  | "dsl_generation"
  | "self_healing"
  | "visual_detection"
  | "path_planning"
  | "failure_analysis"
  | "semantic_matching"
  | "bootstrap_scan";

export interface RuntimeOptions {
  project: string;
  env: string;
  type?: TestType;
  tags: string[];
  caseId?: string;
  deviceProfile?: string;
  locales: string[];
  dryRun: boolean;
  mode?: ExecutionMode;
  headed?: boolean;
  observationMode?: boolean;
  observationProfile?: "execution" | "assertion" | "modeling" | "full";
  maxAiCalls?: number;
  maxAiTokens?: number;
  maxEstimatedCost?: number;
  maxStepHealingLevel?: FallbackLevel;
  startUrl?: string;
  startActivity?: string;
  targetFlows?: string[];
  maxPages?: number;
  maxDepth?: number;
  maxPaths?: number;
  maxDurationMs?: number;
  allowedDomains?: string[];
  deniedPatterns?: string[];
  deniedActions?: string[];
  dryRunOnly?: boolean;
  requireHumanApprovalBeforeSubmit?: boolean;
  abortSignal?: AbortSignal;
  onStep?: (event: {
    type: "step_start" | "step_end";
    runId: string;
    stepIndex: number;
    totalSteps: number;
    dslStepId: string;
    action: string;
    target?: string;
    status?: ExecutionStatus;
    step?: Partial<StepExecution>;
  }) => void | Promise<void>;
  webAuthToken?: {
    token: string;
    originUrl: string;
    headerName?: string;
    storageKeys?: string[];
    cookieNames?: string[];
  };
}

export interface WorkspaceConfig {
  workspaceName: string;
  defaultProject: string;
  defaultEnv: string;
  artifactRoot: string;
  reportRoot: string;
  storage?: {
    sqlitePath?: string;
    pageGraphPath?: string;
    appArchivePath?: string;
    knowledgePath?: string;
    accountsPath?: string;
    environmentDiscoveryPath?: string;
  };
  security?: {
    maskFields?: string[];
    forbiddenWriteActions?: string[];
  };
  ai?: {
    enabled?: boolean;
    provider?: string;
    summaryOutput?: string;
  };
}

export interface ProjectConfig {
  projectKey: string;
  projectName: string;
  owners: string[];
  enabledTestTypes: TestType[];
  defaultEnv: string;
  report: Record<string, boolean>;
  failureArtifacts: Record<string, boolean>;
  exploration?: {
    defaultMode: "readOnly" | "safeForm" | "sandboxWrite" | "fullExploration";
    maxDepth: number;
    maxPages: number;
    allowRiskyActions: boolean;
  };
}

export interface EnvConfig {
  env: string;
  web?: {
    baseUrl: string;
    adminBaseUrl?: string;
    spotAdminBaseUrl?: string;
  };
  api?: { baseUrl: string };
  app?: Record<string, unknown>;
  database?: Record<string, unknown>;
  redis?: Record<string, unknown>;
  mfa?: Record<string, unknown>;
  accountFactory?: Record<string, unknown>;
  timeouts?: {
    actionMs?: number;
    requestMs?: number;
  };
  retry?: {
    caseRetries?: number;
    apiRetries?: number;
  };
  safety?: {
    productionReadonly?: boolean;
    writeActionsAllowed?: boolean;
  };
}

export interface TestAccount {
  id: string;
  project: string;
  env: string;
  username: string;
  password: string;
  label?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TestAccountStore {
  updatedAt: string;
  accounts: TestAccount[];
}

export interface EnvironmentDiscovery {
  project: string;
  env: string;
  updatedAt: string;
  domains: string[];
  apiEndpoints: Array<{
    method?: string;
    url: string;
    domain: string;
    path: string;
    source: "exploration" | "manual";
    lastSeenAt: string;
  }>;
  bypassLogin?: {
    enabled: boolean;
    method: "POST";
    path: string;
    tokenHeaderName: string;
    tokenResponsePath: string;
    usernameField: string;
    passwordField: string;
    extraPayload: Record<string, unknown>;
    updatedAt: string;
  };
  authInjection?: {
    storageKeys: string[];
    cookieNames: string[];
    updatedAt: string;
  };
  notes?: string;
}

export interface CaseMetadata {
  id: string;
  title: string;
  type: TestType;
  project: string;
  module: string;
  priority: Priority;
  tags: string[];
  owner: string;
  env: string[];
  dataProfile?: string;
  preconditions?: string[];
  risk?: string[];
  automationCandidate?: boolean;
  suggestedLayer?: string;
}

export interface DslStep {
  id?: string;
  action: string;
  target?: string;
  value?: unknown;
  valueFrom?: string | Record<string, unknown>;
  providerRequirementId?: string;
  riskLevel?: "low" | "medium" | "high";
  semantic_target?: string;
  semanticTarget?: string;
  locator_strategy?: "css" | "xpath" | "role" | "text" | "accessibility_id" | "resource_id" | "image" | "ai";
  locatorStrategy?: "css" | "xpath" | "role" | "text" | "accessibility_id" | "resource_id" | "image" | "ai";
  primary_locator?: string;
  primaryLocator?: string;
  fallback_locators?: string[];
  fallbackLocators?: string[];
  expected_page_after_action?: string;
  expectedPageAfterAction?: string;
  component?: {
    type?: "dropdown" | "input" | "button" | "table" | "unknown";
    targetField?: string;
    optionDiscoveryMode?: "static_visible" | "searchable_local" | "searchable_remote" | "virtualized" | "dynamic" | "unknown";
    popupScope?: string;
    searchInput?: string;
  };
  postconditions?: Array<{
    id: string;
    type: "selectedValueEquals" | "textVisibleAny" | "textNotVisible" | "locatorVisible";
    expected?: string | string[];
    locator?: string;
    targetField?: string;
    source?: string;
  }>;
  assertion?: DslAssertion;
  allow_healing?: boolean;
  allowHealing?: boolean;
  max_healing_level?: FallbackLevel;
  maxHealingLevel?: FallbackLevel;
  collect_snapshot?: boolean;
  collectSnapshot?: boolean;
  sensitive?: boolean;
  timeout_ms?: number;
  timeoutMs?: number;
  retry_count?: number;
  retryCount?: number;
  scopeGuard?: {
    pageModelId?: string;
    region?: string;
    critical?: boolean;
    forbiddenLocatorPatterns?: string[];
    forbiddenScopes?: string[];
    requiredContextTexts?: string[];
  };
  negativeLocatorHints?: string[];
  preconditions?: Array<{
    id: string;
    type: "textVisibleAny" | "textNotVisible" | "locatorVisible" | "locatorEnabled";
    expected?: string[];
    locator?: string;
    source?: string;
  }>;
  explain?: Record<string, unknown>;
}

export interface DslAssertion {
  type: string;
  target?: string;
  locator?: string;
  fallbackLocators?: string[];
  targetElementId?: string;
  targetStateId?: string;
  expected?: unknown;
  endpoint?: string;
  table?: string;
  column?: string;
  emptyStateAccepted?: boolean;
  source?: string;
  observeWindowMs?: number;
  pollIntervalMs?: number;
  matchMode?: string;
  intent?: Record<string, unknown>;
  actual?: unknown;
  diagnostics?: unknown;
  runtimeSelectedFilters?: Array<{
    label?: string;
    field?: string;
    value: string;
    elementId?: string;
    selectedValueAfter?: string;
    verified?: boolean;
  }>;
  conditions?: Array<{
    column?: string;
    contains?: string;
    equals?: string;
  }>;
}

export interface AutomationCase extends CaseMetadata {
  steps: DslStep[];
  assertions: DslAssertion[];
}

export interface LoadedContext {
  rootDir: string;
  workspace: WorkspaceConfig;
  project: ProjectConfig;
  env: EnvConfig;
}

export interface CaseResult {
  id: string;
  status: "passed" | "failed" | "skipped";
  durationMs: number;
  error?: string;
  artifacts?: string[];
  aiReview?: FailureReview;
  runId?: string;
  healedSteps?: number;
  aiInvocationCount?: number;
}

export interface FailureReview {
  conclusion: string;
  category:
    | "product_defect"
    | "automation_script"
    | "environment"
    | "test_data"
    | "third_party"
    | "network_or_device"
    | "flaky_watch"
    | "assertion_design"
    | "needs_human_decision";
  likelyCause: string;
  evidence: string[];
  nextAction: string;
  ownerHint: "qa" | "dev" | "devops" | "product" | "manual_decision";
  shouldRerun: boolean;
  shouldMarkFlaky: boolean;
  decisionRequired: boolean;
}

export type ExplorationMode = "readOnly" | "safeForm" | "sandboxWrite" | "fullExploration";
export type WebSurface = "site" | "spotAdmin";

export interface PageElementMemory {
  elementId: string;
  role: string;
  text?: string;
  selector?: string;
  href?: string;
  inputType?: string;
  name?: string;
  placeholder?: string;
  riskLevel: "low" | "medium" | "high";
  lastSeenAt: string;
}

export interface PageNodeMemory {
  pageId: string;
  project: string;
  platform: "web" | "app";
  surface?: WebSurface | "mobileApp";
  url?: string;
  urlPattern?: string;
  title?: string;
  semanticName?: string;
  requiredPreconditions: string[];
  elements: PageElementMemory[];
  discoveredBy: "exploration" | "manual" | "case_execution";
  confidence: number;
  visitCount: number;
  lastSeenAt: string;
}

export interface PageEdgeMemory {
  edgeId: string;
  project: string;
  platform: "web" | "app";
  surface?: WebSurface | "mobileApp";
  fromPageId: string;
  toPageId: string;
  action: {
    type: "click" | "navigate" | "deepLink" | "systemBack";
    selector?: string;
    text?: string;
    href?: string;
  };
  preconditions: string[];
  riskLevel: "low" | "medium" | "high";
  successCount: number;
  failedCount: number;
  averageDurationMs: number;
  confidence: number;
  lastVerifiedAt: string;
}

export interface PageGraphMemory {
  project: string;
  updatedAt: string;
  nodes: PageNodeMemory[];
  edges: PageEdgeMemory[];
}

export interface ExecutionRun {
  run_id: string;
  project_id: string;
  platform: Platform;
  env: string;
  test_case_id: string;
  dsl_version?: string;
  test_asset_id?: string;
  test_asset_version?: string;
  execution_preparation_id?: string;
  materialization_fingerprint?: string;
  account_profile_id?: string;
  test_data_fingerprint?: string;
  execution_authorization_id?: string;
  creation_mode?: string;
  mode: ExecutionMode;
  observation_mode?: boolean;
  observation_profile?: string;
  observation_artifact_path?: string;
  start_time: string;
  end_time?: string;
  status: ExecutionStatus;
  total_steps: number;
  passed_steps: number;
  failed_steps: number;
  healed_steps: number;
  ai_invocation_count: number;
  token_input_total: number;
  token_output_total: number;
  estimated_cost: number;
  duration_ms: number;
  error_summary?: string;
}

export interface StepExecution {
  step_id: string;
  run_id: string;
  dsl_step_id: string;
  action_type: string;
  target_semantic_name?: string;
  primary_locator?: string;
  actual_locator_used?: string;
  fallback_level_used: FallbackLevel;
  status: ExecutionStatus;
  before_screenshot_path?: string;
  after_screenshot_path?: string;
  dom_snapshot_path?: string;
  page_source_path?: string;
  assertion_after_dom_path?: string;
  visible_text_snapshot_path?: string;
  assertion_evidence_path?: string;
  observation_artifact_path?: string;
  final_url?: string;
  final_title?: string;
  final_visible_texts?: string[];
  network_summary?: {
    enabled: boolean;
    requests: unknown[];
    matchedBusinessApis: unknown[];
    limitations: string[];
  };
  error_message?: string;
  duration_ms: number;
  ai_used: boolean;
  token_input: number;
  token_output: number;
  estimated_cost: number;
  attempted_locators?: string[];
  action_result?: unknown;
  assertion_summary?: {
    stepIndex?: number;
    stepId?: string;
    readableText?: string;
    type?: string;
    target?: string;
    table?: string;
    column?: string;
    expected?: unknown;
    emptyStateAccepted?: boolean;
    status: ExecutionStatus;
    actual?: unknown;
    diagnostics?: unknown;
    error?: string;
  };
}

export interface SmartElement {
  element_id: string;
  project_id: string;
  platform: Platform;
  page_id?: string;
  semantic_name: string;
  semantic_role?: string;
  element_type: "button" | "input" | "tab" | "text" | "list_item" | "link" | "unknown";
  primary_locator?: string;
  fallback_locators: string[];
  text_candidates: string[];
  nearby_texts: string[];
  visual_signature?: string;
  screen_region?: { x: number; y: number; width: number; height: number };
  last_success_locator?: string;
  success_count: number;
  failure_count: number;
  confidence_score: number;
  source?: "bootstrap_scan" | "case_execution" | "manual" | "exploration";
  source_scan_id?: string;
  last_seen_at: string;
  last_updated_at: string;
}

export interface PageState {
  page_id: string;
  project_id: string;
  platform: Platform;
  page_name?: string;
  url_pattern?: string;
  activity_name?: string;
  route_name?: string;
  title?: string;
  dom_signature?: string;
  page_source_signature?: string;
  screenshot_signature?: string;
  known_elements: string[];
  outgoing_transitions: string[];
  visit_count?: number;
  confidence_score?: number;
  source?: "bootstrap_scan" | "case_execution" | "manual" | "exploration";
  source_scan_id?: string;
  page_type?: BootstrapScanPage["detected_page_type"];
  required_preconditions?: string[];
  last_verified_at?: string;
  last_seen_at: string;
}

export interface PageTransition {
  transition_id: string;
  from_page_id: string;
  to_page_id: string;
  action_description: string;
  trigger_element_id?: string;
  dsl_steps: DslStep[];
  success_count: number;
  failure_count: number;
  average_duration_ms: number;
  confidence_score: number;
}

export interface AIUsage {
  usage_id: string;
  run_id?: string;
  step_id?: string;
  model_name: string;
  purpose: AIPurpose;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  estimated_cost: number;
  latency_ms: number;
  cache_hit: boolean;
  created_at: string;
}

export interface FailureReport {
  report_id: string;
  run_id: string;
  case_id?: string;
  step_id?: string;
  category:
    | "locator_failed"
    | "page_transition_failed"
    | "assertion_failed"
    | "test_data_failed"
    | "environment_failed"
    | "ai_decision_failed"
    | "unknown";
  failed_step?: DslStep;
  failed_layer?: FallbackLevel;
  error_message?: string;
  screenshot_path?: string;
  dom_snapshot_path?: string;
  page_source_path?: string;
  attempted_locators: string[];
  ai_usage_ids?: string[];
  ai_judgement?: string;
  codex_failure_package_path?: string;
  codex_prompt_path?: string;
  suggested_fix?: string;
  created_at: string;
}

export type BootstrapReviewStatus = "pending" | "approved" | "rejected" | "promoted";
export type BootstrapReplayStatus = "pending" | "passed" | "failed";

export interface BootstrapScanRun {
  scan_id: string;
  project_id: string;
  platform: Platform;
  env: string;
  start_url?: string;
  start_activity?: string;
  target_flows: string[];
  mode: "bootstrap_scan";
  status: "running" | "completed" | "failed" | "partial";
  max_pages: number;
  max_depth: number;
  max_paths: number;
  max_duration_ms?: number;
  visited_pages: number;
  generated_paths: number;
  generated_elements: number;
  generated_dsl_cases: number;
  ai_invocation_count: number;
  token_input_total: number;
  token_output_total: number;
  estimated_cost: number;
  safety_config?: {
    allowed_domains: string[];
    denied_patterns: string[];
    denied_actions: string[];
    dry_run_only: boolean;
    require_human_approval_before_submit: boolean;
    max_ai_calls?: number;
    max_ai_tokens?: number;
  };
  target_flow_coverage?: Array<{
    flow: string;
    matched_pages: number;
    matched_paths: number;
    matched_elements: number;
  }>;
  blocked_actions?: Array<{
    text: string;
    selector?: string;
    reason: string;
  }>;
  started_at: string;
  ended_at?: string;
  summary?: string;
  review_package_id?: string;
  review_status?: BootstrapReviewStatus;
  promote_status?: "pending" | "promoted" | "partial" | "skipped";
}

export interface BootstrapInteractiveElement {
  tag?: string;
  role?: string;
  text?: string;
  placeholder?: string;
  ariaLabel?: string;
  name?: string;
  id?: string;
  href?: string;
  selector?: string;
  elementType?: SmartElement["element_type"];
  riskLevel?: "low" | "medium" | "high";
  boundingBox?: { x: number; y: number; width: number; height: number };
}

export interface BootstrapScanPage {
  scan_page_id: string;
  scan_id: string;
  page_signature: string;
  url_or_activity: string;
  title?: string;
  screenshot_path?: string;
  dom_or_page_source_path?: string;
  accessibility_tree_path?: string;
  interactive_elements: BootstrapInteractiveElement[];
  detected_semantic_page_name?: string;
  detected_page_type?: "login" | "register" | "home" | "list" | "detail" | "form" | "settings" | "kyc" | "payment" | "unknown";
  suggested_assertions?: DslAssertion[];
  candidate_page_state: PageState;
  confidence_score: number;
  review_status: BootstrapReviewStatus;
}

export interface BootstrapScanPath {
  scan_path_id: string;
  scan_id: string;
  from_scan_page_id: string;
  to_scan_page_id: string;
  action_description: string;
  trigger_element?: BootstrapInteractiveElement;
  candidate_transition: PageTransition;
  candidate_dsl_steps: DslStep[];
  suggested_assertions?: DslAssertion[];
  replay_status: BootstrapReplayStatus;
  target_flow_score?: number;
  confidence_score: number;
  review_status: BootstrapReviewStatus;
  failure_package_path?: string;
}

export interface BootstrapScanElement {
  scan_element_id: string;
  scan_id: string;
  scan_page_id: string;
  semantic_name: string;
  semantic_role?: string;
  element_type: SmartElement["element_type"];
  primary_locator?: string;
  fallback_locators: string[];
  text_candidates: string[];
  nearby_texts: string[];
  bounding_box?: { x: number; y: number; width: number; height: number };
  visual_signature?: string;
  confidence_score: number;
  review_status: BootstrapReviewStatus;
}

export interface BootstrapReviewPackage {
  package_id: string;
  scan_id: string;
  package_path: string;
  prompt_md_path: string;
  screenshots: string[];
  dom_snapshots: string[];
  candidate_assets: {
    pages: number;
    paths: number;
    elements: number;
    dsl_cases: number;
  };
  generated_at: string;
  review_result_path?: string;
  imported: boolean;
}

export interface BootstrapScanData {
  updatedAt: string;
  runs: BootstrapScanRun[];
  pages: BootstrapScanPage[];
  paths: BootstrapScanPath[];
  elements: BootstrapScanElement[];
  reviewPackages: BootstrapReviewPackage[];
  dslCases: AutomationCase[];
}

export interface BusinessFlow {
  flow_id: string;
  project_id: string;
  env: string;
  platform: Platform;
  name: string;
  target_flows: string[];
  start_page_id?: string;
  target_page_ids: string[];
  transition_ids: string[];
  dsl_case_ids: string[];
  preconditions: string[];
  risk_level: "low" | "medium" | "high";
  source_scan_id?: string;
  review_status: BootstrapReviewStatus;
  replay_status: BootstrapReplayStatus;
  promote_status: "pending" | "promoted" | "partial" | "skipped";
  confidence_score: number;
  created_at: string;
  updated_at: string;
}

export interface BusinessFlowData {
  updatedAt: string;
  flows: BusinessFlow[];
}

export interface KnowledgeChunk {
  chunkId: string;
  project: string;
  sourceType: "page_graph" | "formal_asset" | "business_flow" | "failure_analysis" | "requirement" | "manual_note";
  sourceId: string;
  platform?: "web" | "app";
  surface?: WebSurface | "mobileApp";
  title: string;
  content: string;
  keywords: string[];
  confidence: number;
  updatedAt: string;
  metadata: Record<string, unknown>;
}

export interface KnowledgeBase {
  project: string;
  updatedAt: string;
  chunks: KnowledgeChunk[];
}
