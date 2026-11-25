import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../i18n";
import type { SavedView } from "../platform";
import "./saved-views.css";

export function SavedViewDialog({ children, label, busy, onClose, returnFocus }: {
  children: ReactNode;
  label: string;
  busy: boolean;
  onClose: () => void;
  returnFocus: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const restore = useRef(returnFocus);
  useEffect(() => {
    const element = dialog.current;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const fallback = restore.current;
    element?.showModal();
    element?.querySelector<HTMLElement>("input:not([type=checkbox]), button[data-cancel-delete]")?.focus();
    return () => {
      element?.close();
      if (previous?.isConnected && previous !== document.body) previous.focus();
      else fallback();
    };
  }, []);
  return createPortal(<dialog ref={dialog} className="saved-view-dialog" aria-label={label} aria-busy={busy}
    onKeyDown={(event) => event.stopPropagation()} onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>{children}</dialog>, document.body);
}

export function DeleteSavedViewDialog({ view, disabled, onDelete, onClose, returnFocus }: {
  view: SavedView;
  disabled?: boolean;
  onDelete: (id: string) => Promise<void>;
  onClose: () => void;
  returnFocus: () => void;
}) {
  const { t } = useI18n();
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const title = t("business.deleteSavedViewTitle", { name: view.name });

  async function remove() {
    if (disabled || pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      await onDelete(view.id);
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  return <SavedViewDialog label={title} busy={busy} onClose={onClose} returnFocus={returnFocus}>
    <div className="saved-view-editor">
      <h2>{title}</h2>
      <p>{t("business.deleteSavedViewDescription")}</p>
      {error ? <p role="alert">{error} {t("business.theViewIsStillAvailableRetryDeleting")}</p> : null}
      <footer className="saved-view-dialog-actions">
        <button type="button" data-cancel-delete disabled={busy} onClick={onClose}>{t("business.cancel")}</button>
        <button type="button" className="workspace-destructive" disabled={disabled || busy} onClick={() => void remove()}>{busy ? t("business.deleting") : t("business.confirmDeleteView")}</button>
      </footer>
    </div>
  </SavedViewDialog>;
}
