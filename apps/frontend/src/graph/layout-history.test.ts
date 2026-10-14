import { pinSelectedTables } from "./table-position";
import { describe, expect, it } from "vitest";
import { captureLayoutFrame, DiagramLayoutHistory } from "./layout-history";
import { buildSchemaGraph, type TableNode } from "./schema-graph";
import { reportSnapshot } from "../test/schema-report-fixture";
import { serializeCanvasLayout } from "./elk-layout";

const fixture = (): TableNode[] => buildSchemaGraph(reportSnapshot).nodes.map((node, i) => ({ ...node, position: { x: i * 300, y: 100 }, style: { width: 280, height: 200 } }));

describe("diagram layout history", () => {
  it("undoes and redoes compound moves as one edit, preserving current selection, metadata and unaffected nodes", () => {
    const nodes = fixture();
    const moved = nodes.map((node, i) => i < 2 ? { ...node, position: { x: node.position.x + 100, y: 50 } } : node);
    const history = new DiagramLayoutHistory();
    expect(history.record(captureLayoutFrame(nodes), captureLayoutFrame(moved), "Move tables")).toBe(true);
    const current = moved.map((node) => ({ ...node, selected: true, data: { ...node.data, domainColor: "#ff0000" } }));
    const undone = history.undo(current)!;
    expect(undone.nodes.map((node) => node.position)).toEqual(nodes.map((node) => node.position));
    expect(undone.nodes.every((node) => node.selected && node.data.domainColor === "#ff0000")).toBe(true);
    expect(undone.nodes[2]).toBe(current[2]);
    expect(history.undoLabel).toBeUndefined();
    expect(history.redoLabel).toBe("Move tables");
    expect(history.redo(undone.nodes)!.nodes.map((node) => node.position)).toEqual(moved.map((node) => node.position));
    expect(history.redoLabel).toBeUndefined();
  });

  it("restores resized dimensions in style, explicit and measured values used by layout persistence", () => {
    const nodes = fixture();
    const resized = nodes.map((node, i) => i === 0 ? { ...node, position: { x: -30, y: 80 }, width: 540, height: 360, measured: { width: 540, height: 360 }, style: { width: 540, height: 360 } } : node);
    const history = new DiagramLayoutHistory();
    history.record(captureLayoutFrame(nodes), captureLayoutFrame(resized), "Resize table");
    const undone = history.undo(resized)!.nodes;
    expect(undone[0]).toMatchObject({ position: { x: 0, y: 100 }, style: { width: 280, height: 200 }, measured: { width: 280, height: 200 }, width: 280, height: 200 });
    expect(serializeCanvasLayout(undone)[undone[0].id]).toEqual({ x: 0, y: 100, width: 280, height: 200 });
    expect(history.redo(undone)!.nodes[0]).toMatchObject({ measured: { width: 540, height: 360 }, position: { x: -30, y: 80 } });
  });

  it("does not restore geometry properties that were not changed by the edit", () => {
    const nodes = fixture();
    const moved = nodes.map((node) => ({ ...node, position: { ...node.position, x: 0 } }));
    const history = new DiagramLayoutHistory();
    history.record(captureLayoutFrame(nodes), captureLayoutFrame(moved), "Align left");
    const measured = moved.map((node) => ({ ...node, measured: { width: 400, height: 250 }, position: { ...node.position, y: 900 } }));
    const result = history.undo(measured)!.nodes;
    expect(result.map((node) => node.position.x)).toEqual(nodes.map((node) => node.position.x));
    expect(result.every((node) => node.position.y === 900 && node.measured?.width === 400 && node.measured.height === 250)).toBe(true);
  });

  it("keeps redo for no-op actions, but discards it when a real new edit branches from an undo", () => {
    const history = new DiagramLayoutHistory();
    const nodes = fixture();
    const moved = nodes.map((node) => ({ ...node, position: { ...node.position, y: 300 } }));
    history.record(captureLayoutFrame(nodes), captureLayoutFrame(moved), "Move tables");
    history.undo(moved);
    expect(history.record(captureLayoutFrame(nodes), captureLayoutFrame(nodes), "Align top")).toBe(false);
    expect(history.redoLabel).toBe("Move tables");
    history.record(captureLayoutFrame(nodes), captureLayoutFrame(moved), "Auto layout");
    expect(history.redoLabel).toBeUndefined();
    expect(history.undoLabel).toBe("Auto layout");
  });

  it("undoes fixed states independently of geometry, retaining metadata and selection", () => {
    const nodes = fixture().map((node, i) => ({ ...node, selected: i < 2 }));
    const pinned = pinSelectedTables(nodes, true);
    expect(pinned[2]).toBe(nodes[2]);
    const history = new DiagramLayoutHistory();
    history.record(captureLayoutFrame(nodes), captureLayoutFrame(pinned), "Fix table positions");
    const current = pinned.map((node) => ({ ...node, data: { ...node.data, domainColor: "red" }, position: { x: 1000, y: 2000 } }));
    const undone = history.undo(current)!.nodes;
    expect(undone.every((node) => !node.data.layoutPinned && node.draggable !== false)).toBe(true);
    expect(undone.every((node) => node.data.domainColor === "red" && node.position.x === 1000)).toBe(true);
    const redone = history.redo(undone)!.nodes;
    expect(redone.slice(0, 2).every((node) => node.data.layoutPinned && node.draggable === false && node.selected)).toBe(true);
    expect(serializeCanvasLayout(redone)[redone[0].id].pinned).toBe(true);
    expect(history.record(captureLayoutFrame(redone), captureLayoutFrame(pinSelectedTables(redone, true)), "Fix again")).toBe(false);
  });

  it("bounds memory, orders undo/redo and clears on incompatible node sets", () => {
    const history = new DiagramLayoutHistory(2);
    let nodes = fixture();
    for (let i = 1; i <= 3; i++) {
      const next = nodes.map((node) => ({ ...node, position: { x: i, y: 100 } }));
      history.record(captureLayoutFrame(nodes), captureLayoutFrame(next), `Move ${i}`); nodes = next;
    }
    nodes = history.undo(nodes)!.nodes;
    expect(history.redoLabel).toBe("Move 3");
    nodes = history.undo(nodes)!.nodes;
    expect(nodes[0].position.x).toBe(1);
    expect(history.undo(nodes)).toBeNull();
    expect(history.redo(nodes)!.label).toBe("Move 2");
    history.clear();
    expect(history.undoLabel).toBeUndefined();
    expect(history.redoLabel).toBeUndefined();
    history.record(captureLayoutFrame(fixture()), captureLayoutFrame(nodes), "Move");
    expect(history.undo([])).toBeNull();
    expect(history.undoLabel).toBeUndefined();
    expect(history.record(captureLayoutFrame(fixture()), {}, "Different model")).toBe(false);
  });
});
