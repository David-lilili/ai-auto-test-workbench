import test from "node:test";
import assert from "node:assert/strict";
import type { BusinessFlow, DslStep, KnowledgeChunk, PageTransition } from "../src/core/types.js";
import {
  buildBusinessFlowCoverage,
  buildAiDiagnosticLogForFailure,
  classifyWriteActionEvidence,
  extractCoverageGaps,
  hasVerifiedAssetOverviewEvidence,
  isWeakLayeredEvidence,
  layerEvidenceMetadata,
  rerankKnowledgeHitsForIntent
} from "../src/core/assistant-planning-support.js";

test("reranks red-packet create knowledge above claim knowledge", () => {
  const hits = [
    knowledge("claim-flow", "领取口令红包 claim red packet passphrase", 0.99, "business_flow"),
    knowledge("create-flow", "Demo create_red_packet 创建红包 发红包 red packet create", 0.8, "business_flow"),
    knowledge("page", "红包页面 assets/red-packet", 0.9, "page_graph")
  ];

  const result = rerankKnowledgeHitsForIntent(hits, { module: "red-packet", action: "create" }, "创建 TON 红包", 3);

  assert.equal(result.hits[0].title, "create-flow");
  const claimAudit = result.audit.find((item) => item.matchedKnowledgeId.startsWith("business_flow:claim-flow"));
  assert.match(claimAudit?.rerankReason ?? "", /demote:claim_receive/);
  const createAudit = result.audit.find((item) => item.matchedKnowledgeId.startsWith("business_flow:create-flow"));
  assert.match(createAudit?.rerankReason ?? "", /boost:red_packet_create/);
});

test("demotes red-packet knowledge for asset record read intent", () => {
  const hits = [
    knowledge("claim-red-packet", "领取口令红包 claim red packet passphrase assets/red-packet", 0.99, "manual_note"),
    knowledge("create-red-packet", "创建红包 create red packet assets/red-packet", 0.95, "manual_note"),
    knowledge("asset-record", "资产记录 钱包记录 财务记录 asset record wallet history USDT filter", 0.65, "manual_note")
  ];

  const result = rerankKnowledgeHitsForIntent(hits, { module: "asset", action: "record", operationType: "read" }, "资产记录 USDT", 3);

  assert.equal(result.hits[0].title, "asset-record");
  assert.ok(result.hits.every((hit) => !/red-packet|红包/.test(hit.content)));
  const redPacketAudit = result.audit.find((item) => item.matchedKnowledgeId.startsWith("manual_note:claim-red-packet"));
  assert.match(redPacketAudit?.rerankReason ?? "", /demote:module_mismatch:red_packet_for_asset_record/);
  assert.equal(redPacketAudit?.included, false);
  const assetAudit = result.audit.find((item) => item.matchedKnowledgeId.startsWith("manual_note:asset-record"));
  assert.match(assetAudit?.rerankReason ?? "", /boost:asset_wallet_record/);
  assert.equal(assetAudit?.included, true);
});

test("keeps verified page evidence separate from nested candidate entry", () => {
  const pageState = {
    page_id: "demo.asset.total_assets",
    status: "dom_verified",
    knowledge_status: "dom_verified",
    sourceProposalId: "asset_center_minimal_verified_overview_20260717",
    candidate: {
      status: "candidate",
      targetPageStatus: "unverified",
      retrievalWeight: "weak",
      sourceProposalId: "g1_6_asset_record_candidate_fund_flow"
    }
  };

  const pageEvidence = layerEvidenceMetadata(pageState, "self");
  const childCandidate = layerEvidenceMetadata(pageState, "nestedCandidate");

  assert.equal(pageEvidence.evidenceLevel, "verified");
  assert.equal(pageEvidence.targetPageStatus, "verified");
  assert.equal(pageEvidence.sourceProposalId, "asset_center_minimal_verified_overview_20260717");
  assert.equal(isWeakLayeredEvidence(pageEvidence), false);
  assert.equal(childCandidate.evidenceLevel, "weak_candidate");
  assert.equal(childCandidate.sourceProposalId, "g1_6_asset_record_candidate_fund_flow");
  assert.equal(isWeakLayeredEvidence(childCandidate), true);
});

test("verified asset overview page and USDT row are enough for overview planning readiness", () => {
  const ready = hasVerifiedAssetOverviewEvidence({
    pageCandidates: [
      {
        evidenceLevel: "verified",
        targetPageStatus: "verified",
        sourceProposalId: "asset_center_minimal_verified_overview_20260717"
      }
    ],
    elementCandidates: [
      {
        text: "USDT",
        selector: "text=USDT",
        evidenceLevel: "verified",
        targetPageStatus: "verified",
        sourceProposalId: "asset_center_minimal_verified_overview_20260717"
      }
    ]
  });

  assert.equal(ready, true);
});

test("asset record weak candidate remains weak and does not become overview verified evidence", () => {
  const candidate = layerEvidenceMetadata(
    {
      candidate: {
        status: "candidate",
        retrievalWeight: "weak",
        targetPageStatus: "unverified",
        sourceProposalId: "g1_6_asset_record_candidate_fund_flow"
      }
    },
    "nestedCandidate"
  );

  assert.equal(candidate.evidenceLevel, "weak_candidate");
  assert.equal(isWeakLayeredEvidence(candidate), true);
});

test("business-flow DSL steps count as write action locator evidence", () => {
  const steps: DslStep[] = [
    { id: "click-create", action: "click", semantic_target: "创建红包", primary_locator: "role=button:创建红包" },
    { id: "input-amount", action: "input", semantic_target: "金额", primary_locator: "input >> nth=0", value: "10" },
    { id: "submit", action: "click", semantic_target: "确认创建", primary_locator: "role=button:确认" }
  ];

  const evidence = classifyWriteActionEvidence(steps);

  assert.equal(evidence.status, "covered");
  assert.equal(evidence.locatorLevel, "exact_selector");
  assert.equal(evidence.source, "business_flow");
});

test("semantic-only business-flow DSL is runtime resolvable instead of missing", () => {
  const evidence = classifyWriteActionEvidence([{ id: "submit", action: "click", semantic_target: "确认创建" }]);

  assert.equal(evidence.status, "runtime_resolvable");
  assert.equal(evidence.locatorLevel, "semantic_locator");
});

test("business-flow coverage extracts declared balance preflight", () => {
  const flow: BusinessFlow = {
    flow_id: "demo_test_create_red_packet",
    project_id: "demo",
    env: "test",
    platform: "web",
    name: "创建红包",
    target_flows: ["create red packet", "red packet create", "创建红包"],
    start_page_id: "red-packet",
    target_page_ids: ["red-packet"],
    transition_ids: ["t1"],
    dsl_case_ids: ["case1"],
    preconditions: ["asset.balance.TON >= 10"],
    risk_level: "medium",
    review_status: "approved",
    replay_status: "passed",
    promote_status: "promoted",
    confidence_score: 0.95,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  const transition: PageTransition = {
    transition_id: "t1",
    from_page_id: "red-packet",
    to_page_id: "verify",
    action_description: "创建红包",
    dsl_steps: [{ id: "submit", action: "click", semantic_target: "确认创建", primary_locator: "role=button:确认" }],
    success_count: 1,
    failure_count: 0,
    average_duration_ms: 1000,
    confidence_score: 0.9
  };

  const coverage = buildBusinessFlowCoverage([flow], [transition], { module: "red-packet", action: "create", operationType: "write" }, "demo", "test");

  assert.deepEqual(coverage.matchedFlowIds, ["demo_test_create_red_packet"]);
  assert.equal(coverage.evidence.find((item) => item.item === "write_action_locator")?.status, "covered");
  assert.equal(coverage.preflightChecks[0].status, "declared");
  assert.equal(coverage.preflightChecks[0].name, "asset.balance.TON");
});

test("extracts Page Model execution gaps into failure package coverage gaps", () => {
  const gaps = extractCoverageGaps({
    retrievalBundle: { gaps: ["legacy_gap"] },
    coverage: { uncoveredGoals: ["coverage_gap"] },
    pageModelExecutionPlan: {
      gaps: ["contract_fund_flow_type_filter_option:划转"],
      blockingGaps: ["contract_fund_flow_type_filter_option:划转"]
    }
  });

  assert.deepEqual(gaps, [
    "legacy_gap",
    "coverage_gap",
    "contract_fund_flow_type_filter_option:划转"
  ]);
});

test("builds AI diagnostic log from Page Model execution plan", () => {
  const log = buildAiDiagnosticLogForFailure({
    failureStage: "coverage",
    blockedStage: "coverage",
    readiness: "partial",
    automationReason: "Page boundary violation",
    plan: {
      intentSpec: { module: "asset", action: "contract_fund_flow_filter" },
      pageModelExecutionPlan: {
        readiness: "partial",
        executable: false,
        gaps: ["plan_page_boundary_violation:demo.funds.futures_account"],
        blockingGaps: ["plan_page_boundary_violation:demo.funds.futures_account"],
        evidenceBucketSummary: { targetPage: 1, navigation: 1, executableElements: 2, assertions: 1 },
        executionContract: {
          targetPageId: "demo.funds.contract_fund_flow",
          materializedPageIds: ["demo.funds.contract_fund_flow", "demo.funds.futures_account"],
          missingRoles: [],
          forbiddenEvidenceUsed: ["demo.funds.futures_account"]
        },
        selection: {
          intent: { module: "asset", action: "contract_fund_flow_filter", operationType: "read" },
          selectedEvidence: [
            { kind: "page", id: "demo.funds.contract_fund_flow", pageId: "demo.funds.contract_fund_flow", evidenceRole: "target_page", executionAllowed: true },
            { kind: "page", id: "demo.funds.futures_account", pageId: "demo.funds.futures_account", evidenceRole: "navigation", executionAllowed: true }
          ],
          fallbackEvidence: [],
          excludedEvidence: []
        },
        materialization: {
          executable: false,
          gaps: [],
          blockingGaps: [],
          excludedEvidenceUsed: [],
          temporarySelectorUsed: false,
          case: {
            steps: [
              { id: "open-contract", action: "navigate", pageModelId: "demo.funds.contract_fund_flow" },
              { id: "open-helper", action: "navigate", pageModelId: "demo.funds.futures_account" }
            ]
          }
        }
      }
    }
  });

  assert.equal(log.schemaVersion, "ai-diagnostic-log.v1");
  assert.deepEqual((log.pageModel as Record<string, any>).executionContract.forbiddenEvidenceUsed, ["demo.funds.futures_account"]);
  assert.deepEqual((log.materialization as Record<string, any>).steps.map((step: Record<string, unknown>) => step.pageModelId), [
    "demo.funds.contract_fund_flow",
    "demo.funds.futures_account"
  ]);
  assert.ok(((log.diagnosisHints as string[]) ?? []).includes("execution_contract_forbidden_evidence_used"));
});

function knowledge(title: string, content: string, confidence: number, sourceType: KnowledgeChunk["sourceType"]): KnowledgeChunk {
  return {
    chunkId: title,
    project: "demo",
    sourceType,
    sourceId: title,
    platform: "web",
    title,
    content,
    keywords: [],
    confidence,
    updatedAt: new Date().toISOString()
  };
}
