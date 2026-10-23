import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DataSourceProfile } from "../platform";
import { DataSourcePicker } from "./DataSourcePicker";

const first: DataSourceProfile = {
  id: "postgres", displayName: "Local development", database: "midigi_db", databaseType: "postgreSql",
  host: "127.0.0.1", port: 5433, username: "user", sslMode: "prefer", createdAt: "", updatedAt: "",
};
const second: DataSourceProfile = { ...first, id: "mysql", database: "Flow", databaseType: "mySql", port: 3306 };

function setup() {
  const onSelect = vi.fn();
  const view = render(<><DataSourcePicker profiles={[first, second]} activeProfile={first} disabled={false} onSelect={onSelect} /><button>Edit connection</button></>);
  const trigger = screen.getByRole("button", { name: "Data source: midigi_db" });
  return { ...view, trigger, onSelect };
}

describe("DataSourcePicker", () => {
  it("uses the same detail picker before any model is selected without marking a source active", () => {
    const onSelect = vi.fn();
    render(<DataSourcePicker profiles={[first, second]} disabled={false} onSelect={onSelect} />);
    const trigger = screen.getByRole("button", { name: "Select database" });
    expect(trigger).toHaveTextContent("2 saved connections");
    fireEvent.click(trigger);
    const options = screen.getAllByRole("menuitemradio");
    expect(options.every((option) => option.getAttribute("aria-checked") === "false")).toBe(true);
    expect(options[0]).toHaveFocus();
    fireEvent.keyDown(options[0], { key: "ArrowDown" });
    fireEvent.keyDown(options[1], { key: "Enter" });
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(second);
  });

  it("distinguishes identically named connections and only switches on activation", () => {
    const { trigger, onSelect } = setup();
    expect(trigger).toHaveTextContent("midigi_dbPostgreSQL · Local development");
    fireEvent.click(trigger);
    const menu = screen.getByRole("menu", { name: "Switch database" });
    const options = within(menu).getAllByRole("menuitemradio");
    expect(options[0]).toHaveTextContent("midigi_dbPostgreSQL · Local development127.0.0.1:5433");
    expect(options[1]).toHaveTextContent("FlowMySQL · Local development127.0.0.1:3306");
    expect(options[0]).toHaveAttribute("aria-checked", "true");
    expect(options[0]).toHaveFocus();
    fireEvent.keyDown(options[0], { key: "ArrowDown" });
    expect(options[1]).toHaveFocus();
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.keyDown(options[1], { key: "Enter" });
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(second);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("supports arrow opening, Home/End and typeahead without changing the current model", () => {
    const { trigger, onSelect } = setup();
    fireEvent.keyDown(trigger, { key: "ArrowUp" });
    const options = screen.getAllByRole("menuitemradio");
    expect(options[1]).toHaveFocus();
    fireEvent.keyDown(options[1], { key: "Home" });
    expect(options[0]).toHaveFocus();
    fireEvent.keyDown(options[0], { key: "f" });
    expect(options[1]).toHaveFocus();
    fireEvent.keyDown(options[1], { key: "ArrowDown" });
    expect(options[0]).toHaveFocus();
    fireEvent.keyDown(options[0], { key: "End" });
    expect(options[1]).toHaveFocus();
    fireEvent.keyDown(options[1], { key: "Escape" });
    expect(onSelect).not.toHaveBeenCalled();
    expect(trigger).toHaveFocus();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("closes on current selection without reloading and accepts Space on another connection", () => {
    const { trigger, onSelect } = setup();
    fireEvent.click(trigger);
    fireEvent.click(screen.getAllByRole("menuitemradio")[0]);
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.click(trigger);
    const other = screen.getAllByRole("menuitemradio")[1];
    other.focus();
    fireEvent.keyDown(other, { key: " " });
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(second);
  });

  it("dismisses on outside interaction and Tab without trapping focus or selecting", () => {
    const { trigger, onSelect } = setup();
    fireEvent.click(trigger);
    fireEvent.pointerDown(screen.getByRole("button", { name: "Edit connection" }));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    fireEvent.click(trigger);
    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    fireEvent(screen.getAllByRole("menuitemradio")[0], tab);
    expect(tab.defaultPrevented).toBe(false);
    expect(trigger).toHaveFocus();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    fireEvent.click(trigger);
    fireEvent.focusIn(screen.getByRole("button", { name: "Edit connection" }));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("does not reopen a dismissed popup after a pending operation or external source change", () => {
    const { trigger, rerender, onSelect } = setup();
    fireEvent.click(trigger);
    const picker = (disabled: boolean, activeProfile = first) => <DataSourcePicker profiles={[first, second]} activeProfile={activeProfile} disabled={disabled} onSelect={onSelect} />;
    rerender(<>{picker(true)}<button>Edit connection</button></>);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveAttribute("aria-disabled", "true");
    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    rerender(<>{picker(false)}<button>Edit connection</button></>);
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(trigger);
    rerender(<>{picker(false, second)}<button>Edit connection</button></>);
    expect(screen.getByRole("button", { name: "Data source: Flow" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});
