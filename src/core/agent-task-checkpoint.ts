/**
 * Development Agent 持久任务状态（AI Development Token Efficiency Hardening, items 2/3/6）。
 *
 * - TaskIdentity：每个 Development Task 必须有的身份（taskId/project/phase/objective/specHash/repoHead）。
 * - TaskCheckpoint：任务的持久快照，保存在 .runtime/agent-state/checkpoints/<taskId>.json，
 *   禁止把 conversation 当作唯一 task state。
 * - rollover：CHECKPOINT → HANDOFF（AI_START_HERE markdown）→ NEW SESSION，新会话只加载
 *   TaskCheckpoint + Relevant ContextPack + Current diff + Current error，禁止重载整段历史。
 */

import fs from "fs-extra";
import path from "node:path";
import { createHash } from "node:crypto";

export const AGENT_STATE_DIR = ".runtime/agent-state";
export const CHECKPOINT_SCHEMA_VERSION = "agent-task-checkpoint.v1";

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** item 2：任务身份。specHash 来自 phase spec 原文（只解析一次的依据）。 */
export interface TaskIdentity {
  taskId: string;
  project: string;
  phase: string;
  objective: string;
  specHash: string;
  repoHead: string;
}

export function deriveSpecHash(specText: string): string {
  return sha256Hex(specText.replace(/\r\n/g, "\n").trim());
}

export interface CompletedStep {
  stepId: string;
  summary: string;
  completedAt: string;
  evidenceRef?: string;
}

export interface Blocker {
  signature: string;
  detail: string;
  addedAt: string;
}

export interface DecisionRecord {
  decision: string;
  rationale: string;
  madeAt: string;
}

export interface EvidenceRecord {
  key: string;
  reference: string;
  capturedAt: string;
}

export interface ToolResultSnapshot {
  command: string;
  status: "ok" | "failed";
  summary: string;
  at: string;
}

/** item 3：任务检查点（.runtime/agent-state/checkpoints/<taskId>.json）。 */
export interface TaskCheckpoint {
  schemaVersion: typeof CHECKPOINT_SCHEMA_VERSION;
  taskId: string;
  project: string;
  phase: string;
  objective: string;
  specHash: string;
  repoHeadAtStart: string;
  repoHeadAtLastUpdate: string;
  constraints: string[];
  completedSteps: CompletedStep[];
  currentStep: string | null;
  nextAction: string | null;
  blockers: Blocker[];
  filesTouched: string[];
  decisions: DecisionRecord[];
  importantEvidence: EvidenceRecord[];
  lastToolResult: ToolResultSnapshot | null;
  lastErrorSignature: string | null;
  lastSuccessfulCommand: string | null;
  updatedAt: string;
}

export function createCheckpoint(identity: TaskIdentity, constraints: string[] = []): TaskCheckpoint {
  const now = new Date().toISOString();
  return {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    taskId: identity.taskId,
    project: identity.project,
    phase: identity.phase,
    objective: identity.objective,
    specHash: identity.specHash,
    repoHeadAtStart: identity.repoHead,
    repoHeadAtLastUpdate: identity.repoHead,
    constraints,
    completedSteps: [],
    currentStep: null,
    nextAction: identity.objective,
    blockers: [],
    filesTouched: [],
    decisions: [],
    importantEvidence: [],
    lastToolResult: null,
    lastErrorSignature: null,
    lastSuccessfulCommand: null,
    updatedAt: now
  };
}

export class TaskCheckpointStore {
  private readonly dir: string;

  constructor(rootDir: string) {
    this.dir = path.join(rootDir, AGENT_STATE_DIR, "checkpoints");
  }

  private fileFor(taskId: string): string {
    const safe = taskId.replace(/[^A-Za-z0-9._-]/g, "_");
    return path.join(this.dir, `${safe}.json`);
  }

  async save(checkpoint: TaskCheckpoint): Promise<void> {
    checkpoint.updatedAt = new Date().toISOString();
    fs.ensureDirSync(this.dir);
    await fs.writeJson(this.fileFor(checkpoint.taskId), checkpoint, { spaces: 2 });
  }

  async load(taskId: string): Promise<TaskCheckpoint | null> {
    const file = this.fileFor(taskId);
    if (!(await fs.pathExists(file))) return null;
    try {
      const data = (await fs.readJson(file)) as TaskCheckpoint;
      if (data.schemaVersion !== CHECKPOINT_SCHEMA_VERSION) return null;
      return data;
    } catch {
      return null;
    }
  }

  async list(): Promise<TaskCheckpoint[]> {
    fs.ensureDirSync(this.dir);
    const files = await fs.readdir(this.dir);
    const checkpoints: TaskCheckpoint[] = [];
    for (const file of files.filter((name) => name.endsWith(".json"))) {
      try {
        const data = (await fs.readJson(path.join(this.dir, file))) as TaskCheckpoint;
        if (data.schemaVersion === CHECKPOINT_SCHEMA_VERSION) checkpoints.push(data);
      } catch {
        // 跳过损坏文件。
      }
    }
    return checkpoints.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async remove(taskId: string): Promise<void> {
    const file = this.fileFor(taskId);
    if (await fs.pathExists(file)) await fs.remove(file);
  }
}

/** 便捷更新器：只改字段的只读更新，避免手写深拷贝。 */
export function withCheckpointUpdates(checkpoint: TaskCheckpoint, updates: Partial<Omit<TaskCheckpoint, "schemaVersion" | "taskId" | "project" | "phase" | "objective" | "specHash" | "repoHeadAtStart" | "updatedAt">>): TaskCheckpoint {
  return { ...checkpoint, ...updates, updatedAt: new Date().toISOString() };
}

/**
 * item 6：生成 AI_START_HERE 交接文档（新会话唯一必读的 task 上下文）。
 * 只包含：身份 / 当前步 / 下一步 / 约束 / 已完步骤摘要 / blockers / decisions / 最近工具结果与错误签名。
 * 明确禁止加载：整段历史 conversation。
 */
export function buildHandoffMarkdown(checkpoint: TaskCheckpoint, extraSections: Array<{ title: string; body: string }> = []): string {
  const lines: string[] = [
    "# AI_START_HERE — Development Task Handoff",
    "",
    `- taskId: ${checkpoint.taskId}`,
    `- project: ${checkpoint.project}`,
    `- phase: ${checkpoint.phase}`,
    `- specHash: ${checkpoint.specHash}`,
    `- repoHeadAtStart: ${checkpoint.repoHeadAtStart}`,
    `- repoHeadAtLastUpdate: ${checkpoint.repoHeadAtLastUpdate}`,
    `- updatedAt: ${checkpoint.updatedAt}`,
    "",
    "## Objective",
    "",
    checkpoint.objective,
    ""
  ];
  if (checkpoint.constraints.length > 0) {
    lines.push("## Constraints", "");
    for (const constraint of checkpoint.constraints) lines.push(`- ${constraint}`);
    lines.push("");
  }
  lines.push("## Current Step", "", checkpoint.currentStep ?? "(none)", "");
  lines.push("## Next Action", "", checkpoint.nextAction ?? "(none)", "");
  if (checkpoint.completedSteps.length > 0) {
    lines.push("## Completed Steps", "");
    for (const step of checkpoint.completedSteps) {
      lines.push(`- [${step.stepId}] ${step.summary}${step.evidenceRef ? ` (evidence: ${step.evidenceRef})` : ""}`);
    }
    lines.push("");
  }
  if (checkpoint.blockers.length > 0) {
    lines.push("## Blockers", "");
    for (const blocker of checkpoint.blockers) {
      lines.push(`- ${blocker.signature}: ${blocker.detail}`);
    }
    lines.push("");
  }
  if (checkpoint.decisions.length > 0) {
    lines.push("## Decisions", "");
    for (const decision of checkpoint.decisions) {
      lines.push(`- ${decision.decision} — ${decision.rationale}`);
    }
    lines.push("");
  }
  if (checkpoint.importantEvidence.length > 0) {
    lines.push("## Key Evidence", "");
    for (const evidence of checkpoint.importantEvidence) {
      lines.push(`- ${evidence.key}: ${evidence.reference}`);
    }
    lines.push("");
  }
  if (checkpoint.lastToolResult) {
    lines.push("## Last Tool Result", "", `- command: ${checkpoint.lastToolResult.command}`);
    lines.push(`- status: ${checkpoint.lastToolResult.status}`);
    lines.push(`- summary: ${checkpoint.lastToolResult.summary}`);
    lines.push("");
  }
  lines.push(`## Last Error Signature`, "", checkpoint.lastErrorSignature ?? "(none)", "");
  lines.push(`## Last Successful Command`, "", checkpoint.lastSuccessfulCommand ?? "(none)", "");
  for (const section of extraSections) {
    lines.push(`## ${section.title}`, "", section.body, "");
  }
  lines.push("---", "", "> 本会话禁止重新加载整段历史 conversation。后续 LLM request 只加载本 Handoff + Context Pack + Current diff + Current error。");
  return lines.join("\n");
}
