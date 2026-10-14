import { nodeDimension } from "./elk-layout";
import { estimatedTableNodeHeight, type TableNode } from "./schema-graph";

export type TableArrangement = "left" | "center-x" | "right" | "top" | "center-y" | "bottom" | "distribute-x" | "distribute-y";
export const tableArrangementLabels: Record<TableArrangement, string> = {
  left: "Align left", "center-x": "Align horizontal centers", right: "Align right",
  top: "Align top", "center-y": "Align vertical centers", bottom: "Align bottom",
  "distribute-x": "Distribute horizontally", "distribute-y": "Distribute vertically",
};

/** Align to the selection's bounds; distribute equal edge-to-edge gaps, keeping both ends fixed. */
export function arrangeTables(nodes: TableNode[], action: TableArrangement): TableNode[] {
  const horizontal = ["left", "center-x", "right", "distribute-x"].includes(action);
  const axis = horizontal ? "x" : "y";
  const dimension = horizontal ? "width" : "height";
  const distributing = action.startsWith("distribute-");
  const selected = nodes.filter((node) => node.selected && !node.data.layoutPinned).map((node) => ({
    node,
    start: node.position[axis],
    size: nodeDimension(node, dimension) ?? (horizontal ? 280 : estimatedTableNodeHeight(node.data.table)),
  }));
  if (selected.length < (distributing ? 3 : 2)) return nodes;
  if (selected.some(({ start }) => !Number.isFinite(start))) throw new Error("Table positions must be finite.");
  const start = Math.min(...selected.map((item) => item.start));
  const end = Math.max(...selected.map((item) => item.start + item.size));
  const positions = new Map<string, number>();
  if (distributing) {
    // The table with the rightmost/bottommost edge is the fixed trailing endpoint,
    // even if a smaller nested table starts farther along the axis.
    const ordered = [...selected].sort((a, b) => a.start - b.start || a.node.id.localeCompare(b.node.id));
    const trailing = [...ordered].sort((a, b) => (b.start + b.size) - (a.start + a.size) || b.start - a.start)[0];
    if (trailing === ordered[0]) throw new Error(`Not enough ${horizontal ? "horizontal" : "vertical"} space. Move the outer tables farther apart.`);
    const gap = (end - start - selected.reduce((sum, item) => sum + item.size, 0)) / (selected.length - 1);
    if (gap < 0) throw new Error(`Not enough ${horizontal ? "horizontal" : "vertical"} space. Move the outer tables farther apart.`);
    const sequence = [...ordered.filter((item) => item !== trailing), trailing];
    let cursor = start;
    for (const item of sequence) {
      positions.set(item.node.id, item === trailing ? item.start : cursor);
      cursor += item.size + gap;
    }
  } else {
    for (const item of selected) {
      const position = action === "left" || action === "top" ? start
        : action === "right" || action === "bottom" ? end - item.size
        : (start + end - item.size) / 2;
      positions.set(item.node.id, position);
    }
  }
  return nodes.map((node) => {
    const position = positions.get(node.id);
    return position === undefined || position === node.position[axis] ? node : { ...node, position: { ...node.position, [axis]: position } };
  });
}
