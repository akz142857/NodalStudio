import { memo, useEffect } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useStoreApi, type NodeProps } from "@xyflow/react";
import { afterEach, expect, it, vi } from "vitest";
import type { TableNode } from "../graph/schema-graph";
import { defaultAppSettings } from "../platform";
import { reportSnapshot } from "../test/schema-report-fixture";
import { diagramColumn, diagramTable } from "../test/diagram-comparison-fixture";
import { SchemaCanvas } from "./SchemaCanvas";
import { useCanvasInteraction, useExportTableDetail } from "./CanvasInteractionContext";
import * as exporter from "../graph/diagram-export";

const probe = vi.hoisted(() => ({ store: undefined as ReturnType<typeof useStoreApi> | undefined, panels: 0, fitView: vi.fn().mockResolvedValue(true), renders: new Map<string, number>() }));
vi.mock("./TableNode", () => ({ TableNode: memo(function TestNode({ id, data }: NodeProps<TableNode>) {
  const store = useStoreApi();
  useEffect(() => { probe.store = store; }, [store]);
  const key = useCanvasInteraction().exportReplica ? `export:${id}` : id;
  probe.renders.set(key, (probe.renders.get(key) ?? 0) + 1);
  const detailed = useExportTableDetail(id);
  return <article className="table-node" data-overview={detailed !== undefined && !detailed || undefined}>{data.table.key.name}</article>;
}, (a, b) => a.id === b.id && a.data === b.data && a.selected === b.selected && a.width === b.width && a.height === b.height) }));
vi.mock("./DiagramSelectionActions", () => ({ DiagramSelectionActions: () => { probe.panels += 1; return null; } }));
vi.mock("@xyflow/react", async (load) => {
  const actual = await load<typeof import("@xyflow/react")>();
  return { ...actual, useNodesInitialized: () => true, useReactFlow: () => ({ ...actual.useReactFlow(), fitView: probe.fitView }) };
});
vi.mock("../graph/elk-layout", async (load) => ({ ...await load<typeof import("../graph/elk-layout")>(), layoutSchemaGraph: vi.fn((nodes: TableNode[]) => Promise.resolve(nodes.map((node, index) => ({ ...node, measured: { width: 280, height: 600 }, position: { x: index * 320, y: 0 } })))) }));

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); probe.store = undefined; probe.renders.clear(); probe.panels = 0; });

it("keeps 1,000 tables in the model while culling offscreen DOM, avoiding unrelated renders, and restoring all tables for export", async () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("DOMMatrixReadOnly", class { m22 = 1; });
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1200);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(700);
  const snapshot = { ...reportSnapshot, id: "large", fingerprint: "large", schemas: [{ name: "public", tables: Array.from({ length: 1000 }, (_, i) => diagramTable(`table_${i}`, Array.from({ length: 20 }, (_, c) => diagramColumn(`field_${c}`, c + 1)))), views: [], enums: [] }] };
  const saveDiagramExport = vi.fn().mockResolvedValue({ path: "/tmp/full.svg" });
  const platform = { saveDiagramExport } as unknown as import("../platform").NodalStudioPlatform;
  const { container } = render(<div style={{ width: 1200, height: 700 }}><SchemaCanvas snapshot={snapshot} query="" canvasSettings={defaultAppSettings().canvas} onSelectTable={() => {}} selectedTable={snapshot.schemas[0].tables[0]} platform={platform} runtimeKind="web" /></div>);
  await waitFor(() => expect(screen.getByRole("button", { name: "Export SVG" })).toBeEnabled());
  const store = probe.store!;
  act(() => {
    // JSDOM has no layout engine; supply the measurement/handle cache that
    // React Flow's ResizeObserver normally fills in the native WebView.
    for (const node of store.getState().nodeLookup.values()) {
      node.internals.handleBounds = { source: [], target: [] };
      node.measured = { width: 280, height: 600 };
    }
    store.setState({ width: 1200, height: 700, transform: [0, 0, 1], nodeLookup: new Map(store.getState().nodeLookup) });
  });
  await waitFor(() => expect(container.querySelectorAll(".table-node").length).toBeLessThan(10));
  expect(store.getState().nodes).toHaveLength(1000);
  fireEvent.click(container.querySelector('.react-flow__node[data-id="public.table_0"]')!);
  const panels = probe.panels;
  const renders = probe.renders.get("public.table_0");
  act(() => { store.setState({ transform: [-10, 0, 1] }); });
  expect(probe.panels).toBe(panels);
  expect(probe.renders.get("public.table_0")).toBe(renders);
  act(() => { store.getState().triggerNodeChanges([{ type: "position", id: "public.table_0", position: { x: 10, y: 5 }, dragging: true }]); });
  expect(probe.renders.get("public.table_0")).toBe(renders);
  expect(screen.getByRole("button", { name: "Export SVG" })).toBeDisabled();
  act(() => { store.getState().triggerNodeChanges([{ type: "position", id: "public.table_0", position: { x: 10, y: 5 }, dragging: false }]); });
  await waitFor(() => expect(screen.getByRole("button", { name: "Export SVG" })).toBeEnabled());
  act(() => { store.setState({ transform: [-319000, 0, 1] }); });
  await waitFor(() => expect(container.querySelector('.react-flow__node[data-id="public.table_999"]')).not.toBeNull());
  const captured = new Set<string>();
  const beforeExportTransform = [...store.getState().transform];
  const beforeExportNodes = store.getState().nodes.map(({ id, position, selected, hidden }) => ({ id, position, selected, hidden }));
  const liveRenders = new Map(probe.renders);
  const liveNode = container.querySelector('.schema-canvas-flow:not(.diagram-export-surface) .react-flow__node[data-id="public.table_999"]')!;
  let peakExportTables = 0;
  const observer = new MutationObserver(() => {
    peakExportTables = Math.max(peakExportTables, container.querySelectorAll(".diagram-export-surface .table-node").length);
    expect(container.querySelectorAll(".diagram-export-surface .table-node").length).toBeLessThanOrEqual(16);
    expect(container.querySelectorAll(".schema-canvas-flow:not(.diagram-export-surface) .table-node").length).toBeLessThan(10);
  });
  observer.observe(container, { childList: true, subtree: true });
  const append = vi.fn((batch: HTMLElement[]) => {
    const flow = container.querySelector<HTMLElement>('.schema-canvas-flow:not(.diagram-export-surface)')!;
    expect(flow.inert).toBeFalsy(); expect(flow).not.toHaveAttribute("aria-hidden");
    expect(flow).toHaveAttribute("aria-disabled", "true");
    // Presentation stays mounted and keyboard/mouse actions cannot change it.
    expect(container.contains(liveNode)).toBe(true);
    fireEvent.click(liveNode); fireEvent.keyDown(liveNode, { key: "ArrowRight" });
    expect(batch.length).toBeGreaterThan(0); expect(batch.length).toBeLessThanOrEqual(16);
    expect(container.querySelectorAll('.diagram-export-surface .table-node').length).toBeLessThanOrEqual(16);
    for (const table of batch) {
      expect(table).not.toHaveAttribute("data-overview");
      const id = table.closest(".react-flow__node")!.getAttribute("data-id")!;
      expect(captured.has(id)).toBe(false); captured.add(id);
    }
    expect(store.getState().nodes).toHaveLength(1000);
  });
  const capture = vi.spyOn(exporter, "createDiagramSvgCapture").mockImplementation((options) => {
    expect(options.tableIds?.size).toBe(1000);
    expect(options.root).toHaveClass("diagram-export-surface");
    expect(container.querySelectorAll(".table-node").length).toBeLessThan(10);
    return { appendEdges: vi.fn(), appendTables: append, finish: () => { expect(captured.size).toBe(1000); return { svg: "<svg/>", width: 160000, height: 1000 }; } };
  });
  fireEvent.click(screen.getByRole("button", { name: "Export SVG" }));
  await waitFor(() => expect(capture).toHaveBeenCalledOnce());
  await waitFor(() => expect(saveDiagramExport).toHaveBeenCalledOnce(), { timeout: 10000 });
  // Runtime work can reduce the next batch; all objects must still be read once.
  expect(append.mock.calls.reduce((sum, [batch]) => sum + batch.length, 0)).toBe(1000);
  await waitFor(() => expect(container.querySelectorAll(".table-node").length).toBeLessThan(10));
  observer.disconnect();
  expect(peakExportTables).toBe(16);
  for (const [id, count] of liveRenders) expect(probe.renders.get(id)).toBe(count);
  expect(container.contains(liveNode)).toBe(true);
  expect(store.getState().transform).toEqual(beforeExportTransform);
  expect(store.getState().nodes.map(({ id, position, selected, hidden }) => ({ id, position, selected, hidden }))).toEqual(beforeExportNodes);
}, 25000);

it("isolates marker and accessibility resource identities between mounted canvases and after remount", async () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("DOMMatrixReadOnly", class { m22 = 1; });
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1200);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(700);
  const canvas = (key: string) => <SchemaCanvas key={key} snapshot={reportSnapshot} query="" canvasSettings={defaultAppSettings().canvas} onSelectTable={() => {}} runtimeKind="web" />;
  const { container, rerender } = render(<>{canvas("a")}{canvas("b")}</>);
  const roots = () => [...container.querySelectorAll<HTMLElement>(".schema-canvas-flow:not(.diagram-export-surface)")];
  await waitFor(() => expect(roots().every((root) => root.querySelector("marker[id]"))).toBe(true));
  const first = roots().map((root) => root.id);
  expect(new Set(first).size).toBe(2);
  const markerIds = roots().flatMap((root) => [...root.querySelectorAll("marker[id]")].map((marker) => marker.id));
  expect(new Set(markerIds).size).toBe(markerIds.length);
  for (const root of roots()) {
    const descriptions = root.querySelectorAll("[aria-describedby]");
    expect(descriptions.length).toBeGreaterThan(0);
    for (const element of descriptions) for (const id of element.getAttribute("aria-describedby")!.split(" ")) {
      expect(id).toContain(root.id);
      expect(root.contains(document.getElementById(id))).toBe(true);
    }
  }
  rerender(<>{canvas("c")}{canvas("b")}</>);
  await waitFor(() => expect(roots()[0].id).not.toBe(first[0]));
  expect(roots()[1].id).toBe(first[1]);
});
