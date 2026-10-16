import { useEffect, useMemo, useState } from "react";

/** Spread initial SVG mounts across frames. Coordinate/selection changes keep
 * the completed budget; a different graph or gesture presentation starts a new render sequence. */
export function useProgressiveEdges<T>(edges: T[], graph: object, enabled: boolean, ready: boolean, forceAll: boolean, settleBetweenBatches = false) {
  const [progress, setProgress] = useState<{ graph: object; count: number }>();
  const count = !enabled || forceAll ? edges.length : progress?.graph === graph ? progress.count : Math.min(32, edges.length);
  useEffect(() => {
    if (!enabled || !ready) return;
    let count = Math.min(32, edges.length);
    let frame = 0;
    // Recovery leaves a rendering opportunity between batches so the previous
    // store commit and passive effects need not collide with the next batch.
    const advance = () => {
      count = Math.min(edges.length, count + 128);
      setProgress({ graph, count });
      if (count < edges.length) frame = requestAnimationFrame(settleBetweenBatches
        ? () => { frame = requestAnimationFrame(advance); }
        : advance);
    };
    frame = requestAnimationFrame(advance);
    return () => cancelAnimationFrame(frame);
    // A highlighted edge list may change during rendering without being a new
    // graph. Its length is stable and must not restart or starve the sequence.
  }, [graph, enabled, ready, edges.length, settleBetweenBatches]);
  const renderedEdges = useMemo(() => count >= edges.length ? edges : edges.slice(0, count), [edges, count]);
  return { renderedEdges, pending: enabled && count < edges.length };
}
