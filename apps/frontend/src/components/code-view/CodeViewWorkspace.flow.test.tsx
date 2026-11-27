import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { NodalStudioPlatform, ObjectKey, SnapshotSummary } from "../../platform";
import type { CodeQueryHandoff, CodeViewPlatform, ProjectFile, ProjectPage } from "../../platform/code-view";
import { reportSnapshot } from "../../test/schema-report-fixture";
import { CodeViewWorkspace } from "./CodeViewWorkspace";

beforeAll(() => {
  Object.defineProperty(Range.prototype, "getClientRects", { configurable: true, value: () => [] });
  Object.defineProperty(Range.prototype, "getBoundingClientRect", { configurable: true, value: () => new DOMRect() });
});

afterAll(() => {
  Reflect.deleteProperty(Range.prototype, "getClientRects");
  Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
});

const snapshot = {
  ...reportSnapshot,
  database: { name: "commerce", databaseType: "mySql" as const, version: "8.4" },
};
const paymentTime: ObjectKey = { kind: "column", schema: "commerce.payments", name: "paid_at" };
const payments: ObjectKey = { kind: "table", schema: "commerce", name: "payments" };
const baseline: SnapshotSummary = {
  id: "before-payment-rename",
  sourceId: snapshot.sourceId,
  capturedAt: "2026-10-12T08:00:00Z",
  fingerprint: "before-rename",
  databaseName: snapshot.database.name,
  schemaCount: 1,
  tableCount: 2,
};
const sql = "SELECT paid_at FROM payments";
const queryFile: ProjectFile = {
  path: "queries/paid_orders.sql",
  contents: sql,
  statements: [{ start: 0, end: sql.length, line: 1, digest: "paid-orders-statement", kind: "query",
    references: [paymentTime], changes: [], diagnostics: [], openQuery: true }],
  diagnostic: null,
  ontology: { 0: [{ id: "paid-orders", name: "Paid orders", revision: 3, evidence: "field", stale: false }] },
};
const migrationSql = "ALTER TABLE payments RENAME COLUMN paid_at TO completed_at";
const migrationFile: ProjectFile = {
  path: "migrations/002_rename.sql",
  contents: migrationSql,
  statements: [{ start: 0, end: migrationSql.length, line: 1, digest: "rename-statement", kind: "migration",
    references: [payments], changes: [{ table: payments, action: "rename", before: "paid_at", after: "completed_at" }],
    diagnostics: [], openQuery: false }],
  diagnostic: null,
  ontology: {},
};

function resultFor(file: ProjectFile): ProjectPage {
  return {
    project: {
      id: "commerce-binding", name: "commerce-code", directories: ["queries", "migrations"],
      database: snapshot.database.name, connectionName: "Commerce Local", snapshotId: snapshot.id, snapshotAt: snapshot.capturedAt,
    },
    scan: {
      version: "scan-version", generation: "scan-generation", at: snapshot.capturedAt,
      git: { branch: "main", commit: "fixture-commit" }, skipped: 0, diagnosticCount: 0, fileCount: 1, totalMatching: 1,
      files: [{ path: file.path, diagnostic: null, matches: [{ line: 1, start: 0 }] }],
    },
    scanning: false,
    stale: false,
  };
}

function renderWorkspace(operations: Partial<CodeViewPlatform>, initialObject?: ObjectKey) {
  const platform = {
    codeView: operations,
    listSnapshots: () => Promise.resolve([baseline]),
    listOntology: () => Promise.resolve([]),
  } as unknown as NodalStudioPlatform;
  const onLocate = vi.fn();
  const onOntology = vi.fn();
  const onQuery = vi.fn();
  const onPosition = vi.fn();
  render(<QueryClientProvider client={new QueryClient()}>
    <CodeViewWorkspace platform={platform} snapshot={snapshot} initialObject={initialObject}
      onPosition={onPosition} onLocate={onLocate} onOntology={onOntology} onQuery={onQuery} onReturn={vi.fn()} />
  </QueryClientProvider>);
  return { onLocate, onOntology, onQuery, onPosition };
}

it("previews the first scanned file and keeps the selected filename visible while retrying a read", async () => {
  const result = resultFor(queryFile);
  result.scan!.files.push(...Array.from({ length: 60 }, (_, index) => ({
    path: `migrations/${index}_a_long_migration_name_for_the_file_list.sql`, diagnostic: null, matches: [],
  })));
  const remaining = result.scan!.files.at(-1)!;
  const file = vi.fn<CodeViewPlatform["file"]>().mockImplementation((selection) => {
    if (selection.path === queryFile.path) return Promise.resolve(queryFile);
    return Promise.reject(new Error("The file changed on disk."));
  });
  renderWorkspace({ get: () => Promise.resolve(result), file });

  const files = within(await screen.findByRole("complementary", { name: "SQL files" }));
  expect(files.getByRole("button", { name: queryFile.path })).toHaveAttribute("aria-current", "true");
  expect(await screen.findByRole("button", { name: "Open in Query" })).toBeVisible();

  fireEvent.click(files.getByRole("button", { name: remaining.path }));
  expect(screen.getByRole("heading", { name: remaining.path })).toBeVisible();
  expect(await screen.findByRole("alert")).toHaveTextContent("The file changed on disk.");
  file.mockResolvedValueOnce({ path: remaining.path, contents: "-- comment only", statements: [], diagnostic: null, ontology: {} });
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByText(/No statements in it could be analyzed/)).toBeVisible();
  expect(screen.getByText("-- comment only")).toBeVisible();
});

it("opens a field's matching code and hands its exact statement and target to Query", async () => {
  const handoff: CodeQueryHandoff = {
    sourceId: snapshot.sourceId, bindingId: "commerce-binding", database: "commerce",
    connection: "connection-digest", profileRevision: snapshot.capturedAt, snapshotId: snapshot.id,
    path: queryFile.path, statementDigest: queryFile.statements[0].digest,
  };
  const get = vi.fn<CodeViewPlatform["get"]>().mockResolvedValue(resultFor(queryFile));
  const query = vi.fn<CodeViewPlatform["query"]>().mockResolvedValue([sql, handoff]);
  const { onLocate, onOntology, onQuery } = renderWorkspace({
    get, query, file: () => Promise.resolve(queryFile),
  }, paymentTime);

  fireEvent.click(await screen.findByRole("button", { name: /queries\/paid_orders\.sql/ }));
  expect(get).toHaveBeenCalledWith(expect.objectContaining({ sourceId: snapshot.sourceId, object: paymentTime }));
  fireEvent.click(await screen.findByRole("button", { name: "commerce.payments.paid_at" }));
  expect(onLocate).toHaveBeenCalledWith(paymentTime);
  fireEvent.click(screen.getByRole("button", { name: "Paid orders" }));
  expect(onOntology).toHaveBeenCalledWith("paid-orders");
  fireEvent.click(screen.getByRole("button", { name: "Open in Query" }));
  await waitFor(() => expect(onQuery).toHaveBeenCalledWith(sql, handoff));
  expect(query).toHaveBeenCalledWith({
    sourceId: snapshot.sourceId, bindingId: "commerce-binding", path: queryFile.path,
    indexVersion: "scan-version", start: 0, digest: queryFile.statements[0].digest,
  });
});

it("names the external database of a migration and keeps the SQL preview available", async () => {
  const externalMigration = {
    ...migrationFile,
    statements: [{ ...migrationFile.statements[0], diagnostics: ["outsideDatabase" as const],
      outsideDatabases: ["peer"], references: [], changes: [] }],
  };
  const impact = vi.fn();
  renderWorkspace({ get: () => Promise.resolve(resultFor(externalMigration)), file: () => Promise.resolve(externalMigration), impact });

  expect(await screen.findByText(/This statement references peer\. The selected database is commerce/)).toBeVisible();
  expect(screen.getByRole("textbox", { name: "Read-only object definition" })).toBeVisible();
  expect(screen.queryByRole("heading", { name: "Migration impact" })).not.toBeInTheDocument();
  expect(impact).not.toHaveBeenCalled();
});

it("shows missing migration evidence and requests the selected older snapshot for impact", async () => {
  const impact = vi.fn<CodeViewPlatform["impact"]>().mockImplementation((_statement, baselineId) => Promise.resolve({
    baselineId: baselineId ?? snapshot.id, baselineAt: baselineId ? baseline.capturedAt : snapshot.capturedAt,
    currentAt: snapshot.capturedAt, scanAt: snapshot.capturedAt, missingBaseline: !baselineId, partial: false,
    changes: migrationFile.statements[0].changes, files: baselineId ? resultFor(queryFile).scan!.files : [], ontology: [],
  }));
  const { onPosition } = renderWorkspace({
    get: () => Promise.resolve(resultFor(migrationFile)), impact,
    file: (selection) => Promise.resolve(selection.path === migrationFile.path ? migrationFile : queryFile),
  });
  fireEvent.click(await screen.findByRole("button", { name: migrationFile.path }));
  expect(await screen.findByText(/Impact cannot be determined/)).toBeVisible();
  await waitFor(() => expect(screen.getByRole("combobox", { name: "Comparison snapshot" })).toHaveValue(""));
  fireEvent.change(screen.getByRole("combobox", { name: "Comparison snapshot" }), { target: { value: baseline.id } });
  const dependent = await screen.findByRole("button", { name: queryFile.path });
  expect(impact).toHaveBeenLastCalledWith(expect.objectContaining({ path: migrationFile.path }), baseline.id);
  expect(screen.queryByText(/Impact cannot be determined/)).toBeNull();
  fireEvent.click(dependent);
  expect(onPosition).toHaveBeenLastCalledWith({ path: queryFile.path, start: 0 });
});
