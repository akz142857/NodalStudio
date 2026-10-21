// Development-only fixture. No database, model service or persistent writes.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { InspectorPanel } from "../components/InspectorPanel";
import type { NodalStudioPlatform, SchemaChangeSet } from "../platform";
import { reportSemantics, reportSnapshot } from "./schema-report-fixture";
import { tableAiPreview, tableAiResult, tableAiSettings } from "./table-ai-fixture";
import "../styles.css";
import "../components/inspector.css";

const snapshot = structuredClone(reportSnapshot);
const table = snapshot.schemas[0].tables[1];
table.comment = "订单记录与客户关联，用于追踪购买意图、订单金额和业务状态。";
table.columns[1].comment = "客户的稳定标识；与客户表关联，不包含客户个人信息。";
table.columns[2].comment = "订单金额，不含配送费用。业务口径由团队确认。";
const summaries = [snapshot, { ...snapshot, id: "previous", capturedAt: "2026-10-12T08:00:00Z" }].map((item) => ({
  id: item.id, sourceId: item.sourceId, capturedAt: item.capturedAt,
  fingerprint: item.fingerprint, tableCount: 3, databaseName: item.database.name,
}));
const changeSet = { id: "preview-change", operations: [{ operationType: "addTable" }], riskSummary: { high: 0, medium: 0, low: 1, informational: 0 } } as SchemaChangeSet;
const platform = {
  listSnapshots: () => Promise.resolve(summaries),
  getSnapshot: () => Promise.resolve(snapshot),
  compareSnapshots: () => Promise.resolve(changeSet),
  saveChangeProvenance: async () => {},
  prepareTableExplanation: () => Promise.resolve({ ...tableAiPreview, expiresAt: new Date(Date.now() + 300_000).toISOString() }),
  runTableExplanation: () => Promise.resolve(tableAiResult),
  cancelTableExplanation: async () => {},
  prepareKnowledgeDraft: () => Promise.resolve({
    id: "preview-draft", sourceId: snapshot.sourceId, snapshotId: snapshot.id,
    target: table.key, oldDescription: "订单：记录已确认的购买意图", draftText: "订单：记录已确认的购买意图",
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
    origin: { kind: "manualReview", evidence: { note: "Synthetic preview" } },
  }),
  cancelKnowledgeDraft: async () => {},
  confirmKnowledgeDraft: async () => {},
} as unknown as NodalStudioPlatform;

export function Preview() {
  const [width, setWidth] = useState(320);
  const [theme, setTheme] = useState("dark");
  const [fontSize, setFontSize] = useState(13);
  const [aiMode, setAiMode] = useState("off");
  const [notice, setNotice] = useState("");
  const settings = tableAiSettings();
  settings.source!.ai.enabled = aiMode === "on";
  settings.app.advanced.extensions.migrationProvenance = true;
  if (aiMode === "missing") settings.source = null;
  const noop = () => {};
  return <main style={{ height: "100vh", display: "flex", justifyContent: "center", alignItems: "flex-start", gap: 40, padding: 24, overflow: "auto", background: theme === "light" ? "#e7e7ec" : "#111318", color: theme === "light" ? "#242429" : "#eee" }}>
    <section style={{ width: 260, display: "grid", gap: 16 }}>
      <h1 style={{ fontSize: 20, margin: 0 }}>Inspector visual review</h1>
      <p style={{ margin: 0 }}>Synthetic data · no external requests</p>
      <label>Panel width <select aria-label="Panel width" value={width} onChange={(event) => setWidth(Number(event.target.value))}>{[240, 300, 320, 400, 520].map((value) => <option key={value}>{value}</option>)}</select></label>
      <label>Theme <select aria-label="Theme" value={theme} onChange={(event) => { setTheme(event.target.value); document.documentElement.dataset.theme = event.target.value; }}><option>dark</option><option>light</option><option>system</option></select></label>
      <label>Text size <select aria-label="Text size" value={fontSize} onChange={(event) => { setFontSize(Number(event.target.value)); document.documentElement.style.setProperty("--ui-font-size", `${event.target.value}px`); }}>{[13, 16].map((value) => <option key={value}>{value}</option>)}</select></label>
      <label>AI state <select aria-label="AI state" value={aiMode} onChange={(event) => setAiMode(event.target.value)}><option value="off">Off</option><option value="missing">Settings not loaded</option><option value="on">Enabled</option></select></label>
      <p role="status">{notice}</p>
    </section>
    <aside className="inspector" style={{ flex: `0 0 ${width}px`, width, height: "calc(100vh - 48px)", border: "1px solid #7775", borderRadius: 10 }}>
      <InspectorPanel snapshot={snapshot} selectedTable={table} semantics={reportSemantics} settings={settings} changeSet={changeSet} platform={platform} runtime={{ kind: "desktop", label: "Preview", version: "fixture" }}
        historyRevision="fixture" onSaveAnnotation={() => { setNotice("Saved in preview"); return Promise.resolve(); }} onRefreshSemantics={async () => {}} onSemanticsChange={noop} onApplyView={noop}
        onOpenQuery={() => setNotice("Preview rows action works")} onOpenSettings={() => setNotice("Settings action works")}
        onSelectSnapshot={noop} onCompareSnapshots={noop} onReviewChanges={() => setNotice("Review changes action works")} />
    </aside>
  </main>;
}
const root = createRoot(document.getElementById("root")!);
root.render(<Preview />);
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount());
