import { translateUiLabel } from "../../i18n/business-labels";
import { useI18n } from "../../i18n";
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
  const { t: bt } = useI18n();
  const [preview, setPreview] = useState<ReviewPreview>();
  const [included, setIncluded] = useState<Set<string>>(new Set());
  const [reviewed, setReviewed] = useState<Set<string>>(new Set());
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [saving, setSaving] = useState(false);
  const attempt = useRef<ApplyReviewBatch | undefined>(undefined);
  const pending = useRef(false);
  useUpdateBlocker(bt("business.finishOrCloseTheBatchReview"), saving || reviewed.size > 0);
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
  return <section className="relationship-batch-preview" aria-label={bt("business.batchConfirmationPreview")}>
    <div className="relationship-detail-heading"><div><h3>{bt("business.previewBatchConfirmation")}</h3><p>{included.size} {bt("business.included")} {blocked.length} {bt("business.requireIndividualReview")}</p></div><button disabled={saving} onClick={onBack}>{bt("business.back")}</button></div>
    <p className="relationship-detail-note">{bt("business.reviewEachMappingGroupSBusinessMeaningMatchingField")}</p>
    {!preview && !error ? <p role="status">{bt("business.checkingSelectedCandidates")}</p> : null}
    {[...groups].map(([key, checks]) => <section className="relationship-batch-group" key={key} aria-label={key}>
      <div className="relationship-batch-group-heading"><strong>{key}</strong><button disabled={saving} onClick={() => { setIncluded((current) => new Set([...current].filter((item) => !checks.some((check) => check.entry.key === item)))); setReviewed((current) => { const next = new Set(current); next.delete(key); return next; }); attempt.current = undefined; }}>{bt("business.excludeGroup")}</button></div><span className="relationship-row-schema">{checks.filter((check) => included.has(check.entry.key)).length} {bt("business.of")} {checks.length} {bt("business.includedDetail")}</span>
      <div className="relationship-batch-members">{(expandedGroups.has(key) ? checks : checks.slice(0, 3)).map((check) => {
        const candidate = candidates.find((row) => row.key === check.entry.key);
        return <label className="relationship-batch-member" key={check.entry.key}><input type="checkbox" aria-label={bt("business.include", { value0: mapping(check) })} disabled={saving} checked={included.has(check.entry.key)} onChange={() => toggleIncluded(check.entry.key, key)} /><span><code>{check.entry.source?.schema}.{check.entry.source?.table}.{check.entry.source?.columns.join(",")}</code><small>{candidate ? `${candidate.sourceColumn.formattedType} → ${candidate.targetColumn.formattedType} · ` : ""}{translateUiLabel(relationshipCardinalityLabel(check.cardinality), bt)}{candidate?.sourceColumn.comment || candidate?.sourceTable.comment ? ` · ${candidate.sourceColumn.comment || candidate.sourceTable.comment}` : ""}</small></span></label>;
      })}</div>
      {checks.length > 3 ? <button className="relationship-batch-expand" disabled={saving} onClick={() => setExpandedGroups((current) => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next; })}>{expandedGroups.has(key) ? bt("business.showFewerMappings") : bt("business.showAllMappings", { value0: checks.length })}</button> : null}
      <label className="relationship-check"><input type="checkbox" checked={reviewed.has(key)} disabled={saving || !checks.some((check) => included.has(check.entry.key))} onChange={(event) => setReviewed((current) => { const next = new Set(current); if (event.target.checked) next.add(key); else next.delete(key); return next; })} />{bt("business.iCheckedTheBusinessMeaningOfThisGroup")}</label>
    </section>)}
    {blocked.length ? <section className="relationship-batch-blocked"><h3>{bt("business.keepForIndividualReview")} {blocked.length}</h3>{blocked.map((check) => <div key={check.entry.key}><code>{mapping(check)}</code><p>{check.reason}</p><button disabled={saving} onClick={() => onReview(check.entry.key)}>{bt("business.reviewIndividually")}</button></div>)}</section> : null}
    {error ? <div role="alert" className="relationship-error"><p>{error}</p><button disabled={saving} onClick={() => { setPreview(undefined); setReviewed(new Set()); setIncluded(new Set()); setError(""); setRetry((value) => value + 1); }}>{bt("business.refreshPreview")}</button></div> : null}
    <footer className="relationship-editor-footer"><button disabled={!ready || saving} className="ds-primary" onClick={() => void confirm()}>{saving ? bt("business.confirming") : bt("business.confirmRelationships", { value0: included.size })}</button></footer>
  </section>;
}

export function RelationshipBatchHistory({ api, sourceId, onBack, onUndone, onStateChange }: {
  api: RelationshipBatchApi; sourceId: string; onBack: () => void; onUndone: (batch: ReviewBatch) => void; onStateChange: (state: { dirty: boolean; saving: boolean }) => void;
}) {
  const { t: bt, formatDate } = useI18n();
  const [batches, setBatches] = useState<ReviewBatch[]>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const pending = useRef(false);
  useUpdateBlocker(bt("business.waitForBatchUndo"), busy);
  useEffect(() => { onStateChange({ dirty: false, saving: busy }); }, [busy, onStateChange]);
  useEffect(() => { let active = true; void api.list(sourceId).then((value) => { if (active) { setBatches(value); setError(""); } }).catch((reason: unknown) => { if (active) setError(String(reason)); }); return () => { active = false; }; }, [api, sourceId, reload]);
  async function undo(batch: ReviewBatch) {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError("");
    try { const result = await api.undo(sourceId, batch.id); setBatches((current) => current?.map((row) => row.id === result.id ? result : row)); onUndone(result); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { pending.current = false; setBusy(false); }
  }
  return <section aria-label={bt("business.reviewBatchHistory")}><div className="relationship-detail-heading"><div><h3>{bt("business.reviewBatches")}</h3><p>{bt("business.storedOnThisDeviceUndoPreservesSubsequentEdits")}</p></div><button disabled={busy} onClick={onBack}>{bt("business.back")}</button></div>
    {!batches && !error ? <p role="status">{bt("business.loadingBatches")}</p> : null}
    {batches?.length === 0 ? <p>{bt("business.noReviewBatchesYet")}</p> : null}
    {batches?.map((batch) => <article className="relationship-batch-group" key={batch.id}><strong>{translateUiLabel(batchActionLabels[batch.action], bt)} {batch.keys.length} {bt("business.candidatesDetail")}</strong><span className="relationship-row-schema">{formatDate(batch.createdAt)}</span><details><summary>{bt("business.viewAffectedMappings")}</summary>{batch.keys.map((key) => <code className="relationship-batch-key" key={key}>{key}</code>)}</details>
      {batch.undoneAt ? <p>{batch.skippedKeys.length ? bt("business.undonePreservedSubsequentlyChangedItems", { value0: batch.keys.length - batch.skippedKeys.length, value1: batch.skippedKeys.length }) : bt("business.batchUndone")}</p> : <button disabled={busy} onClick={() => void undo(batch)}>{bt("business.undoBatch")}</button>}
      {batch.skippedKeys.length ? <details><summary>{bt("business.itemsPreserved")}</summary>{batch.skippedKeys.map((key) => <code className="relationship-batch-key" key={key}>{key}</code>)}</details> : null}
    </article>)}
    {error ? <div role="alert"><p>{error}</p><button disabled={busy} onClick={() => setReload((value) => value + 1)}>{bt("business.retry")}</button></div> : null}
  </section>;
}
