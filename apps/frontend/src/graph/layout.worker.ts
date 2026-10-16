/// <reference lib="webworker" />
import { layoutLargeComponent, layoutQualityOptions } from "./large-component-layout";

import ELK, { type ELK as ElkApi } from "elkjs/lib/elk-api.js";
import ElkWorker from "elkjs/lib/elk-worker.min.js?worker";
import { packLayoutComponents, splitLayoutComponents, type PositionedLayoutNode } from "./layout-components";

interface LayoutRequest {
  options: {
    direction: "leftToRight" | "topToBottom";
    nodeSpacing: number;
    layerSpacing: number;
    edgeSpacing: number;
  };
  nodes: Array<{ id: string; width: number; height: number }>;
  edges: Array<{ id: string; source: string; target: string }>;
}

// elk-worker decides at load time whether it *is* a worker script or is being
// imported as a module, by testing `typeof document === "undefined" && typeof
// self !== "undefined"`. Inside a Web Worker both hold, so importing it here —
// directly, or transitively via elk.bundled.js — took the worker branch: it
// exported nothing (leaving elk.bundled's `require(...).Worker` undefined, so
// layout rejected with "undefined is not a constructor" and the canvas fell
// back to the deterministic grid) and it overwrote this worker's own
// `self.onmessage`. Load it the way it expects instead, as a nested worker.
let elk: ElkApi | undefined;

self.onmessage = (event: MessageEvent<LayoutRequest>) => {
  void layoutComponents(event.data)
    .then((positions) => self.postMessage({ positions }))
    .catch((error: unknown) => {
      self.postMessage({ error: error instanceof Error ? error.message : String(error) });
    });
};

async function layoutComponents(request: LayoutRequest): Promise<Record<string, { x: number; y: number }>> {
  const components = splitLayoutComponents(request.nodes, request.edges);
  const positionedComponents: PositionedLayoutNode[][] = [];
  for (const [index, component] of components.entries()) {
    if (component.nodes.length === 1) {
      positionedComponents.push([{ ...component.nodes[0], x: 0, y: 0 }]);
      continue;
    }
    if (component.nodes.length >= 200) {
      positionedComponents.push(layoutLargeComponent(component, request.options.direction, Math.max(request.options.nodeSpacing, request.options.layerSpacing)));
      continue;
    }
    elk ??= new ELK({ workerFactory: () => new ElkWorker() });
    const graph = await elk.layout({
      id: `schema-component-${index}`,
      layoutOptions: {
        "elk.algorithm": "layered",
        "elk.direction": request.options.direction === "topToBottom" ? "DOWN" : "RIGHT",
        "elk.spacing.nodeNode": String(request.options.nodeSpacing),
        "elk.spacing.edgeEdge": String(request.options.edgeSpacing),
        "elk.layered.spacing.edgeEdgeBetweenLayers": String(request.options.edgeSpacing),
        "elk.layered.spacing.nodeNodeBetweenLayers": String(request.options.layerSpacing),
        ...layoutQualityOptions(request.nodes.length),
        "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
      },
      children: component.nodes.map((node) => ({
        id: node.id,
        width: node.width,
        height: node.height,
      })),
      edges: component.edges.map((edge) => ({
        id: edge.id,
        sources: [edge.source],
        targets: [edge.target],
      })),
    });
    const positions = new Map(graph.children?.map((child) => [child.id, child]));
    positionedComponents.push(component.nodes.map((node) => {
      const positioned = positions.get(node.id);
      return { ...node, x: positioned?.x ?? 0, y: positioned?.y ?? 0 };
    }));
  }
  return packLayoutComponents(positionedComponents, Math.max(140, request.options.nodeSpacing * 2));
}
