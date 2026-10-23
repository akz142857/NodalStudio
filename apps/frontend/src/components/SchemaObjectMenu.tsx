import { Fragment, useEffect, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";

export interface SchemaObjectMenuAction { label: string; disabled?: boolean; separatorBefore?: boolean; run: () => void }

/** Object actions live outside the scrolling sidebar; all coordinates respect UI zoom. */
export function SchemaObjectMenu({ x, y, name, actions, onClose }: {
  x: number; y: number; name: string; actions: SchemaObjectMenuAction[]; onClose: (restoreFocus: boolean) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const menu = root.current;
    if (!menu) return;
    const scale = menu.offsetWidth ? menu.getBoundingClientRect().width / menu.offsetWidth || 1 : 1;
    menu.style.left = `${Math.max(6, Math.min(x / scale, window.innerWidth / scale - menu.offsetWidth - 6))}px`;
    menu.style.top = `${Math.max(6, Math.min(y / scale, window.innerHeight / scale - menu.offsetHeight - 6))}px`;
    menu.style.maxHeight = `${window.innerHeight / scale - 12}px`;
    (menu.querySelector<HTMLButtonElement>("button:not(:disabled)") ?? menu).focus();
  }, [x, y]);
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !root.current?.contains(event.target)) onClose(false); };
    const dismiss = () => onClose(false);
    const scroll = (event: Event) => { if (!(event.target instanceof Node) || !root.current?.contains(event.target)) dismiss(); };
    document.addEventListener("pointerdown", outside);
    window.addEventListener("resize", dismiss);
    window.addEventListener("scroll", scroll, true);
    return () => { document.removeEventListener("pointerdown", outside); window.removeEventListener("resize", dismiss); window.removeEventListener("scroll", scroll, true); };
  }, [onClose]);
  return createPortal(<div ref={root} className="schema-object-menu" role="menu" tabIndex={-1} aria-label={`Actions for ${name}`}
    style={{ left: x, top: y }} onContextMenu={(event) => event.preventDefault()}
    onKeyDown={(event) => {
      const items = Array.from(root.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? []);
      const current = items.indexOf(document.activeElement as HTMLButtonElement);
      if (["Escape", "Tab"].includes(event.key)) { event.preventDefault(); event.stopPropagation(); onClose(true); }
      else if (["Enter", " "].includes(event.key) && current >= 0) { event.preventDefault(); event.stopPropagation(); items[current]?.click(); }
      else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
          : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        items[next]?.focus();
      }
    }}>
    <p>{name}</p>
    {actions.map((action) => <Fragment key={action.label}>{action.separatorBefore ? <hr role="separator" /> : null}<button type="button" role="menuitem" disabled={action.disabled} onClick={() => { onClose(true); action.run(); }}>{action.label}</button></Fragment>)}
  </div>, document.body);
}
