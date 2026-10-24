import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IconButton } from "./IconButton";

describe("IconButton", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function hover(button: HTMLElement) {
    fireEvent.pointerEnter(button.parentElement!);
    act(() => { vi.advanceTimersByTime(400); });
  }

  it("shows a named icon and reveals its explanation only on hover or keyboard focus", () => {
    render(<IconButton icon="import" label="Import DDL" description="Read-only preview" />);
    const button = screen.getByRole("button", { name: "Import DDL" });
    expect(button.textContent).toBe("");
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    hover(button);
    expect(screen.getByRole("tooltip")).toHaveTextContent("Import DDL Read-only preview");
    expect(button).toHaveAccessibleDescription("Import DDL Read-only preview");
    fireEvent.pointerLeave(button.parentElement!);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    fireEvent.focus(button);
    expect(screen.getByRole("tooltip")).toBeVisible();
    fireEvent.keyDown(button, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    fireEvent.blur(button);
    fireEvent.focus(button);
    expect(screen.getByRole("tooltip")).toBeVisible();
    fireEvent.blur(button);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("explains unavailable actions without triggering them and preserves running state", () => {
    const onClick = vi.fn();
    const { rerender } = render(<IconButton icon="report" label="Export structure document" description="Wait for semantics" disabled onClick={onClick} />);
    const button = screen.getByRole("button", { name: "Export structure document" });
    hover(button);
    expect(screen.getByRole("tooltip")).toHaveTextContent("Wait for semantics");
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
    rerender(<IconButton icon="report" label="Export structure document" onClick={onClick} />);
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    fireEvent.pointerLeave(button.parentElement!);
    hover(button);
    rerender(<IconButton icon="report" label="Exporting report…" disabled aria-busy="true" />);
    expect(screen.getByRole("button", { name: "Exporting report…" })).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("tooltip")).toHaveTextContent("Exporting report…");
  });

  it("waits for a deliberate hover and cancels the hint when the pointer passes over", () => {
    render(<IconButton icon="settings" label="Settings" />);
    const button = screen.getByRole("button", { name: "Settings" });
    fireEvent.pointerEnter(button.parentElement!);
    act(() => { vi.advanceTimersByTime(200); });
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    fireEvent.pointerLeave(button.parentElement!);
    act(() => { vi.advanceTimersByTime(400); });
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    hover(button);
    expect(screen.getByRole("tooltip")).toHaveTextContent("Settings");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("dismisses the hint when an action opens and restores it on the next deliberate hover", () => {
    const onClick = vi.fn();
    render(<IconButton icon="bell" label="Notifications" onClick={onClick} />);
    const button = screen.getByRole("button", { name: "Notifications" });
    fireEvent.focus(button);
    expect(screen.getByRole("tooltip")).toBeVisible();
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    fireEvent.blur(button);
    fireEvent.pointerLeave(button.parentElement!);
    hover(button);
    expect(screen.getByRole("tooltip")).toBeVisible();
  });

  it("cancels a pending hover when the action unmounts", () => {
    const { unmount } = render(<IconButton icon="report" label="Export" />);
    fireEvent.pointerEnter(screen.getByRole("button", { name: "Export" }).parentElement!);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
