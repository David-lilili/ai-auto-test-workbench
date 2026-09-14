import fs from "fs-extra";
import { loadContext } from "../src/core/config-loader.js";
import {
  buildDslGenerationRuleDiff,
  buildDslGenerationRuleFromProposal,
  dataBindingProposalFromSidecar,
  DslGenerationRuleStore
} from "../src/core/dsl-generation-rule.js";
import type { FailureDiagnosisSidecar } from "../src/core/failure-diagnosis.js";
import { writeSafeJsonFile, writeSafeTextFile } from "../src/core/safe-file-writer.js";

interface CliOptions {
  proposal?: string;
  project?: string;
  dryRun?: boolean;
  confirmWrite?: boolean;
  out?: string;
  report?: string;
}

const options = parseArgs(process.argv.slice(2));
if (!options.proposal || !options.project) {
  console.error("Usage: npx tsx scripts/apply-dsl-generation-rule.ts --proposal <diagnosis-sidecar.json> --project <project> [--dry-run] [--confirm-write] [--out <json>] [--report <md>]");
  process.exit(2);
}
if (options.confirmWrite && options.dryRun) {
  console.error("--confirm-write and --dry-run are mutually exclusive.");
  process.exit(2);
}

const context = await loadContext({ project: options.project });
const sidecar = (await fs.readJson(options.proposal)) as FailureDiagnosisSidecar;
const proposal = dataBindingProposalFromSidecar(sidecar);
const rule = buildDslGenerationRuleFromProposal({
  project: options.project,
  sourceRunId: sidecar.diagnosis.sourceRunId,
  proposal
});
const diff = buildDslGenerationRuleDiff({ proposal, rule });
const store = new DslGenerationRuleStore(context);
let ruleFilePath = store.filePath;
let wroteRule = false;

if (options.confirmWrite) {
  ruleFilePath = await store.upsert(rule);
  wroteRule = true;
}

const result = {
  schemaVersion: "dsl-generation-rule-apply-result.v1",
  mode: options.confirmWrite ? "confirm_write" : "dry_run",
  sourceProposalPath: options.proposal,
  ruleFilePath,
  wroteRule,
  rule,
  diff,
  writePolicy: {
    requiresConfirmWrite: true,
    writesBusinessFlow: false,
    writesKnowledge: false,
    writesElementStore: false,
    startsBrowser: false,
    executesBusiness: false
  }
};

if (options.out) await writeSafeJsonFile(options.out, result);
if (options.report) await writeSafeTextFile(options.report, renderReport(result));
console.log(JSON.stringify({
  ruleFilePath,
  ruleId: rule.ruleId,
  wroteRule,
  before: diff.before,
  after: diff.after
}, null, 2));

function renderReport(input: typeof result): string {
  return [
    "# 阶段 2.5 DSL Generation Rule Dry-run 报告",
    "",
    "## 输入",
    "",
    `- proposal sidecar: \`${input.sourceProposalPath}\``,
    `- rule file: \`${input.ruleFilePath}\``,
    `- ruleId: \`${input.rule.ruleId}\``,
    `- confirm write: \`${input.wroteRule}\``,
    "",
    "## Dry-run Diff",
    "",
    "修复前：",
    "",
    "```json",
    JSON.stringify({
      semanticName: input.diff.semanticName,
      value: input.diff.before.value,
      valueSource: input.diff.before.valueSource
    }, null, 2),
    "```",
    "",
    "修复后：",
    "",
    "```json",
    JSON.stringify({
      semanticName: input.diff.semanticName,
      value: input.diff.after.value,
      valueSource: input.diff.after.valueSource,
      ruleId: input.diff.after.ruleId
    }, null, 2),
    "```",
    "",
    "## 写入影响",
    "",
    `- 是否写入规则: ${input.wroteRule ? "yes" : "no"}`,
    "- 是否修改 business-flow: no",
    "- 是否修改 knowledge: no",
    "- 是否修改 element_store: no",
    "- 是否启动浏览器: no",
    "- 是否执行业务: no",
    "",
    "## 回滚方式",
    "",
    `按 ruleId 回滚：\`${input.rule.ruleId}\`。`,
    "建议优先软禁用该规则，将 `enabled=false` 并记录 disabledReason。",
    "",
    "## 下一步建议",
    "",
    "先用 DSL generation dry-run 对比验证规则影响，再决定是否进入真实执行链路验证。"
  ].join("\n");
}

function parseArgs(args: string[]): CliOptions {
  const result: CliOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--proposal") result.proposal = args[++index];
    else if (arg === "--project") result.project = args[++index];
    else if (arg === "--dry-run") result.dryRun = true;
    else if (arg === "--confirm-write") result.confirmWrite = true;
    else if (arg === "--out") result.out = args[++index];
    else if (arg === "--report") result.report = args[++index];
  }
  return result;
}
