import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { CanvasToolbar } from "./CanvasToolbar";

function Fixture({ disabled = false, onManage = vi.fn(), onViewAll = vi.fn(), onAutoLayout = vi.fn() }) {
  const [physical, setPhysical] = useState(true);
  const [inferred, setInferred] = useState(false);
  return <><CanvasToolbar tableCount={125} disabled={disabled} layoutDisabled={false} onManageRelationships={onManage} onViewAll={onViewAll} onAutoLayout={onAutoLayout} filters={[
    { id: "physical", label: "Physical relationships", count: 0, description: "Declared constraints", checked: physical, onChange: () => setPhysical(!physical) },
    { id: "inferred", label: "Inferred relationships", count: 119, description: "Suggestions, not constraints", checked: inferred, onChange: () => setInferred(!inferred) },
  ]} /><button>Outside</button></>;
}

describe("canvas toolbar", () => {
  it("keeps display toggles independent and preserves them across disclosure openings", () => {
    render(<Fixture />);
    const trigger = screen.getByRole("button", { name: "Relationships" });
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    fireEvent.click(trigger);
    const physical = screen.getByRole("checkbox", { name: "Physical relationships" });
    expect(physical).toHaveFocus();
    expect(physical).toBeChecked();
    fireEvent.click(screen.getByRole("checkbox", { name: "Inferred relationships" }));
    expect(physical).toBeChecked();
    fireEvent.keyDown(physical, { key: "Escape" });
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(trigger);
    expect(screen.getByRole("checkbox", { name: "Inferred relationships" })).toBeChecked();
    fireEvent.pointerDown(screen.getByRole("button", { name: "Outside" }));
    expect(screen.queryByRole("group", { name: "Relationship display" })).not.toBeInTheDocument();
  });
  it("runs view, layout and relationship management actions and closes the disclosure", () => {
    const onManage = vi.fn(), onViewAll = vi.fn(), onAutoLayout = vi.fn();
    render(<Fixture onManage={onManage} onViewAll={onViewAll} onAutoLayout={onAutoLayout} />);
    fireEvent.click(screen.getByRole("button", { name: "View all" }));
    fireEvent.click(screen.getByRole("button", { name: "Auto layout" }));
    fireEvent.click(screen.getByRole("button", { name: "Relationships" }));
    fireEvent.click(screen.getByRole("button", { name: "Manage relationships" }));
    expect(onManage).toHaveBeenCalledOnce();
    expect(onViewAll).toHaveBeenCalledOnce();
    expect(onAutoLayout).toHaveBeenCalledOnce();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });
  it("prevents display or layout changes during export", () => {
    const { rerender } = render(<Fixture />);
    fireEvent.click(screen.getByRole("button", { name: "Relationships" }));
    rerender(<Fixture disabled />);
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    for (const name of ["View all", "Auto layout", "Relationships"]) expect(screen.getByRole("button", { name })).toBeDisabled();
  });
});
