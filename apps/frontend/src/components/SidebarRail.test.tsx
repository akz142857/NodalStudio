import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HeaderSidebarToggle, SidebarRail } from "./SidebarRail";

afterEach(cleanup);

describe("SidebarRail", () => {
  it("exposes the left sidebar control in the header", () => {
    const onToggle = vi.fn();
    render(
      <HeaderSidebarToggle
        side="left"
        expanded
        onToggle={onToggle}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Collapse left sidebar" }));
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it("exposes the right inspector control in the header", () => {
    render(
      <HeaderSidebarToggle side="right" expanded={false} onToggle={vi.fn()} />,
    );

    expect(
      screen.getByRole("button", { name: "Expand right inspector" }),
    ).toHaveAttribute("aria-expanded", "false");
  });

  it("resizes the left sidebar by pointer and keyboard", () => {
    const onResize = vi.fn();
    render(
      <SidebarRail
        side="left"
        expanded
        width={272}
        minWidth={220}
        maxWidth={480}
        onResize={onResize}
        onToggle={vi.fn()}
      />,
    );

    const separator = screen.getByRole("separator", { name: "Resize left sidebar" });
    fireEvent.pointerDown(separator, { button: 0, clientX: 272 });
    fireEvent.pointerMove(window, { clientX: 340 });
    expect(onResize).toHaveBeenCalledWith(340);

    fireEvent.keyDown(separator, { key: "ArrowLeft" });
    expect(onResize).toHaveBeenLastCalledWith(256);
  });

  it("inverts drag direction for the right inspector and clamps its width", () => {
    const onResize = vi.fn();
    render(
      <SidebarRail
        side="right"
        expanded
        width={300}
        minWidth={240}
        maxWidth={520}
        onResize={onResize}
        onToggle={vi.fn()}
      />,
    );

    const separator = screen.getByRole("separator", { name: "Resize right inspector" });
    fireEvent.pointerDown(separator, { button: 0, clientX: 700 });
    fireEvent.pointerMove(window, { clientX: 100 });
    expect(onResize).toHaveBeenCalledWith(520);
  });

  it("collapses an expanded sidebar when dragged close to the edge", () => {
    const onToggle = vi.fn();
    render(
      <SidebarRail
        side="left"
        expanded
        width={272}
        minWidth={220}
        maxWidth={480}
        onResize={vi.fn()}
        onToggle={onToggle}
      />,
    );

    const separator = screen.getByRole("separator", { name: "Resize left sidebar" });
    fireEvent.pointerDown(separator, { button: 0, clientX: 272 });
    fireEvent.pointerMove(window, { clientX: 60 });

    expect(onToggle).toHaveBeenCalledOnce();
  });

  it("reveals a collapsed sidebar by dragging outward from its edge", () => {
    const onResize = vi.fn();
    const onToggle = vi.fn();
    render(
      <SidebarRail
        side="right"
        expanded={false}
        width={300}
        minWidth={240}
        maxWidth={520}
        onResize={onResize}
        onToggle={onToggle}
      />,
    );

    const separator = screen.getByRole("separator", { name: "Resize right inspector" });
    fireEvent.pointerDown(separator, { button: 0, clientX: 900 });
    fireEvent.pointerMove(window, { clientX: 850 });

    expect(onResize).toHaveBeenCalledWith(240);
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it("opens a collapsed sidebar with the outward arrow key", () => {
    const onResize = vi.fn();
    const onToggle = vi.fn();
    render(
      <SidebarRail
        side="left"
        expanded={false}
        width={272}
        minWidth={220}
        maxWidth={480}
        onResize={onResize}
        onToggle={onToggle}
      />,
    );

    fireEvent.keyDown(
      screen.getByRole("separator", { name: "Resize left sidebar" }),
      { key: "ArrowRight" },
    );

    expect(onResize).toHaveBeenCalledWith(220);
    expect(onToggle).toHaveBeenCalledOnce();
  });
});
