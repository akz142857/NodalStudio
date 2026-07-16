export interface LayoutNodeInput {
  id: string;
  width: number;
  height: number;
}

export interface LayoutEdgeInput {
  id: string;
  source: string;
  target: string;
}

export interface LayoutComponent {
  nodes: LayoutNodeInput[];
  edges: LayoutEdgeInput[];
}

export interface PositionedLayoutNode extends LayoutNodeInput {
  x: number;
  y: number;
}

export function splitLayoutComponents(nodes: LayoutNodeInput[], edges: LayoutEdgeInput[]): LayoutComponent[] {
  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  const adjacency = new Map(nodes.map((node) => [node.id, new Set<string>()]));
  for (const edge of edges) {
    if (!nodeMap.has(edge.source) || !nodeMap.has(edge.target)) continue;
    adjacency.get(edge.source)?.add(edge.target);
    adjacency.get(edge.target)?.add(edge.source);
  }
  const visited = new Set<string>();
  const components: LayoutComponent[] = [];
  for (const node of nodes) {
    if (visited.has(node.id)) continue;
    const queue = [node.id];
    const ids = new Set<string>();
    visited.add(node.id);
    while (queue.length) {
      const id = queue.shift();
      if (!id) continue;
      ids.add(id);
      for (const related of adjacency.get(id) ?? []) {
        if (visited.has(related)) continue;
        visited.add(related);
        queue.push(related);
      }
    }
    components.push({
      nodes: nodes.filter((candidate) => ids.has(candidate.id)),
      edges: edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target)),
    });
  }
  return components.sort((left, right) => right.nodes.length - left.nodes.length);
}

export function packLayoutComponents(
  components: PositionedLayoutNode[][],
  gap: number,
): Record<string, { x: number; y: number }> {
  const boxes = components.map((nodes) => {
    const minX = Math.min(...nodes.map((node) => node.x));
    const minY = Math.min(...nodes.map((node) => node.y));
    const maxX = Math.max(...nodes.map((node) => node.x + node.width));
    const maxY = Math.max(...nodes.map((node) => node.y + node.height));
    return { nodes, minX, minY, width: maxX - minX, height: maxY - minY };
  });
  const totalArea = boxes.reduce((sum, box) => sum + (box.width + gap) * (box.height + gap), 0);
  const targetRowWidth = Math.max(900, Math.sqrt(totalArea) * 1.5);
  const positions: Record<string, { x: number; y: number }> = {};
  let cursorX = 0;
  let cursorY = 0;
  let rowHeight = 0;
  for (const box of boxes) {
    if (cursorX > 0 && cursorX + box.width > targetRowWidth) {
      cursorX = 0;
      cursorY += rowHeight + gap;
      rowHeight = 0;
    }
    for (const node of box.nodes) {
      positions[node.id] = {
        x: cursorX + node.x - box.minX,
        y: cursorY + node.y - box.minY,
      };
    }
    cursorX += box.width + gap;
    rowHeight = Math.max(rowHeight, box.height);
  }
  return positions;
}
