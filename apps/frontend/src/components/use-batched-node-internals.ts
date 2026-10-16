import { useCallback } from "react";
import { useStoreApi } from "@xyflow/react";
import { startCanvasWork } from "../graph/canvas-work";

const batches = new WeakMap<object, { ids: Set<string>; queued: boolean }>();

/** Coalesce card effects into one React Flow measurement per animation frame.
 * Resolve mounted cards at measurement time; culled or replaced DOM is skipped. */
export function useBatchedNodeInternals() {
  const store = useStoreApi();
  return useCallback((id: string) => {
    // Each hook receives a wrapper; getState identifies the shared canvas store.
    let batch = batches.get(store.getState);
    if (!batch) { batch = { ids: new Set(), queued: false }; batches.set(store.getState, batch); }
    batch.ids.add(id);
    if (batch.queued) return;
    batch.queued = true;
    requestAnimationFrame(() => {
      const finishBatch = startCanvasWork("node-internals:batch", batch.ids.size);
      try {
        batch.queued = false;
        const requested = new Set(batch.ids); batch.ids.clear();
        const state = store.getState();
        const updates = new Map<string, { id: string; nodeElement: HTMLDivElement; force: true }>();
        state.domNode?.querySelectorAll<HTMLDivElement>(".react-flow__node").forEach((nodeElement) => {
          const nodeId = nodeElement.getAttribute("data-id");
          if (nodeId && requested.has(nodeId)) {
            updates.set(nodeId, { id: nodeId, nodeElement, force: true });
          }
        });
        if (!updates.size) return;
        // DOM ports become authoritative only for cards actually measured now.
        const replacements = state.nodes.filter((node) => updates.has(node.id) && node.handles)
          .map((node) => ({ type: "replace" as const, id: node.id, item: { ...node, handles: undefined } }));
        if (replacements.length) {
          const end = startCanvasWork("node-internals:retire-provisional", replacements.length);
          try { state.triggerNodeChanges(replacements); } finally { end(); }
        }
        const end = startCanvasWork("node-internals:measure", updates.size);
        try { state.updateNodeInternals(updates, { triggerFitView: false }); } finally { end(); }
      } finally { finishBatch(); }
    });
  }, [store]);
}
