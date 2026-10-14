import { BaseEdge, type EdgeProps } from "@xyflow/react";
import type { FieldEdge } from "../../graph/schema-graph";
import { comparisonEdgePath } from "../../graph/comparison-edge-path";

export function ComparisonEdge(props: EdgeProps<FieldEdge>) {
  const [path, labelX, labelY] = comparisonEdgePath({
    sourceX: props.sourceX, sourceY: props.sourceY, targetX: props.targetX, targetY: props.targetY,
    sourcePosition: props.sourcePosition, targetPosition: props.targetPosition,
    edgeStyle: props.data?.edgeStyle, offset: props.data?.comparisonOffset ?? 0,
  });
  return <BaseEdge id={props.id} path={path} labelX={labelX} labelY={labelY}
    style={props.style} markerStart={props.markerStart} markerEnd={props.markerEnd}
    interactionWidth={props.interactionWidth} label={props.label} labelStyle={props.labelStyle}
    labelShowBg={props.labelShowBg} labelBgStyle={props.labelBgStyle}
    labelBgPadding={props.labelBgPadding} labelBgBorderRadius={props.labelBgBorderRadius} />;
}
