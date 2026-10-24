import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useEffect, useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RelationshipManager } from "./RelationshipManager";
import { inferenceReviewSnapshot as snapshot } from "../../test/inference-review-fixture";
import { createRelationshipBatchFixture } from "../../test/relationship-batch-fixture";
import type { RelationshipValidation } from "../../platform";

const request = { revision: 1 };
let fixture: ReturnType<typeof createRelationshipBatchFixture>;
const valid: RelationshipValidation = { valid: true, compatible: true, duplicate: false, physicalExists: false, status: "active", suggestedCardinality: "manyToOne", messages: [] };
const validate = () => Promise.resolve(valid);
function Harness() {
  const [, update] = useState(0);
  const [model] = useState(() => createRelationshipBatchFixture(snapshot, () => update((value) => value + 1)));
  useEffect(() => { fixture = model; }, [model]);
  return <RelationshipManager snapshot={snapshot} relationships={model.relationships} ignoredInferences={model.ignored} reviewRequest={request} onClose={vi.fn()} onSelect={vi.fn()} onValidate={validate} onSave={(input) => model.save(input)} onIgnore={(key) => model.ignore(key)} onRestore={(key) => model.restore(key)} batchApi={model.api} />;
}
beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function(this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function(this: HTMLDialogElement) { this.open = false; } });
});
afterEach(() => { cleanup(); Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal"); Reflect.deleteProperty(HTMLDialogElement.prototype, "close"); });
const selectAll = () => fireEvent.change(screen.getByLabelText("Select candidates for batch"), { target: { value: "all" } });

it("selects filtered rows, keeps row details independent, and clears selection on filter changes", async () => {
  render(<Harness />);
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "order_items" } }); selectAll();
  expect(screen.getByText("2 selected")).toBeVisible();
  const list = screen.getByRole("navigation", { name: "Inferred candidates" });
  fireEvent.click(within(list).getAllByRole("button")[1]); expect(screen.getByText("2 selected")).toBeVisible();
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "payments" } });
  expect(screen.getByText("0 selected")).toBeVisible();
  expect(screen.getByRole("status")).toHaveTextContent("Selection cleared");
  await waitFor(() => expect(screen.getByRole("button", { name: "Confirm and next" })).toBeEnabled());
});
it("previews mixed selection, requires each mapping group review, confirms only eligible rows and undoes the batch", async () => {
  render(<Harness />); selectAll(); fireEvent.click(screen.getByRole("button", { name: "Preview confirmation" }));
  const confirm = await screen.findByRole("button", { name: "Confirm 3 relationships" });
  expect(confirm).toBeDisabled(); expect(screen.getByText("Keep for individual review · 1")).toBeVisible();
  for (const checkbox of screen.getAllByRole("checkbox", { name: "I checked the business meaning of this group" })) fireEvent.click(checkbox);
  fireEvent.click(confirm);
  await waitFor(() => expect(screen.getByRole("button", { name: "Logical · 3" })).toBeVisible());
  expect(screen.getByRole("button", { name: "Inferred · 1" })).toBeVisible();
  expect(screen.getByText("1 selected")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Undo batch" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Logical · 0" })).toBeVisible());
  expect(await screen.findByText("Batch undone")).toBeVisible();
});
it("preserves selection and group review on failure and prevents repeated submission", async () => {
  render(<Harness />); selectAll(); fireEvent.click(screen.getByRole("button", { name: "Preview confirmation" }));
  await screen.findByRole("button", { name: "Confirm 3 relationships" });
  for (const checkbox of screen.getAllByRole("checkbox", { name: "I checked the business meaning of this group" })) fireEvent.click(checkbox);
  fixture.setFailure(true); fireEvent.click(screen.getByRole("button", { name: "Confirm 3 relationships" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("no changes saved");
  expect(screen.getByText("4 selected")).toBeVisible(); expect(fixture.relationships).toHaveLength(0);
  fixture.setFailure(false); fireEvent.click(screen.getByRole("button", { name: "Confirm 3 relationships" }));
  await waitFor(() => expect(fixture.relationships).toHaveLength(3));
});
it("supports batch ignore, restore and durable history entry points", async () => {
  render(<Harness />); selectAll(); fireEvent.click(screen.getByRole("button", { name: "Ignore 4" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Ignored · 4" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Ignored · 4" })); selectAll();
  fireEvent.click(screen.getByRole("button", { name: "Restore 4" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Ignored · 0" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Batch history" }));
  expect(await screen.findByText("Restored 4 candidates")).toBeVisible();
  expect(screen.getByText("Ignored 4 candidates")).toBeVisible();
});
