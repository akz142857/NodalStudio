import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ActionIcon } from "./ActionIcon";
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
}

/** Nonmodal disclosure: Tab navigates its controls; Escape returns to the trigger. */
export function CanvasToolbar({ tableCount, comparisonLabel, filters, disabled, layoutDisabled, onViewAll, onAutoLayout, onManageRelationships, status, context }: CanvasToolbarProps) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  const expanded = open && !disabled;
  useEffect(() => {
    if (!expanded) return;
    panel.current?.querySelector<HTMLInputElement>("input")?.focus();
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [expanded]);
  return <div className="canvas-command-dock">
    {status ? <div className="canvas-command-status" role="status">{status}</div> : null}
    {context ? <div className="canvas-command-context">{context}</div> : null}
    <div className="canvas-command-bar" role="group" aria-label="Canvas tools">
      <span className="canvas-command-count" title={`${tableCount} tables${comparisonLabel ? ` · ${comparisonLabel}` : ""}`}><strong>{tableCount}</strong> tables{comparisonLabel ? <small>{comparisonLabel}</small> : null}</span>
      <div className="canvas-command-navigation" role="group" aria-label="Canvas view and layout">
        <button type="button" disabled={disabled} aria-label="View all" title="View all — exit table focus and fit every table" onClick={onViewAll}><ActionIcon name="fit" /><span className="canvas-command-label">View all</span></button>
        <button type="button" disabled={disabled || layoutDisabled} aria-label="Auto layout" title="Auto layout — arrange movable tables; pinned tables stay in place" onClick={onAutoLayout}><ActionIcon name="grid" /><span className="canvas-command-label">Auto layout</span></button>
      </div>
      <div className="canvas-command-disclosure" ref={root} onBlur={(event) => {
        if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }} onKeyDown={(event) => {
        if (event.key === "Escape" && expanded) { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus(); }
      }}>
        <button ref={trigger} type="button" disabled={disabled} aria-label="Relationships" title="Relationship visibility and management" aria-expanded={expanded} aria-controls={id} onClick={() => setOpen((value) => !value)}><ActionIcon name="relationships" /><span className="canvas-command-label">Relationships</span><span className="canvas-command-chevron"><ActionIcon name="chevronUp" /></span></button>
        {expanded ? <div className="canvas-command-popover" ref={panel} id={id} role="group" aria-label="Relationship display">
          <header><strong>Relationships</strong><span>{tableCount} tables{comparisonLabel ? ` · ${comparisonLabel}` : ""}</span></header>
          <div className="canvas-command-filters">{filters.map((filter) => <label key={filter.id} className="canvas-command-filter">
            <input type="checkbox" aria-label={filter.label} checked={filter.checked} onChange={filter.onChange} aria-describedby={`${id}-${filter.id}`} />
            <span><strong>{filter.label}</strong><small id={`${id}-${filter.id}`}>{filter.description}</small></span>
            {filter.count !== undefined ? <span className="canvas-command-badge">{filter.count}</span> : null}
          </label>)}</div>
          {onManageRelationships ? <div className="canvas-command-management"><button type="button" className="canvas-command-manage" onClick={() => { setOpen(false); trigger.current?.focus(); onManageRelationships(); }}><ActionIcon name="sliders" /><span>Manage relationships</span><ActionIcon name="chevronRight" /></button></div> : null}
          <p className="canvas-command-help">Double-click a table to focus on its relationships. Use View all to return to the full model.</p>
        </div> : null}
      </div>
    </div>
  </div>;
}
