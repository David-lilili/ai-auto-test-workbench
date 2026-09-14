import fs from "fs-extra";
import path from "node:path";

export interface PageOperationManualSelection {
  storePath?: string;
  manuals: Array<Record<string, unknown>>;
  capabilities: Array<Record<string, unknown>>;
  providerFlows: Array<Record<string, unknown>>;
  successEvidencePolicies: Array<Record<string, unknown>>;
  modelingRules: string[];
  gaps: string[];
}

export async function loadRelevantPageOperationManuals(input: {
  rootDir: string;
  project: string;
  env: string;
  intent: {
    module: string;
    action: string;
    data?: Record<string, unknown>;
  };
  request: string;
}): Promise<PageOperationManualSelection> {
  const storePath = path.join(input.rootDir, "storage", "operation-manuals", `${input.project}.json`);
  if (!(await fs.pathExists(storePath))) {
    return {
      storePath,
      manuals: [],
      capabilities: [],
      providerFlows: [],
      successEvidencePolicies: [],
      modelingRules: [],
      gaps: ["operation_manual_store_missing"]
    };
  }
  const store = await fs.readJson(storePath) as Record<string, unknown>;
  return selectRelevantPageOperationManuals({
    storePath,
    store,
    env: input.env,
    intent: input.intent,
    request: input.request
  });
}

export function selectRelevantPageOperationManuals(input: {
  storePath?: string;
  store: Record<string, unknown>;
  env: string;
  intent: {
    module: string;
    action: string;
    data?: Record<string, unknown>;
  };
  request: string;
}): PageOperationManualSelection {
  const manuals = readArray(input.store.manuals).filter((manual) =>
    String(manual.module ?? "") === input.intent.module ||
    manualMatchesRequest(manual, input.request)
  );
  const selectedCapabilities = manuals.flatMap((manual) =>
    readArray(manual.capabilities)
      .filter((capability) => capabilityMatchesIntent(capability, input.intent, input.request))
      .map((capability) => compactCapability(manual, capability))
  );
  const providerFlowIds = new Set(selectedCapabilities.flatMap((capability) => readStringArray(capability.providerFlowIds)));
  const policyIds = new Set(selectedCapabilities.map((capability) => String(capability.successEvidencePolicyId ?? "")).filter(Boolean));
  const availableProviderFlows = [
    ...readArray(input.store.providerFlows),
    ...manuals.flatMap((manual) => readArray(manual.providerFlows))
  ];
  const availableSuccessEvidencePolicies = [
    ...readArray(input.store.successEvidencePolicies),
    ...manuals.flatMap((manual) => readArray(manual.successEvidencePolicies))
  ];
  const providerFlows = availableProviderFlows
    .filter((flow) => providerFlowIds.has(String(flow.providerFlowId ?? "")))
    .map(compactProviderFlow);
  const successEvidencePolicies = availableSuccessEvidencePolicies
    .filter((policy) => policyIds.has(String(policy.policyId ?? "")))
    .map(compactSuccessEvidencePolicy);
  const gaps = [
    manuals.length ? undefined : "operation_manual_not_found_for_intent",
    selectedCapabilities.length ? undefined : "operation_manual_capability_not_found_for_intent",
    providerFlowIds.size > 0 && providerFlows.length === 0 ? "operation_manual_provider_flow_missing" : undefined,
    policyIds.size > 0 && successEvidencePolicies.length === 0 ? "operation_manual_success_policy_missing" : undefined
  ].filter(Boolean) as string[];
  return {
    storePath: input.storePath,
    manuals: manuals.map(compactManual),
    capabilities: selectedCapabilities,
    providerFlows,
    successEvidencePolicies,
    modelingRules: readStringArray(input.store.modelingRules),
    gaps
  };
}

function manualMatchesRequest(manual: Record<string, unknown>, request: string): boolean {
  const text = normalizeText(`${manual.pageName ?? ""} ${manual.pageId ?? ""} ${JSON.stringify(manual.pageSummary ?? {})}`);
  return normalizeText(request).split(/[,，。；;\s]+/).some((term) => term.length >= 2 && text.includes(term));
}

function capabilityMatchesIntent(capability: Record<string, unknown>, intent: { action: string; data?: Record<string, unknown> }, request: string): boolean {
  const id = String(capability.capabilityId ?? "");
  if (isSecurityMethodGuardRequest(request)) {
    const operationType = String(capability.operationType ?? "");
    const text = normalizeText(`${id} ${capability.flowId ?? ""} ${readStringArray(capability.naturalLanguageAliases).join(" ")} ${readStringArray(capability.expectedEffects).join(" ")}`);
    return operationType === "negative_guard" && /security|安全|验证|block|guard|required|拦截|未绑定|未开启/.test(text);
  }
  if (intent.action === "spot_fund_flow_filter") return id === "filter_spot_fund_flow";
  if (intent.action === "contract_fund_flow_filter") return id === "filter_contract_fund_flow";
  if (intent.action === "earn_fund_flow_filter") return id === "filter_earn_fund_flow";
  if (intent.action === "earn_product_view") {
    return isExplicitTabSwitchRequest(request) ? id === "switch_earn_product_type" : id === "view_earn_products";
  }
  if (intent.action === "earn_subscribe") {
    if (/余额不足|余额为\s*0|现货账户\s*0|低于最小|最小申购|为空|未输入|置灰|不可点击|disabled/i.test(request)) {
      return id === "subscribe_earn_product_boundary_validation";
    }
    return id === "subscribe_earn_product";
  }
  if (intent.action === "manage_withdraw_address") return id === "open_withdraw_address_management";
  if (intent.action === "add_withdraw_address") {
    if (intent.data?.addressType === "internal" || /站内|UID|uid|internal/i.test(request)) return id === "create_internal_withdraw_address";
    return id === "create_onchain_withdraw_address";
  }
  if (intent.action === "submit_withdraw" || /发起提现|提币|提现/i.test(request)) return id === "submit_onchain_withdraw";
  if (intent.action === "create_red_packet") return id === "create_red_packet";
  if (intent.action === "claim_red_packet") return id === "claim_red_packet";
  if (intent.action === "view_red_packet_records") return id === "view_red_packet_records";
  const aliases = readStringArray(capability.naturalLanguageAliases).map(normalizeText);
  const normalizedRequest = normalizeText(request);
  return aliases.some((alias) => alias && normalizedRequest.includes(alias));
}

function isSecurityMethodGuardRequest(request: string): boolean {
  return /拦截|阻断|未开启|未绑定|至少开启|安全验证|验证方式|手机验证码|谷歌验证码|Google|GA/i.test(request) &&
    /创建|提现|提币|保存|添加|提交|发红包|创建红包|地址管理|create|submit|add|save|withdraw/i.test(request);
}

function isExplicitTabSwitchRequest(request: string): boolean {
  return /(?:点击|选择|切换|切换到|切换为).{0,16}(?:标签|页签|tab)|(?:活期|定期).{0,8}(?:标签|页签|tab)|产品类型/.test(request);
}

function compactManual(manual: Record<string, unknown>): Record<string, unknown> {
  return {
    manualId: manual.manualId,
    pageId: manual.pageId,
    pageName: manual.pageName,
    module: manual.module,
    entry: manual.entry,
    pageSummary: manual.pageSummary
  };
}

function compactCapability(manual: Record<string, unknown>, capability: Record<string, unknown>): Record<string, unknown> {
  return {
    manualId: manual.manualId,
    pageId: manual.pageId,
    capabilityId: capability.capabilityId,
    operationType: capability.operationType,
    flowId: capability.flowId,
    requiredData: capability.requiredData,
    optionalData: capability.optionalData,
    requiredAccountProfileDimensions: capability.requiredAccountProfileDimensions,
    profileImpact: capability.profileImpact,
    blockedStateIds: capability.blockedStateIds,
    expectedEffects: capability.expectedEffects,
    providerFlowIds: capability.providerFlowIds,
    successEvidencePolicyId: capability.successEvidencePolicyId,
    naturalLanguageAliases: capability.naturalLanguageAliases
  };
}

function compactProviderFlow(flow: Record<string, unknown>): Record<string, unknown> {
  return {
    providerFlowId: flow.providerFlowId,
    description: flow.description,
    trigger: flow.trigger,
    businessSteps: flow.businessSteps,
    requiredProviders: flow.requiredProviders,
    expectedEffects: flow.expectedEffects
  };
}

function compactSuccessEvidencePolicy(policy: Record<string, unknown>): Record<string, unknown> {
  return {
    policyId: policy.policyId,
    description: policy.description,
    preferredEvidenceOrder: policy.preferredEvidenceOrder,
    acceptedSignals: policy.acceptedSignals,
    failureSignals: policy.failureSignals
  };
}

function readArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object") : [];
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, "");
}
