import { useI18n } from "../i18n";
import { MiniMap, Panel, useReactFlow, useStore, useStoreApi, type ReactFlowState } from "@xyflow/react";
import { XYMinimap, type Rect, type XYPosition } from "@xyflow/system";
import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";

export const MINIMAP_WIDTH = 200;
export const MINIMAP_HEIGHT = 150;

/** Dense diagrams need one drawing and one subscription, rather than a mounted
 * React component and store subscription for every offscreen table. */
export const DiagramMiniMap = memo(function DiagramMiniMap({ dense }: { dense: boolean }) {
  const { t } = useI18n();
  const { setCenter, getZoom } = useReactFlow();
  const [hovered, setHovered] = useState(false);
  const [pressedPointer, setPressedPointer] = useState<number>();
  const expanded = hovered || pressedPointer !== undefined;
  const width = expanded ? MINIMAP_WIDTH : MINIMAP_WIDTH / 2;
  const height = expanded ? MINIMAP_HEIGHT : MINIMAP_HEIGHT / 2;

  useEffect(() => {
    if (!expanded) return;
    const release = (event: PointerEvent) => {
      if (event.pointerId === pressedPointer) setPressedPointer(undefined);
    };
    const blur = () => { setPressedPointer(undefined); setHovered(false); };
    window.addEventListener("pointerup", release, true);
    window.addEventListener("pointercancel", release, true);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("pointerup", release, true);
      window.removeEventListener("pointercancel", release, true);
      window.removeEventListener("blur", blur);
    };
  }, [expanded, pressedPointer]);

  const navigate = ({ x, y }: XYPosition) => { void setCenter(x, y, { zoom: getZoom() }); };

  return <div className="canvas-minimap nopan nowheel"
    onPointerEnter={(event) => { if (event.pointerType !== "touch") setHovered(true); }}
    onPointerLeave={() => setHovered(false)}
    onMouseDownCapture={(event) => {
      // The focusable canvas underneath would blur Tools and shift the map before the click lands.
      if (event.button === 0) event.preventDefault();
    }}
    onPointerDown={(event) => {
      if (expanded && event.button === 0 && event.isPrimary) setPressedPointer(event.pointerId);
    }}>
    {dense ? <DenseMiniMap width={width} height={height} onNavigate={navigate} /> :
      <MiniMap style={{ width, height }} offsetScale={5 * width / MINIMAP_WIDTH} pannable zoomable ariaLabel={t("business.miniMap")}
        onClick={(_event, position) => navigate(position)} />}
  </div>;
});

type Miniature = Rect & { selected: boolean; seen: number };
function drawingCache() { return { nodes: new Map<string, Miniature>(), paths: "", selected: "", epoch: 0 }; }
function snapshot(state: ReactFlowState, cache: ReturnType<typeof drawingCache>) {
  const epoch = ++cache.epoch;
  let normalChanged = false, selectedChanged = false;
  const [x, y, zoom] = state.transform;
  const view: Rect = { x: -x / zoom, y: -y / zoom, width: state.width / zoom, height: state.height / zoom };
  let left = view.x, top = view.y, right = view.x + view.width, bottom = view.y + view.height;
  let count = 0;
  for (const node of state.nodeLookup.values()) {
    if (node.hidden) continue;
    const width = node.measured.width ?? node.width ?? 0, height = node.measured.height ?? node.height ?? 0;
    if (!width || !height) continue;
    const { x, y } = node.internals.positionAbsolute;
    left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x + width); bottom = Math.max(bottom, y + height);
    const selected = Boolean(node.selected), previous = cache.nodes.get(node.id);
    if (!previous || previous.x !== x || previous.y !== y || previous.width !== width || previous.height !== height || previous.selected !== selected) {
      if (!selected || previous && !previous.selected) normalChanged = true;
      if (selected || previous?.selected) selectedChanged = true;
      cache.nodes.set(node.id, { x, y, width, height, selected, seen: epoch });
    } else previous.seen = epoch;
    count++;
  }
  for (const [id, node] of cache.nodes) if (node.seen !== epoch) {
    if (node.selected) selectedChanged = true; else normalChanged = true;
    cache.nodes.delete(id);
  }
  const path = (selected: boolean) => [...cache.nodes.values()].filter((node) => node.selected === selected)
    .map(({ x, y, width, height }) => `M${x},${y}h${width}v${height}h${-width}z`).join("");
  if (normalChanged) cache.paths = path(false);
  if (selectedChanged) cache.selected = path(true);
  const scale = Math.max((right - left) / MINIMAP_WIDTH, (bottom - top) / MINIMAP_HEIGHT, 1);
  const offset = 5 * scale, width = MINIMAP_WIDTH * scale + offset * 2, height = MINIMAP_HEIGHT * scale + offset * 2;
  const boxX = left - (MINIMAP_WIDTH * scale - right + left) / 2 - offset;
  const boxY = top - (MINIMAP_HEIGHT * scale - bottom + top) / 2 - offset;
  return { paths: cache.paths, selected: cache.selected, count, scale,
    viewBox: `${boxX} ${boxY} ${width} ${height}`,
    mask: `M${boxX - offset},${boxY - offset}h${width + offset * 2}v${height + offset * 2}h${-width - offset * 2}zM${view.x},${view.y}h${view.width}v${view.height}h${-view.width}z` };
}

function DenseMiniMap({ width, height, onNavigate }: { width: number; height: number; onNavigate: (position: XYPosition) => void }) {
  const { t: bt } = useI18n();
  const store = useStoreApi();
  const panZoom = useStore((state) => state.panZoom);
  const svg = useRef<SVGSVGElement>(null);
  const minimap = useRef<ReturnType<typeof XYMinimap> | null>(null);
  const [drawing, setDrawing] = useState({ paths: "", selected: "", count: 0, scale: 1, viewBox: "0 0 210 160", mask: "" });
  const scale = useRef(drawing.scale * MINIMAP_WIDTH / width);
  useLayoutEffect(() => { scale.current = drawing.scale * MINIMAP_WIDTH / width; }, [drawing.scale, width]);
  useEffect(() => {
    const cache = drawingCache();
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const next = snapshot(store.getState(), cache);
        setDrawing((previous) => previous.paths === next.paths && previous.selected === next.selected && previous.viewBox === next.viewBox && previous.mask === next.mask ? previous : next);
      });
    };
    const unsubscribe = store.subscribe((state, previous) => {
      if (state.nodes !== previous.nodes || state.transform !== previous.transform || state.width !== previous.width || state.height !== previous.height) schedule();
    });
    schedule();
    return () => { unsubscribe(); if (frame) cancelAnimationFrame(frame); };
  }, [store]);
  useEffect(() => {
    if (!svg.current || !panZoom) return;
    const instance = XYMinimap({ domNode: svg.current, panZoom, getTransform: () => store.getState().transform, getViewScale: () => scale.current });
    minimap.current = instance;
    const update = () => { const state = store.getState(); instance.update({ translateExtent: state.translateExtent, width: state.width, height: state.height, pannable: true, zoomable: true }); };
    update();
    const unsubscribe = store.subscribe((state, previous) => { if (state.width !== previous.width || state.height !== previous.height || state.translateExtent !== previous.translateExtent) update(); });
    return () => { unsubscribe(); instance.destroy(); minimap.current = null; };
  }, [store, panZoom]);
  return <Panel position="bottom-right" className="react-flow__minimap" data-testid="rf__minimap" data-minimap-nodes={drawing.count}>
    <svg ref={svg} width={width} height={height} viewBox={drawing.viewBox} className="react-flow__minimap-svg" role="img" aria-label={bt("business.miniMap")}
      onClick={(event) => {
        if (!minimap.current) return;
        const [x, y] = minimap.current.pointer(event.nativeEvent, event.currentTarget);
        onNavigate({ x, y });
      }}>
      <path className="react-flow__minimap-node" d={drawing.paths} />
      <path className="react-flow__minimap-node selected" d={drawing.selected} />
      <path className="react-flow__minimap-mask" d={drawing.mask} fillRule="evenodd" pointerEvents="none" />
    </svg>
  </Panel>;
}
