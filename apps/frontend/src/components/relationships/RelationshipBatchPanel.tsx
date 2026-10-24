import { useEffect, useRef, useState } from "react";
import type { ApplyReviewBatch, RelationshipBatchApi, ReviewBatch, ReviewCheck, ReviewPreview, ReviewRequest } from "../../platform/relationship-batches";
import { useUpdateBlocker } from "../../platform/update-guard";
import { relationshipCardinalityLabel } from "./relationship-labels";
import type { RelationshipCandidate } from "./inferred-review";

import { batchActionLabels } from "../../platform/relationship-batches";
const groupKey = (check: ReviewCheck) => `${check.entry.source?.columns.join(",")} → ${check.entry.target?.schema}.${check.entry.target?.table}.${check.entry.target?.columns.join(",")}`;
const mapping = (check: ReviewCheck) => check.entry.source && check.entry.target
  ? `${check.entry.source.schema}.${check.entry.source.table}.${check.entry.source.columns.join(",")} → ${check.entry.target.schema}.${check.entry.target.table}.${check.entry.target.columns.join(",")}` : check.entry.key;

export function RelationshipBatchPanel({ api, request, candidates, onDone, onBack, onReview, onStateChange }: {
  api: RelationshipBatchApi; request: ReviewRequest; candidates: RelationshipCandidate[];
  onDone: (batch: ReviewBatch) => void; onBack: () => void; onReview: (key: string) => void;
  onStateChange: (state: { dirty: boolean; saving: boolean }) => void;
}) {
  const [preview, setPreview] = useState<ReviewPreview>();
  const [included, setIncluded] = useState<Set<string>>(new Set());
  const [reviewed, setReviewed] = useState<Set<string>>(new Set());
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [saving, setSaving] = useState(false);
  const attempt = useRef<ApplyReviewBatch | undefined>(undefined);
  const pending = useRef(false);
  useUpdateBlocker("finish or close the batch review", saving || reviewed.size > 0);
  useEffect(() => { onStateChange({ dirty: reviewed.size > 0, saving }); }, [reviewed, saving, onStateChange]);
  useEffect(() => {
    let active = true;
    void api.preview(request).then((value) => {
      if (!active) return;
      setPreview(value); setIncluded(new Set(value.checks.filter((check) => !check.reason).map((check) => check.entry.key))); setReviewed(new Set()); setError(""); attempt.current = undefined;
    }).catch((reason: unknown) => { if (active) setError(String(reason)); });
    return () => { active = false; };
  }, [api, request, retry]);
  const groups = new Map<string, ReviewCheck[]>();
  for (const check of preview?.checks ?? []) {
    if (!check.reason) { const key = groupKey(check); groups.set(key, [...(groups.get(key) ?? []), check]); }
  }
  const activeGroups = [...groups].filter(([, checks]) => checks.some((check) => included.has(check.entry.key)));
  const blocked = preview?.checks.filter((check) => check.reason) ?? [];
  const ready = Boolean(preview && included.size && activeGroups.every(([key]) => reviewed.has(key)));
  function toggleIncluded(key: string, group: string) {
    setIncluded((current) => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next; });
    setReviewed((current) => { const next = new Set(current); next.delete(group); return next; }); attempt.current = undefined;
  }
  async function confirm() {
    if (!preview || !ready || pending.current) return;
    pending.current = true; setSaving(true); setError("");
    const input = attempt.current ?? { request, revision: preview.revision, batchId: crypto.randomUUID(), approvedKeys: [...included] };
    attempt.current = input;
    try { onDone(await api.apply(input)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { pending.current = false; setSaving(false); }
  }
  return <section className="relationship-batch-preview" aria-label="Batch confirmation preview">
    <div className="relationship-detail-heading"><div><h3>Preview batch confirmation</h3><p>{included.size} included · {blocked.length} require individual review</p></div><button disabled={saving} onClick={onBack}>Back</button></div>
    <p className="relationship-detail-note">Review each mapping group’s business meaning. Matching field types alone do not establish a relationship.</p>
    {!preview && !error ? <p role="status">Checking selected candidates…</p> : null}
    {[...groups].map(([key, checks]) => <section className="relationship-batch-group" key={key} aria-label={key}>
      <div className="relationship-batch-group-heading"><strong>{key}</strong><button disabled={saving} onClick={() => { setIncluded((current) => new Set([...current].filter((item) => !checks.some((check) => check.entry.key === item)))); setReviewed((current) => { const next = new Set(current); next.delete(key); return next; }); attempt.current = undefined; }}>Exclude group</button></div><span className="relationship-row-schema">{checks.filter((check) => included.has(check.entry.key)).length} of {checks.length} included</span>
      <div className="relationship-batch-members">{(expandedGroups.has(key) ? checks : checks.slice(0, 3)).map((check) => {
        const candidate = candidates.find((row) => row.key === check.entry.key);
        return <label className="relationship-batch-member" key={check.entry.key}><input type="checkbox" aria-label={`Include ${mapping(check)}`} disabled={saving} checked={included.has(check.entry.key)} onChange={() => toggleIncluded(check.entry.key, key)} /><span><code>{check.entry.source?.schema}.{check.entry.source?.table}.{check.entry.source?.columns.join(",")}</code><small>{candidate ? `${candidate.sourceColumn.formattedType} → ${candidate.targetColumn.formattedType} · ` : ""}{relationshipCardinalityLabel(check.cardinality)}{candidate?.sourceColumn.comment || candidate?.sourceTable.comment ? ` · ${candidate.sourceColumn.comment || candidate.sourceTable.comment}` : ""}</small></span></label>;
      })}</div>
      {checks.length > 3 ? <button className="relationship-batch-expand" disabled={saving} onClick={() => setExpandedGroups((current) => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next; })}>{expandedGroups.has(key) ? "Show fewer mappings" : `Show all ${checks.length} mappings`}</button> : null}
      <label className="relationship-check"><input type="checkbox" checked={reviewed.has(key)} disabled={saving || !checks.some((check) => included.has(check.entry.key))} onChange={(event) => setReviewed((current) => { const next = new Set(current); if (event.target.checked) next.add(key); else next.delete(key); return next; })} />I checked the business meaning of this group</label>
    </section>)}
    {blocked.length ? <section className="relationship-batch-blocked"><h3>Keep for individual review · {blocked.length}</h3>{blocked.map((check) => <div key={check.entry.key}><code>{mapping(check)}</code><p>{check.reason}</p><button disabled={saving} onClick={() => onReview(check.entry.key)}>Review individually</button></div>)}</section> : null}
    {error ? <div role="alert" className="relationship-error"><p>{error}</p><button disabled={saving} onClick={() => { setPreview(undefined); setReviewed(new Set()); setIncluded(new Set()); setError(""); setRetry((value) => value + 1); }}>Refresh preview</button></div> : null}
    <footer className="relationship-editor-footer"><button disabled={!ready || saving} className="ds-primary" onClick={() => void confirm()}>{saving ? "Confirming…" : `Confirm ${included.size} relationships`}</button></footer>
  </section>;
}

export function RelationshipBatchHistory({ api, sourceId, onBack, onUndone, onStateChange }: {
  api: RelationshipBatchApi; sourceId: string; onBack: () => void; onUndone: (batch: ReviewBatch) => void; onStateChange: (state: { dirty: boolean; saving: boolean }) => void;
}) {
  const [batches, setBatches] = useState<ReviewBatch[]>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const pending = useRef(false);
  useUpdateBlocker("wait for batch undo", busy);
  useEffect(() => { onStateChange({ dirty: false, saving: busy }); }, [busy, onStateChange]);
  useEffect(() => { let active = true; void api.list(sourceId).then((value) => { if (active) { setBatches(value); setError(""); } }).catch((reason: unknown) => { if (active) setError(String(reason)); }); return () => { active = false; }; }, [api, sourceId, reload]);
  async function undo(batch: ReviewBatch) {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError("");
    try { const result = await api.undo(sourceId, batch.id); setBatches((current) => current?.map((row) => row.id === result.id ? result : row)); onUndone(result); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { pending.current = false; setBusy(false); }
  }
  return <section aria-label="Review batch history"><div className="relationship-detail-heading"><div><h3>Review batches</h3><p>Stored on this device. Undo preserves subsequent edits.</p></div><button disabled={busy} onClick={onBack}>Back</button></div>
    {!batches && !error ? <p role="status">Loading batches…</p> : null}
    {batches?.length === 0 ? <p>No review batches yet.</p> : null}
    {batches?.map((batch) => <article className="relationship-batch-group" key={batch.id}><strong>{batchActionLabels[batch.action]} {batch.keys.length} candidates</strong><span className="relationship-row-schema">{new Date(batch.createdAt).toLocaleString()}</span><details><summary>View affected mappings</summary>{batch.keys.map((key) => <code className="relationship-batch-key" key={key}>{key}</code>)}</details>
      {batch.undoneAt ? <p>{batch.skippedKeys.length ? `Undone ${batch.keys.length - batch.skippedKeys.length}; preserved ${batch.skippedKeys.length} subsequently changed items.` : "Batch undone"}</p> : <button disabled={busy} onClick={() => void undo(batch)}>Undo batch</button>}
      {batch.skippedKeys.length ? <details><summary>Items preserved</summary>{batch.skippedKeys.map((key) => <code className="relationship-batch-key" key={key}>{key}</code>)}</details> : null}
    </article>)}
    {error ? <div role="alert"><p>{error}</p><button disabled={busy} onClick={() => setReload((value) => value + 1)}>Retry</button></div> : null}
  </section>;
}
