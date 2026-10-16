import { useEffect } from "react";
import { ReactFlowProvider, useStoreApi, type Node } from "@xyflow/react";
import { act, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DiagramMiniMap } from "./DiagramMiniMap";

const probe = vi.hoisted(() => ({ update: vi.fn(), destroy: vi.fn(), create: vi.fn() }));
vi.mock("@xyflow/system", async (load) => ({ ...await load<typeof import("@xyflow/system")>(), XYMinimap: (...args: unknown[]) => { probe.create(...args); return { update: probe.update, destroy: probe.destroy }; } }));
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

it("draws all 2,000 model nodes in two paths, skips hidden cards, and coalesces movement without subscribing per node", () => {
  let sequence = 0;
  const frames = new Map<number, FrameRequestCallback>();
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => { frames.set(++sequence, callback); return sequence; });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => { frames.delete(id); });
  const frame = () => act(() => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach((callback) => callback(0)); });
  const nodes: Node[] = Array.from({ length: 2000 }, (_, i) => ({ id: `n${i}`, data: {}, position: { x: i * 300, y: i % 2 * 600 }, measured: { width: 280, height: 500 }, selected: i === 0, hidden: i === 1 }));
  let store: ReturnType<typeof useStoreApi>;
  function Probe() { const value = useStoreApi(); useEffect(() => { store = value; }, [value]); return null; }
  const { container, unmount } = render(<ReactFlowProvider initialNodes={nodes}><Probe /><DiagramMiniMap dense /></ReactFlowProvider>);
  frame();
  const map = container.querySelector('[data-testid="rf__minimap"]')!;
  expect(map).toHaveAttribute("data-minimap-nodes", "1999");
  expect(map.querySelectorAll(".react-flow__minimap-node")).toHaveLength(2);
  expect(map.querySelectorAll("rect")).toHaveLength(0);
  expect(map.querySelector('.react-flow__minimap-node:not(.selected)')!.getAttribute("d")!.match(/M/g)).toHaveLength(1998);
  expect(map.querySelector('.react-flow__minimap-node.selected')).toHaveAttribute("d", "M0,0h280v500h-280z");
  act(() => { store!.getState().setEdges([{ id: "e", source: "n0", target: "n1" }]); });
  expect(frames.size).toBe(0);
  const unchangedPath = map.querySelector('.react-flow__minimap-node:not(.selected)')!;
  const mutations = vi.spyOn(unchangedPath, "setAttribute");
  act(() => {
    for (let x = 300; x <= 900; x += 300) store!.getState().setNodes(nodes.map((node) => node.id === "n0" ? { ...node, position: { x, y: 50 } } : node));
  });
  expect(frames.size).toBe(1); frame();
  expect(map.querySelector('.react-flow__minimap-node.selected')).toHaveAttribute("d", "M900,50h280v500h-280z");
  expect(store!.getState().nodes).toHaveLength(2000);
  expect(mutations).not.toHaveBeenCalled();
  act(() => { store!.setState({ transform: [-100, -200, .2], width: 1200, height: 700 }); }); frame();
  expect(map.querySelector('.react-flow__minimap-mask')!.getAttribute("d")).toContain("M500,1000h6000v3500h-6000z");
  act(() => { store!.setState({ panZoom: {} as NonNullable<ReturnType<typeof store.getState>["panZoom"]> }); });
  expect(probe.create).toHaveBeenCalledOnce();
  expect(probe.update).toHaveBeenCalledWith(expect.objectContaining({ width: 1200, height: 700, pannable: true, zoomable: true }));
  const options = probe.create.mock.calls[0][0] as { getTransform: () => number[]; getViewScale: () => number; domNode: Element };
  expect(options.domNode).toBe(map.querySelector("svg"));
  expect(options.getTransform()).toEqual([-100, -200, .2]); expect(options.getViewScale()).toBeGreaterThan(0);
  act(() => { store!.setState({ width: 1400 }); });
  expect(probe.update).toHaveBeenLastCalledWith(expect.objectContaining({ width: 1400 }));
  expect(frames.size).toBe(1); frame();
  act(() => store!.getState().setNodes(store!.getState().nodes.filter((node) => node.id !== "n5").map((node) => ({ ...node, selected: node.id === "n2", hidden: node.hidden || node.id === "n4" }))));
  frame();
  expect(map).toHaveAttribute("data-minimap-nodes", "1997");
  expect(map.querySelector('.react-flow__minimap-node.selected')).toHaveAttribute("d", "M600,0h280v500h-280z");
  expect(unchangedPath.getAttribute("d")).toContain("M900,50h280v500h-280z");
  expect(unchangedPath.getAttribute("d")).not.toContain("M1200,0h280v500h-280z");
  act(() => { store!.setState({ width: 1600 }); });
  expect(frames.size).toBe(1); unmount();
  expect(frames.size).toBe(0); expect(probe.destroy).toHaveBeenCalledOnce();
});

it("retains the ordinary React Flow minimap for small diagrams", () => {
  const nodes: Node[] = [{ id: "n", position: { x: 10, y: 20 }, data: {}, measured: { width: 280, height: 500 } }];
  const { container } = render(<ReactFlowProvider initialNodes={nodes}><DiagramMiniMap dense={false} /></ReactFlowProvider>);
  expect(container.querySelector(".react-flow__minimap-node")?.tagName.toLowerCase()).toBe("rect");
  expect(container.querySelector("[data-minimap-nodes]")).toBeNull();
});
