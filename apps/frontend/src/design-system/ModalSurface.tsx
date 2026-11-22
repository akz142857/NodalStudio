import { useLayoutEffect, useRef, type ReactNode } from "react";

const focusable = 'button, input, select, textarea, a[href], summary, [contenteditable="true"], [tabindex]';
const nativeModal = typeof HTMLDialogElement !== "undefined" && typeof HTMLDialogElement.prototype.showModal === "function";

/** A top-layer dialog for workspace overlays, with keyboard behavior for DOM-only runtimes. */
export function ModalSurface({ children, label, labelledBy, describedBy, onDismiss }: {
  children: ReactNode;
  label?: string;
  labelledBy?: string;
  describedBy?: string;
  onDismiss: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const previous = document.activeElement;
    if (nativeModal) dialog.showModal();
    const initial = dialog.querySelector<HTMLElement>("[data-modal-focus]:not(:disabled)");
    if (initial) initial.focus({ preventScroll: true });
    else if (!nativeModal) dialog.focus({ preventScroll: true });
    return () => {
      const restore = dialog.contains(document.activeElement) || document.activeElement === document.body;
      if (nativeModal) dialog.close();
      if (restore && previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);

  return <dialog ref={ref} className="ds-modal-root" open={nativeModal ? undefined : true} tabIndex={nativeModal ? undefined : -1}
    aria-label={label} aria-labelledby={labelledBy} aria-describedby={describedBy} aria-modal="true"
    onCancel={(event) => { event.preventDefault(); onDismiss(); }}
    onKeyDown={(event) => {
      if (event.defaultPrevented || event.nativeEvent.isComposing) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onDismiss();
      } else if (!nativeModal && event.key === "Tab") {
        const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(focusable))
          .filter((element) => element.tabIndex >= 0 && !element.matches(":disabled") && !element.closest("[hidden], [inert]"));
        const index = controls.indexOf(document.activeElement as HTMLElement);
        const next = event.shiftKey ? (index <= 0 ? controls.at(-1) : undefined)
          : (index < 0 || index === controls.length - 1 ? controls[0] : undefined);
        if (next) { event.preventDefault(); next.focus(); }
      }
    }}>
    {children}
  </dialog>;
}
