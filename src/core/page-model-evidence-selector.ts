import fs from "fs-extra";
import type { EvidenceRef } from "./ai-orchestration-schema.js";
import { targetPageIdsForIntent as projectRoutingTargetPageIds, primaryTargetPageIdForIntent as projectRoutingPrimaryPageId, normalizeIntentValueForProject } from "./project-intent-routing.js";
import { FALLBACK_PROJECT, FALLBACK_ENV } from "./project-defaults.js";

export type PageModelReadiness = "ready" | "partial" | "blocked_by_precondition" | "missing";
export type PageModelEvidenceRole =
  | "target_page"
  | "navigation"
  | "executable_element"
  | "action_result"
  | "assertion"
  | "provider"
  | "precondition"
  | "supporting"
  | "excluded";

export interface PageModelIntent {
  project: string;
  env: string;
  module: "asset" | "transfer" | "withdraw" | "red-packet" | "personal" | "unknown";
  action: string;
  operationType: "read" | "write" | "unknown";
  loginRequired: boolean;
  data: Record<string, unknown>;
  intentConfidence: number;
  evidence: string[];
}

export interface SelectedPageModelEvidence {
  kind: "page" | "element" | "assertion" | "block" | "precondition" | "provider";
  id: string;
  pageId?: string;
  url?: string;
  urlPattern?: string;
  semanticName?: string;
  status?: string;
  confidence?: number;
  role?: string;
  container?: string;
  region?: string;
  semanticRole?: string;
  controlType?: string;
  targetField?: string;
  optionValue?: string;
  parentElementId?: string;
  dropdown?: Record<string, unknown>;
  locatorCandidates?: unknown[];
  negativeLocatorHints?: string[];
  preconditions?: Array<Record<string, unknown>>;
  resultTable?: Record<string, unknown>;
  fieldMappings?: Array<Record<string, unknown>>;
  rowScope?: Record<string, unknown>;
  actionPostconditions?: Array<Record<string, unknown>>;
  assertionType?: string;
  targetElementId?: string;
  targetStateId?: string;
  textCandidates?: string[];
  provider?: string;
  codeType?: string;
  scene?: string;
  providerRequirementId?: string;
  entityBindings?: {
    asset?: string;
  };
  evidenceRole?: PageModelEvidenceRole;
  executionAllowed?: boolean;
  reason: string;
  evidence: EvidenceRef[];
}

export interface PageModelEvidenceBuckets {
  targetPage: SelectedPageModelEvidence[];
  navigation: SelectedPageModelEvidence[];
  executableElements: SelectedPageModelEvidence[];
  actionResults: SelectedPageModelEvidence[];
  assertions: SelectedPageModelEvidence[];
  providers: SelectedPageModelEvidence[];
  preconditions: SelectedPageModelEvidence[];
  supporting: SelectedPageModelEvidence[];
  excluded: Array<{ id: string; pageId?: string; reason: string; evidenceRole: "excluded"; executionAllowed: false }>;
}

export interface PageModelEvidenceSelection {
  schemaVersion: "page-model-evidence-selection.v1";
  request: string;
  intent: PageModelIntent;
  intentArbitration?: {
    schemaVersion: "intent-arbitration.v1";
    selectedSource: "deepseek_initial_intent" | "local_parser";
    localIntent: PageModelIntent;
    deepSeekIntent?: PageModelIntent;
    conflicts: string[];
    reasons: string[];
  };
  evidenceBuckets: PageModelEvidenceBuckets;
  selectedEvidence: SelectedPageModelEvidence[];
  fallbackEvidence: SelectedPageModelEvidence[];
  excludedEvidence: Array<{ id: string; pageId?: string; reason: string }>;
  gaps: string[];
  blockingGaps: string[];
  readiness: PageModelReadiness;
  executable: boolean;
  reason: string;
}

interface PageModelStore {
  project: string;
  models: PageModel[];
}

interface PageModel {
  pageId: string;
  pageName?: string;
  project?: string;
  module?: string;
  action?: string;
  url?: string;
  urlPattern?: string;
  status?: string;
  confidence?: number;
  evidence?: unknown[];
  elements?: PageModelElement[];
  assertions?: PageModelAssertion[];
  blockedStates?: PageModelBlock[];
  providerRequirements?: PageModelProviderRequirement[];
  resultTable?: Record<string, unknown>;
  fieldMappings?: Array<Record<string, unknown>>;
  actions?: PageModelAction[];
}

interface PageModelAction {
  actionId?: string;
  actionType?: string;
  targetElementId?: string;
  postconditions?: Array<Record<string, unknown>>;
}

interface PageModelElement {
  elementId?: string;
  sourceProposalId?: string;
  semanticName?: string;
  role?: string;
  status?: string;
  confidence?: number;
  container?: string;
  region?: string;
  semanticRole?: string;
  controlType?: string;
  targetField?: string;
  optionValue?: string;
  parentElementId?: string;
  dropdown?: Record<string, unknown>;
  locatorCandidates?: unknown[];
  negativeLocatorHints?: string[];
  preconditions?: Array<Record<string, unknown>>;
  rowScope?: Record<string, unknown>;
  evidence?: unknown[];
}

interface PageModelAssertion {
  assertionId?: string;
  sourceProposalId?: string;
  semanticName?: string;
  assertionKind?: string;
  assertionType?: string;
  targetElementId?: string;
  targetStateId?: string;
  textCandidates?: string[];
  candidates?: unknown[];
  status?: string;
  evidence?: unknown[];
}

interface PageModelBlock {
  blockId?: string;
  pageId?: string;
  blockType?: string;
  status?: string;
  requiredHumanAction?: string;
  evidence?: unknown[];
}

interface PageModelProviderRequirement {
  providerRequirementId?: string;
  provider?: string;
  codeType?: string;
  scene?: string;
  status?: string;
  mappingStatus?: string;
  providerCallStatus?: string;
  evidence?: unknown[];
}

export async function selectEvidenceForRequest(input: {
  request: string;
  pageModelStorePath: string;
  project?: string;
  env?: string;
}): Promise<PageModelEvidenceSelection> {
  const store = await fs.readJson(input.pageModelStorePath) as PageModelStore;
  return selectEvidenceFromPageModelStore({
    request: input.request,
    store,
    project: input.project ?? FALLBACK_PROJECT,
    env: input.env ?? FALLBACK_ENV
  });
}

export function selectEvidenceFromPageModelStore(input: {
  request: string;
  store: PageModelStore;
  project: string;
  env: string;
  deepSeekIntent?: unknown;
}): PageModelEvidenceSelection {
  const localIntent = parseFundsCenterIntent(input.request, input.project, input.env);
  const arbitration = arbitrateIntent(input.request, localIntent, deepSeekIntentToPageModelIntent(input.deepSeekIntent, input.project, input.env));
  const intent = arbitration.intent;
  const selectedEvidence: SelectedPageModelEvidence[] = [];
  const fallbackEvidence: SelectedPageModelEvidence[] = [];
  const excludedEvidence: Array<{ id: string; pageId?: string; reason: string }> = [];
  const gaps = new Set<string>();
  const blockingGaps = new Set<string>();
  const models = (input.store.models ?? []).filter((model) => (model.project ?? input.store.project) === input.project);
  const targetPages = targetPageIdsForIntent(intent);
  // 项目未注册意图路由时退化为全页面候选，由意图匹配自然选择，而不是排除所有页面。
  const pageModels = targetPages.length > 0
    ? targetPages.map((pageId) => models.find((model) => model.pageId === pageId)).filter(Boolean) as PageModel[]
    : models;

  for (const model of models) {
    if (targetPages.length > 0 && !targetPages.includes(model.pageId)) {
      excludedEvidence.push({ id: model.pageId, pageId: model.pageId, reason: "module_or_action_not_relevant_to_request" });
    }
  }

  for (const model of pageModels) {
    selectedEvidence.push(pageEvidence(model, reasonForPage(intent, model)));
    for (const element of selectRelevantElements(intent, model)) selectedEvidence.push(elementEvidence(model, element));
    for (const assertion of selectRelevantAssertions(intent, model)) fallbackEvidence.push(assertionEvidence(model, assertion));
    for (const provider of model.providerRequirements ?? []) fallbackEvidence.push(providerRequirementEvidence(model, provider));
    for (const block of model.blockedStates ?? []) fallbackEvidence.push(blockEvidence(model, block));
  }

  for (const gap of expectedGaps(intent, selectedEvidence, fallbackEvidence)) {
    gaps.add(gap);
    if (isBlockingGap(gap)) blockingGaps.add(gap);
  }
  for (const gap of arbitration.blockingGaps) {
    gaps.add(gap);
    blockingGaps.add(gap);
  }

  const hasSatisfiedTransferSubmitResult =
    intent.module === "transfer" && hasVerifiedTransferSubmitResultAssertion(fallbackEvidence);
  const hasBlockingPrecondition =
    intent.operationType === "write" &&
    !hasSatisfiedTransferSubmitResult &&
    fallbackEvidence.some((item) => item.kind === "block" && /precondition|blocked/i.test(`${item.status ?? ""} ${item.reason}`));
  const readiness = computeReadiness(pageModels, gaps, hasBlockingPrecondition);
  const evidenceBuckets = buildEvidenceBuckets(intent, selectedEvidence, fallbackEvidence, excludedEvidence);
  return {
    schemaVersion: "page-model-evidence-selection.v1",
    request: input.request,
    intent,
    intentArbitration: arbitration.summary,
    evidenceBuckets,
    selectedEvidence,
    fallbackEvidence,
    excludedEvidence,
    gaps: [...gaps],
    blockingGaps: [...blockingGaps],
    readiness,
    executable: readiness === "ready",
    reason: readiness === "ready"
      ? "Page Model evidence is sufficient for an executable draft."
      : hasBlockingPrecondition
        ? "Page Model exists, but execution requires precondition or deeper state validation."
        : "Page Model evidence is partial; DSL dry-run must expose gaps instead of forcing execution."
  };
}

export function rebuildEvidenceBuckets(selection: PageModelEvidenceSelection): void {
  selection.evidenceBuckets = buildEvidenceBuckets(
    selection.intent,
    selection.selectedEvidence,
    selection.fallbackEvidence,
    selection.excludedEvidence
  );
}

export function parseFundsCenterIntent(request: string, project = FALLBACK_PROJECT, env = FALLBACK_ENV): PageModelIntent {
  const normalIntent = parseNormalFundsCenterIntent(request, project, env);
  if (normalIntent) return normalIntent;
  const earnIntent = parseEarnOperationIntent(request, project, env);
  if (earnIntent) return earnIntent;
  const redPacketIntent = parseRedPacketIntent(request, project, env);
  if (redPacketIntent) return redPacketIntent;
  const personalIntent = parsePersonalCenterIntent(request, project, env);
  if (personalIntent) return personalIntent;
  if (isWithdrawAddressManagementRequest(request)) {
    return withdrawAddressManagementIntent(request, project, env, 0.86);
  }
  if (/提现|提币|withdraw/i.test(request)) {
    return {
      project,
      env,
      module: "withdraw",
      action: "submit_withdraw",
      operationType: "write",
      loginRequired: /登录|login/i.test(request),
      data: {
        asset: extractAsset(request),
        network: extractNetwork(request),
        address: request.match(/0x[a-fA-F0-9]{32,}/)?.[0],
        amount: extractAmount(request),
        amountPolicy: extractWithdrawAmountPolicy(request)
      },
      intentConfidence: 0.84,
      evidence: ["keyword:提现", "keyword:链", "keyword:提现地址"]
    };
  }

  if (/划转|transfer/i.test(request)) {
    return {
      project,
      env,
      module: "transfer",
      action: "spot_to_futures",
      operationType: "write",
      loginRequired: /登录|login/i.test(request),
      data: {
        asset: extractAsset(request),
        amount: extractAmount(request),
        fromAccount: /现货/.test(request) ? "spot" : undefined,
        toAccount: /合约/.test(request) ? "futures" : undefined
      },
      intentConfidence: 0.82,
      evidence: ["keyword:划转", "keyword:现货账户", "keyword:合约账户"]
    };
  }

  if (/资金流水|流水|赠币|筛选|record|history|filter/i.test(request)) {
    return {
      project,
      env,
      module: "asset",
      action: "spot_fund_flow_filter",
      operationType: "read",
      loginRequired: /登录|login/i.test(request),
      data: {
        account: /现货/.test(request) ? "spot" : undefined,
        type: /赠币/.test(request) ? "赠币" : undefined
      },
      intentConfidence: 0.78,
      evidence: ["keyword:现货账户", "keyword:资金流水", "keyword:赠币"]
    };
  }

  return {
    project,
    env,
    module: "unknown",
    action: "unknown",
    operationType: "unknown",
    loginRequired: /登录|login/i.test(request),
    data: {},
    intentConfidence: 0.3,
    evidence: ["fallback:unknown"]
  };
}

function deepSeekIntentToPageModelIntent(raw: unknown, project: string, env: string): PageModelIntent | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as Record<string, unknown>;
  const pageIntent = String(record.pageIntent ?? "");
  const businessAction = String(record.businessAction ?? "");
  const expectedOutcome = String(record.expectedOutcome ?? "");
  const operationType = normalizeDeepSeekOperationType(record.operationType);
  const extractedData = record.extractedData && typeof record.extractedData === "object"
    ? record.extractedData as Record<string, unknown>
    : {};
  const assertions = Array.isArray(record.assertions) ? record.assertions as Array<Record<string, unknown>> : [];
  const extractedContext = Object.values(extractedData).map((value) => typeof value === "string" || typeof value === "number" ? String(value) : "").join(" ");
  const combined = `${pageIntent} ${businessAction} ${expectedOutcome} ${extractedContext}`;
  const batchRedeemModalView = deepSeekEarnBatchRedeemModalViewIntent(combined, extractedData, operationType, project, env, record.confidence);
  if (batchRedeemModalView) return batchRedeemModalView;
  const financeAccountView = deepSeekFinanceAccountViewIntent(combined, extractedData, operationType, project, env, record.confidence);
  if (financeAccountView) return financeAccountView;
  const earnProductView = deepSeekEarnProductViewIntent(combined, extractedData, operationType, project, env, record.confidence);
  if (earnProductView) return earnProductView;
  if (hasExplicitWithdrawAddressManagementPageContext(combined)) {
    const uid = stringFromObject(extractedData, ["UID", "uid", "internalUid", "站内地址"]);
    const intent = withdrawAddressManagementIntent(uid ? `${combined} UID${uid}` : combined, project, env, numberOrDefault(record.confidence, 0.86));
    return {
      ...intent,
      data: { ...intent.data, uid: uid ?? intent.data.uid, internalUid: uid ?? intent.data.internalUid },
      evidence: [...intent.evidence, "deepseek_initial_intent", "deepseek_explicit_page_context"]
    };
  }
  const isRedPacketPage = /红包页面|红包模块|red\s*packet\s*page|资产中心-红包/i.test(pageIntent);
  const redAction = /创建|发放|领取|口令|红包记录|红包明细|create|claim|receive|passphrase|record/i.test(businessAction);
  const isFundFlowValueOnly = /流水|fund\s*flow|result_table|列表|筛选|搜索|查询/i.test(combined);
  if ((isRedPacketPage || redAction) && !isFundFlowValueOnly) {
    const intent = parseRedPacketIntent(`${pageIntent} ${businessAction}`, project, env);
    if (intent) return { ...intent, evidence: [...intent.evidence, "deepseek_initial_intent"], intentConfidence: numberOrDefault(record.confidence, intent.intentConfidence) };
  }
  const personalIntent = parsePersonalCenterIntent(combined, project, env);
  if (personalIntent) {
    return {
      ...personalIntent,
      intentConfidence: numberOrDefault(record.confidence, personalIntent.intentConfidence),
      evidence: [...personalIntent.evidence, "deepseek_initial_intent"],
      data: {
        ...personalIntent.data,
        deepSeekIntent: { pageIntent, businessAction, expectedOutcome }
      }
    };
  }
  const earnOperation = deepSeekEarnOperationKind(combined);
  if (earnOperation) {
    const assetValue = normalizeAssetSymbolCandidate(
      stringFromObject(extractedData, ["币种", "资产", "产品币种", "产品代码", "产品", "asset", "currency", "coin", "symbol", "product", "productSymbol"])
    );
    const amountValue = numericFromObject(extractedData, ["数量", "金额", "amount", "quantity"]);
    return {
      project,
      env,
      module: "asset",
      action: earnOperation === "redeem" ? "earn_redeem" : "earn_subscribe",
      operationType: "write",
      loginRequired: true,
      data: {
        asset: assetValue,
        amount: amountValue,
        productType: stringFromObject(extractedData, ["产品类型", "productType"]),
        deepSeekIntent: {
          pageIntent,
          businessAction,
          expectedOutcome
        }
      },
      intentConfidence: numberOrDefault(record.confidence, 0.86),
      evidence: [
        "deepseek_initial_intent",
        `deepseek_action:earn_${earnOperation}`,
        ...(assetValue ? [`deepseek_asset:${assetValue}`] : []),
        ...(amountValue !== undefined ? [`deepseek_amount:${amountValue}`] : [])
      ]
    };
  }
  const explicitFundFlow = deepSeekFundFlowKind(combined);
  if (explicitFundFlow) {
    const typeValue = stringFromObject(extractedData, ["类型筛选", "交易类型", "recordType", "type"])
      ?? assertions.map((item) => item.field && /类型|type/i.test(String(item.field)) ? item.expected : undefined).find((item): item is string => typeof item === "string" && item.trim().length > 0);
    const assetValue = stringFromObject(extractedData, ["币种", "资产", "asset", "currency", "coin"]);
    const action = explicitFundFlow === "earn"
      ? "earn_fund_flow_filter"
      : explicitFundFlow === "contract"
        ? "contract_fund_flow_filter"
        : "spot_fund_flow_filter";
    return {
      project,
      env,
      module: "asset",
      action,
      operationType: operationType === "write" ? "unknown" : "read",
      loginRequired: true,
      data: {
        account: explicitFundFlow,
        asset: assetValue,
        type: typeValue,
        recordType: typeValue,
        productType: stringFromObject(extractedData, ["产品类型", "productType"]),
        deepSeekIntent: {
          pageIntent,
          businessAction,
          expectedOutcome
        }
      },
      intentConfidence: numberOrDefault(record.confidence, 0.86),
      evidence: [
        "deepseek_initial_intent",
        `deepseek_page:${explicitFundFlow}_fund_flow`,
        ...(typeValue ? [`deepseek_filter_value:${typeValue}`] : [])
      ]
    };
  }
  if (/提现|提币|withdraw|地址管理|address/i.test(combined)) {
    const uid = stringFromObject(extractedData, ["UID", "uid", "internalUid", "站内地址"]);
    if (/地址管理|address.management|添加地址|add.address|UID/i.test(combined) || uid) {
      const intent = withdrawAddressManagementIntent(uid ? `${combined} UID${uid}` : combined, project, env, numberOrDefault(record.confidence, 0.86));
      return {
        ...intent,
        data: { ...intent.data, uid: uid ?? intent.data.uid, internalUid: uid ?? intent.data.internalUid },
        evidence: [...intent.evidence, "deepseek_initial_intent"]
      };
    }
  }
  return undefined;
}

function arbitrateIntent(request: string, localIntent: PageModelIntent, deepSeekIntent?: PageModelIntent): {
  intent: PageModelIntent;
  blockingGaps: string[];
  summary: PageModelEvidenceSelection["intentArbitration"];
} {
  const conflicts: string[] = [];
  const reasons: string[] = [];
  let selectedSource: "deepseek_initial_intent" | "local_parser" = "local_parser";
  let intent = localIntent;
  if (deepSeekIntent) {
    if (deepSeekIntent.module !== localIntent.module) conflicts.push(`module:${deepSeekIntent.module}!=${localIntent.module}`);
    if (deepSeekIntent.action !== localIntent.action) conflicts.push(`action:${deepSeekIntent.action}!=${localIntent.action}`);
    if (deepSeekIntent.operationType !== "unknown" && localIntent.operationType !== "unknown" && deepSeekIntent.operationType !== localIntent.operationType) {
      conflicts.push(`operationType:${deepSeekIntent.operationType}!=${localIntent.operationType}`);
    }
    const deepSeekPageAligned = explicitPageContextMatchesIntent(request, deepSeekIntent);
    const localPageAligned = explicitPageContextMatchesIntent(request, localIntent);
    const requestHasExplicitPageContext = hasExplicitPageContext(request);
    const localContradictsExplicitPage = !localPageAligned && requestHasExplicitPageContext;
    const compatibleConflicts = conflicts.filter((item) => isIntentHierarchyCompatible(request, localIntent, deepSeekIntent, item));
    const deepSeekReadLocalWriteWithoutExecution =
      deepSeekIntent.operationType === "read" &&
      localIntent.operationType === "write" &&
      !hasExplicitWriteExecutionCue(request);
    if (compatibleConflicts.length) {
      reasons.push(`Intent hierarchy treated compatible conflicts as page context vs in-page operation: ${compatibleConflicts.join(",")}.`);
      for (const item of compatibleConflicts) {
        const index = conflicts.indexOf(item);
        if (index >= 0) conflicts.splice(index, 1);
      }
    }
    if (deepSeekReadLocalWriteWithoutExecution) {
      intent = mergeIntentData(localIntent, deepSeekIntent);
      selectedSource = "deepseek_initial_intent";
      conflicts.length = 0;
      reasons.push("DeepSeek read intent is preserved because the request only observes action controls and has no explicit write execution cue.");
    } else if (deepSeekPageAligned && !localPageAligned && requestHasExplicitPageContext) {
      intent = mergeIntentData(localIntent, deepSeekIntent);
      selectedSource = "deepseek_initial_intent";
      conflicts.length = 0;
      reasons.push("DeepSeek initial intent is aligned with explicit page context; local parser result is treated as lower-priority evidence.");
    } else if (localPageAligned && !deepSeekPageAligned && requestHasExplicitPageContext) {
      conflicts.length = 0;
      reasons.push("Local parser is aligned with explicit page context; DeepSeek candidate is treated as noisy state evidence instead of a blocker.");
    } else if (deepSeekPageAligned && (conflicts.length || deepSeekIntent.intentConfidence >= localIntent.intentConfidence)) {
      intent = mergeIntentData(localIntent, deepSeekIntent);
      selectedSource = "deepseek_initial_intent";
      reasons.push("DeepSeek initial intent is aligned with explicit page context; local parser result is treated as lower-priority evidence.");
    } else if (conflicts.length) {
      reasons.push("DeepSeek initial intent conflicts with local parser, but no explicit page context gives it priority.");
    }
    if (localContradictsExplicitPage) {
      conflicts.push("local_parser_contradicts_explicit_page_context");
    }
  }
  const blockingGaps = conflicts.length && selectedSource === "local_parser" && hasSevereIntentConflict(conflicts)
    ? conflicts.map((item) => `intent_arbitration_conflict:${item}`)
    : [];
  return {
    intent: { ...intent, evidence: [...new Set([...intent.evidence, `intent_arbitration:${selectedSource}`])] },
    blockingGaps,
    summary: {
      schemaVersion: "intent-arbitration.v1",
      selectedSource,
      localIntent,
      deepSeekIntent,
      conflicts: [...new Set(conflicts)],
      reasons
    }
  };
}

function mergeIntentData(localIntent: PageModelIntent, deepSeekIntent: PageModelIntent): PageModelIntent {
  return {
    ...deepSeekIntent,
    data: mergeIntentDataValues(localIntent.data, deepSeekIntent.data),
    loginRequired: localIntent.loginRequired || deepSeekIntent.loginRequired,
    evidence: [...new Set([...deepSeekIntent.evidence, ...localIntent.evidence.filter((item) => !/^keyword:red_packet|keyword:create_red_packet/.test(item))])]
  };
}

function mergeIntentDataValues(localData: Record<string, unknown>, deepSeekData: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...localData };
  for (const [key, value] of Object.entries(deepSeekData)) {
    if (!isConcreteIntentValue(value)) continue;
    merged[key] = value;
  }
  if (typeof merged.productType === "string" && normalizeText(String(merged.recordType ?? merged.type ?? "")) === normalizeText(merged.productType)) {
    delete merged.recordType;
    delete merged.type;
  }
  return merged;
}

function isConcreteIntentValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value as Record<string, unknown>).length > 0;
  return true;
}

function isIntentHierarchyCompatible(request: string, localIntent: PageModelIntent, deepSeekIntent: PageModelIntent, conflict: string): boolean {
  if (localIntent.module !== deepSeekIntent.module) return false;
  if (!isManagementPageContextAction(deepSeekIntent.action)) return false;
  if (!isChildWriteAction(localIntent.action)) return false;
  if (!hasExplicitChildWriteCue(request)) return false;
  if (conflict === `action:${deepSeekIntent.action}!=${localIntent.action}`) return true;
  if (conflict === `operationType:${deepSeekIntent.operationType}!=${localIntent.operationType}` && deepSeekIntent.operationType === "read" && localIntent.operationType === "write") return true;
  return false;
}

function isManagementPageContextAction(action: string): boolean {
  return /^(manage_|view_|list_|open_)/.test(action) || /management|manage|list|view|open/.test(action);
}

function isChildWriteAction(action: string): boolean {
  return /^(add_|create_|edit_|update_|delete_|remove_|save_)/.test(action) || /add|create|edit|update|delete|remove|save/.test(action);
}

function hasExplicitChildWriteCue(request: string): boolean {
  return /添加|新增|创建|编辑|修改|删除|移除|保存|提交|点击.*保存|add|create|edit|update|delete|remove|save|submit/i.test(request);
}

function hasExplicitWriteExecutionCue(request: string): boolean {
  return /(?:^|[^可不])点击.{0,24}(?:确认|确定|提交|保存|创建|新增|删除|申购|赎回|提现|提币|划转|领取|绑定|解绑|修改|开始认证)|(?:输入|填写|选择).{0,24}(?:金额|数量|地址|验证码|密码|UID|币种|类型|名称|昵称)|(?:确认|确定|提交|保存|创建|新增|删除|申购|赎回|提现|提币|划转|领取|绑定|解绑|修改|认证).{0,16}(?:成功|失败|完成)|submit|confirm|save|create|delete|withdraw|transfer|subscribe|redeem|purchase/i.test(request);
}

function explicitPageContextMatchesIntent(request: string, intent: PageModelIntent): boolean {
  if (/红包记录|红包明细/.test(request)) return intent.module === "red-packet" && intent.action === "view_red_packet_records";
  if (/红包页面|红包模块|资产中心-红包/.test(request)) return intent.module === "red-packet";
  if (/个人中心|用户中心|账号管理|账户管理|身份认证|API管理|API\s*管理|KYC/i.test(request)) return intent.module === "personal";
  if (/现货流水|资金流水/.test(request)) return intent.module === "asset" && intent.action === "spot_fund_flow_filter";
  if (/理财流水/.test(request)) return intent.module === "asset" && intent.action === "earn_fund_flow_filter";
  if (/理财账户|资产中心-理财/.test(request)) return intent.module === "asset" && (intent.action === "earn_redeem" || intent.action === "earn_subscribe" || intent.action === "earn_position_view" || intent.action === "earn_batch_redeem_modal_view" || intent.action === "earn_fund_flow_filter");
  if (/更多-理财|理财产品/.test(request)) return intent.module === "asset" && (intent.action === "earn_subscribe" || intent.action === "earn_redeem" || intent.action === "earn_product_view");
  if (/合约流水/.test(request)) return intent.module === "asset" && intent.action === "contract_fund_flow_filter";
  if (hasExplicitWithdrawAddressManagementPageContext(request)) return intent.module === "withdraw" && (intent.action === "manage_withdraw_address" || intent.action === "add_withdraw_address");
  return true;
}

function hasExplicitPageContext(request: string): boolean {
  return /个人中心|用户中心|账号管理|账户管理|身份认证|API管理|API\s*管理|KYC|现货流水|资金流水|理财流水|理财账户|资产中心-理财|更多-理财|理财产品|合约流水|红包页面|红包模块|资产中心-红包|红包记录|红包明细|地址管理|提现-地址管理|提币-地址管理|address[-_\s]*manage|address\s*management|\/assets\/address-manage/i.test(request);
}

function hasSevereIntentConflict(conflicts: string[]): boolean {
  return conflicts.some((item) => item.startsWith("module:") || item.startsWith("operationType:") || item === "local_parser_contradicts_explicit_page_context");
}

function deepSeekFundFlowKind(text: string): "spot" | "earn" | "contract" | undefined {
  if (/理财流水|理财资金流水|earn\s*fund\s*flow/i.test(text)) return "earn";
  if (/合约流水|合约资金流水|contract\s*fund\s*flow|futures\s*fund\s*flow/i.test(text)) return "contract";
  if (/现货流水|现货资金流水|资金流水页面|fund\s*flow|流水页面/i.test(text)) return "spot";
  return undefined;
}

function deepSeekEarnOperationKind(text: string): "redeem" | "subscribe" | undefined {
  if (/理财流水|资金流水|流水|fund\s*flow|record|history|filter/i.test(text)) return undefined;
  if (!/理财账户|资产中心-理财|更多-理财|理财产品|活期理财|定期理财|earn/i.test(text)) return undefined;
  if (/读取|查看|展示|显示|列表|可见|浏览|状态可读|可读取|不执行切换|不改变/i.test(text) && !hasEarnProductWriteCue(text)) return undefined;
  if (/赎回|redeem/i.test(text)) return "redeem";
  if (/申购|购买|买入|subscribe|purchase/i.test(text)) return "subscribe";
  return undefined;
}

function deepSeekFinanceAccountViewIntent(
  text: string,
  extractedData: Record<string, unknown>,
  operationType: "read" | "write" | "unknown",
  project: string,
  env: string,
  confidence: unknown
): PageModelIntent | undefined {
  if (operationType === "write") return undefined;
  if (!/理财账户|资产中心-理财账户|资产中心-理财|finance account|earn account/i.test(text)) return undefined;
  if (!/读取|查看|展示|显示|进入|打开|列表|持仓|可见|浏览|状态可读|可读取|view|list|visible|read/i.test(text)) return undefined;
  if (hasEarnProductWriteCue(text)) return undefined;
  const assetValue = normalizeAssetSymbolCandidate(stringFromObject(extractedData, ["币种", "资产", "产品币种", "产品代码", "asset", "currency", "coin", "symbol"]));
  return {
    project,
    env,
    module: "asset",
    action: "earn_position_view",
    operationType: "read",
    loginRequired: true,
    data: {
      asset: assetValue,
      entry: "asset_earn_account",
      deepSeekIntent: { pageIntent: text }
    },
    intentConfidence: numberOrDefault(confidence, 0.86),
    evidence: ["deepseek_initial_intent", "deepseek_action:earn_position_view"]
  };
}

function deepSeekEarnBatchRedeemModalViewIntent(
  text: string,
  extractedData: Record<string, unknown>,
  operationType: "read" | "write" | "unknown",
  project: string,
  env: string,
  confidence: unknown
): PageModelIntent | undefined {
  if (operationType === "write") return undefined;
  if (!/理财账户|资产中心-理财|finance account/i.test(text)) return undefined;
  if (!/批量赎回/.test(text)) return undefined;
  if (!/查看|展示|显示|打开|弹窗|不展示|未提供|没有|不存在|不可编辑|输入框|view|visible/i.test(text)) return undefined;
  if (/点击确认|点击确定|提交|赎回成功|确认赎回|提交赎回/i.test(text)) return undefined;
  const assetValue = normalizeAssetSymbolCandidate(stringFromObject(extractedData, ["币种", "资产", "产品币种", "产品代码", "asset", "currency", "coin", "symbol"]));
  return {
    project,
    env,
    module: "asset",
    action: "earn_batch_redeem_modal_view",
    operationType: "read",
    loginRequired: true,
    data: {
      asset: assetValue,
      entry: "asset_earn_account",
      deepSeekIntent: { pageIntent: text }
    },
    intentConfidence: numberOrDefault(confidence, 0.86),
    evidence: ["deepseek_initial_intent", "deepseek_action:earn_batch_redeem_modal_view"]
  };
}

function deepSeekEarnProductViewIntent(
  text: string,
  extractedData: Record<string, unknown>,
  operationType: "read" | "write" | "unknown",
  project: string,
  env: string,
  confidence: unknown
): PageModelIntent | undefined {
  if (operationType === "write") return undefined;
  if (!/更多-理财|理财产品|产品中心|earn product|product center/i.test(text)) return undefined;
  if (!/查看|展示|显示|列表|可见|浏览|view|list/i.test(text)) return undefined;
  if (hasEarnProductWriteCue(text)) return undefined;
  const assetValue = normalizeAssetSymbolCandidate(stringFromObject(extractedData, ["币种", "资产", "产品币种", "产品代码", "asset", "currency", "coin", "symbol"]));
  return {
    project,
    env,
    module: "asset",
    action: "earn_product_view",
    operationType: "read",
    loginRequired: true,
    data: {
      asset: assetValue,
      productName: stringFromObject(extractedData, ["产品名称", "productName", "product"]),
      status: stringFromObject(extractedData, ["状态", "status"]),
      productType: stringFromObject(extractedData, ["产品类型", "productType"]),
      deepSeekIntent: { pageIntent: text }
    },
    intentConfidence: numberOrDefault(confidence, 0.86),
    evidence: ["deepseek_initial_intent", "deepseek_action:earn_product_view"]
  };
}

function normalizeDeepSeekOperationType(value: unknown): "read" | "write" | "unknown" {
  const text = String(value ?? "").toLowerCase();
  if (text === "read" || /查询|搜索|查看|筛选/.test(text)) return "read";
  if (text === "write" || /创建|保存|提交|领取|发起|申购|赎回/.test(text)) return "write";
  return "unknown";
}

function stringFromObject(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number") return String(value);
  }
  return undefined;
}

function numericFromObject(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value.replace(/[^\d.]/g, "")) : NaN;
    if (Number.isFinite(numeric) && numeric > 0) return numeric;
  }
  return undefined;
}

function numberOrDefault(value: unknown, fallback: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

function parseNormalFundsCenterIntent(request: string, project: string, env: string): PageModelIntent | undefined {
  if (hasExplicitFundFlowPageContext(request)) {
    const typeValue = extractFundFlowType(request);
    const assetValue = extractAsset(request);
    const timeRange = extractTimeRange(request);
    const isEarnFundFlow = /\u7406\u8d22\u6d41\u6c34|\u7406\u8d22/.test(request);
    const isContractFundFlow = /\u5408\u7ea6\u6d41\u6c34|\u5408\u7ea6/.test(request);
    return {
      project,
      env,
      module: "asset",
      action: isEarnFundFlow ? "earn_fund_flow_filter" : isContractFundFlow ? "contract_fund_flow_filter" : "spot_fund_flow_filter",
      operationType: "read",
      loginRequired: /\u767b\u5f55|login/i.test(request),
      data: {
        account: isEarnFundFlow ? "earn" : isContractFundFlow ? "contract" : /\u73b0\u8d27/.test(request) ? "spot" : undefined,
        asset: assetValue,
        type: typeValue,
        recordType: typeValue,
        productType: extractEarnProductType(request),
        timeRange,
        resetRequested: isResetRequested(request)
      },
      intentConfidence: 0.94,
      evidence: [
        "page_context:fund_flow",
        isEarnFundFlow ? "keyword:earn_fund_flow" : isContractFundFlow ? "keyword:contract_fund_flow" : "keyword:spot_fund_flow",
        ...(assetValue ? [`keyword:asset:${assetValue}`] : []),
        ...(typeValue ? [`keyword:record_type:${typeValue}`] : []),
        ...(timeRange ? [`keyword:time_range:${timeRange.raw}`] : []),
        "domain_vocabulary"
      ]
    };
  }

  const earnIntent = parseEarnOperationIntent(request, project, env);
  if (earnIntent) return earnIntent;

  const redPacketIntent = parseRedPacketIntent(request, project, env);
  if (redPacketIntent) return redPacketIntent;

  if (isWithdrawAddressManagementRequest(request)) {
    return withdrawAddressManagementIntent(request, project, env, 0.92);
  }

  if (/\u63d0\u73b0|\u63d0\u5e01|withdraw/i.test(request)) {
    return {
      project,
      env,
      module: "withdraw",
      action: "submit_withdraw",
      operationType: "write",
      loginRequired: /\u767b\u5f55|login/i.test(request),
      data: {
        asset: extractAsset(request),
        network: extractNetwork(request),
        address: request.match(/0x[a-fA-F0-9]{32,}/)?.[0],
        amount: extractAmount(request),
        amountPolicy: extractWithdrawAmountPolicy(request)
      },
      intentConfidence: 0.9,
      evidence: ["keyword:withdraw", "keyword:asset", "keyword:network", "domain_vocabulary"]
    };
  }

  if (/\u5212\u8f6c|transfer/i.test(request)) {
    return {
      project,
      env,
      module: "transfer",
      action: "spot_to_futures",
      operationType: "write",
      loginRequired: /\u767b\u5f55|login/i.test(request),
      data: {
        asset: extractAsset(request),
        amount: extractAmount(request),
        fromAccount: /\u73b0\u8d27/.test(request) ? "spot" : undefined,
        toAccount: /\u5408\u7ea6/.test(request) ? "futures" : undefined
      },
      intentConfidence: 0.88,
      evidence: ["keyword:transfer", "keyword:spot_account", "keyword:futures_account", "domain_vocabulary"]
    };
  }

  if (/\u7406\u8d22\u6d41\u6c34|\u5408\u7ea6\u6d41\u6c34|\u8d44\u91d1\u6d41\u6c34|\u73b0\u8d27\u6d41\u6c34|\u6d41\u6c34|record|history|filter/i.test(request)) {
    const typeValue = extractFundFlowType(request);
    const assetValue = extractAsset(request);
    const timeRange = extractTimeRange(request);
    const isEarnFundFlow = /\u7406\u8d22\u6d41\u6c34|\u7406\u8d22/.test(request);
    const isContractFundFlow = /\u5408\u7ea6\u6d41\u6c34|\u5408\u7ea6/.test(request);
    return {
      project,
      env,
      module: "asset",
      action: isEarnFundFlow ? "earn_fund_flow_filter" : isContractFundFlow ? "contract_fund_flow_filter" : "spot_fund_flow_filter",
      operationType: "read",
      loginRequired: /\u767b\u5f55|login/i.test(request),
      data: {
        account: isEarnFundFlow ? "earn" : isContractFundFlow ? "contract" : /\u73b0\u8d27/.test(request) ? "spot" : undefined,
        asset: assetValue,
        type: typeValue,
        recordType: typeValue,
        productType: extractEarnProductType(request),
        timeRange,
        resetRequested: isResetRequested(request)
      },
      intentConfidence: 0.88,
      evidence: [
        isEarnFundFlow ? "keyword:earn_fund_flow" : isContractFundFlow ? "keyword:contract_fund_flow" : "keyword:spot_fund_flow",
        ...(assetValue ? [`keyword:asset:${assetValue}`] : []),
        ...(typeValue ? [`keyword:record_type:${typeValue}`] : []),
        ...(timeRange ? [`keyword:time_range:${timeRange.raw}`] : []),
        "domain_vocabulary"
      ]
    };
  }

  if (/提现|提币|withdraw/i.test(request)) {
    return {
      project,
      env,
      module: "withdraw",
      action: "submit_withdraw",
      operationType: "write",
      loginRequired: /登录|login/i.test(request),
      data: {
        asset: extractAsset(request),
        network: extractNetwork(request),
        address: request.match(/0x[a-fA-F0-9]{32,}/)?.[0],
        amount: extractAmount(request),
        amountPolicy: extractWithdrawAmountPolicy(request)
      },
      intentConfidence: 0.86,
      evidence: ["keyword:提现", "keyword:链", "keyword:提现地址"]
    };
  }

  if (/划转|transfer/i.test(request)) {
    return {
      project,
      env,
      module: "transfer",
      action: "spot_to_futures",
      operationType: "write",
      loginRequired: /登录|login/i.test(request),
      data: {
        asset: extractAsset(request),
        amount: extractAmount(request),
        fromAccount: /现货/.test(request) ? "spot" : undefined,
        toAccount: /合约/.test(request) ? "futures" : undefined
      },
      intentConfidence: 0.84,
      evidence: ["keyword:划转", "keyword:现货账户", "keyword:合约账户"]
    };
  }

  if (/资金流水|现货流水|流水|赠币|筛选|record|history|filter/i.test(request)) {
    return {
      project,
      env,
      module: "asset",
      action: "spot_fund_flow_filter",
      operationType: "read",
      loginRequired: /登录|login/i.test(request),
      data: {
        account: /现货/.test(request) ? "spot" : undefined,
        type: /赠币/.test(request) ? "赠币" : undefined
      },
      intentConfidence: 0.8,
      evidence: ["keyword:现货账户", "keyword:资金流水", "keyword:赠币"]
    };
  }
  return undefined;
}

function parsePersonalCenterIntent(request: string, project: string, env: string): PageModelIntent | undefined {
  const hasExplicitPersonalPageContext = /个人中心|用户中心|账号管理|账户管理|账户活动|身份认证|API管理|API\s*管理|KYC|邀请码|昵称/i.test(request);
  const hasSecuritySettingContext = /登录密码|谷歌验证码|资金密码|手机号/i.test(request) && /安全设置|账号安全|账户安全|绑定|解绑|修改|查看|个人资料|账号资料/i.test(request);
  const hasPersonalContext = hasExplicitPersonalPageContext || hasSecuritySettingContext;
  if (!hasPersonalContext) return undefined;
  const wantsApi = /API管理|API\s*管理|API\s*Key|创建API|立即创建/i.test(request);
  const wantsKyc = /身份认证|KYC|认证状态|开始认证|国家或地区/i.test(request);
  const wantsInvite = /邀请码|邀请链接|我的邀请码/i.test(request);
  const wantsNickname = /昵称|修改昵称/i.test(request);
  const explicitClick = /点击|打开|开始认证|立即创建|创建API|查看|修改/i.test(request);
  const isPureDisplayExpectation = /期望|断言|应该|展示|显示|可见/.test(request) && !/点击|打开/.test(request);
  const wantsModal = explicitClick && !isPureDisplayExpectation;
  const wantsDisabled = /置灰|不可点击|禁用|不可用|disabled/i.test(request);
  const nicknameValue = extractNicknameValue(request);
  const wantsNicknameUpdate = wantsNickname && !wantsDisabled && /修改|更新|改|保存|成功|高亮|可点击|可用|变更/i.test(request);
  const action = wantsApi
    ? wantsModal && /创建API|立即创建|点击/i.test(request) ? "open_api_create_modal" : "view_api_management"
    : wantsKyc
      ? wantsModal && /开始认证|点击/i.test(request) ? "open_kyc_start_modal" : "view_kyc_status"
      : wantsInvite
        ? "open_invite_modal"
        : wantsNickname && wantsDisabled
          ? "assert_nickname_confirm_disabled"
          : wantsNicknameUpdate
            ? "update_nickname"
          : wantsNickname && wantsModal
            ? "open_nickname_modal"
            : "view_account_security";
  return {
    project,
    env,
    module: "personal",
    action,
    operationType: action.startsWith("view_") || action === "open_invite_modal" || action.includes("disabled") ? "read" : "write",
    loginRequired: /登录|login/i.test(request),
    data: {
      targetPage: wantsApi ? "api_management" : wantsKyc ? "kyc" : "account",
      modal: action.includes("modal"),
      disabledAssertion: wantsDisabled,
      nickname: nicknameValue,
      nicknamePolicy: wantsNicknameUpdate && !nicknameValue ? "generate_valid_changed_value" : undefined,
      maxLength: wantsNicknameUpdate ? 10 : undefined
    },
    intentConfidence: 0.9,
    evidence: [
      "page_context:personal_center",
      wantsApi ? "keyword:api_management" : wantsKyc ? "keyword:kyc" : "keyword:account_management",
      "domain_vocabulary"
    ]
  };
}

function extractNicknameValue(request: string): string | undefined {
  const patterns = [
    /昵称(?:修改|更新)?为\s*["“”']?([^"“”'，,。；;\s]+)["“”']?/,
    /昵称(?:改成|改为|改到)\s*["“”']?([^"“”'，,。；;\s]+)["“”']?/,
    /将昵称(?:修改|更新)?为\s*["“”']?([^"“”'，,。；;\s]+)["“”']?/,
    /将昵称(?:改成|改为|改到)\s*["“”']?([^"“”'，,。；;\s]+)["“”']?/,
    /新昵称(?:为|是|输入)?\s*["“”']?([^"“”'，,。；;\s]+)["“”']?/
  ];
  for (const pattern of patterns) {
    const value = request.match(pattern)?.[1]?.trim();
    if (value && !isGenericNicknamePlaceholder(value)) return value.slice(0, 10);
  }
  return undefined;
}

function isGenericNicknamePlaceholder(value: string): boolean {
  return /^(一个|不同于当前昵称|新昵称|当前昵称|昵称|有效昵称|随机昵称)$/i.test(value.trim());
}

function parseRedPacketIntent(request: string, project: string, env: string): PageModelIntent | undefined {
  if (!/\u7ea2\u5305|red\s*packet|red-packet/i.test(request)) return undefined;
  const wantsRecord = /\u8bb0\u5f55|\u660e\u7ec6|\u67e5\u770b|record|history|detail/i.test(request);
  const wantsClaim = /\u9886\u53d6|\u53e3\u4ee4|claim|receive|passphrase/i.test(request) && !wantsRecord && !/\u521b\u5efa|\u53d1\u653e|\u53d1\u51fa|create|send/i.test(request);
  const wantsCreate = /\u521b\u5efa|\u53d1\u653e|\u53d1\u51fa|create|send/i.test(request) && !wantsRecord;
  const redPacketType = /\u666e\u901a\u7ea2\u5305/.test(request)
    ? "normal"
    : /\u62fc\u624b\u6c14\u7ea2\u5305|\u62fc\u624b\u6c14/.test(request)
      ? "random"
      : undefined;
  const passphrase = extractRedPacketPassphrase(request);
  const count = extractCount(request);
  const amount = extractAmount(request);
  const action = wantsCreate ? "create_red_packet" : wantsClaim ? "claim_red_packet" : wantsRecord ? "view_red_packet_records" : "red_packet_home";
  return {
    project,
    env,
    module: "red-packet",
    action,
    operationType: wantsCreate || wantsClaim ? "write" : "read",
    loginRequired: /\u767b\u5f55|login/i.test(request),
    data: {
      asset: wantsCreate ? extractAsset(request) ?? (/USDT/i.test(request) ? "USDT" : undefined) : undefined,
      amount,
      amountPolicy: amount === undefined && /\u6700\u5c0f|\u9ed8\u8ba4/.test(request) ? "min_or_default_allowed" : undefined,
      count,
      quantity: count,
      redPacketType,
      passphrase,
      status: extractStatusFilterValue(request),
      greeting: extractGreeting(request)
    },
    intentConfidence: wantsCreate || wantsClaim || wantsRecord ? 0.9 : 0.78,
    evidence: [
      "keyword:red_packet",
      wantsCreate ? "keyword:create_red_packet" : wantsClaim ? "keyword:claim_red_packet" : wantsRecord ? "keyword:red_packet_records" : "keyword:red_packet_home",
      ...(redPacketType ? [`keyword:red_packet_type:${redPacketType}`] : []),
      ...(passphrase ? ["keyword:red_packet_passphrase"] : [])
    ]
  };
}

function hasExplicitFundFlowPageContext(request: string): boolean {
  return /(?:\u8fdb\u5165|\u6253\u5f00|\u5230|\u67e5\u770b).{0,12}(?:\u7406\u8d22\u6d41\u6c34|\u5408\u7ea6\u6d41\u6c34|\u73b0\u8d27\u6d41\u6c34|\u8d44\u91d1\u6d41\u6c34|\u6d41\u6c34\u9875\u9762)/.test(request) ||
    /(?:\u7406\u8d22\u6d41\u6c34|\u5408\u7ea6\u6d41\u6c34|\u73b0\u8d27\u6d41\u6c34).{0,12}(?:\u9875\u9762|\u7b5b\u9009|\u641c\u7d22|\u67e5\u8be2)/.test(request);
}

function extractWithdrawAmountPolicy(request: string): string | undefined {
  if (/低于|小于|少于|below/i.test(request) && /最小|最低|min/i.test(request)) return "below_minimum";
  if (/超过|大于|高于|余额不足|insufficient/i.test(request) && /余额|可用|balance/i.test(request)) return "above_available_balance";
  if (/最小|默认|min/i.test(request)) return "min_or_default_allowed";
  return undefined;
}

function targetPageIdsForIntent(intent: PageModelIntent): string[] {
  return projectRoutingTargetPageIds(intent);
}

function primaryTargetPageIdForIntent(intent: PageModelIntent): string | undefined {
  return projectRoutingPrimaryPageId(intent);
}

function parseEarnOperationIntent(request: string, project: string, env: string): PageModelIntent | undefined {
  if (/理财流水|资金流水|流水|record|history|filter/i.test(request)) return undefined;
  const batchRedeemModalViewIntent = parseEarnBatchRedeemModalViewIntent(request, project, env);
  if (batchRedeemModalViewIntent) return batchRedeemModalViewIntent;
  const productViewIntent = parseEarnProductViewIntent(request, project, env);
  if (productViewIntent) return productViewIntent;
  const financeAccountViewIntent = parseEarnFinanceAccountViewIntent(request, project, env);
  if (financeAccountViewIntent) return financeAccountViewIntent;
  const hasEarnContext = /理财账户|资产中心-理财|更多-理财|理财产品|活期理财|定期理财|earn/i.test(request);
  const wantsRedeem = /赎回|redeem/i.test(request);
  const wantsSubscribe = /申购|购买|买入|subscribe|purchase/i.test(request);
  if (!hasEarnContext || (!wantsRedeem && !wantsSubscribe)) return undefined;
  const asset = extractAsset(request);
  const amount = extractAmount(request);
  const amountPolicy = amount === undefined
    ? /数量(?:保持)?为空|金额(?:保持)?为空|空数量|空金额|保持空值|保持为空|不输入(?:申购|赎回)?(?:数量|金额)?|(?:数量|金额)?留空|empty/i.test(request)
      ? "empty"
      : /最小|默认/.test(request)
        ? "min_or_default_allowed"
        : undefined
    : undefined;
  return {
    project,
    env,
    module: "asset",
    action: wantsRedeem ? "earn_redeem" : "earn_subscribe",
    operationType: "write",
    loginRequired: /登录|login/i.test(request),
    data: {
      asset,
      amount,
      amountPolicy,
      productType: extractEarnProductType(request),
      entry: /更多/.test(request) ? "more_earn" : /理财账户|资产中心-理财/.test(request) ? "asset_earn_account" : undefined
    },
    intentConfidence: 0.9,
    evidence: [
      "keyword:earn_operation",
      wantsRedeem ? "keyword:earn_redeem" : "keyword:earn_subscribe",
      ...(asset ? [`keyword:asset:${asset}`] : []),
      ...(amount !== undefined ? [`keyword:amount:${amount}`] : [])
    ]
  };
}

function parseEarnBatchRedeemModalViewIntent(request: string, project: string, env: string): PageModelIntent | undefined {
  if (!/理财账户|资产中心-理财|finance account/i.test(request)) return undefined;
  if (!/批量赎回/.test(request)) return undefined;
  if (!/查看|展示|显示|打开|弹窗|不展示|未提供|没有|不存在|不可编辑|输入框/.test(request)) return undefined;
  if (/点击确认|点击确定|提交|赎回成功|确认赎回|提交赎回/i.test(request)) return undefined;
  return {
    project,
    env,
    module: "asset",
    action: "earn_batch_redeem_modal_view",
    operationType: "read",
    loginRequired: /登录|login/i.test(request),
    data: {
      asset: extractAsset(request),
      entry: "asset_earn_account"
    },
    intentConfidence: 0.89,
    evidence: ["keyword:earn_batch_redeem_modal_view", "page_context:finance_account"]
  };
}

function parseEarnFinanceAccountViewIntent(request: string, project: string, env: string): PageModelIntent | undefined {
  const hasFinanceAccountContext = /理财账户|资产中心-理财账户|资产中心理财账户|\/assets\/earn/i.test(request);
  const wantsView = /查看|展示|显示|进入|打开|列表|持仓|可见|浏览/.test(request);
  const explicitReadOnlyStateInspection = /读取|查看|展示|显示|状态可读|可读取|不执行|不点击|不提交|不确认|不改变|仅观察|只读/.test(request);
  const hasWriteAction = /点击.{0,20}(申购|赎回)|批量赎回|自动申购.*切换|切换自动申购|(?:申购|赎回)?(?:数量|金额)(?:保持)?为空|(?:申购|赎回)?(?:数量|金额)输入|输入.{0,12}(?:申购|赎回)?(?:数量|金额)?|(?:申购|赎回).{0,16}\d|点击确认|点击确定|提交|购买|买入|申购成功|赎回成功/i.test(request);
  if (!hasFinanceAccountContext || !wantsView || (hasWriteAction && !explicitReadOnlyStateInspection)) return undefined;
  return {
    project,
    env,
    module: "asset",
    action: "earn_position_view",
    operationType: "read",
    loginRequired: /登录|login/i.test(request),
    data: {
      asset: extractAsset(request),
      entry: "asset_earn_account"
    },
    intentConfidence: 0.88,
    evidence: ["keyword:earn_position_view", "page_context:finance_account"]
  };
}

function parseEarnProductViewIntent(request: string, project: string, env: string): PageModelIntent | undefined {
  const hasProductCenterContext = /更多-理财|理财产品中心|理财产品|产品中心|\/earn/i.test(request);
  const wantsView = /查看|展示|显示|进入|打开|列表|可见|浏览/.test(request);
  const hasWriteAction = hasEarnProductWriteCue(request);
  if (!hasProductCenterContext || !wantsView || hasWriteAction) return undefined;
  return {
    project,
    env,
    module: "asset",
    action: "earn_product_view",
    operationType: "read",
    loginRequired: /登录|login/i.test(request),
    data: {
      asset: extractAsset(request),
      productName: request.match(/产品名称为\s*["“”']?([^"“”'，,。；;\s]+)["“”']?/)?.[1],
      status: request.match(/状态为\s*["“”']?([^"“”'，,。；;\s]+)["“”']?/)?.[1],
      productType: extractEarnProductType(request),
      entry: "more_earn"
    },
    intentConfidence: 0.88,
    evidence: ["keyword:earn_product_view", "page_context:earn_product_center"]
  };
}

function hasEarnProductWriteCue(text: string): boolean {
  if (hasExplicitEarnProductExecutionCue(text)) {
    return true;
  }
  const actionText = removeReadOnlyActionObjectText(text);
  return /(?:申购|赎回).{0,12}(被拒绝|失败|成功)|(?:^|[^可不])点击确认|(?:^|[^可不])点击确定|确认按钮置灰|弹窗.{0,12}确认|提交|购买|买入|申购失败|赎回失败|申购成功|赎回成功|subscribe|redeem|purchase/i.test(actionText);
}

function hasExplicitEarnProductExecutionCue(text: string): boolean {
  return /(?:^|[^可不])点击.{0,20}(申购|赎回)|(?:申购|赎回)?(?:数量|金额)(?:保持)?为空|(?:申购|赎回)?(?:数量|金额)输入|输入.{0,12}(?:申购|赎回)?(?:数量|金额)?|(?:申购|赎回).{0,16}\d/i.test(text);
}

function removeReadOnlyActionObjectText(text: string): string {
  return text
    .replace(/(?:查看|验证|校验|断言|展示|显示|存在|可见|包含|确认).{0,24}[“"']?(?:申购|赎回)[”"']?按钮.{0,16}(?:可点击|可用|可见|显示|展示|置灰|不可点击|禁用|不可用|disabled)/gi, "")
    .replace(/(?:查看|验证|校验|断言|展示|显示|存在|可见|包含).{0,24}(?:申购|赎回)按钮/gi, "")
    .replace(/[“"']?(?:申购|赎回)[”"']?按钮.{0,16}(?:可点击|可用|可见|显示|展示|置灰|不可点击|禁用|不可用|disabled)/gi, "")
    .replace(/(?:可点击|可用|可见|显示|展示|置灰|不可点击|禁用|不可用|disabled).{0,16}[“"']?(?:申购|赎回)[”"']?按钮/gi, "");
}

function isWithdrawAddressManagementRequest(request: string): boolean {
  return /(?:地址管理|管理地址|添加地址|新增地址|保存地址|address[-\s_]?manage|address book|add address)/i.test(request) &&
    /(?:提现|提币|withdraw|地址)/i.test(request);
}

function hasExplicitWithdrawAddressManagementPageContext(request: string): boolean {
  return /(?:提现|提币|withdraw|资产中心).{0,16}(?:地址管理|管理地址)|(?:地址管理|管理地址).{0,16}(?:提现|提币|withdraw)|address[-_\s]*manage|address\s*management|\/assets\/address-manage/i.test(request);
}

function withdrawAddressManagementIntent(request: string, project: string, env: string, confidence: number): PageModelIntent {
  const addressType = /站内地址|站内|UID|uid/i.test(request) ? "internal" : "onchain";
  const uid = request.match(/(?:UID|uid)\s*(?:输入|为|=|:|：)?\s*(\d{3,})/)?.[1] ?? request.match(/站内地址.{0,20}?(\d{3,})/)?.[1];
  const uidPolicy = uid === undefined && /UID.{0,8}(?:保持)?为空|UID.{0,8}留空|空UID|UID empty/i.test(request) ? "empty" : undefined;
  return {
    project,
    env,
    module: "withdraw",
    action: /添加地址|新增地址|保存地址|add address/i.test(request) ? "add_withdraw_address" : "manage_withdraw_address",
    operationType: /添加地址|新增地址|保存地址|add address/i.test(request) ? "write" : "read",
    loginRequired: /登录|login/i.test(request),
    data: {
      asset: extractAsset(request),
      network: extractNetwork(request),
      address: request.match(/0x[a-fA-F0-9]{32,}/)?.[0],
      addressType,
      uid,
      internalUid: uid,
      uidPolicy,
      verification: {
        email: /邮箱|邮件|email/i.test(request),
        totp: /GA|Google|谷歌|TOTP|Authenticator/i.test(request)
      }
    },
    intentConfidence: confidence,
    evidence: ["keyword:withdraw_address_management", "secondary_route:address_manage", "domain_vocabulary"]
  };
}

function buildEvidenceBuckets(
  intent: PageModelIntent,
  selectedEvidence: SelectedPageModelEvidence[],
  fallbackEvidence: SelectedPageModelEvidence[],
  excludedEvidence: Array<{ id: string; pageId?: string; reason: string }>
): PageModelEvidenceBuckets {
  const routedTargetPageId = primaryTargetPageIdForIntent(intent);
  // 项目未注册意图路由时，把首个被选中的页面证据作为主目标页，避免 targetPage 桶为空。
  const targetPageId = routedTargetPageId ?? selectedEvidence.find((item) => item.kind === "page")?.pageId;
  const buckets: PageModelEvidenceBuckets = {
    targetPage: [],
    navigation: [],
    executableElements: [],
    actionResults: [],
    assertions: [],
    providers: [],
    preconditions: [],
    supporting: [],
    excluded: excludedEvidence.map((item) => ({ ...item, evidenceRole: "excluded", executionAllowed: false }))
  };

  for (const item of selectedEvidence) {
    const role = evidenceRoleForSelectedItem(intent, item, targetPageId);
    assignEvidenceRole(item, role);
    pushEvidenceToBucket(buckets, item, role);
  }
  for (const item of fallbackEvidence) {
    const role = evidenceRoleForFallbackItem(intent, item, targetPageId);
    assignEvidenceRole(item, role);
    pushEvidenceToBucket(buckets, item, role);
  }
  return buckets;
}

function evidenceRoleForSelectedItem(intent: PageModelIntent, item: SelectedPageModelEvidence, targetPageId?: string): PageModelEvidenceRole {
  if (item.kind === "page") return item.pageId === targetPageId ? "target_page" : "navigation";
  if (item.kind === "provider") return "provider";
  if (item.kind === "element") {
    if (item.pageId !== targetPageId && isReadFilterIntent(intent)) return "supporting";
    if (isProviderLikeEvidence(item)) return "provider";
    if (isActionResultLikeEvidence(item)) return "action_result";
    if (isObservableAssertionEvidence(item)) return "assertion";
    return isExecutableElementEvidence(item) ? "executable_element" : "supporting";
  }
  if (item.kind === "assertion") return item.pageId === targetPageId || !isReadFilterIntent(intent) ? "assertion" : "supporting";
  if (item.kind === "block" || item.kind === "precondition") return "precondition";
  return "supporting";
}

function evidenceRoleForFallbackItem(intent: PageModelIntent, item: SelectedPageModelEvidence, targetPageId?: string): PageModelEvidenceRole {
  if (item.kind === "assertion") return item.pageId === targetPageId || !isReadFilterIntent(intent) ? "assertion" : "supporting";
  if (item.kind === "block" || item.kind === "precondition") return "precondition";
  return evidenceRoleForSelectedItem(intent, item, targetPageId);
}

function assignEvidenceRole(item: SelectedPageModelEvidence, role: PageModelEvidenceRole): void {
  item.evidenceRole = role;
  item.executionAllowed = role === "target_page" || role === "navigation" || role === "executable_element" || role === "assertion" || role === "provider";
  if (role === "supporting" || role === "precondition" || role === "excluded") item.executionAllowed = false;
}

function pushEvidenceToBucket(buckets: PageModelEvidenceBuckets, item: SelectedPageModelEvidence, role: PageModelEvidenceRole): void {
  if (role === "target_page") buckets.targetPage.push(item);
  else if (role === "navigation") buckets.navigation.push(item);
  else if (role === "executable_element") buckets.executableElements.push(item);
  else if (role === "action_result") buckets.actionResults.push(item);
  else if (role === "assertion") buckets.assertions.push(item);
  else if (role === "provider") buckets.providers.push(item);
  else if (role === "precondition") buckets.preconditions.push(item);
  else buckets.supporting.push(item);
}

function isReadFilterIntent(intent: PageModelIntent): boolean {
  return intent.operationType === "read" && intent.module === "asset";
}

function isExecutableElementEvidence(item: SelectedPageModelEvidence): boolean {
  const text = `${item.id} ${item.semanticName ?? ""} ${item.role ?? ""} ${item.semanticRole ?? ""} ${item.controlType ?? ""}`;
  const isRowAction = /row_action|action_button|open_modal|submit_or_confirm|\u7533\u8d2d|\u8d4e\u56de/i.test(text);
  if (!isRowAction && /table|list|row|empty_state|pagination|page_state|\u5217\u8868|\u8868\u683c|\u8bb0\u5f55|\u7a7a\u72b6\u6001|\u5206\u9875/i.test(text)) return false;
  return /dropdown|option|input|button|tab|selector|filter|query|search|\u4e0b\u62c9|\u9009\u9879|\u8f93\u5165|\u6309\u94ae|\u9875\u7b7e|\u7b5b\u9009|\u67e5\u8be2|\u641c\u7d22/i.test(text);
}

function isObservableAssertionEvidence(item: SelectedPageModelEvidence): boolean {
  const text = `${item.id} ${item.semanticName ?? ""} ${item.role ?? ""} ${item.semanticRole ?? ""} ${item.controlType ?? ""}`;
  if (/row_action|action_button|open_modal|submit_or_confirm|\u7533\u8d2d|\u8d4e\u56de/i.test(text)) return false;
  return /result|table|list|row|empty_state|page_state|\u7ed3\u679c|\u5217\u8868|\u8868\u683c|\u8bb0\u5f55|\u7a7a\u72b6\u6001|\u6682\u65e0/i.test(text);
}

function isProviderLikeEvidence(item: SelectedPageModelEvidence): boolean {
  return /provider|verification|email_code|sms_code|totp|captcha|\u9a8c\u8bc1\u7801/i.test(`${item.id} ${item.semanticName ?? ""} ${item.targetField ?? ""}`);
}

function isActionResultLikeEvidence(item: SelectedPageModelEvidence): boolean {
  return /action_result|result_after|success_state|modal_visible|page_after/i.test(`${item.id} ${item.semanticName ?? ""} ${item.semanticRole ?? ""}`);
}

function reasonForPage(intent: PageModelIntent, model: PageModel): string {
  if (intent.module === "withdraw" && isWithdrawAddressManagementIntent(intent) && model.pageId.includes("address_management")) return "提币地址管理需求需要地址管理二级 PageModel。";
  if (intent.module === "withdraw") return "提现需求需要提现 PageModel。";
  if (intent.module === "transfer" && model.pageId.includes("transfer")) return "划转需求需要划转入口状态 PageModel。";
  if (intent.module === "asset" && intent.action === "earn_redeem" && model.pageId.includes("finance_account")) return "理财赎回需要资产中心理财账户 PageModel 和行内赎回操作证据。";
  if (intent.module === "asset" && intent.action === "earn_subscribe" && model.pageId.includes("earn.product_center")) return "更多-理财申购需要理财产品中心 PageModel 和申购弹窗证据。";
  if (intent.module === "asset" && intent.action === "earn_subscribe" && model.pageId.includes("finance_account")) return "资产中心理财账户也可作为理财申购入口证据。";
  if (intent.module === "asset" && model.pageId.includes("spot_account")) return "现货流水筛选需要现货账户 PageModel 作为入口。";
  if (intent.module === "asset" && model.pageId.includes("fund_flow")) return "现货流水筛选需要资金流水页面或入口状态。";
  return "PageModel selected by module/action match.";
}

function selectRelevantElements(intent: PageModelIntent, model: PageModel): PageModelElement[] {
  if (intent.module === "personal") {
    return selectRelevantPersonalElements(intent, model);
  }
  if (isFundFlowFilterIntent(intent)) {
    return selectRelevantSpotFundFlowElements(intent, model);
  }
  if (intent.module === "asset" && intent.action === "earn_product_view") {
    return (model.elements ?? [])
      .filter((element) => {
        if (hasGeneratedActionReplacement(model, element)) return false;
        if (isRawScanNoiseElement(element)) return false;
        const text = elementSearchText(element);
        return /product_list|产品列表|row_action|申购|活期|定期|load_more|查看更多/i.test(text);
      })
      .sort((a, b) => elementRelevanceScore(intent, b) - elementRelevanceScore(intent, a))
      .slice(0, 20);
  }
  if (intent.module === "asset" && intent.action === "earn_position_view") {
    return selectRelevantEarnPositionViewElements(intent, model);
  }
  if (intent.module === "asset" && intent.action === "earn_batch_redeem_modal_view") {
    return selectRelevantEarnBatchRedeemModalViewElements(intent, model);
  }
  if (isEarnOperationIntent(intent)) {
    return selectRelevantEarnOperationElements(intent, model);
  }
  const terms = termsForIntent(intent);
  const candidates = (model.elements ?? [])
    .filter((element) => {
      if (intent.module === "red-packet" && !isRedPacketElementRelevant(intent, element)) return false;
      if (hasGeneratedActionReplacement(model, element)) return false;
      if (isRawScanNoiseElement(element)) return false;
      const field = inferElementTargetField(element);
      if (field) {
        if (!isIntentFieldRequested(intent, field)) return false;
        if (!optionMatchesIntent(element, intent, field, model)) return false;
      }
      if (intent.module === "withdraw" && isWithdrawNoiseElement(element)) return false;
      if (intent.module === "withdraw" && intent.action === "submit_withdraw" && /address_management_entry|地址管理入口/i.test(elementSearchText(element))) return false;
      if (isNegativeWithdrawAmountIntent(intent) && /provider|verification|email_code|sms_code|totp|验证码|安全验证|success/i.test(elementSearchText(element))) return false;
      return terms.some((term) => containsTerm(element, term));
    })
    .sort((a, b) => elementRelevanceScore(intent, b) - elementRelevanceScore(intent, a));
  return dedupeRelevantElements(candidates, intent).slice(0, 20);
}

function selectRelevantPersonalElements(intent: PageModelIntent, model: PageModel): PageModelElement[] {
  const candidates = (model.elements ?? [])
    .filter((element) => {
      if (hasGeneratedActionReplacement(model, element)) return false;
      if (isRawScanNoiseElement(element)) return false;
      return isPersonalElementRelevant(intent, element);
    })
    .sort((a, b) => elementRelevanceScore(intent, b) - elementRelevanceScore(intent, a));
  return dedupeRelevantElements(candidates, intent).slice(0, 20);
}

function isPersonalElementRelevant(intent: PageModelIntent, element: PageModelElement): boolean {
  const text = elementSearchText(element);
  if (/nav\.|菜单项|navigation/i.test(text)) return false;
  if (intent.action === "open_invite_modal") return /invite_view_button|邀请码.*查看|查看按钮/i.test(text);
  if (intent.action === "open_nickname_modal" || intent.action === "assert_nickname_confirm_disabled") return /nickname_edit_button|昵称行修改|昵称.*修改/i.test(text);
  if (intent.action === "update_nickname") return /nickname_edit_button|nickname_input|nickname_confirm_button|昵称.*修改|昵称输入|确定按钮/i.test(text);
  if (intent.action === "open_kyc_start_modal") return /start_button|开始认证按钮/i.test(text);
  if (intent.action === "open_api_create_modal") return /create_button|empty_create_button|创建API按钮|立即创建按钮/i.test(text);
  if (intent.action.startsWith("view_")) return false;
  return false;
}

function isEarnOperationIntent(intent: PageModelIntent): boolean {
  return intent.module === "asset" && (intent.action === "earn_redeem" || intent.action === "earn_subscribe");
}

function selectRelevantEarnPositionViewElements(intent: PageModelIntent, model: PageModel): PageModelElement[] {
  const wantsSwitchState = /自动申购|auto.?subscribe|switch|开关|aria-checked|data-state/i.test(`${intent.data.deepSeekIntent ? JSON.stringify(intent.data.deepSeekIntent) : ""} ${(intent.evidence ?? []).join(" ")}`);
  return (model.elements ?? [])
    .filter((element) => {
      if (hasGeneratedActionReplacement(model, element)) return false;
      if (isRawScanNoiseElement(element)) return false;
      const text = elementSearchText(element);
      const isAutoSubscribeStateControl = /auto_subscribe_switch|自动申购.*开关|开关.*自动申购/i.test(text);
      if (wantsSwitchState && isAutoSubscribeStateControl) return true;
      if (/confirm|submit|确认|确定|保存|提交|row_action|batch_redeem|redeem|subscribe|赎回|申购|购买/i.test(text)) return false;
      if (wantsSwitchState) return /auto_subscribe_switch|自动申购|switch|开关/i.test(text);
      return /position_table|earn_position_table|持仓列表|列表|table/i.test(text);
    })
    .sort((a, b) => elementRelevanceScore(intent, b) - elementRelevanceScore(intent, a))
    .slice(0, 8);
}

function selectRelevantEarnBatchRedeemModalViewElements(intent: PageModelIntent, model: PageModel): PageModelElement[] {
  return (model.elements ?? [])
    .filter((element) => {
      if (hasGeneratedActionReplacement(model, element)) return false;
      if (isRawScanNoiseElement(element)) return false;
      const text = elementSearchText(element);
      if (/confirm_button|确定|确认|submit|amount_input|redeem_amount|subscribe|申购|row_action/i.test(text)) return false;
      return /batch_redeem\.trigger|列表级批量赎回按钮|批量赎回按钮/i.test(text);
    })
    .sort((a, b) => elementRelevanceScore(intent, b) - elementRelevanceScore(intent, a))
    .slice(0, 4);
}

function selectRelevantEarnOperationElements(intent: PageModelIntent, model: PageModel): PageModelElement[] {
  const candidates = (model.elements ?? [])
    .filter((element) => {
      if (hasGeneratedActionReplacement(model, element)) return false;
      if (isRawScanNoiseElement(element)) return false;
      const field = inferElementTargetField(element);
      if (field) {
        if (!isIntentFieldRequested(intent, field)) return false;
        if (!optionMatchesIntent(element, intent, field, model)) return false;
      }
      return isEarnOperationElementRelevant(intent, element);
    })
    .sort((a, b) => elementRelevanceScore(intent, b) - elementRelevanceScore(intent, a));
  return dedupeRelevantElements(candidates, intent).slice(0, 20);
}

function isEarnOperationElementRelevant(intent: PageModelIntent, element: PageModelElement): boolean {
  const text = elementSearchText(element);
  const isRedeem = intent.action === "earn_redeem";
  const isSubscribe = intent.action === "earn_subscribe";
  if (isRedeem && /subscribe|申购|购买|立即申购/i.test(text)) return false;
  if (isSubscribe && /redeem|赎回/i.test(text)) return false;
  if (isDynamicEarnRowActionTemplate(intent, element)) return true;
  if (isRedeem && /asset_selector|coin_selector|币种筛选/i.test(text)) return false;
  if (/result_table|summary_table|page_state|list|table|\u5217\u8868|\u8868\u683c/.test(text) && !/action_button|input|confirm|button/.test(text)) return false;
  const asset = typeof intent.data.asset === "string" ? intent.data.asset : undefined;
  if (asset && /asset_option|coin_option/i.test(text) && !containsTerm(element, asset)) return false;
  if (asset && isEarnRowActionElement(element)) {
    const requestedAsset = normalizeAssetSymbolCandidate(asset);
    const boundAsset = elementBoundAsset(element);
    if (boundAsset && requestedAsset && boundAsset !== requestedAsset) return false;
  }
  if (isRedeem) return /earn|finance_account|理财账户|redeem|赎回|amount|数量|confirm|确定|success|成功/i.test(text);
  return /earn|product_center|finance_account|理财|subscribe|申购|amount|数量|confirm|确定|asset|coin|币种|success|成功/i.test(text);
}

function isRedPacketElementRelevant(intent: PageModelIntent, element: PageModelElement): boolean {
  const field = inferElementTargetField(element);
  const text = elementSearchText(element);
  if (intent.action === "create_red_packet") {
    if (field === "passphrase") return false;
    if (/claim|领取按钮|领取红包/i.test(text)) return false;
    return ["action", "red_packet_type", "asset", "amount", "count", "greeting", "send_email_code", "email_code", "totp", "confirm_verification"].includes(field ?? "");
  }
  if (intent.action === "claim_red_packet") {
    if (/create|创建|confirm_create|security|verification|email_code|totp|验证码|谷歌/i.test(text)) return false;
    return field === "passphrase" || /claim_button|领取红包按钮/i.test(text);
  }
  if (intent.action === "view_red_packet_records") {
    return /records?\.entry|record_entry|红包记录入口|红包明细/i.test(text);
  }
  return /red_packet|红包/i.test(text);
}

function selectRelevantSpotFundFlowElements(intent: PageModelIntent, model: PageModel): PageModelElement[] {
  const terms = termsForIntent(intent);
  const structuredFields = structuredDropdownFields(model);
  const candidates = (model.elements ?? [])
    .filter((element) => {
      if (isTransferRecordHelperForUnrelatedSpotFlowFilter(intent, element)) return false;
      if (hasGeneratedActionReplacement(model, element)) return false;
      if (isRawScanNoiseElement(element)) return false;
      const field = inferElementTargetField(element);
      if (field) {
        if (!isIntentFieldRequested(intent, field)) return false;
        if (!optionMatchesIntent(element, intent, field, model)) return false;
        if (hasStructuredReplacement(element, field, structuredFields)) return false;
        return true;
      }
      const text = elementSearchText(element);
      return /query_button|search_button|result_list|result_table/i.test(text) || terms.some((term) => containsTerm(element, term));
    })
    .sort((a, b) => elementRelevanceScore(intent, b) - elementRelevanceScore(intent, a));
  return dedupeRelevantElements(candidates, intent).slice(0, 30);
}

function dedupeRelevantElements(elements: PageModelElement[], intent: PageModelIntent): PageModelElement[] {
  if (!isFundFlowFilterIntent(intent)) return elements;
  const selected = new Map<string, PageModelElement>();
  for (const element of elements) {
    const key = evidenceCapabilityKey(element);
    const current = selected.get(key);
    if (!current || elementRelevanceScore(intent, element) > elementRelevanceScore(intent, current)) {
      selected.set(key, element);
    }
  }
  return [...selected.values()];
}

function evidenceCapabilityKey(element: PageModelElement): string {
  const field = inferElementTargetField(element);
  const optionValue = field ? inferElementOptionValue(element, field) : undefined;
  const id = String(element.elementId ?? element.sourceProposalId ?? "");
  const pageId = String((element as Record<string, unknown>).pageId ?? "");
  if (/query_button|search_button/i.test(id)) return `${pageId}:action:query`;
  if (!field) return `${pageId}:element:${id}`;
  if (optionValue) return `${pageId}:${field}:option:${normalizeText(optionValue)}`;
  return `${pageId}:${field}:trigger`;
}

function hasGeneratedActionReplacement(model: PageModel, element: PageModelElement): boolean {
  const id = element.elementId ?? element.sourceProposalId ?? "";
  if (!/query_button|reset_button/i.test(id)) return false;
  if (id.startsWith("funds.")) return false;
  const actionId = /query_button/i.test(id) ? "query_button" : "reset_button";
  return (model.elements ?? []).some((candidate) =>
    candidate.elementId?.startsWith("funds.") &&
    candidate.elementId.endsWith(actionId) &&
    isVerifiedStatus(candidate.status)
  );
}

function isRawScanNoiseElement(element: PageModelElement): boolean {
  const id = String(element.elementId ?? element.sourceProposalId ?? "");
  return /^p4\..*(?:clickable|field|table)_/i.test(id);
}

function isWithdrawNoiseElement(element: PageModelElement): boolean {
  const text = elementSearchText(element);
  return /download|language|open menu|guide|footer|header|clickable_\d+|下载APP|语言|指南/i.test(text);
}

function structuredDropdownFields(model: PageModel): Set<string> {
  return new Set((model.elements ?? [])
    .filter((element) => element.controlType === "dropdown" && element.targetField && isVerifiedStatus(element.status))
    .map((element) => normalizeTargetField(String(element.targetField))));
}

function hasStructuredReplacement(element: PageModelElement, field: string, structuredFields: Set<string>): boolean {
  if (!structuredFields.has(field)) return false;
  if (element.controlType === "dropdown" || element.controlType === "dropdown_option") return false;
  if (element.elementId?.startsWith("funds.") || element.sourceProposalId?.startsWith("funds.")) return false;
  return /filter|selector|option|w3\.|w5\.|p7\./i.test(elementSearchText(element));
}

function isTransferRecordHelperForUnrelatedSpotFlowFilter(intent: PageModelIntent, element: PageModelElement): boolean {
  if (!isFundFlowFilterIntent(intent)) return false;
  const text = elementSearchText(element);
  if (!/t2_5\.transfer_record|transfer_record/i.test(text)) return false;
  const requestedType = getIntentRecordType(intent);
  return !requestedType || !/\u5212\u8f6c|transfer/i.test(requestedType);
}

function isIntentFieldRequested(intent: PageModelIntent, field: string): boolean {
  if (intent.module === "personal") {
    if (field === "action") return true;
    if (["api_label", "google_code", "totp", "country_or_region", "kyc_start", "create_api", "confirm", "nickname", "uid", "email", "google_auth_status", "fund_password", "mobile", "login_password", "invite_code", "withdraw_address_management"].includes(field)) return true;
  }
  if (field === "action") return true;
  if (field === "address_type" || field === "withdraw_mode") return intent.module === "withdraw" && typeof intent.data.addressType === "string";
  if (field === "asset") return typeof intent.data.asset === "string" && intent.data.asset.trim().length > 0;
  if (field === "record_type") return typeof getIntentRecordType(intent) === "string";
  if (field === "product_type") return typeof intent.data.productType === "string" && intent.data.productType.trim().length > 0;
  if (field === "time_range") return Boolean(intent.data.timeRange);
  if (field === "status") return typeof intent.data.status === "string";
  if (field === "network") return typeof intent.data.network === "string" && intent.data.network.trim().length > 0;
  if (field === "address") return typeof intent.data.address === "string" && intent.data.address.trim().length > 0;
  if (field === "uid" || field === "internal_uid") return intent.data.uidPolicy === "empty" || typeof (intent.data.uid ?? intent.data.internalUid) === "string";
  if (field === "label") return typeof intent.data.label === "string" && intent.data.label.trim().length > 0;
  if (field === "amount") return typeof intent.data.amount === "number" || typeof intent.data.amountPolicy === "string";
  if (field === "count" || field === "quantity") return typeof (intent.data.count ?? intent.data.quantity) === "number";
  if (field === "red_packet_type") return intent.module === "red-packet" && typeof intent.data.redPacketType === "string";
  if (field === "greeting") return intent.module === "red-packet" && typeof intent.data.greeting === "string";
  if (field === "passphrase" || field === "red_packet_passphrase") return intent.module === "red-packet" && typeof intent.data.passphrase === "string";
  if (field === "verification_code") return intent.module === "withdraw" && !isNegativeWithdrawAmountIntent(intent);
  if (field === "email_code" || field === "totp" || field === "send_email_code" || field === "confirm_verification") return (intent.module === "withdraw" && !isNegativeWithdrawAmountIntent(intent)) || intent.module === "red-packet";
  if (field === "withdraw_mode") return intent.module === "withdraw";
  return false;
}

function optionMatchesIntent(element: PageModelElement, intent: PageModelIntent, field: string, model?: PageModel): boolean {
  if (field === "action" && isEarnRowActionElement(element)) return true;
  const optionValue = inferElementOptionValue(element, field);
  if (!optionValue) return true;
  if (isUnavailableOption(optionValue) || isUnavailableOption(`${element.semanticName ?? ""} ${element.elementId ?? ""}`)) return false;
  const rawExpected = field === "record_type" ? getIntentRecordType(intent) : field === "red_packet_type" ? intent.data.redPacketType : intent.data[field];
  const expected = typeof rawExpected === "string" ? normalizeFieldValueAlias(model, field, rawExpected) ?? rawExpected : rawExpected;
  if (typeof expected !== "string") return true;
  if (field === "network") return normalizeText(optionValue).includes(normalizeText(expected));
  return normalizeText(optionValue) === normalizeText(expected);
}

function isUnavailableOption(value: string): boolean {
  return /暂不支持|不可用|禁用|disabled|unavailable|not_supported|not supported/i.test(value);
}

function normalizeFieldValueAlias(model: PageModel | undefined, semanticField: string, value: string): string | undefined {
  const normalizedValue = normalizeText(value);
  const mappings = (model?.fieldMappings ?? [])
    .filter((item) => (item.semanticField ?? item.targetField) === semanticField);
  for (const mapping of mappings) {
    const verifiedOptions = readStringArray(mapping.verifiedOptions ?? mapping.options);
    const optionSet = new Set(verifiedOptions.map(normalizeText));
    const aliases = mapping.valueAliases;
    if (!aliases || typeof aliases !== "object" || Array.isArray(aliases)) continue;
    for (const [canonical, rawAliases] of Object.entries(aliases as Record<string, unknown>)) {
      const candidates = readStringArray([canonical, ...readStringArray(rawAliases)]);
      if (!candidates.map(normalizeText).includes(normalizedValue)) continue;
      if (optionSet.has(normalizeText(canonical))) return canonical;
      const verifiedAlias = candidates.find((candidate) => optionSet.has(normalizeText(candidate)));
      if (verifiedAlias) return verifiedAlias;
    }
  }
  return undefined;
}

function elementRelevanceScore(intent: PageModelIntent, element: PageModelElement): number {
  const text = JSON.stringify(element);
  let score = isVerifiedStatus(element.status) ? 20 : 0;
  if (element.controlType === "dropdown") score += 18;
  if (element.controlType === "dropdown_option") score += 16;
  if (element.controlType === "tab") score += 16;
  if (element.elementId?.startsWith("funds.")) score += 14;
  if (element.elementId?.startsWith("c5_2.") || element.sourceProposalId?.startsWith("c5_2.")) score += 20;
  if (intent.module === "withdraw" && /network_selector|network_bsc_option|amount_input|selectedNetwork|negativeLocatorHints|withdraw_form/i.test(text)) score += 15;
  if (intent.module === "withdraw" && /provider|verification|success/i.test(text)) score += 10;
  if (intent.module === "transfer" && /t2\.transfer|t2_5\.transfer/i.test(text)) score += 12;
  if (intent.module === "asset" && /p7\.spot_fund_flow/i.test(text)) score += 12;
  if (isEarnOperationIntent(intent) && /earn|finance_account|product_center|理财|赎回|申购|amount|success/i.test(text)) score += 16;
  if (intent.action === "earn_redeem" && /redeem|赎回/i.test(text)) score += 18;
  if (intent.action === "earn_subscribe" && /subscribe|申购|购买/i.test(text)) score += 18;
  if (isEarnOperationIntent(intent) && typeof intent.data.asset === "string" && text.includes(String(intent.data.asset))) score += 10;
  if (intent.module === "red-packet" && /red_packet|红包|passphrase|口令|security|verification|email_code|totp/i.test(text)) score += 16;
  if (intent.module === "personal" && /personal|个人中心|用户中心|账号|身份认证|kyc|api|邀请码|昵称|安全设置|谷歌验证码|资金密码/i.test(text)) score += 20;
  if (intent.module === "personal" && intent.action === "open_api_create_modal" && /创建API|立即创建|api|google|谷歌|确认/i.test(text)) score += 16;
  if (intent.module === "personal" && intent.action === "open_kyc_start_modal" && /开始认证|国家|地区|确定|kyc|身份认证/i.test(text)) score += 16;
  if (intent.module === "personal" && intent.action.includes("nickname") && /昵称|修改|确定|disabled|enabled|置灰|高亮|可点击|成功/i.test(text)) score += 16;
  if (intent.module === "personal" && intent.action === "open_invite_modal" && /邀请码|邀请链接|查看/i.test(text)) score += 16;
  return score;
}

function selectRelevantAssertions(intent: PageModelIntent, model: PageModel): PageModelAssertion[] {
  if (intent.module === "personal") {
    const terms = termsForIntent(intent);
    return (model.assertions ?? []).filter((assertion) => {
      const text = JSON.stringify(assertion);
      return terms.some((term) => text.includes(term)) || /page_visible|modal_visible|element_disabled|element_enabled|control_disabled|control_enabled|empty_state|text_visible|状态|弹窗|置灰|高亮|可点击|可见/i.test(text);
    }).sort((a, b) => assertionRelevanceScore(intent, b) - assertionRelevanceScore(intent, a)).slice(0, 16);
  }
  const terms = termsForIntent(intent);
  return (model.assertions ?? []).filter((assertion) => {
    const text = JSON.stringify(assertion);
    return terms.some((term) => text.includes(term)) || /(success|page_state|failure|block|empty|list)/i.test(text);
  }).sort((a, b) => assertionRelevanceScore(intent, b) - assertionRelevanceScore(intent, a)).slice(0, 12);
}

function assertionRelevanceScore(intent: PageModelIntent, assertion: PageModelAssertion): number {
  const text = JSON.stringify(assertion);
  let score = isVerifiedStatus(assertion.status) ? 20 : 0;
  if (assertion.assertionId?.startsWith("t2.") || assertion.sourceProposalId?.startsWith("t2.")) score += 10;
  if (intent.module === "transfer" && /submit_success|success_tip|success/i.test(text)) score += 12;
  if (intent.module === "asset" && /gift|empty|list|\u8d60\u5e01|\u6682\u65e0/.test(text)) score += 12;
  if (isEarnOperationIntent(intent) && /earn|理财|赎回|申购|success|成功|message|toast|modal/i.test(text)) score += 14;
  if (intent.module === "withdraw" && /withdraw|success|record|BSC|USDT/i.test(text)) score += 12;
  if (intent.module === "red-packet" && /red_packet|红包|success|record|passphrase|claim|create/i.test(text)) score += 12;
  if (intent.module === "personal" && /personal|账号|身份认证|kyc|api|邀请码|弹窗|modal|disabled|enabled|置灰|高亮|可点击|空状态|page_visible/i.test(text)) score += 18;
  return score;
}

function expectedGaps(intent: PageModelIntent, selected: SelectedPageModelEvidence[], fallback: SelectedPageModelEvidence[]): string[] {
  const all = `${JSON.stringify(selected)} ${JSON.stringify(fallback)}`;
  if (intent.module === "personal") {
    const terms = termsForIntent(intent);
    return [
      selected.some((item) => item.kind === "page") ? undefined : "personal_target_page",
      terms.some((term) => all.includes(term)) ? undefined : "personal_observable_signal",
      fallback.some((item) => item.kind === "assertion") ? undefined : "personal_assertion_capability"
    ].filter(Boolean) as string[];
  }
  if (isFundFlowFilterIntent(intent)) {
    const typeValue = getIntentRecordType(intent);
    const assetValue = typeof intent.data.asset === "string" ? intent.data.asset : undefined;
    const productType = typeof intent.data.productType === "string" ? intent.data.productType : undefined;
    const timeRange = intent.data.timeRange;
    const prefix = intent.action === "earn_fund_flow_filter" ? "earn_fund_flow" : intent.action === "contract_fund_flow_filter" ? "contract_fund_flow" : "spot_fund_flow";
    return [
      typeValue && !hasVerifiedFundFlowTypeOption(selected, typeValue) ? `${prefix}_type_filter_option:${typeValue}` : undefined,
      productType && !hasVerifiedFundFlowProductTypeOption(selected, productType) ? `${prefix}_product_type_filter_option:${productType}` : undefined,
      assetValue && !hasVerifiedFundFlowAssetOption(selected, assetValue) ? `${prefix}_asset_filter_option:${assetValue}` : undefined,
      timeRange && !hasVerifiedFundFlowTimeFilter(selected) ? `${prefix}_time_filter` : undefined,
      hasVerifiedFundFlowResultAssertion(fallback) ? undefined : `${prefix}_result_assertion`
    ].filter(Boolean) as string[];
  }
  if (intent.module === "transfer") {
    return [
      missing(all, "转出") ? "transfer_from_account_selector" : undefined,
      missing(all, "转入") ? "transfer_to_account_selector" : undefined,
      missing(all, "币种") || missing(all, "USDT") ? "transfer_asset_selector" : undefined,
      missing(all, "数量") ? "transfer_amount_input" : undefined,
      hasVerifiedTransferSubmitResultAssertion(fallback) ? undefined : "transfer_submit_result_assertion",
      hasVerifiedTransferRecordAssertion(fallback) ? undefined : "transfer_record_assertion"
    ].filter(Boolean) as string[];
  }
  if (isEarnOperationIntent(intent)) {
    const isRedeem = intent.action === "earn_redeem";
    const prefix = isRedeem ? "earn_redeem" : "earn_subscribe";
    const actionLabel = isRedeem ? "赎回" : "申购";
    const assetValue = typeof intent.data.asset === "string" ? intent.data.asset : undefined;
    const emptyAmountRequested = intent.data.amountPolicy === "empty";
    const hasAssetRowAction = assetValue ? hasEarnRowActionForAsset(selected, assetValue, actionLabel) : false;
    return [
      assetValue && missing(all, assetValue) && !hasAssetRowAction ? `${prefix}_asset_scope:${assetValue}` : undefined,
      assetValue && !hasAssetRowAction ? `${prefix}_row_action_for_asset:${assetValue}` : undefined,
      typeof intent.data.amount !== "number" && typeof intent.data.amountPolicy !== "string" ? `${prefix}_amount_value` : undefined,
      missing(all, actionLabel) ? `${prefix}_action_button` : undefined,
      missing(all, "最小") && missing(all, "数量") && missing(all, "金额") ? `${prefix}_amount_input` : undefined,
      missing(all, "确定") && missing(all, "确认") ? `${prefix}_confirm_button` : undefined,
      emptyAmountRequested
        ? hasEarnOperationDisabledAssertion(fallback) ? undefined : `${prefix}_disabled_assertion`
        : hasEarnOperationSuccessAssertion(fallback) ? undefined : `${prefix}_success_evidence`
    ].filter(Boolean) as string[];
  }
  if (intent.module === "asset" && intent.action === "earn_product_view") {
    return [
      selected.some((item) => item.kind === "page" && item.pageId === "demo.earn.product_center") ? undefined : "earn_product_center_page",
      missing(all, "产品列表") && missing(all, "product_list") ? "earn_product_center_product_list" : undefined,
      hasEarnProductListAssertion(fallback) ? undefined : "earn_product_center_list_assertion"
    ].filter(Boolean) as string[];
  }
  if (intent.module === "asset" && intent.action === "earn_position_view") {
    return [
      selected.some((item) => item.kind === "page" && item.pageId === "demo.funds.finance_account") ? undefined : "finance_account_page",
      hasEarnPositionListAssertion(fallback) ? undefined : "finance_account_position_list_assertion"
    ].filter(Boolean) as string[];
  }
  if (intent.module === "asset" && intent.action === "earn_batch_redeem_modal_view") {
    const allText = `${JSON.stringify(selected)} ${JSON.stringify(fallback)}`;
    return [
      selected.some((item) => item.kind === "page" && item.pageId === "demo.funds.finance_account") ? undefined : "finance_account_page",
      selected.some((item) => /batch_redeem\.trigger|批量赎回按钮/i.test(`${item.id} ${item.semanticName ?? ""}`)) ? undefined : "finance_account_batch_redeem_modal_entry",
      /batch_redeem\.modal_visible|批量赎回弹窗可见/i.test(allText) ? undefined : "finance_account_batch_redeem_modal_assertion",
      /amount_not_editable|input_absent|未提供行内赎回数量编辑|不展示.*输入框/i.test(allText) ? undefined : "finance_account_batch_redeem_amount_absent_assertion"
    ].filter(Boolean) as string[];
  }
  if (intent.module === "red-packet") {
    if (intent.action === "create_red_packet") {
      return [
        missing(all, "创建红包") ? "red_packet_create_entry" : undefined,
        missing(all, "拼手气红包") ? "red_packet_random_type_option" : undefined,
        missing(all, "普通红包") ? "red_packet_normal_type_option" : undefined,
        missing(all, "发放数量") && missing(all, "红包金额") ? "red_packet_amount_input" : undefined,
        missing(all, "红包个数") ? "red_packet_count_input" : undefined,
        missing(all, "确认创建") ? "red_packet_submit_button" : undefined,
        missing(all, "email_code") && missing(all, "邮箱") ? "red_packet_email_provider" : undefined,
        missing(all, "totp") && missing(all, "GA") && missing(all, "谷歌") ? "red_packet_totp_provider" : undefined,
        hasRedPacketSuccessAssertion(fallback) ? undefined : "red_packet_create_success_evidence"
      ].filter(Boolean) as string[];
    }
    if (intent.action === "claim_red_packet") {
      return [
        typeof intent.data.passphrase !== "string" ? "red_packet_passphrase_value" : undefined,
        missing(all, "输入红包口令") && missing(all, "口令") ? "red_packet_passphrase_input" : undefined,
        missing(all, "领取") ? "red_packet_claim_button" : undefined,
        hasRedPacketSuccessAssertion(fallback) ? undefined : "red_packet_claim_success_evidence"
      ].filter(Boolean) as string[];
    }
    if (intent.action === "view_red_packet_records") {
      return [
        missing(all, "红包明细") && missing(all, "红包记录") ? "red_packet_record_entry" : undefined,
        missing(all, "记录") && missing(all, "列表") && missing(all, "暂无") ? "red_packet_record_list_or_empty"
          : undefined
      ].filter(Boolean) as string[];
    }
  }
  if (intent.module === "withdraw") {
    if (isWithdrawAddressManagementIntent(intent)) {
      const isInternalAddress = intent.data.addressType === "internal";
      return [
        missing(all, "添加地址") ? "withdraw_address_management_add_button" : undefined,
        isInternalAddress && missing(all, "站内地址") && missing(all, "UID") ? "withdraw_address_management_internal_address_mode" : undefined,
        !isInternalAddress && typeof intent.data.network === "string" && missing(all, intent.data.network) ? `withdraw_address_management_network:${intent.data.network}` : undefined,
        isInternalAddress && intent.action === "add_withdraw_address" && typeof (intent.data.uid ?? intent.data.internalUid) !== "string" && intent.data.uidPolicy !== "empty" ? "withdraw_address_management_uid_value" : undefined,
        isInternalAddress && intent.action === "add_withdraw_address" && missing(all, "UID") && missing(all, "uid") ? "withdraw_address_management_uid_input" : undefined,
        !isInternalAddress && intent.action === "add_withdraw_address" && typeof intent.data.address !== "string" ? "withdraw_address_management_address_value" : undefined,
        intent.action === "add_withdraw_address" && missing(all, "email_code") && missing(all, "邮箱") ? "withdraw_address_management_email_provider" : undefined,
        intent.action === "add_withdraw_address" && missing(all, "totp") && missing(all, "GA") && missing(all, "谷歌") ? "withdraw_address_management_totp_provider" : undefined
      ].filter(Boolean) as string[];
    }
    if (isNegativeWithdrawAmountIntent(intent)) {
      return [
        missing(all, "BSC") ? "withdraw_chain_selector_bsc" : undefined,
        "withdraw_min_amount_source",
        hasWithdrawFailureOrDisabledAssertion(fallback) ? undefined : "withdraw_negative_amount_assertion"
      ].filter(Boolean) as string[];
    }
    return [
      missing(all, "BSC") ? "withdraw_chain_selector_bsc" : undefined,
      "withdraw_min_amount_source",
      "withdraw_verification_provider_state",
      "withdraw_success_assertion",
      "withdraw_record_assertion"
    ].filter(Boolean) as string[];
  }
  return ["intent_not_supported_by_page_model_store"];
}

function hasVerifiedGiftCoinOption(selected: SelectedPageModelEvidence[]): boolean {
  return selected.some((item) =>
    item.kind === "element" &&
    /赠币/.test(`${item.semanticName ?? ""} ${item.id}`) &&
    isVerifiedStatus(item.status)
  );
}

function hasVerifiedFundFlowTypeOption(selected: SelectedPageModelEvidence[], typeValue: string): boolean {
  const normalizedType = normalizeText(typeValue);
  return selected.some((item) => {
    if (item.kind !== "element" || !isVerifiedStatus(item.status)) return false;
    const field = inferSelectedEvidenceTargetField(item);
    if (field && field !== "record_type") return false;
    if (item.optionValue) return normalizeText(item.optionValue) === normalizedType;
    const text = normalizeText(`${item.semanticName ?? ""} ${item.id}`);
    return text.includes(normalizedType);
  });
}

function hasVerifiedFundFlowAssetOption(selected: SelectedPageModelEvidence[], assetValue: string): boolean {
  const normalizedAsset = normalizeText(assetValue);
  return selected.some((item) => {
    if (item.kind !== "element" || !isVerifiedStatus(item.status)) return false;
    const field = inferSelectedEvidenceTargetField(item);
    if (field && field !== "asset") return false;
    if (item.optionValue) return normalizeText(item.optionValue) === normalizedAsset;
    const text = normalizeText(`${item.semanticName ?? ""} ${item.id}`);
    return text.includes(`option.${normalizedAsset}`) || text.includes(`:${normalizedAsset}`);
  }) || hasVerifiedDynamicDropdownForField(selected, "asset");
}

function isWithdrawAddressManagementIntent(intent: PageModelIntent): boolean {
  return intent.module === "withdraw" && (intent.action === "manage_withdraw_address" || intent.action === "add_withdraw_address");
}

function isNegativeWithdrawAmountIntent(intent: PageModelIntent): boolean {
  return intent.module === "withdraw" &&
    intent.action === "submit_withdraw" &&
    typeof intent.data.amountPolicy === "string" &&
    /below_minimum|above_available_balance|invalid|negative/i.test(intent.data.amountPolicy);
}

function hasVerifiedFundFlowProductTypeOption(selected: SelectedPageModelEvidence[], productType: string): boolean {
  const normalizedProductType = normalizeText(productType);
  return selected.some((item) => {
    if (item.kind !== "element" || !isVerifiedStatus(item.status)) return false;
    const field = inferSelectedEvidenceTargetField(item);
    if (field && field !== "product_type") return false;
    if (item.optionValue) return normalizeText(item.optionValue) === normalizedProductType;
    const text = normalizeText(`${item.semanticName ?? ""} ${item.id}`);
    return text.includes(normalizedProductType);
  });
}

function hasVerifiedFundFlowTimeFilter(selected: SelectedPageModelEvidence[]): boolean {
  return selected.some((item) =>
    item.kind === "element" &&
    inferSelectedEvidenceTargetField(item) === "time_range" &&
    isVerifiedStatus(item.status)
  );
}

function hasVerifiedSpotFundFlowResultAssertion(fallback: SelectedPageModelEvidence[]): boolean {
  return fallback.some((item) =>
    item.kind === "assertion" &&
    /资金流水结果列表|list_or_empty_state|record_type_gift_coin|暂无数据|暂无记录|暂无记录数据/.test(`${item.semanticName ?? ""} ${item.id}`) &&
    isVerifiedStatus(item.status)
  );
}

function hasVerifiedFundFlowResultAssertion(fallback: SelectedPageModelEvidence[]): boolean {
  return fallback.some((item) => {
    if (item.kind !== "assertion" || !isVerifiedStatus(item.status)) return false;
    const text = `${item.semanticName ?? ""} ${item.id}`;
    return /\u8d44\u91d1\u6d41\u6c34\u7ed3\u679c\u5217\u8868|\u7406\u8d22\u6d41\u6c34|\u7ed3\u679c\u5217\u8868|\u7a7a\u72b6\u6001|\u6682\u65e0\u6570\u636e|\u6682\u65e0\u8bb0\u5f55|list_or_empty_state|record_type_gift_coin|empty_state|result_list/i.test(text);
  });
}

function hasVerifiedTransferSubmitResultAssertion(fallback: SelectedPageModelEvidence[]): boolean {
  return fallback.some((item) =>
    item.kind === "assertion" &&
    /t2\.transfer\.submit_success|划转提交成功提示|success_tip|submit_success|success/i.test(`${item.semanticName ?? ""} ${item.id}`) &&
    isVerifiedStatus(item.status)
  );
}

function hasVerifiedTransferRecordAssertion(fallback: SelectedPageModelEvidence[]): boolean {
  return fallback.some((item) =>
    item.kind === "assertion" &&
    /t2_5\.transfer\.record_50_usdt_spot_to_futures|transfer_record_assertion|spot_to_futures_record|划转记录/.test(`${item.semanticName ?? ""} ${item.id}`) &&
    isVerifiedStatus(item.status)
  );
}

function hasEarnProductListAssertion(fallback: SelectedPageModelEvidence[]): boolean {
  return fallback.some((item) =>
    item.kind === "assertion" &&
    /product_list|产品列表|列表|row|行|modal_visible|page_visible/i.test(`${item.id} ${item.semanticName ?? ""}`) &&
    isVerifiedStatus(item.status)
  );
}

function hasEarnPositionListAssertion(fallback: SelectedPageModelEvidence[]): boolean {
  return fallback.some((item) =>
    item.kind === "assertion" &&
    /finance_account|earn_position|position_table|持仓列表|理财持仓|列表|列可见|row/i.test(`${item.id} ${item.semanticName ?? ""}`) &&
    isVerifiedStatus(item.status)
  );
}

function hasRedPacketSuccessAssertion(fallback: SelectedPageModelEvidence[]): boolean {
  return fallback.some((item) =>
    (item.kind === "assertion" || item.kind === "page") &&
    /red_packet|红包|success|成功|record|记录|passphrase|口令|claim|领取|create|创建/i.test(`${item.semanticName ?? ""} ${item.id}`) &&
    isVerifiedStatus(item.status)
  );
}

function hasEarnOperationSuccessAssertion(fallback: SelectedPageModelEvidence[]): boolean {
  return fallback.some((item) =>
    (item.kind === "assertion" || item.kind === "page" || item.kind === "element") &&
    /earn|理财|赎回|申购|success|成功|message|toast|modal/i.test(`${item.semanticName ?? ""} ${item.id}`) &&
    isVerifiedStatus(item.status)
  );
}

function hasEarnOperationDisabledAssertion(fallback: SelectedPageModelEvidence[]): boolean {
  return fallback.some((item) =>
    item.kind === "assertion" &&
    /element_disabled|disabled|置灰|不可点击|禁用|button.*disabled|按钮/i.test(`${item.assertionType ?? ""} ${item.semanticName ?? ""} ${item.id}`) &&
    isVerifiedStatus(item.status)
  );
}

function hasWithdrawFailureOrDisabledAssertion(fallback: SelectedPageModelEvidence[]): boolean {
  return fallback.some((item) =>
    item.kind === "assertion" &&
    /failure|precondition|blocked|disabled|不可提交|置灰|失败|前置条件|余额|最小|限额/i.test(`${item.assertionType ?? ""} ${item.semanticName ?? ""} ${item.id} ${(item.textCandidates ?? []).join(" ")}`) &&
    isVerifiedStatus(item.status)
  );
}

function hasEarnRowActionForAsset(selected: SelectedPageModelEvidence[], assetValue: string, actionLabel: string): boolean {
  const requestedAsset = normalizeAssetSymbolCandidate(assetValue);
  return selected.some((item) => {
    if (item.kind !== "element" || !isVerifiedStatus(item.status)) return false;
    const rowScope = item.rowScope && typeof item.rowScope === "object" ? item.rowScope as Record<string, unknown> : undefined;
    if (rowScope?.valueSource === "intent.data.asset") {
      const scopedActionText = typeof rowScope.actionText === "string" ? rowScope.actionText : "";
      return scopedActionText === actionLabel || /subscribe|redeem|申购|赎回/i.test(scopedActionText);
    }
    const rowWhere = rowScope?.rowWhere && typeof rowScope.rowWhere === "object" ? rowScope.rowWhere as Record<string, unknown> : undefined;
    if (rowWhere && String(rowWhere.asset ?? "").includes("{asset}")) {
      const scopedActionText = typeof rowScope?.actionText === "string" ? rowScope.actionText : "";
      return scopedActionText === actionLabel || /subscribe|redeem|申购|赎回/i.test(scopedActionText);
    }
    const text = `${item.id} ${item.semanticName ?? ""} ${item.role ?? ""} ${item.semanticRole ?? ""} ${item.controlType ?? ""}`;
    if (!new RegExp(actionLabel, "i").test(text) && !/subscribe|redeem|申购|赎回/i.test(text)) return false;
    if (!/row|产品行|持仓行|product_list|finance_account|row_action|action_button/i.test(text)) return false;
    const boundAsset = evidenceBoundAsset(item);
    if (boundAsset) return Boolean(requestedAsset) && boundAsset === requestedAsset;
    return hasAssetPlaceholder(item);
  });
}

function isVerifiedStatus(status?: string): boolean {
  return ["dom_verified", "screenshot_verified", "click_observed", "execution_observed", "execution_verified"].includes(status ?? "");
}

function computeReadiness(pageModels: PageModel[], gaps: Set<string>, hasBlockingPrecondition: boolean): PageModelReadiness {
  if (!pageModels.length) return "missing";
  if (hasBlockingPrecondition) return "blocked_by_precondition";
  return gaps.size ? "partial" : "ready";
}

function isBlockingGap(gap: string): boolean {
  return /submit_result|success_assertion|success_evidence|record_assertion|verification_provider|chain_selector|amount_input|amount_value|action_button|row_action_for_asset|confirm_button|account_selector|asset_selector|asset_scope|asset_filter_option|type_filter_option|time_filter/.test(gap);
}

function termsForIntent(intent: PageModelIntent): string[] {
  if (intent.module === "personal") {
    if (intent.action === "open_api_create_modal") return ["personal", "api", "API管理", "创建API", "立即创建", "标签", "谷歌验证码", "确认", "modal"];
    if (intent.action === "view_api_management") return ["personal", "api", "API管理", "创建API", "未创建API", "空状态"];
    if (intent.action === "open_kyc_start_modal") return ["personal", "kyc", "身份认证", "开始认证", "国家", "地区", "确定", "modal"];
    if (intent.action === "view_kyc_status") return ["personal", "kyc", "身份认证", "未认证", "开始认证", "权益"];
    if (intent.action === "open_invite_modal") return ["personal", "邀请码", "邀请链接", "查看", "modal"];
    if (intent.action === "update_nickname") return ["personal", "昵称", "修改", "输入", "确定", "enabled", "高亮", "成功"];
    if (intent.action === "assert_nickname_confirm_disabled" || intent.action === "open_nickname_modal") return ["personal", "昵称", "修改", "确定", "disabled", "置灰"];
    return ["personal", "账号管理", "安全设置", "UID", "邮箱", "手机号", "谷歌验证码", "资金密码", "提币白名单"];
  }
  if (isEarnOperationIntent(intent)) {
    const terms = ["earn", "理财", "理财账户", "amount", "数量", "确定", "success", "成功"];
    if (intent.action === "earn_redeem") terms.push("redeem", "赎回", "redeem_button", "redeem_amount");
    if (intent.action === "earn_subscribe") terms.push("subscribe", "申购", "购买", "subscribe_button", "subscribe_amount", "理财产品");
    if (typeof intent.data.asset === "string") terms.push(intent.data.asset);
    return terms;
  }
  if (intent.module === "asset" && intent.action === "earn_position_view") {
    return ["earn", "理财账户", "持仓", "持仓列表", "币种", "产品名称", "总金额", "累计收益", "昨日收益", "预期年化收益", "操作"];
  }
  if (intent.module === "asset" && intent.action === "earn_batch_redeem_modal_view") {
    return ["earn", "理财账户", "批量赎回", "批量赎回弹窗", "modal", "input_absent", "未提供行内赎回数量编辑"];
  }
  if (isFundFlowFilterIntent(intent)) {
    const terms = ["fund_flow", "spot_fund_flow", "query_button", "result_list", "result_table"];
    if (intent.action === "earn_fund_flow_filter") terms.push("earn_fund_flow", "product_type_filter", "transaction_type_filter");
    if (intent.action === "contract_fund_flow_filter") terms.push("contract_fund_flow", "futures_fund_flow");
    if (typeof intent.data.asset === "string") terms.push("asset_filter", intent.data.asset);
    const recordType = getIntentRecordType(intent);
    if (recordType) terms.push("type_filter", recordType);
    if (typeof intent.data.productType === "string") terms.push("product_type_filter", intent.data.productType);
    if (intent.data.timeRange) terms.push("time_filter", "date_filter");
    return terms;
  }
  if (intent.module === "withdraw" && isWithdrawAddressManagementIntent(intent)) {
    const terms = ["地址管理", "添加地址", "保存地址", "安全验证", "邮箱验证码", "谷歌验证码", "GA", "TOTP", "币种", "备注"];
    if (intent.data.addressType === "internal") terms.push("站内地址", "站内", "UID", "uid", "internal");
    else terms.push("链上地址", "网络", "地址", "USDT", "BSC");
    return terms;
  }
  if (intent.module === "withdraw") return ["提现", "提币", "币种", "链", "网络", "地址", "数量", "验证码", "手续费", "USDT", "BSC", "暂无数据"];
  if (intent.module === "transfer") return ["划转", "转出", "转入", "现货", "合约", "币种", "数量", "USDT"];
  if (intent.module === "red-packet") {
    const terms = ["red_packet", "红包", "创建红包", "领取", "红包记录", "红包明细", "口令", "发放数量", "红包个数", "安全验证", "邮箱验证码", "谷歌验证码", "TOTP"];
    if (intent.action === "create_red_packet") terms.push("create", "confirm_create", "拼手气红包", "普通红包", "祝福语");
    if (intent.action === "claim_red_packet") terms.push("claim", "passphrase", "输入红包口令");
    if (intent.action === "view_red_packet_records") terms.push("record", "history", "列表", "暂无数据");
    if (typeof intent.data.asset === "string") terms.push(intent.data.asset);
    return terms;
  }
  if (intent.module === "asset") return ["现货", "资金流水", "现货流水", "类型", "赠币", "筛选", "查询", "重置", "暂无数据", "暂无记录", "USDT"];
  return [];
}

function containsTerm(value: unknown, term: string): boolean {
  return JSON.stringify(value).includes(term);
}

function missing(text: string, term: string): boolean {
  return !text.includes(term);
}

function getIntentRecordType(intent: PageModelIntent): string | undefined {
  const value = typeof intent.data.recordType === "string" ? intent.data.recordType : typeof intent.data.type === "string" ? intent.data.type : undefined;
  return normalizeProjectRecordTypeAlias(intent, value);
}

function normalizeProjectRecordTypeAlias(intent: PageModelIntent, value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const projectAlias = normalizeIntentValueForProject(intent, trimmed);
  if (projectAlias) return projectAlias;
  return trimmed;
}

function isResetRequested(request: string): boolean {
  return /\u91cd\u7f6e|\u6e05\u7a7a|reset|clear/i.test(request);
}

function inferElementTargetField(element: PageModelElement): string | undefined {
  if (element.targetField) return normalizeTargetField(element.targetField);
  const text = elementSearchText(element);
  if (/button|open_modal|open_secondary|submit_or_confirm|action_button|query|reset|save_button/i.test(text)) return "action";
  if (/red_packet_type|packet_type|\u62fc\u624b\u6c14\u7ea2\u5305|\u666e\u901a\u7ea2\u5305/i.test(text)) return "red_packet_type";
  if (/red_packet_count|packet_count|\u7ea2\u5305\u4e2a\u6570|\u4e2a\u6570/i.test(text)) return "count";
  if (/red_packet_passphrase|passphrase|\u7ea2\u5305\u53e3\u4ee4|\u53e3\u4ee4/i.test(text)) return "passphrase";
  if (/greeting|\u795d\u798f\u8bed/i.test(text)) return "greeting";
  if (/product_type|\u4ea7\u54c1\u7c7b\u578b|\u6d3b\u671f\u7406\u8d22|\u5b9a\u671f\u7406\u8d22/i.test(text)) return "product_type";
  if (/type_filter|record_type|gift_coin|red_packet|\u7c7b\u578b|\u8d60\u5e01|\u7ea2\u5305/i.test(text)) return "record_type";
  if (/asset_filter|\u5e01\u79cd|currency_filter|currency|asset|symbol/i.test(text)) return "asset";
  if (/network_selector|network|chain|\u7f51\u7edc|\u94fe|BSC|BEP|TRC|ERC/i.test(text)) return "network";
  if (/uid|UID|\u7ad9\u5185.*\u5730\u5740/i.test(text)) return "uid";
  if (/address_type|withdraw_mode|\u94fe\u4e0a\u5730\u5740|\u7ad9\u5185\u5730\u5740|\u7ad9\u5185/i.test(text)) return "address_type";
  if (/address_input|address|\u5730\u5740/i.test(text)) return "address";
  if (/amount_input|amount|min_amount|\u6570\u91cf|\u91d1\u989d|\u6700\u5c0f/i.test(text)) return "amount";
  if (/verification|email_code|sms_code|totp|provider|\u9a8c\u8bc1\u7801/i.test(text)) return "verification_code";
  if (/withdraw_mode|\u94fe\u4e0a\u63d0\u5e01|\u7ad9\u5185\u76f4\u8f6c/i.test(text)) return "withdraw_mode";
  if (/time_filter|\u65f6\u95f4|\u65e5\u671f|date/i.test(text)) return "time_range";
  if (/status|\u72b6\u6001/i.test(text)) return "status";
  return undefined;
}

function inferSelectedEvidenceTargetField(item: SelectedPageModelEvidence): string | undefined {
  if (item.targetField) return normalizeTargetField(item.targetField);
  return inferElementTargetField({
    elementId: item.id,
    semanticName: item.semanticName,
    role: item.role,
    semanticRole: item.semanticRole,
    parentElementId: item.parentElementId
  });
}

function inferElementOptionValue(element: PageModelElement, field: string): string | undefined {
  if (element.optionValue) return String(element.optionValue);
  const id = element.elementId ?? element.sourceProposalId ?? "";
  const semanticName = element.semanticName ?? "";
  const optionMatch = id.match(/\.option\.([^.\s]+)$/i)?.[1];
  if (optionMatch) return /^[a-z0-9]+$/i.test(optionMatch) ? optionMatch.toUpperCase() : optionMatch;
  const fromName = semanticName.match(/[:\uff1a]\s*([^:]+)$/)?.[1]?.trim();
  if (fromName) return fromName;
  if (field === "asset") return `${id} ${semanticName}`.match(/\b[A-Z0-9]{2,12}\b/)?.[0];
  return undefined;
}

function normalizeTargetField(value: string): string {
  const normalized = value.toLowerCase();
  if (["currency", "coin", "symbol"].includes(normalized)) return "asset";
  if (["redpackettype", "red_packet_type", "packettype", "packet_type"].includes(normalized)) return "red_packet_type";
  if (["count", "quantity", "redpacketcount", "red_packet_count"].includes(normalized)) return "count";
  if (["passphrase", "redpacketpassphrase", "red_packet_passphrase", "packetcode", "packet_code"].includes(normalized)) return "passphrase";
  if (["greeting", "blessing", "message"].includes(normalized)) return "greeting";
  if (["type", "recordtype", "record_type"].includes(normalized)) return "record_type";
  if (["producttype", "product_type"].includes(normalized)) return "product_type";
  if (["time", "date", "timerange", "time_range", "date_range"].includes(normalized)) return "time_range";
  if (["chain"].includes(normalized)) return "network";
  if (["mode", "addressmode", "address_mode", "addresstype", "address_type", "withdrawmode", "withdraw_mode"].includes(normalized)) return "address_type";
  if (["internaluid", "internal_uid", "useruid", "user_uid"].includes(normalized)) return "uid";
  if (["remark", "memo", "name"].includes(normalized)) return "label";
  return normalized;
}

function elementSearchText(element: PageModelElement): string {
  return [
    element.elementId,
    element.sourceProposalId,
    element.semanticName,
    element.role,
    element.semanticRole,
    element.controlType,
    element.targetField,
    element.parentElementId,
    element.rowScope ? JSON.stringify(element.rowScope) : undefined,
    element.locatorCandidates ? JSON.stringify(element.locatorCandidates) : undefined
  ].filter(Boolean).join(" ");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractFundFlowType(request: string): string | undefined {
  const quoted = request.match(/(?:\u4ea4\u6613\u7c7b\u578b|\u7b5b\u9009\u7c7b\u578b|\u901a\u8fc7\u7c7b\u578b|(?<!\u4ea7\u54c1)\u7c7b\u578b)(?:\u4e0b\u62c9\u6846|\u5b57\u6bb5)?(?:\u9009\u62e9|\u7b5b\u9009|\u4e3a|=)\s*["\u201c\u201d]?([^"\u201c\u201d\uff0c,\u3002\s]+)["\u201c\u201d]?/)?.[1];
  const normalizedQuoted = cleanExtractedFundFlowType(quoted);
  if (normalizedQuoted && !/^(?:\u4e0b\u62c9\u6846|\u4e0b\u62c9\u6846\u9009\u62e9|\u9009\u62e9|\u7b5b\u9009|\u641c\u7d22|\u67e5\u8be2)$/.test(normalizedQuoted)) return normalizedQuoted;
  const knownTypes = [
    "\u7ea2\u5305\u53d1\u653e",
    "\u7ea2\u5305\u9886\u53d6",
    "\u7ea2\u5305\u9000\u6b3e",
    "\u8d60\u5e01",
    "\u4ea4\u6613",
    "\u5145\u503c",
    "\u63d0\u73b0",
    "\u5212\u8f6c",
    "\u5185\u90e8\u8f6c\u5165",
    "\u5185\u90e8\u8f6c\u51fa",
    "\u5408\u7ea6\u5212\u8f6c",
    "\u7406\u8d22\u5212\u8f6c",
    "\u9080\u8bf7\u5956\u52b1",
    "\u8d44\u91d1\u8d39\u7528",
    "\u5f00\u4ed3\u624b\u7eed\u8d39",
    "\u5e73\u4ed3\u624b\u7eed\u8d39",
    "\u5e73\u4ed3\u76c8\u4e8f",
    "\u8f6c\u5165",
    "\u8f6c\u51fa",
    "\u7533\u8d2d",
    "\u8d4e\u56de",
    "\u6536\u76ca",
    "\u6d3e\u606f",
    "\u672c\u91d1\u53ca\u6536\u76ca\u8fd4\u8fd8",
    "\u672c\u91d1\u8fd4\u8fd8",
    "\u5229\u606f\u6536\u76ca"
  ];
  for (const type of knownTypes) {
    const pattern = new RegExp(`(?:\\u4ea4\\u6613\\u7c7b\\u578b|\\u7c7b\\u578b)(?:\\u4e0b\\u62c9\\u6846|\\u5b57\\u6bb5)?(?:\\u9009\\u62e9|\\u7b5b\\u9009|\\u4e3a|=).{0,12}${escapeRegExp(type)}|(?:\\u901a\\u8fc7\\u7c7b\\u578b|\\u7b5b\\u9009).{0,12}${escapeRegExp(type)}`);
    if (pattern.test(request)) return type;
  }
  return undefined;
}

function extractStatusFilterValue(request: string): string | undefined {
  return request.match(/(?:状态|status)(?:下拉框|字段)(?:选择|筛选|为|=)\s*["“”']?([^"“”'，,。；;\s]+)["“”']?/)?.[1]
    ?? (request.includes("已领取") ? "已领取" : undefined)
    ?? request.match(/(?:状态|status)(?:为|=)\s*["“”']?([^"“”'，,。；;\s]+)["“”']?/)?.[1];
}

function hasVerifiedDynamicDropdownForField(selected: SelectedPageModelEvidence[], targetField: string): boolean {
  return selected.some((item) => {
    if (item.kind !== "element" || !isVerifiedStatus(item.status)) return false;
    if (item.controlType !== "dropdown") return false;
    if (inferSelectedEvidenceTargetField(item) !== targetField) return false;
    const dropdown = item.dropdown ?? {};
    const mode = String(dropdown.optionDiscoveryMode ?? dropdown.option_discovery_mode ?? "").toLowerCase();
    const hasSearchInput = Boolean(dropdown.searchInput || dropdown.search_input || dropdown.searchInputLocator || dropdown.search_input_locator);
    const hasSelectedValueSignal = Boolean(dropdown.selectedValueSignal || dropdown.selected_value_signal || dropdown.valuePersistenceSignal);
    return /searchable|dynamic|remote|virtualized/.test(mode) && hasSearchInput && hasSelectedValueSignal;
  });
}

function cleanExtractedFundFlowType(value?: string): string | undefined {
  const cleaned = value
    ?.replace(/(?:\u8fdb\u884c)?(?:\u641c\u7d22|\u67e5\u8be2).*$/u, "")
    .replace(/\u7684\u6570\u636e.*$/u, "")
    .trim();
  return cleaned || undefined;
}

function extractEarnProductType(request: string): string | undefined {
  for (const type of ["\u6d3b\u671f\u7406\u8d22", "\u5b9a\u671f\u7406\u8d22"]) {
    if (request.includes(type)) return type;
  }
  return undefined;
}

function isFundFlowFilterIntent(intent: PageModelIntent): boolean {
  return intent.module === "asset" && (intent.action === "spot_fund_flow_filter" || intent.action === "earn_fund_flow_filter" || intent.action === "contract_fund_flow_filter");
}

function extractTimeRange(request: string): { raw: string; mode: "relative" | "absolute" | "range"; start?: string; end?: string } | undefined {
  const relative = request.match(/(\u4eca\u5929|\u6628\u5929|\u6700\u8fd17\u5929|\u6700\u8fd1\u4e03\u5929|\u6700\u8fd130\u5929|\u6700\u8fd1\u4e09\u5341\u5929)/)?.[1];
  if (relative) return { raw: relative, mode: "relative" };
  const dateTimes = [...request.matchAll(/\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?/g)].map((match) => match[0].replace(/\//g, "-").replace(/\s+/g, " ").trim());
  if (dateTimes.length >= 2) {
    const start = normalizeDateTimeBoundary(dateTimes[0], "start");
    const end = normalizeDateTimeBoundary(dateTimes[1], "end");
    return { raw: `${start}~${end}`, mode: "range", start, end };
  }
  const date = dateTimes[0];
  if (date) return { raw: date, mode: "absolute" };
  return undefined;
}

function normalizeDateTimeBoundary(value: string, boundary: "start" | "end"): string {
  if (/\d{1,2}:\d{2}/.test(value)) return value;
  return `${value} ${boundary === "start" ? "00:00:00" : "23:59:59"}`;
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, "");
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item).trim()).filter(Boolean);
}

function extractAsset(request: string): string | undefined {
  const searchable = request.replace(/0x[a-fA-F0-9]{32,}/g, " ");
  const explicit = searchable.match(/(?:币种|资产|asset|coin|symbol)(?:下拉框|字段)?(?:选择|输入|为|=|:)?\s*["“”']?\b([A-Z0-9]{2,12})\b/i)?.[1];
  if (explicit) {
    return normalizeAssetSymbolCandidate(explicit);
  }
  const productRow = searchable.match(/(?:定位|选择|点击|查看|进入)?\s*["“”']?\b([A-Za-z][A-Za-z0-9]{1,11})\b["“”']?\s*(?:产品行|币种行|资产行|持仓行)/i)?.[1];
  if (productRow) {
    return normalizeAssetSymbolCandidate(productRow);
  }
  const coupledWithAmount = searchable.match(/[0-9]+(?:\.[0-9]+)?\s*([A-Z][A-Z0-9]{1,11})\b/)?.[1];
  if (coupledWithAmount) {
    return normalizeAssetSymbolCandidate(coupledWithAmount);
  }
  if (isInternalWithdrawAddressRequest(request)) return undefined;
  const tokens = [...searchable.matchAll(/\b[A-Z][A-Z0-9]{1,11}\b/g)].map((match) => match[0].toUpperCase());
  const networkTokens = new Set(["BSC", "BEP20", "BEP", "TRC20", "TRC", "ERC20", "ERC", "ARB", "ARBITRUM", "POLYGON"]);
  return tokens.find((token) => !networkTokens.has(token) && !isNonAssetBusinessToken(token));
}

function isNonAssetBusinessToken(token: string): boolean {
  return new Set(["UID", "ID", "GA", "TOTP", "OTP", "API", "KYC", "TEST", "UAT", "ENV", "LOGIN", "USER", "ACCOUNT"]).has(token.toUpperCase());
}

function normalizeAssetSymbolCandidate(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const raw = String(value).trim().replace(/["“”']/g, "");
  if (!/^[A-Za-z][A-Za-z0-9]{1,11}$/.test(raw)) return undefined;
  const normalized = raw.toUpperCase();
  return isNonAssetBusinessToken(normalized) ? undefined : normalized;
}

function isEarnRowActionElement(element: PageModelElement): boolean {
  const text = elementSearchText(element);
  if (!/subscribe|redeem|申购|赎回/i.test(text)) return false;
  return /row|产品行|持仓行|product_list|finance_account|row_action|action_button/i.test(text);
}

function isDynamicEarnRowActionTemplate(intent: PageModelIntent, element: PageModelElement): boolean {
  const rowScope = element.rowScope && typeof element.rowScope === "object" ? element.rowScope as Record<string, unknown> : undefined;
  const rowWhere = rowScope?.rowWhere && typeof rowScope.rowWhere === "object" ? rowScope.rowWhere as Record<string, unknown> : undefined;
  const hasDynamicAsset = rowScope?.valueSource === "intent.data.asset" || String(rowWhere?.asset ?? "").includes("{asset}");
  if (!hasDynamicAsset) return false;
  const actionText = typeof rowScope?.actionText === "string" ? rowScope.actionText : "";
  if (intent.action === "earn_subscribe") return /申购|subscribe|购买/i.test(actionText);
  if (intent.action === "earn_redeem") return /赎回|redeem/i.test(actionText);
  return false;
}

function elementBoundAsset(element: PageModelElement): string | undefined {
  const rowScopeValue = valueFromRecord(element.rowScope, "value");
  const rowScopeAsset = normalizeAssetSymbolCandidate(rowScopeValue);
  if (rowScopeAsset) return rowScopeAsset;
  const optionAsset = normalizeAssetSymbolCandidate(element.optionValue);
  if (optionAsset && inferElementTargetField(element) === "asset") return optionAsset;
  const serializedLocators = JSON.stringify(element.locatorCandidates ?? []);
  const rowScopedMatch = serializedLocators.match(/rowScoped=(?:value|asset):([A-Za-z][A-Za-z0-9]{1,11})/i)?.[1];
  const rowContainsMatch = serializedLocators.match(/row\s+contains\s+([A-Za-z][A-Za-z0-9]{1,11})/i)?.[1];
  const locatorAsset = normalizeAssetSymbolCandidate(rowScopedMatch ?? rowContainsMatch);
  if (locatorAsset) return locatorAsset;
  const text = `${element.elementId ?? ""} ${element.semanticName ?? ""}`;
  const rowTextMatch = text.match(/\b([A-Za-z][A-Za-z0-9]{1,11})\b\s*(?:产品行|持仓行|币种行|资产行)/i)?.[1]
    ?? text.match(/[._-]([A-Za-z][A-Za-z0-9]{1,11})[._-]row(?!_action)/i)?.[1];
  return normalizeAssetSymbolCandidate(rowTextMatch);
}

function evidenceBoundAsset(item: SelectedPageModelEvidence): string | undefined {
  if (item.entityBindings?.asset) return normalizeAssetSymbolCandidate(item.entityBindings.asset);
  const rowScopeValue = valueFromRecord(item.rowScope, "value");
  const rowScopeAsset = normalizeAssetSymbolCandidate(rowScopeValue);
  if (rowScopeAsset) return rowScopeAsset;
  if (item.targetField === "asset") return normalizeAssetSymbolCandidate(item.optionValue);
  const serializedLocators = JSON.stringify(item.locatorCandidates ?? []);
  const rowScopedMatch = serializedLocators.match(/rowScoped=(?:value|asset):([A-Za-z][A-Za-z0-9]{1,11})/i)?.[1];
  const rowContainsMatch = serializedLocators.match(/row\s+contains\s+([A-Za-z][A-Za-z0-9]{1,11})/i)?.[1];
  const locatorAsset = normalizeAssetSymbolCandidate(rowScopedMatch ?? rowContainsMatch);
  if (locatorAsset) return locatorAsset;
  const text = `${item.id} ${item.semanticName ?? ""}`;
  const rowTextMatch = text.match(/\b([A-Za-z][A-Za-z0-9]{1,11})\b\s*(?:产品行|持仓行|币种行|资产行)/i)?.[1]
    ?? text.match(/[._-]([A-Za-z][A-Za-z0-9]{1,11})[._-]row(?!_action)/i)?.[1];
  return normalizeAssetSymbolCandidate(rowTextMatch);
}

function hasAssetPlaceholder(item: SelectedPageModelEvidence): boolean {
  return JSON.stringify(item.locatorCandidates ?? []).includes("{asset}") ||
    JSON.stringify(item.locatorCandidates ?? []).includes("intent.data.asset");
}

function valueFromRecord(record: Record<string, unknown> | undefined, key: string): unknown {
  return record && typeof record === "object" ? record[key] : undefined;
}

function isInternalWithdrawAddressRequest(request: string): boolean {
  return /站内地址|站内|UID|uid|internal/i.test(request) && /提现|提币|地址/.test(request);
}

function extractNetwork(request: string): string | undefined {
  const exact = request.match(/BSC\s*\(\s*BEP-?20\s*\)/i)?.[0];
  if (exact) return "BSC(BEP-20)";
  const explicit = request.match(/(?:网络|链|network|chain)(?:下拉框|字段)?(?:选择|输入|为|=|:)?\s*["“”']?([A-Za-z0-9() -]{2,32})/i)?.[1]?.trim();
  if (explicit && /BSC|BEP|TRC|ERC|ARB|POL|SOL|Polygon|Ethereum|Tron/i.test(explicit)) return explicit;
  if (/\bBSC\b/i.test(request)) return "BSC";
  return undefined;
}

function extractAmount(request: string): number | undefined {
  const searchable = request.replace(/0x[a-fA-F0-9]{32,}/g, " ");
  const explicit = searchable.match(/(?:金额|发放数量|红包金额|数量输入|划转|输入|赎回|申购|购买)\s*([0-9]+(?:\.[0-9]+)?)/)?.[1];
  if (explicit) return Number(explicit);
  const assetCoupled = searchable.match(/([0-9]+(?:\.[0-9]+)?)\s*(?:USDT|BTC|ETH|SOL|DOT|ZEC|BNB|AIV|[A-Z]{2,12})\b/)?.[1];
  return assetCoupled ? Number(assetCoupled) : undefined;
}

function extractCount(request: string): number | undefined {
  const match = request.match(/(?:红包个数|个数|数量|份数|人数)\s*([0-9]+)/);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function extractRedPacketPassphrase(request: string): string | undefined {
  const quoted = request.match(/(?:口令|领取码|邀请码|passphrase|code)(?:输入|为|=|:|：)?\s*["“”']([^"“”']+)["“”']/i)?.[1]?.trim();
  if (quoted) return quoted;
  return request.match(/(?:口令|领取码|邀请码)(?:输入|为|=|:|：)?\s*([A-Za-z0-9_-]{4,64})/)?.[1]?.trim();
}

function extractGreeting(request: string): string | undefined {
  return request.match(/(?:祝福语|备注|留言)(?:输入|为|=|:|：)?\s*["“”']([^"“”']+)["“”']/)?.[1]?.trim();
}

function pageEvidence(model: PageModel, reason: string): SelectedPageModelEvidence {
  return {
    kind: "page",
    id: model.pageId,
    pageId: model.pageId,
    url: model.url,
    urlPattern: model.urlPattern,
    semanticName: model.pageName,
    status: model.status,
    confidence: model.confidence,
    resultTable: model.resultTable,
    fieldMappings: model.fieldMappings,
    reason,
    evidence: normalizeEvidence(model.evidence, model.pageId)
  };
}

function elementEvidence(model: PageModel, element: PageModelElement): SelectedPageModelEvidence {
  const boundAsset = elementBoundAsset(element);
  return {
    kind: "element",
    id: element.elementId ?? element.sourceProposalId ?? `${model.pageId}:element`,
    pageId: model.pageId,
    semanticName: element.semanticName,
    status: element.status,
    confidence: element.confidence,
    role: element.role,
    container: element.container,
    region: element.region,
    semanticRole: element.semanticRole,
    controlType: element.controlType,
    targetField: inferElementTargetField(element),
    optionValue: inferElementOptionValue(element, inferElementTargetField(element) ?? ""),
    parentElementId: element.parentElementId,
    dropdown: element.dropdown,
    rowScope: element.rowScope,
    actionPostconditions: actionPostconditionsForElement(model, element),
    entityBindings: boundAsset ? { asset: boundAsset } : undefined,
    locatorCandidates: element.locatorCandidates,
    negativeLocatorHints: element.negativeLocatorHints,
    preconditions: element.preconditions,
    reason: "Element matched request terms or required funds-center control.",
    evidence: normalizeEvidence(element.evidence, element.elementId ?? element.sourceProposalId)
  };
}

function assertionEvidence(model: PageModel, assertion: PageModelAssertion): SelectedPageModelEvidence {
  return {
    kind: "assertion",
    id: assertion.assertionId ?? assertion.sourceProposalId ?? `${model.pageId}:assertion`,
    pageId: model.pageId,
    semanticName: assertion.semanticName ?? assertion.assertionKind ?? assertion.assertionType,
    status: assertion.status,
    assertionType: assertion.assertionType ?? assertion.assertionKind,
    targetElementId: assertion.targetElementId,
    targetStateId: assertion.targetStateId,
    textCandidates: assertion.textCandidates,
    locatorCandidates: Array.isArray(assertion.candidates) ? assertion.candidates : undefined,
    reason: "Assertion candidate can support result or empty-state checking.",
    evidence: normalizeEvidence(assertion.evidence, assertion.assertionId ?? assertion.sourceProposalId)
  };
}

function blockEvidence(model: PageModel, block: PageModelBlock): SelectedPageModelEvidence {
  return {
    kind: "block",
    id: block.blockId ?? `${model.pageId}:block`,
    pageId: model.pageId,
    semanticName: block.blockType,
    status: block.status ?? "blocked",
    reason: block.requiredHumanAction ?? "BlockPackage is available for this page state.",
    evidence: normalizeEvidence(block.evidence, block.blockId)
  };
}

function actionPostconditionsForElement(model: PageModel, element: PageModelElement): Array<Record<string, unknown>> | undefined {
  const elementId = element.elementId ?? element.sourceProposalId;
  if (!elementId) return undefined;
  const matches = (model.actions ?? [])
    .filter((action) => action.targetElementId === elementId)
    .flatMap((action) => (action.postconditions ?? []).map((postcondition) => ({
      ...postcondition,
      actionId: action.actionId,
      actionType: action.actionType
    })));
  return matches.length ? matches : undefined;
}

function providerRequirementEvidence(model: PageModel, provider: PageModelProviderRequirement): SelectedPageModelEvidence {
  return {
    kind: "provider",
    id: provider.providerRequirementId ?? `${model.pageId}:provider`,
    pageId: model.pageId,
    semanticName: `${provider.provider ?? "provider"}:${provider.codeType ?? "code"}`,
    provider: provider.provider,
    codeType: provider.codeType,
    scene: provider.scene,
    providerRequirementId: provider.providerRequirementId,
    status: provider.status,
    reason: `ProviderRequirement ${provider.provider ?? "unknown"} ${provider.codeType ?? ""} scene=${provider.scene ?? "unknown"} mapping=${provider.mappingStatus ?? "unknown"} call=${provider.providerCallStatus ?? "unknown"}`,
    evidence: normalizeEvidence(provider.evidence, provider.providerRequirementId)
  };
}

function normalizeEvidence(value: unknown, id?: string): EvidenceRef[] {
  if (!Array.isArray(value)) return [{ source: "page_map", id, confidence: 0.5 }];
  return value.slice(0, 5).map((item) => {
    const record = item && typeof item === "object" ? item as Record<string, unknown> : {};
    return {
      source: "page_map",
      id: String(id ?? record.path ?? record.source ?? "page_model"),
      quote: typeof record.path === "string" ? record.path : undefined,
      confidence: typeof record.confidence === "number" ? record.confidence : 0.5,
      evidenceLevel: record.confidence && Number(record.confidence) >= 0.65 ? "verified" : "weak_candidate"
    };
  });
}
