import ELK, { type ElkNode } from "elkjs/lib/elk.bundled.js";
import { describe, expect, it } from "vitest";
import { layoutQualityOptions } from "./large-component-layout";

// Minimized from a synthetic graph against elkjs 0.11.1. All dimensions are
// positive and finite; EDGE_LENGTH's scanline compactor still rejects it.
// Keep this topology and these unequal card sizes as the regression fixture.
const fixture: ElkNode = {
  id: "schema-component-0",
  layoutOptions: {
    "elk.algorithm": "layered",
    "elk.spacing.nodeNode": "70",
    "elk.spacing.edgeEdge": "24",
    "elk.layered.spacing.edgeEdgeBetweenLayers": "24",
    "elk.layered.spacing.nodeNodeBetweenLayers": "110",
    "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
  },
  children: [
    { id: "n3", width: 320, height: 472 },
    { id: "n5", width: 300, height: 808 },
    { id: "n8", width: 320, height: 304 },
    { id: "n10", width: 360, height: 864 },
    { id: "n16", width: 280, height: 976 },
    { id: "n19", width: 300, height: 1144 },
    { id: "n23", width: 300, height: 1144 },
    { id: "n24", width: 300, height: 752 },
    { id: "n25", width: 340, height: 584 },
    { id: "n28", width: 300, height: 528 },
    { id: "n30", width: 320, height: 416 },
  ],
  edges: [
    { id: "e4", sources: ["n5"], targets: ["n24"] },
    { id: "e6", sources: ["n23"], targets: ["n30"] },
    { id: "e9", sources: ["n25"], targets: ["n10"] },
    { id: "e27", sources: ["n25"], targets: ["n28"] },
    { id: "e28", sources: ["n10"], targets: ["n19"] },
    { id: "e29", sources: ["n8"], targets: ["n3"] },
    { id: "e39", sources: ["n28"], targets: ["n16"] },
    { id: "e40", sources: ["n30"], targets: ["n8"] },
    { id: "e44", sources: ["n25"], targets: ["n3"] },
    { id: "e46", sources: ["n24"], targets: ["n23"] },
    { id: "e52", sources: ["n16"], targets: ["n24"] },
  ],
};

describe("real ELK compaction regression", () => {
  it("reproduces the reported scanline failure with the previous compaction setting", async () => {
    const elk = new ELK();
    await expect(elk.layout({ ...structuredClone(fixture), layoutOptions: {
      ...fixture.layoutOptions,
      ...layoutQualityOptions(11),
      "elk.direction": "RIGHT",
      "elk.layered.compaction.postCompaction.strategy": "EDGE_LENGTH",
    } })).rejects.toThrow("Invalid hitboxes for scanline constraint calculation");
  });

  it.each([
    ["RIGHT", 11], ["DOWN", 11], ["RIGHT", 500], ["DOWN", 500],
  ] as const)("lays out the failing component without overlaps in %s for a %i-table model", async (direction, totalNodes) => {
    const elk = new ELK();
    const input = { ...structuredClone(fixture), layoutOptions: { ...fixture.layoutOptions, ...layoutQualityOptions(totalNodes), "elk.direction": direction } };
    const result = await elk.layout(input);
    const nodes = result.children!;
    expect(nodes.map((node) => node.id)).toEqual(fixture.children!.map((node) => node.id));
    for (const [i, a] of nodes.entries()) {
      expect(Number.isFinite(a.x) && Number.isFinite(a.y)).toBe(true);
      expect({ width: a.width, height: a.height }).toEqual({ width: fixture.children![i].width, height: fixture.children![i].height });
      for (const b of nodes.slice(i + 1)) {
        expect(a.x! + a.width! <= b.x! || b.x! + b.width! <= a.x! || a.y! + a.height! <= b.y! || b.y! + b.height! <= a.y!, `${a.id} overlaps ${b.id}`).toBe(true);
      }
    }
    // This fixture is acyclic: retain the requested relationship direction.
    for (const edge of fixture.edges!) {
      const source = nodes.find((node) => node.id === edge.sources[0])!;
      const target = nodes.find((node) => node.id === edge.targets[0])!;
      expect(direction === "RIGHT" ? source.x! + source.width! <= target.x! : source.y! + source.height! <= target.y!).toBe(true);
    }
  });
});
