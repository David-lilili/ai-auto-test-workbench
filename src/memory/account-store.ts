import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import fs from "fs-extra";
import type { LoadedContext, TestAccount, TestAccountStore } from "../core/types.js";

type SqliteDatabase = {
  exec(sql: string): void;
  prepare(sql: string): {
    all(...values: unknown[]): unknown[];
    get(...values: unknown[]): unknown;
    run(...values: unknown[]): unknown;
  };
  close(): void;
};

interface AccountRow {
  id: string;
  project: string;
  env: string;
  username: string;
  password: string;
  label?: string | null;
  created_at: string;
  updated_at: string;
}

// 项目改名迁移表：从旧 project key 迁移账号到新 key。公开版无默认别名，接入方按需配置。
const PROJECT_KEY_ALIASES: Record<string, string> = {};

export class AccountStore {
  private readonly jsonPath: string;
  private readonly sqlitePath: string;

  constructor(private readonly context: LoadedContext) {
    const jsonConfigured = context.workspace.storage?.accountsPath ?? "storage/accounts.json";
    const sqliteConfigured = context.workspace.storage?.sqlitePath ?? "storage/workbench.sqlite";
    this.jsonPath = path.join(context.rootDir, jsonConfigured);
    this.sqlitePath = path.join(context.rootDir, sqliteConfigured);
  }

  async load(): Promise<TestAccountStore> {
    const accounts = await this.list();
    return { updatedAt: new Date().toISOString(), accounts };
  }

  async save(store: TestAccountStore): Promise<string> {
    const database = await this.openDatabase();
    try {
      database.exec("DELETE FROM test_accounts");
      for (const account of dedupeAccounts(store.accounts)) {
        database
          .prepare(
            `INSERT INTO test_accounts
              (id, project, env, username, password, label, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            account.id,
            account.project,
            account.env,
            account.username,
            account.password,
            account.label ?? null,
            account.createdAt,
            account.updatedAt
          );
      }
    } finally {
      database.close();
    }
    return this.sqlitePath;
  }

  async list(filters?: { project?: string; env?: string; username?: string }): Promise<TestAccount[]> {
    const database = await this.openDatabase();
    try {
      const where: string[] = [];
      const values: unknown[] = [];
      if (filters?.project) {
        where.push("project = ?");
        values.push(filters.project);
      }
      if (filters?.env) {
        where.push("env = ?");
        values.push(filters.env);
      }
      if (filters?.username) {
        where.push("lower(username) LIKE ?");
        values.push(`%${filters.username.toLowerCase()}%`);
      }
      const rows = database
        .prepare(
          `SELECT id, project, env, username, password, label, created_at, updated_at
           FROM test_accounts
           ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
           ORDER BY updated_at DESC`
        )
        .all(...values) as AccountRow[];
      return rows.map(rowToAccount);
    } finally {
      database.close();
    }
  }

  async upsert(input: {
    id?: string;
    project: string;
    env: string;
    username: string;
    password: string;
    label?: string;
  }): Promise<TestAccount> {
    const database = await this.openDatabase();
    try {
      const now = new Date().toISOString();
      const existingById = input.id
        ? (database
            .prepare("SELECT id, project, env, username, password, label, created_at, updated_at FROM test_accounts WHERE id = ?")
            .get(input.id) as AccountRow | undefined)
        : undefined;
      const duplicate = database
        .prepare(
          "SELECT id, project, env, username, password, label, created_at, updated_at FROM test_accounts WHERE project = ? AND env = ? AND username = ?"
        )
        .get(input.project, input.env, input.username) as AccountRow | undefined;
      const target = existingById ?? duplicate;
      const nextId = stableId(`${input.project}|${input.env}|${input.username}`);

      if (target) {
        if (target.id !== nextId) {
          database.prepare("DELETE FROM test_accounts WHERE id = ?").run(target.id);
        }
        database
          .prepare(
            `INSERT INTO test_accounts
              (id, project, env, username, password, label, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
              project = excluded.project,
              env = excluded.env,
              username = excluded.username,
              password = excluded.password,
              label = excluded.label,
              updated_at = excluded.updated_at`
          )
          .run(
            nextId,
            input.project,
            input.env,
            input.username,
            input.password,
            input.label ?? null,
            target.created_at,
            now
          );
        return {
          id: nextId,
          project: input.project,
          env: input.env,
          username: input.username,
          password: input.password,
          label: input.label,
          createdAt: target.created_at,
          updatedAt: now
        };
      }

      const account: TestAccount = {
        id: nextId,
        project: input.project,
        env: input.env,
        username: input.username,
        password: input.password,
        label: input.label,
        createdAt: now,
        updatedAt: now
      };
      database
        .prepare(
          `INSERT INTO test_accounts
            (id, project, env, username, password, label, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          account.id,
          account.project,
          account.env,
          account.username,
          account.password,
          account.label ?? null,
          account.createdAt,
          account.updatedAt
        );
      return account;
    } finally {
      database.close();
    }
  }

  async seedDefaults(): Promise<void> {
    await this.openDatabase().then((database) => database.close());
  }

  private async openDatabase(): Promise<SqliteDatabase> {
    await fs.ensureDir(path.dirname(this.sqlitePath));
    const require = createRequire(import.meta.url);
    const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (filename: string) => SqliteDatabase };
    const database = new DatabaseSync(this.sqlitePath);
    database.exec(`
      CREATE TABLE IF NOT EXISTS test_accounts (
        id TEXT PRIMARY KEY,
        project TEXT NOT NULL,
        env TEXT NOT NULL,
        username TEXT NOT NULL,
        password TEXT NOT NULL,
        label TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(project, env, username)
      );
      CREATE INDEX IF NOT EXISTS idx_test_accounts_project_env ON test_accounts(project, env);
    `);
    await this.migrateJsonAccounts(database);
    this.migrateProjectAliases(database);
    return database;
  }

  private async migrateJsonAccounts(database: SqliteDatabase): Promise<void> {
    const count = database.prepare("SELECT COUNT(*) AS count FROM test_accounts").get() as { count: number };
    if (count.count > 0 || !(await fs.pathExists(this.jsonPath))) return;
    const store = (await fs.readJson(this.jsonPath)) as TestAccountStore;
    for (const account of dedupeAccounts(store.accounts ?? [])) {
      database
        .prepare(
          `INSERT OR IGNORE INTO test_accounts
            (id, project, env, username, password, label, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          account.id,
          account.project,
          account.env,
          account.username,
          account.password,
          account.label ?? null,
          account.createdAt,
          account.updatedAt
        );
    }
  }

  private migrateProjectAliases(database: SqliteDatabase): void {
    const now = new Date().toISOString();
    for (const [fromProject, toProject] of Object.entries(PROJECT_KEY_ALIASES)) {
      const rows = database
        .prepare("SELECT id, project, env, username, password, label, created_at, updated_at FROM test_accounts WHERE project = ?")
        .all(fromProject) as AccountRow[];
      for (const row of rows) {
        const nextId = stableId(`${toProject}|${row.env}|${row.username}`);
        database
          .prepare(
            `INSERT INTO test_accounts
              (id, project, env, username, password, label, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(project, env, username) DO UPDATE SET
              password = excluded.password,
              label = excluded.label,
              updated_at = excluded.updated_at`
          )
          .run(nextId, toProject, row.env, row.username, row.password, row.label ?? null, row.created_at, now);
      }
    }
  }
}

function rowToAccount(row: AccountRow): TestAccount {
  return {
    id: row.id,
    project: row.project,
    env: row.env,
    username: row.username,
    password: row.password,
    label: row.label ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function dedupeAccounts(accounts: TestAccount[]): TestAccount[] {
  const seen = new Set<string>();
  return accounts.filter((account) => {
    const key = `${account.project}|${account.env}|${account.username}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function stableId(value: string): string {
  return crypto.createHash("sha1").update(value).digest("hex").slice(0, 16);
}
