import type { FieldEdge } from "./schema-graph";

/** Rendering only; the owning canvas retains the full relationship model. */
export function presentEdgesDuringDrag(edges: FieldEdge[], movingIds: Set<string>): FieldEdge[] {
  return edges.filter((edge) => edge.selected || movingIds.has(edge.source) || movingIds.has(edge.target));
}

export function prioritiseMovingEdges(edges: FieldEdge[], movingIds: Set<string>): FieldEdge[] {
  const related: FieldEdge[] = []; const remaining: FieldEdge[] = [];
  for (const edge of edges) (edge.selected || movingIds.has(edge.source) || movingIds.has(edge.target) ? related : remaining).push(edge);
  return [...related, ...remaining];
}
