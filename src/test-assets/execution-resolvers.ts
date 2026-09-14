/**
 * P13.12-18：Test Data / Account Profile / Precondition Resolver。
 *
 * 复用既有：account profile schema/dimensions（account-profile-catalog）、
 * storage/account-profiles 数据。不建第二套 account taxonomy。
 */

import fs from "fs-extra";
import path from "node:path";
import type { ResolvedTestData, ResolvedProfile } from "./execution-types.js";
import type { TestAsset } from "./types.js";

// ============ P13.13/14 Test Data Resolver ============

export type TestDataResolutionStatus = "RESOLVED" | "PARTIAL" | "UNRESOLVED" | "CONFLICT";

export function resolveTestDataRequirements(
  requirements: TestAsset["testDataRequirements"],
  sources: {
    staticFixtures?: Record<string, string>;
    accountProfiles?: Array<Record<string, unknown>>;
    envConfig?: Record<string, string>;
    businessKnowledge?: Record<string, string>;
    userProvided?: Record<string, string>;
  }
): { status: TestDataResolutionStatus; resolved: ResolvedTestData[]; unresolved: string[]; conflicts: string[] } {
  const resolved: ResolvedTestData[] = [];
  const unresolved: string[] = [];
  const conflicts: string[] = [];
  for (const req of requirements) {
    const candidate = sources.staticFixtures?.[`${req.dimension}.${req.value}`]
      ?? sources.staticFixtures?.[req.value]
      ?? sources.envConfig?.[req.dimension]
      ?? sources.businessKnowledge?.[req.value]
      ?? sources.userProvided?.[req.value];
    if (candidate) {
      resolved.push({ dimension: req.dimension, value: candidate, source: sources.userProvided?.[req.value] ? "USER_PROVIDED" : sources.envConfig?.[req.dimension] ? "ENV_CONFIG" : sources.businessKnowledge?.[req.value] ? "BUSINESS_KNOWLEDGE" : "STATIC_FIXTURE" });
      continue;
    }
    // account profile 维度匹配
    const profileMatch = (sources.accountProfiles ?? []).find((p) => {
      const v = String(p[req.dimension] ?? p[req.value] ?? "");
      return v && v !== "unknown";
    });
    if (profileMatch) {
      resolved.push({ dimension: req.dimension, value: String(profileMatch[req.dimension] ?? profileMatch[req.value]), source: "ACCOUNT_PROFILE", provenance: String(profileMatch.accountId ?? profileMatch.username ?? "") });
      continue;
    }
    unresolved.push(`${req.dimension}=${req.value}`);
  }
  const status: TestDataResolutionStatus = unresolved.length === 0 ? "RESOLVED" : resolved.length === 0 ? "UNRESOLVED" : "PARTIAL";
  return { status, resolved, unresolved, conflicts };
}

// ============ P13.15/16 Account Profile Resolver ============

export interface ProfileRequirement { dimension: string; value: string }

export function resolveAccountProfileRequirements(
  requirements: ProfileRequirement[],
  profiles: Array<Record<string, unknown>>,
  options?: { deterministicRank?: boolean; needsConfirmationOnMultiple?: boolean }
): ResolvedProfile {
  if (requirements.length === 0) return { matched: true, matchEvidence: ["no requirements"], missingDimensions: [], needsConfirmation: false };
  const matches: Array<{ profile: Record<string, unknown>; score: number; evidence: string[] }> = [];
  for (const p of profiles) {
    const evidence: string[] = [];
    let score = 0;
    for (const req of requirements) {
      const v = String(p[req.dimension] ?? p[req.value] ?? "");
      if (v && v !== "unknown") {
        // 精确值匹配优先（LEVEL_2 只命中 LEVEL_2 的 profile）
        score += v === req.value ? 2 : 1;
        evidence.push(`${req.dimension}=${v}`);
      } else {
        evidence.push(`${req.dimension}=MISSING`);
      }
    }
    if (score > 0) matches.push({ profile: p, score, evidence });
  }
  if (matches.length === 0) {
    return { matched: false, matchEvidence: [], missingDimensions: requirements.map((r) => r.dimension), needsConfirmation: false };
  }
  matches.sort((a, b) => b.score - a.score); // deterministic ranking
  const best = matches[0];
  const needsConfirmation = options?.needsConfirmationOnMultiple !== false && matches.length > 1 && best.score === matches[1].score;
  return {
    profileId: String(best.profile.accountId ?? best.profile.username ?? "profile"),
    matched: true,
    matchEvidence: best.evidence,
    missingDimensions: best.evidence.filter((e) => e.endsWith("=MISSING")).map((e) => e.split("=")[0]),
    needsConfirmation
  };
}

export async function loadAccountProfiles(rootDir: string, project: string, env: string): Promise<Array<Record<string, unknown>>> {
  const p = path.join(rootDir, "storage", "account-profiles", project, `${env}.json`);
  if (!(await fs.pathExists(p))) return [];
  try {
    const store = (await fs.readJson(p)) as { profiles?: Array<Record<string, unknown>> };
    return store.profiles ?? [];
  } catch {
    return [];
  }
}

// ============ P13.17/18 Precondition Resolver ============

export function classifyPrecondition(statement: string): { category: import("./execution-types.js").PreconditionCategory; disposition: import("./execution-types.js").PreconditionDisposition } {
  const s = statement.toLowerCase();
  const category: import("./execution-types.js").PreconditionCategory =
    /login|登录|kyc|实名|认证|2fa|验证/.test(s) ? "ACCOUNT_STATE"
    : /no.?verification|免验证|白名单|whitelist/.test(s) ? "PRODUCT_STATE"
    : /navigate|页面|page|tab|筛选|filter/.test(s) ? "PAGE_STATE"
    : /balance|余额|金额|amount|usdt/.test(s) ? "DATA_STATE"
    : /security|安全|权限|permission/.test(s) ? "SECURITY_STATE"
    : "UNKNOWN" as never;
  const disposition: import("./execution-types.js").PreconditionDisposition =
    category === "PAGE_STATE" ? "can_prepare_safely"
    : /kyc|实名|transfer|划转|withdraw|提现/.test(s) ? "requires_high_risk_operation"
    : /login|登录/.test(s) ? "can_prepare_safely"
    : "unknown";
  return { category, disposition };
}
