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
  return <><CanvasToolbar tableCount={125} disabled={disabled} selectedCount={selected} selectionActions={selected ? <button onClick={() => setSelected(0)}>Clear selection</button> : null} createViewAction={selected ? <button>Save as view…</button> : null} layoutDisabled={false} onManageRelationships={onManage} onViewAll={onViewAll} onAutoLayout={onAutoLayout} filters={[
    { id: "physical", label: "Physical relationships", count: 0, description: "Declared constraints", checked: physical, onChange: () => setPhysical(!physical) },
    { id: "logical", label: "Logical relationships", count: 3, description: "Relationships defined in your model", checked: logical, onChange: () => setLogical(!logical) },
    { id: "inferred", label: "Inferred relationships", count: 119, description: "Suggestions, not constraints", checked: inferred, onChange: () => setInferred(!inferred) },
  ]} /><button>Outside</button></>;
}

describe("canvas toolbar", () => {
  it("raises the minimap only when the bar overlaps its corner and follows width-only selection changes", () => {
    let resize = () => {}; const observed: Element[] = [];
    vi.stubGlobal("ResizeObserver", class { constructor(callback: () => void) { resize = callback; } observe(element: Element) { observed.push(element); } disconnect() {} });
    let wide = false;
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains("schema-canvas-surface")) return { left: 0, right: 900, top: 0, bottom: 700, width: 900, height: 700 } as DOMRect;
      return { left: 300, right: wide ? 800 : 600, top: 640, bottom: 684, width: wide ? 500 : 300, height: 44 } as DOMRect;
    });
    const width = vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) { return this.classList.contains("react-flow__minimap") ? 200 : 900; });
    try {
      const { container, unmount } = render(<div className="schema-canvas-workspace"><Fixture /><div className="schema-canvas-surface"><div className="react-flow__minimap" /></div><footer className="workspace-layout-status" /></div>);
      const map = container.querySelector<HTMLElement>(".react-flow__minimap")!;
      expect(map.style.bottom).toBe("16px");
      expect(observed).toContain(container.querySelector(".canvas-command-bar"));
      wide = true; act(() => resize());
      expect(map.style.bottom).toBe("72px");
      wide = false; fireEvent.click(screen.getByRole("button", { name: "Collapse canvas toolbar" }));
      expect(map.style.bottom).toBe("16px");
      unmount();
    } finally { rect.mockRestore(); width.mockRestore(); vi.unstubAllGlobals(); }
  });
  it("collapses the entire dock without changing selection, and restores access to every action", () => {
    render(<Fixture />);
    expect(screen.queryByRole("group", { name: "Canvas tool panel" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save as view…" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Collapse canvas toolbar" }));
    expect(screen.queryByRole("toolbar", { name: "Canvas tools" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Expand canvas toolbar" })).toHaveTextContent("3");
    fireEvent.click(screen.getByRole("button", { name: "Expand canvas toolbar" }));
    expect(screen.getByText("3 tables selected")).toBeVisible();
    fireEvent.click(canvasToolButton("Clear selection"));
    expect(screen.queryByRole("button", { name: "Save as view…" })).not.toBeInTheDocument();
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
    expect(screen.getByRole("button", { name: "Manage logical relationships" })).toBeVisible();
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
    fireEvent.click(canvasToolButton("Manage logical relationships"));
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
