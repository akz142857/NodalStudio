import { render, screen } from "@testing-library/react";
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
