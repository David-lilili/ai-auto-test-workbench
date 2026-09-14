import type { DslDraft, DslDraftStep } from "./ai-orchestration-schema.js";
import type { PageModelEvidenceSelection, SelectedPageModelEvidence } from "./page-model-evidence-selector.js";

export interface PageModelDslDryRunResult {
  schemaVersion: "page-model-dsl-dry-run.v1";
  request: string;
  readiness: PageModelEvidenceSelection["readiness"];
  executable: boolean;
  dsl: DslDraft;
  gaps: string[];
  blockingGaps: string[];
  reason: string;
}

export function buildPageModelDslDryRun(selection: PageModelEvidenceSelection): PageModelDslDryRunResult {
  const steps: DslDraftStep[] = [];
  const pageEvidence = selection.selectedEvidence.filter((item) => item.kind === "page");
  const elementEvidence = selection.selectedEvidence.filter((item) => item.kind === "element");
  const assertionEvidence = selection.fallbackEvidence.filter((item) => item.kind === "assertion");

  for (const page of pageEvidence) {
    steps.push(buildStep({
      id: `open-${safeId(page.pageId ?? page.id)}`,
      action: "navigate",
      evidenceItem: page,
      runtimeResolvable: page.status !== "dom_verified",
      confidence: page.confidence ?? 0.55
    }));
  }

  for (const element of elementEvidence.slice(0, 12)) {
    const action = inferElementAction(selection, element);
    steps.push(buildStep({
      id: `${action}-${safeId(element.id)}`,
      action,
      evidenceItem: element,
      runtimeResolvable: element.status !== "dom_verified",
      confidence: element.confidence ?? 0.5,
      inputValue: valueForElement(selection, element),
      valueSource: valueSourceForElement(selection, element)
    }));
  }

  for (const assertion of assertionEvidence.slice(0, 4)) {
    steps.push(buildStep({
      id: `assert-${safeId(assertion.id)}`,
      action: "assert",
      evidenceItem: assertion,
      runtimeResolvable: true,
      confidence: assertion.confidence ?? 0.45,
      assertion: {
        type: "page_model_assertion_candidate",
        target: assertion.semanticName ?? assertion.id,
        expected: selection.intent.operationType === "read" ? "matching records or empty state" : "success state or record evidence"
      }
    }));
  }

  const moduleName = selection.intent.module === "unknown" ? "asset" : selection.intent.module;
  const dsl: DslDraft = {
    schemaVersion: "dsl-draft.v1",
    project: selection.intent.project,
    env: selection.intent.env,
    module: moduleName,
    action: selection.intent.action,
    operationType: selection.intent.operationType,
    loginRequired: selection.intent.loginRequired,
    data: selection.intent.data,
    providerDependencies: providerDependenciesForSelection(selection),
    steps,
    assertions: assertionEvidence.map((item) => ({
      type: "pageModelAssertion",
      pageId: item.pageId,
      assertionId: item.id,
      status: item.status,
      reason: item.reason
    })),
    clarificationQuestions: selection.executable ? [] : selection.gaps.map((gap) => `补充 Page Model evidence: ${gap}`)
  };

  return {
    schemaVersion: "page-model-dsl-dry-run.v1",
    request: selection.request,
    readiness: selection.readiness,
    executable: selection.executable,
    dsl,
    gaps: selection.gaps,
    blockingGaps: selection.blockingGaps,
    reason: selection.executable
      ? "All required Page Model evidence is available."
      : "DSL is a non-executable dry-run because one or more required Page Model evidence gaps remain."
  };
}

function buildStep(input: {
  id: string;
  action: string;
  evidenceItem: SelectedPageModelEvidence;
  runtimeResolvable: boolean;
  confidence: number;
  inputValue?: unknown;
  valueSource?: string;
  assertion?: Record<string, unknown>;
}): DslDraftStep {
  return {
    id: input.id,
    action: input.action,
    pageId: input.evidenceItem.pageId,
    elementRef: input.evidenceItem.kind === "element" ? input.evidenceItem.id : undefined,
    semanticName: input.evidenceItem.semanticName,
    semanticLocator: input.evidenceItem.semanticName,
    inputValue: input.inputValue,
    valueSource: input.valueSource,
    evidenceLevel: input.evidenceItem.status === "candidate" ? "weak_candidate" : "verified",
    sourceProposalId: input.evidenceItem.id,
    candidateStatus: input.evidenceItem.status === "candidate" ? "candidate" : "verified",
    runtimeResolvable: input.runtimeResolvable,
    assertion: input.assertion,
    evidence: input.evidenceItem.evidence,
    aiConfidence: input.confidence
  };
}

function inferElementAction(selection: PageModelEvidenceSelection, element: SelectedPageModelEvidence): string {
  const name = `${element.semanticName ?? ""} ${element.id}`;
  if (/筛选|搜索|类型|币种|链|网络|地址|数量|金额|账户|验证码|赠币|USDT|BSC/.test(name)) {
    return selection.intent.operationType === "read" ? "filter" : "input";
  }
  if (/提交|提现|划转|充值|查询|重置|按钮|入口|button|clickable/i.test(name)) return "click";
  if (/列表|表格|记录|流水|row|table/i.test(name)) return "inspect";
  return selection.intent.operationType === "read" ? "inspect" : "interact";
}

function valueForElement(selection: PageModelEvidenceSelection, element: SelectedPageModelEvidence): unknown {
  const name = `${element.semanticName ?? ""} ${element.id}`;
  if (/赠币|类型/.test(name)) return selection.intent.data.type;
  if (/币种|USDT/.test(name)) return selection.intent.data.asset;
  if (/链|网络|BSC/.test(name)) return selection.intent.data.network;
  if (/地址/.test(name)) return selection.intent.data.address;
  if (/数量|金额/.test(name)) return selection.intent.data.amountPolicy === "empty" ? "" : selection.intent.data.amount ?? selection.intent.data.amountPolicy;
  if (/现货|转出/.test(name)) return selection.intent.data.fromAccount;
  if (/合约|转入/.test(name)) return selection.intent.data.toAccount;
  return undefined;
}

function valueSourceForElement(selection: PageModelEvidenceSelection, element: SelectedPageModelEvidence): string | undefined {
  const name = `${element.semanticName ?? ""} ${element.id}`;
  if (/赠币|类型/.test(name)) return "intent.data.type";
  if (/币种|USDT/.test(name)) return "intent.data.asset";
  if (/链|网络|BSC/.test(name)) return "intent.data.network";
  if (/地址/.test(name)) return "intent.data.address";
  if (/数量|金额/.test(name)) return selection.intent.data.amount === undefined ? "intent.data.amountPolicy" : "intent.data.amount";
  if (/现货|转出/.test(name)) return "intent.data.fromAccount";
  if (/合约|转入/.test(name)) return "intent.data.toAccount";
  return undefined;
}

function providerDependenciesForSelection(selection: PageModelEvidenceSelection): string[] {
  if (selection.intent.module !== "withdraw") return [];
  return ["redis.email_code", "keepassxc.totp"];
}

function safeId(value: string): string {
  return value.replace(/[^a-z0-9_-]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();
}
