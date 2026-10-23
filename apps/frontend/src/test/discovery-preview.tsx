// Development-only synthetic preview; not a production build entry or a live model integration.
import { createRoot } from "react-dom/client";
import { useMemo, useState } from "react";
import { BusinessExplorer } from "../components/BusinessExplorer";
import { InspectorPanel } from "../components/InspectorPanel";
import type { DiscoveryInput, DiscoveryPreview, NodalStudioPlatform, TableDefinition } from "../platform";
import { discoveryPreview, discoveryResult, discoverySettings } from "./discovery-fixture";
import { reportSemantics, reportSnapshot } from "./schema-report-fixture";
import { tableAiPreview, tableAiResult } from "./table-ai-fixture";
import "../styles.css";
const noop = () => {};
export function Preview() {
  const [open, setOpen] = useState(true); const [scope, setScope] = useState<"currentTable" | "oneHop" | "domain">("oneHop");
  const [selected, setSelected] = useState<TableDefinition>(); const [explain, setExplain] = useState(0); const [message, setMessage] = useState("");
  const settings = useMemo(() => { const value = discoverySettings(); value.source!.ai.contextScope = scope; return value; }, [scope]);
  const platform = useMemo(() => {
    const previews = new Map<string, DiscoveryPreview>();
    return {
      listSnapshots: () => Promise.resolve([{ id: reportSnapshot.id }]),
      prepareDiscovery: (input: DiscoveryInput) => { const preview = discoveryPreview(input, settings); previews.set(preview.requestId, preview); return Promise.resolve(preview); },
      runDiscovery: (id: string) => { const preview = previews.get(id); if (!preview) return Promise.reject(new Error("Preview cancelled.")); return new Promise((resolve) => window.setTimeout(() => resolve(discoveryResult(preview)), 650)); },
      cancelDiscovery: (id: string) => { previews.delete(id); return Promise.resolve(); },
      prepareTableExplanation: () => Promise.resolve({ ...tableAiPreview, context: { ...tableAiPreview.context, scope, target: selected!.key, tables: [selected!.key], evidence: [{ id: "e1", tableKey: selected!.key, objectKey: selected!.key, kind: "table", label: `${selected!.key.schema}.${selected!.key.name}`, detail: JSON.stringify({ columnCount: selected!.columns.length }), columns: [] }] }, expiresAt: new Date(Date.now() + 300_000).toISOString(), requestBody: { model: "fixture-model", messages: [{ role: "user", content: "Synthetic table explanation fixture" }] } }),
      runTableExplanation: () => Promise.resolve({ ...tableAiResult, target: selected!.key, answer: { schemaVersion: 2, summary: null, interpretations: [], unknowns: ["This is a synthetic preview. Confirm the business grain of the selected table with the team."] } }), cancelTableExplanation: () => Promise.resolve(),
    } as unknown as NodalStudioPlatform;
  }, [scope, settings, selected]);
  return <main style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
    <div style={{ padding: "12px 22px", background: "#192b38", color: "#e8f3fa", display: "flex", alignItems: "center", flexWrap: "wrap", gap: 14 }}>
      <strong>阶段二 · 合成交互预览</strong><span>真实界面组件；固定样例回答，不读取数据库、不调用真实模型。</span>
      <label>预览 AI 范围 <select value={scope} onChange={(event) => setScope(event.target.value as typeof scope)}><option value="currentTable">CurrentTable</option><option value="oneHop">OneHop</option><option value="domain">Domain</option></select></label>
      <button type="button" onClick={() => setOpen(true)}>打开业务找表</button>
    </div>
    <div style={{ position: "relative", flex: 1, minHeight: 0 }}>
      {open ? <BusinessExplorer snapshot={reportSnapshot} semantics={reportSemantics} settings={settings} platform={platform} desktop sourceLabel="Commerce · synthetic source" initialTable={selected} onClose={() => { setOpen(false); setMessage("已返回原视图。正式应用会保留进入前的布局、过滤和选择。"); }} onLocate={(table) => { setSelected(table); setOpen(false); setMessage(`已定位 ${table.key.schema}.${table.key.name}`); }} onExplain={(table) => { setSelected(table); setExplain((n) => n + 1); setOpen(false); setMessage("已接入阶段一的单表解释。"); }} onOpenSettings={() => setMessage("请使用顶部预览范围选择器；正式应用在 Settings → AI 配置。")} /> : <div style={{ padding: 32, display: "flex", gap: 30 }}><section style={{ maxWidth: 420 }}><h2>继续理解当前对象</h2><p>{message}</p><button type="button" onClick={() => setOpen(true)}>返回业务找表</button></section>{selected ? <aside style={{ width: 360, height: "75vh", overflow: "auto" }}><InspectorPanel explainRequest={explain} snapshot={reportSnapshot} selectedTable={selected} semantics={reportSemantics} settings={settings} runtime={{ kind: "desktop", label: "Synthetic preview", version: "test" }} platform={platform} historyRevision={reportSnapshot.id} onSaveAnnotation={async () => {}} onRefreshSemantics={async () => {}} onSemanticsChange={noop} onApplyView={noop} onOpenSettings={noop} onSelectSnapshot={noop} onCompareSnapshots={noop} /></aside> : null}</div>}
    </div>
    {message && open ? <div role="status" style={{ padding: 8 }}>{message}</div> : null}
  </main>;
}
const previewRoot = createRoot(document.getElementById("root")!);
previewRoot.render(<Preview />);
if (import.meta.hot) import.meta.hot.dispose(() => previewRoot.unmount());
