/** Opt-in synchronous spans. Production has no clock reads or retained events. */
export interface CanvasWork { kind: string; start: number; end: number; count?: number }
let observer: ((work: CanvasWork) => void) | undefined;
const noop = () => {};
export function observeCanvasWork(next: (work: CanvasWork) => void) {
  observer = next;
  return () => { if (observer === next) observer = undefined; };
}
export function startCanvasWork(kind: string, count?: number): () => void {
  const target = observer;
  if (!target) return noop;
  const start = performance.now();
  let ended = false;
  return () => {
    if (ended || observer !== target) return;
    ended = true;
    try { target({ kind, start, end: performance.now(), count }); }
    catch { /* Diagnostic observers must not change canvas behavior. */ }
  };
}
export function withCanvasWork<T>(kind: string, run: () => T, count?: number): T {
  const end = startCanvasWork(kind, count);
  try { return run(); } finally { end(); }
}
