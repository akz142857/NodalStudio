import { createRef, useEffect } from "react";
import { ReactFlowProvider, useStoreApi } from "@xyflow/react";
import { getEdgePosition } from "@xyflow/system";
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";
import { buildSchemaGraph, type FieldEdge, type TableNode } from "../graph/schema-graph";
import { comparisonEdgePath } from "../graph/comparison-edge-path";
import { seedCanvasGeometry } from "../graph/canvas-geometry";
import { diagramAfter, diagramBefore, diagramChangeSet } from "../test/diagram-comparison-fixture";
import { defaultAppSettings } from "../platform";
import { CanvasSettingsProvider } from "./CanvasSettingsContext";
import { DiagramExportSurface, type DiagramExportSurfaceHandle } from "./DiagramExportSurface";

beforeEach(() => Object.defineProperty(SVGElement.prototype, "getBBox", { configurable: true,
  value: () => ({ x: 0, y: 0, width: 80, height: 14 }) }));
afterEach(() => { Reflect.deleteProperty(SVGElement.prototype, "getBBox"); });

it("shares comparison cards and actual port paths without changing the model, and cleans up bounded batches", () => {
  const graph = buildSchemaGraph(diagramAfter, { beforeSnapshot: diagramBefore, changeSet: diagramChangeSet });
  graph.nodes = graph.nodes.map((node) => seedCanvasGeometry(node, true));
  let store: ReturnType<typeof useStoreApi<TableNode, FieldEdge>>;
  function Probe() { const value = useStoreApi<TableNode, FieldEdge>(); useEffect(() => { store = value; }, [value]); return null; }
  const ref = createRef<DiagramExportSurfaceHandle>();
  const { container } = render(<ReactFlowProvider initialNodes={graph.nodes} initialEdges={graph.edges}>
    <DiagramExportSurface ref={ref} /><Probe />
  </ReactFlowProvider>);
  const nodes = store!.getState().nodes, edges = store!.getState().edges, lookup = store!.getState().nodeLookup;
  const transform = [...store!.getState().transform];
  const node = graph.nodes.find((candidate) => candidate.id === "public.orders")!;
  const edge = graph.edges.find((candidate) => candidate.data?.changeStatus === "deleted")!;
  const position = getEdgePosition({ id: edge.id, sourceNode: lookup.get(edge.source)!, targetNode: lookup.get(edge.target)!,
    sourceHandle: edge.sourceHandle ?? null, targetHandle: edge.targetHandle ?? null, connectionMode: store!.getState().connectionMode })!;
  const expectedPath = comparisonEdgePath({ ...position, edgeStyle: edge.data?.edgeStyle, offset: edge.data?.comparisonOffset ?? 0 })[0];
  act(() => ref.current!.render({ nodes: [node], edges: [edge], viewport: { x: -40, y: 10, zoom: .2 }, className: "react-flow light large-model-mode schema-canvas-flow" }));
  expect(ref.current!.root()).toHaveAttribute("aria-hidden", "true");
  expect(ref.current!.root()).toHaveClass("light", "large-model-mode");
  expect(container.querySelector('.table-column[data-column-name="legacy_note"]')).toHaveAttribute("data-change", "deleted");
  expect(container.querySelector('.table-column[data-column-name="priority"]')).toHaveAttribute("data-change", "added");
  expect(container.querySelector(".react-flow__edge")).toHaveClass("comparison-edge-deleted");
  expect(container.querySelector(".react-flow__edge-path")).toHaveAttribute("d", expectedPath);
  expect(container.querySelector(".react-flow__edge-textwrapper")).toHaveAttribute("visibility", "visible");
  expect(container.querySelector(".react-flow__handle, .react-flow__resize-control")).toBeNull();
  expect(store!.getState().nodes).toBe(nodes); expect(store!.getState().edges).toBe(edges);
  expect(store!.getState().nodeLookup).toBe(lookup); expect(store!.getState().transform).toEqual(transform);
  // Invalid geometry is rejected before a React commit; the app and retry surface survive.
  expect(() => ref.current!.render({ nodes: [], edges: [{ ...edge, target: "missing" }], viewport: { x: 0, y: 0, zoom: 1 } })).toThrow("Relationship geometry");
  expect(container.querySelectorAll(".table-node")).toHaveLength(1);
  act(() => ref.current!.render());
  expect(container.querySelector(".table-node, .react-flow__edge")).toBeNull();
});

it("preserves a visible card's manually expanded indexes in a collapsed-index export", () => {
  const graph = buildSchemaGraph(diagramAfter);
  const node = { ...graph.nodes[0], data: { ...graph.nodes[0].data, table: { ...graph.nodes[0].data.table,
    indexes: [{ name: "manual_index", columns: ["id"], primary: false, unique: false, method: "btree", predicate: null }] } } };
  const ref = createRef<DiagramExportSurfaceHandle>();
  const { container } = render(<ReactFlowProvider initialNodes={[node]}>
    <CanvasSettingsProvider value={{ ...defaultAppSettings().canvas, indexes: "collapsed" }}><DiagramExportSurface ref={ref} /></CanvasSettingsProvider>
  </ReactFlowProvider>);
  act(() => ref.current!.render({ nodes: [node], edges: [], viewport: { x: 0, y: 0, zoom: 1 }, indexExpansion: new Map([[node.id, true]]) }));
  expect(container.querySelector(".table-indexes")).toHaveTextContent("manual_index");
});

it("reuses batch slots while refreshing table identities, index expansion and relationship labels", () => {
  const graph = buildSchemaGraph(diagramAfter, { beforeSnapshot: diagramBefore, changeSet: diagramChangeSet });
  graph.nodes = graph.nodes.map((node) => seedCanvasGeometry(node, true));
  const ref = createRef<DiagramExportSurfaceHandle>();
  const { container } = render(<ReactFlowProvider initialNodes={graph.nodes} initialEdges={graph.edges}>
    <CanvasSettingsProvider value={{ ...defaultAppSettings().canvas, indexes: "collapsed" }}><DiagramExportSurface ref={ref} /></CanvasSettingsProvider>
  </ReactFlowProvider>);
  const first = graph.nodes[0], second = graph.nodes[1];
  const viewport = { x: -25, y: 12, zoom: .2 };
  act(() => ref.current!.render({ nodes: [first], edges: [], viewport, indexExpansion: new Map([[first.id, true]]) }));
  const card = container.querySelector(".table-node");
  expect(card).toHaveAttribute("data-indexes-expanded", "true");
  act(() => ref.current!.render({ nodes: [second], edges: [], viewport, indexExpansion: new Map([[second.id, false]]) }));
  expect(container.querySelector(".table-node")).toBe(card);
  expect(card!.closest(".react-flow__node")).toHaveAttribute("data-id", second.id);
  expect(card).toHaveAttribute("data-indexes-expanded", "false");
  expect(card!.querySelector("header strong")).toHaveTextContent(second.data.table.key.name);
  const edge = graph.edges[0], next = graph.edges.find((candidate) => candidate.id !== edge.id)!;
  act(() => ref.current!.render({ nodes: [], edges: [{ ...edge, label: undefined }], viewport }));
  const path = container.querySelector(".react-flow__edge-path");
  act(() => ref.current!.render({ nodes: [], edges: [{ ...next, label: undefined, style: { stroke: "purple", strokeDasharray: "8 5" } }], viewport }));
  expect(container.querySelector(".react-flow__edge-path")).toBe(path);
  expect(path).toHaveAttribute("id", next.id);
  expect(path).toHaveStyle({ stroke: "purple", strokeDasharray: "8 5" });
  expect(container.querySelector(".react-flow__edge")).toHaveAttribute("data-id", next.id);
  act(() => ref.current!.render({ nodes: [], edges: [{ ...edge, label: "First label" }], viewport }));
  const firstLabel = container.querySelector(".react-flow__edge-text");
  expect(firstLabel).toHaveTextContent("First label");
  Object.defineProperty(SVGElement.prototype, "getBBox", { configurable: true, value: () => ({ x: 0, y: 0, width: 160, height: 14 }) });
  act(() => ref.current!.render({ nodes: [], edges: [{ ...next, label: "Different label" }], viewport }));
  expect(container.querySelector(".react-flow__edge-text")).not.toBe(firstLabel);
  expect(container.querySelector(".react-flow__edge-text")).toHaveTextContent("Different label");
  expect(Number(container.querySelector(".react-flow__edge-textbg")?.getAttribute("width"))).toBeGreaterThan(160);
  expect(container.querySelector(".react-flow__edge-textwrapper")).toHaveAttribute("visibility", "visible");
  act(() => ref.current!.render());
  expect(container.querySelector(".table-node, .react-flow__edge")).toBeNull();
});
