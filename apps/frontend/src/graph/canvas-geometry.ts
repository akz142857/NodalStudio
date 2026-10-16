import { Position } from "@xyflow/react";
import type { TableNode } from "./schema-graph";

/** Fixed CSS sizes and provisional ports let offscreen nodes participate in fit,
 * layout and edges before mounting. Visible detailed cards replace port bounds
 * with real measurements (comments, custom fonts and resized widths may differ). */
export function seedCanvasGeometry(node: TableNode, fieldLevel: boolean, showComments = true): TableNode {
  const width = typeof node.style?.width === "number" ? node.style.width : 280;
  const height = typeof node.style?.height === "number" ? node.style.height : 120;
  const names = node.data.visibleColumnNames ?? node.data.table.columns.map((column) => column.name);
  const centers = Object.fromEntries(names.map((name, index) => [name, 42 + (showComments && node.data.table.comment ? 36 : 0) + index * 27 + 13.5]));
  const handles: NonNullable<TableNode["handles"]> = [];
  const sources = new Set([...node.data.table.foreignKeys.flatMap((key) => key.columns), ...(node.data.inferredForeignKeyColumns ?? []), ...(node.data.logicalForeignKeyColumns ?? [])]);
  const targets = new Set(node.data.referencedForeignKeyColumns ?? []);
  for (const side of ["left", "right"] as const) {
    const position = side === "left" ? Position.Left : Position.Right;
    const x = side === "left" ? 0 : width;
    if (!fieldLevel) {
      for (const type of ["source", "target"] as const) handles.push({ id: `table-${type}-${side}`, type, position, x, y: height / 2, width: 1, height: 1 });
    } else for (const name of names) {
      if (sources.has(name)) handles.push({ id: `source:${name}:${side}`, type: "source", position, x, y: centers[name], width: 1, height: 1 });
      if (targets.has(name)) handles.push({ id: `target:${name}:${side}`, type: "target", position, x, y: centers[name], width: 1, height: 1 });
    }
  }
  return { ...node, width, height, measured: { width, height }, handles, data: { ...node.data, initialColumnCenters: centers, initialGeometryOptions: { fieldLevel, showComments } } };
}
