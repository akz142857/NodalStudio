import type { DatabaseSnapshot, TableDefinition } from "../platform";

export interface SchemaSearchResult {
  schema: string;
  table: TableDefinition;
  matchingColumns: string[];
}

export function searchSchema(
  snapshot: DatabaseSnapshot | undefined,
  query: string,
  limit = 10,
): SchemaSearchResult[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!snapshot || !normalized) return [];
  return snapshot.schemas.flatMap((schema) => schema.tables.flatMap((table) => {
    const matchingColumns = table.columns
      .filter((column) => column.name.toLocaleLowerCase().includes(normalized))
      .map((column) => column.name);
    const tableMatches = schema.name.toLocaleLowerCase().includes(normalized)
      || table.key.name.toLocaleLowerCase().includes(normalized);
    return tableMatches || matchingColumns.length
      ? [{ schema: schema.name, table, matchingColumns }]
      : [];
  })).slice(0, Math.max(1, limit));
}
