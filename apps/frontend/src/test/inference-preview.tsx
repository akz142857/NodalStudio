// Development-only fixture; all review actions stay in memory.
import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { createRelationshipBatchFixture } from "./relationship-batch-fixture";
import { RelationshipManager } from "../components/relationships/RelationshipManager";
import type { ValidateRelationship } from "../components/relationships/RelationshipEditor";
import { inferenceReviewSnapshot as snapshot } from "./inference-review-fixture";
import "../styles.css";

const request = { revision: 1 };
export function InferencePreview() {
  const [open, setOpen] = useState(true);
  const [theme, setTheme] = useState("dark");
  const [fail, setFail] = useState(false);
  const [, update] = useState(0);
  const [fixture] = useState(() => createRelationshipBatchFixture(snapshot, () => update((value) => value + 1)));
  const { relationships, ignored } = fixture;
  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);
  const validate: ValidateRelationship = useCallback((input) => {
    const types = [input.source, input.target].map((endpoint) => snapshot.schemas.flatMap((schema) => schema.tables).find((table) => table.key.schema === endpoint.schema && table.key.name === endpoint.table)?.columns.find((column) => column.name === endpoint.columns[0])?.typeName);
    const compatible = types[0] === types[1];
    const duplicate = relationships.some((row) => row.source.table === input.source.table && row.source.columns[0] === input.source.columns[0] && row.target.table === input.target.table && row.target.columns[0] === input.target.columns[0]);
    return Promise.resolve({ valid: compatible && !duplicate, compatible, duplicate, physicalExists: false, status: compatible ? "active" : "conflicted", suggestedCardinality: "manyToOne", messages: compatible ? [] : ["Source and target column types differ."] });
  }, [relationships]);
  return <div className="ds-surface" style={{ padding: 24 }}><h1>Candidate review · synthetic model</h1><p>All changes remain in this preview. No database connection.</p><label>Theme <select value={theme} onChange={(event) => setTheme(event.target.value)}><option>dark</option><option>light</option></select></label><label><input type="checkbox" checked={fail} onChange={(event) => { setFail(event.target.checked); fixture.setFailure(event.target.checked); }} /> Simulate write failure</label><button onClick={() => setOpen(true)}>Open review</button>
    <RelationshipManager open={open} snapshot={snapshot} relationships={relationships} ignoredInferences={ignored} reviewRequest={request} onClose={() => setOpen(false)} onSelect={() => setOpen(false)} onValidate={validate} onSave={(input) => fixture.save(input)} batchApi={fixture.api}
      onIgnore={(key) => fixture.ignore(key)} onRestore={(key) => fixture.restore(key)} />
  </div>;
}
const root = createRoot(document.getElementById("root")!);
root.render(<InferencePreview />);
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount());
