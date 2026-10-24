import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LogicalRelationship, RelationshipValidation, SaveLogicalRelationshipInput } from "../../platform";
import { reportSnapshot, reportSemantics } from "../../test/schema-report-fixture";
import { RelationshipManager } from "./RelationshipManager";
import { RelationshipEditor } from "./RelationshipEditor";

const relationship = reportSemantics.logicalRelationships[0];
const valid: RelationshipValidation = { valid: true, compatible: true, duplicate: false, physicalExists: false, suggestedCardinality: "manyToOne", status: "active", messages: [] };
const second: LogicalRelationship = { ...relationship, id: "second", name: "Customer order", source: { schema: "public", table: "orders", columns: ["customer_id"] }, target: { schema: "public", table: "customers", columns: ["id"] }, cardinality: "manyToOne" };
const saved = (input: SaveLogicalRelationshipInput): LogicalRelationship => ({ ...relationship, ...input, id: input.id ?? "new", origin: input.origin ?? "manual", evidence: input.evidence ?? [], note: input.note ?? null, status: input.disabled ? "disabled" : "active" });
const validate = vi.fn().mockResolvedValue(valid);
function Harness({ initial = [relationship, second], save = (input: SaveLogicalRelationshipInput) => Promise.resolve(saved(input)), toggle = vi.fn().mockResolvedValue(undefined), remove = vi.fn(), locate = vi.fn() }: { initial?: LogicalRelationship[]; save?: (input: SaveLogicalRelationshipInput) => Promise<LogicalRelationship>; toggle?: (relationship: LogicalRelationship) => Promise<unknown>; remove?: (relationship: LogicalRelationship) => void; locate?: (relationship: LogicalRelationship) => void }) {
  const [rows, setRows] = useState(initial);
  const [open, setOpen] = useState(true);
  return <><button type="button" onClick={() => setOpen(true)}>Reopen manager</button><RelationshipManager snapshot={reportSnapshot} open={open} relationships={rows} onSelect={locate} onValidate={validate} onSave={async (input) => { const row = await save(input); setRows((rows) => [...rows.filter((item) => item.id !== row.id), row]); return row; }} onToggle={toggle} onDelete={remove} onClose={() => setOpen(false)} /></>;
}
function choose(label: string, option: string) {
  const input = screen.getByRole("combobox", { name: label });
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: option } });
  fireEvent.click(within(screen.getByRole("listbox", { name: `${label} options` })).getByRole("option", { name: new RegExp(`^${option.replaceAll(".", "\\.")}`) }));
}
function editProps(overrides = {}) {
  return { snapshot: reportSnapshot, relationship, onValidate: validate, onSave: vi.fn().mockImplementation((input: SaveLogicalRelationshipInput) => Promise.resolve(saved(input))), onSaved: vi.fn(), onCancel: vi.fn(), onStateChange: vi.fn(), ...overrides };
}
beforeEach(() => {
  validate.mockReset().mockResolvedValue(valid);
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function(this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function(this: HTMLDialogElement) { this.open = false; } });
});
afterEach(() => { cleanup(); Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal"); Reflect.deleteProperty(HTMLDialogElement.prototype, "close"); });

describe("RelationshipManager", () => {
  it("edits in place, preserves search and selection on save, close and reopen", async () => {
    const save = vi.fn().mockImplementation((input: SaveLogicalRelationshipInput) => Promise.resolve(saved(input)));
    render(<Harness save={save} />);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "archive" } });
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByRole("dialog", { name: "Logical relationships" })).toBeVisible();
    fireEvent.change(screen.getByLabelText("Note"), { target: { value: "Reviewed mapping" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("Relationship saved.")).toBeVisible();
    expect(screen.queryByRole("form")).not.toBeInTheDocument();
    expect(screen.getByRole("searchbox")).toHaveValue("archive");
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ id: relationship.id, note: "Reviewed mapping", origin: "confirmedInference", evidence: relationship.evidence }));
    fireEvent.click(screen.getByRole("button", { name: "Close logical relationships" }));
    fireEvent.click(screen.getByRole("button", { name: "Reopen manager" }));
    expect(screen.getByRole("searchbox")).toHaveValue("archive");
    expect(screen.getByText("Reviewed mapping")).toBeVisible();
  });

  it("keeps unsaved edits until discard is explicitly chosen", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Note"), { target: { value: "Unsaved note" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Discard unsaved changes?");
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.getByLabelText("Note")).toHaveValue("Unsaved note");
    fireEvent.click(screen.getByRole("button", { name: "Close logical relationships" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("retains the form after save errors and permits retry", async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error("Local model is locked")).mockImplementation((input: SaveLogicalRelationshipInput) => Promise.resolve(saved(input)));
    render(<Harness save={save} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Local model is locked");
    expect(screen.getByRole("dialog")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("Relationship saved.")).toBeVisible();
  });

  it("offers repair for missing fields and separates physical coverage from attention", () => {
    const remove = vi.fn();
    render(<Harness remove={remove} initial={[{ ...relationship, status: "orphaned" }, { ...second, status: "supersededByPhysical" }]} />);
    expect(screen.getByRole("option", { name: "Needs attention · 1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show on canvas" })).toBeDisabled();
    fireEvent.click(screen.getByLabelText("More relationship actions"));
    fireEvent.click(screen.getByRole("button", { name: "Delete relationship…" }));
    expect(remove).toHaveBeenCalledWith(expect.objectContaining({ status: "orphaned" }));
    fireEvent.click(screen.getByRole("button", { name: "Repair mapping" }));
    expect(screen.getByRole("form", { name: "Edit logical relationship" })).toBeVisible();
    expect(screen.getByRole("combobox", { name: "Source table" })).toBeVisible();
  });

  it("shows toggle failures in the detail pane without closing it", async () => {
    render(<Harness toggle={vi.fn().mockRejectedValue(new Error("Unable to save model"))} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Enabled in this model" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Unable to save model");
    expect(screen.getByRole("checkbox")).toBeChecked();
  });

  it("creates from an empty list using searchable table and field choices", async () => {
    const save = vi.fn().mockImplementation((input: SaveLogicalRelationshipInput) => Promise.resolve(saved(input)));
    render(<Harness initial={[]} save={save} />);
    fireEvent.click(screen.getByRole("button", { name: /New relationship/ }));
    choose("Source table", "archive.orders"); choose("Target table", "public.orders");
    choose("Source field 1", "id"); choose("Target field 1", "id");
    await waitFor(() => expect(screen.getByRole("button", { name: "Create relationship" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Create relationship" }));
    expect(await screen.findByText("Relationship created in this model.")).toBeVisible();
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ name: "orders_id_orders_id", source: { schema: "archive", table: "orders", columns: ["id"] }, cardinality: "manyToOne" }));
  });
});

describe("RelationshipEditor validation", () => {
  it.each(["duplicate", "physicalExists"] as const)("blocks saving when validation reports %s", async (kind) => {
    render(<RelationshipEditor {...editProps({ onValidate: vi.fn().mockResolvedValue({ ...valid, valid: false, [kind]: true }) })} />);
    expect(await screen.findByRole("alert")).toBeVisible();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  });

  it("does not save a changed mapping using stale asynchronous validation", async () => {
    let finish!: (value: RelationshipValidation) => void;
    const onValidate = vi.fn().mockResolvedValueOnce(valid).mockImplementationOnce(() => new Promise<RelationshipValidation>((resolve) => { finish = resolve; }));
    const props = editProps({ onValidate });
    render(<RelationshipEditor {...props} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled());
    choose("Target field 1", "customer_id");
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    await waitFor(() => expect(onValidate).toHaveBeenCalledTimes(2));
    await act(async () => { finish({ ...valid, valid: false, duplicate: true }); await Promise.resolve(); });
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    expect(props.onSave).not.toHaveBeenCalled();
  });

  it("preserves composite mapping order, disabled state and provenance", async () => {
    const relation: LogicalRelationship = { ...second, source: { schema: "public", table: "orders", columns: ["id", "customer_id"] }, target: { schema: "public", table: "orders", columns: ["customer_id", "id"] }, status: "disabled" };
    const props = editProps({ relationship: relation });
    render(<RelationshipEditor {...props} />);
    expect(screen.getByRole("combobox", { name: "Target field 2" })).toHaveValue("id");
    await waitFor(() => expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(props.onSave).toHaveBeenCalledWith(expect.objectContaining({ source: relation.source, target: relation.target, disabled: true, origin: relation.origin, evidence: relation.evidence })));
  });

  it("requires explicit acceptance of incompatible types", async () => {
    render(<RelationshipEditor {...editProps({ onValidate: vi.fn().mockResolvedValue({ ...valid, valid: false, compatible: false, status: "conflicted" }) })} />);
    const allow = await screen.findByRole("checkbox", { name: "Allow type mismatch and mark for review" });
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    fireEvent.click(allow);
    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
  });
});
