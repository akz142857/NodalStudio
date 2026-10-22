// Development-only theme fixture. Synthetic data; no database or network calls.
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ConnectionPanel } from "../components/ConnectionPanel";
import { DatabaseSnapshotHeader } from "../components/DatabaseSnapshotHeader";
import { HistoryPanel } from "../components/HistoryPanel";
import { SchemaCanvas } from "../components/SchemaCanvas";
import { SchemaChangesPanel } from "../components/SchemaChangesPanel";
import { QueryPage } from "../components/query/QueryPage";
import { defaultAppSettings, type NodalStudioPlatform, type QueryExecutionResult } from "../platform";
import { discoveryPreview, discoveryResult, discoverySettings } from "./discovery-fixture";
import type { ConnectionTestOptions, SaveDataSourceInput, DiscoveryInput, DiscoveryPreview } from "../platform";
import { reportSnapshot, reportSemantics } from "./schema-report-fixture";
import { diagramAfter, diagramBefore, diagramChangeSet } from "./diagram-comparison-fixture";
import "../styles.css";

const result: QueryExecutionResult = {
  queryId: "theme-preview", columns: [{ name: "id", databaseType: "int4" }, { name: "customer", databaseType: "text" }, { name: "total", databaseType: "numeric" }],
  rows: [[{ kind: "number", value: 1 }, { kind: "text", value: "Ada", truncated: false }, { kind: "number", value: 129.5 }], [{ kind: "number", value: 2 }, { kind: "null" }, { kind: "number", value: 85 }]],
  rowCount: 2, durationMs: 4, truncated: false, notices: [],
};
const previews = new Map<string, DiscoveryPreview>();
const platform = {
  testPostgresConnection: (_input: SaveDataSourceInput, options?: ConnectionTestOptions) => new Promise((resolve, reject) => {
    const phases = ["configuration", "ssh", "handshake", "metadata", "tls"] as const;
    let index = 0;
    const timer = setInterval(() => {
      if (index === 3 && new URLSearchParams(location.search).get("testResult") === "failure") {
        clearInterval(timer);
        options?.signal?.removeEventListener("abort", abort);
        reject(Object.assign(new Error("The certificate does not match the database hostname. Check the hostname and CA certificate."), { stage: "tls", sshConnected: Boolean(_input.security?.ssh) }));
      } else if (index < phases.length) options?.onProgress?.({ phase: phases[index++], sshConnected: Boolean(_input.security?.ssh) && index > 2 });
      else {
        clearInterval(timer);
        options?.signal?.removeEventListener("abort", abort);
        resolve({ database: { name: "Preview database", databaseType: "postgreSql", version: "16" }, sslActive: true, serverReadOnly: true });
      }
    }, 1200);
    const abort = () => { clearInterval(timer); reject(Object.assign(new Error("Cancelled"), { stage: "cancelled", sshConnected: false })); };
    options?.signal?.addEventListener("abort", abort, { once: true });
  }),
  listSnapshots: () => Promise.resolve([{ id: reportSnapshot.id, sourceId: reportSnapshot.sourceId, capturedAt: reportSnapshot.capturedAt, fingerprint: reportSnapshot.fingerprint, databaseName: reportSnapshot.database.name, schemaCount: reportSnapshot.schemas.length, tableCount: reportSnapshot.schemas.reduce((n,s) => n+s.tables.length,0) }]),
  prepareDiscovery: (input: DiscoveryInput) => { const preview = discoveryPreview(input); previews.set(preview.requestId, preview); return Promise.resolve(preview); },
  runDiscovery: (id: string) => { const result = discoveryResult(previews.get(id)!); result.answer = { terms: [], meanings: [], rankings: [], interpretations: [], readingOrder: [], unknowns: [], sqlDraft: { sql: "SELECT o.id, o.total\nFROM public.orders AS o\nWHERE o.total > 50\nLIMIT 100;", explanation: "Lists order IDs and totals above 50. Synthetic preview only.", assumptions: ["Amount is interpreted using the stored total column."], clarification: [] } }; return Promise.resolve(result); },
  cancelDiscovery: () => Promise.resolve(),
  listDataSources: () => Promise.resolve([]), listQueryHistory: () => Promise.resolve([]), executeReadonlyQuery: () => Promise.resolve(result), exportQueryResult: () => Promise.resolve(null),
  getSnapshot: (id: string) => Promise.resolve(id === diagramBefore.id ? diagramBefore : diagramAfter),
} as unknown as NodalStudioPlatform;

export function Preview() {
  const [theme, setTheme] = useState(new URLSearchParams(location.search).get("theme") ?? "light");
  const [page, setPage] = useState(new URLSearchParams(location.search).get("page") ?? "Query");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [width, setWidth] = useState("100%");
  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);
  return <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
    <header className="ds-surface" style={{ display: "flex", gap: 16, alignItems: "center", padding: 12, background: "var(--ds-sidebar)" }}>
      <strong>Nodal Studio · Theme review</strong>
      <label>Theme <select aria-label="Preview theme" value={theme} onChange={(event) => setTheme(event.target.value)}><option>light</option><option>dark</option><option>system</option></select></label>
      <nav className="segmented" aria-label="Preview page">{["Query", "Database", "Changes", "Connections"].map((name) => <button key={name} className={name === page ? "active" : ""} onClick={() => setPage(name)}>{name}</button>)}</nav>
      <label>Canvas width <select aria-label="Preview canvas width" value={width} onChange={(event) => setWidth(event.target.value)}><option value="100%">Full width</option><option value="640px">640 px</option><option value="360px">360 px</option></select></label>
      <span>Synthetic data · no database connection</span>
    </header>
    <main style={{ position: "relative", flex: 1, minHeight: 0, width, maxWidth: "100%", margin: "0 auto" }}>
      {page === "Query" ? <QueryPage platform={platform} runtimeKind="desktop" snapshot={reportSnapshot} settings={discoverySettings()} semantics={reportSemantics} selectedTable={reportSnapshot.schemas[0].tables[1]} onOpenAiSettings={() => {}} /> : null}
      {page === "Database" ? <div style={{display:"flex",height:"100%",minHeight:0}}><section className="canvas-placeholder database-workspace" style={{flex:1}}><DatabaseSnapshotHeader snapshot={reportSnapshot} latestSnapshotId={reportSnapshot.id} refreshState="idle" onOpenHistory={()=>setHistoryOpen(!historyOpen)}/><SchemaCanvas snapshot={reportSnapshot} semantics={reportSemantics} query="" canvasSettings={defaultAppSettings().canvas} onSelectTable={() => {}} runtimeKind="desktop" /></section>{historyOpen ? <aside style={{width:300,padding:16,overflow:"auto",background:"var(--ds-sidebar)"}}><HistoryPanel sourceId={reportSnapshot.sourceId} revision={reportSnapshot.id} activeSnapshot={reportSnapshot} platform={platform} onSelect={()=>{}} onCompare={()=>{}} /></aside> : null}</div> : null}
      {page === "Changes" ? <div style={{ display: "flex", height: "100%" }}><SchemaChangesPanel currentSnapshot={diagramAfter} changeSet={diagramChangeSet} platform={platform} runtimeKind="desktop" /></div> : null}
      {page === "Connections" ? <aside className="sidebar" style={{ width: 300 }}><ConnectionPanel enabled platform={platform} defaultDatabaseType="postgreSql" defaultSslMode="prefer" onSnapshot={() => {}} /></aside> : null}
    </main>
  </div>;
}
const root = createRoot(document.getElementById("root")!);
const client = new QueryClient();
root.render(<QueryClientProvider client={client}><Preview /></QueryClientProvider>);
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount());
