import { afterEach, expect, it, vi } from "vitest";
import { captureExportBatches } from "./export-batches";
import { animationFrames, diagramExportFrameBudget } from "../test/animation-frames";

afterEach(() => { vi.restoreAllMocks(); });

it("completes single-item export batches and label waits beyond the UI frame budget without losing identities", async () => {
  const frames = animationFrames(250);
  let workTime = 0, labelFrame = 0;
  vi.spyOn(performance, "now").mockImplementation(() => workTime);
  const edges = Array.from({ length: 1000 }, (_, i) => `edge-${i}`);
  const tables = Array.from({ length: 500 }, (_, i) => `table-${i}`);
  const capturedEdges: string[] = [], capturedTables: string[] = [];
  const edgeSizes: number[] = [], tableSizes: number[] = [];
  let batch: string[] = [];
  const capture = async () => {
    await captureExportBatches({ items: edges, maxBatchSize: 64, kind: "edge", assertCurrent: vi.fn(),
      render: (next) => { batch = next; edgeSizes.push(next.length); workTime += next.length * 10; labelFrame = frames.now(); },
      ready: () => frames.now() > labelFrame,
      read: () => { capturedEdges.push(...batch); workTime += batch.length; } });
    await captureExportBatches({ items: tables, maxBatchSize: 16, kind: "table", assertCurrent: vi.fn(),
      render: (next) => { batch = next; tableSizes.push(next.length); workTime += next.length * 10; },
      read: () => { capturedTables.push(...batch); workTime += batch.length; } });
  };
  const completed = vi.fn(), failed = vi.fn();
  const task = capture().then(completed, failed);
  const budget = diagramExportFrameBudget({ edgeCount: edges.length, tableCount: tables.length });
  await frames.until(() => { expect(failed).not.toHaveBeenCalled(); expect(completed).toHaveBeenCalledOnce(); }, budget);
  await task;
  expect(frames.now() / 250).toBeGreaterThan(160);
  expect(edgeSizes[0]).toBe(64); expect(tableSizes[0]).toBe(16);
  expect(edgeSizes.slice(1).every((size) => size === 1)).toBe(true);
  expect(tableSizes.slice(1).every((size) => size === 1)).toBe(true);
  expect(capturedEdges).toEqual(edges); expect(capturedTables).toEqual(tables);
  expect(new Set(capturedEdges).size).toBe(edges.length);
  expect(new Set(capturedTables).size).toBe(tables.length);
});

it("adapts expensive batches to the work budget, preserves every identity in order and yields", async () => {
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const frames = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => { now += 16; callback(now); return 1; });
  const items = Array.from({ length: 53 }, (_, i) => i);
  const captured: number[] = [], sizes: number[] = [];
  let batch: number[] = [];
  await captureExportBatches({ items, maxBatchSize: 16, kind: "table", assertCurrent: vi.fn(),
    render: (next) => { batch = next; sizes.push(next.length); now += next.length; },
    read: () => { now += batch.length; captured.push(...batch); } });
  expect(captured).toEqual(items);
  expect(sizes[0]).toBe(16);
  expect(sizes.slice(1).every((size) => size <= 4)).toBe(true);
  expect(frames.mock.calls.length).toBeGreaterThan(4);
});

it("captures several small relationship batches per frame and waits for label measurement", async () => {
  let now = 0, ready = true;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const frames = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => { ready = true; now += 16; callback(now); return 1; });
  const reads = vi.fn();
  await captureExportBatches({ items: Array.from({ length: 320 }, (_, i) => i), maxBatchSize: 64, kind: "edge", assertCurrent: vi.fn(),
    render: () => { now += 1; }, read: () => { reads(); now += 1; }, ready: () => ready });
  expect(reads).toHaveBeenCalledTimes(5);
  expect(frames).toHaveBeenCalledTimes(2);
  ready = false;
  await captureExportBatches({ items: [1], maxBatchSize: 64, kind: "edge", assertCurrent: vi.fn(), render: () => {},
    ready: () => ready, read: () => { expect(ready).toBe(true); } });
  expect(frames).toHaveBeenCalledTimes(3);
});

it("stops after scope invalidation or unmeasured labels without reading stale DOM", async () => {
  let now = 0, current = true;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => { now += 16; current = false; callback(now); return 1; });
  const read = vi.fn();
  await expect(captureExportBatches({ items: [1], maxBatchSize: 1, kind: "edge", render: () => {}, read,
    assertCurrent: () => { if (!current) throw new Error("Scope changed"); }, ready: () => false })).rejects.toThrow("Scope changed");
  expect(read).not.toHaveBeenCalled();
  await expect(captureExportBatches({ items: [1], maxBatchSize: 1, kind: "edge", render: () => {}, read,
    assertCurrent: () => {}, ready: () => false })).rejects.toThrow("Relationship labels are not ready");
  expect(read).not.toHaveBeenCalled();
  await expect(captureExportBatches({ items: [1], maxBatchSize: 0, kind: "edge", render: () => {}, read, assertCurrent: () => {} })).rejects.toThrow("Invalid export batch size");
});
