import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandPalette } from "./CommandPalette";
import { useState } from "react";

afterEach(cleanup);

describe("CommandPalette", () => {
  it("filters and executes a unique command with Enter", () => {
    const run = vi.fn();
    const onClose = vi.fn();
    render(<CommandPalette commands={[{ id: "ai", label: "Open AI Settings", keywords: "provider model", run }, { id: "git", label: "Open Git Settings", keywords: "repository", run: vi.fn() }]} onClose={onClose} />);
    const search = screen.getByRole("combobox", { name: "Find a command" });
    fireEvent.change(search, { target: { value: "provider" } });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(run).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });
  it("navigates suggestions with the keyboard and restores focus on Escape", () => {
    function Workspace() {
      const [open, setOpen] = useState(false);
      return <><button type="button" onClick={() => setOpen(true)}>Show commands</button>
        {open && <CommandPalette commands={[
          { id: "first", label: "First command", keywords: "", run: vi.fn() },
          { id: "second", label: "Second command", keywords: "", run: vi.fn() },
        ]} onClose={() => setOpen(false)} />}</>;
    }
    render(<Workspace />);
    const trigger = screen.getByRole("button", { name: "Show commands" });
    trigger.focus();
    fireEvent.click(trigger);
    const input = screen.getByRole("combobox");
    expect(input).toHaveFocus();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input).toHaveAttribute("aria-activedescendant", screen.getByRole("option", { name: "Second command", selected: true }).id);
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});
