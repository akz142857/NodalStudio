import { useId, useState, type ReactNode, type Ref } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "../../design-system/Button";
import { EmptyState } from "../../design-system/EmptyState";
import { useI18n } from "../../i18n";
import type {
  CodeDefinitionPosition, CodeDefinitionTarget, CodeExtension, CodeExtensionPlatform,
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
import { codeReviewKeys } from "./code-review-query-keys";

const textFor = (version: CodeReviewVersion | null | undefined) => version?.state === "text" ? version.text : undefined;

export type NoteStatus = ReviewNote["status"] | "recheck" | "pending";
export type RenderDock = (current?: DisplayedCheckTarget, note?: { path: string; status: NoteStatus; body: ReactNode }) => ReactNode;
export type RenderStatus = (status?: NoteStatus) => ReactNode;

function fileReviewStatus(history: ReviewNote[], evidence: string): NoteStatus {
  return history.find((entry) => entry.evidence === evidence)?.status ?? (history.length ? "recheck" : "pending");
}

export function FileReview({ api, project, path, dependency, change, mode, baseline, readPosition, savePosition, onModeChange, onSaved, onRefresh, onCopy,
  onDefinition, allowLanguageTools, eslintAvailability, onBack, arrival, onArrival, showOutline, locateOutline, renderOutline, renderDock, renderStatus,
  checkFiles, extensionsApi, extensions, onSyntaxActivity, readerRef }: {
  api: CodeReviewPlatform;
  project: CodeReviewProject;
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
}) {
  const { t } = useI18n();
  const client = useQueryClient();
  const compare = Boolean(change);
  const file = useQuery({
    queryKey: codeReviewKeys.file(project.id, path, compare, change?.evidence),
    queryFn: async (): Promise<CodeReviewDocument> => dependency?.sourceId && api.definitionSource
      ? { before: null, after: { state: "text", text: await api.definitionSource(project.id, dependency.sourceId) }, evidence: null, indexOnly: false }
      : api.file(project.id, path, compare),
    retry: false,
    gcTime: 30_000,
  });
  const readWorkingTree = mode === "source" && compare;
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
  const note = noteHistory && noteStatus ? {
    path,
    status: noteStatus,
    body: <ReviewNotes key={evidence} api={api} project={project} path={path} document={document}
      history={noteHistory} onSaved={onSaved} />,
  } : undefined;
  const comparison = dependency ? t("codeReview.definitionDependency") : diff && indexOnly ? t("codeReview.index")
    : !diff && showingOriginal ? t("codeReview.originalVersion") : diff && change?.staged ? t("codeReview.hasStaged") : baseline;
  const readerText = diff ? (revised ?? "") : (fullText ?? "");
  const liveSource = !showingOriginal && !(diff && indexOnly);
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
      outline={inspector} checkResult={checkResult} readerRef={readerRef}
      extensionsApi={dependency ? undefined : extensionsApi} extensions={extensions} projectId={project.id} onSyntaxActivity={onSyntaxActivity}
      onBack={onBack} arrival={safeArrival} onArrival={onArrival} />
      : <>{heading}<div className="code-review-reader-body">
        <EmptyState className="code-review-placeholder" icon={<ActionIcon name="document" />} title={t(`codeReview.file.${source.state}`)} />
        {inspector}
      </div>{dock}<div className="code-review-reading-status">{status}</div></>}
    {change && !diffAvailable && fullText !== undefined && <p className="code-review-status" role="status">{t("codeReview.diffUnavailable")}</p>}
  </>;
}

function ReviewNotes({ api, project, path, document, history, onSaved }: {
  api: CodeReviewPlatform;
  project: CodeReviewProject;
  path: string;
  document: CodeReviewDocument;
  history: ReviewNote[];
  onSaved: () => void;
}) {
  const { t, formatDate } = useI18n();
  const noteId = useId();
  const comparisonId = `${noteId}-comparison`;
  const target = t(document.indexOnly ? "codeReview.index" : "codeReview.worktree");
  const comparison = project.baseline ? `${project.baseline.slice(0, 10)} → ${target}` : target;
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
    <div className="code-review-note-composer ds-composite-field" aria-busy={save.isPending}>
      <label className="visually-hidden" htmlFor={noteId}>{t("codeReview.noteField")}</label>
      <textarea id={noteId} aria-describedby={comparisonId} rows={2} maxLength={2000} value={note} readOnly={save.isPending}
        onChange={(event) => {
          setNote(event.target.value);
          saveReviewDraft(project.key, path, document.evidence, event.target.value, current?.note ?? "");
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
