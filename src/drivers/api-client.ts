import { request, type APIRequestContext } from "@playwright/test";
import { maskSecrets } from "../core/secret-manager.js";

export class ApiClient {
  private context?: APIRequestContext;

  constructor(private readonly baseUrl: string) {}

  async init(): Promise<void> {
    this.context = await request.newContext({ baseURL: this.baseUrl });
  }

  async get(path: string, headers: Record<string, string> = {}): Promise<unknown> {
    if (!this.context) await this.init();
    const response = await this.context!.get(path, { headers });
    const body = await response.text();
    if (!response.ok()) {
      throw new Error(
        JSON.stringify({
          method: "GET",
          path,
          status: response.status(),
          headers: maskSecrets(headers),
          body
        })
      );
    }
    return body ? JSON.parse(body) : null;
  }

  async dispose(): Promise<void> {
    await this.context?.dispose();
  }
}
