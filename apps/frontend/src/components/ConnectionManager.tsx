import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { DataSourceProfile } from "../platform";
import { ActionIcon } from "./ActionIcon";

export function ConnectionManager({ profiles, activeSourceId, onClose, onCreate, onEdit, onOpen }: {
  profiles: DataSourceProfile[];
  activeSourceId?: string;
  onClose: () => void;
  onCreate: () => void;
  onEdit: (profile: DataSourceProfile) => void;
  onOpen: (profile: DataSourceProfile) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [query, setQuery] = useState("");
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const element = dialog.current;
    element?.showModal();
    element?.querySelector("input")?.focus();
    return () => {
      const active = document.activeElement;
      const restore = !active || active === document.body || element?.contains(active);
      element?.close();
      if (restore && previous?.isConnected) previous.focus();
    };
  }, []);
  // Remove modal inertness before mounting the existing connection editor,
  // so its initial focus can land on the form rather than the sidebar.
  function leave(action: () => void) { dialog.current?.close(); action(); }
  const visible = profiles.filter((profile) => `${profile.displayName} ${profile.database}`.toLowerCase().includes(query.trim().toLowerCase()));
  return createPortal(<dialog ref={dialog} className="connection-manager" aria-labelledby="connection-manager-title"
    onContextMenu={(event) => event.stopPropagation()}
    onKeyDown={(event) => event.stopPropagation()}
    onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <h2 id="connection-manager-title">Manage connections</h2>
    <input type="search" aria-label="Find database connections" placeholder="Find databases…" value={query} onChange={(event) => setQuery(event.target.value)} />
    <div className="connection-manager-list">
      {visible.map((profile) => <div className="connection-manager-row" key={profile.id}>
        <ActionIcon name="database" />
        <div><strong title={profile.displayName}>{profile.displayName}</strong><span title={profile.database}>{profile.database}{profile.id === activeSourceId ? " · Current" : ""}</span></div>
        <button type="button" aria-label={`Edit ${profile.displayName}`} onClick={() => leave(() => onEdit(profile))}>Edit…</button>
        <button type="button" aria-label={`Open ${profile.displayName}`} onClick={() => leave(() => onOpen(profile))}>Open</button>
      </div>)}
      {!visible.length ? <p>{profiles.length ? "No matching connections." : "No saved connections."}</p> : null}
    </div>
    <footer><button type="button" onClick={() => leave(onCreate)}>Add database…</button><button type="button" onClick={onClose}>Done</button></footer>
  </dialog>, document.body);
}
