import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DatabaseSnapshot, QueryExecutionResult, NodalStudioPlatform } from "../../platform";
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
  it("runs editor SQL and resizes the output with the global pointer stream", async () => {
    let finishQuery!: (value: QueryExecutionResult) => void;
    const executeReadonlyQuery = vi.fn().mockReturnValue(new Promise<QueryExecutionResult>((resolve) => { finishQuery = resolve; }));
    const platform = {
      listQueryHistory: vi.fn().mockResolvedValue([]),
      executeReadonlyQuery,
      cancelQuery: vi.fn().mockResolvedValue(true),
      deleteQueryHistory: vi.fn().mockResolvedValue(true),
      clearQueryHistory: vi.fn().mockResolvedValue(0),
    } as unknown as NodalStudioPlatform;

    const { container } = render(<QueryPage platform={platform} snapshot={snapshot} runtimeKind="desktop" openRequest={{ id: 1, sql: "SELECT 1;" }} onConsumeOpenRequest={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Replace" }));
    const editor = container.querySelector(".cm-content");
    expect(editor).not.toBeNull();
    fireEvent.contextMenu(editor!, { clientX: 120, clientY: 80 });
    expect(screen.getByRole("menuitem", { name: /Run Selected/ })).toBeDisabled();
    fireEvent.keyDown(editor!, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: /Run/ }));
    await waitFor(() => expect(executeReadonlyQuery).toHaveBeenCalledWith(expect.objectContaining({ sql: "SELECT 1;", rowLimit: 100 })));
    expect(container.querySelector(".cm-content")).toHaveTextContent("SELECT 1;");
    act(() => finishQuery(result));
    expect(await screen.findByRole("region", { name: "Query results" })).toBeInTheDocument();

    const splitter = screen.getByRole("separator", { name: "Resize query results" });
    expect(splitter).toHaveAttribute("aria-valuenow", "310");
    fireEvent.mouseDown(splitter, { clientY: 500 });
    fireEvent.mouseMove(window, { clientY: 400 });
    fireEvent.mouseUp(window, { clientY: 400 });
    expect(splitter).toHaveAttribute("aria-valuenow", "410");
    expect(document.body).not.toHaveClass("is-resizing-query-output");
  });
});
