import { Position } from "@xyflow/react";
import { describe, expect, it } from "vitest";
import { comparisonEdgePath } from "./comparison-edge-path";

describe("replacement relationship lanes", () => {
  it.each(["orthogonal", "curved"] as const)("separates identical endpoints in %s mode while keeping ports attached", (edgeStyle) => {
    const endpoints = { sourceX: 100, sourceY: 200, targetX: 400, targetY: 200, sourcePosition: Position.Right, targetPosition: Position.Left, edgeStyle };
    const old = comparisonEdgePath({ ...endpoints, offset: -12 });
    const next = comparisonEdgePath({ ...endpoints, offset: 12 });
    expect(old[0]).not.toEqual(next[0]);
    expect(old[1]).toBeLessThan(next[1]);
    expect(old[2]).toBeLessThan(next[2]);
    expect(old[0]).toMatch(/^M100,200 /);
    expect(old[0]).toMatch(/L400,200$/);
    expect(next[0]).toMatch(/L400,200$/);
  });

  it("separates vertical corridors so each version can be selected independently", () => {
    const endpoints = { sourceX: 100, sourceY: 350, targetX: 300, targetY: 50, sourcePosition: Position.Right, targetPosition: Position.Left };
    const old = comparisonEdgePath({ ...endpoints, offset: -12 });
    const next = comparisonEdgePath({ ...endpoints, offset: 12 });
    expect(next[1] - old[1]).toBe(24);
    expect(old[0]).toContain("188,");
    expect(next[0]).toContain("212,");
  });
});
