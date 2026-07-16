/// <reference lib="webworker" />

import ELK from "elkjs/lib/elk.bundled.js";
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

const elk = new ELK();

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
    const graph = await elk.layout({
      id: `schema-component-${index}`,
      layoutOptions: {
        "elk.algorithm": "layered",
        "elk.direction": request.options.direction === "topToBottom" ? "DOWN" : "RIGHT",
        "elk.spacing.nodeNode": String(request.options.nodeSpacing),
        "elk.spacing.edgeEdge": String(request.options.edgeSpacing),
        "elk.layered.spacing.edgeEdgeBetweenLayers": String(request.options.edgeSpacing),
        "elk.layered.spacing.nodeNodeBetweenLayers": String(request.options.layerSpacing),
        "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
        "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
        "elk.layered.compaction.postCompaction.strategy": "EDGE_LENGTH",
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
    positionedComponents.push(component.nodes.map((node) => {
      const positioned = graph.children?.find((child) => child.id === node.id);
      return { ...node, x: positioned?.x ?? 0, y: positioned?.y ?? 0 };
    }));
  }
  return packLayoutComponents(positionedComponents, Math.max(140, request.options.nodeSpacing * 2));
}
