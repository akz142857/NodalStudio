import type { DatabaseSnapshot } from "../platform";
import { diagramColumn, diagramTable } from "./diagram-comparison-fixture";

export const inferenceReviewSnapshot: DatabaseSnapshot = {
  id: "inference-review-snapshot", sourceId: "inference-review-source", capturedAt: "2026-10-24T00:00:00Z", fingerprint: "inference-review",
  database: { name: "Review demo", databaseType: "postgreSql", version: "17" },
  schemas: [{ name: "public", views: [], enums: [], tables: [
    diagramTable("customers"), diagramTable("products"),
    diagramTable("orders", [diagramColumn("id"), { ...diagramColumn("customer_id", 2), comment: "购买客户" }]),
    diagramTable("order_items", [diagramColumn("id"), diagramColumn("order_id", 2), diagramColumn("product_id", 3)]),
    diagramTable("payments", [diagramColumn("id"), { ...diagramColumn("order_id", 2), typeName: "text", formattedType: "text" }]),
  ] }],
};
