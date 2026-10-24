import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FieldEdge } from "../../graph/schema-graph";
import { RelationshipInspector } from "./RelationshipInspector";

const edge: FieldEdge = { id: "orders-customer", source: "public.orders", target: "public.customers", data: { sourceColumn: "customer_id", targetColumn: "id", relationshipKind: "inferred", fieldLevel: true, confidence: .92 } };
const actions = { onEditLogical: vi.fn(), onToggleLogical: vi.fn(), onDeleteLogical: vi.fn(), onConfirmInference: vi.fn(), onDismissInference: vi.fn(), onIgnoreInferenceRule: vi.fn(), onClose: vi.fn() };
let resized: () => void;
let panelHeight = 360;
const capture = vi.fn();
const release = vi.fn();
function panel() { return screen.getByRole("complementary", { name: "Relationship details" }); }
function handle() { return screen.getByLabelText("Move relationship details"); }
function moveTo(x: number, y: number) {
  const bounds = panel().getBoundingClientRect();
  fireEvent.pointerDown(handle(), { button: 0, pointerId: 1, clientX: bounds.left + 20, clientY: bounds.top + 20 });
  fireEvent.pointerMove(handle(), { pointerId: 1, clientX: x + 20, clientY: y + 20 });
  fireEvent.pointerUp(handle(), { pointerId: 1 });
}
function position() { const { left, top } = panel().getBoundingClientRect(); return { left, top }; }

beforeEach(() => {
  panelHeight = 360;
  vi.stubGlobal("innerWidth", 1200); vi.stubGlobal("innerHeight", 800);
  vi.stubGlobal("PointerEvent", class extends MouseEvent {
    pointerId: number;
    constructor(type: string, options: PointerEventInit = {}) { super(type, options); this.pointerId = options.pointerId ?? 1; }
  });
  vi.stubGlobal("ResizeObserver", class { constructor(callback: () => void) { resized = callback; } observe() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const scale = Number.parseFloat(document.body.style.zoom) || 1;
    const left = Number.parseFloat(this.style.left) * scale || 0, top = Number.parseFloat(this.style.top) * scale || 0;
    const width = Math.min(360 * scale, window.innerWidth - 24), height = Math.min(panelHeight * scale, window.innerHeight - 24);
    return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON() {} };
  });
  Object.defineProperty(HTMLElement.prototype, "setPointerCapture", { configurable: true, value: capture });
  Object.defineProperty(HTMLElement.prototype, "hasPointerCapture", { configurable: true, value: () => true });
  Object.defineProperty(HTMLElement.prototype, "releasePointerCapture", { configurable: true, value: release });
});
afterEach(() => {
  document.body.style.removeProperty("zoom");
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.clearAllMocks();
  for (const name of ["setPointerCapture", "hasPointerCapture", "releasePointerCapture"]) Reflect.deleteProperty(HTMLElement.prototype, name);
});

describe("draggable relationship details", () => {
  it("follows the anchor until moved and preserves a manual position when the canvas pans", () => {
    const { rerender } = render(<RelationshipInspector edge={edge} anchor={{ x: 400, y: 400 }} {...actions} />);
    expect(position()).toEqual({ left: 414, top: 220 });
    rerender(<RelationshipInspector edge={edge} anchor={{ x: 500, y: 400 }} {...actions} />);
    expect(position()).toEqual({ left: 514, top: 220 });
    moveTo(600, 300);
    expect(position()).toEqual({ left: 600, top: 300 });
    expect(capture).toHaveBeenCalledWith(1); expect(release).toHaveBeenCalledWith(1);
    rerender(<RelationshipInspector edge={edge} anchor={{ x: 100, y: 100 }} {...actions} />);
    expect(position()).toEqual({ left: 600, top: 300 });
    rerender(<RelationshipInspector edge={{ ...edge, id: "different-relation" }} anchor={{ x: 100, y: 100 }} {...actions} />);
    expect(position()).toEqual({ left: 114, top: 12 });
  });
  it("clamps all window edges and rechecks bounds after window or content resizing", () => {
    render(<RelationshipInspector edge={edge} anchor={{ x: 400, y: 400 }} {...actions} />);
    moveTo(-100, -100); expect(position()).toEqual({ left: 12, top: 12 });
    moveTo(2000, 2000); expect(position()).toEqual({ left: 828, top: 428 });
    vi.stubGlobal("innerWidth", 700); vi.stubGlobal("innerHeight", 500);
    fireEvent(window, new Event("resize"));
    expect(position()).toEqual({ left: 328, top: 128 });
    panelHeight = 480; act(() => resized());
    expect(position()).toEqual({ left: 328, top: 12 });
    expect(panel()).toHaveStyle({ maxHeight: "476px" });
  });
  it("keeps pointer movement and bounds correct at 150% application scale", () => {
    document.body.style.zoom = "1.5";
    render(<RelationshipInspector edge={edge} anchor={{ x: 100, y: 100 }} {...actions} />);
    moveTo(300, 150); expect(position()).toEqual({ left: 300, top: 150 });
    expect(panel()).toHaveStyle({ left: "200px", top: "100px" });
    moveTo(2000, 2000); expect(position()).toEqual({ left: 648, top: 248 });
  });
  it("does not drag from contents, the close button, or a secondary pointer", () => {
    render(<RelationshipInspector edge={edge} anchor={{ x: 400, y: 400 }} {...actions} />);
    const initial = position();
    for (const target of [screen.getByRole("button", { name: "Close relationship details" }), screen.getByText(/^Naming suggestion/)]) {
      fireEvent.pointerDown(target, { button: 0, pointerId: 1 });
      fireEvent.pointerMove(handle(), { pointerId: 1, clientX: 900, clientY: 700 });
      expect(position()).toEqual(initial);
    }
    fireEvent.pointerDown(handle(), { button: 2, pointerId: 2 });
    fireEvent.pointerMove(handle(), { pointerId: 2, clientX: 900, clientY: 700 });
    expect(position()).toEqual(initial); expect(capture).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Close relationship details" }));
    expect(actions.onClose).toHaveBeenCalledOnce();
  });
  it("stops dragging when pointer capture is cancelled or lost and supports keyboard movement", () => {
    render(<RelationshipInspector edge={edge} anchor={{ x: 400, y: 400 }} {...actions} />);
    for (const cancel of [fireEvent.pointerCancel, fireEvent.lostPointerCapture]) {
      fireEvent.pointerDown(handle(), { button: 0, pointerId: 1, clientX: 430, clientY: 230 });
      cancel(handle(), { pointerId: 1 });
      fireEvent.pointerMove(handle(), { pointerId: 1, clientX: 900, clientY: 700 });
      expect(position()).toEqual({ left: 414, top: 220 });
      expect(handle()).not.toHaveAttribute("data-dragging");
    }
    fireEvent.keyDown(handle(), { key: "ArrowRight" });
    fireEvent.keyDown(handle(), { key: "ArrowDown", shiftKey: true });
    expect(position()).toEqual({ left: 424, top: 221 });
  });
});
