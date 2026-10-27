import { EditorView } from "@codemirror/view";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSnapshot, QueryExecutionResult, NodalStudioPlatform } from "../../platform";
import { clearQuerySessions } from "./query-state";
import { QueryPage } from "./QueryPage";

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

describe("QueryPage", () => {
  beforeEach(() => clearQuerySessions());
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
    expect(cancelQuery).toHaveBeenCalledWith(executeReadonlyQuery.mock.calls[0][0].queryId);
    if (returnToOriginal) rerender(<QueryPage platform={api} snapshot={mysql} runtimeKind="desktop" />);
    await act(async () => { finish(result); await Promise.resolve(); });
    expect(screen.queryByRole("region", { name: "Query results" })).not.toBeInTheDocument();
    expect(screen.getByText(/Data source changed/)).toBeVisible();
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
