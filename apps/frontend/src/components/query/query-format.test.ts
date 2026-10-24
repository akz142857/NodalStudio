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
});
