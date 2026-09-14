import path from "node:path";
import fs from "fs-extra";

export interface DomainVocabularyEntity {
  name: string;
  aliases: string[];
  valuePattern?: string;
}

export interface DomainVocabularyAction {
  action: string;
  operationType: "read" | "write" | "unknown";
  aliases: string[];
}

export interface DomainVocabularyModule {
  module: string;
  aliases: string[];
  actions: DomainVocabularyAction[];
  entities?: DomainVocabularyEntity[];
}

export interface DomainVocabulary {
  schemaVersion: "domain-vocabulary.v1";
  project: string;
  modules: DomainVocabularyModule[];
}

export interface DomainVocabularyEvidence {
  source: "domain_vocabulary";
  module: string;
  action?: string;
  entity?: string;
  matchedText: string;
  matchedAlias: string;
  confidence: number;
}

export interface DomainIntentMatch {
  module?: string;
  action?: string;
  operationType?: "read" | "write" | "unknown";
  entities: Record<string, string>;
  retrievalQueries: string[];
  evidence: DomainVocabularyEvidence[];
  confidence: number;
}

export async function loadDomainVocabulary(rootDir: string, projectKey: string): Promise<DomainVocabulary | undefined> {
  const filePath = path.join(rootDir, "configs", "projects", projectKey, "domain-vocabulary.json");
  if (!(await fs.pathExists(filePath))) return undefined;
  return (await fs.readJson(filePath)) as DomainVocabulary;
}

export function classifyWithDomainVocabulary(message: string, vocabulary?: DomainVocabulary): DomainIntentMatch {
  const evidence: DomainVocabularyEvidence[] = [];
  const entities: Record<string, string> = {};
  if (!vocabulary) return { entities, retrievalQueries: [], evidence, confidence: 0 };

  const moduleMatches = vocabulary.modules
    .map((module) => {
      const moduleAliases = module.aliases.filter((alias) => includesAlias(message, alias));
      const actionMatches = module.actions
        .map((action) => ({ action, aliases: action.aliases.filter((alias) => includesAlias(message, alias)) }))
        .filter((item) => item.aliases.length > 0);
      const entityMatches = (module.entities ?? [])
        .map((entity) => ({ entity, aliases: entity.aliases.filter((alias) => includesAlias(message, alias)), value: extractEntityValue(message, entity.valuePattern) }))
        .filter((item) => item.aliases.length > 0 || item.value);
      const score = moduleAliases.length * 2 + actionMatches.length * 3 + entityMatches.reduce((sum, item) => sum + item.aliases.length, 0);
      return { module, moduleAliases, actionMatches, entityMatches, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);

  const selected = moduleMatches[0];
  if (!selected) return { entities, retrievalQueries: [], evidence, confidence: 0 };

  for (const alias of selected.moduleAliases) {
    evidence.push({ source: "domain_vocabulary", module: selected.module.module, matchedText: message, matchedAlias: alias, confidence: 0.75 });
  }

  const selectedAction = selected.actionMatches[0]?.action;
  for (const alias of selected.actionMatches[0]?.aliases ?? []) {
    evidence.push({ source: "domain_vocabulary", module: selected.module.module, action: selectedAction?.action, matchedText: message, matchedAlias: alias, confidence: 0.82 });
  }

  for (const item of selected.entityMatches) {
    if (item.value) entities[item.entity.name] = item.value.toUpperCase();
    for (const alias of item.aliases) {
      evidence.push({ source: "domain_vocabulary", module: selected.module.module, entity: item.entity.name, matchedText: message, matchedAlias: alias, confidence: 0.72 });
    }
    if (item.value) {
      evidence.push({ source: "domain_vocabulary", module: selected.module.module, entity: item.entity.name, matchedText: message, matchedAlias: item.value, confidence: 0.8 });
    }
  }

  const retrievalQueries = [
    selected.module.module,
    selectedAction?.action,
    ...selected.module.aliases.slice(0, 6),
    ...(selectedAction?.aliases.slice(0, 8) ?? []),
    ...Object.values(entities)
  ].filter((item): item is string => Boolean(item));

  return {
    module: selected.module.module,
    action: selectedAction?.action,
    operationType: selectedAction?.operationType,
    entities,
    retrievalQueries: [...new Set(retrievalQueries)],
    evidence,
    confidence: Math.min(0.9, 0.55 + selected.score * 0.06)
  };
}

export function summarizeDomainVocabulary(vocabulary?: DomainVocabulary): Record<string, unknown> | undefined {
  if (!vocabulary) return undefined;
  return {
    schemaVersion: vocabulary.schemaVersion,
    project: vocabulary.project,
    modules: vocabulary.modules.map((module) => ({
      module: module.module,
      aliases: module.aliases,
      actions: module.actions.map((action) => ({ action: action.action, operationType: action.operationType, aliases: action.aliases })),
      entities: (module.entities ?? []).map((entity) => ({ name: entity.name, aliases: entity.aliases }))
    }))
  };
}

function includesAlias(text: string, alias: string): boolean {
  if (!alias) return false;
  if (/^[a-z0-9 _-]+$/i.test(alias)) return new RegExp(`\\b${escapeRegExp(alias).replace(/\\ /g, "\\s+")}\\b`, "i").test(text);
  return text.includes(alias);
}

function extractEntityValue(message: string, pattern?: string): string | undefined {
  if (!pattern) return undefined;
  const match = message.match(new RegExp(pattern, "i"));
  return match?.[1];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
