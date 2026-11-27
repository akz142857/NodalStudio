import { useLayoutEffect, useRef, useState } from "react";
import { useI18n } from "../../i18n";

export function CodePanelDivider({ orientation, panelId, label, size, min, max, ratio, onResize }: {
  orientation: "horizontal" | "vertical";
  panelId: string;
  label: string;
  size: number;
  min: number;
  max: number;
  ratio: number;
  onResize: (size: number) => void;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; start: number; size: number; scale: number } | undefined>(undefined);
  const vertical = orientation === "vertical";
  const [available, setAvailable] = useState<number>();
  const upper = Math.min(max, available ?? max);
  const lower = Math.min(min, upper);
  const panelSize = Math.min(size, upper);
  const resize = (value: number) => onResize(Math.min(upper, Math.max(lower, Math.round(value))));
  const accessibleLabel = t("navigation.resize", { value0: label });

  useLayoutEffect(() => {
    const parent = ref.current?.parentElement;
    if (!parent) return;
    const measure = () => {
      const extent = vertical ? parent.clientWidth : parent.clientHeight;
      setAvailable(extent > 0 ? Math.floor(extent * ratio) : undefined);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    return () => observer.disconnect();
  }, [vertical, ratio]);

  return <div ref={ref} className="code-panel-divider" role="separator" tabIndex={0}
    aria-label={accessibleLabel} aria-controls={panelId} aria-orientation={orientation}
    aria-valuemin={lower} aria-valuemax={upper} aria-valuenow={panelSize} title={accessibleLabel}
    onPointerDown={(event) => {
      if (event.button !== 0 || event.isPrimary === false) return;
      event.preventDefault();
      const handle = event.currentTarget;
      const rect = handle.getBoundingClientRect();
      const scale = (vertical ? rect.width / handle.offsetWidth : rect.height / handle.offsetHeight) || 1;
      handle.focus({ preventScroll: true });
      handle.setPointerCapture(event.pointerId);
      handle.dataset.resizing = "true";
      drag.current = { id: event.pointerId, start: vertical ? event.clientX : event.clientY, size: panelSize, scale };
    }}
    onPointerMove={(event) => {
      const active = drag.current;
      if (active?.id !== event.pointerId) return;
      const coordinate = vertical ? event.clientX : event.clientY;
      resize(active.size + (active.start - coordinate) / active.scale);
    }}
    onLostPointerCapture={(event) => {
      if (drag.current?.id !== event.pointerId) return;
      drag.current = undefined;
      delete event.currentTarget.dataset.resizing;
    }}
    onKeyDown={(event) => {
      const { key } = event;
      const increase = vertical ? "ArrowLeft" : "ArrowUp";
      const decrease = vertical ? "ArrowRight" : "ArrowDown";
      if (key !== "Home" && key !== "End" && key !== increase && key !== decrease) return;
      event.preventDefault();
      resize(key === "Home" ? lower : key === "End" ? upper : panelSize + (key === increase ? 16 : -16));
    }} />;
}
