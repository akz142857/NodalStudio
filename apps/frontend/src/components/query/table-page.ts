import type { ColumnDefinition, ObjectKey, QueryExecutionResult, TableDefinition } from "../../platform/types";
import type { TableSort } from "../../platform/table-data-preferences";
import { quoteIdentifier, TABLE_PREVIEW_ROW_LIMIT, textLiteral } from "./query-format";

export type TableCursor = (string | null)[];
type Dialect = "mySql" | "postgreSql";

interface Term {
  expression: string;
  projection: string;
  nullable: boolean;
  literal: (value: string) => string | undefined;
}

function termFor(column: ColumnDefinition, dialect: Dialect, nullable: boolean): Term | undefined {
  const identifier = quoteIdentifier(column.name, dialect);
  if (dialect === "postgreSql") {
    if (!column.typeSchema || !column.typeName) return undefined;
    const type = [column.typeSchema, column.typeName].map((name) => quoteIdentifier(name, dialect)).join(".");
    return {
      expression: identifier, nullable, projection: `CAST(${identifier} AS TEXT)`,
      literal: (value) => `CAST(${textLiteral(value, dialect)} AS ${type})`,
    };
  }

  const type = column.typeName.toLowerCase();
  if (/^(?:var)?binary$|blob$/.test(type)) {
    return {
      expression: identifier, nullable, projection: `HEX(${identifier})`,
      literal: (value) => /^(?:[a-f0-9]{2})*$/i.test(value) ? `X'${value}'` : undefined,
    };
  }
  if (/^(?:tinyint|smallint|mediumint|int|integer|bigint|decimal|numeric|float|double|real|bit|year|enum|set)$/.test(type)) {
    // ENUM and SET sort by their stored numbers. Promote floats before rendering
    // the boundary so both sides compare at the precision of the same expression.
    const expression = /^(?:bit|enum|set)$/.test(type) ? `(${identifier} + 0)`
      : /^(?:float|double|real)$/.test(type) ? `(${identifier} + 0e0)` : identifier;
    return {
      expression, nullable, projection: `CAST(${expression} AS CHAR)`,
      literal: (value) => /^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value) ? value : undefined,
    };
  }
  if (/^(?:char|varchar|tinytext|text|mediumtext|longtext|date|datetime|timestamp|time)$/.test(type)) {
    const temporal = /^(?:date|datetime|timestamp|time)$/.test(type);
    return {
      expression: identifier, nullable, projection: `CONVERT(${identifier} USING utf8mb4)`,
      literal: (value) => temporal
        ? (/^[0-9 :.-]+$/.test(value) ? `'${value}'` : undefined)
        : textLiteral(value, dialect),
    };
  }
}

function afterBoundary(terms: Term[], cursor: TableCursor, descending: boolean, dialect: Dialect): string | string[] | undefined {
  if (terms.length !== cursor.length) return undefined;
  const values = cursor.map((value, index) => value === null ? null : terms[index].literal(value));
  if (values.includes(undefined)) return undefined;
  const operator = descending ? "<" : ">";
  const nullsFirst = dialect === "postgreSql" ? descending : !descending;
  const expressions = terms.map(({ expression }) => expression);
  const compare = (start: number): string | undefined => {
    if (start === terms.length) return undefined;
    const names = expressions.slice(start);
    const boundary = values.slice(start);
    if (dialect === "postgreSql" && names.length > 1) {
      return `(${names.join(", ")}) ${operator} (${boundary.join(", ")})`;
    }
    return names.map((name, index) => {
      const prefix = names.slice(0, index).map((previous, i) => `${previous} = ${boundary[i]}`);
      return `(${[...prefix, `${name} ${operator} ${boundary[index]}`].join(" AND ")})`;
    }).join(" OR ");
  };
  const [first] = expressions;
  const orRanges = (left: string, right: string) => dialect === "postgreSql" ? [left, right] : `${left} OR ${right}`;
  // Key columns are non-null. Only the leading user sort can have NULLs.
  if (values.slice(1).includes(null) || (values[0] === null && !terms[0].nullable)) return undefined;
  if (values[0] === null) {
    const ties = compare(1);
    if (!ties) return undefined;
    const nextNulls = `(${first} IS NULL AND (${ties}))`;
    return nullsFirst ? orRanges(nextNulls, `${first} IS NOT NULL`) : nextNulls;
  }
  const nextValues = compare(0);
  return terms[0].nullable && !nullsFirst && nextValues ? orRanges(nextValues, `${first} IS NULL`) : nextValues;
}

export function tablePrimaryKeyApplies(table: TableDefinition, dialect: Dialect, verifiedKeys: string[][]) {
  if (dialect === "postgreSql" && table.includesInheritedRows) return false;
  const key = table.primaryKey?.columns;
  return Boolean(key && (dialect === "mySql" || table.includesInheritedRows === false
    || verifiedKeys.some((columns) => columns.length === key.length && columns.every((column, index) => column === key[index]))));
}

export function tablePagePlan(table: TableDefinition, dialect: Dialect, sort?: TableSort, cursor?: TableCursor, uniqueKeys: string[][] = []) {
  if (table.tableKind === "foreign" || (dialect === "postgreSql" && table.includesInheritedRows)) return undefined;
  const candidates = table.primaryKey && tablePrimaryKeyApplies(table, dialect, uniqueKeys)
    ? [table.primaryKey.columns, ...uniqueKeys] : uniqueKeys;
  const key = candidates.find((candidate) => candidate.length && candidate.every((name) => {
    const column = table.columns.find((item) => item.name === name);
    return column && !column.nullable && termFor(column, dialect, false);
  }));
  if (!key) return undefined;
  const names = sort ? [sort.column, ...key.filter((name) => name !== sort.column)] : key;
  const terms = names.map((name) => {
    const column = table.columns.find((candidate) => candidate.name === name);
    return column && termFor(column, dialect, !key.includes(name) && column.nullable);
  });
  if (!terms.every((term) => term !== undefined)) return undefined;
  const descending = sort?.direction === "desc";
  const usedNames = new Set(table.columns.map(({ name }) => name.toLowerCase()));
  const aliases = terms.map((_, index) => {
    let alias = `__nodal_cursor_${index}`;
    while (usedNames.has(alias)) alias += "_";
    return alias;
  });
  const after = cursor && afterBoundary(terms, cursor, descending, dialect);
  return {
    columns: terms.map((term, index) => `${term.projection} AS ${quoteIdentifier(aliases[index], dialect)}`),
    order: terms.map((term) => `${term.expression} ${descending ? "DESC" : "ASC"}`).join(", "),
    aliases, after,
    usable: !cursor || Boolean(after),
  };
}

// The catalog reports validity and non-nullability for every key part. A
// partially eligible index must never be mistaken for a shorter unique key.
export function tableUniqueKeysSql(key: ObjectKey, dialect: Dialect) {
  const schema = textLiteral(key.schema, dialect);
  const table = textLiteral(key.name, dialect);
  if (dialect === "mySql") {
    return `SELECT CONVERT(s.INDEX_NAME USING utf8mb4), CONVERT(s.COLUMN_NAME USING utf8mb4),
       CASE WHEN c.IS_NULLABLE = 'NO' AND s.SUB_PART IS NULL THEN 1 ELSE 0 END
FROM information_schema.STATISTICS AS s
LEFT JOIN information_schema.COLUMNS AS c
  ON BINARY c.TABLE_SCHEMA = BINARY s.TABLE_SCHEMA
 AND BINARY c.TABLE_NAME = BINARY s.TABLE_NAME
 AND BINARY c.COLUMN_NAME = BINARY s.COLUMN_NAME
WHERE s.TABLE_SCHEMA = ${schema} AND s.TABLE_NAME = ${table}
  AND BINARY s.TABLE_SCHEMA = BINARY ${schema} AND BINARY s.TABLE_NAME = BINARY ${table}
  AND s.NON_UNIQUE = 0 AND s.INDEX_TYPE = 'BTREE'
ORDER BY s.INDEX_NAME, s.SEQ_IN_INDEX;`;
  }
  return `SELECT CAST(i.indexrelid AS TEXT), CAST(a.attname AS TEXT),
       CASE WHEN a.attnotnull AND i.indcollation[p.part] = a.attcollation AND op.opcdefault THEN 1 ELSE 0 END
FROM pg_catalog.pg_index AS i
JOIN pg_catalog.pg_class AS r ON r.oid = i.indrelid
JOIN pg_catalog.pg_namespace AS n ON n.oid = r.relnamespace
JOIN pg_catalog.pg_class AS ix ON ix.oid = i.indexrelid
JOIN pg_catalog.pg_am AS am ON am.oid = ix.relam
CROSS JOIN LATERAL pg_catalog.generate_series(0, i.indnkeyatts - 1) AS p(part)
LEFT JOIN pg_catalog.pg_attribute AS a ON a.attrelid = r.oid AND a.attnum = i.indkey[p.part]
LEFT JOIN pg_catalog.pg_opclass AS op ON op.oid = i.indclass[p.part]
WHERE n.nspname = ${schema} AND r.relname = ${table}
  AND (r.relkind = 'p' OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_inherits WHERE inhparent = r.oid))
  AND am.amname = 'btree' AND i.indisunique AND i.indisvalid AND i.indisready AND i.indislive
  AND i.indpred IS NULL AND i.indexprs IS NULL
ORDER BY i.indexrelid, p.part;`;
}

export function readTableUniqueKeys(result: QueryExecutionResult): string[][] {
  if (result.truncated) return [];
  const indexes = new Map<string, { columns: string[]; eligible: boolean }>();
  for (const [identifier, column, eligible] of result.rows) {
    if (identifier?.kind !== "text" || identifier.truncated) return [];
    const index = indexes.get(identifier.value) ?? { columns: [], eligible: true };
    if (column?.kind === "text" && !column.truncated) index.columns.push(column.value);
    else index.eligible = false;
    index.eligible &&= (eligible?.kind === "number" && eligible.value === 1)
      || (eligible?.kind === "text" && !eligible.truncated && eligible.value === "1");
    indexes.set(identifier.value, index);
  }
  return [...indexes.values()].filter(({ eligible }) => eligible).map(({ columns }) => columns).sort((a, b) => a.length - b.length);
}

function mysqlOffsetTieBreakers(column: ColumnDefinition) {
  const name = quoteIdentifier(column.name, "mySql");
  const type = column.typeName.toLowerCase();
  if (/^(?:geometry|point|linestring|polygon|multipoint|multilinestring|multipolygon|geometrycollection)$/.test(type)) {
    return [`ST_SRID(${name})`, `SHA2(ST_AsWKB(${name}), 256)`];
  }
  if (/text$|blob$|^json$/.test(type)) return [`SHA2(CAST(${name} AS BINARY), 256)`];
  if (/^(?:var)?(?:char|binary)$/.test(type)) {
    const bytes = `CAST(${name} AS BINARY)`;
    const size = Number(/\((\d+)\)/.exec(column.formattedType)?.[1]);
    return size > 0 && size <= 256 ? [bytes] : [bytes, `SHA2(${bytes}, 256)`];
  }
  return [termFor(column, "mySql", column.nullable)?.expression ?? `SHA2(CAST(${name} AS BINARY), 256)`];
}

export function tableOffsetOrder(table: TableDefinition, dialect: Dialect, sort?: TableSort): string {
  const sortColumn = sort && quoteIdentifier(sort.column, dialect);
  const primarySort = sortColumn ? [`${sortColumn} ${sort?.direction === "desc" ? "DESC" : "ASC"}`] : [];
  // PostgreSQL's physical identifiers break ties in a stable table, including
  // an inheritance tree. MySQL has no exposed row ID, so break ties by value.
  const tieBreakers = dialect === "mySql" ? table.columns.flatMap(mysqlOffsetTieBreakers)
    : table.tableKind === "foreign" ? table.columns.map(({ name }) => `CAST(${quoteIdentifier(name, dialect)} AS TEXT) COLLATE "C"`)
    : ["tableoid", "ctid"];
  return [...primarySort, ...tieBreakers.filter((term) => term !== sortColumn).map((term) => `${term} ASC`)].join(", ");
}

export function tablePageResult(result: QueryExecutionResult, aliases: string[] = [], limit = TABLE_PREVIEW_ROW_LIMIT) {
  const hasMore = result.rows.length > limit || result.truncated;
  const firstCursor = result.columns.length - aliases.length;
  const hasCursorColumns = aliases.length > 0 && aliases.every((alias, index) => result.columns[firstCursor + index]?.name === alias);
  const visibleColumns = hasCursorColumns ? result.columns.slice(0, firstCursor) : result.columns;
  const visibleRows = result.rows.slice(0, limit).map((row) => hasCursorColumns ? row.slice(0, firstCursor) : row);
  const boundary = hasMore && hasCursorColumns ? result.rows[visibleRows.length - 1]?.slice(firstCursor) : undefined;
  const next = boundary?.map((cell) => cell.kind === "null" ? null
    : cell.kind === "text" && !cell.truncated ? cell.value : undefined);
  const nextCursor = next?.length === aliases.length && next.every((value) => value !== undefined) ? next : undefined;
  return {
    data: { ...result, columns: visibleColumns, rows: visibleRows, rowCount: visibleRows.length, truncated: false },
    hasMore, nextCursor,
  };
}
