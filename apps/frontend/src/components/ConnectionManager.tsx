import { EmptyState } from "../design-system/EmptyState";
import { Button } from "../design-system/Button";
import { useI18n } from "../i18n";
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
  const { t: bt } = useI18n();
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
  return createPortal(<dialog ref={dialog} className="ds-surface connection-manager" aria-labelledby="connection-manager-title"
    onContextMenu={(event) => event.stopPropagation()}
    onKeyDown={(event) => {
      event.stopPropagation();
      // WebKit's search input can consume Escape before native dialog cancel.
      if (event.key === "Escape") { event.preventDefault(); onClose(); }
    }}
    onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <h2 id="connection-manager-title">{bt("business.manageConnectionsDetail")}</h2>
    <input type="search" aria-label={bt("business.findDatabaseConnections")} placeholder={bt("business.findDatabases")} value={query} onChange={(event) => setQuery(event.target.value)} />
    <div className="connection-manager-list">
      {visible.map((profile) => <div className="connection-manager-row" key={profile.id}>
        <ActionIcon name="database" />
        <div><strong title={profile.displayName}>{profile.displayName}</strong><span title={profile.database}>{profile.database}{profile.id === activeSourceId ? bt("business.current") : ""}</span></div>
        <Button type="button" aria-label={bt("business.edit", { value0: profile.displayName })} onClick={() => leave(() => onEdit(profile))}>{bt("business.editDetail")}</Button>
        <Button type="button" aria-label={bt("business.open", { value0: profile.displayName })} onClick={() => leave(() => onOpen(profile))}>{bt("business.openDetail")}</Button>
      </div>)}
      {!visible.length ? <EmptyState compact title={profiles.length ? bt("business.noMatchingConnections") : bt("business.noSavedConnections")} /> : null}
    </div>
    <footer><Button type="button" onClick={() => leave(onCreate)}>{bt("business.addDatabaseDetail")}</Button><Button type="button" onClick={onClose}>{bt("business.done")}</Button></footer>
  </dialog>, document.body);
}
