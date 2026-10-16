import { createExportDetailStore } from "./export-detail-store";
import { useEffect } from "react";
import { ReactFlowProvider, useStoreApi, type NodeProps } from "@xyflow/react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { getEdgePosition, getHandleBounds } from "@xyflow/system";
import { seedCanvasGeometry } from "../graph/canvas-geometry";
import { describe, expect, it, vi } from "vitest";
import type { TableNode as TableNodeType } from "../graph/schema-graph";
import { CanvasInteractionProvider } from "./CanvasInteractionContext";
import { TableNode } from "./TableNode";
import { buildSchemaGraph } from "../graph/schema-graph";
import { diagramAfter, diagramBefore, diagramChangeSet } from "../test/diagram-comparison-fixture";
import { CanvasSettingsProvider } from "./CanvasSettingsContext";
import { defaultAppSettings } from "../platform";

describe("TableNode", () => {
  it("shows changed and historical fields beyond the ordinary column cap with explicit labels", () => {
    const graph = buildSchemaGraph(diagramAfter, { beforeSnapshot: diagramBefore, changeSet: diagramChangeSet, maxInitialColumns: 1 });
    const node = graph.nodes.find((item) => item.id === "public.orders")!;
    const props = { ...node, dragging: false, zIndex: 0, isConnectable: false, positionAbsoluteX: 0, positionAbsoluteY: 0 } as NodeProps<TableNodeType>;
    const { container } = render(<ReactFlowProvider><CanvasSettingsProvider value={{ ...defaultAppSettings().canvas, maxInitialColumns: 1 }}><TableNode {...props} /></CanvasSettingsProvider></ReactFlowProvider>);
    expect(container.querySelector('[data-column-name="legacy_note"]')).toHaveAttribute("data-change", "deleted");
    expect(container.querySelector('[data-column-name="priority"]')).toHaveAttribute("data-change", "added");
    expect(container.querySelector('[data-column-name="user_id"]')).toHaveAttribute("data-change", "modified");
    expect(screen.getByTitle("Inferred rename from old_name")).toBeVisible();
    expect(screen.getAllByText(/− deleted/)).toHaveLength(2);
    expect(screen.getByText(/\+ added/)).toBeVisible();
    expect(container.querySelector('[data-handleid="source:user_id:right"]')).toBeInTheDocument();
    expect(screen.queryByText(/more unchanged fields/)).not.toBeInTheDocument();
  });

  it("labels a deleted table and all its fields as Before definitions", () => {
    const graph = buildSchemaGraph(diagramAfter, { beforeSnapshot: diagramBefore, changeSet: diagramChangeSet, maxInitialColumns: 1 });
    const node = graph.nodes.find((item) => item.id === "public.audit")!;
    const props = { ...node, dragging: false, zIndex: 0, isConnectable: false, positionAbsoluteX: 0, positionAbsoluteY: 0 } as NodeProps<TableNodeType>;
    const { container } = render(<ReactFlowProvider><TableNode {...props} /></ReactFlowProvider>);
    expect(screen.getByTitle("Deleted table · Before snapshot")).toBeVisible();
    expect(container.querySelectorAll('.table-column[data-change="deleted"]')).toHaveLength(2);
    expect(container.querySelector('[data-handleid="source:order_id:right"]')).toBeInTheDocument();
  });

  it("shows physical FK fields and collected indexes", () => {
    const offsetTop = vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockImplementation(function (this: HTMLElement) {
      return this.dataset.columnName ? 140 : this.classList.contains("table-node") ? 20 : 0;
    });
    const offsetHeight = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.dataset.columnName ? 28 : 0;
    });
    const props = {
      id: "public.orders",
      type: "table",
      selected: true,
      dragging: false,
      zIndex: 0,
      isConnectable: false,
      positionAbsoluteX: 0,
      positionAbsoluteY: 0,
      data: {
        schema: "public",
        table: {
          key: { kind: "table", schema: "public", name: "orders" },
          tableKind: "ordinary",
          columns: [{
            name: "user_id", ordinalPosition: 1, formattedType: "uuid",
            typeSchema: "pg_catalog", typeName: "uuid", nullable: false,
            defaultValue: null, identity: null, generated: false, comment: null,
          }],
          primaryKey: null,
          foreignKeys: [{
            name: "orders_user_fk", columns: ["user_id"], referencedSchema: "public",
            referencedTable: "users", referencedColumns: ["id"], onUpdate: "noAction",
            onDelete: "cascade", matchType: "simple", deferrable: false,
            initiallyDeferred: false,
          }],
          indexes: [{
            name: "orders_user_idx", method: "btree", columns: ["user_id"],
            unique: false, primary: false, predicate: null,
          }],
          constraints: [],
          comment: null,
        },
      },
    } as unknown as NodeProps<TableNodeType>;

    const { container } = render(<ReactFlowProvider><TableNode {...props} /></ReactFlowProvider>);

    expect(screen.getByTitle("Physical foreign key")).toHaveTextContent("FK");
    expect(screen.getByText("orders_user_idx")).toBeVisible();
    expect(screen.getAllByText("IX")).toHaveLength(2);
    expect(screen.getByTitle("Index member")).toBeVisible();
    expect(container.querySelector('[data-handleid="source:user_id:left"]')).toBeInTheDocument();
    expect(container.querySelector('[data-handleid="source:user_id:right"]')).toBeInTheDocument();
    expect(container.querySelector(".table-node")?.contains(container.querySelector('[data-handleid="source:user_id:left"]'))).toBe(false);
    expect(container.querySelector('[data-handleid="source:user_id:left"]')?.parentElement).toHaveClass("field-handle-row");
    expect(container.querySelector<HTMLElement>(".field-handle-row")?.style.top).toBe("134px");
    expect(container.querySelectorAll(".table-resize-handle")).toHaveLength(4);
    expect(container.querySelectorAll(".table-resize-line")).toHaveLength(4);

    const editableProps = { ...props, data: { ...props.data, relationshipsEditable: true } } as NodeProps<TableNodeType>;
    const editable = render(<ReactFlowProvider><TableNode {...editableProps} /></ReactFlowProvider>);
    expect(editable.container.querySelector('[data-handleid="target:user_id:left"]')).toBeInTheDocument();
    expect(editable.container.querySelector('[data-handleid="source:user_id:right"]')).toHaveClass("field-handle-source");

    const panMode = render(<ReactFlowProvider><CanvasInteractionProvider value={{ spacePanMode: true }}><TableNode {...props} /></CanvasInteractionProvider></ReactFlowProvider>);
    expect(panMode.container.querySelectorAll(".table-resize-handle")).toHaveLength(0);
    offsetTop.mockRestore();
    offsetHeight.mockRestore();
  });

  it("only mounts handles for relationship columns, revealing the rest on hover or while connecting", () => {
    const offsetTop = vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockImplementation(function (this: HTMLElement) {
      return this.dataset.columnName ? 140 : this.classList.contains("table-node") ? 20 : 0;
    });
    const offsetHeight = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.dataset.columnName ? 28 : 0;
    });
    const column = (name: string) => ({
      name, ordinalPosition: 1, formattedType: "uuid",
      typeSchema: "pg_catalog", typeName: "uuid", nullable: false,
      defaultValue: null, identity: null, generated: false, comment: null,
    });
    const props = {
      id: "public.orders",
      type: "table",
      selected: false,
      dragging: false,
      zIndex: 0,
      isConnectable: false,
      positionAbsoluteX: 0,
      positionAbsoluteY: 0,
      data: {
        schema: "public",
        // Editable is the expensive case: it used to force four handles onto
        // every column of every table.
        relationshipsEditable: true,
        table: {
          key: { kind: "table", schema: "public", name: "orders" },
          tableKind: "ordinary",
          columns: [column("user_id"), column("note")],
          primaryKey: null,
          foreignKeys: [{
            name: "orders_user_fk", columns: ["user_id"], referencedSchema: "public",
            referencedTable: "users", referencedColumns: ["id"], onUpdate: "noAction",
            onDelete: "cascade", matchType: "simple", deferrable: false,
            initiallyDeferred: false,
          }],
          indexes: [],
          constraints: [],
          comment: null,
        },
      },
    } as unknown as NodeProps<TableNodeType>;

    // `user_id` carries the FK, `note` carries nothing.
    const { container } = render(<ReactFlowProvider><TableNode {...props} /></ReactFlowProvider>);
    expect(container.querySelector('[data-handleid="source:user_id:left"]')).toBeInTheDocument();
    expect(container.querySelector('[data-handleid="source:note:left"]')).not.toBeInTheDocument();

    // Hovering the bare column mounts its handles so a drag can start there.
    const noteRow = container.querySelector('[data-column-name="note"]');
    expect(noteRow).not.toBeNull();
    fireEvent.mouseEnter(noteRow as Element);
    expect(container.querySelector('[data-handleid="source:note:left"]')).toBeInTheDocument();

    // While a relationship is being connected every column must be droppable.
    const connecting = {
      ...props,
      data: { ...props.data, relationshipConnectTargets: { user_id: "valid", note: "warning" } },
    } as unknown as NodeProps<TableNodeType>;
    const dropTargets = render(<ReactFlowProvider><TableNode {...connecting} /></ReactFlowProvider>);
    expect(dropTargets.container.querySelector('[data-handleid="target:note:left"]')).toBeInTheDocument();

    offsetTop.mockRestore();
    offsetHeight.mockRestore();
  });

  it("exposes the domain colour as a custom property instead of a border override", () => {
    const props = {
      id: "public.orders",
      type: "table",
      selected: false,
      dragging: false,
      zIndex: 0,
      isConnectable: false,
      positionAbsoluteX: 0,
      positionAbsoluteY: 0,
      data: {
        schema: "public",
        domainColor: "#ff00aa",
        changeStatus: "added",
        table: {
          key: { kind: "table", schema: "public", name: "orders" },
          tableKind: "ordinary",
          columns: [],
          primaryKey: null,
          foreignKeys: [],
          indexes: [],
          constraints: [],
          comment: null,
        },
      },
    } as unknown as NodeProps<TableNodeType>;

    const { container } = render(<ReactFlowProvider><TableNode {...props} /></ReactFlowProvider>);
    const node = container.querySelector<HTMLElement>(".table-node");
    expect(node).toHaveAttribute("data-domain", "true");
    expect(node?.style.getPropertyValue("--domain-color")).toBe("#ff00aa");
    // The change-status border must survive: domain colour lives on its own channels.
    expect(node?.style.borderTopColor).toBe("");
    expect(node).toHaveAttribute("data-change", "added");
  });
});

function TestZoom({ zoom }: { zoom: number }) {
  const store = useStoreApi();
  useEffect(() => { store.setState({ transform: [0, 0, zoom] }); }, [store, zoom]);
  return null;
}

it("retains seeded and measured anchors without overview Handle subscriptions, restoring them for selection and connecting", async () => {
  const graph = buildSchemaGraph(diagramAfter);
  const nodes = graph.nodes.map((node) => seedCanvasGeometry(node, true));
  const node = nodes.find((item) => item.id === "public.orders")!;
  const edge = graph.edges.find((item) => item.source === node.id)!;
  const props = { ...node, selected: false, dragging: false, zIndex: 0, isConnectable: false, positionAbsoluteX: 0, positionAbsoluteY: 0 } as NodeProps<TableNodeType>;
  let store: ReturnType<typeof useStoreApi>;
  function Probe() { const value = useStoreApi(); useEffect(() => { store = value; }, [value]); return null; }
  function Diagram({ selected = false, connecting = false }: { selected?: boolean; connecting?: boolean }) {
    return <ReactFlowProvider initialNodes={nodes}><TestZoom zoom={.2} /><Probe />
      <CanvasInteractionProvider value={{ spacePanMode: false, overviewEnabled: true }}>
        <TableNode {...props} selected={selected} data={connecting ? { ...node.data, relationshipConnectTargets: { user_id: "valid" } } : node.data} />
      </CanvasInteractionProvider>
    </ReactFlowProvider>;
  }
  const { container, rerender } = render(<Diagram />);
  const position = () => {
    const state = store!.getState();
    return getEdgePosition({ id: edge.id, sourceNode: state.nodeLookup.get(edge.source)!, targetNode: state.nodeLookup.get(edge.target)!,
      sourceHandle: edge.sourceHandle ?? null, targetHandle: edge.targetHandle ?? null, connectionMode: state.connectionMode });
  };
  const seeded = position();
  expect(seeded).not.toBeNull();
  expect(container.querySelector(".table-node")).toHaveAttribute("data-overview", "true");
  expect(container.querySelector(".react-flow__handle")).toHaveAttribute("data-passive-handle", "true");
  expect(getHandleBounds("source", container as HTMLDivElement, container.getBoundingClientRect(), .2, node.id)?.length).toBeGreaterThan(0);
  expect(store!.getState().nodes.find((item) => item.id === node.id)?.handles?.length).toBeGreaterThan(0);
  rerender(<Diagram selected />);
  await act(async () => { await Promise.resolve(); });
  expect(container.querySelector('[data-handleid="source:user_id:right"]')).not.toBeNull();
  expect(container.querySelector("[data-passive-handle]")).toBeNull();
  const measured = position();
  expect(measured).not.toBeNull();
  rerender(<Diagram />);
  expect(container.querySelector(".react-flow__handle")).toHaveAttribute("data-passive-handle", "true");
  expect(getHandleBounds("source", container as HTMLDivElement, container.getBoundingClientRect(), .2, node.id)?.length).toBeGreaterThan(0);
  expect(position()).toEqual(measured);
  rerender(<Diagram connecting />);
  expect(container.querySelector(".table-node")).not.toHaveAttribute("data-overview");
  expect(container.querySelector('[data-handleid="source:user_id:right"]')).not.toBeNull();
  expect(position()).not.toBeNull();
  expect(container.querySelector("[data-passive-handle]")).toBeNull();
});

it("collapses unreadable fields in overview, keeps relation anchors and restores detail for selection, zoom and export", () => {
  const top = vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockReturnValue(42);
  const rowHeight = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(27);
  const node = buildSchemaGraph(diagramAfter, { beforeSnapshot: diagramBefore, changeSet: diagramChangeSet }).nodes.find((item) => item.id === "public.orders")!;
  const props = { ...node, selected: false, dragging: false, zIndex: 0, isConnectable: false, positionAbsoluteX: 0, positionAbsoluteY: 0 } as NodeProps<TableNodeType>;
  function Diagram({ zoom = .2, selected = false, exporting = false, exportTableIds }: { zoom?: number; selected?: boolean; exporting?: boolean; exportTableIds?: ReadonlySet<string> }) {
    return <ReactFlowProvider><TestZoom zoom={zoom} /><CanvasInteractionProvider value={{ spacePanMode: false, overviewEnabled: true, exportRendering: exporting, exportDetails: (() => { const store = createExportDetailStore(); store.set(exportTableIds); return store; })() }}><TableNode {...props} selected={selected} /></CanvasInteractionProvider></ReactFlowProvider>;
  }
  const { container, rerender } = render(<Diagram />);
  expect(container.querySelector(".table-node")).toHaveAttribute("data-overview", "true");
  expect(container.querySelectorAll(".table-column")).toHaveLength(0);
  expect(screen.getByText(/Zoom in for details/)).toHaveTextContent(/changed/);
  expect(screen.getByText(/~ modified/)).toBeInTheDocument();
  const handle = container.querySelector<HTMLElement>('[data-handleid="source:user_id:right"]');
  expect(handle).toBeInTheDocument();
  const anchor = handle?.parentElement?.style.top;
  rerender(<Diagram selected />);
  expect(container.querySelector('[data-column-name="legacy_note"]')).toHaveAttribute("data-change", "deleted");
  expect(container.querySelector('[data-handleid="source:user_id:right"]')?.parentElement?.style.top).toBe(anchor);
  rerender(<Diagram zoom={.6} />);
  expect(container.querySelectorAll(".table-column").length).toBeGreaterThan(0);
  rerender(<Diagram exporting />);
  expect(container.querySelectorAll(".table-column").length).toBeGreaterThan(0);
  const measuredBeforeBatch = top.mock.calls.length;
  // Even selected close-up cards stay compact outside the active export batch.
  rerender(<Diagram zoom={1} selected exporting exportTableIds={new Set()} />);
  expect(container.querySelectorAll(".table-column")).toHaveLength(0);
  // In-place (small diagram) export must keep anchors for its live edges.
  expect(container.querySelector('[data-handleid="source:user_id:right"]')).toBeInTheDocument();
  rerender(<Diagram zoom={1} selected exporting exportTableIds={new Set([node.id])} />);
  expect(container.querySelector('[data-column-name="legacy_note"]')).toHaveAttribute("data-change", "deleted");
  // React Flow applies viewport culling in a later commit. Keep the explicit
  // overview override during that gap even after exportRendering becomes false.
  rerender(<Diagram zoom={1} selected exportTableIds={new Set()} />);
  expect(container.querySelectorAll(".table-column")).toHaveLength(0);
  expect(top).toHaveBeenCalledTimes(measuredBeforeBatch);
  rerender(<Diagram zoom={1} selected />);
  expect(container.querySelectorAll(".table-column").length).toBeGreaterThan(0);
  expect(top.mock.calls.length).toBeGreaterThan(measuredBeforeBatch);
  rerender(<Diagram />);
  expect(container.querySelectorAll(".table-column")).toHaveLength(0);
  top.mockRestore(); rowHeight.mockRestore();
});
