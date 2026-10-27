import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChangeReviewWorkspace } from "./ChangeReviewWorkspace";
import type { NodalStudioPlatform } from "../../platform";
import { WebPlatform } from "../../platform/web-platform";
import type { ChangeReviewWorkspace as Workspace } from "../../platform/change-review-types";
const item = { key: "note:1", kind: "annotation", title: "app.payments", object: { kind: "table" as const, schema: "app", name: "payments" }, reason: "supportChanged", before: { description: "Every payment has an order" }, after: { nullable: true }, evidence: "e1", status: "open", note: "", actions: ["confirm", "defer", "archive"] };
const base: Workspace = { pendingCount: 1, impactCount: 1, structureCount: 0, total: 1, nextCursor: null, sourceId: "source", roundId: "round", baseline: "before", target: "after", baselineAt: "2026-10-24T00:00:00Z", targetAt: "2026-10-24T01:00:00Z", revision: "v1", initialized: true, completed: false, identityChanged: false, items: [item], events: [], coverage: "observedMetadataOnly" };
function setup(data = base) {
  const platform: NodalStudioPlatform = new WebPlatform();
  const load = vi.spyOn(platform, "getChangeReview").mockResolvedValue(structuredClone(data));
  const save = vi.spyOn(platform, "applyChangeReview").mockResolvedValue({ ...data, revision: "v2", items: [] });
  const changed = vi.fn().mockResolvedValue(undefined);
  render(<ChangeReviewWorkspace platform={platform} sourceId="source" revision="1" onChanged={changed} onLocate={vi.fn()} onRefresh={vi.fn()} />);
  return { load, save, changed };
}
beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function (this: HTMLDialogElement) { this.setAttribute("open", ""); } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function (this: HTMLDialogElement) { this.removeAttribute("open"); } });
});
afterEach(() => vi.restoreAllMocks());
describe("current change review", () => {
  it("requires an explicit preview and saves edited text against the displayed revision", async () => {
    const { save } = setup();
    const field = await screen.findByLabelText("Description to confirm (keep or revise)");
    fireEvent.change(field, { target: { value: "A payment may precede an order" } });
    expect(screen.getByRole("button", { name: "Complete this round" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm this description" }));
    expect(save).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm decision" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ revision: "v1", text: "A payment may precede an order", action: "confirm", itemKey: "note:1" }), expect.objectContaining({ view: "impact" })));
    expect(await screen.findByText("Decision saved locally.")).toBeVisible();
  });
  it("retains a draft after a conflict and does not claim it was saved", async () => {
    const { save } = setup(); save.mockRejectedValue(new Error("Review evidence changed"));
    fireEvent.change(await screen.findByLabelText("Description to confirm (keep or revise)"), { target: { value: "my retained draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm this description" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm decision" }));
    await screen.findAllByText(/Review evidence changed/);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByLabelText("Description to confirm (keep or revise)")).toHaveValue("my retained draft");
    expect(screen.queryByText("Decision saved locally.")).not.toBeInTheDocument();
  });
  it("requires a reason for deferral and blocks completion", async () => {
    setup(); await screen.findByText("app.payments", { selector: "h3" });
    expect(screen.getByRole("button", { name: "Defer" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Reason for deferral, archival or accepted limitation"), { target: { value: "Check checkout flow" } });
    fireEvent.click(screen.getByRole("button", { name: "Defer" }));
    expect(screen.getByText("Check checkout flow", { selector: ".review-preview-text" })).toBeVisible();
  });
  it("keeps a successful save separate from a failed model refresh", async () => {
    const { save, changed } = setup(); changed.mockRejectedValue(new Error("refresh failed"));
    await screen.findByLabelText("Description to confirm (keep or revise)");
    fireEvent.click(screen.getByRole("button", { name: "Confirm this description" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm decision" }));
    expect(await screen.findByText(/Saved, but the model view could not refresh/)).toBeVisible();
    changed.mockResolvedValue(undefined); fireEvent.click(screen.getByRole("button", { name: "Retry view refresh" }));
    await waitFor(() => expect(screen.queryByText(/Saved, but the model view could not refresh/)).not.toBeInTheDocument());
    expect(save).toHaveBeenCalledTimes(1);
  });
  it("does not initialize or confirm anything just by opening the page", async () => {
    const { save } = setup({ ...base, initialized: false, baseline: null });
    expect(await screen.findByRole("button", { name: "Establish starting point" })).toBeVisible();
    expect(save).not.toHaveBeenCalled();
  });
  it("loads subsequent pages from the server and uses the global pending count", async () => {
    const { load } = setup({ ...base, items: [], total: 75, nextCursor: "cursor-1", pendingCount: 75 });
    await screen.findByText(/Matches：75/);
    expect(screen.getByRole("button", { name: "Complete this round" })).toBeDisabled();
    load.mockResolvedValue({ ...base, items: [{ ...item, title: "page two" }], total: 75, nextCursor: null, pendingCount: 75 });
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await screen.findByText("page two", { selector: "h3" });
    expect(load).toHaveBeenLastCalledWith("source", expect.objectContaining({ cursor: "cursor-1", limit: 50 }));
    expect(screen.getByRole("button", { name: "Next page" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Previous page" }));
    await waitFor(() => expect(load).toHaveBeenLastCalledWith("source", expect.objectContaining({ cursor: undefined })));
  });
  it("previews only explicitly selected structure keys and clears selection on page change", async () => {
    const { load, save } = setup(); await screen.findByText("app.payments", { selector: "h3" });
    const structure = { ...item, key: "structure:1", title: "added_column", kind: "structure", actions: ["seen", "defer"] };
    load.mockResolvedValue({ ...base, items: [structure], structureCount: 51, total: 51, nextCursor: "more", pendingCount: 52 });
    fireEvent.click(screen.getByRole("button", { name: "All structure changes (0)" }));
    await screen.findByLabelText("Select added_column");
    fireEvent.click(screen.getByRole("button", { name: "Select this page" }));
    fireEvent.click(screen.getByRole("button", { name: "Mark selected structure reviewed (1)" }));
    expect(save).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm decision" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ action: "seenBatch", itemKeys: ["structure:1"], itemKey: null }), expect.objectContaining({ view: "structure" })));
  });
  it("restores the selected archived event with explicit pending-review wording", async () => {
    const { load, save } = setup(); await screen.findByText("app.payments", { selector: "h3" });
    load.mockResolvedValue({ ...base, items: [], events: [{ id: "archive-1", at: base.targetAt, action: "archive", item, text: "retired", restorable: true }], total: 1 });
    fireEvent.click(screen.getByRole("button", { name: "Decision history" }));
    fireEvent.click(await screen.findByRole("button", { name: "Restore archived statement" }));
    expect(screen.getByText(/Old confirmation is not restored/)).toBeVisible();
    expect(save).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm decision" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ action: "restore", itemKey: "archive-1" }), expect.anything()));
  });
  it("discards only the restored item's stale draft after a successful restore", async () => {
    const { load, save } = setup();
    fireEvent.change(await screen.findByLabelText("Description to confirm (keep or revise)"), { target: { value: "obsolete unsaved draft" } });
    load.mockResolvedValue({ ...base, items: [], events: [{ id: "archive-1", at: base.targetAt, action: "archive", item, text: "retired elsewhere", restorable: true }] });
    fireEvent.click(screen.getByRole("button", { name: "Decision history" }));
    fireEvent.click(await screen.findByRole("button", { name: "Restore archived statement" }));
    save.mockResolvedValue({ ...base, revision: "v2", items: [], events: [] });
    fireEvent.click(screen.getByRole("button", { name: "Confirm decision" }));
    await screen.findByText("Decision saved locally.");
    load.mockResolvedValue({ ...base, revision: "v2" });
    fireEvent.click(screen.getByRole("button", { name: "Understanding impacts (1)" }));
    expect(await screen.findByLabelText("Description to confirm (keep or revise)")).toHaveValue("Every payment has an order");
  });
  it("clears a confirmed draft so later server text is not replaced by an older edit", async () => {
    const { load } = setup();
    fireEvent.change(await screen.findByLabelText("Description to confirm (keep or revise)"), { target: { value: "previously confirmed edit" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm this description" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm decision" }));
    await screen.findByText("Decision saved locally.");
    load.mockResolvedValue({ ...base, revision: "v3", items: [{ ...item, before: { description: "new externally edited statement" } }] });
    fireEvent.click(screen.getByRole("button", { name: "Reload review" }));
    expect(await screen.findByLabelText("Description to confirm (keep or revise)")).toHaveValue("new externally edited statement");
  });

  it("returns to page one when the evidence-bound server cursor expires", async () => {
    const { load } = setup({ ...base, nextCursor: "expired" }); await screen.findByText("app.payments", { selector: "h3" });
    load.mockRejectedValueOnce(new Error("Review page expired. Return to the first page.")).mockResolvedValue({ ...base, revision: "v2", nextCursor: null });
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await waitFor(() => expect(load).toHaveBeenLastCalledWith("source", expect.objectContaining({ cursor: undefined })));
    expect(await screen.findByText("app.payments", { selector: "h3" })).toBeVisible();
  });

});
