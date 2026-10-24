import type { DatabaseSnapshot, TableDefinition } from "../../platform";

export function quotePostgresIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

export function quoteIdentifier(value: string, dialect: DatabaseSnapshot["database"]["databaseType"] = "postgreSql"): string {
  const quote = dialect === "mySql" ? "`" : '"';
  return quote + value.replaceAll(quote, quote + quote) + quote;
}

export function tablePreviewSql(table: TableDefinition, rowLimit = 100, dialect: DatabaseSnapshot["database"]["databaseType"] = "postgreSql"): string {
  const schema = quoteIdentifier(table.key.schema, dialect);
  const name = quoteIdentifier(table.key.name, dialect);
  return `SELECT *\nFROM ${schema}.${name}\nLIMIT ${rowLimit};`;
}

export function executableSql(document: string, from: number, to: number): string {
  const selected = document.slice(Math.min(from, to), Math.max(from, to)).trim();
  return selected || document.trim();
}
