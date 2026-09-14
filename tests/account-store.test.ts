import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "fs-extra";
import { AccountStore } from "../src/memory/account-store.js";
import type { LoadedContext } from "../src/core/types.js";

test("migrates legacy demo accounts to demo for renamed project execution", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "account-store-alias-"));
  await fs.ensureDir(path.join(rootDir, "storage"));
  await fs.writeJson(path.join(rootDir, "storage", "accounts.json"), {
    updatedAt: "2026-08-03T00:00:00.000Z",
    accounts: [
      {
        id: "legacy",
        project: "demo",
        env: "test",
        username: "user@example.com",
        password: "secret",
        label: "legacy account",
        createdAt: "2026-08-03T00:00:00.000Z",
        updatedAt: "2026-08-03T00:00:00.000Z"
      }
    ]
  });

  const store = new AccountStore(contextFor(rootDir));
  await store.seedDefaults();

  const migrated = await store.list({ project: "demo", env: "test" });
  assert.equal(migrated.length, 1);
  assert.equal(migrated[0].username, "user@example.com");
  assert.equal(migrated[0].password, "secret");
});

function contextFor(rootDir: string): LoadedContext {
  return {
    rootDir,
    workspace: {
      workspaceName: "test",
      defaultProject: "demo",
      defaultEnv: "test",
      artifactRoot: "artifacts",
      reportRoot: "reports",
      storage: {
        sqlitePath: "storage/workbench.sqlite",
        accountsPath: "storage/accounts.json"
      }
    },
    project: {
      projectKey: "demo",
      projectName: "demo",
      owners: [],
      enabledTestTypes: ["web"],
      defaultEnv: "test",
      report: {},
      failureArtifacts: {}
    },
    env: { env: "test" }
  };
}
