import { chromium, type Browser, type Page } from "@playwright/test";

export class WebDriver {
  private browser?: Browser;
  private page?: Page;

  async open(baseUrl: string, headed = false): Promise<Page> {
    this.browser = await chromium.launch({ headless: !headed });
    this.page = await this.browser.newPage();
    await this.page.goto(baseUrl);
    return this.page;
  }

  async close(): Promise<void> {
    await this.page?.close().catch(() => undefined);
    await this.browser?.close().catch(() => undefined);
  }
}
