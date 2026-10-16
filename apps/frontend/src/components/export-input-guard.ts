import type { SyntheticEvent } from "react";

/** Pause canvas input without removing/recreating the visible accessibility
 * tree or toggling React Flow's per-node interaction subscriptions. */
export function guardExportInput(event: SyntheticEvent, busy: boolean) {
  if (!busy || (event.target instanceof Element && event.target.closest(".diagram-export-actions"))) return false;
  // Keep keyboard navigation out of the canvas available while it is busy.
  if (event.type === "keydown" && "key" in event && event.key === "Tab") return false;
  // React's wheel/touch-start listeners may be passive. Stopping capture prevents the
  // canvas zoom listener; don't try to cancel the browser's default scrolling.
  if (event.type !== "wheel" && event.type !== "touchstart") event.preventDefault();
  event.stopPropagation();
  return true;
}
