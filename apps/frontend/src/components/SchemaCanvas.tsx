import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  SelectionMode,
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
  NodalStudioPlatform,
  RuntimeInfo,
  DomainGroup,
  ObjectKey,
} from "../platform";
import { getPlatform } from "../platform";
import { captureDiagramSvg, diagramFileName } from "../graph/diagram-export";
import type { OperationFeedbackState } from "./OperationFeedback";
import { DiagramExportActions } from "./DiagramExportActions";
import { DiagramSelectionActions } from "./DiagramSelectionActions";
import { DiagramLayoutActions } from "./DiagramLayoutActions";
import { arrangeTables, tableArrangementLabels, type TableArrangement } from "../graph/arrange-tables";
import { captureLayoutFrame, DiagramLayoutHistory, type LayoutFrame } from "../graph/layout-history";
import { pinSelectedTables } from "../graph/table-position";
import { retainTableSelection, selectedCurrentTableKeys } from "../graph/table-selection";
import {
  applyStoredPositions,
  layoutSchemaGraph,
  layoutSelectedSchemaGraph,
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
import { ComparisonEdge } from "./relationships/ComparisonEdge";
import "@xyflow/react/dist/style.css";

const nodeTypes = { table: TableNode } satisfies NodeTypes;
const edgeTypes = { comparison: ComparisonEdge };
const multiSelectionKeys = ["Shift", "Meta", "Control"];
const emptyDomainGroups: DomainGroup[] = [];

export interface SchemaCanvasProps {
  platform?: NodalStudioPlatform;
  runtimeKind?: RuntimeInfo["kind"];
  readOnlyPreview?: boolean;
  snapshot: DatabaseSnapshot;
  query: string;
  changeSet?: SchemaChangeSet;
  beforeSnapshot?: DatabaseSnapshot;
  onSelectTable: (table: TableDefinition | undefined) => void;
  selectedTable?: TableDefinition;
  semantics?: SemanticBundle;
  savedView?: SavedView;
  layoutLoaded?: boolean;
  onSaveLayout?: (positions: Record<string, import("../platform/types").CanvasNodeLayout>) => void | Promise<void>;
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
  onAddTablesToDomain?: (domainId: string, tableKeys: ObjectKey[]) => Promise<DomainGroup>;
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
  platform = getPlatform(),
  runtimeKind,
  readOnlyPreview = false,
  snapshot,
  query,
  changeSet,
  beforeSnapshot,
  onSelectTable,
  selectedTable,
  semantics,
  savedView,
  layoutLoaded = true,
  onSaveLayout: saveCurrentLayout,
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
  onAddTablesToDomain,
}: SchemaCanvasProps) {
  const layoutFingerprint = `${JSON.stringify(snapshot.sourceId)}:${changeSet
    ? `comparison:${changeSet.id}:${beforeSnapshot?.fingerprint ?? "partial"}:${snapshot.fingerprint}`
    : snapshot.fingerprint}`;
  const [focusNodeId, setFocusNodeId] = useState<string>();
  const [boxSelectMode, setBoxSelectMode] = useState(false);
  const spacePanMode = useKeyPress("Space");
  const { fitView, getNodes, getViewport } = useReactFlow<TableNodeType, FieldEdge>();
  const flowRef = useRef<HTMLDivElement>(null);
  const [readyGraph, setReadyGraph] = useState<ReturnType<typeof buildSchemaGraph>>();
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
  const relationshipsEditable = !readOnlyPreview && !changeSet && Boolean(onValidateLogicalRelationship && onCreateLogicalRelationship);
  const showInferredRelationships =
    !readOnlyPreview && (inferredRelationshipOverride ?? canvasSettings.showInferredRelationships);
  const showPhysicalRelationships =
    physicalRelationshipOverride ?? canvasSettings.showDeclaredRelationships;
  const graph = useMemo(
    () => {
      const built = buildSchemaGraph(snapshot, {
        query,
        focusNodeId,
        changeSet,
        beforeSnapshot,
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
      return onOpenQuery && !readOnlyPreview ? {
        ...built,
        nodes: built.nodes.map((node) => ({ ...node, data: { ...node.data,
          onOpenQuery: node.data.changeStatus === "deleted" ? undefined : () => onOpenQuery(node.data.inspectionTable ?? node.data.table),
        } })),
      } : built;
    },
    [beforeSnapshot, canvasSettings.edgeStyle, canvasSettings.fieldLevelEdges, canvasSettings.indexes, canvasSettings.maxInitialColumns, canvasSettings.relationshipHighlightDepth, canvasSettings.showCardinality, canvasSettings.showReferentialActions, canvasSettings.showRelationNames, canvasSettings.showTableComments, changeSet, colorBlindPalette, focusNodeId, highContrastRelations, onOpenQuery, query, readOnlyPreview, relationshipsEditable, savedView, semantics, showInferredRelationships, showInvalidRelationships, showLogicalRelationships, showPhysicalRelationships, snapshot],
  );
  const [nodes, setNodes] = useNodesState<TableNodeType>(graph.nodes);
  const latestNodes = useRef(nodes);
  const selectedNodeIds = useRef(new Set<string>());
  useLayoutEffect(() => {
    latestNodes.current = nodes;
    selectedNodeIds.current = new Set(nodes.filter((node) => node.selected).map((node) => node.id));
  }, [nodes]);
  const layoutReady = readyGraph === graph;
  const [edges, setEdges, onEdgesChange] = useEdgesState(graph.edges);
  const pendingGeometryCommit = useRef(false);
  const draggingRef = useRef(false);
  const lastAutoFitFingerprint = useRef<string | undefined>(undefined);
  const selectionScope = `${snapshot.sourceId}:${snapshot.id}:${changeSet?.id ?? "current"}`;
  const lastSelectionScope = useRef<string | undefined>(undefined);
  const temporaryReason = readOnlyPreview ? "Read-only DDL preview; no source workspace or database connection." : changeSet ? "Comparison diagram." : runtimeKind === "web" ? "Shared Web diagram."
    : savedView ? "Business domain / saved view." : query ? "Search results." : focusNodeId ? "Focused diagram." : undefined;
  const canvasInteraction = useMemo(() => ({ spacePanMode, layoutEditingDisabled: !layoutReady || (!temporaryReason && !layoutLoaded) }), [spacePanMode, layoutReady, temporaryReason, layoutLoaded]);
  const layoutScope = JSON.stringify([selectionScope, query, focusNodeId, savedView?.id, runtimeKind, layoutLoaded, readOnlyPreview]);
  const historyScope = JSON.stringify([layoutScope, graph.nodes.map((node) => node.id).sort()]);
  const layoutHistory = useRef(new DiagramLayoutHistory());
  const gesture = useRef<{ scope: string; before: LayoutFrame; label: string } | undefined>(undefined);
  const [historyActions, setHistoryActions] = useState<{ scope: string; undo?: string; redo?: string }>({ scope: historyScope });
  if (historyActions.scope !== historyScope) setHistoryActions({ scope: historyScope });
  useLayoutEffect(() => {
    layoutHistory.current.clear();
    gesture.current = undefined;
    pendingGeometryCommit.current = false;
    draggingRef.current = false;
  }, [historyScope]);
  const geometryGestureActive = nodes.some((node) => node.dragging || node.resizing);
  const layoutActionsDisabled = canvasInteraction.layoutEditingDisabled || geometryGestureActive;
  const currentLayoutScope = useRef(layoutScope);
  const previousLayoutScope = useRef<string | undefined>(undefined);
  const fullLayouts = useRef(new Map<string, ReturnType<typeof serializeCanvasLayout>>());
  const layoutRevision = useRef(0);
  const saveRevision = useRef(0);
  const saveQueue = useRef(Promise.resolve());
  const [layoutFeedback, setLayoutFeedback] = useState<{ scope: string; state: OperationFeedbackState; retry?: "save" | "auto" | "selected" | TableArrangement }>();
  useLayoutEffect(() => {
    currentLayoutScope.current = layoutScope;
    layoutRevision.current += 1;
    return () => { layoutRevision.current += 1; };
  }, [graph, layoutScope]);

  const saveLayout = useCallback((next: TableNodeType[]) => {
    if (temporaryReason || !layoutLoaded) return;
    // Only the complete current graph is allowed to replace the source's full layout.
    const ids = new Set(next.map((node) => node.id));
    if (next.length !== graph.nodes.length || !graph.nodes.every((node) => ids.has(node.id))) return;
    const positions = serializeCanvasLayout(next);
    fullLayouts.current.set(layoutFingerprint, positions);
    const revision = ++saveRevision.current;
    let cacheError: unknown;
    try { persistLayout(layoutFingerprint, next); } catch (reason) { cacheError = reason; }
    setLayoutFeedback({ scope: layoutScope, state: { phase: "running", summary: "Saving layout…" } });
    // Serialize writes so an older drag/resize cannot finish after a newer arrangement.
    const job = saveQueue.current.then(async () => {
      if (saveCurrentLayout) await saveCurrentLayout(positions);
      else if (cacheError) throw cacheError instanceof Error ? cacheError : new Error("Browser layout storage is unavailable.");
    });
    saveQueue.current = job.catch(() => {});
    void job.then(() => {
      if (currentLayoutScope.current === layoutScope && saveRevision.current === revision) {
        setLayoutFeedback({ scope: layoutScope, state: { phase: "success", summary: `${saveCurrentLayout ? "Layout saved on this device." : "Layout saved in this browser."} ${Object.keys(positions).length} tables.` } });
      }
    }, (reason: unknown) => {
      if (currentLayoutScope.current === layoutScope && saveRevision.current === revision) {
        setLayoutFeedback({ scope: layoutScope, state: { phase: "error", summary: "Layout save failed. Current positions remain visible.", details: reason instanceof Error ? reason.message : String(reason) }, retry: "save" });
      }
    });
  }, [graph.nodes, layoutFingerprint, layoutLoaded, layoutScope, saveCurrentLayout, temporaryReason]);

  const recordLayout = useCallback((before: LayoutFrame, next: TableNodeType[], label: string) => {
    layoutHistory.current.record(before, captureLayoutFrame(next), label);
    setHistoryActions({ scope: historyScope, undo: layoutHistory.current.undoLabel, redo: layoutHistory.current.redoLabel });
  }, [historyScope]);
  const beginGeometryGesture = (label: string) => {
    if (!gesture.current) gesture.current = { scope: historyScope, before: captureLayoutFrame(latestNodes.current), label };
    else if (label === "Resize table") gesture.current.label = label;
    layoutRevision.current += 1;
  };
  const restoreLayoutEdit = useCallback((direction: "undo" | "redo") => {
    if (layoutActionsDisabled || draggingRef.current || gesture.current) return false;
    const restored = layoutHistory.current[direction](getNodes());
    setHistoryActions({ scope: historyScope, undo: layoutHistory.current.undoLabel, redo: layoutHistory.current.redoLabel });
    if (!restored) return false;
    layoutRevision.current += 1;
    setNodes(restored.nodes);
    setEdges(orientFieldEdges(graph.edges, restored.nodes));
    // A disabled undo/redo button can drop focus to the page body. Keep subsequent
    // shortcuts in the diagram, without stealing focus from a selected node.
    if (document.activeElement?.tagName === "BUTTON" && flowRef.current?.parentElement?.contains(document.activeElement)) {
      flowRef.current.focus({ preventScroll: true });
    }
    if (temporaryReason) setLayoutFeedback({ scope: layoutScope, state: { phase: "success", summary: `${direction === "undo" ? "Undid" : "Redid"} ${restored.label} for this view only.` } });
    else saveLayout(restored.nodes);
    return true;
  }, [getNodes, graph.edges, historyScope, layoutActionsDisabled, layoutScope, saveLayout, setEdges, setNodes, temporaryReason]);
  useEffect(() => {
    const onLayoutHistoryKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.altKey || !(event.metaKey || event.ctrlKey)) return;
      const target = event.target;
      if (!(target instanceof HTMLElement) || target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="dialog"]')) return;
      // Leave other editors and inspectors' shortcuts alone. Diagram controls and nodes are in this main area.
      if (!flowRef.current?.parentElement?.contains(target)) return;
      const key = event.key.toLowerCase();
      const direction = key === "z" ? (event.shiftKey ? "redo" : "undo") : key === "y" && event.ctrlKey && !event.metaKey && !event.shiftKey ? "redo" : undefined;
      if (direction && restoreLayoutEdit(direction)) event.preventDefault();
    };
    window.addEventListener("keydown", onLayoutHistoryKey);
    return () => window.removeEventListener("keydown", onLayoutHistoryKey);
  }, [restoreLayoutEdit]);

  const selectedTableNodeId = selectedTable
    ? `${selectedTable.key.schema}.${selectedTable.key.name}`
    : undefined;
  const selectedEdge = edges.find((edge) => edge.id === selectedEdgeId);
  useLayoutEffect(() => {
    void viewportRevision;
    if (!selectedEdge || draggingRef.current) return;
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
  const displayedNodes = useMemo(() => {
    // Hoisted out of the map: this lookup does not vary per node.
    const sourceNode = activeRelationshipSource
      ? graph.nodes.find((candidate) => candidate.id === `${activeRelationshipSource.schema}.${activeRelationshipSource.table}`)
      : undefined;
    const sourceColumn = sourceNode?.data.table.columns.find((column) => column.name === activeRelationshipSource?.columns[0]);
    return nodes.map((node) => {
      const isSource = node.id === selectedEdge?.source;
      const isTarget = node.id === selectedEdge?.target;
      const relationshipConnectTargets = sourceColumn && activeRelationshipSource
        ? Object.fromEntries(node.data.table.columns.map((column) => {
            const sameField = node.data.schema === activeRelationshipSource.schema
              && node.data.table.key.name === activeRelationshipSource.table
              && column.name === activeRelationshipSource.columns[0];
            const compatible = column.typeName === sourceColumn.typeName && column.typeSchema === sourceColumn.typeSchema;
            return [column.name, sameField ? "invalid" : compatible ? "valid" : "warning"];
          })) as Record<string, "valid" | "warning" | "invalid">
        : undefined;
      const inspectorFocused = node.id === selectedTableNodeId;
      const relationshipHighlighted = selectedEdge ? isSource || isTarget : undefined;
      const relationshipColumn = selectedEdge
        ? isSource
          ? selectedEdge.data?.sourceColumn
          : isTarget
            ? selectedEdge.data?.targetColumn
            : undefined
        : undefined;
      // Reuse the existing object when nothing this memo derives has changed, so
      // dragging one table does not hand every other node a fresh `data` identity.
      if (
        node.data.inspectorFocused === inspectorFocused
        && node.data.relationshipHighlighted === relationshipHighlighted
        && node.data.relationshipColumn === relationshipColumn
        && node.data.relationshipConnectTargets === relationshipConnectTargets
      ) {
        return node;
      }
      return {
        ...node,
        data: {
          ...node.data,
          inspectorFocused,
          relationshipHighlighted,
          relationshipColumn,
          relationshipConnectTargets,
        },
      };
    });
  }, [activeRelationshipSource, graph.nodes, nodes, selectedEdge, selectedTableNodeId]);

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
      if (!relationshipsEditable || !selectedLogicalRelationship) return;
      event.preventDefault();
      deleteSelectedLogicalRelationship();
    };
    window.addEventListener("keydown", deleteSelectedRelationship);
    return () => window.removeEventListener("keydown", deleteSelectedRelationship);
  }, [deleteSelectedLogicalRelationship, relationshipsEditable, selectedLogicalRelationship]);

  useEffect(() => {
    let active = true;
    let firstFitFrame = 0;
    let secondFitFrame = 0;
    const shouldAutoFit = lastAutoFitFingerprint.current !== layoutFingerprint || previousLayoutScope.current !== layoutScope;
    const sameLayoutScope = previousLayoutScope.current === layoutScope;
    previousLayoutScope.current = layoutScope;
    const preserveSelection = lastSelectionScope.current === selectionScope;
    lastSelectionScope.current = selectionScope;
    const withSelection = (next: TableNodeType[]) => retainTableSelection(next, getNodes());
    const fitLayoutedGraph = () => {
      firstFitFrame = window.requestAnimationFrame(() => {
        secondFitFrame = window.requestAnimationFrame(() => {
          if (active) {
            setReadyGraph(graph);
            if (shouldAutoFit) {
              lastAutoFitFingerprint.current = layoutFingerprint;
              void fitView({ duration: 300, padding: 0.12, maxZoom: 1 });
            }
          }
        });
      });
    };
    const liveNodes = sameLayoutScope && !shouldAutoFit
      ? applyStoredPositions(graph.nodes, serializeCanvasLayout(getNodes()))
      : null;
    if (liveNodes) {
      setNodes(withSelection(liveNodes));
      setEdges(orientFieldEdges(graph.edges, liveNodes));
      fitLayoutedGraph();
      return () => {
        active = false;
        if (firstFitFrame) window.cancelAnimationFrame(firstFitFrame);
        if (secondFitFrame) window.cancelAnimationFrame(secondFitFrame);
      };
    }
    const saved = !temporaryReason
      ? (applyStoredPositions(graph.nodes, fullLayouts.current.get(layoutFingerprint)) ??
        applyStoredPositions(graph.nodes, semantics?.layout?.sourceId === snapshot.sourceId ? semantics.layout.positions : undefined) ?? restoreLayout(layoutFingerprint, graph.nodes))
      : null;
    // Even an incomplete layout can still supply valid fixed positions when
    // new tables appear. Temporary views inherit fixed cards, then edit locally.
    const fullFingerprint = `${JSON.stringify(snapshot.sourceId)}:${snapshot.fingerprint}`;
    const fullPositions = fullLayouts.current.get(fullFingerprint) ?? (semantics?.layout?.sourceId === snapshot.sourceId ? semantics.layout.positions : undefined);
    const positionedNodes = saved ?? graph.nodes.map((node) => {
      const stored = applyStoredPositions([node], fullPositions) ?? (!readOnlyPreview && runtimeKind !== "web" ? restoreLayout(fullFingerprint, [node]) : null);
      return stored?.[0].data.layoutPinned ? stored[0] : node;
    });
    setNodes(preserveSelection ? withSelection(positionedNodes) : retainTableSelection(positionedNodes, []));
    setEdges(orientFieldEdges(graph.edges, positionedNodes));
    if (saved) {
      fitLayoutedGraph();
    } else {
      void layoutSchemaGraph(positionedNodes, graph.edges, { direction: canvasSettings.layoutDirection, nodeSpacing: canvasSettings.nodeSpacing, layerSpacing: canvasSettings.layerSpacing, edgeSpacing: canvasSettings.edgeSpacing, timeoutMs: layoutWorkerTimeoutMs })
        .then((layoutedNodes) => {
          if (active) {
            setNodes(withSelection(layoutedNodes));
            setEdges(orientFieldEdges(graph.edges, layoutedNodes));
            saveLayout(layoutedNodes);
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
  }, [canvasSettings.edgeSpacing, canvasSettings.layerSpacing, canvasSettings.layoutDirection, canvasSettings.nodeSpacing, fitView, getNodes, graph, layoutWorkerTimeoutMs, semantics?.layout?.positions, semantics?.layout?.sourceId, snapshot.sourceId, snapshot.fingerprint, setEdges, setNodes, layoutFingerprint, selectionScope, layoutScope, temporaryReason, saveLayout, runtimeKind, readOnlyPreview]);

  useEffect(() => {
    if (!pendingGeometryCommit.current) return;
    pendingGeometryCommit.current = false;
    const edit = gesture.current;
    gesture.current = undefined;
    if (edit?.scope !== historyScope) return;
    recordLayout(edit.before, nodes, edit.label);
    setEdges(orientFieldEdges(graph.edges, nodes));
    saveLayout(nodes);
  }, [graph.edges, historyScope, nodes, recordLayout, saveLayout, setEdges]);

  const autoLayoutTables = useCallback((selectedOnly: boolean) => {
    if (layoutActionsDisabled || draggingRef.current || gesture.current) return;
    const current = getNodes();
    if (!current.some((node) => !node.data.layoutPinned && (!selectedOnly || node.selected))) return;
    const revision = ++layoutRevision.current;
    const before = captureLayoutFrame(current);
    const label = selectedOnly ? "Auto layout selected" : "Auto layout";
    setLayoutFeedback({ scope: layoutScope, state: { phase: "running", summary: `${label}…` } });
    const runLayout = selectedOnly ? layoutSelectedSchemaGraph : layoutSchemaGraph;
    void runLayout(current, graph.edges, { direction: canvasSettings.layoutDirection, nodeSpacing: canvasSettings.nodeSpacing, layerSpacing: canvasSettings.layerSpacing, edgeSpacing: canvasSettings.edgeSpacing, timeoutMs: layoutWorkerTimeoutMs }).then((layoutedNodes) => {
      if (currentLayoutScope.current !== layoutScope || revision !== layoutRevision.current) return;
      // Selection may change while the worker is busy; retain current UI state.
      const positions = new Map(layoutedNodes.map((node) => [node.id, node.position]));
      const next = getNodes().map((node) => ({ ...node, position: positions.get(node.id) ?? node.position }));
      recordLayout(before, next, label);
      setNodes(next);
      setEdges(orientFieldEdges(graph.edges, next));
      if (temporaryReason) setLayoutFeedback({ scope: layoutScope, state: { phase: "success", summary: `${label} applied for this view only. ${selectedOnly ? current.filter((node) => node.selected && !node.data.layoutPinned).length : current.filter((node) => !node.data.layoutPinned).length} tables arranged.` } });
      else saveLayout(next);
      if (!selectedOnly) window.requestAnimationFrame(() => {
        if (currentLayoutScope.current === layoutScope && revision === layoutRevision.current) void fitView({ duration: 300, padding: 0.12, maxZoom: 1 });
      });
    }).catch((reason: unknown) => {
      if (currentLayoutScope.current === layoutScope && revision === layoutRevision.current) setLayoutFeedback({ scope: layoutScope, state: { phase: "error", summary: `${label} failed. Current positions remain visible.`, details: reason instanceof Error ? reason.message : String(reason) }, retry: selectedOnly ? "selected" : "auto" });
    });
  }, [canvasSettings, fitView, getNodes, graph.edges, layoutActionsDisabled, layoutScope, layoutWorkerTimeoutMs, recordLayout, saveLayout, setEdges, setNodes, temporaryReason]);

  useEffect(() => {
    function fitCanvas() {
      void fitView({ duration: 250, padding: 0.12 });
    }
    function relayoutCanvas() { autoLayoutTables(false); }
    function focusSelectedTable() {
      if (selectedTable) setFocusNodeId(`${selectedTable.key.schema}.${selectedTable.key.name}`);
    }
    function viewAllTables() {
      setSelectedEdgeId(undefined);
      setNodes((current) => current.map((node) => node.selected ? { ...node, selected: false } : node));
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
  }, [autoLayoutTables, fitView, focusNodeId, nodes, onSelectTable, selectedTable, setNodes]);

  const finishNodeDrag = useCallback(() => {
    draggingRef.current = false;
    // React Flow can still expose the previous dragging flag in its stop callback.
    const movedNodes = getNodes().map((node) => node.dragging ? { ...node, dragging: false } : node);
    setNodes(movedNodes);
    setEdges(orientFieldEdges(graph.edges, movedNodes));
    layoutRevision.current += 1;
    const edit = gesture.current;
    gesture.current = undefined;
    pendingGeometryCommit.current = false;
    if (edit?.scope === historyScope) recordLayout(edit.before, movedNodes, edit.label);
    saveLayout(movedNodes);
  }, [getNodes, graph.edges, historyScope, recordLayout, saveLayout, setEdges, setNodes]);
  const arrangeSelectedTables = (action: TableArrangement) => {
    if (layoutActionsDisabled || draggingRef.current || gesture.current) return;
    try {
      const current = getNodes();
      const arranged = arrangeTables(current, action);
      if (arranged === current) return;
      layoutRevision.current += 1;
      recordLayout(captureLayoutFrame(current), arranged, tableArrangementLabels[action]);
      setNodes(arranged);
      setEdges(orientFieldEdges(graph.edges, arranged));
      if (temporaryReason) setLayoutFeedback({ scope: layoutScope, state: { phase: "success", summary: "Layout adjusted for this view only." } });
      else saveLayout(arranged);
    } catch (reason) {
      saveRevision.current += 1;
      setLayoutFeedback({ scope: layoutScope, state: { phase: "error", summary: "Unable to arrange tables.", details: reason instanceof Error ? reason.message : String(reason) }, retry: action });
    }
  };
  const fixSelectedTables = (pinned: boolean) => {
    if (layoutActionsDisabled || draggingRef.current || gesture.current) return;
    const current = getNodes();
    const next = pinSelectedTables(current, pinned);
    if (next.every((node, index) => node === current[index])) return;
    layoutRevision.current += 1;
    recordLayout(captureLayoutFrame(current), next, pinned ? "Fix table positions" : "Unlock table positions");
    // Fix/unlock disables the button just used; keep layout shortcuts available.
    if (document.activeElement?.tagName === "BUTTON" && flowRef.current?.parentElement?.contains(document.activeElement)) flowRef.current.focus({ preventScroll: true });
    setNodes(next);
    if (temporaryReason) setLayoutFeedback({ scope: layoutScope, state: { phase: "success", summary: "Fixed states adjusted for this view only." } });
    else saveLayout(next);
  };
  const visibleNodeIds = new Set(graph.nodes.map((node) => node.id));
  const selectedNodes = nodes.filter((node) => node.selected && visibleNodeIds.has(node.id));
  const selectedTableKeys = selectedCurrentTableKeys(selectedNodes, snapshot);

  return (
    <>
      <CanvasInteractionProvider value={canvasInteraction}>
      <ReactFlow<TableNodeType, FieldEdge>
        ref={flowRef}
        tabIndex={0}
        className={[
          "schema-canvas-flow",
          nodes.length >= Math.min(canvasSettings.largeModelThreshold, renderDegradeThreshold) ? "large-model-mode" : "",
          spacePanMode ? "space-pan-mode" : "",
          activeRelationshipSource || relationshipRebindSourceSelection ? "relationship-picking-mode" : "",
        ].filter(Boolean).join(" ")}
        nodes={displayedNodes}
        edges={displayedEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={(incoming: NodeChange<TableNodeType>[]) => {
          const fixed = new Set(latestNodes.current.filter((node) => node.data.layoutPinned).map((node) => node.id));
          const changes = incoming.filter((change) => !("id" in change && fixed.has(change.id) && (change.type === "position" || (change.type === "dimensions" && change.resizing !== undefined))));
          const resize = changes.some((change) => change.type === "dimensions" && change.resizing !== undefined);
          const move = changes.some((change) => change.type === "position" && change.position);
          if (resize || move) beginGeometryGesture(resize ? "Resize table" : "Move tables");
          if (changes.some((change) => (change.type === "dimensions" && change.resizing === false) || (!resize && gesture.current?.label !== "Resize table" && !draggingRef.current && change.type === "position" && change.position && change.dragging !== true))) pendingGeometryCommit.current = true;
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
        nodesDraggable={!spacePanMode && !canvasInteraction.layoutEditingDisabled}
        elementsSelectable={!spacePanMode && !activeRelationshipSource && !relationshipRebindSourceSelection}
        selectionKeyCode="Shift"
        multiSelectionKeyCode={multiSelectionKeys}
        selectionMode={SelectionMode.Partial}
        selectionOnDrag={boxSelectMode && !spacePanMode && !activeRelationshipSource && !relationshipRebindSourceSelection}
        deleteKeyCode={null}
        selectNodesOnDrag={false}
        nodeDragThreshold={6}
        nodeClickDistance={6}
        paneClickDistance={6}
        panOnDrag={boxSelectMode ? [1, 2] : true}
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
          if (!relationshipsEditable || edge.data?.relationshipKind !== "logical") return;
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
            const additive = event.shiftKey || event.metaKey || event.ctrlKey;
            const nextSelection = additive ? new Set(selectedNodeIds.current) : new Set<string>();
            if (additive && nextSelection.has(node.id)) nextSelection.delete(node.id);
            else nextSelection.add(node.id);
            selectedNodeIds.current = nextSelection;
            setNodes((current) => current.map((candidate) => ({ ...candidate, selected: nextSelection.has(candidate.id) })));
            onSelectTable(node.data.inspectionTable ?? node.data.table);
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
          onSelectTable(node.data.inspectionTable ?? node.data.table);
          setFocusNodeId((current) => current === node.id ? undefined : node.id);
        }}
        onPaneClick={() => {
          setNodes((current) => current.map((node) => node.selected ? { ...node, selected: false } : node));
          setSelectedEdgeId(undefined);
          setRelationshipPickSource(undefined);
          setRelationshipPickExisting(undefined);
          setRelationshipRebindSourceSelection(undefined);
          setColumnContextMenu(undefined);
          onSelectTable(undefined);
        }}
        onNodeDragStart={() => {
          beginGeometryGesture("Move tables");
          draggingRef.current = true;
        }}
        onNodeDragStop={finishNodeDrag}
        onSelectionDragStart={() => { beginGeometryGesture("Move tables"); draggingRef.current = true; }}
        onSelectionDragStop={finishNodeDrag}
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
      {nodes.length ? <DiagramSelectionActions key={selectionScope} snapshot={snapshot} selectedCount={selectedNodes.length} selectedTableKeys={selectedTableKeys}
        domainGroups={semantics?.domainGroups ?? emptyDomainGroups} disabled={!layoutReady}
        readOnlyReason={readOnlyPreview ? "DDL previews cannot edit business semantics or become database sources." : changeSet ? "Comparison diagrams are read only. Open Database to edit business domains." : runtimeKind === "web" ? "Shared diagrams are read only." : undefined}
        onAddTablesToDomain={readOnlyPreview || changeSet || runtimeKind === "web" ? undefined : onAddTablesToDomain}
        layoutActions={<DiagramLayoutActions selectedCount={selectedNodes.length}
          pinnedCount={selectedNodes.filter((node) => node.data.layoutPinned).length} movableCount={selectedNodes.filter((node) => !node.data.layoutPinned).length}
          onPin={() => fixSelectedTables(true)} onUnpin={() => fixSelectedTables(false)} onAutoLayoutSelected={() => autoLayoutTables(true)} disabled={layoutActionsDisabled} waitingForLayout={!temporaryReason && !layoutLoaded}
          undoLabel={historyActions.scope === historyScope ? historyActions.undo : undefined} redoLabel={historyActions.scope === historyScope ? historyActions.redo : undefined}
          onUndo={() => restoreLayoutEdit("undo")} onRedo={() => restoreLayoutEdit("redo")}
          temporaryReason={temporaryReason} feedback={layoutFeedback?.scope === layoutScope ? layoutFeedback.state : undefined}
          onArrange={arrangeSelectedTables} retryLabel={layoutFeedback?.retry === "save" ? "Retry layout save" : "Retry arrangement"}
          onRetry={layoutFeedback?.scope === layoutScope && layoutFeedback.retry ? () => {
            if (layoutFeedback.retry === "save") saveLayout(getNodes());
            else if (layoutFeedback.retry === "auto" || layoutFeedback.retry === "selected") autoLayoutTables(layoutFeedback.retry === "selected");
            else if (layoutFeedback.retry) arrangeSelectedTables(layoutFeedback.retry);
          } : undefined} />}
        boxSelectionActive={boxSelectMode} onToggleBoxSelection={() => setBoxSelectMode((value) => !value)}
        onClear={() => setNodes((current) => current.map((node) => node.selected ? { ...node, selected: false } : node))} /> : null}
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
          readOnly={!relationshipsEditable}
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
        <span>{nodes.length} tables{changeSet ? beforeSnapshot ? " · Before + After" : " · After" : ""}</span>
        <button type="button" className="relationship-filter relationship-filter-physical" data-active={showPhysicalRelationships || undefined} onClick={() => setPhysicalRelationshipOverride(!showPhysicalRelationships)}>{showPhysicalRelationships ? "✓" : ""} {graph.physicalRelationshipCount} {readOnlyPreview ? "declared FKs" : "physical"}{changeSet ? " versions" : ""}</button>
        <button type="button" className="relationship-filter relationship-filter-logical" data-active={showLogicalRelationships || undefined} onClick={() => setShowLogicalRelationships((value) => !value)}>{showLogicalRelationships ? "✓" : ""} {graph.logicalRelationshipCount} logical</button>
        <button type="button" onClick={() => window.dispatchEvent(new Event("nodalstudio:view-all-tables"))} title="Exit table focus and fit every table into the viewport">View all</button>
        <button type="button" disabled={layoutActionsDisabled || nodes.every((node) => node.data.layoutPinned)} onClick={() => autoLayoutTables(false)} title="Arrange movable tables into compact groups; fixed tables stay in place">Auto layout</button>
        {relationshipsEditable ? <button type="button" onClick={() => setRelationshipManagerOpen(true)}>Manage relationships</button> : null}
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
      {!readOnlyPreview ? <DiagramExportActions scope={layoutScope}
        platform={platform}
        disabled={!layoutReady || !nodes.length}
        fileName={(format) => diagramFileName(snapshot.database.name, snapshot.fingerprint, format)}
        capture={() => {
          if (!flowRef.current) throw new Error("The diagram is no longer open.");
          return captureDiagramSvg({ root: flowRef.current, viewport: getViewport(), snapshot, changeSet, beforeSnapshot, colorBlindPalette,
            scope: [savedView?.name, query ? `Filtered by “${query}”` : "", focusNodeId ? `Focus: ${focusNodeId}` : ""].filter(Boolean).join(" · ") || "All tables" });
        }}
      /> : null}
    </>
  );
}
