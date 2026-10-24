import { Button } from "../../design-system/Button";
import { useI18n } from "../../i18n";
import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { LogicalRelationship } from "../../platform";
import { RelationshipEndpoints } from "./RelationshipPresentation";
import "./relationships.css";

/** In-app confirmation works in the desktop WebView without window.confirm. */
export function RelationshipDeleteDialog({ relationship, onDelete, onDeleted, onCancel }: {
  relationship: LogicalRelationship;
  onDelete: () => Promise<void>;
  onDeleted: () => void;
  onCancel: () => void;
}) {
  const { t: bt } = useI18n();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const pending = useRef(false);
  const active = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useLayoutEffect(() => {
    active.current = true;
    const previous = document.activeElement;
    const dialog = dialogRef.current;
    dialog?.showModal();
    cancelRef.current?.focus();
    return () => {
      active.current = false;
      dialog?.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);

  async function remove() {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      await onDelete();
      if (active.current) onDeleted();
    } catch (reason) {
      if (active.current) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      pending.current = false;
      if (active.current) setBusy(false);
    }
  }

  return createPortal(<dialog ref={dialogRef} className="ds-surface relationship-delete-dialog" aria-labelledby="relationship-delete-title" aria-describedby="relationship-delete-description" aria-busy={busy} onKeyDown={(event) => event.stopPropagation()} onCancel={(event) => { event.preventDefault(); if (!pending.current) onCancel(); }}>
    <h2 id="relationship-delete-title">{bt("business.deleteModelRelationship")}</h2>
    <p id="relationship-delete-description">{bt("business.removesThisUserDefinedLinkFromTheModelDatabase")}</p>
    <p className="relationship-name">{relationship.name}</p>
    <RelationshipEndpoints source={relationship.source} target={relationship.target} />
    {error ? <p className="relationship-error" role="alert">{error}</p> : null}
    <footer><Button type="button" ref={cancelRef} disabled={busy} onClick={onCancel}>{bt("business.cancel")}</Button><Button type="button" variant="danger" className="relationship-delete-action" busy={busy} onClick={() => void remove()}>{busy ? bt("business.deleting") : bt("business.deleteRelationship")}</Button></footer>
  </dialog>, document.body);
}
