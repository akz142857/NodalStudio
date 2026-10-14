import type { DatabaseSnapshot, SemanticBundle } from "../platform";
import { diagramColumn, diagramForeignKey, diagramTable } from "./diagram-comparison-fixture";

const customers = diagramTable("customers", [diagramColumn("id"), { ...diagramColumn("name", 2), formattedType: "text", typeName: "text", nullable: true, comment: "Customer display name" }]);
const orders = diagramTable("orders", [
  { ...diagramColumn("id"), identity: "byDefault" },
  { ...diagramColumn("customer_id", 2), defaultValue: "gen_random_uuid()", comment: "Customer identifier" },
  { ...diagramColumn("total", 3), formattedType: "numeric(12,2)", typeName: "numeric", generated: true, comment: "Calculated order total" },
]);
orders.comment = "Orders placed by customers";
orders.foreignKeys = [{ ...diagramForeignKey("orders_customer_fk", "customer_id", "customers"), deferrable: true, initiallyDeferred: true }];
orders.indexes = [{ name: "orders_customer_idx", method: "btree", columns: ["customer_id", "total"], unique: false, primary: false, predicate: "total > 0" }];
orders.constraints = [{ name: "positive_total", constraintType: "check", definition: "CHECK (total >= 0)" }];

export const reportSnapshot: DatabaseSnapshot = {
  id: "private-snapshot-id", sourceId: "private-source-id", capturedAt: "2026-10-13T08:00:00Z", fingerprint: "schema-report-fingerprint",
  database: { name: "Commerce", databaseType: "postgreSql", version: "17" },
  schemas: [{ name: "public", tables: [customers, orders], views: [{ key: { kind: "view", schema: "public", name: "order_totals" }, materialized: true, definition: "SELECT customer_id, sum(total) FROM public.orders GROUP BY customer_id", comment: "Aggregated totals" }],
    enums: [{ key: { kind: "enum", schema: "public", name: "order_status" }, values: ["new", "paid", "shipped"] }] },
    { name: "archive", tables: [{ ...diagramTable("orders"), key: { kind: "table", schema: "archive", name: "orders" }, comment: "Archived order structure" }], views: [], enums: [] }],
};
export const reportSemantics: SemanticBundle = {
  annotations: [{ sourceId: reportSnapshot.sourceId, objectKey: orders.key, description: "订单：记录已确认的购买意图", tags: ["commerce", "core"], owner: "Commerce team", isCore: true, updatedAt: "2026-10-13T09:00:00Z" },
    { sourceId: reportSnapshot.sourceId, objectKey: { kind: "column", schema: "public.orders", name: "total" }, description: "Amount before shipping", tags: [], owner: null, isCore: false, updatedAt: "2026-10-13T09:00:00Z" }],
  orphanedAnnotations: [],
  domainGroups: [{ id: "domain-private-id", sourceId: reportSnapshot.sourceId, name: "Commerce", description: "Customer orders and ownership", color: "#6941c6", tableKeys: [customers.key, orders.key], updatedAt: "2026-10-13T09:00:00Z" }],
  savedViews: [], layout: null, ignoredRelationshipInferences: [],
  logicalRelationships: [{ id: "private-logical-id", sourceId: reportSnapshot.sourceId, name: "Historical order link", source: { schema: "archive", table: "orders", columns: ["id"] }, target: { schema: "public", table: "orders", columns: ["id"] }, cardinality: "oneToOne", status: "active", origin: "confirmedInference", note: "Confirmed by the domain owner", evidence: ["Application mapping"], createdAt: "2026-10-13T09:00:00Z", updatedAt: "2026-10-13T09:00:00Z" }],
};
