import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";

/** A small, keyboard-accessible disclosure, constrained to its diagram toolbar. */
export function DiagramToolbarMenu({ label, title, disabled, children }: { label: string; title?: string; disabled?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null); const popup = useRef<HTMLDivElement>(null); const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  useLayoutEffect(() => {
    if (!open || !root.current || !popup.current) return;
    const rect = root.current.getBoundingClientRect(); const bounds = root.current.closest(".diagram-toolbar")?.getBoundingClientRect();
    if (bounds) {
      const scale = root.current.offsetWidth ? rect.width / root.current.offsetWidth || 1 : 1;
      const left = Math.max(bounds.left + 6, Math.min(rect.left, bounds.right - popup.current.getBoundingClientRect().width - 6));
      popup.current.style.left = `${(left - rect.left) / scale}px`;
      const bottom = root.current.closest(".schema-canvas-workspace")?.getBoundingClientRect().bottom ?? window.innerHeight;
      popup.current.style.maxHeight = `${Math.max(100, (Math.min(bottom, window.innerHeight) - rect.bottom - 12) / scale)}px`;
    }
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); setOpen(false); trigger.current?.focus(); } };
    const close = () => setOpen(false);
    document.addEventListener("pointerdown", outside); document.addEventListener("keydown", escape); window.addEventListener("resize", close);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); window.removeEventListener("resize", close); };
  }, [open]);
  return <div className="diagram-toolbar-menu" ref={root} onBlur={(event) => { if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
    <button ref={trigger} type="button" title={title} disabled={disabled} aria-expanded={open && !disabled} aria-controls={id} onClick={() => setOpen((value) => !value)}>{label} <span aria-hidden="true">▾</span></button>
    {open && !disabled ? <div className="diagram-toolbar-popover" id={id} ref={popup} role="group" aria-label={`${label} actions`}>{children}</div> : null}
  </div>;
}
