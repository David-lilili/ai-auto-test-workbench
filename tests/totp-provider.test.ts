import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "fs-extra";
import { checkTotpReadiness, classifyTotpReadinessError, registerKeePassXcTotpEntry } from "../src/core/totp-provider.js";
import type { LoadedContext } from "../src/core/types.js";

test("KeePassXC registration distinguishes native TOTP from Notes fallback", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "keepassxc-fallback-"));
  const cliPath = await writeFakeKeePassXcCli(rootDir);
  const databasePath = path.join(rootDir, "test.kdbx");
  await fs.ensureDir(path.join(rootDir, "storage"));
  await fs.writeFile(databasePath, "fake database", "utf8");
  await fs.writeJson(path.join(rootDir, "storage", "secrets.local.json"), {
    keepassxc: {
      demo: {
        test: {
          databasePassword: "secret"
        }
      }
    }
  });

  const result = await registerKeePassXcTotpEntry(contextFor(rootDir, cliPath, databasePath), {
    account: "user@example.com",
    secret: "JBSWY3DPEHPK3PXP",
    issuer: "DEMO"
  });

  assert.equal(result.entry, "Demo/Test/user@example.com");
  assert.equal(result.verified, true);
  assert.equal(result.providerReadable, true);
  assert.equal(result.nativeTotpRegistered, false);
  assert.equal(result.fallbackOtpUriRegistered, true);
  assert.equal(result.registrationMode, "notes_fallback");
});

test("TOTP readiness safely reports provider configuration gaps", async () => {
  const readiness = await checkTotpReadiness(contextForMissingTotpConfig(), {
    account: "user@example.com"
  });

  assert.equal(readiness.ready, false);
  assert.equal(readiness.status, "provider_not_configured");
});

test("TOTP readiness error classification masks unreadable provider state", () => {
  assert.equal(classifyTotpReadinessError(new Error("KeePassXC TOTP entry is missing.")).status, "entry_missing");
  assert.equal(classifyTotpReadinessError(new Error("KeePassXC database unlock failed; check the master password.")).status, "database_unlock_failed");
  assert.equal(classifyTotpReadinessError(new Error("TOTP provider is not implemented yet: bitwarden")).status, "provider_unimplemented");
});

async function writeFakeKeePassXcCli(rootDir: string): Promise<string> {
  if (process.platform === "win32") {
    const filePath = path.join(rootDir, "keepassxc-cli.cmd");
    await fs.writeFile(filePath, [
      "@echo off",
      "set args=%*",
      "echo %args% | findstr /C:\"show -q\" >nul && (echo Cannot find entry 1>&2 & exit /b 1)",
      "echo %args% | findstr /C:\"show --totp\" >nul && (echo Cannot find current TOTP 1>&2 & exit /b 1)",
      "echo %args% | findstr /C:\"show --show-protected --attributes Notes\" >nul && (echo Managed by test & echo otpauth://totp/DEMO:user@example.com?secret=JBSWY3DPEHPK3PXP & exit /b 0)",
      "echo %args% | findstr /C:\"mkdir\" >nul && exit /b 0",
      "echo %args% | findstr /C:\"add\" >nul && exit /b 0",
      "exit /b 0",
      ""
    ].join("\r\n"), "utf8");
    return filePath;
  }

  const filePath = path.join(rootDir, "keepassxc-cli");
  await fs.writeFile(filePath, [
    "#!/usr/bin/env sh",
    "args=\"$*\"",
    "case \"$args\" in",
    "  *\"show -q\"*) echo 'Cannot find entry' >&2; exit 1 ;;",
    "  *\"show --totp\"*) echo 'Cannot find current TOTP' >&2; exit 1 ;;",
    "  *\"show --show-protected --attributes Notes\"*) printf '%s\\n%s\\n' 'Managed by test' 'otpauth://totp/DEMO:user@example.com?secret=JBSWY3DPEHPK3PXP'; exit 0 ;;",
    "  *mkdir*) exit 0 ;;",
    "  *add*) exit 0 ;;",
    "esac",
    "exit 0",
    ""
  ].join("\n"), "utf8");
  await fs.chmod(filePath, 0o755);
  return filePath;
}

function contextFor(rootDir: string, cliPath: string, databasePath: string): LoadedContext {
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
    env: {
      env: "test",
      mfa: {
        totp: {
          defaultProvider: "keepassxc",
          providers: {
            keepassxc: {
              cliPath,
              databasePath,
              databasePasswordSecret: "keepassxc.demo.test.databasePassword",
              entryRoot: "Demo/Test",
              timeoutMs: 10000
            }
          }
        }
      }
    }
  };
}

function contextForMissingTotpConfig(): LoadedContext {
  return {
    rootDir: process.cwd(),
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
      projectName: "Demo",
      owners: [],
      enabledTestTypes: ["web"],
      defaultEnv: "test",
      report: {},
      failureArtifacts: {}
    },
    env: { env: "test" }
  };
}
