interface ExportBatches<T> {
  items: readonly T[];
  maxBatchSize: number;
  kind: "edge" | "table";
  render: (items: T[]) => void;
  read: () => void;
  assertCurrent: () => void;
  /** Label measurement may require a React effect and its follow-up commit. */
  ready?: () => boolean;
}

const FRAME_BUDGET_MS = 8;
const frame = () => new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));

/** FlushSync commits and DOM geometry/style reads are synchronous. Yield on
 * measured work, rather than paying a full animation frame for every tiny batch.
 * Adapt the next batch to costly cards; never widen the bounded DOM surface. */
export async function captureExportBatches<T>({ items, maxBatchSize, kind, render, read, assertCurrent, ready }: ExportBatches<T>) {
  if (!Number.isInteger(maxBatchSize) || maxBatchSize < 1) throw new Error("Invalid export batch size.");
  let count = maxBatchSize;
  let sliceStarted = performance.now();
  const yieldFrame = async () => { await frame(); assertCurrent(); sliceStarted = performance.now(); };
  for (let offset = 0; offset < items.length;) {
    assertCurrent();
    const batch = items.slice(offset, offset + count);
    const started = performance.now();
    render(batch);
    const committed = performance.now();
    performance.measure(`diagram-export:${kind === "edge" ? "edge" : "table"}-commit`, { start: started, end: committed });
    if (ready && !ready()) {
      await yieldFrame();
      if (!ready()) throw new Error("Relationship labels are not ready to export. Try again.");
    }
    const reading = performance.now();
    read();
    const ended = performance.now();
    performance.measure(`diagram-export:${kind === "edge" ? "edge-read" : "read"}`, { start: reading, end: ended });
    performance.measure(`diagram-export:${kind === "edge" ? "edge-batch" : "batch"}`, { start: started, end: ended,
      detail: { offset, count: batch.length } });
    offset += batch.length;
    const work = committed - started + ended - reading;
    if (work > 0) count = Math.max(1, Math.min(maxBatchSize, Math.floor(batch.length * FRAME_BUDGET_MS / work)));
    if (performance.now() - sliceStarted >= FRAME_BUDGET_MS) await yieldFrame();
  }
  // Separate the last read from the next phase's commit / final serialization.
  if (performance.now() > sliceStarted) await yieldFrame();
}
