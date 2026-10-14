import { OperationFeedback } from "./OperationFeedback";
import { useMemo, useState } from "react";
import type { DatabaseSnapshot, NodalStudioPlatform, RuntimeInfo, SchemaChangeSet, SchemaOperation } from "../platform";
import type { RiskLevel } from "../platform/types";
import { changeLabel, operationProperties, PROPERTY_LABELS, propertyValue, snapshotDate } from "./schema-change-details";
import { useComparisonSnapshot, type SnapshotState } from "./use-comparison-snapshot";

interface SchemaChangesPanelProps {
  changeSet: SchemaChangeSet;
  currentSnapshot: DatabaseSnapshot;
  platform: NodalStudioPlatform;
  runtimeKind?: RuntimeInfo["kind"];
}

const PAGE_SIZE = 50;
const RISKS: RiskLevel[] = ["high", "medium", "low", "informational"];

function SnapshotContext({ label, id, state, runtimeKind }: {
  label: string; id: string; state: SnapshotState; runtimeKind?: RuntimeInfo["kind"];
}) {
  return (
    <div className="diff-snapshot-context">
      <strong>{label}</strong>
      <code title={id}>{id}</code>
      {state.snapshot ? (
        <>
          <span>{state.snapshot.database.name} · {snapshotDate(state.snapshot.capturedAt)}</span>
          <small title={state.snapshot.fingerprint}>Fingerprint: {state.snapshot.fingerprint.slice(0, 12)}</small>
        </>
      ) : <OperationFeedback label={`${label} snapshot load`} state={state.loading ? { phase: "running", summary: "Loading snapshot…" } : { phase: runtimeKind === "web" ? "info" : "error", summary: runtimeKind === "web" ? "Snapshot not included in this share." : "Snapshot details unavailable.", details: state.error }} onRetry={runtimeKind === "desktop" ? state.retry : undefined} retryLabel={`Retry ${label.toLowerCase()} snapshot`} />}
    </div>
  );
}

function detailStatus(state: SnapshotState, operation: SchemaOperation, side: "before" | "after"): string {
  if (state.loading) return "Loading…";
  if (!state.snapshot) return "Snapshot unavailable";
  return operation[side] === null ? "Not present" : "Object details unavailable";
}

function OperationDetail({ operation, before, after }: { operation: SchemaOperation; before: SnapshotState; after: SnapshotState }) {
  const [showUnchanged, setShowUnchanged] = useState(false);
  const beforeProperties = before.snapshot ? operationProperties(before.snapshot, operation, "before") : undefined;
  const afterProperties = after.snapshot ? operationProperties(after.snapshot, operation, "after") : undefined;
  const keys = [...new Set([...Object.keys(beforeProperties ?? {}), ...Object.keys(afterProperties ?? {})])];
  const bothKnown = Boolean(beforeProperties || (before.snapshot && operation.before === null)) &&
    Boolean(afterProperties || (after.snapshot && operation.after === null));
  const rows = keys.map((key) => ({
    key,
    changed: bothKnown && JSON.stringify(beforeProperties?.[key]) !== JSON.stringify(afterProperties?.[key]),
  }));
  const visibleRows = rows.filter((row) => showUnchanged || row.changed || !bothKnown);
  const replacement = Boolean(beforeProperties && afterProperties && /^(add|drop)/.test(operation.operationType));

  return (
    <article className="diff-detail" aria-label="Change details">
      <header>
        <div className="diff-detail-heading">
          <h3>{changeLabel(operation.operationType)}</h3>
          <span className="diff-risk" data-risk={operation.risk}>{operation.risk} risk</span>
        </div>
        <p className="diff-object-name">{operation.object.schema}.{operation.object.name}</p>
        <small>{changeLabel(operation.object.kind)}</small>
      </header>
      {operation.operationType === "renameColumn" ? (
        <p className="diff-explanation">Inferred rename: matching column definitions suggest a rename; the original DDL was not recorded.</p>
      ) : null}
      {replacement ? <p className="diff-explanation">This object exists in both snapshots. Its replacement is recorded as separate drop and add operations.</p> : null}
      <div className="diff-summaries">
        <div><strong>Before summary</strong><pre>{operation.before ?? "No summary (addition)"}</pre></div>
        <div><strong>After summary</strong><pre>{operation.after ?? "No summary (removal)"}</pre></div>
      </div>
      <div className="diff-property-controls">
        <h4>Snapshot properties</h4>
        <label><input type="checkbox" checked={showUnchanged} onChange={(event) => setShowUnchanged(event.target.checked)} />Show unchanged properties</label>
      </div>
      <p className="diff-explanation">Values describe the selected Before → After snapshots.</p>
      {!beforeProperties || !afterProperties ? (
        <p className="diff-explanation" role="status">
          {!beforeProperties ? `Before: ${detailStatus(before, operation, "before")}. ` : ""}
          {!afterProperties ? `After: ${detailStatus(after, operation, "after")}.` : ""}
        </p>
      ) : null}
      {visibleRows.length ? (
        <table className="diff-properties" aria-label="Before and after properties">
          <thead><tr><th scope="col">Property</th><th scope="col">Before</th><th scope="col">After</th></tr></thead>
          <tbody>{visibleRows.map(({ key, changed }) => (
            <tr key={key} data-changed={changed}>
              <th scope="row">{PROPERTY_LABELS[key] ?? changeLabel(key)}{changed ? <> <small>Changed</small></> : null}</th>
              <td><pre>{beforeProperties ? propertyValue(beforeProperties[key]) : detailStatus(before, operation, "before")}</pre></td>
              <td><pre>{afterProperties ? propertyValue(afterProperties[key]) : detailStatus(after, operation, "after")}</pre></td>
            </tr>
          ))}</tbody>
        </table>
      ) : (
        <p className="diff-empty">{keys.length ? "No changed properties. Show unchanged properties to inspect the full definition." : "Property details are unavailable; the operation summaries remain available above."}</p>
      )}
    </article>
  );
}

export function SchemaChangesPanel({ changeSet, currentSnapshot, platform, runtimeKind }: SchemaChangesPanelProps) {
  const before = useComparisonSnapshot(changeSet.beforeSnapshotId, currentSnapshot, platform, runtimeKind);
  const after = useComparisonSnapshot(changeSet.afterSnapshotId, currentSnapshot, platform, runtimeKind);
  const [search, setSearch] = useState("");
  const [risk, setRisk] = useState<RiskLevel | "all">("all");
  const [type, setType] = useState("all");
  const [page, setPage] = useState(0);
  const [selectedIndex, setSelectedIndex] = useState<number>();
  const operations = changeSet.operations;
  const types = [...new Set(operations.map((operation) => operation.operationType))].sort();
  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return operations.map((operation, index) => ({ operation, index })).filter(({ operation }) =>
      (risk === "all" || operation.risk === risk) && (type === "all" || operation.operationType === type) &&
      (!term || [operation.object.schema, operation.object.name, operation.object.kind,
        operation.operationType, changeLabel(operation.operationType), operation.before, operation.after].join(" ").toLowerCase().includes(term)));
  }, [operations, risk, search, type]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const activePage = Math.min(page, pageCount - 1);
  const visible = filtered.slice(activePage * PAGE_SIZE, (activePage + 1) * PAGE_SIZE);
  const selected = visible.find(({ index }) => index === selectedIndex) ?? visible[0];
  function resetPage() { setPage(0); setSelectedIndex(undefined); }
  function goToPage(nextPage: number) { setPage(nextPage); setSelectedIndex(undefined); }

  return (
    <section className="schema-changes-panel" aria-label="Schema comparison">
      <header className="diff-header">
        <h2>{operations.length} structural changes</h2>
        <p>Changes are read from <strong>Before → After</strong>. Added and removed objects follow this direction, regardless of capture date.</p>
        <div className="diff-direction" aria-label="Comparison direction">
          <SnapshotContext label="Before" id={changeSet.beforeSnapshotId} state={before} runtimeKind={runtimeKind} />
          <span className="diff-direction-arrow" aria-hidden="true">→</span>
          <SnapshotContext label="After" id={changeSet.afterSnapshotId} state={after} runtimeKind={runtimeKind} />
        </div>
        {runtimeKind === "web" && (!before.snapshot || !after.snapshot) ? (
          <p className="diff-explanation">This share includes one snapshot. Historical properties are unavailable; all change summaries and available snapshot properties are shown.</p>
        ) : null}
        <div className="diff-risk-summary">{RISKS.map((level) => <span key={level} className="diff-risk" data-risk={level}>{changeSet.riskSummary[level]} {level}</span>)}</div>
      </header>
      <div className="diff-filters">
        <label>Search changes<input type="search" placeholder="Object, schema or summary" value={search} onChange={(event) => { setSearch(event.target.value); resetPage(); }} /></label>
        <label>Risk<select value={risk} onChange={(event) => { setRisk(event.target.value as RiskLevel | "all"); resetPage(); }}><option value="all">All risks</option>{RISKS.map((level) => <option key={level} value={level}>{changeLabel(level)}</option>)}</select></label>
        <label>Operation<select value={type} onChange={(event) => { setType(event.target.value); resetPage(); }}><option value="all">All operations</option>{types.map((value) => <option key={value} value={value}>{changeLabel(value)}</option>)}</select></label>
        {search || risk !== "all" || type !== "all" ? <button type="button" onClick={() => { setSearch(""); setRisk("all"); setType("all"); resetPage(); }}>Clear filters</button> : null}
      </div>
      <div className="diff-content">
        <div className="diff-list-pane">
          <p className="diff-count" role="status">{filtered.length ? `Showing ${activePage * PAGE_SIZE + 1}–${activePage * PAGE_SIZE + visible.length} of ${filtered.length} changes` : "0 changes"}{filtered.length !== operations.length ? ` (${operations.length} total)` : ""}</p>
          <ol key={`${activePage}:${risk}:${type}:${search}`} className="diff-operation-list" aria-label="All schema changes" start={activePage * PAGE_SIZE + 1}>
            {visible.map(({ operation, index }) => (
              <li key={index}><button type="button" aria-pressed={selected?.index === index} onClick={() => setSelectedIndex(index)}>
                <span className="diff-operation-heading"><strong>{changeLabel(operation.operationType)}</strong><span className="diff-risk" data-risk={operation.risk}>{operation.risk}</span></span>
                <span className="diff-object-name">{operation.object.schema}.{operation.object.name}</span>
              </button></li>
            ))}
          </ol>
          {!filtered.length ? <p className="diff-empty">{operations.length ? "No changes match these filters." : "No structural changes between these snapshots."}</p> : null}
          {pageCount > 1 ? <nav className="diff-pagination" aria-label="Change pages">
            <button type="button" disabled={activePage === 0} onClick={() => goToPage(activePage - 1)}>Previous</button>
            <span>Page {activePage + 1} of {pageCount}</span>
            <button type="button" disabled={activePage + 1 === pageCount} onClick={() => goToPage(activePage + 1)}>Next</button>
          </nav> : null}
        </div>
        {selected ? <OperationDetail key={selected.index} operation={selected.operation} before={before} after={after} /> : null}
      </div>
    </section>
  );
}
