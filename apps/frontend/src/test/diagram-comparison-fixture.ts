import type { DatabaseSnapshot, SchemaChangeSet, TableDefinition } from "../platform";
import type { ColumnDefinition, ForeignKeyDefinition } from "../platform/types";

export const diagramColumn = (name: string, ordinalPosition = 1): ColumnDefinition => ({
  name, ordinalPosition, formattedType: "uuid", typeSchema: "pg_catalog", typeName: "uuid",
  nullable: false, defaultValue: null, identity: null, generated: false, comment: null,
});
export const diagramTable = (name: string, columns: ColumnDefinition[] = [diagramColumn("id")]): TableDefinition => ({
  key: { kind: "table", schema: "public", name }, tableKind: "ordinary", columns,
  primaryKey: { name: `${name}_pk`, columns: ["id"] }, foreignKeys: [], indexes: [], constraints: [], comment: null,
});
export const diagramForeignKey = (name: string, column: string, target: string): ForeignKeyDefinition => ({
  name, columns: [column], referencedSchema: "public", referencedTable: target, referencedColumns: ["id"],
  onUpdate: "noAction", onDelete: "cascade", matchType: "simple", deferrable: false, initiallyDeferred: false,
});

const orders = diagramTable("orders", [diagramColumn("id"), diagramColumn("user_id", 2),
  { ...diagramColumn("legacy_note", 3), formattedType: "text", typeName: "text" },
  { ...diagramColumn("old_name", 4), formattedType: "text", typeName: "text" }]);
orders.foreignKeys = [diagramForeignKey("orders_owner_fk", "user_id", "users")];
const audit = diagramTable("audit", [diagramColumn("id"), diagramColumn("order_id", 2)]);
audit.foreignKeys = [diagramForeignKey("audit_order_fk", "order_id", "orders")];
export const diagramBefore: DatabaseSnapshot = {
  id: "diagram-before", sourceId: "source", capturedAt: "2026-10-12T08:00:00Z", fingerprint: "diagram-before-fingerprint",
  database: { name: "app", databaseType: "postgreSql", version: "17" },
  schemas: [{ name: "public", tables: [diagramTable("users"), orders, audit], views: [], enums: [] }],
};
const newOrders = { ...orders, columns: [diagramColumn("id"), { ...diagramColumn("user_id", 2), defaultValue: "gen_random_uuid()" },
  { ...diagramColumn("new_name", 3), formattedType: "text", typeName: "text" },
  { ...diagramColumn("priority", 4), formattedType: "integer", typeName: "int4" }],
  foreignKeys: [diagramForeignKey("orders_owner_fk", "user_id", "partners")] };
export const diagramAfter: DatabaseSnapshot = { ...diagramBefore, id: "diagram-after", capturedAt: "2026-10-13T08:00:00Z", fingerprint: "diagram-after-fingerprint",
  schemas: [{ name: "public", tables: [diagramTable("users"), newOrders, diagramTable("partners")], views: [], enums: [] }] };
export const diagramChangeSet: SchemaChangeSet = {
  id: "diagram-changes", beforeSnapshotId: diagramBefore.id, afterSnapshotId: diagramAfter.id, createdAt: diagramAfter.capturedAt,
  operations: [
    { operationType: "dropTable", object: { kind: "table", schema: "public", name: "audit" }, risk: "high", before: "2 columns", after: null },
    { operationType: "addTable", object: { kind: "table", schema: "public", name: "partners" }, risk: "low", before: null, after: "1 column" },
    { operationType: "dropColumn", object: { kind: "column", schema: "public.orders", name: "legacy_note" }, risk: "high", before: "text not null", after: null },
    { operationType: "renameColumn", object: { kind: "column", schema: "public.orders", name: "old_name" }, risk: "high", before: "old_name: text not null", after: "new_name: text not null" },
    { operationType: "alterColumn", object: { kind: "column", schema: "public.orders", name: "user_id" }, risk: "medium", before: "uuid not null", after: "uuid not null" },
    { operationType: "addColumn", object: { kind: "column", schema: "public.orders", name: "priority" }, risk: "medium", before: null, after: "integer not null" },
    { operationType: "dropForeignKey", object: { kind: "foreignKey", schema: "public.orders", name: "orders_owner_fk" }, risk: "high", before: "user_id → users.id", after: null },
    { operationType: "addForeignKey", object: { kind: "foreignKey", schema: "public.orders", name: "orders_owner_fk" }, risk: "high", before: null, after: "user_id → partners.id" },
  ], riskSummary: { high: 5, medium: 2, low: 1, informational: 0 },
};
