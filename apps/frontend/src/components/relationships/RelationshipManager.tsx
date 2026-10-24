import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { DatabaseSnapshot, LogicalRelationship, LogicalRelationshipStatus, SaveLogicalRelationshipInput } from "../../platform";
import { ActionIcon } from "../ActionIcon";
import { RelationshipEditor, type ValidateRelationship } from "./RelationshipEditor";
import { relationshipCardinalityLabel, relationshipStatusLabels } from "./relationship-labels";
import "./relationship-manager.css";

interface RelationshipManagerProps {
  open?: boolean;
  snapshot: DatabaseSnapshot;
  relationships: LogicalRelationship[];
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

export function RelationshipManager({ open = true, snapshot, relationships, onSelect, onValidate, onSave, onToggle, onDelete, canEdit = true, onClose }: RelationshipManagerProps) {
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
    searchRef.current?.focus();
    return () => { dialog?.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, [open]);

  function requestAction(action: () => void) {
    if (locked) return;
    if (editor && editorState.dirty) { setPendingAction(() => action); return; }
    action();
  }
  function closeEditor() { setEditor(undefined); setEditorState({ dirty: false, saving: false }); setPendingAction(undefined); }
  function close() { requestAction(() => { closeEditor(); onClose(); }); }
  function select(id: string) { requestAction(() => { closeEditor(); setSelectedId(id); setMessage(""); setError(""); }); }
  function edit(relationship?: LogicalRelationship) { requestAction(() => { setEditor({ relationship }); setEditorState({ dirty: false, saving: false }); setMessage(""); setError(""); }); }
  async function toggle(relationship: LogicalRelationship) {
    if (locked || !onToggle) return;
    setBusy(true); setSelectedId(relationship.id); setError(""); setMessage("");
    try { await onToggle(relationship); setMessage(relationship.status === "disabled" ? "Relationship enabled in this model." : "Relationship disabled in this model."); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }
  if (!open) return null;
  return createPortal(<dialog ref={dialogRef} className="relationship-manager nodrag nopan" aria-labelledby="logical-relationships-title" aria-describedby="logical-relationships-description" onCancel={(event) => { event.preventDefault(); close(); }} onKeyDown={(event) => event.stopPropagation()}>
    <header className="relationship-manager-header">
      <div><h2 id="logical-relationships-title">Logical relationships</h2><p id="logical-relationships-description">{snapshot.database.name} · {relationships.length} relationships · Local model only</p></div>
      <button type="button" className="ds-primary" disabled={locked || Boolean(editor && !editor.relationship)} onClick={() => edit()}>＋ New relationship</button>
      <button type="button" className="relationship-icon-button" aria-label="Close logical relationships" disabled={locked} onClick={close}><ActionIcon name="close" /></button>
    </header>
    <div className="relationship-manager-tools">
      <label className="relationship-manager-search"><ActionIcon name="search" /><input ref={searchRef} aria-label="Search relationships" type="search" value={query} disabled={Boolean(editor) || locked} onChange={(event) => { setQuery(event.target.value); setSelectedId(undefined); }} placeholder="Search tables, fields, or relationships…" /></label>
      <select aria-label="Relationship status" value={filter} disabled={Boolean(editor) || locked} onChange={(event) => { setFilter(event.target.value as RelationshipFilter); setSelectedId(undefined); }}>
        <option value="all">All statuses · {counts.all}</option><option value="active">Active · {counts.active}</option><option value="attention">Needs attention · {counts.attention}</option><option value="disabled">Disabled · {counts.disabled}</option>{counts.physical ? <option value="physical">Physical FK exists · {counts.physical}</option> : null}
      </select>
    </div>
    {pendingAction ? <div className="relationship-discard" role="alert"><span>Discard unsaved changes?</span><button type="button" onClick={() => setPendingAction(undefined)}>Keep editing</button><button type="button" onClick={() => { const action = pendingAction; closeEditor(); action(); }}>Discard changes</button></div> : null}
    <div className="relationship-manager-body">
      <nav className="relationship-manager-list" aria-label="Logical relationships">
        {visibleRelationships.map((relationship) => <button type="button" className="relationship-manager-row" key={relationship.id} data-status={relationship.status} disabled={locked} aria-pressed={(editor ? editor.relationship?.id : selected?.id) === relationship.id} onClick={() => select(relationship.id)}>
          <strong>{relationship.source.table} <span aria-hidden="true">→</span> {relationship.target.table}</strong><code>{relationship.source.columns.join(", ")} → {relationship.target.columns.join(", ")}</code>
          <span className="relationship-row-schema">{relationship.source.schema}{relationship.source.schema !== relationship.target.schema ? ` → ${relationship.target.schema}` : ""}</span>
          <span className="relationship-row-meta"><span aria-label={relationshipCardinalityLabel(relationship.cardinality)}>{cardinalitySymbols[relationship.cardinality]}</span><span className="relationship-status-badge">{relationshipStatusLabels[relationship.status]}</span></span>
        </button>)}
        {!visibleRelationships.length ? <div className="relationship-manager-empty"><strong>{relationships.length ? "No matching relationships" : "No logical relationships yet"}</strong><p>{relationships.length ? "Try another table, field, or status." : "Create a relationship here or drag between fields on the canvas."}</p>{query || filter !== "all" ? <button type="button" disabled={Boolean(editor)} onClick={() => { setQuery(""); setFilter("all"); setSelectedId(undefined); }}>Clear filters</button> : null}</div> : null}
      </nav>
      <div className="relationship-manager-detail">
        {editor ? <RelationshipEditor key={editor.relationship?.id ?? "new"} snapshot={snapshot} relationship={editor.relationship} onValidate={onValidate} onSave={onSave} onStateChange={setEditorState}
          onCancel={() => requestAction(closeEditor)} onSaved={(saved) => { const created = !editor.relationship; closeEditor(); setSelectedId(saved.id); setMessage(created ? "Relationship created in this model." : "Relationship saved."); if (created) { setQuery(""); setFilter("all"); } }} />
          : selected ? <section aria-label="Relationship details" key={selected.id}>
            <div className="relationship-detail-heading"><div><h3>{selected.source.table} → {selected.target.table}</h3><p>{relationshipCardinalityLabel(selected.cardinality)} · {relationshipStatusLabels[selected.status]}</p></div>{canEdit ? <button type="button" className="ds-primary" disabled={locked} onClick={() => edit(selected)}>{selected.status === "orphaned" ? "Repair mapping" : selected.status === "conflicted" ? "Review mapping" : "Edit"}</button> : null}</div>
            {selected.status === "orphaned" ? <p className="relationship-attention">A table or field no longer exists in this snapshot. Choose its replacement to repair the mapping.</p> : selected.status === "conflicted" ? <p className="relationship-attention">The mapped field types need review. Edit the mapping or explicitly accept the mismatch.</p> : selected.status === "supersededByPhysical" ? <p className="relationship-detail-note">A database foreign key already covers this link. You can remove the redundant model relationship.</p> : null}
            <div className="relationship-manager-endpoints"><Endpoint label="Source" value={selected.source} /><div className="relationship-manager-arrow"><span>{cardinalitySymbols[selected.cardinality]}</span><span aria-hidden="true">↓</span></div><Endpoint label="Target" value={selected.target} /></div>
            {selected.source.columns.length > 1 ? <div className="relationship-pair-summary" aria-label="Field mappings">{selected.source.columns.map((name, index) => <code key={name}>{name} → {selected.target.columns[index] ?? "Missing field"}</code>)}</div> : null}
            {selected.note ? <p className="relationship-detail-note">{selected.note}</p> : null}
            {onToggle && ["active", "disabled", "conflicted"].includes(selected.status) ? <label className="relationship-check"><input type="checkbox" checked={selected.status !== "disabled"} disabled={locked} onChange={() => void toggle(selected)} />Enabled in this model</label> : null}
            <details className="relationship-metadata"><summary>Name and source</summary><code>{selected.name}</code><span>{selected.origin === "confirmedInference" ? "Confirmed inference" : selected.origin === "imported" ? "Imported" : "Manual"}</span>{selected.evidence.length ? <ul>{selected.evidence.map((evidence, index) => <li key={index}>{evidence}</li>)}</ul> : null}</details>
            <div className="relationship-detail-actions"><button type="button" disabled={locked || selected.status === "orphaned"} onClick={() => onSelect(selected)}><ActionIcon name="fit" />Show on canvas</button>{onDelete ? <details className="relationship-more"><summary aria-label="More relationship actions"><ActionIcon name="more" /></summary><div><button type="button" className="danger" disabled={locked} onClick={() => onDelete(selected)}>Delete relationship…</button></div></details> : null}</div>
          </section> : <div className="relationship-manager-empty"><ActionIcon name="relationships" /><strong>Connect the meaning behind your tables</strong><p>Select a relationship to view its fields, or create a new one.</p><button type="button" className="ds-primary" onClick={() => edit()}>Create relationship</button></div>}
        {error ? <p className="relationship-error" role="alert">{error}</p> : null}
        {message && relationships.some((item) => item.id === selectedId) ? <p className="relationship-manager-message" role="status">{message}</p> : null}
      </div>
    </div>
  </dialog>, document.body);
}
