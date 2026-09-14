import type { AutomationCase, RuntimeOptions } from "./types.js";

export function matchesRuntimeFilter(testCase: AutomationCase, options: RuntimeOptions): boolean {
  if (options.caseId && testCase.id !== options.caseId) return false;
  if (options.project && testCase.project !== options.project) return false;
  if (options.type && testCase.type !== options.type) return false;
  if (options.env.length && !testCase.env.includes(options.env)) return false;
  if (!options.tags.length) return true;
  const caseTags = new Set([testCase.priority, testCase.type, ...testCase.tags]);
  return options.tags.every((tag) => caseTags.has(tag));
}
