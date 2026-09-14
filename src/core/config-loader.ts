import path from "node:path";
import fs from "fs-extra";
import YAML from "yaml";
import type { EnvConfig, LoadedContext, ProjectConfig, WorkspaceConfig } from "./types.js";

async function readYaml<T>(filePath: string): Promise<T> {
  if (!(await fs.pathExists(filePath))) {
    throw new Error(`Config file not found: ${filePath}`);
  }
  return YAML.parse(await fs.readFile(filePath, "utf8")) as T;
}

export async function loadContext(options: {
  rootDir?: string;
  project?: string;
  env?: string;
}): Promise<LoadedContext> {
  const rootDir = options.rootDir ?? process.cwd();
  const workspace = await readYaml<WorkspaceConfig>(
    path.join(rootDir, "configs", "global.config.yaml")
  );
  const projectKey = options.project ?? workspace.defaultProject;
  const project = await readYaml<ProjectConfig>(
    path.join(rootDir, "configs", "projects", projectKey, "project.config.yaml")
  );
  const envName = options.env ?? project.defaultEnv ?? workspace.defaultEnv;
  const env = await readYaml<EnvConfig>(
    path.join(rootDir, "configs", "projects", projectKey, `env.${envName}.yaml`)
  );

  return { rootDir, workspace, project, env };
}

export async function readCaseFile<T>(casePath: string): Promise<T> {
  const content = await fs.readFile(casePath, "utf8");
  if (casePath.endsWith(".json")) return JSON.parse(content) as T;
  return YAML.parse(content) as T;
}
