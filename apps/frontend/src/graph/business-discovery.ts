import type { DatabaseSnapshot, DomainGroup, KnownRelationship, LogicalRelationship, ObjectKey, TableDefinition } from "../platform";

export const objectId = (key: ObjectKey) => JSON.stringify([key.schema, key.name]);
export const objectLabel = (key: ObjectKey) => `${key.schema}.${key.name}`;
const tableKey = (schema: string, name: string): ObjectKey => ({ kind: "table", schema, name });
const words = (value: string) => value.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
const dictionary: [string, string[]][] = [
  ["订单", ["order"]], ["客户", ["customer", "client"]], ["用户", ["user"]],
  ["支付", ["payment", "pay"]], ["失败", ["failed", "failure", "error"]],
  ["权限", ["permission", "role", "access"]], ["商品", ["product", "item"]],
  ["库存", ["stock", "inventory"]], ["账户", ["account"]], ["账号", ["account", "login"]],
  ["退款", ["refund"]], ["发票", ["invoice"]], ["物流", ["shipment", "shipping"]],
];
const stopWords = new Set(["the", "a", "an", "of", "for", "to", "and", "is", "are", "where", "which", "find", "table", "tables", "show", "me", "how", "does"]);
export interface DiscoveryCandidate {
  table: TableDefinition;
  score: number;
  matchingColumns: string[];
  reasons: string[];
  direct: boolean;
}

// Resolve against the whole snapshot before applying a local domain filter. A
// dotted schema/table label is not unique, and cannot prove column ownership.
function knowledgeOwner(tables: TableDefinition[], key: ObjectKey): TableDefinition | undefined {
  const matches = tables.filter((table) => key.kind === "table"
    ? objectId(key) === objectId(table.key)
    : key.kind === "column" && key.schema === objectLabel(table.key) && table.columns.some((column) => column.name === key.name));
  return matches.length === 1 ? matches[0] : undefined;
}

/** Entire snapshot search, independent of canvas filters. Saved annotations are intentionally absent. */
export function discoverTables(snapshot: DatabaseSnapshot, question: string, domains: DomainGroup[], includeComments: boolean, domainId = "", modelTerms: string[] = [], knowledge: import("../platform").KnowledgeState[] = []): DiscoveryCandidate[] {
  if (!question.trim()) return [];
  const requestedName = question.trim().toLocaleLowerCase();
  const exactName = (table: TableDefinition) => requestedName === table.key.name.toLocaleLowerCase() || requestedName === objectLabel(table.key).toLocaleLowerCase();
  const directTerms = [...new Set([...words(question), ...dictionary.filter(([word]) => question.includes(word)).map(([word]) => word)])].filter((word) => !stopWords.has(word));
  const expanded = [...new Set([...dictionary.filter(([word]) => question.includes(word)).flatMap(([, terms]) => terms), ...modelTerms.flatMap(words)])].filter((term) => !directTerms.includes(term));
  const domain = domains.find((item) => item.sourceId === snapshot.sourceId && item.id === domainId);
  if (domainId && !domain) return [];
  const tables = snapshot.schemas.flatMap((schema) => schema.tables);
  const notes = knowledge.filter((state) => state.sourceId === snapshot.sourceId && state.status === "confirmed" && state.confirmation)
    .map((state) => ({ state, owner: knowledgeOwner(tables, state.objectKey) }));
  return snapshot.schemas.flatMap((schema) => schema.tables.flatMap((table) => {
    if (domain && !domain.tableKeys.some((key) => objectId(key) === objectId(table.key))) return [];
    const reasons = new Set<string>(); const columns = new Set<string>(); let score = 0; let direct = false;
    const memberships = domains.filter((group) => group.sourceId === snapshot.sourceId && group.tableKeys.some((key) => objectId(key) === objectId(table.key)));
    const fields = [
      { value: objectLabel(table.key), weight: 8, label: "Table name", column: "" },
      ...table.columns.map((column) => ({ value: column.name, weight: 4, label: "Field", column: column.name })),
      ...(includeComments ? [{ value: table.comment ?? "", weight: 3, label: "Database comment", column: "" }, ...table.columns.map((column) => ({ value: column.comment ?? "", weight: 2, label: "Database field comment", column: column.name }))] : []),
      ...notes.filter(({ owner }) => owner === table).map(({ state }) => ({ value: state.confirmation!.finalText, weight: 5, label: "Confirmed team statement", column: state.objectKey.kind === "column" ? state.objectKey.name : "" })),
      ...memberships.map((group) => ({ value: group.name, weight: 2, label: "Domain name", column: "" })),
    ];
    for (const field of fields) for (const [terms, expandedTerm] of [[directTerms, false], [expanded, true]] as const) {
      const matches = terms.filter((term) => field.value.toLocaleLowerCase().includes(term));
      if (!matches.length) continue;
      score += field.weight * (expandedTerm ? 1 : 2) * matches.length;
      direct ||= !expandedTerm;
      if (field.column) columns.add(field.column);
      reasons.add(`${expandedTerm ? "Term hypothesis" : "Direct match"} · ${field.label}${field.column ? ` ${field.column}` : ""}: ${matches.join(", ")}`);
    }
    return score ? [{ table, score, matchingColumns: [...columns], reasons: [...reasons], direct }] : [];
  })).sort((a, b) => Number(exactName(b.table)) - Number(exactName(a.table)) || b.score - a.score || objectId(a.table.key).localeCompare(objectId(b.table.key)));
}

export function knownRelationships(snapshot: DatabaseSnapshot, logical: LogicalRelationship[]) {
  const tables = new Map(snapshot.schemas.flatMap((s) => s.tables).map((t) => [objectId(t.key), t]));
  const relationships: KnownRelationship[] = []; const gaps: string[] = [];
  const valid = (r: KnownRelationship) => r.sourceColumns.length > 0 && r.sourceColumns.length === r.targetColumns.length
    && r.sourceColumns.every((c) => tables.get(objectId(r.source))?.columns.some((column) => column.name === c))
    && r.targetColumns.every((c) => tables.get(objectId(r.target))?.columns.some((column) => column.name === c));
  for (const table of tables.values()) for (const fk of table.foreignKeys) {
    const r: KnownRelationship = { id: `physical|${JSON.stringify([table.key.schema, table.key.name, fk.name])}`, kind: "physical", source: table.key, target: tableKey(fk.referencedSchema, fk.referencedTable), sourceColumns: fk.columns, targetColumns: fk.referencedColumns };
    if (valid(r)) relationships.push(r); else gaps.push(`${objectLabel(table.key)} · ${fk.name}: endpoint table or field is missing from this snapshot.`);
  }
  for (const relation of logical.filter((r) => r.sourceId === snapshot.sourceId && r.status === "active")) {
    const r: KnownRelationship = { id: `logical|${relation.id}`, kind: "logical", source: tableKey(relation.source.schema, relation.source.table), target: tableKey(relation.target.schema, relation.target.table), sourceColumns: relation.source.columns, targetColumns: relation.target.columns };
    const endpointIdentity = (item: LogicalRelationship) => JSON.stringify([item.source.schema, item.source.table, item.source.columns, item.target.schema, item.target.table, item.target.columns]);
    const compatible = valid(r) && r.sourceColumns.every((name, index) => {
      const a = tables.get(objectId(r.source))!.columns.find((c) => c.name === name)!;
      const b = tables.get(objectId(r.target))!.columns.find((c) => c.name === r.targetColumns[index])!;
      return a.typeSchema.toLowerCase() === b.typeSchema.toLowerCase() && a.typeName.toLowerCase() === b.typeName.toLowerCase();
    });
    const duplicate = logical.some((other) => other.id !== relation.id && endpointIdentity(other) === endpointIdentity(relation));
    const physical = relationships.some((p) => p.kind === "physical" && objectId(p.source) === objectId(r.source) && objectId(p.target) === objectId(r.target) && JSON.stringify(p.sourceColumns) === JSON.stringify(r.sourceColumns) && JSON.stringify(p.targetColumns) === JSON.stringify(r.targetColumns));
    const self = objectId(r.source) === objectId(r.target) && JSON.stringify(r.sourceColumns) === JSON.stringify(r.targetColumns);
    if (compatible && !duplicate && !physical && !self) relationships.push(r);
    else gaps.push(`${objectLabel(r.source)} → ${objectLabel(r.target)}: logical relationship needs review or has been superseded.`);
  }
  return { relationships: relationships.sort((a, b) => a.id.localeCompare(b.id)), gaps };
}

export interface LocalPath { tables: ObjectKey[]; relationships: KnownRelationship[] }
export function findKnownPath(root: ObjectKey, target: ObjectKey, relationships: KnownRelationship[], maxDepth = 2): LocalPath | undefined {
  if (objectId(root) === objectId(target)) return undefined;
  const neighbors = new Map<string, { next: ObjectKey; edge: KnownRelationship }[]>();
  for (const edge of relationships) for (const [from, next] of [[edge.source, edge.target], [edge.target, edge.source]]) {
    const id = objectId(from); const entries = neighbors.get(id) ?? [];
    entries.push({ next, edge }); neighbors.set(id, entries);
  }
  const queue: LocalPath[] = [{ tables: [root], relationships: [] }]; const visited = new Set([objectId(root)]);
  for (let index = 0; index < queue.length; index++) {
    const path = queue[index]; if (path.relationships.length >= maxDepth) continue;
    const last = objectId(path.tables[path.tables.length - 1]);
    for (const { next, edge } of neighbors.get(last) ?? []) {
      if (visited.has(objectId(next))) continue;
      const extended = { tables: [...path.tables, next], relationships: [...path.relationships, edge] };
      if (objectId(next) === objectId(target)) return extended;
      visited.add(objectId(next)); queue.push(extended);
    }
  }
  return undefined;
}

export function neighborhood(snapshot: DatabaseSnapshot, root: ObjectKey, relationships: KnownRelationship[], depth: number, path?: LocalPath) {
  const keys = new Set([objectId(root)]);
  for (let hop = 0; hop < depth; hop++) {
    const before = new Set(keys);
    for (const edge of relationships) {
      if (before.has(objectId(edge.source))) keys.add(objectId(edge.target));
      if (before.has(objectId(edge.target))) keys.add(objectId(edge.source));
    }
  }
  // Preserve the selected complete path even when a dense neighborhood is truncated.
  const ordered = [...new Set([objectId(root), ...(path?.tables.map(objectId) ?? []), ...keys])];
  const included = new Set(ordered.slice(0, 100));
  return { omitted: Math.max(0, ordered.length - included.size), snapshot: { ...snapshot, schemas: snapshot.schemas.map((schema) => ({ ...schema, views: [], enums: [], tables: schema.tables.filter((table) => included.has(objectId(table.key))) })) } };
}
