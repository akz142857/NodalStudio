import { useEffect } from "react";
import { ReactFlowProvider, useStoreApi } from "@xyflow/react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { DiagramMiniMap } from "./DiagramMiniMap";

it("pans and zooms the main viewport through the real XYMinimap controller using current geometry", async () => {
  let store: ReturnType<typeof useStoreApi>;
  function Probe() { const value = useStoreApi(); useEffect(() => { store = value; }, [value]); return null; }
  const { container, unmount } = render(<ReactFlowProvider initialNodes={[{ id: "n", position: { x: 1000, y: 500 }, data: {}, measured: { width: 280, height: 500 } }]}><Probe /><DiagramMiniMap dense /></ReactFlowProvider>);
  const pan = vi.fn(), zoom = vi.fn();
  act(() => store!.setState({ width: 1200, height: 700, transform: [50, 80, .5], panZoom: { setViewportConstrained: pan, scaleTo: zoom } as unknown as NonNullable<ReturnType<typeof store.getState>["panZoom"]> }));
  await waitFor(() => expect(container.querySelector('[data-minimap-nodes="1"]')).not.toBeNull());
  const svg = screen.getByRole("img", { name: "Mini Map" });
  Object.defineProperty(svg, "viewBox", { value: { baseVal: { x: 0, y: 0, width: 210, height: 160 } } });
  const scale = Number(svg.getAttribute("viewBox")!.split(" ")[2]) / 210;
  // JSDOM 28 rejects Vitest's window proxy in UIEventInit; D3 needs the
  // event view for its actual window mouse listeners.
  const mouse = (target: Element | Window, type: string, init: MouseEventInit) => {
    const event = new MouseEvent(type, { bubbles: true, ...init });
    Object.defineProperty(event, "view", { value: window }); fireEvent(target, event);
  };
  mouse(svg, "mousedown", { button: 0, buttons: 1, clientX: 20, clientY: 30 });
  mouse(window, "mousemove", { buttons: 1, clientX: 30, clientY: 35 });
  mouse(window, "mouseup", { button: 0, clientX: 30, clientY: 35 });
  expect(pan).toHaveBeenCalledWith({ x: 50 - 10 * scale * .5, y: 80 - 5 * scale * .5, zoom: .5 }, [[0, 0], [1200, 700]], [[-Infinity, -Infinity], [Infinity, Infinity]]);
  fireEvent.wheel(svg, { deltaY: 100, clientX: 20, clientY: 30 });
  expect(zoom).toHaveBeenCalledWith(.5 * Math.pow(2, -.2));
  unmount();
});
