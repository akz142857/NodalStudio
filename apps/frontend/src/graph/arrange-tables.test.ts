import { describe, expect, it } from "vitest";
import { buildSchemaGraph, type TableNode } from "./schema-graph";
import { reportSnapshot } from "../test/schema-report-fixture";
import { arrangeTables, type TableArrangement } from "./arrange-tables";

function fixture() {
  const nodes = buildSchemaGraph(reportSnapshot).nodes;
  return nodes.map((node, i) => ({ ...node, selected: true,
    position: [{ x: -100, y: -50 }, { x: 200, y: 150 }, { x: 700, y: 450 }][i],
    measured: [{ width: 100, height: 60 }, { width: 200, height: 100 }, { width: 50, height: 80 }][i],
  }));
}

describe("arrange selected tables", () => {
  it.each<[TableArrangement, "x" | "y", number[]]>([
    ["left", "x", [-100, -100, -100]], ["center-x", "x", [275, 225, 300]], ["right", "x", [650, 550, 700]],
    ["top", "y", [-50, -50, -50]], ["center-y", "y", [210, 190, 200]], ["bottom", "y", [470, 430, 450]],
    ["distribute-x", "x", [-100, 250, 700]], ["distribute-y", "y", [-50, 180, 450]],
  ])("%s uses actual bounds, retaining the other axis and selection", (action, axis, expected) => {
    const nodes = fixture();
    const original = structuredClone(nodes);
    const result = arrangeTables(nodes, action);
    expect(result.map((node) => node.position[axis])).toEqual(expected);
    expect(result.map((node) => node.position[axis === "x" ? "y" : "x"])).toEqual(nodes.map((node) => node.position[axis === "x" ? "y" : "x"]));
    expect(result.every((node) => node.selected)).toBe(true);
    expect(result.map((node) => node.measured)).toEqual(nodes.map((node) => node.measured));
    expect(nodes).toEqual(original);
  });

  it("retains unselected nodes by identity and does nothing with too few selected tables", () => {
    const nodes = fixture();
    nodes[2].selected = false;
    expect(arrangeTables(nodes, "left")[2]).toBe(nodes[2]);
    expect(arrangeTables(nodes, "distribute-x")).toBe(nodes);
    nodes[1].selected = false;
    expect(arrangeTables(nodes, "right")).toBe(nodes);
  });

  it("sorts by position instead of selection order and fixes both endpoints", () => {
    const nodes = fixture().reverse();
    const result = arrangeTables(nodes, "distribute-x");
    expect(result.map((node) => node.position.x)).toEqual([700, 250, -100]);
    expect(result[0]).toBe(nodes[0]);
    expect(result[2]).toBe(nodes[2]);
  });

  it("rejects insufficient space without creating overlaps or mutating tables", () => {
    const nodes = fixture().map((node, i) => ({ ...node, position: { x: i * 10, y: i * 10 } }));
    const original = structuredClone(nodes);
    expect(() => arrangeTables(nodes, "distribute-x")).toThrow("Not enough horizontal space");
    expect(() => arrangeTables(nodes, "distribute-y")).toThrow("Not enough vertical space");
    expect(nodes).toEqual(original);
  });

  it("excludes fixed tables from alignment bounds and movable-count requirements", () => {
    const nodes = fixture();
    nodes[0] = { ...nodes[0], data: { ...nodes[0].data, layoutPinned: true } };
    const result = arrangeTables(nodes, "left");
    expect(result[0]).toBe(nodes[0]);
    expect(result.map((node) => node.position.x)).toEqual([-100, 200, 200]);
    expect(arrangeTables(nodes, "distribute-x")).toBe(nodes);
    nodes[1] = { ...nodes[1], data: { ...nodes[1].data, layoutPinned: true } };
    expect(arrangeTables(nodes, "top")).toBe(nodes);
  });

  it("uses measured dimensions, explicit dimensions, style, then estimated size", () => {
    const nodes: TableNode[] = fixture().map((node) => ({ ...node, measured: undefined, style: { width: 250, height: 100 } }));
    nodes[0] = { ...nodes[0], width: 100, measured: { width: 80 } };
    nodes[1] = { ...nodes[1], width: 200 };
    expect(arrangeTables(nodes, "right").map((node) => node.position.x)).toEqual([870, 750, 700]);
    const fallback = nodes.map((node) => ({ ...node, measured: undefined, width: undefined, style: undefined }));
    expect(arrangeTables(fallback, "right").map((node) => node.position.x)).toEqual([700, 700, 700]);
  });
});
