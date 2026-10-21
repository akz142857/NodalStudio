import { Position, useStoreApi } from "@xyflow/react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import type { RelationshipEndpoint } from "../platform";
import type { FieldEdge, TableNode } from "../graph/schema-graph";
import { sameRelationshipEndpoint } from "../graph/relationship-interaction";

interface Field { row: HTMLElement; nodeId: string; endpoint: RelationshipEndpoint }
interface Options {
  enabled: boolean;
  scope: string;
  onStart: (source: RelationshipEndpoint | undefined) => void;
  onComplete: (source: RelationshipEndpoint, target: RelationshipEndpoint) => void;
}

/** Row hit testing is separate from edge geometry: keep ports at the row edges. */
export function useFieldRowConnection(options: Options) {
  const store = useStoreApi<TableNode, FieldEdge>();
  const latest = useRef(options);
  useLayoutEffect(() => { latest.current = options; });
  const cleanup = useRef<(() => void) | undefined>(undefined);
  const suppressClick = useRef(false);
  const [active, setActive] = useState(false);
  useEffect(() => () => cleanup.current?.(), [options.enabled, options.scope]);

  const onMouseDown = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    suppressClick.current = false;
    if (!latest.current.enabled || event.button !== 0 || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return;
    const root = event.currentTarget;
    const fieldAt = (element: Element | null): Field | undefined => {
      if (!element || !root.contains(element)) return;
      const candidate = element.closest<HTMLElement>(".table-column, .field-handle-row");
      const nodeElement = candidate?.closest<HTMLElement>(".react-flow__node");
      const nodeId = nodeElement?.dataset.id;
      const name = candidate?.dataset.columnName;
      const node = nodeId ? store.getState().nodeLookup.get(nodeId) : undefined;
      if (!node || !node.data.relationshipsEditable || !name || !node.data.table.columns.some((column) => column.name === name)) return;
      const row = candidate?.classList.contains("table-column") ? candidate : Array.from(nodeElement!.querySelectorAll<HTMLElement>(".table-column")).find((item) => item.dataset.columnName === name);
      if (row) return { row, nodeId: node.id, endpoint: { schema: node.data.schema, table: node.data.table.key.name, columns: [name] } };
    };
    const picked = fieldAt(event.target instanceof Element ? event.target : null);
    if (!picked) return;
    const source: Field = picked;
    // Capture before React Flow's node/pane drag handlers. A plain click still
    // bubbles normally and retains selection, double-click and context menus.
    event.stopPropagation();
    event.preventDefault();
    // Preventing the native mousedown also prevents its focus transfer. Keep
    // keyboard actions on the selected canvas node, not a previously used input.
    source.row.closest<HTMLElement>(".react-flow__node")?.focus({ preventScroll: true });
    cleanup.current?.();
    const doc = root.ownerDocument;
    const win = doc.defaultView!;
    const origin = { x: event.clientX, y: event.clientY };
    let pointer = origin;
    let started = false;
    let frame = 0;
    let side = Position.Right;
    let hovered: HTMLElement | undefined;
    let lastFrame = 0;
    let paintedTransform: number[] | undefined;

    const targetAtPointer = () => fieldAt(doc.elementFromPoint(pointer.x, pointer.y));
    const paint = () => {
      const state = store.getState();
      paintedTransform = state.transform;
      const bounds = state.domNode?.getBoundingClientRect();
      const fromNode = state.nodeLookup.get(source.nodeId);
      if (!bounds || !fromNode || !source.row.isConnected) { finish(); return; }
      const target = targetAtPointer();
      const valid = Boolean(target && !sameRelationshipEndpoint(source.endpoint, target.endpoint));
      if (hovered !== target?.row) { hovered?.removeAttribute("data-row-drop"); hovered = target?.row; }
      if (hovered) hovered.dataset.rowDrop = valid ? "valid" : "invalid";
      const sourceBounds = source.row.getBoundingClientRect();
      const targetBounds = target?.row.getBoundingClientRect();
      const targetSide = targetBounds && targetBounds.left + targetBounds.width / 2 < sourceBounds.left + sourceBounds.width / 2 ? Position.Right : Position.Left;
      const [tx, ty, zoom] = state.transform;
      const from = { x: ((side === Position.Right ? sourceBounds.right : sourceBounds.left) - bounds.left - tx) / zoom, y: (sourceBounds.top + sourceBounds.height / 2 - bounds.top - ty) / zoom };
      const to = valid && targetBounds
        ? { x: (targetSide === Position.Right ? targetBounds.right : targetBounds.left) - bounds.left, y: targetBounds.top + targetBounds.height / 2 - bounds.top }
        : { x: pointer.x - bounds.left, y: pointer.y - bounds.top };
      state.updateConnection({ inProgress: true, from, fromNode, fromPosition: side,
        fromHandle: { id: `source:${source.endpoint.columns[0]}:${side}`, nodeId: source.nodeId, type: "source", position: side, x: from.x - fromNode.internals.positionAbsolute.x, y: from.y - fromNode.internals.positionAbsolute.y, width: 0, height: 0 },
        to, toPosition: targetSide, toNode: target ? state.nodeLookup.get(target.nodeId) ?? null : null,
        toHandle: valid && target ? { id: `target:${target.endpoint.columns[0]}:${targetSide}`, nodeId: target.nodeId, type: "target", position: targetSide, x: (to.x - tx) / zoom, y: (to.y - ty) / zoom, width: 0, height: 0 } : null,
        isValid: target ? valid : null, pointer: { x: pointer.x - bounds.left, y: pointer.y - bounds.top } });
    };
    const tick = (time: number) => {
      if (!started) return;
      if (!lastFrame || store.getState().transform !== paintedTransform) paint();
      if (!started) return;
      const state = store.getState();
      const bounds = state.domNode?.getBoundingClientRect();
      if (bounds && state.autoPanOnConnect) {
        const speed = state.autoPanSpeed * Math.min(2, lastFrame ? (time - lastFrame) / 16.67 : 1);
        const delta = (value: number, min: number, max: number) => value < min + 40 ? speed : value > max - 40 ? -speed : 0;
        const x = delta(pointer.x, bounds.left, bounds.right), y = delta(pointer.y, bounds.top, bounds.bottom);
        if (x || y) void state.panBy({ x, y });
      }
      lastFrame = time;
      frame = win.requestAnimationFrame(tick);
    };
    const move = (next: MouseEvent) => {
      // A mouseup outside the window is not always delivered to this document.
      // Cancel on re-entry instead of leaving a live connection on the pointer.
      if ((next.buttons & 1) === 0) { finish(); return; }
      pointer = { x: next.clientX, y: next.clientY };
      if (!started && Math.hypot(pointer.x - origin.x, pointer.y - origin.y) >= 6) {
        started = true;
        suppressClick.current = true;
        side = pointer.x < origin.x ? Position.Left : Position.Right;
        source.row.dataset.rowSource = "true";
        latest.current.onStart(source.endpoint);
        setActive(true);
        frame = win.requestAnimationFrame(tick);
      }
      if (started) { next.preventDefault(); paint(); }
    };
    function finish() {
      doc.removeEventListener("mousemove", move);
      doc.removeEventListener("mouseup", up);
      doc.removeEventListener("keydown", key, true);
      win.removeEventListener("blur", finish);
      doc.removeEventListener("visibilitychange", visibility);
      win.cancelAnimationFrame(frame);
      source.row.removeAttribute("data-row-source");
      hovered?.removeAttribute("data-row-drop");
      if (started) { store.getState().cancelConnection(); latest.current.onStart(undefined); setActive(false); }
      started = false;
      cleanup.current = undefined;
    }
    function up(next: MouseEvent) {
      if (next.button !== 0) return;
      pointer = { x: next.clientX, y: next.clientY };
      const target = started ? targetAtPointer() : undefined;
      const complete = started && latest.current.enabled && target && !sameRelationshipEndpoint(source.endpoint, target.endpoint);
      finish();
      if (complete && target) latest.current.onComplete(source.endpoint, target.endpoint);
    }
    function key(next: KeyboardEvent) { if (next.key === "Escape" || next.code === "Space") { next.preventDefault(); next.stopPropagation(); finish(); } }
    function visibility() { if (doc.hidden) finish(); }
    cleanup.current = finish;
    doc.addEventListener("mousemove", move);
    doc.addEventListener("mouseup", up);
    doc.addEventListener("keydown", key, true);
    win.addEventListener("blur", finish);
    doc.addEventListener("visibilitychange", visibility);
  }, [store]);
  const onClick = useCallback((event: ReactMouseEvent) => {
    if (suppressClick.current) {
      // Suppress the synthetic canvas click after dragging, never a subsequent
      // keyboard activation inside the relationship confirmation form.
      if (event.target instanceof Element && event.target.closest(".react-flow")) { event.preventDefault(); event.stopPropagation(); }
      suppressClick.current = false;
    }
  }, []);
  return { active, onMouseDown, onClick };
}
