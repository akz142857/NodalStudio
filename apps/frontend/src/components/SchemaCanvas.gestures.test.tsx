import { canvasToolButton } from "../test/canvas-tools";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactFlowProps } from "@xyflow/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FieldEdge, TableNode } from "../graph/schema-graph";
import { defaultAppSettings } from "../platform";
import { reportSemantics, reportSnapshot } from "../test/schema-report-fixture";
import { SchemaCanvas, type SchemaCanvasProps } from "./SchemaCanvas";

// Keep the real React Flow store/rendering; capture its public gesture callbacks
// to reproduce multi-event drags and resizes deterministically in jsdom.
const flow = vi.hoisted(() => ({ props: undefined as ReactFlowProps<TableNode, FieldEdge> | undefined }));
vi.mock("@xyflow/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@xyflow/react")>();
  const { forwardRef } = await import("react");
  return { ...actual, ReactFlow: forwardRef<HTMLDivElement, ReactFlowProps<TableNode, FieldEdge>>((props, ref) => {
    flow.props = props;
    return <actual.ReactFlow {...props} ref={ref} />;
  }) };
});
vi.mock("../graph/elk-layout", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../graph/elk-layout")>();
  return { ...actual, layoutSchemaGraph: (nodes: TableNode[]) => Promise.resolve(nodes) };
});
const positions = {
  "public.customers": { x: 0, y: 100, width: 280, height: 200 },
  "public.orders": { x: 400, y: 300, width: 320, height: 290 },
  "archive.orders": { x: 800, y: 500, width: 280, height: 200 },
};

async function mount() {
  const save = vi.fn<NonNullable<SchemaCanvasProps["onSaveLayout"]>>().mockResolvedValue(undefined);
  const { container } = render(<div style={{ width: 1200, height: 700 }}><SchemaCanvas snapshot={reportSnapshot} semantics={{ ...reportSemantics, layout: { sourceId: reportSnapshot.sourceId, viewId: null, positions, updatedAt: "now" } }} query="" canvasSettings={defaultAppSettings().canvas} runtimeKind="desktop" onSelectTable={() => {}} onSaveLayout={save} /></div>);
  await waitFor(() => expect(screen.getByRole("button", { name: "Export SVG" })).toBeEnabled());
  return { save, container };
}

describe("Diagram geometry gestures", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal("DOMMatrixReadOnly", class { m22 = 1; });
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1200);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(700);
    localStorage.clear();
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("coalesces a continuous multi-table drag and clears stale dragging flags before undo", async () => {
    const { container, save } = await mount();
    fireEvent.click(container.querySelector('.react-flow__node[data-id="public.orders"]')!);
    fireEvent.click(container.querySelector('.react-flow__node[data-id="archive.orders"]')!, { shiftKey: true });
    act(() => { flow.props!.onNodeDragStart!(new MouseEvent("mousedown"), flow.props!.nodes![1], flow.props!.nodes!); });
    for (const offset of [10, 30, 100]) act(() => {
      flow.props!.onNodesChange!(["public.orders", "archive.orders"].map((id) => ({ id, type: "position", position: { x: positions[id as keyof typeof positions].x + offset, y: positions[id as keyof typeof positions].y + offset }, dragging: true })));
    });
    expect(screen.getByRole("button", { name: "Undo layout" })).toBeDisabled();
    act(() => { flow.props!.onNodeDragStop!(new MouseEvent("mouseup"), flow.props!.nodes![1], flow.props!.nodes!); });
    await waitFor(() => expect(screen.getByRole("button", { name: "Undo layout" })).toBeEnabled());
    expect(flow.props!.nodes!.some((node) => node.dragging)).toBe(false);
    expect(flow.props!.nodes!.find((node) => node.id === "public.orders")!.position).toEqual({ x: 500, y: 400 });
    fireEvent.click(screen.getByRole("button", { name: "Undo layout" }));
    expect(flow.props!.nodes!.find((node) => node.id === "public.orders")!.position).toEqual({ x: 400, y: 300 });
    expect(screen.getByRole("button", { name: "Undo layout" })).toBeDisabled();
    expect(screen.getByText("2 tables selected")).toBeVisible();
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save.mock.calls[1][0]).toMatchObject(positions);
    fireEvent.click(screen.getByRole("button", { name: "Redo layout" }));
    expect(flow.props!.nodes!.find((node) => node.id === "archive.orders")!.position).toEqual({ x: 900, y: 600 });
  });

  it("coalesces resize frames, restoring left-edge position and actual persisted dimensions", async () => {
    const { container, save } = await mount();
    fireEvent.click(container.querySelector('.react-flow__node[data-id="public.orders"]')!);
    for (const width of [360, 400, 500]) act(() => {
      flow.props!.onNodesChange!([
        { id: "public.orders", type: "position", position: { x: 720 - width, y: 300 } },
        { id: "public.orders", type: "dimensions", dimensions: { width, height: 350 }, resizing: true, setAttributes: true },
      ]);
    });
    expect(screen.getByRole("button", { name: "Undo layout" })).toBeDisabled();
    act(() => { flow.props!.onNodesChange!([{ id: "public.orders", type: "dimensions", resizing: false }]); });
    await waitFor(() => expect(screen.getByRole("button", { name: "Undo layout" })).toBeEnabled());
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0][0]["public.orders"]).toEqual({ x: 220, y: 300, width: 500, height: 350 });
    fireEvent.click(screen.getByRole("button", { name: "Undo layout" }));
    expect(screen.getByRole("button", { name: "Undo layout" })).toBeDisabled();
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save.mock.calls[1][0]["public.orders"]).toEqual(positions["public.orders"]);
    expect(flow.props!.nodes!.find((node) => node.id === "public.orders")!).toMatchObject({ style: { width: 320, height: 290 }, measured: { width: 320, height: 290 } });
    fireEvent.click(screen.getByRole("button", { name: "Redo layout" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(3));
    expect(save.mock.calls[2][0]["public.orders"]).toEqual({ x: 220, y: 300, width: 500, height: 350 });
  });

  it("rejects fixed-card gesture frames while moving the remaining selection normally", async () => {
    const { container, save } = await mount();
    fireEvent.click(container.querySelector('.react-flow__node[data-id="public.orders"]')!);
    fireEvent.click(canvasToolButton("Fix table positions"));
    fireEvent.click(container.querySelector('.react-flow__node[data-id="archive.orders"]')!, { shiftKey: true });
    act(() => { flow.props!.onNodeDragStart!(new MouseEvent("mousedown"), flow.props!.nodes![2], flow.props!.nodes!); });
    act(() => { flow.props!.onNodesChange!([
      { id: "public.orders", type: "position", position: { x: 900, y: 900 }, dragging: true },
      { id: "archive.orders", type: "position", position: { x: 900, y: 600 }, dragging: true },
      { id: "public.orders", type: "dimensions", dimensions: { width: 700, height: 700 }, resizing: true, setAttributes: true },
    ]); });
    act(() => { flow.props!.onNodeDragStop!(new MouseEvent("mouseup"), flow.props!.nodes![2], flow.props!.nodes!); });
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save.mock.calls[1][0]["public.orders"]).toEqual({ ...positions["public.orders"], pinned: true });
    expect(save.mock.calls[1][0]["archive.orders"]).toEqual({ ...positions["archive.orders"], x: 900, y: 600 });
    fireEvent.click(screen.getByRole("button", { name: "Undo layout" }));
    expect(flow.props!.nodes!.find((node) => node.id === "public.orders")!).toMatchObject({ position: { x: 400, y: 300 }, data: { layoutPinned: true } });
    expect(flow.props!.nodes!.find((node) => node.id === "archive.orders")!.position).toEqual({ x: 800, y: 500 });
  });

});
