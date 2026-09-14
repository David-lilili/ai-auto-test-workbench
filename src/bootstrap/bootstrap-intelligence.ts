import type { BootstrapInteractiveElement, BootstrapScanPage, DslAssertion } from "../core/types.js";
import { classifyRisk } from "../core/exploration-risk-policy.js";

export type BootstrapPageType = NonNullable<BootstrapScanPage["detected_page_type"]>;

export interface SemanticPageResult {
  name: string;
  type: BootstrapPageType;
  confidence: number;
  assertions: DslAssertion[];
}

export interface SemanticElementResult {
  name: string;
  role: string;
  confidence: number;
}

const FLOW_ALIASES: Record<string, string[]> = {
  login: ["login", "sign in", "signin", "log in", "email", "password", "login button"],
  register: ["register", "signup", "sign up", "create account", "email verification"],
  red: ["red", "packet", "red packet", "bonus", "coupon", "reward"],
  packet: ["packet", "red packet", "bonus", "coupon", "reward"],
  bonus: ["bonus", "coupon", "reward", "red packet"],
  kyc: ["kyc", "identity", "verification", "id verification", "document"],
  order: ["order", "place order", "submit order", "buy", "sell"],
  cancel: ["cancel", "cancel order", "revoke", "撤单"],
  withdraw: ["withdraw", "withdrawal", "cash out"],
  deposit: ["deposit", "recharge", "top up"],
  spot: ["spot", "trade", "market", "pair"],
  admin: ["admin", "setting", "config", "management", "dashboard"],
  settings: ["settings", "config", "preference", "permission"],
  payment: ["payment", "pay", "checkout", "card"],
  config: ["config", "setting", "maintenance", "admin"],
  fee: ["fee", "commission", "rate"],
  card: ["card", "u card", "bank card"]
};

// P3-A4：风险词表与分级逻辑统一在 exploration-risk-policy（heuristic 与 bootstrap 共用单一实现）。

export function inferSemanticPage(input: {
  title?: string;
  urlOrActivity: string;
  elements: BootstrapInteractiveElement[];
}): SemanticPageResult {
  const pageText = normalize([input.title, input.urlOrActivity, ...input.elements.flatMap(elementTexts)].filter(Boolean).join(" "));
  const type = classifyPageType(pageText, input.elements);
  const name = pageNameForType(type, input.title, input.urlOrActivity, input.elements);
  return {
    name,
    type,
    confidence: type === "unknown" ? 0.45 : 0.75,
    assertions: suggestAssertions({ ...input, pageType: type })
  };
}

export function inferSemanticElement(item: BootstrapInteractiveElement, page?: BootstrapScanPage): SemanticElementResult {
  const raw = firstText(item) || item.selector || "unknown element";
  const text = normalize(raw);
  const type = item.elementType ?? "unknown";
  const pagePrefix = page?.detected_page_type && page.detected_page_type !== "unknown" ? `${page.detected_page_type} ` : "";
  if (type === "input") {
    if (/password|pwd/.test(text)) return { name: `${pagePrefix}password field`.trim(), role: "credential_input", confidence: 0.9 };
    if (/email|mail|account|user|mobile|phone/.test(text)) return { name: `${pagePrefix}account field`.trim(), role: "account_input", confidence: 0.85 };
    if (/code|otp|captcha|verification/.test(text)) return { name: `${pagePrefix}verification code field`.trim(), role: "verification_input", confidence: 0.85 };
    if (/amount|price|quantity|qty|number/.test(text)) return { name: `${pagePrefix}amount field`.trim(), role: "amount_input", confidence: 0.8 };
    return { name: `${raw} input`.slice(0, 80), role: "input", confidence: 0.65 };
  }
  if (/login|sign in|signin/.test(text)) return { name: `${pagePrefix}login button`.trim(), role: "primary_action", confidence: 0.9 };
  if (/register|signup|sign up/.test(text)) return { name: `${pagePrefix}register button`.trim(), role: "primary_action", confidence: 0.88 };
  if (/submit|confirm|save|create|apply|approve/.test(text)) return { name: `${raw} action`.slice(0, 80), role: "write_action", confidence: 0.8 };
  if (/close|cancel|back|dismiss|ok|got it|accept|allow/.test(text)) return { name: `${raw} dialog control`.slice(0, 80), role: "dialog_control", confidence: 0.75 };
  if (type === "link") return { name: `${raw} link`.slice(0, 80), role: "navigation", confidence: 0.7 };
  return { name: String(raw).trim().slice(0, 80), role: type, confidence: 0.6 };
}

export function expandTargetFlowTerms(flow: string): string[] {
  const terms = normalize(flow)
    .split(/[,\s/|]+/)
    .filter(Boolean);
  return [...new Set(terms.flatMap((term) => [term, ...(FLOW_ALIASES[term] ?? [])]))];
}

export function classifyBootstrapRisk(value: string): "low" | "medium" | "high" {
  const level = classifyRisk(value);
  return level === "forbidden" ? "high" : level;
}

export function suggestAssertions(input: {
  title?: string;
  urlOrActivity: string;
  pageType?: BootstrapPageType;
  elements: BootstrapInteractiveElement[];
}): DslAssertion[] {
  const assertions: DslAssertion[] = [];
  const url = input.urlOrActivity;
  if (/^https?:\/\//i.test(url)) {
    try {
      const parsed = new URL(url);
      if (parsed.pathname && parsed.pathname !== "/") assertions.push({ type: "urlContains", expected: parsed.pathname.split("/").filter(Boolean)[0] ?? "" });
    } catch {
      // ignore malformed urls
    }
  }
  const stableText = input.title || input.elements.map(firstText).find((value) => value && value.length > 2 && value.length < 60);
  if (stableText) assertions.push({ type: "textVisible", target: stableText });
  if (input.pageType === "login") {
    const loginAction = input.elements.map(firstText).find((value) => value && /login|sign in|signin/i.test(value));
    if (loginAction) assertions.push({ type: "textVisible", target: loginAction });
  }
  return dedupeAssertions(assertions).slice(0, 3);
}

function classifyPageType(pageText: string, elements: BootstrapInteractiveElement[]): BootstrapPageType {
  const inputCount = elements.filter((item) => item.elementType === "input").length;
  const hasLoginAction = elements.some((item) => /login|sign in|signin/i.test(elementTexts(item).join(" ")));
  const hasPassword = elements.some((item) => /password|pwd/i.test(elementTexts(item).join(" ")));
  if (/dashboard|workbench|console|overview/.test(pageText) && elements.length > 20) return "home";
  if ((/login|sign in|signin/.test(pageText) || hasLoginAction) && hasPassword) return "login";
  if (/register|signup|sign up|create account/.test(pageText)) return "register";
  if (/kyc|identity|verification|document/.test(pageText)) return "kyc";
  if (/payment|checkout|pay|card/.test(pageText)) return "payment";
  if (/setting|config|permission|preference/.test(pageText)) return "settings";
  if (inputCount >= 2 || /form|submit|save|create/.test(pageText)) return "form";
  if (/detail|profile|overview/.test(pageText)) return "detail";
  if (/list|table|records|history/.test(pageText)) return "list";
  if (/home|dashboard|index/.test(pageText)) return "home";
  return "unknown";
}

function pageNameForType(
  type: BootstrapPageType,
  title: string | undefined,
  urlOrActivity: string,
  elements: BootstrapInteractiveElement[]
): string {
  if (title?.trim()) return title.trim();
  if (type !== "unknown") return `${type} page`;
  const visible = elements.map(firstText).find((value) => value && value.length > 1 && value.length < 40);
  if (visible) return visible;
  try {
    const parsed = new URL(urlOrActivity);
    return parsed.pathname === "/" ? parsed.hostname : parsed.pathname;
  } catch {
    return urlOrActivity || "unknown page";
  }
}

function elementTexts(item: BootstrapInteractiveElement): string[] {
  return [item.text, item.placeholder, item.ariaLabel, item.name, item.id, item.href, item.selector].filter(Boolean) as string[];
}

function firstText(item?: BootstrapInteractiveElement): string | undefined {
  if (!item) return undefined;
  return [item.text, item.ariaLabel, item.placeholder, item.name, item.id].find((value) => value && String(value).trim())?.trim();
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function dedupeAssertions(assertions: DslAssertion[]): DslAssertion[] {
  const seen = new Set<string>();
  return assertions.filter((item) => {
    const key = JSON.stringify(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
