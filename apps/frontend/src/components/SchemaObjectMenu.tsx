import { useI18n } from "../i18n";
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";

type MenuItem = { label: string; disabled?: boolean; separatorBefore?: boolean; run: () => void };
export type SchemaObjectMenuAction = MenuItem | { label: string; disabled?: boolean; separatorBefore?: boolean; children: MenuItem[] };

function items(menu: HTMLElement | null) {
  return Array.from(menu?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? []);
}

function place(menu: HTMLElement, x: number, y: number) {
  const scale = menu.offsetWidth ? menu.getBoundingClientRect().width / menu.offsetWidth || 1 : 1;
  menu.style.maxHeight = `${window.innerHeight / scale - 12}px`;
  menu.style.left = `${Math.max(6, Math.min(x / scale, window.innerWidth / scale - menu.offsetWidth - 6))}px`;
  menu.style.top = `${Math.max(6, Math.min(y / scale, window.innerHeight / scale - menu.offsetHeight - 6))}px`;
}

/** Object actions live outside the scrolling sidebar; all coordinates respect UI zoom. */
export function SchemaObjectMenu({ x, y, name, actions, onClose }: {
  x: number; y: number; name: string; actions: SchemaObjectMenuAction[]; onClose: (restoreFocus: boolean) => void;
}) {
  const { t: bt } = useI18n();
  const surface = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const sub = useRef<HTMLDivElement>(null);
  const [submenu, setSubmenu] = useState<{ label: string; trigger: HTMLButtonElement; focus: boolean }>();
  const current = actions.find((action) => action.label === submenu?.label);
  useLayoutEffect(() => {
    const menu = root.current;
    if (!menu) return;
    place(menu, x, y);
    (items(menu)[0] ?? menu).focus();
  }, [name, x, y]);
  useLayoutEffect(() => {
    const menu = sub.current;
    if (!menu || !submenu || !root.current) return;
    const anchor = submenu.trigger.getBoundingClientRect();
    const bounds = root.current.getBoundingClientRect();
    const width = menu.getBoundingClientRect().width;
    place(menu, bounds.right + width <= window.innerWidth ? bounds.right - 1 : bounds.left - width + 1, anchor.top);
    if (submenu.focus) (items(menu)[0] ?? menu).focus();
  }, [submenu]);
  useEffect(() => {
    const contains = (target: EventTarget | null) => target instanceof Node && surface.current?.contains(target);
    const outside = (event: PointerEvent) => { if (!contains(event.target)) onClose(false); };
    const dismiss = () => onClose(false);
    const scroll = (event: Event) => { if (!contains(event.target)) dismiss(); };
    document.addEventListener("pointerdown", outside);
    window.addEventListener("resize", dismiss);
    window.addEventListener("scroll", scroll, true);
    return () => { document.removeEventListener("pointerdown", outside); window.removeEventListener("resize", dismiss); window.removeEventListener("scroll", scroll, true); };
  }, [onClose]);
  function navigate(event: KeyboardEvent<HTMLDivElement>, inSubmenu = false) {
    const enabled = items(event.currentTarget);
    const index = enabled.indexOf(document.activeElement as HTMLButtonElement);
    const active = enabled[index];
    const key = event.key;
    if (inSubmenu && (key === "Escape" || key === "ArrowLeft")) {
      submenu?.trigger.focus();
      setSubmenu(undefined);
    } else if (key === "Escape" || key === "Tab") {
      onClose(true);
    } else if (key === "ArrowRight" && !inSubmenu && active?.dataset.submenu) {
      setSubmenu({ label: active.dataset.submenu, trigger: active, focus: true });
    } else if ((key === "Enter" || key === " ") && active) {
      active.click();
    } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(key)) {
      const next = key === "Home" ? 0 : key === "End" ? enabled.length - 1
        : (index + (key === "ArrowDown" ? 1 : -1) + enabled.length) % enabled.length;
      enabled[next]?.focus();
      if (!inSubmenu) setSubmenu(undefined);
    } else return;
    event.preventDefault();
    event.stopPropagation();
  }

  function renderActions(entries: SchemaObjectMenuAction[], inSubmenu = false) {
    return entries.map((action) => <Fragment key={action.label}>
      {action.separatorBefore ? <hr role="separator" /> : null}
      {"children" in action ? <button type="button" role="menuitem" disabled={action.disabled} aria-haspopup="menu"
        aria-expanded={submenu?.label === action.label} data-submenu={action.label}
        onClick={(event) => setSubmenu({ label: action.label, trigger: event.currentTarget, focus: true })}
        onPointerEnter={(event) => {
          if (!action.disabled && submenu?.label !== action.label) setSubmenu({ label: action.label, trigger: event.currentTarget, focus: false });
        }}>{action.label}<span className="schema-menu-chevron" aria-hidden="true">›</span></button>
        : <button type="button" role="menuitem" disabled={action.disabled}
          onPointerEnter={() => { if (!inSubmenu && !sub.current?.contains(document.activeElement)) setSubmenu(undefined); }}
          onClick={() => { onClose(true); action.run(); }}>{action.label}</button>}
    </Fragment>);
  }

  return createPortal(<div ref={surface} className="schema-menu-surface" onContextMenu={(event) => event.preventDefault()}>
    <div ref={root} className="schema-object-menu" role="menu" tabIndex={-1} aria-label={bt("business.actionsForDetail", { value0: name })}
      style={{ left: x, top: y }} onKeyDown={(event) => navigate(event)}>
      <p>{name}</p>{renderActions(actions)}
    </div>
    {current && "children" in current ? <div ref={sub} className="schema-object-menu" role="menu" tabIndex={-1}
      aria-label={current.label} onKeyDown={(event) => navigate(event, true)}>{renderActions(current.children, true)}</div> : null}
  </div>, document.body);
}
