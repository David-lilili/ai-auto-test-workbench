import test from "node:test";
import assert from "node:assert/strict";
import type { LoadedContext } from "../src/core/types.js";
import { RedisVerificationCodeProvider, maskRedisKey, maskTarget } from "../src/core/verification-code-provider.js";

class FakeRedisClient {
  selectedDb = 0;
  closed = false;

  constructor(
    private readonly data: Record<string, { type: string; value: string | string[] | Record<string, string> }>,
    private readonly failConnect = false
  ) {}

  async connect(): Promise<void> {
    if (this.failConnect) throw new Error("ECONNREFUSED localhost:6379");
  }

  async select(db: number): Promise<void> {
    this.selectedDb = db;
  }

  async type(key: string): Promise<string> {
    return this.data[key]?.type ?? "none";
  }

  async get(key: string): Promise<string | undefined> {
    const item = this.data[key];
    return item?.type === "string" && typeof item.value === "string" ? item.value : undefined;
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    const item = this.data[key];
    return item?.type === "hash" && !Array.isArray(item.value) && typeof item.value === "object" ? item.value : {};
  }

  async lrange(key: string): Promise<string[]> {
    const item = this.data[key];
    return item?.type === "list" && Array.isArray(item.value) ? item.value : [];
  }

  async del(key: string): Promise<number> {
    delete this.data[key];
    return 1;
  }

  close(): void {
    this.closed = true;
  }
}

test("reads a verification code from Redis string value", async () => {
  const data = { "vc:test:login:user@example.com": { type: "string", value: "code=123456" } };
  const provider = fakeProvider(data);
  const result = await provider.get_code({ project: "demo", env: "test", scene: "login", account: "user@example.com", codeType: "email" });
  assert.equal(result.success, true);
  assert.equal(result.code, "123456");
  assert.equal(result.source, "redis");
  assert.equal(result.maskedTarget, "us***@example.com");
  assert.equal(result.metadata?.key, "vc:test:login:us***@example.com");
});

test("polls until timeout when the key does not exist", async () => {
  const provider = fakeProvider({});
  const result = await provider.get_code({
    project: "demo",
    env: "test",
    scene: "login",
    account: "user@example.com",
    codeType: "email",
    timeoutSeconds: 0.03,
    pollIntervalSeconds: 0.01
  });
  assert.equal(result.success, false);
  assert.equal(result.errorCode, "timeout");
});

test("classifies Redis connection failures", async () => {
  const provider = fakeProvider({}, true);
  const result = await provider.get_code({ project: "demo", env: "test", scene: "login", account: "user@example.com", codeType: "email" });
  assert.equal(result.success, false);
  assert.equal(result.errorCode, "connection_failed");
});

test("classifies code format mismatch", async () => {
  const data = { "vc:test:login:user@example.com": { type: "string", value: "code=abcdef" } };
  const provider = fakeProvider(data);
  const result = await provider.get_code({
    project: "demo",
    env: "test",
    scene: "login",
    account: "user@example.com",
    codeType: "email",
    timeoutSeconds: 0.03,
    pollIntervalSeconds: 0.01
  });
  assert.equal(result.success, false);
  assert.equal(result.errorCode, "format_mismatch");
});

test("uses different key patterns for different scenes", async () => {
  const data = {
    "vc:test:login:user@example.com": { type: "string", value: "111111" },
    "vc:test:withdraw:user@example.com": { type: "string", value: "222222" }
  };
  const provider = fakeProvider(data);
  const login = await provider.get_code({ project: "demo", env: "test", scene: "login", account: "user@example.com", codeType: "email" });
  const withdraw = await provider.get_code({ project: "demo", env: "test", scene: "withdraw", account: "user@example.com", codeType: "email" });
  assert.equal(login.code, "111111");
  assert.equal(withdraw.code, "222222");
});

test("uses environment variables in key patterns for different environments", async () => {
  const data = {
    "vc:uat:login:user@example.com": { type: "string", value: "555555" }
  };
  const provider = new RedisVerificationCodeProvider(fakeContext(["string"], "uat"), {
    timeoutMs: 30,
    pollIntervalMs: 10,
    clientFactory: () => new FakeRedisClient(data)
  });
  const result = await provider.get_code({ project: "demo", env: "uat", scene: "login", account: "user@example.com", codeType: "email" });
  assert.equal(result.success, true);
  assert.equal(result.code, "555555");
  assert.equal(result.metadata?.key, "vc:uat:login:us***@example.com");
});

test("deletes verification code after read only when configured", async () => {
  const data = { "vc:test:login:user@example.com": { type: "string", value: "666666" } };
  const provider = new RedisVerificationCodeProvider(fakeContext(["string"], "test", true), {
    timeoutMs: 30,
    pollIntervalMs: 10,
    clientFactory: () => new FakeRedisClient(data)
  });
  const result = await provider.get_code({ project: "demo", env: "test", scene: "login", account: "user@example.com", codeType: "email" });
  assert.equal(result.success, true);
  assert.equal(data["vc:test:login:user@example.com"], undefined);
});

test("supports hash and list Redis storage types", async () => {
  const hashProvider = fakeProvider({ "vc:test:login:user@example.com": { type: "hash", value: { code: "333333" } } }, false, ["hash"]);
  const listProvider = fakeProvider({ "vc:test:login:user@example.com": { type: "list", value: ["noop", "444444"] } }, false, ["list"]);
  const hash = await hashProvider.get_code({ project: "demo", env: "test", scene: "login", account: "user@example.com", codeType: "email" });
  const list = await listProvider.get_code({ project: "demo", env: "test", scene: "login", account: "user@example.com", codeType: "email" });
  assert.equal(hash.code, "333333");
  assert.equal(list.code, "444444");
});

test("mask helpers do not expose full target or code-like key content", () => {
  assert.equal(maskTarget("13812345678"), "138****5678");
  assert.equal(maskTarget("user@example.com"), "us***@example.com");
  assert.equal(maskRedisKey("sms:test:login:13812345678"), "sms:test:login:138****5678");
});

function fakeProvider(
  data: Record<string, { type: string; value: string | string[] | Record<string, string> }>,
  failConnect = false,
  valueTypes: Array<"string" | "hash" | "list"> = ["string", "hash", "list"]
): RedisVerificationCodeProvider {
  return new RedisVerificationCodeProvider(fakeContext(valueTypes), {
    timeoutMs: 30,
    pollIntervalMs: 10,
    clientFactory: () => new FakeRedisClient(data, failConnect)
  });
}

function fakeContext(valueTypes: Array<"string" | "hash" | "list">, envName = "test", deleteAfterRead = false): LoadedContext {
  return {
    rootDir: process.cwd(),
    workspace: { workspaceName: "test", defaultProject: "demo", defaultEnv: "test", artifactRoot: "artifacts", reportRoot: "reports" },
    project: { projectKey: "demo", projectName: "Demo", owners: [], enabledTestTypes: ["web"], defaultEnv: "test", report: {}, failureArtifacts: {} },
    env: {
      env: envName,
      redis: {
        enabled: true,
        services: {
          spot: {
            mode: "standalone",
            externalSeeds: [{ host: "localhost", port: 6379 }],
            verificationCodes: {
              db: 0,
              pollTimeoutMs: 30,
              pollIntervalMs: 10,
              codeRegex: "\\b\\d{6}\\b",
              valueTypes,
              deleteAfterRead,
              scenes: {
                login: { codeType: "email", keyPatterns: [{ name: "login", key: "vc:{env}:login:{account}" }] },
                withdraw: { codeType: "email", keyPatterns: [{ name: "withdraw", key: "vc:{env}:withdraw:{account}" }] }
              }
            }
          }
        }
      },
      safety: { productionReadonly: false, writeActionsAllowed: true }
    }
  };
}
