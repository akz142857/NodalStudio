import { useI18n } from "../i18n";
import { useUpdateBlocker } from "../platform/update-guard";
import { useEffect, useMemo, useRef, useState } from "react";
import type { AppSettings, RuntimeInfo, TableDefinition } from "../platform";
import { ddlLimits, type DdlDialect, type DdlPreview } from "../ddl/ddl-types";
import { previewDdlInWorker } from "../ddl/ddl-worker-client";
import { ddlDiagramSnapshot } from "../ddl/ddl-preview";
import { SchemaCanvas } from "./SchemaCanvas";
import { OperationFeedback, type OperationFeedbackState } from "./OperationFeedback";
import { useOperation } from "./use-operation";
const sourceId = () => crypto.randomUUID?.() ?? [...crypto.getRandomValues(new Uint32Array(4))].map((value) => value.toString(16).padStart(8, "0")).join("");

export function DdlImportPanel({ canvasSettings, runtimeKind, onClose }: { canvasSettings: AppSettings["canvas"]; runtimeKind?: RuntimeInfo["kind"]; onClose: () => void }) {
  const { t: bt } = useI18n();
  const [text, setText] = useState(""); const [dialect, setDialect] = useState<DdlDialect>("postgreSql"); const [namespace, setNamespace] = useState("public");
  const [source, setSource] = useState<{ kind: DdlPreview["source"]["kind"]; name: string; id: string; edited: boolean }>(() => ({ kind: "ddl-clipboard", name: "SQL editor buffer", id: sourceId(), edited: false }));
  const [revision, setRevision] = useState(0); const [preview, setPreview] = useState<DdlPreview>(); const [view, setView] = useState<"structure" | "diagram">("structure");
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
    }, { running: bt("business.reading", { value0: kind === "ddl-file" ? "SQL file" : "clipboard" }), success: () => bt("business.inputLoadedInMemory"), failure: bt("business.unableToReadSQLInputYouCanPasteText") });
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
      if (isCurrent()) { setPreview(value); setSelected(undefined); }
      return value;
    }, { running: bt("business.parsingTheSelectedDDLSubsetInMemory"), success: (value) => bt("business.tablesAcceptedStatementsSkippedStatementsRegionsErrorsCoverageWarnings", { value0: value.schemas.reduce((count, schema) => count + schema.tables.length, 0), value1: value.coverage.accepted, value2: value.coverage.skipped, value3: value.coverage.errors, value4: value.coverage.warnings, value5: value.coverage.skipped || value.coverage.errors || value.coverage.warnings ? "Partial preview." : "Supported-subset preview; not a complete schema validation." }), failure: bt("business.dDLPreviewFailedTheLiveWorkspaceIsUnchanged") });
  };
  const snapshot = useMemo(() => preview ? ddlDiagramSnapshot(preview) : undefined, [preview]);
  const tables = preview?.schemas.flatMap((schema) => schema.tables) ?? [];
  const graphCollision = new Set(tables.map((table) => `${table.key.schema}.${table.key.name}`)).size !== tables.length;
  const jump = (start: number, end: number) => {
    const target = editor.current; if (!target) return;
    target.focus(); target.setSelectionRange(start, end);
    const line = text.slice(0, start).split("\n").length - 1;
    const style = window.getComputedStyle(target); const height = Number.parseFloat(style.lineHeight) || 20;
    target.scrollTop = Math.max(0, (line - 2) * height); target.scrollLeft = 0;
  };
  return <section className="ddl-import-page" aria-label={bt("business.readOnlyDDLImportPreview")}>
    <header><div><h1>{bt("business.dDLImportPreview")}</h1><p>{bt("business.temporaryFileClipboardModelNotADatabaseCapture")}</p></div><button type="button" onClick={onClose}>{bt("business.closeDDLPreview")}</button></header>
    <p>{bt("business.postgreSQLMySQLCREATETABLEColumnsPKFKAndSimple")}</p>
    <div className="ddl-input-controls">
      <label>{bt("business.sQLFileUTF81MiBMax")}<input type="file" accept=".sql,.ddl,text/plain" disabled={busy} onChange={(event) => { const file = event.target.files?.[0]; if (file) readFile(file); event.target.value = ""; }} /></label>
      <button type="button" disabled={busy} onClick={() => read("ddl-clipboard", bt("business.clipboardSQL"), () => navigator.clipboard?.readText ? navigator.clipboard.readText() : Promise.reject(new Error(bt("business.clipboardReadingIsUnavailableInThisRuntimePasteSQL"))))}>{bt("business.readClipboard")}</button>
      <label>{bt("business.dDLDialect")}<select value={dialect} disabled={busy} onChange={(event) => { const next = event.target.value as DdlDialect; setDialect(next); setNamespace(next === "postgreSql" ? "public" : "imported"); clearResult(); }}><option value="postgreSql">PostgreSQL</option><option value="mySql">MySQL</option></select></label>
      <label>{bt("business.defaultNamespace")}<input value={namespace} maxLength={128} disabled={busy} onChange={(event) => { setNamespace(event.target.value); clearResult(); }} /></label>
    </div>
    <p>{bt("business.source")} {source.kind === "ddl-file" ? bt("business.file") : bt("business.clipboardEditor")} · {source.name}{source.edited ? bt("business.editedBuffer") : ""}{bt("businessExtra.unqualifiedTableNamesUseTheConfiguredNamespaceMySQLUnqualifiedFK")}</p>
    <label className="ddl-text-label">{bt("business.sQLDDLText")}<textarea ref={editor} autoFocus value={text} wrap="off" spellCheck={false} maxLength={ddlLimits.bytes} disabled={busy} onChange={(event) => { setText(event.target.value); setSource((current) => ({ ...current, edited: true })); clearResult(); }} /></label>
    <div className="ddl-actions"><button type="button" disabled={busy || !text.trim()} onClick={run}>{bt("business.previewDDL")}</button><button type="button" onClick={() => { controller.current?.abort(); clearResult(); setText(""); setSource({ kind: "ddl-clipboard", name: "SQL editor buffer", id: sourceId(), edited: false }); }}>{bt("business.clearInputAndPreview")}</button>{parse.busy ? <button type="button" onClick={() => { controller.current?.abort(); clearResult(); setNotice({ phase: "info", summary: bt("business.previewCancelledTheSQLBufferRemainsAvailable") }); }}>{bt("business.cancelPreview")}</button> : null}</div>
    <OperationFeedback label={bt("business.dDLInput")} state={input.state} onRetry={() => lastRead.current?.()} retryLabel={bt("business.retryInputRead")} />
    <OperationFeedback label={bt("business.dDLParsing")} state={notice ?? parse.state} onRetry={run} retryLabel={bt("business.retryDDLPreview")} />
    {preview && snapshot ? <>
      <p>{preview.source.kind} {bt("business.sessionID")} <code>{preview.source.id}</code> {bt("business.contentHash")} <code>{preview.source.contentHash}</code> {bt("business.modelFingerprint")} <code>{preview.fingerprint}</code>{bt("businessExtra.theseIdentifyAParsedFileModelNotAServerStored")}</p>
      <details className="ddl-diagnostics" open><summary>{bt("business.parsingCoverageAndSourceDiagnostics")} {preview.diagnostics.length} {bt("business.findings")}</summary>
        <p>{bt("business.unsupportedInvalidStatementsAreOmittedAtomicallyForwardFKIndex")}</p>
        {preview.diagnostics.slice(0, diagnosticLimit).map((item, index) => <article key={index} data-level={item.level}><strong>{item.level} · {item.code}</strong><p>{item.message}</p><button type="button" onClick={() => jump(item.start, item.end)}>{bt("business.showSourceLine")} {item.line}{bt("business.column")} {item.column}</button></article>)}
        {preview.diagnostics.length > diagnosticLimit ? <button type="button" onClick={() => setDiagnosticLimit((value) => value + 50)}>{bt("business.show50MoreDiagnostics")}</button> : null}
      </details>
      <div className="ddl-actions"><button type="button" aria-pressed={view === "structure"} onClick={() => setView("structure")}>{bt("business.structurePreview")}</button><button type="button" aria-pressed={view === "diagram"} disabled={!tables.length || graphCollision} onClick={() => setView("diagram")}>{bt("business.diagramPreview")}</button></div>
      {graphCollision ? <p role="alert">{bt("business.qualifiedNamesCollideInTheDiagramRendererUseThe")}</p> : null}
      {view === "diagram" && !graphCollision ? <div className="ddl-preview-canvas"><SchemaCanvas key={preview.source.id} snapshot={snapshot} readOnlyPreview runtimeKind={runtimeKind} query="" canvasSettings={{ ...canvasSettings, showInferredRelationships: false }} onSelectTable={setSelected} selectedTable={selected} /></div> : <section aria-label={bt("business.parsedDDLStructure")}>
        {tables.length ? tables.slice(0, tableLimit).map((table) => <details key={JSON.stringify(table.key)}><summary>{table.key.schema}.{table.key.name} · {table.columns.length} {bt("business.columns")} {table.foreignKeys.length} {bt("business.declaredFKs")}</summary><button type="button" onClick={() => { const location = preview.locations.find((value) => value.schema === table.key.schema && value.table === table.key.name && !value.columnName)!; jump(location.start, location.end); }}>{bt("business.showTableSource")}</button>
          <ul>{table.columns.map((column) => <li key={column.name}><strong>{column.name}</strong> · {column.formattedType} · {column.nullable ? "nullable" : bt("business.notNull")}{column.identity ? bt("business.identity", { value0: column.identity }) : ""}{column.defaultValue !== null ? bt("business.default", { value0: column.defaultValue }) : ""} <button type="button" onClick={() => { const location = preview.locations.find((value) => value.schema === table.key.schema && value.table === table.key.name && value.columnName === column.name)!; jump(location.start, location.end); }}>{bt("business.showColumnSource")}</button></li>)}</ul>
          <p>{bt("business.pK")} {table.primaryKey?.columns.join(", ") ?? bt("business.notDeclared")}</p>{table.foreignKeys.map((value) => <p key={value.name}>{bt("business.fK")} {value.name}: {value.columns.join(", ")} → {value.referencedSchema}.{value.referencedTable} ({value.referencedColumns.join(", ")}{bt("business.delete")} {value.onDelete} {bt("business.update")} {value.onUpdate}</p>)}{table.indexes.map((value) => <p key={value.name}>{value.unique ? bt("business.unique") : bt("business.index")} {value.name}: {value.columns.join(", ")}</p>)}
        </details>) : <p>{bt("business.noSupportedTablesWereProducedReviewDiagnosticsAndAdjust")}</p>}
        {tables.length > tableLimit ? <button type="button" onClick={() => setTableLimit((value) => value + 50)}>{bt("business.show50MoreTables")}</button> : null}
      </section>}
    </> : null}
  </section>;
}
