import { EmptyState } from "../design-system/EmptyState";
import { Button } from "../design-system/Button";
import { useI18n } from "../i18n";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { DataSourceProfile, NodalStudioPlatform } from "../platform";
import { ActionIcon } from "./ActionIcon";
import { ConnectionSync } from "./ConnectionSync";
import { connectionFailure } from "./connection-test-state";

export function ConnectionManager({ profiles, activeSourceId, pending, platform, startWithImport, onClose, onCreate, onEdit, onOpen, onDelete, onImported }: {
  profiles: DataSourceProfile[];
  activeSourceId?: string;
  pending: boolean;
  platform: NodalStudioPlatform;
  startWithImport: boolean;
  onClose: () => void;
  onCreate: () => void;
  onEdit: (profile: DataSourceProfile) => void;
  onOpen: (profile: DataSourceProfile) => void;
  onDelete: (profile: DataSourceProfile) => Promise<boolean>;
  onImported: (profiles: DataSourceProfile[]) => void;
}) {
  const { t: bt } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [deleteError, setDeleteError] = useState<string>();
  const [syncOpen, setSyncOpen] = useState(startWithImport);
  const [syncBusy, setSyncBusy] = useState(false);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const element = dialog.current;
    element?.showModal();
    return () => {
      const active = document.activeElement;
      const restore = !active || active === document.body || element?.contains(active);
      element?.close();
      if (restore && previous?.isConnected) previous.focus();
    };
  }, []);
  useEffect(() => { if (!syncOpen) search.current?.focus(); }, [syncOpen]);
  // Remove modal inertness before mounting the existing connection editor,
  // so its initial focus can land on the form rather than the sidebar.
  function leave(action: () => void) { dialog.current?.close(); action(); }
  function dismiss() {
    if (pending || syncBusy) return;
    if (syncOpen && !startWithImport) setSyncOpen(false);
    else onClose();
  }

  async function deleteConnection(profile: DataSourceProfile) {
    setDeleteError(undefined);
    try {
      if (await onDelete(profile)) search.current?.focus();
    } catch (reason) {
      setDeleteError(connectionFailure(reason).message);
    }
  }

  const visible = profiles.filter((profile) => `${profile.displayName} ${profile.database} ${profile.host}`.toLowerCase().includes(query.trim().toLowerCase()));
  return createPortal(<dialog ref={dialog} className={`ds-surface connection-manager${syncOpen ? " connection-sync-dialog" : ""}`} aria-labelledby="connection-manager-title" aria-busy={syncBusy || undefined}
    onContextMenu={(event) => event.stopPropagation()}
    onKeyDown={(event) => {
      event.stopPropagation();
      // WebKit's search input can consume Escape before native dialog cancel.
      if (event.key === "Escape") { event.preventDefault(); dismiss(); }
    }}
    onCancel={(event) => { event.preventDefault(); dismiss(); }}>
    {syncOpen ? <ConnectionSync platform={platform} hasProfiles={profiles.length > 0} startWithImport={startWithImport} busy={syncBusy} onBusyChange={setSyncBusy} onBack={() => setSyncOpen(false)} onImported={onImported} /> : <>
      <header className="connection-manager-heading">
        <h2 id="connection-manager-title">{bt("business.manageConnectionsDetail")}</h2>
        <Button variant="ghost" size="small" disabled={pending} onClick={() => setSyncOpen(true)}>{bt("connectionSync.open")}</Button>
      </header>
      <div className="connection-manager-tools">
        <div className="connection-manager-search">
          <ActionIcon name="search" />
          <input ref={search} type="search" aria-label={bt("business.findDatabaseConnections")} placeholder={bt("business.findDatabases")} value={query} onChange={(event) => setQuery(event.target.value)} />
        </div>
        <Button disabled={pending} onClick={() => leave(onCreate)}>
          <ActionIcon name="add" />
          {bt("business.addDatabaseDetail")}
        </Button>
      </div>
      <div className="connection-manager-list">
        {visible.map((profile) => {
          const pendingSetup = profile.connectionSync?.pending;
          const details = [profile.database, profile.host && `${profile.host}:${profile.port}`].filter(Boolean).join(" · ");
          return <div className="connection-manager-row" key={profile.id}>
            <ActionIcon name="database" />
            <div>
              <strong title={profile.displayName}>{profile.displayName}</strong>
              <span title={details}>{details}{profile.id === activeSourceId ? bt("business.current") : ""}</span>
              {pendingSetup ? <span>{bt("connectionSync.pendingSetup")}</span> : null}
            </div>
            <Button variant="danger" disabled={pending} aria-label={bt("business.deleteConnectionNamed", { value0: profile.displayName })} onClick={() => void deleteConnection(profile)}>{bt("business.deleteConnection")}</Button>
            <Button disabled={pending} aria-label={bt("business.edit", { value0: profile.displayName })} onClick={() => leave(() => onEdit(profile))}>{bt("business.editDetail")}</Button>
            {!pendingSetup ? <Button disabled={pending} aria-label={bt("business.open", { value0: profile.displayName })} onClick={() => leave(() => onOpen(profile))}>{bt("business.openDetail")}</Button> : null}
          </div>;
        })}
        {!visible.length ? <EmptyState compact title={profiles.length ? bt("business.noMatchingConnections") : bt("business.noSavedConnections")} /> : null}
      </div>
      {deleteError ? <p className="connection-manager-error" role="alert">{deleteError}</p> : null}
      <footer className="connection-manager-dismiss">
        <Button disabled={pending} onClick={dismiss}>{bt("business.close")}</Button>
      </footer>
    </>}
  </dialog>, document.body);
}
