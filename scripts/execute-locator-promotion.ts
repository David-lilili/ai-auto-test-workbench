import fs from "fs-extra";
import path from "node:path";
import { promoteLocatorCandidate } from "../src/core/locator-promotion.js";

/**
 * P4-B10 真实执行：≤5 条修复型 locator AUTO_PROMOTE。
 * 候选来自 60 条 locator backlog 中含真实自愈证据的 4 条
 * （聚合后 2 个 unique target；「查看更多」4 run 中 3 次成功满足 policy）。
 */

const rootDir = process.cwd();

async function main() {
  const pendingDir = path.join(rootDir, "storage/proposals/pending");
  const files = (await fs.readdir(pendingDir)).filter(f => f.endsWith(".json"));

  // 收集自愈证据（target 聚合）
  const healingByTarget = new Map<string, { semanticName: string; healedLocator: string; runIds: Set<string>; evidenceIds: string[] }>();
  for (const file of files) {
    const proposal = await fs.readJson(path.join(pendingDir, file));
    if (proposal.proposalType !== "element_locator_update") continue;
    const pkgPath = String(proposal.evidence?.failurePackagePath ?? "");
    const rel = "artifacts" + pkgPath.split("artifacts")[1];
    if (!(await fs.pathExists(rel))) continue;
    try {
      const failurePackage = await fs.readJson(rel);
      const steps = failurePackage.executionSteps ?? [];
      const healed = steps.find((s: Record<string, unknown>) =>
        (s.status === "healed" || s.status === "passed") && Number(s.fallback_level_used) > 0 && s.actual_locator_used);
      if (!healed) continue;
      const target = String(healed.target_semantic_name ?? "");
      if (!healingByTarget.has(target)) {
        healingByTarget.set(target, { semanticName: target, healedLocator: String(healed.actual_locator_used), runIds: new Set(), evidenceIds: [] });
      }
      const entry = healingByTarget.get(target)!;
      entry.runIds.add(String(proposal.runId ?? ""));
      entry.evidenceIds.push(String(proposal.proposalId));
    } catch {
      continue;
    }
  }

  console.log("真实自愈 target 聚合:");
  for (const [target, entry] of healingByTarget) {
    console.log(`  ${target} | 成功 run 数=${entry.runIds.size} | healed=${entry.healedLocator}`);
  }

  // 在 store 中定位对应元素并执行晋升（policy: locator.v1 要求 ≥2 成功）
  const store = await fs.readJson(path.join(rootDir, "storage/page-models/demo.json"));
  const results = [];
  for (const [target, entry] of healingByTarget) {
    if (entry.runIds.size < 2) {
      console.log(`\n跳过 ${target}：成功 run 数 ${entry.runIds.size} < 2（policy minEvidenceCount）`);
      results.push({ target, decision: "REVIEW", reason: "成功次数不足" });
      continue;
    }
    // store 元素匹配
    let matchedElement: { pageId: string; elementId: string; semanticName: string; locatorCandidates: Array<Record<string, unknown>> } | undefined;
    for (const model of store.models) {
      for (const element of (model.elements ?? []) as Array<Record<string, unknown>>) {
        const semanticName = String(element.semanticName ?? "");
        const normalizedTarget = target.replace(/点击|按钮/g, "");
        if (semanticName.includes(target) || semanticName.includes(normalizedTarget) || target.includes(semanticName.replace(/按钮$/g, ""))) {
          matchedElement = {
            pageId: String(model.pageId),
            elementId: String(element.elementId),
            semanticName,
            locatorCandidates: (element.locatorCandidates ?? []) as Array<Record<string, unknown>>
          };
          break;
        }
      }
      if (matchedElement) break;
    }
    if (!matchedElement) {
      console.log(`\n跳过 ${target}：store 中无对应元素（semantic target 未建模）`);
      results.push({ target, decision: "KEEP_PENDING", reason: "元素未建模" });
      continue;
    }

    // 策略映射（actual_locator_used 形态 → strategy）
    const healed = entry.healedLocator;
    const strategy = healed.startsWith("text") ? "text" : healed.startsWith("[") || healed.includes("css=") ? "css" : "role";

    const result = await promoteLocatorCandidate(rootDir, "demo", {
      pageId: matchedElement.pageId,
      elementId: matchedElement.elementId,
      semanticName: matchedElement.semanticName,
      oldLocatorCandidates: matchedElement.locatorCandidates,
      healedLocator: { strategy, value: healed, confidence: 0.7, source: "self_healing_recovery" },
      evidenceIds: entry.evidenceIds,
      policyId: "locator.v1",
      policyVersion: 1,
      sourceRunIds: [...entry.runIds],
      successCount: entry.runIds.size
    });
    console.log(`\n${result.ok ? "✓" : "✗"} ${target} → ${result.action}${result.error ? ` (${result.error})` : ""}`);
    if (result.mutationDiff) {
      console.log(`  locatorCandidates: ${result.mutationDiff.before} → ${result.mutationDiff.after}（旧值保留）`);
      console.log(`  backup: ${result.backupPath}`);
      console.log(`  verificationHistory: 已写入（policy=locator.v1@1, evidence=${entry.evidenceIds.length}）`);
    }
    results.push({ target, decision: result.ok ? "AUTO_PROMOTE" : "ERROR", detail: result });
  }

  await fs.writeJson(path.join(rootDir, "reports/locator-auto-promotion-results.json"), results, { spaces: 2 });
  console.log("\n结果: reports/locator-auto-promotion-results.json");
}

await main();
