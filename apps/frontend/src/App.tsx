import { useQuery } from "@tanstack/react-query";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ConnectionPanel } from "./components/ConnectionPanel";
import { InspectorPanel } from "./components/InspectorPanel";
import { Segmented } from "./components/Segmented";
import { SchemaCanvas } from "./components/SchemaCanvas";
import { SchemaTree } from "./components/SchemaTree";
import { HeaderSidebarToggle, SidebarRail } from "./components/SidebarRail";
import type { SettingsCategory } from "./components/SettingsPage";
import { CommandPalette, type AppCommand } from "./components/CommandPalette";
import type { OpenQueryRequest } from "./components/query/QueryPage";
import { tablePreviewSql } from "./components/query/query-format";
import { searchSchema, type SchemaSearchResult } from "./graph/schema-search";
import { getPlatform } from "./platform";
import type {
  AppSettings,
  CaptureSnapshotResult,
  DataSourceProfile,
  DataSourceSettings,
  DatabaseSnapshot,
  EffectiveSettings,
  SavedView,
  SchemaChangeSet,
  SemanticBundle,
  SaveAnnotationInput,
  SaveLogicalRelationshipInput,
  LogicalRelationship,
  TableDefinition,
} from "./platform";
import { defaultEffectiveSettings } from "./platform";
import { migrateLegacySettings } from "./settings-migration";

const platform = getPlatform();
const SettingsPage = lazy(() => import("./components/SettingsPage").then((module) => ({ default: module.SettingsPage })));
const QueryPage = lazy(() => import("./components/query/QueryPage").then((module) => ({ default: module.QueryPage })));

type ViewMode = "explore" | "query" | "changes";
type AppNotice = { id: string; title: string; message: string; createdAt: string };

function noticeReason(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

type PanelPreference = {
  expanded: boolean;
  width: number;
};

const LEFT_PANEL_DEFAULT: PanelPreference = { expanded: true, width: 272 };
const RIGHT_PANEL_DEFAULT: PanelPreference = { expanded: true, width: 300 };
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
  const [snapshot, setSnapshot] = useState<DatabaseSnapshot>();
  const [changeSet, setChangeSet] = useState<SchemaChangeSet>();
  const [mode, setMode] = useState<ViewMode>("explore");
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [activeSearchResult, setActiveSearchResult] = useState(0);
  const [selectedTable, setSelectedTable] = useState<TableDefinition>();
  const [semantics, setSemantics] = useState<SemanticBundle>(emptySemantics);
  const [savedView, setSavedView] = useState<SavedView>();
  const [refreshState, setRefreshState] = useState<"idle" | "refreshing" | "error">("idle");
  const [leftPanel, setLeftPanel] = useState(LEFT_PANEL_DEFAULT);
  const [rightPanel, setRightPanel] = useState(RIGHT_PANEL_DEFAULT);
  const [settings, setSettings] = useState<EffectiveSettings>(() => defaultEffectiveSettings());
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsCategory, setSettingsCategory] = useState<SettingsCategory>("general");
  const [dataSources, setDataSources] = useState<DataSourceProfile[]>([]);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [notices, setNotices] = useState<AppNotice[]>([]);
  const [noticesOpen, setNoticesOpen] = useState(false);
  const [openQueryRequest, setOpenQueryRequest] = useState<OpenQueryRequest>();
  const searchInputRef = useRef<HTMLInputElement>(null);
  const autoConnectAttempted = useRef(false);
  const automaticUpdateChecked = useRef(false);
  const refreshInFlight = useRef(false);
  const runtime = useQuery({
    queryKey: ["runtime-info"],
    queryFn: () => platform.getRuntimeInfo(),
  });

  const schemaSearchResults = useMemo(() => searchSchema(snapshot, query), [query, snapshot]);

  const openSchemaSearch = useCallback(() => {
    setSettingsOpen(false);
    setMode("explore");
    setSearchOpen(true);
    window.requestAnimationFrame(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    });
  }, []);

  const locateSearchResult = useCallback((result: SchemaSearchResult) => {
    setMode("explore");
    setQuery("");
    setSearchOpen(false);
    setSavedView(undefined);
    setSelectedTable(result.table);
    const nodeId = `${result.schema}.${result.table.key.name}`;
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      window.dispatchEvent(new CustomEvent("nodalstudio:locate-table", { detail: { nodeId } }));
    }));
  }, []);

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
  const healthCheckFailing = useRef(false);

  const handleCapture = useCallback((result: CaptureSnapshotResult) => {
    setSnapshot(result.snapshot);
    setChangeSet(result.changeSet ?? undefined);
    setMode(result.changeSet ? "changes" : "explore");
    setSelectedTable(undefined);
    setSavedView(undefined);
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
        title: hasHighRisk ? "High-risk schema change" : "Schema changed",
        message: `${result.changeSet?.operations.length ?? 0} structural operations detected in ${result.snapshot.database.name}.`,
        createdAt: new Date().toISOString(),
      });
    }
  }, [publishNotice, settings.app.notifications, settings.source?.refresh.changeNotifications]);

  const refreshActive = useCallback(async (trigger: "manual" | "background" = "manual") => {
    if (!snapshot || refreshInFlight.current) return;
    refreshInFlight.current = true;
    setRefreshState("refreshing");
    try {
      const result = await platform.capturePostgresSnapshot(snapshot.sourceId, trigger);
      if (result.stored) handleCapture(result);
      setRefreshState("idle");
    } catch {
      setRefreshState("error");
    } finally {
      refreshInFlight.current = false;
    }
  }, [handleCapture, snapshot]);

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
        if (loaded.app.appearance.restoreSidebarState) {
          setLeftPanel({
            expanded: loaded.app.appearance.leftSidebarExpanded,
            width: loaded.app.appearance.leftSidebarWidth,
          });
          setRightPanel({
            expanded: loaded.app.appearance.rightSidebarExpanded,
            width: loaded.app.appearance.rightSidebarWidth,
          });
        }
        setSettingsLoaded(true);
      })
      .catch((reason: unknown) => {
        // Carry on with defaults so the app still renders, but say so: silently
        // substituting them makes a load failure indistinguishable from a fresh
        // install, and the defaults include the privacy and cloud posture.
        if (!active) return;
        setSettingsLoaded(true);
        publishNoticeRef.current({
          id: "settings-load-failed",
          title: "Stored settings could not be loaded",
          message: `Running with default settings, including default privacy and cloud options. ${noticeReason(reason)}`,
          createdAt: new Date().toISOString(),
        });
      });
    return () => {
      active = false;
    };
  }, [snapshot?.sourceId]);

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
    document.documentElement.lang = settings.app.general.language === "zhCn" ? "zh-CN" : settings.app.general.language === "en" ? "en" : navigator.language;
    document.documentElement.dataset.density = settings.app.appearance.density;
    document.documentElement.dataset.reduceMotion = String(settings.app.appearance.reduceMotion);
    document.documentElement.dataset.highContrastRelations = String(settings.app.appearance.highContrastRelations);
    document.documentElement.dataset.colorBlindPalette = String(settings.app.appearance.colorBlindPalette);
    document.documentElement.style.setProperty("--ui-font-size", `${settings.app.appearance.uiFontSize}px`);
    document.documentElement.style.setProperty("--node-font-size", `${settings.app.appearance.nodeFontSize}px`);
    document.documentElement.style.setProperty("--monospace-font-size", `${settings.app.appearance.monospaceFontSize}px`);
    document.body.style.setProperty("zoom", String(settings.app.general.uiScalePercent / 100));
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
          title: "Data sources could not be listed",
          message: `Existing connections are not shown — they have not been removed. ${noticeReason(reason)}`,
          createdAt: new Date().toISOString(),
        });
      });
  }, [runtime.data?.kind]);

  useEffect(() => {
    if (
      autoConnectAttempted.current ||
      !settingsLoaded ||
      snapshot ||
      runtime.data?.kind !== "desktop" ||
      dataSources.length === 0
    ) return;
    autoConnectAttempted.current = true;
    void Promise.all(
      dataSources.map(async (profile) => ({
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
        if (!candidate) return;
        const result = await platform.capturePostgresSnapshot(candidate.profile.id, "background");
        handleCapture(result);
      })
      .catch(() => setRefreshState("error"));
  }, [dataSources, handleCapture, runtime.data?.kind, settings.app.general.lastSourceId, settings.app.general.reopenLastWorkspace, settings.app.general.startPage, settingsLoaded, snapshot]);

  useEffect(() => {
    if (!settingsLoaded || runtime.data?.kind !== "desktop" || !snapshot) return;
    if (
      settings.app.general.lastSourceId === snapshot.sourceId &&
      settings.app.general.lastViewMode === mode
    ) return;
    const next = {
      ...settings.app,
      general: {
        ...settings.app.general,
        lastSourceId: snapshot.sourceId,
        lastViewMode: mode,
      },
    };
    const timer = window.setTimeout(() => {
      void platform.updateAppSettings(next).then((effective) => setSettings(effective));
    }, 300);
    return () => window.clearTimeout(timer);
  }, [mode, runtime.data?.kind, settings.app, settingsLoaded, snapshot]);

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
        publishNotice({ id: "storage-warning", title: "Local storage warning", message: `Nodal Studio local data uses ${formatAppBytes(totalBytes)}.`, createdAt: new Date().toISOString() });
      }
      if (!snapshot || !settings.source) return;
      if (settings.app.notifications.cloudFailures) {
        const queue = await platform.listSyncDiagnostics(snapshot.sourceId);
        if (active && queue.some((item) => item.state === "conflict" || item.attempts > 0)) {
          publishNotice({ id: `cloud-queue-${snapshot.sourceId}`, title: "Cloud sync needs attention", message: `${queue.length} queued item(s), including failed or conflicted metadata.`, createdAt: new Date().toISOString() });
        }
      }
      if (settings.app.notifications.gitConflicts && settings.source.git.repositoryPath) {
        const git = await platform.checkMergeDriver(snapshot.sourceId, settings.source.git.repositoryPath);
        if (active && (git.fingerprintMatches === false || git.conflictReports.length > 0)) {
          publishNotice({ id: `git-conflict-${snapshot.sourceId}`, title: "Git semantics need attention", message: git.conflictReports.length ? `${git.conflictReports.length} unresolved semantic conflict report(s).` : "Git workspace fingerprint differs from the active Snapshot.", createdAt: new Date().toISOString() });
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
            title: "Background checks are not running",
            message: `Storage, cloud sync and Git conflict warnings are paused until this recovers. ${noticeReason(reason)}`,
            createdAt: new Date().toISOString(),
          });
        });
    }
    runHealthCheck();
    const timer = window.setInterval(runHealthCheck, 60_000);
    if (
      !automaticUpdateChecked.current &&
      settings.app.updates.automaticChecks &&
      settings.app.updates.customFeedUrl &&
      !settings.app.privacy.offlineMode
    ) {
      automaticUpdateChecked.current = true;
      void platform.checkForUpdates().then((result) => {
        if (active && result.availableVersion && settings.app.notifications.updateAvailable) {
          publishNotice({ id: `update-${result.availableVersion}`, title: "Application update available", message: `Nodal Studio ${result.availableVersion} is available on the ${settings.app.updates.channel} channel.`, createdAt: new Date().toISOString() });
        }
      }).catch(() => undefined);
    }
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [publishNotice, runtime.data?.kind, settings.app.history.storageWarningMegabytes, settings.app.notifications.cloudFailures, settings.app.notifications.gitConflicts, settings.app.notifications.storageWarnings, settings.app.notifications.updateAvailable, settings.app.privacy.offlineMode, settings.app.updates.automaticChecks, settings.app.updates.channel, settings.app.updates.customFeedUrl, settings.source, settingsLoaded, snapshot]);

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

  useEffect(() => {
    function handleShortcut(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (
        !event.metaKey &&
        !event.ctrlKey &&
        (target?.matches("input, textarea, select, [contenteditable='true']") ?? false)
      ) {
        return;
      }
      const bindings = settings.app.shortcuts.bindings;
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "p") {
        event.preventDefault();
        setCommandPaletteOpen(true);
        return;
      }
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === "f") {
        event.preventDefault();
        openSchemaSearch();
        return;
      }
      const actions: Array<[string | undefined, () => void]> = [
        [bindings.openSettings, () => {
          setSettingsCategory("general");
          setSettingsOpen(true);
          window.history.replaceState(null, "", "#/settings/general");
        }],
        [bindings.focusSearch, openSchemaSearch],
        [bindings.refreshSchema, () => void refreshActive()],
        [bindings.toggleLeftSidebar, () => setLeftPanel((value) => ({ ...value, expanded: !value.expanded }))],
        [bindings.toggleRightInspector, () => setRightPanel((value) => ({ ...value, expanded: !value.expanded }))],
        [bindings.fitCanvas, () => window.dispatchEvent(new Event("nodalstudio:fit-canvas"))],
        [bindings.focusSelectedTable, () => window.dispatchEvent(new Event("nodalstudio:focus-selected-table"))],
        [bindings.relayoutCanvas, () => window.dispatchEvent(new Event("nodalstudio:relayout-canvas"))],
      ];
      const action = actions.find(([binding]) => binding && matchesShortcut(event, binding));
      if (!action) return;
      event.preventDefault();
      action[1]();
    }
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [openSchemaSearch, refreshActive, settings.app.shortcuts.bindings]);

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

  function openSettings(category: SettingsCategory = "general") {
    setSettingsCategory(category);
    setSettingsOpen(true);
    window.history.replaceState(null, "", `#/settings/${category}`);
  }

  const commands: AppCommand[] = [
    { id: "settings", label: "Open Settings", keywords: "preferences general", shortcut: "Mod+,", run: () => openSettings() },
    { id: "settings-git", label: "Open Git Settings", keywords: "repository merge conflict", run: () => openSettings("git") },
    { id: "settings-ai", label: "Open AI Settings", keywords: "provider model explanation", run: () => openSettings("ai") },
    { id: "refresh", label: "Refresh schema", keywords: "database capture", shortcut: settings.app.shortcuts.bindings.refreshSchema, run: () => void refreshActive() },
    { id: "toggle-left", label: "Toggle left sidebar", keywords: "collapse structure", shortcut: settings.app.shortcuts.bindings.toggleLeftSidebar, run: () => setLeftPanel((value) => ({ ...value, expanded: !value.expanded })) },
    { id: "toggle-right", label: "Toggle right inspector", keywords: "collapse details", shortcut: settings.app.shortcuts.bindings.toggleRightInspector, run: () => setRightPanel((value) => ({ ...value, expanded: !value.expanded })) },
    { id: "fit", label: "Fit ER canvas", keywords: "zoom model", shortcut: settings.app.shortcuts.bindings.fitCanvas, run: () => window.dispatchEvent(new Event("nodalstudio:fit-canvas")) },
    { id: "view-all", label: "View all database tables", keywords: "global overview exit focus", run: () => window.dispatchEvent(new Event("nodalstudio:view-all-tables")) },
    { id: "focus-selected", label: "Focus selected table", keywords: "isolate relationship table", shortcut: settings.app.shortcuts.bindings.focusSelectedTable, run: () => window.dispatchEvent(new Event("nodalstudio:focus-selected-table")) },
    { id: "relayout", label: "Re-layout ER canvas", keywords: "automatic layout", shortcut: settings.app.shortcuts.bindings.relayoutCanvas, run: () => window.dispatchEvent(new Event("nodalstudio:relayout-canvas")) },
  ];

  useEffect(() => {
    if (!snapshot) return;
    let active = true;
    void platform
      .getSemantics(snapshot.sourceId)
      .then((bundle) => {
        if (active) setSemantics(bundle);
      })
      .catch((reason: unknown) => {
        // An empty semantic model and one that failed to load look identical in
        // the Knowledge panel, so the annotations, domain groups and saved views
        // would appear to have been lost rather than to be unavailable.
        if (!active) return;
        setSemantics(emptySemantics);
        publishNoticeRef.current({
          id: `semantics-load-failed-${snapshot.sourceId}`,
          title: "Semantic model could not be loaded",
          message: `Annotations, domain groups and saved views are unavailable for this snapshot — they have not been deleted. ${noticeReason(reason)}`,
          createdAt: new Date().toISOString(),
        });
      });
    return () => {
      active = false;
    };
  }, [snapshot]);

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
    const annotation = await platform.saveAnnotation(input);
    setSemantics((current) => ({
      ...current,
      annotations: [
        annotation,
        ...current.annotations.filter(
          (item) =>
            item.objectKey.kind !== annotation.objectKey.kind ||
            item.objectKey.schema !== annotation.objectKey.schema ||
            item.objectKey.name !== annotation.objectKey.name,
        ),
      ],
    }));
  }

  const upsertLogicalRelationship = useCallback((relationship: LogicalRelationship) => {
    setSemantics((current) => ({
      ...current,
      logicalRelationships: [
        relationship,
        ...current.logicalRelationships.filter((item) => item.id !== relationship.id),
      ],
    }));
  }, []);

  const createLogicalRelationship = useCallback(async (input: SaveLogicalRelationshipInput) => {
    const relationship = await platform.createLogicalRelationship(input);
    upsertLogicalRelationship(relationship);
    return relationship;
  }, [upsertLogicalRelationship]);

  const updateLogicalRelationship = useCallback(async (input: SaveLogicalRelationshipInput) => {
    const relationship = await platform.updateLogicalRelationship(input);
    upsertLogicalRelationship(relationship);
    return relationship;
  }, [upsertLogicalRelationship]);

  const deleteLogicalRelationship = useCallback(async (relationshipId: string) => {
    if (!snapshot) return;
    const deleted = await platform.deleteLogicalRelationship(snapshot.sourceId, relationshipId);
    if (deleted) {
      setSemantics((current) => ({
        ...current,
        logicalRelationships: current.logicalRelationships.filter((item) => item.id !== relationshipId),
      }));
    }
  }, [snapshot]);

  const ignoreRelationshipInference = useCallback(async (relationshipKey: string) => {
    if (!snapshot) return;
    const ignored = await platform.ignoreRelationshipInference(snapshot.sourceId, relationshipKey);
    setSemantics((current) => ({
      ...current,
      ignoredRelationshipInferences: [
        ignored,
        ...current.ignoredRelationshipInferences.filter((item) => item.relationshipKey !== relationshipKey),
      ],
    }));
  }, [snapshot]);

  const saveCanvasLayout = useCallback((positions: Record<string, import("./platform/types").CanvasNodeLayout>) => {
    if (!snapshot) return;
    void platform.saveLayout(snapshot.sourceId, null, positions)
      .catch(() => {
        // The in-memory auto layout remains usable when persistence is unavailable.
      });
  }, [snapshot]);

  function handleHistorySnapshot(historySnapshot: DatabaseSnapshot) {
    setSnapshot(historySnapshot);
    setChangeSet(undefined);
    // Viewing an older snapshot is the ordinary canvas with different data, not
    // a mode of its own — "history" never had a branch in the main area.
    setMode("explore");
    setSelectedTable(undefined);
    setSavedView(undefined);
  }

  function handleComparison(afterSnapshot: DatabaseSnapshot, comparison: SchemaChangeSet) {
    setSnapshot(afterSnapshot);
    setChangeSet(comparison);
    setMode("changes");
    setSelectedTable(undefined);
    setSavedView(undefined);
  }

  const openTableInQuery = useCallback((table: TableDefinition) => {
    setOpenQueryRequest({ id: Date.now(), sql: tablePreviewSql(table) });
    setMode("query");
  }, []);

  return (
    <Suspense fallback={<main className="app-shell"><p>Loading workspace…</p></main>}>
    <main className="app-shell">
      <header className="topbar">
        <HeaderSidebarToggle
          side="left"
          expanded={leftPanel.expanded}
          onToggle={() =>
            setLeftPanel((current) => ({ ...current, expanded: !current.expanded }))
          }
        />
        <div className="brand-block">
          <p className="eyebrow">LIVING SYSTEM BLUEPRINT</p>
          <h1>Nodal Studio</h1>
        </div>
        <Segmented
          label="View mode"
          value={mode}
          onChange={setMode}
          options={[
            { value: "explore", label: "Database" },
            {
              value: "query",
              label: "Query",
              disabled: runtime.data?.kind === "web",
              title: runtime.data?.kind === "web" ? "Query requires the desktop app" : undefined,
            },
            { value: "changes", label: "Changes", disabled: !changeSet },
          ]}
        />
        <label className="global-search">
          <span>Search schema</span>
          <input
            ref={searchInputRef}
            type="search"
            placeholder="Table, field, schema…"
            value={query}
            onFocus={() => setSearchOpen(true)}
            onBlur={() => window.setTimeout(() => setSearchOpen(false), 120)}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveSearchResult(0);
              setSearchOpen(true);
              if (mode !== "explore") setMode("explore");
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setSearchOpen(false);
                setQuery("");
                event.currentTarget.blur();
              } else if (event.key === "ArrowDown" && schemaSearchResults.length) {
                event.preventDefault();
                setActiveSearchResult((value) => (value + 1) % schemaSearchResults.length);
              } else if (event.key === "ArrowUp" && schemaSearchResults.length) {
                event.preventDefault();
                setActiveSearchResult((value) => (value - 1 + schemaSearchResults.length) % schemaSearchResults.length);
              } else if (event.key === "Enter" && schemaSearchResults[activeSearchResult]) {
                event.preventDefault();
                locateSearchResult(schemaSearchResults[activeSearchResult]);
              }
            }}
            disabled={!snapshot}
          />
          {searchOpen && query.trim() ? <div className="global-search-results" role="listbox" aria-label="Schema search results">
            {schemaSearchResults.length ? schemaSearchResults.map((result, index) => <button
              type="button"
              role="option"
              aria-selected={index === activeSearchResult}
              key={`${result.schema}.${result.table.key.name}`}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => locateSearchResult(result)}
            >
              <strong>{result.table.key.name}</strong>
              <span>{result.schema}{result.matchingColumns.length ? ` · ${result.matchingColumns.slice(0, 3).join(", ")}` : ""}</span>
            </button>) : <p>No matching tables or fields</p>}
          </div> : null}
        </label>
        <div className="runtime-actions">
          {snapshot && runtime.data?.kind === "desktop" ? (
            <button
              type="button"
              className="refresh-button"
              onClick={() => void refreshActive()}
              disabled={refreshState === "refreshing"}
              title={refreshState === "error" ? "Last refresh failed" : "Refresh schema now"}
            >
              {refreshState === "refreshing"
                ? "Refreshing…"
                : refreshState === "error"
                  ? "Retry refresh"
                  : "Refresh"}
            </button>
          ) : null}
          <span className="runtime-badge" data-testid="runtime-badge">
            {runtime.isPending ? "Detecting runtime…" : runtime.data?.label}
          </span>
          <button
            type="button"
            className="settings-button"
            aria-label="Open Settings"
            title="Settings (⌘,)"
            onClick={() => openSettings()}
          >
            ⚙
          </button>
          <button type="button" className="command-button" aria-label="Open command palette" title="Command palette (⌘⇧P)" onClick={() => setCommandPaletteOpen(true)}>⌘</button>
          <button type="button" className="notification-button" aria-label="Open notifications" onClick={() => setNoticesOpen((value) => !value)}>●{notices.length ? <b>{notices.length}</b> : null}</button>
          {noticesOpen ? <section className="notification-popover" aria-label="Notifications"><header><strong>Notifications</strong><button type="button" onClick={() => setNotices([])}>Clear</button></header>{notices.length ? notices.map((notice) => <article key={notice.id}><strong>{notice.title}</strong><p>{notice.message}</p><small>{new Date(notice.createdAt).toLocaleTimeString()}</small></article>) : <p>No notifications.</p>}</section> : null}
        </div>
        <HeaderSidebarToggle
          side="right"
          expanded={rightPanel.expanded}
          onToggle={() =>
            setRightPanel((current) => ({ ...current, expanded: !current.expanded }))
          }
        />
      </header>

      <section
        className="workspace"
        aria-label="Nodal Studio workspace"
        style={
          {
            "--left-sidebar-width": `${leftPanel.expanded ? leftPanel.width : 0}px`,
            "--right-sidebar-width": `${rightPanel.expanded ? rightPanel.width : 0}px`,
          } as CSSProperties
        }
      >
        <aside className="sidebar" hidden={!leftPanel.expanded}>
          <ConnectionPanel
            key={`${settings.app.connectionDefaults.databaseEngine}:${settings.app.connectionDefaults.sslMode}`}
            enabled={runtime.data?.kind === "desktop"}
            platform={platform}
            onSnapshot={handleCapture}
            onSourceDeleted={(sourceId) => {
              setDataSources((current) => current.filter((source) => source.id !== sourceId));
              if (snapshot?.sourceId === sourceId) {
                setSnapshot(undefined);
                setChangeSet(undefined);
                setSelectedTable(undefined);
                setSemantics(emptySemantics);
                setSavedView(undefined);
              }
            }}
            defaultDatabaseType={settings.app.connectionDefaults.databaseEngine}
            defaultSslMode={settings.app.connectionDefaults.sslMode}
          />
          {snapshot ? (
            <>
              <SchemaTree snapshot={snapshot} selectedTable={selectedTable} onSelectTable={setSelectedTable} />
            </>
          ) : null}
        </aside>

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

        <section className="canvas-placeholder">
          {mode === "query" ? (
            <QueryPage
              platform={platform}
              snapshot={snapshot}
              runtimeKind={runtime.data?.kind}
              openRequest={openQueryRequest}
              onConsumeOpenRequest={() => setOpenQueryRequest(undefined)}
            />
          ) : snapshot ? (
            <SchemaCanvas
              snapshot={snapshot}
              query={query}
              changeSet={mode === "changes" ? changeSet : undefined}
              onSelectTable={setSelectedTable}
              selectedTable={selectedTable}
              semantics={semantics}
              savedView={savedView}
              onSaveLayout={saveCanvasLayout}
              canvasSettings={settings.app.canvas}
              layoutWorkerTimeoutMs={settings.app.advanced.layoutWorkerTimeoutMs}
              highContrastRelations={settings.app.appearance.highContrastRelations}
              colorBlindPalette={settings.app.appearance.colorBlindPalette}
              renderDegradeThreshold={settings.app.advanced.renderDegradeThreshold}
              onOpenQuery={runtime.data?.kind === "desktop" ? openTableInQuery : undefined}
              onValidateLogicalRelationship={runtime.data?.kind === "desktop" ? (input) => platform.validateLogicalRelationship(input) : undefined}
              onCreateLogicalRelationship={runtime.data?.kind === "desktop" ? createLogicalRelationship : undefined}
              onUpdateLogicalRelationship={runtime.data?.kind === "desktop" ? updateLogicalRelationship : undefined}
              onDeleteLogicalRelationship={runtime.data?.kind === "desktop" ? deleteLogicalRelationship : undefined}
              onIgnoreRelationshipInference={runtime.data?.kind === "desktop" ? ignoreRelationshipInference : undefined}
              onClearSearch={() => setQuery("")}
            />
          ) : (
            <>
              <div className="canvas-grid" />
              <div className="hero-card">
                <p className="eyebrow">EXPLORE · CHANGES · HISTORY</p>
                <h2>Your database model, kept visible.</h2>
                <p>
                  Connect a read-only PostgreSQL source to generate an ER map and track
                  every schema change over time.
                </p>
              </div>
            </>
          )}
        </section>

        <SidebarRail
          side="right"
          expanded={rightPanel.expanded}
          width={rightPanel.width}
          minWidth={RIGHT_PANEL_LIMITS.min}
          maxWidth={RIGHT_PANEL_LIMITS.max}
          onResize={(width) => setRightPanel((current) => ({ ...current, width }))}
          onToggle={() =>
            setRightPanel((current) => ({ ...current, expanded: !current.expanded }))
          }
        />

        <aside className="inspector" hidden={!rightPanel.expanded}>
          <InspectorPanel
            snapshot={snapshot}
            selectedTable={selectedTable}
            changeSet={mode === "changes" ? changeSet : undefined}
            semantics={semantics}
            settings={settings}
            runtime={runtime.data}
            platform={platform}
            historyRevision={snapshot?.id ?? ""}
            onSaveAnnotation={saveAnnotation}
            onSemanticsChange={setSemantics}
            onApplyView={setSavedView}
            onOpenQuery={runtime.data?.kind === "desktop" ? openTableInQuery : undefined}
            onOpenSettings={openSettings}
            onSelectSnapshot={handleHistorySnapshot}
            onCompareSnapshots={handleComparison}
          />
        </aside>
      </section>
      {settingsOpen ? (
        <SettingsPage
          key={settingsCategory}
          platform={platform}
          settings={settings}
          runtime={runtime.data}
          dataSources={dataSources}
          activeSourceId={snapshot?.sourceId}
          initialCategory={settingsCategory}
          onClose={() => {
            setSettingsOpen(false);
            window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
          }}
          onUpdateApp={updateAppSettings}
          onUpdateSource={updateSourceSettings}
          onResetApp={async () => {
            await platform.resetAppSettings();
            setSettings(await platform.getSettings(snapshot?.sourceId));
          }}
          onResetSource={async () => {
            if (!snapshot) return;
            setSettings(await platform.resetDataSourceSettings(snapshot.sourceId));
          }}
          onReload={async () => setSettings(await platform.getSettings(snapshot?.sourceId))}
          onDataSourcesChanged={async () => setDataSources(await platform.listDataSources())}
          onFactoryReset={() => {
            setSnapshot(undefined);
            setChangeSet(undefined);
            setSelectedTable(undefined);
            setSemantics(emptySemantics);
            setDataSources([]);
            setSettings(defaultEffectiveSettings());
            setSettingsOpen(false);
            return Promise.resolve();
          }}
        />
      ) : null}
      {commandPaletteOpen ? <CommandPalette commands={commands} onClose={() => setCommandPaletteOpen(false)} /> : null}
    </main>
    </Suspense>
  );
}

function matchesShortcut(event: KeyboardEvent, binding: string) {
  const parts = binding.toLowerCase().split("+");
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
