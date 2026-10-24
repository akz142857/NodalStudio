import { translateUiLabel } from "../../i18n/business-labels";
import { useI18n } from "../../i18n";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { DatabaseSnapshot, IgnoredRelationshipInference, LogicalRelationship, LogicalRelationshipStatus, SaveLogicalRelationshipInput } from "../../platform";
import { ActionIcon } from "../ActionIcon";
import { RelationshipEditor, type ValidateRelationship } from "./RelationshipEditor";
import { relationshipCardinalityLabel, relationshipStatusLabels } from "./relationship-labels";
import "./relationship-manager.css";
import { InferredRelationshipReview } from "./InferredRelationshipReview";
import { pendingCandidates, relationshipCandidates } from "./inferred-review";

const noIgnored: IgnoredRelationshipInference[] = [];

interface RelationshipManagerProps {
  open?: boolean;
  snapshot: DatabaseSnapshot;
  relationships: LogicalRelationship[];
  ignoredInferences?: IgnoredRelationshipInference[];
  reviewRequest?: { revision: number; candidateKey?: string };
  visibleTableIds?: string[];
  selectedTableId?: string;
  onIgnore?: (key: string) => Promise<void>;
  onRestore?: (key: string) => Promise<void>;
  batchApi?: import("../../platform/relationship-batches").RelationshipBatchApi;
  onSelect: (relationship: LogicalRelationship) => void;
  onValidate: ValidateRelationship;
  onSave: (input: SaveLogicalRelationshipInput) => Promise<LogicalRelationship>;
  onToggle?: (relationship: LogicalRelationship) => Promise<unknown>;
  onDelete?: (relationship: LogicalRelationship) => void;
  canEdit?: boolean;
  onClose: () => void;
}

type RelationshipFilter = "all" | "active" | "attention" | "disabled" | "physical";
const attentionStatuses = new Set<LogicalRelationshipStatus>(["orphaned", "conflicted"]);
const endpointText = (value: LogicalRelationship["source"]) => `${value.schema}.${value.table}.${value.columns.join(",")}`;
const cardinalitySymbols = { oneToOne: "1 : 1", oneToMany: "1 : N", manyToOne: "N : 1", manyToMany: "N : N", unspecified: "—" };

function Endpoint({ label, value }: { label: string; value: LogicalRelationship["source"] }) {
  return <div className="relationship-manager-endpoint"><span>{label} · {value.schema}</span><strong>{value.table}</strong><code>{value.columns.join(", ")}</code></div>;
}

export function RelationshipManager({ open = true, snapshot, relationships, ignoredInferences = noIgnored, reviewRequest, visibleTableIds, selectedTableId, onIgnore, onRestore, batchApi, onSelect, onValidate, onSave, onToggle, onDelete, canEdit = true, onClose }: RelationshipManagerProps) {
  const { t: bt } = useI18n();
  const [tab, setTab] = useState<"logical" | "inferred" | "ignored">(reviewRequest ? "inferred" : "logical");
  const [previousRequest, setPreviousRequest] = useState(reviewRequest);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<RelationshipFilter>("all");
  const [selectedId, setSelectedId] = useState<string>();
  const [editor, setEditor] = useState<{ relationship?: LogicalRelationship }>();
  const [editorState, setEditorState] = useState({ dirty: false, saving: false });
  const [pendingAction, setPendingAction] = useState<() => void>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const dialogRef = useRef<HTMLDialogElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const reviewEnabled = Boolean(onIgnore && onRestore);
  const inferred = useMemo(() => relationshipCandidates(snapshot, relationships), [snapshot, relationships]);
  const candidates = useMemo(() => pendingCandidates(inferred.available, ignoredInferences), [inferred, ignoredInferences]);
  if (reviewRequest !== previousRequest) { setPreviousRequest(reviewRequest); if (reviewRequest) { setTab("inferred"); setEditor(undefined); setEditorState({ dirty: false, saving: false }); } }
  const counts = useMemo(() => ({ all: relationships.length, active: relationships.filter((item) => item.status === "active").length,
    attention: relationships.filter((item) => attentionStatuses.has(item.status)).length, disabled: relationships.filter((item) => item.status === "disabled").length,
    physical: relationships.filter((item) => item.status === "supersededByPhysical").length }), [relationships]);
  const visibleRelationships = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return relationships.filter((relationship) => {
      if (filter === "active" && relationship.status !== "active") return false;
      if (filter === "attention" && !attentionStatuses.has(relationship.status)) return false;
      if (filter === "disabled" && relationship.status !== "disabled") return false;
      if (filter === "physical" && relationship.status !== "supersededByPhysical") return false;
      return !normalized || [relationship.name, endpointText(relationship.source), endpointText(relationship.target), relationship.note ?? ""].some((value) => value.toLocaleLowerCase().includes(normalized));
    }).sort((a, b) => Number(attentionStatuses.has(b.status)) - Number(attentionStatuses.has(a.status)) || endpointText(a.source).localeCompare(endpointText(b.source)));
  }, [filter, query, relationships]);
  const selected = relationships.find((item) => item.id === selectedId) ?? visibleRelationships[0];
  const locked = busy || editorState.saving;

  useLayoutEffect(() => {
    if (!open) return;
    const previous = document.activeElement;
    const dialog = dialogRef.current;
    dialog?.showModal();
    dialog?.querySelector<HTMLInputElement>('input[type="search"]')?.focus();
    return () => { dialog?.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, [open]);

  function requestAction(action: () => void) {
    if (locked) return;
    if (editorState.dirty) { setPendingAction(() => action); return; }
    action();
  }
  function closeEditor() { setEditor(undefined); setEditorState({ dirty: false, saving: false }); setPendingAction(undefined); }
  function close() { requestAction(() => { closeEditor(); onClose(); }); }
  function select(id: string) { requestAction(() => { closeEditor(); setSelectedId(id); setMessage(""); setError(""); }); }
  function edit(relationship?: LogicalRelationship) { requestAction(() => { setTab("logical"); setEditor({ relationship }); setEditorState({ dirty: false, saving: false }); setMessage(""); setError(""); }); }
  async function toggle(relationship: LogicalRelationship) {
    if (locked || !onToggle) return;
    setBusy(true); setSelectedId(relationship.id); setError(""); setMessage("");
    try { await onToggle(relationship); setMessage(relationship.status === "disabled" ? bt("business.relationshipEnabledInThisModel") : bt("business.relationshipDisabledInThisModel")); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }
  if (!open) return null;
  return createPortal(<dialog ref={dialogRef} className="relationship-manager nodrag nopan" aria-labelledby="logical-relationships-title" aria-describedby="logical-relationships-description" onCancel={(event) => { event.preventDefault(); close(); }} onKeyDown={(event) => event.stopPropagation()}>
    <header className="relationship-manager-header">
      <div><h2 id="logical-relationships-title">{bt("business.relationships")}</h2><p id="logical-relationships-description">{snapshot.database.name} {bt("business.localModelOnly")}</p></div>
      <button type="button" className={tab === "logical" ? "ds-primary" : undefined} disabled={locked || Boolean(editor && !editor.relationship)} onClick={() => edit()}>{bt("business.newRelationshipDetail")}</button>
      <button type="button" className="relationship-icon-button" aria-label={bt("business.closeRelationships")} disabled={locked} onClick={close}><ActionIcon name="close" /></button>
    </header>
    {reviewEnabled ? <nav className="relationship-manager-tabs" aria-label={bt("business.relationshipCategories")}>{(["logical", "inferred", "ignored"] as const).map((value) => <button type="button" key={value} aria-pressed={tab === value} disabled={locked} onClick={() => requestAction(() => { closeEditor(); setTab(value); })}>{value === "logical" ? bt("business.logical", { value0: relationships.length }) : value === "inferred" ? bt("business.inferred", { value0: candidates.length }) : bt("business.ignoredDetailDetail", { value0: ignoredInferences.length })}</button>)}</nav> : null}
    {tab === "logical" ? <div className="relationship-manager-tools">
      <label className="relationship-manager-search"><ActionIcon name="search" /><input ref={searchRef} aria-label={bt("business.searchRelationships")} type="search" value={query} disabled={Boolean(editor) || locked} onChange={(event) => { setQuery(event.target.value); setSelectedId(undefined); }} placeholder={bt("business.searchTablesFieldsOrRelationships")} /></label>
      <select aria-label={bt("business.relationshipStatus")} value={filter} disabled={Boolean(editor) || locked} onChange={(event) => { setFilter(event.target.value as RelationshipFilter); setSelectedId(undefined); }}>
        <option value="all">{bt("business.allStatuses")} {counts.all}</option><option value="active">{bt("business.active")} {counts.active}</option><option value="attention">{bt("business.needsAttention")} {counts.attention}</option><option value="disabled">{bt("business.disabled")} {counts.disabled}</option>{counts.physical ? <option value="physical">{bt("business.physicalFKExists")} {counts.physical}</option> : null}
      </select>
    </div> : null}
    {pendingAction ? <div className="relationship-discard" role="alert"><span>{bt("business.discardUnsavedChanges")}</span><button type="button" onClick={() => setPendingAction(undefined)}>{bt("business.keepEditing")}</button><button type="button" onClick={() => { const action = pendingAction; closeEditor(); action(); }}>{bt("business.discardChanges")}</button></div> : null}
    {tab !== "logical" && onIgnore && onRestore ? <InferredRelationshipReview key={`${snapshot.id}:${tab}:${reviewRequest?.revision ?? 0}`} snapshot={snapshot} tab={tab} candidates={candidates} allCandidates={inferred.all} ignored={ignoredInferences}
      initialCandidateKey={reviewRequest?.candidateKey} visibleTableIds={visibleTableIds} selectedTableId={selectedTableId} onValidate={onValidate} onSave={onSave} onIgnore={onIgnore} onRestore={onRestore} batchApi={batchApi} onNavigate={requestAction} onStateChange={setEditorState} /> : <div className="relationship-manager-body">
      <nav className="relationship-manager-list" aria-label={bt("business.logicalRelationships")}>
        {visibleRelationships.map((relationship) => <button type="button" className="relationship-manager-row" key={relationship.id} data-status={relationship.status} disabled={locked} aria-pressed={(editor ? editor.relationship?.id : selected?.id) === relationship.id} onClick={() => select(relationship.id)}>
          <strong>{relationship.source.table} <span aria-hidden="true">→</span> {relationship.target.table}</strong><code>{relationship.source.columns.join(", ")} → {relationship.target.columns.join(", ")}</code>
          <span className="relationship-row-schema">{relationship.source.schema}{relationship.source.schema !== relationship.target.schema ? ` → ${relationship.target.schema}` : ""}</span>
          <span className="relationship-row-meta"><span aria-label={translateUiLabel(relationshipCardinalityLabel(relationship.cardinality), bt)}>{cardinalitySymbols[relationship.cardinality]}</span><span className="relationship-status-badge">{translateUiLabel(relationshipStatusLabels[relationship.status], bt)}</span></span>
        </button>)}
        {!visibleRelationships.length ? <div className="relationship-manager-empty"><strong>{relationships.length ? bt("business.noMatchingRelationships") : bt("business.noLogicalRelationshipsYet")}</strong><p>{relationships.length ? bt("business.tryAnotherTableFieldOrStatus") : bt("business.createARelationshipHereOrDragBetweenFieldsOn")}</p>{query || filter !== "all" ? <button type="button" disabled={Boolean(editor)} onClick={() => { setQuery(""); setFilter("all"); setSelectedId(undefined); }}>{bt("business.clearFilters")}</button> : null}</div> : null}
      </nav>
      <div className="relationship-manager-detail">
        {editor ? <RelationshipEditor key={editor.relationship?.id ?? "new"} snapshot={snapshot} relationship={editor.relationship} onValidate={onValidate} onSave={onSave} onStateChange={setEditorState}
          onCancel={() => requestAction(closeEditor)} onSaved={(saved) => { const created = !editor.relationship; closeEditor(); setSelectedId(saved.id); setMessage(created ? bt("business.relationshipCreatedInThisModel") : bt("business.relationshipSaved")); if (created) { setQuery(""); setFilter("all"); } }} />
          : selected ? <section aria-label={bt("business.relationshipDetails")} key={selected.id}>
            <div className="relationship-detail-heading"><div><h3>{selected.source.table} → {selected.target.table}</h3><p>{translateUiLabel(relationshipCardinalityLabel(selected.cardinality), bt)} · {translateUiLabel(relationshipStatusLabels[selected.status], bt)}</p></div>{canEdit ? <button type="button" className="ds-primary" disabled={locked} onClick={() => edit(selected)}>{selected.status === "orphaned" ? bt("business.repairMapping") : selected.status === "conflicted" ? bt("business.reviewMapping") : bt("business.editDetailDetail")}</button> : null}</div>
            {selected.status === "orphaned" ? <p className="relationship-attention">{bt("business.aTableOrFieldNoLongerExistsInThis")}</p> : selected.status === "conflicted" ? <p className="relationship-attention">{bt("business.theMappedFieldTypesNeedReviewEditTheMapping")}</p> : selected.status === "supersededByPhysical" ? <p className="relationship-detail-note">{bt("business.aDatabaseForeignKeyAlreadyCoversThisLinkYou")}</p> : null}
            <div className="relationship-manager-endpoints"><Endpoint label={bt("business.sourceDetail")} value={selected.source} /><div className="relationship-manager-arrow"><span>{cardinalitySymbols[selected.cardinality]}</span><span aria-hidden="true">↓</span></div><Endpoint label={bt("business.target")} value={selected.target} /></div>
            {selected.source.columns.length > 1 ? <div className="relationship-pair-summary" aria-label={bt("business.fieldMappings")}>{selected.source.columns.map((name, index) => <code key={name}>{name} → {selected.target.columns[index] ?? bt("business.missingField")}</code>)}</div> : null}
            {selected.note ? <p className="relationship-detail-note">{selected.note}</p> : null}
            {onToggle && ["active", "disabled", "conflicted"].includes(selected.status) ? <label className="relationship-check"><input type="checkbox" checked={selected.status !== "disabled"} disabled={locked} onChange={() => void toggle(selected)} />{bt("business.enabledInThisModel")}</label> : null}
            <details className="relationship-metadata"><summary>{bt("business.nameAndSource")}</summary><code>{selected.name}</code><span>{selected.origin === "confirmedInference" ? bt("business.confirmedInference") : selected.origin === "imported" ? bt("business.imported") : bt("business.manual")}</span>{selected.evidence.length ? <ul>{selected.evidence.map((evidence, index) => <li key={index}>{translateUiLabel(evidence, bt)}</li>)}</ul> : null}</details>
            <div className="relationship-detail-actions"><button type="button" disabled={locked || selected.status === "orphaned"} onClick={() => onSelect(selected)}><ActionIcon name="fit" />{bt("business.showOnCanvas")}</button>{onDelete ? <details className="relationship-more"><summary aria-label={bt("business.moreRelationshipActions")}><ActionIcon name="more" /></summary><div><button type="button" className="danger" disabled={locked} onClick={() => onDelete(selected)}>{bt("business.deleteRelationshipDetail")}</button></div></details> : null}</div>
          </section> : <div className="relationship-manager-empty"><ActionIcon name="relationships" /><strong>{bt("business.connectTheMeaningBehindYourTables")}</strong><p>{bt("business.selectARelationshipToViewItsFieldsOrCreate")}</p><button type="button" className="ds-primary" onClick={() => edit()}>{bt("business.createRelationship")}</button></div>}
        {error ? <p className="relationship-error" role="alert">{error}</p> : null}
        {message && relationships.some((item) => item.id === selectedId) ? <p className="relationship-manager-message" role="status">{message}</p> : null}
      </div>
    </div>}
  </dialog>, document.body);
}
