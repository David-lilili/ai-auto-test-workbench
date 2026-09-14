import path from "node:path";
import fs from "fs-extra";
import type { EnvironmentDiscovery, LoadedContext } from "../core/types.js";
import { writeSafeJsonFile } from "../core/safe-file-writer.js";

export class EnvironmentDiscoveryStore {
  private readonly rootPath: string;

  constructor(private readonly context: LoadedContext) {
    const configured = context.workspace.storage?.environmentDiscoveryPath ?? "storage/environment-discovery";
    this.rootPath = path.join(context.rootDir, configured);
  }

  async load(project = this.context.project.projectKey, env = this.context.env.env): Promise<EnvironmentDiscovery> {
    const filePath = this.filePath(project, env);
    if (!(await fs.pathExists(filePath))) {
      return defaultDiscovery(project, env);
    }
    return (await fs.readJson(filePath)) as EnvironmentDiscovery;
  }

  async save(discovery: EnvironmentDiscovery): Promise<string> {
    discovery.updatedAt = new Date().toISOString();
    const filePath = this.filePath(discovery.project, discovery.env);
    await writeSafeJsonFile(filePath, discovery);
    return filePath;
  }

  async mergeNetwork(input: {
    domains: string[];
    apiEndpoints: Array<{ method?: string; url: string; domain: string; path: string }>;
  }): Promise<EnvironmentDiscovery> {
    const discovery = await this.load();
    discovery.domains = [...new Set([...discovery.domains, ...input.domains])].sort();

    const endpointMap = new Map(discovery.apiEndpoints.map((item) => [`${item.method ?? ""}|${item.url}`, item]));
    for (const endpoint of input.apiEndpoints) {
      const key = `${endpoint.method ?? ""}|${endpoint.url}`;
      endpointMap.set(key, {
        ...endpointMap.get(key),
        ...endpoint,
        source: endpointMap.get(key)?.source ?? "exploration",
        lastSeenAt: new Date().toISOString()
      });
    }
    discovery.apiEndpoints = [...endpointMap.values()].sort((a, b) => a.url.localeCompare(b.url));
    await this.save(discovery);
    return discovery;
  }

  private filePath(project: string, env: string): string {
    return path.join(this.rootPath, safePathSegment(project), `${safePathSegment(env)}.json`);
  }
}

function safePathSegment(value: string): string {
  return value.replace(/[^\w.-]+/g, "_");
}

export function defaultDiscovery(project: string, env: string): EnvironmentDiscovery {
  return {
    project,
    env,
    updatedAt: new Date().toISOString(),
    domains: [],
    apiEndpoints: [],
    bypassLogin: {
      enabled: true,
      method: "POST",
      path: "/spot/api/bypass/captcha/login_in",
      tokenHeaderName: "token",
      tokenResponsePath: "data.token",
      usernameField: "mobileNumber",
      passwordField: "loginPword",
      extraPayload: {
        token: true
      },
      updatedAt: new Date().toISOString()
    },
    authInjection: {
      storageKeys: ["token", "TOKEN", "userToken", "accessToken", "access_token", "authToken", "Authorization", "loginToken"],
      cookieNames: ["token"],
      updatedAt: new Date().toISOString()
    }
  };
}
