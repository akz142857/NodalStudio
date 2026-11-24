import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { getPlatform } from "../../platform";
import { diagramAfter } from "../../test/diagram-comparison-fixture";
import { QuickQueryDock } from "./QuickQueryDock";

function floatPanel() {
  fireEvent.click(screen.getByRole("button", { name: "Position Quick Query" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Float Quick Query" }));
}

it("drags within the data area and can return to bottom center from the position menu", () => {
  render(<QuickQueryDock platform={getPlatform()} snapshot={diagramAfter} relation={diagramAfter.schemas[0].tables[0]} reset={0} onResult={vi.fn()} />);
  floatPanel();
  const panel = screen.getByRole("region", { name: "Quick Query" });
  const grip = panel.querySelector(".quick-query-grip")!;
  const bar = grip.parentElement!;
  const capture = vi.fn();
  Object.defineProperty(bar, "setPointerCapture", { value: capture });
  vi.spyOn(panel.parentElement!.querySelector(".quick-query-bounds")!, "getBoundingClientRect").mockReturnValue(new DOMRect(100, 100, 600, 400));
  vi.spyOn(panel, "getBoundingClientRect").mockReturnValue(new DOMRect(300, 450, 200, 50));

  fireEvent.pointerDown(grip, { button: 0, isPrimary: true, pointerId: 1, clientX: 340, clientY: 465 });
  fireEvent.pointerMove(bar, { pointerId: 1, clientX: 240, clientY: 290 });
  expect(capture).toHaveBeenCalledWith(1);
  expect(panel).toHaveStyle({ "--quick-query-x": "25%", "--quick-query-y": "50%" });
  fireEvent.pointerMove(bar, { pointerId: 1, clientX: 900, clientY: 50 });
  expect(panel).toHaveStyle({ "--quick-query-x": "100%", "--quick-query-y": "0%" });
  fireEvent.pointerCancel(bar, { pointerId: 1 });
  fireEvent.pointerMove(bar, { pointerId: 1, clientX: 200, clientY: 300 });
  expect(panel).toHaveStyle({ "--quick-query-x": "100%", "--quick-query-y": "0%" });

  const position = screen.getByRole("button", { name: "Position Quick Query" });
  fireEvent.click(position);
  expect(screen.getByRole("menuitemradio", { name: "Top right", checked: true })).toBeVisible();
  const dock = screen.getByRole("menuitem", { name: "Dock at Top" });
  expect(dock).toHaveFocus();
  fireEvent.keyDown(dock, { key: "ArrowDown" });
  const bottom = screen.getByRole("menuitemradio", { name: "Bottom center" });
  expect(bottom).toHaveFocus();
  fireEvent.keyDown(bottom, { key: "Enter" });
  expect(panel).toHaveStyle({ "--quick-query-x": "50%", "--quick-query-y": "100%" });
  expect(position).toHaveFocus();
});

it("resizes the floating panel at the app scale and retains its size when collapsed", () => {
  render(<QuickQueryDock platform={getPlatform()} snapshot={diagramAfter} relation={diagramAfter.schemas[0].tables[0]} reset={0} onResult={vi.fn()} />);
  floatPanel();
  const panel = screen.getByRole("region", { name: "Quick Query" });
  const toggle = screen.getByRole("button", { name: "Quick Query" });
  const area = panel.parentElement!.querySelector(".quick-query-bounds")!;
  Object.defineProperty(area, "offsetWidth", { value: 400 });
  vi.spyOn(area, "getBoundingClientRect").mockReturnValue(new DOMRect(100, 100, 800, 600));
  vi.spyOn(panel, "getBoundingClientRect").mockReturnValue(new DOMRect(180, 480, 640, 220));

  const editor = screen.getByRole("textbox", { name: "SQL editor" });
  expect(editor.parentElement).toContainElement(screen.getByRole("button", { name: "Run" }));
  expect(editor).toHaveAccessibleDescription("Read only");
  const grip = panel.querySelector('[data-corner="top-right"]')!;
  const capture = vi.fn();
  Object.defineProperty(grip, "setPointerCapture", { value: capture });
  fireEvent.pointerDown(grip, { button: 0, pointerId: 2, clientX: 818, clientY: 482 });
  fireEvent.pointerMove(grip, { pointerId: 2, clientX: 898, clientY: 402 });
  expect(capture).toHaveBeenCalledWith(2);
  expect(panel).toHaveStyle({ "--quick-query-width": "360px", "--quick-query-height": "150px", "--quick-query-y": "100%" });
  fireEvent.pointerMove(grip, { pointerId: 2, clientX: 1200, clientY: 0 });
  expect(panel).toHaveStyle({ "--quick-query-width": "360px", "--quick-query-height": "300px" });
  fireEvent.pointerUp(grip, { pointerId: 2 });

  fireEvent.click(toggle);
  expect(panel.querySelector('.quick-query-resize')).toBeNull();
  fireEvent.click(toggle);
  expect(screen.getByRole("textbox", { name: "SQL editor" })).toHaveFocus();
  expect(panel).toHaveStyle({ "--quick-query-width": "360px", "--quick-query-height": "300px" });
  fireEvent.click(screen.getByRole("button", { name: "Position Quick Query" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Reset Size" }));
  expect(panel.style.getPropertyValue("--quick-query-width")).toBe("");
  expect(panel.style.getPropertyValue("--quick-query-height")).toBe("");
});

it("starts docked and preserves the editor when floating, docking by drag, and detaching", () => {
  render(<QuickQueryDock platform={getPlatform()} snapshot={diagramAfter} relation={diagramAfter.schemas[0].tables[0]} reset={0} onResult={vi.fn()} />);
  const panel = screen.getByRole("region", { name: "Quick Query" });
  const layer = panel.parentElement!;
  expect(layer).toHaveAttribute("data-docked");
  expect(screen.getByRole("button", { name: "Quick Query" })).toHaveAttribute("aria-expanded", "true");
  const editor = screen.getByRole("textbox", { name: "SQL editor" });
  expect(editor).not.toHaveFocus();
  floatPanel();
  const grip = panel.querySelector(".quick-query-grip")!;
  const bar = grip.parentElement!;
  Object.defineProperty(bar, "setPointerCapture", { value: vi.fn() });
  vi.spyOn(layer.querySelector(".quick-query-bounds")!, "getBoundingClientRect").mockReturnValue(new DOMRect(100, 100, 600, 400));
  vi.spyOn(panel, "getBoundingClientRect").mockImplementation(() => layer.hasAttribute("data-docked")
    ? new DOMRect(88, 88, 624, 130) : new DOMRect(250, 350, 300, 150));

  fireEvent.change(editor, { target: { value: "SELECT 42;" } });

  fireEvent.pointerDown(grip, { button: 0, isPrimary: true, pointerId: 1, clientX: 400, clientY: 365 });
  fireEvent.pointerMove(bar, { pointerId: 1, clientX: 400, clientY: 120 });
  expect(screen.getByText("Dock at Top")).toBeVisible();
  expect(layer).not.toHaveAttribute("data-docked");
  fireEvent.pointerMove(bar, { pointerId: 1, clientX: 400, clientY: 160 });
  expect(screen.queryByText("Dock at Top")).toBeNull();
  fireEvent.pointerMove(bar, { pointerId: 1, clientX: 400, clientY: 120 });
  fireEvent.pointerCancel(bar, { pointerId: 1 });
  expect(layer).not.toHaveAttribute("data-docked");
  expect(screen.queryByText("Dock at Top")).toBeNull();

  fireEvent.pointerDown(grip, { button: 0, isPrimary: true, pointerId: 2, clientX: 400, clientY: 365 });
  fireEvent.pointerMove(bar, { pointerId: 2, clientX: 400, clientY: 120 });
  fireEvent.pointerUp(bar, { pointerId: 2, clientX: 400, clientY: 120 });
  expect(layer).toHaveAttribute("data-docked");
  expect(panel.querySelector(".quick-query-resize")).toBeNull();

  fireEvent.pointerDown(grip, { button: 0, isPrimary: true, pointerId: 3, clientX: 400, clientY: 104 });
  fireEvent.pointerMove(bar, { pointerId: 3, clientX: 400, clientY: 115 });
  expect(layer).toHaveAttribute("data-docked");
  fireEvent.pointerMove(bar, { pointerId: 3, clientX: 430, clientY: 210 });
  expect(layer).not.toHaveAttribute("data-docked");
  expect(panel).toHaveStyle({ "--quick-query-x": "60%", "--quick-query-y": "37.6%" });
  fireEvent.pointerUp(bar, { pointerId: 3, clientX: 430, clientY: 210 });
  expect(panel.querySelectorAll(".quick-query-resize")).toHaveLength(4);
  expect(screen.getByRole("textbox", { name: "SQL editor" })).toBe(editor);
  expect(editor).toHaveValue("SELECT 42;");
});
