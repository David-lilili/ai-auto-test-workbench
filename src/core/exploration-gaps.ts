import fs from "fs-extra";
import path from "node:path";
import type { CoverageSnapshot, PageCoverageSnapshot } from "./exploration-coverage.js";

/**
 * Exploration Gap（P2.3）：从 Coverage Snapshot 推导「值得定向探索的未知项」。
 *
 * Gap 必须有明确来源（不枚举不存在的组合）：
 *  1. element_unverified      —— Page Model 有元素且非 candidate，但无执行证据
 *  2. interaction_unverified  —— 已建模 interaction 无 execution evidence
 *  3. state_transition_gap    —— related state model 无进入/退出验证
 *  4. dsl_diagnostic_gap      —— DSL 诊断中出现模型缺失
 *  5. failure_package_gap     —— 失败诊断表明 missing state / dependency
 *  6. candidate_stale         —— candidate 元素长期未验证
 *  7. manual_capability_gap   —— Operation Manual 声明依赖但 Page Model 无证据
 *
 * 优先级 deterministic：
 *  HIGH   = 失败/诊断指向的缺口，或 DSL 引用但无执行证据（正在被使用却未验证）
 *  MEDIUM = 建模存在但零执行证据；capability 声明缺证据
 *  LOW    = candidate 陈旧；状态族关系未验证
 */

export type GapPriority = "HIGH" | "MEDIUM" | "LOW";

export interface ExplorationGap {
  gapId: string;
  pageId: string;
  dimension: "element" | "interaction" | "state" | "dependency";
  target: string;
  status: string;
  source: string;
  evidence: string;
  priority: GapPriority;
  reason: string;
}

export interface ExplorationGapReport {
  schemaVersion: "exploration-gap-report.v1";
  project: string;
  generatedAt: string;
  totalGaps: number;
  byPriority: Record<string, number>;
  bySource: Record<string, number>;
  gaps: ExplorationGap[];
}

function priorityFor(source: string, context: { dslReferenced?: boolean; executionCount?: number }): GapPriority {
  // 失败/诊断类直接 HIGH；DSL 正引用但零执行 → HIGH；其余建模缺口 MEDIUM；陈旧 candidate LOW。
  if (source === "dsl_diagnostic_gap" || source === "failure_package_gap") return "HIGH";
  if (context.dslReferenced && !(context.executionCount ?? 0)) return "HIGH";
  if (source === "candidate_stale") return "LOW";
  if (source === "state_transition_gap") return "LOW";
  return "MEDIUM";
}

/** 从 DSL 诊断目录提取「模型缺失」类缺口证据（只读）。 */
async function loadDiagnosticGaps(rootDir: string, project: string): Promise<Array<{ caseId: string; gaps: string[] }>> {
  const diagRoot = path.join(rootDir, "storage", "dsl-diagnostics", project);
  if (!(await fs.pathExists(diagRoot))) return [];
  const results: Array<{ caseId: string; gaps: string[] }> = [];
  for (const envDir of (await fs.readdir(diagRoot)).filter((name) => !name.endsWith(".json"))) {
    const envPath = path.join(diagRoot, envDir);
    for (const caseDir of (await fs.readdir(envPath).catch(() => []))) {
      const casePath = path.join(envPath, caseDir);
      const files = (await fs.readdir(casePath).catch(() => [])).filter((name) => name.endsWith(".json")).sort();
      const latest = files[files.length - 1];
      if (!latest) continue;
      const record = await fs.readJson(path.join(casePath, latest)).catch(() => undefined) as Record<string, unknown> | undefined;
      if (!record) continue;
      const gaps = Array.isArray(record.gaps) ? record.gaps.map(String) : [];
      const relevant = gaps.filter((gap) =>
        /assertion_capability_missing|missing_page|missing_evidence|missing_model|modeling_gap|element_not_found|page_model_missing/i.test(gap)
      );
      if (relevant.length) results.push({ caseId: String(record.caseId ?? caseDir), gaps: relevant });
    }
  }
  return results;
}

export async function buildExplorationGaps(rootDir: string, project: string, snapshot: CoverageSnapshot): Promise<ExplorationGapReport> {
  const gaps: ExplorationGap[] = [];
  const diagnostics = await loadDiagnosticGaps(rootDir, project);

  for (const page of snapshot.pages) {
    // 来源 1/2/6：元素与交互维度
    for (const element of page.elements) {
      if (element.status === "NOT_APPLICABLE") continue; // I：N/A 不进 gap
      if (element.status === "VERIFIED") continue;
      if (element.status === "UNCERTAIN") {
        // 来源 6：candidate 长期未验证（无 DSL 引用、无执行证据）
        if (!element.dslReferenceCount && !element.executionEvidenceCount) {
          gaps.push({
            gapId: `gap:${page.pageId}:element:${element.elementId}`,
            pageId: page.pageId,
            dimension: "element",
            target: element.elementId,
            status: element.status,
            source: "candidate_stale",
            evidence: `modeledStatus=${element.modeledStatus ?? "candidate"}, dslRefs=0, executions=0`,
            priority: "LOW",
            reason: "candidate 元素无任何 DSL 引用与执行证据，需补采或清理"
          });
        }
        continue;
      }
      // 来源 1：非 candidate 元素从未执行验证
      if (!element.executionEvidenceCount) {
        const priority = priorityFor("element_unverified", { dslReferenced: element.dslReferenceCount > 0, executionCount: element.executionEvidenceCount });
        gaps.push({
          gapId: `gap:${page.pageId}:element:${element.elementId}`,
          pageId: page.pageId,
          dimension: "element",
          target: element.elementId,
          status: element.status,
          source: "element_unverified",
          evidence: `modeledStatus=${element.modeledStatus ?? "-"}`, dslReferenceCount: element.dslReferenceCount,
          priority,
          reason: element.dslReferenceCount
            ? "DSL 已引用该元素但从未执行成功，属于正在使用却未验证"
            : "已建模元素从未有执行证据"
        } as ExplorationGap);
      }
    }

    // 来源 2：interaction 无 execution evidence
    for (const interaction of page.interactions) {
      if (interaction.status === "VERIFIED" || interaction.status === "NOT_APPLICABLE") continue;
      if (interaction.source === "dsl_step") continue; // DSL 编排的步骤执行过才出现在列表
      gaps.push({
        gapId: `gap:${page.pageId}:interaction:${interaction.interaction}:${interaction.targetElementId ?? "page"}`,
        pageId: page.pageId,
        dimension: "interaction",
        target: `${interaction.interaction}${interaction.targetElementId ? `@${interaction.targetElementId}` : ""}`,
        status: interaction.status,
        source: "interaction_unverified",
        evidence: `source=${interaction.source}, evidence=${interaction.evidence}`,
        priority: priorityFor("interaction_unverified", {}),
        reason: "已建模 interaction 缺少 execution evidence"
      });
    }

    // 来源 3：related state model 无进入/退出验证
    if (page.isStateModel) {
      const hasVerifiedEntry = page.interactions.some((item) => item.status === "VERIFIED" && /click|navigate|open/.test(item.interaction));
      if (!hasVerifiedEntry) {
        gaps.push({
          gapId: `gap:${page.pageId}:state:entry_transition`,
          pageId: page.pageId,
          dimension: "state",
          target: "entry_transition",
          status: "KNOWN",
          source: "state_transition_gap",
          evidence: `relatedPages=${page.relatedPages.join(",") || "无"}`,
          priority: "LOW",
          reason: "状态模型存在但无验证过的进入路径"
        });
      }
    }
  }

  // 来源 4/5：诊断与失败包指向的模型缺口
  for (const diagnostic of diagnostics) {
    for (const gapText of diagnostic.gaps.slice(0, 3)) {
      gaps.push({
        gapId: `gap:diagnostic:${diagnostic.caseId}:${gapText.slice(0, 40)}`,
        pageId: "(diagnostic)",
        dimension: "dependency",
        target: gapText.slice(0, 80),
        status: "UNEXPLORED",
        source: "dsl_diagnostic_gap",
        evidence: `caseId=${diagnostic.caseId}`,
        priority: "HIGH",
        reason: "DSL 诊断明确指向的模型能力缺失"
      });
    }
  }

  // 来源 7：Operation Manual 声明能力但 Page Model 无证据
  const manualPath = path.join(rootDir, "storage", "operation-manuals", `${project}.json`);
  if (await fs.pathExists(manualPath)) {
    const manualStore = await fs.readJson(manualPath) as Record<string, unknown>;
    const manuals = Array.isArray(manualStore.manuals) ? manualStore.manuals as Array<Record<string, unknown>> : [];
    for (const manual of manuals) {
      const pageId = String(manual.pageId ?? "");
      const capabilities = Array.isArray(manual.capabilities) ? manual.capabilities as Array<Record<string, unknown>> : [];
      const pageSnapshot = snapshot.pages.find((page) => page.pageId === pageId);
      for (const capability of capabilities) {
        const requiredData = Array.isArray(capability.requiredData) ? capability.requiredData.map(String) : [];
        const operationType = String(capability.operationType ?? "");
        if (operationType !== "write" && operationType !== "negative_guard") continue;
        // 写操作能力应有 interaction 证据
        const hasWriteEvidence = pageSnapshot?.interactions.some((item) => item.status === "VERIFIED" && /submit|click|input|select/.test(item.interaction));
        if (!hasWriteEvidence) {
          gaps.push({
            gapId: `gap:${pageId}:manual:${String(capability.capabilityId ?? "")}`,
            pageId,
            dimension: "interaction",
            target: String(capability.capabilityId ?? ""),
            status: "UNEXPLORED",
            source: "manual_capability_gap",
            evidence: `operationType=${operationType}, requiredData=[${requiredData.join(",")}]`,
            priority: "MEDIUM",
            reason: "Operation Manual 声明的写操作能力缺少 Page Model 执行证据"
          });
        }
      }
    }
  }

  const byPriority: Record<string, number> = {};
  const bySource: Record<string, number> = {};
  for (const gap of gaps) {
    byPriority[gap.priority] = (byPriority[gap.priority] ?? 0) + 1;
    bySource[gap.source] = (bySource[gap.source] ?? 0) + 1;
  }
  // 确定性排序：priority(HIGH>MEDIUM>LOW) → source → pageId → gapId
  const priorityOrder: Record<string, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };
  gaps.sort((a, b) =>
    priorityOrder[a.priority] - priorityOrder[b.priority]
    || a.source.localeCompare(b.source)
    || a.pageId.localeCompare(b.pageId)
    || a.gapId.localeCompare(b.gapId)
  );

  return {
    schemaVersion: "exploration-gap-report.v1",
    project,
    generatedAt: new Date().toISOString(),
    totalGaps: gaps.length,
    byPriority,
    bySource,
    gaps
  };
}
