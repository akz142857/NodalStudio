import { describe, expect, it } from "vitest";
import type { TableNode } from "./schema-graph";
import { applyStoredPositions, persistLayout, restoreLayout, serializeCanvasLayout } from "./elk-layout";

function node(id: string, x: number, y: number): TableNode {
  return {
    id,
    type: "table",
    position: { x, y },
    data: {
      schema: "public",
      table: {
        key: { kind: "table", schema: "public", name: id },
        tableKind: "ordinary",
        columns: [],
        primaryKey: null,
        foreignKeys: [],
        indexes: [],
        constraints: [],
        comment: null,
      },
    },
  };
}

describe("layout persistence", () => {
  it("restores positions only when every current node is present", () => {
    const nodes = [node("users", 10, 20), node("orders", 30, 40)];
    persistLayout("fingerprint", nodes);

    expect(restoreLayout("fingerprint", [node("users", 0, 0), node("orders", 0, 0)])).toEqual(
      nodes.map((item) => ({ ...item, style: { width: 280, height: 120 } })),
    );
    expect(restoreLayout("fingerprint", [...nodes, node("payments", 0, 0)])).toBeNull();
  });

  it("persists an independently resized table width and height", () => {
    const resized = {
      ...node("orders", 15, 25),
      measured: { width: 540, height: 360 },
      style: { width: 540, height: 360 },
    };

    persistLayout("resized", [resized]);

    expect(restoreLayout("resized", [node("orders", 0, 0)])).toMatchObject([{
      id: "orders",
      position: { x: 15, y: 25 },
      style: { width: 540, height: 360 },
    }]);
  });

  it("restores remotely stored dimensions while remaining compatible with position-only layouts", () => {
    expect(applyStoredPositions([node("orders", 0, 0)], {
      orders: { x: 15, y: 25, width: 540, height: 360 },
    })).toMatchObject([{
      position: { x: 15, y: 25 },
      style: { width: 540, height: 360 },
    }]);

    expect(applyStoredPositions([node("orders", 0, 0)], {
      orders: { x: 15, y: 25 },
    })).toMatchObject([{
      position: { x: 15, y: 25 },
      style: { width: 280, height: 120 },
    }]);
  });

  it("serializes the current position and measured dimensions for persistence", () => {
    const resized = {
      ...node("orders", 15, 25),
      measured: { width: 540, height: 360 },
    };

    expect(serializeCanvasLayout([resized])).toEqual({
      orders: { x: 15, y: 25, width: 540, height: 360 },
    });
  });
});
