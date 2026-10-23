import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ActionIcon } from "./ActionIcon";
import { DiagramToolbarMenu } from "./DiagramToolbarMenu";
import "./canvas-toolbar.css";

export interface CanvasRelationshipFilter {
  id: string;
  label: string;
  count?: number;
  description: string;
  checked: boolean;
  onChange: () => void;
}
interface CanvasToolbarProps {
  minimapVisible?: boolean;
  onToggleMinimap?: () => void;
  tableCount: number;
  comparisonLabel?: string;
  filters: CanvasRelationshipFilter[];
  disabled?: boolean;
  layoutDisabled: boolean;
  onViewAll: () => void;
  onAutoLayout: () => void;
  onManageRelationships?: () => void;
  status?: string;
  context?: ReactNode;
  selectedCount?: number;
  createViewAction?: ReactNode;
  selectionActions?: ReactNode;
  navigationControls?: ReactNode;
}

/** A stable bottom dock. Collapsing is presentation-only and never clears selection. */
export function CanvasToolbar({ tableCount, comparisonLabel, filters, disabled, layoutDisabled, onViewAll, onAutoLayout, onManageRelationships, status, context, selectedCount = 0, createViewAction, selectionActions, navigationControls, minimapVisible, onToggleMinimap }: CanvasToolbarProps) {
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const restore = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  const expanded = open && !disabled && !collapsed;
  const close = () => { setOpen(false); trigger.current?.focus(); };
  useLayoutEffect(() => {
    const dock = root.current;
    const workspace = dock?.closest(".schema-canvas-workspace");
    const surface = workspace?.querySelector<HTMLElement>(".schema-canvas-surface");
    const footer = workspace?.querySelector<HTMLElement>(".workspace-layout-status");
    if (!dock || !surface || !footer) return;
    const position = () => {
      dock.style.bottom = `${footer.offsetHeight + 16}px`;
      dock.style.setProperty("--canvas-tools-height", `${Math.max(80, surface.clientHeight - dock.offsetHeight - 32)}px`);
      const minimap = surface.querySelector<HTMLElement>(".react-flow__minimap");
      if (minimap) {
        const bounds = surface.getBoundingClientRect();
        const mapWidth = minimap.offsetWidth;
        const mapLeft = bounds.right - 16 - mapWidth;
        let bottom = 16;
        for (const element of dock.querySelectorAll<HTMLElement>(".canvas-command-bar, .canvas-command-restore, .canvas-command-context, .canvas-command-status")) {
          if (element.hidden) continue;
          const rect = element.getBoundingClientRect();
          if (rect.right + 12 > mapLeft && rect.left < bounds.right - 16 + 12) bottom = Math.max(bottom, bounds.bottom - rect.top + 12);
        }
        minimap.style.bottom = `${bottom}px`;
      }
    };
    position();
    const observer = new ResizeObserver(position);
    observer.observe(surface); observer.observe(footer); observer.observe(dock);
    dock.querySelectorAll<HTMLElement>(".canvas-command-bar, .canvas-command-restore").forEach((element) => observer.observe(element));
    const minimap = surface.querySelector<HTMLElement>(".react-flow__minimap");
    if (minimap) observer.observe(minimap);
    return () => observer.disconnect();
  }, [collapsed, minimapVisible]);
  useEffect(() => {
    if (!expanded) return;
    const outside = (event: PointerEvent) => {
      // A saved-view dialog is portaled outside the dock and owns focus until closed.
      if (event.target instanceof Element && event.target.closest("dialog")) return;
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [expanded]);
  return <div className="canvas-command-dock" ref={root} onKeyDown={(event) => {
    if (event.key === "Escape" && expanded && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); close(); }
  }} onBlur={(event) => {
    if (event.relatedTarget instanceof Element && event.relatedTarget.closest("dialog")) return;
    if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) setOpen(false);
  }}>
    {status ? <div className="canvas-command-status" role="status">{status}</div> : null}
    {context ? <div className="canvas-command-context">{context}</div> : null}
    <div className="canvas-command-popover" ref={panel} id={id} role="group" aria-label="Canvas tool panel" hidden={!expanded}>
      <header><strong>Canvas tools</strong><button type="button" aria-label="Close canvas tool panel" title="Close panel; keep selection" onClick={close}><ActionIcon name="chevronUp" /></button></header>
      {selectionActions}
      <div className="canvas-command-section-label">Entire diagram · {tableCount} tables{comparisonLabel ? ` · ${comparisonLabel}` : ""}</div>
      <button type="button" className="canvas-command-row" disabled={disabled} aria-label="View all" title="Exit table focus and fit every table" onClick={() => { close(); onViewAll(); }}><ActionIcon name="fit" />View all</button>
      <button type="button" className="canvas-command-row" disabled={disabled || layoutDisabled} aria-label="Auto layout" title="Arrange all movable tables; pinned tables stay in place" onClick={() => { close(); onAutoLayout(); }}><ActionIcon name="grid" />Layout all tables</button>
      {onToggleMinimap ? <button type="button" className="canvas-command-row" aria-label="Show minimap" aria-pressed={minimapVisible} disabled={disabled} onClick={onToggleMinimap}><ActionIcon name="map" />Minimap<span className="canvas-command-toggle-state">{minimapVisible ? "On" : "Off"}</span></button> : null}
      <DiagramToolbarMenu inline label="Relationships" title="Relationship visibility and management" disabled={disabled}>
        <div className="canvas-command-filters">{filters.map((filter) => <label key={filter.id} className="canvas-command-filter">
          <input type="checkbox" aria-label={filter.label} checked={filter.checked} onChange={filter.onChange} aria-describedby={`${id}-${filter.id}`} />
          <span><strong>{filter.label}</strong><small id={`${id}-${filter.id}`}>{filter.description}</small></span>
          {filter.count !== undefined ? <span className="canvas-command-badge">{filter.count}</span> : null}
        </label>)}</div>
        {onManageRelationships ? <button type="button" className="canvas-command-manage" onClick={() => { close(); onManageRelationships(); }}><ActionIcon name="sliders" />Manage relationships<ActionIcon name="chevronRight" /></button> : null}
      </DiagramToolbarMenu>
    </div>
    <button ref={restore} type="button" className="canvas-command-restore" hidden={!collapsed} disabled={disabled} aria-label="Expand canvas toolbar" title="Expand toolbar; selection is preserved" onClick={() => { setCollapsed(false); requestAnimationFrame(() => trigger.current?.focus()); }}><ActionIcon name="sliders" />Tools{selectedCount > 0 ? <span className="canvas-command-badge">{selectedCount}</span> : null}</button>
    <div className="canvas-command-bar" role="toolbar" aria-label="Canvas tools" hidden={collapsed}>
      {selectedCount > 0 ? <span className="canvas-command-count">{selectedCount} table{selectedCount === 1 ? "" : "s"} selected</span> : null}
      {createViewAction}
      <button ref={trigger} type="button" disabled={disabled} aria-label="Canvas tools" title="Show or hide canvas tools" aria-expanded={expanded} aria-controls={id} onKeyDown={(event) => {
        if (event.key === "ArrowUp") { event.preventDefault(); setOpen(true); requestAnimationFrame(() => panel.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus()); }
      }} onClick={() => setOpen((value) => !value)}><ActionIcon name="sliders" />Tools</button>
      {navigationControls ? <div className="canvas-command-navigation">{navigationControls}</div> : null}
      <button type="button" disabled={disabled} aria-label="Collapse canvas toolbar" title="Collapse toolbar; keep selection" onClick={() => { setOpen(false); setCollapsed(true); requestAnimationFrame(() => restore.current?.focus()); }}><ActionIcon name="chevronDown" /></button>
    </div>
  </div>;
}
