import { describe, expect, it } from "vitest";
import type { DatabaseSnapshot, SchemaOperation, TableDefinition } from "../platform";
import { operationProperties } from "./schema-change-details";

const table: TableDefinition = {
  key: { kind: "table", schema: "public", name: "orders" }, tableKind: "ordinary", comment: "Order data",
  columns: [], primaryKey: { name: "orders_pk", columns: ["id"] },
  foreignKeys: [{ name: "orders_fk", columns: ["account_id"], referencedSchema: "crm", referencedTable: "accounts",
    referencedColumns: ["id"], onUpdate: "CASCADE", onDelete: "RESTRICT", matchType: "SIMPLE", deferrable: true, initiallyDeferred: false }],
  indexes: [{ name: "orders_idx", method: "btree", columns: ["id"], unique: true, primary: false, predicate: "id > 0" }],
  constraints: [{ name: "orders_check", constraintType: "check", definition: "CHECK (total > 0)" }],
};
const snapshot: DatabaseSnapshot = {
  id: "after", sourceId: "source", capturedAt: "2026-10-13T00:00:00Z", fingerprint: "test",
  database: { name: "app", databaseType: "postgreSql", version: "17" },
  schemas: [{ name: "public", tables: [table],
    views: [{ key: { kind: "view", schema: "public", name: "recent_orders" }, definition: "SELECT * FROM orders", materialized: true, comment: "Recent orders" }],
    enums: [{ key: { kind: "enum", schema: "public", name: "order_status" }, values: ["pending", "ready"] }] }],
};

describe("snapshot change details", () => {
  it.each([
    { kind: "table", schema: "public", name: "orders", properties: { schema: "public", name: "orders", comment: "Order data", primaryKey: table.primaryKey } },
    { kind: "primaryKey", schema: "public.orders", name: "orders_pk", properties: { name: "orders_pk", columns: ["id"] } },
    { kind: "foreignKey", schema: "public.orders", name: "orders_fk", properties: { referencedSchema: "crm", onDelete: "RESTRICT", deferrable: true } },
    { kind: "index", schema: "public.orders", name: "orders_idx", properties: { predicate: "id > 0", unique: true } },
    { kind: "constraint", schema: "public.orders", name: "orders_check", properties: { constraintType: "check", definition: "CHECK (total > 0)" } },
    { kind: "view", schema: "public", name: "recent_orders", properties: { definition: "SELECT * FROM orders", materialized: true, comment: "Recent orders" } },
    { kind: "enum", schema: "public", name: "order_status", properties: { values: ["pending", "ready"] } },
  ])("retrieves $kind properties omitted by operation summaries", ({ kind, schema, name, properties }) => {
    const operation: SchemaOperation = { operationType: "addTable", object: { kind, schema, name }, risk: "low", before: null, after: "Summary" };
    expect(operationProperties(snapshot, operation, "after")).toMatchObject(properties);
  });

  it("does not take a same-name object from another schema", () => {
    const operation: SchemaOperation = { operationType: "addIndex", object: { kind: "index", schema: "crm.orders", name: "orders_idx" }, risk: "low", before: null, after: "Summary" };
    expect(operationProperties(snapshot, operation, "after")).toBeUndefined();
  });

  it("does not guess when qualified child keys are ambiguous", () => {
    const ambiguous = { ...snapshot, schemas: [{ ...snapshot.schemas[0], tables: [
      { ...table, key: { ...table.key, schema: "tenant.eu", name: "orders" } },
      { ...table, key: { ...table.key, schema: "tenant", name: "eu.orders" } },
    ] }] };
    const operation: SchemaOperation = { operationType: "dropPrimaryKey", object: { kind: "primaryKey", schema: "tenant.eu.orders", name: "orders_pk" }, risk: "high", before: "id", after: null };
    expect(operationProperties(ambiguous, operation, "before")).toBeUndefined();
  });
});
