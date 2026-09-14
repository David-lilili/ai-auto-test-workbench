import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveBrowserRuntimeConfig } from "../src/core/browser-runtime.js";

test("resolves default Playwright Chromium runtime", () => {
  const old = { ...process.env };
  delete process.env.AI_AUTOTEST_BROWSER;
  delete process.env.AI_AUTOTEST_BROWSER_HEADLESS;
  try {
    const config = resolveBrowserRuntimeConfig({ headed: false });
    assert.equal(config.kind, "playwright-chromium");
    assert.equal(config.headless, true);
  } finally {
    process.env = old;
  }
});

test("resolves system Chrome and headed mode from environment", () => {
  const old = { ...process.env };
  process.env.AI_AUTOTEST_BROWSER = "system-chrome";
  process.env.AI_AUTOTEST_BROWSER_HEADLESS = "false";
  process.env.AI_AUTOTEST_CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  try {
    const config = resolveBrowserRuntimeConfig({ headed: false });
    assert.equal(config.kind, "system-chrome");
    assert.equal(config.headless, false);
    assert.equal(config.chromePath, "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe");
  } finally {
    process.env = old;
  }
});

test("resolves CDP endpoint from remote debugging port", () => {
  const old = { ...process.env };
  process.env.AI_AUTOTEST_BROWSER = "cdp";
  process.env.AI_AUTOTEST_REMOTE_DEBUGGING_PORT = "9222";
  try {
    const config = resolveBrowserRuntimeConfig({ headed: true });
    assert.equal(config.kind, "cdp-existing-chrome");
    assert.equal(config.cdpEndpoint, "http://127.0.0.1:9222");
  } finally {
    process.env = old;
  }
});
