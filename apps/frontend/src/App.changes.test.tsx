import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CaptureSnapshotResult, DatabaseSnapshot, SchemaChangeSet, SemanticBundle } from "./platform";
import { getPlatform } from "./platform";
import type { ChangeReviewWorkspace } from "./platform/change-review-types";
import type { ConfirmedDefinition } from "./platform/ontology-types";
import { App } from "./App";
import { ModelTableChangeDetails } from "./components/ModelTableChanges";
import type { SchemaCanvasProps } from "./components/SchemaCanvas";
import { modelTableKey } from "./graph/model-table-changes";

const fixture = vi.hoisted(() => {
  const before = { id: "before", sourceId: "source", capturedAt: "2026-10-12T00:00:00Z", fingerprint: "before-fingerprint",
    database: { name: "app", databaseType: "postgreSql" as const, version: "17" }, schemas: [] };
  const after = { ...before, id: "after", capturedAt: "2026-10-13T00:00:00Z", fingerprint: "after-fingerprint", schemas: [{ name: "public", views: [], enums: [], tables: [{
    key: { kind: "table" as const, schema: "public", name: "orders" }, tableKind: "ordinary" as const,
    columns: [{
      name: "status", ordinalPosition: 1, formattedType: "character varying(20)", typeSchema: "pg_catalog", typeName: "varchar",
      nullable: false, defaultValue: null, identity: null, generated: false, comment: null,
    }], primaryKey: null, foreignKeys: [], indexes: [], constraints: [], comment: "Order data",
  }] }] };
  const changeSet = { id: "forward", beforeSnapshotId: "before", afterSnapshotId: "after", createdAt: after.capturedAt,
    operations: [{ operationType: "addTable" as const, object: { kind: "table", schema: "public", name: "orders" }, risk: "low" as const, before: null, after: "1 columns" }],
    riskSummary: { high: 0, medium: 0, low: 1, informational: 0 } };
  return { before, after, changeSet };
});

// Keep this an App wiring test: canvas layout and connection IO have their own tests.
vi.mock("./components/ConnectionPanel", () => ({ ConnectionPanel: ({ onSnapshot }: { onSnapshot: (result: CaptureSnapshotResult) => void }) =>
  <>
    <button type="button" onClick={() => onSnapshot({ snapshot: fixture.after, changeSet: fixture.changeSet, stored: true })}>Capture fixture</button>
    <button type="button" onClick={() => onSnapshot({ snapshot: fixture.after, changeSet: null, stored: false })}>Open stored fixture</button>
    <button type="button" onClick={() => onSnapshot({ snapshot: { ...fixture.after, database: { ...fixture.after.database, databaseType: "mySql", version: "5.7.44-log" } }, changeSet: null, stored: false })}>
      Open legacy MySQL fixture
    </button>
    {(["mySql", "sqlite"] as const).map((databaseType) => <button key={databaseType} type="button"
      onClick={() => onSnapshot({ snapshot: { ...fixture.after, database: { ...fixture.after.database, databaseType } }, changeSet: null, stored: false })}>
      Open {databaseType} fixture
    </button>)}
  </> }));
vi.mock("./components/SchemaCanvas", () => ({
  SchemaCanvas: ({ snapshot, changeSet, modelTableChanges, onSelectTable }: SchemaCanvasProps) => <>
    <p>Diagram: {snapshot.id} · {changeSet?.id ?? "no comparison"}</p>
    {snapshot.schemas.flatMap((schema) => schema.tables).map((table) => <button type="button" key={modelTableKey(table.key)} onClick={() => onSelectTable(table)}>
      {table.key.schema}.{table.key.name} · {modelTableChanges?.get(modelTableKey(table.key))?.status ?? "unchanged"}
    </button>)}
  </>,
}));

describe("App schema changes", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(["mySql", "sqlite"])("opens Ontology from the %s model", async (databaseType) => {
    const platform = getPlatform();
    vi.spyOn(platform, "getRuntimeInfo").mockResolvedValue({ kind: "desktop", label: "Desktop runtime", version: "test" });
    const listOntology = vi.spyOn(platform, "listOntology").mockResolvedValue([]);
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><App /></QueryClientProvider>);
    await screen.findByText("Desktop runtime");
    fireEvent.click(screen.getByRole("button", { name: `Open ${databaseType} fixture` }));
    fireEvent.click(screen.getByRole("button", { name: "Ontology" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "New Definition" })).toBeEnabled());
    expect(listOntology).toHaveBeenCalledWith({ sourceId: fixture.after.sourceId, snapshotId: fixture.after.id });
  });

  it("shows the minimum supported MySQL version in Ontology", async () => {
    const platform = getPlatform();
    vi.spyOn(platform, "getRuntimeInfo").mockResolvedValue({ kind: "desktop", label: "Desktop runtime", version: "test" });
    const listOntology = vi.spyOn(platform, "listOntology").mockResolvedValue([]);
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><App /></QueryClientProvider>);
    await screen.findByText("Desktop runtime");
    fireEvent.click(screen.getByRole("button", { name: "Open legacy MySQL fixture" }));
    fireEvent.click(screen.getByRole("button", { name: "Ontology" }));
    expect(screen.getByText("Ontology requires MySQL 8.0 or later.")).toBeVisible();
    expect(listOntology).not.toHaveBeenCalled();
  });

  it("exports the loaded snapshot independently of Diagram filters and waits for its saved semantics", async () => {
    const platform = getPlatform();
    vi.spyOn(platform, "getRuntimeInfo").mockResolvedValue({ kind: "desktop", label: "Desktop runtime", version: "test" });
    const semantics: SemanticBundle = { annotations: [{ sourceId: "source", objectKey: fixture.after.schemas[0].tables[0].key, description: "Saved order meaning", tags: [], owner: null, isCore: false, updatedAt: "2026-10-13T10:00:00Z" }], orphanedAnnotations: [], domainGroups: [], savedViews: [], layout: null, logicalRelationships: [], ignoredRelationshipInferences: [] };
    let finish!: (bundle: SemanticBundle) => void;
    vi.spyOn(platform, "getSemantics").mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const save = vi.spyOn(platform, "saveSchemaReport").mockResolvedValue({ path: "/Downloads/report.html" });
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><App /></QueryClientProvider>);
    await screen.findByText("Desktop runtime");
    expect(screen.queryByRole("button", { name: "Export structure document" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Capture fixture" }));
    expect(screen.getByRole("button", { name: "Export structure document" })).toBeDisabled();
    await act(() => Promise.resolve(finish(semantics)));
    fireEvent.change(screen.getByRole("combobox", { name: "Search schema" }), { target: { value: "non-matching-filter" } });
    fireEvent.click(screen.getByRole("button", { name: "Export structure document" }));
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    const input = save.mock.calls[0][0];
    expect(input.html).toContain("public.orders");
    expect(input.html).toContain("after-fingerprint");
    expect(input.html).toContain("Saved order meaning");
    expect(input.html).not.toContain("non-matching-filter");
    expect(await screen.findByText(/Saved to \/Downloads\/report.html/)).toBeVisible();
  });

  it("shows the latest change on the canvas and opens before/after by clicking the table", async () => {
    const platform = getPlatform();
    vi.spyOn(platform, "getRuntimeInfo").mockResolvedValue({ kind: "desktop", label: "Desktop runtime", version: "test" });
    vi.spyOn(platform, "getSnapshot").mockResolvedValue(fixture.after);
    const schema = fixture.after.schemas[0];
    const table = schema.tables[0];
    const snapshot: DatabaseSnapshot = { ...fixture.after, id: "after-refresh", schemas: [{ ...schema, tables: [{
      ...table, columns: [{ ...table.columns[0], formattedType: "character varying(50)" }],
    }] }] };
    vi.spyOn(platform, "capturePostgresSnapshot").mockResolvedValue({ snapshot, stored: true, changeSet: {
      ...fixture.changeSet, id: "refresh", beforeSnapshotId: fixture.after.id, afterSnapshotId: snapshot.id,
      operations: [{ operationType: "alterColumn", object: { kind: "column", schema: "public.orders", name: "status" },
        risk: "medium", before: "character varying(20) not null", after: "character varying(50) not null" }],
    } });

    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><App /></QueryClientProvider>);
    await screen.findByText("Desktop runtime");
    fireEvent.click(screen.getByRole("button", { name: "Capture fixture" }));
    expect(screen.getByRole("button", { name: "Model" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Refresh schema" }));
    expect(await screen.findByText("Diagram: after-refresh · no comparison")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "public.orders · modified" }));
    const detail = within(await screen.findByRole("region", { name: "Latest changes" }));
    expect(detail.getByText("status")).toBeVisible();
    expect(await detail.findByText("character varying(20)")).toBeVisible();
    expect(detail.getByText("character varying(50)")).toBeVisible();
    expect(screen.getByRole("button", { name: "Model" })).toHaveAttribute("aria-pressed", "true");
  });

  it("restores the latest change badge from saved model snapshots", async () => {
    const platform = getPlatform();
    vi.spyOn(platform, "getRuntimeInfo").mockResolvedValue({ kind: "desktop", label: "Desktop runtime", version: "test" });
    const listHistory = vi.spyOn(platform, "listSnapshots");
    vi.spyOn(platform, "listRecentSnapshotIds").mockResolvedValue([fixture.after.id, fixture.before.id]);
    const compare = vi.spyOn(platform, "compareSnapshots").mockResolvedValue(fixture.changeSet);
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><App /></QueryClientProvider>);
    await screen.findByText("Desktop runtime");
    fireEvent.click(screen.getByRole("button", { name: "Open stored fixture" }));
    expect(await screen.findByRole("button", { name: "public.orders · added" })).toBeVisible();
    expect(compare).toHaveBeenCalledExactlyOnceWith("before", "after");
    expect(listHistory).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Model" })).toHaveAttribute("aria-pressed", "true");
  });

  it("loads the new ontology revision immediately after closing its review on the same snapshot", { timeout: 15_000 }, async () => {
    const platform = getPlatform();
    const { id: snapshotId, sourceId, capturedAt } = fixture.after;
    const table = fixture.after.schemas[0].tables[0].key;
    const sample = { month: "2026-09", expectedOrderIds: ["7"] };
    const original: ConfirmedDefinition = {
      id: "paid-orders", revision: 1, confirmedSnapshotId: "before", sample,
      definition: {
        name: "Paid orders", timeZone: "UTC", order: { name: "Order", table, idColumn: "id" },
        payment: { name: "Payment", table, orderIdColumn: "id", statusColumn: "status", successValue: "paid", paidAtColumn: "paid_at" },
      },
      impacts: [{ field: { role: "paymentTime", table, column: "paid_at" }, reason: "missingColumn" }],
    };
    const definition = { ...original.definition, payment: { ...original.definition.payment, paidAtColumn: "completed_at" } };
    const review: ChangeReviewWorkspace = {
      sourceId, roundId: "round", baseline: "before", target: snapshotId, baselineAt: capturedAt, targetAt: capturedAt,
      revision: "open", initialized: true, completed: false, identityChanged: false, coverage: "observedMetadataOnly",
      pendingCount: 1, impactCount: 1, structureCount: 0, total: 1, nextCursor: null, events: [],
      items: [{
        key: `ontology:${original.id}`, kind: "ontology", title: original.definition.name, object: null,
        reason: "ontologyBindingChanged", evidence: "evidence", status: "open", note: "", actions: ["confirmOntology"],
        before: { definition: original.definition },
        after: { definitionId: original.id, snapshotId, impacts: original.impacts, sample, verification: {
          id: "verified", snapshotId, checkedAt: capturedAt, definition, basis: "Verified payment event timestamp",
          month: sample.month, expectedOrderIds: ["7"], actualOrderIds: ["7"], missingOrderIds: [], unexpectedOrderIds: [], passed: true,
        } },
      }],
    };
    vi.spyOn(platform, "getRuntimeInfo").mockResolvedValue({ kind: "desktop", label: "Desktop runtime", version: "test" });
    const lists = vi.spyOn(platform, "listOntology").mockResolvedValueOnce([original])
      .mockResolvedValue([{ ...original, revision: 2, confirmedSnapshotId: snapshotId, definition, impacts: [] }]);
    const loadReview = vi.spyOn(platform, "getChangeReview").mockResolvedValue(review);
    const capture = vi.spyOn(platform, "capturePostgresSnapshot").mockResolvedValue({ snapshot: fixture.after, stored: false, changeSet: null });
    const close = vi.spyOn(platform, "applyChangeReview").mockResolvedValue({ ...review, items: [], pendingCount: 0, impactCount: 0, total: 0, revision: "closed" });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } });
    const { container } = render(<QueryClientProvider client={client}><App /></QueryClientProvider>);

    await screen.findByText("Desktop runtime");
    fireEvent.click(screen.getByRole("button", { name: "Capture fixture" }));
    fireEvent.click(screen.getByRole("button", { name: "Query" }));
    fireEvent.click(await screen.findByRole("button", { name: "Use a business definition" }));
    expect(screen.getByRole("dialog", { name: "Use a business definition" })).toHaveTextContent("paid_at");
    expect(screen.queryByRole("button", { name: "Preview SQL" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "View Change Review" }));
    await screen.findByRole("button", { name: "Confirm Binding and Close Item" }, { timeout: 5_000 });
    loadReview.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Refresh database" }));
    await waitFor(() => expect(loadReview).toHaveBeenCalledWith(sourceId, expect.objectContaining({ itemKey: `ontology:${original.id}` })));
    expect(capture).toHaveBeenCalledWith(sourceId, "manual");
    const confirm = await screen.findByRole("button", { name: "Confirm Binding and Close Item" });
    const dialog = container.querySelector<HTMLDialogElement>(".review-dialog")!;
    dialog.showModal = () => { dialog.open = true; };
    dialog.close = () => { dialog.open = false; };
    fireEvent.click(confirm);
    fireEvent.click(screen.getByRole("button", { name: "Confirm decision" }));
    await screen.findByText("Ontology review closed. Query generation is available.");
    expect(close).toHaveBeenCalledWith(expect.objectContaining({ action: "confirmOntology", text: "verified" }), expect.anything());

    fireEvent.click(screen.getByRole("button", { name: "Query" }));
    fireEvent.click(await screen.findByRole("button", { name: "Use a business definition" }));
    expect(screen.getByRole("dialog", { name: "Use a business definition" })).toHaveTextContent(/Confirmed · Revision 2/);
    expect(screen.getByRole("button", { name: "Preview SQL" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Ontology" }));
    expect(await screen.findByText("completed_at", { selector: "code" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Generate SQL" })).toBeEnabled();
    expect(lists).toHaveBeenCalledTimes(2);
  });

  it("puts SQLite column changes first and keeps the old and new DDL behind a disclosure", async () => {
    const platform = getPlatform();
    const sourceTable = fixture.after.schemas[0].tables[0];
    const oldDdl = "CREATE TABLE orders (status VARCHAR(20) NOT NULL)";
    const newDdl = 'CREATE TABLE "orders" (status VARCHAR(50) NOT NULL)';
    const beforeTable = { ...sourceTable, columns: [{ ...sourceTable.columns[0], formattedType: "VARCHAR(20)" }] };
    const table = { ...sourceTable, columns: [{ ...sourceTable.columns[0], formattedType: "VARCHAR(50)" }] };
    const before: DatabaseSnapshot = { ...fixture.after, id: "sqlite-before", schemas: [{ ...fixture.after.schemas[0], tables: [beforeTable] }] };
    const after: DatabaseSnapshot = { ...before, id: "sqlite-after", schemas: [{ ...fixture.after.schemas[0], tables: [table] }] };
    const changeSet: SchemaChangeSet = { ...fixture.changeSet, beforeSnapshotId: before.id, afterSnapshotId: after.id, operations: [
      { operationType: "alterTable", object: table.key, risk: "medium", before: JSON.stringify({ definition: oldDdl, indexTerms: {} }), after: JSON.stringify({ definition: newDdl, indexTerms: {} }) },
      { operationType: "alterColumn", object: { kind: "column", name: "status", schema: "public.orders" }, risk: "medium", before: "VARCHAR(20) not null", after: "VARCHAR(50) not null" },
    ] };
    vi.spyOn(platform, "getSnapshot").mockResolvedValue(before);

    render(<QueryClientProvider client={new QueryClient()}><ModelTableChangeDetails change={{ key: table.key, status: "modified", operations: changeSet.operations }} changeSet={changeSet} snapshot={after} platform={platform} runtimeKind="desktop" /></QueryClientProvider>);

    expect(await screen.findByText("Data type")).toBeVisible();
    const change = within(screen.getByRole("listitem"));
    expect(change.getByText("VARCHAR(20)")).toBeVisible();
    expect(change.getByText("VARCHAR(50)")).toBeVisible();
    const disclosure = screen.getByText("View table definition change").closest("details")!;
    expect(disclosure).not.toHaveAttribute("open");
    expect(screen.getByText(oldDdl)).not.toBeVisible();
    fireEvent.click(screen.getByText("View table definition change"));
    expect(screen.getByText(oldDdl)).toBeVisible();
    expect(screen.getByText(newDdl)).toBeVisible();
    expect(screen.queryByText(/indexTerms/)).not.toBeInTheDocument();
  });

  it("opens the complete diff on request, preserves the diagram option and compares in reverse", async () => {
    const platform = getPlatform();
    vi.spyOn(platform, "getRuntimeInfo").mockResolvedValue({ kind: "desktop", label: "Desktop runtime", version: "test" });
    vi.spyOn(platform, "getSnapshot").mockImplementation((id) => Promise.resolve(id === "before" ? fixture.before : fixture.after));
    vi.spyOn(platform, "listRecentSnapshotIds").mockResolvedValue([fixture.after.id, fixture.before.id]);
    vi.spyOn(platform, "listSnapshots").mockResolvedValue([fixture.after, fixture.before].map((snapshot) => ({
      id: snapshot.id, sourceId: snapshot.sourceId, capturedAt: snapshot.capturedAt, fingerprint: snapshot.fingerprint,
      databaseName: "app", schemaCount: snapshot.schemas.length, tableCount: snapshot.schemas.length,
    })));
    const reversed: SchemaChangeSet = { ...fixture.changeSet, id: "reverse", beforeSnapshotId: "after", afterSnapshotId: "before",
      operations: [{ ...fixture.changeSet.operations[0], operationType: "dropTable", risk: "high", before: "1 columns", after: null }],
      riskSummary: { high: 1, medium: 0, low: 0, informational: 0 } };
    const compareSnapshots = vi.spyOn(platform, "compareSnapshots").mockResolvedValue(reversed);
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><App /></QueryClientProvider>);
    await screen.findByText("Desktop runtime");
    fireEvent.click(screen.getByRole("button", { name: "Capture fixture" }));
    fireEvent.click(screen.getByRole("button", { name: "Review changes" }));
    fireEvent.click(screen.getByRole("button", { name: "History comparison" }));
    expect(screen.getByRole("button", { name: "Model" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("region", { name: "Schema comparison" })).toBeVisible();
    expect(await screen.findByText("Order data")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Diagram" }));
    expect(screen.getByText("Diagram: after · forward")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    expect(screen.getByText("Diagram: after · no comparison")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Expand right inspector" }));
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    fireEvent.click(screen.getByRole("button", { name: "Review all changes" }));
    expect(screen.getByRole("region", { name: "Schema comparison" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Change list" })).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(await screen.findByRole("button", { name: "Swap direction" }));
    fireEvent.click(screen.getByRole("button", { name: "Compare versions" }));
    await waitFor(() => expect(compareSnapshots).toHaveBeenCalledWith("after", "before"));
    expect(await screen.findByText("After: Not present.")).toBeVisible();
    const context = screen.getByLabelText("Comparison direction");
    await waitFor(() => expect(within(context).getAllByText(/Fingerprint:/)[0]).toHaveTextContent("after-finger"));
    expect(within(screen.getByRole("article", { name: "Change details" })).getByRole("heading", { name: "Drop table" })).toBeVisible();
  });
});
