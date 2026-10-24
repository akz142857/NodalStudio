import { translateUiLabel } from "../i18n/business-labels";
import { useI18n, type Translate } from "../i18n";
import { OperationFeedback } from "./OperationFeedback";
import { useMemo, useState } from "react";
import type { DatabaseSnapshot, NodalStudioPlatform, RuntimeInfo, SchemaChangeSet, SchemaOperation } from "../platform";
import type { RiskLevel } from "../platform/types";
import { changeLabel, operationProperties, PROPERTY_LABELS, propertyValue } from "./schema-change-details";
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
  const { t: bt, formatDate } = useI18n();
  return (
    <div className="diff-snapshot-context">
      <strong>{label}</strong>
      <code title={id}>{id}</code>
      {state.snapshot ? (
        <>
          <span>{state.snapshot.database.name} · {formatDate(state.snapshot.capturedAt)}</span>
          <small title={state.snapshot.fingerprint}>{bt("business.fingerprintDetail")} {state.snapshot.fingerprint.slice(0, 12)}</small>
        </>
      ) : <OperationFeedback label={bt("business.snapshotLoad", { value0: label })} state={state.loading ? { phase: "running", summary: bt("business.loadingSnapshot") } : { phase: runtimeKind === "web" ? "info" : "error", summary: runtimeKind === "web" ? bt("business.snapshotNotIncludedInThisShare") : bt("business.snapshotDetailsUnavailable"), details: state.error }} onRetry={runtimeKind === "desktop" ? state.retry : undefined} retryLabel={bt("business.retrySnapshot", { value0: label.toLowerCase() })} />}
    </div>
  );
}

function detailStatus(bt: Translate, state: SnapshotState, operation: SchemaOperation, side: "before" | "after"): string {
  if (state.loading) return bt("business.loading");
  if (!state.snapshot) return bt("business.snapshotUnavailable");
  return operation[side] === null ? bt("business.notPresent") : bt("business.objectDetailsUnavailable");
}

function OperationDetail({ operation, before, after }: { operation: SchemaOperation; before: SnapshotState; after: SnapshotState }) {
  const { t: bt } = useI18n();
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
    <article className="diff-detail" aria-label={bt("business.changeDetails")}>
      <header>
        <div className="diff-detail-heading">
          <h3>{translateUiLabel(changeLabel(operation.operationType), bt)}</h3>
          <span className="diff-risk" data-risk={operation.risk}>{translateUiLabel(operation.risk, bt)} {bt("business.risk")}</span>
        </div>
        <p className="diff-object-name">{operation.object.schema}.{operation.object.name}</p>
        <small>{translateUiLabel(changeLabel(operation.object.kind), bt)}</small>
      </header>
      {operation.operationType === "renameColumn" ? (
        <p className="diff-explanation">{bt("business.inferredRenameMatchingColumnDefinitionsSuggestARenameThe")}</p>
      ) : null}
      {replacement ? <p className="diff-explanation">{bt("business.thisObjectExistsInBothSnapshotsItsReplacementIs")}</p> : null}
      <div className="diff-summaries">
        <div><strong>{bt("business.beforeSummary")}</strong><pre>{operation.before ?? bt("business.noSummaryAddition")}</pre></div>
        <div><strong>{bt("business.afterSummary")}</strong><pre>{operation.after ?? bt("business.noSummaryRemoval")}</pre></div>
      </div>
      <div className="diff-property-controls">
        <h4>{bt("business.snapshotProperties")}</h4>
        <label><input type="checkbox" checked={showUnchanged} onChange={(event) => setShowUnchanged(event.target.checked)} />{bt("business.showUnchangedProperties")}</label>
      </div>
      <p className="diff-explanation">{bt("business.valuesDescribeTheSelectedBeforeAfterSnapshots")}</p>
      {!beforeProperties || !afterProperties ? (
        <p className="diff-explanation" role="status">
          {!beforeProperties ? bt("business.before", { value0: detailStatus(bt, before, operation, "before") }) : ""}
          {!afterProperties ? bt("business.afterDetail", { value0: detailStatus(bt, after, operation, "after") }) : ""}
        </p>
      ) : null}
      {visibleRows.length ? (
        <table className="diff-properties" aria-label={bt("business.beforeAndAfterProperties")}>
          <thead><tr><th scope="col">{bt("business.property")}</th><th scope="col">{bt("business.beforeDetail")}</th><th scope="col">{bt("business.after")}</th></tr></thead>
          <tbody>{visibleRows.map(({ key, changed }) => (
            <tr key={key} data-changed={changed}>
              <th scope="row">{translateUiLabel(PROPERTY_LABELS[key] ?? changeLabel(key), bt)}{changed ? <> <small>{bt("business.changedDetail")}</small></> : null}</th>
              <td><pre>{beforeProperties ? propertyValue(beforeProperties[key], bt, key) : detailStatus(bt, before, operation, "before")}</pre></td>
              <td><pre>{afterProperties ? propertyValue(afterProperties[key], bt, key) : detailStatus(bt, after, operation, "after")}</pre></td>
            </tr>
          ))}</tbody>
        </table>
      ) : (
        <p className="diff-empty">{keys.length ? bt("business.noChangedPropertiesShowUnchangedPropertiesToInspectThe") : bt("business.propertyDetailsAreUnavailableTheOperationSummariesRemainAvailable")}</p>
      )}
    </article>
  );
}

export function SchemaChangesPanel({ changeSet, currentSnapshot, platform, runtimeKind }: SchemaChangesPanelProps) {
  const { t: bt } = useI18n();
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
        operation.operationType, translateUiLabel(changeLabel(operation.operationType), bt), operation.before, operation.after].join(" ").toLowerCase().includes(term)));
  }, [operations, risk, search, type, bt]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const activePage = Math.min(page, pageCount - 1);
  const visible = filtered.slice(activePage * PAGE_SIZE, (activePage + 1) * PAGE_SIZE);
  const selected = visible.find(({ index }) => index === selectedIndex) ?? visible[0];
  function resetPage() { setPage(0); setSelectedIndex(undefined); }
  function goToPage(nextPage: number) { setPage(nextPage); setSelectedIndex(undefined); }

  return (
    <section className="schema-changes-panel" aria-label={bt("business.schemaComparison")}>
      <header className="diff-header">
        <h2>{operations.length} {bt("business.structuralChanges")}</h2>
        <p>{bt("business.changesAreReadFrom")} <strong>{bt("business.beforeAfterDetail")}</strong>{bt("businessExtra.addedAndRemovedObjectsFollowThisDirectionRegardlessOfCapture")}</p>
        <div className="diff-direction" aria-label={bt("business.comparisonDirection")}>
          <SnapshotContext label={bt("business.beforeDetail")} id={changeSet.beforeSnapshotId} state={before} runtimeKind={runtimeKind} />
          <span className="diff-direction-arrow" aria-hidden="true">→</span>
          <SnapshotContext label={bt("business.after")} id={changeSet.afterSnapshotId} state={after} runtimeKind={runtimeKind} />
        </div>
        {runtimeKind === "web" && (!before.snapshot || !after.snapshot) ? (
          <p className="diff-explanation">{bt("business.thisShareIncludesOneSnapshotHistoricalPropertiesAreUnavailable")}</p>
        ) : null}
        <div className="diff-risk-summary">{RISKS.map((level) => <span key={level} className="diff-risk" data-risk={level}>{changeSet.riskSummary[level]} {translateUiLabel(level, bt)}</span>)}</div>
      </header>
      <div className="diff-filters">
        <label>{bt("business.searchChanges")}<input type="search" placeholder={bt("business.objectSchemaOrSummary")} value={search} onChange={(event) => { setSearch(event.target.value); resetPage(); }} /></label>
        <label>{bt("business.riskDetail")}<select className="ds-select" value={risk} onChange={(event) => { setRisk(event.target.value as RiskLevel | "all"); resetPage(); }}><option value="all">{bt("business.allRisks")}</option>{RISKS.map((level) => <option key={level} value={level}>{translateUiLabel(changeLabel(level), bt)}</option>)}</select></label>
        <label>{bt("business.operation")}<select className="ds-select" value={type} onChange={(event) => { setType(event.target.value); resetPage(); }}><option value="all">{bt("business.allOperations")}</option>{types.map((value) => <option key={value} value={value}>{translateUiLabel(changeLabel(value), bt)}</option>)}</select></label>
        {search || risk !== "all" || type !== "all" ? <button type="button" onClick={() => { setSearch(""); setRisk("all"); setType("all"); resetPage(); }}>{bt("business.clearFilters")}</button> : null}
      </div>
      <div className="diff-content">
        <div className="diff-list-pane">
          <p className="diff-count" role="status">{filtered.length ? bt("business.showingOfChanges", { value0: activePage * PAGE_SIZE + 1, value1: activePage * PAGE_SIZE + visible.length, value2: filtered.length }) : bt("business.0Changes")}{filtered.length !== operations.length ? bt("business.total", { value0: operations.length }) : ""}</p>
          <ol key={`${activePage}:${risk}:${type}:${search}`} className="diff-operation-list" aria-label={bt("business.allSchemaChanges")} start={activePage * PAGE_SIZE + 1}>
            {visible.map(({ operation, index }) => (
              <li key={index}><button type="button" aria-pressed={selected?.index === index} onClick={() => setSelectedIndex(index)}>
                <span className="diff-operation-heading"><strong>{translateUiLabel(changeLabel(operation.operationType), bt)}</strong><span className="diff-risk" data-risk={operation.risk}>{translateUiLabel(operation.risk, bt)}</span></span>
                <span className="diff-object-name">{operation.object.schema}.{operation.object.name}</span>
              </button></li>
            ))}
          </ol>
          {!filtered.length ? <p className="diff-empty">{operations.length ? bt("business.noChangesMatchTheseFilters") : bt("business.noStructuralChangesBetweenTheseSnapshots")}</p> : null}
          {pageCount > 1 ? <nav className="diff-pagination" aria-label={bt("business.changePages")}>
            <button type="button" disabled={activePage === 0} onClick={() => goToPage(activePage - 1)}>{bt("business.previous")}</button>
            <span>{bt("business.page")} {activePage + 1} {bt("business.of")} {pageCount}</span>
            <button type="button" disabled={activePage + 1 === pageCount} onClick={() => goToPage(activePage + 1)}>{bt("business.next")}</button>
          </nav> : null}
        </div>
        {selected ? <OperationDetail key={selected.index} operation={selected.operation} before={before} after={after} /> : null}
      </div>
    </section>
  );
}
