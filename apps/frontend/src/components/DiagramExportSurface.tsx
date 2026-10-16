import { forwardRef, useImperativeHandle, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useStoreApi, type EdgeProps, type Viewport } from "@xyflow/react";
import { getEdgePosition, getMarkerId } from "@xyflow/system";
import type { FieldEdge, TableNode as TableNodeType } from "../graph/schema-graph";
import { CanvasInteractionProvider } from "./CanvasInteractionContext";
import { TableNode } from "./TableNode";
import { ComparisonEdge } from "./relationships/ComparisonEdge";

export interface ExportBatch { nodes: TableNodeType[]; edges: FieldEdge[]; viewport: Viewport; indexExpansion?: ReadonlyMap<string, boolean>; className?: string }
export interface DiagramExportSurfaceHandle {
  root: () => HTMLDivElement | null;
  render: (batch?: ExportBatch) => void;
}
interface PreparedBatch extends Omit<ExportBatch, "nodes" | "edges"> {
  nodes: { node: TableNodeType; position: { x: number; y: number } }[];
  edges: EdgeProps<FieldEdge>[];
}

/** Measurable, unpainted batches share card/edge presentation, never the canvas
 * renderer lifecycle. No node/edge is added to or removed from its model. */
export const DiagramExportSurface = forwardRef<DiagramExportSurfaceHandle>(function DiagramExportSurface(_, ref) {
  const root = useRef<HTMLDivElement>(null);
  const [batch, setBatch] = useState<PreparedBatch>();
  const store = useStoreApi<TableNodeType, FieldEdge>();
  useImperativeHandle(ref, () => ({ root: () => root.current, render: (next) => {
    // Validate/resolve outside React rendering so failures follow the normal
    // export error/retry path rather than tearing down the application root.
    const state = store.getState();
    const marker = (value: FieldEdge["markerEnd"]) => value ? `url('#${getMarkerId(value, state.rfId)}')` : undefined;
    const prepared: PreparedBatch | undefined = next && { ...next, nodes: next.nodes.map((node) => {
      const internal = state.nodeLookup.get(node.id);
      if (!internal) throw new Error(`Table geometry is unavailable: ${node.id}`);
      return { node, position: { ...internal.internals.positionAbsolute } };
    }), edges: next.edges.map((edge) => {
      const sourceNode = state.nodeLookup.get(edge.source), targetNode = state.nodeLookup.get(edge.target);
      const position = sourceNode && targetNode ? getEdgePosition({ id: edge.id, sourceNode, targetNode,
        sourceHandle: edge.sourceHandle ?? null, targetHandle: edge.targetHandle ?? null, connectionMode: state.connectionMode }) : null;
      if (!position) throw new Error(`Relationship geometry is unavailable: ${edge.id}`);
      return { ...edge, ...position, sourceHandleId: edge.sourceHandle, targetHandleId: edge.targetHandle,
        selected: Boolean(edge.selected), selectable: false, deletable: false, markerStart: marker(edge.markerStart), markerEnd: marker(edge.markerEnd) };
    }) };
    flushSync(() => setBatch(prepared));
  } }), [store]);
  return <div ref={root} className={`${batch?.className ?? "schema-canvas-flow react-flow"} diagram-export-surface`} aria-hidden="true" inert
    style={{ position: "absolute", inset: 0, opacity: 0, pointerEvents: "none", contain: "layout style paint", overflow: "hidden" }}>
    <CanvasInteractionProvider value={{ spacePanMode: false, layoutEditingDisabled: true, exportRendering: true, exportReplica: true }}>
      <div className="react-flow__viewport" style={{ transform: batch ? `translate(${batch.viewport.x}px, ${batch.viewport.y}px) scale(${batch.viewport.zoom})` : undefined }}>
        {/* Export copies are controlled by the current batch, so fixed slots
            reuse DOM without carrying table-local state into the next card. */}
        <div className="react-flow__nodes">{batch?.nodes.map(({ node, position }, slot) => {
          return <div key={slot} className={`react-flow__node react-flow__node-table${node.selected ? " selected" : ""}`} data-id={node.id}
            style={{ ...node.style, position: "absolute", transform: `translate(${position.x}px,${position.y}px)`, width: node.width, height: node.height }}>
            <TableNode id={node.id} type="table" data={node.data} selected={Boolean(node.selected)} dragging={false}
              draggable={false} selectable={false} deletable={false} isConnectable={false} zIndex={0}
              positionAbsoluteX={position.x} positionAbsoluteY={position.y} width={node.width} height={node.height} exportIndexesExpanded={batch.indexExpansion?.get(node.id)} />
          </div>;
        })}</div>
        <div className="react-flow__edges"><svg style={{ position: "absolute", width: 1, height: 1, overflow: "visible" }}>{batch?.edges.map((edge, slot) => {
          const status = edge.data?.changeStatus;
          return <g key={slot} data-id={edge.id} className={`react-flow__edge selectable nopan${edge.selected ? " selected" : ""}${status ? ` comparison-edge comparison-edge-${status}` : ""}`}>
            {/* EdgeText retains its previous nonzero measurement while a new
                label's effect is pending. Remount labeled edges so readiness
                cannot accept a stale label box from the previous slot. */}
            <ComparisonEdge key={edge.label ? edge.id : undefined} {...edge} />
          </g>;
        })}</svg></div>
      </div>
    </CanvasInteractionProvider>
  </div>;
});
