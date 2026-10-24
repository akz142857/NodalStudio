// Development-only fixture; all review actions stay in memory.
import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { IgnoredRelationshipInference, LogicalRelationship, SaveLogicalRelationshipInput } from "../platform";
import { RelationshipManager } from "../components/relationships/RelationshipManager";
import type { ValidateRelationship } from "../components/relationships/RelationshipEditor";
import { inferenceReviewSnapshot as snapshot } from "./inference-review-fixture";
import "../styles.css";

const request = { revision: 1 };
export function InferencePreview() {
  const [open, setOpen] = useState(true);
  const [theme, setTheme] = useState("dark");
  const [fail, setFail] = useState(false);
  const [relationships, setRelationships] = useState<LogicalRelationship[]>([]);
  const [ignored, setIgnored] = useState<IgnoredRelationshipInference[]>([]);
  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);
  const validate: ValidateRelationship = useCallback((input) => {
    const types = [input.source, input.target].map((endpoint) => snapshot.schemas.flatMap((schema) => schema.tables).find((table) => table.key.schema === endpoint.schema && table.key.name === endpoint.table)?.columns.find((column) => column.name === endpoint.columns[0])?.typeName);
    const compatible = types[0] === types[1];
    const duplicate = relationships.some((row) => row.source.table === input.source.table && row.source.columns[0] === input.source.columns[0] && row.target.table === input.target.table && row.target.columns[0] === input.target.columns[0]);
    return Promise.resolve({ valid: compatible && !duplicate, compatible, duplicate, physicalExists: false, status: compatible ? "active" : "conflicted", suggestedCardinality: "manyToOne", messages: compatible ? [] : ["Source and target column types differ."] });
  }, [relationships]);
  function save(input: SaveLogicalRelationshipInput): Promise<LogicalRelationship> {
    if (fail) return Promise.reject(new Error("Simulated model write failure. Your review has been preserved."));
    const row: LogicalRelationship = { ...input, id: input.id ?? crypto.randomUUID(), origin: input.origin ?? "manual", evidence: input.evidence ?? [], note: input.note ?? null, status: input.allowTypeMismatch ? "conflicted" : "active", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    setRelationships((current) => [...current.filter((item) => item.id !== row.id), row]);
    return Promise.resolve(row);
  }
  return <div className="ds-surface" style={{ padding: 24 }}><h1>Candidate review · synthetic model</h1><p>All changes remain in this preview. No database connection.</p><label>Theme <select value={theme} onChange={(event) => setTheme(event.target.value)}><option>dark</option><option>light</option></select></label><label><input type="checkbox" checked={fail} onChange={(event) => setFail(event.target.checked)} /> Simulate write failure</label><button onClick={() => setOpen(true)}>Open review</button>
    <RelationshipManager open={open} snapshot={snapshot} relationships={relationships} ignoredInferences={ignored} reviewRequest={request} onClose={() => setOpen(false)} onSelect={() => setOpen(false)} onValidate={validate} onSave={save}
      onIgnore={(relationshipKey) => { if (fail) return Promise.reject(new Error("Simulated ignore failure")); setIgnored((current) => [...current, { sourceId: snapshot.sourceId, relationshipKey, ignoredAt: new Date().toISOString() }]); return Promise.resolve(); }}
      onRestore={(key) => { if (fail) return Promise.reject(new Error("Simulated restore failure")); setIgnored((current) => current.filter((entry) => entry.relationshipKey !== key)); return Promise.resolve(); }} />
  </div>;
}
const root = createRoot(document.getElementById("root")!);
root.render(<InferencePreview />);
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount());
