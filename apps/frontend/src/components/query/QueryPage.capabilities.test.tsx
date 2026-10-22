import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NodalStudioPlatform, QueryHistoryEntry } from "../../platform";
import { reportSnapshot } from "../../test/schema-report-fixture";
import { QueryPage } from "./QueryPage";
vi.mock("./SqlEditor", () => ({ SqlEditor: ({ value, onRun }: { value: string; onRun: (sql: string) => void }) => <><p>SQL draft: {value}</p><button type="button" onClick={() => onRun("SELECT 1;")}>Editor execution shortcut</button></> }));
function platform() { return { executeReadonlyQuery: vi.fn<NodalStudioPlatform["executeReadonlyQuery"]>().mockResolvedValue({ queryId: "q", columns: [], rows: [], rowCount: 0, durationMs: 1, truncated: false, notices: [] }), listQueryHistory: vi.fn<(sourceId: string, limit?: number) => Promise<QueryHistoryEntry[]>>().mockResolvedValue([]) }; }
describe("Query capability boundaries", () => {
  beforeEach(() => localStorage.clear());
  it.each([
    ["desktop", "mySql"], ["web", "postgreSql"], ["web", "mySql"],
  ] as const)("blocks Run and editor execution on %s/%s without requesting query history", (runtimeKind, databaseType) => {
    const api = platform();
    render(<QueryPage platform={api as unknown as NodalStudioPlatform} runtimeKind={runtimeKind} snapshot={{ ...reportSnapshot, database: { ...reportSnapshot.database, databaseType } }} />);
    expect(screen.getByRole("button", { name: /Run/ })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Editor execution shortcut" }));
    expect(api.executeReadonlyQuery).not.toHaveBeenCalled(); expect(api.listQueryHistory).not.toHaveBeenCalled();
    expect(screen.getByText(runtimeKind === "web" ? /web viewer never connects/ : /MySQL metadata capture is supported/)).toBeVisible();
  });
  it("allows Desktop PostgreSQL execution through the same guard", async () => {
    const api = platform(); render(<QueryPage platform={api as unknown as NodalStudioPlatform} runtimeKind="desktop" snapshot={reportSnapshot} />);
    expect(screen.getByRole("button", { name: /Run/ })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Editor execution shortcut" }));
    await waitFor(() => expect(api.executeReadonlyQuery).toHaveBeenCalledOnce());
    expect(api.executeReadonlyQuery).toHaveBeenCalledWith(expect.objectContaining({ sourceId: reportSnapshot.sourceId, sql: "SELECT 1;", rowLimit: 100 }));
  });
  it("ignores pending history when switching from PostgreSQL to an unsupported MySQL source", async () => {
    const api = platform(); let finish!: (entries: QueryHistoryEntry[]) => void;
    vi.mocked(api.listQueryHistory).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const { rerender } = render(<QueryPage platform={api as unknown as NodalStudioPlatform} runtimeKind="desktop" snapshot={reportSnapshot} />);
    rerender(<QueryPage platform={api as unknown as NodalStudioPlatform} runtimeKind="desktop" snapshot={{ ...reportSnapshot, sourceId: "mysql", database: { ...reportSnapshot.database, databaseType: "mySql" } }} />);
    await act(() => Promise.resolve(finish([{ id: "old", sourceId: reportSnapshot.sourceId, executedAt: reportSnapshot.capturedAt, sqlText: "SELECT 'old-source';", durationMs: 1, rowCount: 1, status: "succeeded", errorKind: null }])));
    expect(screen.getByRole("tab", { name: "History 0" })).toBeVisible();
    expect(screen.queryByText("SELECT 'old-source';")).not.toBeInTheDocument(); expect(api.listQueryHistory).toHaveBeenCalledOnce();
  });
});
