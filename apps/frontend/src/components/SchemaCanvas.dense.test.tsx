import { memo, useEffect } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useStoreApi, type NodeProps } from "@xyflow/react";
import { afterEach, expect, it, vi } from "vitest";
import type { TableNode } from "../graph/schema-graph";
import { defaultAppSettings, type NodalStudioPlatform } from "../platform";
import { diagramColumn, diagramForeignKey, diagramTable, diagramAfter } from "../test/diagram-comparison-fixture";
import { animationFrames, diagramExportFrameBudget } from "../test/animation-frames";
import { SchemaCanvas } from "./SchemaCanvas";
import { useExportTableDetail } from "./CanvasInteractionContext";
import * as exporter from "../graph/diagram-export";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
const canvasStyles = readFileSync(resolve("src/styles.css"), "utf8").replace(/^@import[^\n]*\n/, "");

const probe = vi.hoisted(() => ({ store: undefined as ReturnType<typeof useStoreApi> | undefined, fitView: vi.fn().mockResolvedValue(true) }));
vi.mock("./TableNode", () => ({ TableNode: memo(function TestNode({ id, data }: NodeProps<TableNode>) {
  const store = useStoreApi(); useEffect(() => { probe.store = store; }, [store]);
  const detailed = useExportTableDetail(id);
  return <article className="table-node" data-overview={detailed !== undefined && !detailed || undefined}>{data.table.key.name}</article>;
}) }));
vi.mock("@xyflow/react", async (load) => {
  const actual = await load<typeof import("@xyflow/react")>();
  return { ...actual, useNodesInitialized: () => true, useReactFlow: () => ({ ...actual.useReactFlow(), fitView: probe.fitView }) };
});
vi.mock("../graph/elk-layout", async (load) => ({ ...await load<typeof import("../graph/elk-layout")>(),
  layoutSchemaGraph: vi.fn((nodes: TableNode[]) => Promise.resolve(nodes.map((node, i) => ({ ...node, position: { x: i * 320, y: i % 2 * 250 } })))),
}));
afterEach(() => { document.querySelectorAll("style[data-canvas-regression]").forEach((style) => style.remove()); vi.restoreAllMocks(); vi.unstubAllGlobals(); probe.store = undefined; });

it.each([16, 250])("retains the dense model, selects, exports and rebuilds all edges with %i ms frames", async (interval) => {
  const frames = animationFrames(interval);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("DOMMatrixReadOnly", class { m22 = 1; });
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1200);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(700);
  const tables = Array.from({ length: 500 }, (_, i) => ({ ...diagramTable(`t${i}`, [diagramColumn("id"), diagramColumn("p0", 2), diagramColumn("p1", 3)]),
    foreignKeys: [diagramForeignKey(`fk${i}a`, "p0", "t0"), diagramForeignKey(`fk${i}b`, "p1", "t1")] }));
  const snapshot = { ...diagramAfter, id: "dense", fingerprint: "dense", schemas: [{ name: "public", tables, views: [], enums: [] }] };
  const saveDiagramExport = vi.fn().mockResolvedValue({ path: "/tmp/dense.svg" });
  const onSelectTable = vi.fn();
  const { container } = render(<SchemaCanvas snapshot={snapshot} query="" canvasSettings={defaultAppSettings().canvas}
    runtimeKind="web" onSelectTable={onSelectTable} platform={{ saveDiagramExport } as unknown as NodalStudioPlatform} />);
  const exportButton = screen.getByRole("button", { name: "Export SVG" });
  await frames.until(() => expect(exportButton).toBeEnabled());
  const store = probe.store!;
  act(() => { store.setState({ width: 1200, height: 700, transform: [0, 0, 1] }); });
  const paths = () => container.querySelectorAll('[data-shared-edge="true"] .react-flow__edge-path');
  const stylesheet = document.createElement("style"); stylesheet.dataset.canvasRegression = ""; stylesheet.textContent = canvasStyles; document.head.append(stylesheet);

  await frames.until(() => expect(paths()).toHaveLength(1000));
  const allEdgeIds = new Set(store.getState().edges.map((edge) => edge.id));
  const expectCompletePaint = () => {
    const painted = [...container.querySelectorAll('[data-shared-edge="true"]')].map((edge) => edge.getAttribute("data-id"));
    expect(paths()).toHaveLength(1000);
    expect(painted).toHaveLength(allEdgeIds.size);
    expect(new Set(painted)).toEqual(allEdgeIds);
  };
  expectCompletePaint();
  expect(store.getState().nodes).toHaveLength(500); expect(store.getState().edges).toHaveLength(1000);
  expect(container.querySelectorAll("[data-shared-edge-layer]")).toHaveLength(1);
  const proxies = container.querySelectorAll<SVGGElement>("g.diagram-edge-proxy");
  expect(proxies).toHaveLength(1000);
  for (const proxy of proxies) {
    expect(proxy.childNodes).toHaveLength(0);
  }
  for (const index of [0, 500, 999]) expect(getComputedStyle(proxies[index].parentElement!).display).toBe("none");
  expect(getComputedStyle(container.querySelector("[data-shared-edge-layer]")!).display).not.toBe("none");
  expect(getComputedStyle(container.querySelector(".react-flow__marker")!).display).not.toBe("none");
  // The CSS guard must stop hiding a proxy if a future renderer paints in it.
  const guardedProxy = proxies[0].parentElement!;
  const nonempty = document.createElementNS("http://www.w3.org/2000/svg", "path");
  proxies[0].append(nonempty);
  expect(getComputedStyle(guardedProxy).display).not.toBe("none");
  nonempty.remove();

  const path = paths()[4]; const id = path.parentElement!.getAttribute("data-id")!;
  fireEvent.click(path, { clientX: 350, clientY: 150 });
  expect(onSelectTable).toHaveBeenCalledWith(undefined);
  expect(screen.getByLabelText("Relationship details")).toBeVisible();
  expect(store.getState().edges.find((edge) => edge.id === id)?.selected).toBe(true);
  expect(container.querySelector('[data-shared-edge="true"].selected')).not.toBeNull();
  fireEvent.keyDown(container.querySelector('[data-shared-edge="true"].selected')!, { key: "Escape" });
  expect(screen.queryByLabelText("Relationship details")).toBeNull();
  expect(store.getState().edges.some((edge) => edge.selected)).toBe(false);
  const keyboardEdge = container.querySelector<SVGGElement>(`[data-shared-edge="true"][data-id="${id}"]`)!;
  keyboardEdge.focus(); fireEvent.keyDown(keyboardEdge, { key: "Enter" });
  await frames.until(() => expect(container.querySelector('[data-shared-edge="true"].selected')).toHaveFocus());
  fireEvent.keyDown(container.querySelector('[data-shared-edge="true"].selected')!, { key: "Escape" });
  const paintRoot = container.querySelector("[data-shared-edge-layer]");
  const stableEdge = store.getState().edges.find((edge) => edge.source === "public.t100")!;
  const moving = store.getState().nodes.find((node) => node.id === "public.t4")!;
  act(() => store.getState().triggerNodeChanges([{ type: "position", id: moving.id, position: { x: moving.position.x + 10, y: moving.position.y }, dragging: true }]));
  await frames.until(() => expect(paths().length).toBeLessThan(10));
  expect(container.querySelector("[data-shared-edge-layer]")).toBe(paintRoot);
  expect(paintRoot?.isConnected).toBe(true);
  expect(store.getState().nodes).toHaveLength(500);
  expect(screen.getByRole("button", { name: "Export SVG" })).toBeDisabled();
  act(() => store.getState().triggerNodeChanges([{ type: "position", id: moving.id, position: { x: moving.position.x + 10, y: moving.position.y }, dragging: false }]));
  const recoveryStarted = frames.now();
  await frames.advance();
  const partialCount = paths().length;
  expect(partialCount).toBeGreaterThan(0); expect(partialCount).toBeLessThan(1000);
  expect(screen.getByText("Drawing relationships…")).toBeVisible();
  expect(exportButton).toBeDisabled();
  await frames.advance();
  expect(paths()).toHaveLength(partialCount); // Recovery yields between batches.
  await frames.until(expectCompletePaint);
  if (interval === 250) expect(frames.now() - recoveryStarted).toBeGreaterThan(1000);
  expect(screen.queryByText("Drawing relationships…")).not.toBeInTheDocument();
  expect(exportButton).toBeEnabled();
  expect(store.getState().edges.find((edge) => edge.id === stableEdge.id)).toBe(stableEdge);
  expect(container.querySelector("[data-shared-edge-layer]")).toBe(paintRoot);
  const exportFrameBudget = diagramExportFrameBudget({ edgeCount: allEdgeIds.size, tableCount: tables.length });
  const captured = new Set<string>();
  const append = vi.fn((batch: HTMLElement[]) => {
    expect(batch.length).toBeGreaterThan(0); expect(batch.length).toBeLessThanOrEqual(16);
    expect(container.querySelectorAll('.diagram-export-surface .table-node').length).toBeLessThanOrEqual(16);
    for (const table of batch) {
      expect(table).not.toHaveAttribute("data-overview");
      const id = table.closest(".react-flow__node")!.getAttribute("data-id")!;
      expect(captured.has(id)).toBe(false); captured.add(id);
    }
    expect(store.getState().nodes).toHaveLength(500);
  });
  const capturedEdges = new Set<string>();
  const capture = vi.spyOn(exporter, "createDiagramSvgCapture").mockImplementation((options) => {
    expect(options.tableIds?.size).toBe(500); expect(options.edgeIds?.size).toBe(1000);
    capturedEdges.clear();
    return { appendEdges: () => {
      const batch = options.root.querySelectorAll(".react-flow__edge");
      expect(batch.length).toBeGreaterThan(0); expect(batch.length).toBeLessThanOrEqual(64);
      for (const edge of batch) { const id = edge.getAttribute("data-id")!; expect(capturedEdges.has(id)).toBe(false); capturedEdges.add(id); }
      expect(store.getState().nodes).toHaveLength(500); expect(store.getState().edges).toHaveLength(1000);
    }, appendTables: append, finish: () => { expect(captured.size).toBe(500); expect(capturedEdges.size).toBe(1000); return { svg: "<svg/>", width: 160000, height: 1000 }; } };
  });
  fireEvent.click(screen.getByRole("button", { name: "Export SVG" }));
  await frames.until(() => expect(capture).toHaveBeenCalledOnce());
  await frames.until(() => expect(saveDiagramExport).toHaveBeenCalledOnce(), exportFrameBudget);
  expect(append.mock.calls.reduce((sum, [batch]) => sum + batch.length, 0)).toBe(500);
  await frames.until(() => expect(exportButton).toBeEnabled());
  const flow = container.querySelector<HTMLElement>(".schema-canvas-flow")!;
  expect(flow.inert).toBeFalsy(); expect(flow).not.toHaveAttribute("aria-hidden");
  const transform = store.getState().transform;
  append.mockImplementationOnce(() => { throw new Error("batch failed"); });
  fireEvent.click(screen.getByRole("button", { name: "Export SVG" }));
  await frames.until(() => expect(screen.getByText(/Unable to export SVG diagram/)).toBeVisible(), exportFrameBudget);
  expect(flow.inert).toBeFalsy(); expect(flow).not.toHaveAttribute("aria-hidden");
  expect(store.getState().transform).toEqual(transform);
  expect(store.getState().nodes).toHaveLength(500);
  expect(store.getState().edges).toHaveLength(1000);
  expect(saveDiagramExport).toHaveBeenCalledOnce();
  stylesheet.remove();
  fireEvent.click(screen.getByRole("button", { name: "Relationships" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Physical relationships" }));
  await frames.until(() => expect(container.querySelectorAll("[data-shared-edge-layer]")).toHaveLength(0));
  fireEvent.click(screen.getByRole("checkbox", { name: "Physical relationships" }));
  await frames.until(expectCompletePaint);
  expect(container.querySelectorAll("[data-shared-edge-layer]")).toHaveLength(1);
// This checks 500 nodes / 1,000 edges in jsdom, not a wall-clock performance SLA.
// Windows hosted runners need more time; frame and batch bounds above still apply.
}, 120000);
