import type { RelationshipEndpoint } from "../platform";
import type { TableNode } from "./schema-graph";

export function relationshipEndpointFromHandle(
  nodes: TableNode[],
  nodeId: string | null | undefined,
  handleId: string | null | undefined,
): RelationshipEndpoint | undefined {
  if (!nodeId || !handleId) return undefined;
  const node = nodes.find((candidate) => candidate.id === nodeId);
  const [, column] = handleId.split(":");
  if (!node || !column || !node.data.table.columns.some((candidate) => candidate.name === column)) return undefined;
  return { schema: node.data.schema, table: node.data.table.key.name, columns: [column] };
}

export function sameRelationshipEndpoint(left: RelationshipEndpoint, right: RelationshipEndpoint) {
  return left.schema === right.schema
    && left.table === right.table
    && left.columns.length === right.columns.length
    && left.columns.every((column, index) => right.columns[index] === column);
}

export function floatingRelationshipPanelPosition(
  anchor: { x: number; y: number },
  viewport: { width: number; height: number },
  panel = { width: 320, height: 420 },
): { left: number; top: number } {
  const margin = 12;
  const gap = 14;
  const left = anchor.x + gap + panel.width <= viewport.width - margin
    ? anchor.x + gap
    : anchor.x - gap - panel.width;
  return {
    left: Math.max(margin, Math.min(left, viewport.width - panel.width - margin)),
    top: Math.max(margin, Math.min(anchor.y - panel.height / 2, viewport.height - panel.height - margin)),
  };
}
