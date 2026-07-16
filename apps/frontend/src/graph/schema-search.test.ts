import { describe, expect, it } from "vitest";
import type { DatabaseSnapshot, TableDefinition } from "../platform";
import { searchSchema } from "./schema-search";

function table(name: string, columns: string[]): TableDefinition {
  return {
    key: { kind: "table", schema: "public", name }, tableKind: "ordinary",
    columns: columns.map((column, index) => ({ name: column, ordinalPosition: index + 1, formattedType: "text", typeSchema: "pg_catalog", typeName: "text", nullable: true, defaultValue: null, identity: null, generated: false, comment: null })),
    primaryKey: null, foreignKeys: [], indexes: [], constraints: [], comment: null,
  };
}

const snapshot: DatabaseSnapshot = {
  id: "snapshot", sourceId: "source", capturedAt: "2026-07-12T00:00:00Z", fingerprint: "fp",
  database: { name: "app", databaseType: "postgreSql", version: "17" },
  schemas: [{ name: "public", tables: [table("orders", ["id", "customer_id"]), table("customers", ["id", "email"])], views: [], enums: [] }],
};

describe("searchSchema", () => {
  it("finds tables by table and field name", () => {
    expect(searchSchema(snapshot, "orders").map((result) => result.table.key.name)).toEqual(["orders"]);
    expect(searchSchema(snapshot, "email")).toMatchObject([{ table: { key: { name: "customers" } }, matchingColumns: ["email"] }]);
  });

  it("is case insensitive and bounded", () => {
    expect(searchSchema(snapshot, "CUSTOM", 1)).toHaveLength(1);
    expect(searchSchema(snapshot, "  ")).toEqual([]);
  });
});
