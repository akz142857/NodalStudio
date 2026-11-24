import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import { useI18n } from "../../i18n";
import { normalizeQueryError } from "../../i18n/query-errors";
import type { DatabaseSnapshot, NodalStudioPlatform, QueryExecutionResult, TableDefinition, ViewDefinition } from "../../platform/types";
import { ActionIcon } from "../ActionIcon";
import { SchemaObjectMenu } from "../SchemaObjectMenu";
import { executableSql, TABLE_PREVIEW_ROW_LIMIT, tablePreviewSql } from "./query-format";
import { executeTableQuery } from "./table-query";
import "./quick-query-dock.css";

type Props = {
  platform: NodalStudioPlatform;
  snapshot: DatabaseSnapshot;
  relation: TableDefinition | ViewDefinition;
  reset: number;
  onResult: (result: QueryExecutionResult, sql: string) => void;
};
type Output = { kind: "error"; message: string }
  | { kind: "running" | "stopping" | "cancelled" };
type Position = { x: number; y: number };
type Size = { width: number; height: number };
type Corner = "top-left" | "top-right" | "bottom-left" | "bottom-right";
type PanelDrag = {
  pointerId: number;
  startedDocked: boolean;
  startX: number;
  startY: number;
  moved: boolean;
  offsetX: number;
  offsetY: number;
  grabFraction: number;
  detachAt?: Position;
};
type ResizeDrag = { pointerId: number; x: number; y: number; panel: DOMRect; area: DOMRect; scale: number; corner: Corner };
const corners: Corner[] = ["top-left", "top-right", "bottom-left", "bottom-right"];
const minimumWidth = 312;
const minimumHeight = 148;
const dockDistance = 32;
const detachDistance = 28;
const bottomCenter = { x: 0.5, y: 1 };
const positions = [
  { label: "tableData.quickQueryBottom", ...bottomCenter },
  { label: "tableData.quickQueryTopLeft", x: 0, y: 0 },
  { label: "tableData.quickQueryTopRight", x: 1, y: 0 },
  { label: "tableData.quickQueryBottomLeft", x: 0, y: 1 },
  { label: "tableData.quickQueryBottomRight", x: 1, y: 1 },
] as const;
const clamp = (value: number) => Math.min(1, Math.max(0, value));

function positionAtPointer(area: DOMRect, panel: DOMRect, pointer: Position, drag: PanelDrag, fallback: Position) {
  const width = area.width - panel.width;
  const height = area.height - panel.height;
  return {
    x: width > 0 ? clamp((pointer.x - drag.offsetX - area.left) / width) : fallback.x,
    y: height > 0 ? clamp((pointer.y - drag.offsetY - area.top) / height) : fallback.y,
  };
}

function boundsScale(element: HTMLElement, bounds: DOMRect) {
  return (element.offsetWidth && bounds.width / element.offsetWidth) || 1;
}

function atTopEdge(area: DOMRect, pointer: Position, scale: number) {
  const inset = 12 * scale;
  return pointer.x >= area.left - inset && pointer.x <= area.right + inset
    && pointer.y >= area.top - inset && pointer.y <= area.top + dockDistance * scale;
}

function resizeAxis(origin: number, size: number, area: number, delta: number, minimum: number, fromStart: boolean, anchor: number) {
  const opposite = fromStart ? origin + size : origin;
  const available = Math.max(0, fromStart ? opposite : area - opposite);
  const nextSize = Math.min(available, Math.max(minimum, size + (fromStart ? -delta : delta)));
  const range = area - nextSize;
  const start = fromStart ? opposite - nextSize : opposite;
  return { size: nextSize, anchor: range > 0 ? clamp(start / range) : anchor };
}

export function QuickQueryDock({ platform, snapshot, relation, reset, onResult }: Props) {
  const key = JSON.stringify(relation.key);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [docked, setDocked] = useState(true);
  const [layout, setLayout] = useState<{ position: Position; size?: Size }>({ position: bottomCenter });
  const move = useCallback((position: Position) => {
    setLayout((current) => current.position.x === position.x && current.position.y === position.y ? current : { ...current, position });
  }, []);
  const sql = drafts[key] ?? tablePreviewSql(relation, TABLE_PREVIEW_ROW_LIMIT, snapshot.database.databaseType);
  return <QuickQueryEditor key={`${key}:${reset}`} platform={platform} sourceId={snapshot.sourceId} sql={sql}
    onResult={onResult} position={layout.position} size={layout.size} docked={docked} onDockChange={setDocked}
    onMove={move}
    onResize={(size, position) => setLayout((current) => ({ size, position: position ?? current.position }))}
    onChange={(value) => setDrafts((current) => ({ ...current, [key]: value }))} />;
}

function QuickQueryEditor({ platform, sourceId, sql, onChange, onResult, position, size, docked, onDockChange, onMove, onResize }: Pick<Props, "platform" | "onResult"> & {
  sourceId: string;
  sql: string;
  onChange: (value: string) => void;
  position: Position;
  size?: Size;
  docked: boolean;
  onDockChange: (docked: boolean) => void;
  onMove: (position: Position) => void;
  onResize: (size?: Size, position?: Position) => void;
}) {
  const { t } = useI18n();
  const panelId = useId();
  const bounds = useRef<HTMLDivElement>(null);
  const dock = useRef<HTMLElement>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const positionButton = useRef<HTMLButtonElement>(null);
  const drag = useRef<PanelDrag | undefined>(undefined);
  const resize = useRef<ResizeDrag | undefined>(undefined);
  const request = useRef<AbortController | undefined>(undefined);
  const focusOnExpand = useRef(false);
  const [expanded, setExpanded] = useState(true);
  const [dragging, setDragging] = useState(false);
  const [dockTarget, setDockTarget] = useState(false);
  const [positionMenu, setPositionMenu] = useState<{ x: number; y: number }>();
  const [output, setOutput] = useState<Output>();
  const busy = output?.kind === "running" || output?.kind === "stopping";

  useEffect(() => {
    if (expanded && focusOnExpand.current) {
      focusOnExpand.current = false;
      editor.current?.focus();
    }
  }, [expanded]);
  useLayoutEffect(() => () => {
    request.current?.abort();
    request.current = undefined;
  }, []);

  useLayoutEffect(() => {
    const active = drag.current;
    if (docked || !active?.detachAt) return;
    const area = bounds.current?.getBoundingClientRect();
    const panel = dock.current?.getBoundingClientRect();
    if (!area || !panel) return;
    const pointer = active.detachAt;
    active.detachAt = undefined;
    active.offsetX = panel.width * active.grabFraction;
    onMove(positionAtPointer(area, panel, pointer, active, position));
  }, [docked, onMove, position]);

  function startDrag(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || event.isPrimary === false || drag.current || resize.current
      || (event.target instanceof Element && event.target.closest("button"))) return;
    const panel = dock.current?.getBoundingClientRect();
    if (!panel) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const offsetX = event.clientX - panel.left;
    drag.current = { pointerId: event.pointerId, startedDocked: docked, startX: event.clientX, startY: event.clientY, moved: false,
      offsetX, offsetY: event.clientY - panel.top, grabFraction: panel.width ? clamp(offsetX / panel.width) : 0.5 };
    setDragging(true);
  }

  function movePanel(event: PointerEvent<HTMLDivElement>) {
    const active = drag.current;
    const area = bounds.current;
    const panel = dock.current;
    if (!active || active.pointerId !== event.pointerId || !area || !panel) return;
    const rect = area.getBoundingClientRect();
    const scale = boundsScale(area, rect);
    const pointer = { x: event.clientX, y: event.clientY };
    if (!active.moved && Math.hypot(pointer.x - active.startX, pointer.y - active.startY) < 4 * scale) return;
    active.moved = true;
    if (docked) {
      if (pointer.y - active.startY < detachDistance * scale) return;
      active.detachAt = pointer;
      onDockChange(false);
      return;
    }
    setDockTarget(atTopEdge(rect, pointer, scale));
    onMove(positionAtPointer(rect, panel.getBoundingClientRect(), pointer, active, position));
  }

  function endDrag(event: PointerEvent<HTMLDivElement>, dropped: boolean) {
    const active = drag.current;
    if (active?.pointerId !== event.pointerId) return;
    drag.current = undefined;
    setDragging(false);
    setDockTarget(false);
    if (!dropped && active.startedDocked) onDockChange(true);
    const area = bounds.current;
    if (!dropped || !active.moved || docked || !area) return;
    const rect = area.getBoundingClientRect();
    if (atTopEdge(rect, { x: event.clientX, y: event.clientY }, boundsScale(area, rect))) onDockChange(true);
  }

  function startResize(event: PointerEvent<HTMLSpanElement>, corner: Corner) {
    const area = bounds.current;
    const panel = dock.current;
    if (event.button !== 0 || drag.current || resize.current || !area || !panel || !area.offsetWidth) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const rect = area.getBoundingClientRect();
    resize.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, area: rect, panel: panel.getBoundingClientRect(),
      scale: boundsScale(area, rect), corner };
  }

  function resizePanel(event: PointerEvent<HTMLSpanElement>) {
    const active = resize.current;
    if (!active || active.pointerId !== event.pointerId) return;
    const { area, panel, scale, corner } = active;
    const horizontal = resizeAxis(panel.left - area.left, panel.width, area.width, event.clientX - active.x, minimumWidth * scale, corner.endsWith("left"), position.x);
    const vertical = resizeAxis(panel.top - area.top, panel.height, area.height, event.clientY - active.y, minimumHeight * scale, corner.startsWith("top"), position.y);
    onResize({ width: horizontal.size / scale, height: vertical.size / scale }, { x: horizontal.anchor, y: vertical.anchor });
  }

  function endResize(event: PointerEvent<HTMLSpanElement>) {
    if (resize.current?.pointerId === event.pointerId) resize.current = undefined;
  }

  function stepSize(direction: number) {
    const area = bounds.current;
    const panel = dock.current;
    if (!area || !panel) return;
    onResize({
      width: Math.min(area.offsetWidth, Math.max(minimumWidth, panel.offsetWidth + direction * 48)),
      height: Math.min(area.offsetHeight, Math.max(minimumHeight, panel.offsetHeight + direction * 32)),
    });
  }

  async function run() {
    const field = editor.current;
    if (request.current || !field) return;
    const statement = executableSql(field.value, field.selectionStart, field.selectionEnd);
    if (!statement) return;
    const controller = new AbortController();
    request.current = controller;
    setOutput({ kind: "running" });
    try {
      const result = await executeTableQuery(platform, { sourceId, sql: statement, rowLimit: TABLE_PREVIEW_ROW_LIMIT, timeoutMs: 30_000 }, controller.signal);
      if (request.current !== controller) return;
      if (controller.signal.aborted) setOutput({ kind: "cancelled" });
      else {
        setOutput(undefined);
        onResult(result, statement);
      }
    } catch (error) {
      if (request.current === controller) setOutput(controller.signal.aborted ? { kind: "cancelled" }
        : { kind: "error", message: normalizeQueryError(t, error).message });
    } finally {
      if (request.current === controller) request.current = undefined;
    }
  }

  const panelStyle = {
    "--quick-query-x": `${position.x * 100}%`, "--quick-query-y": `${position.y * 100}%`,
    "--quick-query-width": size && `${size.width}px`, "--quick-query-height": size && `${size.height}px`,
  } as CSSProperties;
  return <div className="quick-query-layer" data-docked={docked || undefined}>
    <div ref={bounds} className="quick-query-bounds" aria-hidden="true">
      {dockTarget && <div className="quick-query-drop-guide"><span>{t("tableData.quickQueryDockTop")}</span></div>}
    </div>
    <section ref={dock} className="quick-query-dock ds-surface" style={panelStyle}
      data-expanded={expanded || undefined} aria-label={t("tableData.quickQuery")}>
      <div className="quick-query-bar" data-dragging={dragging || undefined}
        onPointerDown={startDrag} onPointerMove={movePanel} onPointerUp={(event) => endDrag(event, true)}
        onPointerCancel={(event) => endDrag(event, false)} onLostPointerCapture={(event) => endDrag(event, false)}>
        <button ref={toggle} type="button" className="ds-button quick-query-toggle" data-variant="ghost"
          aria-expanded={expanded} aria-controls={panelId} onClick={() => {
            focusOnExpand.current = !expanded;
            setExpanded(!expanded);
          }}>
          <ActionIcon name="viewer" />
          {t("tableData.quickQuery")}
          <ActionIcon name={docked !== expanded ? "chevronDown" : "chevronUp"} />
        </button>
        <span className="quick-query-grip" aria-hidden="true" />
        {expanded && <span id={`${panelId}-mode`} className="quick-query-mode">{t("business.readOnly")}</span>}
        <button ref={positionButton} type="button" className="ds-button quick-query-position" data-variant="ghost"
          title={t("tableData.quickQueryPosition")} aria-label={t("tableData.quickQueryPosition")}
          aria-haspopup="menu" aria-expanded={Boolean(positionMenu)}
          onPointerDown={(event) => { if (positionMenu) event.stopPropagation(); }} onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            setPositionMenu((current) => current ? undefined : { x: rect.left, y: rect.bottom });
          }}><ActionIcon name="more" /></button>
      </div>
      <div id={panelId} className="quick-query-panel" hidden={!expanded}>
        {expanded && <>
          <div className="quick-query-editor">
            <textarea ref={editor} aria-label={t("business.sQLEditor")} aria-describedby={`${panelId}-mode`} rows={3} value={sql} spellCheck={false}
              placeholder={t("business.writeAReadOnlySELECTQuery")} onChange={(event) => onChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void run();
                }
                if (event.key === "Escape") {
                  setExpanded(false);
                  toggle.current?.focus();
                }
              }} />
            <div className="quick-query-editor-actions">
              {busy ? <button type="button" className="ds-button quick-query-execute" data-size="small" disabled={output.kind === "stopping"} onClick={() => {
                request.current?.abort();
                setOutput({ kind: "stopping" });
              }}><ActionIcon name="stop" />{t("business.stop")}</button>
                : <button type="button" className="ds-button ds-primary quick-query-execute" data-size="small" aria-keyshortcuts="Meta+Enter Control+Enter"
                  disabled={!sql.trim()} onClick={() => void run()}><ActionIcon name="play" />{t("business.run")}</button>}
            </div>
          </div>
          {output?.kind === "error" && <p role="alert">{output.message}</p>}
          {output?.kind === "running" && <p role="status">{t("business.executingReadOnlyQuery")}</p>}
          {output?.kind === "stopping" && <p role="status">{t("business.cancelling")}</p>}
          {output?.kind === "cancelled" && <p role="status">{t("business.cancelled")}</p>}
        </>}
      </div>
      {expanded && !docked && corners.map((corner) => <span key={corner} aria-hidden="true" className="quick-query-resize" data-corner={corner}
        title={t("tableData.quickQueryResize")} onPointerDown={(event) => startResize(event, corner)} onPointerMove={resizePanel}
        onPointerUp={endResize} onPointerCancel={endResize} onLostPointerCapture={endResize} />)}
      {positionMenu && <SchemaObjectMenu {...positionMenu} name={t("tableData.quickQueryPosition")} showName={false}
        actions={[
          { label: t(docked ? "tableData.quickQueryFloat" : "tableData.quickQueryDockTop"), run: () => onDockChange(!docked) },
          ...positions.map(({ label, x, y }, index) => ({
            label: t(label), checked: !docked && position.x === x && position.y === y, separatorBefore: index === 0,
            run: () => { onDockChange(false); onMove({ x, y }); },
          })),
          ...(expanded && !docked ? [
            { label: t("tableData.quickQueryLarger"), separatorBefore: true, run: () => stepSize(1) },
            { label: t("tableData.quickQuerySmaller"), run: () => stepSize(-1) },
            { label: t("tableData.quickQueryResetSize"), disabled: !size, run: () => onResize() },
          ] : []),
        ]}
        onClose={(restoreFocus) => { setPositionMenu(undefined); if (restoreFocus) positionButton.current?.focus({ preventScroll: true }); }} />}
    </section>
  </div>;
}
