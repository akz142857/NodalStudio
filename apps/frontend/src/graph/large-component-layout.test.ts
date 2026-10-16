import { describe, expect, it } from "vitest";
import { layoutLargeComponent, layoutQualityOptions } from "./large-component-layout";
import { splitLayoutComponents, type LayoutComponent } from "./layout-components";

function graph(count: number): LayoutComponent {
  return { nodes: Array.from({ length: count }, (_, i) => ({ id: `n${i}`, width: 240 + i % 7 * 20, height: 120 + i % 13 * 27 })), edges: Array.from({ length: count - 1 }, (_, i) => [{ id: `chain${i}`, source: `n${i + 1}`, target: `n${i}` }, { id: `long${i}`, source: `n${i + 1}`, target: "n0" }]).flat() };
}

describe("bounded large component layout", () => {
  it.each(["leftToRight", "topToBottom"] as const)("packs a 2,000-table group with long edges, cycles and varying sizes without overlaps (%s)", (direction) => {
    const input = graph(2000); input.edges.push({ id: "cycle", source: "n0", target: "n1999" });
    const before = structuredClone(input);
    const result = layoutLargeComponent(input, direction, 70);
    expect(result).toHaveLength(2000);
    expect(new Set(result.map((node) => node.id)).size).toBe(2000);
    for (let i = 0; i < result.length; i += 1) {
      const a = result[i]; expect(Number.isFinite(a.x) && Number.isFinite(a.y)).toBe(true);
      for (let j = i + 1; j < result.length; j += 1) {
        const b = result[j];
        if (!(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y)) throw new Error(`Overlap: ${a.id} / ${b.id}`);
      }
    }
    expect(input).toEqual(before);
    expect(layoutLargeComponent(input, direction, 70)).toEqual(result);
  });
  it("handles empty groups and selects a cheaper ELK policy for large models", () => {
    expect(layoutLargeComponent({ nodes: [], edges: [] }, "leftToRight", 70)).toEqual([]);
    expect(layoutQualityOptions(499)["elk.layered.nodePlacement.strategy"]).toBe("NETWORK_SIMPLEX");
    expect(layoutQualityOptions(500)["elk.layered.nodePlacement.strategy"]).toBe("BRANDES_KOEPF");
  });
  it("splits 2,000 independent groups without losing nodes, edge order, or input order", () => {
    const nodes = Array.from({ length: 4000 }, (_, i) => ({ id: `n${i}`, width: 280, height: 500 }));
    const edges = Array.from({ length: 2000 }, (_, i) => ({ id: `e${i}`, source: `n${i * 2}`, target: `n${i * 2 + 1}` }));
    const components = splitLayoutComponents(nodes, [...edges, { id: "missing", source: "n0", target: "absent" }]);
    expect(components).toHaveLength(2000);
    expect(components.flatMap((component) => component.nodes)).toEqual(nodes);
    expect(components.flatMap((component) => component.edges)).toEqual(edges);
  });
});
