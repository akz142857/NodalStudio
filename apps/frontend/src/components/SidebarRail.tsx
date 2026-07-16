import { useEffect, useRef, type KeyboardEvent } from "react";

export type SidebarSide = "left" | "right";

type SidebarRailProps = {
  side: SidebarSide;
  expanded: boolean;
  width: number;
  minWidth: number;
  maxWidth: number;
  onResize: (width: number) => void;
  onToggle: () => void;
};

type HeaderSidebarToggleProps = Pick<SidebarRailProps, "side" | "expanded" | "onToggle">;

const KEYBOARD_STEP = 16;
const COLLAPSE_THRESHOLD = 72;
const REVEAL_THRESHOLD = 32;

type SidebarDrag = {
  startX: number;
  startWidth: number;
  startedExpanded: boolean;
  toggled: boolean;
};

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function HeaderSidebarToggle({
  side,
  expanded,
  onToggle,
}: HeaderSidebarToggleProps) {
  const panelName = side === "left" ? "left sidebar" : "right inspector";

  return (
    <button
      type="button"
      className={`header-sidebar-toggle header-sidebar-toggle-${side}`}
      aria-label={`${expanded ? "Collapse" : "Expand"} ${panelName}`}
      aria-expanded={expanded}
      title={`${expanded ? "Hide" : "Show"} ${panelName}`}
      onClick={onToggle}
    >
      <svg aria-hidden="true" viewBox="0 0 20 20">
        <rect x="2.5" y="3.5" width="15" height="13" rx="2.5" />
        <path d={side === "left" ? "M7 4v12" : "M13 4v12"} />
      </svg>
    </button>
  );
}

export function SidebarRail({
  side,
  expanded,
  width,
  minWidth,
  maxWidth,
  onResize,
  onToggle,
}: SidebarRailProps) {
  const drag = useRef<SidebarDrag | undefined>(undefined);
  const onResizeRef = useRef(onResize);
  const onToggleRef = useRef(onToggle);

  useEffect(() => {
    onResizeRef.current = onResize;
    onToggleRef.current = onToggle;
  }, [onResize, onToggle]);

  useEffect(() => {
    function move(event: PointerEvent) {
      if (!drag.current) return;
      const currentDrag = drag.current;
      const rawDelta = event.clientX - drag.current.startX;
      const delta = side === "left" ? rawDelta : -rawDelta;
      const nextWidth = currentDrag.startWidth + delta;

      if (currentDrag.startedExpanded) {
        if (nextWidth <= COLLAPSE_THRESHOLD && !currentDrag.toggled) {
          currentDrag.toggled = true;
          onToggleRef.current();
          return;
        }
        if (!currentDrag.toggled) {
          onResizeRef.current(clamp(nextWidth, minWidth, maxWidth));
        }
        return;
      }

      if (nextWidth >= REVEAL_THRESHOLD) {
        onResizeRef.current(clamp(nextWidth, minWidth, maxWidth));
        if (!currentDrag.toggled) {
          currentDrag.toggled = true;
          onToggleRef.current();
        }
      }
    }

    function stop() {
      drag.current = undefined;
      document.body.classList.remove("is-resizing-sidebar");
    }

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      drag.current = undefined;
      document.body.classList.remove("is-resizing-sidebar");
    };
  }, [maxWidth, minWidth, side]);

  function resizeFromKeyboard(event: KeyboardEvent<HTMLDivElement>) {
    if (!expanded) {
      const opensPanel =
        (side === "left" && event.key === "ArrowRight") ||
        (side === "right" && event.key === "ArrowLeft") ||
        event.key === "End";
      if (!opensPanel) return;
      event.preventDefault();
      onResize(minWidth);
      onToggle();
      return;
    }
    let nextWidth: number | undefined;
    if (event.key === "Home") nextWidth = minWidth;
    if (event.key === "End") nextWidth = maxWidth;
    if (event.key === "ArrowLeft") {
      nextWidth = width + (side === "left" ? -KEYBOARD_STEP : KEYBOARD_STEP);
    }
    if (event.key === "ArrowRight") {
      nextWidth = width + (side === "left" ? KEYBOARD_STEP : -KEYBOARD_STEP);
    }
    if (nextWidth === undefined) return;
    event.preventDefault();
    onResize(clamp(nextWidth, minWidth, maxWidth));
  }

  const panelName = side === "left" ? "left sidebar" : "right inspector";

  return (
    <div className={`sidebar-rail sidebar-rail-${side}`}>
      <div
        className="sidebar-resize-handle"
        role="separator"
        aria-label={`Resize ${panelName}`}
        aria-orientation="vertical"
        aria-valuemin={0}
        aria-valuemax={maxWidth}
        aria-valuenow={expanded ? width : 0}
        tabIndex={0}
        onDoubleClick={onToggle}
        onKeyDown={resizeFromKeyboard}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          drag.current = {
            startX: event.clientX,
            startWidth: expanded ? width : 0,
            startedExpanded: expanded,
            toggled: false,
          };
          document.body.classList.add("is-resizing-sidebar");
        }}
      />
    </div>
  );
}
