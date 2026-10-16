import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DiagramToolbarMenu } from "./DiagramToolbarMenu";

describe("diagram toolbar disclosure", () => {
  it("keeps commands out of the canvas until opened and invokes an actual command", () => {
    const align = vi.fn();
    render(<DiagramToolbarMenu label="Align / distribute"><button onClick={align}>Align left</button></DiagramToolbarMenu>);
    expect(screen.queryByRole("button", { name: "Align left" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Align / distribute" }));
    fireEvent.click(screen.getByRole("button", { name: "Align left" })); expect(align).toHaveBeenCalledOnce();
  });
  it("closes with Escape and restores trigger focus, or closes when clicking outside / tabbing away", () => {
    render(<><DiagramToolbarMenu label="Align"><button>Align left</button></DiagramToolbarMenu><button>Outside</button></>);
    const trigger = screen.getByRole("button", { name: "Align" });
    fireEvent.click(trigger); screen.getByRole("button", { name: "Align left" }).focus(); fireEvent.keyDown(document, { key: "Escape" });
    expect(trigger).toHaveFocus(); expect(trigger).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(trigger); fireEvent.pointerDown(screen.getByRole("button", { name: "Outside" })); expect(trigger).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(trigger); fireEvent.blur(screen.getByRole("button", { name: "Align left" }), { relatedTarget: screen.getByRole("button", { name: "Outside" }) });
    expect(screen.queryByRole("button", { name: "Align left" })).not.toBeInTheDocument();
  });
  it("blocks disabled actions and closes menus when the diagram is resized", () => {
    const { rerender } = render(<DiagramToolbarMenu label="Domain" disabled title="Create a business domain first."><button>Add to domain</button></DiagramToolbarMenu>);
    expect(screen.getByRole("button", { name: "Domain" })).toBeDisabled(); fireEvent.click(screen.getByRole("button", { name: "Domain" })); expect(screen.queryByRole("button", { name: "Add to domain" })).not.toBeInTheDocument();
    rerender(<DiagramToolbarMenu label="Domain"><button>Add to domain</button></DiagramToolbarMenu>); fireEvent.click(screen.getByRole("button", { name: "Domain" }));
    fireEvent(window, new Event("resize")); expect(screen.getByRole("button", { name: "Domain" })).toHaveAttribute("aria-expanded", "false");
  });
});
