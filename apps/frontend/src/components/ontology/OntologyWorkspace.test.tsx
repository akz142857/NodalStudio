import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { expect, it, vi } from "vitest";
import type { DatabaseSnapshot, NodalStudioPlatform } from "../../platform";
import type { ChangeReviewItem } from "../../platform/change-review-types";
import type { ConfirmOntologyInput, ConfirmedDefinition, DraftOntologyInput, OntologyQueryDraft, PaidOrdersDefinition } from "../../platform/ontology-types";
import { diagramColumn, diagramTable } from "../../test/diagram-comparison-fixture";
import { reportSnapshot } from "../../test/schema-report-fixture";
import { OntologyReviewPanel } from "../change-review/OntologyReviewPanel";
import { OntologyWorkspace } from "./OntologyWorkspace";
import { DefinitionEditor } from "./DefinitionEditor";

const orders = diagramTable("orders", [diagramColumn("id")]);
const payments = diagramTable("payments", [
  diagramColumn("order_id"),
  { ...diagramColumn("status", 2), typeName: "text", formattedType: "text" },
  { ...diagramColumn("paid_at", 3), typeName: "timestamptz", formattedType: "timestamp with time zone" },
]);
const initial: DatabaseSnapshot = {
  ...reportSnapshot,
  schemas: [{ name: "public", tables: [orders, payments], views: [], enums: [] }],
};
const renamed: DatabaseSnapshot = {
  ...initial,
  id: "rename",
  schemas: [{
    ...initial.schemas[0],
    tables: [orders, { ...payments, columns: payments.columns.map((field) =>
      field.name === "paid_at" ? { ...field, name: "completed_at" } : field) }],
  }],
};

function chooseOption(input: HTMLElement, search: string, option: string) {
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: search } });
  fireEvent.click(within(screen.getByRole("listbox")).getByRole("option", { name: option }));
}

it.each([
  { databaseType: "mySql", typeName: "datetime", statusType: "enum", label: "Storage Time Zone", storage: "singaporeDateTime" },
  { databaseType: "sqlite", typeName: "INTEGER", statusType: "TEXT", label: "Time Format", storage: "unixMilliseconds" },
] as const)("requires the payment time storage choice for $databaseType", ({ databaseType, typeName, statusType, label, storage }) => {
  const snapshot: DatabaseSnapshot = {
    ...initial, database: { ...initial.database, databaseType },
    schemas: [{ ...initial.schemas[0], tables: [orders, { ...payments, columns: payments.columns.map((field) => {
      if (field.name === "paid_at") return { ...field, typeName, formattedType: typeName };
      if (field.name === "status") return { ...field, typeName: statusType };
      return field;
    }) }] }],
  };
  const confirm = vi.fn<(definition: PaidOrdersDefinition) => void>();
  function Editor() {
    const [definition, update] = useState<PaidOrdersDefinition>({
      name: "Paid orders", timeZone: "UTC", order: { name: "Order", table: orders.key, idColumn: "id" },
      payment: { name: "Payment", table: payments.key, orderIdColumn: "order_id", statusColumn: "status", successValue: "paid", paidAtColumn: "paid_at" },
    });
    return <DefinitionEditor snapshot={snapshot} definition={definition} title="Edit definition"
      disabled={false} onChange={update} onConfirm={() => confirm(definition)} />;
  }
  render(<Editor />);
  const save = screen.getByRole("button", { name: "Confirm & Save" });
  expect(save).toBeDisabled();
  fireEvent.change(screen.getByLabelText(label), { target: { value: storage } });
  fireEvent.click(save);
  expect(confirm).toHaveBeenCalledOnce();
  expect(confirm.mock.calls[0][0].timeZone).toBe("UTC");
  expect(confirm.mock.calls[0][0].payment.timeStorage).toBe(storage);
});

it("saves an approved sample and sends an impacted definition to Change Review", async () => {
  let saved: ConfirmedDefinition | undefined;
  const confirmOntology = vi.fn((input: ConfirmOntologyInput): Promise<ConfirmedDefinition> => {
    saved = { id: "paid-orders", revision: input.target ? input.target.revision + 1 : 1,
      confirmedSnapshotId: input.scope.snapshotId, definition: input.definition, impacts: [] };
    return Promise.resolve(saved);
  });
  const listOntology = vi.fn(() => Promise.resolve(saved ? [saved] : []));
  const draftOntologyLastMonth = vi.fn((input: DraftOntologyInput): Promise<OntologyQueryDraft> => Promise.resolve({
    ...input.scope, revision: input.target.revision, definitionName: "Paid orders", timeZone: "Asia/Singapore",
    startsAt: "2026-10-01T00:00:00+08:00", endsBefore: "2026-11-01T00:00:00+08:00",
    sql: `SELECT "${saved?.definition.payment.paidAtColumn}" FROM "public"."payments";`,
  }));
  const saveOntologySample = vi.fn((input: { sample: ConfirmedDefinition["sample"] }) => {
    saved = { ...saved!, sample: input.sample };
    return Promise.resolve(saved);
  });
  const api = { listOntology, confirmOntology, saveOntologySample, draftOntologyLastMonth } as unknown as NodalStudioPlatform;
  const openQuery = vi.fn();
  const viewChanges = vi.fn();
  const queryClient = new QueryClient();
  const view = (snapshot: DatabaseSnapshot) => <QueryClientProvider client={queryClient}>
    <OntologyWorkspace platform={api} snapshot={snapshot} refreshing={false}
      onRefresh={vi.fn()} onViewChanges={viewChanges} onOpenQuery={openQuery} />
  </QueryClientProvider>;
  const crowded = {
    ...initial,
    schemas: [{ ...initial.schemas[0], tables: [
      ...Array.from({ length: 1_200 }, (_, n) => diagramTable(`orders_history_${n}`, [])),
      orders, payments,
    ] }],
  };
  const page = render(view(crowded));

  const create = screen.getByRole("button", { name: "New Definition" });
  await waitFor(() => expect(create).toBeEnabled());
  fireEvent.click(create);
  const change = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
  change("Definition Name", "Paid orders");
  change("Business Time Zone", "Asia/Singapore");
  const orderObject = screen.getByRole("group", { name: "Order Object" });
  const paymentObject = screen.getByRole("group", { name: "Payment Object" });
  const orderTable = within(orderObject).getByRole("combobox", { name: "Source Table" });
  const orderId = within(orderObject).getByRole("combobox", { name: "Order ID (Primary Key)" });
  expect(orderId).toBeDisabled();
  fireEvent.focus(orderTable);
  expect(within(screen.getByRole("listbox")).getAllByRole("option")).toHaveLength(40);
  expect(screen.getByRole("status")).toHaveTextContent("Showing 40 of 1,202");
  fireEvent.change(orderTable, { target: { value: "ORDERS" } });
  const exact = within(screen.getByRole("listbox")).getByRole("option", { name: "public.orders" });
  expect(within(exact).getByText("orders")).toBeVisible();
  expect(within(exact).getByText("public")).toBeVisible();
  expect(exact).toHaveAttribute("title", "public.orders");
  expect(orderTable).toHaveAttribute("aria-activedescendant", exact.id);
  fireEvent.keyDown(orderTable, { key: "ArrowDown" });
  expect(orderTable).not.toHaveAttribute("aria-activedescendant", exact.id);
  fireEvent.keyDown(orderTable, { key: "ArrowUp" });
  expect(orderTable).toHaveAttribute("aria-activedescendant", exact.id);
  fireEvent.keyDown(orderTable, { key: "Enter" });
  expect(orderTable).toHaveValue("public.orders");
  chooseOption(orderId, "id", "id");
  chooseOption(orderTable, "public.orders", "public.orders");
  expect(orderId).toHaveValue("id");
  chooseOption(within(paymentObject).getByRole("combobox", { name: "Source Table" }), "PUBLIC.PAYMENTS", "public.payments");
  chooseOption(screen.getByRole("combobox", { name: "Order Reference" }), "order", "order_id");
  chooseOption(screen.getByRole("combobox", { name: "Payment Status" }), "stat", "status");
  change("Successful Status Value", "succeeded");
  chooseOption(screen.getByRole("combobox", { name: "Successful Payment Time" }), "paid", "paid_at");
  fireEvent.click(screen.getByRole("button", { name: "Confirm & Save" }));
  await screen.findByRole("heading", { name: "Paid orders" });
  expect(confirmOntology).toHaveBeenCalledOnce();
  change("Sample Business Month", "2026-10");
  change("Expected Order IDs", "1\n 4 \n7");
  fireEvent.click(screen.getByRole("button", { name: "Save Approved Sample" }));
  expect(await screen.findByText("Approved sample saved.")).toBeVisible();
  expect(saveOntologySample).toHaveBeenCalledWith(expect.objectContaining({
    sample: { month: "2026-10", expectedOrderIds: ["1", " 4 ", "7"] },
  }));
  fireEvent.click(screen.getByRole("button", { name: "Generate SQL" }));
  const draft = await screen.findByRole("region", { name: "SQL Draft" });
  expect(draft).toHaveTextContent('SELECT "paid_at"');
  fireEvent.click(within(draft).getByRole("button", { name: "Open in Query" }));
  expect(openQuery).toHaveBeenCalledWith(expect.objectContaining({ snapshotId: initial.id, revision: 1 }), { id: saved?.id, revision: 1 });

  saved = { ...saved!, impacts: [{ field: { role: "paymentTime", table: payments.key, column: "paid_at" }, reason: "missingColumn" }] };
  page.rerender(view(renamed));
  expect(await screen.findByText("public.payments.paid_at")).toBeVisible();
  expect(screen.getByRole("button", { name: "Generate SQL" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "View Change Review" }));
  expect(viewChanges).toHaveBeenCalledWith("paid-orders");
  expect(screen.queryByRole("button", { name: "Edit Definition" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Save Approved Sample" })).not.toBeInTheDocument();
});

it("restores a missing field when search is dismissed and lets the reviewer bind its replacement", () => {
  const definition: PaidOrdersDefinition = {
    name: "Paid orders", timeZone: "UTC", order: { name: "Order", table: orders.key, idColumn: "id" },
    payment: { name: "Payment", table: payments.key, orderIdColumn: "order_id", statusColumn: "status", successValue: "paid", paidAtColumn: "paid_at" },
  };
  const item: ChangeReviewItem = {
    key: "ontology:orders", kind: "ontology", title: definition.name, object: null, reason: "ontologyBindingChanged",
    evidence: "binding", status: "open", note: "", actions: ["confirmOntology"],
    before: { definition },
    after: {
      definitionId: "orders", snapshotId: renamed.id, sample: { month: "2026-10", expectedOrderIds: ["1"] },
      impacts: [{ reason: "missingColumn", field: { role: "paymentTime", table: payments.key, column: "paid_at" } }],
    },
  };
  const verify = vi.fn<(definition: PaidOrdersDefinition, basis: string) => void>();
  render(<OntologyReviewPanel item={item} snapshot={renamed} busy={false} onVerify={verify} onClose={vi.fn()} />);
  const time = screen.getByRole("combobox", { name: "Successful Payment Time" });
  expect(time).toHaveValue("paid_at · Field missing from the current snapshot");
  fireEvent.focus(time);
  fireEvent.change(time, { target: { value: "absent" } });
  expect(screen.getByRole("status")).toHaveTextContent("No matching options.");
  fireEvent.keyDown(time, { key: "Escape" });
  expect(time).toHaveValue("paid_at · Field missing from the current snapshot");
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  fireEvent.click(time);
  fireEvent.change(time, { target: { value: "completed" } });
  fireEvent.keyDown(time, { key: "Enter" });
  expect(time).toHaveValue("completed_at");
  expect(verify).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Business Confirmation Evidence"), { target: { value: "Event contract confirmed" } });
  fireEvent.click(screen.getByRole("button", { name: "Run Order Sample" }));
  expect(verify).toHaveBeenCalledWith({ ...definition, payment: { ...definition.payment, paidAtColumn: "completed_at" } }, "Event contract confirmed");
});
