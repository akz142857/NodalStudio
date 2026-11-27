import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type RefObject } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "../../design-system/Button";
import { ActionIcon, type ActionIconName } from "../ActionIcon";
import { IconButton } from "../IconButton";
import { SchemaObjectMenu } from "../SchemaObjectMenu";
import { Segmented } from "../Segmented";
import { SidebarRail } from "../SidebarRail";
import { EmptyState } from "../../design-system/EmptyState";
import { ModalSurface } from "../../design-system/ModalSurface";
import { useI18n } from "../../i18n";
import type {
  CodeDefinitionPosition, CodeDefinitionRequest, CodeDefinitionTarget, CodeReviewChange, CodeReviewCompactFolders, CodeReviewDirectory, CodeReviewDocument,
  CodeExtension, CodeExtensionPlatform, CodeReviewPlatform, CodeReviewProject, CodeReviewVersion, CodeSearchMatch,
} from "../../platform/code-review";
import { CodeFileIcon, CodeReviewReader, type DefinitionArrival, type DefinitionGesture, type ReadingPosition } from "./CodeReviewReader";
import { CodeReviewOutline } from "./CodeReviewOutline";
import { CodeReviewChecks } from "./CodeReviewChecks";
import { CodeReviewExtensions, type ExtensionActivity } from "./CodeReviewExtensions";
import { checkTargetProblem, isEslintSource, normalizeReviewText, type CheckFinding, type EslintAvailability, type ReadingMode } from "./code-review-checks";
import { useCodeReviewChecks, type CheckedFile, type DisplayedCheckTarget } from "./use-code-review-checks";
import { CodeQuickOpen } from "./CodeQuickOpen";
import { CodePanelDivider } from "./CodePanelDivider";
import { supportsCodeNavigation } from "./code-review-file-types";
import { reviewHistory, reviewNoteDraft, saveReviewDraft, saveReviewNote, type ReviewNote } from "./code-review-notes";
import { isCodeContextMenuKey, useCodeContextMenu } from "./use-code-context-menu";
import "./code-review.css";

const workspaceKey = ["code-review"] as const;
const currentKey = [...workspaceKey, "current"] as const;
const compactFoldersKey = "nodalstudio:code-review:compact-folders";
const basename = (path: string) => path.split("/").at(-1) ?? path;
const folderName = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));
const textFor = (version: CodeReviewVersion | null | undefined) => version?.state === "text" ? version.text : undefined;
const noChanges: readonly CodeReviewChange[] = [];

type CodeSidebarProps = { sidebarId: string; sidebarOpen: boolean; setSidebarOpen: (open: boolean) => void };
type CodeOutlineProps = { outlineId: string; outlineOpen: boolean };
type CodeSearchProps = { searchAnchor?: RefObject<HTMLButtonElement | null> };
type NavigatorView = "changes" | "files" | "search" | "extensions";
type NoteStatus = ReviewNote["status"] | "recheck" | "pending";
type ReviewDock = "checks" | "note";
type RenderDock = (current?: DisplayedCheckTarget, note?: React.ReactNode) => React.ReactNode;
type RenderStatus = (status?: NoteStatus) => React.ReactNode;
function fileReviewStatus(history: ReviewNote[], evidence: string): NoteStatus {
  return history.find((entry) => entry.evidence === evidence)?.status ?? (history.length ? "recheck" : "pending");
}

export function CodeReviewWorkspace({ api, allowDefinitions = true, allowExtensions = false, extensionsOffline = false,
  eslintAvailability = "eslintUnavailable", outlineId, outlineOpen, searchAnchor, ...sidebarProps }: {
  api: CodeReviewPlatform;
  allowDefinitions?: boolean;
  allowExtensions?: boolean;
  extensionsOffline?: boolean;
  eslintAvailability?: EslintAvailability;
} & CodeSidebarProps & CodeOutlineProps & CodeSearchProps) {
  const { t } = useI18n();
  const client = useQueryClient();
  const project = useQuery({ queryKey: currentKey, queryFn: () => api.current(), retry: false, staleTime: Infinity });
  const [searchAfterPick, setSearchAfterPick] = useState<string>();
  const [outlineWidth, setOutlineWidth] = useState(224);
  const { mutate: pick, isPending: picking, isError: pickFailed } = useMutation<CodeReviewProject | null, Error, boolean>({
    mutationFn: () => api.choose(),
    onSuccess: (result, search) => {
      if (!result) return;
      setSearchAfterPick(search ? result.id : undefined);
      client.setQueryData(currentKey, result);
    },
  });
  useEffect(() => {
    if (project.isPending || project.data || picking) return;
    const open = () => pick(true);
    window.addEventListener("nodalstudio:code-quick-open", open);
    return () => window.removeEventListener("nodalstudio:code-quick-open", open);
  }, [project.isPending, project.data, picking, pick]);
  const choose = project.data
    ? <IconButton icon="folder" className="code-review-tool" label={t("codeReview.switchProject")} disabled={picking} onClick={() => pick(false)} />
    : <Button variant="primary" busy={picking} onClick={() => pick(false)}><ActionIcon name="folder" />{t("codeReview.openFolder")}</Button>;
  const renderOutline = (outline?: React.ReactNode) => outlineOpen && <>
    <CodePanelDivider orientation="vertical" panelId={outlineId} label={t("codeReview.outline")}
      size={outlineWidth} min={132} max={480} ratio={0.48} onResize={setOutlineWidth} />
    <aside id={outlineId} className="code-outline" aria-label={t("codeReview.outline")} style={{ width: outlineWidth }}>
      <header><h3>{t("codeReview.outline")}</h3></header>
      <div className="code-outline-scroll">{outline ?? <p>{t("codeReview.outlineSelectFile")}</p>}</div>
    </aside>
  </>;

  return <section className="code-review ds-surface" aria-label={t("codeReview.title")}>
    {pickFailed && <p className="code-review-notice" role="alert">{t("codeReview.openFailed")}</p>}
    {project.isPending ? <p className="code-review-status" role="status">{t("navigation.loadingWorkspace")}</p>
      : project.data ? <ProjectReview key={project.data.id} api={api} project={project.data} choose={choose}
        quickOpenInitially={project.data.id === searchAfterPick}
        extensionsApi={allowExtensions ? api.extensions : undefined} extensionsOffline={extensionsOffline}
        allowDefinitions={allowDefinitions} eslintAvailability={eslintAvailability} outlineOpen={outlineOpen}
        renderOutline={renderOutline} searchAnchor={searchAnchor} {...sidebarProps} />
      : <div className="code-review-reader-body">
        <EmptyState className="code-review-placeholder" icon={<ActionIcon name="codeDocument" />}
          title={t("codeReview.title")} description={t("codeReview.intro")} actions={choose} />
        {renderOutline()}
      </div>}
  </section>;
}

type ProjectProps = { api: CodeReviewPlatform; project: CodeReviewProject };
type ReturnPoint = { key: string; mode: ReadingMode; viewport: ReadingPosition };
type DefinitionDialog = { point: ReturnPoint } & (
  { kind: "enable"; input: CodeDefinitionRequest } | { kind: "targets"; targets: CodeDefinitionTarget[] }
);

function ProjectReview({ api, project, choose, quickOpenInitially, allowDefinitions, eslintAvailability, sidebarId, sidebarOpen, setSidebarOpen,
  outlineOpen, renderOutline, searchAnchor, extensionsApi, extensionsOffline }: ProjectProps & CodeSidebarProps & CodeSearchProps & {
  choose: React.ReactNode;
  outlineOpen: boolean;
  renderOutline: (outline?: React.ReactNode) => React.ReactNode;
  quickOpenInitially: boolean;
  allowDefinitions: boolean;
  eslintAvailability: EslintAvailability;
  extensionsApi?: CodeExtensionPlatform;
  extensionsOffline: boolean;
}) {
  const { t } = useI18n();
  const client = useQueryClient();
  const canCompare = project.git === "ready" || project.git === "noBaseline";
  const scope = [...workspaceKey, project.id] as const;
  const checks = useCodeReviewChecks(api, project, eslintAvailability);
  const { run: checkRun, verify: verifyCheck } = checks;
  const extensionsKey = [...scope, "extensions"] as const;
  const extensionList = useQuery({
    queryKey: extensionsKey, enabled: Boolean(extensionsApi), retry: false, staleTime: Infinity,
    queryFn: () => extensionsApi?.list(project.id) ?? Promise.resolve([]),
  });
  const extensions = extensionsApi ? extensionList.data ?? [] : [];
  const [syntaxActivity, setSyntaxActivity] = useState<{ path: string; activity: ExtensionActivity }>();
  const onSyntaxActivity = useCallback((path: string, activity: ExtensionActivity) => {
    setSyntaxActivity({ path, activity });
  }, []);
  const [dock, setDock] = useState<ReviewDock>();
  const [dockSizes, setDockSizes] = useState({ checks: 300, note: 270 });
  const dockId = useId();
  const [findingsFilter, setFindingsFilter] = useState("");
  const [severityFilter, setSeverityFilter] = useState<"all" | CheckFinding["severity"]>("all");
  const [collapsedChecks, setCollapsedChecks] = useState<ReadonlySet<string>>(() => new Set());
  const [selectedFinding, setSelectedFinding] = useState<CheckFinding>();
  const checksScroll = useRef<{ runId: number | undefined; top: number }>({ runId: undefined, top: 0 });
  const changes = useQuery({
    queryKey: [...scope, "changes"],
    queryFn: () => api.changes(project.id),
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
    retry: false,
  });
  const [selectedView, setView] = useState<NavigatorView>(canCompare ? "changes" : "files");
  const view = selectedView === "extensions" && !extensionsApi ? "files" : selectedView;
  const [contentPane, setContentPane] = useState<HTMLDivElement | null>(null);
  const [tabs, setTabs] = useState<string[]>();
  const [selected, setSelected] = useState<string>();
  const [filter, setFilter] = useState("");
  const [notice, setNotice] = useState("");
  const [sidebarWidth, setSidebarWidth] = useState(226);
  const [quickOpen, setQuickOpen] = useState<{ findInFile: boolean } | undefined>(quickOpenInitially ? { findInFile: false } : undefined);
  const [recentFiles, setRecentFiles] = useState<string[]>([]);
  const [reveal, setReveal] = useState<{ path: string }>();
  const contextMenu = useCodeContextMenu();
  const [modes, setModes] = useState<ReadonlyMap<string, ReadingMode>>(() => new Map());
  const [externalFiles, setExternalFiles] = useState<ReadonlyMap<string, CodeDefinitionTarget>>(() => new Map());
  const [returnPoints, setReturnPoints] = useState<ReturnPoint[]>([]);
  const [arrival, setArrival] = useState<{ key: string; destination: DefinitionArrival }>();
  const [definitionDialog, setDefinitionDialog] = useState<DefinitionDialog>();
  const definitionVersion = useRef(0);
  const positions = useRef(new Map<string, ReadingPosition>());
  const readPosition = useCallback((key: string) => positions.current.get(key), []);
  const savePosition = useCallback((key: string, position: ReadingPosition) => { positions.current.set(key, position); }, []);
  const [showHidden, setShowHidden] = useState(false);
  const [compactFolders, setCompactFolders] = useState(() => {
    try { return localStorage.getItem(compactFoldersKey) !== "false"; }
    catch { return true; }
  });
  const toggleCompactFolders = () => {
    const enabled = !compactFolders;
    setCompactFolders(enabled);
    try { localStorage.setItem(compactFoldersKey, String(enabled)); } catch { /* The current workspace can still use the setting. */ }
  };
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [, setNoteRevision] = useState(0);
  const activityBar = useRef<HTMLElement>(null);
  const sidebar = useRef<HTMLElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const detail = useRef<HTMLDivElement>(null);
  const toolbar = useRef<HTMLElement>(null);
  const pendingFocus = useRef<"list" | "filter" | "tab" | undefined>(undefined);
  const changed = changes.data?.files ?? noChanges;
  const changedPaths = useMemo(() => indexChangedPaths(changed), [changed]);
  const firstChange = changed[0]?.path;
  const openTabs = useMemo(() => tabs ?? (firstChange ? [firstChange] : []), [firstChange, tabs]);
  const active = selected && openTabs.includes(selected) ? selected : openTabs[0];
  const change = changed.find((entry) => entry.path === active);
  const readingMode = (active && modes.get(active)) || (change ? "diff" : "source");
  const dependency = active ? externalFiles.get(active) : undefined;
  useEffect(() => {
    const file = checkRun?.files.find((item) => item.target.path === active && item.status === "checked");
    if (file && checkRun?.status === "finished") void verifyCheck(file, checkRun);
  }, [active, dock, readingMode, checkRun, verifyCheck]);
  useLayoutEffect(() => () => { definitionVersion.current += 1; }, [active, readingMode]);
  const setReadingMode = (path: string, mode: ReadingMode) => setModes((current) => {
    if (current.get(path) === mode) return current;
    return new Map(current).set(path, mode);
  });
  useEffect(() => {
    const showQuickOpen = () => {
      if (api.paths) setQuickOpen({ findInFile: Boolean(detail.current?.querySelector("[data-code-find]")) });
    };
    const cycle = (event: globalThis.KeyboardEvent) => {
      if (quickOpen || event.defaultPrevented || event.isComposing || event.key !== "Tab" || !event.ctrlKey || event.altKey || event.metaKey || openTabs.length < 2) return;
      if (event.target instanceof Element && event.target.closest("dialog[open], [aria-modal=true]")) return;
      event.preventDefault();
      const current = active ? openTabs.indexOf(active) : 0;
      const path = openTabs[(current + (event.shiftKey ? -1 : 1) + openTabs.length) % openTabs.length];
      definitionVersion.current += 1;
      setDefinitionDialog(undefined);
      pendingFocus.current = "tab";
      setTabs(openTabs);
      setSelected(path);
      setNotice("");
    };
    window.addEventListener("nodalstudio:code-quick-open", showQuickOpen);
    window.addEventListener("keydown", cycle);
    return () => {
      window.removeEventListener("nodalstudio:code-quick-open", showQuickOpen);
      window.removeEventListener("keydown", cycle);
    };
  }, [active, api, openTabs, quickOpen]);

  useLayoutEffect(() => {
    if (!pendingFocus.current) return;
    const target = pendingFocus.current === "tab"
      ? detail.current?.querySelector<HTMLButtonElement>(".code-review-tabs [aria-current]")
      : pendingFocus.current === "filter"
        ? sidebar.current?.querySelector<HTMLInputElement>("input[type=search]")
        : list.current?.querySelector<HTMLButtonElement>("[data-code-row]") ?? activityBar.current?.querySelector<HTMLButtonElement>("button[aria-pressed=true]");
    if (!target) return;
    pendingFocus.current = undefined;
    target.focus();
  });

  useEffect(() => {
    function find() {
      const action = detail.current?.querySelector<HTMLButtonElement>("[data-code-find]");
      if (action) {
        action.click();
        return;
      }
      if (!canCompare || changed.length === 0) {
        const row = view === "files" && sidebarOpen && list.current?.querySelector<HTMLButtonElement>("[data-code-row]");
        if (row) row.focus();
        else { pendingFocus.current = "list"; setSidebarOpen(true); setView("files"); }
        return;
      }
      const filterField = sidebar.current?.querySelector<HTMLInputElement>("input[type=search]");
      if (sidebarOpen && filterField) filterField.focus();
      else {
        pendingFocus.current = "filter";
        setSidebarOpen(true);
        setView("changes");
      }
    }
    window.addEventListener("nodalstudio:code-find", find);
    return () => window.removeEventListener("nodalstudio:code-find", find);
  }, [canCompare, changed.length, setSidebarOpen, sidebarOpen, view]);

  const { refetch } = changes;
  const projectId = project.id;
  useEffect(() => {
    function refresh() {
      setNotice("");
      void client.invalidateQueries({ queryKey: [...workspaceKey, projectId, "directory"] });
      void client.invalidateQueries({ queryKey: [...workspaceKey, projectId, "paths"] });
      void client.invalidateQueries({ queryKey: [...workspaceKey, projectId, "content"] });
      void refetch().then(() => client.invalidateQueries({ queryKey: [...workspaceKey, projectId, "file"] }));
    }
    window.addEventListener("nodalstudio:code-refresh", refresh);
    return () => window.removeEventListener("nodalstudio:code-refresh", refresh);
  }, [client, projectId, refetch]);
  useEffect(() => {
    function refreshChecks() {
      if (!checkRun || checkRun.status === "running") return;
      void (async () => {
        for (const file of checkRun.files) await verifyCheck(file, checkRun);
      })();
    }
    window.addEventListener("nodalstudio:code-refresh", refreshChecks);
    return () => window.removeEventListener("nodalstudio:code-refresh", refreshChecks);
  }, [checkRun, verifyCheck]);

  const open = (path: string, mode?: ReadingMode) => {
    definitionVersion.current += 1;
    setDefinitionDialog(undefined);
    if (mode) setReadingMode(path, mode);
    setTabs(openTabs.includes(path) ? openTabs : [...openTabs, path]);
    setSelected(path);
    if (!path.startsWith("\0")) setRecentFiles((current) => [path, ...current.filter((file) => file !== path)].slice(0, 40));
    setNotice("");
  };
  const locateSearchHit = async (path: string, match: CodeSearchMatch) => {
    setView("search");
    setSidebarOpen(true);
    const version = ++definitionVersion.current;
    try {
      const source = await api.file(project.id, path, false);
      if (version !== definitionVersion.current) return;
      const line = source.after.state === "text" ? normalizeReviewText(source.after.text).split("\n")[match.line] : undefined;
      if (line?.slice(match.character, match.character + match.matched.length) !== match.matched) {
        setNotice(t("codeReview.contentStale"));
        return;
      }
      client.setQueryData([...scope, "file", path, false], source);
      client.setQueryData([...scope, "file", path, false, undefined], source);
      setArrival({ key: path, destination: { position: match, match: match.matched } });
      open(path, "source");
    } catch {
      if (version === definitionVersion.current) setNotice(t("codeReview.fileFailed"));
    }
  };
  const locateCheck = async (file: CheckedFile, finding: CheckFinding) => {
    if (!checkRun) return;
    const latest = await verifyCheck(file, checkRun);
    if (!latest) return;
    const { target } = file;
    if (target.mode === "diff") {
      client.setQueryData([...scope, "file", target.path, true, target.evidence], latest.document);
    } else {
      client.setQueryData([...scope, "file", target.path, false], latest.document);
      client.setQueryData([...scope, "file", target.path, false, undefined], latest.document);
    }
    setArrival({ key: target.path, destination: { check: { ...target, text: latest.text, range: finding.range } } });
    setSelectedFinding(finding);
    open(target.path, target.mode);
  };
  const closeDock = () => {
    detail.current?.querySelector<HTMLButtonElement>(`[data-review-dock-toggle="${dock}"]`)?.focus();
    setDock(undefined);
  };
  const dockLabel = t(dock === "checks" ? "codeReview.checks.title" : "codeReview.notes");
  const renderDock: RenderDock = (current, note) => dock && <>
    <CodePanelDivider orientation="horizontal" panelId={dockId} label={dockLabel} size={dockSizes[dock]}
      min={144} max={700} ratio={0.65} onResize={(height) => setDockSizes((sizes) => ({ ...sizes, [dock]: height }))} />
    <aside id={dockId} className="code-review-dock" style={{ height: dockSizes[dock] }} aria-label={dockLabel}
      onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); closeDock(); } }}>
      <header className="code-review-dock-header">
        <h3>{dockLabel}</h3>
        {dock === "checks" && <div className="code-checks-filters">
          <input type="search" placeholder={t("codeReview.checks.search")} aria-label={t("codeReview.checks.search")}
            value={findingsFilter} onChange={(event) => setFindingsFilter(event.target.value)} />
          <select className="ds-select" aria-label={t("codeReview.checks.severityFilter")} value={severityFilter} onChange={(event) => {
            const value = event.target.value;
            if (value === "all" || value === "error" || value === "warning") setSeverityFilter(value);
          }}>
            <option value="all">{t("codeReview.checks.allSeverities")}</option>
            <option value="error">{t("codeReview.checks.errors")}</option>
            <option value="warning">{t("codeReview.checks.warnings")}</option>
          </select>
        </div>}
        <IconButton className="code-review-tool code-review-dock-close" icon="close" label={t("codeReview.checks.close")} onClick={closeDock} />
      </header>
      {dock === "checks" ? <CodeReviewChecks checks={checks} current={current} changes={changes.data} extensions={extensions} scrollRef={checksScroll}
        search={findingsFilter} severity={severityFilter} collapsed={collapsedChecks} selected={selectedFinding} toggleFile={(path) => setCollapsedChecks((previous) => {
          const next = new Set(previous);
          if (!next.delete(path)) next.add(path);
          return next;
        })}
        locate={(file, finding) => { void locateCheck(file, finding); }}
        batchUnavailable={!canCompare ? project.git === "folder" ? "folder" : "git"
          : changes.isFetching ? "loading" : changes.isError ? "git" : changed.length === 0 ? "clean" : undefined} />
        : note ?? <p className="code-review-dock-empty">{t("codeReview.noteSelectChange")}</p>}
    </aside>
  </>;
  const findings = checkRun?.files.flatMap((file) => file.status === "checked" ? file.findings : []) ?? [];
  const errors = findings.filter((finding) => finding.severity === "error").length;
  const warnings = findings.length - errors;
  const renderStatus: RenderStatus = (status) => <>
    <button type="button" className="code-review-dock-toggle" data-review-dock-toggle="checks"
      aria-expanded={dock === "checks"} aria-controls={dock === "checks" ? dockId : undefined}
      aria-label={t(dock === "checks" ? "codeReview.checks.hide" : "codeReview.checks.show", { errors, warnings })}
      onClick={() => setDock((current) => current === "checks" ? undefined : "checks")}>
      <span data-severity="error"><ActionIcon name="error" />{errors}</span>
      <span data-severity="warning"><ActionIcon name="warning" />{warnings}</span>
    </button>
    {status && <button type="button" className="code-review-dock-toggle" data-review-dock-toggle="note"
      aria-expanded={dock === "note"} aria-controls={dock === "note" ? dockId : undefined}
      aria-label={t("codeReview.noteToggle", { status: t(`codeReview.${status}`) })}
      onClick={() => setDock((current) => current === "note" ? undefined : "note")}>
      <ActionIcon name="edit" /><span>{t("codeReview.notes")}</span>
      <span className="code-review-note-status" data-status={status}>{t(`codeReview.${status}`)}</span>
    </button>}
  </>;
  const visitDefinition = (target: CodeDefinitionTarget, point: ReturnPoint) => {
    const key = target.sourceId ? `\0${target.sourceId}` : target.path;
    if (target.sourceId) setExternalFiles((current) => new Map(current).set(key, target));
    setReturnPoints((current) => [...current.slice(-49), point]);
    setArrival({ key, destination: { position: target.position } });
    open(key, "source");
  };
  const back = returnPoints.length ? () => {
    const point = returnPoints.at(-1);
    if (!point) return;
    setReturnPoints((current) => current.slice(0, -1));
    setArrival({ key: point.key, destination: { viewport: point.viewport } });
    open(point.key, point.mode);
  } : undefined;
  const lookUpDefinition = async (point: ReturnPoint, input: CodeDefinitionRequest) => {
    if (!api.definition) return;
    const version = ++definitionVersion.current;
    setDefinitionDialog(undefined);
    setNotice(t("codeReview.definitionFinding"));
    try {
      const result = await api.definition(project.id, input);
      if (input.enable) void client.invalidateQueries({ queryKey: [...scope, "outline"] });
      if (version !== definitionVersion.current) return;
      switch (result.state) {
        case "resolved":
          if (result.targets.length === 1) visitDefinition(result.targets[0], point);
          else {
            setNotice("");
            setDefinitionDialog({ kind: "targets", point, targets: result.targets });
          }
          break;
        case "disabled":
          setNotice("");
          setDefinitionDialog({ kind: "enable", point, input });
          break;
        case "missingServer": setNotice(t("codeReview.definitionMissingServer", { command: result.command })); break;
        case "unsupported": setNotice(t("codeReview.definitionUnsupported")); break;
        case "notFound": setNotice(t("codeReview.definitionNotFound")); break;
        case "stale": setNotice(t("codeReview.definitionStale")); break;
        case "unavailable": setNotice(t("codeReview.definitionUnavailable")); break;
      }
    } catch {
      if (version === definitionVersion.current) setNotice(t("codeReview.definitionUnavailable"));
    }
  };
  const closeTabs = (paths: readonly string[]) => {
    const closingActive = active !== undefined && paths.includes(active);
    if (closingActive) {
      definitionVersion.current += 1;
      setDefinitionDialog(undefined);
      setNotice("");
    }
    const remaining = openTabs.filter((tab) => !paths.includes(tab));
    const next = closingActive && active !== undefined ? remaining[Math.min(openTabs.indexOf(active), remaining.length - 1)] : active;
    pendingFocus.current = next ? "tab" : sidebarOpen ? "list" : undefined;
    if (!next && !sidebarOpen) toolbar.current?.focus();
    setTabs(remaining);
    setSelected(next);
  };
  const refresh = () => window.dispatchEvent(new Event("nodalstudio:code-refresh"));
  const browseFiles = () => {
    pendingFocus.current = "list";
    setSidebarOpen(true);
    setView("files");
  };
  const query = filter.trim().toLocaleLowerCase();
  const shown = changed.filter((entry) => entry.path.toLocaleLowerCase().includes(query));
  const clean = canCompare && Boolean(changes.data && !changed.length && !changes.data.limited && !changes.isError);
  const copy = (text: string) => {
    void Promise.resolve().then(() => navigator.clipboard.writeText(text)).then(() => setNotice(t("codeReview.copied"))).catch(() => setNotice(t("codeReview.copyFailed")));
  };
  const revealFile = (path: string) => {
    const segments = path.split("/");
    if (segments.some((part) => part.startsWith("."))) setShowHidden(true);
    setExpanded((current) => new Set([...current, ...segments.slice(0, -1).map((_, index) => segments.slice(0, index + 1).join("/"))]));
    setSidebarOpen(true);
    setView("files");
    setReveal({ path });
  };
  const fileMenu = (event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>, key: string, source: "tree" | "changes" | "tab") => {
    const external = externalFiles.get(key);
    const path = external?.path ?? key;
    const edited = changed.find((entry) => entry.path === key);
    const tab = source === "tab";
    const right = tab ? openTabs.slice(openTabs.indexOf(key) + 1) : [];
    const trigger = tab ? event.currentTarget.querySelector("button") ?? event.currentTarget : event.currentTarget;
    contextMenu.show(event, path, [
      ...(!external && edited?.kind !== "deleted" ? [{ label: t("codeReview.menu.openSource"), run: () => open(key, "source") }] : []),
      ...(edited ? [{ label: t("codeReview.menu.openDiff"), run: () => open(key, "diff") }] : []),
      ...(edited?.evidence ? [{ label: t("codeReview.menu.openNote"), run: () => { open(key, "diff"); setDock("note"); } }] : []),
      { label: t(external ? "codeReview.menu.copyPath" : "codeReview.menu.copyRelativePath"),
        separatorBefore: Boolean(edited || !external), run: () => copy(path) },
      ...(!external && source !== "tree" ? [{ label: t("codeReview.menu.reveal"), run: () => revealFile(key) }] : []),
      ...(tab ? [
        { label: t("codeReview.menu.close"), separatorBefore: true, run: () => closeTabs([key]) },
        { label: t("codeReview.menu.closeOthers"), disabled: openTabs.length < 2, run: () => closeTabs(openTabs.filter((item) => item !== key)) },
        { label: t("codeReview.menu.closeRight"), disabled: right.length === 0, run: () => closeTabs(right) },
        { label: t("codeReview.menu.closeAll"), run: () => closeTabs(openTabs) },
      ] : []),
    ], trigger);
  };

  const refreshButton = <IconButton icon="refresh" className="code-review-tool" label={t(changes.isFetching ? "codeReview.refreshing" : "codeReview.refresh")}
    disabled={changes.isFetching} aria-busy={changes.isFetching || undefined} onClick={refresh} />;
  const viewLabels = {
    files: t("codeReview.files"), search: t("codeReview.searchResults"),
    changes: t("codeReview.changesLabel"), extensions: t("codeReview.extensions.title"),
  };
  const activitiesAvailable: { view: NavigatorView; icon: ActionIconName }[] = [{ view: "files", icon: "document" }];
  if (api.searchContent) activitiesAvailable.push({ view: "search", icon: "search" });
  if (canCompare) activitiesAvailable.push({ view: "changes", icon: "git" });
  if (extensionsApi) activitiesAvailable.push({ view: "extensions", icon: "extensions" });
  const activities: ExtensionActivity[] = [];
  if (syntaxActivity && syntaxActivity.path === active) activities.push(syntaxActivity.activity);
  if (checkRun?.extension && checkRun.status !== "cancelled") {
    activities.push({
      id: checkRun.extension.id,
      state: checkRun.status === "running" ? "running" : checkRun.files.some((file) => file.status === "checked") ? "ran" : "failed",
      detail: checkRun.extensionError,
    });
  }
  const baseline = project.baseline ? t("codeReview.compareBase", { commit: project.baseline.slice(0, 10) }) : t(`codeReview.git.${project.git}`);
  return <>
    {changes.isError && <p className="code-review-notice" role="alert">{t("codeReview.refreshFailed")}</p>}
    <div className="code-review-workspace" data-sidebar={sidebarOpen ? "open" : "closed"}
      style={{ "--code-sidebar-width": `${sidebarWidth}px` } as React.CSSProperties}>
      <nav ref={activityBar} className="code-review-activity" aria-label={t("codeReview.navigatorMode")} onKeyDown={navigateActivityBar}>
        {activitiesAvailable.map(({ view: target, icon }) => {
          const active = sidebarOpen && view === target;
          const count = target === "changes" ? changes.data?.files.length : undefined;
          return <IconButton key={target} className="code-review-tool code-review-activity-button" icon={icon}
            label={count === undefined ? viewLabels[target] : t("codeReview.changes", { count })}
            aria-pressed={active} aria-controls={sidebarId} onClick={() => {
              setView(target);
              setSidebarOpen(!active);
            }}>
            {count !== undefined && count > 0 && <span className="code-review-activity-count" aria-hidden="true">{count > 99 ? "99+" : count}</span>}
          </IconButton>;
        })}
      </nav>
      <aside ref={sidebar} id={sidebarId} className="code-review-sidebar" aria-label={t("codeReview.projectFiles")} hidden={!sidebarOpen}>
        <header className="code-review-header">
          <h1>{viewLabels[view]}</h1>
          <div className="code-review-header-actions" role="group" aria-label={t("codeReview.projectActions")}>
            {refreshButton}{choose}
          </div>
        </header>
        {view === "extensions" && extensionsApi ? <CodeReviewExtensions api={extensionsApi} projectId={project.id} items={extensions}
          loading={extensionList.isPending} loadError={extensionList.isError} retry={() => { void extensionList.refetch(); }}
          activities={activities} offline={extensionsOffline} onUpdate={(id, item) => {
            if (!item?.enabled || extensions.some((installed) => installed.id === id && installed.sha256 !== item.sha256)) {
              checks.clearExtension(id);
              setSyntaxActivity((current) => current?.activity.id === id ? undefined : current);
            }
            client.setQueryData<CodeExtension[]>(extensionsKey, (current = []) =>
              [...current.filter((extension) => extension.id !== id), ...(item ? [item] : [])]
                .sort((a, b) => a.id.localeCompare(b.id)));
          }} /> : <>
        {view === "files" && <div className="code-review-files-toolbar">
          <h2 className="code-review-project-name" title={project.name}>{project.name}</h2>
          {sidebarOpen && <FileViewOptions compactFolders={compactFolders} showHidden={showHidden}
            toggleCompactFolders={toggleCompactFolders} toggleHidden={() => setShowHidden((visible) => !visible)} />}
        </div>}
        {view === "changes" && changed.length > 0 && <div className="code-review-sidebar-controls">
          <div className="code-review-filter">
            <ActionIcon name="search" />
            <input type="search" value={filter} onChange={(event) => setFilter(event.target.value)} placeholder={t("codeReview.filter")} aria-label={t("codeReview.filter")} />
          </div>
        </div>}
        {view === "search" ? <div ref={setContentPane} className="code-content-pane" /> :
        <div className="code-review-file-list" ref={list} aria-busy={view === "changes" && changes.isFetching || undefined} onKeyDown={navigateFiles}>
          {view === "files" ? <>
            {changes.data?.limited && <p role="status">{t("codeReview.limited")}</p>}
            <DirectoryTree api={api} project={project} path="" active={active} onOpen={open} onFileMenu={fileMenu} reveal={reveal} showHidden={showHidden}
              compact={compactFolders ? showHidden ? "all" : "visible" : undefined}
              changedPaths={changedPaths} expanded={expanded} onToggle={(paths) => setExpanded((current) => {
                const next = new Set(current);
                if (next.has(paths[0])) next.delete(paths[0]);
                else paths.forEach((path) => next.add(path));
                return next;
              })} />
          </>
            : changes.isPending ? <p role="status">{t("codeReview.loadingChanges")}</p>
            : <>
              {changes.data?.limited && <p role="status">{t("codeReview.limited")}</p>}
              {shown.length === 0 && !changes.isError && !clean && query && <p role="status">{t("codeReview.noMatches")}</p>}
              {clean && active && <p role="status">{t("codeReview.noChanges")}</p>}
              <ul>{shown.map((entry) => {
                const history = reviewHistory(project.key, entry.path);
                const review = history.find((note) => note.evidence === entry.evidence);
                const status = review?.status ?? (history.length > 0 ? "recheck" : undefined);
                const folder = folderName(entry.path);
                return <li key={entry.path}><button type="button" className="code-review-change" data-code-row=""
                  aria-haspopup="menu" aria-keyshortcuts="Shift+F10"
                  onContextMenu={(event) => fileMenu(event, entry.path, "changes")}
                  onKeyDown={(event) => { if (isCodeContextMenuKey(event)) fileMenu(event, entry.path, "changes"); }}
                  aria-current={entry.path === active ? "true" : undefined} title={entry.path} onClick={() => open(entry.path, "diff")}>
                  <ActionIcon name={entry.path.endsWith(".sql") ? "codeDocument" : "document"} />
                  <span className="code-review-filename">{basename(entry.path)}</span>
                  <span className="code-review-kind" data-kind={entry.kind}>{t(`codeReview.kind.${entry.kind}`)}</span>
                  {(folder || status) && <span className="code-review-change-meta">
                    {folder && <span className="code-review-path">{folder}</span>}
                    {status && <span className="code-review-disposition" data-status={status}>{t(`codeReview.${status}`)}</span>}
                  </span>}
                </button></li>;
              })}</ul>
            </>}
        </div>}
        </>}
      </aside>
      {sidebarOpen && <SidebarRail side="left" expanded width={sidebarWidth} minWidth={176} maxWidth={420}
        onResize={setSidebarWidth} onToggle={() => setSidebarOpen(false)} />}
      <div className="code-review-detail" ref={detail}>
        <header className="code-review-editor-bar" ref={toolbar} tabIndex={-1}>
          {!sidebarOpen && <div className="code-review-header-actions">{refreshButton}{choose}</div>}
          {returnPoints.length > 0 && <IconButton icon="chevronLeft" className="code-review-tool" label={t("codeReview.definitionBack")} onClick={back} />}
          <nav className="code-review-tabs" aria-label={t("codeReview.openFiles")}>
            {openTabs.map((key) => {
              const path = externalFiles.get(key)?.path ?? key;
              return <div className="code-review-tab" key={key}
                onContextMenu={(event) => fileMenu(event, key, "tab")}
                onKeyDown={(event) => { if (isCodeContextMenuKey(event)) fileMenu(event, key, "tab"); }}>
                <Button variant="ghost" size="small" title={path} aria-current={key === active ? "true" : undefined}
                  aria-haspopup="menu" aria-keyshortcuts="Shift+F10"
                  onClick={() => open(key)}><CodeFileIcon path={path} />
                  <span>{basename(path.replaceAll("\\", "/"))}</span></Button>
                <IconButton icon="close" className="code-review-tab-close" label={t("codeReview.close", { path })} onClick={() => closeTabs([key])} />
              </div>;
            })}
          </nav>
        </header>
        {active ? <FileReview key={JSON.stringify([active, change?.evidence])}
          api={api} project={project} path={active} dependency={dependency} change={change} mode={readingMode}
          allowLanguageTools={allowDefinitions} eslintAvailability={eslintAvailability}
          showOutline={outlineOpen} renderOutline={renderOutline} renderDock={renderDock} renderStatus={renderStatus}
          checkFiles={checkRun?.status === "running" ? undefined : checkRun?.files}
          extensionsApi={extensionsApi} extensions={extensions} onSyntaxActivity={onSyntaxActivity}
          locateOutline={(position) => {
            setArrival({ key: active, destination: { position } });
            setReadingMode(active, "source");
          }}
          baseline={baseline} readPosition={readPosition} savePosition={savePosition} onModeChange={(mode) => {
            definitionVersion.current += 1;
            setDefinitionDialog(undefined);
            setNotice("");
            setReadingMode(active, mode);
          }}
          onSaved={() => setNoteRevision((current) => current + 1)} onRefresh={refresh} onCopy={copy}
          arrival={arrival?.key === active ? arrival.destination : undefined} onArrival={(found) => {
            setArrival(undefined);
            if (found === false) setNotice(t("codeReview.contentStale"));
          }} onBack={back}
          onDefinition={api.definition && allowDefinitions ? (gesture, mode) => {
            const origin = dependency?.sourceId
              ? { kind: "dependency" as const, id: dependency.sourceId }
              : { kind: "workspace" as const, path: active };
            void lookUpDefinition({ key: active, mode, viewport: gesture.viewport }, { origin, text: gesture.text, position: gesture.position, enable: false });
          } : undefined} />
          : <><div className="code-review-reader-body">
            <EmptyState className="code-review-placeholder" icon={<ActionIcon name={view === "changes" && clean ? "check" : "codeDocument"} />}
              title={t(view === "changes" && clean ? "codeReview.noChanges" : "codeReview.selectFile")}
              description={t(view === "changes" && clean ? "codeReview.cleanHelp" : "codeReview.selectFileHelp")}
              actions={view === "changes" || !sidebarOpen ? <Button onClick={browseFiles}>{t("codeReview.browseFiles")}</Button> : undefined} />
            {renderOutline()}
          </div>{renderDock()}<div className="code-review-reading-status">{renderStatus()}<span>{baseline}</span></div></>}
        <div className="code-review-announcement" role="status">{notice && <p>{notice}</p>}</div>
      </div>
    </div>
    {contextMenu.surface}
    {(api.paths || api.searchContent) && <CodeQuickOpen api={api} projectId={project.id} visible={Boolean(quickOpen)} anchor={searchAnchor}
      contentPane={sidebarOpen ? contentPane : null} recent={[...recentFiles, ...openTabs.filter((key) => !externalFiles.has(key))]}
      untracked={changed.filter((entry) => entry.kind === "added" && !entry.indexOnly).map((entry) => entry.path)}
      unavailable={new Set(changed.filter((entry) => entry.kind === "deleted").map((entry) => entry.path))}
      onOpen={(path, position) => {
        if (position) setArrival({ key: path, destination: { position } });
        else pendingFocus.current = "tab";
        open(path, "source");
      }}
      onHit={(path, match) => void locateSearchHit(path, match)}
      onFind={quickOpen?.findInFile ? () => {
        requestAnimationFrame(() => detail.current?.querySelector<HTMLButtonElement>("[data-code-find]")?.click());
      } : undefined}
      onDismiss={() => setQuickOpen(undefined)} />}
    {definitionDialog && definitionDialog.point.key === active && <ModalSurface
      label={t("codeReview.definition")} onDismiss={() => setDefinitionDialog(undefined)}>
      <div className="code-definition-dialog ds-surface">
        {definitionDialog.kind === "enable" ? <>
          <strong>{t("codeReview.definitionEnable")}</strong>
          <p>{t("codeReview.definitionTrust")}</p>
          <div className="code-review-note-actions">
            <Button onClick={() => setDefinitionDialog(undefined)}>{t("codeReview.definitionCancel")}</Button>
            <Button variant="primary" onClick={() => void lookUpDefinition(definitionDialog.point, { ...definitionDialog.input, enable: true })}>
              {t("codeReview.definitionEnable")}
            </Button>
          </div>
        </> : <>
          <strong>{t("codeReview.definitionChoose")}</strong>
          <ul>{definitionDialog.targets.map((target, index) => <li key={index}>
            <button type="button" data-modal-focus={index === 0 ? "" : undefined} onClick={() => visitDefinition(target, definitionDialog.point)}>
              {target.path} · {t("codeReview.caret", { line: target.position.line + 1, column: target.position.character + 1 })}
            </button>
          </li>)}</ul>
        </>}
      </div>
    </ModalSurface>}
  </>;
}

function FileViewOptions({ compactFolders, showHidden, toggleCompactFolders, toggleHidden }: {
  compactFolders: boolean;
  showHidden: boolean;
  toggleCompactFolders: () => void;
  toggleHidden: () => void;
}) {
  const { t } = useI18n();
  const [anchor, setAnchor] = useState<HTMLButtonElement>();
  const label = t("codeReview.fileViewOptions");
  return <>
    <IconButton icon="sliders" label={label} className="code-review-tool" aria-haspopup="menu" aria-expanded={Boolean(anchor)}
      onClick={(event) => setAnchor(anchor ? undefined : event.currentTarget)}
      onKeyDown={(event) => {
        if (event.key !== "ArrowDown") return;
        event.preventDefault();
        setAnchor(event.currentTarget);
      }} />
    {anchor && <SchemaObjectMenu anchor={anchor} name={label} showName={false} className="code-review-view-options"
      actions={[
        { label: t("codeReview.compactFolders"), checked: compactFolders, checkbox: true, run: toggleCompactFolders },
        { label: t("codeReview.showHidden"), checked: showHidden, checkbox: true, run: toggleHidden },
      ]} onClose={(restoreFocus) => {
        setAnchor(undefined);
        if (restoreFocus && anchor.isConnected) anchor.focus({ preventScroll: true });
      }} />}
  </>;
}

function navigateActivityBar(event: KeyboardEvent<HTMLElement>) {
  const { key } = event;
  if (key !== "ArrowDown" && key !== "ArrowUp" && key !== "Home" && key !== "End") return;
  const buttons = [...event.currentTarget.querySelectorAll("button")];
  const index = buttons.findIndex((button) => button === event.target);
  if (index < 0) return;
  const next = key === "Home" ? 0 : key === "End" ? buttons.length - 1
    : (index + (key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
  event.preventDefault();
  buttons[next].focus();
}

function navigateFiles(event: KeyboardEvent<HTMLDivElement>) {
  if (!(event.target instanceof HTMLButtonElement) || !event.target.hasAttribute("data-code-row")) return;
  const current = event.target;
  const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button[data-code-row]")];
  const index = rows.indexOf(current);
  let target: HTMLButtonElement | undefined | null;
  const expanded = current.getAttribute("aria-expanded");
  switch (event.key) {
    case "ArrowDown": target = rows[index + 1]; break;
    case "ArrowUp": target = rows[index - 1]; break;
    case "Home": target = rows[0]; break;
    case "End": target = rows.at(-1); break;
    case "ArrowRight":
      if (expanded === "false") current.click();
      if (expanded === "true") target = current.parentElement?.querySelector(":scope > ul > li > button[data-code-row]");
      break;
    case "ArrowLeft":
      if (expanded === "true") current.click();
      else target = current.parentElement?.parentElement?.closest("li")?.querySelector(":scope > button[data-code-row]");
      break;
    default: return;
  }
  event.preventDefault();
  target?.focus();
}

type TreeEntry = CodeReviewDirectory["entries"][number] & { kind?: CodeReviewChange["kind"] };
type ChangedPaths = Map<string, Map<string, TreeEntry>>;
const fileStatusMarker: Record<CodeReviewChange["kind"], string> = {
  added: "A", modified: "M", deleted: "D", renamed: "R", conflict: "!",
};
const folderStatusMessage = {
  added: "codeReview.folderContainsAdded",
  modified: "codeReview.folderContainsChanges",
  deleted: "codeReview.folderContainsDeleted",
  renamed: "codeReview.folderContainsChanges",
  conflict: "codeReview.folderContainsConflicts",
} as const;
const folderStatusMarker: Partial<Record<CodeReviewChange["kind"], string>> = { added: "+", deleted: "−", conflict: "!" };

function treeEntryKey(entry: TreeEntry) {
  return entry.directory ? `${entry.path}/` : entry.path;
}

function indexChangedPaths(changes: readonly CodeReviewChange[]): ChangedPaths {
  const index: ChangedPaths = new Map();
  function add(path: string, directory: boolean, kind: CodeReviewChange["kind"]) {
    const parent = folderName(path);
    let children = index.get(parent);
    if (!children) {
      children = new Map();
      index.set(parent, children);
    }
    const entry = { path, name: basename(path), directory, kind };
    const key = treeEntryKey(entry);
    const previous = children.get(key);
    if (!previous) {
      children.set(key, entry);
      return true;
    }
    if (!directory || previous.kind === kind || previous.kind === "conflict") return false;
    // Mixed changes use the modified color, and conflicts take precedence.
    const merged = kind === "conflict" ? kind : "modified";
    if (previous.kind === merged) return false;
    previous.kind = merged;
    return true;
  }
  for (const { path, kind } of changes) {
    add(path, false, kind);
    const folderKind = kind === "renamed" ? "modified" : kind;
    for (let parent = folderName(path); parent; parent = folderName(parent)) {
      if (!add(parent, true, folderKind)) break;
    }
  }
  return index;
}

function folderRow(entry: TreeEntry, changedPaths: ChangedPaths, showHidden: boolean, compact: boolean) {
  const names = [entry.name];
  const paths = [entry.path];
  let path = entry.path;
  if (compact && entry.directory) {
    for (const name of entry.compactSegments ?? []) {
      const child = `${path}/${name}`;
      const changed = changedPaths.get(path);
      if ((!showHidden && name.startsWith(".")) || (changed && [...changed.values()].some((sibling) =>
        (showHidden || !sibling.name.startsWith(".")) && (!sibling.directory || sibling.path !== child)))) break;
      names.push(name);
      paths.push(child);
      path = child;
    }
  }
  return { names, paths, tail: path };
}

function DirectoryTree({ api, project, path, active, onOpen, onFileMenu, reveal, showHidden, compact, changedPaths, expanded, onToggle, readDirectory = true }: ProjectProps & {
  path: string;
  active?: string;
  onOpen: (path: string, mode: ReadingMode) => void;
  onFileMenu: (event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>, path: string, source: "tree") => void;
  reveal?: { path: string };
  showHidden: boolean;
  compact?: CodeReviewCompactFolders;
  changedPaths: ChangedPaths;
  expanded: ReadonlySet<string>;
  onToggle: (paths: string[]) => void;
  readDirectory?: boolean;
}) {
  const { t } = useI18n();
  const directory = useQuery({
    queryKey: [...workspaceKey, project.id, "directory", path, compact],
    queryFn: () => api.directory(project.id, path, compact),
    placeholderData: (previous, query) => query?.queryKey[3] === path ? previous : undefined,
    retry: false,
    staleTime: Infinity,
    enabled: readDirectory,
  });
  const revealRow = useRef<HTMLButtonElement>(null);
  const lastReveal = useRef<typeof reveal>(undefined);
  useLayoutEffect(() => {
    const row = revealRow.current;
    if (!row || lastReveal.current === reveal) return;
    lastReveal.current = reveal;
    row.scrollIntoView?.({ block: "nearest" });
    row.focus({ preventScroll: true });
  }, [reveal, directory.data, changedPaths]);
  if (readDirectory && directory.isPending) return <p role="status">{t("navigation.loadingWorkspace")}</p>;
  const changed = changedPaths.get(path);
  if (readDirectory && directory.isError && !changed) return <p role="alert">{t("codeReview.folderFailed")}</p>;
  const workingEntries = readDirectory ? directory.data?.entries ?? [] : [];
  const present = new Set(workingEntries.map(treeEntryKey));
  const missing = [...(changed?.values() ?? [])].filter((entry) => !present.has(treeEntryKey(entry)));
  // Changes can contain files absent from the working tree, including a deleted directory's last file.
  const entries = missing.length === 0 ? workingEntries : [...workingEntries, ...missing].sort((a, b) =>
    Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
  const visible = entries.filter((entry) => showHidden || !entry.name.startsWith("."));
  return <>
    {readDirectory && directory.isError && <p role="alert">{t("codeReview.folderFailed")}</p>}
    {readDirectory && directory.data?.limited && <p role="status">{t("codeReview.limited")}</p>}
    {visible.length > 0 && <ul className="code-review-tree">{visible.map((entry) => {
      const key = treeEntryKey(entry);
      const kind = changed?.get(key)?.kind;
      const status = kind ? t(entry.directory ? folderStatusMessage[kind] : `codeReview.kind.${kind}`) : undefined;
      const onDisk = present.has(key);
      const isOpen = expanded.has(entry.path);
      const { names, paths, tail } = folderRow(entry, changedPaths, showHidden,
        Boolean(compact && onDisk && !directory.isPlaceholderData && !directory.isError));
      const compacted = names.length > 1;
      return <li key={key}>
        <button type="button" data-code-row="" aria-current={!entry.directory && entry.path === active ? "true" : undefined}
          data-folder-change={entry.directory ? kind : undefined}
          ref={!entry.directory && entry.path === reveal?.path ? revealRow : undefined}
          aria-haspopup={entry.directory ? undefined : "menu"} aria-keyshortcuts={entry.directory ? undefined : "Shift+F10"}
          onContextMenu={entry.directory ? undefined : (event) => onFileMenu(event, entry.path, "tree")}
          onKeyDown={entry.directory ? undefined : (event) => { if (isCodeContextMenuKey(event)) onFileMenu(event, entry.path, "tree"); }}
          aria-label={compacted ? names.join(" / ") : undefined}
          title={status ? `${tail} · ${status}` : tail} aria-description={status}
          aria-expanded={entry.directory ? isOpen : undefined}
          onClick={() => entry.directory ? onToggle(paths) : onOpen(entry.path, onDisk ? "source" : "diff")}>
          <span className="code-review-disclosure">{entry.directory && <ActionIcon name={isOpen ? "chevronDown" : "chevronRight"} />}</span>
          <ActionIcon className={entry.directory ? "code-review-folder-icon" : undefined} name={entry.directory ? "folder" : "document"} />
          {compacted ? <span className="code-review-compact-name" aria-hidden="true">
            <span className="code-review-filename code-review-compact-prefix">{names.slice(0, -1).join(" / ")}</span>
            <span className="code-review-compact-separator">/</span>
            <span className="code-review-filename code-review-compact-tail">{names.at(-1)}</span>
          </span> : <span className="code-review-filename">{entry.name}</span>}
          {kind && (entry.directory ? <span className="code-review-tree-folder-status" aria-hidden="true">{folderStatusMarker[kind]}</span>
            : <span className="code-review-kind code-review-tree-file-status" data-kind={kind} aria-hidden="true">{fileStatusMarker[kind]}</span>)}
        </button>
        {entry.directory && isOpen && <DirectoryTree api={api} project={project} path={tail} active={active} onOpen={onOpen}
          onFileMenu={onFileMenu} reveal={reveal}
          showHidden={showHidden} compact={compact} changedPaths={changedPaths} expanded={expanded} onToggle={onToggle}
          readDirectory={onDisk || Boolean(readDirectory && directory.data?.limited)} />}
      </li>;
    })}</ul>}
  </>;
}

function FileReview({ api, project, path, dependency, change, mode, baseline, readPosition, savePosition, onModeChange, onSaved, onRefresh, onCopy,
  onDefinition, allowLanguageTools, eslintAvailability, onBack, arrival, onArrival, showOutline, locateOutline, renderOutline, renderDock, renderStatus,
  checkFiles, extensionsApi, extensions, onSyntaxActivity }: ProjectProps & {
  path: string;
  dependency?: CodeDefinitionTarget;
  change?: CodeReviewChange;
  mode: ReadingMode;
  baseline: string;
  readPosition: (key: string) => ReadingPosition | undefined;
  savePosition: (key: string, position: ReadingPosition) => void;
  onModeChange: (mode: ReadingMode) => void;
  onSaved: () => void;
  onRefresh: () => void;
  onCopy: (text: string) => void;
  onDefinition?: (gesture: DefinitionGesture, mode: ReadingMode) => void;
  allowLanguageTools: boolean;
  eslintAvailability: EslintAvailability;
  locateOutline: (position: CodeDefinitionPosition) => void;
  showOutline: boolean;
  renderOutline: (outline?: React.ReactNode) => React.ReactNode;
  renderDock: RenderDock;
  renderStatus: RenderStatus;
  checkFiles?: readonly CheckedFile[];
  extensionsApi?: CodeExtensionPlatform;
  extensions: CodeExtension[];
  onSyntaxActivity: (path: string, activity: ExtensionActivity) => void;
  onBack?: () => void;
  arrival?: DefinitionArrival;
  onArrival: (found?: boolean) => void;
}) {
  const { t } = useI18n();
  const compare = Boolean(change);
  const file = useQuery({
    queryKey: [...workspaceKey, project.id, "file", path, compare, change?.evidence],
    queryFn: async (): Promise<CodeReviewDocument> => dependency?.sourceId && api.definitionSource
      ? { before: null, after: { state: "text", text: await api.definitionSource(project.id, dependency.sourceId) }, evidence: null, indexOnly: false }
      : api.file(project.id, path, compare),
    retry: false,
    gcTime: 30_000,
  });
  const readWorkingTree = mode === "source" && compare;
  const workingTree = useQuery({
    queryKey: [...workspaceKey, project.id, "file", path, false],
    queryFn: () => api.file(project.id, path, false),
    enabled: readWorkingTree,
    retry: false,
    gcTime: 30_000,
  });
  if (file.isPending || (readWorkingTree && workingTree.isPending)) return <><div className="code-review-reader-body">
    <EmptyState className="code-review-placeholder" title={<span role="status">{t("navigation.loadingWorkspace")}</span>} />
    {renderOutline()}
  </div>{renderDock()}<div className="code-review-reading-status">{renderStatus()}</div></>;
  const document = (file.isError ? undefined : file.data) ?? (readWorkingTree ? workingTree.data : undefined);
  if (!document || (readWorkingTree && workingTree.isError)) return <><div className="code-review-reader-body">
    <div className="code-review-status code-review-placeholder" role="alert">
      <p>{t(dependency ? "codeReview.definitionSourceUnavailable" : String(file.error) === "codeReviewStale" ? "codeReview.stale" : "codeReview.fileFailed")}</p>
      <Button size="small" onClick={onRefresh}>{t("codeReview.refresh")}</Button>
    </div>
    {renderOutline()}
  </div>{renderDock()}<div className="code-review-reading-status">{renderStatus()}</div></>;

  const { before, after, evidence, indexOnly } = document;
  const original = textFor(before);
  const revised = textFor(after);
  const diffAvailable = Boolean(before && (original !== undefined || before.state === "missing")
    && (revised !== undefined || after.state === "missing"));
  const source = readWorkingTree && workingTree.data ? workingTree.data.after : after;
  const showingOriginal = source.state === "missing" && original !== undefined;
  const fullText = textFor(source) ?? (showingOriginal ? original : undefined);
  const diff = diffAvailable && mode === "diff";
  const viewSwitcher = diffAvailable || (readWorkingTree && file.isError) ? <Segmented label={t("codeReview.readerMode")} value={diff ? "diff" : "source"}
    className="code-review-view-mode" onChange={onModeChange}
    options={[{ value: "diff", label: t("codeReview.diff"), icon: "diff" }, { value: "source", label: t("codeReview.source"), icon: "codeDocument" }]} /> : undefined;
  const displayPath = dependency?.path ?? path;
  const parts = displayPath.replaceAll("\\", "/").split("/").filter(Boolean);
  const filename = parts.pop() ?? displayPath;
  const positionKey = JSON.stringify([path, diff ? "diff" : "source"]);
  const heading = <div className="code-review-document-heading">
    <nav className="code-review-document-path" aria-label={t("codeReview.filePath")} title={displayPath}>
      <ol role="list">
        {parts.length > 1 && <li className="code-review-document-overflow" aria-hidden="true">…</li>}
        {parts.map((part, index) => <li key={index} className="code-review-document-folder">
          {index > 0 && <ActionIcon name="chevronRight" />}
          <span>{part}</span>
        </li>)}
        <li className="code-review-document-file" aria-current="page">
          {parts.length > 0 && <ActionIcon name="chevronRight" />}
          <CodeFileIcon path={displayPath} />
          <h2>{filename}</h2>
        </li>
      </ol>
    </nav>
  </div>;
  const noteHistory = change && evidence ? reviewHistory(project.key, path) : undefined;
  const noteStatus = noteHistory && evidence ? fileReviewStatus(noteHistory, evidence) : undefined;
  const note = noteHistory && noteStatus ? <ReviewNotes key={evidence} api={api} project={project} path={path} document={document}
    history={noteHistory} status={noteStatus} onSaved={onSaved} /> : undefined;
  const comparison = dependency ? t("codeReview.definitionDependency") : diff && indexOnly ? t("codeReview.index")
    : !diff && showingOriginal ? t("codeReview.originalVersion") : diff && change?.staged ? t("codeReview.hasStaged") : baseline;
  const readerText = diff ? (revised ?? "") : (fullText ?? "");
  const liveSource = !showingOriginal && !(diff && indexOnly);
  const origin = dependency?.sourceId ? { kind: "dependency" as const, id: dependency.sourceId } : { kind: "workspace" as const, path };
  const outline = showOutline && allowLanguageTools && liveSource && fullText !== undefined && api.documentOutline && supportsCodeNavigation(displayPath)
    ? <CodeReviewOutline locate={locateOutline} onRefresh={onRefresh}
      queryKey={[...workspaceKey, project.id, "outline", path, readWorkingTree ? workingTree.dataUpdatedAt : file.dataUpdatedAt, mode]}
      load={(enable) => api.documentOutline?.(project.id, { origin, enable, text: normalizeReviewText(readerText) })
        ?? Promise.resolve({ state: "unavailable" })} />
    : undefined;
  const checkTarget = { path, mode: diff ? "diff" as const : "source" as const, evidence: diff ? evidence : null, indexOnly: diff && indexOnly };
  const checkProblem = checkTargetProblem(checkTarget, diff ? after : source, Boolean(dependency))
    ?? (isEslintSource(path) && eslintAvailability !== "enabled" ? eslintAvailability : undefined);
  const matchesCheck = (target: DisplayedCheckTarget["target"]) => target.path === path && target.mode === checkTarget.mode
    && target.evidence === checkTarget.evidence && target.indexOnly === checkTarget.indexOnly;
  const checkResult = !checkProblem ? checkFiles?.find((item) => item.status === "checked" && matchesCheck(item.target)) : undefined;
  const safeArrival = arrival && "check" in arrival && !matchesCheck({ ...arrival.check, path }) ? undefined : arrival;
  const inspector = renderOutline(outline);
  const dock = renderDock({ target: checkTarget, text: readerText, problem: checkProblem }, note);
  const status = renderStatus(noteStatus);
  return <>
    {change?.previousPath && <p className="code-review-status">{t("codeReview.renamedFrom", { path: change.previousPath })}</p>}
    {diff || fullText !== undefined ? <CodeReviewReader path={displayPath} original={diff ? (original ?? "") : undefined}
      text={readerText} onCopy={onCopy} viewSwitcher={viewSwitcher} heading={heading}
      fallbackCopy={after.state === "missing" && diff ? original : undefined} footer={status} dock={dock} comparison={comparison}
      readPosition={() => readPosition(positionKey)} onPosition={(position) => savePosition(positionKey, position)}
      onDefinition={onDefinition && !showingOriginal ? (gesture) => onDefinition(gesture, diff ? "diff" : "source") : undefined}
      onReferences={allowLanguageTools && liveSource && api.documentHighlights ? (position, text) => api.documentHighlights?.(project.id, { origin, position, text }) ?? Promise.resolve([]) : undefined}
      outline={inspector} checkResult={checkResult}
      extensionsApi={dependency ? undefined : extensionsApi} extensions={extensions} projectId={project.id} onSyntaxActivity={onSyntaxActivity}
      onBack={onBack} arrival={safeArrival} onArrival={onArrival} />
      : <>{heading}<div className="code-review-reader-body">
        <EmptyState className="code-review-placeholder" icon={<ActionIcon name="document" />} title={t(`codeReview.file.${source.state}`)} />
        {inspector}
      </div>{dock}<div className="code-review-reading-status">{status}</div></>}
    {change && !diffAvailable && fullText !== undefined && <p className="code-review-status" role="status">{t("codeReview.diffUnavailable")}</p>}
  </>;
}

function ReviewNotes({ api, project, path, document, history, status, onSaved }: ProjectProps & {
  path: string;
  document: CodeReviewDocument;
  history: ReviewNote[];
  status: NoteStatus;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const noteId = useId();
  const current = history.find((entry) => entry.evidence === document.evidence);
  const older = history.filter((entry) => entry.evidence !== document.evidence);
  const [note, setNote] = useState(() => reviewNoteDraft(project.key, path, document.evidence) ?? current?.note ?? "");
  const save = useMutation({
    mutationFn: async (status: ReviewNote["status"]) => {
      const latest = await api.file(project.id, path, true);
      if (!latest.evidence || latest.evidence !== document.evidence) throw new Error("codeReviewStale");
      saveReviewNote(project.key, path, { evidence: latest.evidence, status, note, at: new Date().toISOString() });
      saveReviewDraft(project.key, path, latest.evidence, "");
    },
    onSuccess: onSaved,
  });
  return <div className="code-review-notes-body">
      <div className="code-review-note-context">
        <strong title={path}>{basename(path)}</strong>
        {folderName(path) && <span>{folderName(path)}</span>}
        <span className="code-review-note-status" data-status={status} role="status">{t(`codeReview.${status}`)}</span>
      </div>
      <label className="visually-hidden" htmlFor={noteId}>{t("codeReview.notes")}</label>
      <textarea id={noteId} rows={3} wrap="soft" maxLength={2000} value={note} readOnly={save.isPending}
        onChange={(event) => {
          setNote(event.target.value);
          saveReviewDraft(project.key, path, document.evidence, event.target.value, current?.note ?? "");
        }} placeholder={t("codeReview.notePlaceholder")} />
      <div className="code-review-note-actions">
        <Button size="small" variant="secondary" disabled={save.isPending} onClick={() => save.mutate("needsChanges")}>{t("codeReview.needsChanges")}</Button>
        <Button size="small" variant="primary" disabled={save.isPending} onClick={() => save.mutate("reviewed")}>{t("codeReview.markReviewed")}</Button>
      </div>
      {save.isError && <p role="alert">{t(save.error.message === "codeReviewStale" || String(save.error) === "codeReviewStale"
        ? "codeReview.stale" : "codeReview.noteFailed")}</p>}
      {older.length > 0 && <details className="code-review-history">
        <summary>{t("codeReview.history")}</summary>
        <ul>{[...older].reverse().map((entry) => <li key={entry.evidence}>
          <span>{t(`codeReview.${entry.status}`)} · {new Date(entry.at).toLocaleString()}</span>
          {entry.note && <p>{entry.note}</p>}
        </li>)}</ul>
      </details>}
  </div>;
}
