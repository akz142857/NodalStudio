import {
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  type NodeProps,
  type NodeTypes,
} from "@xyflow/react";
import { useEffect, useMemo, useState } from "react";
import { AiReviewQueue } from "./AiReviewQueue";
import type {
  LocalProject,
  ProjectEdge,
  ProjectGraphSnapshot,
  ProjectNode,
  NodalStudioPlatform,
} from "../platform";
import {
  buildSystemFlow,
  filterSystemGraph,
  type SystemFlowEdge,
  type SystemFlowNode,
} from "../graph/system-map-graph";
import "@xyflow/react/dist/style.css";

export interface SystemMapSelection {
  node: ProjectNode;
  edges: ProjectEdge[];
}

interface SystemMapProps {
  platform: NodalStudioPlatform;
  sourceId: string;
  query: string;
  onSelect: (selection: SystemMapSelection | undefined) => void;
}

interface LoadedSystemGraph {
  projects: LocalProject[];
  scanIds: string[];
  graph: ProjectGraphSnapshot;
}

const nodeTypes = { system: SystemNode } satisfies NodeTypes;

async function loadSystemGraph(
  platform: NodalStudioPlatform,
  sourceId: string,
): Promise<LoadedSystemGraph> {
  const projects = (await platform.listLocalProjects()).filter((project) =>
    project.databaseSourceIds.includes(sourceId),
  );
  const snapshots = await Promise.all(
    projects.map(async (project) => {
      const scans = await platform.listProjectScans(project.id);
      const scan = scans.find((candidate) => candidate.status === "ready");
      return scan ? platform.getProjectGraph(scan.id) : null;
    }),
  );
  const nodeMap = new Map<string, ProjectNode>();
  const edgeMap = new Map<string, ProjectEdge>();
  for (const snapshot of snapshots) {
    for (const node of snapshot?.nodes ?? []) nodeMap.set(node.id, node);
    for (const edge of snapshot?.edges ?? []) edgeMap.set(edge.id, edge);
  }
  return {
    projects,
    scanIds: snapshots.filter((snapshot): snapshot is ProjectGraphSnapshot => Boolean(snapshot)).map((snapshot) => snapshot.scanId),
    graph: {
      scanId: snapshots.find(Boolean)?.scanId ?? "combined",
      nodes: [...nodeMap.values()],
      edges: [...edgeMap.values()],
    },
  };
}

export function SystemMap(props: SystemMapProps) {
  return (
    <ReactFlowProvider>
      <SystemMapInner {...props} />
    </ReactFlowProvider>
  );
}

function SystemMapInner({ platform, sourceId, query, onSelect }: SystemMapProps) {
  const [loaded, setLoaded] = useState<LoadedSystemGraph>({
    projects: [],
    scanIds: [],
    graph: { scanId: "combined", nodes: [], edges: [] },
  });
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [projectFilter, setProjectFilter] = useState("all");
  const [certaintyFilter, setCertaintyFilter] = useState("all");
  const [graphRevision, setGraphRevision] = useState(0);

  useEffect(() => {
    let disposed = false;
    void loadSystemGraph(platform, sourceId).then(
      (result) => {
        if (disposed) return;
        setLoaded(result);
        setStatus("ready");
      },
      () => {
        if (!disposed) setStatus("error");
      },
    );
    return () => {
      disposed = true;
    };
  }, [graphRevision, platform, sourceId]);

  const visibleGraph = useMemo(
    () => filterSystemGraph(loaded.graph, query, projectFilter, certaintyFilter),
    [certaintyFilter, loaded.graph, projectFilter, query],
  );
  const flow = useMemo(() => {
    const built = buildSystemFlow(visibleGraph);
    const positions = loadSystemMapPositions(sourceId);
    return { ...built, nodes: built.nodes.map((node) => ({ ...node, position: positions[node.id] ?? node.position })) };
  }, [sourceId, visibleGraph]);
  const [nodes, setNodes, onNodesChange] = useNodesState<SystemFlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<SystemFlowEdge>([]);

  useEffect(() => {
    setNodes(flow.nodes);
    setEdges(flow.edges);
  }, [flow.edges, flow.nodes, setEdges, setNodes]);

  if (status === "loading") {
    return <div className="system-map-empty"><strong>Indexing System Map…</strong><span>Loading the latest successful local project scans.</span></div>;
  }
  if (status === "error") {
    return <div className="system-map-empty" data-status="error"><strong>System Map unavailable</strong><span>The local project graph could not be loaded.</span></div>;
  }
  if (!loaded.projects.length) {
    return <div className="system-map-empty"><strong>No project bound to this database</strong><span>Add a local project from the left sidebar, then run Scan.</span></div>;
  }

  return (
    <div className="system-map">
      <div className="system-map-toolbar">
        <label>Project<select value={projectFilter} onChange={(event) => setProjectFilter(event.target.value)}><option value="all">All projects</option>{loaded.projects.map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}</select></label>
        <label>Evidence<select value={certaintyFilter} onChange={(event) => setCertaintyFilter(event.target.value)}><option value="confirmed">Confirmed/static</option><option value="all">Include inferred</option><option value="inferred">Inferred only</option></select></label>
        <span>{flow.nodes.length} nodes · {flow.edges.length} relations</span>
        <AiReviewQueue platform={platform} scanIds={loaded.scanIds} onGraphChanged={() => setGraphRevision((value) => value + 1)} />
      </div>
      <ReactFlow<SystemFlowNode, SystemFlowEdge>
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={nodeTypes}
        onNodeClick={(_event, node) => {
          const graphNode = node.data.graphNode;
          onSelect({
            node: graphNode,
            edges: visibleGraph.edges.filter(
              (edge) => edge.sourceId === graphNode.id || edge.targetId === graphNode.id,
            ),
          });
        }}
        onPaneClick={() => onSelect(undefined)}
        onNodeDragStop={(_event, node) => saveSystemMapPosition(sourceId, node.id, node.position)}
        fitView
        minZoom={0.15}
        maxZoom={1.8}
        colorMode="light"
      >
        <Background gap={20} size={1} />
        <MiniMap pannable zoomable nodeColor="#8793a3" />
        <Controls />
      </ReactFlow>
    </div>
  );
}

function loadSystemMapPositions(sourceId: string): Record<string, { x: number; y: number }> {
  try {
    const parsed: unknown = JSON.parse(
      localStorage.getItem(`nodalstudio:system-map:${sourceId}`) ??
        localStorage.getItem(`sqlaieditor:system-map:${sourceId}`) ??
        "{}",
    );
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, { x: number; y: number }] => {
      const value: unknown = entry[1];
      return Boolean(value && typeof value === "object" && "x" in value && "y" in value && typeof value.x === "number" && typeof value.y === "number");
    }));
  } catch { return {}; }
}

function saveSystemMapPosition(sourceId: string, nodeId: string, position: { x: number; y: number }) {
  const positions = loadSystemMapPositions(sourceId);
  positions[nodeId] = position;
  localStorage.setItem(`nodalstudio:system-map:${sourceId}`, JSON.stringify(positions));
  localStorage.removeItem(`sqlaieditor:system-map:${sourceId}`);
}

function SystemNode({ data, selected }: NodeProps<SystemFlowNode>) {
  const node = data.graphNode;
  return (
    <article className="system-node" data-kind={node.kind} data-selected={selected || undefined}>
      <Handle type="target" position={Position.Left} />
      <small>{node.kind}</small>
      <strong>{node.name}</strong>
      <span>{node.relativePath ? `${node.relativePath}${node.line ? `:${node.line}` : ""}` : node.qualifiedName}</span>
      <Handle type="source" position={Position.Right} />
    </article>
  );
}
