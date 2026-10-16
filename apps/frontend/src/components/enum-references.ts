import type { ColumnDefinition, DatabaseSnapshot, EnumDefinition, TableDefinition } from "../platform/types";

export interface EnumReference {
  table: TableDefinition;
  fields: { column: ColumnDefinition; array: boolean }[];
}

// Catalog names are case-sensitive. Never infer a type from a column's name or
// from PostgreSQL's generated array-name prefix (which can collide/truncate).
function identifiers(name: string) {
  return [`"${name.replaceAll('"', '""')}"`, ...(/^[a-z_][a-z0-9_$]*$/.test(name) ? [name] : [])];
}

/** References present in captured table metadata. Domains and view columns are
 * not represented by this snapshot model, so no dependency is guessed for them. */
export function enumReferences(snapshot: DatabaseSnapshot, item: EnumDefinition): EnumReference[] {
  const names = identifiers(item.key.name), schemas = identifiers(item.key.schema);
  const arrayTypes = new Set([...names, ...schemas.flatMap((schema) => names.map((name) => `${schema}.${name}`))]);
  return snapshot.schemas.flatMap((schema) => schema.tables.flatMap((table) => {
    const fields = table.columns.flatMap((column) => {
      if (column.typeSchema !== item.key.schema) return [];
      if (column.typeName === item.key.name) return [{ column, array: false }];
      // format_type records an enum array as [schema.]type[], including quoted
      // identifiers. Use that captured identity, not a substring type match.
      const formatted = column.formattedType.trim();
      const base = formatted.replace(/(?:\[\s*\])+$/, "");
      return base !== formatted && arrayTypes.has(base) ? [{ column, array: true }] : [];
    });
    return fields.length ? [{ table, fields }] : [];
  }));
}
