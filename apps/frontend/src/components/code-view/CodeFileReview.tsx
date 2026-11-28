import { useId, useState, type ReactNode, type Ref } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "../../design-system/Button";
import { EmptyState } from "../../design-system/EmptyState";
import { useI18n } from "../../i18n";
import type {
  CodeChangeComparison, CodeDefinitionPosition, CodeDefinitionTarget, CodeExtension, CodeExtensionPlatform,
  CodeReviewChange, CodeReviewDocument, CodeReviewPlatform, CodeReviewProject, CodeReviewVersion,
} from "../../platform/code-review";
import { ActionIcon } from "../ActionIcon";
import { Segmented } from "../Segmented";
import { CodeFileIcon, CodeReviewReader, type CodeReaderHandle, type DefinitionArrival, type DefinitionGesture, type ReadingPosition } from "./CodeReviewReader";
import { CodeReviewOutline } from "./CodeReviewOutline";
import type { ExtensionActivity } from "./CodeReviewExtensions";
import { checkTargetProblem, isEslintSource, normalizeReviewText, type EslintAvailability, type ReadingMode } from "./code-review-checks";
import type { CheckedFile, DisplayedCheckTarget } from "./use-code-review-checks";
import { supportsCodeNavigation } from "./code-review-file-types";
import { reviewHistory, reviewNoteDraft, saveReviewDraft, saveReviewNote, type ReviewNote } from "./code-review-notes";
import { versionReviewStatus } from "./code-git-review";
import { codeReviewKeys } from "./code-review-query-keys";
import type { PythonDebugSource } from "./python-debug-source";
import { isCodeContextMenuKey, useCodeContextMenu } from "./use-code-context-menu";

const textFor = (version: CodeReviewVersion | null | undefined) => version?.state === "text" ? version.text : undefined;

export type NoteStatus = ReviewNote["status"] | "recheck" | "pending";
export type RenderDock = (current?: DisplayedCheckTarget, note?: { path: string; status: NoteStatus; body: ReactNode }) => ReactNode;
export type RenderStatus = (status?: NoteStatus) => ReactNode;

export function FileReview({ api, project, path, dependency, change, mode, baseline, baselineCommit, readPosition, savePosition, onModeChange, onSaved, onRefresh, onCopy, onRevealInFinder, onRevealFolderInFinder, gitControls,
  onDefinition, allowLanguageTools, eslintAvailability, onBack, arrival, onArrival, showOutline, locateOutline, renderOutline, renderDock, renderStatus,
  checkFiles, extensionsApi, extensions, onSyntaxActivity, readerRef, debugSource, wrap, branchReviewKey, previousReview }: {
  api: CodeReviewPlatform;
  project: CodeReviewProject;
  path: string;
  dependency?: CodeDefinitionTarget;
  change?: CodeReviewChange;
  mode: ReadingMode;
  baseline: string;
  baselineCommit?: string | null;
  branchReviewKey?: string;
  previousReview?: boolean;
  gitControls?: ReactNode;
  readPosition: (key: string) => ReadingPosition | undefined;
  savePosition: (key: string, position: ReadingPosition) => void;
  onModeChange: (mode: ReadingMode) => void;
  onSaved: () => void;
  onRefresh: () => void;
  onCopy: (text: string) => void;
  onRevealInFinder?: () => void;
  onRevealFolderInFinder?: (path: string) => void;
  onDefinition?: (gesture: DefinitionGesture, mode: ReadingMode) => void;
  allowLanguageTools: boolean;
  eslintAvailability: EslintAvailability;
  locateOutline: (position: CodeDefinitionPosition) => void;
  showOutline: boolean;
  renderOutline: (outline?: ReactNode) => ReactNode;
  renderDock: RenderDock;
  renderStatus: RenderStatus;
  checkFiles?: readonly CheckedFile[];
  extensionsApi?: CodeExtensionPlatform;
  extensions: CodeExtension[];
  onSyntaxActivity: (path: string, activity: ExtensionActivity) => void;
  onBack?: () => void;
  arrival?: DefinitionArrival;
  onArrival: (found?: boolean) => void;
  readerRef?: Ref<CodeReaderHandle>;
  debugSource?: PythonDebugSource;
  wrap?: boolean;
}) {
  const { t } = useI18n();
  const client = useQueryClient();
  const contextMenu = useCodeContextMenu();
  const compare = Boolean(change);
  const scope = change?.comparison;
  const readComparison = () => branchReviewKey && api.branchFile ? api.branchFile(project.id, path)
    : previousReview && compare ? api.file(project.id, path, compare, scope, true)
      : scope ? api.file(project.id, path, compare, scope) : api.file(project.id, path, compare);
  const file = useQuery({
    queryKey: [...codeReviewKeys.file(project.id, path, compare, change?.evidence, scope), ...(branchReviewKey ? [branchReviewKey] : previousReview ? ["previous"] : [])],
    queryFn: async (): Promise<CodeReviewDocument> => {
      if (dependency?.sourceId && api.definitionSource) {
        return { before: null, after: { state: "text", text: await api.definitionSource(project.id, dependency.sourceId) }, evidence: null, indexOnly: false };
      }
      const current = await readComparison();
      if ((scope || branchReviewKey) && current.evidence !== change?.evidence) throw new Error("codeReviewStale");
      return current;
    },
    retry: false,
    gcTime: 30_000,
  });
  const readWorkingTree = mode === "source" && compare && !branchReviewKey;
  const workingTree = useQuery({
    queryKey: codeReviewKeys.file(project.id, path, false),
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
  const stale = (file.error instanceof Error ? file.error.message : String(file.error)) === "codeReviewStale";
  if (!document || (readWorkingTree && workingTree.isError)) return <><div className="code-review-reader-body">
    <div className="code-review-status code-review-placeholder" role="alert">
      <p>{t(dependency ? "codeReview.definitionSourceUnavailable" : stale ? "codeReview.stale" : "codeReview.fileFailed")}</p>
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
  const positionKey = JSON.stringify([path, diff ? scope ?? "diff" : "source", ...(branchReviewKey ? [branchReviewKey] : previousReview && diff ? ["previous"] : [])]);
  const finderMenu = (name: string, reveal?: () => void) => reveal ? {
    tabIndex: 0,
    "aria-haspopup": "menu" as const,
    "aria-keyshortcuts": "Shift+F10",
    onContextMenu: (event: React.MouseEvent<HTMLLIElement>) => contextMenu.showFinder(event, name, reveal),
    onKeyDown: (event: React.KeyboardEvent<HTMLLIElement>) => {
      if (isCodeContextMenuKey(event)) contextMenu.showFinder(event, name, reveal);
    },
  } : {};
  const heading = <div className="code-review-document-heading">
    <nav className="code-review-document-path" aria-label={t("codeReview.filePath")} title={displayPath}>
      <ol role="list">
        {parts.length > 1 && <li className="code-review-document-overflow" aria-hidden="true">…</li>}
        {parts.map((part, index) => <li key={index} className="code-review-document-folder"
          {...finderMenu(part, onRevealFolderInFinder && (() => onRevealFolderInFinder(parts.slice(0, index + 1).join("/"))))}>
          {index > 0 && <ActionIcon name="chevronRight" />}
          <span>{part}</span>
        </li>)}
        <li className="code-review-document-file" aria-current="page" {...finderMenu(filename, onRevealInFinder)}>
          {parts.length > 0 && <ActionIcon name="chevronRight" />}
          <CodeFileIcon path={displayPath} />
          <h2>{filename}</h2>
        </li>
      </ol>
    </nav>
    {gitControls}
  </div>;
  const reviewKey = branchReviewKey ?? project.key;
  const noteHistory = change && evidence ? reviewHistory(reviewKey, path) : undefined;
  const noteStatus = noteHistory && evidence ? versionReviewStatus(noteHistory, evidence, scope) : undefined;
  const noteTarget = t(indexOnly ? "codeReview.index" : "codeReview.worktree");
  const noteComparison = branchReviewKey ? baseline
    : scope ? t(scope === "staged" ? "codeReview.gitReview.stagedDiff" : "codeReview.gitReview.unstagedDiff")
      : baselineCommit ? `${baselineCommit.slice(0, 10)} → ${noteTarget}` : noteTarget;
  const note = noteHistory && noteStatus ? {
    path,
    status: noteStatus,
    body: <ReviewNotes key={evidence} reviewKey={reviewKey} path={path} document={document} readComparison={readComparison}
      history={noteHistory} scope={scope} comparison={noteComparison} onSaved={onSaved} />,
  } : undefined;
  const comparison = dependency ? t("codeReview.definitionDependency")
    : diff && scope ? t(scope === "staged" ? "codeReview.gitReview.stagedDiff" : "codeReview.gitReview.unstagedDiff")
    : diff && indexOnly ? t("codeReview.index")
    : !diff && showingOriginal ? t("codeReview.originalVersion") : diff && change?.staged ? t("codeReview.hasStaged") : baseline;
  const readerText = diff ? (revised ?? "") : (fullText ?? "");
  const liveSource = !branchReviewKey && !showingOriginal && !(diff && indexOnly);
  const origin = dependency?.sourceId ? { kind: "dependency" as const, id: dependency.sourceId } : { kind: "workspace" as const, path };
  const outline = showOutline && allowLanguageTools && liveSource && fullText !== undefined && api.documentOutline && supportsCodeNavigation(displayPath)
    ? <CodeReviewOutline locate={locateOutline} onRefresh={onRefresh}
      queryKey={codeReviewKeys.outline(project.id, path, readWorkingTree ? workingTree.dataUpdatedAt : file.dataUpdatedAt, mode)}
      load={async (enable) => {
        const result = await api.documentOutline?.(project.id, { origin, enable, text: normalizeReviewText(readerText) });
        if (enable) void client.invalidateQueries({ queryKey: codeReviewKeys.languages(project.id) });
        return result ?? { state: "unavailable" };
      }} />
    : undefined;
  const checkTarget = { path, mode: diff ? "diff" as const : "source" as const, evidence: diff ? evidence : null, indexOnly: diff && indexOnly,
    ...(diff && scope ? { comparison: scope } : {}) };
  const checkProblem = checkTargetProblem(checkTarget, diff ? after : source, Boolean(dependency))
    ?? (isEslintSource(path) && eslintAvailability !== "enabled" ? eslintAvailability : undefined);
  const matchesCheck = (target: DisplayedCheckTarget["target"]) => target.path === path && target.mode === checkTarget.mode
    && target.evidence === checkTarget.evidence && target.indexOnly === checkTarget.indexOnly && target.comparison === checkTarget.comparison;
  const checkResult = !checkProblem ? checkFiles?.find((item) => item.status === "checked" && matchesCheck(item.target)) : undefined;
  const safeArrival = arrival && "check" in arrival && !matchesCheck({ ...arrival.check, path }) ? undefined : arrival;
  const inspector = renderOutline(outline);
  const dock = renderDock(branchReviewKey || previousReview ? undefined : { target: checkTarget, text: readerText, problem: checkProblem }, note);
  const status = renderStatus(noteStatus);
  return <>
    {change?.previousPath && <p className="code-review-status">{t("codeReview.renamedFrom", { path: change.previousPath })}</p>}
    {mode === "diff" && document.executableChangedTo !== undefined && <p className="code-review-status" role="status">
      {t(document.executableChangedTo ? "codeReview.gitReview.executable" : "codeReview.gitReview.nonExecutable")}
    </p>}
    {diff || fullText !== undefined ? <CodeReviewReader path={displayPath} original={diff ? (original ?? "") : undefined}
      sourceBaseline={!diff && change && !showingOriginal ? original : undefined}
      sourceFileChange={!diff && change ? showingOriginal ? "deleted" : before?.state === "missing" ? "added" : undefined : undefined}
      text={readerText} onCopy={onCopy} onRevealInFinder={onRevealInFinder} viewSwitcher={viewSwitcher} heading={heading}
      fallbackCopy={after.state === "missing" && diff ? original : undefined} footer={status} dock={dock} comparison={comparison}
      readPosition={() => readPosition(positionKey)} onPosition={(position) => savePosition(positionKey, position)}
      onDefinition={onDefinition && liveSource ? (gesture) => onDefinition(gesture, diff ? "diff" : "source") : undefined}
      onReferences={allowLanguageTools && liveSource && api.documentHighlights ? (position, text) => api.documentHighlights?.(project.id, { origin, position, text }) ?? Promise.resolve([]) : undefined}
      outline={inspector} checkResult={checkResult} readerRef={readerRef}
      debugSource={liveSource && !diff ? debugSource : undefined}
      wrap={wrap}
      extensionsApi={dependency ? undefined : extensionsApi} extensions={extensions} projectId={project.id} onSyntaxActivity={onSyntaxActivity}
      onBack={onBack} arrival={safeArrival} onArrival={onArrival} />
      : <>{heading}<div className="code-review-reader-body">
        <EmptyState className="code-review-placeholder" icon={<ActionIcon name="document" />} title={t(`codeReview.file.${source.state}`)} />
        {inspector}
      </div>{dock}<div className="code-review-reading-status">{status}</div></>}
    {change && !diffAvailable && fullText !== undefined && <p className="code-review-status" role="status">{t("codeReview.diffUnavailable")}</p>}
    {contextMenu.surface}
  </>;
}

function ReviewNotes({ reviewKey, path, document, history, scope, comparison, onSaved, readComparison }: {
  reviewKey: string;
  path: string;
  document: CodeReviewDocument;
  history: ReviewNote[];
  scope?: CodeChangeComparison;
  comparison: string;
  readComparison: () => Promise<CodeReviewDocument>;
  onSaved: () => void;
}) {
  const { t, formatDate } = useI18n();
  const noteId = useId();
  const comparisonId = `${noteId}-comparison`;
  const current = history.find((entry) => entry.evidence === document.evidence);
  const older = history.filter((entry) => entry.evidence !== document.evidence);
  const [note, setNote] = useState(() => reviewNoteDraft(reviewKey, path, document.evidence) ?? current?.note ?? "");
  const save = useMutation({
    mutationFn: async (status: ReviewNote["status"]) => {
      const latest = await readComparison();
      if (!latest.evidence || latest.evidence !== document.evidence) throw new Error("codeReviewStale");
      saveReviewNote(reviewKey, path, { evidence: latest.evidence, comparison: scope, status, note, at: new Date().toISOString() });
      saveReviewDraft(reviewKey, path, latest.evidence, "");
    },
    onSuccess: onSaved,
  });
  return <div className="code-review-notes-body">
    <div className="code-review-note-composer ds-composite-field" aria-busy={save.isPending}>
      <label className="visually-hidden" htmlFor={noteId}>{t("codeReview.noteField")}</label>
      <textarea id={noteId} aria-describedby={comparisonId} rows={2} maxLength={2000} value={note} readOnly={save.isPending}
        onChange={(event) => {
          setNote(event.target.value);
          saveReviewDraft(reviewKey, path, document.evidence, event.target.value, current?.note ?? "");
        }} placeholder={t("codeReview.notePlaceholder")} />
      <div className="code-review-note-footer">
        <span id={comparisonId} className="code-review-note-comparison" title={comparison}>{comparison}</span>
        <div className="code-review-note-actions">
          <Button size="small" variant="secondary" disabled={save.isPending} busy={save.isPending && save.variables === "needsChanges"}
            onClick={() => save.mutate("needsChanges")}>{t("codeReview.needsChanges")}</Button>
          <Button size="small" variant="primary" disabled={save.isPending} busy={save.isPending && save.variables === "reviewed"}
            onClick={() => save.mutate("reviewed")}>{t("codeReview.markReviewed")}</Button>
        </div>
      </div>
    </div>
    {save.isError && <p className="code-review-note-feedback" role="alert">{t(save.error.message === "codeReviewStale" || String(save.error) === "codeReviewStale"
      ? "codeReview.stale" : "codeReview.noteFailed")}</p>}
    {older.length > 0 && <details className="code-review-history">
      <summary>{t("codeReview.history")}</summary>
      <ul>{[...older].reverse().map((entry) => <li key={entry.evidence}>
        <div>
          <span data-status={entry.status}>{t(`codeReview.${entry.status}`)}</span>
          <time dateTime={entry.at}>{formatDate(entry.at, "local", { dateStyle: "medium", timeStyle: "short" })}</time>
        </div>
        {entry.note && <p>{entry.note}</p>}
      </li>)}</ul>
    </details>}
  </div>;
}
