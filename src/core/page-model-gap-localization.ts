export function localizePageModelGap(gap: string): string {
  const raw = String(gap);
  if (raw.startsWith("user_assertion_not_understood:")) {
    return `\u7528\u6237\u5199\u4e86\u65ad\u8a00\uff0c\u4f46\u5e73\u53f0\u6ca1\u6709\u6210\u529f\u7406\u89e3\u548c\u7269\u5316\u8be5\u65ad\u8a00\uff1a${raw.split(":").slice(1).join(":")}`;
  }
  if (raw === "provider_verification_step_not_materialized") {
    return "需要完成验证码/安全验证，但当前 DSL 没有生成发送验证码、输入 GA/TOTP、输入邮箱/短信验证码或确认验证步骤。";
  }
  if (raw === "write_success_assertion_not_materialized") {
    return "这是写操作并期望成功，但当前 DSL 没有生成成功断言，例如成功提示、列表新增、接口成功或弹窗关闭。";
  }
  if (raw.startsWith("provider_component_candidate_not_executable:")) {
    return `验证码/安全验证组件仍是候选建模，不能进入执行：${raw.split(":").slice(1).join(":")}`;
  }
  if (raw.startsWith("provider_component_missing_executable_locator:")) {
    return `验证码/安全验证组件缺少真实可执行定位，不能使用占位文本执行：${raw.split(":").slice(1).join(":")}`;
  }
  if (raw === "missing_page_model_store") return "当前项目还没有 Page Model Store，需要先建模。";
  if (raw === "operation_manual_store_missing") return "当前项目还没有 Operation Manual Store，需要先补充页面操作手册。";
  if (raw === "operation_manual_not_found_for_intent") return "没有找到匹配当前意图的页面操作手册。";
  if (raw === "operation_manual_capability_not_found_for_intent") return "页面操作手册中没有找到匹配当前操作的 capability。";
  if (raw === "operation_manual_provider_flow_missing") return "操作手册声明了验证流程，但没有找到对应 Provider Flow 定义。";
  if (raw === "operation_manual_success_policy_missing") return "操作手册声明了成功判断策略，但没有找到对应 Success Evidence Policy。";
  if (raw.startsWith("dropdown_component_missing_option_discovery:")) {
    return `下拉框缺少选项采集方式，无法确认如何选择：${raw.split(":").slice(1).join(":")}`;
  }
  if (raw.startsWith("dropdown_component_option_not_modeled:")) {
    const parts = raw.split(":");
    return `下拉框没有建模目标选项：元素 ${parts[1] ?? "未知"}，期望值 ${parts.slice(2).join(":") || "未知"}`;
  }
  if (raw.startsWith("dropdown_component_target_option_not_verified:")) {
    const parts = raw.split(":");
    return `下拉框目标选项尚未完成可执行验证，需要补采建模：元素 ${parts[1] ?? "未知"}，期望值 ${parts.slice(2).join(":") || "未知"}`;
  }
  if (raw.startsWith("dropdown_component_missing_selected_value_signal:")) {
    return `下拉框缺少选中值回显/持久化信号，无法证明选择已成功：${raw.split(":").slice(1).join(":")}`;
  }
  if (raw.startsWith("plan_page_boundary_violation:")) {
    return `计划包含了目标页面外的步骤，已阻断：${raw.split(":").slice(1).join(":")}`;
  }
  if (raw.startsWith("plan_operation_boundary_violation:")) {
    return `读操作计划中混入了提交/确认等写操作，已阻断：${raw.split(":").slice(1).join(":")}`;
  }
  if (raw.startsWith("intent_arbitration_conflict:")) {
    return `生成内容可信度校验发现历史兼容冲突 gap：${raw.split(":").slice(1).join(":")}。本地不应继续扩展意图仲裁规则。`;
  }
  if (raw === "intent_contract_page_missing") return "生成内容可信度校验未找到目标页面证据。";
  if (raw.startsWith("intent_contract_required_data_missing:")) return `生成内容可信度校验发现必填数据缺失：${raw.split(":").slice(1).join(":")}`;
  if (raw.startsWith("intent_contract_provider_flow_missing:")) return `生成内容可信度校验发现 provider flow 未落库：${raw.split(":").slice(1).join(":")}`;
  if (raw.startsWith("intent_contract_assertion_type_unsupported:")) return `生成内容可信度校验发现断言类型暂不受支持：${raw.split(":").slice(1).join(":")}`;
  if (raw.startsWith("intent_contract_success_policy_missing:")) return `生成内容可信度校验警告：成功证据策略未落库：${raw.split(":").slice(1).join(":")}`;
  if (raw === "intent_contract_operation_type_mismatch") return "生成内容可信度校验警告：操作类型与能力声明存在边界差异，但不阻断已物化 DSL。";
  if (raw === "intent_contract_capability_missing") return "生成内容可信度校验警告：操作手册缺少匹配 capability，但 Page Model 已提供可物化证据。";
  if (raw.startsWith("raw_scan_evidence_not_executable:")) {
    return `计划使用了原始扫描候选证据，尚未达到执行级建模标准：${raw.split(":").slice(1).join(":")}`;
  }
  if (/fund_flow_.*_option:/.test(raw)) return `资金流水筛选缺少目标下拉选项建模：${raw}`;
  if (/fund_flow_result_assertion/.test(raw)) return "资金流水页面缺少结果列表/空状态断言能力。";
  return `未本地化的平台缺口：${raw}`;
}

export function localizePageModelGaps(gaps: string[]): string[] {
  return [...new Set(gaps.map(localizePageModelGap))];
}

export function formatLocalizedPageModelGaps(gaps: string[]): string {
  return localizePageModelGaps(gaps).join("；");
}
