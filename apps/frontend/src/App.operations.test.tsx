import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { getPlatform } from "./platform";
import type { CaptureSnapshotResult } from "./platform";
import { reportSnapshot } from "./test/schema-report-fixture";
import type { SchemaCanvasProps } from "./components/SchemaCanvas";
const other = { ...reportSnapshot, sourceId: "other-source", id: "other-snapshot", database: { ...reportSnapshot.database, name: "Other Commerce" } };
vi.mock("./components/ConnectionPanel", () => ({ ConnectionPanel: ({ onSnapshot }: { onSnapshot: (result: CaptureSnapshotResult) => void }) => <>
  <button onClick={() => onSnapshot({ snapshot: reportSnapshot, stored: true, changeSet: null })}>Load operation fixture</button>
  <button onClick={() => onSnapshot({ snapshot: other, stored: true, changeSet: null })}>Load other source</button>
</> }));
vi.mock("./components/SchemaCanvas", () => ({ SchemaCanvas: ({ snapshot }: SchemaCanvasProps) => <p data-testid="operation-canvas">{snapshot.sourceId} · {snapshot.id}</p> }));
async function mount() {
  const platform = getPlatform();
  vi.spyOn(platform, "getRuntimeInfo").mockResolvedValue({ kind: "desktop", label: "Desktop test runtime", version: "test" });
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><App /></QueryClientProvider>);
  await screen.findByText("Desktop test runtime"); fireEvent.click(screen.getByRole("button", { name: "Load operation fixture" }));
  return platform;
}
const refresh = () => screen.getAllByRole("button", { name: "Refresh" })[0];
describe("App snapshot operation feedback", () => {
  beforeEach(() => localStorage.clear()); afterEach(() => vi.restoreAllMocks());
  it("reports refresh running/error/success, blocks duplicates and retries with the current source", async () => {
    const platform = await mount(); let reject!: (reason: Error) => void;
    const capture = vi.spyOn(platform, "capturePostgresSnapshot").mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; })).mockResolvedValue({ snapshot: reportSnapshot, stored: false, changeSet: null });
    const button = refresh(); fireEvent.click(button); fireEvent.click(button);
    expect(within(screen.getByRole("group", { name: "Snapshot refresh" })).getByRole("status")).toHaveTextContent("Running · Refreshing Commerce");
    expect(screen.getAllByRole("button", { name: "Refreshing…" })[0]).toBeDisabled(); expect(capture).toHaveBeenCalledOnce();
    await act(() => Promise.resolve(reject(new Error("Connection interrupted"))));
    expect(screen.getByRole("alert")).toHaveTextContent("The loaded snapshot remains available");
    expect(screen.getByRole("alert")).toHaveTextContent("Connection interrupted");
    expect(screen.getByTestId("operation-canvas")).toHaveTextContent(reportSnapshot.id);
    fireEvent.click(screen.getByRole("button", { name: "Retry snapshot refresh" }));
    await waitFor(() => expect(within(screen.getByRole("group", { name: "Snapshot refresh" })).getByRole("status")).toHaveTextContent("3 tables · 0 structural changes. No new snapshot stored."));
    expect(capture).toHaveBeenCalledTimes(2); expect(capture).toHaveBeenLastCalledWith(reportSnapshot.sourceId, "manual");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("group", { name: "Snapshot refresh" })).getByRole("button", { name: "Dismiss result" }));
    expect(screen.queryByRole("group", { name: "Snapshot refresh" })).not.toBeInTheDocument();
  });
  it.each(["success", "failure"])("does not replace the current source or show a late refresh %s", async (outcome) => {
    const platform = await mount(); let finish!: (value: CaptureSnapshotResult) => void; let fail!: (error: Error) => void;
    vi.spyOn(platform, "capturePostgresSnapshot").mockImplementation(() => new Promise((resolve, reject) => { finish = resolve; fail = reject; }));
    fireEvent.click(refresh()); fireEvent.click(screen.getByRole("button", { name: "Load other source" }));
    expect(screen.queryByRole("group", { name: "Snapshot refresh" })).not.toBeInTheDocument();
    await act(async () => { if (outcome === "success") finish({ snapshot: { ...reportSnapshot, id: "late-id" }, stored: true, changeSet: null }); else fail(new Error("Old source failed")); await Promise.resolve(); });
    expect(screen.getByTestId("operation-canvas")).toHaveTextContent("other-source · other-snapshot");
    expect(screen.queryByText("Old source failed")).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Snapshot refresh" })).not.toBeInTheDocument();
  });
});
