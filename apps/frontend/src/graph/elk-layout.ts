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

export async function layoutSchemaGraph(
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

export function restoreLayout(snapshotFingerprint: string, nodes: TableNode[]): TableNode[] | null {
  const raw =
    localStorage.getItem(layoutStorageKey(snapshotFingerprint)) ??
    localStorage.getItem(legacyLayoutStorageKey(snapshotFingerprint));
  if (!raw) return null;
  try {
    const stored = JSON.parse(raw) as Record<string, StoredNodeLayout>;
    if (!nodes.every((node) => stored[node.id])) return null;
    return nodes.map((node) => applyStoredNodeLayout(node, stored[node.id]));
  } catch {
    return null;
  }
}

export function applyStoredPositions(
  nodes: TableNode[],
  positions: Record<string, CanvasNodeLayout> | undefined,
): TableNode[] | null {
  if (!positions || !nodes.every((node) => positions[node.id])) return null;
  return nodes.map((node) => applyStoredNodeLayout(node, positions[node.id]));
}

export function persistLayout(snapshotFingerprint: string, nodes: TableNode[]): void {
  localStorage.setItem(layoutStorageKey(snapshotFingerprint), JSON.stringify(serializeCanvasLayout(nodes)));
  localStorage.removeItem(legacyLayoutStorageKey(snapshotFingerprint));
}

export function serializeCanvasLayout(nodes: TableNode[]): Record<string, CanvasNodeLayout> {
  return Object.fromEntries(nodes.map((node) => [node.id, {
    ...node.position,
    width: nodeDimension(node, "width"),
    height: nodeDimension(node, "height"),
  }]));
}

interface StoredNodeLayout {
  x: number;
  y: number;
  width?: number;
  height?: number;
}

function applyStoredNodeLayout(node: TableNode, stored: StoredNodeLayout): TableNode {
  const width = validDimension(stored.width) ? stored.width : undefined;
  const height = validDimension(stored.height) ? stored.height : undefined;
  return {
    ...node,
    position: { x: stored.x, y: stored.y },
    style: {
      width: width ?? nodeDimension(node, "width") ?? 280,
      height: height ?? nodeDimension(node, "height") ?? estimatedTableNodeHeight(node.data.table),
    },
  };
}

function nodeDimension(node: TableNode, dimension: "width" | "height"): number | undefined {
  const measured = node.measured?.[dimension];
  if (validDimension(measured)) return measured;
  const value = node.style?.[dimension];
  return validDimension(value) ? value : undefined;
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
