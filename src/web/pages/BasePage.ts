import type { Page } from "@playwright/test";

export abstract class BasePage {
  constructor(protected readonly page: Page) {}

  async screenshot(name: string): Promise<Buffer> {
    return this.page.screenshot({ fullPage: true, path: `artifacts/screenshots/${name}.png` });
  }
}
