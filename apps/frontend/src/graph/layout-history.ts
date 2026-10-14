import { setTablePinned } from "./table-position";
import type { CanvasNodeLayout } from "../platform/types";
import { nodeDimension } from "./elk-layout";
import { estimatedTableNodeHeight, type TableNode } from "./schema-graph";

export type LayoutFrame = Record<string, CanvasNodeLayout>;
type GeometryPatch = Partial<CanvasNodeLayout>;
interface LayoutEdit {
  label: string;
  patches: Map<string, { before: GeometryPatch; after: GeometryPatch }>;
}
const properties = ["x", "y", "width", "height", "pinned"] as const;

export function captureLayoutFrame(nodes: TableNode[]): LayoutFrame {
  return Object.fromEntries(nodes.map((node) => [node.id, {
    ...node.position,
    ...(node.data.layoutPinned ? { pinned: true } : {}),
    width: nodeDimension(node, "width") ?? 280,
    height: nodeDimension(node, "height") ?? estimatedTableNodeHeight(node.data.table),
  }]));
}

/** Session-only geometry history. Only changed properties are restored; model and selection stay current. */
export class DiagramLayoutHistory {
  private past: LayoutEdit[] = [];
  private future: LayoutEdit[] = [];
  constructor(private readonly limit = 50) {}

  get undoLabel(): string | undefined { return this.past.at(-1)?.label; }
  get redoLabel(): string | undefined { return this.future.at(-1)?.label; }
  clear(): void { this.past = []; this.future = []; }

  record(before: LayoutFrame, after: LayoutFrame, label: string): boolean {
    if (Object.keys(before).length !== Object.keys(after).length || !Object.keys(before).every((id) => after[id])) {
      this.clear();
      return false;
    }
    const patches: LayoutEdit["patches"] = new Map();
    for (const [id, previous] of Object.entries(before)) {
      const next = after[id];
      const changed = properties.filter((key) => previous[key] !== next[key]);
      if (changed.length) patches.set(id, {
        before: Object.fromEntries(changed.map((key) => [key, previous[key]])),
        after: Object.fromEntries(changed.map((key) => [key, next[key]])),
      });
    }
    if (!patches.size) return false;
    this.past.push({ label, patches });
    if (this.past.length > this.limit) this.past.shift();
    this.future = [];
    return true;
  }

  undo(nodes: TableNode[]): { nodes: TableNode[]; label: string } | null { return this.restore(nodes, "before"); }
  redo(nodes: TableNode[]): { nodes: TableNode[]; label: string } | null { return this.restore(nodes, "after"); }

  private restore(nodes: TableNode[], direction: "before" | "after"): { nodes: TableNode[]; label: string } | null {
    const from = direction === "before" ? this.past : this.future;
    const to = direction === "before" ? this.future : this.past;
    const edit = from.at(-1);
    if (!edit) return null;
    const ids = new Set(nodes.map((node) => node.id));
    if ([...edit.patches.keys()].some((id) => !ids.has(id))) { this.clear(); return null; }
    const restored = nodes.map((node) => {
      const patch = edit.patches.get(node.id)?.[direction];
      if (!patch) return node;
      const resized = patch.width !== undefined || patch.height !== undefined;
      return {
        ...("pinned" in patch ? setTablePinned(node, patch.pinned === true) : node),
        position: { x: patch.x ?? node.position.x, y: patch.y ?? node.position.y },
        ...(resized ? {
          style: { ...node.style, ...(patch.width !== undefined ? { width: patch.width } : {}), ...(patch.height !== undefined ? { height: patch.height } : {}) },
          ...(patch.width !== undefined ? { width: patch.width } : {}),
          ...(patch.height !== undefined ? { height: patch.height } : {}),
          measured: { ...node.measured, ...(patch.width !== undefined ? { width: patch.width } : {}), ...(patch.height !== undefined ? { height: patch.height } : {}) },
        } : {}),
      };
    });
    from.pop(); to.push(edit);
    return { nodes: restored, label: edit.label };
  }
}
