import { useEffect, useId, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../i18n";
import { MIN_COLUMN_WIDTH, MAX_COLUMN_WIDTH } from "../platform/table-data-preferences";
import { SchemaObjectMenu } from "./SchemaObjectMenu";
import "./data-column-header.css";

export function DataColumnHeader({ name, databaseType, comment, width, onResize, onResizeCommit, onSelect, selected, direction, onSort, canClearSort, sortDisabled }: {
  name: string;
  databaseType: string;
  comment?: string | null;
  width: number;
  onResize: (width: number) => void;
  onResizeCommit?: (width: number) => void;
  onSelect?: () => void;
  selected?: boolean;
  direction?: "asc" | "desc";
  onSort?: (direction?: "asc" | "desc") => void;
  canClearSort?: boolean;
  sortDisabled?: boolean;
}) {
  const { t } = useI18n();
  const [menu, setMenu] = useState<{ x: number; y: number }>();
  const [commentAnchor, setCommentAnchor] = useState<HTMLElement>();
  const commentText = comment?.trim();
  const commentId = useId();
  const hoverTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const trigger = useRef<HTMLButtonElement>(null);
  const stopResize = useRef<() => void>(undefined);
  useEffect(() => () => stopResize.current?.(), []);
  useEffect(() => () => clearTimeout(hoverTimer.current), []);

  function closeComment() {
    clearTimeout(hoverTimer.current);
    setCommentAnchor(undefined);
  }

  function hoverComment(event: PointerEvent<HTMLElement>) {
    if (!commentText || event.pointerType === "touch") return;
    const anchor = event.currentTarget;
    clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(() => setCommentAnchor(anchor), 400);
  }

  function constrain(nextWidth: number) {
    return Math.round(Math.max(MIN_COLUMN_WIDTH, Math.min(MAX_COLUMN_WIDTH, nextWidth)));
  }

  function toggleMenu(button: HTMLButtonElement) {
    closeComment();
    const bounds = button.getBoundingClientRect();
    setMenu(menu ? undefined : { x: bounds.left, y: bounds.bottom });
  }

  function beginResize(event: ReactMouseEvent<HTMLSpanElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    closeComment();
    const startX = event.clientX;
    const handle = event.currentTarget;
    const scale = (handle.offsetWidth && handle.getBoundingClientRect().width / handle.offsetWidth) || 1;
    stopResize.current?.();
    document.body.classList.add("is-resizing-query-column");
    handle.dataset.resizing = "true";
    let nextWidth = width;
    const move = (moveEvent: MouseEvent) => {
      const adjusted = constrain(width + (moveEvent.clientX - startX) / scale);
      if (adjusted === nextWidth) return;
      nextWidth = adjusted;
      onResize(nextWidth);
    };
    const finish = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", finish);
      window.removeEventListener("blur", finish);
      document.body.classList.remove("is-resizing-query-column");
      delete handle.dataset.resizing;
      stopResize.current = undefined;
      if (nextWidth !== width) onResizeCommit?.(nextWidth);
    };
    stopResize.current = finish;
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", finish);
    window.addEventListener("blur", finish);
  }

  const label = <><span title={commentText ? undefined : name}>{name}</span><small title={commentText ? undefined : databaseType}>{databaseType}</small></>;
  return (
    <th scope="col" className="data-column-header" data-column-selected={selected || undefined}
      aria-sort={direction === "asc" ? "ascending" : direction === "desc" ? "descending" : undefined}
      onClick={onSelect && ((event) => {
        const target = event.target;
        if (target instanceof Element && event.currentTarget.contains(target) && !target.closest("button, [role='separator']")) onSelect();
      })}>
      <div className="data-column-heading">
        {onSelect ? <button type="button" className="data-column-label data-column-name" aria-label={name}
          aria-description={[databaseType, commentText].filter(Boolean).join(". ")}
          aria-describedby={commentAnchor && commentText ? commentId : undefined}
          aria-pressed={selected} onClick={() => { closeComment(); onSelect(); }}
          onPointerEnter={hoverComment} onPointerLeave={closeComment} onBlur={closeComment}
          onFocus={(event) => {
            if (commentText && event.currentTarget.matches(":focus-visible")) setCommentAnchor(event.currentTarget);
          }}>{label}</button>
          : <div className="data-column-label" onPointerEnter={hoverComment} onPointerLeave={closeComment}>{label}</div>}
        {(onSort || direction) && <div className="data-column-actions">
          {direction && <span className="data-column-sort-direction" aria-hidden="true">{direction === "asc" ? "↑" : "↓"}</span>}
          {onSort && <button ref={trigger} type="button" className="data-column-menu-trigger" aria-label={t("tableData.sortBy", { value0: name })}
            aria-haspopup="menu" aria-expanded={Boolean(menu)} disabled={sortDisabled}
            onClick={(event) => toggleMenu(event.currentTarget)} onKeyDown={(event) => {
              if (event.key !== "ArrowDown") return;
              event.preventDefault();
              toggleMenu(event.currentTarget);
            }}>
            <span className="data-column-chevron" aria-hidden="true" />
          </button>}
        </div>}
      </div>
      <span className="data-column-resizer" role="separator" aria-label={t("business.resizeColumn", { value0: name })}
        aria-orientation="vertical" aria-valuemin={MIN_COLUMN_WIDTH} aria-valuemax={MAX_COLUMN_WIDTH} aria-valuenow={width} tabIndex={0}
        onMouseDown={beginResize} onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          const nextWidth = constrain(width + (event.key === "ArrowRight" ? 16 : -16));
          if (nextWidth === width) return;
          onResize(nextWidth);
          onResizeCommit?.(nextWidth);
        }} />
      {menu && onSort && !sortDisabled && <SchemaObjectMenu {...menu} name={name} showName={false} className="data-column-sort-menu"
        actions={[
          { label: t("tableData.sortAscending"), checked: direction === "asc", run: () => onSort("asc") },
          { label: t("tableData.sortDescending"), checked: direction === "desc", run: () => onSort("desc") },
          { label: t("tableData.clearSort"), disabled: !canClearSort, run: () => onSort() },
        ]} onClose={(restoreFocus) => { setMenu(undefined); if (restoreFocus) trigger.current?.focus(); }} />}
      {commentAnchor && commentText && <ColumnComment id={commentId} anchor={commentAnchor}
        text={commentText} onDismiss={() => setCommentAnchor(undefined)} />}
    </th>
  );
}

function ColumnComment({ id, anchor, text, onDismiss }: {
  id: string; anchor: HTMLElement; text: string; onDismiss: () => void;
}) {
  const tip = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = tip.current;
    if (!element) return;
    const bounds = anchor.getBoundingClientRect();
    const size = element.getBoundingClientRect();
    const scale = (element.offsetWidth && size.width / element.offsetWidth) || 1;
    const gap = 6 * scale;
    const left = Math.max(gap, Math.min(bounds.left, window.innerWidth - size.width - gap));
    const below = bounds.bottom + gap;
    const top = below + size.height < window.innerHeight - gap ? below : Math.max(gap, bounds.top - size.height - gap);
    element.style.left = `${left / scale}px`;
    element.style.top = `${top / scale}px`;
  }, [anchor, text]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") onDismiss(); };
    window.addEventListener("keydown", escape);
    window.addEventListener("scroll", onDismiss, true);
    window.addEventListener("resize", onDismiss);
    return () => {
      window.removeEventListener("keydown", escape);
      window.removeEventListener("scroll", onDismiss, true);
      window.removeEventListener("resize", onDismiss);
    };
  }, [onDismiss]);
  return createPortal(<div ref={tip} id={id} className="data-column-comment" role="tooltip">{text}</div>, document.body);
}
