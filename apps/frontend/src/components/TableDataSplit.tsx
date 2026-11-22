import { useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from "react";
import { useI18n } from "../i18n";
import { DEFAULT_ROW_PANEL_WIDTH, MAX_ROW_PANEL_WIDTH, MIN_ROW_PANEL_WIDTH } from "../platform/table-data-preferences";

const GRID_AND_DIVIDER_MIN_WIDTH = 268;
const KEYBOARD_STEP = 16;

export function TableDataSplit({ children, inspector, inspectorId, preferredWidth, onWidthChange }: {
  children: ReactNode;
  inspector?: ReactNode;
  inspectorId: string;
  preferredWidth: number;
  onWidthChange: (width: number) => void;
}) {
  const { t } = useI18n();
  const body = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; x: number; width: number; scale: number; nextWidth: number } | undefined>(undefined);
  const [bodyWidth, setBodyWidth] = useState<number>();
  const [dragWidth, setDragWidth] = useState<number>();
  const maxWidth = Math.max(MIN_ROW_PANEL_WIDTH, Math.min(MAX_ROW_PANEL_WIDTH, (bodyWidth ?? Infinity) - GRID_AND_DIVIDER_MIN_WIDTH));
  const panelWidth = Math.min(dragWidth ?? preferredWidth, maxWidth);

  useLayoutEffect(() => {
    const element = body.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setBodyWidth(Math.floor(entry.contentRect.width)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  function constrain(width: number) {
    return Math.max(MIN_ROW_PANEL_WIDTH, Math.min(maxWidth, Math.round(width)));
  }

  function endDrag(event: PointerEvent<HTMLDivElement>) {
    const active = drag.current;
    if (active?.id !== event.pointerId) return;
    drag.current = undefined;
    delete event.currentTarget.dataset.resizing;
    setDragWidth(undefined);
    if (active.nextWidth !== active.width) onWidthChange(active.nextWidth);
  }

  return (
    <div ref={body} className="table-data-body" data-row-panel={Boolean(inspector)}
      style={{ "--table-data-panel-width": `${panelWidth}px` } as CSSProperties}>
      {children}
      {inspector && <>
        <div className="table-data-panel-divider" role="separator" aria-label={t("tableData.resizeRowPanel")} aria-controls={inspectorId}
          aria-orientation="vertical" aria-valuemin={MIN_ROW_PANEL_WIDTH} aria-valuemax={maxWidth} aria-valuenow={panelWidth} tabIndex={0}
          title={t("tableData.resizeRowPanel")} onDoubleClick={() => onWidthChange(DEFAULT_ROW_PANEL_WIDTH)}
          onPointerDown={(event) => {
            if (event.button !== 0 || event.isPrimary === false) return;
            event.preventDefault();
            const divider = event.currentTarget;
            const scale = (divider.offsetWidth && divider.getBoundingClientRect().width / divider.offsetWidth) || 1;
            divider.focus({ preventScroll: true });
            divider.setPointerCapture(event.pointerId);
            drag.current = { id: event.pointerId, x: event.clientX, width: panelWidth, nextWidth: panelWidth, scale };
            divider.dataset.resizing = "true";
          }}
          onPointerMove={(event) => {
            const active = drag.current;
            if (active?.id !== event.pointerId) return;
            active.nextWidth = constrain(active.width - (event.clientX - active.x) / active.scale);
            setDragWidth(active.nextWidth);
          }}
          onPointerUp={endDrag} onPointerCancel={endDrag} onLostPointerCapture={endDrag}
          onKeyDown={(event) => {
            const { key } = event;
            if (key !== "ArrowLeft" && key !== "ArrowRight" && key !== "Home" && key !== "End") return;
            event.preventDefault();
            const nextWidth = constrain(key === "Home" ? MIN_ROW_PANEL_WIDTH : key === "End" ? maxWidth : panelWidth + (key === "ArrowLeft" ? KEYBOARD_STEP : -KEYBOARD_STEP));
            if (nextWidth !== panelWidth) onWidthChange(nextWidth);
          }} />
        {inspector}
      </>}
    </div>
  );
}
