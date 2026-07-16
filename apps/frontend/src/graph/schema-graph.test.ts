import { describe, expect, it } from "vitest";
import type { DatabaseSnapshot, LogicalRelationship, TableDefinition } from "../platform";
import { buildSchemaGraph, estimatedTableNodeHeight, orientFieldEdges } from "./schema-graph";

function table(name: string): TableDefinition {
  return {
    key: { kind: "table", schema: "public", name },
    tableKind: "ordinary",
    columns: [],
    primaryKey: null,
    foreignKeys: [],
    indexes: [],
    constraints: [],
    comment: null,
  };
}

describe("buildSchemaGraph", () => {
  it("merges logical relationships separately from physical constraints", () => {
    const users = table("users");
    const orders = table("orders");
    for (const model of [users, orders]) {
      model.columns.push({
        name: "id", ordinalPosition: 1, formattedType: "uuid", typeSchema: "pg_catalog",
        typeName: "uuid", nullable: false, defaultValue: null, identity: null,
        generated: false, comment: null,
      });
    }
    orders.columns.push({
      name: "user_id", ordinalPosition: 2, formattedType: "uuid", typeSchema: "pg_catalog",
      typeName: "uuid", nullable: false, defaultValue: null, identity: null,
      generated: false, comment: null,
    });
    const snapshot = {
      id: "snapshot", sourceId: "source", capturedAt: "2026-07-11T00:00:00Z",
      fingerprint: "fingerprint", database: { name: "app", databaseType: "postgreSql", version: "17" },
      schemas: [{ name: "public", tables: [users, orders], views: [], enums: [] }],
    } satisfies DatabaseSnapshot;
    const relationship: LogicalRelationship = {
      id: "logical-1", sourceId: "source", name: "orders_owner",
      source: { schema: "public", table: "orders", columns: ["user_id"] },
      target: { schema: "public", table: "users", columns: ["id"] },
      cardinality: "manyToOne", status: "active", origin: "manual", note: "Order owner",
      evidence: [], createdAt: "2026-07-11T00:00:00Z", updatedAt: "2026-07-11T00:00:00Z",
    };

    const graph = buildSchemaGraph(snapshot, { logicalRelationships: [relationship] });
    expect(graph.logicalRelationshipCount).toBe(1);
    expect(graph.edges[0]).toMatchObject({
      id: "logical.logical-1.0",
      data: { relationshipKind: "logical", relationshipId: "logical-1", cardinality: "manyToOne" },
      style: { stroke: "#7c3aed", strokeDasharray: "8 5" },
    });
    expect(graph.nodes.find((node) => node.id === "public.orders")?.data.logicalForeignKeyColumns).toEqual(["user_id"]);

    orders.foreignKeys.push({ name: "orders_user_fk", columns: ["user_id"], referencedSchema: "public", referencedTable: "users", referencedColumns: ["id"], onUpdate: "noAction", onDelete: "noAction", matchType: "simple", deferrable: false, initiallyDeferred: false });
    relationship.status = "supersededByPhysical";
    const physicalWins = buildSchemaGraph(snapshot, { logicalRelationships: [relationship] });
    expect(physicalWins.edges).toHaveLength(1);
    expect(physicalWins.edges[0].data?.relationshipKind).toBe("physical");
  });

  it("suppresses inferred candidates after dismissal", () => {
    const users = table("users");
    users.primaryKey = { name: "users_pkey", columns: ["id"] };
    users.columns.push({ name: "id", ordinalPosition: 1, formattedType: "uuid", typeSchema: "pg_catalog", typeName: "uuid", nullable: false, defaultValue: null, identity: null, generated: false, comment: null });
    const orders = table("orders");
    orders.columns.push({ name: "user_id", ordinalPosition: 1, formattedType: "uuid", typeSchema: "pg_catalog", typeName: "uuid", nullable: false, defaultValue: null, identity: null, generated: false, comment: null });
    const snapshot = { id: "snapshot", sourceId: "source", capturedAt: "2026-07-11T00:00:00Z", fingerprint: "fingerprint", database: { name: "app", databaseType: "postgreSql", version: "17" }, schemas: [{ name: "public", tables: [users, orders], views: [], enums: [] }] } satisfies DatabaseSnapshot;
    const relationshipKey = "public.orders[user_id]->public.users[id]";

    expect(buildSchemaGraph(snapshot, { includeInferredRelationships: true }).edges).toHaveLength(1);
    expect(buildSchemaGraph(snapshot, { includeInferredRelationships: true, ignoredRelationshipKeys: [relationshipKey] }).edges).toEqual([]);
    expect(buildSchemaGraph(snapshot, { includeInferredRelationships: true, ignoredRelationshipKeys: ["rule:naming-id:public.orders.user_id"] }).edges).toEqual([]);
  });

  it("estimates only rows that the current canvas settings render", () => {
    const model = table("wide");
    model.columns = Array.from({ length: 100 }, (_, index) => ({
      name: `column_${index}`,
      ordinalPosition: index + 1,
      formattedType: "text",
      typeSchema: "pg_catalog",
      typeName: "text",
      nullable: true,
      defaultValue: null,
      identity: null,
      generated: false,
      comment: null,
    }));
    model.indexes = Array.from({ length: 8 }, (_, index) => ({ name: `index_${index}`, columns: ["column_0"], unique: false, primary: false, method: "btree", predicate: null, expression: null }));

    expect(estimatedTableNodeHeight(model, { maxInitialColumns: 10, indexes: "hidden" })).toBe(335);
    expect(estimatedTableNodeHeight(model, { maxInitialColumns: 10, indexes: "collapsed" })).toBe(367);
    expect(estimatedTableNodeHeight(model, { maxInitialColumns: 100, indexes: "expanded" })).toBeGreaterThan(2_800);
  });

  it("maps tables and foreign keys to React Flow elements", () => {
    const users = table("users");
    const orders = table("orders");
    orders.foreignKeys.push({
      name: "orders_user_fk",
      columns: ["user_id"],
      referencedSchema: "public",
      referencedTable: "users",
      referencedColumns: ["id"],
      onUpdate: "noAction",
      onDelete: "cascade",
      matchType: "simple",
      deferrable: false,
      initiallyDeferred: false,
    });
    const snapshot = {
      id: "snapshot",
      sourceId: "source",
      capturedAt: "2026-07-11T00:00:00Z",
      fingerprint: "fingerprint",
      database: { name: "app", databaseType: "postgreSql", version: "17" },
      schemas: [{ name: "public", tables: [users, orders], views: [], enums: [] }],
    } satisfies DatabaseSnapshot;

    const graph = buildSchemaGraph(snapshot);

    expect(graph.nodes.map((node) => node.id)).toEqual(["public.users", "public.orders"]);
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]).toMatchObject({
      source: "public.orders",
      target: "public.users",
      sourceHandle: "source:user_id:right",
      targetHandle: "target:id:left",
      data: { sourceColumn: "user_id", targetColumn: "id" },
    });
    expect(graph.nodes[0].data.referencedForeignKeyColumns).toEqual(["id"]);
  });

  it("filters tables by field name while removing dangling relationships", () => {
    const users = table("users");
    users.columns.push({
      name: "email",
      ordinalPosition: 1,
      formattedType: "text",
      typeSchema: "pg_catalog",
      typeName: "text",
      nullable: false,
      defaultValue: null,
      identity: null,
      generated: false,
      comment: null,
    });
    const orders = table("orders");
    orders.foreignKeys.push({
      name: "orders_user_fk",
      columns: ["user_id"],
      referencedSchema: "public",
      referencedTable: "users",
      referencedColumns: ["id"],
      onUpdate: "noAction",
      onDelete: "cascade",
      matchType: "simple",
      deferrable: false,
      initiallyDeferred: false,
    });
    const snapshot = {
      id: "snapshot",
      sourceId: "source",
      capturedAt: "2026-07-11T00:00:00Z",
      fingerprint: "fingerprint",
      database: { name: "app", databaseType: "postgreSql", version: "17" },
      schemas: [{ name: "public", tables: [users, orders], views: [], enums: [] }],
    } satisfies DatabaseSnapshot;

    const graph = buildSchemaGraph(snapshot, { query: "email" });

    expect(graph.nodes.map((node) => node.id)).toEqual(["public.users"]);
    expect(graph.edges).toEqual([]);
  });

  it("keeps the focused table visible even when it has no relationships", () => {
    const users = table("users");
    const auditLog = table("audit_log");
    const snapshot = {
      id: "snapshot",
      sourceId: "source",
      capturedAt: "2026-07-11T00:00:00Z",
      fingerprint: "fingerprint",
      database: { name: "app", databaseType: "postgreSql", version: "17" },
      schemas: [{ name: "public", tables: [users, auditLog], views: [], enums: [] }],
    } satisfies DatabaseSnapshot;

    const focused = buildSchemaGraph(snapshot, { focusNodeId: "public.audit_log" });
    const staleFocus = buildSchemaGraph(snapshot, { focusNodeId: "public.removed_table" });

    expect(focused.nodes.map((node) => node.id)).toEqual(["public.audit_log"]);
    expect(focused.nodes[0].style).toMatchObject({ cursor: "default" });
    expect(staleFocus.nodes.map((node) => node.id)).toEqual([
      "public.users",
      "public.audit_log",
    ]);
  });

  it("expands saved views by the configured relationship depth", () => {
    const users = table("users");
    const orders = table("orders");
    const items = table("order_items");
    orders.foreignKeys.push({
      name: "orders_user_fk",
      columns: ["user_id"],
      referencedSchema: "public",
      referencedTable: "users",
      referencedColumns: ["id"],
      onUpdate: "noAction",
      onDelete: "cascade",
      matchType: "simple",
      deferrable: false,
      initiallyDeferred: false,
    });
    items.foreignKeys.push({
      name: "items_order_fk",
      columns: ["order_id"],
      referencedSchema: "public",
      referencedTable: "orders",
      referencedColumns: ["id"],
      onUpdate: "noAction",
      onDelete: "cascade",
      matchType: "simple",
      deferrable: false,
      initiallyDeferred: false,
    });
    const snapshot = {
      id: "snapshot",
      sourceId: "source",
      capturedAt: "2026-07-11T00:00:00Z",
      fingerprint: "fingerprint",
      database: { name: "app", databaseType: "postgreSql", version: "17" },
      schemas: [{ name: "public", tables: [users, orders, items], views: [], enums: [] }],
    } satisfies DatabaseSnapshot;

    const oneHop = buildSchemaGraph(snapshot, {
      rootNodeIds: ["public.users"],
      relationshipDepth: 1,
    });
    const twoHops = buildSchemaGraph(snapshot, {
      rootNodeIds: ["public.users"],
      relationshipDepth: 2,
    });

    expect(oneHop.nodes.map((node) => node.id)).toEqual(["public.users", "public.orders"]);
    expect(twoHops.nodes.map((node) => node.id)).toEqual([
      "public.users",
      "public.orders",
      "public.order_items",
    ]);
  });

  it("keeps naming-based relationships separate from declared foreign keys", () => {
    const users = table("users");
    users.primaryKey = { name: "users_pkey", columns: ["id"] };
    const orders = table("orders");
    orders.columns.push({
      name: "user_id",
      ordinalPosition: 1,
      formattedType: "uuid",
      typeSchema: "pg_catalog",
      typeName: "uuid",
      nullable: false,
      defaultValue: null,
      identity: null,
      generated: false,
      comment: null,
    });
    const snapshot = {
      id: "snapshot",
      sourceId: "source",
      capturedAt: "2026-07-11T00:00:00Z",
      fingerprint: "fingerprint",
      database: { name: "app", databaseType: "postgreSql", version: "17" },
      schemas: [{ name: "public", tables: [users, orders], views: [], enums: [] }],
    } satisfies DatabaseSnapshot;

    const faithfulGraph = buildSchemaGraph(snapshot);
    expect(faithfulGraph.edges).toEqual([]);
    expect(faithfulGraph.physicalRelationshipCount).toBe(0);
    expect(faithfulGraph.inferredRelationshipCount).toBe(1);

    const suggestedGraph = buildSchemaGraph(snapshot, { includeInferredRelationships: true });
    expect(suggestedGraph.edges[0]).toMatchObject({
      source: "public.orders",
      target: "public.users",
      data: { relationshipKind: "inferred" },
    });
    expect(suggestedGraph.edges[0].style).toMatchObject({ strokeDasharray: "6 4" });
  });

  it("uses a shared table prefix to disambiguate inferred domain relations", () => {
    const repairOrders = table("repair_orders");
    repairOrders.primaryKey = { name: "repair_orders_pkey", columns: ["id"] };
    const tradeOrders = table("trade_orders");
    tradeOrders.primaryKey = { name: "trade_orders_pkey", columns: ["id"] };
    const items = table("repair_order_items");
    items.columns.push({
      name: "order_id", ordinalPosition: 1, formattedType: "uuid",
      typeSchema: "pg_catalog", typeName: "uuid", nullable: false,
      defaultValue: null, identity: null, generated: false, comment: null,
    });
    const snapshot = {
      id: "snapshot", sourceId: "source", capturedAt: "2026-07-11T00:00:00Z",
      fingerprint: "fingerprint",
      database: { name: "app", databaseType: "postgreSql", version: "17" },
      schemas: [{ name: "public", tables: [repairOrders, tradeOrders, items], views: [], enums: [] }],
    } satisfies DatabaseSnapshot;

    const graph = buildSchemaGraph(snapshot, { includeInferredRelationships: true });
    expect(graph.edges[0]).toMatchObject({
      source: "public.repair_order_items",
      target: "public.repair_orders",
    });
  });

  it("creates one field edge per composite foreign-key column and reorients ports", () => {
    const parents = table("parents");
    const children = table("children");
    children.foreignKeys.push({
      name: "children_parent_fk",
      columns: ["tenant_id", "parent_id"],
      referencedSchema: "public",
      referencedTable: "parents",
      referencedColumns: ["tenant_id", "id"],
      onUpdate: "noAction",
      onDelete: "cascade",
      matchType: "simple",
      deferrable: false,
      initiallyDeferred: false,
    });
    const snapshot = {
      id: "snapshot", sourceId: "source", capturedAt: "2026-07-11T00:00:00Z",
      fingerprint: "fingerprint",
      database: { name: "app", databaseType: "postgreSql", version: "17" },
      schemas: [{ name: "public", tables: [parents, children], views: [], enums: [] }],
    } satisfies DatabaseSnapshot;

    const graph = buildSchemaGraph(snapshot);
    expect(graph.physicalRelationshipCount).toBe(1);
    expect(graph.edges).toHaveLength(2);
    expect(graph.edges.map((edge) => edge.data?.targetColumn)).toEqual(["tenant_id", "id"]);

    const moved = graph.nodes.map((node) => ({
      ...node,
      position: node.id === "public.children" ? { x: 600, y: 0 } : { x: 0, y: 0 },
    }));
    const oriented = orientFieldEdges(graph.edges, moved);
    expect(oriented[0]).toMatchObject({
      sourceHandle: "source:tenant_id:left",
      targetHandle: "target:tenant_id:right",
    });
  });
});
