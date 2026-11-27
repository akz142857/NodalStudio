import { EditorView } from "@codemirror/view";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSnapshot, QueryExecutionResult, QueryHistoryEntry, NodalStudioPlatform } from "../../platform";
import type { CodeQueryHandoff } from "../../platform/code-view";
import type { ConfirmedDefinition, OntologyQueryDraft } from "../../platform/ontology-types";
import { discoverySettings } from "../../test/discovery-fixture";
import { reportSemantics, reportSnapshot } from "../../test/schema-report-fixture";
import { clearQuerySessions, legacyQueryWorkspaceKey, loadQuerySession, queryWorkspaceKey, saveQuerySession, unboundQueryWorkspaceKey } from "./query-state";
import { QueryPage } from "./QueryPage";
import { usesAppleKeyboard } from "../command-shortcuts";

const snapshot: DatabaseSnapshot = {
  id: "snapshot",
  sourceId: "11111111-1111-4111-8111-111111111111",
  capturedAt: "2026-07-12T00:00:00Z",
  fingerprint: "fingerprint",
  database: { name: "app", databaseType: "postgreSql", version: "17" },
  schemas: [{ name: "public", tables: [], views: [], enums: [] }],
};

const result: QueryExecutionResult = {
  queryId: "query",
  columns: [{ name: "value", databaseType: "int4" }],
  rows: [[{ kind: "number", value: 1 }]],
  rowCount: 1,
  durationMs: 3,
  truncated: false,
  notices: [],
};
const reportWorkspace = queryWorkspaceKey(reportSnapshot.sourceId);

describe("QueryPage", () => {
  beforeEach(() => clearQuerySessions());
  it("uses confirmed paid-order SQL for a matching question and preserves the editable draft", async () => {
    const [orders, payments] = reportSnapshot.schemas[0].tables;
    const entry: ConfirmedDefinition = {
      id: "paid", revision: 2, confirmedSnapshotId: reportSnapshot.id, impacts: [],
      definition: {
        name: "已付款订单", timeZone: "Asia/Singapore",
        order: { name: "Order", table: orders.key, idColumn: "id" },
        payment: { name: "Payment", table: payments.key, orderIdColumn: "order_id", statusColumn: "status", successValue: "paid", paidAtColumn: "completed_at" },
      },
    };
    const draft: OntologyQueryDraft = {
      sourceId: reportSnapshot.sourceId, snapshotId: reportSnapshot.id, revision: entry.revision,
      definitionName: entry.definition.name, timeZone: entry.definition.timeZone,
      startsAt: "2026-10-01T00:00:00+08:00", endsBefore: "2026-11-01T00:00:00+08:00",
      sql: "SELECT order_id FROM payments WHERE completed_at IS NOT NULL;",
    };
    const draftOntologyLastMonth = vi.fn<NodalStudioPlatform["draftOntologyLastMonth"]>().mockResolvedValue(draft);
    const prepareDiscovery = vi.fn();
    const executeReadonlyQuery = vi.fn();
    const platform = {
      listQueryHistory: vi.fn().mockResolvedValue([]),
      listRecentSnapshotIds: vi.fn().mockResolvedValue([reportSnapshot.id]),
      draftOntologyLastMonth, prepareDiscovery, executeReadonlyQuery,
    } as unknown as NodalStudioPlatform;
    saveQuerySession(reportWorkspace, { ...loadQuerySession(reportWorkspace), draft: "SELECT 7;" });
    const { container } = render(<QueryPage snapshot={reportSnapshot} platform={platform} runtimeKind="desktop"
      settings={discoverySettings()} semantics={reportSemantics}
      ontology={{ entries: [entry], loading: false, review: vi.fn(), reload: vi.fn() }} />);
    fireEvent.click(screen.getByRole("tab", { name: "Draft query" }));
    fireEvent.change(screen.getByLabelText("Question"), { target: { value: "列出上月已付款订单。" } });
    fireEvent.click(screen.getByRole("button", { name: "Create SQL draft" }));
    const sheet = screen.getByRole("dialog", { name: "Use a business definition" });
    fireEvent.click(within(sheet).getByRole("button", { name: "Preview SQL" }));
    expect(await within(sheet).findByText(draft.sql)).toBeVisible();
    expect(draftOntologyLastMonth).toHaveBeenCalledWith({
      scope: { sourceId: draft.sourceId, snapshotId: draft.snapshotId }, target: { id: entry.id, revision: entry.revision },
    });
    draftOntologyLastMonth.mockRejectedValueOnce(new Error("Review the updated definition before generating SQL."));
    fireEvent.click(within(sheet).getByRole("button", { name: "Open in SQL Editor" }));
    expect(await within(sheet).findByRole("alert")).toHaveTextContent("Review the updated definition");
    expect(loadQuerySession(reportWorkspace).draft).toBe("SELECT 7;");
    fireEvent.click(within(sheet).getByRole("button", { name: "Preview SQL" }));
    await within(sheet).findByText(draft.sql);
    fireEvent.click(within(sheet).getByRole("button", { name: "Open in SQL Editor" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(EditorView.findFromDOM(container.querySelector<HTMLElement>(".cm-editor")!)?.state.doc.toString()).toBe(draft.sql);
    expect(loadQuerySession(reportWorkspace).previousDraft?.sql).toBe("SELECT 7;");
    expect(draftOntologyLastMonth).toHaveBeenCalledTimes(4);
    expect(prepareDiscovery).not.toHaveBeenCalled();
    expect(executeReadonlyQuery).not.toHaveBeenCalled();
  });
  it("revalidates a preview opened from Ontology and asks for confirmation when the month has changed", async () => {
    const [order, payment] = reportSnapshot.schemas[0].tables;
    const entry: ConfirmedDefinition = {
      id: "paid", revision: 1, confirmedSnapshotId: reportSnapshot.id, impacts: [],
      definition: { name: "Paid orders", timeZone: "UTC", order: { name: "Order", table: order.key, idColumn: "id" },
        payment: { name: "Payment", table: payment.key, orderIdColumn: "order_id", statusColumn: "status", successValue: "paid", paidAtColumn: "paid_at" } },
    };
    const original: OntologyQueryDraft = {
      sourceId: reportSnapshot.sourceId, snapshotId: reportSnapshot.id, revision: 1, definitionName: "Paid orders", timeZone: "UTC",
      startsAt: "2026-10-01T00:00:00Z", endsBefore: "2026-11-01T00:00:00Z", sql: "SELECT 'October';",
    };
    const updated = { ...original, startsAt: original.endsBefore, endsBefore: "2026-12-01T00:00:00Z", sql: "SELECT 'November';" };
    const draftOntologyLastMonth = vi.fn<NodalStudioPlatform["draftOntologyLastMonth"]>().mockResolvedValue(updated);
    const onConsumeOpenRequest = vi.fn();
    const api = { listQueryHistory: vi.fn().mockResolvedValue([]), draftOntologyLastMonth } as unknown as NodalStudioPlatform;
    const target = { id: entry.id, revision: entry.revision };
    saveQuerySession(reportWorkspace, { ...loadQuerySession(reportWorkspace), draft: "SELECT 7;" });
    render(<QueryPage snapshot={reportSnapshot} platform={api} runtimeKind="desktop" onConsumeOpenRequest={onConsumeOpenRequest}
      openRequest={{ id: 1, kind: "ontology", sourceId: original.sourceId, sql: original.sql, ontology: { target, draft: original } }}
      ontology={{ entries: [entry], loading: false, review: vi.fn(), reload: vi.fn() }} />);
    const sheet = screen.getByRole("dialog", { name: "Use a business definition" });
    expect(within(sheet).getByText(original.sql)).toBeVisible();
    fireEvent.click(within(sheet).getByRole("button", { name: "Open in SQL Editor" }));
    expect(await within(sheet).findByText(updated.sql)).toBeVisible();
    expect(draftOntologyLastMonth).toHaveBeenCalledWith({ scope: { sourceId: original.sourceId, snapshotId: original.snapshotId }, target });
    expect(onConsumeOpenRequest).not.toHaveBeenCalled();
    expect(loadQuerySession(reportWorkspace).draft).toBe("SELECT 7;");
    fireEvent.click(within(sheet).getByRole("button", { name: "Open in SQL Editor" }));
    await waitFor(() => expect(onConsumeOpenRequest).toHaveBeenCalledOnce());
    expect(loadQuerySession(reportWorkspace).draft).toBe(updated.sql);
  });
  it("keeps a project query tied to its source when sources or snapshots change", async () => {
    const mysql = { ...snapshot, database: { ...snapshot.database, databaseType: "mySql" as const } };
    const other = { ...mysql, sourceId: "other-source", database: { ...mysql.database, name: "other" } };
    const sourceKey = queryWorkspaceKey(mysql.sourceId);
    const otherKey = queryWorkspaceKey(other.sourceId);
    const sql = "SELECT id FROM orders";
    const handoff: CodeQueryHandoff = {
      sourceId: mysql.sourceId, snapshotId: mysql.id, database: mysql.database.name,
      bindingId: "binding", path: "queries/orders.sql", statementDigest: "statement",
      connection: "target", profileRevision: mysql.capturedAt,
    };
    const executeReadonlyQuery = vi.fn<NodalStudioPlatform["executeReadonlyQuery"]>().mockResolvedValue(result);
    const platform = { executeReadonlyQuery, listQueryHistory: vi.fn().mockResolvedValue([]) } as unknown as NodalStudioPlatform;
    const onConsumeOpenRequest = vi.fn();
    saveQuerySession(sourceKey, { ...loadQuerySession(sourceKey), draft: "SELECT 2" });
    saveQuerySession(otherKey, { ...loadQuerySession(otherKey), draft: "SELECT 3" });
    const page = (selected: DatabaseSnapshot, opening = false) => <QueryPage
      platform={platform} snapshot={selected} runtimeKind="desktop" onConsumeOpenRequest={onConsumeOpenRequest}
      openRequest={opening ? { id: 1, kind: "project", sourceId: mysql.sourceId, projectHandoff: handoff, sql } : undefined} />;
    const view = render(page(mysql, true));
    const dialog = screen.getByRole("dialog", { name: "Open project query" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Open" }));
    expect(onConsumeOpenRequest).toHaveBeenCalledOnce();
    view.rerender(page(mysql));
    expect(loadQuerySession(sourceKey)).toMatchObject({ draft: sql, previousDraft: { sql: "SELECT 2" } });
    expect(executeReadonlyQuery).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /^Run/ }));
    await waitFor(() => expect(executeReadonlyQuery).toHaveBeenCalledWith(expect.objectContaining({ sql, projectHandoff: handoff })));

    view.rerender(page(other));
    expect(loadQuerySession(otherKey).draft).toBe("SELECT 3");
    expect(loadQuerySession(sourceKey).origin).toMatchObject({ kind: "project", handoff });
    view.rerender(page({ ...mysql, id: "refreshed-snapshot" }));
    fireEvent.click(screen.getByRole("button", { name: /^Run/ }));
    expect(await screen.findByText(/needs a verified database target/)).toBeVisible();
    expect(executeReadonlyQuery).toHaveBeenCalledTimes(1);
  });
  it.each([false, true])("runs MySQL cursor statements and discards a late result after changing sources (return to original: %s)", async (returnToOriginal) => {
    let finish!: (value: QueryExecutionResult) => void;
    const executeReadonlyQuery = vi.fn<NodalStudioPlatform["executeReadonlyQuery"]>().mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const cancelQuery = vi.fn().mockResolvedValue(true);
    const api = { executeReadonlyQuery, cancelQuery, listQueryHistory: vi.fn().mockResolvedValue([]) } as unknown as NodalStudioPlatform;
    const mysql = { ...snapshot, database: { ...snapshot.database, databaseType: "mySql" as const } };
    const { container, rerender } = render(<QueryPage platform={api} snapshot={mysql} runtimeKind="desktop" />);
    const editor = container.querySelector<HTMLElement>(".cm-editor")!;
    const view = EditorView.findFromDOM(editor)!;
    const sql = "SELECT `semi;colon` FROM `orders`;\nSELECT 9;";
    act(() => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: sql }, selection: { anchor: sql.indexOf("9") } }));
    fireEvent.keyDown(editor, { key: "R", metaKey: true, shiftKey: true });
    await waitFor(() => expect(executeReadonlyQuery).toHaveBeenCalledWith(expect.objectContaining({ sourceId: snapshot.sourceId, sql: "SELECT 9;" })));
    rerender(<QueryPage platform={api} snapshot={{ ...snapshot, sourceId: "other-source" }} runtimeKind="desktop" />);
    expect(screen.getByRole("textbox", { name: "SQL editor" })).not.toHaveTextContent("SELECT 9;");
    expect(cancelQuery).toHaveBeenCalledWith(executeReadonlyQuery.mock.calls[0][0].queryId);
    if (returnToOriginal) rerender(<QueryPage platform={api} snapshot={mysql} runtimeKind="desktop" />);
    await act(async () => { finish(result); await Promise.resolve(); });
    expect(screen.queryByRole("region", { name: "Query results" })).not.toBeInTheDocument();
    expect(screen.getByText(/Database changed/)).toBeVisible();
    expect(screen.getByRole("textbox", { name: "SQL editor" }).textContent?.includes("SELECT 9;")).toBe(returnToOriginal);
  });
  it("keeps each database's draft and suppresses another database's output on remount", () => {
    const sessionKey = queryWorkspaceKey(snapshot.sourceId);
    saveQuerySession(sessionKey, { ...loadQuerySession(sessionKey), outputSourceId: snapshot.sourceId,
      draft: "SELECT 42;", message: "Output from the previous connection", result, outcome: "succeeded", rowLimit: 500 });
    const api = { listQueryHistory: vi.fn().mockResolvedValue([]) } as unknown as NodalStudioPlatform;
    const nextSnapshot = { ...snapshot, sourceId: "other-source" };
    const { container, rerender } = render(<QueryPage platform={api} snapshot={nextSnapshot} runtimeKind="desktop" />);
    expect(screen.queryByText("Output from the previous connection")).not.toBeInTheDocument();
    expect(loadQuerySession(sessionKey)).toMatchObject({ outputSourceId: snapshot.sourceId, draft: "SELECT 42;", rowLimit: 500 });
    expect(EditorView.findFromDOM(container.querySelector<HTMLElement>(".cm-editor")!)?.state.doc.toString()).toBe("");
    rerender(<QueryPage platform={api} snapshot={snapshot} runtimeKind="desktop" />);
    expect(EditorView.findFromDOM(container.querySelector<HTMLElement>(".cm-editor")!)?.state.doc.toString()).toBe("SELECT 42;");
  });

  it("keeps the save shortcut in the visible Query workspace", () => {
    const workspace = queryWorkspaceKey(snapshot.sourceId);
    saveQuerySession(workspace, { ...loadQuerySession(workspace), draft: "SELECT 12;", savedQuery: { id: "saved", name: "Example" } });
    const platform = { listQueryHistory: vi.fn().mockResolvedValue([]) } as unknown as NodalStudioPlatform;
    const onSaveQuery = vi.fn().mockReturnValue({ query: { id: "saved", name: "Example", sql: "SELECT 12;" } });
    const page = <QueryPage platform={platform} snapshot={snapshot} runtimeKind="desktop" onSaveQuery={onSaveQuery} />;
    const { rerender } = render(<div inert>{page}</div>);
    const shortcut = { key: "s", metaKey: usesAppleKeyboard(), ctrlKey: !usesAppleKeyboard() };
    expect(fireEvent.keyDown(document.body, shortcut)).toBe(true);
    expect(onSaveQuery).not.toHaveBeenCalled();
    rerender(<div>{page}</div>);
    expect(fireEvent.keyDown(document.body, shortcut)).toBe(false);
    expect(onSaveQuery).toHaveBeenCalledWith("Example", "SELECT 12;", "saved");
  });

  it("keeps the current history when a clear in another database finishes late", async () => {
    const next = { ...snapshot, sourceId: "next-database" };
    const entry: QueryHistoryEntry = { id: "entry", sourceId: snapshot.sourceId, sqlText: "SELECT 42;", executedAt: snapshot.capturedAt, durationMs: 2, rowCount: 1, status: "succeeded", errorKind: null };
    let finishClear!: (deleted: number) => void;
    const clearQueryHistory = vi.fn().mockImplementation(() => new Promise<number>((resolve) => { finishClear = resolve; }));
    const listQueryHistory = vi.fn((sourceId: string) => Promise.resolve(sourceId === snapshot.sourceId
      ? [entry] : [{ ...entry, sourceId, sqlText: "SELECT 99;" }]));
    const api = { clearQueryHistory, listQueryHistory } as unknown as NodalStudioPlatform;
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    try {
      const { rerender } = render(<QueryPage platform={api} snapshot={snapshot} runtimeKind="desktop" />);
      fireEvent.click(await screen.findByRole("tab", { name: "History 1" }));
      fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
      expect(clearQueryHistory).toHaveBeenCalledWith(snapshot.sourceId);
      rerender(<QueryPage platform={api} snapshot={next} runtimeKind="desktop" />);
      fireEvent.click(await screen.findByRole("tab", { name: "History 1" }));
      expect(screen.getByRole("button", { name: "SELECT 99;" })).toBeVisible();
      await act(async () => { finishClear(1); await Promise.resolve(); });
      expect(screen.getByRole("button", { name: "SELECT 99;" })).toBeVisible();
    } finally {
      confirm.mockRestore();
    }
  });

  it.each([legacyQueryWorkspaceKey, unboundQueryWorkspaceKey])("only moves an unassigned draft from %s when the user chooses to restore it", (workspace) => {
    saveQuerySession(workspace, { ...loadQuerySession(workspace), draft: "SELECT 7;" });
    const executeReadonlyQuery = vi.fn();
    const api = { listQueryHistory: vi.fn().mockResolvedValue([]), executeReadonlyQuery } as unknown as NodalStudioPlatform;
    render(<QueryPage platform={api} snapshot={snapshot} runtimeKind="desktop" />);
    expect(screen.getByRole("textbox", { name: "SQL editor" })).not.toHaveTextContent("SELECT 7;");
    fireEvent.click(screen.getByRole("button", { name: "Restore unassigned SQL draft in app" }));
    expect(screen.getByRole("textbox", { name: "SQL editor" })).toHaveTextContent("SELECT 7;");
    expect(loadQuerySession(queryWorkspaceKey(snapshot.sourceId)).draft).toBe("SELECT 7;");
    expect(loadQuerySession(workspace).draft).toBe("");
    expect(executeReadonlyQuery).not.toHaveBeenCalled();
  });
  it("runs editor SQL and resizes the output with the global pointer stream", async () => {
    let finishQuery!: (value: QueryExecutionResult) => void;
    const executeReadonlyQuery = vi.fn<NodalStudioPlatform["executeReadonlyQuery"]>().mockReturnValue(new Promise<QueryExecutionResult>((resolve) => { finishQuery = resolve; }));
    const platform = {
      listQueryHistory: vi.fn().mockResolvedValue([]),
      executeReadonlyQuery,
      cancelQuery: vi.fn().mockResolvedValue(true),
      deleteQueryHistory: vi.fn().mockResolvedValue(true),
      clearQueryHistory: vi.fn().mockResolvedValue(0),
    } as unknown as NodalStudioPlatform;

    const { container, rerender } = render(<QueryPage platform={platform} snapshot={snapshot} runtimeKind="desktop" openRequest={{ id: 1, sql: "SELECT 1;" }} onConsumeOpenRequest={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Replace" }));
    rerender(<QueryPage platform={platform} snapshot={snapshot} runtimeKind="desktop" />);
    const editor = container.querySelector(".cm-content");
    expect(editor).not.toBeNull();
    fireEvent.contextMenu(editor!, { clientX: 120, clientY: 80 });
    expect(screen.getByRole("menuitem", { name: "Run current statement" })).toBeEnabled();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Query execution options" }));
    expect(screen.getByRole("menuitem", { name: /^Run (?:⌘R|Ctrl\+R)$/ })).toBeEnabled();
    fireEvent.keyDown(editor!, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: /Run/ }));
    await waitFor(() => expect(executeReadonlyQuery).toHaveBeenCalledWith(expect.objectContaining({ sql: "SELECT 1;", rowLimit: 100 })));
    expect(container.querySelector(".cm-content")).toHaveTextContent("SELECT 1;");
    act(() => finishQuery(result));
    expect(await screen.findByRole("region", { name: "Query results" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("1 row · 3 ms");

    const splitter = screen.getByRole("separator", { name: "Resize query results" });
    expect(splitter).toHaveAttribute("aria-valuenow", "310");
    fireEvent.mouseDown(splitter, { clientY: 500 });
    fireEvent.mouseMove(window, { clientY: 400 });
    fireEvent.mouseUp(window, { clientY: 400 });
    expect(splitter).toHaveAttribute("aria-valuenow", "410");
    expect(document.body).not.toHaveClass("is-resizing-query-output");
  });
  it("disables empty execution and dismisses a menu when its SQL changes", () => {
    const platform = { listQueryHistory: vi.fn().mockResolvedValue([]), cancelQuery: vi.fn() } as unknown as NodalStudioPlatform;
    const { container } = render(<QueryPage platform={platform} snapshot={snapshot} runtimeKind="desktop" />);
    const editor = container.querySelector<HTMLElement>(".cm-editor")!;
    const view = EditorView.findFromDOM(editor)!;
    fireEvent.contextMenu(editor);
    expect(screen.getByRole("menuitem", { name: "Run selected SQL" })).toBeDisabled();
    expect(screen.getByRole("menuitem", { name: "Run current statement" })).toBeDisabled();
    act(() => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "SELECT 1;" } }));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    const coords = vi.spyOn(view, "coordsAtPos").mockReturnValue({ left: 100, right: 101, top: 100, bottom: 120 });
    fireEvent.keyDown(editor, { key: "F10", shiftKey: true });
    expect(screen.getByRole("menuitem", { name: "Run current statement" })).toBeEnabled();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    coords.mockRestore();
  });

  it("runs selected SQL from the editor menu through the existing readonly query path", async () => {
    const executeReadonlyQuery = vi.fn().mockResolvedValue(result);
    const platform = { executeReadonlyQuery, listQueryHistory: vi.fn().mockResolvedValue([]), cancelQuery: vi.fn() } as unknown as NodalStudioPlatform;
    const { container } = render(<QueryPage platform={platform} snapshot={snapshot} runtimeKind="desktop" />);
    const editor = container.querySelector<HTMLElement>(".cm-editor")!;
    const view = EditorView.findFromDOM(editor)!;
    const sql = "SELECT 1;\nSELECT 2;";
    act(() => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: sql }, selection: { anchor: 10, head: sql.length } }));
    fireEvent.contextMenu(editor, { clientX: 200, clientY: 150 });
    fireEvent.click(screen.getByRole("menuitem", { name: "Run selected SQL" }));
    await waitFor(() => expect(executeReadonlyQuery).toHaveBeenCalledWith(expect.objectContaining({ sql: "SELECT 2;", rowLimit: 100, timeoutMs: 30000 })));
    expect(view.state.selection.main.from).toBe(10);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
  it("runs the cursor statement and exposes only stop while a query is executing", async () => {
    let finish!: (value: QueryExecutionResult) => void;
    const executeReadonlyQuery = vi.fn<NodalStudioPlatform["executeReadonlyQuery"]>().mockImplementation(() => new Promise<QueryExecutionResult>(resolve => { finish = resolve; }));
    const cancelQuery = vi.fn().mockResolvedValue(true);
    const platform = { executeReadonlyQuery, cancelQuery, listQueryHistory: vi.fn().mockResolvedValue([]) } as unknown as NodalStudioPlatform;
    const { container } = render(<QueryPage platform={platform} snapshot={snapshot} runtimeKind="desktop" />);
    const editor = container.querySelector<HTMLElement>(".cm-editor")!;
    const view = EditorView.findFromDOM(editor)!;
    const sql = "SELECT ';';\nSELECT 2;";
    act(() => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: sql }, selection: { anchor: sql.indexOf("2") } }));
    fireEvent.contextMenu(editor);
    expect(screen.getByRole("menuitem", { name: "Run selected SQL" })).toBeDisabled();
    fireEvent.click(screen.getByRole("menuitem", { name: "Run current statement" }));
    await waitFor(() => expect(executeReadonlyQuery).toHaveBeenCalledWith(expect.objectContaining({ sql: "SELECT 2;" })));
    fireEvent.contextMenu(editor);
    expect(screen.getByRole("menuitem", { name: "Run current statement" })).toBeDisabled();
    fireEvent.click(screen.getByRole("menuitem", { name: "Stop query" }));
    expect(cancelQuery).toHaveBeenCalledWith(executeReadonlyQuery.mock.calls[0][0].queryId);
    await act(async () => { finish(result); await Promise.resolve(); });
  });

  it("supports keyboard output navigation and reversible pane focus without replacing the draft", async () => {
    const listQueryHistory = vi.fn().mockResolvedValue([]);
    const api = { listQueryHistory } as unknown as NodalStudioPlatform;
    const { container } = render(<QueryPage platform={api} snapshot={snapshot} runtimeKind="desktop" />);
    await waitFor(() => expect(listQueryHistory).toHaveBeenCalled());
    expect(container.querySelector(".query-page")).toHaveStyle({ "--query-output-height": "45%" });
    const results = screen.getByRole("tab", { name: "Results" });
    fireEvent.keyDown(results, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Message" })).toHaveFocus();
    expect(screen.getByRole("tabpanel", { name: "Message" })).toHaveAccessibleName("Message");
    fireEvent.keyDown(screen.getByRole("tab", { name: "Message" }), { key: "End" });
    expect(screen.getByRole("tab", { name: "History 0" })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(screen.getByRole("button", { name: "Expand output pane" }));
    expect(container.querySelector(".query-page")).toHaveAttribute("data-focus-output", "true");
    fireEvent.click(screen.getByRole("button", { name: "Restore split view" }));
    expect(container.querySelector(".query-page")).not.toHaveAttribute("data-focus-output");
    fireEvent.click(screen.getByRole("button", { name: "Collapse query output" }));
    expect(screen.queryByRole("tabpanel", { name: "History 0" })).not.toBeInTheDocument();
    fireEvent.click(results);
    expect(screen.getByRole("tabpanel", { name: "Results" })).toBeVisible();
  });

  it("runs the selection or cursor statement with Navicat shortcuts and stops only the active request", async () => {
    let finish!: (value: QueryExecutionResult) => void;
    const executeReadonlyQuery = vi.fn<NodalStudioPlatform["executeReadonlyQuery"]>().mockImplementation(() => new Promise<QueryExecutionResult>((resolve) => { finish = resolve; }));
    const cancelQuery = vi.fn().mockResolvedValue(true);
    const api = { listQueryHistory: vi.fn().mockResolvedValue([]), executeReadonlyQuery, cancelQuery } as unknown as NodalStudioPlatform;
    const { container } = render(<QueryPage platform={api} snapshot={snapshot} runtimeKind="desktop" />);
    const editor = container.querySelector<HTMLElement>(".cm-editor")!;
    const view = EditorView.findFromDOM(editor)!;
    const sql = "SELECT 'one;two';\nSELECT 2;";
    act(() => { view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: sql }, selection: { anchor: sql.indexOf("2") } }); });
    fireEvent.keyDown(editor, { key: "R", metaKey: true, shiftKey: true });
    await waitFor(() => expect(executeReadonlyQuery).toHaveBeenCalledWith(expect.objectContaining({ sql: "SELECT 2;" })));
    fireEvent.keyDown(editor, { key: ".", metaKey: true });
    expect(cancelQuery).toHaveBeenCalledWith(executeReadonlyQuery.mock.calls[0][0].queryId);
    fireEvent.keyDown(editor, { key: "r", metaKey: true });
    expect(executeReadonlyQuery).toHaveBeenCalledTimes(1);
    await act(async () => { finish(result); await Promise.resolve(); });
    act(() => { view.dispatch({ selection: { anchor: 0, head: sql.indexOf("\n") } }); });
    fireEvent.keyDown(editor, { key: "r", ctrlKey: true });
    await waitFor(() => expect(executeReadonlyQuery).toHaveBeenLastCalledWith(expect.objectContaining({ sql: "SELECT 'one;two';" })));
    await act(async () => { finish(result); await Promise.resolve(); });
    act(() => { view.dispatch({ selection: { anchor: 0 } }); });
    fireEvent.keyDown(editor, { key: "Enter", metaKey: true });
    await waitFor(() => expect(executeReadonlyQuery).toHaveBeenLastCalledWith(expect.objectContaining({ sql })));
    await act(async () => { finish(result); await Promise.resolve(); });
    fireEvent.click(screen.getByRole("button", { name: "Query execution options" }));
    const runItem = screen.getByRole("menuitem", { name: /^Run (?:⌘R|Ctrl\+R)$/ });
    expect(runItem).toHaveFocus();
    fireEvent.keyDown(runItem, { key: "ArrowDown" });
    expect(screen.getByRole("menuitem", { name: /Run Current Statement/ })).toHaveFocus();
    expect(screen.getByRole("menuitem", { name: /Stop/ })).toBeDisabled();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
