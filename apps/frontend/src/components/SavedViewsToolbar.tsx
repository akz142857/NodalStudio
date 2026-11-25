import { useI18n } from "../i18n";
import { useRef, useState, type ReactNode } from "react";
import { ActionIcon } from "./ActionIcon";
import { DiagramToolbarMenu } from "./DiagramToolbarMenu";
import { DeleteSavedViewDialog, SavedViewDialog } from "./SavedViewDialog";
import type { CanvasLayout, DatabaseSnapshot, ObjectKey, SavedView, SaveViewInput } from "../platform/types";
import { tableKeyIdentity } from "../graph/table-selection";

export interface SavedViewControls {
  picker: ReactNode;
  menu: ReactNode;
  createAction: ReactNode;
  selectionCreateAction: ReactNode;
  notice: ReactNode;
}

export interface SavedViewsToolbarProps {
  children?: (controls: SavedViewControls) => ReactNode;
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

type ViewAction = "create" | "edit" | "copy";
type Draft = { action: ViewAction; id: string; name: string; keys: ObjectKey[]; depth: number; positions?: CanvasLayout["positions"]; viewport?: CanvasLayout["viewport"] };

export function SavedViewsToolbar({ snapshot, views, activeView, selectedKeys, positions, viewport, layouts, disabled, onApply, onSave, onDelete, children }: SavedViewsToolbarProps) {
  const { t: bt } = useI18n();
  const root = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<Draft>();
  const [memberQuery, setMemberQuery] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const view = views.find((item) => item.id === activeView?.id && item.sourceId === snapshot.sourceId);
  const tables = snapshot.schemas.flatMap((schema) => schema.tables.map((table) => table.key));
  const known = new Set(tables.map(tableKeyIdentity));
  const members = draft ? [...tables, ...draft.keys.filter((key) => !known.has(tableKeyIdentity(key)))] : [];
  const visibleMembers = members.filter((key) => `${key.schema}.${key.name}`.toLowerCase().includes(memberQuery.toLowerCase()));
  const missingCount = view?.rootTableKeys.filter((key) => !known.has(tableKeyIdentity(key))).length ?? 0;
  function begin(action: ViewAction) {
    setError(""); setDeleting(false); setMemberQuery("");
    if (action === "create") {
      setDraft({ action, id: crypto.randomUUID(), name: "", keys: selectedKeys, depth: 0, positions });
    } else if (view) {
      const layout = layouts?.find((item) => item.viewId === view.id);
      setDraft({ action, id: action === "copy" ? crypto.randomUUID() : view.id, name: action === "copy" ? bt("business.copy", { value0: view.name }) : view.name, keys: view.rootTableKeys, depth: view.relationshipDepth,
        ...(action === "copy" ? { positions: layout?.positions ?? positions, viewport: layout?.viewport ?? viewport } : {}) });
    }
  }
  async function save() {
    if (!draft || busy || disabled || !draft.name.trim() || !draft.keys.length) return;
    setBusy(true); setError("");
    try {
      let initialPositions = draft.positions;
      if (draft.action === "create" && initialPositions) {
        const memberIds = new Set(draft.keys.map((key) => `${key.schema}.${key.name}`));
        initialPositions = Object.fromEntries(Object.entries(initialPositions).filter(([id]) => memberIds.has(id)));
      }
      const result = await onSave({ id: draft.id, sourceId: snapshot.sourceId, snapshotId: snapshot.id, name: draft.name.trim(), rootTableKeys: draft.keys, relationshipDepth: draft.depth, positions: initialPositions, viewport: draft.viewport });
      setDraft(undefined); onApply(result);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }
  const picker = <select aria-label={bt("business.modelView")} value={view?.id ?? (activeView?.id.startsWith("domain:") ? activeView.id : "")} disabled={busy || disabled} onChange={(event) => { setDraft(undefined); setDeleting(false); setError(""); onApply(views.find((item) => item.id === event.target.value && item.sourceId === snapshot.sourceId)); }}>
      <option value="">{bt("business.fullModel")}</option>
      {activeView?.id.startsWith("domain:") ? <option value={activeView.id} disabled>{activeView.name}</option> : null}
      {views.filter((item) => item.sourceId === snapshot.sourceId).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
    </select>;
  const menu = view ? <DiagramToolbarMenu label={bt("business.viewActions")} icon="more" title={bt("business.viewActions")} disabled={disabled || busy} closeOnAction>
      <button type="button" aria-label={bt("business.editView")} onClick={() => begin("edit")}>{bt("business.editViewDetail")}</button>
      <button type="button" aria-label={bt("business.duplicateView")} onClick={() => begin("copy")}>{bt("business.duplicateViewDetail")}</button>
      <hr />
      <button type="button" className="workspace-destructive" aria-label={bt("business.deleteView")} onClick={() => { setDraft(undefined); setDeleting(true); setError(""); }}>{bt("business.deleteViewDetail")}</button>
    </DiagramToolbarMenu> : null;
  const createViewButton = (className: string) => selectedKeys.length ? <button className={className}
    type="button" aria-label={bt("business.saveSelectionAsView")} title={bt("business.saveAsView")} disabled={disabled || busy} onClick={(event) => {
    event.currentTarget.focus();
    begin("create");
  }}><ActionIcon name="floppyDisk" /><span>{bt("business.saveAsView")}</span></button> : null;
  const createAction = createViewButton("create-view-action");
  const notice = missingCount || view?.relationshipDepth ? <div className="workspace-view-notice" role="status">
    {view?.relationshipDepth ? <span>{bt("business.relationshipView")} {view.relationshipDepth} {bt("business.hops")}</span> : null}
    {missingCount ? <span>{missingCount} {bt("business.membersUnavailableInThisSnapshotTheirReferencesArePreserved")}</span> : null}
  </div> : null;
  const close = () => { setDraft(undefined); setError(""); };
  const focusViewActions = () => root.current?.querySelector<HTMLButtonElement>(".diagram-toolbar-menu > button")?.focus();
  return <div className="saved-views-controller" ref={root}>
    {children ? children({ picker, menu, createAction, selectionCreateAction: createViewButton("selection-save-button"), notice }) : <section className="saved-views-toolbar" aria-label={bt("business.savedModelViews")}>{picker}{menu}{createAction}{notice}</section>}
    {draft ? <SavedViewDialog label={bt("business.savedView")} busy={busy} onClose={close} returnFocus={focusViewActions}>
    <form className="saved-view-editor" aria-label={bt("business.editSavedModelView")} onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <h2>{draft.action === "edit" ? bt("business.editView") : bt("business.saveAModelView")}</h2>
      <label>{bt("business.viewName")} <input aria-label={bt("business.viewName")} value={draft.name} disabled={busy} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
      <p>{draft.depth ? bt("business.legacyRelationshipViewTheseRootsExpandByHopsEditing", { value0: draft.depth }) : bt("business.onlyCheckedTablesBelongToThisViewRefreshingDoes")}</p>
      <label className="saved-view-member-search"><input type="search" aria-label={bt("business.findViewMembers")} placeholder={bt("business.findTables")} value={memberQuery} disabled={busy} onChange={(event) => setMemberQuery(event.target.value)} /><span>{draft.keys.length} {bt("businessExtra.selected")}</span></label>
      <div className="saved-view-members" role="group" aria-label={bt("business.viewMembers")}>{visibleMembers.map((key) => <label key={tableKeyIdentity(key)}>
        <input type="checkbox" disabled={busy} checked={draft.keys.some((item) => tableKeyIdentity(item) === tableKeyIdentity(key))} onChange={(event) => setDraft({ ...draft, keys: event.target.checked ? [...draft.keys, key] : draft.keys.filter((item) => tableKeyIdentity(item) !== tableKeyIdentity(key)) })} />
        {key.schema}.{key.name}{known.has(tableKeyIdentity(key)) ? "" : bt("business.unavailablePreserved")}
      </label>)}{!visibleMembers.length ? <p>{bt("business.noTablesMatchYourSearch")}</p> : null}</div>
      <footer className="saved-view-dialog-actions"><button type="button" disabled={busy} onClick={close}>{bt("business.cancel")}</button>
      <button type="submit" disabled={disabled || busy || !draft.name.trim() || !draft.keys.length}>{busy ? bt("business.saving") : bt("business.saveView")}</button></footer>
    </form>
    {error ? <p role="alert">{error} {bt("business.yourEditsArePreservedRetrySaving")}</p> : null}
    </SavedViewDialog> : null}
    {deleting && view ? <DeleteSavedViewDialog view={view} disabled={disabled} onDelete={onDelete} onClose={() => setDeleting(false)} returnFocus={focusViewActions} /> : null}
  </div>;
}
