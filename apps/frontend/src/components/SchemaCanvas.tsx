import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  useEdgesState,
  useKeyPress,
  useNodesState,
  useReactFlow,
  useViewport,
  type Connection,
  type NodeChange,
  type NodeTypes,
} from "@xyflow/react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  DatabaseSnapshot,
  AppSettings,
  SavedView,
  SchemaChangeSet,
  SemanticBundle,
  TableDefinition,
  LogicalRelationship,
  RelationshipEndpoint,
  RelationshipValidation,
  SaveLogicalRelationshipInput,
} from "../platform";
import {
  applyStoredPositions,
  layoutSchemaGraph,
  persistLayout,
  restoreLayout,
  serializeCanvasLayout,
} from "../graph/elk-layout";
import {
  buildSchemaGraph,
  orientFieldEdges,
  type FieldEdge,
  type TableNode as TableNodeType,
  logicalRelationshipKey,
  inferredRelationshipRuleKey,
} from "../graph/schema-graph";
import { TableNode } from "./TableNode";
import { relationshipEndpointFromHandle, sameRelationshipEndpoint } from "../graph/relationship-interaction";
import { CanvasInteractionProvider } from "./CanvasInteractionContext";
import { CanvasSettingsProvider } from "./CanvasSettingsContext";
import { RelationshipCreatePopover, type RelationshipDraft } from "./relationships/RelationshipCreatePopover";
import { RelationshipInspector } from "./relationships/RelationshipInspector";
import { RelationshipManager } from "./relationships/RelationshipManager";
import { RelationshipTargetPicker } from "./relationships/RelationshipTargetPicker";
import "@xyflow/react/dist/style.css";

const nodeTypes = { table: TableNode } satisfies NodeTypes;

interface SchemaCanvasProps {
  snapshot: DatabaseSnapshot;
  query: string;
  changeSet?: SchemaChangeSet;
  onSelectTable: (table: TableDefinition | undefined) => void;
  selectedTable?: TableDefinition;
  semantics?: SemanticBundle;
  savedView?: SavedView;
  onSaveLayout?: (positions: Record<string, import("../platform/types").CanvasNodeLayout>) => void;
  canvasSettings: AppSettings["canvas"];
  layoutWorkerTimeoutMs?: number;
  highContrastRelations?: boolean;
  colorBlindPalette?: boolean;
  renderDegradeThreshold?: number;
  onOpenQuery?: (table: TableDefinition) => void;
  onValidateLogicalRelationship?: (input: {
    sourceId: string;
    source: RelationshipEndpoint;
    target: RelationshipEndpoint;
    relationshipId?: string;
  }) => Promise<RelationshipValidation>;
  onCreateLogicalRelationship?: (input: SaveLogicalRelationshipInput) => Promise<LogicalRelationship>;
  onUpdateLogicalRelationship?: (input: SaveLogicalRelationshipInput) => Promise<LogicalRelationship>;
  onDeleteLogicalRelationship?: (relationshipId: string) => Promise<void>;
  onIgnoreRelationshipInference?: (relationshipKey: string) => Promise<void>;
  onClearSearch?: () => void;
}

export function SchemaCanvas(props: SchemaCanvasProps) {
  return (
    <CanvasSettingsProvider value={props.canvasSettings}>
      <ReactFlowProvider>
        <SchemaCanvasInner {...props} />
      </ReactFlowProvider>
    </CanvasSettingsProvider>
  );
}

function SchemaCanvasInner({
  snapshot,
  query,
  changeSet,
  onSelectTable,
  selectedTable,
  semantics,
  savedView,
  onSaveLayout,
  canvasSettings,
  layoutWorkerTimeoutMs = 15_000,
  highContrastRelations = false,
  colorBlindPalette = false,
  renderDegradeThreshold = 500,
  onOpenQuery,
  onValidateLogicalRelationship,
  onCreateLogicalRelationship,
  onUpdateLogicalRelationship,
  onDeleteLogicalRelationship,
  onIgnoreRelationshipInference,
  onClearSearch,
}: SchemaCanvasProps) {
  const [focusNodeId, setFocusNodeId] = useState<string>();
  const spacePanMode = useKeyPress("Space");
  const { fitView, getNodes } = useReactFlow<TableNodeType, FieldEdge>();
  const viewport = useViewport();
  const viewportRevision = `${viewport.x}:${viewport.y}:${viewport.zoom}`;
  const [inferredRelationshipOverride, setInferredRelationshipOverride] = useState<boolean>();
  const [physicalRelationshipOverride, setPhysicalRelationshipOverride] = useState<boolean>();
  const [showLogicalRelationships, setShowLogicalRelationships] = useState(true);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string>();
  const [showInvalidRelationships, setShowInvalidRelationships] = useState(false);
  const [relationshipDraft, setRelationshipDraft] = useState<RelationshipDraft>();
  const [relationshipPickSource, setRelationshipPickSource] = useState<RelationshipEndpoint>();
  const [relationshipPickExisting, setRelationshipPickExisting] = useState<LogicalRelationship>();
  const [relationshipRebindSourceSelection, setRelationshipRebindSourceSelection] = useState<LogicalRelationship>();
  const [relationshipManagerOpen, setRelationshipManagerOpen] = useState(false);
  const [relationshipActionError, setRelationshipActionError] = useState("");
  const [connectionDragSource, setConnectionDragSource] = useState<RelationshipEndpoint>();
  const [selectedEdgeAnchor, setSelectedEdgeAnchor] = useState<{ edgeId: string; x: number; y: number }>();
  const [columnContextMenu, setColumnContextMenu] = useState<{ x: number; y: number; source: RelationshipEndpoint }>();
  const relationshipsEditable = Boolean(onValidateLogicalRelationship && onCreateLogicalRelationship);
  const showInferredRelationships =
    inferredRelationshipOverride ?? canvasSettings.showInferredRelationships;
  const showPhysicalRelationships =
    physicalRelationshipOverride ?? canvasSettings.showDeclaredRelationships;
  const graph = useMemo(
    () => {
      const built = buildSchemaGraph(snapshot, {
        query,
        focusNodeId,
        changeSet,
        rootNodeIds: savedView?.rootTableKeys.map((key) => `${key.schema}.${key.name}`),
        relationshipDepth: savedView?.relationshipDepth,
        annotations: semantics?.annotations,
        domainGroups: semantics?.domainGroups,
        includeInferredRelationships: showInferredRelationships,
        includePhysicalRelationships: showPhysicalRelationships,
        includeLogicalRelationships: showLogicalRelationships,
        includeInvalidLogicalRelationships: showInvalidRelationships,
        logicalRelationships: semantics?.logicalRelationships,
        ignoredRelationshipKeys: semantics?.ignoredRelationshipInferences.map((item) => item.relationshipKey),
        relationshipsEditable,
        showRelationshipLabels: canvasSettings.showRelationNames,
        edgeStyle: canvasSettings.edgeStyle,
        fieldLevelEdges: canvasSettings.fieldLevelEdges,
        showCardinality: canvasSettings.showCardinality,
        showReferentialActions: canvasSettings.showReferentialActions,
        relationshipHighlightDepth: canvasSettings.relationshipHighlightDepth,
        highContrastRelations,
        colorBlindPalette,
        maxInitialColumns: canvasSettings.maxInitialColumns,
        indexes: canvasSettings.indexes,
        showTableComments: canvasSettings.showTableComments,
      });
      return onOpenQuery ? {
        ...built,
        nodes: built.nodes.map((node) => ({ ...node, data: { ...node.data, onOpenQuery } })),
      } : built;
    },
    [canvasSettings.edgeStyle, canvasSettings.fieldLevelEdges, canvasSettings.indexes, canvasSettings.maxInitialColumns, canvasSettings.relationshipHighlightDepth, canvasSettings.showCardinality, canvasSettings.showReferentialActions, canvasSettings.showRelationNames, canvasSettings.showTableComments, changeSet, colorBlindPalette, focusNodeId, highContrastRelations, onOpenQuery, query, relationshipsEditable, savedView, semantics, showInferredRelationships, showInvalidRelationships, showLogicalRelationships, showPhysicalRelationships, snapshot],
  );
  const [nodes, setNodes] = useNodesState<TableNodeType>(graph.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(graph.edges);
  const persistResizedNodes = useRef(false);
  const lastAutoFitFingerprint = useRef<string | undefined>(undefined);
  const selectedTableNodeId = selectedTable
    ? `${selectedTable.key.schema}.${selectedTable.key.name}`
    : undefined;
  const selectedEdge = edges.find((edge) => edge.id === selectedEdgeId);
  useLayoutEffect(() => {
    void viewportRevision;
    if (!selectedEdge) return;
    const frame = window.requestAnimationFrame(() => {
      const edgeElement = Array.from(document.querySelectorAll<SVGGElement>(".schema-canvas-flow .react-flow__edge"))
        .find((element) => element.dataset.id === selectedEdge.id);
      const edgePath = edgeElement?.querySelector<SVGPathElement>(".react-flow__edge-path");
      if (!edgePath) return;
      const bounds = edgePath.getBoundingClientRect();
      setSelectedEdgeAnchor({
        edgeId: selectedEdge.id,
        x: bounds.left + bounds.width / 2,
        y: bounds.top + bounds.height / 2,
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [nodes, selectedEdge, viewportRevision]);
  const displayedEdges = useMemo(() => edges.map((edge) => {
    if (!selectedEdge) return edge;
    const highlighted = edge.id === selectedEdge.id;
    const originalStroke = typeof edge.style?.stroke === "string" ? edge.style.stroke : "#2563eb";
    return {
      ...edge,
      zIndex: highlighted ? 30 : 0,
      style: {
        ...edge.style,
        stroke: highlighted ? originalStroke : "#9ca3af",
        strokeWidth: highlighted ? Math.max(Number(edge.style?.strokeWidth ?? 1.8), 3.4) : 1.15,
        opacity: highlighted ? 1 : 0.18,
      },
      markerEnd: typeof edge.markerEnd === "object" ? {
        ...edge.markerEnd,
        color: highlighted ? originalStroke : "#9ca3af",
      } : edge.markerEnd,
      labelStyle: { ...edge.labelStyle, opacity: highlighted ? 1 : 0.12 },
      labelBgStyle: { ...edge.labelBgStyle, fillOpacity: highlighted ? 0.94 : 0.08 },
    };
  }), [edges, selectedEdge]);
  const activeRelationshipSource = relationshipPickSource ?? connectionDragSource;
  const displayedNodes = useMemo(() => nodes.map((node) => {
    const isSource = node.id === selectedEdge?.source;
    const isTarget = node.id === selectedEdge?.target;
    const sourceNode = activeRelationshipSource
      ? graph.nodes.find((candidate) => candidate.id === `${activeRelationshipSource.schema}.${activeRelationshipSource.table}`)
      : undefined;
    const sourceColumn = sourceNode?.data.table.columns.find((column) => column.name === activeRelationshipSource?.columns[0]);
    const relationshipConnectTargets = sourceColumn && activeRelationshipSource
      ? Object.fromEntries(node.data.table.columns.map((column) => {
          const sameField = node.data.schema === activeRelationshipSource.schema
            && node.data.table.key.name === activeRelationshipSource.table
            && column.name === activeRelationshipSource.columns[0];
          const compatible = column.typeName === sourceColumn.typeName && column.typeSchema === sourceColumn.typeSchema;
          return [column.name, sameField ? "invalid" : compatible ? "valid" : "warning"];
        })) as Record<string, "valid" | "warning" | "invalid">
      : undefined;
    return {
      ...node,
      selected: node.id === selectedTableNodeId,
      data: {
        ...node.data,
        relationshipHighlighted: selectedEdge ? isSource || isTarget : undefined,
        relationshipColumn: selectedEdge
          ? isSource
            ? selectedEdge.data?.sourceColumn
            : isTarget
              ? selectedEdge.data?.targetColumn
              : undefined
          : undefined,
        relationshipConnectTargets,
      },
    };
  }), [activeRelationshipSource, graph.nodes, nodes, selectedEdge, selectedTableNodeId]);

  const endpointFromHandle = useCallback((nodeId: string | null | undefined, handleId: string | null | undefined): RelationshipEndpoint | undefined => {
    return relationshipEndpointFromHandle(graph.nodes, nodeId, handleId);
  }, [graph.nodes]);

  const connectionEndpoint = useCallback((connection: Connection | FieldEdge, side: "source" | "target") => endpointFromHandle(
    side === "source" ? connection.source : connection.target,
    side === "source" ? connection.sourceHandle : connection.targetHandle,
  ), [endpointFromHandle]);

  const isValidRelationshipConnection = useCallback((connection: Connection | FieldEdge) => {
    const source = connectionEndpoint(connection, "source");
    const target = connectionEndpoint(connection, "target");
    if (!source || !target) return false;
    return !sameRelationshipEndpoint(source, target);
  }, [connectionEndpoint]);

  const saveRelationshipDraft = useCallback(async (input: SaveLogicalRelationshipInput) => {
    if (input.id) {
      if (!onUpdateLogicalRelationship) throw new Error("Logical relationship editing is unavailable.");
      await onUpdateLogicalRelationship(input);
    } else {
      if (!onCreateLogicalRelationship) throw new Error("Logical relationship creation is unavailable.");
      await onCreateLogicalRelationship(input);
    }
    setRelationshipDraft(undefined);
    setRelationshipPickSource(undefined);
    setRelationshipPickExisting(undefined);
  }, [onCreateLogicalRelationship, onUpdateLogicalRelationship]);

  const selectedLogicalRelationship = selectedEdge?.data?.relationshipKind === "logical"
    ? semantics?.logicalRelationships.find((relationship) => relationship.id === selectedEdge.data?.relationshipId)
    : undefined;

  const startEditingSelectedRelationship = useCallback(() => {
    if (!selectedLogicalRelationship) return;
    setRelationshipDraft({
      source: selectedLogicalRelationship.source,
      target: selectedLogicalRelationship.target,
      relationship: selectedLogicalRelationship,
    });
  }, [selectedLogicalRelationship]);

  const reportRelationshipError = useCallback((reason: unknown) => {
    setRelationshipActionError(reason instanceof Error ? reason.message : String(reason));
  }, []);

  const deleteSelectedLogicalRelationship = useCallback(() => {
    if (!selectedLogicalRelationship || !onDeleteLogicalRelationship) return;
    if (!window.confirm(`Delete logical relationship “${selectedLogicalRelationship.name}”?\n\nThe database will not be changed.`)) return;
    void onDeleteLogicalRelationship(selectedLogicalRelationship.id)
      .then(() => setSelectedEdgeId(undefined))
      .catch(reportRelationshipError);
  }, [onDeleteLogicalRelationship, reportRelationshipError, selectedLogicalRelationship]);

  const chooseRelationshipTarget = useCallback((target: RelationshipEndpoint) => {
    if (!relationshipPickSource) return;
    setRelationshipDraft({
      source: relationshipPickSource,
      target,
      relationship: relationshipPickExisting,
      origin: relationshipPickExisting ? undefined : "manual",
    });
    setRelationshipPickSource(undefined);
    setRelationshipPickExisting(undefined);
  }, [relationshipPickExisting, relationshipPickSource]);

  useEffect(() => {
    const clearRelationship = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSelectedEdgeId(undefined);
        setRelationshipDraft(undefined);
        setRelationshipPickSource(undefined);
        setRelationshipPickExisting(undefined);
        setRelationshipRebindSourceSelection(undefined);
        setRelationshipManagerOpen(false);
        setColumnContextMenu(undefined);
      }
    };
    window.addEventListener("keydown", clearRelationship);
    return () => window.removeEventListener("keydown", clearRelationship);
  }, []);

  useEffect(() => {
    const deleteSelectedRelationship = (event: KeyboardEvent) => {
      if (event.key !== "Delete" && event.key !== "Backspace") return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      if (!selectedLogicalRelationship) return;
      event.preventDefault();
      deleteSelectedLogicalRelationship();
    };
    window.addEventListener("keydown", deleteSelectedRelationship);
    return () => window.removeEventListener("keydown", deleteSelectedRelationship);
  }, [deleteSelectedLogicalRelationship, selectedLogicalRelationship]);

  useEffect(() => {
    let active = true;
    let firstFitFrame = 0;
    let secondFitFrame = 0;
    const shouldAutoFit = lastAutoFitFingerprint.current !== snapshot.fingerprint;
    const fitLayoutedGraph = () => {
      if (!shouldAutoFit) return;
      firstFitFrame = window.requestAnimationFrame(() => {
        secondFitFrame = window.requestAnimationFrame(() => {
          if (active) {
            lastAutoFitFingerprint.current = snapshot.fingerprint;
            void fitView({ duration: 300, padding: 0.12, maxZoom: 1 });
          }
        });
      });
    };
    const liveNodes = !shouldAutoFit
      ? applyStoredPositions(graph.nodes, serializeCanvasLayout(getNodes()))
      : null;
    if (liveNodes) {
      setNodes(liveNodes);
      setEdges(orientFieldEdges(graph.edges, liveNodes));
      return () => {
        active = false;
      };
    }
    const saved =
      !query && !focusNodeId && !savedView
        ? (applyStoredPositions(graph.nodes, semantics?.layout?.positions) ??
          restoreLayout(snapshot.fingerprint, graph.nodes))
        : null;
    const positionedNodes = saved ?? graph.nodes;
    setNodes(positionedNodes);
    setEdges(orientFieldEdges(graph.edges, positionedNodes));
    if (saved) {
      fitLayoutedGraph();
    } else {
      void layoutSchemaGraph(graph.nodes, graph.edges, { direction: canvasSettings.layoutDirection, nodeSpacing: canvasSettings.nodeSpacing, layerSpacing: canvasSettings.layerSpacing, edgeSpacing: canvasSettings.edgeSpacing, timeoutMs: layoutWorkerTimeoutMs })
        .then((layoutedNodes) => {
          if (active) {
            setNodes(layoutedNodes);
            setEdges(orientFieldEdges(graph.edges, layoutedNodes));
            if (!query && !focusNodeId && !savedView) {
              persistLayout(snapshot.fingerprint, layoutedNodes);
              onSaveLayout?.(serializeCanvasLayout(layoutedNodes));
            }
            fitLayoutedGraph();
          }
        })
        .catch(() => {
          // The deterministic grid from buildSchemaGraph remains a usable fallback.
          if (active) fitLayoutedGraph();
        });
    }
    return () => {
      active = false;
      if (firstFitFrame) window.cancelAnimationFrame(firstFitFrame);
      if (secondFitFrame) window.cancelAnimationFrame(secondFitFrame);
    };
  }, [canvasSettings.edgeSpacing, canvasSettings.layerSpacing, canvasSettings.layoutDirection, canvasSettings.nodeSpacing, fitView, focusNodeId, getNodes, graph, layoutWorkerTimeoutMs, onSaveLayout, query, savedView, semantics?.layout?.positions, setEdges, setNodes, snapshot.fingerprint]);

  useEffect(() => {
    if (!persistResizedNodes.current) return;
    persistResizedNodes.current = false;
    if (query || focusNodeId || savedView) return;
    persistLayout(snapshot.fingerprint, nodes);
    onSaveLayout?.(serializeCanvasLayout(nodes));
  }, [focusNodeId, nodes, onSaveLayout, query, savedView, snapshot.fingerprint]);

  useEffect(() => {
    function fitCanvas() {
      void fitView({ duration: 250, padding: 0.12 });
    }
    function relayoutCanvas() {
      void layoutSchemaGraph(nodes, graph.edges, { direction: canvasSettings.layoutDirection, nodeSpacing: canvasSettings.nodeSpacing, layerSpacing: canvasSettings.layerSpacing, edgeSpacing: canvasSettings.edgeSpacing, timeoutMs: layoutWorkerTimeoutMs }).then((layoutedNodes) => {
        setNodes(layoutedNodes);
        setEdges(orientFieldEdges(graph.edges, layoutedNodes));
        if (!query && !focusNodeId && !savedView) {
          persistLayout(snapshot.fingerprint, layoutedNodes);
          onSaveLayout?.(serializeCanvasLayout(layoutedNodes));
        }
        window.requestAnimationFrame(() => {
          void fitView({ duration: 300, padding: 0.12, maxZoom: 1 });
        });
      });
    }
    function focusSelectedTable() {
      if (selectedTable) setFocusNodeId(`${selectedTable.key.schema}.${selectedTable.key.name}`);
    }
    function viewAllTables() {
      setSelectedEdgeId(undefined);
      onSelectTable(undefined);
      if (focusNodeId) {
        setFocusNodeId(undefined);
      } else {
        void fitView({ duration: 300, padding: 0.12, maxZoom: 1 });
      }
    }
    function locateTable(event: Event) {
      const nodeId = (event as CustomEvent<{ nodeId?: string }>).detail?.nodeId;
      if (!nodeId) return;
      setFocusNodeId(undefined);
      setSelectedEdgeId(undefined);
      const node = nodes.find((candidate) => candidate.id === nodeId);
      if (node) window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
        void fitView({ nodes: [node], duration: 350, padding: 0.8, minZoom: 0.75, maxZoom: 1.2 });
      }));
    }
    window.addEventListener("nodalstudio:fit-canvas", fitCanvas);
    window.addEventListener("nodalstudio:relayout-canvas", relayoutCanvas);
    window.addEventListener("nodalstudio:focus-selected-table", focusSelectedTable);
    window.addEventListener("nodalstudio:view-all-tables", viewAllTables);
    window.addEventListener("nodalstudio:locate-table", locateTable);
    return () => {
      window.removeEventListener("nodalstudio:fit-canvas", fitCanvas);
      window.removeEventListener("nodalstudio:relayout-canvas", relayoutCanvas);
      window.removeEventListener("nodalstudio:focus-selected-table", focusSelectedTable);
      window.removeEventListener("nodalstudio:view-all-tables", viewAllTables);
      window.removeEventListener("nodalstudio:locate-table", locateTable);
    };
  }, [canvasSettings.edgeSpacing, canvasSettings.layerSpacing, canvasSettings.layoutDirection, canvasSettings.nodeSpacing, fitView, focusNodeId, graph, layoutWorkerTimeoutMs, nodes, onSaveLayout, onSelectTable, query, savedView, selectedTable, setEdges, setNodes, snapshot.fingerprint]);

  return (
    <>
      <CanvasInteractionProvider value={{ spacePanMode }}>
      <ReactFlow<TableNodeType, FieldEdge>
        className={[
          "schema-canvas-flow",
          nodes.length >= Math.min(canvasSettings.largeModelThreshold, renderDegradeThreshold) ? "large-model-mode" : "",
          spacePanMode ? "space-pan-mode" : "",
          activeRelationshipSource || relationshipRebindSourceSelection ? "relationship-picking-mode" : "",
        ].filter(Boolean).join(" ")}
        nodes={displayedNodes}
        edges={displayedEdges}
        nodeTypes={nodeTypes}
        onNodesChange={(changes: NodeChange<TableNodeType>[]) => {
          const resizeEnded = changes.some(
            (change) => change.type === "dimensions" && change.resizing === false,
          );
          if (resizeEnded) persistResizedNodes.current = true;
          setNodes((currentNodes) => {
            return applyNodeChanges(changes, currentNodes);
          });
        }}
        onEdgesChange={onEdgesChange}
        onConnectStart={(_event, params) => {
          if (params.handleType !== "source") return;
          setConnectionDragSource(endpointFromHandle(params.nodeId, params.handleId));
        }}
        onConnectEnd={() => setConnectionDragSource(undefined)}
        isValidConnection={isValidRelationshipConnection}
        connectionLineStyle={{ stroke: "#7c3aed", strokeWidth: 2, strokeDasharray: "8 5" }}
        autoPanOnConnect
        onConnect={(connection) => {
          const source = connectionEndpoint(connection, "source");
          const target = connectionEndpoint(connection, "target");
          if (source && target) setRelationshipDraft({ source, target, origin: "manual" });
        }}
        nodesDraggable={!spacePanMode}
        nodeDragThreshold={6}
        nodeClickDistance={6}
        paneClickDistance={6}
        panOnDrag
        panActivationKeyCode="Space"
        zoomOnDoubleClick={false}
        edgesFocusable
        edgesReconnectable={false}
        onEdgeClick={(event, edge) => {
          event.preventDefault();
          event.stopPropagation();
          onSelectTable(undefined);
          setSelectedEdgeId(edge.id);
          setSelectedEdgeAnchor({ edgeId: edge.id, x: event.clientX, y: event.clientY });
        }}
        onEdgeDoubleClick={(event, edge) => {
          event.preventDefault();
          event.stopPropagation();
          onSelectTable(undefined);
          setSelectedEdgeId(edge.id);
          setSelectedEdgeAnchor({ edgeId: edge.id, x: event.clientX, y: event.clientY });
          if (edge.data?.relationshipKind !== "logical") return;
          const relationship = semantics?.logicalRelationships.find((item) => item.id === edge.data?.relationshipId);
          if (relationship) {
            setRelationshipDraft({
              source: relationship.source,
              target: relationship.target,
              relationship,
            });
          }
        }}
        onNodeClick={(event, node) => {
          event.stopPropagation();
          if (!spacePanMode) {
            const element = event.target instanceof Element
              ? event.target.closest<HTMLElement>("[data-column-name]")
              : null;
            if (relationshipRebindSourceSelection && element?.dataset.columnName) {
              setRelationshipPickSource({
                schema: node.data.schema,
                table: node.data.table.key.name,
                columns: [element.dataset.columnName],
              });
              setRelationshipPickExisting(relationshipRebindSourceSelection);
              setRelationshipRebindSourceSelection(undefined);
              return;
            }
            if (relationshipPickSource && element?.dataset.columnName) {
              chooseRelationshipTarget({
                schema: node.data.schema,
                table: node.data.table.key.name,
                columns: [element.dataset.columnName],
              });
              return;
            }
            setSelectedEdgeId(undefined);
            onSelectTable(node.data.table);
          }
        }}
        onNodeContextMenu={(event, node) => {
          if (!relationshipsEditable || spacePanMode) return;
          const element = event.target instanceof Element
            ? event.target.closest<HTMLElement>("[data-column-name]")
            : null;
          const column = element?.dataset.columnName;
          if (!column) return;
          event.preventDefault();
          event.stopPropagation();
          setColumnContextMenu({
            x: event.clientX,
            y: event.clientY,
            source: { schema: node.data.schema, table: node.data.table.key.name, columns: [column] },
          });
        }}
        onNodeDoubleClick={(event, node) => {
          event.preventDefault();
          event.stopPropagation();
          if (spacePanMode || relationshipPickSource || relationshipRebindSourceSelection) return;
          onSelectTable(node.data.table);
          setFocusNodeId((current) => current === node.id ? undefined : node.id);
        }}
        onPaneClick={() => {
          setSelectedEdgeId(undefined);
          setRelationshipPickSource(undefined);
          setRelationshipPickExisting(undefined);
          setRelationshipRebindSourceSelection(undefined);
          setColumnContextMenu(undefined);
          onSelectTable(undefined);
        }}
        onNodeDragStop={(_event, movedNode) => {
          const movedNodes = nodes.map((node) =>
            node.id === movedNode.id ? movedNode : node,
          );
          setEdges(orientFieldEdges(graph.edges, movedNodes));
          if (query || focusNodeId || savedView) return;
          persistLayout(snapshot.fingerprint, movedNodes);
          onSaveLayout?.(serializeCanvasLayout(movedNodes));
        }}
        fitView
        minZoom={0.1}
        maxZoom={1.8}
        colorMode="light"
      >
        <Background gap={20} size={1} />
        <MiniMap pannable zoomable />
        <Controls />
      </ReactFlow>
      </CanvasInteractionProvider>
      {columnContextMenu ? (
        <div className="relationship-context-menu" role="menu" style={{ left: columnContextMenu.x, top: columnContextMenu.y }}>
          <button type="button" role="menuitem" onClick={() => {
            setRelationshipPickSource(columnContextMenu.source);
            setRelationshipPickExisting(undefined);
            setColumnContextMenu(undefined);
          }}>Create logical relationship…</button>
          <button type="button" role="menuitem" onClick={() => {
            const id = `${columnContextMenu.source.schema}.${columnContextMenu.source.table}`;
            setColumnContextMenu(undefined);
            const related = edges.find((edge) =>
              (edge.source === id && edge.data?.sourceColumn === columnContextMenu.source.columns[0])
              || (edge.target === id && edge.data?.targetColumn === columnContextMenu.source.columns[0]));
            if (related) setSelectedEdgeId(related.id);
          }}>Show relationships</button>
        </div>
      ) : null}
      {relationshipRebindSourceSelection ? <div className="relationship-pick-hint">Select a new source field for {relationshipRebindSourceSelection.name} <button type="button" onClick={() => setRelationshipRebindSourceSelection(undefined)}>Cancel</button></div> : null}
      {relationshipPickSource ? <RelationshipTargetPicker snapshot={snapshot} source={relationshipPickSource} onSelect={chooseRelationshipTarget} onCancel={() => { setRelationshipPickSource(undefined); setRelationshipPickExisting(undefined); }} /> : null}
      {relationshipDraft && onValidateLogicalRelationship ? (
        <RelationshipCreatePopover
          key={`${relationshipDraft.relationship?.id ?? "new"}:${relationshipDraft.source.schema}.${relationshipDraft.source.table}.${relationshipDraft.source.columns.join(",")}:${relationshipDraft.target.schema}.${relationshipDraft.target.table}.${relationshipDraft.target.columns.join(",")}`}
          sourceId={snapshot.sourceId}
          draft={relationshipDraft}
          onValidate={onValidateLogicalRelationship}
          onSave={saveRelationshipDraft}
          onCancel={() => setRelationshipDraft(undefined)}
        />
      ) : null}
      {selectedEdge && selectedEdgeAnchor?.edgeId === selectedEdge.id ? (
        <RelationshipInspector
          edge={selectedEdge}
          anchor={selectedEdgeAnchor}
          onClose={() => setSelectedEdgeId(undefined)}
          onEditLogical={startEditingSelectedRelationship}
          onToggleLogical={() => {
            if (!selectedLogicalRelationship || !onUpdateLogicalRelationship) return;
            void onUpdateLogicalRelationship({
              id: selectedLogicalRelationship.id,
              sourceId: snapshot.sourceId,
              name: selectedLogicalRelationship.name,
              source: selectedLogicalRelationship.source,
              target: selectedLogicalRelationship.target,
              cardinality: selectedLogicalRelationship.cardinality,
              origin: selectedLogicalRelationship.origin,
              note: selectedLogicalRelationship.note,
              evidence: selectedLogicalRelationship.evidence,
              disabled: selectedLogicalRelationship.status !== "disabled",
              allowTypeMismatch: selectedLogicalRelationship.status === "conflicted",
            }).then(() => setSelectedEdgeId(undefined)).catch(reportRelationshipError);
          }}
          onDeleteLogical={() => {
            deleteSelectedLogicalRelationship();
          }}
          onConfirmInference={() => {
            if (selectedEdge.data?.relationshipKind !== "inferred") return;
            const source = endpointFromHandle(selectedEdge.source, `source:${selectedEdge.data.sourceColumn}:right`);
            const target = endpointFromHandle(selectedEdge.target, `target:${selectedEdge.data.targetColumn}:left`);
            if (source && target) setRelationshipDraft({ source, target, origin: "confirmedInference", evidence: selectedEdge.data.evidence });
          }}
          onDismissInference={() => {
            if (selectedEdge.data?.relationshipKind !== "inferred" || !onIgnoreRelationshipInference) return;
            const key = logicalRelationshipKey(selectedEdge.source, selectedEdge.data.sourceColumn, selectedEdge.target, selectedEdge.data.targetColumn);
            void onIgnoreRelationshipInference(key).then(() => setSelectedEdgeId(undefined)).catch(reportRelationshipError);
          }}
          onIgnoreInferenceRule={() => {
            if (selectedEdge.data?.relationshipKind !== "inferred" || !onIgnoreRelationshipInference) return;
            const key = inferredRelationshipRuleKey({ sourceId: selectedEdge.source, column: selectedEdge.data.sourceColumn });
            void onIgnoreRelationshipInference(key).then(() => setSelectedEdgeId(undefined)).catch(reportRelationshipError);
          }}
        />
      ) : null}
      {relationshipManagerOpen ? <RelationshipManager
        relationships={semantics?.logicalRelationships ?? []}
        onClose={() => setRelationshipManagerOpen(false)}
        onSelect={(relationship) => {
          setRelationshipManagerOpen(false);
          setShowLogicalRelationships(true);
          if (relationship.status !== "active") setShowInvalidRelationships(true);
          setSelectedEdgeId(`logical.${relationship.id}.0`);
        }}
        onEdit={(relationship) => {
          setRelationshipManagerOpen(false);
          setRelationshipDraft({ source: relationship.source, target: relationship.target, relationship });
        }}
        onRebindTarget={(relationship) => {
          setRelationshipManagerOpen(false);
          onClearSearch?.();
          const sourceTable = snapshot.schemas.find((schema) => schema.name === relationship.source.schema)?.tables.find((table) => table.key.name === relationship.source.table);
          const sourceExists = relationship.source.columns.every((name) => sourceTable?.columns.some((column) => column.name === name));
          if (sourceExists) {
            setRelationshipPickSource(relationship.source);
            setRelationshipPickExisting(relationship);
          } else {
            setRelationshipRebindSourceSelection(relationship);
          }
        }}
        onDelete={(relationship) => {
          if (!onDeleteLogicalRelationship || !window.confirm(`Delete logical relationship “${relationship.name}”?\n\nThe database will not be changed.`)) return;
          void onDeleteLogicalRelationship(relationship.id).catch(reportRelationshipError);
        }}
        onToggle={(relationship) => {
          if (!onUpdateLogicalRelationship) return;
          void onUpdateLogicalRelationship({
            id: relationship.id,
            sourceId: snapshot.sourceId,
            name: relationship.name,
            source: relationship.source,
            target: relationship.target,
            cardinality: relationship.cardinality,
            origin: relationship.origin,
            note: relationship.note,
            evidence: relationship.evidence,
            disabled: relationship.status !== "disabled",
            allowTypeMismatch: relationship.status === "conflicted",
          }).catch(reportRelationshipError);
        }}
      /> : null}
      {relationshipActionError ? <div className="relationship-action-error" role="alert">{relationshipActionError}<button type="button" onClick={() => setRelationshipActionError("")}>Dismiss</button></div> : null}
      <div className="canvas-status">
        <span>{nodes.length} tables</span>
        <button type="button" className="relationship-filter relationship-filter-physical" data-active={showPhysicalRelationships || undefined} onClick={() => setPhysicalRelationshipOverride(!showPhysicalRelationships)}>{showPhysicalRelationships ? "✓" : ""} {graph.physicalRelationshipCount} physical</button>
        <button type="button" className="relationship-filter relationship-filter-logical" data-active={showLogicalRelationships || undefined} onClick={() => setShowLogicalRelationships((value) => !value)}>{showLogicalRelationships ? "✓" : ""} {graph.logicalRelationshipCount} logical</button>
        <button type="button" onClick={() => window.dispatchEvent(new Event("nodalstudio:view-all-tables"))} title="Exit table focus and fit every table into the viewport">View all</button>
        <button type="button" onClick={() => window.dispatchEvent(new Event("nodalstudio:relayout-canvas"))} title="Arrange related tables into compact groups">Auto layout</button>
        <button type="button" onClick={() => setRelationshipManagerOpen(true)}>Manage relationships</button>
        {semantics?.logicalRelationships.some((relationship) => relationship.status !== "active") ? <button type="button" data-active={showInvalidRelationships || undefined} onClick={() => setShowInvalidRelationships((value) => !value)}>{showInvalidRelationships ? "Hide" : "Show"} inactive</button> : null}
        {selectedEdge ? <><span className="selected-relation-summary" title={selectedEdge.data?.relationshipKind === "logical" ? "Double-click to edit · Delete or Backspace to remove" : undefined}>{selectedEdge.data?.constraintName ?? selectedEdge.data?.relationshipKind}: {selectedEdge.source}.{selectedEdge.data?.sourceColumn} → {selectedEdge.target}.{selectedEdge.data?.targetColumn}</span><button type="button" onClick={() => setSelectedEdgeId(undefined)}>Clear relation</button></> : null}
        {query ? <span>Filtered by “{query}”</span> : null}
        {focusNodeId ? (
          <button type="button" onClick={() => setFocusNodeId(undefined)}>
            Show all relations
          </button>
        ) : (
          <span>
            {savedView
              ? `${savedView.name} · ${savedView.relationshipDepth} hops`
              : "Double-click a table to isolate its relations"}
          </span>
        )}
        {graph.inferredRelationshipCount > 0 ? (
          <button
            type="button"
            data-active={showInferredRelationships || undefined}
            onClick={() => setInferredRelationshipOverride(!showInferredRelationships)}
            title="Naming-based suggestions are not database constraints"
          >
            {showInferredRelationships ? "Hide" : "Show"} {graph.inferredRelationshipCount} inferred
          </button>
        ) : null}
      </div>
    </>
  );
}
