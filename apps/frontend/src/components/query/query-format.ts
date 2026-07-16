import type { TableDefinition } from "../../platform";

export function quotePostgresIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

export function tablePreviewSql(table: TableDefinition, rowLimit = 100): string {
  const schema = quotePostgresIdentifier(table.key.schema);
  const name = quotePostgresIdentifier(table.key.name);
  return `SELECT *\nFROM ${schema}.${name}\nLIMIT ${rowLimit};`;
}

export function executableSql(document: string, from: number, to: number): string {
  const selected = document.slice(Math.min(from, to), Math.max(from, to)).trim();
  return selected || document.trim();
}
