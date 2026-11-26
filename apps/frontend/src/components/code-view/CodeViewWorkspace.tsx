import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { DatabaseSnapshot, NodalStudioPlatform, ObjectKey } from "../../platform";
import { codeViewQueryKey, type CodeOntologyReference, type CodeQueryHandoff, type IndexedProjectFile, type ProjectStatementSelection } from "../../platform/code-view";
import { ontologyRequiresReview } from "../../platform/ontology-types";
import { useI18n } from "../../i18n";
import { ModalSurface } from "../../design-system/ModalSurface";
import { DefinitionReader } from "../ObjectDocument";
import "./code-view.css";

const pageSize = 80;
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const labelObject = (key: ObjectKey) => `${key.schema}.${key.name}`;
type Position = { path: string; start: number };
type Feedback = { message: string; error: boolean };

export function CodeViewWorkspace({ platform, snapshot, initialObject, initialPosition, onPosition, onLocate, onOntology, onQuery, onReturn, returnLabel }: {
  platform: NodalStudioPlatform;
  snapshot: DatabaseSnapshot;
  initialObject?: ObjectKey;
  initialPosition?: Position;
  onPosition: (position: Position) => void;
  onLocate: (key: ObjectKey) => void;
  onOntology: (id: string) => void;
  onQuery: (sql: string, handoff: CodeQueryHandoff) => void;
  onReturn: () => void;
  returnLabel?: string;
}) {
  const { t, locale } = useI18n();
  const api = platform.codeView!;
  const client = useQueryClient();
  const sourceId = snapshot.sourceId;
  const baseKey = codeViewQueryKey(sourceId);
  const [object, setObject] = useState(initialObject);
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [directories, setDirectories] = useState("");
  const [pickedPosition, setPosition] = useState(initialPosition);
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>();
  const [baselineId, setBaselineId] = useState("");
  const [confirmation, setConfirmation] = useState<{ object?: ObjectKey; definition?: { id: string; revision: number } }>();
  const [mobileDetail, setMobileDetail] = useState(Boolean(initialPosition));
  const active = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const selectedFileButton = useRef<HTMLButtonElement>(null);
  const fileRequest = { sourceId, object, search, offset };
  const page = useQuery({
    queryKey: [...baseKey, snapshot.id, "page", object, search, offset],
    queryFn: () => api.get(fileRequest),
    networkMode: "always", refetchOnWindowFocus: false, retry: false,
  });
  const scan = page.data?.scan;
  const project = page.data?.project;
  const firstFile = scan?.files[0];
  const position = pickedPosition ?? (firstFile ? { path: firstFile.path, start: firstFile.matches[0]?.start ?? 0 } : undefined);
  useEffect(() => {
    if (body.current) body.current.scrollTop = 0;
  }, [position?.path]);
  const file = useQuery({
    queryKey: [...baseKey, "file", project?.id, scan?.version, position?.path],
    queryFn: () => api.file({ sourceId, bindingId: project!.id, path: position!.path, indexVersion: scan!.version }),
    enabled: Boolean(scan && project && position),
    networkMode: "always", refetchOnWindowFocus: false, retry: false,
  });
  const statement = file.data?.statements.find((entry) => entry.start === position?.start) ?? file.data?.statements[0];
  const outsideDatabase = statement?.diagnostics.includes("outsideDatabase");
  const showMigrationImpact = statement?.kind === "migration" && !outsideDatabase;
  const selection: ProjectStatementSelection | undefined = statement && scan && project && position
    ? { sourceId, bindingId: project.id, path: position.path, indexVersion: scan.version, start: statement.start, digest: statement.digest }
    : undefined;
  const baselines = useQuery({
    queryKey: [...baseKey, "baselines", snapshot.id],
    queryFn: () => platform.listSnapshots(sourceId),
    enabled: showMigrationImpact, networkMode: "always", retry: false,
  });
  const migration = useQuery({
    queryKey: [...baseKey, "migration", selection, baselineId],
    queryFn: () => api.impact(selection!, baselineId || undefined),
    enabled: Boolean(selection && showMigrationImpact), networkMode: "always", refetchOnWindowFocus: false, retry: false,
  });
  const definitions = useQuery({
    queryKey: [...baseKey, "definitions", snapshot.id],
    queryFn: () => platform.listOntology({ sourceId, snapshotId: snapshot.id }),
    enabled: Boolean(selection), networkMode: "always", retry: false,
  });
  useEffect(() => {
    active.current = true;
    heading.current?.focus({ preventScroll: true });
    let waiting = false;
    const validate = () => {
      if (waiting) return;
      waiting = true;
      void api.get({ sourceId, checkFiles: true })
        .then((current) => {
          if (active.current && current.stale) return client.invalidateQueries({ queryKey: codeViewQueryKey(sourceId) });
        })
        .catch(() => undefined)
        .finally(() => { waiting = false; });
    };
    validate();
    window.addEventListener("focus", validate);
    return () => { active.current = false; window.removeEventListener("focus", validate); };
  }, [api, client, sourceId]);
  const refresh = () => client.invalidateQueries({ queryKey: baseKey });
  const perform = async (action: () => Promise<void>) => {
    setBusy(true);
    setFeedback(undefined);
    try {
      await action();
    } catch (error) {
      if (active.current) setFeedback({ error: true, message: errorText(error) });
    } finally {
      if (active.current) setBusy(false);
    }
  };
  const runScan = async (bindingId: string) => {
    setScanning(true);
    try {
      await api.scan({ sourceId, bindingId });
    } finally {
      if (active.current) setScanning(false);
      await refresh();
    }
  };
  const pick = () => void perform(async () => {
    const roots = directories.split(",").map((value) => value.trim()).filter(Boolean);
    const chosen = await api.choose(sourceId, roots.length ? roots : [""]);
    if (!active.current || !chosen) return;
    setPosition(undefined);
    setOffset(0);
    await refresh();
    await runScan(chosen.id);
  });
  const chooseFile = (item: IndexedProjectFile, start = item.matches[0]?.start ?? 0) => {
    const selected = { path: item.path, start };
    setPosition(selected);
    onPosition(selected);
    setBaselineId("");
    setMobileDetail(true);
  };
  const selectStatement = (start: number) => {
    if (!position) return;
    const selected = { path: position.path, start };
    setPosition(selected);
    onPosition(selected);
    setBaselineId("");
  };
  const formatDate = (value: string) => new Date(value).toLocaleString(locale);
  const fileLink = (item: IndexedProjectFile) => {
    const separator = item.path.lastIndexOf("/");
    return <button type="button" key={item.path}
      ref={position?.path === item.path ? selectedFileButton : undefined} aria-label={item.path} title={item.path}
      aria-current={position?.path === item.path ? "true" : undefined} onClick={() => chooseFile(item)}>
      <span className="code-view-file-label">
        <span>{item.path.slice(separator + 1)}</span>
        {separator >= 0 && <small>{item.path.slice(0, separator)}</small>}
      </span>
      {object && item.matches.length ? <small>{item.matches.length}</small> : null}
    </button>;
  };
  const ontologyLink = (entry: CodeOntologyReference) => <li key={`${entry.id}-${entry.evidence}`}>
    <button type="button" onClick={() => onOntology(entry.id)}>{entry.name}</button>
    <small>{t("codeView.revision", { revision: entry.revision })} · {t(`codeView.${entry.evidence}`)}{entry.stale ? ` · ${t("codeView.needsReview")}` : ""}</small>
  </li>;
  const associations = statement ? file.data?.associations?.[statement.start] ?? [] : [];
  const isScanning = scanning || Boolean(page.data?.scanning);
  const currentProject = !page.isError && project;
  const showingStale = Boolean(page.data?.stale);
  return <section className="code-view ds-surface" aria-label={t("codeView.title")} data-mobile-detail={mobileDetail}>
    <header className="code-view-header">
      <div>
        <button type="button" onClick={onReturn}>← {returnLabel ?? t("navigation.model")}</button>
        <h2 ref={heading} tabIndex={-1}>{t("codeView.title")}</h2>
        {currentProject && <p>{currentProject.name} · {currentProject.connectionName} · {currentProject.database}</p>}
        {!currentProject && <p>{snapshot.database.name}</p>}
      </div>
      {currentProject && <div className="code-view-actions">
        {isScanning
          ? <button type="button" onClick={() => void api.cancel({ sourceId, bindingId: currentProject.id }).catch((error: unknown) => setFeedback({ error: true, message: errorText(error) }))}>{t("codeView.cancelScan")}</button>
          : <button type="button" className="ds-primary" disabled={busy} onClick={() => void perform(() => runScan(currentProject.id))}>{t(scan ? "codeView.rescan" : "codeView.scan")}</button>}
        <button type="button" disabled={busy || isScanning} onClick={pick}>{t("codeView.choose")}</button>
        <button type="button" disabled={busy || isScanning} onClick={() => {
          if (window.confirm(t("codeView.confirmRemove"))) void perform(async () => {
            await api.remove({ sourceId, bindingId: currentProject.id });
            setPosition(undefined);
            await refresh();
          });
        }}>{t("codeView.remove")}</button>
      </div>}
    </header>
    {page.isPending && <p className="code-view-notice" role="status">{t("navigation.loadingWorkspace")}</p>}
    {page.isError && <p className="code-view-notice" role="alert">{errorText(page.error)}</p>}
    {feedback && <p className="code-view-notice" role={feedback.error ? "alert" : "status"}>{feedback.message}</p>}
    {isScanning && <p className="code-view-notice" role="status">{t("codeView.scanning")}</p>}
    {!page.isPending && !currentProject && <div className="code-view-setup">
      <p>{t("codeView.chooseHelp")}</p>
      <button type="button" className="ds-primary" disabled={busy} onClick={pick}>{t("codeView.choose")}</button>
      <label>{t("codeView.directories")}<input value={directories} onChange={(event) => setDirectories(event.target.value)} /></label>
      <small>{t("codeView.directoriesHint")}</small>
    </div>}
    {currentProject && <div className="code-view-status">
      <span>{scan?.git.commit || scan?.git.branch ? [scan.git.branch, scan.git.commit?.slice(0, 10)].filter(Boolean).join(" · ") : t("codeView.versionUnknown")} · {t("codeView.workingTree")}</span>
      <span>{t("codeView.currentDetails", { current: formatDate(currentProject.snapshotAt) })}</span>
      <span>{currentProject.directories.map((root) => root || ".").join(", ")}</span>
      {scan ? <span>{t("codeView.scanStatus", { count: scan.fileCount, at: formatDate(scan.at) })}</span> : <span>{t("codeView.noScan")}</span>}
      {scan && (scan.skipped > 0 || scan.diagnosticCount > 0) && <span>{t("codeView.coverage", { skipped: scan.skipped, diagnostics: scan.diagnosticCount })}</span>}
      {scan?.partialUpdate && <span>{t("codeView.partialUpdate")}</span>}
      {showingStale && <strong role="status">{t("codeView.stale")}</strong>}
    </div>}
    {scan && currentProject && <div className="code-view-body" ref={body}>
      <aside className="code-view-files" aria-label={t("codeView.files")}>
        <label>{t("codeView.search")}<input type="search" value={search} onChange={(event) => { setSearch(event.target.value); setOffset(0); }} /></label>
        {object && <div className="code-view-filter"><code>{labelObject(object)}</code><button type="button" onClick={() => { setObject(undefined); setOffset(0); }}>{t("codeView.clearFilter")}</button></div>}
        <div className="code-view-file-list">{scan.files.map(fileLink)}</div>
        {!showingStale && !scan.files.length && <p>{t(object ? "codeView.noReferences" : "codeView.noMatchingFiles")}</p>}
        {(offset > 0 || offset + pageSize < scan.totalMatching) && <div className="code-view-actions">
          <button type="button" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - pageSize))}>{t("codeView.prev")}</button>
          <button type="button" disabled={offset + pageSize >= scan.totalMatching} onClick={() => setOffset(offset + pageSize)}>{t("codeView.next")}</button>
        </div>}
      </aside>
      <div className="code-view-reader">
        <button type="button" className="code-view-mobile-back" onClick={() => {
          setMobileDetail(false);
          requestAnimationFrame(() => selectedFileButton.current?.focus());
        }}>← {t("codeView.files")}</button>
        {!position && <p>{t("codeView.selectFile")}</p>}
        {position && <div className="code-view-actions code-view-reader-heading">
          <h3>{position.path}</h3>
          {file.data && currentProject.canOpenExternalEditor && api.openInEditor && <button type="button" disabled={busy || showingStale} onClick={() => {
            void perform(async () => {
              await api.openInEditor?.({ sourceId, bindingId: currentProject.id, path: position.path, indexVersion: scan.version });
            });
          }}>{t("codeView.openEditor")}</button>}
        </div>}
        {position && file.isPending && <p role="status">{t("codeView.loadingFile")}</p>}
        {file.isError && <div className="code-view-actions">
          <p role="alert">{errorText(file.error)}</p>
          <button type="button" disabled={file.isFetching} onClick={() => void file.refetch()}>{t("business.retry")}</button>
        </div>}
        {file.data && <>
          {file.data.diagnostic && <p>{t(`codeView.diagnostic.${file.data.diagnostic}`)}</p>}
          {file.data.statements.length ? <label>{t("codeView.statements")}<select value={statement?.start ?? ""} onChange={(event) => selectStatement(Number(event.target.value))}>
            {file.data.statements.map((entry) => <option key={entry.start} value={entry.start}>{t("codeView.line", { line: entry.line })} · {t(`codeView.${entry.kind}`)}</option>)}
          </select></label> : <p>{t("codeView.previewOnly")}</p>}
          <DefinitionReader value={file.data.contents} wrap={false} dialect="mySql" selectedLine={statement?.line} />
        </>}
      </div>
      {file.data && statement && selection && <aside className="code-view-references">
        <section>
          <h3>{t("codeView.references")}</h3>
          {statement.references.length ? <ul>{statement.references.map((reference) => <li key={labelObject(reference)}><button type="button" onClick={() => onLocate(reference)}>{labelObject(reference)}</button></li>)}</ul> : !outsideDatabase && <p>{t("codeView.noObjects")}</p>}
          {associations.length > 0 && <ul>{associations.map(({ object, evidence, stale }, index) => <li key={`${labelObject(object)}-${evidence}-${index}`}>
            {stale ? <code>{labelObject(object)}</code> : <button type="button" onClick={() => onLocate(object)}>{labelObject(object)}</button>}
            <small>{t(evidence === "legacy" ? "codeView.legacy" : "codeView.confirmed")}{stale ? ` · ${t("codeView.needsReview")}` : ""}</small>
          </li>)}</ul>}
          {statement.diagnostics.map((diagnostic) => <p key={diagnostic}>
            {diagnostic === "outsideDatabase" && statement.outsideDatabases?.length
              ? t("codeView.outsideDatabaseDetails", { targets: statement.outsideDatabases.join(", "), database: currentProject.database })
              : t(`codeView.diagnostic.${diagnostic}`)}
          </p>)}
          {initialObject && !statement.references.some((reference) => labelObject(reference) === labelObject(initialObject)) &&
            <button type="button" disabled={busy || showingStale} onClick={() => setConfirmation({ object: initialObject })}>{t("codeView.confirmObject")}</button>}
          {statement.openQuery && <button type="button" className="ds-primary" disabled={busy || showingStale} onClick={() => void perform(async () => {
            const [sql, handoff] = await api.query(selection);
            if (active.current) onQuery(sql, handoff);
          })}>{t("codeView.openQuery")}</button>}
        </section>
        <section>
          <h3>{t("codeView.ontology")}</h3>
          <ul>{(file.data.ontology[statement.start] ?? []).map(ontologyLink)}</ul>
          {definitions.data?.some((entry) => !ontologyRequiresReview(entry)) && <label>{t("codeView.confirmOntology")}
            <select value="" disabled={busy || showingStale} onChange={(event) => {
              const entry = definitions.data?.find((definition) => definition.id === event.target.value);
              if (entry) setConfirmation({ definition: { id: entry.id, revision: entry.revision } });
            }}>
              <option value="">—</option>
              {definitions.data.filter((entry) => !ontologyRequiresReview(entry)).map((entry) => <option key={entry.id} value={entry.id}>{entry.definition.name}</option>)}
            </select>
          </label>}
        </section>
        {showMigrationImpact && <section>
          <h3>{t("codeView.impact")}</h3>
          <p>{t("codeView.impactHelp")}</p>
          <label>{t("codeView.baseline")}<select value={baselineId} onChange={(event) => setBaselineId(event.target.value)}>
            <option value="">{t("codeView.currentBaseline")}</option>
            {migration.data?.linkedBaselineId && migration.data.linkedBaselineAt &&
              <option value={migration.data.linkedBaselineId}>{t("codeView.linkedBaseline", { date: formatDate(migration.data.linkedBaselineAt) })}</option>}
            {(baselines.data ?? []).filter((entry) => entry.id !== snapshot.id && entry.id !== migration.data?.linkedBaselineId && entry.databaseName === snapshot.database.name)
              .map((entry) => <option key={entry.id} value={entry.id}>{formatDate(entry.capturedAt)}</option>)}
          </select></label>
          <ul>{(migration.data?.changes ?? statement.changes).map((change, index) => <li key={index}>
            <strong>{t(`codeView.${change.action}`)}</strong> <code>{labelObject(change.table)}{change.before ? `.${change.before}` : ""}{change.after ? ` → ${change.after}` : ""}</code>
            {typeof change.beforeObserved === "boolean" && <small>{t("codeView.observedTarget", { name: change.before ?? change.table.name, status: t(change.beforeObserved ? "codeView.observed" : "codeView.unobserved") })}</small>}
            {typeof change.afterObserved === "boolean" && change.before !== change.after && <small>{t("codeView.observedTarget", { name: change.after ?? change.table.name, status: t(change.afterObserved ? "codeView.observed" : "codeView.unobserved") })}</small>}
            {typeof change.afterObserved === "boolean" && change.action === "createTable" && <small>{t("codeView.observedTarget", { name: change.table.name, status: t(change.afterObserved ? "codeView.observed" : "codeView.unobserved") })}</small>}

          </li>)}</ul>
          {migration.isError && <p role="alert">{errorText(migration.error)}</p>}
          {migration.data && <>
            <p>{migration.data.baselineAt ? t("codeView.baselineDetails", { baseline: formatDate(migration.data.baselineAt), current: formatDate(migration.data.currentAt) }) : t("codeView.currentDetails", { current: formatDate(migration.data.currentAt) })}</p>
            {migration.data.missingBaseline && <p role="status">{t("codeView.missingBaseline")}</p>}
            {migration.data.partial && <p>{t("codeView.partialImpact")}</p>}
            <h4>{t("codeView.impactFiles")}</h4>
            <div className="code-view-file-list">{migration.data.files.map(fileLink)}</div>
            <ul>{migration.data.ontology.map(ontologyLink)}</ul>
          </>}
        </section>}
      </aside>}
    </div>}
    {confirmation && selection && <ModalSurface label={t("codeView.confirmTitle")} onDismiss={() => setConfirmation(undefined)}>
      <div className="query-dialog-backdrop"><section className="query-dialog ds-surface">
        <h3>{t("codeView.confirmTitle")}</h3>
        <p>{t("codeView.confirmExplanation")}</p>
        <div className="code-view-actions">
          <button type="button" data-modal-focus onClick={() => setConfirmation(undefined)}>{t("business.cancel")}</button>
          <button type="button" className="ds-primary" disabled={busy} onClick={() => void perform(async () => {
            await api.confirm({ selection, ...confirmation });
            setConfirmation(undefined);
            await refresh();
          })}>{t("codeView.confirmTitle")}</button>
        </div>
      </section></div>
    </ModalSurface>}
  </section>;
}
