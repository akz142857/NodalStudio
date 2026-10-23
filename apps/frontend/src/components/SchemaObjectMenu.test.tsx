import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SchemaObjectMenu } from "./SchemaObjectMenu";

afterEach(() => vi.restoreAllMocks());
it("keeps a zoomed context menu within the viewport near the bottom-right edge", () => {
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(240);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(128);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 480, height: 256 } as DOMRect);
  render(<SchemaObjectMenu x={window.innerWidth - 2} y={window.innerHeight - 2} name="public.orders" actions={[{ label: "Locate", run: vi.fn() }]} onClose={vi.fn()} />);
  const menu = screen.getByRole("menu");
  const left = Number.parseFloat(menu.style.left) * 2; const top = Number.parseFloat(menu.style.top) * 2;
  expect(left).toBeGreaterThanOrEqual(0); expect(top).toBeGreaterThanOrEqual(0);
  expect(left + 480).toBeLessThanOrEqual(window.innerWidth);
  expect(top + 256).toBeLessThanOrEqual(window.innerHeight);
  expect(screen.getByRole("menuitem")).toHaveFocus();
});

it("activates enabled menu actions with Enter and skips disabled commands", () => {
  const run = vi.fn(), onClose = vi.fn();
  render(<SchemaObjectMenu x={20} y={20} name="Databases" actions={[
    { label: "Unavailable", disabled: true, run: vi.fn() }, { label: "Manage", run },
  ]} onClose={onClose} />);
  expect(screen.getByRole("menuitem", { name: "Manage" })).toHaveFocus();
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Enter" });
  expect(run).toHaveBeenCalledOnce();
  expect(onClose).toHaveBeenCalledWith(true);
});
