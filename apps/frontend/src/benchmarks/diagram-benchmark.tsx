// Separate entry point: production React/React Flow/ELK, no mock workers or DOM.
import { createRoot } from "react-dom/client";
import { Profiler, useCallback, useMemo, useState } from "react";
import { SchemaCanvas } from "../components/SchemaCanvas";
import { defaultAppSettings, getPlatform, type DatabaseSnapshot, type NodalStudioPlatform, type TableDefinition } from "../platform";
import "../styles.css";
import { CanvasAttribution, installCanvasAttribution } from "./canvas-attribution";

const diagnostic = import.meta.env.NODAL_BENCH_PROFILE === true;
let detail = "idle";
const attribution = new CanvasAttribution();
attribution.contextDetail = () => detail;
if (diagnostic) installCanvasAttribution(attribution);
const effectCallbacks = diagnostic ? {
  onCommit: (_id: string, _phase: string, duration: number, commitTime: number) => attribution.effect("react-layout-effects", duration, commitTime),
  onPostCommit: (_id: string, _phase: string, duration: number, commitTime: number) => attribution.effect("react-passive-effects", duration, commitTime),
} : {};
let commits: { phase: string; actualMs: number; commitMs: number; start: number; end: number }[] = [];
let spikes: { detail: string; ms: number; at: number }[] = [];
function profile(_id: string, phase: string, actualMs: number, _base: number, start: number, commitTime: number) {
  if (diagnostic) { attribution.effect("react-render", actualMs, commitTime); attribution.effect("react-commit-wall", performance.now() - commitTime, commitTime); }
  if (diagnostic && active) commits.push({ phase, actualMs, commitMs: performance.now() - commitTime, start, end: performance.now() });
}
type Measurement = { commits?: typeof commits; spikes?: typeof spikes; phase: string; wallMs: number; frameP95Ms: number; frameMaxMs: number; framesOver50Ms: number; longTasks: number | null; longestTaskMs: number | null; mountedTables: number; mountedEdges: number; paintedSvgRoots: number; domElements: number; workerMs: number[]; hidden: boolean; movedGestures?: number; temporarilyMutedEdges?: number; mutedEdgesAfter?: number };
let active: { phase: string; start: number; last: number; gaps: number[]; frameWindows: { start: number; end: number; ms: number }[]; tasks: number[]; workers: number[]; hidden: boolean; focused: boolean; focusLost: boolean } | undefined;
let exportFrames: { start: number; end: number; ms: number }[] = [];
const measurements: Measurement[] = [];
const focusSamples: { focusPhase: string; focusedAtStart: boolean; focusedAtEnd: boolean; focusLost: boolean }[] = [];
window.addEventListener("blur", () => { if (active) active.focusLost = true; });
const traceKey = "nodal-diagram-benchmark-trace";
const previousTrace = localStorage.getItem(traceKey);
let scenario: Record<string, unknown> = {};
let peakExportDetails = 0;
let beforeExport = { transform: "", selected: "" };
function trace(phase: string, state: "running" | "completed") {
  localStorage.setItem(traceKey, JSON.stringify({ phase, state, scenario, measurements: measurements.slice(-3), time: new Date().toISOString() }));
}
const supportsLongTasks = PerformanceObserver.supportedEntryTypes.includes("longtask");
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
function tick(now: number) { if (diagnostic) { attribution.detail = detail; if (active) attribution.frame({ phase: active.phase, detail, start: active.last, end: now, ms: now - active.last }); } if (active?.phase === "svg-export") peakExportDetails = Math.max(peakExportDetails, (document.querySelector('.diagram-export-surface') ?? document).querySelectorAll('.table-node:not([data-overview="true"])').length); if (active) { if (diagnostic && now - active.last > 45) spikes.push({ detail, ms: now - active.last, at: now }); active.gaps.push(now - active.last); active.frameWindows.push({ start: active.last, end: now, ms: now - active.last }); active.last = now; active.hidden ||= document.hidden; } requestAnimationFrame(tick); }
requestAnimationFrame(tick);
if (supportsLongTasks) new PerformanceObserver((list) => { if (active) active.tasks.push(...list.getEntries().map((entry) => entry.duration)); }).observe({ type: "longtask" });
const NativeWorker = window.Worker;
window.Worker = class extends NativeWorker {
  started = 0;
  constructor(url: string | URL, options?: WorkerOptions) {
    super(url, options);
    this.addEventListener("message", () => { if (active && this.started) active.workers.push(performance.now() - this.started); });
  }
  override postMessage(message: unknown, transfer?: Transferable[] | StructuredSerializeOptions) {
    this.started = performance.now();
    if (Array.isArray(transfer)) super.postMessage(message, transfer); else super.postMessage(message, transfer);
  }
};
function begin(phase: string) { if (diagnostic) { attribution.phase = phase; attribution.detail = phase; } commits = []; spikes = []; detail = phase; const now = performance.now(); active = { phase, start: now, last: now, gaps: [], frameWindows: [], tasks: [], workers: [], hidden: document.hidden, focused: document.hasFocus(), focusLost: false }; trace(phase, "running"); }
function finish(): Measurement | undefined {
  if (!active) return;
  const sample = active; active = undefined;
  if (diagnostic) attribution.phase = "idle";
  focusSamples.push({ focusPhase: sample.phase, focusedAtStart: sample.focused, focusedAtEnd: document.hasFocus(), focusLost: sample.focusLost });
  if (sample.phase === "svg-export") exportFrames = sample.frameWindows;
  const gaps = [...sample.gaps].sort((a, b) => a - b);
  const result = { phase: sample.phase, wallMs: performance.now() - sample.start, frameP95Ms: gaps[Math.floor(gaps.length * .95)] ?? 0, frameMaxMs: Math.max(0, ...gaps), framesOver50Ms: gaps.filter((gap) => gap > 50).length, longTasks: supportsLongTasks ? sample.tasks.length : null, longestTaskMs: supportsLongTasks ? Math.max(0, ...sample.tasks) : null, mountedTables: document.querySelectorAll(".table-node").length, mountedEdges: document.querySelectorAll(".react-flow__edge > .react-flow__edge-path").length, paintedSvgRoots: [...document.querySelectorAll(".react-flow__edges svg.shared-edge-layer, .react-flow__edges > svg:not(.shared-edge-layer)")].filter((svg) => svg.querySelector(".react-flow__edge-path")).length, domElements: document.querySelectorAll("*").length, workerMs: sample.workers, hidden: sample.hidden, ...(diagnostic ? { commits: [...commits].sort((a,b) => (b.actualMs+b.commitMs)-(a.actualMs+a.commitMs)).slice(0,8), spikes } : {}) };
  measurements.push(result); trace(sample.phase, "completed"); return result;
}
function fixture(count: number, connected: boolean): DatabaseSnapshot {
  const tables: TableDefinition[] = Array.from({ length: count }, (_, i) => {
    const groupStart = connected ? 0 : Math.floor(i / 40) * 40;
    const name = `entity_${String(i).padStart(4, "0")}`;
    const targets = [...new Set([i - 1, groupStart])].filter((target) => target >= groupStart && target < i);
    const names = ["id", ...targets.map((target) => `parent_${target}_id`), ...Array.from({ length: 19 - targets.length }, (_, c) => `attribute_${c}`)];
    return { key: { kind: "table", schema: "public", name }, tableKind: "ordinary", comment: `Synthetic benchmark entity ${i}`, primaryKey: { name: `${name}_pkey`, columns: ["id"] },
      columns: names.map((column, c) => ({ name: column, ordinalPosition: c + 1, formattedType: c < targets.length + 1 ? "bigint" : "character varying(200)", typeSchema: "pg_catalog", typeName: c < targets.length + 1 ? "int8" : "varchar", nullable: c > targets.length, defaultValue: null, identity: null, generated: false, comment: null })),
      foreignKeys: targets.map((target) => ({ name: `${name}_parent_${target}_fk`, columns: [`parent_${target}_id`], referencedSchema: "public", referencedTable: `entity_${String(target).padStart(4, "0")}`, referencedColumns: ["id"], onUpdate: "noAction", onDelete: "noAction", matchType: "simple", deferrable: false, initiallyDeferred: false })),
      indexes: [{ name: `${name}_pkey`, columns: ["id"], primary: true, unique: true, method: "btree", predicate: null }], constraints: [] };
  });
  return { id: `bench-${count}-${connected}`, sourceId: "isolated-benchmark", capturedAt: "2026-10-15T00:00:00Z", fingerprint: `bench-${count}-${connected}`, database: { name: "Synthetic benchmark only", databaseType: "postgreSql", version: "17" }, schemas: [{ name: "public", tables, views: [], enums: [] }] };
}
const settings = defaultAppSettings().canvas;
const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>(".schema-canvas-workspace button")].find((element) => element.textContent === name || element.getAttribute("aria-label") === name);
async function ready() { const started = performance.now(); while (performance.now() - started < 60000) { if (button("Auto layout")?.disabled === false && button("Export SVG")?.disabled === false && document.querySelector(".schema-canvas-flow .table-node") && document.querySelector(".schema-canvas-flow .react-flow__edge-path")) { await frame(); await frame(); return; } await new Promise((resolve) => setTimeout(resolve, 50)); } throw new Error("Canvas did not become ready within 60 seconds"); }
export function Benchmark() {
  const [count, setCount] = useState(2000); const [connected, setConnected] = useState(false);
  const [snapshot, setSnapshot] = useState<DatabaseSnapshot>(); const [selected, setSelected] = useState<TableDefinition>();
  const [output, setOutput] = useState("Ready. Keep this tab visible during measurements.");
  const [busy, setBusy] = useState(false);
  const [hideEdges, setHideEdges] = useState(false);
  const [hideTables, setHideTables] = useState(false);
  const [saveToDisk, setSaveToDisk] = useState(false);
  const [exportResult, setExportResult] = useState<Record<string, unknown>>();
  const [exportFrameReport, setExportFrameReport] = useState<Record<string, unknown>>();
  const [exportBatchReport, setExportBatchReport] = useState<Record<string, unknown>>();
  const [diagnosticReceipt, setDiagnosticReceipt] = useState("");
  const [locate, setLocate] = useState<import("../components/SchemaCanvas").CanvasLocateRequest>();
  const report = useCallback(() => { trace(measurements.at(-1)?.phase ?? "idle", "completed"); setOutput(JSON.stringify({ userAgent: navigator.userAgent, viewport: [innerWidth, innerHeight], devicePixelRatio, tables: count, topology: connected ? "connected" : "40-table components", scenario, measurements }, null, 2)); }, [count, connected]);
  const platform = useMemo(() => ({ saveDiagramExport: async (input) => {
    if (input.format !== "svg") throw new Error("This benchmark captures SVG in memory only.");
    // Stop capture timing before benchmark validation. Parsing a giant SVG into
    // another native SVG DOM itself adds substantial WebKit memory/CPU cost.
    const preparedWallMs = active ? performance.now() - active.start : undefined;
    const validationStarted = performance.now();
    const payload = new TextDecoder().decode(input.data instanceof Uint8Array ? input.data : Uint8Array.from(input.data));
    const tables = new Set<string>(); const edges = new Set<string>(); let columns = 0; let edgeCount = 0; let arrowheads = 0;
    for (const match of payload.matchAll(/<(?:g|path)\b[^>]*>/g)) {
      const tag = match[0]; const table = tag.match(/data-table-id="([^"]*)"/)?.[1];
      if (table !== undefined) tables.add(table);
      if (/data-column-name=/.test(tag)) columns++;
      if (tag.match(/class="([^"]*)"/)?.[1].split(" ").includes("react-flow__edge")) { edgeCount++; edges.add(tag.match(/data-id="([^"]*)"/)?.[1] ?? ""); }
      if (tag.startsWith("<path") && /marker-end=/.test(tag)) arrowheads++;
    }
    const summary = { bytes: input.data.length, tables: tables.size, columns, edges: edgeCount, uniqueEdges: edges.size, arrowheads,
      theme: payload.match(/data-theme="([^"]*)"/)?.[1], validation: "String inventory only; validate the saved file with an independent XML parser." };
    await frame(); await frame();
    const restored = { transform: document.querySelector<HTMLElement>(".react-flow__viewport")?.style.transform ?? "", selected: document.querySelector(".react-flow__node.selected")?.getAttribute("data-id") ?? "" };
    const validationMs = performance.now() - validationStarted;
    const nativeSaveStarted = performance.now();
    const receipt = saveToDisk ? await getPlatform().saveDiagramExport(input) : { path: "benchmark memory (no file written)" };
    const nativeSaveMs = performance.now() - nativeSaveStarted;
    finish();
    const stages: Record<string, number[]> = {};
    for (const entry of performance.getEntriesByType("measure")) if (entry.name.startsWith("diagram-export:")) (stages[entry.name.replace("diagram-export:", "")] ??= []).push(entry.duration);
    const stageFrames: Record<string, { count: number; p95: number; max: number; over50: number }> = {};
    for (const name of ["mount", "edge-batch", "edge-commit", "edge-read", "batch", "table-commit", "read", "serialize", "restore", "restore-surface", "restore-interaction", "bytes", "byte-allocation", "utf8-chunk"]) {
      const ranges = performance.getEntriesByName(`diagram-export:${name}`);
      const gaps = exportFrames.filter((gap) => ranges.some((range) => gap.start < range.startTime + range.duration && gap.end > range.startTime)).map((gap) => gap.ms).sort((a, b) => a - b);
      stageFrames[name] = { count: gaps.length, p95: gaps[Math.floor(gaps.length * .95)] ?? 0, max: Math.max(0, ...gaps), over50: gaps.filter((gap) => gap > 50).length };
    }
    setExportFrameReport(stageFrames);
    setExportBatchReport(Object.fromEntries(["edge-batch", "batch"].map((name) => {
      const sizes = performance.getEntriesByName(`diagram-export:${name}`).flatMap((entry) => {
        const detail: unknown = (entry as PerformanceMeasure).detail;
        const size = typeof detail === "object" && detail !== null && "count" in detail ? detail.count : undefined;
        return typeof size === "number" ? [size] : [];
      });
      return [name, { count: sizes.length, total: sizes.reduce((a, b) => a + b, 0), min: sizes.length ? Math.min(...sizes) : 0, max: Math.max(0, ...sizes) }];
    })));
    setExportResult({ ...summary, preparedWallMs, validationMs, nativeSaveMs, savedToDisk: saveToDisk, transport: input.data instanceof Uint8Array ? "binary" : "legacy-json", stages: Object.fromEntries(Object.entries(stages).map(([name, values]) => [name, { count: values.length, sum: values.reduce((a,b) => a+b,0), max: Math.max(...values) }])), restoreMs: performance.getEntriesByName("diagram-export:restore").at(-1)?.duration, peakDetailedTables: peakExportDetails, viewportRestored: restored.transform === beforeExport.transform, selectionRestored: restored.selected === beforeExport.selected }); report();
    return receipt;
  } }) as Pick<NodalStudioPlatform, "saveDiagramExport"> as NodalStudioPlatform, [report, saveToDisk]);
  async function load() {
    if (diagnostic) { attribution.reset(); attribution.phase = "retire"; attribution.detail = "canvas-unmount"; }
    scenario = { tables: count, connected, hideEdges, hideTables };
    setBusy(true); setSnapshot(undefined); setSelected(undefined); setLocate(undefined);
    await frame(); await frame(); begin("first-load");
    detail = "fixture"; const next = fixture(count, connected); detail = "canvas-render-and-paint"; setSnapshot(next);
    try { await ready(); await new Promise((resolve) => setTimeout(resolve, 350)); finish(); report(); return next; }
    catch (error) { finish(); report(); setOutput((previous) => `${previous}\n${String(error)}`); }
    finally { setBusy(false); }
  }
  async function runFullScenario() {
    const next = await load(); if (!next || !(await autoLayout())) return;
    setBusy(true);
    try {
      const table = next.schemas[0].tables[20];
      setSelected(table); setLocate({ sourceId: next.sourceId, snapshotId: next.id, nodeId: `public.${table.key.name}`, revision: Date.now() });
      // Location can wait for node measurement. Start the animation settling
      // allowance only after the requested table is actually selected.
      const locateStarted = performance.now();
      while (document.querySelector('.react-flow__node.selected')?.getAttribute("data-id") !== `public.${table.key.name}`) {
        if (performance.now() - locateStarted > 60000) throw new Error("Drag target did not become selected");
        await frame();
      }
      await new Promise((resolve) => setTimeout(resolve, 500)); await ready();
      await repeatableDrag();
    } catch (error) { setOutput(String(error)); }
    finally { setBusy(false); }
  }
  async function repeatableDrag() {
    setBusy(true);
    begin("scripted-pointer-drag");
    let movedGestures = 0; let temporarilyMutedEdges = 0;
    const mountedBefore = document.querySelectorAll(".react-flow__edge > .react-flow__edge-path").length;
    try {
      for (let gesture = 0; gesture < 6; gesture += 1) {
        const header = document.querySelector<HTMLElement>('.react-flow__node.selected .table-node header');
        const node = header?.closest<HTMLElement>(".react-flow__node");
        if (!header || !node) throw new Error("Locate the drag target first");
        const before = node.style.transform;
        const rect = header.getBoundingClientRect();
        const x = rect.left + rect.width / 2; const y = rect.top + rect.height / 2;
        const sign = gesture % 2 ? -1 : 1;
        detail = `gesture-${gesture}:press`; header.dispatchEvent(new MouseEvent("mousedown", { view: window, bubbles: true, button: 0, buttons: 1, clientX: x, clientY: y }));
        for (let step = 1; step <= 15; step += 1) {
          await frame();
          temporarilyMutedEdges = Math.max(temporarilyMutedEdges, mountedBefore - document.querySelectorAll(".react-flow__edge > .react-flow__edge-path").length);
          detail = `gesture-${gesture}:move-${step}`; window.dispatchEvent(new MouseEvent("mousemove", { view: window, bubbles: true, button: 0, buttons: 1, clientX: x + sign * 60 * step / 15, clientY: y + sign * 20 * step / 15 }));
        }
        detail = `gesture-${gesture}:release`; window.dispatchEvent(new MouseEvent("mouseup", { view: window, bubbles: true, button: 0, clientX: x + sign * 60, clientY: y + sign * 20 }));
        await frame(); await frame();
        if (node.style.transform !== before) movedGestures += 1;
      }
      detail = "recover"; await ready();
      const result = finish(); if (result) { result.movedGestures = movedGestures; result.temporarilyMutedEdges = temporarilyMutedEdges; result.mutedEdgesAfter = document.querySelectorAll(".diagram-drag-muted").length; }
      report();
    } catch (error) { finish(); setOutput(String(error)); }
    finally { setBusy(false); }
  }
  async function autoLayout() {
    setBusy(true); begin("auto-layout");
    try {
      const action = button("Auto layout");
      if (!action || action.disabled) throw new Error("Layout is not ready");
      action.click();
      // Wait on the operation's explicit state rather than scanning all text
      // (closed tooltip/live-region text can retain a previous running label).
      await new Promise((resolve) => setTimeout(resolve, 0));
      const started = performance.now();
      while (document.querySelector('[aria-label="Diagram layout operation"]')?.getAttribute("data-phase") === "running") {
        if (performance.now() - started > 60000) throw new Error("Layout feedback did not settle");
        await new Promise((resolve) => setTimeout(resolve, 16));
      }
      await new Promise((resolve) => setTimeout(resolve, 32));
      finish(); report(); return true;
    } catch (error) { finish(); report(); setOutput((previous) => `${previous}\n${String(error)}`); return false; }
    finally { setBusy(false); }
  }
  return <div className="diagram-benchmark" data-hide-edges={hideEdges} data-hide-tables={hideTables} style={{ height: "100vh", display: "grid", gridTemplateRows: "auto minmax(0, 1fr) 230px" }} onClickCapture={(event) => { if (event.target instanceof HTMLButtonElement && event.target.textContent === "Export SVG") { setExportResult(undefined); peakExportDetails = 0;
      beforeExport = { transform: document.querySelector<HTMLElement>(".react-flow__viewport")?.style.transform ?? "", selected: document.querySelector(".react-flow__node.selected")?.getAttribute("data-id") ?? "" };
      begin("svg-export"); } }}>
    <style>{`.diagram-benchmark[data-hide-edges="true"] .react-flow__edges {visibility:hidden} .diagram-benchmark[data-hide-tables="true"] .table-node {visibility:hidden}`}</style>
    <header style={{ padding: 8, display: "flex", gap: 8, alignItems: "center" }}><strong>Actual Diagram benchmark</strong><label>Tables <select value={count} disabled={busy} onChange={(event) => setCount(Number(event.target.value))}><option>1000</option><option>2000</option></select></label><label><input type="checkbox" checked={connected} disabled={busy} onChange={(event) => setConnected(event.target.checked)} />Single connected graph</label><button disabled={busy} onClick={() => void load()}>Measure first load</button><button disabled={busy || !snapshot} onClick={() => void autoLayout()}>Measure auto layout</button><button disabled={busy || !snapshot} onClick={() => { if (snapshot) { const table = snapshot.schemas[0].tables[20]; setSelected(table); setLocate({ sourceId: snapshot.sourceId, snapshotId: snapshot.id, nodeId: `public.${table.key.name}`, revision: Date.now() }); } }}>Locate drag target</button><button disabled={!snapshot} onClick={() => { begin("native-pointer-drag"); setOutput("Recording native pointer drag. Drag the selected table repeatedly, then stop recording."); }}>Record drag</button><button onClick={() => { finish(); report(); }}>Stop recording</button></header>
    <Profiler id="canvas" onRender={profile} {...effectCallbacks}>{snapshot ? <SchemaCanvas snapshot={snapshot} query="" canvasSettings={settings} runtimeKind="web" platform={platform} onSelectTable={setSelected} selectedTable={selected} locateRequest={locate} onLocateComplete={() => setLocate(undefined)} /> : <div><p>Uses the real production canvas and real layout workers; fixture only, no database access.</p><label><input type="checkbox" checked={hideEdges} onChange={(event) => setHideEdges(event.target.checked)} />Hide edge paint (diagnostic)</label><label><input type="checkbox" checked={hideTables} onChange={(event) => setHideTables(event.target.checked)} />Hide table paint (diagnostic)</label><pre aria-label="Previous process trace">{previousTrace ?? "No prior trace"}</pre></div>}</Profiler>
    <div style={{ overflow: "auto", background: "#15171a", color: "#ddd" }}><pre aria-label="Benchmark results" style={{ margin: 0, padding: 10, fontSize: 12 }}>{output}</pre><button style={{ position: "absolute", bottom: 10, right: 12, zIndex: 100 }} disabled={busy || !selected} onClick={() => void repeatableDrag()}>Measure repeatable drag</button><button style={{ position: "absolute", bottom: 10, right: 230, zIndex: 100 }} disabled={busy} onClick={() => void runFullScenario()}>Run full scenario</button><pre aria-label="Latest measurement" style={{ padding: 10, whiteSpace: "pre-wrap" }}>{JSON.stringify(measurements.at(-1) ?? {})}</pre><label><input type="checkbox" checked={saveToDisk} onChange={(event) => setSaveToDisk(event.target.checked)} />Save exported artifact to disk</label><pre aria-label="Export validation">{JSON.stringify(exportResult ? Object.fromEntries(Object.entries(exportResult).filter(([key]) => key !== "stages")) : {})}</pre><div aria-label="Export stages">{Object.entries((exportResult?.stages ?? {}) as Record<string, object>).map(([measure, stats]) => <pre key={measure}>{JSON.stringify({ measure, ...stats })}</pre>)}</div><div aria-label="Export stage frames">{Object.entries(exportFrameReport ?? {}).map(([name, stats]) => <pre key={name}>{JSON.stringify({ stage: name, ...stats as object })}</pre>)}</div><div aria-label="Export batch sizes">{Object.entries(exportBatchReport ?? {}).map(([kind, stats]) => <pre key={kind}>{JSON.stringify({ batchKind: kind, ...stats as object })}</pre>)}</div>{diagnostic ? <><button disabled={busy} onClick={() => {
      const roots = [...document.querySelectorAll(".react-flow__edges > svg")];
      const proxies = roots.filter((svg) => svg.querySelector(":scope > g.react-flow__edge") && !svg.querySelector(".react-flow__edge-path"));
      const paintInventory = { svgRoots: roots.length, emptyProxyRoots: proxies.length, displayNoneProxies: proxies.filter((svg) => getComputedStyle(svg).display === "none").length, paths: document.querySelectorAll(".react-flow__edge-path").length };
      const json = JSON.stringify({ ...attribution.snapshot(), measurements, focusSamples, scenario, paintInventory });
      const html = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Canvas attribution</title><pre id="trace">${json.replaceAll("&", "&amp;").replaceAll("<", "&lt;")}</pre></html>`;
      void getPlatform().saveSchemaReport({ fileName: "Nodal-canvas-attribution.html", html }).then((receipt) => setDiagnosticReceipt(receipt.path ?? "No file saved")).catch((error: unknown) => setDiagnosticReceipt(String(error)));
    }}>Save attribution trace</button><pre aria-label="Attribution receipt">{diagnosticReceipt}</pre><pre aria-label="Stage attribution">{JSON.stringify({ enabled: true, spans: attribution.spans.length, reactCallbacks: attribution.react.length, dropped: attribution.dropped })}</pre></> : null}<div aria-label="Focus samples">{focusSamples.slice(-3).map((sample, i) => <pre key={i}>{JSON.stringify(sample)}</pre>)}</div><div aria-label="Scenario samples">{measurements.slice(-3).map((sample, i) => <pre key={i} style={{ whiteSpace: "pre-wrap" }}>{JSON.stringify(sample)}</pre>)}</div></div>
  </div>;
}
createRoot(document.getElementById("root")!).render(<Benchmark />);
