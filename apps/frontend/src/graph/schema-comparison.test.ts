import { describe, expect, it } from "vitest";
import { buildSchemaGraph, orientFieldEdges } from "./schema-graph";
import { diagramAfter, diagramBefore, diagramChangeSet, diagramColumn, diagramForeignKey, diagramTable } from "../test/diagram-comparison-fixture";

describe("comparison diagram", () => {
  it("restores deleted tables, columns and their incoming and outgoing connections without mutating snapshots", () => {
    const original = JSON.stringify([diagramBefore, diagramAfter]);
    const graph = buildSchemaGraph(diagramAfter, { changeSet: diagramChangeSet, beforeSnapshot: diagramBefore });
    expect(graph.nodes).toHaveLength(4);
    expect(graph.nodes.find((node) => node.id === "public.audit")?.data.changeStatus).toBe("deleted");
    expect(graph.nodes.find((node) => node.id === "public.partners")?.data.changeStatus).toBe("added");
    expect(graph.nodes.find((node) => node.id === "public.users")?.data.changeStatus).toBeUndefined();
    const orders = graph.nodes.find((node) => node.id === "public.orders");
    expect(orders?.data.columnChanges).toMatchObject({ legacy_note: "deleted", old_name: "deleted", new_name: "modified", user_id: "modified", priority: "added", id: undefined });
    expect(orders?.data.columnNotes?.new_name).toContain("Inferred rename");
    expect(orders?.data.inspectionTable?.columns.map((column) => column.name)).not.toContain("legacy_note");
    expect(graph.edges.find((edge) => edge.source === "public.audit")).toMatchObject({ target: "public.orders", data: { changeStatus: "deleted", snapshotSide: "before" } });
    expect(JSON.stringify([diagramBefore, diagramAfter])).toBe(original);
  });

  it("keeps two distinguishable versions when a same-name foreign key is replaced", () => {
    const graph = buildSchemaGraph(diagramAfter, { changeSet: diagramChangeSet, beforeSnapshot: diagramBefore, showRelationshipLabels: false });
    const versions = graph.edges.filter((edge) => edge.data?.constraintName === "orders_owner_fk");
    expect(versions).toHaveLength(2);
    expect(new Set(versions.map((edge) => edge.id)).size).toBe(2);
    expect(versions.find((edge) => edge.target === "public.users")).toMatchObject({ data: { changeStatus: "deleted", snapshotSide: "before" }, style: { strokeDasharray: "8 5" } });
    expect(versions.find((edge) => edge.target === "public.partners")).toMatchObject({ data: { changeStatus: "modified", snapshotSide: "after" } });
    expect(versions.map((edge) => typeof edge.label === "string" ? edge.label : "").join(" ")).toMatch(/Before.*After|After.*Before/);
    expect(orientFieldEdges(graph.edges, graph.nodes).map((edge) => edge.id)).toEqual(graph.edges.map((edge) => edge.id));
  });

  it("reveals changed fields and relationship endpoints even beyond the configured column cap", () => {
    const graph = buildSchemaGraph(diagramAfter, { changeSet: diagramChangeSet, beforeSnapshot: diagramBefore, maxInitialColumns: 1 });
    const orders = graph.nodes.find((node) => node.id === "public.orders");
    expect(orders?.data.visibleColumnNames).toEqual(expect.arrayContaining(["id", "legacy_note", "old_name", "new_name", "user_id", "priority"]));
    expect(Number(orders?.style?.height)).toBeGreaterThan(180);
    for (const edge of graph.edges) {
      expect(graph.nodes.find((node) => node.id === edge.source)?.data.visibleColumnNames).toContain(edge.data?.sourceColumn);
      expect(graph.nodes.find((node) => node.id === edge.target)?.data.visibleColumnNames).toContain(edge.data?.targetColumn);
    }
  });

  it("separates old and new lanes when only referential actions change", () => {
    const before = diagramBefore.schemas[0].tables.find((table) => table.key.name === "orders")!;
    const after = { ...diagramAfter, schemas: [{ ...diagramAfter.schemas[0], tables: diagramAfter.schemas[0].tables.map((table) =>
      table.key.name === "orders" ? { ...table, foreignKeys: [{ ...before.foreignKeys[0], onDelete: "restrict" }] } : table) }] };
    const graph = buildSchemaGraph(after, { changeSet: diagramChangeSet, beforeSnapshot: diagramBefore });
    const versions = graph.edges.filter((edge) => edge.data?.constraintName === "orders_owner_fk");
    expect(versions).toHaveLength(2);
    expect(versions.every((edge) => edge.target === "public.users" && edge.type === "comparison")).toBe(true);
    expect(versions.find((edge) => edge.data?.snapshotSide === "before")?.data).toMatchObject({ comparisonOffset: -12, onDelete: before.foreignKeys[0].onDelete });
    expect(versions.find((edge) => edge.data?.snapshotSide === "after")?.data).toMatchObject({ comparisonOffset: 12, onDelete: "restrict" });
  });

  it("keeps deleted neighbors reachable in table focus and saved views", () => {
    const options = { changeSet: diagramChangeSet, beforeSnapshot: diagramBefore };
    expect(buildSchemaGraph(diagramAfter, { ...options, focusNodeId: "public.audit" }).nodes.map((node) => node.id)).toContain("public.orders");
    expect(buildSchemaGraph(diagramAfter, { ...options, rootNodeIds: ["public.orders"], relationshipDepth: 1 }).nodes.map((node) => node.id)).toContain("public.audit");
    expect(buildSchemaGraph(diagramAfter, { ...options, query: "legacy_note" }).nodes.map((node) => node.id)).toEqual(["public.orders"]);
  });

  it("does not reconstruct ghosts from an unrelated baseline or from summaries", () => {
    for (const beforeSnapshot of [undefined, { ...diagramBefore, id: "unrelated" }]) {
      const graph = buildSchemaGraph(diagramAfter, { changeSet: diagramChangeSet, beforeSnapshot });
      expect(graph.nodes.map((node) => node.id)).not.toContain("public.audit");
      expect(graph.edges.every((edge) => edge.data?.snapshotSide !== "before")).toBe(true);
    }
  });

  it("uses comparison direction rather than capture dates to determine deletion", () => {
    const reverse = { ...diagramChangeSet, id: "reverse", beforeSnapshotId: diagramAfter.id, afterSnapshotId: diagramBefore.id, operations: [] };
    const graph = buildSchemaGraph(diagramBefore, { changeSet: reverse, beforeSnapshot: diagramAfter });
    expect(graph.nodes.find((node) => node.id === "public.partners")?.data.changeStatus).toBe("deleted");
    expect(graph.nodes.find((node) => node.id === "public.audit")?.data.changeStatus).toBe("added");
    expect(graph.nodes.find((node) => node.id === "public.orders")?.data.columnChanges?.priority).toBe("deleted");
  });

  it("does not infer relationships using historical fields or deleted tables", () => {
    const before = { ...diagramBefore, schemas: [{ ...diagramBefore.schemas[0], tables: [diagramTable("users"), diagramTable("orders", [diagramColumn("id"), diagramColumn("user_id", 2)])] }] };
    const after = { ...diagramAfter, schemas: [{ ...diagramAfter.schemas[0], tables: [diagramTable("orders")]}] };
    const graph = buildSchemaGraph(after, { changeSet: diagramChangeSet, beforeSnapshot: before, includeInferredRelationships: true });
    expect(graph.inferredRelationshipCount).toBe(0);
    expect(graph.edges).toHaveLength(0);
    expect(graph.nodes.find((node) => node.id === "public.orders")?.data.columnChanges?.user_id).toBe("deleted");
  });

  it("preserves every member of a deleted composite foreign key", () => {
    const parent = diagramTable("parent", [diagramColumn("id"), diagramColumn("tenant_id", 2)]);
    const child = diagramTable("child", [diagramColumn("id"), diagramColumn("tenant_id", 2), diagramColumn("parent_id", 3)]);
    child.foreignKeys = [{ ...diagramForeignKey("child_fk", "parent_id", "parent"), columns: ["tenant_id", "parent_id"], referencedColumns: ["tenant_id", "id"] }];
    const before = { ...diagramBefore, schemas: [{ ...diagramBefore.schemas[0], tables: [parent, child] }] };
    const after = { ...diagramAfter, schemas: [{ ...diagramAfter.schemas[0], tables: [parent, { ...child, foreignKeys: [], columns: [diagramColumn("id")] }] }] };
    const graph = buildSchemaGraph(after, { beforeSnapshot: before, changeSet: { ...diagramChangeSet, operations: [] }, maxInitialColumns: 1 });
    expect(graph.physicalRelationshipCount).toBe(1);
    expect(graph.edges).toHaveLength(2);
    expect(graph.edges.every((edge) => edge.data?.changeStatus === "deleted")).toBe(true);
  });

  it("leaves the ordinary After diagram free of comparison objects", () => {
    const graph = buildSchemaGraph(diagramAfter, { beforeSnapshot: diagramBefore });
    expect(graph.nodes).toHaveLength(3);
    expect(graph.nodes.every((node) => node.data.changeStatus === undefined)).toBe(true);
    expect(graph.nodes.find((node) => node.id === "public.orders")?.data.table.columns.map((column) => column.name)).not.toContain("legacy_note");
    expect(graph.edges).toHaveLength(1);
  });

  it("keeps ordinary diagram relationship ports visible when other fields are collapsed", () => {
    const graph = buildSchemaGraph(diagramAfter, { maxInitialColumns: 1 });
    expect(graph.nodes.find((node) => node.id === "public.orders")?.data.visibleColumnNames).toEqual(["id", "user_id"]);
    expect(graph.nodes.find((node) => node.id === "public.orders")?.data.visibleColumnNames).not.toContain("priority");
    expect(graph.nodes.find((node) => node.id === "public.partners")?.data.visibleColumnNames).toContain("id");
    expect(graph.edges).toHaveLength(1);
  });
});
