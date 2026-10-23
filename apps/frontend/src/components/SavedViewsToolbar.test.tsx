import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { reportSnapshot } from "../test/schema-report-fixture";
import { SavedViewsToolbar, type SavedViewsToolbarProps } from "./SavedViewsToolbar";

const keys = reportSnapshot.schemas.flatMap((schema) => schema.tables.map((table) => table.key));
const view = { id: "view-a", sourceId: reportSnapshot.sourceId, name: "Fulfillment", rootTableKeys: keys.slice(0, 2), relationshipDepth: 0, updatedAt: "now" };
function setup(overrides: Partial<SavedViewsToolbarProps> = {}) {
  const props: SavedViewsToolbarProps = { snapshot: reportSnapshot, views: [], selectedKeys: keys.slice(0, 2), positions: Object.fromEntries(keys.map((key, i) => [`${key.schema}.${key.name}`, { x: i * 300, y: i * 50 }])), viewport: { x: 10, y: 20, zoom: .7 }, onApply: vi.fn(), onSave: vi.fn<SavedViewsToolbarProps["onSave"]>((input) => Promise.resolve({ ...input, id: input.id!, updatedAt: "now" })), onDelete: vi.fn().mockResolvedValue(undefined), ...overrides };
  render(<SavedViewsToolbar {...props} />); return props;
}
describe("Saved model views", () => {
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
    fireEvent.click(screen.getByRole("button", { name: "Duplicate view" }));
    fireEvent.click(screen.getByRole("button", { name: "Save view" }));
    await waitFor(() => expect(props.onSave).toHaveBeenCalled());
    const input = vi.mocked(props.onSave).mock.calls[0][0];
    expect(input.id).not.toBe(view.id); expect(input.positions).toEqual(positions); expect(input.viewport?.zoom).toBe(.5);
    fireEvent.click(screen.getByRole("button", { name: "Delete view" }));
    expect(props.onDelete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete view" }));
    await waitFor(() => expect(props.onDelete).toHaveBeenCalledWith(view.id));
  });
});
