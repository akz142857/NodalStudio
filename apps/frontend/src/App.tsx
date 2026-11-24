import { ChangeReviewWorkspace } from "./components/change-review/ChangeReviewWorkspace";
import { OntologyWorkspace } from "./components/ontology/OntologyWorkspace";
import { useOntologyDefinitions } from "./components/ontology/use-ontology-definitions";
import { findDocumentObject } from "./components/object-document-model";
import { ObjectDocument, ObjectDocumentProperties } from "./components/ObjectDocument";
import { capabilityMessages } from "./i18n/capabilities";
import { I18nProvider, useI18n, useEventTranslator } from "./i18n";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ModelViewNavigation } from "./components/ModelViewNavigation";
import { ConnectionPanel } from "./components/ConnectionPanel";
import { InspectorPanel } from "./components/InspectorPanel";
import { BusinessExplorer } from "./components/BusinessExplorer";
import { Segmented } from "./components/Segmented";
import { SchemaPreflightPanel } from "./components/SchemaPreflightPanel";
import { OperationFeedback } from "./components/OperationFeedback";
import { ActionIcon } from "./components/ActionIcon";
import { IconButton } from "./components/IconButton";
import { useOperation } from "./components/use-operation";
import { currentCapabilityTarget, resolveCapability } from "./platform/capabilities";
import { SchemaCanvas, type CanvasLocateRequest } from "./components/SchemaCanvas";
import { ChangesEmptyState } from "./components/ChangesEmptyState";
import { SchemaChangesPanel } from "./components/SchemaChangesPanel";
import { SchemaChangesDiagram } from "./components/SchemaChangesDiagram";
import { SchemaTree } from "./components/SchemaTree";
import { SqliteTableWorkspace } from "./components/SqliteTableWorkspace";
import { useTableRowCounts } from "./components/use-table-row-counts";
import { DEFAULT_ROW_PANEL_WIDTH, clearTableDataPreferences, readRowPanelWidth, saveRowPanelWidth } from "./platform/table-data-preferences";
import { TableDataPreview } from "./components/TableDataPreview";
import { TableDdlDialog } from "./components/TableDdlDialog";
import { EmptyState } from "./design-system/EmptyState";
import { DatabaseExportDialog, type DatabaseExportTarget } from "./components/DatabaseExportDialog";
import { SchemaReportExportAction } from "./components/SchemaReportExportAction";
import { HeaderSidebarToggle, SidebarRail } from "./components/SidebarRail";
import { useSystemAccent } from "./design-system/system-accent";
import type { SettingsCategory } from "./components/SettingsPage";
import { CommandPalette, type AppCommand } from "./components/CommandPalette";
import { formatCommandShortcut, usesAppleKeyboard, WORKSPACE_SHORTCUTS } from "./components/command-shortcuts";
import type { QueryDraftSeed } from "./components/query/QueryDraftPanel";
import type { OpenQueryRequest } from "./components/query/QueryPage";
import { QuickQueryDock } from "./components/query/QuickQueryDock";
import { tablePreviewSql } from "./components/query/query-format";
import { clearQuerySessions } from "./components/query/query-state";
import { clearSavedQueries, deleteNamedQuery, listSavedQueries, saveNamedQuery, type SavedQuery } from "./components/query/saved-queries";
import { searchSchema, type SchemaSearchResult } from "./graph/schema-search";
import { domainMembershipAddition } from "./graph/table-selection";
import { collectModelTableChanges, modelTableKey } from "./graph/model-table-changes";
import { getPlatform } from "./platform";
import { schemaDdlTarget, schemaDdlTargetKey, type SchemaDdlTarget } from "./platform/schema-ddl";
import { sqliteTableSourceKey, type SqliteTableTarget } from "./platform/sqlite-table";
import { ontologyDefinitionsKey, requiresNewerMySqlForOntology } from "./platform/ontology-types";
import type {
  AppSettings,
  CaptureSnapshotResult,
  DataSourceProfile,
  DataSourceSettings,
  DatabaseSnapshot,
  EffectiveSettings,
  QueryExecutionResult,
  SavedView,
  SchemaChangeSet,
  SemanticBundle,
  SaveAnnotationInput,
  SaveLogicalRelationshipInput,
  TableDefinition,
  ObjectKey,
} from "./platform";
import { defaultEffectiveSettings } from "./platform";
import { migrateLegacySettings } from "./settings-migration";
import { useAvailableUpdate } from "./components/settings/use-available-update";
import { UpdateBanner } from "./components/settings/UpdateBanner";

const platform = getPlatform();
const SettingsPage = lazy(() => import("./components/SettingsPage").then((module) => ({ default: module.SettingsPage })));
const QueryPage = lazy(() => import("./components/query/QueryPage").then((module) => ({ default: module.QueryPage })));
const DdlImportPanel = lazy(() => import("./components/DdlImportPanel").then((module) => ({ default: module.DdlImportPanel })));

type ViewMode = "explore" | "ontology" | "database" | "query" | "changes";
type OpenSqliteTable = { target: SqliteTableTarget; binding: string; key: string; retain?: boolean };
type AppNotice = { id: string; title: string; message: string; createdAt: string; settingsCategory?: SettingsCategory };

function noticeReason(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

type PanelPreference = {
  expanded: boolean;
  width: number;
};

const LEFT_PANEL_DEFAULT: PanelPreference = { expanded: true, width: 272 };
const RIGHT_PANEL_DEFAULT: PanelPreference = { expanded: false, width: 300 };
const LEFT_PANEL_LIMITS = { min: 220, max: 480 };
const RIGHT_PANEL_LIMITS = { min: 240, max: 520 };

const emptySemantics: SemanticBundle = {
  annotations: [],
  orphanedAnnotations: [],
  domainGroups: [],
  savedViews: [],
  layout: null,
  logicalRelationships: [],
  ignoredRelationshipInferences: [],
};

export function App() {
  useSystemAccent();
  const queryClient = useQueryClient();
  const [snapshot, setSnapshot] = useState<DatabaseSnapshot>();
  const [historyPreview, setHistoryPreview] = useState(false);
  const latestWorkspace = useRef<{ snapshot: DatabaseSnapshot; view?: SavedView } | undefined>(undefined);
  const [changeSet, setChangeSet] = useState<SchemaChangeSet>();
  const [mode, setMode] = useState<ViewMode>("explore");
  const viewMode = mode === "changes" ? "explore" : mode;
  const [preflightOpen, restorePreflightOpen] = useState(false);
  const [preflightMounted, setPreflightMounted] = useState(false);
  const [preflightDetailsExpanded, setPreflightDetailsExpanded] = useState(true);
  const [preflightDetailHost, setPreflightDetailHost] = useState<HTMLDivElement | null>(null);
  const setPreflightOpen = useCallback((open: boolean) => { if (open) { setPreflightMounted(true); setMode("explore"); } restorePreflightOpen(open); }, []);
  const [ddlPreviewOpen, setDdlActive] = useState(false);
  const [ddlMounted, setDdlMounted] = useState(false);
  const ddlTrigger = useRef<HTMLElement | null>(null);
  const setDdlPreviewOpen = (open: boolean, trigger = document.activeElement) => {
    if (open) { ddlTrigger.current = trigger instanceof HTMLElement ? trigger : null; setDdlMounted(true); }
    setDdlActive(open);
    if (!open) requestAnimationFrame(() => { if (ddlTrigger.current?.isConnected) ddlTrigger.current.focus(); });
  };
  const ddlHost = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ddlMounted) return;
    const topbar = document.querySelector<HTMLElement>(".app-shell > .topbar");
    if (!topbar || typeof ResizeObserver === "undefined") return;
    const update = () => ddlHost.current?.style.setProperty("--ddl-workspace-top", `${topbar.offsetTop + topbar.offsetHeight}px`);
    const observer = new ResizeObserver(update); observer.observe(topbar); update();
    return () => observer.disconnect();
  }, [ddlMounted]);
  const [reviewView, setReviewView] = useState<"review" | "history">("review");
  const [reviewRefresh, setReviewRefresh] = useState(0);
  const [ontologySelection, setOntologySelection] = useState<{ sourceId: string; id: string }>();
  const [ontologyReviewSelection, setOntologyReviewSelection] = useState<{ sourceId: string; id: string }>();
  const [changesView, setChangesView] = useState<"list" | "diagram">("list");
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [relationshipSearch, setRelationshipSearch] = useState<{ snapshot: DatabaseSnapshot; mode: ViewMode; table: TableDefinition; question: string }>();
  const [explainRequest, setExplainRequest] = useState(0);
  const [activeSearchResult, setActiveSearchResult] = useState(0);
  const [objectDocument, setObjectDocument] = useState<{ snapshot: DatabaseSnapshot; key: ObjectKey }>();
  const [databaseObjectSelection, setDatabaseObjectSelection] = useState<{ sourceId: string; key: ObjectKey; definition: boolean }>();
  const [selectedTable, setSelectedTable] = useState<TableDefinition>();
  const [columnFocus, setColumnFocus] = useState<{ snapshot: DatabaseSnapshot | undefined; table: TableDefinition; name: string }>();
  const [semanticsSettledSnapshot, setSemanticsSettledSnapshot] = useState<DatabaseSnapshot>();
  const [locateRequest, setLocateRequest] = useState<CanvasLocateRequest>();
  const locateRevision = useRef(0);
  const finishLocate = useCallback((request: CanvasLocateRequest) => setLocateRequest((current) => current === request ? undefined : current), []);
  const [semantics, setSemantics] = useState<SemanticBundle>(emptySemantics);
  const [semanticsSnapshot, setSemanticsSnapshot] = useState<DatabaseSnapshot>();
  // Every entry point shares one source/snapshot session and response sequence.
  // A -> B -> A is a new session even when the same snapshot object is reused.
  const semanticSession = useMemo(() => ({ snapshot }), [snapshot]);
  const activeSemanticSession = useRef<typeof semanticSession | undefined>(semanticSession);
  const semanticRequest = useRef(0);
  useLayoutEffect(() => {
    activeSemanticSession.current = semanticSession;
    return () => { activeSemanticSession.current = undefined; };
  }, [semanticSession]);
  const changeSemantics = useCallback((bundle: SemanticBundle) => {
    if (activeSemanticSession.current === semanticSession) {
      setSemantics((current) => ({ ...current, domainGroups: bundle.domainGroups, savedViews: bundle.savedViews }));
    }
  }, [semanticSession]);
  const [savedView, setSavedView] = useState<SavedView>();
  const applyView = useCallback((view: SavedView | undefined) => {
    if (activeSemanticSession.current !== semanticSession || (view && view.sourceId !== snapshot?.sourceId)) return;
    setSavedView(view); setQuery(""); setLocateRequest(undefined);
    if (snapshot) { try { if (view && !view.id.startsWith("domain:")) localStorage.setItem(`nodalstudio:last-view:${snapshot.sourceId}`, view.id); else localStorage.removeItem(`nodalstudio:last-view:${snapshot.sourceId}`); } catch { /* Optional navigation preference; layout persistence is authoritative. */ } }
  }, [semanticSession, snapshot]);
  const refreshOperation = useOperation(snapshot?.sourceId ?? "no-source");
  const runRefresh = refreshOperation.run;
  const refreshState = refreshOperation.busy ? "refreshing" : refreshOperation.state?.phase === "error" ? "error" : "idle";
  const [leftPanel, setLeftPanel] = useState(LEFT_PANEL_DEFAULT);
  const [rightPanel, restoreRightPanel] = useState(RIGHT_PANEL_DEFAULT);
  const rightPanelInteracted = useRef(false);
  const setRightPanel = useCallback((update: PanelPreference | ((current: PanelPreference) => PanelPreference)) => {
    rightPanelInteracted.current = true;
    restoreRightPanel(update);
  }, []);
  const [modelChangeRequest, setModelChangeRequest] = useState(0);
  const [settings, setSettings] = useState<EffectiveSettings>(() => defaultEffectiveSettings());
  const i18n = useI18n(settings.app.general.language);
  const { t } = i18n;
  const translate = useEventTranslator(t);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [settingsAvailable, setSettingsAvailable] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsCategory, setSettingsCategory] = useState<SettingsCategory>("general");
  const [dataSources, setDataSources] = useState<DataSourceProfile[]>([]);
  const [sourcesRevision, setSourcesRevision] = useState(0);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [savedNotices, setNotices] = useState<AppNotice[]>([]);
  const [noticesOpen, setNoticesOpen] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const commandPaletteTrigger = useRef<Element | null>(null);
  const openCommandPalette = useCallback(() => {
    commandPaletteTrigger.current = document.activeElement;
    setSearchOpen(false);
    setToolsOpen(false);
    setNoticesOpen(false);
    setCommandPaletteOpen(true);
  }, []);
  const workspaceTools = useRef<HTMLDivElement>(null);
  const workspaceToolsId = useId();
  const searchListId = useId();
  const [queryDraftSeed, setQueryDraftSeed] = useState<QueryDraftSeed>();
  const [openQueryRequest, setOpenQueryRequest] = useState<OpenQueryRequest>();
  const [savedQueryCatalog, setSavedQueryCatalog] = useState<{ sourceId: string; queries: SavedQuery[] }>();
  const [quickQueryView, setQuickQueryView] = useState<{ scope?: string; result?: { result: QueryExecutionResult; sql: string }; reset: number }>({ reset: 0 });
  const [sqliteEditors, setSqliteEditors] = useState<OpenSqliteTable[]>([]);
  const retainSqliteEditor = useCallback((target: SqliteTableTarget, binding: string, retain: boolean) => {
    const key = JSON.stringify([target.sourceId, binding, target.table]);
    setSqliteEditors((current) => {
      const entry = current.find((editor) => editor.key === key);
      if (!entry || Boolean(entry.retain) === retain) return current;
      return current.map((editor) => editor === entry ? { ...editor, retain } : editor);
    });
  }, []);
  const [rowPanelWidth, setRowPanelWidth] = useState(readRowPanelWidth);
  const resizeRowPanel = useCallback((width: number) => {
    setRowPanelWidth(width);
    saveRowPanelWidth(width);
  }, []);
  const [databaseExport, setDatabaseExport] = useState<{ snapshot: DatabaseSnapshot; target: DatabaseExportTarget }>();
  const [showTableDdl, setShowTableDdl] = useState<string>();
  const searchInputRef = useRef<HTMLInputElement>(null);
  const autoConnectAttempted = useRef(false);
  const startupRevision = useRef(0);
  const beginSourceOpen = useCallback(() => { startupRevision.current += 1; }, []);
  useEffect(() => () => { startupRevision.current += 1; }, []);
  const [dismissedUpdate, setDismissedUpdate] = useState<string>();
  const notifiedUpdate = useRef<string | undefined>(undefined);
  const runtime = useQuery({
    queryKey: ["runtime-info"],
    queryFn: () => platform.getRuntimeInfo(),
  });
  const connectionFolder = useQuery({
    queryKey: ["connection-folder-status"],
    queryFn: () => platform.getConnectionFolderStatus(),
    enabled: runtime.data?.kind === "desktop",
    refetchInterval: 5_000,
    retry: false,
  });
  const notifiedConnectionFolder = useRef<string | null>(null);
  const notices = connectionFolder.data?.pendingId
    ? savedNotices
    : savedNotices.filter(({ id }) => id !== "connection-folder-update");
  const availableUpdate = useAvailableUpdate(platform,
    settingsAvailable && runtime.data?.kind === "desktop" && runtime.data.distribution !== "macAppStore" && settings.app.updates.automaticChecks && !settings.app.privacy.offlineMode,
    settings.app.updates);
  const updateNotificationsEnabled = settings.app.notifications.updateAvailable && !isQuietHours(settings.app.notifications);
  const showUpdateBanner = Boolean(availableUpdate && updateNotificationsEnabled && dismissedUpdate !== availableUpdate);
  const discoveryLatest = useQuery({
    queryKey: ["discovery-latest-snapshot", snapshot?.sourceId, snapshot?.id],
    queryFn: () => platform.listSnapshots(snapshot!.sourceId),
    enabled: runtime.data?.kind === "desktop" && !!snapshot,
  });
  const capturedModelChanges = !historyPreview && snapshot && changeSet?.afterSnapshotId === snapshot.id ? changeSet : undefined;
  const previousModelSnapshot = snapshot && discoveryLatest.data?.[0]?.id === snapshot.id ? discoveryLatest.data[1] : undefined;
  const storedModelChanges = useQuery({
    queryKey: ["model-table-changes", snapshot?.sourceId, previousModelSnapshot?.id, snapshot?.id],
    queryFn: () => platform.compareSnapshots(previousModelSnapshot!.id, snapshot!.id),
    enabled: mode === "explore" && !historyPreview && !capturedModelChanges && Boolean(previousModelSnapshot),
    networkMode: "always",
    refetchOnWindowFocus: false,
    staleTime: Infinity,
    retry: false,
  });
  const modelChangeSet = mode === "explore" && !historyPreview ? capturedModelChanges ?? storedModelChanges.data : undefined;
  const modelTableChanges = useMemo(() => snapshot && modelChangeSet
    ? collectModelTableChanges(snapshot, modelChangeSet) : undefined, [modelChangeSet, snapshot]);
  useEffect(() => {
    const openReview = () => { setOntologyReviewSelection(undefined); setReviewView("review"); setMode("changes"); setPreflightOpen(false); setRelationshipSearch(undefined); };
    window.addEventListener("nodalstudio:change-review", openReview);
    return () => window.removeEventListener("nodalstudio:change-review", openReview);
  }, [setPreflightOpen]);
  const queryCapability = resolveCapability("read-only-query", runtime.data?.kind, snapshot?.database.databaseType);
  const queryTarget = currentCapabilityTarget(runtime.data?.kind, snapshot?.database.databaseType);
  const queryScope = queryTarget ? t(capabilityMessages["read-only-query"].targets[queryTarget]) : t("navigation.query.unknown");
  const querySupported = Boolean(snapshot) && queryCapability.status === "supported";
  const sourceId = snapshot?.sourceId;
  const savedQueries = useMemo(() => sourceId
    ? (savedQueryCatalog?.sourceId === sourceId ? savedQueryCatalog.queries : listSavedQueries(sourceId)) : [], [savedQueryCatalog, sourceId]);
  const databaseObject = useMemo(() => databaseObjectSelection && databaseObjectSelection.sourceId === snapshot?.sourceId
    ? findDocumentObject(snapshot, databaseObjectSelection.key) : undefined, [databaseObjectSelection, snapshot]);
  const activeProfile = dataSources.find((source) => source.id === snapshot?.sourceId);
  const countProfile = activeProfile && querySupported && !historyPreview && activeProfile.databaseType === snapshot?.database.databaseType
    && (activeProfile.databaseType === "sqlite" ||
      (settingsAvailable && !settings.app.privacy.offlineMode && activeProfile.database === snapshot.database.name))
    ? activeProfile : undefined;
  const tableRowCounts = useTableRowCounts(platform, countProfile, leftPanel.expanded);
  const sqliteBinding = activeProfile?.sqlite?.path;
  const ddlTarget = useMemo(() => {
    if (runtime.data?.kind !== "desktop" || historyPreview || !snapshot || !activeProfile
      || activeProfile.databaseType !== snapshot.database.databaseType
      || (activeProfile.databaseType !== "sqlite" && activeProfile.database !== snapshot.database.name)) return undefined;
    return schemaDdlTarget(activeProfile);
  }, [runtime.data?.kind, historyPreview, snapshot, activeProfile]);
  const liveSqlite = !historyPreview && Boolean(sqliteBinding)
    && resolveCapability("table-data-edit", runtime.data?.kind, snapshot?.database.databaseType).status === "supported";
  const currentTable = snapshot && selectedTable
    ? snapshot.schemas.find((schema) => schema.name === selectedTable.key.schema)?.tables.find((table) => table.key.name === selectedTable.key.name)
    : undefined;
  const browsableTable = querySupported && !historyPreview ? currentTable : undefined;
  const browsableView = querySupported && !historyPreview && databaseObject && "materialized" in databaseObject && !databaseObjectSelection?.definition
    ? databaseObject : undefined;
  const databaseDocument = browsableView ? undefined : databaseObject;
  const previewRelation = browsableView ?? browsableTable;
  const quickQueryRelation = mode === "database" && !databaseDocument ? previewRelation : undefined;
  const quickQueryScope = quickQueryRelation && JSON.stringify([sourceId, activeProfile?.updatedAt, quickQueryRelation.key]);
  const tableDdlScope = mode === "database" && !databaseObject && browsableTable && countProfile ? quickQueryScope : undefined;
  const openTableDdl = tableDdlScope ? () => setShowTableDdl(tableDdlScope) : undefined;
  if (showTableDdl && showTableDdl !== tableDdlScope) setShowTableDdl(undefined);
  if (quickQueryView.scope !== quickQueryScope) setQuickQueryView({ scope: quickQueryScope, reset: 0 });
  const quickQueryResult = quickQueryView.scope === quickQueryScope ? quickQueryView.result : undefined;
  const activeSqliteEditor = liveSqlite && browsableTable?.key.schema === "main"
    && !browsableTable.sqlite?.virtualTable && !browsableTable.sqlite?.columnsUnavailable
    ? sqliteEditors.find((editor) => editor.target.sourceId === snapshot?.sourceId
      && editor.binding === sqliteBinding && editor.target.table === browsableTable.key.name) : undefined;
  const modelInspectorVisible = mode !== "database" && mode !== "ontology";
  const ontologySnapshot = runtime.data?.kind === "desktop" && !historyPreview ? snapshot : undefined;
  const ontologyRequiresNewerMySql = ontologySnapshot && requiresNewerMySqlForOntology(ontologySnapshot.database);
  const queryOntologyScope = mode === "query" && ontologySnapshot && !ontologyRequiresNewerMySql
    ? { sourceId: ontologySnapshot.sourceId, snapshotId: ontologySnapshot.id } : undefined;
  const queryOntology = useOntologyDefinitions(platform, queryOntologyScope);
  const ontologyDefinitionId = ontologySelection?.sourceId === ontologySnapshot?.sourceId ? ontologySelection?.id : undefined;
  const postgresExport = runtime.data?.kind === "desktop" && snapshot?.database.databaseType === "postgreSql" && !historyPreview;
  const postgresDump = postgresExport && runtime.data?.distribution !== "macAppStore";
  const domainWorkspace = useRef({ snapshot, semantics, semanticsSnapshot, runtimeKind: runtime.data?.kind, mode, reviewView, historyPreview });
  const pendingDomainUpdates = useRef(new Set<string>());
  useLayoutEffect(() => {
    domainWorkspace.current = { snapshot, semantics, semanticsSnapshot, runtimeKind: runtime.data?.kind, mode, reviewView, historyPreview };
  }, [snapshot, semantics, semanticsSnapshot, runtime.data?.kind, mode, reviewView, historyPreview]);

  const addTablesToDomain = useCallback(async (domainId: string, tableKeys: ObjectKey[]) => {
    const workspace = domainWorkspace.current;
    const currentSnapshot = workspace.snapshot;
    if (!currentSnapshot || workspace.runtimeKind !== "desktop" || workspace.mode !== "explore" || workspace.semanticsSnapshot !== currentSnapshot) {
      throw new Error(translate("navigation.openALoadedDatabaseDiagramInTheDesktop"));
    }
    const group = workspace.semantics.domainGroups.find((item) => item.id === domainId && item.sourceId === currentSnapshot.sourceId);
    if (!group) throw new Error(translate("navigation.thisBusinessDomainIsNoLongerAvailableChoose"));
    const addition = domainMembershipAddition(currentSnapshot, group, tableKeys);
    if (!addition.addedCount) return group;
    const updateKey = `${currentSnapshot.sourceId}:${domainId}`;
    if (pendingDomainUpdates.current.has(updateKey)) throw new Error(translate("navigation.thisBusinessDomainIsStillBeingSavedTry"));
    pendingDomainUpdates.current.add(updateKey);
    try {
      const saved = await platform.saveDomainGroup(addition.input);
      if (domainWorkspace.current.snapshot?.sourceId === currentSnapshot.sourceId) {
        setSemantics((current) => ({ ...current, domainGroups: current.domainGroups.map((item) => item.id === saved.id ? saved : item) }));
        setSavedView((current) => current?.id === `domain:${saved.id}` ? { ...current, rootTableKeys: saved.tableKeys, name: saved.name, updatedAt: saved.updatedAt } : current);
      }
      return saved;
    } finally {
      pendingDomainUpdates.current.delete(updateKey);
    }
  }, [translate]);

  const schemaSearchResults = useMemo(() => searchSchema(snapshot, query, 10, {
    includeComments: Boolean(settings.source?.ai.includeComments),
    semantics: semanticsSettledSnapshot === snapshot
      ? { domainGroups: semantics.domainGroups, knowledge: settings.source?.ai.includeConfirmedSemantics ? semantics.knowledge : undefined }
      : undefined,
  }), [query, snapshot, semantics, semanticsSettledSnapshot, settings.source]);
  const showSearchResults = searchOpen && Boolean(query.trim());
  const searchIndex = Math.min(activeSearchResult, Math.max(0, schemaSearchResults.length - 1));
  const selectedSearchResult = schemaSearchResults[searchIndex];
  const searchMatch = selectedSearchResult?.match;
  const activeSearchOption = showSearchResults && selectedSearchResult ? `${searchListId}-${searchIndex}` : undefined;
  useEffect(() => {
    if (activeSearchOption) document.getElementById(activeSearchOption)?.scrollIntoView?.({ block: "nearest" });
  }, [activeSearchOption, query]);
  useEffect(() => {
    if (!toolsOpen) return;
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !workspaceTools.current?.contains(event.target)) setToolsOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [toolsOpen]);
  const WorkspaceCanvas = mode === "changes" && changeSet ? SchemaChangesDiagram : SchemaCanvas;
  const historicalSelection = Boolean(snapshot && selectedTable && !currentTable);

  const openSchemaSearch = useCallback(() => {
    setSettingsOpen(false);
    setPreflightOpen(false);
    setSearchOpen(true);
    window.requestAnimationFrame(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    });
  }, [setPreflightOpen]);

  const locateTable = useCallback((table: TableDefinition) => {
    if (!snapshot) return;
    setObjectDocument(undefined);
    setDatabaseObjectSelection(undefined);
    setMode("explore");
    setRelationshipSearch(undefined);
    setPreflightOpen(false);
    setQuery("");
    setSearchOpen(false);
    setSavedView(undefined);
    setSelectedTable(table);
    setColumnFocus(undefined);
    setLocateRequest({ sourceId: snapshot.sourceId, snapshotId: snapshot.id,
      nodeId: `${table.key.schema}.${table.key.name}`, revision: ++locateRevision.current });
  }, [snapshot, setPreflightOpen]);
  const locateSearchResult = useCallback((result: SchemaSearchResult) => locateTable(result.table), [locateTable]);
  const revealModelTableChanges = useCallback(() => {
    setRightPanel((panel) => ({ ...panel, expanded: true }));
    setModelChangeRequest((request) => request + 1);
  }, [setRightPanel]);
  const inspectTable = useCallback((table: TableDefinition | undefined, columnName?: string) => {
    setSelectedTable(table);
    setDatabaseObjectSelection(undefined);
    setLocateRequest(undefined);
    setColumnFocus(table && columnName ? { snapshot, table, name: columnName } : undefined);
    if (table && modelTableChanges?.has(modelTableKey(table.key))) revealModelTableChanges();
    else if (columnName) setRightPanel((panel) => ({ ...panel, expanded: true }));
  }, [modelTableChanges, revealModelTableChanges, setRightPanel, snapshot]);

  const publishNotice = useCallback((notice: AppNotice) => {
    if (isQuietHours(settings.app.notifications)) return;
    setNotices((current) => [notice, ...current.filter((item) => item.id !== notice.id)].slice(0, 50));
    if (settings.app.notifications.systemNotifications && Notification.permission === "granted") {
      new Notification(notice.title, { body: notice.message });
    }
  }, [settings.app.notifications]);

  // Effects that only need to *emit* a notice read publishNotice through a ref:
  // its identity changes with every notification setting, and depending on it
  // would make the settings loader re-fetch (and the semantics loader re-run)
  // each time those settings change.
  const publishNoticeRef = useRef(publishNotice);
  useEffect(() => {
    publishNoticeRef.current = publishNotice;
  }, [publishNotice]);
  useEffect(() => {
    if (!availableUpdate || !updateNotificationsEnabled || notifiedUpdate.current === availableUpdate) return;
    notifiedUpdate.current = availableUpdate;
    publishNoticeRef.current({ id: `update-${availableUpdate}`, title: translate("navigation.applicationUpdateAvailable"),
      message: translate("navigation.nodalStudioIsAvailableReviewWhatSNew", { value0: availableUpdate }),
      createdAt: new Date().toISOString(), settingsCategory: "updates" });
  }, [availableUpdate, updateNotificationsEnabled, translate]);
  useEffect(() => {
    if (!connectionFolder.data) return;
    const { pendingId, pending } = connectionFolder.data;
    if (pendingId === notifiedConnectionFolder.current) return;
    notifiedConnectionFolder.current = pendingId;
    if (pendingId) {
      publishNoticeRef.current({
        id: "connection-folder-update",
        title: translate("connectionFolder.updatesAvailable"),
        message: translate("connectionFolder.updatesMessage", { count: pending }),
        createdAt: new Date().toISOString(),
        settingsCategory: "cloud",
      });
    }
  }, [connectionFolder.data, translate]);
  const loadSemantics = useCallback(() => {
    if (!snapshot || activeSemanticSession.current !== semanticSession) return Promise.resolve();
    const request = ++semanticRequest.current;
    const current = () => activeSemanticSession.current === semanticSession && request === semanticRequest.current;
    return platform.getSemantics(snapshot.sourceId).then((bundle) => {
      if (!current()) return;
      setSemantics(bundle);
      if (!historyPreview) setSavedView((currentView) => {
        if (currentView?.sourceId === snapshot.sourceId && currentView.id.startsWith("domain:")) return currentView;
        let preferred: string | undefined = currentView?.sourceId === snapshot.sourceId ? currentView.id : undefined;
        try { preferred ??= localStorage.getItem(`nodalstudio:last-view:${snapshot.sourceId}`) ?? undefined; } catch { /* Preference unavailable. */ }
        return bundle.savedViews.find((view) => view.sourceId === snapshot.sourceId && view.id === preferred);
      });
      setSemanticsSnapshot(snapshot);
      setSemanticsSettledSnapshot(snapshot);
    }).catch((reason: unknown) => {
      if (!current()) return;
      setSemantics(emptySemantics);
      setSemanticsSnapshot(undefined);
      setSemanticsSettledSnapshot(snapshot);
      publishNoticeRef.current({
        id: `semantics-load-failed-${snapshot.sourceId}`,
        title: translate("navigation.semanticModelCouldNotBeLoaded"),
        message: translate("navigation.annotationsDomainGroupsAndSavedViewsAreUnavailable", { value0: noticeReason(reason) }),
        createdAt: new Date().toISOString(),
      });
      throw reason;
    });
  }, [snapshot, semanticSession, historyPreview, translate]);
  const currentSemanticLoader = useRef<{ sourceId: string; load: () => Promise<void> } | undefined>(undefined);
  useLayoutEffect(() => {
    currentSemanticLoader.current = snapshot ? { sourceId: snapshot.sourceId, load: loadSemantics } : undefined;
    return () => { currentSemanticLoader.current = undefined; };
  }, [snapshot, loadSemantics]);
  const refreshSemantics = useCallback(async () => {
    // A committed write belongs to its source, even if its editor/session has gone.
    // Load through the current session; never apply an old session's read result.
    const current = currentSemanticLoader.current;
    if (!snapshot || current?.sourceId !== snapshot.sourceId) return;
    setSemantics((value) => ({ ...value, knowledge: [] }));
    await current.load();
  }, [snapshot]);
  const healthCheckFailing = useRef(false);

  const handleCapture = useCallback((result: CaptureSnapshotResult, preserveMode = false) => {
    startupRevision.current += 1;
    const sameSource = snapshot?.sourceId === result.snapshot.sourceId;
    setHistoryPreview(false);
    setSnapshot(result.snapshot);
    if (!preserveMode || !sameSource) setDatabaseObjectSelection(undefined);
    setChangeSet(result.changeSet ?? undefined);
    setChangesView("list");
    if (!preserveMode) setMode("explore");
    setSelectedTable((table) => preserveMode && sameSource && table
      ? result.snapshot.schemas.find((schema) => schema.name === table.key.schema)?.tables.find((item) => item.key.name === table.key.name)
      : undefined);
    setLocateRequest(undefined);
    if (!sameSource) { setSavedView(undefined); setOpenQueryRequest(undefined); }
    else if (historyPreview) setSavedView(latestWorkspace.current?.view);
    latestWorkspace.current = { snapshot: result.snapshot, view: sameSource ? (historyPreview ? latestWorkspace.current?.view : savedView) : undefined };
    const notificationSettings = settings.app.notifications;
    const schemaNotificationLevel =
      settings.source?.refresh.changeNotifications ?? notificationSettings.schemaChanges;
    const hasHighRisk = (result.changeSet?.riskSummary.high ?? 0) > 0;
    const shouldNotify = Boolean(result.changeSet) &&
      (schemaNotificationLevel === "all" ||
        (schemaNotificationLevel === "highRisk" && hasHighRisk));
    if (shouldNotify) {
      publishNotice({
        id: result.changeSet?.id ?? result.snapshot.id,
        title: hasHighRisk ? translate("navigation.highRiskSchemaChange") : translate("navigation.schemaChanged"),
        message: translate("navigation.structuralOperationsDetectedIn", { value0: result.changeSet?.operations.length ?? 0, value1: result.snapshot.database.name }),
        createdAt: new Date().toISOString(),
      });
    }
  }, [publishNotice, settings.app.notifications, settings.source?.refresh.changeNotifications, snapshot?.sourceId, savedView, historyPreview, translate]);

  const ddlWorkspace = useRef<{ snapshot: DatabaseSnapshot; targetKey: string; accept: typeof handleCapture } | undefined>(undefined);
  useLayoutEffect(() => {
    ddlWorkspace.current = ddlTarget && snapshot
      ? { snapshot, targetKey: schemaDdlTargetKey(ddlTarget), accept: handleCapture } : undefined;
  }, [handleCapture, ddlTarget, snapshot]);

  const acceptSchemaDdl = useCallback((target: SchemaDdlTarget, result?: CaptureSnapshotResult) => {
    if (target.databaseType === "sqlite") {
      void queryClient.invalidateQueries({ queryKey: sqliteTableSourceKey(target.sourceId, target.filePath) });
    }
    const current = ddlWorkspace.current;
    if (result && current && current.targetKey === schemaDdlTargetKey(target)
      && result.snapshot.id !== current.snapshot.id
      && Date.parse(result.snapshot.capturedAt) >= Date.parse(current.snapshot.capturedAt)) {
      current.accept(result, true);
    }
  }, [queryClient]);

  const refreshActive = useCallback(async (trigger: "manual" | "background" = "manual") => {
    if (!snapshot) return;
    await runRefresh(async (isCurrent) => {
      const result = await platform.capturePostgresSnapshot(snapshot.sourceId, trigger);
      const visible = domainWorkspace.current;
      const currentReview = visible.mode === "changes" && visible.reviewView === "review" && !visible.historyPreview;
      if (isCurrent() && trigger === "manual" && visible.snapshot === snapshot) {
        if (currentReview) setReviewRefresh(value => value + 1);
        void queryClient.invalidateQueries({ queryKey: ontologyDefinitionsKey({ sourceId: snapshot.sourceId }) });
      }
      if (isCurrent() && result.stored && visible.snapshot === snapshot) {
        handleCapture(result, currentReview || visible.mode === "database" || visible.mode === "explore" || visible.mode === "ontology");
        if (trigger === "manual") void queryClient.invalidateQueries({ queryKey: ["table-row-estimates", snapshot.sourceId] });
        if (sqliteBinding) void queryClient.invalidateQueries({ queryKey: sqliteTableSourceKey(snapshot.sourceId, sqliteBinding) });
      }
      return result;
    }, { running: translate("navigation.refreshing", { value0: snapshot.database.name }), success: (result) => translate("navigation.snapshotRefreshedTablesStructuralChanges", { value0: result.snapshot.schemas.reduce((count, schema) => count + schema.tables.length, 0), value1: result.changeSet?.operations.length ?? 0, value2: result.stored ? "" : translate("navigation.refresh.noSnapshot") }), failure: translate("navigation.unableToRefreshTheLoadedSnapshotRemainsAvailable", { value0: snapshot.database.name }) });
  }, [handleCapture, queryClient, runRefresh, snapshot, sqliteBinding, translate]);

  useEffect(() => {
    const intervalSeconds = settings.source?.refresh.intervalSeconds ?? 30;
    if (!snapshot || runtime.data?.kind !== "desktop" || intervalSeconds === 0) return;
    const timer = window.setInterval(() => {
      if (settings.source?.refresh.pauseInBackground && document.hidden) return;
      void refreshActive("background");
    }, intervalSeconds * 1000);
    return () => window.clearInterval(timer);
  }, [refreshActive, runtime.data?.kind, settings.source?.refresh, snapshot]);

  useEffect(() => {
    let active = true;
    void platform
      .getSettings(snapshot?.sourceId)
      .then((loaded) => migrateLegacySettings(platform, loaded, snapshot?.sourceId))
      .then((loaded) => {
        if (!active) return;
        setSettings(loaded);
        setSettingsAvailable(true);
        if (loaded.app.appearance.restoreSidebarState) {
          setLeftPanel({
            expanded: loaded.app.appearance.leftSidebarExpanded,
            width: loaded.app.appearance.leftSidebarWidth,
          });
          // A delayed settings read must not undo an explicit open/close action.
          if (!rightPanelInteracted.current) {
            restoreRightPanel({
              expanded: loaded.app.appearance.rightSidebarExpanded,
              width: loaded.app.appearance.rightSidebarWidth,
            });
          }
        }
        setSettingsLoaded(true);
      })
      .catch((reason: unknown) => {
        // Carry on with defaults so the app still renders, but say so: silently
        // substituting them makes a load failure indistinguishable from a fresh
        // install, and the defaults include the privacy and cloud posture.
        if (!active) return;
        setSettingsAvailable(false);
        setSettingsLoaded(true);
        publishNoticeRef.current({
          id: "settings-load-failed",
          title: translate("navigation.storedSettingsCouldNotBeLoaded"),
          message: translate("navigation.runningWithDefaultSettingsIncludingDefaultPrivacyAnd", { value0: noticeReason(reason) }),
          createdAt: new Date().toISOString(),
        });
      });
    return () => {
      active = false;
    };
  }, [snapshot?.sourceId, translate]);

  useEffect(() => {
    if (!settingsLoaded) return;
    const timer = window.setTimeout(() => {
      const appearance = {
        ...settings.app.appearance,
        leftSidebarExpanded: leftPanel.expanded,
        leftSidebarWidth: leftPanel.width,
        rightSidebarExpanded: rightPanel.expanded,
        rightSidebarWidth: rightPanel.width,
      };
      if (JSON.stringify(appearance) === JSON.stringify(settings.app.appearance)) return;
      const next = { ...settings.app, appearance };
      void platform.updateAppSettings(next).then(() =>
        setSettings((current) => ({ ...current, app: next })),
      );
    }, 300);
    return () => window.clearTimeout(timer);
  }, [leftPanel, rightPanel, settings.app, settingsLoaded]);

  useEffect(() => {
    document.documentElement.dataset.theme = settings.app.general.theme;
    document.documentElement.dataset.density = settings.app.appearance.density;
    document.documentElement.dataset.reduceMotion = String(settings.app.appearance.reduceMotion);
    document.documentElement.dataset.highContrastRelations = String(settings.app.appearance.highContrastRelations);
    document.documentElement.dataset.colorBlindPalette = String(settings.app.appearance.colorBlindPalette);
    document.documentElement.style.setProperty("--ui-font-size", `${settings.app.appearance.uiFontSize}px`);
    document.documentElement.style.setProperty("--node-font-size", `${settings.app.appearance.nodeFontSize}px`);
    document.documentElement.style.setProperty("--monospace-font-size", `${settings.app.appearance.monospaceFontSize}px`);
    const uiScale = String(settings.app.general.uiScalePercent / 100);
    document.documentElement.style.setProperty("--ui-scale", uiScale);
    document.body.style.setProperty("zoom", uiScale);
  }, [settings.app.appearance, settings.app.general]);

  useEffect(() => {
    if (runtime.data?.kind !== "desktop") return;
    void platform
      .listDataSources()
      .then(setDataSources)
      .catch((reason: unknown) => {
        // An empty list and a failed one look the same in the sidebar, so a
        // connection that exists would read as "you have none".
        setDataSources([]);
        publishNoticeRef.current({
          id: "data-sources-load-failed",
          title: translate("navigation.dataSourcesCouldNotBeListed"),
          message: translate("navigation.existingConnectionsAreNotShownTheyHaveNot", { value0: noticeReason(reason) }),
          createdAt: new Date().toISOString(),
        });
      });
  }, [runtime.data?.kind, translate]);

  useEffect(() => {
    const connectable = dataSources.filter((profile) => !profile.connectionSync?.pending);
    if (
      autoConnectAttempted.current ||
      !settingsLoaded ||
      snapshot ||
      runtime.data?.kind !== "desktop" ||
      connectable.length === 0
    ) return;
    autoConnectAttempted.current = true;
    const revision = startupRevision.current;
    const isCurrent = () => startupRevision.current === revision;
    void Promise.all(
      connectable.map(async (profile) => ({
        profile,
        effective: await platform.getSettings(profile.id),
      })),
    )
      .then((candidates) => {
        const lastSource = settings.app.general.startPage === "lastDataSource" &&
          settings.app.general.reopenLastWorkspace
          ? candidates.find(({ profile }) => profile.id === settings.app.general.lastSourceId)
          : undefined;
        return lastSource ?? candidates.find(({ effective }) => effective.source?.refresh.autoConnect);
      })
      .then(async (candidate) => {
        if (!candidate || !isCurrent()) return;
        if (candidate.effective.source?.refresh.autoConnect) {
          const result = await platform.capturePostgresSnapshot(candidate.profile.id, "background");
          if (isCurrent()) handleCapture(result);
        } else {
          // Reopening a workspace is a local read. Live introspection is opt-in.
          const snapshots = await platform.listSnapshots(candidate.profile.id);
          if (!isCurrent()) return;
          const latest = snapshots[0];
          if (!latest) throw new Error(translate("navigation.noSavedModelIsAvailableEditTheConnection"));
          const saved = await platform.getSnapshot(latest.id);
          if (isCurrent()) handleCapture({ snapshot: saved, stored: false, changeSet: null });
        }
      })
      .catch((reason: unknown) => {
        if (isCurrent()) publishNoticeRef.current({ id: "auto-connect-failed", title: translate("navigation.workspaceCouldNotBeOpened"), message: translate("navigation.chooseTheDataSourceToRetry", { value0: noticeReason(reason) }), createdAt: new Date().toISOString() });
      });
  }, [dataSources, handleCapture, runtime.data?.kind, settings.app.general.lastSourceId, settings.app.general.reopenLastWorkspace, settings.app.general.startPage, settingsLoaded, snapshot, translate]);

  useEffect(() => {
    if (!settingsLoaded || runtime.data?.kind !== "desktop" || !snapshot) return;
    const lastViewMode = viewMode === "ontology" ? "explore" : viewMode;
    if (
      settings.app.general.lastSourceId === snapshot.sourceId &&
      settings.app.general.lastViewMode === lastViewMode
    ) return;
    const next = {
      ...settings.app,
      general: {
        ...settings.app.general,
        lastSourceId: snapshot.sourceId,
        lastViewMode,
      },
    };
    let active = true;
    const timer = window.setTimeout(() => {
      void platform.updateAppSettings(next)
        .then((effective) => {
          if (!active) return;
          // This command returns only app settings, without source/project policy.
          setSettings((current) => ({ ...current, app: effective.app }));
        })
        .catch((reason: unknown) => {
          if (!active) return;
          publishNoticeRef.current({
            id: "workspace-settings-save-failed",
            title: translate("navigation.recentWorkspaceCouldNotBeSaved"),
            message: noticeReason(reason),
            createdAt: new Date().toISOString(),
          });
        });
    }, 300);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [viewMode, runtime.data?.kind, settings.app, settingsLoaded, snapshot, translate]);

  useEffect(() => {
    if (!settings.app.general.confirmBeforeQuit || refreshState !== "refreshing") return;
    const preventQuit = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", preventQuit);
    return () => window.removeEventListener("beforeunload", preventQuit);
  }, [refreshState, settings.app.general.confirmBeforeQuit]);

  useEffect(() => {
    if (!settingsLoaded || runtime.data?.kind !== "desktop") return;
    let active = true;
    async function inspectLocalHealth() {
      const usage = await platform.getStorageUsage();
      if (!active) return;
      const totalBytes = usage.snapshotBytes + usage.semanticBytes + usage.layoutBytes + usage.syncQueueBytes + usage.settingsBytes;
      if (settings.app.notifications.storageWarnings && totalBytes >= settings.app.history.storageWarningMegabytes * 1024 * 1024) {
        publishNotice({ id: "storage-warning", title: translate("navigation.localStorageWarning"), message: translate("navigation.nodalStudioLocalDataUses", { value0: formatAppBytes(totalBytes) }), createdAt: new Date().toISOString() });
      }
      if (!snapshot || !settings.source) return;
      if (runtime.data?.distribution !== "macAppStore" && settings.app.notifications.cloudFailures) {
        const queue = await platform.listSyncDiagnostics(snapshot.sourceId);
        if (active && queue.some((item) => item.state === "conflict" || item.attempts > 0)) {
          publishNotice({ id: `cloud-queue-${snapshot.sourceId}`, title: translate("navigation.cloudSyncNeedsAttention"), message: translate("navigation.queuedItemSIncludingFailedOrConflictedMetadata", { value0: queue.length }), createdAt: new Date().toISOString() });
        }
      }
      if (settings.app.notifications.gitConflicts && settings.source.git.repositoryPath) {
        const git = await platform.checkMergeDriver(snapshot.sourceId, settings.source.git.repositoryPath);
        if (active && (git.fingerprintMatches === false || git.conflictReports.length > 0)) {
          publishNotice({ id: `git-conflict-${snapshot.sourceId}`, title: translate("navigation.gitSemanticsNeedAttention"), message: git.conflictReports.length ? translate("navigation.unresolvedSemanticConflictReportS", { value0: git.conflictReports.length }) : translate("navigation.gitWorkspaceFingerprintDiffersFromTheActiveSnapshot"), createdAt: new Date().toISOString() });
        }
      }
    }
    // This check is what raises drift, cloud and Git-conflict warnings, so its
    // own failure has to be visible: otherwise the warnings simply stop and the
    // silence reads as "nothing wrong". Notify on the edge into failure only —
    // it runs every minute.
    function runHealthCheck() {
      void inspectLocalHealth()
        .then(() => {
          healthCheckFailing.current = false;
        })
        .catch((reason: unknown) => {
          if (!active || healthCheckFailing.current) return;
          healthCheckFailing.current = true;
          publishNotice({
            id: "health-check-failed",
            title: translate("navigation.backgroundChecksAreNotRunning"),
            message: translate("navigation.storageCloudSyncAndGitConflictWarningsAre", { value0: noticeReason(reason) }),
            createdAt: new Date().toISOString(),
          });
        });
    }
    runHealthCheck();
    const timer = window.setInterval(runHealthCheck, 60_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [publishNotice, runtime.data?.kind, runtime.data?.distribution, settings.app.history.storageWarningMegabytes, settings.app.notifications.cloudFailures, settings.app.notifications.gitConflicts, settings.app.notifications.storageWarnings, settings.source, settingsLoaded, snapshot, translate]);

  useEffect(() => {
    function openFromLocation() {
      const match = window.location.hash.match(/^#\/settings\/(.+)$/);
      if (!match) return;
      const category = match[1] as SettingsCategory;
      if (category) setSettingsCategory(category);
      setSettingsOpen(true);
    }
    openFromLocation();
    window.addEventListener("hashchange", openFromLocation);
    return () => {
      window.removeEventListener("hashchange", openFromLocation);
    };
  }, []);

  async function updateAppSettings(next: AppSettings) {
    await platform.updateAppSettings(next);
    const refreshed = await platform.getSettings(snapshot?.sourceId);
    setSettings(refreshed);
    setLeftPanel({ expanded: refreshed.app.appearance.leftSidebarExpanded, width: refreshed.app.appearance.leftSidebarWidth });
    setRightPanel({ expanded: refreshed.app.appearance.rightSidebarExpanded, width: refreshed.app.appearance.rightSidebarWidth });
  }

  async function updateSourceSettings(next: DataSourceSettings) {
    const refreshed = await platform.updateDataSourceSettings(next);
    setSettings(refreshed);
  }

  const openSettings = useCallback((category: SettingsCategory = "general") => {
    setNoticesOpen(false);
    setSettingsCategory(category);
    setSettingsOpen(true);
    window.history.replaceState(null, "", `#/settings/${category}`);
  }, []);

  useEffect(() => {
    if (!snapshot) return;
    void loadSemantics().catch(() => undefined);
  }, [snapshot, loadSemantics]);

  useEffect(() => {
    if (runtime.data?.kind !== "web" || snapshot) return;
    let active = true;
    void platform
      .loadSharedBundle()
      .then((bundle) => {
        if (!active || !bundle) return;
        if (bundle.snapshot) setSnapshot(bundle.snapshot);
        setChangeSet(bundle.changeSet ?? undefined);
        setSemantics({
          annotations: bundle.annotations,
          orphanedAnnotations: [],
          domainGroups: bundle.domainGroups,
          savedViews: bundle.savedViews,
          layout: bundle.layout,
          logicalRelationships: bundle.logicalRelationships ?? [],
          ignoredRelationshipInferences: [],
        });
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [runtime.data?.kind, snapshot]);

  async function saveAnnotation(input: SaveAnnotationInput) {
    await platform.saveAnnotation(input);
    await refreshSemantics();
  }

  const createLogicalRelationship = useCallback(async (input: SaveLogicalRelationshipInput) => {
    const relationship = await platform.createLogicalRelationship(input);
    await refreshSemantics();
    return relationship;
  }, [refreshSemantics]);

  const updateLogicalRelationship = useCallback(async (input: SaveLogicalRelationshipInput) => {
    const relationship = await platform.updateLogicalRelationship(input);
    await refreshSemantics();
    return relationship;
  }, [refreshSemantics]);

  const deleteLogicalRelationship = useCallback(async (relationshipId: string) => {
    if (!snapshot) return;
    await platform.deleteLogicalRelationship(snapshot.sourceId, relationshipId);
    await refreshSemantics();
  }, [snapshot, refreshSemantics]);

  const ignoreRelationshipInference = useCallback(async (relationshipKey: string) => {
    if (!snapshot) return;
    const ignored = await platform.ignoreRelationshipInference(snapshot.sourceId, relationshipKey);
    if (activeSemanticSession.current !== semanticSession) return;
    setSemantics((current) => ({
      ...current,
      ignoredRelationshipInferences: [
        ignored,
        ...current.ignoredRelationshipInferences.filter((item) => item.relationshipKey !== relationshipKey),
      ],
    }));
  }, [snapshot, semanticSession]);

  const restoreRelationshipInference = useCallback(async (relationshipKey: string) => {
    if (!snapshot) throw new Error(translate("navigation.selectADataSourceToRestoreThisCandidate"));
    await platform.restoreRelationshipInference(snapshot.sourceId, relationshipKey);
    if (activeSemanticSession.current !== semanticSession) return;
    setSemantics((current) => ({ ...current,
      ignoredRelationshipInferences: current.ignoredRelationshipInferences.filter((item) => item.relationshipKey !== relationshipKey),
    }));
  }, [snapshot, semanticSession, translate]);

  const relationshipBatchApi = useMemo<import("./platform/relationship-batches").RelationshipBatchApi>(() => ({
    preview: (input) => platform.previewRelationshipBatch(input),
    apply: async (input) => { const batch = await platform.applyRelationshipBatch(input); await refreshSemantics(); return batch; },
    list: (sourceId) => platform.listRelationshipBatches(sourceId),
    undo: async (sourceId, batchId) => { const batch = await platform.undoRelationshipBatch(sourceId, batchId); await refreshSemantics(); return batch; },
  }), [refreshSemantics]);

  const saveCanvasLayout = useCallback(async (positions: Record<string, import("./platform/types").CanvasNodeLayout>, viewport?: import("./platform/types").CanvasLayout["viewport"]) => {
    if (!snapshot || historyPreview || mode !== "explore") throw new Error(translate("navigation.historicalLayoutsAreTemporaryReturnToTheLatest"));
    const viewId = savedView && !savedView.id.startsWith("domain:") ? savedView.id : null;
    await platform.saveLayout(snapshot.sourceId, viewId, positions, viewport, snapshot.id);
    if (activeSemanticSession.current !== semanticSession) return;
    const layout = { sourceId: snapshot.sourceId, viewId, positions, viewport, updatedAt: new Date().toISOString() };
    setSemantics((current) => ({ ...current, ...(viewId ? {} : { layout }), viewLayouts: [...(current.viewLayouts ?? []).filter((item) => item.viewId !== viewId), layout] }));
  }, [snapshot, savedView, historyPreview, mode, semanticSession, translate]);

  const saveModelView = useCallback(async (input: import("./platform/types").SaveViewInput) => {
    if (!snapshot || historyPreview || mode !== "explore" || input.sourceId !== snapshot.sourceId || input.snapshotId !== snapshot.id) throw new Error(translate("navigation.returnToTheLatestModelToSaveViews"));
    const view = await platform.saveView(input);
    if (activeSemanticSession.current === semanticSession) {
      setSemantics((current) => ({ ...current, savedViews: [...current.savedViews.filter((item) => item.id !== view.id), view],
        viewLayouts: input.positions ? [...(current.viewLayouts ?? []).filter((item) => item.viewId !== view.id), { sourceId: view.sourceId, viewId: view.id, positions: input.positions, viewport: input.viewport, updatedAt: view.updatedAt }] : current.viewLayouts }));
    }
    return view;
  }, [snapshot, historyPreview, mode, semanticSession, translate]);

  const deleteModelView = useCallback(async (id: string) => {
    if (!snapshot || historyPreview || mode !== "explore") throw new Error(translate("navigation.returnToTheLatestModelToDeleteViews"));
    await platform.deleteView(snapshot.sourceId, id, snapshot.id);
    if (activeSemanticSession.current === semanticSession) setSemantics((current) => ({ ...current, savedViews: current.savedViews.filter((item) => item.id !== id), viewLayouts: current.viewLayouts?.filter((item) => item.viewId !== id) }));
  }, [snapshot, historyPreview, mode, semanticSession, translate]);

  function rememberLatestWorkspace() {
    if (snapshot && !historyPreview) latestWorkspace.current = { snapshot, view: savedView };
  }

  async function returnToLatestModel() {
    if (!snapshot) return;
    const session = semanticSession;
    const summaries = await platform.listSnapshots(snapshot.sourceId);
    if (!summaries[0]) return;
    const latest = await platform.getSnapshot(summaries[0].id);
    if (activeSemanticSession.current !== session) return;
    openLatestModel(latest);
  }

  function openLatestModel(latest: DatabaseSnapshot) {
    setSnapshot(latest); setHistoryPreview(false); setChangeSet(undefined); setMode("explore");
    setDatabaseObjectSelection(undefined);
    setSavedView(latestWorkspace.current?.snapshot.sourceId === latest.sourceId ? latestWorkspace.current.view : undefined);
    setQuery(""); setSelectedTable(undefined); setLocateRequest(undefined);
  }

  function handleHistorySnapshot(historySnapshot: DatabaseSnapshot, latest: boolean) {
    if (latest) {
      if (historyPreview || snapshot?.id !== historySnapshot.id) openLatestModel(historySnapshot);
      return;
    }
    rememberLatestWorkspace();
    setDatabaseObjectSelection(undefined);
    setHistoryPreview(true);
    setSnapshot(historySnapshot);
    setChangeSet(undefined);
    // Viewing an older snapshot is the ordinary canvas with different data, not
    // a mode of its own — "history" never had a branch in the main area.
    setMode("explore");
    setSelectedTable(undefined);
    setLocateRequest(undefined);
    setSavedView(undefined);
  }

  function handleComparison(afterSnapshot: DatabaseSnapshot, comparison: SchemaChangeSet) {
    rememberLatestWorkspace();
    setDatabaseObjectSelection(undefined);
    setHistoryPreview(true);
    setSnapshot(afterSnapshot);
    setChangeSet(comparison);
    setChangesView("list");
    setReviewView("history");
    setMode("changes");
    setSelectedTable(undefined);
    setLocateRequest(undefined);
    setSavedView(undefined);
  }

  const openTableInQuery = useCallback((table: TableDefinition) => {
    if (!querySupported) return;
    setPreflightOpen(false);
    setLocateRequest(undefined);
    setSearchOpen(false);
    setRelationshipSearch(undefined);
    setQueryDraftSeed(undefined);
    setOpenQueryRequest({ id: Date.now(), sourceId, sql: tablePreviewSql(table, 100, snapshot?.database.databaseType) });
    setMode("query");
  }, [querySupported, snapshot?.database.databaseType, sourceId, setPreflightOpen]);

  function draftFromContext(seed: Omit<QueryDraftSeed, "id">) {
    if (seed.sourceId !== snapshot?.sourceId || seed.snapshotId !== snapshot.id) return;
    setQueryDraftSeed({ ...seed, id: Date.now() });
    setSearchOpen(false);
    setRelationshipSearch(undefined);
    setOpenQueryRequest(undefined);
    setPreflightOpen(false);
    setMode("query");
  }

  function showRelatedTables(table: TableDefinition) {
    if (!snapshot) return;
    setSearchOpen(false);
    setRelationshipSearch({ snapshot, mode, table, question: query.trim() });
  }

  function openSearchResultInQuery(table: TableDefinition) {
    if (!snapshot || !querySupported || historyPreview || discoveryLatest.data?.[0]?.id !== snapshot.id) return;
    if (snapshot.database.databaseType === "sqlite" || settings.app.privacy.offlineMode
      || !settings.source?.ai.enabled || settings.source.ai.provider !== "openAiCompatible") {
      openTableInQuery(table);
      return;
    }
    draftFromContext({ sourceId: snapshot.sourceId, snapshotId: snapshot.id, question: query.trim(),
      root: table.key, tables: [table.key], domainId: null });
  }

  function openSavedQuery(query?: SavedQuery) {
    if (!sourceId || !querySupported) return;
    setPreflightOpen(false);
    setRelationshipSearch(undefined);
    setQueryDraftSeed(undefined);
    setOpenQueryRequest({ id: Date.now(), sourceId, sql: query?.sql ?? "", kind: query ? "saved" : "new", savedQuery: query });
    setMode("query");
  }

  function deleteSavedQuery(query: SavedQuery) {
    if (!sourceId || !window.confirm(t("savedQueries.confirmDelete", { value0: query.name }))) return;
    if (deleteNamedQuery(sourceId, query.id)) setSavedQueryCatalog({ sourceId, queries: listSavedQueries(sourceId) });
    else publishNotice({ id: "saved-query-delete", title: t("savedQueries.storageError"), message: query.name, createdAt: new Date().toISOString() });
  }

  function openTable(table: TableDefinition) {
    if (!snapshot || !querySupported || historyPreview) return;
    setPreflightOpen(false);
    setLocateRequest(undefined);
    setQueryDraftSeed(undefined);
    setRelationshipSearch(undefined);
    setOpenQueryRequest(undefined);
    setDatabaseObjectSelection(undefined);
    setSelectedTable(table);
    setColumnFocus(undefined);
    setMode("database");
    if (liveSqlite && sqliteBinding && table.key.schema === "main"
      && !table.sqlite?.virtualTable && !table.sqlite?.columnsUnavailable) {
      const target: SqliteTableTarget = { sourceId: snapshot.sourceId, table: table.key.name };
      const key = JSON.stringify([target.sourceId, sqliteBinding, target.table]);
      setSqliteEditors((current) => {
        const retained = current.filter((editor) => editor.key === key || editor.retain);
        return retained.some((editor) => editor.key === key) ? retained : [...retained, { target, binding: sqliteBinding, key }];
      });
    } else {
      setSqliteEditors((current) => current.some((editor) => !editor.retain) ? current.filter((editor) => editor.retain) : current);
    }
  }

  const documentObject = objectDocument && objectDocument.snapshot === snapshot ? findDocumentObject(snapshot, objectDocument.key) : undefined;
  const documentVisible = Boolean(documentObject && mode === "explore" && !preflightOpen);
  const activeRelationshipSearch = relationshipSearch?.snapshot === snapshot && relationshipSearch?.mode === mode
    && !historyPreview ? relationshipSearch : undefined;
  const bindings = settings.app.shortcuts.bindings;
  const appleKeyboard = usesAppleKeyboard();
  const desktopShortcuts = runtime.data?.kind === "desktop";
  const queryUnavailable = runtime.data?.kind === "web" || Boolean(snapshot && !querySupported);
  const [[modelLabel, modelKey], [ontologyLabel, ontologyKey], [databaseLabel, databaseKey], [queryLabel, queryKey]] = WORKSPACE_SHORTCUTS;
  const modelShortcut = desktopShortcuts ? modelKey : undefined;
  const ontologyShortcut = ontologySnapshot ? ontologyKey : undefined;
  const databaseShortcut = desktopShortcuts ? databaseKey : undefined;
  const queryShortcut = desktopShortcuts && !queryUnavailable ? queryKey : undefined;
  const workspaceBindings = [["open-model", modelShortcut], ["open-ontology", ontologyShortcut], ["open-database", databaseShortcut], ["open-query", queryShortcut]] as const;
  const workspaceShortcuts = desktopShortcuts ? WORKSPACE_SHORTCUTS.map(([, shortcut]) => shortcut) : [];
  const appShortcut = (binding?: string) => activeAppShortcut(binding, mode === "query", workspaceShortcuts);
  const settingsShortcut = appShortcut(bindings.openSettings);
  const refreshAvailable = Boolean(snapshot && runtime.data?.kind === "desktop" && refreshState !== "refreshing");
  const canvasAvailable = Boolean(snapshot && !preflightOpen && !documentVisible
    && (mode === "explore" || (mode === "changes" && reviewView === "history" && changeSet && changesView === "diagram")));
  const focusCanvasAvailable = canvasAvailable && Boolean(currentTable) && !activeRelationshipSearch;
  const toggleLeftSidebar = useCallback(() => setLeftPanel(value => ({ ...value, expanded: !value.expanded })), []);
  const toggleRightInspector = useCallback(() => {
    if (preflightOpen) setPreflightDetailsExpanded(value => !value);
    else setRightPanel(value => ({ ...value, expanded: !value.expanded }));
  }, [preflightOpen, setRightPanel]);
  const commands: AppCommand<WorkspaceCommandId>[] = [
    { id: "search", group: "view", icon: "search", label: t("navigation.searchSchema"), keywords: "find table column 搜索 查找 表 字段",
      available: Boolean(snapshot), shortcut: appShortcut(bindings.focusSearch) },
    { id: "open-model", group: "view", icon: "canvas", label: t(modelLabel), keywords: "ER diagram 关系图",
      shortcut: modelShortcut },
    { id: "open-ontology", group: "view", icon: "relationships", label: t(ontologyLabel), keywords: "business definitions 业务口径",
      available: Boolean(ontologySnapshot), shortcut: ontologyShortcut },
    { id: "open-database", group: "view", icon: "database", label: t(databaseLabel), keywords: "browse table rows 浏览数据", shortcut: databaseShortcut },
    { id: "open-query", group: "view", icon: "viewer", label: t(queryLabel), keywords: "SQL editor 编辑器", available: !queryUnavailable, shortcut: queryShortcut },
    { id: "toggle-left", group: "view", icon: "list", label: t("navigation.toggleLeftSidebar"), keywords: "collapse expand sidebar 展开 收起 导航",
      shortcut: appShortcut(bindings.toggleLeftSidebar) },
    { id: "toggle-right", group: "view", icon: "split", label: t("navigation.toggleRightInspector"), keywords: "collapse expand details 展开 收起 属性 右侧栏",
      available: modelInspectorVisible, shortcut: appShortcut(bindings.toggleRightInspector) },
    { id: "fit", group: "view", icon: "fit", label: t("navigation.fitERCanvas"), keywords: "zoom model 缩放 适应 完整",
      available: canvasAvailable, shortcut: appShortcut(bindings.fitCanvas) },
    { id: "view-all", group: "view", icon: "table", label: t("navigation.viewAllDatabaseTables"), keywords: "global overview exit focus 完整模型 退出聚焦", available: canvasAvailable },
    { id: "focus-selected", group: "view", icon: "select", label: t("navigation.focusSelectedTable"), keywords: "isolate relationship table 关系 邻居",
      available: focusCanvasAvailable, shortcut: appShortcut(bindings.focusSelectedTable) },
    { id: "relayout", group: "view", icon: "canvas", label: t("navigation.reLayoutERCanvas"), keywords: "auto layout 整理 排列",
      available: canvasAvailable, shortcut: appShortcut(bindings.relayoutCanvas) },
    { id: "ddl-preview", group: "structure", icon: "import", label: t("navigation.openReadOnlyDDLPreview"), keywords: "SQL file clipboard PostgreSQL MySQL import 导入 文件 剪贴板" },
    { id: "refresh", group: "structure", icon: "refresh", label: t("navigation.refreshSchema"), keywords: "database capture snapshot 数据库 快照 捕获",
      available: refreshAvailable, shortcut: appShortcut(bindings.refreshSchema) },
    { id: "preflight", group: "structure", icon: "preflight", label: t("navigation.openStructurePreflight"), keywords: "schema check validation PostgreSQL MySQL 检查 验证",
      available: Boolean(snapshot && !preflightOpen) },
    { id: "review", group: "structure", icon: "report", label: t("navigation.reviewChanges"), keywords: "change review ontology 变更 本体 口径",
      available: Boolean(ontologySnapshot && (mode !== "changes" || reviewView !== "review")) },
    { id: "settings", group: "settings", icon: "settings", label: t("navigation.openSettings"), keywords: "preferences general 偏好 通用",
      shortcut: settingsShortcut },
    { id: "settings-git", group: "settings", icon: "git", label: t("navigation.openGitSettings"), keywords: "repository merge conflict 仓库 合并 冲突" },
    { id: "settings-ai", group: "settings", icon: "ai", label: t("navigation.openAISettings"), keywords: "provider model explanation 提供方 模型 解释" },
    { id: "capabilities", group: "settings", icon: "grid", label: t("navigation.openCapabilityMatrix"), keywords: "support PostgreSQL MySQL Desktop Web limitations 功能 支持 范围" },
  ];

  function switchWorkspace(next: Exclude<ViewMode, "changes">) {
    if (next === "database" && !databaseObject && browsableTable) {
      openTable(browsableTable);
      return;
    }
    setPreflightOpen(false);
    setRelationshipSearch(undefined);
    setLocateRequest(undefined);
    setSearchOpen(false);
    if (next === "ontology") setOntologySelection(undefined);
    setMode(next);
  }

  function runWorkspaceCommand(id: WorkspaceCommandId) {
    switch (id) {
      case "open-model": return switchWorkspace("explore");
      case "open-ontology": return switchWorkspace("ontology");
      case "open-database": return switchWorkspace("database");
      case "open-query": return switchWorkspace("query");
      case "search": return openSchemaSearch();
      case "toggle-left": return toggleLeftSidebar();
      case "toggle-right": return toggleRightInspector();
      case "fit": window.dispatchEvent(new Event("nodalstudio:fit-canvas")); return;
      case "view-all": window.dispatchEvent(new Event("nodalstudio:view-all-tables")); return;
      case "focus-selected": window.dispatchEvent(new Event("nodalstudio:focus-selected-table")); return;
      case "relayout": window.dispatchEvent(new Event("nodalstudio:relayout-canvas")); return;
      case "ddl-preview":
        setSettingsOpen(false);
        setDdlPreviewOpen(true, commandPaletteTrigger.current);
        return;
      case "refresh": void refreshActive(); return;
      case "preflight": return setPreflightOpen(true);
      case "review": window.dispatchEvent(new Event("nodalstudio:change-review")); return;
      case "settings": return openSettings();
      case "settings-git": return openSettings("git");
      case "settings-ai": return openSettings("ai");
      case "capabilities": return openSettings("capabilities");
    }
  }
  useEffect(() => {
    function handleShortcut(event: KeyboardEvent) {
      if (ddlPreviewOpen || commandPaletteOpen || event.defaultPrevented || event.isComposing) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("dialog[open], [aria-modal='true']")) return;
      if (!event.metaKey && !event.ctrlKey) {
        if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
        if (event.key === "Enter" && target?.closest("button, a[href], summary, [role='button'], [role='tab'], [role='option']")) return;
      }
      if (matchesShortcut(event, COMMAND_PALETTE_SHORTCUT)) {
        event.preventDefault();
        if (!event.repeat) openCommandPalette();
        return;
      }
      const platformModifier = appleKeyboard ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
      const workspaceAction = platformModifier && workspaceBindings.find(([, binding]) => binding && matchesShortcut(event, binding));
      if (workspaceAction) {
        event.preventDefault();
        if (!event.repeat) runWorkspaceCommand(workspaceAction[0]);
        return;
      }
      const bindingsByCommand: [WorkspaceCommandId, string | undefined][] = [
        ["settings", bindings.openSettings],
        ["search", snapshot ? bindings.focusSearch : undefined],
        ["refresh", refreshAvailable ? bindings.refreshSchema : undefined],
        ["toggle-left", bindings.toggleLeftSidebar],
        ["toggle-right", modelInspectorVisible ? bindings.toggleRightInspector : undefined],
        ["fit", canvasAvailable ? bindings.fitCanvas : undefined],
        ["focus-selected", focusCanvasAvailable ? bindings.focusSelectedTable : undefined],
        ["relayout", canvasAvailable ? bindings.relayoutCanvas : undefined],
      ];
      const action = bindingsByCommand.find(([, binding]) => {
        const shortcut = appShortcut(binding);
        return shortcut && matchesShortcut(event, shortcut);
      });
      if (!action) return;
      event.preventDefault();
      if (!event.repeat) runWorkspaceCommand(action[0]);
    }
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  });
  const openObjectDocument = useCallback((key: ObjectKey) => {
    if (!snapshot) return;
    setObjectDocument({ snapshot, key }); setMode("explore"); setPreflightOpen(false); setRelationshipSearch(undefined);
  }, [snapshot, setPreflightOpen]);
  const closeObjectDocument = useCallback(() => setObjectDocument(undefined), []);
  const openDatabaseObject = useCallback((key: ObjectKey, definition = false) => {
    if (snapshot) setDatabaseObjectSelection({ sourceId: snapshot.sourceId, key, definition });
  }, [snapshot]);
  function closeDatabaseDocument() {
    if (databaseDocument?.key.kind === "view" && querySupported && !historyPreview) openDatabaseObject(databaseDocument.key);
    else setDatabaseObjectSelection(undefined);
  }

  return (
    <I18nProvider value={i18n}>
    <main inert={ddlPreviewOpen || undefined} aria-hidden={ddlPreviewOpen || undefined} className={`app-shell${showUpdateBanner ? " has-update-banner" : ""}`}>
      <header className="topbar" data-glass={runtime.data?.kind === "desktop" && appleKeyboard || undefined}>
        <HeaderSidebarToggle
          side="left"
          expanded={leftPanel.expanded}
          onToggle={() =>
            setLeftPanel((current) => ({ ...current, expanded: !current.expanded }))
          }
        />
        <span className="visually-hidden" data-testid="runtime-badge"
          title={runtime.isPending ? t("navigation.detectingRuntime") : runtime.data?.label}>
          {runtime.isPending ? t("navigation.detectingRuntime") : runtime.data?.label}
        </span>
        <Segmented
          label={t("navigation.viewMode")}
          value={viewMode}
          onChange={switchWorkspace}
          options={[
            { value: "explore", label: t("navigation.model"), ...workspaceShortcutHint(t(modelLabel), modelShortcut) },
            ...(ontologySnapshot ? [{ value: "ontology" as const, label: t("ontology.title"), ...workspaceShortcutHint(t(ontologyLabel), ontologyShortcut) }] : []),
            { value: "database", label: t("navigation.database"), ...workspaceShortcutHint(t(databaseLabel), databaseShortcut) },
            {
              value: "query",
              label: t("navigation.query"),
              disabled: queryUnavailable,
              title: queryCapability.status === "supported" ? undefined : queryScope,
              ...workspaceShortcutHint(t(queryLabel), queryShortcut),
            },
          ]}
        />
        <div className="global-search" onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) setSearchOpen(false);
        }} onKeyDown={(event) => {
          if (event.key !== "Escape" || !showSearchResults || event.target === searchInputRef.current) return;
          event.preventDefault();
          searchInputRef.current?.focus();
          setSearchOpen(false);
        }}>
          <ActionIcon name="search" />
          <input
            ref={searchInputRef}
            type="search"
            role="combobox"
            aria-label={t("navigation.searchSchema")}
            autoComplete="off"
            aria-autocomplete="list"
            aria-expanded={showSearchResults && schemaSearchResults.length > 0}
            aria-controls={showSearchResults && schemaSearchResults.length > 0 ? searchListId : undefined}
            aria-activedescendant={activeSearchOption}
            placeholder={t("navigation.searchTableFieldOrTerm")}
            value={query}
            onFocus={() => setSearchOpen(true)}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveSearchResult(0);
              setSearchOpen(true);
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "Escape") {
                if (!showSearchResults) return;
                event.preventDefault();
                setSearchOpen(false);
                setQuery("");
              } else if (event.key === "ArrowDown" && schemaSearchResults.length) {
                event.preventDefault();
                setActiveSearchResult(showSearchResults ? (searchIndex + 1) % schemaSearchResults.length : 0);
                setSearchOpen(true);
              } else if (event.key === "ArrowUp" && schemaSearchResults.length) {
                event.preventDefault();
                setActiveSearchResult(showSearchResults ? (searchIndex - 1 + schemaSearchResults.length) % schemaSearchResults.length : schemaSearchResults.length - 1);
                setSearchOpen(true);
              } else if (event.key === "Enter" && showSearchResults && selectedSearchResult) {
                event.preventDefault();
                locateSearchResult(selectedSearchResult);
              }
            }}
            disabled={!snapshot}
          />
          {showSearchResults ? <div className="global-search-panel ds-surface">
            {snapshot ? <div className="global-search-scope">{t("navigation.searchInDatabase", { value0: snapshot.database.name })}</div> : null}
            <div className="global-search-results" id={searchListId} role={schemaSearchResults.length ? "listbox" : "status"} aria-label={t("navigation.schemaSearchResults")}>
            {schemaSearchResults.length ? schemaSearchResults.map((result, index) => <button
              type="button"
              role="option"
              id={`${searchListId}-${index}`}
              tabIndex={-1}
              aria-selected={index === searchIndex}
              key={`${result.schema}.${result.table.key.name}`}
              onPointerEnter={() => setActiveSearchResult(index)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => locateSearchResult(result)}
            >
              <strong>{result.table.key.name}</strong>
              <span>{result.schema}{result.matchingColumns.length ? ` · ${result.matchingColumns.slice(0, 3).join(", ")}` : ""}</span>
            </button>) : <p>{t("navigation.noMatchingTablesOrFields")}</p>}
            </div>
            {selectedSearchResult ? <div className="global-search-context">
              <p>{searchMatch
                ? t(searchMatch.expanded ? "navigation.searchExpansionMatch" : "navigation.searchMetadataMatch", {
                  value0: [t(`navigation.searchEvidence.${searchMatch.basis}`), searchMatch.column].filter(Boolean).join(" "),
                  value1: searchMatch.terms.join(", "),
                })
                : t(selectedSearchResult.nameMatch ? "navigation.searchNameMatch" : "navigation.searchFieldMatch")}</p>
              {runtime.data?.kind === "desktop" && !historyPreview && <div className="global-search-actions">
                <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => showRelatedTables(selectedSearchResult.table)}>{t("navigation.showRelatedTables")}</button>
                {querySupported && snapshot && discoveryLatest.data?.[0]?.id === snapshot.id
                  ? <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => openSearchResultInQuery(selectedSearchResult.table)}>{t("navigation.useSearchResultInQuery")}</button> : null}
              </div>}
            </div> : null}
          </div> : null}
        </div>
        <div className="runtime-actions" role="group" aria-label={t("navigation.applicationTools")}>
          <div className="workspace-tools" ref={workspaceTools} data-open={toolsOpen || undefined}
            onBlur={(event) => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) setToolsOpen(false); }}
            onKeyDown={(event) => {
              if (event.key !== "Escape" || !toolsOpen) return;
              event.preventDefault();
              setToolsOpen(false);
              event.currentTarget.querySelector<HTMLButtonElement>(".workspace-tools-toggle button")?.focus();
            }}>
          <div className="workspace-tools-toggle"><IconButton icon="more" label={t("navigation.moreWorkspaceTools")} aria-expanded={toolsOpen}
            aria-controls={workspaceToolsId} onClick={(event) => {
              event.currentTarget.focus({ preventScroll: true });
              setToolsOpen((open) => !open);
            }} /></div>
          <div id={workspaceToolsId} className="workspace-tools-panel" role="group" aria-label={t("navigation.workspaceActions")}>
          {ontologySnapshot ? <IconButton menuLabel icon="list" className="review-entry" label={t("navigation.reviewChanges")}
            description={t("navigation.reviewChangesHelp")} aria-pressed={mode === "changes" && reviewView === "review"}
            onClick={() => { setToolsOpen(false); window.dispatchEvent(new Event("nodalstudio:change-review")); }} /> : null}
          <IconButton menuLabel icon="import" label={t("navigation.importDDL")} onClick={() => setDdlPreviewOpen(true)} description={t("navigation.openATemporaryPostgreSQLMySQLFileOrClipboard")} />
          {snapshot ? <IconButton menuLabel icon="preflight" label={t("navigation.structurePreflight")} aria-pressed={preflightOpen} onClick={() => setPreflightOpen(true)} description={t("navigation.checkTheEntireLoadedSnapshotWithDialectAware")} /> : null}
          {snapshot ? <SchemaReportExportAction key={snapshot.id} snapshot={snapshot} semantics={semanticsSnapshot === snapshot ? semantics : undefined} platform={platform} /> : null}
          </div>
          </div>
          {refreshOperation.state?.phase === "error" ? <div className="refresh-operation-result"><OperationFeedback label={t("navigation.snapshotRefresh")} state={refreshOperation.state} onRetry={() => void refreshActive()} retryLabel={t("navigation.retrySnapshotRefresh")} onDismiss={refreshOperation.dismiss} /></div> : null}
          {snapshot && runtime.data?.kind === "desktop" ? (
            <div className="refresh-tool">
              <IconButton
                icon="refresh"
                className="refresh-button"
                onClick={() => void refreshActive()}
                disabled={refreshState === "refreshing"}
                aria-busy={refreshState === "refreshing"}
                description={refreshState === "error" ? t("navigation.lastRefreshFailedTryRefreshingTheSchemaAgain") : t("navigation.refreshSchemaNow")}
                label={refreshState === "refreshing"
                  ? t("navigation.refreshingDetail")
                  : refreshState === "error"
                    ? t("navigation.retrySchemaRefresh")
                    : t("navigation.refreshSchema")}
              />
            </div>
          ) : null}
          <div className="app-tools">
            <IconButton
              icon="settings"
              label={t("navigation.openSettings")}
              description={settingsShortcut ? formatCommandShortcut(settingsShortcut) : undefined}
              onClick={(event) => {
                event.currentTarget.focus({ preventScroll: true });
                openSettings();
              }}
            />
            <IconButton icon="command" label={t("navigation.openCommandPalette")} description={t("navigation.commandPaletteP", { value0: formatCommandShortcut(COMMAND_PALETTE_SHORTCUT) })} aria-haspopup="dialog" onClick={(event) => {
              event.currentTarget.focus({ preventScroll: true });
              openCommandPalette();
            }} />
            <IconButton icon="bell" label={t("navigation.openNotifications")} description={notices.length ? t("navigation.notifications", { value0: notices.length }) : t("navigation.noNotifications")} className="notification-button" aria-expanded={noticesOpen} onClick={() => setNoticesOpen((value) => !value)}>{notices.length ? <b aria-hidden="true">{notices.length > 99 ? "99+" : notices.length}</b> : null}</IconButton>
          </div>
          {noticesOpen ? <section className="notification-popover" aria-label={t("settings.notifications")}><header><strong>{t("settings.notifications")}</strong><button type="button" onClick={() => setNotices([])}>{t("navigation.clear")}</button></header>{notices.length ? notices.map((notice) => <article key={notice.id}><strong>{notice.title}</strong><p>{notice.message}</p><small>{i18n.formatDate(notice.createdAt, "local", { timeStyle: "medium" })}</small>{notice.settingsCategory ? <button type="button" className="notification-update-action" onClick={() => openSettings(notice.settingsCategory)}>{t("navigation.viewUpdate")}</button> : null}</article>) : <p>{t("navigation.noNotificationsDetail")}</p>}</section> : null}
        </div>
        {modelInspectorVisible && <HeaderSidebarToggle
          side="right"
          expanded={preflightOpen ? preflightDetailsExpanded : rightPanel.expanded}
          onToggle={() =>
            preflightOpen ? setPreflightDetailsExpanded(value => !value) : setRightPanel((current) => ({ ...current, expanded: !current.expanded }))
          }
        />}
      </header>

      {showUpdateBanner && availableUpdate ? <UpdateBanner version={availableUpdate} onOpen={() => openSettings("updates")} onDismiss={() => setDismissedUpdate(availableUpdate)} /> : null}

      <section
        className="workspace"
        aria-label={t("navigation.nodalStudioWorkspace")}
        style={
          {
            "--left-sidebar-width": `${leftPanel.expanded ? leftPanel.width : 0}px`,
            "--right-sidebar-width": `${modelInspectorVisible && (preflightOpen ? preflightDetailsExpanded : rightPanel.expanded) ? rightPanel.width : 0}px`,
          } as CSSProperties
        }
      >
        <aside className="sidebar" hidden={!leftPanel.expanded}>
          <ConnectionPanel
            key={`${settings.app.connectionDefaults.databaseEngine}:${settings.app.connectionDefaults.sslMode}`}
            enabled={runtime.data?.kind === "desktop"}
            platform={platform}
            sourcesRevision={sourcesRevision}
            onSnapshot={handleCapture}
            onSourceSaved={(profile) => {
              void queryClient.resetQueries({ queryKey: ontologyDefinitionsKey({ sourceId: profile.id }) });
              setOpenQueryRequest((request) => request?.ontology?.draft.sourceId === profile.id ? undefined : request);
              setDataSources((current) => [...current.filter((source) => source.id !== profile.id), profile]);
            }}
            onSourceOpenStart={beginSourceOpen}
            onRefresh={snapshot && !historyPreview ? () => void refreshActive() : undefined}
            refreshDisabled={refreshState === "refreshing"}
            onSourceDeleted={(sourceId) => {
              queryClient.removeQueries({ queryKey: ontologyDefinitionsKey({ sourceId }) });
              clearSavedQueries(sourceId);
              setSavedQueryCatalog((catalog) => catalog?.sourceId === sourceId ? undefined : catalog);
              setDataSources((current) => current.filter((source) => source.id !== sourceId));
              setSqliteEditors((current) => current.filter((editor) => editor.target.sourceId !== sourceId));
              if (snapshot?.sourceId === sourceId) {
                setSnapshot(undefined);
                setChangeSet(undefined);
                setSelectedTable(undefined);
                setLocateRequest(undefined);
                setSemantics(emptySemantics);
                setSavedView(undefined);
              }
            }}
            defaultDatabaseType={settings.app.connectionDefaults.databaseEngine}
            defaultSslMode={settings.app.connectionDefaults.sslMode}
            activeSourceId={snapshot?.sourceId}
          >
            {snapshot ? (
              <SchemaTree
                navigation={runtime.data?.kind === "desktop" && mode !== "database" ? <ModelViewNavigation sourceId={snapshot.sourceId} views={semantics.savedViews} activeView={savedView}
                  disabled={historyPreview || semanticsSnapshot !== snapshot}
                  onApply={(view) => { setObjectDocument(undefined); setMode("explore"); setPreflightOpen(false); setRelationshipSearch(undefined); setSearchOpen(false); applyView(view); }} /> : undefined}
                snapshot={snapshot}
                databaseMode={mode === "database"}
                savedQueries={mode === "database" && querySupported && !historyPreview ? savedQueries : undefined}
                onOpenSavedQuery={openSavedQuery}
                onNewQuery={() => openSavedQuery()}
                onDeleteSavedQuery={deleteSavedQuery}
                rowCounts={tableRowCounts}
                selectedTable={selectedTable}
                selectedObject={mode === "database" ? databaseObject?.key : documentVisible ? documentObject?.key : undefined}
                onOpenObject={mode === "database" ? openDatabaseObject : openObjectDocument}
                onCloseObject={mode === "database" ? () => setDatabaseObjectSelection(undefined) : closeObjectDocument}
                onOpenView={mode === "database" && querySupported && !historyPreview ? (view) => openDatabaseObject(view.key) : undefined}
                onShowDefinition={mode === "database" ? (key) => openDatabaseObject(key, true) : undefined}
                onSelectTable={mode === "database" && querySupported && !historyPreview ? openTable : locateTable}
                onOpenTable={querySupported && !historyPreview ? openTable : undefined}
                onExportTable={postgresExport ? (table) => setDatabaseExport({ snapshot, target: { kind: "tableData", table } }) : undefined}
                onDumpSchema={postgresDump ? (schema, dumpMode) => setDatabaseExport({ snapshot, target: { kind: "sqlDump", schema, mode: dumpMode } }) : undefined}
                onOpenQuery={querySupported ? openTableInQuery : undefined}
              />
            ) : null}
          </ConnectionPanel>

        </aside>
        {databaseExport ? <DatabaseExportDialog platform={platform} snapshot={databaseExport.snapshot} target={databaseExport.target}
          onClose={() => setDatabaseExport(undefined)} /> : null}
        {showTableDdl && tableDdlScope === showTableDdl && browsableTable && countProfile && (
          <TableDdlDialog platform={platform} profile={countProfile} table={browsableTable} onClose={() => setShowTableDdl(undefined)} />
        )}

        <SidebarRail
          side="left"
          expanded={leftPanel.expanded}
          width={leftPanel.width}
          minWidth={LEFT_PANEL_LIMITS.min}
          maxWidth={LEFT_PANEL_LIMITS.max}
          onResize={(width) => setLeftPanel((current) => ({ ...current, width }))}
          onToggle={() =>
            setLeftPanel((current) => ({ ...current, expanded: !current.expanded }))
          }
        />

        <section className={`canvas-placeholder${(snapshot && mode === "explore") || mode === "database" ? " database-workspace" : ""}${mode === "changes" ? " changes-workspace" : ""}`}>
          <div className="canvas-workspace-content" inert={Boolean(activeRelationshipSearch)}>
          {snapshot && quickQueryRelation && <QuickQueryDock
            key={JSON.stringify([snapshot.sourceId, activeProfile?.updatedAt])}
            platform={platform} snapshot={snapshot} relation={quickQueryRelation} reset={quickQueryView.reset}
            onResult={(result, sql) => setQuickQueryView((current) => current.scope === quickQueryScope && current.reset === quickQueryView.reset
              ? { ...current, result: { result, sql } } : current)} />}
          {sqliteEditors.map((editor) => {
            const activeTable = mode === "database" && !databaseObject && activeSqliteEditor?.key === editor.key;
            const pageVisible = activeTable && !quickQueryResult;
            return (
              <div key={editor.key} className="table-data-host" hidden={!pageVisible}>
                <SqliteTableWorkspace platform={platform} target={editor.target} binding={editor.binding} activeTable={activeTable} pageVisible={pageVisible}
                  modelColumns={activeTable ? browsableTable?.columns : undefined}
                  onShowDdl={activeTable ? openTableDdl : undefined}
                  onRetainChange={retainSqliteEditor}
                  panelWidth={rowPanelWidth} onPanelWidthChange={resizeRowPanel} />
              </div>
            );
          })}
          {historyPreview && snapshot ? <div className="workspace-history-banner" role="status"><span>{t("navigation.historicalWorkspaceLayoutChangesAreTemporary")}</span><button type="button" onClick={() => { void returnToLatestModel().catch((reason: unknown) => publishNotice({ id: "return-latest-failed", title: t("navigation.unableToOpenLatestModel"), message: noticeReason(reason), createdAt: new Date().toISOString() })); }}>{t("navigation.returnToLatestModel")}</button></div> : null}
          {mode === "changes" ? <div className="changes-view-toolbar">
            <Segmented label={t("navigation.reviewView")} value={reviewView} onChange={setReviewView}
              options={[{ value: "review", label: t("navigation.currentReview") }, { value: "history", label: t("navigation.historyComparison") }]} />
          </div> : null}
          {!preflightOpen && mode === "changes" && reviewView === "history" && changeSet ? (
            <div className="changes-view-toolbar">
              <Segmented
                label={t("navigation.changesView")}
                value={changesView}
                options={[{ value: "list", label: t("navigation.changeList") }, { value: "diagram", label: t("navigation.diagram") }]}
                onChange={setChangesView}
              />
              <span title={`Before: ${changeSet.beforeSnapshotId}\nAfter: ${changeSet.afterSnapshotId}`}>
                {t("navigation.before")}{" "}{changeSet.beforeSnapshotId.slice(0, 8)} {t("navigation.after")}{" "}{changeSet.afterSnapshotId.slice(0, 8)}
              </span>
            </div>
          ) : null}
          {preflightMounted && snapshot ? <SchemaPreflightPanel key={JSON.stringify([snapshot.sourceId, snapshot.id, snapshot.fingerprint])} snapshot={snapshot} active={preflightOpen} detailHost={preflightDetailHost}
            onShowDetail={() => setPreflightDetailsExpanded(true)}
            onClose={() => setPreflightOpen(false)} onLocate={(key) => {
              const table = snapshot.schemas.flatMap((schema) => schema.tables).find((item) => item.key.schema === key.schema && item.key.name === key.name);
              if (table) locateSearchResult({ schema: key.schema, table, matchingColumns: [] });
            }} /> : null}
          {mode === "changes" && reviewView === "review" && snapshot ? (
            runtime.data?.kind === "desktop" && !historyPreview ? <ChangeReviewWorkspace platform={platform} sourceId={snapshot.sourceId} revision={JSON.stringify([snapshot.id, activeProfile?.updatedAt, reviewRefresh, semantics])} onChanged={refreshSemantics} onRefresh={() => void refreshActive()}
              onOntologyClosed={() => void queryClient.resetQueries({ queryKey: ontologyDefinitionsKey({ sourceId: snapshot.sourceId }) })}
              snapshot={ontologyRequiresNewerMySql ? undefined : ontologySnapshot} initialItemKey={ontologyReviewSelection?.sourceId === snapshot.sourceId ? `ontology:${ontologyReviewSelection.id}` : undefined}
              onOpenOntology={ontologySnapshot ? (id) => {
                setOntologySelection({ sourceId: ontologySnapshot.sourceId, id });
                setMode("ontology");
              } : undefined} onLocate={(key) => {
              const table = snapshot.schemas.flatMap(s => s.tables).find(t => t.key.schema === key.schema && (t.key.name === key.name || key.name.startsWith(`${t.key.name}.`)));
              if (table) locateSearchResult({ schema: table.key.schema, table, matchingColumns: [] });
              return Boolean(table);
            }} /> : <p>{i18n.locale === "zh-CN" ? "请返回桌面应用中的最新数据库模型进行复核。" : "Return to the latest connected desktop model to review changes."}</p>
          ) : mode === "ontology" ? (
            ontologySnapshot && !ontologyRequiresNewerMySql ? <OntologyWorkspace key={ontologySnapshot.sourceId} platform={platform} snapshot={ontologySnapshot}
              initialDefinitionId={ontologyDefinitionId} refreshing={refreshState === "refreshing"} onRefresh={() => void refreshActive()}
              onViewChanges={(id) => { setOntologyReviewSelection({ sourceId: ontologySnapshot.sourceId, id }); setReviewView("review"); setMode("changes"); }} onOpenQuery={(draft, target) => {
                if (!querySupported || draft.sourceId !== ontologySnapshot.sourceId || draft.snapshotId !== ontologySnapshot.id) return;
                setQueryDraftSeed(undefined);
                setOpenQueryRequest({ id: Date.now(), sourceId: draft.sourceId, sql: draft.sql, kind: "ontology", ontology: { draft, target } });
                setMode("query");
              }} /> : <EmptyState title={t(ontologyRequiresNewerMySql ? "ontology.mysqlVersionRequired" : "ontology.unavailable")} />
          ) : mode === "database" ? (
            snapshot && databaseDocument ? <ObjectDocument key={JSON.stringify([snapshot.sourceId, databaseDocument.key])} snapshot={snapshot}
              object={databaseDocument} backLabel={t(databaseDocument.key.kind === "view" && querySupported && !historyPreview ? "objects.openViewData" : "navigation.database")}
              onClose={closeDatabaseDocument} onSelect={openDatabaseObject} onSelectTable={querySupported && !historyPreview ? openTable : locateTable} />
            : !databaseObject && activeSqliteEditor && !quickQueryResult ? null : snapshot && previewRelation ? (
              <TableDataPreview key={JSON.stringify([snapshot.sourceId, activeProfile?.updatedAt, previewRelation.key])}
                platform={platform} snapshot={snapshot} table={previewRelation} connectionRevision={activeProfile?.updatedAt}
                onShowDdl={openTableDdl}
                quickQuery={quickQueryResult ? { ...quickQueryResult, onReturn: () => setQuickQueryView((current) => ({ scope: current.scope, reset: current.reset + 1 })) } : undefined}
                onShowDefinition={browsableView && (() => openDatabaseObject(browsableView.key, true))} />
            ) : <EmptyState className="table-data-empty" icon={<ActionIcon name="grid" />}
              title={t(runtime.data?.kind === "web" ? "tableData.desktopOnly" : historyPreview ? "tableData.latestModel" : snapshot ? "objects.chooseDatabaseObject" : "tableData.openDatabase")}
              description={snapshot && !historyPreview && runtime.data?.kind === "desktop" ? t("objects.chooseDatabaseObjectHint") : undefined} />
          ) : mode === "query" ? (
            <Suspense fallback={<div className="workspace-loading" role="status">{t("navigation.loadingWorkspace")}</div>}><QueryPage
              platform={platform}
              snapshot={snapshot}
              runtimeKind={runtime.data?.kind}
              settings={settings}
              semantics={semantics}
              selectedTable={historicalSelection ? undefined : selectedTable}
              draftSeed={queryDraftSeed}
              onOpenAiSettings={() => openSettings("ai")}
              ontology={queryOntologyScope ? {
                entries: queryOntology.data ?? [], loading: queryOntology.isPending,
                reload: () => { void queryOntology.refetch(); },
                review: (id) => {
                  setOntologyReviewSelection({ sourceId: queryOntologyScope.sourceId, id });
                  setReviewView("review"); setMode("changes");
                },
              } : undefined}
              ddlTarget={ddlTarget}
              onSchemaDdlCommitted={acceptSchemaDdl}
              openRequest={openQueryRequest}
              onConsumeOpenRequest={() => setOpenQueryRequest(undefined)}
              onSaveQuery={sourceId && querySupported && !historyPreview ? (name, sql, id) => {
                const outcome = saveNamedQuery(sourceId, name, sql, id);
                if ("query" in outcome) setSavedQueryCatalog({ sourceId, queries: listSavedQueries(sourceId) });
                return outcome;
              } : undefined}
            />
            </Suspense>
          ) : mode === "changes" && !changeSet ? (
            <ChangesEmptyState snapshot={snapshot} desktop={runtime.data?.kind === "desktop"}
              snapshotCount={discoveryLatest.data?.length ?? 0} loading={discoveryLatest.isPending} error={discoveryLatest.isError}
              refreshing={refreshState === "refreshing"}
              onHistory={() => { setRightPanel((panel) => ({ ...panel, expanded: true })); window.dispatchEvent(new Event("nodalstudio:inspect-history")); }}
              onRefresh={snapshot && !historyPreview ? () => { void refreshActive(); } : undefined}
              onRetry={() => { void discoveryLatest.refetch(); }} />
          ) : mode === "changes" && changeSet && snapshot && changesView === "list" ? (
            <SchemaChangesPanel
              key={changeSet.id}
              changeSet={changeSet}
              currentSnapshot={snapshot}
              platform={platform}
              runtimeKind={runtime.data?.kind}
            />
          ) : snapshot ? (
            <div className="object-canvas-host" style={documentVisible || preflightOpen ? { visibility: "hidden" } : undefined} inert={documentVisible || preflightOpen || Boolean(activeRelationshipSearch)}>
            <WorkspaceCanvas
              onOpenHistory={mode === "explore" ? () => {
                setRightPanel((panel) => ({ ...panel, expanded: true }));
                window.dispatchEvent(new Event("nodalstudio:inspect-history"));
              } : undefined}
              latestSnapshotId={discoveryLatest.data?.[0]?.id}
              refreshState={refreshState}
              interactionPaused={preflightOpen || ddlPreviewOpen || documentVisible || Boolean(activeRelationshipSearch)}
              platform={platform}
              runtimeKind={runtime.data?.kind}
              snapshot={snapshot}
              query={query}
              changeSet={mode === "changes" ? changeSet : undefined}
              modelTableChanges={modelTableChanges}
              onSelectTable={inspectTable}
              selectedTable={selectedTable}
              locateRequest={mode === "explore" ? locateRequest : undefined}
              onLocateComplete={finishLocate}
              navigationReady={semanticsSettledSnapshot === snapshot}
              semantics={semantics}
              onAddTablesToDomain={runtime.data?.kind === "desktop" && mode === "explore" && semanticsSnapshot === snapshot ? addTablesToDomain : undefined}
              savedView={savedView}
              temporaryViewKind={historyPreview ? "historical" : undefined}
              temporaryViewLabel={historyPreview ? t("navigation.historicalSnapshot") : undefined}
              onApplyView={!historyPreview ? applyView : undefined}
              onSaveView={!historyPreview ? saveModelView : undefined}
              onDeleteView={!historyPreview ? deleteModelView : undefined}
              onSaveLayout={saveCanvasLayout}
              layoutLoaded={semanticsSnapshot === snapshot}
              canvasSettings={settings.app.canvas}
              layoutWorkerTimeoutMs={settings.app.advanced.layoutWorkerTimeoutMs}
              highContrastRelations={settings.app.appearance.highContrastRelations}
              colorBlindPalette={settings.app.appearance.colorBlindPalette}
              renderDegradeThreshold={settings.app.advanced.renderDegradeThreshold}
              onOpenQuery={querySupported ? openTableInQuery : undefined}
              onValidateLogicalRelationship={runtime.data?.kind === "desktop" ? (input) => platform.validateLogicalRelationship(input) : undefined}
              onCreateLogicalRelationship={runtime.data?.kind === "desktop" ? createLogicalRelationship : undefined}
              onUpdateLogicalRelationship={runtime.data?.kind === "desktop" ? updateLogicalRelationship : undefined}
              onDeleteLogicalRelationship={runtime.data?.kind === "desktop" ? deleteLogicalRelationship : undefined}
              onIgnoreRelationshipInference={runtime.data?.kind === "desktop" ? ignoreRelationshipInference : undefined}
              onRestoreRelationshipInference={runtime.data?.kind === "desktop" ? restoreRelationshipInference : undefined}
              relationshipBatchApi={runtime.data?.kind === "desktop" ? relationshipBatchApi : undefined}
              onClearSearch={() => setQuery("")}
            />
            </div>
          ) : (
            <>
              <div className="canvas-grid" />
              <div className="hero-card">
                <p className="eyebrow">{t("navigation.eXPLORECHANGESHISTORY")}</p>
                <h2>{dataSources.length ? t("navigation.selectADatabaseToExplore") : t("navigation.yourDatabaseModelKeptVisible")}</h2>
                <p>
                  {dataSources.length
                    ? t("navigation.chooseASavedConnectionFromTheDatabasePicker")
                    : t("navigation.connectADatabaseToGenerateAnERMap")}
                </p>
              </div>
            </>
          )}
          {preflightMounted && !preflightOpen && snapshot && mode === "explore" ? <div className="preflight-resume ds-surface"><button onClick={() => setPreflightOpen(true)}>{t("preflight.resume")}</button></div> : null}
          {documentVisible && snapshot && documentObject ? <ObjectDocument key={JSON.stringify([snapshot.id, documentObject.key])} snapshot={snapshot} object={documentObject} onClose={closeObjectDocument} onSelect={openObjectDocument} onSelectTable={locateTable} /> : null}
          </div>
          {snapshot && activeRelationshipSearch && runtime.data?.kind === "desktop" ? <BusinessExplorer
            key={JSON.stringify([snapshot.id, activeRelationshipSearch.table.key, activeRelationshipSearch.question])}
            snapshot={snapshot} semantics={semantics} settings={settings} platform={platform} desktop
            initialTable={activeRelationshipSearch.table} initialQuestion={activeRelationshipSearch.question}
            sourceLabel={dataSources.find((source) => source.id === snapshot.sourceId)?.displayName}
            onDraftQuery={querySupported && snapshot.database.databaseType !== "sqlite" ? draftFromContext : undefined}
            onClose={() => {
              setRelationshipSearch(undefined);
              searchInputRef.current?.focus({ preventScroll: true });
              setSearchOpen(false);
            }}
            onLocate={locateTable}
            onExplain={(table) => { locateTable(table); setRightPanel((panel) => ({ ...panel, expanded: true })); setExplainRequest((value) => value + 1); }}
            onOpenSettings={() => openSettings("ai")}
          /> : null}
        </section>

        {modelInspectorVisible && <SidebarRail
          side="right"
          expanded={(preflightOpen ? preflightDetailsExpanded : rightPanel.expanded)}
          width={rightPanel.width}
          minWidth={RIGHT_PANEL_LIMITS.min}
          maxWidth={RIGHT_PANEL_LIMITS.max}
          onResize={(width) => setRightPanel((current) => ({ ...current, width }))}
          onToggle={() =>
            preflightOpen ? setPreflightDetailsExpanded(value => !value) : setRightPanel((current) => ({ ...current, expanded: !current.expanded }))
          }
        />}

        <aside className="inspector" aria-label={t("business.inspector")} hidden={!modelInspectorVisible || !(preflightOpen ? preflightDetailsExpanded : rightPanel.expanded)}>
          {/* changeSet is not gated on the view mode here: the canvas overlay is
              a rendering mode, while the History segment owns time whatever the
              main area happens to be showing. */}
          {documentVisible && documentObject ? <ObjectDocumentProperties key={JSON.stringify(documentObject.key)} object={documentObject} /> : null}
          <div className="inspector-page" ref={setPreflightDetailHost} hidden={!preflightOpen} />
          <div className="inspector-page" hidden={documentVisible || preflightOpen}>
          <InspectorPanel
            onOpenObject={openObjectDocument}
            columnFocus={columnFocus?.snapshot === snapshot && columnFocus?.table === selectedTable ? columnFocus : undefined}
            explainRequest={explainRequest}
            snapshot={snapshot}
            selectedTable={selectedTable}
            historicalSelection={historicalSelection}
            changeSet={changeSet}
            modelChangeSet={modelChangeSet}
            modelTableChange={currentTable ? modelTableChanges?.get(modelTableKey(currentTable.key)) : undefined}
            modelChangeRequest={modelChangeRequest}
            semantics={semanticsSnapshot === snapshot ? semantics : emptySemantics}
            settings={settings}
            runtime={runtime.data}
            platform={platform}
            historyRevision={snapshot?.id ?? ""}
            onSaveAnnotation={saveAnnotation}
            onSemanticsChange={changeSemantics}
            onRefreshSemantics={refreshSemantics}
            onApplyView={(view) => {
              setObjectDocument(undefined);
              setRelationshipSearch(undefined);
              setPreflightOpen(false);
              setSearchOpen(false);
              setMode("explore");
              applyView(view);
            }}
            historyPreview={historyPreview}
            onOpenQuery={querySupported && !historyPreview && !historicalSelection ? openTableInQuery : undefined}
            onOpenSettings={openSettings}
            onSelectSnapshot={handleHistorySnapshot}
            onCompareSnapshots={handleComparison}
            onReviewChanges={() => { setReviewView("history"); setMode("changes"); setChangesView("list"); }}
          />
          </div>
        </aside>
      </section>
      {settingsOpen ? (
        <Suspense fallback={<div className="page-loading-overlay" role="status">{t("navigation.loadingWorkspace")}</div>}><SettingsPage
          key={settingsCategory}
          platform={platform}
          settings={settings}
          runtime={runtime.data}
          connectionFolderStatus={connectionFolder.data}
          onConnectionFolderStatus={(status) => { queryClient.setQueryData(["connection-folder-status"], status); }}
          dataSources={dataSources}
          activeSourceId={snapshot?.sourceId}
          activeDatabase={snapshot?.database}
          initialCategory={settingsCategory}
          onClose={() => {
            setSettingsOpen(false);
            window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
          }}
          onUpdateApp={updateAppSettings}
          onUpdateSource={updateSourceSettings}
          onResetApp={async () => {
            await platform.resetAppSettings();
            resizeRowPanel(DEFAULT_ROW_PANEL_WIDTH);
            setSettings(await platform.getSettings(snapshot?.sourceId));
          }}
          onResetSource={async () => {
            if (!snapshot) return;
            setSettings(await platform.resetDataSourceSettings(snapshot.sourceId));
          }}
          onReload={async () => {
            // Settings failure must not leave imported or deleted knowledge eligible.
            await Promise.all([
              platform.getSettings(snapshot?.sourceId).then((next) => {
                if (activeSemanticSession.current === semanticSession) setSettings(next);
              }),
              refreshSemantics(),
              snapshot ? discoveryLatest.refetch() : Promise.resolve(),
            ]);
          }}
          onDataSourcesChanged={async () => {
            setSourcesRevision((current) => current + 1);
            setDataSources(await platform.listDataSources());
          }}
          onFactoryReset={() => {
            clearQuerySessions();
            clearSavedQueries();
            setSavedQueryCatalog(undefined);
            clearTableDataPreferences();
            setSqliteEditors([]);
            resizeRowPanel(DEFAULT_ROW_PANEL_WIDTH);
            setMode("explore");
            setOpenQueryRequest(undefined);
            setDatabaseObjectSelection(undefined);
            setSnapshot(undefined);
            setChangeSet(undefined);
            setSelectedTable(undefined);
            setLocateRequest(undefined);
            setSemantics(emptySemantics);
            setDataSources([]);
            setSettings(defaultEffectiveSettings());
            setSettingsOpen(false);
            return Promise.resolve();
          }}
        /></Suspense>
      ) : null}
      {commandPaletteOpen ? <CommandPalette commands={commands} onRun={runWorkspaceCommand} onClose={() => setCommandPaletteOpen(false)} /> : null}
    </main>
    {ddlMounted ? <div ref={ddlHost} className="ddl-session-host" hidden={!ddlPreviewOpen}><Suspense fallback={<div role="status">{t("navigation.loadingWorkspace")}</div>}><DdlImportPanel active={ddlPreviewOpen} canvasSettings={settings.app.canvas} runtimeKind={runtime.data?.kind} onReturn={() => setDdlPreviewOpen(false)} onClose={() => { setDdlPreviewOpen(false); setDdlMounted(false); }} /></Suspense></div> : null}
    </I18nProvider>
  );
}

type WorkspaceCommandId = "open-model" | "open-ontology" | "open-database" | "open-query" | "search" | "toggle-left" | "toggle-right" | "fit" | "view-all" | "focus-selected"
  | "relayout" | "ddl-preview" | "refresh" | "preflight" | "review" | "settings" | "settings-git" | "settings-ai" | "capabilities";

const COMMAND_PALETTE_SHORTCUT = "Mod+Shift+P";

function workspaceShortcutHint(label: string, shortcut?: string) {
  return shortcut ? {
    title: `${label} (${formatCommandShortcut(shortcut)})`,
    ariaKeyShortcuts: shortcut.replace("Mod", usesAppleKeyboard() ? "Meta" : "Control"),
  } : undefined;
}

function activeAppShortcut(binding: string | undefined, inQuery: boolean, workspaceShortcuts: (string | undefined)[]) {
  if (!binding) return undefined;
  const normalized = binding.trim().toLowerCase();
  if (workspaceShortcuts.some((shortcut) => shortcut?.toLowerCase() === normalized)) return undefined;
  const parts = normalized.split("+");
  const key = parts.pop();
  const mod = parts.includes("mod");
  const shift = parts.includes("shift");
  const alt = parts.includes("alt");
  if ((mod && shift && !alt && key === "p") || (inQuery && mod && !alt && ["r", "enter", "."].includes(key ?? ""))) {
    return undefined;
  }
  return binding;
}

function matchesShortcut(event: KeyboardEvent, binding: string) {
  const parts = binding.trim().toLowerCase().split("+");
  const key = parts.at(-1);
  const modifier = event.metaKey || event.ctrlKey;
  return (
    event.key.toLowerCase() === key &&
    modifier === parts.includes("mod") &&
    event.shiftKey === parts.includes("shift") &&
    event.altKey === parts.includes("alt")
  );
}

function isQuietHours(settings: AppSettings["notifications"]) {
  if (!settings.quietHoursEnabled) return false;
  const current = new Date().toTimeString().slice(0, 5);
  return settings.quietHoursStart <= settings.quietHoursEnd
    ? current >= settings.quietHoursStart && current < settings.quietHoursEnd
    : current >= settings.quietHoursStart || current < settings.quietHoursEnd;
}

function formatAppBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
