import { act } from "@testing-library/react";
import { vi } from "vitest";

// captureExportBatches can shrink to one item per batch. Each edge batch can
// await label measurement and then yield for work; table batches only yield.
// Add the two-frame mount/restore waits and one final yield for each phase.
export function diagramExportFrameBudget({ edgeCount, tableCount }: { edgeCount: number; tableCount: number }) {
  return edgeCount * 2 + tableCount + 2 + 2 + 1 + 1;
}

// Drive real React/React Flow commits one frame at a time. Recovery deliberately
// leaves a frame between batches, so completion has no one-second wall-clock SLA.
export function animationFrames(interval: number) {
  let sequence = 0, time = 0;
  const pending = new Map<number, FrameRequestCallback>();
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => { pending.set(++sequence, callback); return sequence; });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => { pending.delete(id); });
  const advance = async () => {
    time += interval;
    await act(async () => {
      for (const [id, callback] of [...pending]) {
        if (pending.delete(id)) callback(time);
      }
      await Promise.resolve(); // Let frame-driven export continuations commit too.
    });
  };
  return {
    advance,
    now: () => time,
    async until(assertion: () => void, frameBudget = 160) {
      // UI recovery uses the default bound. Adaptive exports must supply the
      // workload-derived bound rather than depend on the host's batch speed.
      for (let frame = 0; frame < frameBudget; frame++) {
        await advance();
        try { assertion(); return; } catch { /* Retry after the next committed frame. */ }
      }
      assertion();
    },
  };
}
