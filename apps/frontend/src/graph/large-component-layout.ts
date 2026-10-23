import type { LayoutComponent, PositionedLayoutNode } from "./layout-components";

/** Bounded-work layout for huge connected groups. Layered layout can introduce
 * quadratically many dummy nodes for long edges; grouping neighbours and packing
 * actual card sizes keeps both time and space linear instead. */
export function layoutLargeComponent(component: LayoutComponent, direction: "leftToRight" | "topToBottom", spacing: number): PositionedLayoutNode[] {
  const adjacency = new Map(component.nodes.map((node) => [node.id, new Set<string>()]));
  for (const edge of component.edges) {
    if (!adjacency.has(edge.source) || !adjacency.has(edge.target)) continue;
    adjacency.get(edge.source)?.add(edge.target);
    adjacency.get(edge.target)?.add(edge.source);
  }
  const root = component.nodes.reduce((best, node) => (adjacency.get(node.id)?.size ?? 0) > (adjacency.get(best.id)?.size ?? 0) ? node : best, component.nodes[0]);
  if (!root) return [];
  const queue = [root.id]; const seen = new Set(queue);
  for (let head = 0; head < queue.length; head += 1) for (const id of adjacency.get(queue[head]) ?? []) {
    if (!seen.has(id)) { seen.add(id); queue.push(id); }
  }
  for (const node of component.nodes) if (!seen.has(node.id)) queue.push(node.id);
  const lookup = new Map(component.nodes.map((node) => [node.id, node]));
  const vertical = direction === "topToBottom";
  const area = component.nodes.reduce((sum, node) => sum + (node.width + spacing) * (node.height + spacing), 0);
  const rowWidth = Math.max(900, Math.sqrt(area) * 1.25);
  let x = 0; let y = 0; let rowHeight = 0;
  return queue.map((id) => {
    const node = lookup.get(id)!;
    const width = vertical ? node.height : node.width;
    const height = vertical ? node.width : node.height;
    if (x > 0 && x + width > rowWidth) { x = 0; y += rowHeight + spacing; rowHeight = 0; }
    const positioned = { ...node, x: vertical ? y : x, y: vertical ? x : y };
    x += width + spacing; rowHeight = Math.max(rowHeight, height);
    return positioned;
  });
}

export function layoutQualityOptions(totalNodes: number) {
  return totalNodes >= 500 ? {
    "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
    "elk.layered.thoroughness": "1",
    "elk.layered.compaction.postCompaction.strategy": "NONE",
  } : {
    "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
    "elk.layered.thoroughness": "7",
    // EDGE_LENGTH can reject valid unequal card bounds with "Invalid hitboxes
    // for scanline constraint calculation" (see the real-ELK regression).
    // Keep layered placement/crossing reduction, but use ELK's default of no
    // optional post-compaction. We render our own field edges after placement.
    "elk.layered.compaction.postCompaction.strategy": "NONE",
  };
}
