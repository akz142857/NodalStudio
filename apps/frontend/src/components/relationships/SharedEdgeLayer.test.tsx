import { fireEvent, render, waitFor } from "@testing-library/react";
import { Position, type EdgeProps } from "@xyflow/react";
import { afterEach, expect, it, vi } from "vitest";
import { SharedEdge, SharedEdgeLayer, type EdgeActivationEvent } from "./SharedEdgeLayer";
import type { FieldEdge } from "../../graph/schema-graph";

const probe = vi.hoisted(() => ({ domNode: undefined as HTMLElement | undefined, transform: [0, 0, 1], width: 1200, height: 700 }));
vi.mock("@xyflow/react", async (load) => ({ ...await load<typeof import("@xyflow/react")>(),
  useStore: (select: (state: { domNode?: HTMLElement }) => unknown) => select(probe),
}));
afterEach(() => { probe.domNode?.remove(); probe.domNode = undefined; Reflect.deleteProperty(SVGElement.prototype, "getBBox"); vi.restoreAllMocks(); });

function setup() {
  probe.domNode = document.createElement("div");
  probe.domNode.innerHTML = '<div class="react-flow__edges"></div>';
  document.body.append(probe.domNode);
  Object.defineProperty(SVGElement.prototype, "getBBox", { configurable: true, value: () => ({ x: 0, y: 0, width: 100, height: 16 }) });
  return probe.domNode.querySelector(".react-flow__edges")!;
}
function edge(id: string, selected = false): EdgeProps<FieldEdge> {
  return { id, source: "source", target: "target", sourceX: 100, sourceY: 50, targetX: 500, targetY: 200,
    sourcePosition: Position.Right, targetPosition: Position.Left, type: "comparison", selected,
    selectable: true, deletable: false, animated: false, markerEnd: "url('#arrow')", interactionWidth: 20,
    label: id === "e0" ? "− Deleted · Before" : undefined, style: { stroke: "#c43e48", strokeDasharray: "8 5" },
    data: { relationshipKind: "physical", sourceColumn: "parent_id", targetColumn: "id", fieldLevel: true, changeStatus: "deleted", edgeStyle: "orthogonal", comparisonOffset: -12 } };
}

it("paints thousands of complete relationship paths in one SVG viewport, including markers, labels and comparison lanes", async () => {
  const root = setup(); const activate = vi.fn(); const clear = vi.fn();
  const { rerender, unmount } = render(<SharedEdgeLayer enabled activate={activate} clear={clear}>{Array.from({ length: 2000 }, (_, i) => {
    const props = edge(`e${i}`, i === 0);
    if (i === 1) props.data = { ...props.data!, relationshipKind: "inferred" };
    return <SharedEdge key={i} {...props} />;
  })}</SharedEdgeLayer>);
  await waitFor(() => expect(root.querySelectorAll(".react-flow__edge-path")).toHaveLength(2000));
  expect(root.querySelectorAll("svg")).toHaveLength(1);
  expect(root.querySelectorAll(".react-flow__edge-interaction")).toHaveLength(2000);
  const selected = root.querySelector('[data-id="e0"]')!;
  expect(selected.parentElement).toBe(root.querySelector("svg > g:last-child"));
  expect(root.querySelector('[data-id="e1"]')!.parentElement).toBe(root.querySelector("svg > g:first-child"));
  expect(root.querySelector('[data-id="e2"]')!.parentElement).toBe(root.querySelector("svg > g:nth-child(2)"));
  expect(selected).toHaveClass("comparison-edge-deleted", "selected");
  expect(selected.querySelector(".react-flow__edge-path")).toHaveAttribute("marker-end", "url('#arrow')");
  expect(selected.querySelector(".react-flow__edge-path")!.getAttribute("d")).toContain("L");
  expect(selected.textContent).toContain("− Deleted · Before");
  expect(selected.querySelector(".react-flow__edge-path")).toHaveStyle({ strokeDasharray: "8 5" });
  rerender(<SharedEdgeLayer enabled activate={activate} clear={clear}><SharedEdge {...{ ...edge("e0"), sourceX: 150 }} /></SharedEdgeLayer>);
  await waitFor(() => expect(root.querySelectorAll(".react-flow__edge-path")).toHaveLength(1));
  expect(root.querySelector(".react-flow__edge-path")!.getAttribute("d")).toMatch(/^M150,50/);
  unmount(); expect(root.children).toHaveLength(0);
});

it("supports pointer activation, logical edit activation, keyboard selection and escape without duplicate events", async () => {
  const root = setup(); const activate = vi.fn((event: EdgeActivationEvent) => { event.preventDefault(); event.stopPropagation(); }); const clear = vi.fn();
  render(<SharedEdgeLayer enabled activate={activate} clear={clear}><SharedEdge {...edge("e0")} /></SharedEdgeLayer>);
  const group = await waitFor(() => { const group = root.querySelector('[data-id="e0"]'); expect(group).not.toBeNull(); return group!; });
  expect(group).toHaveAttribute("tabindex", "0"); expect(group).toHaveAttribute("aria-label", "Edge from source to target");
  fireEvent.click(group, { clientX: 200, clientY: 100 });
  expect(activate).toHaveBeenLastCalledWith(expect.anything(), "e0", false);
  fireEvent.doubleClick(group);
  expect(activate).toHaveBeenLastCalledWith(expect.anything(), "e0", true);
  fireEvent.keyDown(group, { key: "Enter" }); fireEvent.keyDown(group, { key: " " });
  expect(activate).toHaveBeenCalledTimes(4);
  fireEvent.keyDown(group, { key: "Escape" }); expect(clear).toHaveBeenCalledOnce();
});

it("clips each paint viewport to the canvas while retaining path DOM and ownership across pan/zoom and recovery", async () => {
  const root = setup(); const activate = vi.fn(), clear = vi.fn();
  probe.transform = [-300, -200, .5]; probe.width = 800; probe.height = 600;
  const tree = () => <SharedEdgeLayer enabled activate={activate} clear={clear}><SharedEdge {...edge("e1")} /></SharedEdgeLayer>;
  const { rerender } = render(tree());
  const path = await waitFor(() => { const path = root.querySelector(".react-flow__edge-path"); expect(path).not.toBeNull(); return path!; });
  const viewport = path.closest("svg")!, geometry = path.getAttribute("d");
  expect(viewport).toHaveAttribute("viewBox", "600 400 1600 1200");
  expect(viewport).toHaveStyle({ left: "600px", top: "400px", width: "1600px", height: "1200px", overflow: "hidden" });
  probe.transform = [-600, -400, 2]; rerender(tree());
  expect(path.closest("svg")).toBe(viewport);
  expect(viewport).toHaveAttribute("viewBox", "300 200 400 300");
  expect(root.querySelector(".react-flow__edge-path")).toBe(path);
  expect(path.getAttribute("d")).toBe(geometry);
  probe.transform = [0, 0, 1]; probe.width = 1200; probe.height = 700;
});
