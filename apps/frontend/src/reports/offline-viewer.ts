import type { DatabaseSnapshot, SemanticBundle } from "../platform";
import { assertReportSize, createSchemaReport, schemaReportFileName } from "./schema-report";
import { offlineViewerModel } from "./offline-viewer-model";
import { offlineViewerRuntime } from "./offline-viewer-runtime";

const STYLE = `
[hidden] { display: none !important; }
.viewer { background: white; border: 1px solid #d0d5dd; border-radius: 10px; padding: 20px; margin: 24px 0; }
.viewer-controls { display: flex; align-items: end; flex-wrap: wrap; gap: 12px; }
.viewer label { display: flex; flex-direction: column; font-size: 13px; gap: 4px; }
.viewer input, .viewer select, .viewer button { font: inherit; padding: 8px; border: 1px solid #98a2b3; border-radius: 5px; background: white; color: #1d2939; }
.viewer input[type=search] { width: min(320px, 80vw); }
.viewer .kind { flex-direction: row; align-items: center; }
.viewer button { cursor: pointer; } .viewer button:disabled { opacity: .5; cursor: default; } .viewer button[aria-pressed=true] { background: #eef4ff; border-color: #175cd3; }
.viewer :focus-visible { outline: 3px solid #1570ef; outline-offset: 2px; }
.viewer-workspace { display: grid; grid-template-columns: 220px minmax(0, 1fr); gap: 12px; margin-top: 16px; }
.viewer-list { max-height: 560px; overflow: auto; } .viewer-list button { display: block; width: 100%; text-align: left; margin-bottom: 6px; overflow-wrap: anywhere; }
.viewer-stage { min-width: 0; height: 560px; background: #f5f7fa; border: 1px solid #d0d5dd; border-radius: 6px; }
.viewer-graph { width: 100%; height: 100%; touch-action: none; cursor: grab; } .viewer-node { cursor: pointer; }
.viewer-node rect { fill: white; stroke: #98a2b3; stroke-width: 1.5; } .viewer-node.selected rect { stroke: #175cd3; stroke-width: 4; }
.viewer-node .node-title { font: bold 15px sans-serif; fill: #1d2939; } .viewer-node .node-column { font: 12px monospace; fill: #344054; }
.viewer-edge { fill: none; stroke-width: 2; stroke: #175cd3; } .viewer-edge.logical { stroke: #6941c6; stroke-dasharray: 6 4; }
.viewer-selected { padding: 12px 0 0; } .viewer-selected button { text-align: left; overflow-wrap: anywhere; } .viewer-selected li { margin: 6px 0; }
@media (max-width: 700px) { .viewer { padding: 12px; } .viewer-workspace { grid-template-columns: 1fr; } .viewer-list { max-height: 150px; } .viewer-stage { height: 440px; } }
@media print { .viewer-controls, .viewer-list, .viewer-selected { display: none; } .viewer-workspace { display: block; } .viewer-stage { height: 600px; } article[hidden] { display: block !important; } }
`;
// JSON is inert data; escape script delimiters and HTML-significant characters, including line separators.
const scriptData = (value: unknown) => JSON.stringify(value).replace(/[<>&\u2028\u2029]/gu, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);

export async function createOfflineViewer(snapshot: DatabaseSnapshot, semantics: SemanticBundle) {
  const model = offlineViewerModel(snapshot, semantics);
  const report = createSchemaReport(snapshot, semantics);
  const script = `(${offlineViewerRuntime.toString()})();`;
  if (!crypto.subtle) throw new Error("Offline Viewer export requires Web Crypto SHA-256 in a secure/local compatible runtime.");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(script));
  const hash = btoa(String.fromCharCode(...new Uint8Array(digest)));
  const controls = `<section class="viewer" aria-labelledby="viewer-title"><h2 id="viewer-title">Interactive offline Viewer</h2>
    <p>Read only · One entire loaded snapshot, independent of the app’s Diagram filters. No comparison history or deleted-object reconstruction. Web exports include only the shared contents. Saved semantics are current, not historical.</p>
    <p>Physical FK: solid blue · Active saved logical: dashed purple · Arrows show source → target. No inferred candidates or database writes.</p>
    <details><summary>Export scope, read-only boundaries and limits</summary>
      <p>No connection, queries, editing, AI, cloud calls, tracking or saved browser state. Reopen to reset. This portable file contains readable metadata; it has no share-token expiry, revocation or encryption.</p>
      <p>Diagram: deterministic overview layout, table-level physical FKs (solid blue) and active saved logical links (dashed purple), no inferred candidates. Up to 12 columns per card; complete details below. Long labels are abbreviated. ${model.unavailableRelations} relationships with unavailable endpoints/columns are omitted from the graph and remain described in the dictionary. Inactive saved links are listed in the dictionary only.</p>
      <p>Export limits: 500 tables / 5,000 columns / 5,000 physical or active logical relationships / 32 MiB. Larger models are rejected without truncation; use the static HTML report. A modern browser with JavaScript/SVG is required for interaction. App layout, theme, comparisons and DDL import sessions are not included.</p>
    </details>
    <p id="viewer-fallback">Interactive controls require JavaScript and a compatible browser. The complete static dictionary below remains readable if scripts are disabled or blocked.</p>
    <div id="viewer-controls" class="viewer-controls" hidden>
      <label>Search metadata<input id="viewer-search" type="search" placeholder="Table, field, comment or semantics" maxlength="256"></label>
      <label>Schema<select id="viewer-schema"><option value="">All schemas</option></select></label>
      <label>Business domain<select id="viewer-domain"><option value="">All domains</option></select></label>
      <label class="kind"><input id="viewer-physical" type="checkbox" checked>Physical FK</label><label class="kind"><input id="viewer-logical" type="checkbox" checked>Saved logical</label>
      <button id="viewer-reset" type="button">Show all / reset filters</button><button id="viewer-neighbors" type="button" disabled>One-hop relations</button>
      <button id="viewer-fit" type="button">Fit diagram</button><button id="viewer-zoom-in" type="button">Zoom in</button><button id="viewer-zoom-out" type="button">Zoom out</button>
    </div><p id="viewer-status" role="status" aria-live="polite"></p>
    <div id="viewer-workspace" class="viewer-workspace" hidden><div id="viewer-list" class="viewer-list" role="group" aria-label="Matching tables"></div><div id="viewer-stage" class="viewer-stage"><svg id="viewer-graph" class="viewer-graph" xmlns="http://www.w3.org/2000/svg" tabindex="0" role="group" aria-label="Read-only schema diagram"></svg></div></div>
    <p>Search filters table/object details; schema/domain and one-hop filters narrow the table diagram. One-hop respects current filters. Click a card or table-list entry for details and relationship navigation. Drag empty graph space to pan; keyboard arrows pan, +/− zoom when the graph is focused. Views, enums and inactive relationships have dictionary details, not diagram nodes. Use internal links to reveal hidden destinations.</p>
    <div id="viewer-selected" class="viewer-selected" aria-live="polite"></div></section>`;
  const html = report.html
    .replace("— Schema report</title>", "— Offline Viewer</title>")
    .replace("Nodal Studio · Data dictionary", "Nodal Studio · Offline Viewer")
    .replace("default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'", `default-src 'none'; script-src 'sha256-${hash}'; style-src 'unsafe-inline'; connect-src 'none'; img-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`)
    .replace("</style>", `${STYLE}</style>`)
    .replace('<nav id="contents"', `${controls}<nav id="contents"`)
    .replace("</body>", `<script id="offline-model" type="application/json">${scriptData(model)}</script><script>${script}</script></body>`);
  assertReportSize(html);
  return { html, tableCount: report.tableCount, columnCount: report.columnCount, relationshipCount: model.relations.length };
}
export function offlineViewerFileName(snapshot: DatabaseSnapshot) {
  const name = schemaReportFileName(snapshot); const at = name.lastIndexOf("-schema-report-");
  return `${name.slice(0, at)}-offline-viewer-${name.slice(at + "-schema-report-".length)}`;
}
