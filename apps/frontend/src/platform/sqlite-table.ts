import type { TableFilter } from "./table-data-filter";
import type { TablePageSize, TableSort } from "./table-data-preferences";

export type SqliteValue =
  | { kind: "null" }
  | { kind: "text" | "integer" | "real"; value: string };

export type SqliteCell = SqliteValue | { kind: "unavailable" };

export interface SqliteTableTarget {
  sourceId: string;
  table: string;
}

export interface SqlitePageCursor {
  version: string;
  values: ({ kind: "null" } | { kind: "integer" | "real" | "text"; value: string } | { kind: "binary"; value: number[] })[];
}

export function sqliteTableSourceKey(sourceId: string, binding: string) {
  return ["sqlite-table-data", sourceId, binding] as const;
}

export interface SqliteTableReadOptions {
  offset: number;
  pageSize?: TablePageSize;
  cursor?: SqlitePageCursor;
  sort?: TableSort;
  filter?: TableFilter;
}

export interface SqliteTableColumn {
  name: string;
  declaredType: string;
  generated: boolean;
  primaryKey: boolean;
}

export interface SqliteRowIdentity {
  key: SqliteValue[];
  revision: string;
}

export interface SqliteTableData {
  version: string;
  columns: SqliteTableColumn[];
  rows: { cells: SqliteCell[]; identity: SqliteRowIdentity | null }[];
  statement?: string;
  nextOffset: number | null;
  nextCursor?: SqlitePageCursor;
}

export interface SqliteField {
  column: number;
  value: SqliteValue;
}

export type SqliteRowChange =
  | { kind: "insert"; fields: SqliteField[] }
  | { kind: "update"; identity: SqliteRowIdentity; fields: SqliteField[] }
  | { kind: "delete"; identity: SqliteRowIdentity };

export interface SaveSqliteTableInput {
  target: SqliteTableTarget;
  version: string;
  changes: SqliteRowChange[];
}
