// Development-only fixture. All model changes are in memory; no database calls.
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { SchemaCanvas } from "../components/SchemaCanvas";
import { defaultAppSettings, type SaveLogicalRelationshipInput, type LogicalRelationship } from "../platform";
import { reportSnapshot, reportSemantics } from "./schema-report-fixture";
import "../styles.css";

const relation: LogicalRelationship = { ...reportSemantics.logicalRelationships[0], name: "orders_profile_identity_id_orders_tenant_id", origin: "manual", cardinality: "manyToOne", note: null, evidence: [] };
export function Preview() {
  const [theme, setTheme] = useState("light");
  const [relationships, setRelationships] = useState([relation]);
  const [fail, setFail] = useState(false);
  const [message, setMessage] = useState("Synthetic model · no database connection");
  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);
  const update = (input: SaveLogicalRelationshipInput) => {
    const value: LogicalRelationship = { ...relation, ...input, id: input.id ?? "preview-new", origin: input.origin ?? "manual", note: input.note ?? null, evidence: input.evidence ?? [], status: input.disabled ? "disabled" : "active" };
    setRelationships((current) => [...current.filter((item) => item.id !== value.id), value]);
    return Promise.resolve(value);
  };
  return <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
    <header className="ds-surface" style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "center", padding: 12, background: "var(--ds-sidebar)" }}>
      <strong>Model relationship review</strong><label>Theme <select aria-label="Preview theme" value={theme} onChange={(event) => setTheme(event.target.value)}><option>light</option><option>dark</option><option>system</option></select></label>
      <label><input type="checkbox" checked={fail} onChange={(event) => setFail(event.target.checked)} /> Simulate deletion failure</label>
      <button type="button" onClick={() => { setRelationships([relation]); setMessage("Preview model reset"); }}>Reset preview model</button><span role="status">{message}</span>
    </header>
    <div style={{ flex: 1, minHeight: 0 }}><SchemaCanvas snapshot={reportSnapshot} query="" semantics={{ ...reportSemantics, logicalRelationships: relationships }} onSelectTable={() => {}} runtimeKind="desktop" canvasSettings={defaultAppSettings().canvas}
      onValidateLogicalRelationship={() => Promise.resolve({ valid: true, compatible: true, duplicate: false, physicalExists: false, suggestedCardinality: "manyToOne", status: "active", messages: [] })}
      onCreateLogicalRelationship={update} onUpdateLogicalRelationship={update} onDeleteLogicalRelationship={(id) => {
        if (fail) return Promise.reject(new Error("Local model is temporarily locked. Try again."));
        setRelationships((current) => current.filter((item) => item.id !== id));
        setMessage("Model relationship deleted · database unchanged");
        return Promise.resolve();
      }} />
    </div>
  </div>;
}
const root = createRoot(document.getElementById("root")!);
root.render(<Preview />);
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount());
