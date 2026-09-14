import path from "node:path";
import fs from "fs-extra";
import type { AIUsage, ExecutionRun, FailureReport, LoadedContext, StepExecution } from "../core/types.js";
import { writeSafeJsonFile } from "../core/safe-file-writer.js";

interface ExecutionStoreData {
  updatedAt: string;
  runs: ExecutionRun[];
  steps: StepExecution[];
  aiUsages: AIUsage[];
  failureReports: FailureReport[];
}

export class ExecutionStore {
  private readonly filePath: string;

  constructor(private readonly context: LoadedContext) {
    this.filePath = path.join(context.rootDir, "storage", "execution", `${context.project.projectKey}.json`);
  }

  async load(): Promise<ExecutionStoreData> {
    if (!(await fs.pathExists(this.filePath))) {
      return { updatedAt: new Date().toISOString(), runs: [], steps: [], aiUsages: [], failureReports: [] };
    }
    return (await fs.readJson(this.filePath)) as ExecutionStoreData;
  }

  async save(data: ExecutionStoreData): Promise<string> {
    data.updatedAt = new Date().toISOString();
    await writeSafeJsonFile(this.filePath, data);
    return this.filePath;
  }

  async upsertRun(run: ExecutionRun): Promise<void> {
    const data = await this.load();
    const index = data.runs.findIndex((item) => item.run_id === run.run_id);
    if (index >= 0) data.runs[index] = run;
    else data.runs.unshift(run);
    data.runs = data.runs.slice(0, 500);
    await this.save(data);
  }

  async appendStep(step: StepExecution): Promise<void> {
    const data = await this.load();
    data.steps.push(step);
    data.steps = data.steps.slice(-5000);
    await this.save(data);
  }

  async appendAIUsage(usage: AIUsage): Promise<void> {
    const data = await this.load();
    data.aiUsages.push(usage);
    data.aiUsages = data.aiUsages.slice(-5000);
    await this.save(data);
  }

  async appendFailureReport(report: FailureReport): Promise<void> {
    const data = await this.load();
    data.failureReports.unshift(report);
    data.failureReports = data.failureReports.slice(0, 1000);
    await this.save(data);
  }

  async listSteps(runId: string): Promise<StepExecution[]> {
    const data = await this.load();
    return data.steps.filter((item) => item.run_id === runId);
  }

  async listAIUsage(runId: string): Promise<AIUsage[]> {
    const data = await this.load();
    return data.aiUsages.filter((item) => item.run_id === runId);
  }
}
