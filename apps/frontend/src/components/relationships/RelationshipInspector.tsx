import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { LogicalRelationship } from "../../platform";
import { RelationshipEndpoints } from "./RelationshipPresentation";
import { relationshipCardinalityLabel, relationshipStatusLabels } from "./relationship-labels";
import "./relationships.css";
import type { FieldEdge } from "../../graph/schema-graph";
import { floatingRelationshipPanelPosition } from "../../graph/relationship-interaction";

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
  const updatePosition = useCallback(() => {
    const inspector = inspectorRef.current;
    if (!inspector) return;
    const bounds = inspector.getBoundingClientRect();
    setPosition(floatingRelationshipPanelPosition(
      anchor,
      { width: window.innerWidth, height: window.innerHeight },
      { width: Math.ceil(bounds.width), height: Math.ceil(bounds.height) },
    ));
    setPositioned(true);
  }, [anchor]);

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
      <header><div><span className="relationship-kind" data-kind={data.relationshipKind}>{kindLabel}</span><h2>{data.relationshipKind === "logical" ? "Model relationship" : data.relationshipKind === "physical" ? "Database foreign key" : "Suggested relationship"}</h2></div><button type="button" aria-label="Close relationship details" onClick={onClose}>×</button></header>
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
