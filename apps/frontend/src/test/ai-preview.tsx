// Development-only visual fixture; ai-preview.html is not a production build entry.
import { createRoot } from "react-dom/client";
import { useState } from "react";
import { InspectorPanel } from "../components/InspectorPanel";
import type { NodalStudioPlatform, RuntimeInfo, TableAiContext } from "../platform";
import { aiTable, tableAiPreview, tableAiResult, tableAiSettings } from "./table-ai-fixture";
import { reportSemantics, reportSnapshot } from "./schema-report-fixture";
import "../styles.css";
import "../components/inspector.css";

const archived = reportSnapshot.schemas[1].tables[0];
const logical = reportSemantics.logicalRelationships[0];
const previewSettings = tableAiSettings();
previewSettings.source!.ai.contextScope = "oneHop";
const previewContext: TableAiContext = {
  ...tableAiPreview.context,
  scope: "oneHop",
  tables: [aiTable.key, reportSnapshot.schemas[0].tables[0].key, archived.key],
  evidence: [...tableAiPreview.context.evidence, {
    id: "e3", tableKey: archived.key, objectKey: archived.key, kind: "logicalRelationship",
    label: "archive.orders · orders",
    detail: JSON.stringify({ source: logical.source, target: logical.target, kind: "model-only logical relationship; not a database constraint" }),
    columns: logical.source.columns,
  }],
  coverage: [...tableAiPreview.context.coverage, "Synthetic UI fixture: only selected evidence items are shown."],
};
const platform = {
  prepareTableExplanation: () => Promise.resolve({
    ...tableAiPreview, context: previewContext, expiresAt: new Date(Date.now() + 300_000).toISOString(),
    requestBody: { model: "fixture-model", messages: [{ role: "user", content: JSON.stringify(previewContext) }] },
  }),
  runTableExplanation: () => Promise.resolve(tableAiResult),
  cancelTableExplanation: () => Promise.resolve(),
  listSnapshots: () => Promise.resolve([]),
} as unknown as NodalStudioPlatform;
const noop = () => {};
export function Preview() {
  const [message, setMessage] = useState("");
  const [historical, setHistorical] = useState(false);
  return <main style={{ height: "100vh", overflow: "auto", display: "flex", gap: 40, padding: 40, justifyContent: "center", alignItems: "flex-start", flexWrap: "wrap" }}>
    <section style={{ width: 340, lineHeight: 1.8 }}><p>NODAL STUDIO / 阶段一</p><h1>从解释回到证据</h1>
      <p>这是使用真实界面组件的合成数据预览。回答是固定测试样例，不调用模型、不读取本机数据库。</p>
      <ol><li>选择右侧 AI。</li><li>点击 Prepare request preview 查看发送内容。</li><li>点击 Send this request 查看样例解释。</li><li>点击 e1 定位字段、e2 定位索引，或在 Structural evidence 中点击 e3 定位逻辑关系的源字段。</li></ol>
      <label><input type="checkbox" checked={historical} onChange={(event) => setHistorical(event.target.checked)} />显示历史表（切换后再返回，旧定位应清除）</label>
      <p>正式功能在桌面应用中：设置 AI 提供方后，选中当前快照中的表 → AI。</p><p role="status">{message}</p>
    </section>
    <aside className="inspector-panel" style={{ width: 360, minWidth: 0, height: "calc(100vh - 80px)", overflow: "auto", padding: 20, border: "1px solid #546172", borderRadius: 12 }}>
      <InspectorPanel snapshot={reportSnapshot} selectedTable={aiTable} historicalSelection={historical} semantics={reportSemantics} settings={previewSettings} platform={platform} runtime={{ kind: "desktop" } as RuntimeInfo}
        historyRevision="fixture" onSaveAnnotation={() => Promise.resolve()} onRefreshSemantics={async () => {}} onSemanticsChange={noop} onApplyView={noop} onOpenSettings={() => setMessage("预览使用固定测试设置。请在正式桌面应用的 Settings → AI 修改提供方和范围。")}
        onSelectSnapshot={noop} onCompareSnapshots={noop}/>
    </aside>
  </main>;
}
createRoot(document.getElementById("root")!).render(<Preview />);
