import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type RefObject } from "react";
import { useIsFetching, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "../../design-system/Button";
import { EmptyState } from "../../design-system/EmptyState";
import { ModalSurface } from "../../design-system/ModalSurface";
import { useI18n } from "../../i18n";
import type {
  CodeChangeComparison, CodeDefinitionRequest, CodeDefinitionTarget, CodeExtension, CodeExtensionPlatform, CodeIndexChange,
  CodeFinderAction, CodeFinderTarget, CodeLanguageStatus, CodeNewEntryKind, CodePasteResult, CodeReviewChange, CodeReviewChanges,
  CodeReviewPlatform, CodeReviewProject, CodeSearchMatch,
} from "../../platform/code-review";
import type { RuntimeInfo } from "../../platform/types";
import { setUpdateBlocker } from "../../platform/update-guard";
import { ActionIcon, type ActionIconName } from "../ActionIcon";
import { IconButton } from "../IconButton";
import type { SchemaObjectMenuAction } from "../SchemaObjectMenu";
import { SidebarRail } from "../SidebarRail";
import { Segmented } from "../Segmented";
import { CODE_SHORTCUTS, codeShortcutEvent, formatCommandShortcut, usesAppleKeyboard, type CodeShortcut } from "../command-shortcuts";
import { CodeFileIcon, CodeReviewDraft, type CodeReaderHandle, type DefinitionArrival, type ReadingPosition } from "./CodeReviewReader";
import { CodeProjectsPanel, CodeProjectSwitcher, type ProjectAction } from "./CodeProjectsPanel";
import { CodeReviewChecks } from "./CodeReviewChecks";
import { PythonDebugPanel } from "./PythonDebugPanel";
import { usePythonDebug } from "./use-python-debug";
import { CodeReviewLanguageServices } from "./CodeReviewLanguageServices";
import { CodeReviewExtensions, type ExtensionActivity } from "./CodeReviewExtensions";
import { DirectoryTree, FileViewOptions } from "./CodeDirectoryTree";
import { indexChangedPaths, navigateFiles } from "./code-directory-tree-utils";
import { FileReview, type NoteStatus, type RenderDock, type RenderStatus } from "./CodeFileReview";
import { normalizeReviewText, type CheckFinding, type EslintAvailability, type ReadingMode } from "./code-review-checks";
import { useCodeReviewChecks, type CheckedFile } from "./use-code-review-checks";
import { CodeContentSearch, CodeQuickOpen } from "./CodeQuickOpen";
import { CodePanelDivider } from "./CodePanelDivider";
import { CodeNewEntryDialog } from "./CodeNewEntryDialog";
import { CodeChangesNavigation, CodeWorktreeSwitcher, type CodeChangesView } from "./CodeChangesNavigation";
import { CodeGitReviewControls, type GitReviewFilter, type GitReviewScope } from "./CodeGitReviewControls";
import { changesInScope, rememberReviewedComparisons, reviewStatus } from "./code-git-review";
import { codeReviewKeys } from "./code-review-query-keys";
import { codeReviewSidebarMinWidth, createCodeReviewStore, useCodeReviewLayout, type CodeReviewStore, type ReviewDock } from "./code-review-store";
import { isCodeContextMenuKey, useCodeContextMenu } from "./use-code-context-menu";
import "./code-review.css";

const compactFoldersKey = "nodalstudio:code-review:compact-folders";
const basename = (path: string) => path.split("/").at(-1) ?? path;
const folderName = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));
const noChanges: readonly CodeReviewChange[] = [];
const projectMutationScope = { id: "code-review-active-project" };
const gitRevisionInterval = 2_000;

type CodeSidebarProps = { sidebarId: string; sidebarOpen: boolean; setSidebarOpen: (open: boolean) => void };
type CodeOutlineProps = { outlineId: string; outlineOpen: boolean };
type CodeSearchProps = { searchAnchor?: RefObject<HTMLButtonElement | null> };
type ProjectView = "changes" | "files" | "search" | "extensions";
type NavigatorView = "projects" | ProjectView;
type FinderMenu = (target: CodeFinderTarget, intoParent?: boolean) => SchemaObjectMenuAction[];
type RevealInFinder = (target: CodeFinderTarget) => void;
type Draft = { number: number; text: string };

type ReviewContext = {
  tabs: string[] | undefined;
  selected: string | undefined;
  drafts: ReadonlyMap<string, Draft>;
  draftCount: number;
  view: ProjectView;
  expanded: ReadonlySet<string>;
  modes: ReadonlyMap<string, ReadingMode>;
  comparisonChoices: ReadonlyMap<string, CodeChangeComparison | null>;
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
    style={{ "--code-sidebar-width": `${sidebarWidth}px`, "--code-sidebar-min-width": `${codeReviewSidebarMinWidth}px` } as React.CSSProperties}>
    {children(sidebarOpen ? <SidebarRail side="left" expanded width={sidebarWidth} minWidth={codeReviewSidebarMinWidth} maxWidth={420}
      onResize={setSidebarWidth} onToggle={() => setSidebarOpen(false)} /> : null)}
  </div>;
}

export function CodeReviewWorkspace({ api, allowDefinitions = true, extensionsMode, allowFinder = false, allowFinderReveal = allowFinder, extensionsOffline = false,
  eslintAvailability = "eslintUnavailable", outlineId, outlineOpen, searchAnchor, sidebarId, sidebarOpen, setSidebarOpen }: {
  api: CodeReviewPlatform;
  allowDefinitions?: boolean;
  extensionsMode?: RuntimeInfo["codeExtensions"];
  allowFinder?: boolean;
  allowFinderReveal?: boolean;
  extensionsOffline?: boolean;
  eslintAvailability?: EslintAvailability;
} & CodeSidebarProps & CodeOutlineProps & CodeSearchProps) {
  const { t, locale } = useI18n();
  const client = useQueryClient();
  const [layoutStore] = useState(createCodeReviewStore);
  const workspace = useRef<HTMLElement>(null);
  const [projectFilter, setProjectFilter] = useState("");
  const projectScrollTopRef = useRef(0);
  const project = useQuery({ queryKey: codeReviewKeys.current, queryFn: () => api.current(), retry: false, staleTime: Infinity });
  const library = api.projects;
  const extensionsApi = useMemo(() => {
    if (extensionsMode === "syntax" && api.extensions) return { ...api.extensions, openVsx: undefined };
    return extensionsMode === "full" ? api.extensions : undefined;
  }, [api.extensions, extensionsMode]);
  const finder = allowFinder ? api.finder : undefined;
  const finderReveal = allowFinderReveal ? api.finder : undefined;
  const projects = useQuery({ queryKey: codeReviewKeys.projects, queryFn: () => library?.list() ?? Promise.resolve({ projects: [], groups: [] }),
    enabled: Boolean(library), retry: false, staleTime: Infinity });
  const [showProjects, setShowProjects] = useState(false);
  const [changesView, setChangesView] = useState<CodeChangesView>("local");
  const [worktreeFocus, setWorktreeFocus] = useState<string>();
  const worktreeSwitch = useMutation({
    networkMode: "always",
    scope: projectMutationScope,
    mutationFn: ({ id, path }: { id: string; path: string }) => api.switchWorktree!(id, path),
    onSuccess: (next) => {
      setWorktreeFocus(next.id);
      client.setQueryData(codeReviewKeys.current, next);
    },
  });
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
    networkMode: "always",
    scope: projectMutationScope,
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
        setChangesView("local");
        setWorktreeFocus(undefined);
        worktreeSwitch.reset();
        if (library && !quick) setShowProjects(!showFiles);
        client.setQueryData(codeReviewKeys.current, result ?? null);
      }
      if (library) await client.invalidateQueries({ queryKey: codeReviewKeys.projects });
    },
  });
  const projectBusy = managing || worktreeSwitch.isPending;
  const refreshActiveRef = useRef<(() => void) | undefined>(undefined);
  const runFinder = async (target: CodeFinderTarget, action: CodeFinderAction) => {
    const native = action === "reveal" ? finderReveal : finder;
    if (!native) return;
    setFinderNotice(undefined);
    try {
      const result = await native.act(target, action);
      if (action === "copy") setFinderNotice({ text: t("codeReview.copied") });
      if (action === "paste") {
        setFinderNotice(describePaste(result));
        const active = client.getQueryData<CodeReviewProject | null>(codeReviewKeys.current);
        const sameProject = target.kind === "entry" ? active?.id === target.projectId : target.kind === "project" && active?.savedProjectId === target.id;
        if (result.added && sameProject) refreshActiveRef.current?.();
      }
    } catch (error) {
      setFinderNotice(finderError(error));
    }
  };
  const revealInFinder: RevealInFinder | undefined = finderReveal ? (target) => { void runFinder(target, "reveal"); } : undefined;
  const hasFinderMenu = Boolean(finder || finderReveal);
  const finderMenu: FinderMenu = (target, intoParent) => [
    ...(finderReveal ? [{ label: t("codeReview.files.revealFinder"), separatorBefore: true, run: () => void runFinder(target, "reveal") }] : []),
    ...(finder ? [
      { label: t("codeReview.files.copyItem"), run: () => void runFinder(target, "copy") },
      { label: t(intoParent ? "codeReview.files.pasteIntoFolder" : "codeReview.files.pasteItem"), run: () => void runFinder(target, "paste") },
    ] : []),
  ];
  const catalogEntries = projects.data?.projects;
  const savedProjects = useMemo(() => {
    if (!catalogEntries) return undefined;
    const collator = new Intl.Collator(locale, { numeric: true, sensitivity: "base" });
    return [...catalogEntries].sort((a, b) => collator.compare(a.name, b.name)
      || collator.compare(a.path, b.path) || a.id.localeCompare(b.id));
  }, [locale, catalogEntries]);
  const openProjectList = () => {
    setShowProjects(true);
    setSidebarOpen(true);
  };
  useEffect(() => {
    if (project.isPending || project.data || projectBusy) return;
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
  }, [project.isPending, project.data, projectBusy, manage, savedProjects, setSidebarOpen]);
  const choose = project.data
    ? <IconButton icon="folderOpen" className="code-review-tool" label={t(library ? "codeReview.projects.manage" : "codeReview.switchProject")} disabled={projectBusy}
        onClick={library ? openProjectList : () => manage({ kind: "add" })} />
    : <Button variant="primary" busy={projectBusy} onClick={() => manage({ kind: "add" })}><ActionIcon name="folder" />{t("codeReview.openFolder")}</Button>;
  const missingProject = String(actionError) === "codeReviewSavedProjectUnavailable";
  const panel = library ? <CodeProjectsPanel projects={savedProjects ?? []} groups={projects.data?.groups ?? []} currentId={project.data?.savedProjectId}
    filter={projectFilter} onFilterChange={setProjectFilter} scrollTopRef={projectScrollTopRef}
    finderActions={hasFinderMenu ? (id) => finderMenu({ kind: "project", id }) : undefined}
    allowPasteProjects={Boolean(finder)}
    failedId={missingProject && action?.kind === "open" ? action.id : undefined} busy={projectBusy}
    loading={projects.isPending} loadFailed={projects.isError} onRetry={() => { void projects.refetch(); }}
    onAction={manage} onActionAsync={manageAsync} /> : undefined;
  const switcher = library && project.data ? <CodeProjectSwitcher name={project.data.name} currentId={project.data.savedProjectId}
    projects={savedProjects ?? []} busy={projectBusy} onAction={manage} onManage={openProjectList} /> : undefined;
  const renderOutline = useCallback((outline?: React.ReactNode) => (
    <CodeOutlinePane layoutStore={layoutStore} outlineId={outlineId} outlineOpen={outlineOpen}>{outline}</CodeOutlinePane>
  ), [layoutStore, outlineId, outlineOpen]);

  return <section ref={workspace} className="code-review ds-surface" aria-label={t("codeReview.title")}>
    {worktreeSwitch.isError && <p className="code-review-notice" role="alert">{t("codeReview.worktrees.failed")}</p>}
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
        changesView={changesView} onChangesView={setChangesView} worktreeBusy={projectBusy}
        focusWorktree={project.data.id === worktreeFocus}
        onSwitchWorktree={api.switchWorktree ? (path) => worktreeSwitch.mutate({ id: project.data!.id, path }) : undefined}
        finderMenu={hasFinderMenu ? finderMenu : undefined} revealInFinder={revealInFinder}
        projectsPanel={panel} showProjects={showProjects} setShowProjects={setShowProjects}
        extensionsApi={extensionsApi} extensionsOffline={extensionsOffline} syntaxExtensionsOnly={extensionsMode === "syntax"}
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

function ProjectReview({ api, project, choose, layoutStore, refreshRef, quickOpenInitially, filesInitially, projectSwitcher, finderMenu, revealInFinder, allowDefinitions, eslintAvailability, sidebarId, sidebarOpen, setSidebarOpen,
  outlineOpen, renderOutline, searchAnchor, extensionsApi, extensionsOffline, syntaxExtensionsOnly, projectsPanel, showProjects, setShowProjects,
  changesView, onChangesView, worktreeBusy, focusWorktree, onSwitchWorktree }: ProjectProps & CodeSidebarProps & CodeSearchProps & {
  choose: React.ReactNode;
  layoutStore: CodeReviewStore;
  refreshRef: RefObject<(() => void) | undefined>;
  outlineOpen: boolean;
  renderOutline: (outline?: React.ReactNode) => React.ReactNode;
  quickOpenInitially: boolean;
  filesInitially: boolean;
  changesView: CodeChangesView;
  onChangesView: (view: CodeChangesView) => void;
  worktreeBusy: boolean;
  focusWorktree: boolean;
  onSwitchWorktree?: (path: string) => void;
  projectSwitcher?: React.ReactNode;
  finderMenu?: FinderMenu;
  revealInFinder?: RevealInFinder;
  allowDefinitions: boolean;
  eslintAvailability: EslintAvailability;
  extensionsApi?: CodeExtensionPlatform;
  extensionsOffline: boolean;
  syntaxExtensionsOnly: boolean;
  projectsPanel?: React.ReactNode;
  showProjects: boolean;
  setShowProjects: (open: boolean) => void;
}) {
  const { t, formatNumber } = useI18n();
  const client = useQueryClient();
  const canCompare = project.git === "ready" || project.git === "noBaseline";
  const [remembered] = useState(() => reviewContexts.get(api)?.get(project.key));
  const extensionsKey = codeReviewKeys.extensions(project.id);
  const extensionList = useQuery({
    queryKey: extensionsKey, enabled: Boolean(extensionsApi), retry: false, staleTime: Infinity, networkMode: "always",
    queryFn: () => extensionsApi?.list(project.id) ?? Promise.resolve([]),
  });
  const extensions = extensionsApi ? extensionList.data ?? [] : [];
  const pythonApi = extensionsApi && !syntaxExtensionsOnly ? api.pythonDebug : undefined;
  const pythonReady = extensions.some((extension) => extension.capability === "pythonDebugger" && extension.enabled);
  const python = usePythonDebug(pythonApi, project.id);
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
    queryFn: async () => {
      const snapshot = await api.changes(project.id);
      rememberReviewedComparisons(project.key, snapshot);
      return snapshot;
    },
    refetchOnMount: "always",
    refetchOnWindowFocus: (query) => query.state.data?.git ? "always" : false,
    networkMode: "always",
    retry: false,
  });
  const [refreshingChanges, setRefreshingChanges] = useState(false);
  const [manualRefreshFailed, setManualRefreshFailed] = useState(false);
  const changesBusy = changes.isPending || refreshingChanges;
  const changesFailed = changes.isError && (!changes.data || manualRefreshFailed);
  const checks = useCodeReviewChecks(api, { ...project, baseline: changes.data?.git ? changes.data.git.head ?? changes.data.git.baseline : project.baseline }, eslintAvailability);
  const { run: checkRun, verify: verifyCheck, verifyAll: verifyAllChecks } = checks;
  const filesRefreshing = useIsFetching({ queryKey: codeReviewKeys.directories(project.id) }) > 0;
  const [selectedView, setSelectedView] = useState<ProjectView>(focusWorktree ? "changes" : filesInitially ? "files" : remembered?.view ?? (canCompare ? "changes" : "files"));
  const projectView = (selectedView === "extensions" && !extensionsApi) || (selectedView === "changes" && !canCompare)
    || (selectedView === "search" && !api.searchContent) ? "files" : selectedView;
  const view = projectsPanel && showProjects ? "projects" : projectView;
  const setView = useCallback((next: NavigatorView) => {
    setShowProjects(next === "projects");
    if (next !== "projects") setSelectedView(next);
  }, [setShowProjects]);
  const [tabs, setTabs] = useState(remembered?.tabs);
  const closedTabs = useRef<string[]>([]);
  const [wordWrap, setWordWrap] = useState(false);
  const [selected, setSelected] = useState(remembered?.selected);
  const [drafts, setDrafts] = useState<ReadonlyMap<string, Draft>>(() => remembered?.drafts ?? new Map());
  const draftCount = useRef(remembered?.draftCount ?? 0);
  const [newEntry, setNewEntry] = useState<{ directory: string; kind: CodeNewEntryKind }>();
  const [discardTabs, setDiscardTabs] = useState<readonly string[]>();
  const [filter, setFilter] = useState(remembered?.changesFilter ?? "");
  const [gitScope, setGitScope] = useState<GitReviewScope>("all");
  const [previousReview, setPreviousReview] = useState(false);
  const [reviewFilter, setReviewFilter] = useState<GitReviewFilter>("all");
  const [comparisonChoices, setComparisonChoices] = useState<ReadonlyMap<string, CodeChangeComparison | null>>(() => remembered?.comparisonChoices ?? new Map());
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
  const git = changes.data?.git;
  const indexRevision = git?.indexRevision;
  const lastIndexRevision = useRef(indexRevision);
  useEffect(() => {
    if (lastIndexRevision.current && indexRevision && lastIndexRevision.current !== indexRevision) {
      void client.invalidateQueries({
        queryKey: codeReviewKeys.files(project.id),
        predicate: ({ queryKey }) => queryKey[4] === false,
      });
    }
    lastIndexRevision.current = indexRevision;
  }, [client, indexRevision, project.id]);
  const worktrees = git?.worktrees;
  const modernChanges = Boolean(worktrees);
  const branch = api.branchFile ? changes.data?.branchChanges : undefined;
  const branchView = view === "changes" && changesView === "branch" ? branch : undefined;
  const previousAvailable = Boolean(changes.data?.previousFiles && changes.data.previousStaged);
  const historical = view === "changes" && previousReview && previousAvailable && !branchView;
  const branchReviewKey = branchView ? JSON.stringify([project.key, "branch", branchView.target]) : undefined;
  const localChanges = useMemo(() => changesInScope(changes.data, gitScope), [changes.data, gitScope]);
  const previousChanges = useMemo(() => changes.data?.previousStaged
    ? changesInScope({ ...changes.data, staged: changes.data.previousStaged }, "all") : noChanges, [changes.data]);
  const scoped = branchView?.files ?? (historical ? previousChanges : localChanges);
  const allScoped = useMemo(() => changesInScope(changes.data, "all"), [changes.data]);
  const checkChanges = branchView || historical ? undefined
    : gitScope === "all" ? changes.data : changes.data && { ...changes.data, files: localChanges };
  const byScope = useMemo(() => ({
    staged: new Map((historical ? changes.data?.previousStaged : changes.data?.staged)?.map((entry) => [entry.path, entry] as const)),
    unstaged: new Map(changes.data?.unstaged?.map((entry) => [entry.path, entry] as const)),
  }), [changes.data, historical]);
  const changedPaths = useMemo(() => indexChangedPaths(modernChanges ? allScoped : changed), [allScoped, changed, modernChanges]);
  const firstChange = (branchView?.files ?? (historical ? previousChanges : allScoped))[0]?.path;
  if (tabs === undefined && firstChange) setTabs([firstChange]);
  const openTabs = useMemo(() => tabs ?? [], [tabs]);
  const active = selected && openTabs.includes(selected) ? selected : openTabs[0];
  const activeDraft = active ? drafts.get(active) : undefined;
  const selectedComparison = active ? comparisonChoices.get(active) : undefined;
  const stagedVersion = active ? byScope.staged.get(active) : undefined;
  const unstagedVersion = active ? byScope.unstaged.get(active) : undefined;
  const combinedChange = (historical ? changes.data?.previousFiles : changed)?.find((entry) => entry.path === active);
  const change = branchView ? branchView.files.find((entry) => entry.path === active)
    : selectedComparison === null ? combinedChange
      : (selectedComparison === "staged" ? stagedVersion ?? unstagedVersion : unstagedVersion ?? stagedVersion) ?? combinedChange;
  const readingMode = (active && modes.get(active)) || (change ? "diff" : "source");
  const dependency = active ? externalFiles.get(active) : undefined;
  const revealEntry = revealInFinder ? (path: string) => revealInFinder({ kind: "entry", projectId: project.id, path }) : undefined;
  const revealFileInFinder = (path: string, external?: CodeDefinitionTarget) => {
    if (!external) return revealEntry ? () => revealEntry(path) : undefined;
    if (revealInFinder && external.sourceId && external.path.startsWith("/")) {
      const sourceId = external.sourceId;
      return () => revealInFinder({ kind: "dependency", projectId: project.id, sourceId });
    }
  };
  const pythonFile = !dependency && !activeDraft && active?.endsWith(".py") ? active : undefined;
  const pausedFrame = python.paused?.frames.find((frame) => frame.id === python.paused?.selected);
  const pythonLines = pythonFile ? python.breakpoints[pythonFile] : undefined;
  const pythonVerified = pythonFile ? python.verified[pythonFile] : undefined;
  const pythonPausedLine = pythonFile && pausedFrame?.path === pythonFile ? pausedFrame.line : undefined;
  const pythonToggle = python.toggle;
  const debugSource = useMemo(() => (pythonApi && pythonReady && !extensionsOffline && pythonFile ? {
    lines: pythonLines ?? [],
    verified: pythonVerified ?? [],
    paused: pythonPausedLine,
    toggle: (line: number) => pythonToggle(pythonFile, line),
  } : undefined), [extensionsOffline, pythonApi, pythonFile, pythonLines, pythonPausedLine, pythonReady, pythonToggle, pythonVerified]);
  const openPausedFrame = useRef<(frame: { path: string; line: number }) => void>(() => {});
  useEffect(() => {
    const frame = python.paused?.frames.find((item) => item.id === python.paused?.selected);
    if (frame?.path && frame.line >= 1) openPausedFrame.current({ path: frame.path, line: frame.line });
  }, [python.paused]);

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
    if (focusWorktree && modernChanges) sidebar.current?.querySelector<HTMLElement>(".code-worktree-switcher > summary")?.focus({ preventScroll: true });
  }, [focusWorktree, modernChanges]);

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
      comparisonChoices,
      positions: positions.current,
      recent: recentFiles,
      contentQuery,
      changesFilter: filter,
      showHidden,
      showNote: dock === "note" && Boolean(active),
    });
  }, [active, api, comparisonChoices, contentQuery, dock, drafts, expanded, filter, firstChange, modes, project.key, projectView, recentFiles, showHidden, tabs]);

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
  function selectComparison(path: string, comparison: CodeChangeComparison | null) {
    setComparisonChoices((current) => new Map(current).set(path, comparison));
  }
  const baselineMutation = useMutation({
    networkMode: "always",
    onMutate: () => client.cancelQueries({ queryKey: codeReviewKeys.changes(projectId) }),
    mutationFn: () => api.updateBaseline!(projectId),
    onSuccess: (result) => {
      rememberReviewedComparisons(project.key, result);
      setPreviousReview(false);
      client.setQueryData(codeReviewKeys.changes(projectId), result);
      void client.invalidateQueries({ queryKey: codeReviewKeys.files(projectId) });
    },
    onError: () => setNotice(t("codeReview.gitReview.baselineUnavailable")),
  });
  const indexMutation = useMutation({
    networkMode: "always",
    mutationFn: (input: CodeIndexChange) => api.changeIndex!(projectId, input),
    onSuccess: (_, input) => {
      selectComparison(input.path, input.comparison === "staged" ? "unstaged" : "staged");
      setNotice(t(input.comparison === "staged" ? "codeReview.gitReview.unstagedNotice" : "codeReview.gitReview.stagedNotice"));
    },
    onError: (error) => {
      const code = error instanceof Error ? error.message : String(error);
      const messages = new Map<string, "stale" | "locked" | "unsupported" | "conflict">([
        ["codeReviewStale", "stale"], ["codeReviewIndexLocked", "locked"],
        ["codeReviewIndexUnsupported", "unsupported"], ["codeReviewIndexConflict", "conflict"],
      ]);
      setNotice(t(`codeReview.gitReview.${messages.get(code) ?? "unavailable"}`));
    },
    onSettled: async () => {
      await refetch();
      void client.invalidateQueries({ queryKey: codeReviewKeys.files(projectId) });
    },
  });
  const gitBusy = changesBusy || indexMutation.isPending || baselineMutation.isPending;
  const watchGit = canCompare && view === "changes" && sidebarOpen && !worktreeBusy && !gitBusy;
  const gitRevision = api.gitRevision;
  useEffect(() => {
    if (!watchGit || !gitRevision) return;
    const probe = gitRevision;
    const queryKey = codeReviewKeys.changes(projectId);
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    function schedule() {
      timer = setTimeout(() => { void poll(); }, gitRevisionInterval);
    }
    async function poll() {
      try {
        if (document.visibilityState === "hidden") return;
        const revision = await probe(projectId);
        if (stopped) return;
        const current = client.getQueryData<CodeReviewChanges>(queryKey)?.git?.indexRevision;
        if (!current || current === revision || client.getQueryState(queryKey)?.fetchStatus === "fetching") return;
        await refetch({ cancelRefetch: false });
      } catch {
        // A concurrent Git operation can make the probe temporarily unavailable.
      } finally {
        if (!stopped) schedule();
      }
    }
    schedule();
    return () => { stopped = true; clearTimeout(timer); };
  }, [client, gitRevision, projectId, refetch, watchGit]);
  const indexAllowed = (entry: CodeReviewChange) => Boolean(api.changeIndex && git && (modernChanges || !git.baselineChanged) && !historical && !branchView && !gitBusy && !worktreeBusy
    && entry.comparison && entry.evidence && entry.kind !== "conflict");
  function updateIndex(entry: CodeReviewChange) {
    if (!git || !entry.comparison || !entry.evidence || !indexAllowed(entry)) return;
    setNotice("");
    indexMutation.mutate({ path: entry.path, comparison: entry.comparison, evidence: entry.evidence, indexRevision: git.indexRevision });
  }
  const checkRunRef = useRef(checkRun);
  useLayoutEffect(() => { checkRunRef.current = checkRun; }, [checkRun]);

  const refreshChanges = useCallback(() => {
    setNotice("");
    setRefreshingChanges(true);
    setManualRefreshFailed(false);
    refreshVerifyAbort.current?.abort();
    const controller = new AbortController();
    refreshVerifyAbort.current = controller;
    void refetch({ cancelRefetch: false }).then((result) => {
      if (controller.signal.aborted) return;
      setManualRefreshFailed(result.isError);
      void client.invalidateQueries({ queryKey: codeReviewKeys.files(projectId) });
      const currentRun = checkRunRef.current;
      if (currentRun && currentRun.status !== "running") {
        void verifyAllChecks(currentRun, controller.signal);
      }
    }).finally(() => {
      if (!controller.signal.aborted) setRefreshingChanges(false);
    });
  }, [client, projectId, refetch, verifyAllChecks]);

  const refreshFileTree = useCallback(() => {
    void client.invalidateQueries({ queryKey: codeReviewKeys.directories(projectId) });
    void client.invalidateQueries({ queryKey: codeReviewKeys.paths(projectId) });
  }, [client, projectId]);

  const refreshFiles = useCallback(() => {
    refreshFileTree();
    if (canCompare) refreshChanges();
    else void client.invalidateQueries({ queryKey: codeReviewKeys.files(projectId) });
  }, [canCompare, client, projectId, refreshChanges, refreshFileTree]);

  const refreshProject = useCallback(() => {
    void client.invalidateQueries({ queryKey: codeReviewKeys.contentRoot(projectId) });
    refreshFileTree();
    refreshChanges();
  }, [client, projectId, refreshChanges, refreshFileTree]);

  useEffect(() => {
    refreshRef.current = refreshProject;
    window.addEventListener("nodalstudio:code-refresh", refreshProject);
    return () => {
      refreshRef.current = undefined;
      window.removeEventListener("nodalstudio:code-refresh", refreshProject);
    };
  }, [refreshProject, refreshRef]);
  useEffect(() => () => refreshVerifyAbort.current?.abort(), []);

  const open = (path: string, mode?: ReadingMode, comparison?: CodeChangeComparison | null) => {
    definitionVersion.current += 1;
    setDefinitionDialog(undefined);
    if (mode) setReadingMode(path, mode);
    if (comparison !== undefined) selectComparison(path, comparison);
    closedTabs.current = closedTabs.current.filter((closed) => closed !== path);
    setTabs(openTabs.includes(path) ? openTabs : [...openTabs, path]);
    setSelected(path);
    if (!path.startsWith("\0")) setRecentFiles((current) => [path, ...current.filter((file) => file !== path)].slice(0, 40));
    setNotice("");
  };
  useLayoutEffect(() => {
    openPausedFrame.current = (frame) => {
      setArrival({ key: frame.path, destination: { position: { line: frame.line - 1, character: 0 } } });
      open(frame.path, "source");
    };
  });

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
    client.setQueryData(codeReviewKeys.file(project.id, target.path, target.mode === "diff", target.evidence, target.comparison), latest.document);
    setArrival({ key: target.path, destination: { check: { ...target, text: latest.text, range: finding.range } } });
    setSelectedFinding(finding);
    if (branchView || historical) {
      setPreviousReview(false);
      onChangesView("local");
    }
    open(target.path, target.mode, target.comparison ?? null);
  };

  const closeDock = () => {
    if (pendingFocus.current === "note") pendingFocus.current = undefined;
    detail.current?.querySelector<HTMLButtonElement>(`[data-review-dock-toggle="${dock}"]`)?.focus();
    setDock(undefined);
  };
  const dockLabel = t(dock === "checks" ? "codeReview.checks.title" : dock === "languages" ? "codeReview.languages.title"
    : dock === "debug" ? "codeReview.debug.title" : "codeReview.notes");
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
      {dock === "checks" ? <CodeReviewChecks checks={checks} current={current} changes={checkChanges} extensions={extensions} scrollRef={checksScroll}
        search={findingsFilter} severity={severityFilter} collapsed={collapsedChecks} selected={selectedFinding} toggleFile={(path) => setCollapsedChecks((previous) => {
          const next = new Set(previous);
          if (!next.delete(path)) next.add(path);
          return next;
        })}
        locate={(file, finding) => { void locateCheck(file, finding); }}
        batchUnavailable={!canCompare ? project.git === "folder" ? "folder" : "git"
          : changesBusy ? "loading" : changesFailed ? "git" : !checkChanges?.files.length ? "clean" : undefined} />
        : dock === "languages" ? <CodeReviewLanguageServices status={languageQuery.data} projectName={project.name}
          enable={() => enableLanguages()} enabling={enablingLanguages} error={languageQuery.isError || enableLanguagesFailed} />
        : dock === "debug" && pythonApi ? <PythonDebugPanel api={pythonApi} projectId={project.id} path={pythonFile}
          ready={pythonReady} offline={extensionsOffline} debug={python} onExtensions={() => {
            setView("extensions");
            setSidebarOpen(true);
          }} onFrame={(frame) => {
            if (!frame.path || frame.line < 1) return;
            setArrival({ key: frame.path, destination: { position: { line: frame.line - 1, character: 0 } } });
            open(frame.path, "source");
          }} /> : note?.body ?? <p className="code-review-dock-empty">{t("codeReview.noteSelectChange")}</p>}
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
    const closingFiles = paths.filter((path) => !path.startsWith("\0"));
    closedTabs.current = [...closingFiles, ...closedTabs.current.filter((path) => !paths.includes(path))].slice(0, 40);
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
  const showDebugPanel = () => {
    if (!pythonApi) return false;
    setDock("debug");
    if (pythonFile) setReadingMode(pythonFile, "source");
    return true;
  };
  const selectRelativeTab = (offset: number) => {
    if (!active || openTabs.length < 2) return false;
    const next = openTabs[(openTabs.indexOf(active) + offset + openTabs.length) % openTabs.length];
    pendingFocus.current = "tab";
    open(next);
    return true;
  };
  const shortcutActions = useRef<Partial<Record<CodeShortcut, () => void | boolean>>>({});
  useLayoutEffect(() => {
    const showProjectView = (next: NavigatorView, available: boolean) => {
      if (!available) return false;
      setView(next);
      setSidebarOpen(true);
      return true;
    };
    const debugStep = (kind: "stepOver" | "stepIn" | "stepOut") => {
      if (!pythonApi || python.mode !== "paused" || python.busy) return false;
      python.control({ kind });
      return true;
    };
    shortcutActions.current = {
      "new-draft": newDraft,
      "close-tab": () => { if (active) closeTabs([active]); },
      "close-all-tabs": () => { if (openTabs.length) closeTabs(openTabs); },
      "reopen-tab": () => {
        const path = closedTabs.current.shift();
        if (!path) return false;
        pendingFocus.current = "tab";
        open(path);
        return true;
      },
      "next-tab": () => selectRelativeTab(1),
      "previous-tab": () => selectRelativeTab(-1),
      "project-search": focusProjectSearch,
      files: browseFiles,
      changes: () => showProjectView("changes", canCompare),
      extensions: () => showProjectView("extensions", Boolean(extensionsApi)),
      "debug-panel": showDebugPanel,
      "debug-start": () => {
        if (!pythonApi) return false;
        if (python.mode === "paused" && !python.busy) python.control({ kind: "continue" });
        else if (python.mode === "idle" || python.mode === "finished") {
          const form = detail.current?.querySelector<HTMLFormElement>("[data-python-launch]");
          if (form?.querySelector("button[type=submit]:not(:disabled)")) form.requestSubmit();
          else showDebugPanel();
        }
        return true;
      },
      "debug-stop": () => {
        if (!pythonApi) return false;
        python.stop();
        return true;
      },
      "debug-breakpoint": () => {
        const trigger = detail.current?.querySelector<HTMLButtonElement>("[data-code-breakpoint]");
        trigger?.click();
        return Boolean(trigger);
      },
      "debug-step-over": () => debugStep("stepOver"),
      "debug-step-in": () => debugStep("stepIn"),
      "debug-step-out": () => debugStep("stepOut"),
      "definition-back": () => { if (!back) return false; back(); return true; },
      "word-wrap": () => { if (!active) return false; setWordWrap((wrap) => !wrap); return true; },
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
    const shortcuts = Object.keys(CODE_SHORTCUTS) as CodeShortcut[];
    const listeners = shortcuts.map((shortcut) => {
      const name = codeShortcutEvent(shortcut);
      const run = (event: Event) => {
        const action = shortcutActions.current[shortcut];
        if (action && action() !== false) event.preventDefault();
      };
      window.addEventListener(name, run);
      return { name, run };
    });
    return () => listeners.forEach(({ name, run }) => window.removeEventListener(name, run));
  }, []);

  const query = filter.trim().toLocaleLowerCase();
  const reviewStates = { pending: 0, reviewed: 0, needsChanges: 0, recheck: 0 };
  const scopedStatus = scoped.map((entry) => {
    const status = reviewStatus(branchReviewKey ?? project.key, entry);
    const other = gitScope === "all" && entry.comparison === "unstaged" ? byScope.staged.get(entry.path) : undefined;
    const otherStatus = other ? reviewStatus(project.key, other) : status;
    const combined = (["needsChanges", "recheck", "pending", "reviewed"] as const)
      .find((candidate) => candidate === status || candidate === otherStatus) ?? status;
    reviewStates[combined] += 1;
    const next = status === "pending" || status === "recheck" ? entry
      : otherStatus === "pending" || otherStatus === "recheck" ? other : undefined;
    return { entry, status: combined, next };
  });
  const shown = scopedStatus.filter(({ entry, status }) => entry.path.toLocaleLowerCase().includes(query)
    && (!git || reviewFilter === "all" || reviewFilter === status));
  const nextReview = scopedStatus.filter(({ next }) => next !== undefined);
  const activeReview = nextReview.findIndex(({ entry }) => entry.path === active);
  const nextReviewEntry = nextReview.length ? nextReview[(activeReview + 1) % nextReview.length].next : undefined;
  const displayedLimited = branchView?.limited ?? (historical ? changes.data?.previousLimited : changes.data?.localLimited ?? changes.data?.limited);
  const clean = canCompare && Boolean(changes.data && !scoped.length && !displayedLimited && !changesFailed);
  const grouped = modernChanges && !branchView && !historical;
  const groups = grouped ? (["staged", "unstaged"] as const).map((scope) => ({
    scope,
    entries: [...byScope[scope].values()].filter((entry) => entry.path.toLocaleLowerCase().includes(query))
      .map((entry) => ({ entry, status: reviewStatus(project.key, entry) }))
      .filter(({ status }) => reviewFilter === "all" || reviewFilter === status),
  })) : [];
  const hasMatches = grouped ? groups.some(({ entries }) => entries.length > 0) : shown.length > 0;
  const emptyChangesLabel = branchView ? "codeReview.worktrees.noCommitted" : "codeReview.noChanges";
  function selectChangesView(next: CodeChangesView) {
    if (!historical && next === changesView) return;
    setPreviousReview(false);
    onChangesView(next);
    setFilter("");
    setReviewFilter("all");
    const entries = next === "branch" ? branch?.files ?? noChanges : allScoped;
    const entry = entries.find((item) => item.path === active) ?? entries[0];
    if (entry) open(entry.path, "diff", next === "branch" ? undefined : entry.comparison ?? null);
  }
  function changeScope(scope: GitReviewScope) {
    setGitScope(scope);
    const next = scope !== "all" && active ? byScope[scope].get(active) : undefined;
    if (next?.comparison) selectComparison(next.path, next.comparison);
  }
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
  const createActions = (directory: string): SchemaObjectMenuAction[] => api.createEntry ? [
    { label: t("codeReview.files.newFile"), run: () => setNewEntry({ directory, kind: "file" }) },
    { label: t("codeReview.files.newFolder"), run: () => setNewEntry({ directory, kind: "folder" }) },
  ] : [];
  const folderMenu = (event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>, path: string) => {
    const actions = [...createActions(path), ...(finderMenu?.({ kind: "entry", projectId: project.id, path }) ?? [])];
    if (actions.length) contextMenu.show(event, path ? basename(path) : project.name, actions);
  };
  const fileMenu = (event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>, key: string, source: "tree" | "changes" | "tab", comparison?: CodeChangeComparison) => {
    const draft = drafts.get(key);
    const external = externalFiles.get(key);
    const path = draft ? t("codeReview.draftTitle", { number: draft.number }) : external?.path ?? key;
    const edited = branchView ? branchView.files.find((entry) => entry.path === key)
      : (comparison ? byScope[comparison].get(key) : undefined) ?? (historical ? previousChanges : modernChanges ? allScoped : changed).find((entry) => entry.path === key);
    const tab = source === "tab";
    const right = tab ? openTabs.slice(openTabs.indexOf(key) + 1) : [];
    const trigger = tab ? event.currentTarget.querySelector("button") ?? event.currentTarget : event.currentTarget;
    const reveal = !draft ? revealFileInFinder(key, external) : undefined;
    const diskActions = draft || external || edited?.kind === "deleted"
      ? reveal ? [{ label: t("codeReview.files.revealFinder"), separatorBefore: true, run: reveal }] : []
      : finderMenu?.({ kind: "entry", projectId: project.id, path: key }, true) ?? [];
    contextMenu.show(event, path, [
      ...(!draft && !external && edited?.kind !== "deleted" ? [{ label: t("codeReview.menu.openSource"), run: () => open(key, "source") }] : []),
      ...(edited ? [{ label: t("codeReview.menu.openDiff"), run: () => open(key, "diff", edited.comparison) }] : []),
      ...(edited?.evidence ? [{ label: t("codeReview.menu.openNote"), run: () => { open(key, "diff", edited.comparison); setDock("note"); } }] : []),
      ...(source === "tree" && !draft && !external ? createActions(folderName(key)).map((action, index) => ({
        ...action, separatorBefore: index === 0,
      })) : []),
      ...(edited?.comparison && api.changeIndex && !historical && !branchView ? [{
        label: t(edited.comparison === "staged" ? "codeReview.gitReview.unstage" : "codeReview.gitReview.stage"),
        disabled: !indexAllowed(edited), run: () => updateIndex(edited),
      }] : []),
      ...(!draft ? [{ label: t(external ? "codeReview.menu.copyPath" : "codeReview.menu.copyRelativePath"),
        separatorBefore: Boolean(edited || !external), run: () => copy(path) }] : []),
      ...(!draft && !external && source !== "tree" ? [{ label: t("codeReview.menu.reveal"), run: () => revealFile(key) }] : []),
      ...diskActions,
      ...(tab ? [
        { label: t("codeReview.menu.close"), separatorBefore: !draft, run: () => closeTabs([key]) },
        { label: t("codeReview.menu.closeOthers"), disabled: openTabs.length < 2, run: () => closeTabs(openTabs.filter((item) => item !== key)) },
        { label: t("codeReview.menu.closeRight"), disabled: right.length === 0, run: () => closeTabs(right) },
        { label: t("codeReview.menu.closeAll"), run: () => closeTabs(openTabs) },
      ] : []),
    ], trigger);
  };

  const renderChange = ({ entry, status: review }: { entry: CodeReviewChange; status: NoteStatus }) => {
    const status = git || review !== "pending" ? review : undefined;
    const scopeBadges = !grouped && !branchView && gitScope === "all" && entry.comparison ? (["staged", "unstaged"] as const)
      .filter((comparison) => byScope[comparison].has(entry.path)) : [];
    const folder = folderName(entry.path);
    const selected = entry.path === active && (!grouped || entry.comparison === change?.comparison);
    return <li key={entry.path}><button type="button" className="code-review-change" data-code-row=""
      aria-haspopup="menu" aria-keyshortcuts="Shift+F10"
      onContextMenu={(event) => fileMenu(event, entry.path, "changes", entry.comparison)}
      onKeyDown={(event) => { if (isCodeContextMenuKey(event)) fileMenu(event, entry.path, "changes", entry.comparison); }}
      aria-current={selected ? "true" : undefined} title={entry.path} onClick={() => open(entry.path, "diff", branchView ? undefined : entry.comparison ?? null)}>
      <ActionIcon name={entry.path.endsWith(".sql") ? "codeDocument" : "document"} />
      <span className="code-review-filename">{basename(entry.path)}</span>
      <span className="code-review-kind" data-kind={entry.kind}>{t(`codeReview.kind.${entry.kind}`)}</span>
      {(folder || status || scopeBadges.length > 0) && <span className="code-review-change-meta">
        {folder && <span className="code-review-path">{folder}</span>}
        {scopeBadges.length > 0 && <span className="code-review-git-badges"
          aria-label={scopeBadges.length > 1 ? t("codeReview.gitReview.both") : undefined}>
          {scopeBadges.map((scope) => <span key={scope}>{t(`codeReview.gitReview.${scope}`)}</span>)}
        </span>}
        {status && <span className="code-review-disposition" data-status={status}>{t(`codeReview.${status}`)}</span>}
      </span>}
    </button></li>;
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

  const refreshButton = <IconButton icon="refresh" className="code-review-tool" label={t(changesBusy ? "codeReview.refreshing" : "codeReview.refresh")}
    disabled={changesBusy} aria-busy={changesBusy || undefined} onClick={refreshProject} />;
  const viewLabels = {
    projects: t("codeReview.projects.title"),
    files: t("codeReview.files"), search: t("codeReview.searchResults"),
    changes: t("codeReview.changesLabel"), extensions: t("codeReview.extensions.title"),
  };
  const activitiesAvailable: { view: NavigatorView; icon: ActionIconName }[] = [];
  if (projectsPanel) activitiesAvailable.push({ view: "projects", icon: "folder" });
  activitiesAvailable.push({ view: "files", icon: "documents" });
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
  const baselineCommit = git ? modernChanges && !historical ? git.head : git.baseline : project.baseline;
  const baseline = branchView ? t("codeReview.worktrees.branchRange", { base: branchView.base.slice(0, 10), head: branchView.head.slice(0, 10) })
    : baselineCommit ? t("codeReview.compareBase", { commit: baselineCommit.slice(0, 10) }) : t(`codeReview.git.${project.git}`);
  const alternateScope = stagedVersion && unstagedVersion;
  const diffControls = (current: boolean) => git && active && change?.comparison && readingMode === "diff" ? <div className="code-review-git-diff-actions">
    {alternateScope && <Segmented label={t("codeReview.gitReview.fileComparison")} value={change.comparison}
      options={[
        { value: "unstaged", label: t("codeReview.gitReview.unstaged") },
        { value: "staged", label: t("codeReview.gitReview.staged") },
      ]} onChange={(scope) => selectComparison(active, scope)} />}
    {api.changeIndex && !historical && <Button size="small" disabled={!current || !indexAllowed(change)} onClick={() => updateIndex(change)}>
      {t(change.comparison === "staged" ? "codeReview.gitReview.unstage" : "codeReview.gitReview.stage")}
    </Button>}
  </div> : undefined;
  return <>
    {changesFailed && <p className="code-review-notice" role="alert">{t("codeReview.refreshFailed")}</p>}
    <CodeWorkspaceFrame layoutStore={layoutStore} sidebarOpen={sidebarOpen} setSidebarOpen={setSidebarOpen}>
      {(rail) => <>
        <nav ref={activityBar} className="code-review-activity" aria-label={t("codeReview.navigatorMode")} onKeyDown={navigateActivityBar}>
          {activitiesAvailable.map(({ view: target, icon }) => {
            const isActive = sidebarOpen && view === target;
            const count = target === "changes" && changes.data ? allScoped.length : undefined;
            const shortcut = target === "files" ? CODE_SHORTCUTS.files : target === "search" ? CODE_SHORTCUTS["project-search"]
              : target === "changes" ? CODE_SHORTCUTS.changes : target === "extensions" ? CODE_SHORTCUTS.extensions : undefined;
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
          aria-label={view === "files" ? t("codeReview.projectFiles") : viewLabels[view]} hidden={!sidebarOpen}>
          {view === "projects" ? projectsPanel
          : view === "extensions" && extensionsApi ? <CodeReviewExtensions api={extensionsApi} projectId={project.id} items={extensions}
            loading={extensionList.isPending} loadError={extensionList.isError} retry={() => { void extensionList.refetch(); }}
            refreshing={extensionList.isFetching}
            activities={activities} loadPaths={api.paths} offline={extensionsOffline} syntaxOnly={syntaxExtensionsOnly} active={sidebarOpen} onUpdate={(id, item) => {
              if (!item?.enabled || extensions.some((installed) => installed.id === id && installed.sha256 !== item.sha256)) {
                checks.clearExtension(id);
                setSyntaxActivity((current) => current?.activity.id === id ? undefined : current);
              }
              client.setQueryData<CodeExtension[]>(extensionsKey, (current = []) =>
                [...current.filter((extension) => extension.id !== id), ...(item ? [item] : [])]
                  .sort((a, b) => a.id.localeCompare(b.id)));
            }} />
          : view === "search" ? <CodeContentSearch api={api} projectId={project.id} query={contentQuery}
            onQuery={setContentQuery} onRevealInFinder={revealEntry} onHit={(path, match) => { void locateSearchHit(path, match); }} />
          : <>
          <header className="code-review-header" onContextMenu={view === "files" ? (event) => folderMenu(event, "") : undefined}
            onKeyDown={view === "files" ? (event) => { if (isCodeContextMenuKey(event)) folderMenu(event, ""); } : undefined}>
            {view === "files" && <>
              {projectSwitcher ?? <h2 className="code-review-project-name" title={project.name}>{project.name}</h2>}
              {!projectSwitcher && choose}
            </>}
            {view === "changes" && onSwitchWorktree && worktrees && <CodeWorktreeSwitcher worktrees={worktrees}
              busy={worktreeBusy || indexMutation.isPending || baselineMutation.isPending} onSwitch={onSwitchWorktree}
              onRevealInFinder={revealInFinder ? (path) => revealInFinder({ kind: "worktree", projectId: project.id, path }) : undefined} />}
            <div className="code-review-header-actions" role="group" aria-label={t("codeReview.panelActions", { name: viewLabels[view] })}>
              {view === "files" ? <>
                <IconButton icon="refresh" className="code-review-tool" label={t("codeReview.refreshFiles")}
                  disabled={filesRefreshing || (canCompare && changesBusy)} onClick={refreshFiles} />
                {api.createEntry && <IconButton icon="documentAdd" className="code-review-tool" label={t("codeReview.files.newFile")}
                  onClick={() => setNewEntry({ directory: "", kind: "file" })} />}
                {sidebarOpen && <FileViewOptions compactFolders={compactFolders} showHidden={showHidden}
                  toggleCompactFolders={toggleCompactFolders} toggleHidden={() => setShowHidden((visible) => !visible)} />}
              </> : <IconButton icon="refresh" className="code-review-tool" label={t("codeReview.refreshChanges")}
                disabled={changesBusy || worktreeBusy} onClick={refreshChanges} />}
            </div>
          </header>
          {view === "changes" && modernChanges && <CodeChangesNavigation view={branchView ? "branch" : "local"} branch={branch} head={git?.head}
            localCount={allScoped.length} localLimited={Boolean(changes.data?.localLimited)} previous={historical} onView={selectChangesView} />}
          {view === "changes" && git && <CodeGitReviewControls git={git} scope={gitScope} filter={reviewFilter} counts={reviewStates}
            canAdvance={Boolean(nextReviewEntry)} canUpdateBaseline={Boolean(api.updateBaseline)} busy={gitBusy}
            showNavigation={!modernChanges} previous={historical} onPrevious={previousAvailable && !branchView ? () => {
              setPreviousReview(true);
              setFilter("");
              setReviewFilter("all");
              const entry = previousChanges.find((item) => item.path === active) ?? previousChanges[0];
              if (entry) open(entry.path, "diff", entry.comparison ?? null);
            } : undefined}
            onScope={changeScope} onFilter={setReviewFilter} onNext={() => {
              if (nextReviewEntry) {
                setReviewFilter("all");
                setFilter("");
                pendingFocus.current = "tab";
                open(nextReviewEntry.path, "diff", nextReviewEntry.comparison);
              }
            }} onUpdateBaseline={() => baselineMutation.mutate()} />}
          {view === "changes" && scoped.length > 0 && <div className="code-review-sidebar-controls">
            <div className="code-review-filter">
              <ActionIcon name="search" />
              <input type="search" value={filter} onChange={(event) => setFilter(event.target.value)} placeholder={t("codeReview.filter")} aria-label={t("codeReview.filter")} />
            </div>
          </div>}
          <div className="code-review-file-list" ref={list} aria-busy={view === "changes" && changesBusy || undefined}
            onContextMenu={(event) => { if (view === "files" && event.target === event.currentTarget) folderMenu(event, ""); }}
            onKeyDown={navigateFiles}>
            {view === "files" ? <>
              {changes.data?.limited && <p role="status">{t("codeReview.limited")}</p>}
              <DirectoryTree api={api} project={project} path="" active={active}
                focusedKey={focusedTreeKey} onFocusRow={setFocusedTreeKey} onOpen={open} onFileMenu={fileMenu}
                onFolderMenu={finderMenu || api.createEntry ? folderMenu : undefined} reveal={reveal} showHidden={showHidden}
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
                {displayedLimited && <p role="status">{t("codeReview.limited")}</p>}
                {!hasMatches && !changesFailed && !clean && (git || query) && <p role="status">{t("codeReview.noMatches")}</p>}
                {clean && active && <p role="status">{t(emptyChangesLabel)}</p>}
                {grouped ? groups.filter(({ entries }) => entries.length > 0).map(({ scope, entries }) =>
                  <details key={scope} className="code-changes-group" open>
                    <summary><ActionIcon name="chevronDown" />{t(`codeReview.gitReview.${scope}`)}</summary>
                    <ul>{entries.map(renderChange)}</ul>
                  </details>)
                  : <ul>{shown.map(renderChange)}</ul>}
              </>}
          </div>
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
            {pythonApi && <IconButton icon="play" className="code-review-tool" label={t("codeReview.debug.title")}
              description={formatCommandShortcut(CODE_SHORTCUTS["debug-panel"])}
              data-review-dock-toggle="debug" aria-expanded={dock === "debug"} aria-controls={dock === "debug" ? dockId : undefined}
              onClick={() => {
                if (dock === "debug") closeDock();
                else showDebugPanel();
              }} />}
            <IconButton icon="add" className="code-review-tool" label={t("codeReview.newDraft")}
              description={formatCommandShortcut(CODE_SHORTCUTS["new-draft"])}
              aria-keyshortcuts={usesAppleKeyboard() ? "Meta+N" : "Control+N"} onClick={newDraft} />
          </header>
          {active && activeDraft ? <CodeReviewDraft key={active} title={t("codeReview.draftTitle", { number: activeDraft.number })}
            wrap={wordWrap}
            text={activeDraft.text} onEdit={(text) => setDrafts((current) => new Map(current).set(active, { ...activeDraft, text }))}
            outline={renderOutline()} dock={renderDock()} footer={renderStatus()} readerRef={readerRef} />
          : active ? <FileReview key={active}
            api={api} project={project} path={active} dependency={dependency} change={change} mode={readingMode}
            branchReviewKey={change ? branchReviewKey : undefined} previousReview={historical && Boolean(change)}
            onRevealInFinder={revealFileInFinder(active, dependency)} onRevealFolderInFinder={dependency ? undefined : revealEntry}
            allowLanguageTools={allowDefinitions} eslintAvailability={eslintAvailability}
            showOutline={outlineOpen} renderOutline={renderOutline} renderDock={renderDock} renderStatus={renderStatus}
            checkFiles={checkRun?.status === "running" ? undefined : checkRun?.files}
            extensionsApi={extensionsApi} extensions={extensions} onSyntaxActivity={onSyntaxActivity}
            readerRef={readerRef}
            wrap={wordWrap}
            debugSource={debugSource}
            locateOutline={(position) => {
              setArrival({ key: active, destination: { position } });
              setReadingMode(active, "source");
            }}
            baseline={baseline} baselineCommit={baselineCommit} gitControls={diffControls} readPosition={readPosition} savePosition={savePosition} onModeChange={(mode) => {
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
                title={t(view === "changes" && clean ? emptyChangesLabel : "codeReview.selectFile")}
                description={branchView && clean ? undefined : t(view === "changes" && clean ? "codeReview.cleanHelp" : "codeReview.selectFileHelp")}
                actions={view === "changes" || !sidebarOpen ? <Button onClick={browseFiles}>{t("codeReview.browseFiles")}</Button> : undefined} />
              {renderOutline()}
            </div>{renderDock()}<div className="code-review-reading-status">{renderStatus()}<span>{baseline}</span></div></>}
          <div className="code-review-announcement" role="status">{notice && <p>{notice}</p>}</div>
        </div>
      </>}
    </CodeWorkspaceFrame>
    {contextMenu.surface}
    {newEntry && api.createEntry && <CodeNewEntryDialog kind={newEntry.kind}
      location={newEntry.directory ? `${project.name}/${newEntry.directory}` : project.name}
      create={(name) => api.createEntry!(project.id, newEntry.directory, name, newEntry.kind)}
      onDismiss={() => setNewEntry(undefined)} onCreated={(path) => {
        setNewEntry(undefined);
        refreshProject();
        revealFile(path);
        if (newEntry.kind === "file") open(path, "source");
      }} />}
    {(api.paths || api.searchContent) && <CodeQuickOpen api={api} projectId={project.id} visible={Boolean(quickOpen)} anchor={searchAnchor}
      contentQuery={contentQuery} onContentQuery={setContentQuery}
      onRevealInFinder={revealEntry}
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
