import { useI18n } from "../i18n";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { ActionIcon } from "./ActionIcon";
import { ControlButton, Controls, useReactFlow, useStore, useStoreApi } from "@xyflow/react";
import { MINIMAP_HEIGHT, MINIMAP_WIDTH } from "./DiagramMiniMap";
import "./canvas-toolbar.css";

const canvasInset = 16;
const overlayGap = 12;
const defaultPosition = { x: 0.5, y: 1 };
const clampFraction = (value: number) => Math.max(0, Math.min(1, value));

function measureDock(dock: HTMLDivElement | null) {
  const surface = dock?.parentElement;
  if (!dock || !surface?.classList.contains("schema-canvas-surface")) return;
  const canvas = surface.getBoundingClientRect();
  const rect = dock.getBoundingClientRect();
  const scale = (surface.offsetWidth && canvas.width / surface.offsetWidth) || 1;
  return { surface, canvas, rect, scale, inset: canvasInset * scale };
}

function positionMinimap(canvas: DOMRect, obstacles: DOMRect[], scale: number) {
  const inset = canvasInset * scale;
  const gap = overlayGap * scale;
  const right = canvas.right - inset;
  const bottom = canvas.bottom - inset;
  const width = (MINIMAP_WIDTH + 2) * scale;
  const height = (MINIMAP_HEIGHT + 2) * scale;
  const rightEdges = [right, ...obstacles.map((item) => Math.min(right, item.left - gap))];
  const bottomEdges = [bottom, ...obstacles.map((item) => Math.min(bottom, item.top - gap))];
  let best: { right: number; bottom: number } | undefined;

  // Keep the full footprint clear for both sizes without moving the map on hover.
  for (const mapRight of rightEdges) {
    if (mapRight - width < canvas.left + inset) continue;
    for (const mapBottom of bottomEdges) {
      if (mapBottom - height < canvas.top + inset) continue;
      const blocked = obstacles.some((item) =>
        mapRight > item.left - gap && mapRight - width < item.right + gap
        && mapBottom > item.top - gap && mapBottom - height < item.bottom + gap);
      const offset = { right: (canvas.right - mapRight) / scale, bottom: (canvas.bottom - mapBottom) / scale };
      if (!blocked && (!best || offset.right + offset.bottom < best.right + best.bottom)) best = offset;
    }
  }
  return best ?? { right: canvasInset, bottom: canvasInset };
}

export interface CanvasRelationshipFilter {
  id: string;
  label: string;
  count?: number;
  description: string;
  checked: boolean;
  onChange: () => void;
}
export function CanvasNavigationControls() {
  const { t } = useI18n();
  const store = useStoreApi();
  const { zoomIn, zoomOut, fitView } = useReactFlow();
  const atMinimum = useStore((state) => state.transform[2] <= state.minZoom);
  const atMaximum = useStore((state) => state.transform[2] >= state.maxZoom);
  const interactive = useStore((state) => state.nodesDraggable || state.nodesConnectable || state.elementsSelectable);
  const labels = {
    zoomIn: t("businessExtra.zoomIn"),
    zoomOut: t("businessExtra.zoomOut"),
    fit: t("businessExtra.fitView"),
    interactivity: t("businessExtra.toggleInteractivity"),
  };
  return <Controls aria-label={t("businessExtra.zoomControls")} orientation="horizontal" showZoom={false} showFitView={false} showInteractive={false}>
    <ControlButton className="react-flow__controls-zoomin" aria-label={labels.zoomIn} title={labels.zoomIn} disabled={atMaximum} onClick={() => void zoomIn()}><ActionIcon name="add" /></ControlButton>
    <ControlButton className="react-flow__controls-zoomout" aria-label={labels.zoomOut} title={labels.zoomOut} disabled={atMinimum} onClick={() => void zoomOut()}><ActionIcon name="remove" /></ControlButton>
    <ControlButton className="react-flow__controls-fitview" aria-label={labels.fit} title={labels.fit} onClick={() => void fitView()}><ActionIcon name="fit" /></ControlButton>
    <ControlButton className="react-flow__controls-interactive" aria-label={labels.interactivity} title={labels.interactivity} aria-pressed={!interactive}
      onClick={() => store.setState({ nodesDraggable: !interactive, nodesConnectable: !interactive, elementsSelectable: !interactive })}>
      <ActionIcon name={interactive ? "unlock" : "lock"} />
    </ControlButton>
  </Controls>;
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
  onReviewInferences?: () => void;
  status?: string;
  context?: ReactNode;
  selectedCount?: number;
  selectionActions?: ReactNode;
  navigationControls?: ReactNode;
}

/** The dock position is local to the canvas, separate from diagram layout. */
export function CanvasToolbar({ tableCount, comparisonLabel, filters, disabled, layoutDisabled, onViewAll, onAutoLayout, onManageRelationships, onReviewInferences, status, context, selectedCount = 0, selectionActions, navigationControls, minimapVisible, onToggleMinimap }: CanvasToolbarProps) {
  const { t: bt, locale } = useI18n();
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [position, setPosition] = useState(defaultPosition);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ id: number; offsetX: number; offsetY: number } | undefined>(undefined);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const restore = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  const expanded = open && !disabled && !collapsed;
  const close = () => { setOpen(false); trigger.current?.focus(); };
  const placeOverlays = useCallback(() => {
    const dock = root.current;
    const measured = measureDock(dock);
    if (!dock || !measured) return;
    const { surface, canvas, rect, scale, inset } = measured;
    const above = (rect.top - canvas.top - inset) / scale;
    const below = (canvas.bottom - rect.bottom - inset) / scale;
    const panelWidth = Math.max(0, Math.min(320, (canvas.width - 2 * inset) / scale));
    const halfPanel = panelWidth * scale / 2;
    const center = Math.max(canvas.left + inset + halfPanel, Math.min((rect.left + rect.right) / 2, canvas.right - inset - halfPanel));
    dock.dataset.panelSide = below > above ? "below" : "above";
    dock.style.setProperty("--canvas-tools-width", `${panelWidth}px`);
    dock.style.setProperty("--canvas-tools-left", `${(center - rect.left) / scale}px`);
    dock.style.setProperty("--canvas-tools-height", `${Math.max(0, Math.max(above, below) - 8)}px`);

    const obstacles = [rect];
    const tools = panel.current;
    if (tools && !tools.hidden) obstacles.push(tools.getBoundingClientRect());
    const minimap = positionMinimap(canvas, obstacles, scale);
    surface.style.setProperty("--canvas-minimap-right", `${minimap.right}px`);
    surface.style.setProperty("--canvas-minimap-bottom", `${minimap.bottom}px`);
  }, []);
  useLayoutEffect(() => {
    const dock = root.current;
    const measured = measureDock(dock);
    if (!dock || !measured) return;
    const { surface } = measured;
    const observer = new ResizeObserver(placeOverlays);
    observer.observe(surface);
    observer.observe(dock);
    if (panel.current) observer.observe(panel.current);
    return () => {
      observer.disconnect();
      surface.style.removeProperty("--canvas-minimap-right");
      surface.style.removeProperty("--canvas-minimap-bottom");
    };
  }, [placeOverlays]);
  useLayoutEffect(placeOverlays, [placeOverlays, position, collapsed, expanded]);
  useEffect(() => {
    if (!expanded) return;
    const outside = (event: PointerEvent) => {
      // Closing Tools would move the minimap during the gesture the user just started.
      if (event.target instanceof Element && event.target.closest("dialog, .canvas-minimap")) return;
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [expanded]);

  function moveDock(left: number, top: number, { canvas, rect, inset }: NonNullable<ReturnType<typeof measureDock>>) {
    const horizontalTravel = canvas.width - rect.width - 2 * inset;
    const verticalTravel = canvas.height - rect.height - 2 * inset;
    setPosition((current) => ({
      x: horizontalTravel > 0 ? clampFraction((left - canvas.left - inset) / horizontalTravel) : current.x,
      y: verticalTravel > 0 ? clampFraction((top - canvas.top - inset) / verticalTravel) : current.y,
    }));
  }

  function endDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (drag.current?.id !== event.pointerId) return;
    drag.current = undefined;
    setDragging(false);
  }

  const grip = <div className="canvas-command-grip" role="group" tabIndex={disabled ? -1 : 0} aria-disabled={disabled || undefined}
    aria-label={bt("business.moveCanvasToolbar")} title={bt("business.moveCanvasToolbarHelp")}
    onPointerDown={(event) => {
      if (disabled || event.button !== 0 || event.isPrimary === false || drag.current) return;
      const measured = measureDock(root.current);
      if (!measured) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { id: event.pointerId, offsetX: event.clientX - measured.rect.left, offsetY: event.clientY - measured.rect.top };
      setDragging(true);
    }} onPointerMove={(event) => {
      const active = drag.current;
      if (disabled || active?.id !== event.pointerId) return;
      const measured = measureDock(root.current);
      if (measured) moveDock(event.clientX - active.offsetX, event.clientY - active.offsetY, measured);
    }} onPointerUp={endDrag} onPointerCancel={endDrag} onLostPointerCapture={endDrag}
    onKeyDown={(event) => {
      if (disabled || event.altKey || event.ctrlKey || event.metaKey || !["Home", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
      const measured = measureDock(root.current);
      if (!measured) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Home") { setPosition(defaultPosition); return; }
      const step = (event.shiftKey ? 64 : 16) * measured.scale;
      const x = event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0;
      const y = event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0;
      moveDock(measured.rect.left + x, measured.rect.top + y, measured);
    }}><ActionIcon name="grip" /></div>;

  return <div className="canvas-command-dock" ref={root} data-dragging={dragging || undefined}
    style={{ "--canvas-dock-x": position.x, "--canvas-dock-y": position.y } as CSSProperties} onKeyDown={(event) => {
    if (event.key === "Escape" && expanded && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); close(); }
  }} onBlur={(event) => {
    if (event.relatedTarget instanceof Element && event.relatedTarget.closest("dialog")) return;
    if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) setOpen(false);
  }}>
    {status ? <div className="canvas-command-status" role="status">{status}</div> : null}
    {context ? <div className="canvas-command-context">{context}</div> : null}
    <div className="canvas-command-popover" ref={panel} id={id} role="group" aria-label={bt("business.canvasToolPanel")} hidden={!expanded}>
      <header><strong>{bt("business.canvasTools")}</strong><button type="button" aria-label={bt("business.closeCanvasToolPanel")} title={bt("business.closePanelKeepSelection")} onClick={close}><ActionIcon name="chevronUp" /></button></header>
      {selectionActions}
      <div className="canvas-command-section-label">{bt("business.entireDiagram")} {tableCount} {bt("business.tablesDetail")}{comparisonLabel ? ` · ${comparisonLabel}` : ""}</div>
      <button type="button" className="canvas-command-row" disabled={disabled} aria-label={bt("business.viewAll")} title={bt("business.exitTableFocusAndFitEveryTable")} onClick={() => { close(); onViewAll(); }}><ActionIcon name="fit" />{bt("business.viewAll")}</button>
      <button type="button" className="canvas-command-row" disabled={disabled || layoutDisabled} aria-label={bt("business.autoLayout")} title={bt("business.arrangeAllMovableTablesPinnedTablesStayInPlace")} onClick={() => { close(); onAutoLayout(); }}><ActionIcon name="grid" />{bt("business.layoutAllTables")}</button>
      {onToggleMinimap ? <button type="button" className="canvas-command-row" aria-label={bt("business.showMinimap")} aria-pressed={minimapVisible} disabled={disabled} onClick={onToggleMinimap}><ActionIcon name="map" />{bt("business.minimap")}<span className="canvas-command-toggle-state">{minimapVisible ? bt("business.on") : bt("business.off")}</span></button> : null}
      <div className="canvas-command-relationships" role="group" aria-labelledby={`${id}-relationships`}>
        <h3 id={`${id}-relationships`} className="canvas-command-section-label">{bt("business.relationships")}</h3>
        <div className="canvas-command-filters">{filters.map((filter) => <label key={filter.id} className="canvas-command-filter">
          <input type="checkbox" aria-label={filter.label} checked={filter.checked} disabled={disabled} onChange={filter.onChange} aria-describedby={`${id}-${filter.id}`} />
          <span><strong>{filter.label}</strong><small id={`${id}-${filter.id}`}>{filter.description}</small></span>
          {filter.count !== undefined ? <span className="canvas-command-badge">{filter.count}</span> : null}
        </label>)}</div>
        {onReviewInferences ? <button type="button" className="canvas-command-manage" disabled={disabled} onClick={() => { close(); onReviewInferences(); }}><ActionIcon name="relationships" />{bt("business.reviewCandidates")}<ActionIcon name="chevronRight" /></button> : null}
        {onManageRelationships ? <button type="button" className="canvas-command-manage" onClick={() => { close(); onManageRelationships(); }}><ActionIcon name="sliders" />{bt("business.manageRelationships")}<ActionIcon name="chevronRight" /></button> : null}
      </div>
    </div>
    <div className={collapsed ? "canvas-command-restore" : "canvas-command-bar"} role={collapsed ? undefined : "toolbar"} aria-label={collapsed ? undefined : bt("business.canvasTools")}>
      {grip}
      {collapsed ? <button ref={restore} type="button" disabled={disabled} aria-label={bt("business.expandCanvasToolbar")} title={bt("business.expandToolbarSelectionIsPreserved")} onClick={() => { setCollapsed(false); requestAnimationFrame(() => trigger.current?.focus()); }}><ActionIcon name="sliders" />{bt("business.tools")}{selectedCount > 0 ? <span className="canvas-command-badge">{selectedCount}</span> : null}</button> : <>
      {selectedCount > 0 ? <span className="canvas-command-count">{selectedCount} {bt("businessExtra.table")}{locale === "zh-CN" || selectedCount === 1 ? "" : "s"} {bt("businessExtra.selected")}</span> : null}
      <button ref={trigger} type="button" disabled={disabled} aria-label={bt("business.canvasTools")} title={bt("business.showOrHideCanvasTools")} aria-expanded={expanded} aria-controls={id} onKeyDown={(event) => {
        if (event.key === "ArrowUp" || event.key === "ArrowDown") { event.preventDefault(); setOpen(true); requestAnimationFrame(() => panel.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus()); }
      }} onClick={(event) => {
        event.currentTarget.focus({ preventScroll: true });
        setOpen((value) => !value);
      }}><ActionIcon name="sliders" />{bt("business.tools")}</button>
      {navigationControls ? <div className="canvas-command-navigation">{navigationControls}</div> : null}
      <button type="button" disabled={disabled} aria-label={bt("business.collapseCanvasToolbar")} title={bt("business.collapseToolbarKeepSelection")} onClick={() => { setOpen(false); setCollapsed(true); requestAnimationFrame(() => restore.current?.focus()); }}><ActionIcon name="chevronDown" /></button>
      </>}
    </div>
  </div>;
}
