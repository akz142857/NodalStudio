import { useEffect, useId, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from "react";
import type { DatabaseSnapshot, QueryErrorKind, QueryExecutionResult, QueryHistoryEntry, NodalStudioPlatform } from "../../platform";
import { QueryRunControls } from "./QueryRunControls";
import { queryKeys } from "./query-shortcuts";
import { QueryDraftPanel, type QueryDraftSeed } from "./QueryDraftPanel";
import type { EffectiveSettings, SemanticBundle, TableDefinition } from "../../platform";
import { ActionIcon } from "../ActionIcon";
import "./query-workspace.css";
import { QueryHistory } from "./QueryHistory";
import { QueryResultGrid } from "./QueryResultGrid";
import { loadQuerySession, resizedQueryResultHeight, saveQuerySession, type QuerySession, type QueryTab } from "./query-state";
import { SqlEditor, type SqlEditorHandle } from "./SqlEditor";
import { resolveCapability } from "../../platform/capabilities";

export interface OpenQueryRequest { id: number; sql: string }

interface QueryPageProps {
  platform: NodalStudioPlatform;
  snapshot?: DatabaseSnapshot;
  runtimeKind?: "desktop" | "web";
  openRequest?: OpenQueryRequest;
  onConsumeOpenRequest?: () => void;
  settings?: EffectiveSettings;
  semantics?: SemanticBundle;
  selectedTable?: TableDefinition;
  draftSeed?: QueryDraftSeed;
  onOpenAiSettings?: () => void;
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

export function QueryPage({ platform, snapshot, runtimeKind, openRequest, onConsumeOpenRequest, settings, semantics, selectedTable, draftSeed, onOpenAiSettings }: QueryPageProps) {
  const [drafting, setDrafting] = useState(Boolean(draftSeed && draftSeed.sourceId === snapshot?.sourceId && draftSeed.snapshotId === snapshot?.id));
  const draftBinding = JSON.stringify([settings?.source, settings?.app.privacy, semantics?.logicalRelationships, semantics?.domainGroups, semantics?.knowledge]);
  const [generatedRequest, setGeneratedRequest] = useState<{ sourceId: string; snapshotId: string; sql: string; binding: string }>();
  const [appliedDraft, setAppliedDraft] = useState<{ sourceId: string; snapshotId: string; previous: string; sql: string }>();
  const editorTabRef = useRef<HTMLButtonElement>(null);
  const draftTabRef = useRef<HTMLButtonElement>(null);
  const editorId = useId();
  const pendingGenerated = generatedRequest?.sourceId === snapshot?.sourceId && generatedRequest?.snapshotId === snapshot?.id && generatedRequest?.binding === draftBinding ? generatedRequest : undefined;
  const pendingOpen = pendingGenerated ?? openRequest;
  const closeOpen = () => { if (pendingGenerated) setGeneratedRequest(undefined); else onConsumeOpenRequest?.(); };
  const outputId = useId();
  const outputRef = useRef<HTMLElement>(null);
  const [focusOutput, setFocusOutput] = useState(false);
  const sourceId = snapshot?.sourceId ?? "no-source";
  const capability = resolveCapability("read-only-query", runtimeKind, snapshot?.database.databaseType);
  const desktopReady = Boolean(snapshot) && capability.status === "supported";
  const canDraft = desktopReady && Boolean(settings && semantics);
  const sessionKey = "query-workspace";
  const [session, setSession] = useState<QuerySession>(() => loadQuerySession(sessionKey));
  const [historyRecord, setHistoryRecord] = useState<{ sourceId: string; entries: QueryHistoryEntry[] }>({ sourceId, entries: [] });
  const history = desktopReady && historyRecord.sourceId === sourceId ? historyRecord.entries : [];
  const [executing, setExecuting] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const editorRef = useRef<SqlEditorHandle>(null);
  const activeQueryId = useRef<string | undefined>(undefined);
  const previousSourceId = useRef(sourceId);
  const stopResizeRef = useRef<(() => void) | undefined>(undefined);

  if (previousSourceId.current !== sourceId) {
    previousSourceId.current = sourceId;
    setSession((current) => ({ ...current, result: undefined, outcome: undefined, message: "Data source changed. The SQL draft was preserved; run it again against the new source.", activeTab: "message" }));
  }
  useEffect(() => { saveQuerySession(sessionKey, session); }, [session]);
  useEffect(() => {
    if (!snapshot || !desktopReady) return;
    let active = true;
    void platform.listQueryHistory(sourceId).then((entries) => { if (active) setHistoryRecord({ sourceId, entries }); }).catch(() => { if (active) setHistoryRecord({ sourceId, entries: [] }); });
    return () => { active = false; };
  }, [platform, desktopReady, snapshot, sourceId]);
  useEffect(() => {
    if (!executing) return;
    const started = performance.now();
    const timer = window.setInterval(() => setElapsedMs(performance.now() - started), 100);
    return () => window.clearInterval(timer);
  }, [executing]);
  useEffect(() => () => stopResizeRef.current?.(), []);

  async function run(sqlText: string) {
    if (!snapshot || !desktopReady || executing || activeQueryId.current || drafting || pendingOpen) return;
    if (!sqlText.trim()) {
      setSession((current) => ({ ...current, message: "Enter one read-only SELECT statement before running the query.", activeTab: "message", outputCollapsed: false }));
      editorRef.current?.focus();
      return;
    }
    setAppliedDraft(undefined);
    const queryId = crypto.randomUUID();
    activeQueryId.current = queryId;
    setExecuting(true);
    setElapsedMs(0);
    setSession((current) => ({ ...current, message: "Executing read-only query…", activeTab: "message", outputCollapsed: false }));
    try {
      const result: QueryExecutionResult = await platform.executeReadonlyQuery({ queryId, sourceId, sql: sqlText, rowLimit: session.rowLimit, timeoutMs: 30_000 });
      const summary = `${result.rowCount} rows in ${result.durationMs} ms${result.truncated ? " · truncated at the selected row limit" : ""}.`;
      setSession((current) => ({ ...current, result, outcome: "succeeded", message: [summary, ...result.notices].join("\n"), activeTab: "results", outputCollapsed: false }));
    } catch (error) {
      const normalized = queryError(error);
      setSession((current) => ({ ...current, outcome: "failed", message: `${normalized.kind}: ${normalized.message}`, activeTab: "message", outputCollapsed: false }));
    } finally {
      activeQueryId.current = undefined;
      setExecuting(false);
      setHistoryRecord({ sourceId, entries: await platform.listQueryHistory(sourceId).catch(() => []) });
    }
  }

  function stopQuery() {
    if (activeQueryId.current) void platform.cancelQuery(activeQueryId.current).catch((error: unknown) => {
      setSession((current) => ({ ...current, message: `Unable to stop query: ${queryError(error).message}`, activeTab: "message" }));
    });
  }
  function showEditor() { setDrafting(false); setFocusOutput(false); }
  function selectTab(tab: QueryTab) { setSession((current) => ({ ...current, activeTab: tab, outputCollapsed: false })); }
  function beginResultResize(event: ReactMouseEvent<HTMLDivElement>) {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = outputRef.current?.getBoundingClientRect().height || session.resultHeight;
    stopResizeRef.current?.();
    document.body.classList.add("is-resizing-query-output");
    setSession((current) => ({ ...current, outputCollapsed: false }));
    const move = (moveEvent: MouseEvent) => {
      moveEvent.preventDefault();
      const resultHeight = resizedQueryResultHeight(startHeight, startY, moveEvent.clientY);
      setSession((current) => current.resultHeight === resultHeight ? current : { ...current, resultHeight, outputResized: true });
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
  const outputHeight = session.outputCollapsed ? "46px" : session.outputResized ? `${session.resultHeight}px` : "45%";
  const tabs: { id: QueryTab; label: string; count?: number }[] = [
    { id: "results", label: "Results", count: session.result?.rowCount },
    { id: "message", label: "Message" },
    { id: "history", label: "History", count: history.length },
  ];

  return <section className="query-page" aria-label="Query workspace" data-focus-output={focusOutput || undefined} style={{ "--query-output-height": outputHeight } as CSSProperties} onKeyDownCapture={(event) => {
    if (!(event.metaKey || event.ctrlKey) || event.altKey || event.nativeEvent.isComposing) return;
    const key = event.key.toLowerCase();
    if (key !== "r" && key !== "enter" && key !== ".") return;
    // Own query shortcuts inside this workspace, including disabled states, so ⌘R cannot refresh the schema.
    event.preventDefault(); event.stopPropagation();
    if (event.repeat || pendingOpen) return;
    if (key === ".") { if (!event.shiftKey) stopQuery(); return; }
    if (drafting || (key === "enter" && event.shiftKey)) return;
    void run(key === "r" && event.shiftKey ? editorRef.current?.getCurrentStatementSql() ?? "" : editorRef.current?.getExecutableSql() ?? "");
  }}>
    <header className="query-toolbar">
      <div className="query-source"><ActionIcon name="database" /><div><strong>{snapshot?.database.name ?? "Query"}</strong><span>{snapshot ? `${snapshot.database.databaseType === "postgreSql" ? "PostgreSQL" : "MySQL"} · ${snapshot.schemas.length} ${snapshot.schemas.length === 1 ? "schema" : "schemas"}` : "Select a data source to begin"}</span></div></div>
      <div className="query-toolbar-actions">

        <span className="query-readonly" title="Queries run in a read-only transaction"><ActionIcon name="shield" />Read only</span>
        <label className="query-limit">Row limit<select value={[100, 500, 1000].includes(session.rowLimit) ? session.rowLimit : "custom"} onChange={(event) => setSession((current) => ({ ...current, rowLimit: event.target.value === "custom" ? 5000 : Number(event.target.value) }))}><option value={100}>100</option><option value={500}>500</option><option value={1000}>1,000</option><option value="custom">Custom…</option></select></label>
        {![100, 500, 1000].includes(session.rowLimit) ? <label className="query-custom-limit"><input aria-label="Custom row limit" type="number" min={1} max={5000} value={session.rowLimit} onChange={(event) => setSession((current) => ({ ...current, rowLimit: Math.min(5000, Math.max(1, Number(event.target.value) || 1)) }))} /></label> : null}
        <QueryRunControls executing={executing} disabled={!desktopReady || drafting || Boolean(pendingOpen)} onRun={() => void run(editorRef.current?.getExecutableSql() ?? "")} onRunCurrent={() => void run(editorRef.current?.getCurrentStatementSql() ?? "")} onStop={stopQuery} />
      </div>
    </header>
    {!desktopReady ? <div className="query-runtime-notice">{runtimeKind === "web" ? "Query is available only in the desktop app. The web viewer never connects to your database." : capability.scope}</div> : null}
    {!drafting && appliedDraft && appliedDraft.sourceId === sourceId && appliedDraft.snapshotId === snapshot?.id && session.draft === appliedDraft.sql ? <div className="query-draft-notice" role="status"><span>AI draft · Review the SQL, then choose Run when ready. Nothing has run.</span><button type="button" onClick={() => { setSession((current) => ({ ...current, draft: appliedDraft.previous })); setAppliedDraft(undefined); editorRef.current?.focus(); }}>Undo replacement</button></div> : null}
    <div className="query-editor-heading">
      <div className="query-input-tabs" role="tablist" aria-label="Query input" onKeyDown={(event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const next = canDraft && (event.key === "End" || (event.key !== "Home" && !drafting));
        setDrafting(next); setFocusOutput(false); (next ? draftTabRef : editorTabRef).current?.focus();
      }}>
        <button ref={editorTabRef} type="button" role="tab" id={`${editorId}-sql`} aria-controls={`${editorId}-sql-panel`} aria-selected={!drafting} tabIndex={drafting ? -1 : 0} onClick={showEditor}>SQL editor</button>
        {canDraft ? <button ref={draftTabRef} type="button" role="tab" id={`${editorId}-draft`} aria-controls={`${editorId}-draft-panel`} aria-selected={drafting} tabIndex={drafting ? 0 : -1} onClick={() => { setDrafting(true); setFocusOutput(false); }}><ActionIcon name="ai" />Draft query</button> : null}
      </div>
      <span>{drafting ? "Generate a draft, then review it in SQL editor" : `Run a selection, or use ${queryKeys.current} for the current statement`}</span>
    </div>
    <div className="query-input-pane">
      <div className="query-editor-pane" role="tabpanel" id={`${editorId}-sql-panel`} aria-labelledby={`${editorId}-sql`} hidden={drafting}><SqlEditor ref={editorRef} value={session.draft} snapshot={snapshot} onChange={(draft) => setSession((current) => ({ ...current, draft }))} onRun={(sqlText) => void run(sqlText)} executing={executing} disabled={!desktopReady || Boolean(pendingOpen)} onStop={stopQuery} /></div>
      {canDraft && snapshot && settings && semantics ? <div className="query-draft-pane" role="tabpanel" id={`${editorId}-draft-panel`} aria-labelledby={`${editorId}-draft`} hidden={!drafting}><QueryDraftPanel platform={platform} snapshot={snapshot} settings={settings} semantics={semantics} seed={draftSeed} initialTable={selectedTable} onOpenSettings={() => onOpenAiSettings?.()} onUseSql={(sql) => setGeneratedRequest({ sourceId, snapshotId: snapshot.id, sql, binding: draftBinding })} /></div> : null}
    </div>
    <div className="query-result-resizer" hidden={drafting} role="separator" aria-label="Resize query results" aria-orientation="horizontal" aria-valuemin={120} aria-valuemax={650} aria-valuenow={session.resultHeight} tabIndex={0} onMouseDown={beginResultResize} onKeyDown={(event) => {
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      event.preventDefault();
      setSession((current) => ({ ...current, outputCollapsed: false, outputResized: true, resultHeight: resizedQueryResultHeight(outputRef.current?.getBoundingClientRect().height || current.resultHeight, 0, event.key === "ArrowUp" ? -20 : 20) }));
    }}><span /></div>
    <section ref={outputRef} hidden={drafting} className="query-output" aria-label="Query output pane" data-collapsed={session.outputCollapsed || undefined}>
      <header className="query-output-toolbar">
        <div className="query-output-tabs" role="tablist" aria-label="Query output">{tabs.map((tab, index) => <button key={tab.id} type="button" role="tab" aria-label={`${tab.label}${tab.count !== undefined ? ` ${tab.count}` : ""}`} id={`${outputId}-${tab.id}`} aria-controls={`${outputId}-panel`} aria-selected={session.activeTab === tab.id} tabIndex={session.activeTab === tab.id ? 0 : -1} onClick={() => selectTab(tab.id)} onKeyDown={(event) => {
          const next = event.key === "ArrowRight" ? (index + 1) % tabs.length : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : undefined;
          if (next === undefined) return;
          event.preventDefault(); selectTab(tabs[next].id);
          document.getElementById(`${outputId}-${tabs[next].id}`)?.focus();
        }}>{tab.label}{tab.count !== undefined ? <span className="query-tab-count">{tab.count}</span> : null}</button>)}</div>
        <span className="query-result-summary" role="status">{executing ? `Running · ${(elapsedMs / 1000).toFixed(1)} s` : session.outcome === "failed" ? "Query failed · See Message" : session.result ? `${session.result.rowCount} ${session.result.rowCount === 1 ? "row" : "rows"} · ${session.result.durationMs} ms${session.result.truncated ? " · Limit reached" : ""}` : "Ready"}</span>
        <div className="query-pane-actions">
          <button type="button" aria-label={focusOutput ? "Restore split view" : "Expand output pane"} title={focusOutput ? "Restore split view" : "Expand output pane"} aria-pressed={focusOutput} onClick={() => { setFocusOutput(!focusOutput); setSession((current) => ({ ...current, outputCollapsed: false })); }}><ActionIcon name={focusOutput ? "split" : "expand"} /></button>
          <button type="button" aria-label={session.outputCollapsed ? "Expand query output" : "Collapse query output"} title={session.outputCollapsed ? "Expand query output" : "Collapse query output"} aria-expanded={!session.outputCollapsed} onClick={() => { setFocusOutput(false); setSession((current) => ({ ...current, outputCollapsed: !current.outputCollapsed })); }}><span className="query-collapse-icon" data-collapsed={session.outputCollapsed || undefined}><ActionIcon name="chevronUp" /></span></button>
        </div>
      </header>
      {!session.outputCollapsed ? <div className="query-output-body" role="tabpanel" id={`${outputId}-panel`} aria-labelledby={`${outputId}-${session.activeTab}`} tabIndex={0}>{session.activeTab === "results" ? <QueryResultGrid result={session.result} platform={platform} /> : session.activeTab === "message" ? <pre className="query-message">{session.message}</pre> : <QueryHistory entries={history} onRestore={(draft) => { showEditor(); setSession((current) => ({ ...current, draft })); requestAnimationFrame(() => editorRef.current?.focus()); }} onDelete={(id) => { void platform.deleteQueryHistory(sourceId, id).then(() => setHistoryRecord((current) => ({ ...current, entries: current.entries.filter((item) => item.id !== id) }))); }} onClear={() => { if (window.confirm("Clear all local query history for this data source?")) void platform.clearQueryHistory(sourceId).then(() => setHistoryRecord({ sourceId, entries: [] })); }} />}</div> : null}
    </section>

    {pendingOpen ? <div className="query-dialog-backdrop" role="presentation"><section className="query-dialog" role="dialog" aria-modal="true" aria-label="Open generated query" onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); closeOpen(); } }}><h3>{pendingGenerated ? "Use this SQL draft?" : session.draft.trim() ? "Editor already contains SQL" : "Preview table rows"}</h3><p>{pendingGenerated ? "This replaces the editor draft. You can undo the replacement. Review it in the editor, then choose Run to execute." : session.draft.trim() ? "Replace it, append the generated table query, or keep the current draft?" : "Open the generated read-only query in the editor?"}</p>{pendingGenerated ? <pre aria-label="SQL to insert">{pendingGenerated.sql}</pre> : null}<div><button type="button" onClick={() => {
      if (pendingGenerated) { setAppliedDraft({ ...pendingGenerated, previous: session.draft }); setDrafting(false); }
      showEditor(); setSession((current) => ({ ...current, draft: pendingOpen.sql })); closeOpen(); requestAnimationFrame(() => editorRef.current?.focus());
    }}>Replace</button>{session.draft.trim() && !pendingGenerated ? <button type="button" onClick={() => { showEditor(); setSession((current) => ({ ...current, draft: `${current.draft.trimEnd()}\n\n${pendingOpen.sql}` })); closeOpen(); }}>Append</button> : null}<button type="button" autoFocus onClick={closeOpen}>Cancel</button></div></section></div> : null}
  </section>;
}
