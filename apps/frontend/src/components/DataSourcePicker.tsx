import { useI18n } from "../i18n";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { DataSourceProfile } from "../platform";
import { ActionIcon } from "./ActionIcon";

type InitialFocus = "selected" | "first" | "last";

function engine(profile: DataSourceProfile) {
  return profile.databaseType === "mySql" ? "MySQL" : "PostgreSQL";
}

function address(profile: DataSourceProfile) {
  const host = profile.host.includes(":") && !profile.host.startsWith("[") ? `[${profile.host}]` : profile.host;
  return `${host}:${profile.port}`;
}

export function DataSourcePicker({ profiles, activeProfile, disabled, onSelect, onEdit, onManage }: {
  profiles: DataSourceProfile[];
  activeProfile?: DataSourceProfile;
  disabled: boolean;
  onSelect: (profile: DataSourceProfile) => void;
  onEdit?: (profile: DataSourceProfile) => void;
  onManage?: () => void;
}) {
  const { t: bt, locale } = useI18n();
  const trigger = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const activeSourceId = activeProfile?.id;
  const [opening, setOpening] = useState<{ sourceId?: string; focus: InitialFocus }>();
  if (opening && (disabled || opening.sourceId !== activeSourceId)) setOpening(undefined);
  const open = Boolean(opening && !disabled && opening.sourceId === activeSourceId);
  const close = useCallback((restoreFocus: boolean) => {
    setOpening(undefined);
    if (restoreFocus) trigger.current?.focus();
  }, []);
  return <>
    <button ref={trigger} type="button" className="source-navigation-picker" aria-disabled={disabled || undefined}
      aria-label={activeProfile ? bt("business.dataSourceDetail", { value0: activeProfile.database }) : bt("business.selectDatabase")} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined}
      title={activeProfile ? bt("business.switchDatabase", { value0: activeProfile.database, value1: engine(activeProfile), value2: activeProfile.displayName, value3: address(activeProfile) }) : bt("business.selectADatabaseToOpenItsSavedModel")}
      onClick={() => { if (!disabled) setOpening(open ? undefined : { sourceId: activeSourceId, focus: "selected" }); }}
      onKeyDown={(event) => {
        if (disabled) return;
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        event.preventDefault(); event.stopPropagation();
        setOpening({ sourceId: activeSourceId, focus: event.key === "ArrowDown" ? "first" : "last" });
      }}>
      <ActionIcon name="database" />
      <span className="source-navigation-label"><strong>{activeProfile?.database ?? bt("business.selectDatabase")}</strong><span>{activeProfile ? `${engine(activeProfile)} · ${activeProfile.displayName}` : bt("business.savedConnection", { value0: profiles.length, value1: locale === "zh-CN" ? "" : (profiles.length === 1 ? "" : "s") })}</span></span>
      <ActionIcon name="chevronDown" />
    </button>
    {open && opening ? <DataSourceMenu id={menuId} trigger={trigger} profiles={profiles} activeSourceId={activeSourceId}
      initialFocus={opening.focus} onClose={close} onSelect={(profile) => {
        close(true);
        if (profile.id !== activeSourceId) onSelect(profile);
      }} onEdit={activeProfile && onEdit ? () => { close(true); onEdit(activeProfile); } : undefined}
      onManage={onManage ? () => { close(true); onManage(); } : undefined} /> : null}
  </>;
}

function DataSourceMenu({ id, trigger, profiles, activeSourceId, initialFocus, onClose, onSelect, onEdit, onManage }: {
  id: string;
  trigger: RefObject<HTMLButtonElement | null>;
  profiles: DataSourceProfile[];
  activeSourceId?: string;
  initialFocus: InitialFocus;
  onClose: (restoreFocus: boolean) => void;
  onSelect: (profile: DataSourceProfile) => void;
  onEdit?: () => void;
  onManage?: () => void;
}) {
  const { t: bt } = useI18n();
  const root = useRef<HTMLDivElement>(null);
  const typeahead = useRef({ text: "", time: 0 });
  useLayoutEffect(() => {
    const menu = root.current;
    const anchor = trigger.current;
    if (!menu || !anchor) return;
    function position() {
      if (!menu || !anchor) return;
      // Portal coordinates, dimensions and viewport bounds share the app's UI zoom.
      const scale = menu.offsetWidth ? menu.getBoundingClientRect().width / menu.offsetWidth || 1 : 1;
      const bounds = anchor.getBoundingClientRect();
      const viewportWidth = window.innerWidth / scale, viewportHeight = window.innerHeight / scale;
      const width = Math.min(Math.max(bounds.width / scale, 300), viewportWidth - 16);
      menu.style.width = `${width}px`;
      menu.style.left = `${Math.max(8, Math.min(bounds.left / scale, viewportWidth - width - 8))}px`;
      const below = viewportHeight - bounds.bottom / scale - 14;
      const above = bounds.top / scale - 14;
      const upward = below < Math.min(menu.scrollHeight, 280) && above > below;
      menu.style.maxHeight = `${Math.max(0, Math.min(380, upward ? above : below))}px`;
      menu.style.top = `${upward ? Math.max(8, bounds.top / scale - menu.offsetHeight - 6) : bounds.bottom / scale + 6}px`;
    }
    position();
    const items = menu.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"], [role="menuitem"]');
    const selected = menu.querySelector<HTMLButtonElement>('[aria-checked="true"]');
    const first = initialFocus === "last" ? items[items.length - 1] : initialFocus === "selected" ? selected : items[0];
    (first ?? items[0])?.focus({ preventScroll: true });
    (first ?? items[0])?.scrollIntoView?.({ block: "nearest" });
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(position);
    observer?.observe(anchor);
    observer?.observe(menu);
    return () => observer?.disconnect();
  }, [initialFocus, trigger]);
  useEffect(() => {
    function outside(event: Event) {
      if (event.target instanceof Node && !root.current?.contains(event.target) && !trigger.current?.contains(event.target)) onClose(false);
    }
    const dismiss = () => onClose(false);
    const scroll = (event: Event) => { if (!(event.target instanceof Node) || !root.current?.contains(event.target)) dismiss(); };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", outside);
    window.addEventListener("resize", dismiss);
    window.addEventListener("scroll", scroll, true);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("focusin", outside);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("scroll", scroll, true);
    };
  }, [onClose, trigger]);
  return createPortal(<div ref={root} id={id} className="data-source-menu" role="menu" aria-label={bt("business.switchDatabaseDetail")}
    onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); }}
    onKeyDown={(event) => {
      event.stopPropagation();
      const items = Array.from(root.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"], [role="menuitem"]') ?? []);
      const current = items.indexOf(document.activeElement as HTMLButtonElement);
      if (event.key === "Escape") { event.preventDefault(); onClose(true); }
      // Let Tab advance from the trigger in the sidebar instead of the body portal.
      else if (event.key === "Tab") onClose(true);
      else if (["Enter", " "].includes(event.key)) { event.preventDefault(); items[current]?.click(); }
      else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
          : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        items[next]?.focus();
      } else if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        const now = Date.now();
        const text = (now - typeahead.current.time < 700 ? typeahead.current.text : "") + event.key.toLowerCase();
        typeahead.current = { text, time: now };
        const next = profiles.findIndex((profile) => profile.database.toLowerCase().startsWith(text) || profile.displayName.toLowerCase().startsWith(text));
        items[next]?.focus();
      }
    }}>
    <div className="data-source-menu-heading" aria-hidden="true">{bt("business.switchDatabaseDetail")}</div>
    {profiles.map((profile) => <button key={profile.id} type="button" role="menuitemradio" aria-checked={profile.id === activeSourceId}
      title={`${profile.database} — ${engine(profile)} · ${profile.displayName} · ${address(profile)}`}
      onClick={() => onSelect(profile)}>
      <ActionIcon name="database" />
      <span className="data-source-menu-label"><strong>{profile.database}</strong><span>{engine(profile)} · {profile.displayName}</span><small>{address(profile)}</small></span>
      <span className="data-source-menu-check" aria-hidden="true">✓</span>
    </button>)}
    {onEdit || onManage ? <div className="data-source-menu-actions" role="group" aria-label={bt("business.connectionActions")}>
      {onEdit ? <button type="button" role="menuitem" onClick={onEdit}><ActionIcon name="settings" />{bt("business.editCurrentConnection")}</button> : null}
      {onManage ? <button type="button" role="menuitem" onClick={onManage}><ActionIcon name="sliders" />{bt("business.manageConnections")}</button> : null}
    </div> : null}
  </div>, document.body);
}
