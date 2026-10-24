import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { DatabaseSnapshot, IgnoredRelationshipInference, LogicalRelationship, RelationshipCardinality, RelationshipValidation, SaveLogicalRelationshipInput } from "../../platform";
import { useUpdateBlocker } from "../../platform/update-guard";
import { ActionIcon } from "../ActionIcon";
import type { ValidateRelationship } from "./RelationshipEditor";
import { relationshipCardinalityLabel } from "./relationship-labels";
import { candidateInScope, candidateMatches, candidateNeedsReview, type RelationshipCandidate } from "./inferred-review";

import { batchActionLabels } from "../../platform/relationship-batches";
import type { ApplyReviewBatch, RelationshipBatchApi, ReviewAction, ReviewBatch, ReviewRequest } from "../../platform/relationship-batches";
import { RelationshipBatchHistory, RelationshipBatchPanel } from "./RelationshipBatchPanel";

interface ReviewState { dirty: boolean; saving: boolean }
interface Props {
  snapshot: DatabaseSnapshot;
  tab: "inferred" | "ignored";
  candidates: RelationshipCandidate[];
  allCandidates: RelationshipCandidate[];
  ignored: IgnoredRelationshipInference[];
  initialCandidateKey?: string;
  visibleTableIds?: string[];
  selectedTableId?: string;
  onValidate: ValidateRelationship;
  onSave: (input: SaveLogicalRelationshipInput) => Promise<LogicalRelationship>;
  onIgnore: (key: string) => Promise<void>;
  onRestore: (key: string) => Promise<void>;
  batchApi?: RelationshipBatchApi;
  onNavigate: (action: () => void) => void;
  onStateChange: (state: ReviewState) => void;
}

function CandidateEndpoints({ candidate }: { candidate: RelationshipCandidate }) {
  return <div className="inference-endpoints">{(["source", "target"] as const).map((side) => {
    const endpoint = candidate[side];
    const column = side === "source" ? candidate.sourceColumn : candidate.targetColumn;
    const table = side === "source" ? candidate.sourceTable : candidate.targetTable;
    return <div className="relationship-manager-endpoint" key={side}><span>{side === "source" ? "Source" : "Target"} · {endpoint.schema}</span><strong>{endpoint.table}</strong><code>{column.name}</code><span>{column.formattedType} · {column.nullable ? "Nullable" : "Not null"}</span>{column.comment || table.comment ? <p>{column.comment || table.comment}</p> : null}</div>;
  })}</div>;
}

function CandidateConfirmation({ candidate, snapshot, onValidate, onSave, onSaved, onIgnore, onStateChange, disabled }: {
  candidate: RelationshipCandidate;
  snapshot: DatabaseSnapshot;
  onValidate: ValidateRelationship;
  onSave: Props["onSave"];
  onSaved: (relationship: LogicalRelationship) => void;
  onIgnore: () => void;
  onStateChange: Props["onStateChange"];
  disabled: boolean;
}) {
  const [note, setNote] = useState("");
  const [cardinality, setCardinality] = useState<RelationshipCardinality>();
  const [allowMismatch, setAllowMismatch] = useState(false);
  const [validation, setValidation] = useState<{ key: string; result?: RelationshipValidation; error?: string }>();
  const [retry, setRetry] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const key = JSON.stringify([snapshot.id, candidate.key, retry]);
  const result = validation?.key === key ? validation.result : undefined;
  const validationError = validation?.key === key ? validation.error : undefined;
  const dirty = Boolean(note || cardinality || allowMismatch);
  useUpdateBlocker("finish or close the relationship review", dirty || saving);
  useEffect(() => { onStateChange({ dirty, saving }); }, [dirty, saving, onStateChange]);
  useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => onValidate({ sourceId: snapshot.sourceId, source: candidate.source, target: candidate.target })).then((value) => {
      if (active) setValidation({ key, result: value });
    }).catch((reason: unknown) => { if (active) setValidation({ key, error: reason instanceof Error ? reason.message : String(reason) }); });
    return () => { active = false; };
  }, [candidate, key, onValidate, snapshot.sourceId]);
  const canSave = !disabled && !saving && result && !result.duplicate && !result.physicalExists
    && (result.valid || (!result.compatible && result.status === "conflicted" && allowMismatch));
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!canSave || pending.current) return;
    pending.current = true; setSaving(true); setError("");
    try {
      const saved = await onSave({ sourceId: snapshot.sourceId, source: candidate.source, target: candidate.target,
        name: `${candidate.source.table}_${candidate.sourceColumn.name}_${candidate.target.table}_${candidate.targetColumn.name}`.slice(0, 160),
        cardinality: cardinality ?? result?.suggestedCardinality ?? "unspecified", note: note.trim() || null,
        origin: "confirmedInference", evidence: candidate.evidence, allowTypeMismatch: allowMismatch, disabled: false });
      onSaved(saved);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { pending.current = false; setSaving(false); }
  }
  return <form className="inference-confirmation relationship-editor" aria-label="Review inferred relationship" onSubmit={(event) => void submit(event)}>
    <div className="relationship-detail-heading"><div><h3 tabIndex={-1}>Review candidate</h3><p>Naming suggestion · business meaning not yet confirmed</p></div></div>
    <CandidateEndpoints candidate={candidate} />
    <ul className="inference-evidence" aria-label="Inference evidence">{candidate.evidence.map((evidence) => <li key={evidence}>{evidence}</li>)}</ul>
    {candidate.bulkReviewReason ? <p className="relationship-attention">{candidate.bulkReviewReason}. Check the business mapping before confirming.</p> : null}
    {!candidate.targetUnique ? <p className="relationship-attention">This target field is not known to be unique by itself. Review the relationship type before confirming.</p> : null}
    {candidate.existingTargets.length ? <div className="relationship-attention"><strong>This source field already has a logical relationship</strong><ul>{candidate.existingTargets.map((target) => <li key={target}>{target}</li>)}</ul><p>Check whether this additional target represents a different business relationship before confirming.</p></div> : null}
    <fieldset disabled={saving || disabled}>
      <label>Relationship type<select value={cardinality ?? result?.suggestedCardinality ?? "unspecified"} onChange={(event) => setCardinality(event.target.value as RelationshipCardinality)}>
        {(["manyToOne", "oneToOne", "oneToMany", "manyToMany", "unspecified"] as const).map((value) => <option value={value} key={value}>{relationshipCardinalityLabel(value)}</option>)}
      </select></label>
      <details className="relationship-metadata"><summary>Add a note</summary><label>Confirmation note<textarea rows={3} maxLength={2000} placeholder="Describe why these fields are related…" value={note} onChange={(event) => setNote(event.target.value)} /></label></details>
      {result && !result.compatible && result.status === "conflicted" ? <label className="relationship-check"><input type="checkbox" checked={allowMismatch} onChange={(event) => setAllowMismatch(event.target.checked)} />I reviewed the type mismatch; mark this relationship for review</label> : null}
    </fieldset>
    <div className="relationship-editor-validation" aria-live="polite">
      {!result && !validationError ? <p>Checking field mapping…</p> : null}
      {result?.duplicate ? <p role="alert">This logical relationship already exists, possibly disabled. Review it in the Logical tab.</p> : result?.physicalExists ? <p role="alert">A database foreign key already covers this mapping.</p> : null}
      {result?.messages.length ? <ul>{result.messages.map((message) => <li key={message}>{message}</li>)}</ul> : null}
      {validationError ? <p role="alert">{validationError} <button type="button" disabled={saving || disabled} onClick={() => setRetry((value) => value + 1)}>Retry validation</button></p> : null}
      {error ? <p role="alert">{error}</p> : null}
      <p>Structure checked only; stored data has not been verified. Confirmation adds a local model relationship, not a database foreign key.</p>
    </div>
    <footer className="relationship-editor-footer inference-actions"><button type="button" disabled={saving || disabled} onClick={onIgnore}>Ignore candidate</button><button type="submit" className="ds-primary" disabled={!canSave}>{saving ? "Confirming…" : "Confirm and next"}</button></footer>
  </form>;
}

export function InferredRelationshipReview({ snapshot, tab, candidates, allCandidates, ignored, initialCandidateKey, visibleTableIds, selectedTableId, onValidate, onSave, onIgnore, onRestore, batchApi, onNavigate, onStateChange }: Props) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [scope, setScope] = useState(initialCandidateKey ? "all" : selectedTableId ? "selected" : visibleTableIds ? "view" : "all");
  const [selectedKey, setSelectedKey] = useState(initialCandidateKey);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [batchRequest, setBatchRequest] = useState<ReviewRequest>();
  const [history, setHistory] = useState(false);
  const [lastBatch, setLastBatch] = useState<ReviewBatch>();
  const lastCheckedKey = useRef<string | undefined>(undefined);
  const quickAttempt = useRef<ApplyReviewBatch | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState(0);
  const [draftRevision, setDraftRevision] = useState(0);
  const [formState, setFormState] = useState<ReviewState>({ dirty: false, saving: false });
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const actionPending = useRef(false);
  const detailRef = useRef<HTMLDivElement>(null);
  const focusNext = useRef(false);
  const locked = busy || formState.saving;
  const resolvedScope = scope === "selected" && !selectedTableId ? "all" : scope === "view" && !visibleTableIds ? "all" : scope;
  const rows = useMemo(() => {
    if (tab === "inferred") return candidates.filter((candidate) => candidateMatches(candidate, query) && candidateInScope(candidate, resolvedScope, visibleTableIds, selectedTableId)
      && (filter === "all" || (filter === "matching" ? !candidateNeedsReview(candidate) : candidateNeedsReview(candidate))))
      .map((candidate) => ({ key: candidate.key, candidate, ignored: undefined }));
    return ignored.map((entry) => ({ key: entry.relationshipKey, ignored: entry,
      candidate: allCandidates.find((candidate) => candidate.key === entry.relationshipKey || candidate.ruleKey === entry.relationshipKey) }))
      .filter((row) => row.candidate ? candidateMatches(row.candidate, query) : row.key.toLowerCase().includes(query.trim().toLowerCase()));
  }, [tab, candidates, ignored, allCandidates, query, filter, resolvedScope, visibleTableIds, selectedTableId]);
  const selectedRows = rows.filter((row) => checked.has(row.key));
  const eligibleRows = rows.filter((row) => row.candidate && !candidateNeedsReview(row.candidate));
  const selected = rows.find((row) => row.key === selectedKey) ?? rows[0];
  useEffect(() => { onStateChange({ dirty: formState.dirty, saving: locked }); }, [formState.dirty, locked, onStateChange]);
  useEffect(() => {
    if (focusNext.current) { focusNext.current = false; detailRef.current?.querySelector<HTMLElement>('h3')?.focus(); }
  }, [selected?.key, step]);
  function navigate(action: () => void) { onNavigate(() => { setDraftRevision((value) => value + 1); setFormState({ dirty: false, saving: false }); setError(""); setMessage(""); action(); }); }
  function leaveBatch() { setBatchRequest(undefined); setHistory(false); setFormState({ dirty: false, saving: false }); }
  function clearSelection() { setChecked(new Set()); lastCheckedKey.current = undefined; quickAttempt.current = undefined; leaveBatch(); }
  function changeFilters(action: () => void) { if (checked.size) setMessage("Selection cleared because the filters changed."); clearSelection(); action(); }
  function makeRequest(action: ReviewAction): ReviewRequest {
    return { sourceId: snapshot.sourceId, snapshotId: snapshot.id, action, entries: selectedRows.map((row) => ({ key: row.key, source: row.candidate?.source, target: row.candidate?.target })) };
  }
  function batchDone(batch: ReviewBatch) {
    setChecked((current) => new Set([...current].filter((key) => !batch.keys.includes(key))));
    leaveBatch(); setLastBatch(batch); quickAttempt.current = undefined; setError("");
    setMessage(`${batchActionLabels[batch.action]} ${batch.keys.length} candidates. ${batch.action === "confirm" ? "Other selected candidates remain for individual review." : "You can undo this batch."}`);
  }
  function undone(batch: ReviewBatch) {
    setLastBatch(batch); clearSelection(); setHistory(true);
    setMessage(`Undone ${batch.keys.length - batch.skippedKeys.length} changes.${batch.skippedKeys.length ? ` Preserved ${batch.skippedKeys.length} subsequently changed items; see batch details.` : ""}`);
  }
  async function quickBatch(action: "ignore" | "restore") {
    if (!batchApi || actionPending.current || !selectedRows.length) return;
    actionPending.current = true; setBusy(true); setError("");
    try {
      const request = makeRequest(action);
      let input = quickAttempt.current;
      if (!input || JSON.stringify(input.request) !== JSON.stringify(request)) {
        const preview = await batchApi.preview(request);
        if (preview.checks.some((check) => check.reason)) throw new Error("The selection changed. Refresh this model and select candidates again.");
        input = { request, revision: preview.revision, batchId: crypto.randomUUID(), approvedKeys: preview.checks.map((check) => check.entry.key) };
        quickAttempt.current = input;
      }
      batchDone(await batchApi.apply(input));
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { actionPending.current = false; setBusy(false); }
  }
  async function undoLast() {
    if (!batchApi || !lastBatch || actionPending.current) return;
    actionPending.current = true; setBusy(true); setError("");
    try { undone(await batchApi.undo(snapshot.sourceId, lastBatch.id)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { actionPending.current = false; setBusy(false); }
  }
  function advance(key: string) {
    const index = rows.findIndex((row) => row.key === key);
    setSelectedKey(rows[index + 1]?.key ?? rows[index - 1]?.key);
    setFormState({ dirty: false, saving: false });
    focusNext.current = true;
    setStep((value) => value + 1);
  }
  async function mutate(key: string, restore: boolean) {
    if (actionPending.current) return;
    actionPending.current = true; setBusy(true); setError("");
    try {
      await (restore ? onRestore(key) : onIgnore(key));
      advance(key);
      setMessage(restore ? "Ignore entry removed. Candidates return unless another ignore rule or an existing relationship covers them." : "Candidate ignored. Restore it anytime from Ignored.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { actionPending.current = false; setBusy(false); }
  }
  const isRule = selected?.key.startsWith("rule:naming-id:");
  const hasFilters = Boolean(query || (tab === "inferred" && (filter !== "all" || resolvedScope !== "all")));
  return <>
    <div className="relationship-manager-tools inference-tools">
      <label className="relationship-manager-search"><ActionIcon name="search" /><input type="search" autoCorrect="off" autoCapitalize="none" spellCheck={false} aria-label="Search candidates" placeholder="Search tables, fields, or comments…" value={query} disabled={locked || formState.dirty} onChange={(event) => { changeFilters(() => { setQuery(event.target.value); setSelectedKey(undefined); }); }} /></label>
      {tab === "inferred" ? <><select aria-label="Candidate scope" disabled={locked || formState.dirty} value={resolvedScope} onChange={(event) => { changeFilters(() => { setScope(event.target.value); setSelectedKey(undefined); }); }}><option value="all">Entire database</option>{visibleTableIds ? <option value="view">Current diagram</option> : null}{selectedTableId ? <option value="selected">Selected table</option> : null}</select>
        <select aria-label="Candidate evidence" disabled={locked || formState.dirty} value={filter} onChange={(event) => { changeFilters(() => { setFilter(event.target.value); setSelectedKey(undefined); }); }}><option value="all">All evidence</option><option value="matching">Compatible types · unique target</option><option value="review">Needs review</option></select></> : null}
    </div>
    {batchApi ? <div className="inference-bulk-toolbar" aria-label="Batch review actions">
      <select aria-label="Select candidates for batch" value="" disabled={locked || formState.dirty} onChange={(event) => { quickAttempt.current = undefined; leaveBatch(); setChecked(new Set(event.target.value === "all" ? rows.map((row) => row.key) : event.target.value === "eligible" ? eligibleRows.map((row) => row.key) : [])); }}>
        <option value="" disabled>Select…</option><option value="all">All filtered · {rows.length}</option>{tab === "inferred" ? <option value="eligible">Structure checks passed · {eligibleRows.length}</option> : null}<option value="none">Clear selection</option>
      </select>
      <span aria-live="polite">{selectedRows.length} selected</span>
      {tab === "inferred" ? <button className={selectedRows.length ? "ds-primary" : undefined} disabled={!selectedRows.length || locked || formState.dirty} onClick={() => navigate(() => { setBatchRequest(makeRequest("confirm")); setHistory(false); })}>Preview confirmation</button> : null}
      <button disabled={!selectedRows.length || locked || formState.dirty} onClick={() => void quickBatch(tab === "ignored" ? "restore" : "ignore")}>{tab === "ignored" ? "Restore" : "Ignore"} {selectedRows.length}</button>
      {selectedRows.length ? <button disabled={locked || formState.dirty} onClick={clearSelection}>Clear</button> : null}
      <button disabled={locked} onClick={() => navigate(() => { setHistory(true); setBatchRequest(undefined); })}>Batch history</button>
    </div> : null}
    <div className="inference-result-count">{rows.length} {tab === "inferred" ? rows.length === 1 ? "candidate" : "candidates" : rows.length === 1 ? "ignored entry" : "ignored entries"}{tab === "inferred" && formState.dirty ? " · Finish this review to change filters" : tab === "ignored" ? " · Includes previously ignored naming rules" : " · Naming suggestions, not confirmed facts"}</div>
    <div className="relationship-manager-body">
      <nav className="relationship-manager-list" aria-label={tab === "inferred" ? "Inferred candidates" : "Ignored candidates"}>
        {rows.map((row) => <div key={row.key} className={batchApi ? "inference-selectable-row" : undefined}>
          {batchApi ? <input type="checkbox" aria-label={`Select ${row.key}`} checked={checked.has(row.key)} disabled={locked || formState.dirty} onChange={(event) => { const next = new Set(checked); const previous = rows.findIndex((item) => item.key === lastCheckedKey.current); const current = rows.findIndex((item) => item.key === row.key); const range = "shiftKey" in event.nativeEvent && event.nativeEvent.shiftKey === true && previous >= 0 ? rows.slice(Math.min(previous, current), Math.max(previous, current) + 1) : [row]; for (const item of range) { if (event.target.checked) next.add(item.key); else next.delete(item.key); } lastCheckedKey.current = row.key; setChecked(next); quickAttempt.current = undefined; leaveBatch(); }} /> : null}
          <button type="button" className="relationship-manager-row" aria-pressed={row.key === selected?.key} disabled={locked} data-status={row.candidate && candidateNeedsReview(row.candidate) ? "conflicted" : undefined} onClick={() => navigate(() => { leaveBatch(); setSelectedKey(row.key); })}>
          <strong>{row.candidate ? `${row.candidate.source.table} → ${row.candidate.target.table}` : row.key.startsWith("rule:naming-id:") ? "Ignored field rule" : "Previous candidate"}</strong>
          <code>{row.candidate ? `${row.candidate.sourceColumn.name} → ${row.candidate.targetColumn.name}` : row.key.replace(/^rule:naming-id:/, "")}</code>
          {row.candidate ? <span className="relationship-row-schema">{row.candidate.source.schema}{row.candidate.source.schema !== row.candidate.target.schema ? ` → ${row.candidate.target.schema}` : ""}</span> : null}
          <span className="relationship-status-badge">{row.key.startsWith("rule:naming-id:") ? "Naming rule · all suggestions for this field" : tab === "ignored" ? "Ignored candidate" : row.candidate && !candidateNeedsReview(row.candidate) ? "Compatible types · unique target" : "Needs review"}</span>
        </button></div>)}
        {!rows.length ? <div className="relationship-manager-empty"><strong>{hasFilters ? "No matching candidates" : tab === "ignored" ? "No ignored candidates" : "Review queue complete"}</strong><p>{tab === "ignored" ? "Ignored candidates and field rules appear here." : "Adjust the search or scope to review other suggestions."}</p>{hasFilters ? <button type="button" onClick={() => navigate(() => { changeFilters(() => { setQuery(""); setFilter("all"); setScope("all"); }); })}>Clear filters</button> : null}</div> : null}
      </nav>
      <div ref={detailRef} className="relationship-manager-detail">
        {batchApi && history ? <RelationshipBatchHistory api={batchApi} sourceId={snapshot.sourceId} onBack={leaveBatch} onUndone={undone} onStateChange={setFormState} />
          : batchApi && batchRequest ? <RelationshipBatchPanel api={batchApi} request={batchRequest} candidates={allCandidates} onDone={batchDone} onBack={() => navigate(leaveBatch)} onReview={(key) => navigate(() => { leaveBatch(); setSelectedKey(key); })} onStateChange={setFormState} />
          : selected && tab === "inferred" && selected.candidate ? <CandidateConfirmation key={`${snapshot.id}:${selected.key}:${draftRevision}`} candidate={selected.candidate} snapshot={snapshot} onValidate={onValidate} onSave={onSave} onStateChange={setFormState} disabled={busy}
          onIgnore={() => navigate(() => { void mutate(selected.key, false); })}
          onSaved={() => { advance(selected.key); setMessage("Confirmed as a logical relationship. Review the next candidate."); }} />
          : selected ? <section aria-label="Ignored relationship details"><div className="relationship-detail-heading"><div><h3>{isRule ? "Ignored naming rule" : "Ignored candidate"}</h3><p>{selected.ignored ? `Ignored ${new Date(selected.ignored.ignoredAt).toLocaleDateString()}` : ""}</p></div></div>
            {selected.candidate ? <CandidateEndpoints candidate={selected.candidate} /> : <code className="inference-ignored-key">{selected.key.replace(/^rule:naming-id:/, "")}</code>}
            <p className="relationship-detail-note">{isRule ? "This rule hides naming suggestions for this source field, including future suggestions. Restoring it allows those suggestions to appear again." : "This entry hides only this field-to-field suggestion."}</p>
            {!selected.candidate ? <p className="relationship-detail-note">This suggestion is no longer generated by the current snapshot. You can still remove its ignore entry.</p> : null}
            <button type="button" data-restore className="ds-primary" disabled={locked} onClick={() => void mutate(selected.key, true)}>{busy ? "Restoring…" : isRule ? "Restore field suggestions" : "Restore candidate"}</button>
          </section> : <div className="relationship-manager-empty"><ActionIcon name="relationships" /><strong>Select a candidate to review</strong><p>Confirmed suggestions become logical relationships in this model.</p></div>}
      </div>
    </div>
    {error || message ? <div className="inference-feedback" role={error ? "alert" : "status"}>{error || message}{!error && lastBatch && !lastBatch.undoneAt && batchApi ? <button disabled={locked} onClick={() => void undoLast()}>Undo batch</button> : null}</div> : null}
  </>;
}
