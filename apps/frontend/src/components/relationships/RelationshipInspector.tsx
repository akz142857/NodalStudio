import { translateUiLabel } from "../../i18n/business-labels";
import { useI18n } from "../../i18n";
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
  const { t: bt } = useI18n();
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
    ? bt("business.physicalFK")
    : data.relationshipKind === "logical"
      ? bt("business.logicalRelationship")
      : bt("business.inferredCandidate");
  return createPortal(
    <aside ref={inspectorRef} className="ds-surface relationship-inspector nodrag nopan" aria-label={bt("business.relationshipDetails")} style={{ ...position, visibility: positioned ? "visible" : "hidden" }}>
      <header className="relationship-inspector-drag-handle" data-dragging={dragging || undefined} tabIndex={0} aria-label={bt("business.moveRelationshipDetails")} title={bt("business.dragToMoveArrowKeysMove10PxShift")}
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
      ><div><span className="relationship-kind" data-kind={data.relationshipKind}>{kindLabel}</span><h2>{data.relationshipKind === "logical" ? bt("business.modelRelationship") : data.relationshipKind === "physical" ? bt("business.databaseForeignKey") : bt("business.suggestedRelationship")}</h2></div><button type="button" aria-label={bt("business.closeRelationshipDetails")} onClick={onClose}>×</button></header>
      {data.relationshipKind === "logical" ? <p className="relationship-fact-note">{bt("business.userDefinedLinkModelOnlyThisDashedLineIs")}</p> : null}
      {data.constraintName ? <p className="relationship-name">{data.constraintName}</p> : null}
      <RelationshipEndpoints source={logicalRelationship?.source ?? { schema: "", table: edge.source, columns: [data.sourceColumn] }} target={logicalRelationship?.target ?? { schema: "", table: edge.target, columns: [data.targetColumn] }} />
      <dl>
        {data.changeStatus ? <div><dt>{bt("business.change")}</dt><dd>{data.changeStatus} · {data.snapshotSide === "before" ? bt("business.beforeSnapshot") : bt("business.afterSnapshot")}</dd></div> : null}
        {data.cardinality ? <div><dt>{bt("business.cardinality")}</dt><dd>{translateUiLabel(relationshipCardinalityLabel(data.cardinality), bt)}</dd></div> : null}
        {data.relationshipStatus ? <div><dt>{bt("business.statusDetail")}</dt><dd>{translateUiLabel(relationshipStatusLabels[data.relationshipStatus], bt)}</dd></div> : null}
        {data.onDelete ? <div><dt>{bt("business.onDelete")}</dt><dd>{data.onDelete}</dd></div> : null}
        {data.onUpdate ? <div><dt>{bt("business.onUpdate")}</dt><dd>{data.onUpdate}</dd></div> : null}
      </dl>
      {data.note ? <p>{data.note}</p> : null}
      {data.evidence?.length ? <ul>{data.evidence.map((item) => <li key={item}>{item}</li>)}</ul> : null}
      {data.relationshipKind === "physical" ? <p className="relationship-fact-note">{bt("business.databaseConstraintReadOnly")}</p> : null}
      {data.relationshipKind === "logical" && !readOnly ? <div className="relationship-actions"><button type="button" className="ds-primary" title={bt("business.youCanAlsoDoubleClickTheRelationshipLine")} onClick={onEditLogical}>{bt("business.editDetailDetail")}</button><button type="button" onClick={onToggleLogical}>{data.relationshipStatus === "disabled" ? bt("business.enable") : bt("business.disable")}</button><button type="button" className="danger" title={bt("business.deleteOrBackspaceAlsoRemovesTheSelectedLogicalRelationship")} onClick={onDeleteLogical}>{bt("business.deleteDetailDetail")}</button></div> : null}
      {data.relationshipKind === "inferred" ? <p className="relationship-fact-note">{bt("business.namingSuggestionBusinessMeaningAndStoredDataHaveNot")}</p> : null}
      {data.relationshipKind === "inferred" && !readOnly ? <div className="relationship-actions"><button type="button" className="ds-primary" onClick={onConfirmInference}>{bt("business.reviewCandidate")}</button><button type="button" onClick={onDismissInference}>{bt("business.ignoreCandidate")}</button><details><summary>{bt("business.moreDetail")}</summary><button type="button" onClick={onIgnoreInferenceRule}>{bt("business.stopSuggestingThisSourceField")}</button></details></div> : null}
    </aside>,
    document.body,
  );
}
