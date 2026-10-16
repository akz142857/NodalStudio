import { fireEvent, render } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { SyntheticEvent } from "react";
import { guardExportInput } from "./export-input-guard";

it("blocks canvas pointer, keyboard, wheel, touch and context actions while allowing Tab and export controls", () => {
  const action = vi.fn(), exportAction = vi.fn();
  function Surface({ busy }: { busy: boolean }) {
    return <div onClickCapture={(event) => { guardExportInput(event, busy); }} onKeyDownCapture={(event) => { guardExportInput(event, busy); }}
      onPointerDownCapture={(event) => { guardExportInput(event, busy); }} onMouseDownCapture={(event) => { guardExportInput(event, busy); }}
      onWheelCapture={(event) => { guardExportInput(event, busy); }} onTouchStartCapture={(event) => { guardExportInput(event, busy); }}
      onContextMenuCapture={(event) => { guardExportInput(event, busy); }}>
      <button data-testid="node" onClick={action} onKeyDown={action} onPointerDown={action} onMouseDown={action} onWheel={action} onTouchStart={action} onContextMenu={action}>Table</button>
      <div className="diagram-export-actions"><button data-testid="export" onClick={exportAction}>Export</button></div>
    </div>;
  }
  const { getByTestId, rerender } = render(<Surface busy />), node = getByTestId("node");
  fireEvent.click(node); fireEvent.pointerDown(node); fireEvent.mouseDown(node); fireEvent.wheel(node); fireEvent.touchStart(node); fireEvent.contextMenu(node); fireEvent.keyDown(node, { key: "Enter" });
  expect(action).not.toHaveBeenCalled();
  for (const type of ["wheel", "touchstart"]) {
    const event = { type, target: node, preventDefault: vi.fn(), stopPropagation: vi.fn() };
    expect(guardExportInput(event as unknown as SyntheticEvent, true)).toBe(true);
    expect(event.stopPropagation).toHaveBeenCalledOnce(); expect(event.preventDefault).not.toHaveBeenCalled();
  }
  fireEvent.keyDown(node, { key: "Tab" }); expect(action).toHaveBeenCalledOnce();
  fireEvent.click(getByTestId("export")); expect(exportAction).toHaveBeenCalledOnce();
  rerender(<Surface busy={false} />); fireEvent.click(node); fireEvent.keyDown(node, { key: "Enter" }); expect(action).toHaveBeenCalledTimes(3);
});
