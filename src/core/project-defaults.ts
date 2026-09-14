import fs from "fs-extra";
import path from "node:path";
import YAML from "yaml";
import type { WorkspaceConfig } from "./types.js";

/**
 * 平台层项目默认值来源：configs/global.config.yaml 的 defaultProject/defaultEnv。
 * core 层与 server 层不得再硬编码 "demo"/"test" 字面量作为默认项目/环境；
 * 只有 workspace 配置本身是这一约定的权威来源。
 */
export interface ProjectDefaults {
  defaultProject: string;
  defaultEnv: string;
}

const FALLBACK_DEFAULTS: ProjectDefaults = { defaultProject: "demo", defaultEnv: "test" };

/** core 层同步 API 的兜底默认值：workspace 配置未加载时使用。 */
export const FALLBACK_PROJECT = FALLBACK_DEFAULTS.defaultProject;
export const FALLBACK_ENV = FALLBACK_DEFAULTS.defaultEnv;

export async function readProjectDefaults(rootDir: string): Promise<ProjectDefaults> {
  const configPath = path.join(rootDir, "configs", "global.config.yaml");
  try {
    if (!(await fs.pathExists(configPath))) return FALLBACK_DEFAULTS;
    const workspace = (YAML.parse(await fs.readFile(configPath, "utf8")) ?? {}) as Partial<WorkspaceConfig>;
    return {
      defaultProject: typeof workspace.defaultProject === "string" && workspace.defaultProject.trim() ? workspace.defaultProject.trim() : FALLBACK_DEFAULTS.defaultProject,
      defaultEnv: typeof workspace.defaultEnv === "string" && workspace.defaultEnv.trim() ? workspace.defaultEnv.trim() : FALLBACK_DEFAULTS.defaultEnv
    };
  } catch {
    return FALLBACK_DEFAULTS;
  }
}
