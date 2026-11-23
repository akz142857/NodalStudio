import type { DatabaseSnapshot, SemanticBundle, TableDefinition } from "../platform";
import { discoverTables, objectId, type DiscoveryEvidence } from "./business-discovery";

export interface SchemaSearchResult {
  schema: string;
  table: TableDefinition;
  matchingColumns: string[];
  match?: DiscoveryEvidence;
  nameMatch?: boolean;
}

interface SearchContext {
  includeComments: boolean;
  semantics?: Pick<SemanticBundle, "domainGroups" | "knowledge">;
}

export function searchSchema(
  snapshot: DatabaseSnapshot | undefined,
  query: string,
  limit = 10,
  context?: SearchContext,
): SchemaSearchResult[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!snapshot || !normalized) return [];
  const direct = snapshot.schemas.flatMap((schema) => schema.tables.flatMap((table) => {
    const name = table.key.name.toLocaleLowerCase();
    const qualified = `${schema.name}.${table.key.name}`.toLocaleLowerCase();
    const matchingColumns = table.columns
      .filter((column) => column.name.toLocaleLowerCase().includes(normalized))
      .map((column) => column.name);
    const priority = name === normalized || qualified === normalized ? 0
      : name.startsWith(normalized) || qualified.startsWith(normalized) ? 1
        : name.includes(normalized) || qualified.includes(normalized) ? 2
          : matchingColumns.length ? 3 : undefined;
    return priority === undefined ? [] : [{ priority, result: { schema: schema.name, table, matchingColumns, nameMatch: priority < 3 } }];
  })).sort((a, b) => a.priority - b.priority).map(({ result }) => result);
  const max = Math.max(1, limit);
  if (!context || direct.length >= max) return direct.slice(0, max);
  const seen = new Set(direct.map((result) => objectId(result.table.key)));
  const related = discoverTables(snapshot, query, context.semantics?.domainGroups ?? [],
    context.includeComments, "", [], context.semantics?.knowledge ?? [])
    .filter(({ table }) => !seen.has(objectId(table.key)))
    .map(({ table, matchingColumns, match }) => ({ schema: table.key.schema, table, matchingColumns, match }));
  return [...direct, ...related].slice(0, max);
}
