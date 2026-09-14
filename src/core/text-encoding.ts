export interface EncodingIssue {
  path: string;
  valuePreview: string;
  reason: string;
  codePoints: string[];
}

export interface EncodingSummary {
  issueCount: number;
  issues: EncodingIssue[];
}

export class EncodingBoundaryError extends Error {
  readonly issues: EncodingIssue[];

  constructor(message: string, issues: EncodingIssue[]) {
    super(message);
    this.name = "EncodingBoundaryError";
    this.issues = issues;
  }
}

const MOJIBAKE_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: new RegExp("[\\uFFFD\\u951F]", "u"), reason: "replacement-character" },
  { pattern: new RegExp("[\\u00C3\\u00C2].", "u"), reason: "latin1-decoded-utf8" },
  { pattern: new RegExp("(?:\\u93BB\\u612E\\u5E47|\\u9352\\u72BB\\u6ACE|\\u95AB\\u6C33|\\u9366\\u677F|\\u9422\\u5BA0\\u5598)", "u"), reason: "gbk-mojibake-cjk" },
  {
    pattern: new RegExp(
      [
        "\\u9405\\u8BF2\\u7D8D",
        "\\u941C\\uE1C8\\uE557",
        "\\u6D93\\u5B2A\\u5D1F",
        "\\u8D10\\uE708",
        "\\u752F\\u5099\\u73AF",
        "\\u95B2\\u6226\\uE596",
        "\\u7481\\u2033\\u579D",
        "\\u9346\\u6B13\\u6437"
      ].join("|"),
      "u"
    ),
    reason: "gbk-mojibake-cjk"
  }
];

export function containsMojibake(value: string): boolean {
  return detectStringEncodingIssues(value, "$").length > 0;
}

export function assertCleanTextBoundary(value: unknown, boundaryName: string): void {
  const summary = summarizeEncodingIssues(value);
  if (summary.issueCount > 0) {
    throw new EncodingBoundaryError(`Encoding boundary rejected mojibake text at ${boundaryName}.`, summary.issues);
  }
}

export function summarizeEncodingIssues(value: unknown, maxIssues = 20): EncodingSummary {
  const issues: EncodingIssue[] = [];
  collectIssues(value, "$", issues, maxIssues);
  return { issueCount: issues.length, issues };
}

export function summarizeCodePoints(value: string, maxChars = 80): string[] {
  return [...value.slice(0, maxChars)].map((char) => char.codePointAt(0)?.toString(16) ?? "");
}

export function normalizeForEncodingLog(value: unknown): unknown {
  const summary = summarizeEncodingIssues(value, 5);
  return summary.issueCount > 0 ? { encodingSuspect: true, encodingIssues: summary.issues } : { encodingSuspect: false };
}

function collectIssues(value: unknown, path: string, issues: EncodingIssue[], maxIssues: number): void {
  if (issues.length >= maxIssues) return;
  if (typeof value === "string") {
    issues.push(...detectStringEncodingIssues(value, path).slice(0, maxIssues - issues.length));
    return;
  }
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectIssues(item, `${path}[${index}]`, issues, maxIssues));
    return;
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    collectIssues(item, `${path}.${key}`, issues, maxIssues);
    if (issues.length >= maxIssues) return;
  }
}

function detectStringEncodingIssues(value: string, path: string): EncodingIssue[] {
  const issues: EncodingIssue[] = [];
  for (const { pattern, reason } of MOJIBAKE_PATTERNS) {
    if (!pattern.test(value)) continue;
    issues.push({
      path,
      valuePreview: escapeForEncodingPreview(value, 160),
      reason,
      codePoints: summarizeCodePoints(value, 80)
    });
    break;
  }
  return issues;
}

function escapeForEncodingPreview(value: string, maxChars: number): string {
  let preview = "";
  let count = 0;
  for (const char of value) {
    if (count >= maxChars) break;
    count += 1;
    const codePoint = char.codePointAt(0) ?? 0;
    if (codePoint >= 0x20 && codePoint <= 0x7e) {
      preview += char;
    } else {
      preview += `\\u{${codePoint.toString(16)}}`;
    }
  }
  return preview;
}
