import type { ColumnDefinition, DatabaseSnapshot, ObjectKey } from "../../platform/types";
import type { TableFilter, TableFilterRule } from "../../platform/table-data-filter";
import type { TableSort } from "../../platform/table-data-preferences";

export const TABLE_PREVIEW_ROW_LIMIT = 100;
type Dialect = DatabaseSnapshot["database"]["databaseType"];
type PreviewTarget = { key: Pick<ObjectKey, "schema" | "name">; columns?: readonly Pick<ColumnDefinition, "name" | "typeName">[] };

interface PreviewPage {
  columns?: string[];
  order: string;
  after?: string | string[];
  offset?: number;
}

export function quotePostgresIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

export function quoteIdentifier(value: string, dialect: DatabaseSnapshot["database"]["databaseType"] = "postgreSql"): string {
  const quote = dialect === "mySql" ? "`" : '"';
  return quote + value.replaceAll(quote, quote + quote) + quote;
}

export function textLiteral(value: string, dialect: Dialect): string {
  if (dialect === "postgreSql") {
    let delimiter = "$nodal$";
    for (let index = 1; (value + delimiter).indexOf(delimiter) !== value.length; index++) delimiter = `$nodal${index}$`;
    return delimiter + value + delimiter;
  }
  const hex = Array.from(new TextEncoder().encode(value), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return dialect === "mySql" ? `CONVERT(X'${hex}' USING utf8mb4)` : `CAST(X'${hex}' AS TEXT)`;
}

function filterPredicate(rule: TableFilterRule, table: PreviewTarget, dialect: Dialect) {
  const column = quoteIdentifier(rule.column, dialect);
  const text = dialect === "mySql" ? `CONVERT(${column} USING utf8mb4)` : `CAST(${column} AS TEXT)`;
  const mysqlNumber = dialect === "mySql" && table.columns?.some(({ name, typeName }) => name === rule.column &&
    /^(?:tinyint|smallint|mediumint|int|integer|bigint|float|double|decimal|numeric|real|bit|year)(?: unsigned)?$/i.test(typeName));
  const literal = (value: string) => mysqlNumber
    ? (/^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:e[+-]?[0-9]+)?$/i.test(value.trim()) ? value.trim() : "NULL")
    : textLiteral(value, dialect);

  switch (rule.kind) {
    case "equals": return `${column} = ${literal(rule.value)}`;
    case "notEquals": return `${column} <> ${literal(rule.value)}`;
    case "less": return `${column} < ${literal(rule.value)}`;
    case "lessOrEqual": return `${column} <= ${literal(rule.value)}`;
    case "greater": return `${column} > ${literal(rule.value)}`;
    case "greaterOrEqual": return `${column} >= ${literal(rule.value)}`;
    case "isNull": return `${column} IS NULL`;
    case "isNotNull": return `${column} IS NOT NULL`;
    case "isEmpty": return `LENGTH(${text}) = 0`;
    case "isNotEmpty": return `LENGTH(${text}) > 0`;
    case "between": case "notBetween":
      return `${column}${rule.kind === "notBetween" ? " NOT" : ""} BETWEEN ${literal(rule.value)} AND ${literal(rule.end)}`;
    case "inList": case "notInList":
      return `${column}${rule.kind === "notInList" ? " NOT" : ""} IN (${rule.values.map(literal).join(", ")})`;
    default: {
      const value = rule.value.replace(/[!%_]/g, "!$&");
      const prefix = rule.kind === "startsWith" || rule.kind === "notStartsWith" ? "" : "%";
      const suffix = rule.kind === "endsWith" || rule.kind === "notEndsWith" ? "" : "%";
      const pattern = `LOWER(${textLiteral(prefix + value + suffix, dialect)})`;
      const normalizedPattern = dialect === "mySql" ? `(${pattern} COLLATE utf8mb4_bin)` : pattern;
      return `LOWER(${text})${rule.kind.startsWith("not") ? " NOT" : ""} LIKE ${normalizedPattern} ESCAPE '!'`;
    }
  }
}

function tableFromSql(table: PreviewTarget, dialect: Dialect, filter?: TableFilter, after?: string) {
  const schema = quoteIdentifier(table.key.schema, dialect);
  const name = quoteIdentifier(table.key.name, dialect);
  const conditions: string[] = [];
  if (filter?.rules.length) {
    const rules = filter.rules.map((rule) => `(${filterPredicate(rule, table, dialect)})`).join(filter.match === "all" ? " AND " : " OR ");
    conditions.push(after ? `(${rules})` : rules);
  }
  if (after !== undefined) conditions.push(`(${after})`);
  const where = conditions.length ? `\nWHERE ${conditions.join(" AND ")}` : "";
  return `FROM ${schema}.${name}${where}`;
}

export function tableCountSql(table: PreviewTarget, dialect: Dialect, filter?: TableFilter) {
  const text = dialect === "mySql" ? "CHAR" : "TEXT";
  return `SELECT CAST(COUNT(*) AS ${text})\n${tableFromSql(table, dialect, filter)};`;
}

export function tablePreviewSql(table: PreviewTarget, rowLimit = 100, dialect: Dialect = "postgreSql", sort?: TableSort, filter?: TableFilter,
  page?: PreviewPage): string {
  if (page && Array.isArray(page.after)) {
    // Disjoint, individually bounded ranges let each branch seek into an index
    // when the database would otherwise scan to satisfy ORDER BY over an OR.
    const parts = page.after.map((after) => `(${tablePreviewSql(table, rowLimit, dialect, sort, filter, { ...page, after }).slice(0, -1)})`);
    return `SELECT * FROM (\n${parts.join("\nUNION ALL\n")}\n) AS nodal_page\nORDER BY ${page.order}\nLIMIT ${rowLimit};`;
  }
  const order = page?.order ?? (sort ? `${quoteIdentifier(sort.column, dialect)} ${sort.direction === "asc" ? "ASC" : "DESC"}` : "");
  const orderBy = order ? `\nORDER BY ${order}` : "";
  const projection = ["*", ...(page?.columns ?? [])].join(", ");
  const offset = page?.offset ? ` OFFSET ${page.offset}` : "";
  const after = typeof page?.after === "string" ? page.after : undefined;
  return `SELECT ${projection}\n${tableFromSql(table, dialect, filter, after)}${orderBy}\nLIMIT ${rowLimit}${offset};`;
}

export function executableSql(document: string, from: number, to: number): string {
  const selected = document.slice(Math.min(from, to), Math.max(from, to)).trim();
  return selected || document.trim();
}
