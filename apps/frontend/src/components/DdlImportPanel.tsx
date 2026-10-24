import { useI18n } from "../i18n";
import { useUpdateBlocker } from "../platform/update-guard";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../design-system/Button";
import { Segmented } from "./Segmented";
import { SchemaTree } from "./SchemaTree";
import { TableStructure } from "./TableInspector";
import "./ddl-import.css";
import type { AppSettings, RuntimeInfo, TableDefinition } from "../platform";
import { ddlLimits, type DdlDialect, type DdlPreview } from "../ddl/ddl-types";
import { previewDdlInWorker } from "../ddl/ddl-worker-client";
import { ddlDiagramSnapshot } from "../ddl/ddl-preview";
import { SchemaCanvas } from "./SchemaCanvas";
import { OperationFeedback, type OperationFeedbackState } from "./OperationFeedback";
import { useOperation } from "./use-operation";
const sourceId = () => crypto.randomUUID?.() ?? [...crypto.getRandomValues(new Uint32Array(4))].map((value) => value.toString(16).padStart(8, "0")).join("");

export function DdlImportPanel({ canvasSettings, runtimeKind, onClose, onReturn = onClose, active = true }: { canvasSettings: AppSettings["canvas"]; runtimeKind?: RuntimeInfo["kind"]; onClose: () => void; onReturn?: () => void; active?: boolean }) {
  const { t: bt, locale } = useI18n();
  const [editing, setEditing] = useState(true);
  const [confirmClose, setConfirmClose] = useState(false);
  const workspaceReturn = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const confirmation = useRef<HTMLDialogElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [text, setText] = useState(""); const [dialect, setDialect] = useState<DdlDialect>("postgreSql"); const [namespace, setNamespace] = useState("public");
  const [source, setSource] = useState<{ kind: DdlPreview["source"]["kind"]; name: string; id: string; edited: boolean }>(() => ({ kind: "ddl-clipboard", name: "SQL editor buffer", id: sourceId(), edited: false }));
  const [revision, setRevision] = useState(0); const [preview, setPreview] = useState<DdlPreview>(); const [view, setView] = useState<"structure" | "diagram">("diagram");
  const [selected, setSelected] = useState<TableDefinition>(); const [notice, setNotice] = useState<OperationFeedbackState>(); const [diagnosticLimit, setDiagnosticLimit] = useState(50);
  const [tableLimit, setTableLimit] = useState(50);
  const parse = useOperation(String(revision)); const input = useOperation(String(revision));
  const controller = useRef<AbortController | undefined>(undefined); const editor = useRef<HTMLTextAreaElement>(null); const lastRead = useRef<(() => void) | undefined>(undefined);
  useEffect(() => () => controller.current?.abort(), [revision]);
  const busy = parse.busy || input.busy;
  const clearResult = () => { setRevision((value) => value + 1); setPreview(undefined); setSelected(undefined); setNotice(undefined); setDiagnosticLimit(50); setTableLimit(50); };
  const read = (kind: DdlPreview["source"]["kind"], name: string, load: () => Promise<string>) => {
    lastRead.current = () => read(kind, name, load);
    void input.run(async (isCurrent) => {
      const value = await load(); if (new TextEncoder().encode(value).length > ddlLimits.bytes) throw new Error(bt("business.inputExceedsThe1MiBPreviewLimitChooseA"));
      if (isCurrent()) { clearResult(); setText(value); setSource({ kind, name, id: sourceId(), edited: false }); }
      return value;
    }, { running: bt("business.reading", { value0: kind === "ddl-file" ? bt("business.file") : bt("business.clipboardEditor") }), success: () => bt("business.inputLoadedInMemory"), failure: bt("business.unableToReadSQLInputYouCanPasteText") });
  };
  const readFile = (file: File) => read("ddl-file", file.name, async () => {
    if (file.size > ddlLimits.bytes) throw new Error(bt("business.fileExceedsThe1MiBPreviewLimit"));
    const bytes = await file.arrayBuffer(); try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new Error(bt("business.fileIsNotValidUTF8ConvertItTo")); }
  });
  useUpdateBlocker(bt("business.finishAndCloseTheTemporaryDDLPreview"), Boolean(text.trim()) || busy);
  const run = () => {
    if (busy || !text.trim()) return;
    controller.current?.abort(); const abort = new AbortController(); controller.current = abort; setNotice(undefined);
    void parse.run(async (isCurrent) => {
      const value = await previewDdlInWorker({ text, dialect, defaultSchema: namespace, source }, abort.signal);
      if (isCurrent()) { setPreview(value); setSelected(value.schemas.flatMap(schema => schema.tables)[0]); setEditing(false); }
      return value;
    }, { running: bt("business.parsingTheSelectedDDLSubsetInMemory"), success: (value) => bt("ddl.summary", { tables: value.schemas.reduce((count, schema) => count + schema.tables.length, 0), findings: value.diagnostics.length }), failure: bt("business.dDLPreviewFailedTheLiveWorkspaceIsUnchanged") });
  };
  const snapshot = useMemo(() => {
    if (!preview) return undefined;
    const value = ddlDiagramSnapshot(preview);
    if (preview.source.kind !== "ddl-file") value.database.name = bt("business.clipboardEditor");
    return value;
  }, [preview, bt]);
  const tables = preview?.schemas.flatMap((schema) => schema.tables) ?? [];
  const graphCollision = new Set(tables.map((table) => `${table.key.schema}.${table.key.name}`)).size !== tables.length;
  const jump = (start: number, end: number) => {
    const target = editor.current; if (!target) return;
    target.focus(); target.setSelectionRange(start, end);
    const line = text.slice(0, start).split("\n").length - 1;
    const style = window.getComputedStyle(target); const height = Number.parseFloat(style.lineHeight) || 20;
    target.scrollTop = Math.max(0, (line - 2) * height); target.scrollLeft = 0;
  };
  const requestClose = () => { if (text.trim() || busy) setConfirmClose(true); else onClose(); };
  useEffect(() => {
    const el = dialog.current;
    if (!el) return;
    if (active && editing) { if (!el.open) el.showModal(); }
    else { el.close(); if(active) workspaceReturn.current?.focus(); }
  }, [active, editing]);
  useEffect(() => {
    const el = confirmation.current;
    if (active && confirmClose) el?.showModal(); else el?.close();
  }, [active, confirmClose]);
  useEffect(() => {
    const previous = document.activeElement;
    if (!active) return;
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, [active]);
  const editSource = (start: number, end: number) => {
    setEditing(true);
    requestAnimationFrame(() => jump(start, end));
  };
  const sourceName = source.kind === "ddl-file" ? source.name : bt("business.clipboardEditor");
  return <section className="ddl-session ds-surface" hidden={!active} aria-label={bt("business.readOnlyDDLImportPreview")}>
    {preview && snapshot ? <section className="ddl-model-workspace" aria-label={bt("ddl.workspace")}>
      <header className="ddl-workspace-header">
        <Button ref={workspaceReturn} onClick={onReturn}>← {bt("ddl.return")}</Button>
        <div><h2>{bt("business.dDLImportPreview")}</h2><p>{sourceName} · {bt("ddl.temporary")}</p></div>
        <Button onClick={() => setEditing(true)}>{bt("ddl.edit")}</Button>
        <Button onClick={requestClose}>{bt("ddl.close")}</Button>
      </header>
      <div className="ddl-workspace-toolbar">
        <Segmented label={bt("ddl.views")} value={!tables.length || graphCollision ? "structure" : view} onChange={setView} options={[
          {value: "diagram", label: bt("business.diagramPreview"), disabled: !tables.length || graphCollision},
          {value: "structure", label: bt("business.structurePreview")},
        ]} />
        <span role="status">{bt("ddl.summary", {tables: tables.length, findings: preview.diagnostics.length})}</span>
      </div>
      <div className="ddl-model-body">
        <aside className="ddl-model-tree"><SchemaTree snapshot={snapshot} selectedTable={selected} onSelectTable={setSelected} /></aside>
        <div className="ddl-model-center">
          <div className="ddl-model-canvas" hidden={view !== "diagram" || graphCollision || !tables.length}>
            {tables.length && !graphCollision ? <SchemaCanvas key={`${preview.source.id}:${preview.fingerprint}`} snapshot={snapshot} interactionPaused={!active || editing} readOnlyPreview runtimeKind={runtimeKind} query="" canvasSettings={{ ...canvasSettings, showInferredRelationships: false }} onSelectTable={setSelected} selectedTable={selected} /> : null}
          </div>
          {view === "structure" || !tables.length || graphCollision ? <section className="ddl-structure-list" aria-label={bt("business.parsedDDLStructure")}>
            {graphCollision ? <p role="alert">{bt("business.qualifiedNamesCollideInTheDiagramRendererUseThe")}</p> : null}
            {tables.length ? tables.slice(0, tableLimit).map(table => <button type="button" key={JSON.stringify(table.key)} aria-pressed={selected === table} onClick={() => setSelected(table)}><strong>{table.key.schema}.{table.key.name}</strong><span>{bt("ddl.tableSummary", {columns: table.columns.length, keys: table.foreignKeys.length})}</span></button>) : <div className="ds-empty-state"><strong>{bt("ddl.noTables")}</strong><p>{bt("business.noSupportedTablesWereProducedReviewDiagnosticsAndAdjust")}</p><Button onClick={() => setEditing(true)}>{bt("ddl.edit")}</Button></div>}
            {tables.length > tableLimit ? <Button onClick={() => setTableLimit(value => value + 50)}>{bt("business.show50MoreTables")}</Button> : null}
          </section> : null}
        </div>
        <aside className="ddl-model-inspector inspector-view">
          {selected ? <><h2>{selected.key.schema}.{selected.key.name}</h2><Button onClick={() => { const location = preview.locations.find(value => value.schema === selected.key.schema && value.table === selected.key.name && !value.columnName); if(location) editSource(location.start, location.end); }}>{bt("business.showTableSource")}</Button><TableStructure table={selected} onShowColumnSource={name => {
              const location = preview.locations.find(value => value.schema === selected.key.schema && value.table === selected.key.name && value.columnName === name);
              if (location) editSource(location.start, location.end);
            }} /></> : <p>{bt("ddl.selectTable")}</p>}
        </aside>
      </div>
      <details className="ddl-diagnostics" open={tables.length ? undefined : true}>
        <summary>{bt("ddl.diagnostics")} · {preview.diagnostics.length} {bt("business.findings")}</summary>
        <div className="ddl-diagnostics-content"><p>{bt("business.unsupportedInvalidStatementsAreOmittedAtomicallyForwardFKIndex")}</p>
        {preview.diagnostics.slice(0, diagnosticLimit).map((item, index) => <article key={index} data-level={item.level}><strong>{bt(item.level === "error" ? "ddl.error" : item.level === "info" ? "ddl.info" : "ddl.warning")} · {item.code}</strong><p>{locale === "zh-CN" ? bt(diagnosticMessageKey(item.code)) : item.message}</p>{locale === "zh-CN" ? <details><summary>{bt("ddl.originalDiagnostic")}</summary><p>{item.message}</p></details> : null}<Button onClick={() => editSource(item.start, item.end)}>{bt("business.showSourceLine")} {item.line}{bt("business.column")} {item.column}</Button></article>)}
        {preview.diagnostics.length > diagnosticLimit ? <Button onClick={() => setDiagnosticLimit(value => value + 50)}>{bt("business.show50MoreDiagnostics")}</Button> : null}
        <details><summary>{bt("ddl.technical")}</summary><p>{bt("business.sessionID")} <code>{preview.source.id}</code><br />{bt("business.contentHash")} <code>{preview.source.contentHash}</code><br />{bt("business.modelFingerprint")} <code>{preview.fingerprint}</code></p></details></div>
      </details>
    </section> : null}
    <dialog ref={dialog} className="ddl-import-dialog ds-surface" aria-labelledby="ddl-import-title" aria-describedby="ddl-import-description" onCancel={event => { event.preventDefault(); if (preview) setEditing(false); else requestClose(); }}>
      <header><h2 id="ddl-import-title">{bt("navigation.importDDL")}</h2><p id="ddl-import-description">{bt("ddl.description")}</p></header>
      <div className="ddl-import-content">
        <div className="ddl-source-actions"><Button disabled={busy} onClick={() => fileInput.current?.click()}>{bt("ddl.chooseFile")}</Button>
          <input ref={fileInput} className="ddl-file-input" type="file" aria-label={bt("business.sQLFileUTF81MiBMax")} accept=".sql,.ddl,text/plain" disabled={busy} onChange={event => { const file = event.target.files?.[0]; if(file) readFile(file); event.target.value = ""; }} />
          <Button disabled={busy} onClick={() => read("ddl-clipboard", bt("business.clipboardSQL"), () => navigator.clipboard?.readText ? navigator.clipboard.readText() : Promise.reject(new Error(bt("business.clipboardReadingIsUnavailableInThisRuntimePasteSQL"))))}>{bt("business.readClipboard")}</Button><span>{bt("ddl.fileHint")}</span>
        </div>
        <div className="ddl-input-controls"><label>{bt("business.dDLDialect")}<select value={dialect} disabled={busy} onChange={event => { const next = event.target.value as DdlDialect; setDialect(next); setNamespace(next === "postgreSql" ? "public" : "imported"); clearResult(); }}><option value="postgreSql">PostgreSQL</option><option value="mySql">MySQL</option></select></label>
          <label>{bt("business.defaultNamespace")}<input value={namespace} maxLength={128} disabled={busy} onChange={event => {setNamespace(event.target.value); clearResult();}} /></label>
        </div>
        <p className="ddl-source-name">{bt("business.source")} {sourceName}{source.edited ? bt("business.editedBuffer") : ""}</p>
        <label className="ddl-text-label">{bt("business.sQLDDLText")}<textarea ref={editor} autoFocus value={text} wrap="off" spellCheck={false} maxLength={ddlLimits.bytes} disabled={busy} onChange={event => {setText(event.target.value); setSource(current => ({...current, edited:true})); clearResult();}} /></label>
        <details className="ddl-supported"><summary>{bt("ddl.supported")}</summary><p>{bt("business.postgreSQLMySQLCREATETABLEColumnsPKFKAndSimple")}</p></details>
        <OperationFeedback label={bt("business.dDLInput")} state={input.state} onRetry={() => lastRead.current?.()} retryLabel={bt("business.retryInputRead")} />
        <OperationFeedback label={bt("business.dDLParsing")} state={notice ?? parse.state} onRetry={run} retryLabel={bt("business.retryDDLPreview")} />
      </div>
      <footer><Button disabled={busy || !text} onClick={() => {clearResult(); setText(""); setSource({kind:"ddl-clipboard", name:"SQL editor buffer", id:sourceId(), edited:false});}}>{bt("business.clearInputAndPreview")}</Button><span />
        <Button onClick={() => { if(busy) {controller.current?.abort(); clearResult(); setNotice({phase:"info", summary:bt("business.previewCancelledTheSQLBufferRemainsAvailable")});} else if(preview) setEditing(false); else requestClose(); }}>{busy ? bt("business.cancelPreview") : bt("business.cancel")}</Button>
        <Button variant="primary" disabled={busy || !text.trim()} onClick={run}>{bt("business.previewDDL")}</Button>
      </footer>
    </dialog>
    <dialog ref={confirmation} className="ddl-discard-dialog ds-surface" aria-labelledby="ddl-discard-title" onCancel={event => {event.preventDefault(); setConfirmClose(false);}}><h2 id="ddl-discard-title">{bt("ddl.discardTitle")}</h2><p>{bt("ddl.discardDescription")}</p><footer><Button onClick={() => setConfirmClose(false)}>{bt("ddl.keep")}</Button><Button variant="danger" onClick={() => {controller.current?.abort(); onClose();}}>{bt("ddl.discard")}</Button></footer></dialog>
  </section>;
}

function diagnosticMessageKey(code: string) {
  const keys = {
    "unsupported-statement": "ddl.diagStatement", "unsupported-create": "ddl.diagCreate",
    "unsupported-region": "ddl.diagRegion", "projection": "ddl.diagProjection",
    "unsupported-or-invalid": "ddl.diagInvalid", "index-target": "ddl.diagIndex",
    "fk-target": "ddl.diagForeignKey", "lexical": "ddl.diagLexical",
    "executable-comment": "ddl.diagComment",
  } as const;
  return keys[code as keyof typeof keys] ?? "ddl.diagInvalid";
}
