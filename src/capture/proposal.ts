import type {
  CaptureAuthContext,
  CaptureEvidence,
  CaptureRunConfig,
  CaptureTargetResult
} from "./types.js";
import { confidenceForElement, evidenceRefs, inferActionStatus, locatorCandidatesFromInventory, sourceArtifacts } from "./evidence.js";
import { maskAccount } from "./auth.js";

export function buildProposal(
  config: CaptureRunConfig,
  auth: CaptureAuthContext,
  captures: CaptureTargetResult[],
  artifactDirRelative: string
): Record<string, unknown> {
  const pageModels = captures.map(({ target, capture }) => ({
    proposalId: `${config.runId}_page_${target.id}`,
    type: "PageModelProposal",
    pageId: target.pageId,
    pageName: target.label,
    project: config.project,
    platform: config.platform,
    locale: config.locale,
    module: target.module,
    action: target.action,
    url: capture.url,
    title: capture.title,
    pageType: capture.pageType,
    status: capture.status,
    confidence: capture.confidence,
    expectedCapability: target.expectedCapability,
    regions: inferRegions(capture),
    dialogs: capture.inventory.dialogs,
    iframes: capture.inventory.iframes,
    sourceArtifacts: sourceArtifacts(capture)
  }));
  const navigationEdges = captures.map(({ target, capture, before, actionResult }) => ({
    proposalId: `${config.runId}_edge_${target.id}`,
    type: "NavigationEdgeProposal",
    fromPageId: target.kind === "direct_page" ? "external.direct_url" : config.entryPageId,
    toPageId: target.pageId,
    entryName: target.label,
    action: target.kind === "direct_page" ? "navigate" : "click",
    status: target.kind === "direct_page" ? "dom_verified" : inferActionStatus(actionResult),
    riskLevel: target.riskLevel,
    urlChanged: before ? before.url !== capture.url : undefined,
    stateChanged: before ? before.visibleTextHash !== capture.visibleTextHash || before.domHash !== capture.domHash : undefined,
    locatorCandidate: target.entryText ? { strategy: "text", value: target.entryText, source: "visible_text", confidence: actionResult?.status === "clicked" ? 0.7 : 0.4 } : undefined,
    actionResult,
    evidence: evidenceRefs(capture)
  }));
  const elementInventories = captures.flatMap(({ target, capture }) => buildElementInventory(config, target, capture));
  const assertionModels = captures.flatMap(({ target, capture }) => buildAssertionModels(config, target, capture));
  const actionResults = captures.filter((item) => item.actionResult).map(({ target, capture, before, actionResult }) => ({
    proposalId: `${config.runId}_action_${target.id}`,
    type: "ActionResultProposal",
    pageId: before?.pageId ?? config.entryPageId,
    targetPageId: target.pageId,
    action: "click",
    targetText: target.entryText,
    resultStatus: inferActionStatus(actionResult),
    beforeUrl: before?.url,
    afterUrl: capture.url,
    urlChanged: before ? before.url !== capture.url : false,
    stateChanged: before ? before.visibleTextHash !== capture.visibleTextHash || before.domHash !== capture.domHash : false,
    modalOrDrawerDetected: capture.inventory.dialogs.length > 0,
    evidence: evidenceRefs(capture)
  }));
  const dataBindingCandidates = captures.flatMap(({ target, capture }) => buildDataBindingCandidates(config, target, capture));
  const preconditions = captures.flatMap(({ target, capture }) => buildPreconditions(config, target, capture));
  const blockPackages = captures.map((item) => item.block).filter(Boolean);
  return {
    schemaVersion: config.schemaVersion,
    generatedAt: new Date().toISOString(),
    runId: config.runId,
    reportTitle: config.reportTitle,
    project: config.project,
    env: config.env,
    platform: config.platform,
    locale: config.locale,
    entryUrl: config.entryUrl,
    boundaries: {
      wroteMainKnowledge: false,
      upgradedVerified: false,
      generatedDsl: false,
      executedAcceptanceProbes: false,
      submittedFundsOperation: false,
      fullExplorationAllowedForTestUat: true
    },
    auth: {
      bypassLoginAttempted: Boolean(auth.bypassLogin?.enabled),
      accountMasked: maskAccount(String(auth.account?.username ?? ""))
    },
    scanConfig: {
      actualTargets: config.targets.length
    },
    artifactDir: artifactDirRelative,
    summary: {
      scannedTargets: captures.length,
      pageModelProposals: pageModels.length,
      navigationEdgeProposals: navigationEdges.length,
      elementInventoryProposals: elementInventories.length,
      assertionModelProposals: assertionModels.length,
      actionResultProposals: actionResults.length,
      dataBindingCandidateProposals: dataBindingCandidates.length,
      preconditionProposals: preconditions.length,
      blockPackages: blockPackages.length
    },
    captures: captures.map(({ target, capture, actionResult, block }) => ({
      id: target.id,
      pageId: target.pageId,
      label: target.label,
      url: capture.url,
      title: capture.title,
      status: capture.status,
      confidence: capture.confidence,
      pageType: capture.pageType,
      counts: {
        clickables: capture.inventory.clickables.length,
        fields: capture.inventory.fields.length,
        buttons: capture.inventory.buttons.length,
        tables: capture.inventory.tables.length,
        dialogs: capture.inventory.dialogs.length,
        iframes: capture.inventory.iframes.length
      },
      signalScore: capture.signals.score,
      actionResult,
      blockId: block?.blockId,
      artifacts: sourceArtifacts(capture)
    })),
    proposals: {
      pageModels,
      navigationEdges,
      elementInventories,
      assertionModels,
      actionResults,
      dataBindingCandidates,
      preconditions,
      blockPackages
    },
    coverageProbes: buildCoverageProbeStatus(config, captures),
    nextStageRecommendation: config.nextStage ?? {
      recommended: true,
      stage: "Page Model proposal review / selective knowledge write",
      reason: "Capture run has produced reusable page-model proposals and evidence artifacts without writing verified knowledge."
    }
  };
}

function inferRegions(capture: CaptureEvidence): Array<Record<string, unknown>> {
  const regions: Array<Record<string, unknown>> = [];
  for (const group of capture.signals.groups) {
    if (group.matched.length) regions.push({ name: `${group.name}相关区域`, confidence: 0.55, evidence: group.matched.slice(0, 8) });
  }
  if (capture.inventory.fields.length) regions.push({ name: "表单或筛选区域", confidence: 0.55, fieldCount: capture.inventory.fields.length });
  if (capture.inventory.tables.length) regions.push({ name: "列表或表格区域", confidence: 0.55, tableCount: capture.inventory.tables.length });
  if (capture.inventory.dialogs.length) regions.push({ name: "弹窗/抽屉区域", confidence: 0.5, dialogCount: capture.inventory.dialogs.length });
  return regions;
}

function buildElementInventory(config: CaptureRunConfig, target: CaptureTargetResult["target"], capture: CaptureEvidence): Array<Record<string, unknown>> {
  const records: Array<Record<string, unknown>> = [];
  for (const [index, item] of capture.inventory.clickables.slice(0, 40).entries()) {
    records.push({
      proposalId: `${config.runId}_element_${target.id}_clickable_${index}`,
      type: "ElementInventoryProposal",
      pageId: target.pageId,
      semanticName: String(item.text ?? item.ariaLabel ?? item.placeholder ?? `${target.label} clickable ${index + 1}`),
      role: String(item.role ?? item.tag ?? "clickable"),
      locatorCandidates: locatorCandidatesFromInventory(item),
      status: "dom_verified",
      confidence: confidenceForElement(item),
      evidence: evidenceRefs(capture)
    });
  }
  for (const [index, item] of capture.inventory.fields.slice(0, 25).entries()) {
    records.push({
      proposalId: `${config.runId}_element_${target.id}_field_${index}`,
      type: "ElementInventoryProposal",
      pageId: target.pageId,
      semanticName: String(item.label ?? item.placeholder ?? item.ariaLabel ?? item.name ?? `${target.label} field ${index + 1}`),
      role: String(item.role ?? item.tag ?? "field"),
      locatorCandidates: locatorCandidatesFromInventory(item),
      status: "dom_verified",
      confidence: confidenceForElement(item),
      evidence: evidenceRefs(capture)
    });
  }
  for (const [index, item] of capture.inventory.tables.slice(0, 10).entries()) {
    records.push({
      proposalId: `${config.runId}_element_${target.id}_table_${index}`,
      type: "ElementInventoryProposal",
      pageId: target.pageId,
      semanticName: `${target.label}列表或表格 ${index + 1}`,
      role: "table_or_list",
      rowCount: item.rowCount,
      locatorCandidates: [{ strategy: "text_signature", value: item.text, confidence: 0.45, source: "dom" }],
      status: "dom_verified",
      confidence: 0.5,
      evidence: evidenceRefs(capture)
    });
  }
  return records;
}

function buildAssertionModels(config: CaptureRunConfig, target: CaptureTargetResult["target"], capture: CaptureEvidence): Array<Record<string, unknown>> {
  const successCandidates: Array<Record<string, unknown>> = [];
  for (const group of capture.signals.groups) {
    if (group.role !== "success" || !group.matched.length) continue;
    successCandidates.push({ type: "visible_text_any", expected: group.matched.slice(0, 8), meaning: `${group.name}_visible`, confidence: 0.55 });
  }
  const failureCandidates = capture.signals.blockTerms.length
    ? [{ type: "visible_text_any", expected: capture.signals.blockTerms, meaning: "blocked_by_precondition_or_validation", confidence: 0.6 }]
    : [];
  return [
    {
      proposalId: `${config.runId}_assertion_${target.id}_success`,
      type: "AssertionModelProposal",
      pageId: target.pageId,
      module: target.module,
      action: target.action,
      assertionKind: "success_or_page_state",
      candidates: successCandidates,
      status: successCandidates.length ? "candidate" : "blocked",
      evidence: evidenceRefs(capture)
    },
    {
      proposalId: `${config.runId}_assertion_${target.id}_failure`,
      type: "AssertionModelProposal",
      pageId: target.pageId,
      module: target.module,
      action: target.action,
      assertionKind: "failure_or_block_state",
      candidates: failureCandidates,
      status: "candidate",
      evidence: evidenceRefs(capture)
    }
  ];
}

function buildDataBindingCandidates(config: CaptureRunConfig, target: CaptureTargetResult["target"], capture: CaptureEvidence): Array<Record<string, unknown>> {
  const text = [target.label, capture.visibleTextSample.join("\n"), JSON.stringify(capture.inventory.fields)].join("\n");
  const bindings: Array<Record<string, unknown>> = [];
  for (const item of config.dataBindingRules) {
    if (!text.includes(item.term)) continue;
    bindings.push({
      proposalId: `${config.runId}_binding_${target.id}_${item.targetField}`,
      type: "DataBindingCandidateProposal",
      pageId: target.pageId,
      module: target.module,
      action: target.action,
      semanticName: item.term,
      targetField: item.targetField,
      valueType: item.valueType,
      valueSource: item.sourcePath,
      status: "candidate",
      confidence: 0.48,
      evidence: evidenceRefs(capture)
    });
  }
  return bindings;
}

function buildPreconditions(config: CaptureRunConfig, target: CaptureTargetResult["target"], capture: CaptureEvidence): Array<Record<string, unknown>> {
  const all = [target.expectedCapability, capture.visibleTextSample.join("\n"), JSON.stringify(capture.signals)].join("\n");
  const preconditions = new Set<string>();
  for (const rule of config.preconditionRules) {
    if (new RegExp(rule.pattern, "i").test(all)) preconditions.add(rule.name);
  }
  return [...preconditions].map((name) => ({
    proposalId: `${config.runId}_precondition_${target.id}_${name}`,
    type: "PreconditionProposal",
    pageId: target.pageId,
    module: target.module,
    action: target.action,
    preconditionType: name,
    status: "candidate",
    evidence: evidenceRefs(capture)
  }));
}

export function buildBlockIfNeeded(
  config: CaptureRunConfig,
  target: CaptureTargetResult["target"],
  capture: CaptureEvidence,
  actionResult?: Record<string, unknown>
): Record<string, unknown> | undefined {
  if (actionResult?.status && actionResult.status !== "clicked") {
    return {
      blockId: `${config.runId}_block_${target.id}_entry`,
      pageId: target.pageId,
      pageUrl: capture.url,
      blockType: "entry_not_found_or_not_clickable",
      screenshot: capture.screenshotPath,
      dom: capture.domPath,
      visibleText: capture.visibleTextPath,
      failedAction: actionResult,
      requiredHumanAction: `确认 ${target.label} 入口在当前账号、语言和页面状态下是否可见，或提供人工进入后的页面。`,
      resumePoint: { url: config.entryUrl, pageId: config.entryPageId, targetText: target.entryText },
      suggestedNextAction: "人工确认入口或在下一轮扫描中从当前页面继续。"
    };
  }
  if (!capture.signals.blockTerms.length) return undefined;
  return {
    blockId: `${config.runId}_block_${target.id}_precondition`,
    pageId: target.pageId,
    pageUrl: capture.url,
    blockType: "blocked_by_precondition",
    screenshot: capture.screenshotPath,
    dom: capture.domPath,
    visibleText: capture.visibleTextPath,
    failedAction: actionResult,
    requiredHumanAction: `准备或确认 ${target.label} 所需的账号状态、验证码、KYC、余额、地址白名单、权限、风控或环境数据。`,
    resumePoint: { url: capture.url, pageId: target.pageId },
    suggestedNextAction: "前置条件满足后从该页面继续建模或执行验证。"
  };
}

function buildCoverageProbeStatus(config: CaptureRunConfig, captures: CaptureTargetResult[]): Record<string, unknown> {
  const probes = config.coverageProbes ?? [];
  const status: Record<string, unknown> = {};
  for (const probe of probes) {
    const has = (id: string): boolean => captures.some((item) => item.target.id === id && item.capture.status !== "blocked");
    const artifacts = probe.requiresTargetIds
      .map((id) => captures.find((item) => item.target.id === id)?.capture)
      .filter(Boolean)
      .map((capture) => sourceArtifacts(capture as CaptureEvidence));
    status[probe.key] = {
      purpose: probe.purpose,
      coverage: probe.requiresTargetIds.every(has) ? "partial" : "missing",
      coveredModels: probe.requiresTargetIds.filter(has),
      gaps: probe.gaps,
      relatedArtifacts: artifacts
    };
  }
  return status;
}

export function renderReport(proposal: Record<string, unknown>): string {
  const summary = proposal.summary as Record<string, number>;
  const proposals = proposal.proposals as Record<string, Array<Record<string, unknown>>>;
  const lines: string[] = [
    `# ${String(proposal.reportTitle ?? `${proposal.runId} 建模扫描执行报告`)}`,
    "",
    "## 边界",
    "",
    `- 扫描入口: \`${String(proposal.entryUrl)}\``,
    `- 环境: ${String(proposal.project)} ${String(proposal.env)}`,
    "- 是否启动浏览器: yes",
    "- 是否生成最终 DSL: no",
    "- 是否写主知识库: no",
    "- 是否升级 verified: no",
    `- artifacts: \`${String(proposal.artifactDir)}\``,
    "",
    "## 扫描摘要",
    "",
    `- 扫描目标: ${summary.scannedTargets}`,
    `- PageModel proposal: ${summary.pageModelProposals}`,
    `- NavigationEdge proposal: ${summary.navigationEdgeProposals}`,
    `- ElementInventory proposal: ${summary.elementInventoryProposals}`,
    `- AssertionModel proposal: ${summary.assertionModelProposals}`,
    `- ActionResult proposal: ${summary.actionResultProposals}`,
    `- DataBindingCandidate proposal: ${summary.dataBindingCandidateProposals}`,
    `- Precondition proposal: ${summary.preconditionProposals}`,
    `- BlockPackage: ${summary.blockPackages}`,
    "",
    "## 页面模型 proposal 摘要",
    ""
  ];
  for (const item of proposals.pageModels) {
    lines.push(`- ${item.pageName}: pageId=\`${item.pageId}\`, module=${item.module}, action=${item.action}, status=${item.status}, confidence=${item.confidence}, pageType=${item.pageType}`);
  }
  lines.push("", "## 阻塞包摘要", "");
  if (proposals.blockPackages.length) {
    for (const item of proposals.blockPackages) {
      lines.push(`- ${item.blockId}: ${item.blockType}, pageId=\`${item.pageId}\`, suggestedNextAction=${item.suggestedNextAction}`);
    }
  } else {
    lines.push("- 本次扫描未生成 BlockPackage。");
  }
  const coverageProbes = (proposal.coverageProbes ?? {}) as Record<string, Record<string, unknown>>;
  if (Object.keys(coverageProbes).length) {
    lines.push("", "## coverage probe 覆盖情况", "");
    for (const [key, value] of Object.entries(coverageProbes)) {
      const coveredModels = Array.isArray(value.coveredModels) ? (value.coveredModels as string[]).join(", ") : "none";
      const gaps = Array.isArray(value.gaps) ? (value.gaps as string[]).join(" / ") : "none";
      lines.push(`- ${key}: coverage=${String(value.coverage)}, coveredModels=${coveredModels || "none"}, gaps=${gaps || "none"}`);
    }
  }
  lines.push("", "## 说明", "");
  lines.push("报告正文不嵌入页面原始大段文本；DOM、可见文本、截图和可访问性快照均以 artifact 路径引用。本产物只作为 proposal，入库前仍需 schema validation 和人工评审。");
  return `${lines.join("\n")}\n`;
}

