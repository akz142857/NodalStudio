import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useProgressiveEdges } from "./use-progressive-edges";

afterEach(() => vi.restoreAllMocks());
it("spreads large edge mounts across frames, retains progress while highlighting, exports all edges and cancels obsolete graphs", () => {
  let sequence = 0;
  const frames = new Map<number, FrameRequestCallback>();
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => { frames.set(++sequence, callback); return sequence; });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => { frames.delete(id); });
  const frame = () => act(() => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach((callback) => callback(0)); });
  const edges = Array.from({ length: 4000 }, (_, i) => ({ id: i }));
  const graph = {};
  const { result, rerender, unmount } = renderHook(({ graph, edges, ready, forceAll }) => useProgressiveEdges(edges, graph, true, ready, forceAll), { initialProps: { graph, edges, ready: false, forceAll: false } });
  expect(result.current.renderedEdges).toHaveLength(32); expect(frames.size).toBe(0);
  rerender({ graph, edges, ready: true, forceAll: false });
  frame(); expect(result.current.renderedEdges).toHaveLength(160);
  const highlighted = edges.map((edge) => ({ ...edge }));
  rerender({ graph, edges: highlighted, ready: true, forceAll: false });
  frame(); expect(result.current.renderedEdges).toHaveLength(288);
  rerender({ graph, edges, ready: true, forceAll: true });
  expect(result.current.renderedEdges).toBe(edges); expect(result.current.pending).toBe(false);
  const next = {};
  rerender({ graph: next, edges, ready: true, forceAll: false });
  expect(result.current.renderedEdges).toHaveLength(32);
  frame(); expect(result.current.renderedEdges).toHaveLength(160);
  for (let i = 0; i < 31; i += 1) frame();
  expect(result.current.renderedEdges).toBe(edges); expect(result.current.pending).toBe(false); expect(frames.size).toBe(0);
  rerender({ graph: {}, edges, ready: true, forceAll: false });
  expect(frames.size).toBe(1); unmount(); expect(frames.size).toBe(0);
});
it("renders small diagrams immediately", () => {
  const raf = vi.spyOn(window, "requestAnimationFrame");
  const edges = [1, 2, 3]; const graph = {};
  const { result } = renderHook(() => useProgressiveEdges(edges, graph, false, false, false));
  expect(result.current.renderedEdges).toBe(edges); expect(result.current.pending).toBe(false); expect(raf).not.toHaveBeenCalled();
});
it("leaves a recovery frame between batches, preserves every edge and cancels either pending frame on graph replacement", () => {
  let sequence = 0;
  const frames = new Map<number, FrameRequestCallback>();
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => { frames.set(++sequence, callback); return sequence; });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => { frames.delete(id); });
  const frame = () => act(() => { const pending = [...frames.values()]; frames.clear(); pending.forEach((callback) => callback(0)); });
  const edges = Array.from({ length: 4000 }, (_, id) => ({ id })), graph = {};
  const { result, rerender, unmount } = renderHook(({ scope }) => useProgressiveEdges(edges, scope, true, true, false, true), { initialProps: { scope: graph } });
  frame(); expect(result.current.renderedEdges).toHaveLength(160);
  frame(); expect(result.current.renderedEdges).toHaveLength(160); expect(result.current.pending).toBe(true);
  frame(); expect(result.current.renderedEdges).toHaveLength(288);
  frame(); rerender({ scope: {} });
  expect(result.current.renderedEdges).toHaveLength(32); expect(frames.size).toBe(1);
  for (let i = 0; i < 64; i++) frame();
  expect(result.current.renderedEdges).toBe(edges); expect(result.current.pending).toBe(false); expect(frames.size).toBe(0);
  rerender({ scope: {} }); frame(); frame();
  expect(frames.size).toBe(1); unmount(); expect(frames.size).toBe(0);
});

it.each(["settle", "advance"])("cancels the pending %s frame when another drag interrupts recovery, then restores the latest edges", (pendingPhase) => {
  let sequence = 0, time = 0;
  const frames = new Map<number, FrameRequestCallback>();
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => { frames.set(++sequence, callback); return sequence; });
  const cancel = vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => { frames.delete(id); });
  const frame = () => act(() => {
    time += 250;
    for (const [id, callback] of [...frames]) if (frames.delete(id)) callback(time);
  });
  const edges = Array.from({ length: 1000 }, (_, id) => ({ id }));
  const { result, rerender, unmount } = renderHook(({ scope, edges, dragging }) =>
    useProgressiveEdges(edges, scope, true, true, dragging, !dragging),
  { initialProps: { scope: {}, edges, dragging: false } });
  frame();
  expect(result.current.pending).toBe(true);
  expect(result.current.renderedEdges.length).toBeLessThan(edges.length);
  if (pendingPhase === "advance") frame();
  const obsoleteFrame = [...frames.keys()][0];

  const connected = [edges[50], edges[51]];
  rerender({ scope: {}, edges: connected, dragging: true });
  expect(cancel).toHaveBeenCalledWith(obsoleteFrame);
  expect(frames.has(obsoleteFrame)).toBe(false);
  frame();
  expect(result.current.renderedEdges).toBe(connected);
  expect(result.current.pending).toBe(false);

  const latest = edges.map((edge) => ({ id: edge.id + 1000 }));
  rerender({ scope: {}, edges: latest, dragging: false });
  const started = time;
  for (let i = 0; i < 20 && result.current.pending; i++) frame();
  expect(time - started).toBeGreaterThan(1000);
  expect(result.current.renderedEdges).toBe(latest);
  expect(new Set(result.current.renderedEdges.map((edge) => edge.id)).size).toBe(1000);
  expect(result.current.pending).toBe(false);
  expect(frames.size).toBe(0);
  unmount();
});
