import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useBatchedNodeInternals } from "./use-batched-node-internals";

const probe = vi.hoisted(() => ({ store: { getState: vi.fn() } }));
vi.mock("@xyflow/react", () => ({ useStoreApi: () => ({ ...probe.store }) }));

let frames: FrameRequestCallback[];
function frame() { act(() => { const pending = frames; frames = []; pending.forEach((callback) => callback(0)); }); }
function canvas(ids: string[]) {
  const domNode = document.createElement("div");
  domNode.innerHTML = ids.map((id) => `<div class="react-flow__node" data-id="${id}"><article class="table-node"></article></div>`).join("");
  return { domNode, nodes: ids.map((id) => ({ id, data: { table: id }, measured: { width: 280, height: 500 }, handles: [] })), triggerNodeChanges: vi.fn<(changes: Array<{ id: string; item: { data: object; measured: object; handles?: unknown } }>) => void>(), updateNodeInternals: vi.fn<(updates: Map<string, { nodeElement: HTMLDivElement; force: boolean }>, options: { triggerFitView: boolean }) => void>() };
}
beforeEach(() => { frames = []; vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => { frames.push(callback); return frames.length; })); });
afterEach(() => vi.unstubAllGlobals());

describe("batched node measurement", () => {
  it("coalesces 1,000 mounted cards into one React Flow measurement and retires provisional handles", () => {
    const state = canvas(Array.from({ length: 1000 }, (_, i) => `n${i}`));
    probe.store = { getState: vi.fn(() => state) };
    const first = renderHook(() => useBatchedNodeInternals());
    const second = renderHook(() => useBatchedNodeInternals());
    act(() => { for (const node of state.nodes) { first.result.current(node.id); second.result.current(node.id); } });
    expect(state.updateNodeInternals).not.toHaveBeenCalled();
    expect(frames).toHaveLength(1);
    frame();
    expect(state.updateNodeInternals).toHaveBeenCalledOnce();
    const updates = state.updateNodeInternals.mock.calls[0][0] as Map<string, { nodeElement: HTMLElement; force: boolean }>;
    expect([...updates.keys()]).toEqual(state.nodes.map((node) => node.id));
    expect(updates.get("n0")).toMatchObject({ nodeElement: state.domNode.firstChild, force: true });
    expect(state.updateNodeInternals.mock.calls[0][1]).toEqual({ triggerFitView: false });
    expect(state.triggerNodeChanges).toHaveBeenCalledOnce();
    const changes = state.triggerNodeChanges.mock.calls[0][0];
    expect(changes).toHaveLength(1000);
    expect(changes[0].item.handles).toBeUndefined();
    expect(changes[0].item.data).toBe(state.nodes[0].data);
    expect(changes[0].item.measured).toBe(state.nodes[0].measured);
  });
  it("isolates independent canvases and schedules later measurements again", () => {
    const a = canvas(["first", "later"]), b = canvas(["second"]);
    probe.store = { getState: vi.fn(() => a) };
    const first = renderHook(() => useBatchedNodeInternals());
    probe.store = { getState: vi.fn(() => b) };
    const second = renderHook(() => useBatchedNodeInternals());
    act(() => { first.result.current("first"); second.result.current("second"); }); frame();
    expect([...a.updateNodeInternals.mock.calls[0][0].keys()]).toEqual(["first"]);
    expect([...b.updateNodeInternals.mock.calls[0][0].keys()]).toEqual(["second"]);
    act(() => first.result.current("later")); frame();
    expect([...a.updateNodeInternals.mock.lastCall![0].keys()]).toEqual(["later"]);
  });
  it("skips cards culled before the frame and measures replacement DOM instead of a stale element", () => {
    const state = canvas(["replaced", "unmounted"]);
    probe.store = { getState: vi.fn(() => state) };
    const hook = renderHook(() => useBatchedNodeInternals());
    act(() => state.nodes.forEach((node) => hook.result.current(node.id)));
    const replacement = state.domNode.firstElementChild!.cloneNode(true);
    state.domNode.firstElementChild!.replaceWith(replacement);
    state.domNode.lastElementChild!.remove();
    frame();
    expect([...state.updateNodeInternals.mock.calls[0][0].keys()]).toEqual(["replaced"]);
    expect(state.updateNodeInternals.mock.calls[0][0].get("replaced")!.nodeElement).toBe(replacement);
    expect(state.triggerNodeChanges.mock.calls[0][0].map((change: { id: string }) => change.id)).toEqual(["replaced"]);
  });
});
