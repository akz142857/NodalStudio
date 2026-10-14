import { describe, expect, it } from "vitest";
import { buildSchemaGraph } from "./schema-graph";
import { domainMembershipAddition, retainTableSelection, selectedCurrentTableKeys } from "./table-selection";
import { reportSemantics, reportSnapshot } from "../test/schema-report-fixture";
import { diagramAfter, diagramBefore, diagramChangeSet } from "../test/diagram-comparison-fixture";

describe("table selection and domain membership", () => {
  it("appends distinct qualified tables while preserving existing and orphaned members and domain metadata", () => {
    const group = { ...reportSemantics.domainGroups[0], tableKeys: [reportSnapshot.schemas[0].tables[0].key, { kind: "table", schema: "removed", name: "legacy" }] };
    const selected = [reportSnapshot.schemas[0].tables[1].key, reportSnapshot.schemas[1].tables[0].key, reportSnapshot.schemas[0].tables[1].key, group.tableKeys[0]];
    const before = JSON.stringify([group, selected]);
    const addition = domainMembershipAddition(reportSnapshot, group, selected);
    expect(addition.input).toEqual({ id: group.id, sourceId: group.sourceId, name: group.name, description: group.description, color: group.color, tableKeys: [...group.tableKeys, selected[0], selected[1]] });
    expect(addition.addedCount).toBe(2); expect(addition.alreadyMemberCount).toBe(1);
    expect(JSON.stringify([group, selected])).toBe(before);
    expect(domainMembershipAddition(reportSnapshot, group, [group.tableKeys[0]]).addedCount).toBe(0);
  });

  it("rejects foreign domains, removed tables and non-table keys", () => {
    const group = reportSemantics.domainGroups[0];
    expect(() => domainMembershipAddition(reportSnapshot, { ...group, sourceId: "other" }, [group.tableKeys[0]])).toThrow("another data source");
    for (const key of [{ kind: "column", schema: "public.orders", name: "id" }, { kind: "table", schema: "missing", name: "orders" }]) {
      expect(() => domainMembershipAddition(reportSnapshot, group, [key])).toThrow("no longer present");
    }
  });

  it("excludes deleted comparison ghosts from current semantic keys", () => {
    const nodes = buildSchemaGraph(diagramAfter, { beforeSnapshot: diagramBefore, changeSet: diagramChangeSet }).nodes.map((node) => ({ ...node, selected: true }));
    expect(nodes.some((node) => node.data.changeStatus === "deleted")).toBe(true);
    expect(selectedCurrentTableKeys(nodes, diagramAfter).map((key) => key.name)).toEqual(["users", "orders", "partners"]);
  });

  it("retains selection only for nodes still visible and never changes layout positions", () => {
    const nodes = buildSchemaGraph(reportSnapshot).nodes;
    const selected = nodes.map((node) => ({ ...node, selected: true }));
    const filtered = buildSchemaGraph(reportSnapshot, { query: "archive" }).nodes;
    const kept = retainTableSelection(filtered, selected);
    expect(kept).toHaveLength(1); expect(kept[0].selected).toBe(true);
    expect(kept[0].position).toEqual(filtered[0].position);
    expect(retainTableSelection(nodes, kept).filter((node) => node.selected).map((node) => node.id)).toEqual(["archive.orders"]);
    expect(retainTableSelection(nodes, []).every((node) => !node.selected)).toBe(true);
  });
});
