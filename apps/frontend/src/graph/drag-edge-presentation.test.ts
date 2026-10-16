import { expect, it } from "vitest";
import { presentEdgesDuringDrag, prioritiseMovingEdges } from "./drag-edge-presentation";
import type { FieldEdge } from "./schema-graph";

it("keeps relationships for all moving tables and restores the original complete presentation on release/export", () => {
  const edges: FieldEdge[] = [
    { id: "a", source: "moving-a", target: "fixed" },
    { id: "b", source: "other", target: "moving-b" },
    { id: "c", source: "other", target: "fixed", className: "comparison-deleted", label: "Before definition", data: { relationshipKind: "physical", sourceColumn: "id", targetColumn: "id", fieldLevel: true } },
  ];
  const during = presentEdgesDuringDrag(edges, new Set(["moving-a", "moving-b"]));
  expect(during).toHaveLength(2);
  expect(during[0]).toBe(edges[0]); expect(during[1]).toBe(edges[1]);
  const restored = prioritiseMovingEdges(edges, new Set(["moving-a", "moving-b"]));
  expect(restored).toHaveLength(3); expect(restored[2]).toBe(edges[2]);
  expect(edges[2].className).toBe("comparison-deleted");
});
