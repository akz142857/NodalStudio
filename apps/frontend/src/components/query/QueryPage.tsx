import { useEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from "react";
import type { DatabaseSnapshot, QueryErrorKind, QueryExecutionResult, QueryHistoryEntry, NodalStudioPlatform } from "../../platform";
import { QueryHistory } from "./QueryHistory";
import { QueryResultGrid } from "./QueryResultGrid";
import { loadQuerySession, resizedQueryResultHeight, saveQuerySession, type QuerySession, type QueryTab } from "./query-state";
import { SqlEditor, type SqlEditorHandle } from "./SqlEditor";

export interface OpenQueryRequest { id: number; sql: string }

interface QueryPageProps {
  platform: NodalStudioPlatform;
  snapshot?: DatabaseSnapshot;
  runtimeKind?: "desktop" | "web";
  openRequest?: OpenQueryRequest;
  onConsumeOpenRequest?: () => void;
}

function queryError(error: unknown): { kind: QueryErrorKind; message: string } {
  if (typeof error === "object" && error && "kind" in error && "message" in error) {
    return { kind: String(error.kind) as QueryErrorKind, message: String(error.message) };
  }
  if (typeof error === "string") {
    try { return queryError(JSON.parse(error)); } catch { return { kind: "internal", message: error }; }
  }
  return { kind: "internal", message: error instanceof Error ? error.message : "Query execution failed." };
}

export function QueryPage({ platform, snapshot, runtimeKind, openRequest, onConsumeOpenRequest }: QueryPageProps) {
  const sourceId = snapshot?.sourceId ?? "no-source";
  const sessionKey = "query-workspace";
  const [session, setSession] = useState<QuerySession>(() => loadQuerySession(sessionKey));
  const [history, setHistory] = useState<QueryHistoryEntry[]>([]);
  const [executing, setExecuting] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const editorRef = useRef<SqlEditorHandle>(null);
  const activeQueryId = useRef<string | undefined>(undefined);
  const previousSourceId = useRef(sourceId);
  const stopResizeRef = useRef<(() => void) | undefined>(undefined);

  if (previousSourceId.current !== sourceId) {
    previousSourceId.current = sourceId;
    setSession((current) => ({ ...current, result: undefined, message: "Data source changed. The SQL draft was preserved; run it again against the new source.", activeTab: "message" }));
  }
  useEffect(() => { saveQuerySession(sessionKey, session); }, [session]);
  useEffect(() => {
    if (!snapshot || runtimeKind !== "desktop") return;
    void platform.listQueryHistory(sourceId).then(setHistory).catch(() => setHistory([]));
  }, [platform, runtimeKind, snapshot, sourceId]);
  useEffect(() => {
    if (!executing) return;
    const started = performance.now();
    const timer = window.setInterval(() => setElapsedMs(performance.now() - started), 100);
    return () => window.clearInterval(timer);
  }, [executing]);
  useEffect(() => () => stopResizeRef.current?.(), []);

  async function run(sqlText: string) {
    if (!snapshot || runtimeKind !== "desktop" || executing) return;
    if (!sqlText.trim()) {
      setSession((current) => ({ ...current, message: "Enter one read-only SELECT statement before running the query.", activeTab: "message", outputCollapsed: false }));
      editorRef.current?.focus();
      return;
    }
    const queryId = crypto.randomUUID();
    activeQueryId.current = queryId;
    setExecuting(true);
    setElapsedMs(0);
    setSession((current) => ({ ...current, message: "Executing read-only query…", activeTab: "message", outputCollapsed: false }));
    try {
      const result: QueryExecutionResult = await platform.executeReadonlyQuery({ queryId, sourceId, sql: sqlText, rowLimit: session.rowLimit, timeoutMs: 30_000 });
      const summary = `${result.rowCount} rows in ${result.durationMs} ms${result.truncated ? " · truncated at the selected row limit" : ""}.`;
      setSession((current) => ({ ...current, result, message: [summary, ...result.notices].join("\n"), activeTab: "results", outputCollapsed: false }));
    } catch (error) {
      const normalized = queryError(error);
      setSession((current) => ({ ...current, message: `${normalized.kind}: ${normalized.message}`, activeTab: "message", outputCollapsed: false }));
    } finally {
      activeQueryId.current = undefined;
      setExecuting(false);
      setHistory(await platform.listQueryHistory(sourceId).catch(() => []));
    }
  }

  function selectTab(tab: QueryTab) { setSession((current) => ({ ...current, activeTab: tab })); }
  function beginResultResize(event: ReactMouseEvent<HTMLDivElement>) {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = session.resultHeight;
    stopResizeRef.current?.();
    document.body.classList.add("is-resizing-query-output");
    setSession((current) => ({ ...current, outputCollapsed: false }));
    const move = (moveEvent: MouseEvent) => {
      moveEvent.preventDefault();
      const resultHeight = resizedQueryResultHeight(startHeight, startY, moveEvent.clientY);
      setSession((current) => current.resultHeight === resultHeight ? current : { ...current, resultHeight });
    };
    const finish = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", finish);
      document.body.classList.remove("is-resizing-query-output");
      stopResizeRef.current = undefined;
    };
    stopResizeRef.current = finish;
    window.addEventListener("mousemove", move, { passive: false });
    window.addEventListener("mouseup", finish, { once: true });
  }
  const desktopReady = runtimeKind === "desktop" && Boolean(snapshot);
  const outputHeight = session.outputCollapsed ? 36 : session.resultHeight;

  return <section className="query-page" aria-label="Query workspace" style={{ "--query-output-height": `${outputHeight}px` } as CSSProperties}>
    <header className="query-toolbar">
      <div><strong>Query</strong><span>{snapshot ? `${snapshot.database.name} · ${snapshot.schemas.length} schemas` : "No data source selected"}</span></div>
      <label>Rows<select value={[100, 500, 1000].includes(session.rowLimit) ? session.rowLimit : "custom"} onChange={(event) => setSession((current) => ({ ...current, rowLimit: event.target.value === "custom" ? 5000 : Number(event.target.value) }))}><option value={100}>100</option><option value={500}>500</option><option value={1000}>1,000</option><option value="custom">Custom</option></select></label>
      {![100, 500, 1000].includes(session.rowLimit) ? <label className="query-custom-limit"><input aria-label="Custom row limit" type="number" min={1} max={5000} value={session.rowLimit} onChange={(event) => setSession((current) => ({ ...current, rowLimit: Math.min(5000, Math.max(1, Number(event.target.value) || 1)) }))} /></label> : null}
      {executing ? <button type="button" className="query-cancel" onClick={() => activeQueryId.current && void platform.cancelQuery(activeQueryId.current)}>Stop</button> : <button type="button" className="query-run" disabled={!desktopReady} onClick={() => void run(editorRef.current?.getExecutableSql() ?? "")}>Run <kbd>⌘↵</kbd></button>}
      <span className="query-elapsed">{executing ? `${Math.round(elapsedMs)} ms` : "Read only"}</span>
    </header>
    {!desktopReady ? <div className="query-runtime-notice">{runtimeKind === "web" ? "Query is available only in the desktop app. The web viewer never connects to your database." : "Connect a PostgreSQL data source to start a read-only query."}</div> : null}
    <div className="query-editor-pane"><SqlEditor ref={editorRef} value={session.draft} snapshot={snapshot} onChange={(draft) => setSession((current) => ({ ...current, draft }))} onRun={(sqlText) => void run(sqlText)} /></div>
    <div className="query-result-resizer" role="separator" aria-label="Resize query results" aria-orientation="horizontal" aria-valuemin={120} aria-valuemax={650} aria-valuenow={session.resultHeight} tabIndex={0} onMouseDown={beginResultResize} onKeyDown={(event) => {
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      event.preventDefault();
      setSession((current) => ({ ...current, outputCollapsed: false, resultHeight: resizedQueryResultHeight(current.resultHeight, 0, event.key === "ArrowUp" ? -20 : 20) }));
    }}><span /></div>
    <section className="query-output" data-collapsed={session.outputCollapsed || undefined}>
      <nav aria-label="Query output"><button type="button" className={session.activeTab === "results" ? "active" : ""} onClick={() => { selectTab("results"); setSession((current) => ({ ...current, activeTab: "results", outputCollapsed: false })); }}>Results {session.result ? `(${session.result.rowCount})` : ""}</button><button type="button" className={session.activeTab === "message" ? "active" : ""} onClick={() => { selectTab("message"); setSession((current) => ({ ...current, activeTab: "message", outputCollapsed: false })); }}>Message</button><button type="button" className={session.activeTab === "history" ? "active" : ""} onClick={() => { selectTab("history"); setSession((current) => ({ ...current, activeTab: "history", outputCollapsed: false })); }}>History ({history.length})</button><button type="button" className="query-output-toggle" aria-label={session.outputCollapsed ? "Expand query output" : "Collapse query output"} onClick={() => setSession((current) => ({ ...current, outputCollapsed: !current.outputCollapsed }))}>{session.outputCollapsed ? "▴" : "▾"}</button></nav>
      {!session.outputCollapsed ? <div className="query-output-body">{session.activeTab === "results" ? <QueryResultGrid result={session.result} /> : session.activeTab === "message" ? <pre className="query-message">{session.message}</pre> : <QueryHistory entries={history} onRestore={(draft) => { setSession((current) => ({ ...current, draft })); editorRef.current?.focus(); }} onDelete={(id) => { void platform.deleteQueryHistory(sourceId, id).then(() => setHistory((current) => current.filter((item) => item.id !== id))); }} onClear={() => { if (window.confirm("Clear all local query history for this data source?")) void platform.clearQueryHistory(sourceId).then(() => setHistory([])); }} />}</div> : null}
    </section>
    {openRequest ? <div className="query-dialog-backdrop" role="presentation"><section className="query-dialog" role="dialog" aria-modal="true" aria-label="Open generated query"><h3>{session.draft.trim() ? "Editor already contains SQL" : "Preview table rows"}</h3><p>{session.draft.trim() ? "Replace it, append the generated table query, or keep the current draft?" : "Open the generated read-only query in the editor?"}</p><div><button type="button" onClick={() => { setSession((current) => ({ ...current, draft: openRequest.sql })); onConsumeOpenRequest?.(); }}>Replace</button>{session.draft.trim() ? <button type="button" onClick={() => { setSession((current) => ({ ...current, draft: `${current.draft.trimEnd()}\n\n${openRequest.sql}` })); onConsumeOpenRequest?.(); }}>Append</button> : null}<button type="button" onClick={() => { onConsumeOpenRequest?.(); }}>Cancel</button></div></section></div> : null}
  </section>;
}
