import { ActionIcon, type ActionIconName } from "./ActionIcon";
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";

/** A small, keyboard-accessible disclosure, constrained to its diagram toolbar. */
export function DiagramToolbarMenu({ label, title, disabled, children, icon, closeOnAction = false }: { label: string; title?: string; disabled?: boolean; children: ReactNode; icon?: ActionIconName; closeOnAction?: boolean }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null); const popup = useRef<HTMLDivElement>(null); const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  useLayoutEffect(() => {
    if (!open || !root.current || !popup.current) return;
    const rect = root.current.getBoundingClientRect(); const bounds = root.current.closest(".model-workspace-header, .workspace-selection-bar, .diagram-toolbar")?.getBoundingClientRect();
    if (bounds) {
      const scale = root.current.offsetWidth ? rect.width / root.current.offsetWidth || 1 : 1;
      const left = Math.max(bounds.left + 6, Math.min(rect.left, bounds.right - popup.current.getBoundingClientRect().width - 6));
      popup.current.style.left = `${(left - rect.left) / scale}px`;
      const workspace = root.current.closest(".schema-canvas-workspace")?.getBoundingClientRect();
      const available = root.current.closest(".workspace-selection-bar") ? rect.top - Math.max(0, workspace?.top ?? 0) - 80 : Math.min(workspace?.bottom ?? window.innerHeight, window.innerHeight) - rect.bottom - 12;
      popup.current.style.maxHeight = `${Math.max(100, available / scale)}px`;
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
    <button ref={trigger} type="button" title={title} disabled={disabled} aria-expanded={open && !disabled} aria-label={label} aria-controls={id} onKeyDown={(event) => { if (event.key === "ArrowDown") { event.preventDefault(); setOpen(true); requestAnimationFrame(() => popup.current?.querySelector<HTMLElement>("button:not(:disabled), select:not(:disabled)")?.focus()); } }} onClick={() => setOpen((value) => !value)}>{icon ? <ActionIcon name={icon} /> : <>{label} <span aria-hidden="true">▾</span></>}</button>
    {open && !disabled ? <div className="diagram-toolbar-popover" id={id} ref={popup} role="group" aria-label={`${label} actions`} onClick={(event) => { if (closeOnAction && event.target instanceof Element && event.target.closest("button:not(:disabled)")) { setOpen(false); trigger.current?.focus(); } }} onKeyDown={(event) => {
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) || event.target instanceof HTMLSelectElement || event.target instanceof HTMLInputElement) return;
      const items = [...(popup.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
      if (!items.length) return;
      event.preventDefault();
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      items[event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
    }}>{children}</div> : null}
  </div>;
}
