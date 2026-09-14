/**
 * P8.21/P8.22：Field Mapping + Required/Validation Modeling。
 *
 * P8.21：targetField 不靠 element text 随便推。优先 name/id/autocomplete/label-for/form control name/
 * placeholder/Operation Manual，再 fallback semanticName。LOW confidence 不进入自动 DSL evidence。
 *
 * P8.22：通用采集 required/aria-required/min/max/minLength/maxLength/pattern/step/readonly/disabled
 * 变成结构 metadata（DOM_FIELD_CONSTRAINT）。绝不把 min=10 自动解释成业务规则"最低提现 10"——
 * 业务规则仍走 REVIEW。
 *
 * 铁律：deterministic；不引入业务推断；不写页面特例。
 */

export interface FieldMetadataInput {
  name?: string;
  id?: string;
  autocomplete?: string;
  placeholder?: string;
  labelText?: string;
  semanticName?: string;
  tag?: string;
  type?: string;
  /** DOM 约束（原样记录）。 */
  constraints?: {
    required?: boolean;
    ariaRequired?: boolean;
    min?: number | string;
    max?: number | string;
    minLength?: number;
    maxLength?: number;
    pattern?: string;
    step?: number | string;
    readonly?: boolean;
    disabled?: boolean;
  };
}

export interface FieldMetadata {
  targetField?: string;
  targetFieldConfidence: "HIGH" | "MEDIUM" | "LOW";
  targetFieldSources: string[];
  /** DOM_FIELD_CONSTRAINT（不是业务规则）。 */
  domConstraints: Array<{ type: string; value?: string; source: string }>;
  /** 该字段是否 required（DOM 级）。 */
  required: boolean;
  /** 是否 readonly / disabled（DOM 级）。 */
  readonly: boolean;
  disabled: boolean;
}

/** targetField 推断源优先级。 */
export function inferTargetField(input: FieldMetadataInput): { targetField?: string; confidence: "HIGH" | "MEDIUM" | "LOW"; sources: string[] } {
  const sources: string[] = [];
  const push = (field: string | undefined, source: string, conf: "HIGH" | "MEDIUM" | "LOW") => {
    if (field && field.trim()) { sources.push(source); return { field: field.trim(), conf }; }
    return undefined;
  };

  const candidates: Array<{ field?: string; conf: "HIGH" | "MEDIUM" | "LOW"; source: string }> = [
    { field: input.name, conf: "HIGH", source: "name" },
    { field: input.id, conf: "HIGH", source: "id" },
    { field: input.autocomplete, conf: "HIGH", source: "autocomplete" },
    { field: input.labelText, conf: "MEDIUM", source: "label_for" },
    { field: input.placeholder, conf: "MEDIUM", source: "placeholder" },
    { field: input.semanticName, conf: "LOW", source: "semanticName_fallback" }
  ];

  for (const c of candidates) {
    if (c.field && c.field.trim()) {
      sources.push(c.source);
      return { targetField: c.field.trim(), confidence: c.conf, sources };
    }
  }
  return { confidence: "LOW", sources };
}

/** P8.22：DOM 约束 → 结构化 metadata（业务规则解释由 REVIEW 负责，不在这里做）。 */
export function buildFieldMetadata(input: FieldMetadataInput): FieldMetadata {
  const tf = inferTargetField(input);
  const constraints = input.constraints ?? {};
  const domConstraints: FieldMetadata["domConstraints"] = [];

  if (constraints.required) domConstraints.push({ type: "required", source: "dom" });
  if (constraints.ariaRequired) domConstraints.push({ type: "aria-required", source: "dom" });
  if (constraints.min !== undefined) domConstraints.push({ type: "min", value: String(constraints.min), source: "dom" });
  if (constraints.max !== undefined) domConstraints.push({ type: "max", value: String(constraints.max), source: "dom" });
  if (constraints.minLength !== undefined) domConstraints.push({ type: "minLength", value: String(constraints.minLength), source: "dom" });
  if (constraints.maxLength !== undefined) domConstraints.push({ type: "maxLength", value: String(constraints.maxLength), source: "dom" });
  if (constraints.pattern) domConstraints.push({ type: "pattern", value: constraints.pattern, source: "dom" });
  if (constraints.step !== undefined) domConstraints.push({ type: "step", value: String(constraints.step), source: "dom" });
  if (constraints.readonly) domConstraints.push({ type: "readonly", source: "dom" });
  if (constraints.disabled) domConstraints.push({ type: "disabled", source: "dom" });

  return {
    targetField: tf.targetField,
    targetFieldConfidence: tf.confidence,
    targetFieldSources: tf.sources,
    domConstraints,
    required: Boolean(constraints.required || constraints.ariaRequired),
    readonly: Boolean(constraints.readonly),
    disabled: Boolean(constraints.disabled)
  };
}

/** 业务规则是否被自动推断（必须为 false——业务规则永远 REVIEW）。 */
export function wouldAutoInferBusinessRule(constraints: FieldMetadata["domConstraints"]): boolean {
  // min/max/pattern 只记录为 DOM_FIELD_CONSTRAINT，不代表业务规则
  return constraints.some((c) => c.type === "business_rule");
}
