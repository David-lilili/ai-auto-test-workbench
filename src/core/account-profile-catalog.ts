import fs from "fs-extra";
import path from "node:path";

/**
 * Account Profile Dimension Catalog（P3-A → P3-A.1）：单一事实源 + 语义选择。
 *
 * P3-A.1 修正：不再按 schema 数组物理顺序"取前 N 条"（位置裁剪），
 * 改为 deterministic relevance selection（四级优先）：
 *   P1 Operation Manual 能力 required 的维度（实例经模板通配匹配回 schema 模板）
 *   P2 业务域维度（feature/earn——与交易/理财操作相关的核心域）
 *   P3 global/core 维度（security/identity/profile —— 账号基础状态）
 *   P4 其余维度（history 明细/assets 变体，按字母序补充至上限）
 *
 * 保证：
 * - required-but-omitted = 0（OM required 永不因上限被截掉，测试固化）；
 * - 新 dimension 不会因"排在第 25 位以后"永久不可见（P4 按域轮转补充，
 *   上限内覆盖所有域的代表；required 新维度无条件入选）；
 * - 同输入同输出（无时间/随机/顺序依赖——排序键全为字符串比较）。
 */

export interface AccountProfileCatalogEntry {
  dimension: string;
  meaning: string;
}

export interface AccountProfileSchemaDimension {
  dimensionId: string;
  label?: string;
  description?: string;
  valueType?: string;
}

export interface AccountProfileSchemaStore {
  schemaVersion?: string;
  project?: string;
  dimensions?: AccountProfileSchemaDimension[];
}

/** Operation Manual 能力声明（selector 只读消费 requiredAccountProfileDimensions）。 */
export interface OperationManualCapabilityRef {
  capabilityId?: string;
  requiredAccountProfileDimensions?: Array<{ dimensionId?: string }>;
}

export interface OperationManualStore {
  manuals?: Array<{ capabilities?: OperationManualCapabilityRef[] }>;
}

export interface DimensionSelectionResult {
  selectedDimensions: AccountProfileCatalogEntry[];
  omittedDimensions: string[];
  selectionReasons: Array<{ dimension: string; priority: "P1_OM_REQUIRED" | "P2_BUSINESS_DOMAIN" | "P3_CORE_ACCOUNT" | "P4_SUPPLEMENTARY"; reason: string }>;
  requiredButOmitted: string[];
}

export const PROFILE_CATALOG_MAX_ENTRIES = 24;

export async function loadAccountProfileSchema(rootDir: string, project: string): Promise<AccountProfileSchemaStore | undefined> {
  if (!/^[a-z0-9_-]+$/i.test(project)) return undefined;
  const schemaPath = path.join(rootDir, "storage", "account-profile-schemas", `${project}.json`);
  if (!(await fs.pathExists(schemaPath))) return undefined;
  return await fs.readJson(schemaPath) as AccountProfileSchemaStore;
}

export async function loadOperationManualStore(rootDir: string, project: string): Promise<OperationManualStore | undefined> {
  if (!/^[a-z0-9_-]+$/i.test(project)) return undefined;
  const manualPath = path.join(rootDir, "storage", "operation-manuals", `${project}.json`);
  if (!(await fs.pathExists(manualPath))) return undefined;
  return await fs.readJson(manualPath) as OperationManualStore;
}

/** 模板通配匹配：schema 模板的 {asset}/{type}/{accountType} 段可匹配任意单段值。 */
function templateMatches(template: string, instance: string): boolean {
  if (template === instance) return true;
  const pattern = template
    .split(".")
    .map((segment) => /^\{[^}]+\}$/.test(segment) ? "[^.]+" : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\.");
  return new RegExp(`^${pattern}$`).test(instance);
}

/** 收集 Operation Manual 全部 required dimension 实例。 */
export function collectRequiredDimensions(manual: OperationManualStore | undefined): string[] {
  if (!manual?.manuals) return [];
  const required = new Set<string>();
  for (const entry of manual.manuals) {
    for (const capability of entry.capabilities ?? []) {
      for (const dimension of capability.requiredAccountProfileDimensions ?? []) {
        if (dimension.dimensionId) required.add(dimension.dimensionId);
      }
    }
  }
  return [...required].sort();
}

// 域分级依据（P3-A.1 实测校准）：DSL 账号画像匹配实际消费 12 条维度，
// 其中 assets.spot.available（余额前置）与 history.*.records（聚合前置）均在
// 交易/理财类用例的 accountProfileNeeds 中直接出现——归 P2 业务域。
const P2_DOMAINS = new Set(["feature", "earn", "assets"]);
const P3_DOMAINS = new Set(["security", "identity", "profile"]);
/** 聚合维度（history.*.records）是 intent accountProfileNeeds 的直接产出形态，P2 处理。 */
const P2_AGGREGATE_PATTERN = /^history\.[^.]+\.records$/;

/**
 * Deterministic relevance selection（P3-A.1 核心）。
 * intent 阶段尚无 module/action 上下文（intent 本身就是要产出 module/action），
 * 因此 P2/P3 按域选择而非按意图选择——这是当前信息量下的确定性最优解。
 */
export function selectProfileDimensions(
  schema: AccountProfileSchemaStore | undefined,
  requiredInstances: string[],
  maxEntries: number = PROFILE_CATALOG_MAX_ENTRIES
): DimensionSelectionResult {
  const dimensions = (schema?.dimensions ?? []).filter((dimension) => Boolean(dimension.dimensionId));
  const reasons = new Map<string, DimensionSelectionResult["selectionReasons"][number]>();

  // P1：OM required（实例→模板匹配；required 命中的模板无条件入选，不占上限约束的牺牲位）
  const requiredTemplates = new Set<string>();
  const unmatchedRequired: string[] = [];
  for (const instance of requiredInstances) {
    const template = dimensions.find((dimension) => templateMatches(dimension.dimensionId!, instance));
    if (template) {
      requiredTemplates.add(template.dimensionId!);
      reasons.set(template.dimensionId!, {
        dimension: template.dimensionId!,
        priority: "P1_OM_REQUIRED",
        reason: `Operation Manual 能力 required 实例 ${instance} 命中该模板`
      });
    } else {
      unmatchedRequired.push(instance);
    }
  }

  // P2/P3/P4：非 required 维度按域分级
  const rest = dimensions.filter((dimension) => !requiredTemplates.has(dimension.dimensionId!));
  const p2: typeof rest = [];
  const p3: typeof rest = [];
  const p4: typeof rest = [];
  for (const dimension of rest) {
    const domain = dimension.dimensionId!.split(".")[0];
    if (P2_DOMAINS.has(domain) || P2_AGGREGATE_PATTERN.test(dimension.dimensionId!)) p2.push(dimension);
    else if (P3_DOMAINS.has(domain)) p3.push(dimension);
    else p4.push(dimension);
  }
  const byDimensionId = (a: AccountProfileSchemaDimension, b: AccountProfileSchemaDimension) => a.dimensionId!.localeCompare(b.dimensionId!);
  // P2 内部分层：records 聚合维度（intent accountProfileNeeds 直接产出形态）优先于域内明细。
  p2.sort((a, b) => {
    const aRecords = P2_AGGREGATE_PATTERN.test(a.dimensionId!) ? 0 : 1;
    const bRecords = P2_AGGREGATE_PATTERN.test(b.dimensionId!) ? 0 : 1;
    return aRecords - bRecords || byDimensionId(a, b);
  });
  p3.sort(byDimensionId);
  p4.sort(byDimensionId);

  for (const dimension of p2) {
    reasons.set(dimension.dimensionId!, { dimension: dimension.dimensionId!, priority: "P2_BUSINESS_DOMAIN", reason: P2_AGGREGATE_PATTERN.test(dimension.dimensionId!) ? "聚合记录维度（intent accountProfileNeeds 直接产出形态）" : "业务域维度（feature/earn/assets）" });
  }
  for (const dimension of p3) {
    reasons.set(dimension.dimensionId!, { dimension: dimension.dimensionId!, priority: "P3_CORE_ACCOUNT", reason: "账号基础状态域（security/identity/profile）" });
  }
  for (const dimension of p4) {
    reasons.set(dimension.dimensionId!, { dimension: dimension.dimensionId!, priority: "P4_SUPPLEMENTARY", reason: "补充维度（history 明细/assets 变体）" });
  }

  // 组装：required 全量 → P2 → P3 → P4 填充至上限（域内字母序，不依赖 schema 物理顺序）
  const toEntry = (dimension: AccountProfileSchemaDimension): AccountProfileCatalogEntry => ({
    dimension: dimension.dimensionId!,
    meaning: String(dimension.label ?? dimension.description ?? "account profile dimension")
  });
  const selected: AccountProfileCatalogEntry[] = [...requiredTemplates]
    .sort()
    .map((id) => dimensions.find((dimension) => dimension.dimensionId === id))
    .filter((dimension): dimension is AccountProfileSchemaDimension => Boolean(dimension))
    .map(toEntry);
  for (const pool of [p2, p3, p4]) {
    for (const dimension of pool) {
      if (selected.length >= maxEntries) break;
      selected.push(toEntry(dimension));
    }
    if (selected.length >= maxEntries) break;
  }

  const selectedIds = new Set(selected.map((entry) => entry.dimension));
  const omitted = dimensions
    .filter((dimension) => !selectedIds.has(dimension.dimensionId!))
    .map((dimension) => dimension.dimensionId!)
    .sort();
  // required-but-omitted 必须为 0：required 模板入选不受上限约束
  const requiredButOmitted = [...requiredTemplates].filter((id) => !selectedIds.has(id));

  return {
    selectedDimensions: selected,
    omittedDimensions: omitted,
    selectionReasons: [...reasons.values()].sort((a, b) => a.dimension.localeCompare(b.dimension)),
    requiredButOmitted
  };
}

/** 向后兼容：P3-A 的直接生成入口（内部走 selector，manual 可选）。 */
export function buildAccountProfileCatalogFromSchema(
  schema: AccountProfileSchemaStore | undefined,
  manual?: OperationManualStore | undefined
): AccountProfileCatalogEntry[] {
  return selectProfileDimensions(schema, collectRequiredDimensions(manual)).selectedDimensions;
}
