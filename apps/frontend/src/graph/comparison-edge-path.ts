import { getBezierPath, getSmoothStepPath, Position } from "@xyflow/react";

interface ComparisonPathOptions {
  sourceX: number;
  sourceY: number;
  targetX: number;
  targetY: number;
  sourcePosition: Position;
  targetPosition: Position;
  edgeStyle?: "orthogonal" | "curved";
  offset: number;
}

/** Give replacement versions separate lanes even when only FK actions changed. */
export function comparisonEdgePath({ offset, edgeStyle, ...points }: ComparisonPathOptions): [string, number, number] {
  const pathFor = edgeStyle === "curved" ? getBezierPath : getSmoothStepPath;
  if (!offset) {
    const [path, x, y] = pathFor(points);
    return [path, x, y];
  }
  const sourceDirection = points.sourcePosition === Position.Left ? -1 : 1;
  const targetDirection = points.targetPosition === Position.Left ? -1 : 1;
  const shiftedSourceX = points.sourceX + sourceDirection * 24 + offset;
  const shiftedTargetX = points.targetX + targetDirection * 24 + offset;
  const [shifted, labelX, labelY] = pathFor({
    ...points, sourceX: shiftedSourceX, sourceY: points.sourceY + offset,
    targetX: shiftedTargetX, targetY: points.targetY + offset,
  });
  const path = `M${points.sourceX},${points.sourceY} L${points.sourceX + sourceDirection * 6},${points.sourceY} L${shiftedSourceX},${points.sourceY + offset} ${shifted.replace(/^M[^LCQ]+/, "")} L${points.targetX + targetDirection * 6},${points.targetY} L${points.targetX},${points.targetY}`;
  return [path, labelX, labelY];
}
