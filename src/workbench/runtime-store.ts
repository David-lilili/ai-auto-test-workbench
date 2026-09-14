import { createRequire } from "node:module";
import fs from "fs-extra";
import path from "node:path";
import { logger } from "../core/logger.js";

/**
 * 运行态数据 repository（M2）：runtime.sqlite 承接追加型、查询型、事务型数据。
 *
 * 边界：
 * - 执行级知识资产（page-models / operation-manuals 等）不进库，仍在 git JSON；
 * - 本库只放运行态：proposal 审核队列、审核审计、DSL 诊断索引；
 * - JSON 仍是写入方的事实源（file -> sqlite 单向镜像），审核动作双写（JSON 为准），
 *   避免迁移期间行为分叉；后续写入方逐步切到 sqlite 后再收窄。
 */

type SqliteStatement = { run(...params: unknown[]): unknown; all(...params: unknown[]): unknown[]; get(...params: unknown[]): unknown };
type SqliteDatabase = {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
};

export interface RuntimeProposalRow {
  proposalId: string;
  status: string;
  createdAt: string;
  project: string;
  env: string;
  proposalType: string;
  failureStage: string | null;
  reason: string | null;
  userRequest: string | null;
  reviewedAt: string | null;
  reviewedBy: string | null;
  reviewNote: string | null;
  sourceFile: string | null;
}

export interface RuntimeReviewLogRow {
  id: number;
  reviewedAt: string;
  proposalId: string;
  project: string;
  env: string;
  proposalType: string;
  action: string;
  reviewedBy: string;
  note: string | null;
  previousStatus: string;
  newStatus: string;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS proposals (
    proposal_id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    project TEXT NOT NULL,
    env TEXT NOT NULL DEFAULT 'test',
    proposal_type TEXT NOT NULL DEFAULT 'unknown',
    failure_stage TEXT,
    reason TEXT,
    user_request TEXT,
    reviewed_at TEXT,
    reviewed_by TEXT,
    review_note TEXT,
    source_file TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_proposals_project_status ON proposals(project, status);
  CREATE INDEX IF NOT EXISTS idx_proposals_created_at ON proposals(created_at DESC);
  CREATE TABLE IF NOT EXISTS review_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reviewed_at TEXT NOT NULL,
    proposal_id TEXT NOT NULL,
    project TEXT NOT NULL,
    env TEXT NOT NULL DEFAULT 'test',
    proposal_type TEXT NOT NULL DEFAULT 'unknown',
    action TEXT NOT NULL,
    reviewed_by TEXT NOT NULL,
    note TEXT,
    previous_status TEXT NOT NULL,
    new_status TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_review_log_proposal ON review_log(proposal_id);
  CREATE TABLE IF NOT EXISTS runtime_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;

export class RuntimeStore {
  private readonly dbPath: string;

  constructor(rootDir: string) {
    this.dbPath = path.join(rootDir, "storage", "runtime.sqlite");
  }

  private open(): SqliteDatabase {
    fs.ensureDirSync(path.dirname(this.dbPath));
    const require = createRequire(import.meta.url);
    const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (filename: string, options?: Record<string, unknown>) => SqliteDatabase };
    const database = new DatabaseSync(this.dbPath);
    database.exec(SCHEMA);
    return database;
  }

  async withDatabase<T>(fn: (database: SqliteDatabase) => T): Promise<T> {
    const database = this.open();
    try {
      return fn(database);
    } finally {
      database.close();
    }
  }

  /** 把 proposals 目录（pending/approved/rejected）镜像进 sqlite；幂等，可重复执行。 */
  async syncProposalsFromFiles(): Promise<{ pending: number; approved: number; rejected: number }> {
    const rootDir = path.dirname(path.dirname(this.dbPath));
    const counts = { pending: 0, approved: 0, rejected: 0 };
    const scopes = ["pending", "approved", "rejected"] as const;
    const statusByScope = { pending: "pending_review", approved: "approved", rejected: "rejected" } as const;
    for (const scope of scopes) {
      const dir = path.join(rootDir, "storage", "proposals", scope);
      if (!(await fs.pathExists(dir))) continue;
      const files = (await fs.readdir(dir)).filter((file) => file.endsWith(".json"));
      for (const file of files) {
        const record = await fs.readJson(path.join(dir, file)).catch(() => undefined) as Record<string, unknown> | undefined;
        if (!record) continue;
        await this.upsertProposal({
          proposalId: String(record.proposalId ?? file.replace(/\.json$/, "")),
          status: String(record.status ?? statusByScope[scope]),
          createdAt: String(record.createdAt ?? ""),
          project: String(record.project ?? ""),
          env: String(record.env ?? "test"),
          proposalType: String(record.proposalType ?? "unknown"),
          failureStage: typeof record.failureStage === "string" ? record.failureStage : null,
          reason: typeof record.reason === "string" ? record.reason : null,
          userRequest: typeof record.userRequest === "string" ? record.userRequest : null,
          reviewedAt: typeof record.reviewedAt === "string" ? record.reviewedAt : null,
          reviewedBy: typeof record.reviewedBy === "string" ? record.reviewedBy : null,
          reviewNote: typeof record.reviewNote === "string" ? record.reviewNote : null,
          sourceFile: path.join("storage", "proposals", scope, file).replace(/\\/g, "/")
        });
        counts[scope] += 1;
      }
    }
    logger.info("Runtime store synced from proposal files", counts);
    return counts;
  }

  async upsertProposal(row: RuntimeProposalRow): Promise<void> {
    await this.withDatabase((database) => {
      database.prepare(`
        INSERT INTO proposals (proposal_id, status, created_at, project, env, proposal_type, failure_stage, reason, user_request, reviewed_at, reviewed_by, review_note, source_file)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(proposal_id) DO UPDATE SET
          status = excluded.status,
          reviewed_at = excluded.reviewed_at,
          reviewed_by = excluded.reviewed_by,
          review_note = excluded.review_note,
          source_file = excluded.source_file
      `).run(
        row.proposalId, row.status, row.createdAt, row.project, row.env, row.proposalType,
        row.failureStage, row.reason, row.userRequest, row.reviewedAt, row.reviewedBy, row.reviewNote, row.sourceFile
      );
    });
  }

  async listProposals(filter: { project?: string; status?: string; proposalType?: string; limit?: number }): Promise<RuntimeProposalRow[]> {
    return this.withDatabase((database) => {
      const conditions: string[] = [];
      const params: unknown[] = [];
      if (filter.project) {
        conditions.push("project = ?");
        params.push(filter.project);
      }
      if (filter.status) {
        conditions.push("status = ?");
        params.push(filter.status);
      }
      if (filter.proposalType) {
        conditions.push("proposal_type = ?");
        params.push(filter.proposalType);
      }
      const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
      const limit = Math.max(1, Math.min(filter.limit ?? 100, 500));
      const rows = database.prepare(`
        SELECT proposal_id AS proposalId, status, created_at AS createdAt, project, env,
               proposal_type AS proposalType, failure_stage AS failureStage, reason, user_request AS userRequest,
               reviewed_at AS reviewedAt, reviewed_by AS reviewedBy, review_note AS reviewNote, source_file AS sourceFile
        FROM proposals ${where}
        ORDER BY created_at DESC
        LIMIT ${limit}
      `).all(...params);
      return rows as RuntimeProposalRow[];
    });
  }

  async countProposalsByStatus(project?: string): Promise<Record<string, number>> {
    return this.withDatabase((database) => {
      const rows = project
        ? database.prepare("SELECT status, COUNT(*) AS count FROM proposals WHERE project = ? GROUP BY status").all(project)
        : database.prepare("SELECT status, COUNT(*) AS count FROM proposals GROUP BY status").all();
      const result: Record<string, number> = {};
      for (const row of rows as Array<{ status: string; count: number }>) {
        result[row.status] = row.count;
      }
      return result;
    });
  }

  async appendReviewLog(entry: Omit<RuntimeReviewLogRow, "id">): Promise<void> {
    await this.withDatabase((database) => {
      database.prepare(`
        INSERT INTO review_log (reviewed_at, proposal_id, project, env, proposal_type, action, reviewed_by, note, previous_status, new_status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        entry.reviewedAt, entry.proposalId, entry.project, entry.env, entry.proposalType,
        entry.action, entry.reviewedBy, entry.note, entry.previousStatus, entry.newStatus
      );
    });
  }

  async listReviewLog(filter: { proposalId?: string; limit?: number }): Promise<RuntimeReviewLogRow[]> {
    return this.withDatabase((database) => {
      const limit = Math.max(1, Math.min(filter.limit ?? 50, 500));
      if (filter.proposalId) {
        return database.prepare(`
          SELECT id, reviewed_at AS reviewedAt, proposal_id AS proposalId, project, env,
                 proposal_type AS proposalType, action, reviewed_by AS reviewedBy, note,
                 previous_status AS previousStatus, new_status AS newStatus
          FROM review_log WHERE proposal_id = ? ORDER BY id DESC LIMIT ${limit}
        `).all(filter.proposalId) as RuntimeReviewLogRow[];
      }
      return database.prepare(`
        SELECT id, reviewed_at AS reviewedAt, proposal_id AS proposalId, project, env,
               proposal_type AS proposalType, action, reviewed_by AS reviewedBy, note,
               previous_status AS previousStatus, new_status AS newStatus
        FROM review_log ORDER BY id DESC LIMIT ${limit}
      `).all() as RuntimeReviewLogRow[];
    });
  }
}
