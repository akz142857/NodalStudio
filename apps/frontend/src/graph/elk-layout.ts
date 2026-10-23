import { seedCanvasGeometry } from "./canvas-geometry";
import { setTablePinned } from "./table-position";
import type { Edge } from "@xyflow/react";
import type { CanvasNodeLayout } from "../platform/types";
import { estimatedTableNodeHeight, type TableNode } from "./schema-graph";

interface LayoutResponse {
  positions?: Record<string, { x: number; y: number }>;
  error?: string;
}

export interface LayoutOptions {
  direction: "leftToRight" | "topToBottom";
  nodeSpacing: number;
  layerSpacing: number;
  edgeSpacing: number;
  timeoutMs: number;
}

const defaultLayoutOptions: LayoutOptions = {
  direction: "leftToRight",
  nodeSpacing: 70,
  layerSpacing: 110,
  edgeSpacing: 24,
  timeoutMs: 15_000,
};

async function layoutWorkerGraph(
  nodes: TableNode[],
  edges: Edge[],
  options: Partial<LayoutOptions> = {},
): Promise<TableNode[]> {
  if (nodes.length === 0) return [];
  const resolvedOptions = { ...defaultLayoutOptions, ...options };
  const worker = new Worker(new URL("./layout.worker.ts", import.meta.url), { type: "module" });
  try {
    const response = await new Promise<LayoutResponse>((resolve, reject) => {
      const timeout = window.setTimeout(
        () => reject(new Error(`Layout timed out after ${resolvedOptions.timeoutMs} ms`)),
        resolvedOptions.timeoutMs,
      );
      worker.onmessage = (event: MessageEvent<LayoutResponse>) => {
        window.clearTimeout(timeout);
        resolve(event.data);
      };
      worker.onerror = (event) => {
        window.clearTimeout(timeout);
        reject(new Error(event.message));
      };
      worker.postMessage({
        options: resolvedOptions,
        nodes: nodes.map((node) => ({
          id: node.id,
          width: nodeDimension(node, "width") ?? 280,
          height: nodeDimension(node, "height") ?? estimatedTableNodeHeight(node.data.table),
        })),
        edges: edges.map((edge) => ({
          id: edge.id,
          source: edge.source,
          target: edge.target,
        })),
      });
    });
    if (response.error) throw new Error(response.error);
    return nodes.map((node) => ({
      ...node,
      position: response.positions?.[node.id] ?? node.position,
    }));
  } finally {
    worker.terminate();
  }
}

/** Keep pinned/unselected tables intact and treat their bounds as obstacles. */
export function layoutSchemaGraph(nodes: TableNode[], edges: Edge[], options: Partial<LayoutOptions> = {}): Promise<TableNode[]> {
  return layoutMovableTables(nodes, edges, options, false);
}

export function layoutSelectedSchemaGraph(nodes: TableNode[], edges: Edge[], options: Partial<LayoutOptions> = {}): Promise<TableNode[]> {
  return layoutMovableTables(nodes, edges, options, true);
}

async function layoutMovableTables(nodes: TableNode[], edges: Edge[], options: Partial<LayoutOptions>, selectedOnly: boolean): Promise<TableNode[]> {
  const movable = nodes.filter((node) => !node.data.layoutPinned && (!selectedOnly || node.selected));
  if (!movable.length) return nodes;
  const ids = new Set(movable.map((node) => node.id));
  const layouted = await layoutWorkerGraph(movable, edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target)), options);
  if (layouted.some((node) => !Number.isFinite(node.position.x) || !Number.isFinite(node.position.y))) throw new Error("Layout returned invalid table positions.");
  const obstacles = nodes.filter((node) => !ids.has(node.id));
  const bounds = (node: TableNode) => ({
    x: node.position.x, y: node.position.y,
    width: nodeDimension(node, "width") ?? 280,
    height: nodeDimension(node, "height") ?? estimatedTableNodeHeight(node.data.table),
  });
  const spacing = Math.max(0, options.nodeSpacing ?? defaultLayoutOptions.nodeSpacing);
  const minX = Math.min(...layouted.map((node) => node.position.x));
  const minY = Math.min(...layouted.map((node) => node.position.y));
  let dx = selectedOnly ? Math.min(...movable.map((node) => node.position.x)) - minX : 0;
  let dy = selectedOnly ? Math.min(...movable.map((node) => node.position.y)) - minY : 0;
  // Each card pair forbids an interval of translations along the layout axis.
  // Scan their union once, avoiding repeated all-pairs scans for dense diagrams.
  const vertical = options.direction === "topToBottom";
  const forbidden = layouted.flatMap((node) => {
    const a = bounds(node);
    return obstacles.flatMap((obstacle) => {
      const b = bounds(obstacle);
      const overlaps = vertical
        ? a.x + dx < b.x + b.width + spacing && a.x + dx + a.width + spacing > b.x
        : a.y + dy < b.y + b.height + spacing && a.y + dy + a.height + spacing > b.y;
      if (!overlaps) return [];
      return [vertical
        ? { start: b.y - a.y - a.height - spacing, end: b.y + b.height + spacing - a.y }
        : { start: b.x - a.x - a.width - spacing, end: b.x + b.width + spacing - a.x }];
    });
  }).sort((a, b) => a.start - b.start);
  let offset = vertical ? dy : dx;
  for (const interval of forbidden) if (offset > interval.start && offset < interval.end) offset = interval.end;
  if (vertical) dy = offset; else dx = offset;
  const positions = new Map(layouted.map((node) => [node.id, { x: node.position.x + dx, y: node.position.y + dy }]));
  return nodes.map((node) => positions.has(node.id) ? { ...node, position: positions.get(node.id)! } : node);
}

export function restoreLayout(snapshotFingerprint: string, nodes: TableNode[]): TableNode[] | null {
  try {
    const raw =
      localStorage.getItem(layoutStorageKey(snapshotFingerprint)) ??
      localStorage.getItem(legacyLayoutStorageKey(snapshotFingerprint));
    if (!raw) return null;
    const stored = JSON.parse(raw) as Record<string, StoredNodeLayout>;
    if (!nodes.every((node) => validPosition(stored[node.id]))) return null;
    return nodes.map((node) => applyStoredNodeLayout(node, stored[node.id]));
  } catch {
    return null;
  }
}

export function applyStoredPositions(
  nodes: TableNode[],
  positions: Record<string, CanvasNodeLayout> | undefined,
): TableNode[] | null {
  if (!positions || !nodes.every((node) => validPosition(positions[node.id]))) return null;
  return nodes.map((node) => applyStoredNodeLayout(node, positions[node.id]));
}

/** Restore existing nodes exactly and place only missing nodes around them. */
export async function restoreOrExtendLayout(nodes: TableNode[], edges: Edge[], positions: Record<string, CanvasNodeLayout> | undefined, options: Partial<LayoutOptions> = {}): Promise<TableNode[]> {
  const restored = new Map(nodes.flatMap((node) => {
    const saved = applyStoredPositions([node], positions);
    return saved ? [[node.id, saved[0]] as const] : [];
  }));
  if (restored.size === nodes.length) return nodes.map((node) => restored.get(node.id)!);
  const prepared = nodes.map((node) => restored.has(node.id) ? setTablePinned(restored.get(node.id)!, true) : node);
  const arranged = await layoutSchemaGraph(prepared, edges, options);
  return arranged.map((node) => restored.get(node.id) ?? node);
}

export function persistLayout(snapshotFingerprint: string, nodes: TableNode[]): void {
  localStorage.setItem(layoutStorageKey(snapshotFingerprint), JSON.stringify(serializeCanvasLayout(nodes)));
  localStorage.removeItem(legacyLayoutStorageKey(snapshotFingerprint));
}

export function serializeCanvasLayout(nodes: TableNode[]): Record<string, CanvasNodeLayout> {
  return Object.fromEntries(nodes.map((node) => [node.id, {
    ...node.position,
    ...(node.data.layoutPinned ? { pinned: true } : {}),
    width: nodeDimension(node, "width"),
    height: nodeDimension(node, "height"),
  }]));
}

interface StoredNodeLayout {
  pinned?: boolean;
  x: number;
  y: number;
  width?: number;
  height?: number;
}

function applyStoredNodeLayout(node: TableNode, stored: StoredNodeLayout): TableNode {
  const width = validDimension(stored.width) ? stored.width : undefined;
  const height = validDimension(stored.height) ? stored.height : undefined;
  const restored: TableNode = {
    ...setTablePinned(node, stored.pinned === true),
    position: { x: stored.x, y: stored.y },
    style: {
      ...node.style,
      width: width ?? nodeDimension(node, "width") ?? 280,
      height: height ?? nodeDimension(node, "height") ?? estimatedTableNodeHeight(node.data.table),
    },
  };
  return node.data.initialGeometryOptions ? seedCanvasGeometry(restored, node.data.initialGeometryOptions?.fieldLevel ?? true, node.data.initialGeometryOptions?.showComments ?? true) : restored;
}

export function nodeDimension(node: TableNode, dimension: "width" | "height"): number | undefined {
  const measured = node.measured?.[dimension];
  if (validDimension(measured)) return measured;
  if (validDimension(node[dimension])) return node[dimension];
  const value = node.style?.[dimension];
  return validDimension(value) ? value : undefined;
}

function validPosition(value: StoredNodeLayout | undefined): boolean {
  return Boolean(value && Number.isFinite(value.x) && Number.isFinite(value.y));
}

function validDimension(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function layoutStorageKey(snapshotFingerprint: string): string {
  return `nodalstudio:layout:${snapshotFingerprint}`;
}

function legacyLayoutStorageKey(snapshotFingerprint: string): string {
  return `sqlaieditor:layout:${snapshotFingerprint}`;
}
