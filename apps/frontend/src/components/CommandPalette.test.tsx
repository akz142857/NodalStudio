import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandPalette } from "./CommandPalette";
import { formatCommandShortcut } from "./command-shortcuts";
import { useState } from "react";

afterEach(cleanup);

const settingsCommand = { group: "settings", icon: "settings" } as const;

describe("CommandPalette", () => {
  it("filters and executes a unique command with Enter", () => {
    const run = vi.fn();
    const onClose = vi.fn();
    render(<CommandPalette commands={[
      { ...settingsCommand, id: "ai", label: "Open AI Settings", keywords: "provider model" },
      { ...settingsCommand, id: "git", label: "Open Git Settings", keywords: "repository" },
    ]} onRun={run} onClose={onClose} />);
    const search = screen.getByRole("combobox", { name: "Find a command" });
    fireEvent.change(search, { target: { value: "MODEL   AI" } });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(run).toHaveBeenCalledExactlyOnceWith("ai");
    expect(onClose).toHaveBeenCalledOnce();
  });
  it("navigates suggestions with the keyboard and restores focus on Escape", () => {
    function Workspace() {
      const [open, setOpen] = useState(false);
      return <><button type="button" onClick={() => setOpen(true)}>Show commands</button>
        {open && <CommandPalette commands={[
          { ...settingsCommand, id: "first", label: "First command", keywords: "" },
          { id: "second", group: "structure", icon: "database", label: "Second command", keywords: "" },
        ]} onRun={vi.fn()} onClose={() => setOpen(false)} />}</>;
    }
    render(<Workspace />);
    const trigger = screen.getByRole("button", { name: "Show commands" });
    trigger.focus();
    fireEvent.click(trigger);
    const input = screen.getByRole("combobox");
    expect(input).toHaveFocus();
    expect(screen.getByRole("group", { name: "Structure" })).toBeVisible();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input).toHaveAttribute("aria-activedescendant", screen.getByRole("option", { name: "First command", selected: true }).id);
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("formats shortcuts for the active operating system", () => {
    expect(formatCommandShortcut("Mod+Shift+R", true)).toBe("⇧⌘R");
    expect(formatCommandShortcut("Mod+,", true)).toBe("⌘,");
    expect(formatCommandShortcut("Mod+Alt+Enter", false)).toBe("Ctrl+Alt+Enter");
  });
});
