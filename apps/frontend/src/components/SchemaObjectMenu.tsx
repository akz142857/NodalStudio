import { useI18n } from "../i18n";
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

type MenuItem = {
  id?: string;
  label: string;
  disabled?: boolean;
  description?: string;
  separatorBefore?: boolean;
  checked?: boolean;
  leading?: ReactNode;
  checkbox?: boolean;
  run: () => void;
};
export type SchemaObjectMenuAction = MenuItem | {
  label: string;
  disabled?: boolean;
  separatorBefore?: boolean;
  children: MenuItem[];
  className?: string;
};
type MenuPosition =
  | { x: number; y: number; anchor?: never }
  | { anchor: HTMLElement; x?: never; y?: never };

function items(menu: HTMLElement | null) {
  return Array.from(menu?.querySelectorAll<HTMLButtonElement>(
    ':is([role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]):not(:disabled)',
  ) ?? []);
}

function place(menu: HTMLElement, x: number, y: number, alignRight = false, anchorTop?: number) {
  const scale = menu.offsetWidth ? menu.getBoundingClientRect().width / menu.offsetWidth || 1 : 1;
  const left = x / scale - (alignRight ? menu.offsetWidth : 0);
  menu.style.maxHeight = `${window.innerHeight / scale - 12}px`;
  menu.style.left = `${Math.max(6, Math.min(left, window.innerWidth / scale - menu.offsetWidth - 6))}px`;
  const bottom = window.innerHeight / scale - menu.offsetHeight - 6;
  const above = anchorTop === undefined ? -1 : anchorTop / scale - menu.offsetHeight - 4;
  const top = y / scale > bottom && above >= 6 ? above : y / scale;
  menu.style.top = `${Math.max(6, Math.min(top, bottom))}px`;
}

/** Object actions live outside the scrolling sidebar; all coordinates respect UI zoom. */
export function SchemaObjectMenu({ x = 0, y = 0, anchor, name, actions, onClose, showName = true, className, align = "end", portalHost }: MenuPosition & {
  name: string; actions: SchemaObjectMenuAction[]; onClose: (restoreFocus: boolean) => void;
  showName?: boolean; className?: string; align?: "start" | "end";
  portalHost?: HTMLElement;
}) {
  const { t: bt } = useI18n();
  const surface = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const sub = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<number>(undefined);
  const [submenu, setSubmenu] = useState<{ label: string; trigger: HTMLButtonElement; focus: boolean }>();
  const current = actions.find((action) => action.label === submenu?.label);
  useLayoutEffect(() => {
    const menu = root.current;
    if (!menu) return;
    if (anchor) {
      const rect = anchor.getBoundingClientRect();
      const alignRight = (align === "end") === (getComputedStyle(anchor).direction !== "rtl");
      place(menu, alignRight ? rect.right : rect.left, rect.bottom + 4, alignRight, rect.top);
    } else place(menu, x, y);
    (items(menu)[0] ?? menu).focus();
  }, [align, anchor, name, x, y]);
  useLayoutEffect(() => {
    const menu = sub.current;
    if (!menu || !submenu || !root.current) return;
    const trigger = submenu.trigger.getBoundingClientRect();
    const parent = root.current.getBoundingClientRect();
    const bounds = menu.getBoundingClientRect();
    const entries = items(menu);
    const first = entries[0]?.getBoundingClientRect();
    const scale = menu.offsetWidth ? bounds.width / menu.offsetWidth || 1 : 1;
    const spaceRight = window.innerWidth - parent.right;
    const spaceLeft = parent.left;
    const needed = bounds.width + 5 * scale;
    const rtl = getComputedStyle(submenu.trigger).direction === "rtl";
    const openLeft = rtl ? spaceLeft >= needed || spaceLeft > spaceRight
      : spaceRight < needed && spaceLeft > spaceRight;
    // Align the first choice with the parent row and keep the menu edges connected.
    const top = first ? trigger.top + (trigger.height - first.height) / 2 - (first.top - bounds.top) : trigger.top;
    place(menu, openLeft ? parent.left + scale : parent.right - scale, top, openLeft);
    if (submenu.focus) {
      const selected = entries.find((entry) => entry.getAttribute("aria-checked") === "true");
      (selected ?? entries[0] ?? menu).focus();
    }
  }, [submenu]);
  useEffect(() => () => window.clearTimeout(closeTimer.current), []);
  useEffect(() => {
    const contains = (target: EventTarget | null) => target instanceof Node && surface.current?.contains(target);
    const outside = (event: PointerEvent) => {
      if (!contains(event.target) && !(event.target instanceof Node && anchor?.contains(event.target))) onClose(false);
    };
    const dismiss = () => onClose(false);
    const scroll = (event: Event) => { if (!contains(event.target)) dismiss(); };
    document.addEventListener("pointerdown", outside);
    window.addEventListener("resize", dismiss);
    window.addEventListener("scroll", scroll, true);
    return () => { document.removeEventListener("pointerdown", outside); window.removeEventListener("resize", dismiss); window.removeEventListener("scroll", scroll, true); };
  }, [anchor, onClose]);
  function navigate(event: KeyboardEvent<HTMLDivElement>, inSubmenu = false) {
    const enabled = items(event.currentTarget);
    const index = enabled.indexOf(document.activeElement as HTMLButtonElement);
    const active = enabled[index];
    const key = event.key;
    if (key === "Tab") {
      onClose(true);
      // Resume at the invoker and let the browser advance to the next control.
      event.stopPropagation();
      return;
    }
    const rtl = getComputedStyle(event.currentTarget).direction === "rtl";
    const openKey = rtl ? "ArrowLeft" : "ArrowRight";
    const backKey = rtl ? "ArrowRight" : "ArrowLeft";
    window.clearTimeout(closeTimer.current);
    if (inSubmenu && (key === "Escape" || key === backKey)) {
      submenu?.trigger.focus();
      setSubmenu(undefined);
    } else if (key === "Escape") {
      onClose(true);
    } else if (key === openKey && !inSubmenu && active?.dataset.submenu) {
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
    return entries.map((action) => <Fragment key={("id" in action ? action.id : undefined) ?? action.label}>
      {action.separatorBefore ? <hr role="separator" /> : null}
      {"children" in action ? <button type="button" role="menuitem" disabled={action.disabled} aria-haspopup="menu"
        aria-expanded={submenu?.label === action.label} data-submenu={action.label}
        onClick={(event) => {
          window.clearTimeout(closeTimer.current);
          setSubmenu({ label: action.label, trigger: event.currentTarget, focus: true });
        }}
        onPointerEnter={(event) => {
          if (action.disabled || event.pointerType === "touch") return;
          window.clearTimeout(closeTimer.current);
          if (submenu?.label !== action.label) setSubmenu({ label: action.label, trigger: event.currentTarget, focus: false });
        }}><span className="schema-menu-label">{action.label}</span><span className="schema-menu-chevron" aria-hidden="true">›</span></button>
        : <button type="button" role={action.checked === undefined ? "menuitem" : action.checkbox ? "menuitemcheckbox" : "menuitemradio"}
          aria-checked={action.checked} disabled={action.disabled} aria-description={action.description} title={action.description}
          onPointerEnter={() => {
            if (inSubmenu || !submenu || sub.current?.contains(document.activeElement)) return;
            // Give the pointer time to cross a sibling row on its way to the submenu.
            window.clearTimeout(closeTimer.current);
            closeTimer.current = window.setTimeout(() => setSubmenu(undefined), 220);
          }}
          onClick={() => { onClose(true); action.run(); }}>
          {action.checked !== undefined && <span className="schema-menu-check" aria-hidden="true">{action.checked ? "✓" : ""}</span>}
          {action.leading && <span className="schema-menu-leading" aria-hidden="true">{action.leading}</span>}
          <span className="schema-menu-label">{action.label}</span>
        </button>}
    </Fragment>);
  }

  return createPortal(<div ref={surface} className="schema-menu-surface" onContextMenu={(event) => event.preventDefault()}>
    <div ref={root} className={className ? `schema-object-menu ${className}` : "schema-object-menu"} role="menu" tabIndex={-1} aria-label={bt("business.actionsForDetail", { value0: name })}
      style={{ left: x, top: y }} onKeyDown={(event) => navigate(event)}>
      {showName && <p>{name}</p>}{renderActions(actions)}
    </div>
    {current && "children" in current ? <div ref={sub} className={current.className ? `schema-object-menu ${current.className}` : "schema-object-menu"}
      role="menu" tabIndex={-1} aria-label={current.label}
      onPointerEnter={() => window.clearTimeout(closeTimer.current)}
      onKeyDown={(event) => navigate(event, true)}>{renderActions(current.children, true)}</div> : null}
  </div>, portalHost ?? document.body);
}
