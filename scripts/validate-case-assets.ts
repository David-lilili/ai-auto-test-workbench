import fs from "node:fs/promises";
import path from "node:path";

interface Finding {
  file: string;
  caseId: string;
  field: string;
  issue: string;
  detail: string;
}

const CASE_ROOT = path.resolve(process.cwd(), "storage", "cases");
const findings: Finding[] = [];

const INTERNAL_KNOWLEDGE_LEAK_PATTERNS: Array<{ issue: string; pattern: RegExp; hint: string }> = [
  {
    issue: "candidate_wording_leaked_to_case_assertion",
    pattern: /候选(?:文案|文本|提示|断言|消息)|(?:candidate|textCandidates|candidateTexts)\s*(?:text|wording|assertion|message|copy)?/i,
    hint: "用例期望只能描述业务可见结果；候选文案/textCandidates 应保留在 Page Model/Operation Manual 中。"
  },
  {
    issue: "dsl_contract_leaked_to_case_assertion",
    pattern: /DSL\s*断言|Page Model\s*断言|assertionId|断言\s*ID/i,
    hint: "用例期望不能混入 DSL/Page Model 物化校验语句；断言 ID 关系应保存在 knowledgeRefs 或 DSL 校验结果中。"
  }
];

for (const filePath of await caseStoreFiles(CASE_ROOT)) {
  await validateCaseStore(filePath);
}

if (findings.length) {
  for (const finding of findings) {
    console.log(`${relative(finding.file)}:${finding.caseId}:${finding.field}: ${finding.issue}: ${finding.detail}`);
  }
  console.log(`\nCase asset validation failed: ${findings.length} issue(s).`);
  process.exit(1);
}

console.log("Case asset validation passed: no modeling-internal candidate wording leaked into case assertions.");

async function caseStoreFiles(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(root, entry.name));
}

async function validateCaseStore(filePath: string): Promise<void> {
  const raw = JSON.parse(await fs.readFile(filePath, "utf8")) as Record<string, unknown>;
  const cases = Array.isArray(raw.cases) ? raw.cases : [];
  for (const item of cases) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const caseId = String(record.id ?? "<missing-id>");
    validateTextField(filePath, caseId, "expectedAssertion", record.expectedAssertion);
    validateExpectedResults(filePath, caseId, record.expectedResults);
  }
}

function validateExpectedResults(filePath: string, caseId: string, value: unknown): void {
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  for (const [key, fieldValue] of Object.entries(record)) {
    if (typeof fieldValue === "string") {
      validateTextField(filePath, caseId, `expectedResults.${key}`, fieldValue);
      continue;
    }
    if (Array.isArray(fieldValue)) {
      fieldValue.forEach((item, index) => validateTextField(filePath, caseId, `expectedResults.${key}[${index}]`, item));
    }
  }
}

function validateTextField(filePath: string, caseId: string, field: string, value: unknown): void {
  if (typeof value !== "string" || !value.trim()) return;
  for (const rule of INTERNAL_KNOWLEDGE_LEAK_PATTERNS) {
    if (!rule.pattern.test(value)) continue;
    findings.push({
      file: filePath,
      caseId,
      field,
      issue: rule.issue,
      detail: rule.hint
    });
  }
}

function relative(filePath: string): string {
  return path.relative(process.cwd(), filePath) || filePath;
}
