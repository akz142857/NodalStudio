import { useCallback, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import type { LogicalRelationship } from "../../platform";
import { RelationshipEndpoints } from "./RelationshipPresentation";
import { relationshipCardinalityLabel, relationshipStatusLabels } from "./relationship-labels";
import "./relationships.css";
import type { FieldEdge } from "../../graph/schema-graph";
import { clampRelationshipPanelPosition, floatingRelationshipPanelPosition } from "../../graph/relationship-interaction";

interface RelationshipInspectorProps {
  edge: FieldEdge;
  logicalRelationship?: LogicalRelationship;
  readOnly?: boolean;
  anchor: { x: number; y: number };
  onEditLogical: () => void;
  onToggleLogical: () => void;
  onDeleteLogical: () => void;
  onConfirmInference: () => void;
  onDismissInference: () => void;
  onIgnoreInferenceRule: () => void;
  onClose: () => void;
}

export function RelationshipInspector({
  edge,
  logicalRelationship,
  readOnly = false,
  anchor,
  onEditLogical,
  onToggleLogical,
  onDeleteLogical,
  onConfirmInference,
  onDismissInference,
  onIgnoreInferenceRule,
  onClose,
}: RelationshipInspectorProps) {
  const inspectorRef = useRef<HTMLElement>(null);
  const [position, setPosition] = useState({ left: 12, top: 12 });
  const [positioned, setPositioned] = useState(false);
  const [dragging, setDragging] = useState(false);
  const manualPosition = useRef<{ edgeId: string; left: number; top: number } | undefined>(undefined);
  const drag = useRef<{ edgeId: string; pointerId: number; offsetX: number; offsetY: number } | undefined>(undefined);
  const measurePanel = useCallback(() => {
    const inspector = inspectorRef.current;
    if (!inspector) return;
    // The app scales document.body with CSS zoom; pointer coordinates are unscaled viewport pixels.
    const scale = Number.parseFloat(getComputedStyle(document.body).zoom) || 1;
    inspector.style.maxWidth = `${Math.max(0, window.innerWidth - 24) / scale}px`;
    inspector.style.maxHeight = `${Math.max(0, window.innerHeight - 24) / scale}px`;
    const bounds = inspector.getBoundingClientRect();
    return { scale, bounds, viewport: { width: window.innerWidth, height: window.innerHeight }, panel: { width: Math.ceil(bounds.width), height: Math.ceil(bounds.height) } };
  }, []);
  const updatePosition = useCallback(() => {
    const measured = measurePanel();
    if (!measured) return;
    const { scale, viewport, panel } = measured;
    const manual = manualPosition.current?.edgeId === edge.id ? manualPosition.current : undefined;
    const next = manual ? clampRelationshipPanelPosition(manual, viewport, panel) : floatingRelationshipPanelPosition(anchor, viewport, panel);
    if (manual) manualPosition.current = { edgeId: edge.id, ...next };
    setPosition({ left: next.left / scale, top: next.top / scale });
    setPositioned(true);
  }, [anchor, edge.id, measurePanel]);

  const movePanel = (next: { left: number; top: number }) => {
    const measured = measurePanel();
    if (!measured) return;
    const clamped = clampRelationshipPanelPosition(next, measured.viewport, measured.panel);
    manualPosition.current = { edgeId: edge.id, ...clamped };
    setPosition({ left: clamped.left / measured.scale, top: clamped.top / measured.scale });
  };
  const endDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = undefined;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  useLayoutEffect(() => {
    updatePosition();
    const inspector = inspectorRef.current;
    const observer = inspector && typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(updatePosition)
      : undefined;
    if (inspector) observer?.observe(inspector);
    window.addEventListener("resize", updatePosition);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", updatePosition);
    };
  }, [updatePosition]);

  const data = edge.data;
  if (!data) return null;
  const kindLabel = data.relationshipKind === "physical"
    ? "Physical FK"
    : data.relationshipKind === "logical"
      ? "Logical relationship"
      : "Inferred candidate";
  return createPortal(
    <aside ref={inspectorRef} className="ds-surface relationship-inspector nodrag nopan" aria-label="Relationship details" style={{ ...position, visibility: positioned ? "visible" : "hidden" }}>
      <header className="relationship-inspector-drag-handle" data-dragging={dragging || undefined} tabIndex={0} aria-label="Move relationship details" title="Drag to move · Arrow keys move 10 px · Shift + arrow keys move 1 px"
        onPointerDown={(event) => {
          if (event.button !== 0 || event.isPrimary === false || (event.target instanceof Element && event.target.closest("button"))) return;
          const measured = measurePanel();
          if (!measured) return;
          event.preventDefault(); event.stopPropagation();
          event.currentTarget.focus({ preventScroll: true });
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { edgeId: edge.id, pointerId: event.pointerId, offsetX: event.clientX - measured.bounds.left, offsetY: event.clientY - measured.bounds.top };
          setDragging(true);
        }}
        onPointerMove={(event) => {
          const active = drag.current;
          if (!active || active.edgeId !== edge.id || active.pointerId !== event.pointerId) return;
          event.preventDefault(); event.stopPropagation();
          movePanel({ left: event.clientX - active.offsetX, top: event.clientY - active.offsetY });
        }}
        onPointerUp={endDrag} onPointerCancel={endDrag} onLostPointerCapture={endDrag}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
          const measured = measurePanel();
          if (!measured) return;
          event.preventDefault(); event.stopPropagation();
          const step = event.shiftKey ? 1 : 10;
          movePanel({ left: measured.bounds.left + (event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0), top: measured.bounds.top + (event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0) });
        }}
      ><div><span className="relationship-kind" data-kind={data.relationshipKind}>{kindLabel}</span><h2>{data.relationshipKind === "logical" ? "Model relationship" : data.relationshipKind === "physical" ? "Database foreign key" : "Suggested relationship"}</h2></div><button type="button" aria-label="Close relationship details" onClick={onClose}>×</button></header>
      {data.relationshipKind === "logical" ? <p className="relationship-fact-note">User-defined link · model only. This dashed line is independent of database foreign key constraints.</p> : null}
      {data.constraintName ? <p className="relationship-name">{data.constraintName}</p> : null}
      <RelationshipEndpoints source={logicalRelationship?.source ?? { schema: "", table: edge.source, columns: [data.sourceColumn] }} target={logicalRelationship?.target ?? { schema: "", table: edge.target, columns: [data.targetColumn] }} />
      <dl>
        {data.changeStatus ? <div><dt>Change</dt><dd>{data.changeStatus} · {data.snapshotSide === "before" ? "Before snapshot" : "After snapshot"}</dd></div> : null}
        {data.cardinality ? <div><dt>Cardinality</dt><dd>{relationshipCardinalityLabel(data.cardinality)}</dd></div> : null}
        {data.relationshipStatus ? <div><dt>Status</dt><dd>{relationshipStatusLabels[data.relationshipStatus]}</dd></div> : null}
        {data.onDelete ? <div><dt>On delete</dt><dd>{data.onDelete}</dd></div> : null}
        {data.onUpdate ? <div><dt>On update</dt><dd>{data.onUpdate}</dd></div> : null}
        {data.confidence ? <div><dt>Confidence</dt><dd>{Math.round(data.confidence * 100)}%</dd></div> : null}
      </dl>
      {data.note ? <p>{data.note}</p> : null}
      {data.evidence?.length ? <ul>{data.evidence.map((item) => <li key={item}>{item}</li>)}</ul> : null}
      {data.relationshipKind === "physical" ? <p className="relationship-fact-note">Database constraint · read only</p> : null}
      {data.relationshipKind === "logical" && !readOnly ? <div className="relationship-actions"><button type="button" className="ds-primary" title="You can also double-click the relationship line" onClick={onEditLogical}>Edit</button><button type="button" onClick={onToggleLogical}>{data.relationshipStatus === "disabled" ? "Enable" : "Disable"}</button><button type="button" className="danger" title="Delete or Backspace also removes the selected logical relationship" onClick={onDeleteLogical}>Delete…</button></div> : null}
      {data.relationshipKind === "inferred" && !readOnly ? <div className="relationship-actions"><button type="button" onClick={onConfirmInference}>Confirm as logical</button><button type="button" onClick={onDismissInference}>Dismiss</button><button type="button" onClick={onIgnoreInferenceRule}>Ignore naming rule</button></div> : null}
    </aside>,
    document.body,
  );
}
