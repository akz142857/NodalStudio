import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { reportSnapshot } from "../test/schema-report-fixture";
import { SavedViewsToolbar, type SavedViewsToolbarProps } from "./SavedViewsToolbar";

const keys = reportSnapshot.schemas.flatMap((schema) => schema.tables.map((table) => table.key));
const view = { id: "view-a", sourceId: reportSnapshot.sourceId, name: "Fulfillment", rootTableKeys: keys.slice(0, 2), relationshipDepth: 0, updatedAt: "now" };
function setup(overrides: Partial<SavedViewsToolbarProps> = {}) {
  const props: SavedViewsToolbarProps = { snapshot: reportSnapshot, views: [], selectedKeys: keys.slice(0, 2), positions: Object.fromEntries(keys.map((key, i) => [`${key.schema}.${key.name}`, { x: i * 300, y: i * 50 }])), viewport: { x: 10, y: 20, zoom: .7 }, onApply: vi.fn(), onSave: vi.fn<SavedViewsToolbarProps["onSave"]>((input) => Promise.resolve({ ...input, id: input.id!, updatedAt: "now" })), onDelete: vi.fn().mockResolvedValue(undefined), ...overrides };
  render(<SavedViewsToolbar {...props} />); return props;
}
describe("Saved model views", () => {
  beforeAll(() => {
    HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
    HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  });
  afterAll(() => { Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal"); Reflect.deleteProperty(HTMLDialogElement.prototype, "close"); });

  it("creates an explicit multi-table view with just its selected positions", async () => {
    const props = setup();
    fireEvent.click(screen.getByRole("button", { name: "Save selection as view" }));
    fireEvent.change(screen.getByRole("textbox", { name: "View name" }), { target: { value: "Orders" } });
    fireEvent.click(screen.getByRole("button", { name: "Save view" }));
    await waitFor(() => expect(props.onApply).toHaveBeenCalled());
    expect(props.onSave).toHaveBeenCalledWith(expect.objectContaining({ name: "Orders", snapshotId: reportSnapshot.id, sourceId: reportSnapshot.sourceId, relationshipDepth: 0, rootTableKeys: keys.slice(0, 2) }));
    expect(Object.keys(vi.mocked(props.onSave).mock.calls[0][0].positions!)).toHaveLength(2);
  });
  it("keeps the same draft identity and input after a failed save", async () => {
    const props = setup({ onSave: vi.fn().mockRejectedValueOnce(new Error("disk full")).mockResolvedValue(view) });
    fireEvent.click(screen.getByRole("button", { name: "Save selection as view" }));
    fireEvent.change(screen.getByRole("textbox", { name: "View name" }), { target: { value: "Orders" } });
    fireEvent.click(screen.getByRole("button", { name: "Save view" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("disk full");
    expect(screen.getByRole("textbox", { name: "View name" })).toHaveValue("Orders");
    fireEvent.click(screen.getByRole("button", { name: "Save view" }));
    await waitFor(() => expect(props.onSave).toHaveBeenCalledTimes(2));
    expect(vi.mocked(props.onSave).mock.calls[0][0]).toEqual(vi.mocked(props.onSave).mock.calls[1][0]);
  });
  it("preserves legacy depth and missing members while editing roots", async () => {
    const missing = { kind: "table" as const, schema: "public", name: "removed" };
    const legacy = { ...view, relationshipDepth: 2, rootTableKeys: [...view.rootTableKeys, missing] };
    const props = setup({ views: [legacy], activeView: legacy });
    fireEvent.click(screen.getByRole("button", { name: "View actions" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit view" }));
    expect(screen.getByText(/Legacy relationship view/)).toBeVisible();
    expect(screen.getByRole("checkbox", { name: /removed/ })).toBeChecked();
    fireEvent.change(screen.getByRole("textbox", { name: "View name" }), { target: { value: "Renamed" } });
    fireEvent.click(screen.getByRole("button", { name: "Save view" }));
    await waitFor(() => expect(props.onSave).toHaveBeenCalled());
    expect(props.onSave).toHaveBeenCalledWith(expect.objectContaining({ id: view.id, relationshipDepth: 2, rootTableKeys: legacy.rootTableKeys, positions: undefined }));
  });
  it("duplicates layout into a new view identity and requires explicit deletion", async () => {
    const positions = { a: { x: 4, y: 8, pinned: true } };
    const props = setup({ views: [view], activeView: view, layouts: [{ sourceId: view.sourceId, viewId: view.id, positions, viewport: { x: 1, y: 2, zoom: .5 }, updatedAt: "now" }] });
    fireEvent.click(screen.getByRole("button", { name: "View actions" }));
    fireEvent.click(screen.getByRole("button", { name: "Duplicate view" }));
    fireEvent.click(screen.getByRole("button", { name: "Save view" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const input = vi.mocked(props.onSave).mock.calls[0][0];
    expect(input.id).not.toBe(view.id); expect(input.positions).toEqual(positions); expect(input.viewport?.zoom).toBe(.5);
    fireEvent.click(screen.getByRole("button", { name: "View actions" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete view" }));
    expect(props.onDelete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete view" }));
    await waitFor(() => expect(props.onDelete).toHaveBeenCalledWith(view.id));
  });
  it("hides creation without a selection and keeps low-frequency commands in the view menu", () => {
    setup({ views: [view], activeView: view, selectedKeys: [] });
    expect(screen.queryByRole("button", { name: "Save selection as view" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete view" })).not.toBeInTheDocument();
    const trigger = screen.getByRole("button", { name: "View actions" });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: "Edit view" }));
    expect(screen.getByRole("textbox", { name: "View name" })).toHaveFocus();
    fireEvent(screen.getByRole("dialog"), new Event("cancel", { cancelable: true }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
  it("does not dismiss a pending save via Escape and preserves member edits", async () => {
    let finish!: (value: typeof view) => void;
    const props = setup({ views: [view], activeView: view, onSave: vi.fn(() => new Promise<typeof view>((resolve) => { finish = resolve; })) });
    fireEvent.click(screen.getByRole("button", { name: "View actions" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit view" }));
    fireEvent.click(screen.getAllByRole("checkbox")[0]);
    fireEvent.click(screen.getByRole("button", { name: "Save view" }));
    fireEvent(screen.getByRole("dialog"), new Event("cancel", { cancelable: true }));
    expect(screen.getByRole("dialog")).toBeVisible();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(props.onSave).toHaveBeenCalledWith(expect.objectContaining({ rootTableKeys: keys.slice(1, 2), positions: undefined }));
    finish(view);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
  it("shows an active business domain while allowing a return to the full model", () => {
    const props = setup({ activeView: { ...view, id: "domain:commerce", name: "Commerce" } });
    expect(screen.getByRole("combobox", { name: "Model view" })).toHaveValue("domain:commerce");
    fireEvent.change(screen.getByRole("combobox", { name: "Model view" }), { target: { value: "" } });
    expect(props.onApply).toHaveBeenCalledWith(undefined);
  });

  it("filters the member picker without dropping checked tables outside the search", async () => {
    const props = setup({ views: [view], activeView: view });
    fireEvent.click(screen.getByRole("button", { name: "View actions" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit view" }));
    fireEvent.change(screen.getByRole("searchbox", { name: "Find view members" }), { target: { value: "not-present" } });
    expect(screen.getByText("No tables match your search.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Save view" }));
    await waitFor(() => expect(props.onSave).toHaveBeenCalledWith(expect.objectContaining({ rootTableKeys: view.rootTableKeys })));
  });
  it("focuses Cancel for deletion and preserves the view after a failed delete", async () => {
    const props = setup({ views: [view], activeView: view, onDelete: vi.fn().mockRejectedValue(new Error("storage unavailable")) });
    fireEvent.click(screen.getByRole("button", { name: "View actions" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete view" }));
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete view" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("storage unavailable");
    expect(props.onApply).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeVisible();
  });

});
