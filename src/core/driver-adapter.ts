import type { BootstrapInteractiveElement, DslAssertion, PageState } from "./types.js";
import type { SemanticLocatorCandidate } from "./semantic-locator-matcher.js";

export interface VisualTargetCandidate {
  x: number;
  y: number;
  width: number;
  height: number;
  score: number;
  reason: string;
  locator?: string;
  textCandidates?: string[];
  nearbyTexts?: string[];
}

export interface DriverAdapter {
  getCurrentPageState(): Promise<PageState>;
  getDomOrPageSource(): Promise<string>;
  getAccessibilityTree(): Promise<unknown>;
  takeScreenshot(filePath?: string): Promise<string | Buffer>;
  findElement(locator: string): Promise<unknown>;
  click(target: string): Promise<void>;
  input(target: string, text: string): Promise<void>;
  setDateRange?(target: string, value: unknown, options?: { timeoutMs?: number }): Promise<Record<string, unknown>>;
  selectDropdownOption?(target: string, value: string, options?: { component?: unknown; postconditions?: unknown; timeoutMs?: number }): Promise<Record<string, unknown>>;
  swipe(params: unknown): Promise<void>;
  waitFor(condition: unknown, timeoutMs?: number): Promise<void>;
  assertState(assertion: DslAssertion): Promise<void>;
  getCurrentUrlOrActivity(): Promise<string>;
  getInteractiveElements?(): Promise<BootstrapInteractiveElement[]>;
  dismissSystemOverlays?(): Promise<number>;
  switchToWebView?(): Promise<boolean>;
  findSemanticLocators?(semanticTarget: string, actionType: string): Promise<SemanticLocatorCandidate[]>;
  findVisualTargets?(semanticTarget: string, actionType: string): Promise<VisualTargetCandidate[]>;
  clickAt?(x: number, y: number): Promise<void>;
  inputAt?(x: number, y: number, text: string): Promise<void>;
  close(): Promise<void>;
}
