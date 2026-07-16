import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandPalette } from "./CommandPalette";

afterEach(cleanup);

describe("CommandPalette", () => {
  it("filters and executes a unique command with Enter", () => {
    const run = vi.fn();
    const onClose = vi.fn();
    render(<CommandPalette commands={[{ id: "ai", label: "Open AI Settings", keywords: "provider model", run }, { id: "git", label: "Open Git Settings", keywords: "repository", run: vi.fn() }]} onClose={onClose} />);
    const search = screen.getByRole("searchbox", { name: "Find a command" });
    fireEvent.change(search, { target: { value: "provider" } });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(run).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });
});
