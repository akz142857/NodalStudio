import type { ColumnDefinition, DatabaseSnapshot } from "../platform/types";
import { reportSnapshot } from "./schema-report-fixture";
import { diagramColumn } from "./diagram-comparison-fixture";

export const enumColumn = (name: string, typeSchema = "public", typeName = "order_status", formattedType = typeName): ColumnDefinition => ({
  ...diagramColumn(name), typeSchema, typeName, formattedType,
});

export const enumSnapshot: DatabaseSnapshot = {
  ...reportSnapshot,
  id: "enum-snapshot",
  schemas: [{
    ...reportSnapshot.schemas[0],
    tables: [reportSnapshot.schemas[0].tables[0], { ...reportSnapshot.schemas[0].tables[1], columns: [
      ...reportSnapshot.schemas[0].tables[1].columns,
      enumColumn("status"), enumColumn("previous_status"),
      enumColumn("history", "public", "_order_status_2", '"public"."order_status"[][]'),
      enumColumn("other_status", "archive"),
      enumColumn("not_an_enum", "pg_catalog", "text", "order_status"),
      enumColumn("domain_status", "public", "status_domain"),
    ] }],
    enums: [{ ...reportSnapshot.schemas[0].enums[0], values: ["new", "paid", "shipped", "", '<script>alert("x")</script>'] }],
    views: [...reportSnapshot.schemas[0].views, { key: { kind: "view", schema: "public", name: "order_status" }, materialized: false, definition: "SELECT 1", comment: null }],
  }, {
    ...reportSnapshot.schemas[1],
    tables: [{ ...reportSnapshot.schemas[1].tables[0], columns: [enumColumn("public_status"), enumColumn("status", "archive")] }],
    enums: [{ key: { kind: "enum", schema: "archive", name: "order_status" }, values: ["archived"] }],
  }],
};
