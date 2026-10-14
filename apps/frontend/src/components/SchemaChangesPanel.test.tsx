import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DatabaseSnapshot, NodalStudioPlatform, SchemaChangeSet, SchemaOperation, TableDefinition } from "../platform";
import type { ColumnDefinition } from "../platform/types";
import { SchemaChangesPanel } from "./SchemaChangesPanel";

const column: ColumnDefinition = {
  name: "status", ordinalPosition: 1, formattedType: "text", typeSchema: "pg_catalog",
  typeName: "text", nullable: false, defaultValue: "'pending'::text", identity: null,
  generated: false, comment: "Original comment",
};
const table: TableDefinition = {
  key: { kind: "table", schema: "public", name: "orders" }, tableKind: "ordinary",
  columns: [column], primaryKey: null, foreignKeys: [], indexes: [], constraints: [], comment: null,
};
const before: DatabaseSnapshot = {
  id: "before", sourceId: "source", capturedAt: "2026-07-11T09:00:00Z", fingerprint: "before-fingerprint",
  database: { name: "app", databaseType: "postgreSql", version: "17" },
  schemas: [{ name: "public", tables: [table], views: [], enums: [] }],
};
const after: DatabaseSnapshot = {
  ...before, id: "after", capturedAt: "2026-07-11T10:00:00Z", fingerprint: "after-fingerprint",
  schemas: [{ ...before.schemas[0], tables: [{ ...table, columns: [{ ...column, defaultValue: "'ready'::text", comment: "Updated comment" }] }] }],
};
const operation: SchemaOperation = {
  operationType: "alterColumn", object: { kind: "column", schema: "public.orders", name: "status" },
  risk: "medium", before: "text not null", after: "text not null",
};
function changes(operations: SchemaOperation[] = [operation]): SchemaChangeSet {
  return { id: "changes", beforeSnapshotId: "before", afterSnapshotId: "after", createdAt: after.capturedAt,
    operations, riskSummary: { high: 0, medium: operations.length, low: 0, informational: 0 } };
}
function mount(options: { before?: DatabaseSnapshot; after?: DatabaseSnapshot; changeSet?: SchemaChangeSet; web?: boolean; getSnapshot?: NodalStudioPlatform["getSnapshot"] } = {}) {
  const getSnapshot = options.getSnapshot ?? vi.fn().mockResolvedValue(options.before ?? before);
  const platform = { getSnapshot } as unknown as NodalStudioPlatform;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const props = { changeSet: options.changeSet ?? changes(), currentSnapshot: options.after ?? after, platform, runtimeKind: options.web ? "web" as const : "desktop" as const };
  return { ...render(<QueryClientProvider client={client}><SchemaChangesPanel {...props} /></QueryClientProvider>), getSnapshot, client, props };
}

describe("SchemaChangesPanel", () => {
  it("reveals defaults and comments that the identical operation summaries omit", async () => {
    const { getSnapshot } = mount();
    const properties = await screen.findByRole("table", { name: "Before and after properties" });
    expect(await within(properties).findByText("'pending'::text")).toBeVisible();
    expect(within(properties).getByText("'ready'::text")).toBeVisible();
    expect(within(properties).getByText("Original comment")).toBeVisible();
    expect(within(properties).getByText("Updated comment")).toBeVisible();
    expect(within(properties).queryByText("Data type")).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Show unchanged properties"));
    expect(within(properties).getByText("Data type")).toBeVisible();
    expect(getSnapshot).toHaveBeenCalledExactlyOnceWith("before");
    expect(within(screen.getByLabelText("Comparison direction")).getByText("before")).toBeVisible();
    expect(within(screen.getByLabelText("Comparison direction")).getByText("after")).toBeVisible();
  });

  it("makes every change reachable beyond the old 30-item limit and across pages", async () => {
    const operations = Array.from({ length: 75 }, (_, index): SchemaOperation => ({
      ...operation, operationType: index === 74 ? "dropColumn" : "addColumn",
      object: { ...operation.object, name: `field_${index}` }, risk: index === 74 ? "high" : "low",
      before: index === 74 ? "text not null" : null, after: index === 74 ? null : "text not null",
    }));
    mount({ changeSet: changes(operations) });
    const list = () => screen.getByRole("list", { name: "All schema changes" });
    expect(within(list()).getAllByRole("button")).toHaveLength(50);
    expect(within(list()).getByText("public.orders.field_40")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(within(list()).getAllByRole("button")).toHaveLength(25);
    fireEvent.click(within(list()).getByRole("button", { name: /field_74/ }));
    expect(within(screen.getByRole("article", { name: "Change details" })).getByText("public.orders.field_74")).toBeVisible();
    fireEvent.change(screen.getByLabelText("Search changes"), { target: { value: "field_74" } });
    expect(within(list()).getAllByRole("button")).toHaveLength(1);
    expect(screen.getByText("Showing 1–1 of 1 changes (75 total)")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    fireEvent.change(screen.getByLabelText("Risk"), { target: { value: "high" } });
    expect(within(list()).getAllByRole("button")).toHaveLength(1);
    fireEvent.change(screen.getByLabelText("Operation"), { target: { value: "addColumn" } });
    expect(screen.getByText("No changes match these filters.")).toBeVisible();
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("Loading snapshot…")).not.toBeInTheDocument());
  });

  it("shows removed-object properties and distinguishes absence from an unavailable snapshot", async () => {
    const deleted = { ...operation, operationType: "dropColumn" as const, after: null };
    mount({ changeSet: changes([deleted]), after: { ...after, schemas: [{ ...after.schemas[0], tables: [{ ...table, columns: [] }] }] } });
    expect(await screen.findByText("'pending'::text")).toBeVisible();
    expect(screen.getByText("After: Not present.")).toBeVisible();
    expect(screen.queryByText(/Snapshot unavailable/)).not.toBeInTheDocument();
  });

  it("keeps actual before and after definitions for same-name drop/add replacements", async () => {
    const oldIndex = { name: "orders_idx", columns: ["status"], method: "btree", unique: false, primary: false, predicate: null };
    const beforeIndex = { ...before, schemas: [{ ...before.schemas[0], tables: [{ ...table, indexes: [oldIndex] }] }] };
    const afterIndex = { ...after, schemas: [{ ...after.schemas[0], tables: [{ ...table, indexes: [{ ...oldIndex, unique: true }] }] }] };
    mount({ before: beforeIndex, after: afterIndex, changeSet: changes([
      { ...operation, operationType: "dropIndex", object: { kind: "index", schema: "public.orders", name: "orders_idx" }, after: null },
      { ...operation, operationType: "addIndex", object: { kind: "index", schema: "public.orders", name: "orders_idx" }, before: null },
    ]) });
    const unique = await screen.findByRole("row", { name: /Unique Changed No Yes/ });
    expect(unique).toBeVisible();
    expect(screen.getByText(/replacement is recorded as separate drop and add operations/)).toBeVisible();
    expect(screen.queryByText("After: Not present.")).not.toBeInTheDocument();
  });

  it("uses summaries when a web share does not include historical properties", () => {
    const { getSnapshot } = mount({ web: true });
    expect(screen.getByText(/This share includes one snapshot/)).toBeVisible();
    expect(screen.getByText(/Before: Snapshot unavailable/)).toBeVisible();
    expect(screen.getByText("'ready'::text")).toBeVisible();
    expect(screen.getAllByText("text not null")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: /Retry/ })).not.toBeInTheDocument();
    expect(getSnapshot).not.toHaveBeenCalled();
  });

  it("reports and retries a history load failure without presenting missing values as deletions", async () => {
    const getSnapshot = vi.fn<NodalStudioPlatform["getSnapshot"]>().mockRejectedValueOnce(new Error("History was pruned")).mockResolvedValueOnce(before);
    mount({ getSnapshot });
    expect(await screen.findByText("History was pruned")).toBeVisible();
    expect(screen.getByText(/Before: Snapshot unavailable/)).toBeVisible();
    expect(screen.queryByText("Before: Not present.")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry before snapshot" }));
    expect(await screen.findByText("'pending'::text")).toBeVisible();
    expect(getSnapshot).toHaveBeenCalledTimes(2);
  });

  it("labels inferred renames and resolves identifiers containing dots and colons", async () => {
    const key = { kind: "table" as const, schema: "tenant.eu", name: "order.items" };
    const oldColumn = { ...column, name: "old: name" };
    const newColumn = { ...column, name: "new: name" };
    const oldSnapshot = { ...before, schemas: [{ ...before.schemas[0], name: key.schema, tables: [{ ...table, key, columns: [oldColumn] }] }] };
    const newSnapshot = { ...after, schemas: [{ ...after.schemas[0], name: key.schema, tables: [{ ...table, key, columns: [newColumn] }] }] };
    mount({ before: oldSnapshot, after: newSnapshot, changeSet: changes([{ ...operation,
      operationType: "renameColumn", object: { kind: "column", schema: "tenant.eu.order.items", name: oldColumn.name },
      before: "old: name: text not null", after: "new: name: text not null",
    }]) });
    expect(screen.getByText(/Inferred rename:/)).toBeVisible();
    const row = await screen.findByRole("row", { name: /Name Changed old: name new: name/ });
    expect(row).toBeVisible();
  });

  it("does not let a late history response overwrite a newer comparison", async () => {
    let complete!: (snapshot: DatabaseSnapshot) => void;
    const getSnapshot = vi.fn<NodalStudioPlatform["getSnapshot"]>().mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; })).mockResolvedValueOnce({ ...before, id: "other-before", schemas: [{ ...before.schemas[0], tables: [{ ...table, columns: [{ ...column, comment: "Other baseline" }] }] }] });
    const { rerender, client, props } = mount({ getSnapshot });
    rerender(<QueryClientProvider client={client}><SchemaChangesPanel {...props} changeSet={{ ...changes(), id: "other", beforeSnapshotId: "other-before" }} /></QueryClientProvider>);
    expect(await screen.findByText("Other baseline")).toBeVisible();
    complete(before);
    await waitFor(() => expect(screen.queryByText("Original comment")).not.toBeInTheDocument());
    expect(screen.getByText("Other baseline")).toBeVisible();
  });

  it("explains an empty comparison", () => {
    mount({ changeSet: changes([]) });
    expect(screen.getByText("No structural changes between these snapshots.")).toBeVisible();
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
  });

  it("shows properties in the selected direction when comparing back to an older snapshot", async () => {
    mount({ after: before, getSnapshot: vi.fn().mockResolvedValue(after),
      changeSet: { ...changes(), beforeSnapshotId: "after", afterSnapshotId: "before" } });
    const row = await screen.findByRole("row", { name: /Default value Changed 'ready'::text 'pending'::text/ });
    const cells = within(row).getAllByRole("cell");
    expect(cells[0]).toHaveTextContent("'ready'::text");
    expect(cells[1]).toHaveTextContent("'pending'::text");
  });
});
