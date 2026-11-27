import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type RefObject } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "../../design-system/Button";
import { EmptyState } from "../../design-system/EmptyState";
import { ModalSurface } from "../../design-system/ModalSurface";
import { useI18n } from "../../i18n";
import type {
  CodeDefinitionRequest, CodeDefinitionTarget, CodeExtension, CodeExtensionPlatform,
  CodeFinderAction, CodeFinderTarget, CodeLanguageStatus, CodePasteResult, CodeReviewChange,
  CodeReviewPlatform, CodeReviewProject, CodeSearchMatch,
} from "../../platform/code-review";
import { setUpdateBlocker } from "../../platform/update-guard";
import { ActionIcon, type ActionIconName } from "../ActionIcon";
import { IconButton } from "../IconButton";
import type { SchemaObjectMenuAction } from "../SchemaObjectMenu";
import { SidebarRail } from "../SidebarRail";
import { CODE_SHORTCUTS, codeShortcutEvent, formatCommandShortcut, usesAppleKeyboard, type CodeShortcut } from "../command-shortcuts";
import { CodeFileIcon, CodeReviewDraft, type CodeReaderHandle, type DefinitionArrival, type ReadingPosition } from "./CodeReviewReader";
import { CodeProjectsPanel, CodeProjectSwitcher, type ProjectAction } from "./CodeProjectsPanel";
import { CodeReviewChecks } from "./CodeReviewChecks";
import { CodeReviewLanguageServices } from "./CodeReviewLanguageServices";
import { CodeReviewExtensions, type ExtensionActivity } from "./CodeReviewExtensions";
import { DirectoryTree, FileViewOptions } from "./CodeDirectoryTree";
import { indexChangedPaths, navigateFiles } from "./code-directory-tree-utils";
import { FileReview, type RenderDock, type RenderStatus } from "./CodeFileReview";
import { normalizeReviewText, type CheckFinding, type EslintAvailability, type ReadingMode } from "./code-review-checks";
import { useCodeReviewChecks, type CheckedFile } from "./use-code-review-checks";
import { CodeContentSearch, CodeQuickOpen } from "./CodeQuickOpen";
import { CodePanelDivider } from "./CodePanelDivider";
import { reviewHistory } from "./code-review-notes";
import { codeReviewKeys } from "./code-review-query-keys";
import { createCodeReviewStore, useCodeReviewLayout, type CodeReviewStore, type ReviewDock } from "./code-review-store";
import { isCodeContextMenuKey, useCodeContextMenu } from "./use-code-context-menu";
import "./code-review.css";

const compactFoldersKey = "nodalstudio:code-review:compact-folders";
const basename = (path: string) => path.split("/").at(-1) ?? path;
const folderName = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));
const noChanges: readonly CodeReviewChange[] = [];

type CodeSidebarProps = { sidebarId: string; sidebarOpen: boolean; setSidebarOpen: (open: boolean) => void };
type CodeOutlineProps = { outlineId: string; outlineOpen: boolean };
type CodeSearchProps = { searchAnchor?: RefObject<HTMLButtonElement | null> };
type ProjectView = "changes" | "files" | "search" | "extensions";
type NavigatorView = "projects" | ProjectView;
type FinderMenu = (target: CodeFinderTarget, intoParent?: boolean) => SchemaObjectMenuAction[];
type Draft = { number: number; text: string };

type ReviewContext = {
  tabs: string[] | undefined;
  selected: string | undefined;
  drafts: ReadonlyMap<string, Draft>;
  draftCount: number;
  view: ProjectView;
  expanded: ReadonlySet<string>;
  modes: ReadonlyMap<string, ReadingMode>;
  positions: Map<string, ReadingPosition>;
  recent: string[];
  contentQuery: string;
  changesFilter: string;
  showHidden: boolean;
  showNote: boolean;
};

const reviewContexts = new WeakMap<CodeReviewPlatform, Map<string, ReviewContext>>();

function activeLanguageWorkspace(status: CodeLanguageStatus | undefined) {
  const workspaces = status?.state === "workspaces" ? status.workspaces : [];
  return workspaces.find((workspace) => workspace.progress)
    ?? workspaces.find((workspace) => workspace.state === "starting" || workspace.state === "queued");
}

function CodeOutlinePane({ layoutStore, outlineId, outlineOpen, children }: {
  layoutStore: CodeReviewStore;
  outlineId: string;
  outlineOpen: boolean;
  children?: React.ReactNode;
}) {
  const { t } = useI18n();
  const outlineWidth = useCodeReviewLayout(layoutStore, (state) => state.outlineWidth);
  const setOutlineWidth = useCodeReviewLayout(layoutStore, (state) => state.setOutlineWidth);
  if (!outlineOpen) return null;
  return <>
    <CodePanelDivider orientation="vertical" panelId={outlineId} label={t("codeReview.outline")}
      size={outlineWidth} min={132} max={480} ratio={0.48} onResize={setOutlineWidth} />
    <aside id={outlineId} className="code-outline" aria-label={t("codeReview.outline")} style={{ width: outlineWidth }}>
      <header><h3>{t("codeReview.outline")}</h3></header>
      <div className="code-outline-scroll">{children ?? <p>{t("codeReview.outlineSelectFile")}</p>}</div>
    </aside>
  </>;
}

function CodeWorkspaceFrame({ layoutStore, sidebarOpen, setSidebarOpen, children }: {
  layoutStore: CodeReviewStore;
  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;
  children: (rail: React.ReactNode) => React.ReactNode;
}) {
  const sidebarWidth = useCodeReviewLayout(layoutStore, (state) => state.sidebarWidth);
  const setSidebarWidth = useCodeReviewLayout(layoutStore, (state) => state.setSidebarWidth);
  return <div className="code-review-workspace" data-sidebar={sidebarOpen ? "open" : "closed"}
    style={{ "--code-sidebar-width": `${sidebarWidth}px` } as React.CSSProperties}>
    {children(sidebarOpen ? <SidebarRail side="left" expanded width={sidebarWidth} minWidth={176} maxWidth={420}
      onResize={setSidebarWidth} onToggle={() => setSidebarOpen(false)} /> : null)}
  </div>;
}

export function CodeReviewWorkspace({ api, allowDefinitions = true, allowExtensions = false, allowFinder = false, extensionsOffline = false,
  eslintAvailability = "eslintUnavailable", outlineId, outlineOpen, searchAnchor, sidebarId, sidebarOpen, setSidebarOpen }: {
  api: CodeReviewPlatform;
  allowDefinitions?: boolean;
  allowExtensions?: boolean;
  allowFinder?: boolean;
  extensionsOffline?: boolean;
  eslintAvailability?: EslintAvailability;
} & CodeSidebarProps & CodeOutlineProps & CodeSearchProps) {
  const { t } = useI18n();
  const client = useQueryClient();
  const [layoutStore] = useState(createCodeReviewStore);
  const workspace = useRef<HTMLElement>(null);
  const project = useQuery({ queryKey: codeReviewKeys.current, queryFn: () => api.current(), retry: false, staleTime: Infinity });
  const library = api.projects;
  const finder = allowFinder ? api.finder : undefined;
  const projects = useQuery({ queryKey: codeReviewKeys.projects, queryFn: () => library?.list() ?? Promise.resolve({ projects: [], groups: [] }),
    enabled: Boolean(library), retry: false, staleTime: Infinity });
  const [showProjects, setShowProjects] = useState(false);
  const [searchAfterPick, setSearchAfterPick] = useState<string>();
  const [filesAfterSwitch, setFilesAfterSwitch] = useState<string>();
  const [finderNotice, setFinderNotice] = useState<{ text: string; error?: boolean }>();
  const describePaste = (result: CodePasteResult, addProjects = false) => ({
    text: result.added === 0 ? t(addProjects ? "codeReview.projects.clipboardFoldersOnly" : "codeReview.files.pasteFailed")
      : t(addProjects ? "codeReview.projects.pastedFolders" : "codeReview.files.pastedItems", result),
    error: result.added === 0,
  });
  const finderError = (error: unknown) => ({
    text: t(String(error) === "codeReviewClipboardEmpty" ? "codeReview.files.clipboardEmpty"
      : String(error) === "codeReviewClipboardLimit" ? "codeReview.files.clipboardLimit"
        : "codeReview.files.actionFailed"),
    error: true,
  });
  const { mutate: manage, mutateAsync: manageAsync, isPending: managing, error: actionError, variables: action } = useMutation({
    mutationFn: async (input: ProjectAction) => {
      setFinderNotice(undefined);
      if (input.kind === "add") return api.choose();
      if (input.kind === "open") return library?.open(input.id);
      if (input.kind === "relocate") return library?.relocate(input.id);
      if (input.kind === "remove") {
        const activeProject = client.getQueryData<CodeReviewProject | null>(codeReviewKeys.current);
        const removed = await library?.remove(input.id);
        if (activeProject?.savedProjectId === input.id) {
          reviewContexts.get(api)?.delete(activeProject.key);
        }
        return removed;
      }
      if (input.kind === "pin") await library?.pin(input.id, input.pinned);
      if (input.kind === "group") await library?.editGroups(input.input);
      if (input.kind === "pasteProjects" && finder) {
        try {
          setFinderNotice(describePaste(await finder.addProjects(), true));
        } catch (error) {
          setFinderNotice(finderError(error));
        }
      }
    },
    onSuccess: async (result, input) => {
      if (result || input.kind === "remove") {
        const quick = input.kind === "add" && input.quickOpen;
        const showFiles = input.kind === "open" && input.fromFiles;
        setSearchAfterPick(quick ? result?.id : undefined);
        setFilesAfterSwitch(showFiles ? result?.id : undefined);
        if (library && !quick) setShowProjects(!showFiles);
        client.setQueryData(codeReviewKeys.current, result ?? null);
      }
      if (library) await client.invalidateQueries({ queryKey: codeReviewKeys.projects });
    },
  });
  const refreshActiveRef = useRef<(() => void) | undefined>(undefined);
  const finderMenu: FinderMenu | undefined = finder ? (target, intoParent) => {
    const run = async (act: CodeFinderAction) => {
      setFinderNotice(undefined);
      try {
        const result = await finder.act(target, act);
        if (act === "copy") setFinderNotice({ text: t("codeReview.copied") });
        if (act === "paste") {
          setFinderNotice(describePaste(result));
          const active = client.getQueryData<CodeReviewProject | null>(codeReviewKeys.current);
          const sameProject = target.kind === "entry" ? active?.id === target.projectId : active?.savedProjectId === target.id;
          if (result.added && sameProject) refreshActiveRef.current?.();
        }
      } catch (error) {
        setFinderNotice(finderError(error));
      }
    };
    return [
      { label: t("codeReview.files.revealFinder"), separatorBefore: true, run: () => void run("reveal") },
      { label: t("codeReview.files.copyItem"), run: () => void run("copy") },
      { label: t(intoParent ? "codeReview.files.pasteIntoFolder" : "codeReview.files.pasteItem"), run: () => void run("paste") },
    ];
  } : undefined;
  const savedProjects = projects.data?.projects;
  const openProjectList = () => {
    setShowProjects(true);
    setSidebarOpen(true);
  };
  useEffect(() => {
    if (project.isPending || project.data || managing) return;
    let frame = 0;
    const focusProjects = () => {
      setSidebarOpen(true);
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => workspace.current?.querySelector<HTMLInputElement>("[data-code-project-filter]")?.focus());
    };
    const open = () => {
      if (savedProjects?.length) focusProjects();
      else manage({ kind: "add", quickOpen: true });
    };
    window.addEventListener("nodalstudio:code-quick-open", open);
    if (savedProjects?.length) window.addEventListener("nodalstudio:code-find", focusProjects);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("nodalstudio:code-quick-open", open);
      window.removeEventListener("nodalstudio:code-find", focusProjects);
    };
  }, [project.isPending, project.data, managing, manage, savedProjects, setSidebarOpen]);
  const choose = project.data
    ? <IconButton icon="folderOpen" className="code-review-tool" label={t(library ? "codeReview.projects.manage" : "codeReview.switchProject")} disabled={managing}
        onClick={library ? openProjectList : () => manage({ kind: "add" })} />
    : <Button variant="primary" busy={managing} onClick={() => manage({ kind: "add" })}><ActionIcon name="folder" />{t("codeReview.openFolder")}</Button>;
  const missingProject = String(actionError) === "codeReviewSavedProjectUnavailable";
  const panel = library ? <CodeProjectsPanel projects={savedProjects ?? []} groups={projects.data?.groups ?? []} currentId={project.data?.savedProjectId}
    finderActions={finderMenu ? (id) => finderMenu({ kind: "project", id }) : undefined}
    failedId={missingProject && action?.kind === "open" ? action.id : undefined} busy={managing}
    loading={projects.isPending} loadFailed={projects.isError} onRetry={() => { void projects.refetch(); }}
    onAction={manage} onActionAsync={manageAsync} /> : undefined;
  const switcher = library && project.data ? <CodeProjectSwitcher name={project.data.name} currentId={project.data.savedProjectId}
    projects={savedProjects ?? []} busy={managing} onAction={manage} onManage={openProjectList} /> : undefined;
  const renderOutline = useCallback((outline?: React.ReactNode) => (
    <CodeOutlinePane layoutStore={layoutStore} outlineId={outlineId} outlineOpen={outlineOpen}>{outline}</CodeOutlinePane>
  ), [layoutStore, outlineId, outlineOpen]);

  return <section ref={workspace} className="code-review ds-surface" aria-label={t("codeReview.title")}>
    {finderNotice && <p className="code-review-notice" role={finderNotice.error ? "alert" : "status"}>{finderNotice.text}</p>}
    {actionError && <p className="code-review-notice" role="alert">{t(
      missingProject ? "codeReview.projects.unavailable"
        : String(actionError) === "codeReviewProjectAlreadyAdded" ? "codeReview.projects.alreadyAdded"
          : String(actionError) === "codeReviewDuplicateGroupName" ? "codeReview.projects.duplicateGroup"
            : String(actionError) === "codeReviewInvalidGroupName" ? "codeReview.projects.invalidGroup"
              : library ? "codeReview.projects.actionFailed" : "codeReview.openFailed",
    )}</p>}
    {project.isPending ? <p className="code-review-status" role="status">{t("navigation.loadingWorkspace")}</p>
      : project.data ? <ProjectReview key={project.data.id} api={api} project={project.data} choose={choose}
        layoutStore={layoutStore} refreshRef={refreshActiveRef}
        quickOpenInitially={project.data.id === searchAfterPick}
        filesInitially={project.data.id === filesAfterSwitch} projectSwitcher={switcher}
        finderMenu={finderMenu}
        projectsPanel={panel} showProjects={showProjects} setShowProjects={setShowProjects}
        extensionsApi={allowExtensions ? api.extensions : undefined} extensionsOffline={extensionsOffline}
        allowDefinitions={allowDefinitions} eslintAvailability={eslintAvailability} outlineOpen={outlineOpen}
        renderOutline={renderOutline} searchAnchor={searchAnchor} sidebarId={sidebarId} sidebarOpen={sidebarOpen} setSidebarOpen={setSidebarOpen} />
      : panel ? <CodeWorkspaceFrame layoutStore={layoutStore} sidebarOpen={sidebarOpen} setSidebarOpen={setSidebarOpen}>
        {(rail) => <>
          <nav className="code-review-activity" aria-label={t("codeReview.navigatorMode")}>
            <IconButton className="code-review-tool code-review-activity-button" icon="folder"
              label={t("codeReview.projects.title")} aria-pressed={sidebarOpen} aria-controls={sidebarId}
              onClick={() => setSidebarOpen(!sidebarOpen)} />
          </nav>
          <aside id={sidebarId} className="code-review-sidebar" hidden={!sidebarOpen}
            aria-label={t("codeReview.projects.title")}>{panel}</aside>
          {rail}
          <div className="code-review-detail"><div className="code-review-reader-body">
            <EmptyState className="code-review-placeholder" icon={<ActionIcon name="codeDocument" />}
              title={t("codeReview.title")} description={t("codeReview.projects.select")}
              actions={savedProjects?.length ? !sidebarOpen && <Button onClick={openProjectList}>{t("codeReview.projects.title")}</Button> : choose} />
            {renderOutline()}
          </div></div>
        </>}
      </CodeWorkspaceFrame> : <div className="code-review-reader-body">
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

function CodeDockFrame({ layoutStore, dock, dockId, dockLabel, onEscape, children }: {
  layoutStore: CodeReviewStore;
  dock: ReviewDock;
  dockId: string;
  dockLabel: string;
  onEscape: () => void;
  children: React.ReactNode;
}) {
  const height = useCodeReviewLayout(layoutStore, (state) => state.dockSizes[dock]);
  const setDockSize = useCodeReviewLayout(layoutStore, (state) => state.setDockSize);
  return <>
    <CodePanelDivider orientation="horizontal" panelId={dockId} label={dockLabel} size={height}
      min={144} max={700} ratio={0.65} onResize={(next) => setDockSize(dock, next)} />
    <aside id={dockId} className="code-review-dock" style={{ height }} aria-label={dockLabel}
      onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onEscape(); } }}>
      {children}
    </aside>
  </>;
}

function ProjectReview({ api, project, choose, layoutStore, refreshRef, quickOpenInitially, filesInitially, projectSwitcher, finderMenu, allowDefinitions, eslintAvailability, sidebarId, sidebarOpen, setSidebarOpen,
  outlineOpen, renderOutline, searchAnchor, extensionsApi, extensionsOffline, projectsPanel, showProjects, setShowProjects }: ProjectProps & CodeSidebarProps & CodeSearchProps & {
  choose: React.ReactNode;
  layoutStore: CodeReviewStore;
  refreshRef: RefObject<(() => void) | undefined>;
  outlineOpen: boolean;
  renderOutline: (outline?: React.ReactNode) => React.ReactNode;
  quickOpenInitially: boolean;
  filesInitially: boolean;
  projectSwitcher?: React.ReactNode;
  finderMenu?: FinderMenu;
  allowDefinitions: boolean;
  eslintAvailability: EslintAvailability;
  extensionsApi?: CodeExtensionPlatform;
  extensionsOffline: boolean;
  projectsPanel?: React.ReactNode;
  showProjects: boolean;
  setShowProjects: (open: boolean) => void;
}) {
  const { t, formatNumber } = useI18n();
  const client = useQueryClient();
  const canCompare = project.git === "ready" || project.git === "noBaseline";
  const [remembered] = useState(() => reviewContexts.get(api)?.get(project.key));
  const checks = useCodeReviewChecks(api, project, eslintAvailability);
  const { run: checkRun, verify: verifyCheck, verifyAll: verifyAllChecks } = checks;
  const extensionsKey = codeReviewKeys.extensions(project.id);
  const extensionList = useQuery({
    queryKey: extensionsKey, enabled: Boolean(extensionsApi), retry: false, staleTime: Infinity,
    queryFn: () => extensionsApi?.list(project.id) ?? Promise.resolve([]),
  });
  const extensions = extensionsApi ? extensionList.data ?? [] : [];
  const [syntaxActivity, setSyntaxActivity] = useState<{ path: string; activity: ExtensionActivity }>();
  const onSyntaxActivity = useCallback((path: string, activity: ExtensionActivity) => {
    setSyntaxActivity({ path, activity });
  }, []);
  const [dock, setDock] = useState<ReviewDock | undefined>(remembered?.showNote ? "note" : undefined);
  const dockId = useId();
  const languageApi = allowDefinitions ? api.languageServices : undefined;
  const canSearchContent = api.searchContent !== undefined;
  const languageQuery = useQuery({
    queryKey: codeReviewKeys.languages(project.id),
    enabled: Boolean(languageApi),
    queryFn: () => languageApi?.status(project.id) ?? Promise.resolve({ state: "disabled" as const }),
    refetchInterval: ({ state: { data } }) => {
      if (!data || data.state === "disabled" || data.state === "failed" || data.state === "offline") return false;
      if (data.state === "discovering" || activeLanguageWorkspace(data)) return 350;
      return dock === "languages" && (typeof document === "undefined" || document.hasFocus()) ? 1500 : false;
    },
    retry: false,
  });
  const { mutate: enableLanguages, isPending: enablingLanguages, isError: enableLanguagesFailed } = useMutation({
    mutationFn: () => languageApi?.enable(project.id) ?? Promise.resolve(),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: codeReviewKeys.languages(project.id) });
      void client.invalidateQueries({ queryKey: codeReviewKeys.outlines(project.id) });
    },
  });
  const activeLanguage = activeLanguageWorkspace(languageQuery.data);
  const languageBusy = languageQuery.data?.state === "discovering" || Boolean(activeLanguage);
  const languagePercent = activeLanguage?.progress?.percentage;
  const [findingsFilter, setFindingsFilter] = useState("");
  const [severityFilter, setSeverityFilter] = useState<"all" | CheckFinding["severity"]>("all");
  const [collapsedChecks, setCollapsedChecks] = useState<ReadonlySet<string>>(() => new Set());
  const [selectedFinding, setSelectedFinding] = useState<CheckFinding>();
  const checksScroll = useRef<{ runId: number | undefined; top: number }>({ runId: undefined, top: 0 });
  const changes = useQuery({
    queryKey: codeReviewKeys.changes(project.id),
    queryFn: () => api.changes(project.id),
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
    retry: false,
  });
  const [selectedView, setSelectedView] = useState<ProjectView>(filesInitially ? "files" : remembered?.view ?? (canCompare ? "changes" : "files"));
  const projectView = (selectedView === "extensions" && !extensionsApi) || (selectedView === "changes" && !canCompare) ? "files" : selectedView;
  const view = projectsPanel && showProjects ? "projects" : projectView;
  const setView = useCallback((next: NavigatorView) => {
    setShowProjects(next === "projects");
    if (next !== "projects") setSelectedView(next);
  }, [setShowProjects]);
  const [tabs, setTabs] = useState(remembered?.tabs);
  const [selected, setSelected] = useState(remembered?.selected);
  const [drafts, setDrafts] = useState<ReadonlyMap<string, Draft>>(() => remembered?.drafts ?? new Map());
  const draftCount = useRef(remembered?.draftCount ?? 0);
  const [discardTabs, setDiscardTabs] = useState<readonly string[]>();
  const [filter, setFilter] = useState(remembered?.changesFilter ?? "");
  const [contentQuery, setContentQuery] = useState(remembered?.contentQuery ?? "");
  const [notice, setNotice] = useState("");
  const [quickOpen, setQuickOpen] = useState<{ findInFile: boolean } | undefined>(quickOpenInitially ? { findInFile: false } : undefined);
  const [recentFiles, setRecentFiles] = useState(remembered?.recent ?? []);
  const [reveal, setReveal] = useState<{ path: string }>();
  const [focusedTreeKey, setFocusedTreeKey] = useState<string>();
  const contextMenu = useCodeContextMenu();
  const [modes, setModes] = useState<ReadonlyMap<string, ReadingMode>>(() => remembered?.modes ?? new Map());
  const [externalFiles, setExternalFiles] = useState<ReadonlyMap<string, CodeDefinitionTarget>>(() => new Map());
  const [returnPoints, setReturnPoints] = useState<ReturnPoint[]>([]);
  const [arrival, setArrival] = useState<{ key: string; destination: DefinitionArrival }>();
  const [definitionDialog, setDefinitionDialog] = useState<DefinitionDialog>();
  const definitionVersion = useRef(0);
  const positions = useRef(remembered?.positions ?? new Map<string, ReadingPosition>());
  const readPosition = useCallback((key: string) => positions.current.get(key), []);
  const savePosition = useCallback((key: string, position: ReadingPosition) => { positions.current.set(key, position); }, []);
  const [showHidden, setShowHidden] = useState(remembered?.showHidden ?? false);
  const [compactFolders, setCompactFolders] = useState(() => {
    try { return localStorage.getItem(compactFoldersKey) !== "false"; }
    catch { return true; }
  });
  const toggleCompactFolders = () => {
    const enabled = !compactFolders;
    setCompactFolders(enabled);
    try { localStorage.setItem(compactFoldersKey, String(enabled)); } catch { /* The current workspace can still use the setting. */ }
  };
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => remembered?.expanded ?? new Set());
  const [, setNoteRevision] = useState(0);
  const activityBar = useRef<HTMLElement>(null);
  const sidebar = useRef<HTMLElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const detail = useRef<HTMLDivElement>(null);
  const toolbar = useRef<HTMLElement>(null);
  const readerRef = useRef<CodeReaderHandle>(null);
  const refreshVerifyAbort = useRef<AbortController | null>(null);
  const pendingFocus = useRef<"list" | "filter" | "search" | "tab" | "checks" | "note" | undefined>(undefined);
  const changed = changes.data?.files ?? noChanges;
  const changedPaths = useMemo(() => indexChangedPaths(changed), [changed]);
  const firstChange = changed[0]?.path;
  const openTabs = useMemo(() => tabs ?? (firstChange ? [firstChange] : []), [firstChange, tabs]);
  const active = selected && openTabs.includes(selected) ? selected : openTabs[0];
  const activeDraft = active ? drafts.get(active) : undefined;
  const change = changed.find((entry) => entry.path === active);
  const readingMode = (active && modes.get(active)) || (change ? "diff" : "source");
  const dependency = active ? externalFiles.get(active) : undefined;

  const hasUnsavedDrafts = useMemo(() => [...drafts.values()].some((draft) => draft.text.length > 0), [drafts]);
  useEffect(() => {
    setUpdateBlocker(
      `code-drafts:${project.key}`,
      hasUnsavedDrafts ? "copy or discard your unsaved Code session drafts before installing the update" : undefined,
    );
    return () => { setUpdateBlocker(`code-drafts:${project.key}`, undefined); };
  }, [hasUnsavedDrafts, project.key]);

  useLayoutEffect(() => {
    if (filesInitially) sidebar.current?.querySelector<HTMLButtonElement>("[data-code-project-switcher]")?.focus({ preventScroll: true });
  }, [filesInitially]);

  useLayoutEffect(() => {
    let contexts = reviewContexts.get(api);
    if (!contexts) {
      contexts = new Map();
      reviewContexts.set(api, contexts);
    }
    const localTabs = tabs?.filter((path) => !path.startsWith("\0") || drafts.has(path));
    contexts.set(project.key, {
      tabs: localTabs ?? (firstChange ? [firstChange] : undefined),
      selected: active && (!active.startsWith("\0") || drafts.has(active)) ? active : undefined,
      drafts,
      draftCount: draftCount.current,
      view: projectView,
      expanded,
      modes,
      positions: positions.current,
      recent: recentFiles,
      contentQuery,
      changesFilter: filter,
      showHidden,
      showNote: dock === "note" && Boolean(active),
    });
  }, [active, api, contentQuery, dock, drafts, expanded, filter, firstChange, modes, project.key, projectView, recentFiles, showHidden, tabs]);

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
      if (api.paths) setQuickOpen({ findInFile: Boolean(readerRef.current || detail.current?.querySelector("[data-code-find]")) });
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
    const focus = pendingFocus.current;
    const target = focus === "tab" ? detail.current?.querySelector<HTMLElement>(".code-review-tabs [aria-current]")
      : focus === "checks" ? detail.current?.querySelector<HTMLElement>(".code-checks-filters input")
      : focus === "note" ? detail.current?.querySelector<HTMLTextAreaElement>(".code-review-note-composer textarea")
      : focus === "filter" ? sidebar.current?.querySelector<HTMLElement>("input[type=search]")
      : focus === "search" ? sidebar.current?.querySelector<HTMLElement>("[data-code-content-field]")
      : list.current?.querySelector<HTMLElement>("[data-code-row]") ?? activityBar.current?.querySelector<HTMLElement>("button[aria-pressed=true]");
    if (!target) return;
    pendingFocus.current = undefined;
    target.focus();
  }, [active, dock, sidebarOpen, view, openTabs.length, changed.length]);

  const focusProjectSearch = useCallback(() => {
    if (!canSearchContent) return false;
    const input = sidebarOpen && sidebar.current?.querySelector<HTMLInputElement>("[data-code-content-field]");
    if (input) input.focus();
    else {
      pendingFocus.current = "search";
      setSidebarOpen(true);
      setView("search");
    }
    return true;
  }, [canSearchContent, setSidebarOpen, setView, sidebarOpen]);

  useEffect(() => {
    function find() {
      if (readerRef.current) {
        readerRef.current.openFind();
        return;
      }
      const action = detail.current?.querySelector<HTMLButtonElement>("[data-code-find]");
      if (action) {
        action.click();
        return;
      }
      if (focusProjectSearch()) return;
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
  }, [canCompare, changed.length, focusProjectSearch, setSidebarOpen, setView, sidebarOpen, view]);

  const { refetch } = changes;
  const projectId = project.id;
  const checkRunRef = useRef(checkRun);
  useLayoutEffect(() => { checkRunRef.current = checkRun; }, [checkRun]);

  const refreshProject = useCallback(() => {
    setNotice("");
    refreshVerifyAbort.current?.abort();
    const controller = new AbortController();
    refreshVerifyAbort.current = controller;
    void client.invalidateQueries({ queryKey: codeReviewKeys.directories(projectId) });
    void client.invalidateQueries({ queryKey: codeReviewKeys.paths(projectId) });
    void client.invalidateQueries({ queryKey: codeReviewKeys.contentRoot(projectId) });
    void refetch().then(() => {
      void client.invalidateQueries({ queryKey: codeReviewKeys.files(projectId) });
      const currentRun = checkRunRef.current;
      if (currentRun && currentRun.status !== "running") {
        void verifyAllChecks(currentRun, controller.signal);
      }
    });
  }, [client, projectId, refetch, verifyAllChecks]);

  useEffect(() => {
    refreshRef.current = refreshProject;
    window.addEventListener("nodalstudio:code-refresh", refreshProject);
    return () => {
      refreshRef.current = undefined;
      refreshVerifyAbort.current?.abort();
      window.removeEventListener("nodalstudio:code-refresh", refreshProject);
    };
  }, [refreshProject, refreshRef]);

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
      client.setQueryData(codeReviewKeys.file(project.id, path, false), source);
      setArrival({ key: path, destination: { position: match, match: match.matched } });
      open(path, "source");
    } catch {
      if (version === definitionVersion.current) setNotice(t("codeReview.fileFailed"));
    }
  };

  const locateCheck = async (file: CheckedFile, finding: CheckFinding) => {
    if (!checkRun) return;
    const version = ++definitionVersion.current;
    const latest = await verifyCheck(file, checkRun);
    if (!latest || version !== definitionVersion.current) return;
    const { target } = file;
    client.setQueryData(codeReviewKeys.file(project.id, target.path, target.mode === "diff", target.evidence), latest.document);
    setArrival({ key: target.path, destination: { check: { ...target, text: latest.text, range: finding.range } } });
    setSelectedFinding(finding);
    open(target.path, target.mode);
  };

  const closeDock = () => {
    if (pendingFocus.current === "note") pendingFocus.current = undefined;
    detail.current?.querySelector<HTMLButtonElement>(`[data-review-dock-toggle="${dock}"]`)?.focus();
    setDock(undefined);
  };
  const dockLabel = t(dock === "checks" ? "codeReview.checks.title" : dock === "languages" ? "codeReview.languages.title" : "codeReview.notes");
  const renderDock: RenderDock = (current, note) => dock && (
    <CodeDockFrame layoutStore={layoutStore} dock={dock} dockId={dockId} dockLabel={dockLabel} onEscape={closeDock}>
      <header className="code-review-dock-header">
        <h3>{dockLabel}</h3>
        {dock === "note" && note && <>
          <div className="code-review-note-target" title={note.path}>
            <CodeFileIcon path={note.path} />
            <strong>{basename(note.path)}</strong>
            {folderName(note.path) && <span>{folderName(note.path)}</span>}
          </div>
          <span className="code-review-note-status code-review-note-badge" data-status={note.status}
            role="status">{t(`codeReview.${note.status}`)}</span>
        </>}
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
        : dock === "languages" ? <CodeReviewLanguageServices status={languageQuery.data} projectName={project.name}
          enable={() => enableLanguages()} enabling={enablingLanguages} error={languageQuery.isError || enableLanguagesFailed} />
          : note?.body ?? <p className="code-review-dock-empty">{t("codeReview.noteSelectChange")}</p>}
    </CodeDockFrame>
  );

  const { errors, warnings } = useMemo(() => {
    let errorCount = 0;
    let totalCount = 0;
    for (const file of checkRun?.files ?? []) {
      if (file.status !== "checked") continue;
      for (const finding of file.findings) {
        totalCount += 1;
        if (finding.severity === "error") errorCount += 1;
      }
    }
    return { errors: errorCount, warnings: totalCount - errorCount };
  }, [checkRun?.files]);

  const renderStatus: RenderStatus = (status) => <>
    <button type="button" className="code-review-dock-toggle" data-review-dock-toggle="checks"
      aria-expanded={dock === "checks"} aria-controls={dock === "checks" ? dockId : undefined}
      aria-label={t(dock === "checks" ? "codeReview.checks.hide" : "codeReview.checks.show", { errors, warnings })}
      onClick={() => setDock((current) => current === "checks" ? undefined : "checks")}>
      <span data-severity="error"><ActionIcon name="error" />{errors}</span>
      <span data-severity="warning"><ActionIcon name="warning" />{warnings}</span>
    </button>
    {languageApi && <button type="button" className="code-review-dock-toggle code-language-toggle" data-review-dock-toggle="languages"
      aria-expanded={dock === "languages"} aria-controls={dock === "languages" ? dockId : undefined}
      data-busy={languageBusy}
      onClick={() => setDock((current) => current === "languages" ? undefined : "languages")}>
      <ActionIcon name={languageBusy ? "refresh" : "codeDocument"} />
      <span>{t("codeReview.languages.title")}</span>
      {languageBusy && <span className="code-language-progress-label">
        {languagePercent == null ? t("codeReview.languages.initializing") : formatNumber(languagePercent / 100, { style: "percent" })}
      </span>}
    </button>}
    {status && <button type="button" className="code-review-dock-toggle" data-review-dock-toggle="note"
      aria-expanded={dock === "note"} aria-controls={dock === "note" ? dockId : undefined}
      aria-label={t("codeReview.noteToggle", { status: t(`codeReview.${status}`) })}
      onClick={() => {
        if (dock === "note") closeDock();
        else {
          pendingFocus.current = "note";
          setDock("note");
        }
      }}>
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
      if (input.enable) {
        void client.invalidateQueries({ queryKey: codeReviewKeys.outlines(project.id) });
        void client.invalidateQueries({ queryKey: codeReviewKeys.languages(project.id) });
      }
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
        case "offline": setNotice(t("codeReview.languages.offline")); break;
        case "stale": setNotice(t("codeReview.definitionStale")); break;
        case "unavailable": setNotice(t("codeReview.definitionUnavailable")); break;
      }
    } catch {
      if (version === definitionVersion.current) setNotice(t("codeReview.definitionUnavailable"));
    }
  };
  const closeTabs = (paths: readonly string[], discard = false) => {
    if (!discard && paths.some((path) => drafts.get(path)?.text)) {
      setDiscardTabs(paths);
      return;
    }
    if (paths.some((path) => drafts.has(path))) {
      setDrafts(new Map(Array.from(drafts).filter(([path]) => !paths.includes(path))));
    }
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
  const browseFiles = () => {
    const row = sidebarOpen && view === "files" && list.current?.querySelector<HTMLButtonElement>("[data-code-row]");
    if (row) {
      row.focus();
      return;
    }
    pendingFocus.current = "list";
    setSidebarOpen(true);
    setView("files");
  };
  const newDraft = () => {
    const number = ++draftCount.current;
    const key = `\0draft:${number}`;
    setDrafts((current) => new Map(current).set(key, { number, text: "" }));
    open(key);
  };

  const shortcutActions = useRef<Record<CodeShortcut, () => void | boolean>>({
    "new-draft": () => undefined,
    "project-search": () => false,
    files: () => undefined,
    checks: () => undefined,
    "go-to-line": () => false,
  });
  useLayoutEffect(() => {
    shortcutActions.current = {
      "new-draft": newDraft,
      "project-search": focusProjectSearch,
      files: browseFiles,
      checks: () => {
        if (dock === "checks") closeDock();
        else {
          pendingFocus.current = "checks";
          setDock("checks");
        }
      },
      "go-to-line": () => {
        if (readerRef.current) {
          readerRef.current.openGoToLine();
          return true;
        }
        const trigger = detail.current?.querySelector<HTMLButtonElement>("[data-code-go-to-line]");
        trigger?.click();
        return Boolean(trigger);
      },
    };
  });
  useEffect(() => {
    const shortcuts: CodeShortcut[] = ["new-draft", "project-search", "files", "checks", "go-to-line"];
    const listeners = shortcuts.map((shortcut) => {
      const name = codeShortcutEvent(shortcut);
      const run = (event: Event) => { if (shortcutActions.current[shortcut]() !== false) event.preventDefault(); };
      window.addEventListener(name, run);
      return { name, run };
    });
    return () => listeners.forEach(({ name, run }) => window.removeEventListener(name, run));
  }, []);

  const query = filter.trim().toLocaleLowerCase();
  const shown = useMemo(() => changed.filter((entry) => entry.path.toLocaleLowerCase().includes(query)), [changed, query]);
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
  const folderMenu = (event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>, path: string) => {
    if (finderMenu) contextMenu.show(event, path ? basename(path) : project.name,
      finderMenu({ kind: "entry", projectId: project.id, path }));
  };
  const fileMenu = (event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>, key: string, source: "tree" | "changes" | "tab") => {
    const draft = drafts.get(key);
    const external = externalFiles.get(key);
    const path = draft ? t("codeReview.draftTitle", { number: draft.number }) : external?.path ?? key;
    const edited = changed.find((entry) => entry.path === key);
    const tab = source === "tab";
    const right = tab ? openTabs.slice(openTabs.indexOf(key) + 1) : [];
    const trigger = tab ? event.currentTarget.querySelector("button") ?? event.currentTarget : event.currentTarget;
    contextMenu.show(event, path, [
      ...(!draft && !external && edited?.kind !== "deleted" ? [{ label: t("codeReview.menu.openSource"), run: () => open(key, "source") }] : []),
      ...(edited ? [{ label: t("codeReview.menu.openDiff"), run: () => open(key, "diff") }] : []),
      ...(edited?.evidence ? [{ label: t("codeReview.menu.openNote"), run: () => { open(key, "diff"); setDock("note"); } }] : []),
      ...(!draft ? [{ label: t(external ? "codeReview.menu.copyPath" : "codeReview.menu.copyRelativePath"),
        separatorBefore: Boolean(edited || !external), run: () => copy(path) }] : []),
      ...(!draft && !external && source !== "tree" ? [{ label: t("codeReview.menu.reveal"), run: () => revealFile(key) }] : []),
      ...(!draft && !external && edited?.kind !== "deleted" ? finderMenu?.({ kind: "entry", projectId: project.id, path: key }, true) ?? [] : []),
      ...(tab ? [
        { label: t("codeReview.menu.close"), separatorBefore: !draft, run: () => closeTabs([key]) },
        { label: t("codeReview.menu.closeOthers"), disabled: openTabs.length < 2, run: () => closeTabs(openTabs.filter((item) => item !== key)) },
        { label: t("codeReview.menu.closeRight"), disabled: right.length === 0, run: () => closeTabs(right) },
        { label: t("codeReview.menu.closeAll"), run: () => closeTabs(openTabs) },
      ] : []),
    ], trigger);
  };

  const quickOpenRecent = useMemo(
    () => [...recentFiles, ...openTabs.filter((key) => !key.startsWith("\0"))],
    [openTabs, recentFiles],
  );
  const quickOpenUntracked = useMemo(
    () => changed.filter((entry) => entry.kind === "added" && !entry.indexOnly).map((entry) => entry.path),
    [changed],
  );
  const quickOpenUnavailable = useMemo(
    () => new Set(changed.filter((entry) => entry.kind === "deleted").map((entry) => entry.path)),
    [changed],
  );

  const refreshButton = <IconButton icon="refresh" className="code-review-tool" label={t(changes.isFetching ? "codeReview.refreshing" : "codeReview.refresh")}
    disabled={changes.isFetching} aria-busy={changes.isFetching || undefined} onClick={refreshProject} />;
  const viewLabels = {
    projects: t("codeReview.projects.title"),
    files: t("codeReview.files"), search: t("codeReview.searchResults"),
    changes: t("codeReview.changesLabel"), extensions: t("codeReview.extensions.title"),
  };
  const activitiesAvailable: { view: NavigatorView; icon: ActionIconName }[] = [];
  if (projectsPanel) activitiesAvailable.push({ view: "projects", icon: "folder" });
  activitiesAvailable.push({ view: "files", icon: "document" });
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
    <CodeWorkspaceFrame layoutStore={layoutStore} sidebarOpen={sidebarOpen} setSidebarOpen={setSidebarOpen}>
      {(rail) => <>
        <nav ref={activityBar} className="code-review-activity" aria-label={t("codeReview.navigatorMode")} onKeyDown={navigateActivityBar}>
          {activitiesAvailable.map(({ view: target, icon }) => {
            const isActive = sidebarOpen && view === target;
            const count = target === "changes" ? changes.data?.files.length : undefined;
            const shortcut = target === "files" ? CODE_SHORTCUTS.files : target === "search" ? CODE_SHORTCUTS["project-search"] : undefined;
            return <IconButton key={target} className="code-review-tool code-review-activity-button" icon={icon}
              label={count === undefined ? viewLabels[target] : t("codeReview.changes", { count })}
              description={shortcut ? formatCommandShortcut(shortcut) : undefined}
              aria-pressed={isActive} aria-controls={sidebarId} onClick={() => {
                setView(target);
                setSidebarOpen(!isActive);
              }}>
              {count !== undefined && count > 0 && <span className="code-review-activity-count" aria-hidden="true">{count > 99 ? "99+" : count}</span>}
            </IconButton>;
          })}
        </nav>
        <aside ref={sidebar} id={sidebarId} className="code-review-sidebar"
          aria-label={view === "projects" ? viewLabels.projects : t("codeReview.projectFiles")} hidden={!sidebarOpen}>
          {view === "projects" ? projectsPanel : <>
          <header className="code-review-header">
            <h1>{viewLabels[view]}</h1>
            <div className="code-review-header-actions" role="group" aria-label={t("codeReview.projectActions")}>
              {refreshButton}{choose}
            </div>
          </header>
          {view === "extensions" && extensionsApi ? <CodeReviewExtensions api={extensionsApi} projectId={project.id} items={extensions}
            loading={extensionList.isPending} loadError={extensionList.isError} retry={() => { void extensionList.refetch(); }}
            activities={activities} offline={extensionsOffline} active={sidebarOpen} onUpdate={(id, item) => {
              if (!item?.enabled || extensions.some((installed) => installed.id === id && installed.sha256 !== item.sha256)) {
                checks.clearExtension(id);
                setSyntaxActivity((current) => current?.activity.id === id ? undefined : current);
              }
              client.setQueryData<CodeExtension[]>(extensionsKey, (current = []) =>
                [...current.filter((extension) => extension.id !== id), ...(item ? [item] : [])]
                  .sort((a, b) => a.id.localeCompare(b.id)));
            }} /> : <>
          {view === "files" && <div className="code-review-files-toolbar" onContextMenu={(event) => folderMenu(event, "")}
            onKeyDown={(event) => { if (isCodeContextMenuKey(event)) folderMenu(event, ""); }}>
            {projectSwitcher ?? <h2 className="code-review-project-name" title={project.name}>{project.name}</h2>}
            {sidebarOpen && <FileViewOptions compactFolders={compactFolders} showHidden={showHidden}
              toggleCompactFolders={toggleCompactFolders} toggleHidden={() => setShowHidden((visible) => !visible)} />}
          </div>}
          {view === "changes" && changed.length > 0 && <div className="code-review-sidebar-controls">
            <div className="code-review-filter">
              <ActionIcon name="search" />
              <input type="search" value={filter} onChange={(event) => setFilter(event.target.value)} placeholder={t("codeReview.filter")} aria-label={t("codeReview.filter")} />
            </div>
          </div>}
          {view === "search" ? <div className="code-content-pane">
            {api.searchContent && <CodeContentSearch api={api} projectId={project.id} query={contentQuery}
              onQuery={setContentQuery} onHit={(path, match) => { void locateSearchHit(path, match); }} />}
          </div> :
          <div className="code-review-file-list" ref={list} aria-busy={view === "changes" && changes.isFetching || undefined}
            onContextMenu={(event) => { if (view === "files" && event.target === event.currentTarget) folderMenu(event, ""); }}
            onKeyDown={navigateFiles}>
            {view === "files" ? <>
              {changes.data?.limited && <p role="status">{t("codeReview.limited")}</p>}
              <DirectoryTree api={api} project={project} path="" active={active}
                focusedKey={focusedTreeKey} onFocusRow={setFocusedTreeKey} onOpen={open} onFileMenu={fileMenu}
                onFolderMenu={finderMenu ? folderMenu : undefined} reveal={reveal} showHidden={showHidden}
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
          </>}
        </aside>
        {rail}
        <div className="code-review-detail" ref={detail}>
          <header className="code-review-editor-bar" ref={toolbar} tabIndex={-1}>
            {!sidebarOpen && <div className="code-review-header-actions">{refreshButton}{choose}</div>}
            {returnPoints.length > 0 && <IconButton icon="chevronLeft" className="code-review-tool" label={t("codeReview.definitionBack")} onClick={back} />}
            <nav className="code-review-tabs" aria-label={t("codeReview.openFiles")} onKeyDown={navigateTabBar}>
              {openTabs.map((key) => {
                const draft = drafts.get(key);
                const path = draft ? t("codeReview.draftTitle", { number: draft.number }) : externalFiles.get(key)?.path ?? key;
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
            <IconButton icon="add" className="code-review-tool" label={t("codeReview.newDraft")}
              description={formatCommandShortcut(CODE_SHORTCUTS["new-draft"])}
              aria-keyshortcuts={usesAppleKeyboard() ? "Meta+N" : "Control+N"} onClick={newDraft} />
          </header>
          {active && activeDraft ? <CodeReviewDraft key={active} title={t("codeReview.draftTitle", { number: activeDraft.number })}
            text={activeDraft.text} onEdit={(text) => setDrafts((current) => new Map(current).set(active, { ...activeDraft, text }))}
            outline={renderOutline()} dock={renderDock()} footer={renderStatus()} readerRef={readerRef} />
          : active ? <FileReview key={JSON.stringify([active, change?.evidence])}
            api={api} project={project} path={active} dependency={dependency} change={change} mode={readingMode}
            allowLanguageTools={allowDefinitions} eslintAvailability={eslintAvailability}
            showOutline={outlineOpen} renderOutline={renderOutline} renderDock={renderDock} renderStatus={renderStatus}
            checkFiles={checkRun?.status === "running" ? undefined : checkRun?.files}
            extensionsApi={extensionsApi} extensions={extensions} onSyntaxActivity={onSyntaxActivity}
            readerRef={readerRef}
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
            onSaved={() => setNoteRevision((current) => current + 1)} onRefresh={refreshProject} onCopy={copy}
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
      </>}
    </CodeWorkspaceFrame>
    {contextMenu.surface}
    {(api.paths || api.searchContent) && <CodeQuickOpen api={api} projectId={project.id} visible={Boolean(quickOpen)} anchor={searchAnchor}
      contentQuery={contentQuery} onContentQuery={setContentQuery}
      recent={quickOpenRecent} untracked={quickOpenUntracked} unavailable={quickOpenUnavailable}
      onOpen={(path, position) => {
        if (position) setArrival({ key: path, destination: { position } });
        else pendingFocus.current = "tab";
        open(path, "source");
      }}
      onHit={(path, match) => void locateSearchHit(path, match)}
      onFind={quickOpen?.findInFile ? () => {
        requestAnimationFrame(() => {
          if (readerRef.current) readerRef.current.openFind();
          else detail.current?.querySelector<HTMLButtonElement>("[data-code-find]")?.click();
        });
      } : undefined}
      onDismiss={() => setQuickOpen(undefined)} />}
    {discardTabs && <ModalSurface label={t("codeReview.discardDraft")} onDismiss={() => setDiscardTabs(undefined)}>
      <div className="code-definition-dialog ds-surface">
        <h2>{t("codeReview.discardDraft")}</h2>
        <p>{t("codeReview.discardDraftDetail")}</p>
        <div className="code-review-note-actions">
          <Button data-modal-focus onClick={() => setDiscardTabs(undefined)}>{t("codeReview.cancel")}</Button>
          <Button variant="danger" onClick={() => { closeTabs(discardTabs, true); setDiscardTabs(undefined); }}>{t("codeReview.discardDraftConfirm")}</Button>
        </div>
      </div>
    </ModalSurface>}
    {definitionDialog && definitionDialog.point.key === active && <ModalSurface
      label={t("codeReview.definition")} onDismiss={() => setDefinitionDialog(undefined)}>
      <div className="code-definition-dialog ds-surface">
        {definitionDialog.kind === "enable" ? <>
          <h2>{t("codeReview.definitionEnable")}</h2>
          <p>{t("codeReview.definitionTrust")}</p>
          <div className="code-review-note-actions">
            <Button data-modal-focus onClick={() => setDefinitionDialog(undefined)}>{t("codeReview.cancel")}</Button>
            <Button variant="primary" onClick={() => void lookUpDefinition(definitionDialog.point, { ...definitionDialog.input, enable: true })}>
              {t("codeReview.definitionEnable")}
            </Button>
          </div>
        </> : <>
          <h2>{t("codeReview.definitionChoose")}</h2>
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

function navigateTabBar(event: KeyboardEvent<HTMLElement>) {
  const { key } = event;
  if (key !== "ArrowLeft" && key !== "ArrowRight" && key !== "Home" && key !== "End") return;
  const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(".code-review-tab > button:first-child")];
  const index = buttons.findIndex((button) => button === event.target);
  if (index < 0 || buttons.length < 2) return;
  const next = key === "Home" ? 0 : key === "End" ? buttons.length - 1
    : (index + (key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
  event.preventDefault();
  buttons[next].focus();
}
