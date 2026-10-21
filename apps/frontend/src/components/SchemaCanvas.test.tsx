import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildSchemaGraph, type TableNode as TableNodeType } from "../graph/schema-graph";
import { layoutSchemaGraph, layoutSelectedSchemaGraph } from "../graph/elk-layout";
import type { TableDefinition } from "../platform";
import { defaultAppSettings } from "../platform";
import { reportSemantics, reportSnapshot } from "../test/schema-report-fixture";
import { diagramAfter, diagramBefore, diagramChangeSet } from "../test/diagram-comparison-fixture";
import { SchemaCanvas, type SchemaCanvasProps } from "./SchemaCanvas";

vi.mock("../graph/elk-layout", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../graph/elk-layout")>();
  return { ...actual, layoutSchemaGraph: vi.fn((nodes: TableNodeType[]) => Promise.resolve(nodes)), layoutSelectedSchemaGraph: vi.fn((nodes: TableNodeType[]) => Promise.resolve(nodes)) };
});

function CanvasHarness(props: Partial<SchemaCanvasProps>) {
  const [selectedTable, setSelectedTable] = useState<TableDefinition>();
  return <div style={{ width: 1200, height: 700 }}><SchemaCanvas snapshot={reportSnapshot} semantics={reportSemantics} query="" canvasSettings={defaultAppSettings().canvas} onSelectTable={setSelectedTable} selectedTable={selectedTable} runtimeKind="desktop" {...props} /></div>;
}

function arrangementButton(name: string) {
  const menu = screen.getByRole("button", { name: "Align / distribute" });
  if (menu.getAttribute("aria-expanded") !== "true") fireEvent.click(menu);
  return screen.getByRole("button", { name });
}

describe("SchemaCanvas table selection", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal("DOMMatrixReadOnly", class { m22 = 1; });
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1200);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(700);
    localStorage.clear();
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("pans the viewport on horizontal and vertical wheel input without moving tables or changing zoom", async () => {
    const save = vi.fn();
    const { container } = render(<CanvasHarness semantics={positionedSemantics} onSaveLayout={save} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Auto layout" })).toBeEnabled());
    const pane = container.querySelector(".react-flow__pane")!;
    const viewport = container.querySelector<HTMLElement>(".react-flow__viewport")!;
    const transform = () => {
      const values = viewport.style.transform.match(/translate\(([-\d.]+)px,([-\d.]+)px\) scale\(([-\d.]+)\)/)!;
      return values.slice(1).map(Number);
    };
    const positions = Array.from(container.querySelectorAll<HTMLElement>(".react-flow__node"), (node) => node.style.transform);
    const before = transform();
    fireEvent.wheel(pane, { deltaX: 90, deltaY: 0, deltaMode: 0 });
    await waitFor(() => expect(transform()[0]).toBeCloseTo(before[0] - 90));
    expect(transform()[1]).toBeCloseTo(before[1]); expect(transform()[2]).toBe(before[2]);
    fireEvent.wheel(pane, { deltaX: -30, deltaY: 45, deltaMode: 0 });
    await waitFor(() => expect(transform()[0]).toBeCloseTo(before[0] - 60));
    expect(transform()[1]).toBeCloseTo(before[1] - 45); expect(transform()[2]).toBe(before[2]);
    // Line-mode wheel deltas from mice are normalized by the canvas library.
    fireEvent.wheel(pane, { deltaX: 2, deltaY: 0, deltaMode: 1 });
    await waitFor(() => expect(transform()[0]).toBeCloseTo(before[0] - 100));
    expect(Array.from(container.querySelectorAll<HTMLElement>(".react-flow__node"), (node) => node.style.transform)).toEqual(positions);
    expect(save).not.toHaveBeenCalled();
    // WebKit/Chromium represent trackpad pinch as a control-modified wheel event.
    fireEvent.wheel(pane, { deltaY: -30, deltaMode: 0, ctrlKey: true, clientX: 200, clientY: 200 });
    await waitFor(() => expect(transform()[2]).toBeGreaterThan(before[2]));
  });

  it("places working selection tools above the canvas, removes the floating panel and allows dismissing layout results", async () => {
    const { container } = render(<CanvasHarness runtimeKind="web" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Auto layout" })).toBeEnabled());
    const toolbar = screen.getByRole("toolbar", { name: "Diagram tools" }); const flow = container.querySelector(".schema-canvas-flow")!;
    expect(toolbar.parentElement).toBe(flow.parentElement!.parentElement);
    expect(flow.parentElement!.contains(toolbar)).toBe(false); expect(container.querySelector(".diagram-selection-actions")).toBeNull();
    expect(screen.queryByText(/Shift \/ ⌘ \/ Ctrl-click/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Box select" })); expect(screen.getByRole("button", { name: "Box select" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(container.querySelector('.react-flow__node[data-id="public.orders"]')!);
    expect(screen.queryByRole("button", { name: "Align left" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Fix table positions" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Fixed states adjusted");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss layout result" })); expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("keeps layout undo shortcuts working from the new toolbar outside the React Flow surface", async () => {
    const save = vi.fn<NonNullable<SchemaCanvasProps["onSaveLayout"]>>().mockResolvedValue(undefined);
    const { container } = render(<CanvasHarness semantics={positionedSemantics} onSaveLayout={save} />);
    await selectNodes(container, ["public.orders", "archive.orders"]);
    fireEvent.click(arrangementButton("Align left"));
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    const undo = screen.getByRole("button", { name: "Undo layout" }); undo.focus();
    fireEvent.keyDown(undo, { key: "z", metaKey: true });
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(container.querySelector('.react-flow__node[data-id="archive.orders"]')).toHaveStyle({ transform: "translate(6000px,1000px)" });
  });

  it("keeps DDL preview arrangements temporary on Desktop and blocks connection/semantic/export entry points", async () => {
    const save = vi.fn(); const add = vi.fn(); const query = vi.fn();
    const { container } = render(<CanvasHarness readOnlyPreview onSaveLayout={save} onAddTablesToDomain={add} onOpenQuery={query} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Auto layout" })).toBeEnabled());
    fireEvent.click(container.querySelector('.react-flow__node[data-id="public.orders"]')!);
    expect(screen.getByRole("button", { name: "Business domain" })).toHaveAttribute("title", expect.stringContaining("DDL previews cannot edit business semantics")); expect(screen.queryByRole("button", { name: "Export SVG" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Fix table positions" }));
    expect(save).not.toHaveBeenCalled(); expect(add).not.toHaveBeenCalled(); expect(query).not.toHaveBeenCalled(); expect(localStorage.length).toBe(0);
    expect(screen.getByRole("button", { name: /declared FKs/ })).toBeVisible();
  });

  it.each([false, true])("reports failed automatic layout and retries the same operation (selected=%s)", async (selected) => {
    const save = vi.fn();
    const { container } = render(<CanvasHarness runtimeKind="web" onSaveLayout={save} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Export SVG" })).toBeEnabled());
    fireEvent.click(container.querySelector('.react-flow__node[data-id="public.orders"]')!);
    const before = container.querySelector('.react-flow__node[data-id="public.orders"]')!.getAttribute("style");
    const layout = vi.mocked(selected ? layoutSelectedSchemaGraph : layoutSchemaGraph);
    layout.mockRejectedValueOnce(new Error("Layout worker unavailable"));
    fireEvent.click(screen.getByRole("button", { name: selected ? "Auto layout selected" : "Auto layout" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Layout worker unavailable"));
    expect(container.querySelector('.react-flow__node[data-id="public.orders"]')!.getAttribute("style")).toBe(before);
    fireEvent.click(screen.getByRole("button", { name: "Retry arrangement" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("applied for this view only"));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument(); expect(save).not.toHaveBeenCalled();
  });

  it("uses real React Flow selection for additive clicks, toggles, plain clicks and clearing without coupling inspector focus", async () => {
    const { container } = render(<CanvasHarness />);
    const node = (id: string) => container.querySelector(`.react-flow__node[data-id="${id}"]`)!;
    await waitFor(() => expect(node("public.orders")).not.toBeNull());
    fireEvent.click(node("public.orders"));
    expect(screen.getByText("1 table selected")).toBeVisible();
    fireEvent.keyDown(window, { key: "Shift", code: "ShiftLeft" });
    fireEvent.click(node("archive.orders"), { shiftKey: true });
    expect(screen.getByText("2 tables selected")).toBeVisible();
    fireEvent.click(node("public.orders"), { shiftKey: true });
    expect(screen.getByText("1 table selected")).toBeVisible();
    expect(node("public.orders").querySelector("article")?.getAttribute("data-selected")).toBeNull();
    expect(node("public.orders").querySelector("article")?.getAttribute("data-inspector-focused")).toBe("true");
    fireEvent.keyUp(window, { key: "Shift", code: "ShiftLeft" });
    fireEvent.keyDown(window, { key: "Control", code: "ControlLeft" });
    fireEvent.click(node("public.orders"), { ctrlKey: true });
    expect(screen.getByText("2 tables selected")).toBeVisible();
    fireEvent.keyUp(window, { key: "Control", code: "ControlLeft" });
    fireEvent.click(node("archive.orders"));
    expect(screen.getByText("1 table selected")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Clear selection" }));
    expect(screen.queryByText(/table[s]? selected/)).not.toBeInTheDocument();
  });

  it("retains visible selection across semantics updates, drops filtered nodes and clears on a source switch", async () => {
    const { container, rerender } = render(<CanvasHarness />);
    const node = (id: string) => container.querySelector(`.react-flow__node[data-id="${id}"]`)!;
    await waitFor(() => expect(node("public.orders")).not.toBeNull());
    fireEvent.click(node("public.orders"));
    fireEvent.keyDown(window, { key: "Meta", code: "MetaLeft" });
    fireEvent.click(node("archive.orders"), { metaKey: true });
    fireEvent.keyUp(window, { key: "Meta", code: "MetaLeft" });
    rerender(<CanvasHarness semantics={{ ...reportSemantics, annotations: [] }} />);
    await waitFor(() => expect(screen.getByText("2 tables selected")).toBeVisible());
    await act(() => new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve())));
    expect(screen.getByText("2 tables selected")).toBeVisible();
    rerender(<CanvasHarness query="archive" />);
    await waitFor(() => expect(screen.getByText("1 table selected")).toBeVisible());
    rerender(<CanvasHarness snapshot={{ ...reportSnapshot, id: "another-snapshot", sourceId: "other-source" }} />);
    await waitFor(() => expect(screen.queryByText(/table[s]? selected/)).not.toBeInTheDocument());
  });

  it("never removes physical tables through React Flow delete shortcuts", async () => {
    const { container } = render(<CanvasHarness />);
    const orders = container.querySelector('.react-flow__node[data-id="public.orders"]')!;
    await waitFor(() => expect(orders).not.toBeNull());
    fireEvent.click(orders);
    fireEvent.keyDown(window, { key: "Backspace", code: "Backspace" });
    fireEvent.keyUp(window, { key: "Backspace", code: "Backspace" });
    expect(container.querySelectorAll(".react-flow__node")).toHaveLength(3);
    expect(screen.getByText("1 table selected")).toBeVisible();
  });

  it("keeps comparison ghosts and Web diagrams out of domain editing even when a save callback is supplied", async () => {
    const save = vi.fn<NonNullable<SchemaCanvasProps["onAddTablesToDomain"]>>();
    const { container, rerender } = render(<CanvasHarness snapshot={diagramAfter} beforeSnapshot={diagramBefore} changeSet={diagramChangeSet} onAddTablesToDomain={save} />);
    const ghost = container.querySelector('.react-flow__node[data-id="public.audit"]')!;
    await waitFor(() => expect(ghost).not.toBeNull());
    fireEvent.click(ghost);
    expect(screen.getByRole("button", { name: "Business domain" })).toHaveAttribute("title", expect.stringContaining("Comparison diagrams are read only"));
    expect(screen.queryByRole("button", { name: "Add to domain" })).not.toBeInTheDocument();
    rerender(<CanvasHarness runtimeKind="web" onAddTablesToDomain={save} />);
    await waitFor(() => expect(container.querySelector('.react-flow__node[data-id="public.orders"]')).not.toBeNull());
    fireEvent.click(container.querySelector('.react-flow__node[data-id="public.orders"]')!);
    expect(screen.getByRole("button", { name: "Business domain" })).toHaveAttribute("title", "Shared diagrams are read only.");
    expect(screen.queryByRole("button", { name: "Add to domain" })).not.toBeInTheDocument();
    expect(save).not.toHaveBeenCalled();
  });

  const positions = {
    "public.customers": { x: 0, y: 100, width: 280, height: 200 },
    "public.orders": { x: 4000, y: 600, width: 280, height: 200 },
    "archive.orders": { x: 6000, y: 1000, width: 280, height: 200 },
  };
  const positionedSemantics = { ...reportSemantics, layout: { sourceId: reportSnapshot.sourceId, viewId: null, positions, updatedAt: "2026-10-13T00:00:00Z" } };

  async function selectNodes(container: HTMLElement, ids = Object.keys(positions)) {
    await waitFor(() => expect(screen.getByRole("button", { name: "Export SVG" })).toBeEnabled());
    for (const [index, id] of ids.entries()) {
      fireEvent.click(container.querySelector(`.react-flow__node[data-id="${id}"]`)!, { shiftKey: index > 0 });
    }
    if (ids.length > 1) await waitFor(() => expect(arrangementButton("Align left")).toBeEnabled());
  }

  it("aligns and distributes actual React Flow nodes, preserves selection and saves the complete layout", async () => {
    const save = vi.fn<NonNullable<SchemaCanvasProps["onSaveLayout"]>>().mockResolvedValue(undefined);
    const { container } = render(<CanvasHarness semantics={positionedSemantics} onSaveLayout={save} />);
    await selectNodes(container);
    fireEvent.click(arrangementButton("Distribute horizontally"));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0][0]).toMatchObject({
      "public.customers": { x: 0, y: 100 }, "public.orders": { x: 3000, y: 600 }, "archive.orders": { x: 6000, y: 1000 },
    });
    fireEvent.click(arrangementButton("Align left"));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(Object.keys(save.mock.calls[1][0])).toHaveLength(3);
    expect(Object.values(save.mock.calls[1][0]).every((node) => node.x === 0)).toBe(true);
    expect(container.querySelector('.react-flow__node[data-id="public.orders"]')).toHaveStyle({ transform: "translate(0px,600px)" });
    expect(screen.getByText("3 tables selected")).toBeVisible();
    expect(screen.getByText(/Layout saved on this device\./)).toBeVisible();
    expect(screen.getByRole("group", { name: "Diagram layout" })).toHaveAttribute("title", expect.stringContaining("Pan, zoom and selection are not saved"));
  });

  it.each(["search", "saved view"])("keeps %s changes temporary and restores the full layout when leaving", async (scope) => {
    const save = vi.fn<NonNullable<SchemaCanvasProps["onSaveLayout"]>>();
    const savedView = { id: "all-tables-view", sourceId: reportSnapshot.sourceId, name: "Everything", rootTableKeys: reportSnapshot.schemas.flatMap((schema) => schema.tables.map((table) => table.key)), relationshipDepth: 0, updatedAt: "now" };
    const { container, rerender } = render(<CanvasHarness semantics={positionedSemantics} onSaveLayout={save} />);
    await selectNodes(container, ["public.orders", "archive.orders"]);
    const initial = container.querySelector('.react-flow__node[data-id="public.orders"]')!.getAttribute("style");
    rerender(<CanvasHarness semantics={positionedSemantics} onSaveLayout={save} query={scope === "search" ? "orders" : ""} savedView={scope === "saved view" ? savedView : undefined} />);
    await waitFor(() => expect(arrangementButton("Align left")).toBeEnabled());
    fireEvent.click(arrangementButton("Align left"));
    expect(screen.getByText("Layout adjusted for this view only.")).toBeVisible();
    expect(save).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
    rerender(<CanvasHarness semantics={positionedSemantics} onSaveLayout={save} />);
    await waitFor(() => expect(container.querySelector('.react-flow__node[data-id="public.orders"]')!.getAttribute("style")).toBe(initial));
    expect(save).not.toHaveBeenCalled();
  });

  it("also keeps focus layouts temporary, including automatic layout", async () => {
    const save = vi.fn<NonNullable<SchemaCanvasProps["onSaveLayout"]>>();
    const { container } = render(<CanvasHarness semantics={positionedSemantics} onSaveLayout={save} />);
    await selectNodes(container, ["public.orders"]);
    fireEvent.doubleClick(container.querySelector('.react-flow__node[data-id="public.orders"]')!);
    await waitFor(() => expect(screen.getByRole("group", { name: "Diagram layout" })).toHaveAttribute("title", "Focused diagram. Layout changes are temporary."));
    await selectNodes(container, ["public.orders", "public.customers"]);
    fireEvent.click(arrangementButton("Align top"));
    act(() => { window.dispatchEvent(new Event("nodalstudio:relayout-canvas")); });
    await act(async () => {});
    expect(save).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
  });

  it.each(["web", "comparison"])("arranges %s diagrams without persisting or changing the model", async (scope) => {
    const save = vi.fn<NonNullable<SchemaCanvasProps["onSaveLayout"]>>();
    const { container } = render(<CanvasHarness semantics={positionedSemantics} onSaveLayout={save} runtimeKind={scope === "web" ? "web" : "desktop"}
      {...(scope === "comparison" ? { snapshot: diagramAfter, beforeSnapshot: diagramBefore, changeSet: diagramChangeSet } : {})} />);
    await selectNodes(container, scope === "comparison" ? ["public.orders", "public.audit"] : ["public.orders", "archive.orders"]);
    fireEvent.click(arrangementButton("Align left"));
    await act(async () => {});
    expect(screen.getByText("Layout adjusted for this view only.")).toBeVisible();
    expect(save).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
  });

  it("retains a failed arrangement's positions and retries the complete latest layout", async () => {
    const save = vi.fn<NonNullable<SchemaCanvasProps["onSaveLayout"]>>().mockRejectedValueOnce(new Error("disk unavailable")).mockResolvedValue(undefined);
    const { container } = render(<CanvasHarness semantics={positionedSemantics} onSaveLayout={save} />);
    await selectNodes(container, ["public.orders", "archive.orders"]);
    fireEvent.click(arrangementButton("Align right"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Retry layout save" })).toBeEnabled());
    expect(screen.getByRole("alert")).toHaveTextContent("disk unavailable");
    expect(Object.keys(save.mock.calls[0][0])).toHaveLength(3);
    expect(save.mock.calls[0][0]["public.customers"]).toMatchObject(positions["public.customers"]);
    fireEvent.click(screen.getByRole("button", { name: "Retry layout save" }));
    await waitFor(() => expect(screen.getByText(/Layout saved on this device\./)).toBeVisible());
    expect(save.mock.calls[1][0]).toEqual(save.mock.calls[0][0]);
  });

  it("serializes rapid layout saves and ignores stale feedback after switching sources", async () => {
    let finish!: () => void;
    const save = vi.fn<NonNullable<SchemaCanvasProps["onSaveLayout"]>>().mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; })).mockResolvedValue(undefined);
    const { container, rerender } = render(<CanvasHarness semantics={positionedSemantics} onSaveLayout={save} />);
    await selectNodes(container);
    fireEvent.click(arrangementButton("Align left"));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    fireEvent.click(arrangementButton("Align bottom"));
    await act(async () => {});
    expect(save).toHaveBeenCalledTimes(1);
    const otherSemantics = { ...positionedSemantics, layout: { ...positionedSemantics.layout, sourceId: "other-source", positions: { ...positions, "public.orders": { ...positions["public.orders"], x: 9000 } } } };
    rerender(<CanvasHarness snapshot={{ ...reportSnapshot, sourceId: "other-source", id: "other-snapshot" }} semantics={otherSemantics} />);
    act(() => { finish(); });
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save.mock.calls[1][0]["public.orders"].y).toBeGreaterThan(save.mock.calls[0][0]["public.orders"].y);
    expect(container.querySelector('.react-flow__node[data-id="public.orders"]')).toHaveStyle({ transform: "translate(9000px,600px)" });
    expect(screen.queryByText(/Layout saved on this device\./)).not.toBeInTheDocument();
  });

  it("does not apply a pending auto layout after a newer manual arrangement", async () => {
    const save = vi.fn<NonNullable<SchemaCanvasProps["onSaveLayout"]>>().mockResolvedValue(undefined);
    const { container } = render(<CanvasHarness semantics={positionedSemantics} onSaveLayout={save} />);
    await selectNodes(container);
    let finish!: (nodes: TableNodeType[]) => void;
    vi.mocked(layoutSchemaGraph).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    act(() => { window.dispatchEvent(new Event("nodalstudio:relayout-canvas")); });
    const pendingNodes = vi.mocked(layoutSchemaGraph).mock.calls.at(-1)![0];
    fireEvent.click(arrangementButton("Align left"));
    act(() => { finish(pendingNodes.map((node) => ({ ...node, position: { x: -1000, y: -1000 } }))); });
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(container.querySelector('.react-flow__node[data-id="public.orders"]')).toHaveStyle({ transform: "translate(0px,600px)" });
  });

  it("reports insufficient distribution space without moving tables or offering a save retry", async () => {
    const save = vi.fn<NonNullable<SchemaCanvasProps["onSaveLayout"]>>().mockResolvedValue(undefined);
    const { container } = render(<CanvasHarness semantics={positionedSemantics} onSaveLayout={save} />);
    await selectNodes(container);
    fireEvent.click(arrangementButton("Align left"));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    fireEvent.click(arrangementButton("Distribute horizontally"));
    expect(screen.getByRole("alert")).toHaveTextContent("Not enough horizontal space");
    expect(screen.queryByRole("button", { name: "Retry layout save" })).not.toBeInTheDocument();
    expect(container.querySelector('.react-flow__node[data-id="public.orders"]')).toHaveStyle({ transform: "translate(0px,600px)" });
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("waits for saved semantics before enabling arrangements or writing an initial layout", async () => {
    const save = vi.fn<NonNullable<SchemaCanvasProps["onSaveLayout"]>>();
    const { container, rerender } = render(<CanvasHarness semantics={undefined} layoutLoaded={false} onSaveLayout={save} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Export SVG" })).toBeEnabled());
    fireEvent.click(container.querySelector('.react-flow__node[data-id="public.orders"]')!);
    fireEvent.click(container.querySelector('.react-flow__node[data-id="archive.orders"]')!, { shiftKey: true });
    expect(arrangementButton("Align left")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Auto layout" })).toBeDisabled();
    expect(container.querySelectorAll(".table-resize-handle")).toHaveLength(0);
    expect(screen.getByRole("group", { name: "Diagram layout" })).toHaveAttribute("title", "Waiting for the saved layout to load.");
    expect(save).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
    rerender(<CanvasHarness semantics={positionedSemantics} layoutLoaded onSaveLayout={save} />);
    await waitFor(() => expect(arrangementButton("Align left")).toBeEnabled());
    expect(container.querySelectorAll(".table-resize-handle").length).toBeGreaterThan(0);
    expect(container.querySelector('.react-flow__node[data-id="public.orders"]')).toHaveStyle({ transform: "translate(4000px,600px)" });
    expect(save).not.toHaveBeenCalled();
  });

  it("isolates caches by source even with the same fingerprint and rejects a previous source's semantic layout", async () => {
    const { container, rerender, unmount } = render(<CanvasHarness semantics={positionedSemantics} />);
    await selectNodes(container);
    fireEvent.click(arrangementButton("Align left"));
    await waitFor(() => expect(screen.getByText(/Layout saved in this browser\./)).toBeVisible());
    const otherSnapshot = { ...reportSnapshot, sourceId: "another-source", id: "another-snapshot" };
    rerender(<CanvasHarness snapshot={otherSnapshot} semantics={positionedSemantics} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Export SVG" })).toBeEnabled());
    const position = buildSchemaGraph(otherSnapshot).nodes.find((node) => node.id === "public.orders")!.position;
    expect(container.querySelector('.react-flow__node[data-id="public.orders"]')).toHaveStyle({ transform: `translate(${position.x}px,${position.y}px)` });
    expect(localStorage.length).toBe(2);
    unmount();
    const reopened = render(<CanvasHarness semantics={{ ...reportSemantics, layout: null }} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Export SVG" })).toBeEnabled());
    expect(reopened.container.querySelector('.react-flow__node[data-id="public.orders"]')).toHaveStyle({ transform: "translate(0px,600px)" });
  });

  it("undoes and redoes alignment and distribution, saving each complete result even with an empty selection", async () => {
    const save = vi.fn<NonNullable<SchemaCanvasProps["onSaveLayout"]>>().mockResolvedValue(undefined);
    const { container } = render(<CanvasHarness semantics={positionedSemantics} onSaveLayout={save} />);
    expect(screen.getByRole("button", { name: "Undo layout" })).toBeDisabled();
    await selectNodes(container);
    fireEvent.click(arrangementButton("Distribute horizontally"));
    fireEvent.click(arrangementButton("Align left"));
    fireEvent.click(screen.getByRole("button", { name: "Clear selection" }));
    const orders = () => container.querySelector('.react-flow__node[data-id="public.orders"]')!;
    fireEvent.click(screen.getByRole("button", { name: "Undo layout" }));
    expect(orders()).toHaveStyle({ transform: "translate(3000px,600px)" });
    expect(screen.queryByText(/table[s]? selected/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Undo layout" }));
    expect(orders()).toHaveStyle({ transform: "translate(4000px,600px)" });
    expect(screen.getByRole("button", { name: "Undo layout" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Redo layout" }));
    expect(orders()).toHaveStyle({ transform: "translate(3000px,600px)" });
    await waitFor(() => expect(save).toHaveBeenCalledTimes(5));
    expect(save.mock.calls.every(([frame]) => Object.keys(frame).length === 3)).toBe(true);
    expect(save.mock.calls[3][0]).toMatchObject(positions);
  });

  it("retains layout history through semantic and selection updates, while new edits discard redo", async () => {
    const { container, rerender } = render(<CanvasHarness semantics={positionedSemantics} />);
    await selectNodes(container);
    fireEvent.click(arrangementButton("Align left"));
    rerender(<CanvasHarness semantics={{ ...positionedSemantics, domainGroups: [{ ...reportSemantics.domainGroups[0], color: "#ff0000" }] }} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Undo layout" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Undo layout" }));
    expect(screen.getByText("3 tables selected")).toBeVisible();
    expect(container.querySelector('.react-flow__node[data-id="public.orders"] article')).toHaveStyle({ "--domain-color": "#ff0000" });
    expect(screen.getByRole("button", { name: "Redo layout" })).toBeEnabled();
    fireEvent.click(arrangementButton("Align top"));
    expect(screen.getByRole("button", { name: "Redo layout" })).toBeDisabled();
  });

  it("handles canvas undo/redo shortcuts without intercepting text input, dialogs or another panel", async () => {
    const { container } = render(<CanvasHarness semantics={positionedSemantics} />);
    await selectNodes(container);
    fireEvent.click(arrangementButton("Align left"));
    const node = container.querySelector('.react-flow__node[data-id="public.orders"]')!;
    const input = document.createElement("textarea"); container.append(input);
    expect(fireEvent.keyDown(input, { key: "z", ctrlKey: true })).toBe(true);
    expect(fireEvent.keyDown(document.body, { key: "z", metaKey: true })).toBe(true);
    const dialog = document.createElement("div"); dialog.setAttribute("role", "dialog"); container.append(dialog);
    expect(fireEvent.keyDown(dialog, { key: "z", ctrlKey: true })).toBe(true);
    expect(node).toHaveStyle({ transform: "translate(0px,600px)" });
    screen.getByRole("button", { name: "Undo layout" }).focus();
    fireEvent.click(screen.getByRole("button", { name: "Undo layout" }));
    expect(container.querySelector(".schema-canvas-flow")).toHaveFocus();
    expect(fireEvent.keyDown(document.activeElement!, { key: "z", ctrlKey: true, shiftKey: true })).toBe(false);
    expect(node).toHaveStyle({ transform: "translate(0px,600px)" });
    expect(fireEvent.keyDown(node, { key: "z", ctrlKey: true })).toBe(false);
    expect(node).toHaveStyle({ transform: "translate(4000px,600px)" });
    expect(fireEvent.keyDown(node, { key: "Z", metaKey: true, shiftKey: true })).toBe(false);
    expect(node).toHaveStyle({ transform: "translate(0px,600px)" });
    fireEvent.keyDown(node, { key: "z", metaKey: true });
    expect(fireEvent.keyDown(node, { key: "y", ctrlKey: true })).toBe(false);
    expect(node).toHaveStyle({ transform: "translate(0px,600px)" });
  });

  it.each(["source", "snapshot", "search", "saved view"])("clears undo and redo on a %s scope switch", async (scope) => {
    const { container, rerender } = render(<CanvasHarness semantics={positionedSemantics} />);
    await selectNodes(container);
    fireEvent.click(arrangementButton("Align left"));
    const next: Partial<SchemaCanvasProps> = scope === "source" ? { snapshot: { ...reportSnapshot, sourceId: "other-source", id: "other-snapshot" } }
      : scope === "snapshot" ? { snapshot: { ...reportSnapshot, id: "other-snapshot" } }
      : scope === "search" ? { query: "orders" }
      : { savedView: { id: "orders-view", sourceId: reportSnapshot.sourceId, name: "Orders", rootTableKeys: [reportSnapshot.schemas[0].tables[1].key], relationshipDepth: 0, updatedAt: "now" } };
    rerender(<CanvasHarness semantics={positionedSemantics} {...next} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Export SVG" })).toBeEnabled());
    expect(screen.getByRole("button", { name: "Undo layout" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Redo layout" })).toBeDisabled();
    rerender(<CanvasHarness semantics={positionedSemantics} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Export SVG" })).toBeEnabled());
    expect(screen.getByRole("button", { name: "Undo layout" })).toBeDisabled();
  });

  it.each(["web", "comparison", "search"])("undoes temporary %s layouts without writing current layouts", async (scope) => {
    const save = vi.fn<NonNullable<SchemaCanvasProps["onSaveLayout"]>>();
    const { container } = render(<CanvasHarness semantics={positionedSemantics} onSaveLayout={save} runtimeKind={scope === "web" ? "web" : "desktop"}
      {...(scope === "comparison" ? { snapshot: diagramAfter, beforeSnapshot: diagramBefore, changeSet: diagramChangeSet } : scope === "search" ? { query: "orders" } : {})} />);
    await selectNodes(container, scope === "comparison" ? ["public.orders", "public.audit"] : ["public.orders", "archive.orders"]);
    const id = scope === "comparison" ? "public.audit" : "archive.orders";
    const node = container.querySelector(`.react-flow__node[data-id="${id}"]`)!;
    const before = node.getAttribute("style");
    fireEvent.click(arrangementButton("Align left"));
    fireEvent.click(screen.getByRole("button", { name: "Undo layout" }));
    expect(node.getAttribute("style")).toBe(before);
    expect(screen.getByText("Undid Align left for this view only.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Redo layout" }));
    expect(screen.getByText("Redid Align left for this view only.")).toBeVisible();
    expect(save).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
  });

  it("undoes manual auto layout, but does not record initial or stale automatic layouts", async () => {
    const save = vi.fn<NonNullable<SchemaCanvasProps["onSaveLayout"]>>().mockResolvedValue(undefined);
    const { container } = render(<CanvasHarness semantics={positionedSemantics} onSaveLayout={save} />);
    await selectNodes(container);
    expect(screen.getByRole("button", { name: "Undo layout" })).toBeDisabled();
    vi.mocked(layoutSchemaGraph).mockImplementationOnce((nodes) => Promise.resolve(nodes.map((node) => ({ ...node, position: { x: 500, y: 500 } }))));
    fireEvent.click(screen.getByRole("button", { name: "Auto layout" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Undo layout" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Undo layout" }));
    expect(container.querySelector('.react-flow__node[data-id="public.orders"]')).toHaveStyle({ transform: "translate(4000px,600px)" });
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
  });

  it("records React Flow keyboard moves of multiple selected tables and persists the undo", async () => {
    const save = vi.fn<NonNullable<SchemaCanvasProps["onSaveLayout"]>>().mockResolvedValue(undefined);
    const { container } = render(<CanvasHarness semantics={positionedSemantics} onSaveLayout={save} />);
    await selectNodes(container, ["public.orders", "archive.orders"]);
    const node = container.querySelector('.react-flow__node[data-id="public.orders"]')!;
    fireEvent.keyDown(node, { key: "ArrowRight" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Undo layout" })).toBeEnabled());
    expect(node).toHaveStyle({ transform: "translate(4005px,600px)" });
    expect(container.querySelector('.react-flow__node[data-id="archive.orders"]')).toHaveStyle({ transform: "translate(6005px,1000px)" });
    fireEvent.click(screen.getByRole("button", { name: "Undo layout" }));
    expect(node).toHaveStyle({ transform: "translate(4000px,600px)" });
    expect(screen.getByText("2 tables selected")).toBeVisible();
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save.mock.calls[1][0]).toMatchObject(positions);
  });

  it("keeps a failed undo visible and retryable without consuming its redo entry", async () => {
    const save = vi.fn<NonNullable<SchemaCanvasProps["onSaveLayout"]>>().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("disk unavailable")).mockResolvedValue(undefined);
    const { container } = render(<CanvasHarness semantics={positionedSemantics} onSaveLayout={save} />);
    await selectNodes(container);
    fireEvent.click(arrangementButton("Align left"));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Undo layout" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("disk unavailable"));
    expect(container.querySelector('.react-flow__node[data-id="public.orders"]')).toHaveStyle({ transform: "translate(4000px,600px)" });
    expect(screen.getByRole("button", { name: "Redo layout" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Retry layout save" }));
    await waitFor(() => expect(screen.getByText(/Layout saved on this device\./)).toBeVisible());
    expect(save.mock.calls[2][0]).toMatchObject(positions);
    expect(screen.getByRole("button", { name: "Redo layout" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Redo layout" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(4));
    expect(save.mock.calls[3][0]["public.orders"].x).toBe(0);
  });

  it("fixes selected tables, prevents keyboard and resize edits, and undo/redo persists fixed states", async () => {
    const save = vi.fn<NonNullable<SchemaCanvasProps["onSaveLayout"]>>().mockResolvedValue(undefined);
    const { container, unmount } = render(<CanvasHarness semantics={positionedSemantics} onSaveLayout={save} />);
    await selectNodes(container, ["public.orders"]);
    const orders = container.querySelector('.react-flow__node[data-id="public.orders"]')!;
    const fix = screen.getByRole("button", { name: "Fix table positions" });
    fix.focus();
    fireEvent.click(fix);
    expect(container.querySelector(".schema-canvas-flow")).toHaveFocus();
    expect(orders.querySelector('[aria-label="Table position fixed"]')).not.toBeNull();
    expect(orders.querySelector('.table-resize-handle')).toBeNull();
    expect(screen.getByRole("button", { name: "Auto layout selected" })).toBeDisabled();
    fireEvent.keyDown(orders, { key: "ArrowRight" });
    expect(orders).toHaveStyle({ transform: "translate(4000px,600px)" });
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0][0]["public.orders"]).toEqual({ ...positions["public.orders"], pinned: true });
    fireEvent.click(screen.getByRole("button", { name: "Undo layout" }));
    expect(orders.querySelector('[aria-label="Table position fixed"]')).toBeNull();
    expect(orders.querySelector('.table-resize-handle')).not.toBeNull();
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save.mock.calls[1][0]["public.orders"].pinned).toBeUndefined();
    fireEvent.click(screen.getByRole("button", { name: "Redo layout" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(3));
    const restored = save.mock.calls[2][0];
    unmount();
    const next = render(<CanvasHarness semantics={{ ...positionedSemantics, layout: { ...positionedSemantics.layout, positions: restored } }} onSaveLayout={save} />);
    await selectNodes(next.container, ["public.orders"]);
    expect(next.container.querySelector('.react-flow__node[data-id="public.orders"] [aria-label="Table position fixed"]')).not.toBeNull();
    expect(screen.getByRole("button", { name: "Undo layout" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Unlock table positions" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(4));
    expect(save.mock.calls[3][0]["public.orders"].pinned).toBeUndefined();
  });

  it("skips fixed selected tables for alignment and keyboard multi-moves, and counts only movable tables", async () => {
    const fixedPositions = { ...positions, "public.customers": { ...positions["public.customers"], pinned: true } };
    const { container } = render(<CanvasHarness semantics={{ ...positionedSemantics, layout: { ...positionedSemantics.layout, positions: fixedPositions } }} />);
    await selectNodes(container);
    expect(screen.getByRole("button", { name: "Align / distribute" })).toHaveAttribute("title", expect.stringContaining("1 fixed · 2 movable selected"));
    expect(arrangementButton("Distribute horizontally")).toBeDisabled();
    fireEvent.click(arrangementButton("Align left"));
    expect(container.querySelector('.react-flow__node[data-id="public.customers"]')).toHaveStyle({ transform: "translate(0px,100px)" });
    expect(container.querySelector('.react-flow__node[data-id="archive.orders"]')).toHaveStyle({ transform: "translate(4000px,1000px)" });
    fireEvent.keyDown(container.querySelector('.react-flow__node[data-id="public.orders"]')!, { key: "ArrowRight" });
    expect(container.querySelector('.react-flow__node[data-id="public.customers"]')).toHaveStyle({ transform: "translate(0px,100px)" });
    expect(container.querySelector('.react-flow__node[data-id="archive.orders"]')).toHaveStyle({ transform: "translate(4005px,1000px)" });
    fireEvent.click(screen.getByRole("button", { name: "Fix table positions" }));
    expect(screen.getByRole("button", { name: "Auto layout" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Auto layout selected" })).toBeDisabled();
  });

  it("auto lays out only the selection, saves the complete diagram and supports undo/redo", async () => {
    const save = vi.fn<NonNullable<SchemaCanvasProps["onSaveLayout"]>>().mockResolvedValue(undefined);
    const { container } = render(<CanvasHarness semantics={positionedSemantics} onSaveLayout={save} />);
    await selectNodes(container, ["public.orders", "archive.orders"]);
    vi.mocked(layoutSelectedSchemaGraph).mockImplementationOnce((nodes) => Promise.resolve(nodes.map((node, index) => node.selected ? { ...node, position: { x: 800 + index * 300, y: 500 } } : node)));
    fireEvent.click(screen.getByRole("button", { name: "Auto layout selected" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(Object.keys(save.mock.calls[0][0])).toHaveLength(3);
    expect(save.mock.calls[0][0]["public.customers"]).toEqual(positions["public.customers"]);
    await waitFor(() => expect(container.querySelector('.react-flow__node[data-id="public.orders"]')).toHaveStyle({ transform: "translate(1100px,500px)" }));
    expect(screen.getByText("2 tables selected")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Undo layout" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save.mock.calls[1][0]).toMatchObject(positions);
    fireEvent.click(screen.getByRole("button", { name: "Redo layout" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(3));
    expect(save.mock.calls[2][0]).toEqual(save.mock.calls[0][0]);
  });

  it.each(["search", "web", "comparison"])("keeps fixed states and selected automatic layout temporary in %s", async (scope) => {
    const save = vi.fn<NonNullable<SchemaCanvasProps["onSaveLayout"]>>();
    const props = { semantics: positionedSemantics, onSaveLayout: save, query: scope === "search" ? "orders" : "", runtimeKind: scope === "web" ? "web" as const : "desktop" as const,
      ...(scope === "comparison" ? { snapshot: diagramAfter, beforeSnapshot: diagramBefore, changeSet: diagramChangeSet } : {}) };
    const { container, rerender } = render(<CanvasHarness {...props} />);
    await selectNodes(container, scope === "comparison" ? ["public.audit"] : ["public.orders"]);
    fireEvent.click(screen.getByRole("button", { name: "Fix table positions" }));
    expect(container.querySelector('[aria-label="Table position fixed"]')).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Unlock table positions" }));
    vi.mocked(layoutSelectedSchemaGraph).mockImplementationOnce((nodes) => Promise.resolve(nodes.map((node) => node.selected ? { ...node, position: { x: 222, y: 333 } } : node)));
    fireEvent.click(screen.getByRole("button", { name: "Auto layout selected" }));
    await waitFor(() => expect(screen.getByText(/Auto layout selected applied for this view only\./)).toBeVisible());
    expect(save).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
    rerender(<CanvasHarness semantics={positionedSemantics} onSaveLayout={save} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Export SVG" })).toBeEnabled());
    expect(container.querySelector('[aria-label="Table position fixed"]')).toBeNull();
    expect(container.querySelector('.react-flow__node[data-id="public.orders"]')).toHaveStyle({ transform: "translate(4000px,600px)" });
  });

  it("inherits full diagram fixed positions in temporary views without leaking local unlocks", async () => {
    const fixedPositions = { ...positions, "public.orders": { ...positions["public.orders"], pinned: true } };
    const semantics = { ...positionedSemantics, layout: { ...positionedSemantics.layout, positions: fixedPositions } };
    const save = vi.fn<NonNullable<SchemaCanvasProps["onSaveLayout"]>>();
    const { container, rerender } = render(<CanvasHarness semantics={semantics} query="orders" onSaveLayout={save} />);
    await selectNodes(container, ["public.orders"]);
    expect(container.querySelector('.react-flow__node[data-id="public.orders"]')).toHaveStyle({ transform: "translate(4000px,600px)" });
    fireEvent.click(screen.getByRole("button", { name: "Unlock table positions" }));
    expect(screen.getByText("Fixed states adjusted for this view only.")).toBeVisible();
    rerender(<CanvasHarness semantics={semantics} onSaveLayout={save} />);
    await waitFor(() => expect(container.querySelector('.react-flow__node[data-id="public.orders"] [aria-label="Table position fixed"]')).not.toBeNull());
    expect(save).not.toHaveBeenCalled();
  });

  it("rejects stale selected auto layout after a pin edit and preserves current selection during pending layout", async () => {
    const save = vi.fn<NonNullable<SchemaCanvasProps["onSaveLayout"]>>().mockResolvedValue(undefined);
    const { container } = render(<CanvasHarness semantics={positionedSemantics} onSaveLayout={save} />);
    await selectNodes(container, ["public.orders"]);
    let finish!: (nodes: TableNodeType[]) => void;
    let request!: TableNodeType[];
    vi.mocked(layoutSelectedSchemaGraph).mockImplementationOnce((nodes) => { request = nodes; return new Promise((resolve) => { finish = resolve; }); });
    fireEvent.click(screen.getByRole("button", { name: "Auto layout selected" }));
    fireEvent.click(screen.getByRole("button", { name: "Fix table positions" }));
    await act(async () => { finish(request.map((node) => ({ ...node, position: { x: 999, y: 999 } }))); await Promise.resolve(); });
    expect(container.querySelector('.react-flow__node[data-id="public.orders"]')).toHaveStyle({ transform: "translate(4000px,600px)" });
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    vi.mocked(layoutSelectedSchemaGraph).mockImplementationOnce((nodes) => { request = nodes; return new Promise((resolve) => { finish = resolve; }); });
    fireEvent.click(screen.getByRole("button", { name: "Unlock table positions" }));
    fireEvent.click(screen.getByRole("button", { name: "Auto layout selected" }));
    fireEvent.click(container.querySelector('.react-flow__node[data-id="archive.orders"]')!);
    await act(async () => { finish(request.map((node) => node.selected ? { ...node, position: { x: 777, y: 777 } } : node)); await Promise.resolve(); });
    expect(container.querySelector('.react-flow__node[data-id="public.orders"]')).toHaveStyle({ transform: "translate(777px,777px)" });
    expect(container.querySelector('.react-flow__node[data-id="archive.orders"] article')).toHaveAttribute("data-selected", "true");
    expect(container.querySelector('.react-flow__node[data-id="public.orders"] article')).not.toHaveAttribute("data-selected");
  });

  it("keeps failed selected auto layout out of history and retries failed fixed-state saves", async () => {
    const save = vi.fn<NonNullable<SchemaCanvasProps["onSaveLayout"]>>().mockRejectedValueOnce(new Error("disk full")).mockResolvedValue(undefined);
    const { container } = render(<CanvasHarness semantics={positionedSemantics} onSaveLayout={save} />);
    await selectNodes(container, ["public.orders"]);
    vi.mocked(layoutSelectedSchemaGraph).mockRejectedValueOnce(new Error("worker failed"));
    fireEvent.click(screen.getByRole("button", { name: "Auto layout selected" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("worker failed"));
    expect(screen.getByRole("button", { name: "Undo layout" })).toBeDisabled();
    expect(save).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Fix table positions" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("disk full"));
    expect(container.querySelector('[aria-label="Table position fixed"]')).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry layout save" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save.mock.calls[1][0]["public.orders"].pinned).toBe(true);
    expect(screen.getByRole("button", { name: "Undo layout" })).toHaveAttribute("title", expect.stringContaining("Fix table positions"));
  });


  it("preserves valid fixed cards when a newly added table invalidates the complete saved layout", async () => {
    const incomplete = { "public.orders": { ...positions["public.orders"], pinned: true } };
    const save = vi.fn<NonNullable<SchemaCanvasProps["onSaveLayout"]>>().mockResolvedValue(undefined);
    const { container } = render(<CanvasHarness semantics={{ ...positionedSemantics, layout: { ...positionedSemantics.layout, positions: incomplete } }} onSaveLayout={save} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Export SVG" })).toBeEnabled());
    expect(container.querySelector('.react-flow__node[data-id="public.orders"]')).toHaveStyle({ transform: "translate(4000px,600px)" });
    expect(container.querySelector('.react-flow__node[data-id="public.orders"] [aria-label="Table position fixed"]')).not.toBeNull();
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(Object.keys(save.mock.calls[0][0])).toHaveLength(3);
    expect(save.mock.calls[0][0]["public.orders"]).toEqual({ ...positions["public.orders"], pinned: true });
  });

  it("ignores selected auto layout after changing source and never carries fixed states into another source", async () => {
    const save = vi.fn<NonNullable<SchemaCanvasProps["onSaveLayout"]>>().mockResolvedValue(undefined);
    const { container, rerender } = render(<CanvasHarness semantics={positionedSemantics} onSaveLayout={save} />);
    await selectNodes(container, ["public.orders"]);
    fireEvent.click(screen.getByRole("button", { name: "Fix table positions" }));
    fireEvent.click(container.querySelector('.react-flow__node[data-id="archive.orders"]')!);
    let finish!: (nodes: TableNodeType[]) => void;
    let request!: TableNodeType[];
    vi.mocked(layoutSelectedSchemaGraph).mockImplementationOnce((nodes) => { request = nodes; return new Promise((resolve) => { finish = resolve; }); });
    fireEvent.click(screen.getByRole("button", { name: "Auto layout selected" }));
    rerender(<CanvasHarness snapshot={{ ...reportSnapshot, sourceId: "new-source", id: "new-snapshot" }} semantics={reportSemantics} onSaveLayout={save} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Export SVG" })).toBeEnabled());
    const baseline = container.querySelector('.react-flow__node[data-id="archive.orders"]')!.getAttribute("style");
    const writes = save.mock.calls.length;
    await act(async () => { finish(request.map((node) => ({ ...node, position: { x: 9999, y: 9999 } }))); await Promise.resolve(); });
    expect(container.querySelector('.react-flow__node[data-id="archive.orders"]')!.getAttribute("style")).toBe(baseline);
    expect(container.querySelector('[aria-label="Table position fixed"]')).toBeNull();
    expect(screen.getByRole("button", { name: "Undo layout" })).toBeDisabled();
    expect(save).toHaveBeenCalledTimes(writes);
  });

});

// Real row events exercise the same canvas path as the desktop WebView. Only
// hit-testing geometry is supplied because jsdom has no rendered layout.
describe("field-row relationship gestures", () => {
  let hit: Element | null = null;
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal("DOMMatrixReadOnly", class { m22 = 1; });
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1200);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(700);
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => hit });
    hit = null;
    localStorage.clear();
  });
  afterEach(() => {
    Reflect.deleteProperty(document, "elementFromPoint");
    vi.restoreAllMocks(); vi.unstubAllGlobals();
  });
  async function setup(props: Partial<SchemaCanvasProps> = {}) {
    const create = vi.fn().mockResolvedValue({});
    const validate = vi.fn().mockResolvedValue({ valid: true, compatible: true, duplicate: false, physicalExists: false, suggestedCardinality: "manyToOne", status: "active", messages: [] });
    const view = render(<CanvasHarness onCreateLogicalRelationship={create} onValidateLogicalRelationship={validate} {...props} />);
    await waitFor(() => expect(view.container.querySelector('.react-flow__node[data-id="public.orders"] .table-column')).not.toBeNull());
    const source = view.container.querySelector<HTMLElement>('.react-flow__node[data-id="public.orders"] .table-column[data-column-name="id"]')!;
    const target = view.container.querySelector<HTMLElement>('.react-flow__node[data-id="public.customers"] .table-column[data-column-name="id"]')!;
    return { ...view, source, target, create, validate };
  }
  function mouse(target: Element | Document, type: string, x: number, modifiers = {}) {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, buttons: type === "mouseup" ? 0 : 1, clientX: x, clientY: 300, ...modifiers });
    // Vitest's Window proxy is rejected by jsdom's constructor, while D3 needs
    // event.view for its native drag suppression/cleanup.
    Object.defineProperty(event, "view", { value: window });
    fireEvent(target, event);
  }
  function start(source: HTMLElement, modifiers = {}) { mouse(source.querySelector(".column-type")!, "mousedown", 800, modifiers); }
  function move(x = 200) { mouse(document, "mousemove", x); }
  function release(x = 200) { mouse(document, "mouseup", x); }

  it("drags a row's type area onto another entire row and requires confirmation before saving", async () => {
    const { source, target, create, validate } = await setup();
    hit = target.querySelector(".column-type"); start(source); move(); release();
    expect(await screen.findByRole("heading", { name: "Create logical relationship" })).toBeVisible();
    expect(screen.getByLabelText("Name")).toHaveValue("orders_id_customers_id");
    expect(create).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole("button", { name: "Create" })).toBeEnabled());
    expect(validate).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({ source: { schema: "public", table: "orders", columns: ["id"] }, target: { schema: "public", table: "customers", columns: ["id"] }, origin: "manual" })));
  });
  it("transfers keyboard focus to the table when pressing a field", async () => {
    const { source } = await setup();
    const previous = screen.getByRole("button", { name: "Auto layout" });
    previous.focus();
    start(source); release(800);
    expect(source.closest(".react-flow__node")).toHaveFocus();
  });
  it("cancels a connection when the pointer returns after releasing outside the window", async () => {
    const { source, target, validate } = await setup();
    hit = target; start(source); move();
    expect(source).toHaveAttribute("data-row-source", "true");
    mouse(document, "mousemove", 200, { buttons: 0 });
    expect(source).not.toHaveAttribute("data-row-source");
    expect(target).not.toHaveAttribute("data-row-drop");
    release();
    expect(screen.queryByRole("heading", { name: "Create logical relationship" })).toBeNull();
    expect(validate).not.toHaveBeenCalled();
  });
  it("only completes the connection when the initiating mouse button is released", async () => {
    const { source, target, validate } = await setup();
    hit = target; start(source); move();
    mouse(document, "mouseup", 200, { button: 2, buttons: 1 });
    expect(source).toHaveAttribute("data-row-source", "true");
    expect(validate).not.toHaveBeenCalled();
    expect(screen.queryByRole("heading", { name: "Create logical relationship" })).toBeNull();
    release();
    expect(await screen.findByRole("heading", { name: "Create logical relationship" })).toBeVisible();
  });
  it.each(["click", "blank", "same", "escape", "blur"])("does not create a relationship for %s", async (kind) => {
    const { source, target, create, validate } = await setup();
    hit = kind === "blank" ? null : kind === "same" ? source : target;
    start(source); move(kind === "click" ? 803 : 200);
    if (kind === "escape") fireEvent.keyDown(document, { key: "Escape" });
    if (kind === "blur") fireEvent(window, new Event("blur"));
    release(kind === "click" ? 803 : 200);
    expect(screen.queryByRole("heading", { name: "Create logical relationship" })).toBeNull();
    expect(source).not.toHaveAttribute("data-row-source");
    expect(target).not.toHaveAttribute("data-row-drop");
    expect(create).not.toHaveBeenCalled(); expect(validate).not.toHaveBeenCalled();
  });
  it("leaves modifier selection and read-only previews outside the connection gesture", async () => {
    const view = await setup(); hit = view.target;
    start(view.source, { shiftKey: true }); move(); release();
    expect(screen.queryByRole("heading", { name: "Create logical relationship" })).toBeNull();
    view.unmount();
    const readOnly = await setup({ readOnlyPreview: true }); hit = readOnly.target;
    start(readOnly.source); move(); release();
    expect(readOnly.create).not.toHaveBeenCalled(); expect(readOnly.validate).not.toHaveBeenCalled();
  });
});
