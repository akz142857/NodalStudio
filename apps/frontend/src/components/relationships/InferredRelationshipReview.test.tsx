import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IgnoredRelationshipInference, LogicalRelationship, RelationshipValidation, SaveLogicalRelationshipInput } from "../../platform";
import { inferenceReviewSnapshot as snapshot } from "../../test/inference-review-fixture";
import { RelationshipManager } from "./RelationshipManager";
import type { ValidateRelationship } from "./RelationshipEditor";
import { candidateInScope, pendingCandidates, relationshipCandidates } from "./inferred-review";
import { buildSchemaGraph } from "../../graph/schema-graph";

const valid: RelationshipValidation = { valid: true, compatible: true, duplicate: false, physicalExists: false, suggestedCardinality: "manyToOne", status: "active", messages: [] };
const now = "2026-10-24T00:00:00Z";
const saved = (input: SaveLogicalRelationshipInput): LogicalRelationship => ({ ...input, id: `${input.source.table}-${input.source.columns[0]}`, sourceId: snapshot.sourceId, origin: input.origin ?? "manual", note: input.note ?? null, evidence: input.evidence ?? [], status: input.allowTypeMismatch ? "conflicted" : "active", createdAt: now, updatedAt: now });
const save = vi.fn<(input: SaveLogicalRelationshipInput) => Promise<LogicalRelationship>>().mockImplementation((input) => Promise.resolve(saved(input)));
const validate = vi.fn<ValidateRelationship>().mockResolvedValue(valid);
const ignore = vi.fn<(key: string) => Promise<void>>().mockResolvedValue(undefined);
const restore = vi.fn<(key: string) => Promise<void>>().mockResolvedValue(undefined);
const request = { revision: 1 };
function Harness({ initialIgnored = [], selectedTableId }: { initialIgnored?: IgnoredRelationshipInference[]; selectedTableId?: string }) {
  const [relationships, setRelationships] = useState<LogicalRelationship[]>([]);
  const [ignored, setIgnored] = useState(initialIgnored);
  const [open, setOpen] = useState(true);
  return <><button onClick={() => setOpen(true)}>Reopen</button><RelationshipManager snapshot={snapshot} relationships={relationships} ignoredInferences={ignored} reviewRequest={request} open={open} onClose={() => setOpen(false)}
    selectedTableId={selectedTableId} visibleTableIds={["public.order_items", "public.orders"]} onSelect={vi.fn()} onValidate={validate}
    onSave={async (input) => { const result = await save(input); setRelationships((current) => [...current, result]); return result; }}
    onIgnore={async (key) => { await ignore(key); setIgnored((current) => [...current, { sourceId: snapshot.sourceId, relationshipKey: key, ignoredAt: now }]); }}
    onRestore={async (key) => { await restore(key); setIgnored((current) => current.filter((item) => item.relationshipKey !== key)); }} /></>;
}
const rows = () => within(screen.getByRole("navigation", { name: "Inferred candidates" })).queryAllByRole("button").filter((button) => button.hasAttribute("aria-pressed"));
const wholeDatabase = () => fireEvent.change(screen.getByLabelText("Candidate scope"), { target: { value: "all" } });
beforeEach(() => {
  save.mockReset().mockImplementation((input: SaveLogicalRelationshipInput) => Promise.resolve(saved(input)));
  validate.mockReset().mockResolvedValue(valid); ignore.mockReset().mockResolvedValue(undefined); restore.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function(this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function(this: HTMLDialogElement) { this.open = false; } });
});
afterEach(() => { cleanup(); Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal"); Reflect.deleteProperty(HTMLDialogElement.prototype, "close"); });

describe("Inferred relationship review", () => {
  it("filters by current diagram, selected table, evidence, fields and comments", async () => {
    render(<Harness selectedTableId="public.payments" />);
    expect(rows()).toHaveLength(1);
    wholeDatabase(); expect(rows()).toHaveLength(4);
    fireEvent.change(screen.getByLabelText("Candidate evidence"), { target: { value: "review" } });
    expect(rows()).toHaveLength(1); expect(rows()[0]).toHaveTextContent("payments");
    fireEvent.change(screen.getByLabelText("Candidate evidence"), { target: { value: "matching" } }); expect(rows()).toHaveLength(3);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "购买客户" } }); expect(rows()).toHaveLength(1);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Candidate scope"), { target: { value: "view" } });
    expect(rows()).toHaveLength(1); expect(rows()[0]).toHaveTextContent("order_id → id");
    await waitFor(() => expect(validate).toHaveBeenCalled());
    expect(save).not.toHaveBeenCalled();
  });

  it("confirms and advances in the filtered queue, retaining provenance and search", async () => {
    render(<Harness />); wholeDatabase();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "order_items" } });
    expect(rows()).toHaveLength(2);
    fireEvent.click(screen.getByText("Add a note"));
    fireEvent.change(screen.getByLabelText("Confirmation note"), { target: { value: "Checked application mapping" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Confirm and next" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Confirm and next" }));
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ origin: "confirmedInference", note: "Checked application mapping" }));
    expect(save.mock.calls[0][0].evidence).toContain("Target is a single-column primary key");
    expect(screen.getByRole("searchbox")).toHaveValue("order_items");
    expect(rows()[0]).toHaveTextContent("product_id");
    expect(screen.getByRole("button", { name: "Logical · 1" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Inferred · 3" })).toBeVisible();
    expect(screen.getByLabelText("Confirmation note")).toHaveValue("");
  });

  it("does not advance on failure or double-submit and retains note for retry", async () => {
    let reject!: (reason: Error) => void;
    save.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    render(<Harness />); wholeDatabase();
    fireEvent.click(screen.getByText("Add a note"));
    fireEvent.change(screen.getByLabelText("Confirmation note"), { target: { value: "Keep this note" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Confirm and next" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Confirm and next" }));
    expect(screen.getByRole("button", { name: "Confirming…" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Confirming…" }));
    expect(save).toHaveBeenCalledOnce();
    await act(() => Promise.resolve(reject(new Error("Model is locked"))));
    expect(await screen.findByRole("alert")).toHaveTextContent("Model is locked");
    expect(rows()).toHaveLength(4); expect(screen.getByLabelText("Confirmation note")).toHaveValue("Keep this note");
    fireEvent.click(screen.getByRole("button", { name: "Confirm and next" }));
    await waitFor(() => expect(rows()).toHaveLength(3));
  });

  it("ignores and restores a candidate across closing and reopening", async () => {
    render(<Harness />); wholeDatabase();
    fireEvent.click(screen.getByRole("button", { name: "Ignore candidate" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Ignored · 1" })).toBeVisible());
    expect(rows()).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "Close relationships" })); fireEvent.click(screen.getByRole("button", { name: "Reopen" }));
    fireEvent.click(screen.getByRole("button", { name: "Ignored · 1" }));
    restore.mockRejectedValueOnce(new Error("Store unavailable"));
    fireEvent.click(screen.getByRole("button", { name: "Restore candidate" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Store unavailable");
    expect(screen.getByRole("button", { name: "Ignored · 1" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Restore candidate" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Ignored · 0" })).toBeVisible());
    await waitFor(() => expect(screen.getByRole("button", { name: "Inferred · 4" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Inferred · 4" })); wholeDatabase(); expect(rows()).toHaveLength(4);
    expect(restore).toHaveBeenLastCalledWith(ignore.mock.calls[0][0]);
  });

  it("keeps dirty reviews until discard and requires explicit acceptance of type mismatch", async () => {
    validate.mockResolvedValue({ ...valid, valid: false, compatible: false, status: "conflicted" });
    render(<Harness selectedTableId="public.payments" />);
    expect(await screen.findByRole("checkbox", { name: /I reviewed the type mismatch/ })).toBeVisible();
    expect(screen.getByRole("button", { name: "Confirm and next" })).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: /I reviewed the type mismatch/ }));
    expect(screen.getByRole("button", { name: "Confirm and next" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Logical · 0" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Discard unsaved changes?");
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.getByRole("checkbox")).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Confirm and next" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ allowTypeMismatch: true })));
  });

  it("lists and restores legacy naming rules and stale ignore entries", async () => {
    const rule = "rule:naming-id:public.order_items.order_id";
    render(<Harness initialIgnored={[rule, "deleted.orders[user_id]->public.users[id]"].map((relationshipKey) => ({ relationshipKey, sourceId: snapshot.sourceId, ignoredAt: now }))} />);
    expect(screen.getByRole("button", { name: "Inferred · 3" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Ignored · 2" }));
    expect(screen.getByText(/including future suggestions/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Restore field suggestions" }));
    await waitFor(() => expect(restore).toHaveBeenCalledWith(rule));
    expect(await screen.findByText(/no longer generated/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Restore candidate" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Ignored · 0" })).toBeVisible());
  });

  it("ignores stale validation results after switching candidates", async () => {
    let finish!: (value: RelationshipValidation) => void;
    validate.mockImplementationOnce(() => new Promise<RelationshipValidation>((resolve) => { finish = resolve; })).mockResolvedValue(valid);
    render(<Harness />); wholeDatabase();
    await waitFor(() => expect(validate).toHaveBeenCalledOnce());
    fireEvent.click(rows()[1]);
    await waitFor(() => expect(screen.getByRole("button", { name: "Confirm and next" })).toBeEnabled());
    await act(() => Promise.resolve(finish({ ...valid, valid: false, duplicate: true })));
    expect(screen.getByRole("button", { name: "Confirm and next" })).toBeEnabled();
    expect(screen.queryByText(/possibly disabled/)).not.toBeInTheDocument();
  });
});

describe("Review evidence", () => {
  it("marks signed/unsigned MySQL fields and alternative logical targets for review", () => {
    const mysql = structuredClone(snapshot);
    const items = mysql.schemas[0].tables.find((table) => table.key.name === "order_items")!;
    const orders = mysql.schemas[0].tables.find((table) => table.key.name === "orders")!;
    Object.assign(items.columns.find((column) => column.name === "order_id")!, { typeName: "int", typeSchema: "", formattedType: "int" });
    Object.assign(orders.columns[0], { typeName: "int", typeSchema: "", formattedType: "int unsigned" });
    const candidate = relationshipCandidates(mysql, []).all.find((row) => row.source.table === "order_items" && row.sourceColumn.name === "order_id")!;
    expect(candidate.typeMatches).toBe(false);
    expect(buildSchemaGraph(mysql, { includeInferredRelationships: true }).edges.find((edge) => edge.source === "public.order_items" && edge.target === "public.orders")?.data?.evidence).toContain("Source and target column types differ");
    const existing = saved({ sourceId: snapshot.sourceId, name: "Business mapping", source: candidate.source, target: { schema: "public", table: "customers", columns: ["id"] }, cardinality: "manyToOne" });
    expect(relationshipCandidates(mysql, [existing]).available.find((row) => row.key === candidate.key)?.existingTargets).toEqual(["public.customers.id (active)"]);
  });
  it("does not describe one field of a composite primary key as unique", () => {
    const composite = structuredClone(snapshot);
    composite.schemas[0].tables.find((table) => table.key.name === "orders")!.primaryKey!.columns = ["id", "customer_id"];
    const { all } = relationshipCandidates(composite, []);
    const candidate = all.find((item) => item.source.table === "order_items" && item.sourceColumn.name === "order_id")!;
    expect(candidate.targetUnique).toBe(false);
    expect(candidate.evidence.join(" ")).toContain("not known to be unique");
    expect(candidateInScope(candidate, "selected", [], "public.orders")).toBe(true);
  });
  it("excludes existing disabled relationships and respects overlapping ignore rules", () => {
    const { all } = relationshipCandidates(snapshot, []);
    const candidate = all[0];
    const logical = { ...saved({ sourceId: snapshot.sourceId, name: "existing", source: candidate.source, target: candidate.target, cardinality: "manyToOne" }), status: "disabled" as const };
    expect(relationshipCandidates(snapshot, [logical]).available.some((row) => row.key === candidate.key)).toBe(false);
    const ignored = [candidate.key, candidate.ruleKey].map((relationshipKey) => ({ sourceId: snapshot.sourceId, relationshipKey, ignoredAt: now }));
    expect(pendingCandidates(all, ignored.slice(1)).some((row) => row.key === candidate.key)).toBe(false);
    expect(pendingCandidates(all, []).some((row) => row.key === candidate.key)).toBe(true);
  });
});
