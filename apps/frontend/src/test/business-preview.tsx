// Development-only fixture: synthetic local data, no database or network access.
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider, useI18n } from "../i18n";
import { defaultEffectiveSettings, type NodalStudioPlatform, type TableDefinition, type DataSourceProfile } from "../platform";
import type { Language } from "../platform/settings-types";
import { reportSnapshot as snapshot, reportSemantics } from "./schema-report-fixture";
import { ConnectionPanel } from "../components/ConnectionPanel";
import { SchemaTree } from "../components/SchemaTree";
import { SchemaCanvas } from "../components/SchemaCanvas";
import { TableStructure } from "../components/TableInspector";
import { QueryPage } from "../components/query/QueryPage";
import { HistoryPanel } from "../components/HistoryPanel";
import { RelationshipManager } from "../components/relationships/RelationshipManager";
import { Button } from "../design-system/Button";
import "../styles.css";
import "./business-preview.css";

const params = new URLSearchParams(location.search);
const profile: DataSourceProfile = { id: snapshot.sourceId, displayName: "Commerce demo", host: "localhost", port: 5432, database: "Commerce", username: "demo", databaseType: "postgreSql", sslMode: "verifyFull", createdAt: snapshot.capturedAt, updatedAt: snapshot.capturedAt };
const history = [0, 1].map((i) => ({ id: i ? "baseline" : snapshot.id, sourceId: snapshot.sourceId, capturedAt: `2026-10-${13-i}T08:00:00Z`, fingerprint: `demo-${i}`, databaseName: "Commerce", schemaCount: 2, tableCount: 3 }));
const platform = {
  listDataSources: () => Promise.resolve([profile]), listSnapshots: () => Promise.resolve(history), getSnapshot: () => Promise.resolve(snapshot),
  testPostgresConnection: () => Promise.resolve({ database: snapshot.database, sslActive: true, serverReadOnly: true }),
  listQueryHistory: () => Promise.resolve([]), cancelQuery: () => Promise.resolve(true),
  executeReadonlyQuery: () => Promise.resolve({ queryId: `preview-${Date.now()}`, columns: [{ name: "customer_id", databaseType: "int4" }, { name: "total", databaseType: "numeric" }], rows: [[{ kind: "number", value: 1001 }, { kind: "number", value: 128 }], [{ kind: "number", value: 1002 }, { kind: "number", value: 256 }]], rowCount: 2, durationMs: 4, truncated: false, notices: [] }),
} as unknown as NodalStudioPlatform;
const settings = defaultEffectiveSettings(snapshot.sourceId);
export function Preview() {
  const [language, setLanguage] = useState<Language>(params.get("language") === "en" ? "en" : "zhCn");
  const i18n = useI18n(language);
  const [theme, setTheme] = useState(params.get("theme") === "dark" ? "dark" : "light");
  const [page, setPage] = useState("model");
  const [selected, setSelected] = useState<TableDefinition | undefined>(snapshot.schemas[0].tables[1]);
  const [relationships, setRelationships] = useState(false);
  useEffect(() => { document.documentElement.dataset.theme = theme; document.documentElement.style.setProperty("--ui-font-size", params.get("font") === "18" ? "18px" : "13px"); }, [theme]);
  return <I18nProvider value={i18n}><div className="business-preview">
    <header className="business-preview-controls ds-surface"><strong>Nodal Studio · {language === "en" ? "Synthetic preview" : "模拟预览"}</strong>
      <select aria-label="Preview language" value={language} onChange={(e) => setLanguage(e.target.value as Language)}><option value="zhCn">简体中文</option><option value="en">English</option></select>
      <select aria-label="Preview theme" value={theme} onChange={(e) => setTheme(e.target.value)}><option value="light">Light</option><option value="dark">Dark</option></select>
      <Button onClick={() => setPage("model")}>{i18n.t("business.modelView")}</Button><Button onClick={() => setPage("query")}>{i18n.t("business.queryDetail")}</Button><Button onClick={() => setPage("history")}>{i18n.t("business.history")}</Button><Button onClick={() => setRelationships(true)}>{i18n.t("business.relationships")}</Button>
    </header>
    {page === "model" ? <div className="business-preview-model"><aside><ConnectionPanel enabled activeSourceId={snapshot.sourceId} platform={platform} onSnapshot={() => {}} defaultDatabaseType="postgreSql" defaultSslMode="verifyFull"><SchemaTree snapshot={snapshot} selectedTable={selected} onSelectTable={setSelected} onOpenQuery={() => setPage("query")} /></ConnectionPanel></aside>
      <SchemaCanvas platform={platform} snapshot={snapshot} query="" selectedTable={selected} onSelectTable={setSelected} semantics={reportSemantics} canvasSettings={settings.app.canvas} runtimeKind="web" onOpenHistory={() => setPage("history")} onOpenQuery={() => setPage("query")} />
      <aside>{selected ? <TableStructure table={selected} onOpenQuery={() => setPage("query")} /> : null}</aside></div> : page === "query" ? <QueryPage snapshot={snapshot} platform={platform} runtimeKind="desktop" /> : <div className="business-preview-history"><HistoryPanel platform={platform} sourceId={snapshot.sourceId} revision={snapshot.id} activeSnapshot={snapshot} onSelect={() => setPage("model")} onCompare={() => {}} /></div>}
    <RelationshipManager snapshot={snapshot} relationships={reportSemantics.logicalRelationships} open={relationships} onValidate={() => Promise.resolve({ valid: true, compatible: true, duplicate: false, physicalExists: false, suggestedCardinality: "oneToOne", status: "active", messages: [] })} onSave={(input) => Promise.resolve({ ...reportSemantics.logicalRelationships[0], ...input, status: "active", origin: "manual", note: input.note ?? null, evidence: input.evidence ?? [] })} onSelect={() => {}} onClose={() => setRelationships(false)} />
  </div></I18nProvider>;
}
const root = createRoot(document.getElementById("root")!); root.render(<Preview />);
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount());
