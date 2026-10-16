import { BaseEdge, useStore, type EdgeProps } from "@xyflow/react";
import { createContext, useContext, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { comparisonEdgePath } from "../../graph/comparison-edge-path";
import type { FieldEdge } from "../../graph/schema-graph";
import { EdgePaintCommitBoundary } from "./EdgePaintCommitBoundary";

export type EdgeActivationEvent = MouseEvent<SVGGElement> | KeyboardEvent<SVGGElement>;
interface Layer {
  inferred: SVGGElement | null;
  normal: SVGGElement | null;
  selected: SVGGElement | null;
  activate: (event: EdgeActivationEvent, id: string, edit: boolean) => void;
  clear: () => void;
}
const Context = createContext<Layer | undefined>(undefined);

/** Keep React Flow's model, visibility, ports and subscriptions, but paint dense
 * diagrams into one SVG instead of creating one SVG viewport per relationship. */
export function SharedEdgeLayer({ enabled, activate, clear, children, graphScope }: {
  enabled: boolean; activate: Layer["activate"]; clear: () => void; children: ReactNode; graphScope?: object;
}) {
  const edgeRoot = useStore((state) => enabled ? state.domNode?.querySelector(".react-flow__edges") ?? null : null);
  const [inferred, setInferred] = useState<SVGGElement | null>(null);
  const [normal, setNormal] = useState<SVGGElement | null>(null);
  const [selected, setSelected] = useState<SVGGElement | null>(null);
  const [paint, setPaint] = useState<SVGSVGElement | null>(null);
  const transform = useStore((state) => enabled ? state.transform : null) ?? [0, 0, 1];
  const width = useStore((state) => enabled ? state.width : null) ?? 1;
  const height = useStore((state) => enabled ? state.height : null) ?? 1;
  const zoom = transform[2];
  const viewport = { x: -transform[0] / zoom, y: -transform[1] / zoom, width: width / zoom, height: height / zoom };
  const count = useStore((state) => enabled ? state.edges?.length ?? 0 : 0);
  const value = useMemo(() => ({ inferred, normal, selected, activate, clear }), [inferred, normal, selected, activate, clear]);
  return <Context.Provider value={value}>
    <EdgePaintCommitBoundary root={paint} count={count} scope={graphScope} enabled={enabled}>
    {children}
    {enabled && edgeRoot ? createPortal(<svg ref={setPaint} className="shared-edge-layer" data-shared-edge-layer="true" viewBox={`${viewport.x} ${viewport.y} ${viewport.width} ${viewport.height}`} style={{ left: viewport.x, top: viewport.y, width: viewport.width, height: viewport.height, overflow: "hidden", zIndex: 2 }}>
      <g ref={setInferred} /><g ref={setNormal} /><g ref={setSelected} />
    </svg>, edgeRoot) : null}
    </EdgePaintCommitBoundary>
  </Context.Provider>;
}

export function SharedEdge(props: EdgeProps<FieldEdge>) {
  const layer = useContext(Context);
  const target = props.selected ? layer?.selected : props.data?.relationshipKind === "inferred" ? layer?.inferred : layer?.normal;
  const group = useRef<SVGGElement>(null);
  const restoreFocus = useRef(false);
  useLayoutEffect(() => {
    if (restoreFocus.current && group.current) { group.current.focus(); restoreFocus.current = false; }
  }, [target, props.selected]);
  const [path, labelX, labelY] = comparisonEdgePath({
    sourceX: props.sourceX, sourceY: props.sourceY, targetX: props.targetX, targetY: props.targetY,
    sourcePosition: props.sourcePosition, targetPosition: props.targetPosition,
    edgeStyle: props.data?.edgeStyle, offset: props.data?.comparisonOffset ?? 0,
  });
  if (!layer || !target) return null;
  const status = props.data?.changeStatus;
  return createPortal(<g ref={group} className={`react-flow__edge selectable nopan${props.selected ? " selected" : ""}${status ? ` comparison-edge comparison-edge-${status}` : ""}`}
    data-id={props.id} data-shared-edge="true" role="group" aria-roledescription="edge"
    aria-label={`Edge from ${props.source} to ${props.target}`} tabIndex={0}
    onClick={(event) => layer.activate(event, props.id, false)}
    onDoubleClick={(event) => layer.activate(event, props.id, true)}
    onKeyDown={(event) => {
      if (event.key === "Enter" || event.key === " ") { restoreFocus.current = !props.selected; layer.activate(event, props.id, false); }
      else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); layer.clear(); }
    }}>
    <BaseEdge id={props.id} path={path} labelX={labelX} labelY={labelY}
      style={props.style} markerStart={props.markerStart} markerEnd={props.markerEnd}
      interactionWidth={props.interactionWidth} label={props.label} labelStyle={props.labelStyle}
      labelShowBg={props.labelShowBg} labelBgStyle={props.labelBgStyle}
      labelBgPadding={props.labelBgPadding} labelBgBorderRadius={props.labelBgBorderRadius} />
  </g>, target, props.id);
}
