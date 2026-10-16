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
  const byNode = new Map<string, LayoutComponent>();
  const components: LayoutComponent[] = [];
  for (const node of nodes) {
    if (byNode.has(node.id)) continue;
    const component: LayoutComponent = { nodes: [], edges: [] };
    const queue = [node.id];
    byNode.set(node.id, component);
    for (let head = 0; head < queue.length; head += 1) {
      const id = queue[head];
      for (const related of adjacency.get(id) ?? []) {
        if (byNode.has(related)) continue;
        byNode.set(related, component);
        queue.push(related);
      }
    }
    components.push(component);
  }
  for (const node of nodes) byNode.get(node.id)!.nodes.push(node);
  for (const edge of edges) {
    const component = byNode.get(edge.source);
    if (component && component === byNode.get(edge.target)) component.edges.push(edge);
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
