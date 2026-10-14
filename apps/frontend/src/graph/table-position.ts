import type { TableNode } from "./schema-graph";

/** Pinning belongs to the personal layout, never to the physical table model. */
export function setTablePinned(node: TableNode, pinned: boolean): TableNode {
  if (Boolean(node.data.layoutPinned) === pinned) return node;
  return { ...node, draggable: pinned ? false : undefined, data: { ...node.data, layoutPinned: pinned || undefined } };
}

export function pinSelectedTables(nodes: TableNode[], pinned: boolean): TableNode[] {
  return nodes.map((node) => node.selected ? setTablePinned(node, pinned) : node);
}
