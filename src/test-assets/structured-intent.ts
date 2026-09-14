/**
 * P13-A1：StructuredExecutionIntent（provider-neutral，正式 planner 输入）。
 *
 * 不把 TestAsset → deepSeekIntent 形成永久耦合；兼容层负责转换。
 */

export interface StructuredExecutionIntent {
  project: string;
  module: string;
  action: string;
  operationType: "read" | "write" | "unknown";
  capabilities: string[];
  entities: string[];
  data: Record<string, unknown>;
  semanticActions: Array<{ action: string; target: string; value?: string; sourceActionId?: string }>;
  expectedOutcomes: Array<{ statement: string; sourceOutcomeId?: string; groundingKind?: string; groundingRef?: string }>;
  preconditions: Array<{ statement: string }>;
  source: {
    type: "TEST_ASSET";
    testAssetId: string;
    testAssetVersion: string;
  };
}

/** 兼容层：StructuredExecutionIntent → legacy deepSeekIntent（仅作为 planner 兼容入口）。 */
export function structuredIntentToLegacy(intent: StructuredExecutionIntent): Record<string, unknown> {
  return {
    project: intent.project,
    module: intent.module,
    action: intent.action,
    operationType: intent.operationType,
    capabilities: intent.capabilities,
    entities: intent.entities,
    data: intent.data,
    source: intent.source
  };
}

/** A3：TestAsset source 标记——planner 不得把 request 当语义事实源。 */
export function structuredIntentFallbackRecord(intent: StructuredExecutionIntent, fallbackReason: string): { code: "STRUCTURED_INTENT_FALLBACK"; source: string; reason: string } {
  return { code: "STRUCTURED_INTENT_FALLBACK", source: `${intent.source.type}:${intent.source.testAssetId}@${intent.source.testAssetVersion}`, reason: fallbackReason };
}
