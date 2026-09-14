import type { SmartElement } from "./types.js";

export interface SemanticLocatorCandidate {
  locator: string;
  score: number;
  reason: string;
  elementType: SmartElement["element_type"];
  textCandidates: string[];
  nearbyTexts: string[];
}

export interface SemanticMatchInput {
  semanticTarget: string;
  actionType: string;
  platform: "web" | "android" | "ios" | "app";
  pageStructure: unknown;
}

interface WebControl {
  tag?: string;
  text?: string;
  placeholder?: string;
  ariaLabel?: string;
  role?: string;
  id?: string;
  name?: string;
  testId?: string;
  href?: string;
  selector?: string;
}

export function matchSemanticLocators(input: SemanticMatchInput): SemanticLocatorCandidate[] {
  if (!input.semanticTarget.trim()) return [];
  if (input.platform === "web") return matchWebSemanticLocators(input.semanticTarget, input.actionType, input.pageStructure);
  return matchMobileSemanticLocators(input.semanticTarget, input.actionType, input.pageStructure);
}

export function matchWebSemanticLocators(
  semanticTarget: string,
  actionType: string,
  pageStructure: unknown
): SemanticLocatorCandidate[] {
  const controls = normalizeWebControls(pageStructure);
  const target = normalize(semanticTarget);
  return controls
    .flatMap((control) => {
      const textValues = [control.text, control.placeholder, control.ariaLabel, control.name, control.id, control.testId].filter(Boolean) as string[];
      const haystack = normalize(textValues.join(" "));
      const score = scoreText(target, haystack) + scoreActionType(actionType, control);
      const locator = locatorForWebControl(control, textValues[0] ?? semanticTarget);
      if (!locator || score <= 0) return [];
      return [
        {
          locator,
          score,
          reason: `Matched ${control.tag ?? "element"} by ${textValues.join(" / ")}`.slice(0, 240),
          elementType: elementTypeForWeb(control, actionType),
          textCandidates: textValues.slice(0, 10),
          nearbyTexts: [control.href].filter(Boolean) as string[]
        }
      ];
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);
}

export function matchMobileSemanticLocators(
  semanticTarget: string,
  actionType: string,
  pageStructure: unknown
): SemanticLocatorCandidate[] {
  const text = typeof pageStructure === "string" ? pageStructure : JSON.stringify(pageStructure ?? "");
  const target = normalize(semanticTarget);
  const candidates: SemanticLocatorCandidate[] = [];
  for (const attr of ["content-desc", "text", "resource-id", "label", "name"]) {
    const regex = new RegExp(`${attr}="([^"]*${escapeRegExpLoose(semanticTarget)}[^"]*)"`, "gi");
    for (const match of text.matchAll(regex)) {
      const value = match[1] ?? "";
      const score = scoreText(target, normalize(value)) + (actionType === "input" ? 5 : 10);
      const locator = mobileLocator(attr, value);
      if (locator) {
        candidates.push({
          locator,
          score,
          reason: `Matched mobile ${attr}: ${value}`.slice(0, 240),
          elementType: actionType === "input" ? "input" : "button",
          textCandidates: [value],
          nearbyTexts: []
        });
      }
    }
  }
  return candidates.sort((a, b) => b.score - a.score).slice(0, 10);
}

function normalizeWebControls(pageStructure: unknown): WebControl[] {
  if (Array.isArray(pageStructure)) return pageStructure as WebControl[];
  if (pageStructure && typeof pageStructure === "object" && "controls" in pageStructure) {
    const controls = (pageStructure as { controls?: unknown }).controls;
    if (Array.isArray(controls)) return controls as WebControl[];
  }
  return [];
}

function locatorForWebControl(control: WebControl, fallbackText: string): string | undefined {
  if (control.selector) return control.selector;
  if (control.testId) return `[data-testid="${cssEscape(control.testId)}"]`;
  if (control.id) return `#${cssIdentifier(control.id)}`;
  if (control.name) return `${control.tag ?? "input"}[name="${cssEscape(control.name)}"]`;
  if (control.placeholder) return `${control.tag ?? "input"}[placeholder*="${cssEscape(control.placeholder)}"]`;
  if (control.ariaLabel) return `[aria-label*="${cssEscape(control.ariaLabel)}"]`;
  if (control.tag === "button") return `role=button:${fallbackText}`;
  if (control.tag === "a" && fallbackText) return `text=${fallbackText}`;
  if (fallbackText) return `text=${fallbackText}`;
  return undefined;
}

function elementTypeForWeb(control: WebControl, actionType: string): SmartElement["element_type"] {
  if (actionType === "input" || ["input", "textarea", "select"].includes(control.tag ?? "")) return "input";
  if (control.tag === "a") return "link";
  if (control.tag === "button" || actionType === "click") return "button";
  return "unknown";
}

function scoreActionType(actionType: string, control: WebControl): number {
  const tag = control.tag ?? "";
  if (actionType === "input" && ["input", "textarea", "select"].includes(tag)) return 30;
  if (actionType === "click" && ["button", "a"].includes(tag)) return 25;
  return 0;
}

function scoreText(target: string, haystack: string): number {
  if (!target || !haystack) return 0;
  if (haystack === target) return 100;
  if (haystack.includes(target)) return 70;
  return target
    .split(/\s+/)
    .filter(Boolean)
    .reduce((score, term) => score + (haystack.includes(term) ? 12 : 0), 0);
}

function mobileLocator(attr: string, value: string): string | undefined {
  if (!value) return undefined;
  if (attr === "content-desc" || attr === "label" || attr === "name") return `accessibility_id=${value}`;
  if (attr === "resource-id") return `resource_id=${value}`;
  if (attr === "text") return `text=${value}`;
  return undefined;
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function cssEscape(value: string): string {
  return value.replace(/"/g, '\\"');
}

function cssIdentifier(value: string): string {
  return value.replace(/([ #;?%&,.+*~':"!^$[\]()=>|/@])/g, "\\$1");
}

function escapeRegExpLoose(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, ".*");
}
