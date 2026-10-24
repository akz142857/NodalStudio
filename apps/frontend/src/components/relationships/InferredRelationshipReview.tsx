import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { DatabaseSnapshot, IgnoredRelationshipInference, LogicalRelationship, RelationshipCardinality, RelationshipValidation, SaveLogicalRelationshipInput } from "../../platform";
import { useUpdateBlocker } from "../../platform/update-guard";
import { ActionIcon } from "../ActionIcon";
import type { ValidateRelationship } from "./RelationshipEditor";
import { relationshipCardinalityLabel } from "./relationship-labels";
import { candidateInScope, candidateMatches, candidateNeedsReview, type RelationshipCandidate } from "./inferred-review";

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

export function InferredRelationshipReview({ snapshot, tab, candidates, allCandidates, ignored, initialCandidateKey, visibleTableIds, selectedTableId, onValidate, onSave, onIgnore, onRestore, onNavigate, onStateChange }: Props) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [scope, setScope] = useState(initialCandidateKey ? "all" : selectedTableId ? "selected" : visibleTableIds ? "view" : "all");
  const [selectedKey, setSelectedKey] = useState(initialCandidateKey);
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
  const selected = rows.find((row) => row.key === selectedKey) ?? rows[0];
  useEffect(() => { onStateChange({ dirty: formState.dirty, saving: locked }); }, [formState.dirty, locked, onStateChange]);
  useEffect(() => {
    if (focusNext.current) { focusNext.current = false; detailRef.current?.querySelector<HTMLElement>('h3')?.focus(); }
  }, [selected?.key, step]);
  function navigate(action: () => void) { onNavigate(() => { setDraftRevision((value) => value + 1); setFormState({ dirty: false, saving: false }); setError(""); setMessage(""); action(); }); }
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
      <label className="relationship-manager-search"><ActionIcon name="search" /><input type="search" autoCorrect="off" autoCapitalize="none" spellCheck={false} aria-label="Search candidates" placeholder="Search tables, fields, or comments…" value={query} disabled={locked || formState.dirty} onChange={(event) => { setQuery(event.target.value); setSelectedKey(undefined); setMessage(""); }} /></label>
      {tab === "inferred" ? <><select aria-label="Candidate scope" disabled={locked || formState.dirty} value={resolvedScope} onChange={(event) => { setScope(event.target.value); setSelectedKey(undefined); }}><option value="all">Entire database</option>{visibleTableIds ? <option value="view">Current diagram</option> : null}{selectedTableId ? <option value="selected">Selected table</option> : null}</select>
        <select aria-label="Candidate evidence" disabled={locked || formState.dirty} value={filter} onChange={(event) => { setFilter(event.target.value); setSelectedKey(undefined); }}><option value="all">All evidence</option><option value="matching">Compatible types · unique target</option><option value="review">Needs review</option></select></> : null}
    </div>
    <div className="inference-result-count">{rows.length} {tab === "inferred" ? rows.length === 1 ? "candidate" : "candidates" : rows.length === 1 ? "ignored entry" : "ignored entries"}{tab === "inferred" && formState.dirty ? " · Finish this review to change filters" : tab === "ignored" ? " · Includes previously ignored naming rules" : " · Naming suggestions, not confirmed facts"}</div>
    <div className="relationship-manager-body">
      <nav className="relationship-manager-list" aria-label={tab === "inferred" ? "Inferred candidates" : "Ignored candidates"}>
        {rows.map((row) => <button type="button" key={row.key} className="relationship-manager-row" aria-pressed={row.key === selected?.key} disabled={locked} data-status={row.candidate && candidateNeedsReview(row.candidate) ? "conflicted" : undefined} onClick={() => navigate(() => setSelectedKey(row.key))}>
          <strong>{row.candidate ? `${row.candidate.source.table} → ${row.candidate.target.table}` : row.key.startsWith("rule:naming-id:") ? "Ignored field rule" : "Previous candidate"}</strong>
          <code>{row.candidate ? `${row.candidate.sourceColumn.name} → ${row.candidate.targetColumn.name}` : row.key.replace(/^rule:naming-id:/, "")}</code>
          {row.candidate ? <span className="relationship-row-schema">{row.candidate.source.schema}{row.candidate.source.schema !== row.candidate.target.schema ? ` → ${row.candidate.target.schema}` : ""}</span> : null}
          <span className="relationship-status-badge">{row.key.startsWith("rule:naming-id:") ? "Naming rule · all suggestions for this field" : tab === "ignored" ? "Ignored candidate" : row.candidate && !candidateNeedsReview(row.candidate) ? "Compatible types · unique target" : "Needs review"}</span>
        </button>)}
        {!rows.length ? <div className="relationship-manager-empty"><strong>{hasFilters ? "No matching candidates" : tab === "ignored" ? "No ignored candidates" : "Review queue complete"}</strong><p>{tab === "ignored" ? "Ignored candidates and field rules appear here." : "Adjust the search or scope to review other suggestions."}</p>{hasFilters ? <button type="button" onClick={() => navigate(() => { setQuery(""); setFilter("all"); setScope("all"); })}>Clear filters</button> : null}</div> : null}
      </nav>
      <div ref={detailRef} className="relationship-manager-detail">
        {selected && tab === "inferred" && selected.candidate ? <CandidateConfirmation key={`${snapshot.id}:${selected.key}:${draftRevision}`} candidate={selected.candidate} snapshot={snapshot} onValidate={onValidate} onSave={onSave} onStateChange={setFormState} disabled={busy}
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
    {error || message ? <div className="inference-feedback" role={error ? "alert" : "status"}>{error || message}</div> : null}
  </>;
}
