import { useState } from "react";
import type { CanvasLayout, DatabaseSnapshot, ObjectKey, SavedView, SaveViewInput } from "../platform/types";
import { tableKeyIdentity } from "../graph/table-selection";
import "./saved-views.css";

export interface SavedViewsToolbarProps {
  snapshot: DatabaseSnapshot;
  views: SavedView[];
  activeView?: SavedView;
  selectedKeys: ObjectKey[];
  positions: CanvasLayout["positions"];
  viewport: CanvasLayout["viewport"];
  layouts?: CanvasLayout[];
  disabled?: boolean;
  onApply: (view: SavedView | undefined) => void;
  onSave: (input: SaveViewInput) => Promise<SavedView>;
  onDelete: (id: string) => Promise<void>;
}

type Draft = { id: string; name: string; keys: ObjectKey[]; depth: number; positions?: CanvasLayout["positions"]; viewport?: CanvasLayout["viewport"] };

export function SavedViewsToolbar({ snapshot, views, activeView, selectedKeys, positions, viewport, layouts, disabled, onApply, onSave, onDelete }: SavedViewsToolbarProps) {
  const [draft, setDraft] = useState<Draft>();
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const view = views.find((item) => item.id === activeView?.id && item.sourceId === snapshot.sourceId);
  const tables = snapshot.schemas.flatMap((schema) => schema.tables.map((table) => table.key));
  const known = new Set(tables.map(tableKeyIdentity));
  const members = draft ? [...tables, ...draft.keys.filter((key) => !known.has(tableKeyIdentity(key)))] : [];
  const missingCount = view?.rootTableKeys.filter((key) => !known.has(tableKeyIdentity(key))).length ?? 0;
  function begin(action: "create" | "edit" | "copy") {
    setError(""); setDeleting(false);
    if (action === "create") {
      const ids = new Set(selectedKeys.map((key) => `${key.schema}.${key.name}`));
      setDraft({ id: crypto.randomUUID(), name: "", keys: selectedKeys, depth: 0, positions: Object.fromEntries(Object.entries(positions).filter(([id]) => ids.has(id))) });
    } else if (view) {
      const layout = layouts?.find((item) => item.viewId === view.id);
      setDraft({ id: action === "copy" ? crypto.randomUUID() : view.id, name: action === "copy" ? `${view.name} copy` : view.name, keys: view.rootTableKeys, depth: view.relationshipDepth,
        ...(action === "copy" ? { positions: layout?.positions ?? positions, viewport: layout?.viewport ?? viewport } : {}) });
    }
  }
  async function save() {
    if (!draft || busy || disabled || !draft.name.trim() || !draft.keys.length) return;
    setBusy(true); setError("");
    try {
      const result = await onSave({ id: draft.id, sourceId: snapshot.sourceId, snapshotId: snapshot.id, name: draft.name.trim(), rootTableKeys: draft.keys, relationshipDepth: draft.depth, positions: draft.positions, viewport: draft.viewport });
      setDraft(undefined); onApply(result);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }
  async function remove() {
    if (!view || busy || disabled) return;
    setBusy(true); setError("");
    try { await onDelete(view.id); setDeleting(false); onApply(undefined); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }
  return <section className="saved-views-toolbar" aria-label="Saved model views">
    <label>View <select aria-label="Model view" value={view?.id ?? ""} disabled={busy || disabled} onChange={(event) => { setDraft(undefined); setDeleting(false); setError(""); onApply(views.find((item) => item.id === event.target.value)); }}>
      <option value="">Full model</option>
      {views.filter((item) => item.sourceId === snapshot.sourceId).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
    </select></label>
    <button type="button" disabled={disabled || busy || !selectedKeys.length} onClick={() => begin("create")}>Save selection as view</button>
    {view ? <><span>{view.relationshipDepth ? `${view.relationshipDepth}-hop relationship view` : `${view.rootTableKeys.length} explicit members`}</span>
      <button type="button" disabled={disabled || busy} onClick={() => begin("edit")}>Edit view</button>
      <button type="button" disabled={disabled || busy} onClick={() => begin("copy")}>Duplicate view</button>
      <button type="button" disabled={disabled || busy} onClick={() => { setDraft(undefined); setDeleting(true); setError(""); }}>Delete view</button></> : null}
    {missingCount ? <span role="status">{missingCount} members unavailable in this snapshot; their references are preserved.</span> : null}
    {draft ? <form className="saved-view-editor" aria-label="Edit saved model view" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <label>View name <input aria-label="View name" autoFocus value={draft.name} disabled={busy} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
      <p>{draft.depth ? `Legacy relationship view: these roots expand by ${draft.depth} hops. Editing preserves that behavior.` : "Only checked tables belong to this view. Refreshing does not add neighbors automatically."}</p>
      <div className="saved-view-members" role="group" aria-label="View members">{members.map((key) => <label key={tableKeyIdentity(key)}>
        <input type="checkbox" disabled={busy} checked={draft.keys.some((item) => tableKeyIdentity(item) === tableKeyIdentity(key))} onChange={(event) => setDraft({ ...draft, keys: event.target.checked ? [...draft.keys, key] : draft.keys.filter((item) => tableKeyIdentity(item) !== tableKeyIdentity(key)) })} />
        {key.schema}.{key.name}{known.has(tableKeyIdentity(key)) ? "" : " (unavailable; preserved)"}
      </label>)}</div>
      <button type="submit" disabled={disabled || busy || !draft.name.trim() || !draft.keys.length}>{busy ? "Saving…" : "Save view"}</button>
      <button type="button" disabled={busy} onClick={() => { setDraft(undefined); setError(""); }}>Cancel</button>
    </form> : null}
    {deleting && view ? <div className="saved-view-editor" role="alertdialog" aria-label="Delete saved view">
      <p>Delete “{view.name}” and its local layout? Tables, annotations and logical relationships are preserved. Exported or shared copies are unaffected.</p>
      <button type="button" disabled={disabled || busy} onClick={() => void remove()}>Confirm delete view</button>
      <button type="button" disabled={busy} onClick={() => setDeleting(false)}>Cancel</button>
    </div> : null}
    {error ? <p role="alert">{error} Your edits are preserved; retry saving.</p> : null}
  </section>;
}
