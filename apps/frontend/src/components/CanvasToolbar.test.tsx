import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { CanvasToolbar } from "./CanvasToolbar";
import { canvasToolButton, openCanvasTools } from "../test/canvas-tools";

function Fixture({ disabled = false, onManage = vi.fn(), onViewAll = vi.fn(), onAutoLayout = vi.fn() }) {
  const [physical, setPhysical] = useState(true);
  const [logical, setLogical] = useState(true);
  const [inferred, setInferred] = useState(false);
  const [selected, setSelected] = useState(3);
  return <><CanvasToolbar tableCount={125} disabled={disabled} selectedCount={selected} selectionActions={selected ? <button onClick={() => setSelected(0)}>Clear selection</button> : null} layoutDisabled={false} onManageRelationships={onManage} onViewAll={onViewAll} onAutoLayout={onAutoLayout} filters={[
    { id: "physical", label: "Physical relationships", count: 0, description: "Declared constraints", checked: physical, onChange: () => setPhysical(!physical) },
    { id: "logical", label: "Logical relationships", count: 3, description: "Relationships defined in your model", checked: logical, onChange: () => setLogical(!logical) },
    { id: "inferred", label: "Inferred relationships", count: 119, description: "Suggestions, not constraints", checked: inferred, onChange: () => setInferred(!inferred) },
  ]} /><button>Outside</button></>;
}

describe("canvas toolbar", () => {
  it.each([0.8, 1, 1.5])("clears the toolbar when its width changes at %s UI scale", (scale) => {
    let resize = () => {}; const observed: Element[] = [];
    vi.stubGlobal("ResizeObserver", class { constructor(callback: () => void) { resize = callback; } observe(element: Element) { observed.push(element); } disconnect() {} });
    let wide = false;
    const bounds = (x: number, y: number, width: number, height: number) => new DOMRect(x * scale, y * scale, width * scale, height * scale);
    const offset = vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("schema-canvas-surface") ? 900 : 0;
    });
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains("schema-canvas-surface")) return bounds(0, 0, 900, 700);
      if (this.classList.contains("canvas-command-dock") && this.querySelector(".canvas-command-bar")) return bounds(300, 640, wide ? 500 : 300, 44);
      return bounds(300, 640, 100, 44);
    });
    try {
      const { container, unmount } = render(<div className="schema-canvas-surface"><Fixture /></div>);
      const surface = container.querySelector<HTMLElement>(".schema-canvas-surface")!;
      expect(parseFloat(surface.style.getPropertyValue("--canvas-minimap-bottom"))).toBeCloseTo(16);
      expect(observed).toContain(container.querySelector(".canvas-command-dock"));
      wide = true; act(() => resize());
      expect(parseFloat(surface.style.getPropertyValue("--canvas-minimap-bottom"))).toBeCloseTo(72);
      wide = false; fireEvent.click(screen.getByRole("button", { name: "Collapse canvas toolbar" }));
      expect(parseFloat(surface.style.getPropertyValue("--canvas-minimap-bottom"))).toBeCloseTo(16);
      unmount();
    } finally { rect.mockRestore(); offset.mockRestore(); vi.unstubAllGlobals(); }
  });
  it("slides the minimap clear of an open panel when there is no room above it", () => {
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains("schema-canvas-surface")) return new DOMRect(0, 0, 900, 700);
      if (this.classList.contains("canvas-command-dock")) return new DOMRect(560, 640, 324, 44);
      if (this.classList.contains("canvas-command-popover")) return new DOMRect(560, 80, 324, 552);
      return new DOMRect();
    });
    try {
      const { container } = render(<div className="schema-canvas-surface"><Fixture /><div className="canvas-minimap" /></div>);
      const canvas = container.querySelector<HTMLElement>(".schema-canvas-surface")!;
      const trigger = screen.getByRole("button", { name: "Canvas tools" });
      expect(canvas).toHaveStyle({ "--canvas-minimap-right": "16px", "--canvas-minimap-bottom": "72px" });
      fireEvent.click(trigger);
      expect(trigger).toHaveFocus();
      expect(canvas).toHaveStyle({ "--canvas-minimap-right": "352px", "--canvas-minimap-bottom": "16px" });
      fireEvent.pointerDown(canvas.querySelector(".canvas-minimap")!);
      expect(trigger).toHaveAttribute("aria-expanded", "true");
      fireEvent.keyDown(document.activeElement!, { key: "Escape" });
      expect(trigger).toHaveAttribute("aria-expanded", "false");
      expect(canvas).toHaveStyle({ "--canvas-minimap-right": "16px", "--canvas-minimap-bottom": "72px" });
    } finally { rect.mockRestore(); vi.unstubAllGlobals(); }
  });
  it("drags and clamps the dock at the app scale, keeps its place when collapsed and resets by keyboard", () => {
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    try {
      render(<div className="schema-canvas-surface"><Fixture /></div>);
      const grip = screen.getByRole("group", { name: "Move canvas toolbar" });
      const dock = grip.closest<HTMLElement>(".canvas-command-dock")!;
      const area = dock.parentElement!;
      const capture = vi.fn();
      Object.defineProperty(grip, "setPointerCapture", { value: capture });
      Object.defineProperty(area, "offsetWidth", { value: 600 });
      vi.spyOn(area, "getBoundingClientRect").mockReturnValue(new DOMRect(100, 100, 1200, 800));
      vi.spyOn(dock, "getBoundingClientRect").mockReturnValue(new DOMRect(500, 788, 400, 80));
      expect(dock.style.getPropertyValue("--canvas-dock-y")).toBe("1");

      fireEvent.pointerDown(grip, { button: 0, pointerId: 1, isPrimary: true, clientX: 520, clientY: 820 });
      fireEvent.pointerMove(grip, { pointerId: 1, clientX: 1350, clientY: 100 });
      expect(capture).toHaveBeenCalledWith(1);
      expect(dock.style.getPropertyValue("--canvas-dock-x")).toBe("1");
      expect(dock.style.getPropertyValue("--canvas-dock-y")).toBe("0");
      fireEvent.pointerCancel(grip, { pointerId: 1 });
      fireEvent.pointerMove(grip, { pointerId: 1, clientX: 600, clientY: 400 });
      expect(dock.style.getPropertyValue("--canvas-dock-y")).toBe("0");
      expect(dock).not.toHaveAttribute("data-dragging");

      fireEvent.click(screen.getByRole("button", { name: "Collapse canvas toolbar" }));
      expect(dock.style.getPropertyValue("--canvas-dock-x")).toBe("1");
      expect(screen.getByRole("button", { name: "Expand canvas toolbar" })).toHaveTextContent("3");
      fireEvent.keyDown(screen.getByRole("group", { name: "Move canvas toolbar" }), { key: "Home" });
      expect(dock.style.getPropertyValue("--canvas-dock-x")).toBe("0.5");
      expect(dock.style.getPropertyValue("--canvas-dock-y")).toBe("1");
    } finally { vi.restoreAllMocks(); vi.unstubAllGlobals(); }
  });
  it("collapses the entire dock without changing selection, and restores access to every action", () => {
    render(<Fixture />);
    expect(screen.queryByRole("group", { name: "Canvas tool panel" })).not.toBeInTheDocument();
    expect(screen.getByText("3 tables selected")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Collapse canvas toolbar" }));
    expect(screen.queryByRole("toolbar", { name: "Canvas tools" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Expand canvas toolbar" })).toHaveTextContent("3");
    fireEvent.click(screen.getByRole("button", { name: "Expand canvas toolbar" }));
    expect(screen.getByText("3 tables selected")).toBeVisible();
    fireEvent.click(canvasToolButton("Clear selection"));
    expect(screen.queryByText("3 tables selected")).not.toBeInTheDocument();
  });
  it("shows all relationship filters on opening Tools and preserves them while using other commands", () => {
    render(<Fixture />);
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    const trigger = openCanvasTools();
    expect(screen.getByRole("heading", { name: "Relationships" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Relationships" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("checkbox")).toHaveLength(3);
    const physical = screen.getByRole("checkbox", { name: "Physical relationships" });
    const logical = screen.getByRole("checkbox", { name: "Logical relationships" });
    expect(physical).toBeChecked();
    expect(logical).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Inferred relationships" })).not.toBeChecked();
    fireEvent.click(screen.getByRole("checkbox", { name: "Inferred relationships" }));
    expect(physical).toBeChecked();
    expect(logical).toBeChecked();
    physical.focus(); screen.getByRole("button", { name: "View all" }).focus();
    expect(screen.getByRole("group", { name: "Relationships" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Manage relationships" })).toBeVisible();
    physical.focus(); fireEvent.keyDown(physical, { key: "Escape" });
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("group", { name: "Canvas tool panel" })).not.toBeInTheDocument();
    openCanvasTools();
    expect(screen.getByRole("checkbox", { name: "Inferred relationships" })).toBeChecked();
    fireEvent.pointerDown(screen.getByRole("button", { name: "Outside" }));
    expect(screen.queryByRole("group", { name: "Canvas tool panel" })).not.toBeInTheDocument();
  });
  it("runs view, layout and relationship management actions and closes the panel", () => {
    const onManage = vi.fn(), onViewAll = vi.fn(), onAutoLayout = vi.fn();
    render(<Fixture onManage={onManage} onViewAll={onViewAll} onAutoLayout={onAutoLayout} />);
    fireEvent.click(canvasToolButton("View all"));
    fireEvent.click(canvasToolButton("Auto layout"));
    fireEvent.click(canvasToolButton("Manage relationships"));
    expect(onManage).toHaveBeenCalledOnce(); expect(onViewAll).toHaveBeenCalledOnce(); expect(onAutoLayout).toHaveBeenCalledOnce();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Canvas tools" })).toHaveFocus();
  });
  it("prevents tools from opening during export", () => {
    const { rerender } = render(<Fixture />);
    openCanvasTools();
    rerender(<Fixture disabled />);
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Canvas tools" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Collapse canvas toolbar" })).toBeDisabled();
  });
  it("returns focus to the trigger on Escape without running layout or view actions", () => {
    const layout = vi.fn(), view = vi.fn(); render(<Fixture onAutoLayout={layout} onViewAll={view} />);
    const command = canvasToolButton("Auto layout"); command.focus(); fireEvent.keyDown(command, { key: "Escape" });
    expect(screen.getByRole("button", { name: "Canvas tools" })).toHaveFocus();
    expect(screen.queryByRole("group", { name: "Canvas tool panel" })).not.toBeInTheDocument();
    expect(layout).not.toHaveBeenCalled(); expect(view).not.toHaveBeenCalled();
  });
});
