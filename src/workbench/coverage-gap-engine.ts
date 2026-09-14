import fs from "fs-extra";
import path from "node:path";

/**
 * 覆盖差距引擎：对比 Operation Manual 已建模能力与用例资产覆盖，
 * 产出「已建模但无用例覆盖」的能力清单，供批量追加起草（cases:draft）消费。
 *
 * 匹配策略（按优先级）：
 * 1. 用例显式 pageModelId 命中 + 请求文本命中能力别名/能力 ID；
 * 2. 请求文本直接命中能力别名。
 * 覆盖判定偏宽（宁可漏报差距，不误报已有覆盖）。
 */

export interface CoverageGapCapability {
  capabilityId: string;
  pageId: string;
  pageName: string;
  module: string;
  operationType: string;
  naturalLanguageAliases: string[];
  requiredData: string[];
  coveredCaseIds: string[];
  coverageStatus: "covered" | "partial" | "uncovered";
}

export interface CoverageGapReport {
  schemaVersion: "coverage-gap-report.v1";
  project: string;
  generatedAt: string;
  totalPages: number;
  totalCapabilities: number;
  covered: number;
  partial: number;
  uncovered: number;
  coveragePercent: number;
  gaps: CoverageGapCapability[];
}

/**
 * 能力匹配关键词：
 * - 中文别名原文（含去「未绑定/拦截」等修饰后的核心动作）；
 * - 页面中文短名（"资产中心-现货流水"→"现货流水"）+ 动作词组合；
 * - 能力 ID 的下划线/驼峰分段词（英文用例或注释场景兜底）。
 */
const ACTION_WORDS_BY_ID: Array<{ prefix: string; word: string }> = [
  { prefix: "filter", word: "筛选" },
  { prefix: "query", word: "查询" },
  { prefix: "subscribe", word: "申购" },
  { prefix: "redeem", word: "赎回" },
  { prefix: "create", word: "创建" },
  { prefix: "add", word: "添加" },
  { prefix: "claim", word: "领取" },
  { prefix: "view", word: "查看" },
  { prefix: "open", word: "打开" },
  { prefix: "submit", word: "提交" },
  { prefix: "toggle", word: "切换" },
  { prefix: "bind", word: "绑定" },
  { prefix: "switch", word: "切换" },
  { prefix: "update", word: "修改" }
];

function buildCapabilityKeywords(capabilityId: string, aliases: string[]): string[] {
  const keywords = new Set<string>(aliases.filter(Boolean));
  // 能力 ID 动作词 → 中文动作词：subscribe→申购、claim→领取、filter→筛选。
  // 用例文本通常含动作词（"点击申购"），比别名滑窗更稳且不会跨能力误命中
  // （toggle_auto_subscribe 不含 subscribe 之外的独立动作词前缀时由别名核心词负责）。
  const actionWord = ACTION_WORDS_BY_ID.find((entry) => capabilityId.startsWith(entry.prefix));
  if (actionWord) keywords.add(actionWord.word);
  // 别名去掉否定修饰后的核心（"红包创建未绑谷歌拦截"→"红包创建"）
  for (const alias of aliases) {
    const core = alias.replace(/未绑定?.*$/, "").replace(/拦截$/, "");
    if (core.length >= 2 && core !== alias) keywords.add(core);
  }
  // 能力 ID 分段
  const segments = capabilityId.split(/[_.]/).filter(Boolean);
  for (let size = 2; size <= segments.length; size += 1) {
    keywords.add(segments.slice(-size).join("_"));
  }
  return [...keywords];
}

export async function analyzeCoverageGaps(rootDir: string, project: string): Promise<CoverageGapReport> {
  if (!/^[a-z0-9_-]+$/i.test(project)) throw new Error(`Invalid project key: ${project}`);
  const manualPath = path.join(rootDir, "storage", "operation-manuals", `${project}.json`);
  const casesPath = path.join(rootDir, "storage", "cases", `${project}.json`);
  if (!(await fs.pathExists(manualPath))) {
    throw new Error(`Operation Manual Store 未配置: ${project}`);
  }
  const manualStore = await fs.readJson(manualPath) as Record<string, unknown>;
  const caseStore = (await fs.pathExists(casesPath))
    ? await fs.readJson(casesPath) as Record<string, unknown>
    : { cases: [] };
  const manuals = Array.isArray(manualStore.manuals) ? manualStore.manuals as Array<Record<string, unknown>> : [];
  const cases = Array.isArray(caseStore.cases) ? caseStore.cases as Array<Record<string, unknown>> : [];

  const gaps: CoverageGapCapability[] = [];
  let totalCapabilities = 0;

  for (const manual of manuals) {
    const pageId = String(manual.pageId ?? "");
    const pageName = String(manual.pageName ?? pageId);
    const module = String(manual.module ?? "");
    const capabilities = Array.isArray(manual.capabilities) ? manual.capabilities as Array<Record<string, unknown>> : [];
    for (const capability of capabilities) {
      const capabilityId = String(capability.capabilityId ?? "");
      if (!capabilityId) continue;
      totalCapabilities += 1;
      const aliases = Array.isArray(capability.naturalLanguageAliases) ? capability.naturalLanguageAliases.map(String) : [];
      const requiredData = Array.isArray(capability.requiredData) ? capability.requiredData.map(String) : [];
      const operationType = String(capability.operationType ?? "unknown");

      // 覆盖判定（两级）：
      // 页面级——用例挂到该页面且文本含页面中文短名（证明该页面有针对性用例）；
      // 能力级——用例文本命中能力的中文别名核心、能力 ID 分段或「短名+动作词」组合。
      // 只有页面级命中而能力级未命中的能力标 partial（页面有用例但该能力未覆盖）。
      const coveredCaseIds: string[] = [];
      const pageCases = cases.filter((item) => String(item.pageModelId ?? "") === pageId);
      const shortPageName = pageName.includes("-") ? pageName.split("-").slice(-1)[0] : pageName;
      const capabilityKeywords = buildCapabilityKeywords(capabilityId, aliases);
      for (const testCase of pageCases) {
        const text = `${String(testCase.request ?? "")}\n${String(testCase.title ?? "")}\n${String(testCase.expectedAssertion ?? "")}`;
        const hit = capabilityKeywords.some((keyword) => keyword.length >= 2 && text.includes(keyword));
        if (hit) coveredCaseIds.push(String(testCase.id ?? ""));
      }
      const pageLevelCases = shortPageName && shortPageName.length >= 2
        ? pageCases.filter((item) => `${String(item.title ?? "")}${String(item.request ?? "")}`.includes(shortPageName))
        : [];

      const coverageStatus: CoverageGapCapability["coverageStatus"] = coveredCaseIds.length > 0
        ? "covered"
        : pageLevelCases.length > 0
          ? "partial"
          : "uncovered";
      gaps.push({
        capabilityId,
        pageId,
        pageName,
        module,
        operationType,
        naturalLanguageAliases: aliases,
        requiredData,
        coveredCaseIds,
        coverageStatus
      });
    }
  }

  const covered = gaps.filter((item) => item.coverageStatus === "covered").length;
  const partial = gaps.filter((item) => item.coverageStatus === "partial").length;
  const uncovered = gaps.length - covered - partial;
  return {
    schemaVersion: "coverage-gap-report.v1",
    project,
    generatedAt: new Date().toISOString(),
    totalPages: manuals.length,
    totalCapabilities: gaps.length,
    covered,
    partial,
    uncovered,
    coveragePercent: gaps.length ? Math.round((covered / gaps.length) * 1000) / 10 : 0,
    gaps: gaps.sort((a, b) => a.coverageStatus.localeCompare(b.coverageStatus) || a.pageId.localeCompare(b.pageId))
  };
}

export function renderCoverageGapReport(report: CoverageGapReport): string {
  const lines = [
    `# 用例覆盖差距报告 ${report.generatedAt.slice(0, 10)}`,
    "",
    `- 已建模页面：${report.totalPages}，已建模能力：${report.totalCapabilities}`,
    `- 已覆盖：${report.covered}（${report.coveragePercent}%），未覆盖：${report.uncovered}`,
    "",
    "## 未覆盖能力（可追加起草用例）",
    ""
  ];
  const uncovered = report.gaps.filter((item) => item.coverageStatus === "uncovered");
  if (uncovered.length) {
    for (const gap of uncovered) {
      lines.push(`- ${gap.pageName}（${gap.pageId}）：\`${gap.capabilityId}\` [${gap.operationType}]${gap.naturalLanguageAliases.length ? ` 别名：${gap.naturalLanguageAliases.slice(0, 3).join("、")}` : ""}`);
    }
  } else {
    lines.push("- 无完全未覆盖的能力。");
  }
  const partial = report.gaps.filter((item) => item.coverageStatus === "partial");
  if (partial.length) {
    lines.push("", "## 部分覆盖（页面有用例，该能力未覆盖）", "");
    for (const gap of partial) {
      lines.push(`- ${gap.pageName}（${gap.pageId}）：\`${gap.capabilityId}\` [${gap.operationType}]`);
    }
  }
  lines.push("", "## 说明", "");
  lines.push("覆盖判定基于用例文本与能力自然语言别名的匹配，偏宽；未覆盖项建议用 `npm run cases:draft -- --project <project> --env <env> --pages <pageId>` 追加起草后人工审核入库。");
  return `${lines.join("\n")}\n`;
}
