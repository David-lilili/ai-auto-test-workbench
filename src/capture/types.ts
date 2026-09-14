export type CaptureTargetKind = "direct_page" | "same_page_action";
export type CaptureRiskLevel = "low" | "medium" | "high";
export type CaptureSignalRole = "success" | "form" | "record" | "block";
export type CaptureKnowledgeStatus = "candidate" | "screenshot_verified" | "dom_verified" | "click_observed" | "blocked";

export interface CaptureSignalGroup {
  name: string;
  terms: string[];
  weight?: number;
  role?: CaptureSignalRole;
}

export interface CaptureTarget {
  id: string;
  pageId: string;
  label: string;
  module: string;
  action: string;
  kind: CaptureTargetKind;
  url?: string;
  entryText?: string;
  expectedCapability: string;
  riskLevel: CaptureRiskLevel;
}

export interface CaptureDataBindingRule {
  term: string;
  targetField: string;
  valueType: string;
  sourcePath: string;
}

export interface CapturePreconditionRule {
  name: string;
  pattern: string;
}

export interface CaptureCoverageProbe {
  key: string;
  purpose: string;
  requiresTargetIds: string[];
  gaps: string[];
}

export interface CaptureRunConfig {
  runId: string;
  project: string;
  env: string;
  platform: "web";
  locale: string;
  schemaVersion: string;
  entryUrl: string;
  entryPageId: string;
  entryLabel: string;
  targets: CaptureTarget[];
  signalGroups: CaptureSignalGroup[];
  dataBindingRules: CaptureDataBindingRule[];
  preconditionRules: CapturePreconditionRule[];
  coverageProbes?: CaptureCoverageProbe[];
  viewport?: { width: number; height: number };
  headed?: boolean;
  navigationTimeoutMs?: number;
  reportTitle?: string;
  nextStage?: { stage: string; reason: string };
}

export interface InventoryItem {
  index: number;
  tag?: string;
  role?: string;
  text?: string;
  ariaLabel?: string;
  placeholder?: string;
  name?: string;
  id?: string;
  href?: string;
  type?: string;
  disabled?: boolean;
  classes?: string;
  label?: string;
  valuePresent?: boolean;
  rowCount?: number;
  src?: string;
  title?: string;
  /** P6.2：table/list 的列头。 */
  columnHeaders?: string[];
  /** P6.2：首行单元格文本（用于推断列结构）。 */
  firstRowCells?: string[];
}

export interface InventorySummary {
  clickables: InventoryItem[];
  fields: InventoryItem[];
  buttons: InventoryItem[];
  tables: InventoryItem[];
  dialogs: InventoryItem[];
  iframes: InventoryItem[];
  selectLike: InventoryItem[];
  /** P6.2：native select 的 option 清单（可直接读，不需打开）。 */
  selectOptions?: Array<{ index: number; id?: string; name?: string; ariaLabel?: string; text?: string; options: Array<{ value?: string; text?: string; disabled?: boolean }> }>;
  /** P6.2：结构化空状态文本（暂无数据/No data 等）。 */
  emptyStateTexts?: string[];
  /** P6.2：分页区域信号。 */
  pagination?: Array<{ index: number; text?: string; items: number }>;
}

export interface CaptureSignalSummary {
  groups: Array<{ name: string; matched: string[]; weight: number; role?: CaptureSignalRole }>;
  blockTerms: string[];
  score: number;
}

export interface CaptureEvidence {
  id: string;
  pageId: string;
  label: string;
  module: string;
  action: string;
  url: string;
  title: string;
  pageType: string;
  screenshotPath: string;
  domPath: string;
  visibleTextPath: string;
  accessibilityPath: string;
  summaryPath: string;
  domHash: string;
  visibleTextHash: string;
  visibleTextSample: string[];
  signals: CaptureSignalSummary;
  inventory: InventorySummary;
  status: CaptureKnowledgeStatus;
  confidence: number;
}

export interface CaptureTargetResult {
  target: CaptureTarget;
  capture: CaptureEvidence;
  before?: CaptureEvidence;
  actionResult?: Record<string, unknown>;
  block?: Record<string, unknown>;
}

export interface CaptureAuthContext {
  webBaseUrl: string;
  apiBaseUrl: string;
  bypassLogin?: {
    enabled: boolean;
    method?: string;
    path: string;
    tokenHeaderName?: string;
    tokenResponsePath?: string;
    usernameField: string;
    passwordField: string;
    extraPayload?: Record<string, unknown>;
  };
  authInjection?: { storageKeys?: string[]; cookieNames?: string[] };
  account?: { username?: string; password?: string };
}
