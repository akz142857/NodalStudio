import type { DatabaseSnapshot, IgnoredRelationshipInference, LogicalRelationship, RelationshipEndpoint, TableDefinition } from "../../platform";
import type { ColumnDefinition } from "../../platform/types";
import { inferRelationships, inferredRelationshipRuleKey, logicalRelationshipKey, tableNodeId } from "../../graph/schema-graph";

export interface RelationshipCandidate {
  key: string;
  ruleKey: string;
  source: RelationshipEndpoint;
  target: RelationshipEndpoint;
  sourceTable: TableDefinition;
  targetTable: TableDefinition;
  sourceColumn: ColumnDefinition;
  targetColumn: ColumnDefinition;
  typeMatches: boolean;
  targetUnique: boolean;
  existingTargets: string[];
  evidence: string[];
  bulkReviewReason?: string;
}

export function relationshipCandidates(snapshot: DatabaseSnapshot, relationships: LogicalRelationship[]) {
  const tables = snapshot.schemas.flatMap((schema) => schema.tables.map((table) => ({ schema: schema.name, table })));
  const byId = new Map(tables.map(({ schema, table }) => [tableNodeId(schema, table.key.name), table]));
  // Disabled logical links also exist in the store and cannot be created twice.
  const established = new Set(relationships.flatMap((relationship) => relationship.source.columns.map((column, index) =>
    logicalRelationshipKey(tableNodeId(relationship.source.schema, relationship.source.table), column,
      tableNodeId(relationship.target.schema, relationship.target.table), relationship.target.columns[index]))));
  const all = inferRelationships(tables).flatMap((inference): RelationshipCandidate[] => {
    const sourceTable = byId.get(inference.sourceId);
    const targetTable = byId.get(inference.targetId);
    const sourceColumn = sourceTable?.columns.find((column) => column.name === inference.column);
    const targetColumn = targetTable?.columns.find((column) => column.name === inference.referencedColumn);
    if (!sourceTable || !targetTable || !sourceColumn || !targetColumn) return [];
    const typeMatches = sourceColumn.typeName.toLowerCase() === targetColumn.typeName.toLowerCase()
      && sourceColumn.typeSchema.toLowerCase() === targetColumn.typeSchema.toLowerCase()
      && /\bunsigned\b/i.test(sourceColumn.formattedType) === /\bunsigned\b/i.test(targetColumn.formattedType);
    const singlePrimary = targetTable.primaryKey?.columns.length === 1 && targetTable.primaryKey.columns[0] === targetColumn.name;
    const targetUnique = singlePrimary || targetTable.indexes.some((index) => index.unique && !index.predicate && index.columns.length === 1 && index.columns[0] === targetColumn.name);
    const existingTargets = relationships.filter((relationship) => relationship.source.schema === sourceTable.key.schema
      && relationship.source.table === sourceTable.key.name && relationship.source.columns.includes(sourceColumn.name)
      && relationship.status !== "orphaned")
      .map((relationship) => `${relationship.target.schema}.${relationship.target.table}.${relationship.target.columns.join(", ")} (${relationship.status})`);
    const stem = sourceColumn.name.replace(/_id$/, "");
    const plural = stem.endsWith("y") ? `${stem.slice(0, -1)}ies` : `${stem}s`;
    const alternatives = tables.filter(({ table }) => table.primaryKey?.columns.includes("id") && [stem, plural].some((name) => table.key.name === name || table.key.name.endsWith(`_${name}`)));
    const bulkReviewReason = sourceTable.key.schema !== targetTable.key.schema ? "Cross-schema mapping requires individual review"
      : alternatives.length !== 1 || ![stem, plural].includes(targetTable.key.name) ? "The naming target is ambiguous or requires contextual review" : undefined;
    return [{ key: inference.relationshipKey, ruleKey: inferredRelationshipRuleKey(inference),
      source: { schema: sourceTable.key.schema, table: sourceTable.key.name, columns: [sourceColumn.name] },
      target: { schema: targetTable.key.schema, table: targetTable.key.name, columns: [targetColumn.name] },
      sourceTable, targetTable, sourceColumn, targetColumn, typeMatches, targetUnique, existingTargets, bulkReviewReason,
      evidence: [inference.evidence[0], typeMatches ? "Base types and signedness match" : "Column types or signedness differ",
        singlePrimary ? "Target is a single-column primary key" : targetUnique ? "Target has a single-column unique index" : "Target belongs to a composite primary key; this column alone is not known to be unique"],
    }];
  }).sort((a, b) => Number(!candidateNeedsReview(b)) - Number(!candidateNeedsReview(a)) || a.key.localeCompare(b.key));
  return { all, available: all.filter((candidate) => !established.has(candidate.key)) };
}

export function candidateNeedsReview(candidate: RelationshipCandidate) {
  return !candidate.typeMatches || !candidate.targetUnique || candidate.existingTargets.length > 0 || Boolean(candidate.bulkReviewReason);
}

export function pendingCandidates(candidates: RelationshipCandidate[], ignored: IgnoredRelationshipInference[]) {
  const keys = new Set(ignored.map((item) => item.relationshipKey));
  return candidates.filter((candidate) => !keys.has(candidate.key) && !keys.has(candidate.ruleKey));
}

export function candidateMatches(candidate: RelationshipCandidate, query: string) {
  const text = [candidate.key, candidate.sourceTable.comment, candidate.targetTable.comment, candidate.sourceColumn.comment, candidate.targetColumn.comment].join(" ").toLocaleLowerCase();
  return query.toLocaleLowerCase().trim().split(/\s+/).every((token) => text.includes(token));
}

export function candidateInScope(candidate: RelationshipCandidate, scope: string, visibleTableIds?: string[], selectedTableId?: string) {
  const sourceId = tableNodeId(candidate.source.schema, candidate.source.table);
  const targetId = tableNodeId(candidate.target.schema, candidate.target.table);
  return scope === "selected" ? sourceId === selectedTableId || targetId === selectedTableId
    : scope === "view" ? Boolean(visibleTableIds?.includes(sourceId) && visibleTableIds.includes(targetId)) : true;
}
