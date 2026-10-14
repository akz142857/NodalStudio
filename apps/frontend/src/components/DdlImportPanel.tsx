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
      const value = await load(); if (new TextEncoder().encode(value).length > ddlLimits.bytes) throw new Error("Input exceeds the 1 MiB preview limit. Choose a smaller UTF-8 SQL file or paste a smaller DDL subset.");
      if (isCurrent()) { clearResult(); setText(value); setSource({ kind, name, id: sourceId(), edited: false }); }
      return value;
    }, { running: `Reading ${kind === "ddl-file" ? "SQL file" : "clipboard"}…`, success: () => "Input loaded in memory.", failure: "Unable to read SQL input. You can paste text manually." });
  };
  const readFile = (file: File) => read("ddl-file", file.name, async () => {
    if (file.size > ddlLimits.bytes) throw new Error("File exceeds the 1 MiB preview limit.");
    const bytes = await file.arrayBuffer(); try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new Error("File is not valid UTF-8. Convert it to UTF-8 before previewing."); }
  });
  const run = () => {
    if (busy || !text.trim()) return;
    controller.current?.abort(); const abort = new AbortController(); controller.current = abort; setNotice(undefined);
    void parse.run(async (isCurrent) => {
      const value = await previewDdlInWorker({ text, dialect, defaultSchema: namespace, source }, abort.signal);
      if (isCurrent()) { setPreview(value); setSelected(undefined); }
      return value;
    }, { running: "Parsing the selected DDL subset in memory…", success: (value) => `${value.schemas.reduce((count, schema) => count + schema.tables.length, 0)} tables · ${value.coverage.accepted} accepted statements · ${value.coverage.skipped} skipped statements/regions · ${value.coverage.errors} errors · ${value.coverage.warnings} coverage warnings. ${value.coverage.skipped || value.coverage.errors || value.coverage.warnings ? "Partial preview." : "Supported-subset preview; not a complete schema validation."}`, failure: "DDL preview failed. The live workspace is unchanged." });
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
  return <section className="ddl-import-page" aria-label="Read-only DDL import preview">
    <header><div><h1>DDL import preview</h1><p>Temporary file/clipboard model · not a database capture</p></div><button type="button" onClick={onClose}>Close DDL preview</button></header>
    <p>PostgreSQL / MySQL CREATE TABLE, columns, PK/FK and simple indexes only. ALTER, VIEW/ENUM objects, CHECK, generated expressions and routines are outside this version. Nothing is executed, saved as a connection/history, compared with a live snapshot, published or sent to AI. Close to discard this session.</p>
    <div className="ddl-input-controls">
      <label>SQL file (UTF-8, 1 MiB max)<input type="file" accept=".sql,.ddl,text/plain" disabled={busy} onChange={(event) => { const file = event.target.files?.[0]; if (file) readFile(file); event.target.value = ""; }} /></label>
      <button type="button" disabled={busy} onClick={() => read("ddl-clipboard", "Clipboard SQL", () => navigator.clipboard?.readText ? navigator.clipboard.readText() : Promise.reject(new Error("Clipboard reading is unavailable in this runtime. Paste SQL into the editor instead.")))}>Read clipboard</button>
      <label>DDL dialect<select value={dialect} disabled={busy} onChange={(event) => { const next = event.target.value as DdlDialect; setDialect(next); setNamespace(next === "postgreSql" ? "public" : "imported"); clearResult(); }}><option value="postgreSql">PostgreSQL</option><option value="mySql">MySQL</option></select></label>
      <label>Default namespace<input value={namespace} maxLength={128} disabled={busy} onChange={(event) => { setNamespace(event.target.value); clearResult(); }} /></label>
    </div>
    <p>Source: {source.kind === "ddl-file" ? "File" : "Clipboard/editor"} · {source.name}{source.edited ? " (edited buffer)" : ""}. Unqualified table names use the configured namespace; MySQL unqualified FK targets use the declaring table’s namespace. PostgreSQL search_path/SET and MySQL USE are not replayed. Parsing is bounded to 500 tables / 5,000 columns / 5,000 statements and 64 nested levels.</p>
    <label className="ddl-text-label">SQL DDL text<textarea ref={editor} autoFocus value={text} wrap="off" spellCheck={false} maxLength={ddlLimits.bytes} disabled={busy} onChange={(event) => { setText(event.target.value); setSource((current) => ({ ...current, edited: true })); clearResult(); }} /></label>
    <div className="ddl-actions"><button type="button" disabled={busy || !text.trim()} onClick={run}>Preview DDL</button><button type="button" onClick={() => { controller.current?.abort(); clearResult(); setText(""); setSource({ kind: "ddl-clipboard", name: "SQL editor buffer", id: sourceId(), edited: false }); }}>Clear input and preview</button>{parse.busy ? <button type="button" onClick={() => { controller.current?.abort(); clearResult(); setNotice({ phase: "info", summary: "Preview cancelled; the SQL buffer remains available." }); }}>Cancel preview</button> : null}</div>
    <OperationFeedback label="DDL input" state={input.state} onRetry={() => lastRead.current?.()} retryLabel="Retry input read" />
    <OperationFeedback label="DDL parsing" state={notice ?? parse.state} onRetry={run} retryLabel="Retry DDL preview" />
    {preview && snapshot ? <>
      <p>{preview.source.kind} · Session ID <code>{preview.source.id}</code> · Content hash <code>{preview.source.contentHash}</code> · Model fingerprint <code>{preview.fingerprint}</code>. These identify a parsed file model, not a server, stored database snapshot or migration history.</p>
      <details className="ddl-diagnostics" open><summary>Parsing coverage and source diagnostics · {preview.diagnostics.length} findings</summary>
        <p>Unsupported/invalid statements are omitted atomically. Forward FK/index targets are resolved from supported declarations, not by replaying SQL execution order. Parsed types remain declared text, not catalog types. Unnamed constraints receive preview-only names. MySQL storage/charset options are omitted with coverage warnings. Routine/DELIMITER regions stop parsing to prevent their bodies becoming false tables; COPY rows and non-DDL statements are omitted.</p>
        {preview.diagnostics.slice(0, diagnosticLimit).map((item, index) => <article key={index} data-level={item.level}><strong>{item.level} · {item.code}</strong><p>{item.message}</p><button type="button" onClick={() => jump(item.start, item.end)}>Show source: line {item.line}, column {item.column}</button></article>)}
        {preview.diagnostics.length > diagnosticLimit ? <button type="button" onClick={() => setDiagnosticLimit((value) => value + 50)}>Show 50 more diagnostics</button> : null}
      </details>
      <div className="ddl-actions"><button type="button" aria-pressed={view === "structure"} onClick={() => setView("structure")}>Structure preview</button><button type="button" aria-pressed={view === "diagram"} disabled={!tables.length || graphCollision} onClick={() => setView("diagram")}>Diagram preview</button></div>
      {graphCollision ? <p role="alert">Qualified names collide in the Diagram renderer. Use the complete structure list; no imported objects were merged.</p> : null}
      {view === "diagram" && !graphCollision ? <div className="ddl-preview-canvas"><SchemaCanvas key={preview.source.id} snapshot={snapshot} readOnlyPreview runtimeKind={runtimeKind} query="" canvasSettings={{ ...canvasSettings, showInferredRelationships: false }} onSelectTable={setSelected} selectedTable={selected} /></div> : <section aria-label="Parsed DDL structure">
        {tables.length ? tables.slice(0, tableLimit).map((table) => <details key={JSON.stringify(table.key)}><summary>{table.key.schema}.{table.key.name} · {table.columns.length} columns · {table.foreignKeys.length} declared FKs</summary><button type="button" onClick={() => { const location = preview.locations.find((value) => value.schema === table.key.schema && value.table === table.key.name && !value.columnName)!; jump(location.start, location.end); }}>Show table source</button>
          <ul>{table.columns.map((column) => <li key={column.name}><strong>{column.name}</strong> · {column.formattedType} · {column.nullable ? "nullable" : "not null"}{column.identity ? ` · identity: ${column.identity}` : ""}{column.defaultValue !== null ? ` · default: ${column.defaultValue}` : ""} <button type="button" onClick={() => { const location = preview.locations.find((value) => value.schema === table.key.schema && value.table === table.key.name && value.columnName === column.name)!; jump(location.start, location.end); }}>Show column source</button></li>)}</ul>
          <p>PK: {table.primaryKey?.columns.join(", ") ?? "not declared"}</p>{table.foreignKeys.map((value) => <p key={value.name}>FK {value.name}: {value.columns.join(", ")} → {value.referencedSchema}.{value.referencedTable} ({value.referencedColumns.join(", ")}) · delete {value.onDelete} · update {value.onUpdate}</p>)}{table.indexes.map((value) => <p key={value.name}>{value.unique ? "Unique" : "Index"} {value.name}: {value.columns.join(", ")}</p>)}
        </details>) : <p>No supported tables were produced. Review diagnostics and adjust the input/dialect; an empty preview does not mean the database has no tables.</p>}
        {tables.length > tableLimit ? <button type="button" onClick={() => setTableLimit((value) => value + 50)}>Show 50 more tables</button> : null}
      </section>}
    </> : null}
  </section>;
}
