import { observeCanvasWork, type CanvasWork } from "../graph/canvas-work";

export interface TraceSpan extends CanvasWork { phase: string; detail: string }
export interface ReactTiming {
  kind: "react-render" | "react-commit-wall" | "react-layout-effects" | "react-passive-effects";
  phase: string; detail: string; at: number; duration: number; commitTime: number;
}
export interface FrameWindow { start: number; end: number; ms: number; phase: string; detail: string }

/** Nested spans describe inclusive work; union them before subtracting from a
 * frame. The remainder is UNATTRIBUTED, never a JavaScript estimate of paint. */
export function coveredTime(spans: { start: number; end: number }[], start: number, end: number) {
  const ranges = spans.map((span) => [Math.max(start, span.start), Math.min(end, span.end)])
    .filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0]);
  let total = 0, cursor = start;
  for (const [a, b] of ranges) { total += Math.max(0, b - Math.max(cursor, a)); cursor = Math.max(cursor, b); }
  return total;
}
export class CanvasAttribution {
  phase = "idle";
  detail = "idle";
  contextDetail?: () => string;
  spans: TraceSpan[] = [];
  react: ReactTiming[] = [];
  frames: FrameWindow[] = [];
  dropped = 0;
  anchor = { epochMs: Date.now(), performanceMs: performance.now(), timeOrigin: performance.timeOrigin };
  constructor(private limit = 30000) {}
  reset() {
    this.spans = []; this.react = []; this.frames = []; this.dropped = 0;
    this.anchor = { epochMs: Date.now(), performanceMs: performance.now(), timeOrigin: performance.timeOrigin };
  }
  span(work: CanvasWork) {
    if (this.spans.length + this.react.length >= this.limit) { this.dropped++; return; }
    this.spans.push({ ...work, phase: this.phase, detail: this.contextDetail?.() ?? this.detail });
  }
  effect(kind: ReactTiming["kind"], duration: number, commitTime: number) {
    if (this.spans.length + this.react.length >= this.limit) { this.dropped++; return; }
    this.react.push({ kind, phase: this.phase, detail: this.contextDetail?.() ?? this.detail, at: performance.now(), duration, commitTime });
  }
  frame(frame: FrameWindow) {
    if (this.frames.length >= this.limit) { this.dropped++; return; }
    this.frames.push(frame);
  }
  summary(phase: string) {
    const work = this.spans.filter((span) => span.phase === phase);
    const kinds = [...new Set([...work.map((span) => span.kind), ...this.react.filter((r) => r.phase === phase).map((r) => r.kind)])];
    const totals = kinds.map((kind) => {
      const values = [...work.filter((span) => span.kind === kind).map((span) => span.end - span.start), ...this.react.filter((r) => r.phase === phase && r.kind === kind).map((r) => r.duration)];
      return { attributionPhase: phase, kind, calls: values.length, totalMs: values.reduce((a, b) => a + b, 0), maxMs: Math.max(0, ...values) };
    });
    const gaps = this.frames.filter((frame) => frame.phase === phase && frame.ms > 45).sort((a, b) => b.ms - a.ms).slice(0, 10).map((frame) => {
      const instrumentedWallMs = coveredTime(work, frame.start, frame.end);
      const effects = this.react.filter((r) => r.at > frame.start && r.at <= frame.end);
      const sum = (kind: ReactTiming["kind"]) => effects.filter((r) => r.kind === kind).reduce((n, r) => n + r.duration, 0);
      return { attributionPhase: phase, frame: { ...frame, instrumentedWallMs, unattributedWallMs: Math.max(0, frame.ms - instrumentedWallMs), renderMs: sum("react-render"), commitWallMs: sum("react-commit-wall"), layoutEffectsMs: sum("react-layout-effects"), passiveEffectsMs: sum("react-passive-effects") } };
    });
    const longest = [...work].sort((a, b) => b.end - b.start - (a.end - a.start)).slice(0, 8).map((span) => ({ attributionPhase: phase, longestSpan: span }));
    return [...totals, ...gaps, ...longest];
  }
  snapshot() { return { anchor: this.anchor, dropped: this.dropped, spans: this.spans, react: this.react, frames: this.frames }; }
}

/** Diagnostic build only. No DOM inventory reads, forced layouts or UI updates
 * inside the callbacks. Keep cancellation IDs and ResizeObserver semantics. */
export function installCanvasAttribution(trace: CanvasAttribution) {
  const release = observeCanvasWork((work) => trace.span(work));
  const raf = window.requestAnimationFrame;
  const Resize = window.ResizeObserver;
  window.requestAnimationFrame = (callback) => raf.call(window, (now) => {
    const start = performance.now();
    try { callback(now); } finally { trace.span({ kind: "raf-callback", start, end: performance.now() }); }
  });
  if (Resize) window.ResizeObserver = class extends Resize {
    constructor(callback: ResizeObserverCallback) {
      super((entries, observer) => {
        const start = performance.now();
        try { callback(entries, observer); } finally { trace.span({ kind: "resize-observer", start, end: performance.now(), count: entries.length }); }
      });
    }
  };
  return () => { release(); window.requestAnimationFrame = raf; window.ResizeObserver = Resize; };
}
