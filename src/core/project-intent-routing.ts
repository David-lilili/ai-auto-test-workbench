/**
 * 项目意图路由注册表：core 层消费的唯一入口。
 * 新项目接入时提供自己的 ProjectIntentPageRouting 实现并在此注册，
 * 让 core 层按 intent.project 分发，而不是在 core 里加 if 分支。
 */
export interface IntentLike {
  project: string;
  module: string;
  action: string;
  data: Record<string, unknown>;
}

export interface ProjectIntentPageRouting {
  project: string;
  /** 意图涉及的候选页面 ID（含导航经过页），按相关性排序。 */
  targetPageIdsForIntent(intent: IntentLike): string[];
  /** 意图的主目标页面 ID；无法判断时返回 undefined。 */
  primaryTargetPageIdForIntent(intent: IntentLike): string | undefined;
  /** 项目专属的用户输入值归一化：用户口语值 → Page Model 已建模枚举值。 */
  normalizeIntentValue(intent: IntentLike, value: string): string | undefined;
}

const registry = new Map<string, ProjectIntentPageRouting>();

export function registerIntentPageRouting(routing: ProjectIntentPageRouting): void {
  registry.set(routing.project, routing);
}

export function getIntentPageRouting(project: string): ProjectIntentPageRouting | undefined {
  return registry.get(project);
}

export function targetPageIdsForIntent(intent: IntentLike): string[] {
  return getIntentPageRouting(intent.project)?.targetPageIdsForIntent(intent) ?? [];
}

export function primaryTargetPageIdForIntent(intent: IntentLike): string | undefined {
  return getIntentPageRouting(intent.project)?.primaryTargetPageIdForIntent(intent);
}

/** 项目专属的用户输入值归一化（口语值 → 已建模枚举值）；未注册项目返回原值。 */
export function normalizeIntentValueForProject(intent: IntentLike, value: string): string | undefined {
  return getIntentPageRouting(intent.project)?.normalizeIntentValue(intent, value);
}
