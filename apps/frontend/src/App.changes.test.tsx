import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CaptureSnapshotResult, DatabaseSnapshot, SchemaChangeSet, SemanticBundle } from "./platform";
import { getPlatform } from "./platform";
import { App } from "./App";

const fixture = vi.hoisted(() => {
  const before = { id: "before", sourceId: "source", capturedAt: "2026-10-12T00:00:00Z", fingerprint: "before-fingerprint",
    database: { name: "app", databaseType: "postgreSql" as const, version: "17" }, schemas: [] };
  const after = { ...before, id: "after", capturedAt: "2026-10-13T00:00:00Z", fingerprint: "after-fingerprint", schemas: [{ name: "public", views: [], enums: [], tables: [{
    key: { kind: "table" as const, schema: "public", name: "orders" }, tableKind: "ordinary" as const, columns: [], primaryKey: null, foreignKeys: [], indexes: [], constraints: [], comment: "Order data",
  }] }] };
  const changeSet = { id: "forward", beforeSnapshotId: "before", afterSnapshotId: "after", createdAt: after.capturedAt,
    operations: [{ operationType: "addTable" as const, object: { kind: "table", schema: "public", name: "orders" }, risk: "low" as const, before: null, after: "0 columns" }],
    riskSummary: { high: 0, medium: 0, low: 1, informational: 0 } };
  return { before, after, changeSet };
});

// Keep this an App wiring test: canvas layout and connection IO have their own tests.
vi.mock("./components/ConnectionPanel", () => ({ ConnectionPanel: ({ onSnapshot }: { onSnapshot: (result: CaptureSnapshotResult) => void }) =>
  <button type="button" onClick={() => onSnapshot({ snapshot: fixture.after, changeSet: fixture.changeSet, stored: true })}>Capture fixture</button> }));
vi.mock("./components/SchemaCanvas", () => ({ SchemaCanvas: ({ snapshot, changeSet }: { snapshot: DatabaseSnapshot; changeSet?: SchemaChangeSet }) =>
  <p>Diagram: {snapshot.id} · {changeSet?.id ?? "no comparison"}</p> }));

describe("App schema changes", () => {
  afterEach(() => vi.restoreAllMocks());

  it("exports the loaded snapshot independently of Diagram filters and waits for its saved semantics", async () => {
    const platform = getPlatform();
    vi.spyOn(platform, "getRuntimeInfo").mockResolvedValue({ kind: "desktop", label: "Desktop runtime", version: "test" });
    const semantics: SemanticBundle = { annotations: [{ sourceId: "source", objectKey: fixture.after.schemas[0].tables[0].key, description: "Saved order meaning", tags: [], owner: null, isCore: false, updatedAt: "2026-10-13T10:00:00Z" }], orphanedAnnotations: [], domainGroups: [], savedViews: [], layout: null, logicalRelationships: [], ignoredRelationshipInferences: [] };
    let finish!: (bundle: SemanticBundle) => void;
    vi.spyOn(platform, "getSemantics").mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const save = vi.spyOn(platform, "saveSchemaReport").mockResolvedValue({ path: "/Downloads/report.html" });
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><App /></QueryClientProvider>);
    await screen.findByText("Desktop runtime");
    expect(screen.queryByRole("button", { name: "Export HTML report" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Capture fixture" }));
    expect(screen.getByRole("button", { name: "Export HTML report" })).toBeDisabled();
    await act(() => Promise.resolve(finish(semantics)));
    fireEvent.change(screen.getByPlaceholderText("Table, field, schema…"), { target: { value: "non-matching-filter" } });
    fireEvent.click(screen.getByRole("button", { name: "Export HTML report" }));
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    const input = save.mock.calls[0][0];
    expect(input.html).toContain("public.orders");
    expect(input.html).toContain("after-fingerprint");
    expect(input.html).toContain("Saved order meaning");
    expect(input.html).not.toContain("non-matching-filter");
    expect(await screen.findByText(/Saved to \/Downloads\/report.html/)).toBeVisible();
  });

  it("opens the complete diff after capture, preserves the diagram option and compares in reverse", async () => {
    const platform = getPlatform();
    vi.spyOn(platform, "getRuntimeInfo").mockResolvedValue({ kind: "desktop", label: "Desktop runtime", version: "test" });
    vi.spyOn(platform, "getSnapshot").mockImplementation((id) => Promise.resolve(id === "before" ? fixture.before : fixture.after));
    vi.spyOn(platform, "listSnapshots").mockResolvedValue([fixture.after, fixture.before].map((snapshot) => ({
      id: snapshot.id, sourceId: snapshot.sourceId, capturedAt: snapshot.capturedAt, fingerprint: snapshot.fingerprint,
      databaseName: "app", schemaCount: snapshot.schemas.length, tableCount: snapshot.schemas.length,
    })));
    const reversed: SchemaChangeSet = { ...fixture.changeSet, id: "reverse", beforeSnapshotId: "after", afterSnapshotId: "before",
      operations: [{ ...fixture.changeSet.operations[0], operationType: "dropTable", risk: "high", before: "0 columns", after: null }],
      riskSummary: { high: 1, medium: 0, low: 0, informational: 0 } };
    const compareSnapshots = vi.spyOn(platform, "compareSnapshots").mockResolvedValue(reversed);
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><App /></QueryClientProvider>);
    await screen.findByText("Desktop runtime");
    fireEvent.click(screen.getByRole("button", { name: "Capture fixture" }));
    expect(screen.getByRole("region", { name: "Schema comparison" })).toBeVisible();
    expect(await screen.findByText("Order data")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Diagram" }));
    expect(screen.getByText("Diagram: after · forward")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Database" }));
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
