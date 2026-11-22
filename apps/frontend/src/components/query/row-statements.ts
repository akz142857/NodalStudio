import type { SqliteCell, SqliteTableColumn, SqliteTableData } from "../../platform/sqlite-table";
import type { DatabaseSnapshot, ObjectKey, QueryCell, QueryColumn, TableDefinition } from "../../platform/types";
import { quoteIdentifier, textLiteral } from "./query-format";

type Dialect = DatabaseSnapshot["database"]["databaseType"];
type TableName = Pick<ObjectKey, "schema" | "name">;
type Field = { name: string; literal: string | undefined };
type Statement = { sql: string } | { reason: "missingKey" | "incompleteValues" | "noUpdateFields" };
export type RowStatements = { insert: Statement; update: Statement };
export type StatementTable = { table: TableDefinition; dialect: Dialect };

const numericLiteral = /^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:e[+-]?[0-9]+)?$/i;
const networkNumericType = /^(?:int2|int4|int8|smallint|int|integer|bigint|mediumint|tinyint|decimal|numeric|float|float4|float8|double|double precision|real|year)(?: unsigned)?$/i;

function stringLiteral(value: string, dialect: Dialect): string | undefined {
  const quoted = (part: string) => `'${part.replaceAll("'", "''")}'`;
  if (value.includes("\0")) {
    if (dialect === "sqlite") return value.split("\0").map(quoted).join(" || char(0) || ");
    if (dialect === "postgreSql") return undefined;
    return textLiteral(value, dialect);
  }
  // Both MySQL and PostgreSQL have modes that change the meaning of backslashes.
  return (dialect !== "sqlite" && value.includes("\\")) || (dialect === "mySql" && value.includes("\u001a"))
    ? textLiteral(value, dialect) : quoted(value);
}

function queryCellLiteral(cell: QueryCell | undefined, type: string, dialect: Dialect): string | undefined {
  switch (cell?.kind) {
    case "null": return "NULL";
    case "boolean": return cell.value ? "TRUE" : "FALSE";
    case "number": return Number.isFinite(cell.value) ? String(cell.value) : undefined;
    case "json": return !cell.truncated && cell.raw !== undefined ? stringLiteral(cell.raw, dialect) : undefined;
    case "text": {
      if (cell.truncated) return undefined;
      if (networkNumericType.test(type) && numericLiteral.test(cell.value)) return cell.value;
      return stringLiteral(cell.value, dialect);
    }
    default: return undefined;
  }
}

function sqliteCellLiteral(cell: SqliteCell | undefined): string | undefined {
  if (cell?.kind === "null") return "NULL";
  if (cell?.kind === "text") return stringLiteral(cell.value, "sqlite");
  if (cell?.kind === "integer") {
    if (!/^[+-]?[0-9]+$/.test(cell.value)) return undefined;
    const value = BigInt(cell.value);
    return value >= -9223372036854775808n && value <= 9223372036854775807n ? String(value) : undefined;
  }
  if (cell?.kind === "real" && numericLiteral.test(cell.value) && Number.isFinite(Number(cell.value))) {
    return /[.e]/i.test(cell.value) ? cell.value : `${cell.value}.0`;
  }
  return undefined;
}

function statements(dialect: Dialect, target: TableName, insertFields: Field[], updateFields: Field[], key: Field[], overrideIdentity = false): RowStatements {
  const quote = (name: string) => quoteIdentifier(name, dialect);
  const table = `${quote(target.schema)}.${quote(target.name)}`;
  let insert: Statement;
  if (!insertFields.length) {
    insert = { sql: dialect === "mySql" ? `INSERT INTO ${table} () VALUES ();` : `INSERT INTO ${table} DEFAULT VALUES;` };
  } else if (insertFields.some(({ literal }) => literal === undefined)) {
    insert = { reason: "incompleteValues" };
  } else {
    const columns = insertFields.map(({ name }) => quote(name)).join(", ");
    const values = insertFields.map(({ literal }) => literal).join(", ");
    const override = overrideIdentity ? " OVERRIDING SYSTEM VALUE" : "";
    insert = { sql: `INSERT INTO ${table} (${columns})${override} VALUES (${values});` };
  }

  let update: Statement;
  if (!key.length || key.some(({ literal }) => literal === undefined || literal === "NULL")) {
    update = { reason: "missingKey" };
  } else if (!updateFields.length) {
    update = { reason: "noUpdateFields" };
  } else if (updateFields.some(({ literal }) => literal === undefined)) {
    update = { reason: "incompleteValues" };
  } else {
    const assignment = ({ name, literal }: Field) => `${quote(name)} = ${literal}`;
    update = { sql: `UPDATE ${table} SET ${updateFields.map(assignment).join(", ")} WHERE ${key.map(assignment).join(" AND ")};` };
  }
  return { insert, update };
}

export function queryRowStatements({ table, dialect }: StatementTable, columns: readonly QueryColumn[], row: readonly QueryCell[]): RowStatements {
  const values = new Map(columns.map(({ name, databaseType }, index) => [name, queryCellLiteral(row[index], databaseType, dialect)]));
  const keyColumns = table.primaryKey?.columns ?? [];
  const field = (name: string) => ({ name, literal: values.get(name) });
  // Older MySQL snapshots also marked expression defaults as generated. A real
  // generated column cannot have its own default.
  const writable = table.columns.filter(({ generated, defaultValue }) => !generated || (dialect === "mySql" && defaultValue != null));
  const update = writable.filter(({ name, identity }) => !keyColumns.includes(name) && !(dialect === "postgreSql" && identity === "always"));
  return statements(dialect, table.key, writable.map(({ name }) => field(name)), update.map(({ name }) => field(name)),
    keyColumns.map(field), dialect === "postgreSql" && writable.some(({ identity }) => identity === "always"));
}

export function sqliteRowStatements(table: string, columns: readonly SqliteTableColumn[],
  original: SqliteTableData["rows"][number] | undefined, changes: ReadonlyMap<number, SqliteCell> | undefined, deleted: boolean): RowStatements {
  const insert: Field[] = [];
  const update: Field[] = [];
  const key: Field[] = [];
  columns.forEach(({ name, generated, primaryKey }, index) => {
    const originalCell = original?.cells[index];
    const changed = changes?.get(index);
    if (original?.identity && primaryKey) key.push({ name, literal: sqliteCellLiteral(originalCell) });
    if (generated) return;
    const field = { name, literal: sqliteCellLiteral(changed ?? originalCell) };
    if (original || changed) insert.push(field);
    if (!deleted && (changes ? changed !== undefined : !primaryKey)) update.push(field);
  });
  return statements("sqlite", { schema: "main", name: table }, insert, update, key);
}
