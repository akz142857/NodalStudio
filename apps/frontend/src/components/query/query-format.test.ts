import { describe, expect, it } from "vitest";
import type { TableDefinition } from "../../platform";
import { quoteIdentifier, executableSql, quotePostgresIdentifier, tablePreviewSql } from "./query-format";

const table = {
  key: { kind: "table", schema: "Sales Ops", name: "order\"item" },
  tableKind: "ordinary",
  columns: [],
  primaryKey: null,
  foreignKeys: [],
  indexes: [],
  constraints: [],
  comment: null,
} satisfies TableDefinition;

describe("query formatting", () => {
  it("quotes PostgreSQL identifiers including embedded quotes", () => {
    expect(quotePostgresIdentifier('a"b')).toBe('"a""b"');
    expect(tablePreviewSql(table)).toContain('FROM "Sales Ops"."order""item"');
    expect(tablePreviewSql(table, 100, "postgreSql", { column: 'total"amount', direction: "asc" }))
      .toContain('ORDER BY "total""amount" ASC\nLIMIT 100');
  });

  it("executes the selection before the whole document", () => {
    const document = "SELECT 1;\nSELECT 2;";
    expect(executableSql(document, 10, 19)).toBe("SELECT 2;");
    expect(executableSql(document, 0, 0)).toBe(document);
  });
});


it("quotes MySQL identifiers with escaped backticks for row previews", () => {
  const table = { key: { schema: "Sales Ops", name: "order`item" } } as TableDefinition;
  expect(quoteIdentifier("order`item", "mySql")).toBe("`order``item`");
  expect(tablePreviewSql(table, 100, "mySql")).toBe("SELECT *\nFROM `Sales Ops`.`order``item`\nLIMIT 100;");
  expect(tablePreviewSql(table, 100, "mySql", { column: "total`amount", direction: "desc" }))
    .toContain("ORDER BY `total``amount` DESC\nLIMIT 100");
});

it("builds PostgreSQL filters before sorting and limiting, with literal wildcard and delimiter characters", () => {
  const sql = tablePreviewSql(table, 101, "postgreSql", { column: "id", direction: "desc" }, {
    match: "all",
    rules: [
      { column: "name", kind: "startsWith", value: "Café_%" },
      { column: "id", kind: "between", value: "1", end: "10" },
      { column: "note", kind: "equals", value: "Cost $nodal" },
    ],
  });
  expect(sql).toContain(`WHERE (LOWER(CAST("name" AS TEXT)) LIKE LOWER($nodal$Café!_!%%$nodal$) ESCAPE '!')
    AND ("id" BETWEEN $nodal$1$nodal$ AND $nodal$10$nodal$) AND ("note" = $nodal1$Cost $nodal$nodal1$)`.replace("\n    ", " "));
  expect(sql).toMatch(/\nORDER BY "id" DESC\nLIMIT 101;$/);
});

it("encodes MySQL filter values independently of backslash handling", () => {
  const sql = tablePreviewSql(table, 101, "mySql", undefined, {
    match: "any",
    rules: [
      { column: "name", kind: "inList", values: ["O'Reilly", "A\\B"] },
      { column: "note", kind: "isNull" },
    ],
  });
  expect(sql).toContain("WHERE (`name` IN (CONVERT(X'4f275265696c6c79' USING utf8mb4), CONVERT(X'415c42' USING utf8mb4))) OR (`note` IS NULL)\nLIMIT 101;");
});
