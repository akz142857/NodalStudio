import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setTablePinned } from "./table-position";
import type { TableNode } from "./schema-graph";
import { restoreOrExtendLayout, applyStoredPositions, layoutSchemaGraph, layoutSelectedSchemaGraph, persistLayout, restoreLayout, serializeCanvasLayout } from "./elk-layout";

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

  it("rejects malformed or non-finite positions instead of rendering an invalid layout", () => {
    const nodes = [node("orders", 0, 0)];
    expect(applyStoredPositions(nodes, { orders: { x: NaN, y: 1 } })).toBeNull();
    expect(applyStoredPositions(nodes, { orders: { x: 1, y: Infinity } })).toBeNull();
    localStorage.setItem("nodalstudio:layout:invalid", '{"orders":{"x":null,"y":2}}');
    expect(restoreLayout("invalid", nodes)).toBeNull();
  });
});


describe("scoped automatic layout", () => {
  it("extends an old layout without moving or pinning its unpinned nodes", async () => {
    const positions = { old: { x: 812, y: 217, width: 320, height: 200 }, fixed: { x: 100, y: 50, pinned: true } };
    const result = await restoreOrExtendLayout([node("old", 0, 0), node("fixed", 0, 0), node("new", 0, 0)], [], positions);
    expect(result[0]).toMatchObject({ position: { x: 812, y: 217 }, style: { width: 320, height: 200 } });
    expect(result[0].data.layoutPinned).toBeUndefined();
    expect(result[1]).toMatchObject({ position: { x: 100, y: 50 }, data: { layoutPinned: true } });
    expect(requests[0].nodes.map((item) => item.id)).toEqual(["new"]);
    expect(result[2].position.x).toBeGreaterThanOrEqual(450);
  });

  const requests: { nodes: { id: string; width: number; height: number }[]; edges: { id: string; source: string; target: string }[] }[] = [];
  const terminate = vi.fn();
  beforeEach(() => {
    requests.length = 0; terminate.mockClear();
    vi.stubGlobal("Worker", class {
      onmessage?: (event: { data: unknown }) => void;
      postMessage(request: typeof requests[number]) {
        requests.push(request);
        queueMicrotask(() => this.onmessage?.({ data: { positions: Object.fromEntries(request.nodes.map((item, i) => [item.id, { x: i * 400, y: 0 }])) } }));
      }
      terminate = terminate;
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("sends only selected movable nodes and induced relations to the worker, retaining all other state", async () => {
    const nodes = [node("a", -400, -200), node("b", -100, 200), node("c", 5000, 0), setTablePinned(node("d", 8000, 0), true)].map((item, i) => ({ ...item, selected: i !== 2 }));
    const edges = [{ id: "ab", source: "a", target: "b" }, { id: "bc", source: "b", target: "c" }, { id: "bd", source: "b", target: "d" }];
    const result = await layoutSelectedSchemaGraph(nodes, edges);
    expect(requests[0].nodes.map((item) => item.id)).toEqual(["a", "b"]);
    expect(requests[0].edges.map((item) => item.id)).toEqual(["ab"]);
    expect(result.map((item) => item.position)).toEqual([{ x: -400, y: -200 }, { x: 0, y: -200 }, nodes[2].position, nodes[3].position]);
    expect(result[2]).toBe(nodes[2]); expect(result[3]).toBe(nodes[3]);
    expect(result[0].data).toBe(nodes[0].data);
    expect(result.every((item, i) => item.selected === nodes[i].selected)).toBe(true);
    expect(nodes[1].position).toEqual({ x: -100, y: 200 });
    expect(terminate).toHaveBeenCalledOnce();
  });

  it.each(["leftToRight", "topToBottom"] as const)("avoids stationary cards using actual bounds in %s layouts", async (direction) => {
    const nodes = [{ ...node("a", 0, 0), selected: true }, { ...node("b", 100, 0), selected: true }, { ...node("obstacle", 350, -50), measured: { width: 600, height: 400 } }];
    const result = await layoutSelectedSchemaGraph(nodes, [], { direction, nodeSpacing: 70 });
    expect(result[2]).toBe(nodes[2]);
    if (direction === "leftToRight") expect(result[0].position).toEqual({ x: 1020, y: 0 });
    else expect(result[0].position).toEqual({ x: 0, y: 420 });
    expect(result[1].position.x - result[0].position.x).toBe(400);
  });

  it("clears multiple successive obstacles without creating card overlaps", async () => {
    const moving = { ...node("a", 0, 0), selected: true };
    const obstacles = [node("b", 100, 0), node("c", 450, 0), node("d", 800, 0)];
    const result = await layoutSelectedSchemaGraph([moving, ...obstacles], [], { nodeSpacing: 70 });
    expect(result[0].position).toEqual({ x: 1150, y: 0 });
    expect(result.slice(1)).toEqual(obstacles);
  });

  it("keeps fixed positions and dimensions in full auto layout and skips worker creation when all are fixed", async () => {
    const fixed = setTablePinned({ ...node("fixed", 0, 0), measured: { width: 540, height: 360 } }, true);
    const result = await layoutSchemaGraph([fixed, node("moving", 2000, 1000)], []);
    expect(requests[0].nodes.map((item) => item.id)).toEqual(["moving"]);
    expect(result[0]).toBe(fixed);
    expect(result[1].position).toEqual({ x: 610, y: 0 });
    const nodes = [fixed];
    expect(await layoutSchemaGraph(nodes, [])).toBe(nodes);
    expect(await layoutSelectedSchemaGraph(nodes, [])).toBe(nodes);
    expect(requests).toHaveLength(1);
  });

  it("round trips fixed flags and unlocks legacy position-only layouts", () => {
    const pinned = setTablePinned(node("a", 10, 20), true);
    persistLayout("pinned", [pinned]);
    expect(serializeCanvasLayout([pinned]).a.pinned).toBe(true);
    expect(restoreLayout("pinned", [node("a", 0, 0)])![0]).toMatchObject({ draggable: false, data: { layoutPinned: true }, position: { x: 10, y: 20 } });
    expect(applyStoredPositions([pinned], { a: { x: 1, y: 2 } })![0]).toMatchObject({ draggable: undefined, data: { layoutPinned: undefined } });
    expect(applyStoredPositions([node("a", 0, 0)], { a: { x: 1, y: 2, pinned: "true" as unknown as boolean } })![0].data.layoutPinned).toBeUndefined();
  });

  it("rejects worker failures without changing input and always releases its worker", async () => {
    vi.stubGlobal("Worker", class {
      onmessage?: (event: { data: unknown }) => void;
      postMessage() { queueMicrotask(() => this.onmessage?.({ data: { error: "ELK failed" } })); }
      terminate = terminate;
    });
    const nodes = [{ ...node("a", 10, 20), selected: true }];
    await expect(layoutSelectedSchemaGraph(nodes, [])).rejects.toThrow("ELK failed");
    expect(nodes[0].position).toEqual({ x: 10, y: 20 });
    expect(terminate).toHaveBeenCalledOnce();
  });
});
