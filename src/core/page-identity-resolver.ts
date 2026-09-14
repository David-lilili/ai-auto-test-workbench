import fs from "fs-extra";
import path from "node:path";

/**
 * Page Identity Resolver（P1）：判定「待入库页面」与「已有 Page Model」是否同一页面。
 *
 * 解决的问题：pageId 拼写差异（demo/demo）、不同采集批次、命名风格差异
 * 导致同一真实页面被重复建模。历史实例：
 *   - demo.funds.red_packet vs demo.funds.red_packet（拼写前缀）
 *   - demo.asset.total_assets vs demo.funds.total_assets（同 URL 同页面，两套元素）
 *
 * 设计约束：
 * - 纯确定性算法，无 LLM、无 embedding。
 * - URL 相同不代表同一页面：平台合法存在「同 URL 多交互状态」模型（*_entry / *_dimension_state），
 *   因此 URL 是强信号但必须与语义信号联合判定。
 * - 输出四态 + score + reasons + matched/conflicting signals + candidatePageIds。
 * - 本模块只做判定，不执行合并；高风险判定由调用方转 proposal 审核。
 */

export type PageIdentityVerdict = "SAME_PAGE" | "POSSIBLE_SAME_PAGE" | "RELATED_STATE_MODEL" | "NEW_PAGE" | "CONFLICT";

export interface PageIdentitySignal {
  pageId: string;
  url?: string;
  pageName?: string;
  semanticNames?: string[];
  domHash?: string;
  visibleTextHash?: string;
}

export interface PageIdentityMatchedSignal {
  modelPageId: string;
  signal: string;
  detail: string;
}

export interface PageIdentityResult {
  verdict: PageIdentityVerdict;
  score: number;
  reasons: string[];
  matchedSignals: PageIdentityMatchedSignal[];
  conflictingSignals: PageIdentityMatchedSignal[];
  candidatePageIds: string[];
  /**
   * SAME_PAGE 时的 canonical 写回目标（已有模型的 pageId）。
   * 仅 SAME_PAGE 可自动重定向；POSSIBLE/CONFLICT/RELATED 状态下为 undefined，
   * 写回层必须按 incoming pageId 处理并走人工审核。
   */
  targetPageId?: string;
  /** 判定是否来自 pageId 之外的强证据（domHash/URL+语义），用于审计追踪。 */
  remapEvidence?: string;
}

/** 归一化 pageId：小写、统一分隔符，用于容忍拼写型差异（demo→demo 只差字母序）。 */
export function normalizePageId(pageId: string): string {
  return String(pageId ?? "")
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
}

/** 归一化 URL：去 query/hash、去尾斜杠、小写 host。 */
export function normalizeUrl(url: string): string {
  const value = String(url ?? "").trim();
  if (!value) return "";
  try {
    const parsed = new URL(value);
    return `${parsed.protocol}//${parsed.host.toLowerCase()}${parsed.pathname.replace(/\/+$/, "")}`;
  } catch {
    return value.toLowerCase().replace(/[#?].*$/, "").replace(/\/+$/, "");
  }
}

/**
 * 语义关键词提取：中文按 2 字窗、英文/数字 token 化。
 * 「资金流水入口」→ [资金,金流,流水,水入,入口]
 * 「asset_action.fund_flow」→ [asset, action, fund, flow]
 */
export function semanticKeywords(text: string): string[] {
  const value = String(text ?? "");
  const keywords = new Set<string>();
  // 英文/数字 token
  for (const token of value.match(/[a-z][a-z0-9_]{2,}/gi) ?? []) {
    keywords.add(token.toLowerCase());
  }
  // 中文 2 字滑窗
  const chineseOnly = value.replace(/[^\u4e00-\u9fa5]/g, "");
  for (let i = 0; i < chineseOnly.length - 1; i += 1) {
    keywords.add(chineseOnly.slice(i, i + 2));
  }
  return [...keywords];
}

function semanticOverlap(a: string[] | undefined, b: string[] | undefined, corpus?: PageIdentitySignal[]): { ratio: number; common: string[] } {
  if (!a?.length || !b?.length) return { ratio: 0, common: [] };
  const keywordsA = new Set(a.flatMap((name) => semanticKeywords(name)));
  const keywordsB = new Set(b.flatMap((name) => semanticKeywords(name)));
  // IDF 式通用词降权：出现在超过 1/3 模型里的关键词（usdt/合约/充值这类站点级通用词）
  // 不作为「同页」证据，避免同 URL 状态族被长文本元素名撑出假性高重叠。
  let stopKeywords = new Set<string>();
  if (corpus && corpus.length >= 4) {
    const docFreq = new Map<string, number>();
    for (const model of corpus) {
      const modelKeywords = new Set((model.semanticNames ?? []).flatMap((name) => semanticKeywords(name)));
      for (const keyword of modelKeywords) docFreq.set(keyword, (docFreq.get(keyword) ?? 0) + 1);
    }
    const threshold = Math.ceil(corpus.length / 3);
    for (const [keyword, count] of docFreq) {
      if (count >= threshold) stopKeywords.add(keyword);
    }
  }
  const common = [...keywordsA].filter((keyword) => keywordsB.has(keyword) && !stopKeywords.has(keyword));
  const smaller = Math.min(
    [...keywordsA].filter((keyword) => !stopKeywords.has(keyword)).length,
    [...keywordsB].filter((keyword) => !stopKeywords.has(keyword)).length
  );
  return { ratio: smaller ? common.length / smaller : 0, common: common.slice(0, 8) };
}

/** 状态型 pageId 特征：同 URL 下的交互状态模型（entry/state/tab 切换），合并风险高。 */
function looksLikeStateModel(pageId: string): boolean {
  return /(_entry|_state|_dimension|_modal|_drawer|_tab)$|\.state\./i.test(pageId);
}

/**
 * 判定 incoming 页面与某个已有 model 的身份关系。
 * 返回 0-1 score 与信号明细；调用方汇总所有 model 后取最优决定 verdict。
 */
export function scoreIdentityPair(incoming: PageIdentitySignal, model: PageIdentitySignal, corpus?: PageIdentitySignal[]): {
  score: number;
  matched: PageIdentityMatchedSignal[];
  conflicts: PageIdentityMatchedSignal[];
  pageIdExact: boolean;
  pageIdNormalized: boolean;
  urlMatch: boolean;
  domHashMatch: boolean;
} {
  const matched: PageIdentityMatchedSignal[] = [];
  const conflicts: PageIdentityMatchedSignal[] = [];

  const incomingPageId = String(incoming.pageId ?? "");
  const modelPageId = String(model.pageId ?? "");
  const pageIdExact = Boolean(incomingPageId) && incomingPageId === modelPageId;
  const pageIdNormalized = !pageIdExact && Boolean(incomingPageId) && normalizePageId(incomingPageId) === normalizePageId(modelPageId);

  const incomingUrl = normalizeUrl(incoming.url ?? "");
  const modelUrl = normalizeUrl(model.url ?? "");
  const urlMatch = Boolean(incomingUrl) && incomingUrl === modelUrl;

  const overlap = semanticOverlap(incoming.semanticNames, model.semanticNames, corpus);

  const nameA = String(incoming.pageName ?? "");
  const nameB = String(model.pageName ?? "");
  const nameMatch = Boolean(nameA) && nameA === nameB;

  const domHashMatch = Boolean(incoming.domHash) && incoming.domHash === model.domHash;
  const textHashMatch = Boolean(incoming.visibleTextHash) && incoming.visibleTextHash === model.visibleTextHash;

  if (pageIdExact) {
    matched.push({ modelPageId: modelPageId, signal: "pageId", detail: `exact: ${incomingPageId}` });
  } else if (pageIdNormalized) {
    matched.push({ modelPageId: modelPageId, signal: "pageId(normalized)", detail: `${incomingPageId} ≈ ${modelPageId}` });
  }

  if (urlMatch) {
    matched.push({ modelPageId: modelPageId, signal: "url", detail: `${incomingUrl}` });
  } else if (incomingUrl && modelUrl) {
    // URL 同源不同路径：弱冲突信号（可能是同站点不同页面）
    if (new URL(incoming.url ?? "http://x").host === new URL(model.url ?? "http://x").host) {
      conflicts.push({ modelPageId: modelPageId, signal: "url", detail: `同源不同路径: ${incomingUrl} vs ${modelUrl}` });
    }
  }

  // URL 明确不同（同源不同路径）时，语义重叠是站点通用词噪音（账户/划转/提现），
  // 不作为同页证据——只记录参考信息，不计入评分。
  const urlExplicitlyDifferent = Boolean(incomingUrl) && Boolean(modelUrl) && incomingUrl !== modelUrl;
  if (!urlExplicitlyDifferent && overlap.ratio >= 0.34) {
    matched.push({ modelPageId: modelPageId, signal: "semanticElements", detail: `语义重叠 ${(overlap.ratio * 100).toFixed(0)}%: ${overlap.common.slice(0, 5).join(", ")}` });
  } else if (overlap.ratio >= 0.34 && urlExplicitlyDifferent) {
    matched.push({ modelPageId: modelPageId, signal: "semanticElements(参考,URL不同不计分)", detail: `语义重叠 ${(overlap.ratio * 100).toFixed(0)}%（不同 URL 页面，不计入身份评分）` });
  } else if (overlap.ratio > 0 && overlap.ratio < 0.15 && (incoming.semanticNames?.length ?? 0) >= 5 && (model.semanticNames?.length ?? 0) >= 5) {
    conflicts.push({ modelPageId: modelPageId, signal: "semanticElements", detail: `语义重叠仅 ${(overlap.ratio * 100).toFixed(0)}%，元素集差异大` });
  }

  if (nameMatch) {
    matched.push({ modelPageId: modelPageId, signal: "pageName", detail: `${nameA}` });
  }

  if (domHashMatch) {
    matched.push({ modelPageId: modelPageId, signal: "domHash", detail: `完全一致` });
  }
  if (textHashMatch) {
    matched.push({ modelPageId: modelPageId, signal: "visibleTextHash", detail: `完全一致` });
  }

  // 评分：pageId 与 hash 是决定性信号；URL+语义组合是主要路径。
  // 安全边界：非 pageId 匹配且无 hash 的组合最高 0.70（URL+语义+同名），
  // 低于 SAME_PAGE 阈值 0.75——该区间一律 POSSIBLE_SAME_PAGE 走人工审核，
  // 只有 pageId 精确匹配或 domHash 完全一致才允许自动 canonical 重定向。
  let score = 0;
  if (pageIdExact) score += 0.5;
  else if (pageIdNormalized) score += 0.4;
  if (domHashMatch) score += 0.3;
  if (textHashMatch) score += 0.2;
  if (urlMatch) score += 0.25;
  if (!urlExplicitlyDifferent) {
    if (overlap.ratio >= 0.5) score += 0.35;
    else if (overlap.ratio >= 0.34) score += 0.25;
    else if (overlap.ratio >= 0.2) score += 0.15;
  }
  if (nameMatch) score += 0.1;

  return {
    score: Math.min(1, Number(score.toFixed(2))),
    matched,
    conflicts,
    pageIdExact,
    pageIdNormalized,
    urlMatch,
    domHashMatch
  };
}

/**
 * 主入口：incoming 页面 vs 全部已有 Page Model。
 * verdict 规则：
 *  - SAME_PAGE：pageId 精确匹配，或 (url+强语义) / (hash 匹配) 且无冲突。
 *  - POSSIBLE_SAME_PAGE：归一化 pageId 命中，或 url+中语义——转 proposal 审核。
 *  - CONFLICT：有强匹配信号但存在显著冲突信号（如状态模型特征 vs 页面级特征）。
 *  - NEW_PAGE：最高分低于阈值。
 */
export function resolvePageIdentity(incoming: PageIdentitySignal, existingModels: PageIdentitySignal[]): PageIdentityResult {
  const corpus = [incoming, ...existingModels];
  const reasons: string[] = [];
  const allMatched: PageIdentityMatchedSignal[] = [];
  const allConflicts: PageIdentityMatchedSignal[] = [];
  const candidates: Array<{ pageId: string; score: number; pair: ReturnType<typeof scoreIdentityPair> }> = [];

  for (const model of existingModels) {
    const pair = scoreIdentityPair(incoming, model, corpus);
    if (pair.score > 0 || pair.conflicts.length) {
      candidates.push({ pageId: String(model.pageId ?? ""), score: pair.score, pair });
      allMatched.push(...pair.matched);
      allConflicts.push(...pair.conflicts);
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  const candidatePageIds = candidates.filter((item) => item.score >= 0.3).map((item) => item.pageId);

  // RELATED_STATE_MODEL 前置判定（优先于 NEW_PAGE 门槛）：
  // 页面级 vs 状态级模型共享 URL 是合法状态族关系——即使语义重叠低（弹窗元素 vs 页面元素
  // 本来就少交集）也要识别为 RELATED，而不是误判 NEW_PAGE 或冲突。
  const urlMatchedCandidate = candidates.find((item) => item.pair.urlMatch);
  if (urlMatchedCandidate) {
    const incomingIsState = looksLikeStateModel(incoming.pageId ?? "");
    const targetIsState = looksLikeStateModel(urlMatchedCandidate.pageId);
    // 两种 RELATED：页面级↔状态级（父子关系）、状态级↔状态级（同页兄弟状态）。
    if (incomingIsState !== targetIsState || (incomingIsState && targetIsState)) {
      const relationKind = incomingIsState && targetIsState
        ? "同页面的两个交互状态模型（兄弟状态）"
        : "页面级 vs 交互状态级模型（父子关系）";
      return {
        verdict: "RELATED_STATE_MODEL",
        score: urlMatchedCandidate.score,
        reasons: [
          `与 ${urlMatchedCandidate.pageId} 共享 URL：${relationKind}`,
          "不合并、不告警，仅记录页面关系"
        ],
        matchedSignals: urlMatchedCandidate.pair.matched,
        conflictingSignals: [],
        candidatePageIds: []
      };
    }
  }

  if (!best || best.score < 0.3) {
    return {
      verdict: "NEW_PAGE",
      score: best?.score ?? 0,
      reasons: best
        ? [`最高身份得分 ${best.score} 低于阈值 0.3，判定为新页面`]
        : ["没有任何已有模型存在可用的身份信号"],
      matchedSignals: allMatched,
      conflictingSignals: allConflicts,
      candidatePageIds: []
    };
  }

  // RELATED_STATE_MODEL（合法已解释关系，优先于 CONFLICT 判定）：
  // 同 URL 下的 entry/state/dimension/modal 模型与页面级模型共享 URL 是平台合法设计，
  // 这是"同一页面的不同交互状态"，既不是重复页面也不是未知冲突。
  // 行为：不 merge、不生成 identity conflict proposal、仅记录 relationship。
  const incomingIsState = looksLikeStateModel(incoming.pageId ?? "");
  const targetIsState = looksLikeStateModel(best.pageId);
  const stateMismatch = incomingIsState !== targetIsState;
  // RELATED 已在前置判定处理；此处仅处理 CONFLICT（类型不一致但 URL 不同 = 无法解释的矛盾）。

  // CONFLICT：仅保留真正互相矛盾、无法解释的 identity signals。
  if (stateMismatch && best.score < 0.75 && !best.pair.urlMatch) {
    const stateConflict = {
      modelPageId: best.pageId,
      signal: "modelType",
      detail: `incoming ${incomingIsState ? "是状态模型(entry/state)" : "是页面级模型"} vs 目标 ${targetIsState ? "是状态模型" : "是页面级模型"}，且 URL 不同：身份信号互相矛盾`
    };
    return {
      verdict: "CONFLICT",
      score: best.score,
      reasons: [
        `与 ${best.pageId} 得分 ${best.score} 但模型类型不一致且 URL 不同，无法解释为状态族关系`,
        "需要人工审核确认是否同一页面"
      ],
      matchedSignals: allMatched,
      conflictingSignals: [stateConflict, ...allConflicts],
      candidatePageIds
    };
  }
  if (allConflicts.length && best.score >= 0.3 && best.score < 0.75) {
    if (best.pair.conflicts.length >= 2) {
      return {
        verdict: "CONFLICT",
        score: best.score,
        reasons: [
          `与 ${best.pageId} 存在部分匹配（得分 ${best.score}）但伴随 ${allConflicts.length} 条冲突信号`,
          "需要人工审核确认是否同一页面"
        ],
        matchedSignals: allMatched,
        conflictingSignals: allConflicts,
        candidatePageIds
      };
    }
  }

  // pageId 精确匹配或 domHash 匹配是可直接放行的 exact identity。
  if (best.pair.pageIdExact || best.pair.domHashMatch) {
    return {
      verdict: "SAME_PAGE",
      score: best.score,
      reasons: best.pair.pageIdExact
        ? [`pageId 精确匹配: ${best.pageId}`]
        : [`DOM hash 完全一致: ${best.pageId}`],
      matchedSignals: allMatched,
      conflictingSignals: allConflicts,
      candidatePageIds,
      targetPageId: best.pageId,
      remapEvidence: best.pair.pageIdExact ? "pageId_exact" : "dom_hash_match"
    };
  }

  if (best.score >= 0.75) {
    return {
      verdict: "SAME_PAGE",
      score: best.score,
      reasons: [`URL + 语义元素组合得分 ${best.score} ≥ 0.75，判定同一页面`],
      matchedSignals: allMatched,
      conflictingSignals: allConflicts,
      candidatePageIds,
      targetPageId: best.pageId,
      remapEvidence: "url_semantic_composite"
    };
  }

  return {
    verdict: "POSSIBLE_SAME_PAGE",
    score: best.score,
    reasons: [`与 ${best.pageId} 身份得分 ${best.score}（0.3~0.75 区间），疑似同页需审核`],
    matchedSignals: allMatched,
    conflictingSignals: allConflicts,
    candidatePageIds
  };
}

/** 从 Page Model Store 读取身份信号视图。 */
export async function loadPageIdentitySignals(rootDir: string, project: string): Promise<PageIdentitySignal[]> {
  if (!/^[a-z0-9_-]+$/i.test(project)) throw new Error(`Invalid project key: ${project}`);
  const storePath = path.join(rootDir, "storage", "page-models", `${project}.json`);
  if (!(await fs.pathExists(storePath))) return [];
  const store = await fs.readJson(storePath) as Record<string, unknown>;
  const models = Array.isArray(store.models) ? store.models as Array<Record<string, unknown>> : [];
  return models.map((model) => ({
    pageId: String(model.pageId ?? ""),
    url: typeof model.url === "string" ? model.url : undefined,
    pageName: typeof model.pageName === "string" ? model.pageName : undefined,
    semanticNames: Array.isArray(model.elements)
      ? (model.elements as Array<Record<string, unknown>>).map((element) => String(element.semanticName ?? "")).filter(Boolean)
      : undefined,
    // P6：bootstrap 会携带 domHash/visibleTextHash；若不读取，SAME_PAGE 的 hash 路径永不生效。
    // 历史模型无这些字段时保持 undefined（行为不变）。
    domHash: typeof model.domHash === "string" ? model.domHash : undefined,
    visibleTextHash: typeof model.visibleTextHash === "string" ? model.visibleTextHash : undefined
  }));
}
