import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { expect, it, vi } from "vitest";
import { DEFAULT_ROW_PANEL_WIDTH, readRowPanelWidth, saveRowPanelWidth } from "../platform/table-data-preferences";
import { TableDataSplit } from "./TableDataSplit";

function Split({ open }: { open: boolean }) {
  const [width, setWidth] = useState(readRowPanelWidth);
  return <TableDataSplit inspectorId="fields" inspector={open ? <section id="fields" aria-label="Row editor" /> : undefined}
    preferredWidth={width} onWidthChange={(next) => { setWidth(next); saveRowPanelWidth(next); }}>Rows</TableDataSplit>;
}

it("resizes at the app scale and keeps the preferred width across window changes and app restarts", () => {
  let observeWidth: ResizeObserverCallback | undefined;
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: ResizeObserverCallback) { observeWidth = callback; }
    observe() {}
    disconnect() {}
  });

  try {
    saveRowPanelWidth(DEFAULT_ROW_PANEL_WIDTH);
    const { rerender, unmount } = render(<Split open />);
    const divider = () => screen.getByRole("separator", { name: "Resize row panel" });
    const resizeWindow = (width: number) => act(() => observeWidth?.([{ contentRect: { width } } as ResizeObserverEntry], {} as ResizeObserver));
    resizeWindow(1200);
    expect(divider()).toHaveAttribute("aria-valuenow", "336");

    const capture = vi.fn();
    Object.defineProperties(divider(), { offsetWidth: { value: 8 }, setPointerCapture: { value: capture } });
    vi.spyOn(divider(), "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 12, 200));
    fireEvent.pointerDown(divider(), { button: 0, pointerId: 1, isPrimary: true, clientX: 700 });
    fireEvent.pointerMove(divider(), { pointerId: 1, clientX: 610 });
    expect(capture).toHaveBeenCalledWith(1);
    expect(divider()).toHaveAttribute("aria-valuenow", "396");
    expect(readRowPanelWidth()).toBe(336);
    fireEvent.pointerCancel(divider(), { pointerId: 1 });
    fireEvent.pointerMove(divider(), { pointerId: 1, clientX: 600 });
    expect(divider()).not.toHaveAttribute("data-resizing");
    expect(divider()).toHaveAttribute("aria-valuenow", "396");
    expect(readRowPanelWidth()).toBe(396);

    fireEvent.keyDown(divider(), { key: "ArrowLeft" });
    expect(divider()).toHaveAttribute("aria-valuenow", "412");
    resizeWindow(590);
    expect(divider()).toHaveAttribute("aria-valuemax", "322");
    expect(divider()).toHaveAttribute("aria-valuenow", "322");
    expect(readRowPanelWidth()).toBe(412);
    rerender(<Split open={false} />);
    expect(screen.queryByRole("separator")).not.toBeInTheDocument();
    rerender(<Split open />);
    resizeWindow(1200);
    expect(divider()).toHaveAttribute("aria-valuenow", "412");

    unmount();
    render(<Split open />);
    resizeWindow(1200);
    expect(divider()).toHaveAttribute("aria-valuenow", "412");
    fireEvent.doubleClick(divider());
    expect(divider()).toHaveAttribute("aria-valuenow", "336");
    expect(readRowPanelWidth()).toBe(336);
  } finally {
    saveRowPanelWidth(DEFAULT_ROW_PANEL_WIDTH);
    vi.unstubAllGlobals();
  }
});
