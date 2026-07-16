import type { Edge, Node } from "@xyflow/react";
import type { ProjectEdge, ProjectGraphSnapshot, ProjectNode } from "../platform";

export type SystemNodeData = { graphNode: ProjectNode };
export type SystemFlowNode = Node<SystemNodeData, "system">;
export type SystemFlowEdge = Edge<{ graphEdge: ProjectEdge }>;

export function filterSystemGraph(
  graph: ProjectGraphSnapshot,
  query: string,
  projectFilter: string,
  certaintyFilter: string,
): ProjectGraphSnapshot {
  const normalized = query.trim().toLowerCase();
  const architectural = graph.nodes.filter((node) => node.kind !== "file" && node.kind !== "module");
  const projectNodes = architectural.filter(
    (node) => projectFilter === "all" || node.projectId === projectFilter,
  );
  const matchingIds = new Set(
    projectNodes
      .filter(
        (node) =>
          !normalized ||
          `${node.name} ${node.qualifiedName} ${node.kind}`.toLowerCase().includes(normalized),
      )
      .map((node) => node.id),
  );
  const projectNodeIds = new Set(projectNodes.map((node) => node.id));
  if (normalized) {
    for (const edge of graph.edges) {
      if (matchingIds.has(edge.sourceId) && projectNodeIds.has(edge.targetId)) matchingIds.add(edge.targetId);
      if (matchingIds.has(edge.targetId) && projectNodeIds.has(edge.sourceId)) matchingIds.add(edge.sourceId);
    }
  }
  const edges = graph.edges.filter((edge) => {
    const inferred = edge.certainty === "aiInferred" || edge.certainty === "convention";
    if (certaintyFilter === "confirmed" && inferred) return false;
    if (certaintyFilter === "inferred" && !inferred) return false;
    return matchingIds.has(edge.sourceId) && matchingIds.has(edge.targetId);
  });
  const connected = new Set(edges.flatMap((edge) => [edge.sourceId, edge.targetId]));
  return {
    scanId: graph.scanId,
    nodes: projectNodes.filter((node) => matchingIds.has(node.id) && (connected.has(node.id) || normalized)),
    edges,
  };
}

export function buildSystemFlow(
  graph: ProjectGraphSnapshot,
): { nodes: SystemFlowNode[]; edges: SystemFlowEdge[] } {
  const lanes = new Map<number, number>();
  const nodes = graph.nodes.map((graphNode) => {
    const lane = nodeLane(graphNode.kind);
    const row = lanes.get(lane) ?? 0;
    lanes.set(lane, row + 1);
    return {
      id: graphNode.id,
      type: "system" as const,
      position: { x: lane * 280 + 60, y: row * 118 + 80 },
      data: { graphNode },
    };
  });
  const edges = graph.edges.map((graphEdge) => ({
    id: graphEdge.id,
    source: graphEdge.sourceId,
    target: graphEdge.targetId,
    label: graphEdge.kind,
    data: { graphEdge },
    animated: graphEdge.reviewStatus === "pending",
    style: {
      stroke: edgeColor(graphEdge),
      strokeWidth: 1.5,
      strokeDasharray:
        graphEdge.certainty === "aiInferred"
          ? "2 5"
          : graphEdge.certainty === "convention"
            ? "7 5"
            : undefined,
    },
  }));
  return { nodes, edges };
}

function nodeLane(kind: ProjectNode["kind"]): number {
  if (kind === "page") return 0;
  if (kind === "endpoint") return 1;
  if (kind === "service" || kind === "symbol") return 2;
  if (["repository", "ormModel", "query", "migration"].includes(kind)) return 3;
  return 4;
}

function edgeColor(edge: ProjectEdge): string {
  if (edge.certainty === "aiInferred") return "#c792ea";
  if (edge.certainty === "convention") return "#d5a94d";
  return "#5d718e";
}
