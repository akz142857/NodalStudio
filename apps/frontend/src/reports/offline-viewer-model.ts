import type { DatabaseSnapshot, SemanticBundle } from "../platform";

export const offlineViewerLimits = { tables: 500, columns: 5000, relationships: 5000 };
export interface OfflineTable {
  id: string;
  schema: string;
  name: string;
  domains: string[];
  columns: { name: string; type: string; primary: boolean; nullable: boolean }[];
}
export interface OfflineRelation { source: string; target: string; name: string; kind: "physical" | "logical" }
export interface OfflineViewerModel {
  version: 1;
  tables: OfflineTable[];
  domains: { id: string; name: string }[];
  objects: { id: string; schema: string }[];
  relations: OfflineRelation[];
  unavailableRelations: number;
}
const keyOf = (schema: string, name: string) => JSON.stringify([schema, name]);

/** Small display-only allowlist. Never embed a snapshot/workspace bundle or local identity. */
export function offlineViewerModel(snapshot: DatabaseSnapshot, semantics: SemanticBundle): OfflineViewerModel {
  if (snapshot.sourceId.startsWith("ddl-preview:") || snapshot.fingerprint.startsWith("ddl-preview-v1:")) throw new Error("Temporary DDL previews cannot be exported as captured database viewers.");
  const tables: OfflineTable[] = snapshot.schemas.flatMap((schema, si) => schema.tables.map((table, ti) => ({
    id: `table-${si}-${ti}`, schema: table.key.schema, name: table.key.name, domains: [],
    columns: table.columns.map((column) => ({ name: column.name, type: column.formattedType, primary: table.primaryKey?.columns.includes(column.name) ?? false, nullable: column.nullable })),
  })));
  if (tables.length > offlineViewerLimits.tables || tables.reduce((sum, table) => sum + table.columns.length, 0) > offlineViewerLimits.columns) throw new Error("Offline Viewer supports at most 500 tables / 5,000 columns. Use the static HTML report for larger snapshots; no objects were truncated.");
  const byKey = new Map(tables.map((table) => [keyOf(table.schema, table.name), table]));
  if (byKey.size !== tables.length) throw new Error("Duplicate qualified table identities cannot be exported to Offline Viewer.");
  const domains = semantics.domainGroups.filter((group) => group.sourceId === snapshot.sourceId).flatMap((group, index) => {
    const members = group.tableKeys.filter((key) => key.kind === "table").map((key) => byKey.get(keyOf(key.schema, key.name))).filter((table) => table !== undefined);
    if (!members.length) return [];
    const id = `domain-${index}`;
    members.forEach((table) => { if (!table.domains.includes(id)) table.domains.push(id); });
    return [{ id, name: group.name }];
  });
  const relations: OfflineRelation[] = []; let unavailableRelations = 0;
  const add = (sourceSchema: string, sourceName: string, sourceColumns: string[], targetSchema: string, targetName: string, targetColumns: string[], name: string, kind: OfflineRelation["kind"]) => {
    const source = byKey.get(keyOf(sourceSchema, sourceName)); const target = byKey.get(keyOf(targetSchema, targetName));
    if (!source || !target || !sourceColumns.length || sourceColumns.length !== targetColumns.length || sourceColumns.some((name) => !source.columns.some((column) => column.name === name)) || targetColumns.some((name) => !target.columns.some((column) => column.name === name))) { unavailableRelations++; return; }
    relations.push({ source: source.id, target: target.id, name, kind });
  };
  for (const schema of snapshot.schemas) for (const table of schema.tables) for (const fk of table.foreignKeys) add(table.key.schema, table.key.name, fk.columns, fk.referencedSchema, fk.referencedTable, fk.referencedColumns, fk.name, "physical");
  for (const relation of semantics.logicalRelationships) if (relation.sourceId === snapshot.sourceId && relation.status === "active") add(relation.source.schema, relation.source.table, relation.source.columns, relation.target.schema, relation.target.table, relation.target.columns, relation.name, "logical");
  if (relations.length + unavailableRelations > offlineViewerLimits.relationships) throw new Error("Offline Viewer supports at most 5,000 physical / active logical relationships. Use the static HTML report; no relationships were truncated.");
  const objects = snapshot.schemas.flatMap((schema, si) => [
    ...schema.views.map((view, vi) => ({ id: `view-${si}-${vi}`, schema: view.key.schema })),
    ...schema.enums.map((item, ei) => ({ id: `enum-${si}-${ei}`, schema: item.key.schema })),
  ]);
  return { version: 1, tables, domains, objects, relations, unavailableRelations };
}
