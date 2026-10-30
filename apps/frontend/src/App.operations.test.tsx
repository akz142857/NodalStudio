import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { getPlatform } from "./platform";
import type { CaptureSnapshotResult } from "./platform";
import { reportSnapshot } from "./test/schema-report-fixture";
import { DatabaseSnapshotHeader } from "./components/DatabaseSnapshotHeader";
import type { SchemaCanvasProps } from "./components/SchemaCanvas";
const other = { ...reportSnapshot, sourceId: "other-source", id: "other-snapshot", database: { ...reportSnapshot.database, name: "Other Commerce" } };
vi.mock("./components/ConnectionPanel", () => ({ ConnectionPanel: ({ onSnapshot }: { onSnapshot: (result: CaptureSnapshotResult) => void }) => <>
  <button onClick={() => onSnapshot({ snapshot: reportSnapshot, stored: true, changeSet: null })}>Load operation fixture</button>
  <button onClick={() => onSnapshot({ snapshot: other, stored: true, changeSet: null })}>Load other source</button>
</> }));
vi.mock("./components/SchemaCanvas", () => ({ SchemaCanvas: ({ snapshot, onOpenHistory, refreshState, onSelectTable, selectedTable }: SchemaCanvasProps) => <>
  <DatabaseSnapshotHeader snapshot={snapshot} onOpenHistory={onOpenHistory} refreshState={refreshState} />
  <p data-testid="operation-canvas">{snapshot.sourceId} · {snapshot.id}</p>
  <button onClick={() => onSelectTable(snapshot.schemas[0].tables[1], "total")}>Select order field</button>
  <output data-testid="selected-table">{selectedTable?.key.name}</output>
</> }));
async function mount() {
  const platform = getPlatform();
  vi.spyOn(platform, "getRuntimeInfo").mockResolvedValue({ kind: "desktop", label: "Desktop test runtime", version: "test" });
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><App /></QueryClientProvider>);
  await screen.findByText("Desktop test runtime"); fireEvent.click(screen.getByRole("button", { name: "Load operation fixture" }));
  return platform;
}
const refresh = () => screen.getAllByRole("button", { name: "Refresh schema" })[0];
describe("App snapshot operation feedback", () => {
  beforeEach(() => localStorage.clear()); afterEach(() => vi.restoreAllMocks());
  it("presents header functions as named icons with contextual help and working actions", async () => {
    await mount();
    const tools = within(screen.getByRole("group", { name: "Application tools" }));
    for (const name of ["Import DDL", "Structure preflight", "Export structure document", "Export interactive viewer", "Refresh schema", "Open Settings", "Open command palette", "Open notifications"]) {
      const button = tools.getByRole("button", { name });
      expect(button.textContent).toBe("");
    }
    const preflight = tools.getByRole("button", { name: "Structure preflight" });
    fireEvent.focus(preflight);
    expect(tools.getByRole("tooltip")).toHaveTextContent("Check the entire loaded snapshot");
    fireEvent.click(preflight);
    expect(preflight).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("heading", { name: "Structure preflight" })).toBeVisible();
  });
  it("keeps the source sidebar for navigation and opens History from the Database title", async () => {
    await mount();
    expect(screen.queryByRole("region",{name:"Active snapshot"})).toBeNull();
    expect(document.querySelector(".sidebar")?.textContent).not.toContain("Snapshot");
    expect(screen.getAllByRole("button",{name:"Refresh schema"})).toHaveLength(1);
    const collapse = screen.queryByRole("button",{name:"Collapse right inspector"});
    if (collapse) fireEvent.click(collapse);
    fireEvent.click(screen.getByRole("button",{name:"Open schema history"}));
    expect(document.querySelector(".inspector")).not.toHaveAttribute("hidden");
    expect(await screen.findByRole("region",{name:"Schema history"})).toBeVisible();
    expect(screen.getByRole("region",{name:"Viewing snapshot details"})).toHaveTextContent(reportSnapshot.fingerprint);
  });
  it("keeps normal refreshes quiet, reports errors, blocks duplicates and retries with the current source", async () => {
    const platform = await mount(); let reject!: (reason: Error) => void;
    const capture = vi.spyOn(platform, "capturePostgresSnapshot").mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; })).mockResolvedValue({ snapshot: reportSnapshot, stored: false, changeSet: null });
    const button = refresh(); fireEvent.click(button); fireEvent.click(button);
    expect(screen.queryByRole("group", { name: "Snapshot refresh" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Refreshing…" })[0]).toBeDisabled(); expect(capture).toHaveBeenCalledOnce();
    await act(() => Promise.resolve(reject(new Error("Connection interrupted"))));
    const failure = within(screen.getByRole("group", { name: "Snapshot refresh" })).getByRole("alert");
    expect(failure).toHaveTextContent("The loaded snapshot remains available");
    expect(failure).toHaveTextContent("Connection interrupted");
    expect(screen.getByTestId("operation-canvas")).toHaveTextContent(reportSnapshot.id);
    fireEvent.click(screen.getByRole("button", { name: "Retry snapshot refresh" }));
    await waitFor(() => expect(refresh()).toBeEnabled());
    expect(capture).toHaveBeenCalledTimes(2); expect(capture).toHaveBeenLastCalledWith(reportSnapshot.sourceId, "manual");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Snapshot refresh" })).not.toBeInTheDocument();
  });
  it("keeps automatic refresh enabled without replacing unchanged models or clearing the selected field", async () => {
    const timers = vi.spyOn(window, "setInterval");
    const platform = await mount();
    let finish!: (result: CaptureSnapshotResult) => void;
    const capture = vi.spyOn(platform, "capturePostgresSnapshot").mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    fireEvent.click(screen.getByRole("button", { name: "Select order field" }));
    const header = screen.getByRole("banner", { name: "Database snapshot context" });
    const initialContent = header.innerHTML;
    const field = document.querySelector('[data-column-focus="true"]');
    expect(field).toHaveTextContent("Calculated order total");
    const getSemantics = vi.spyOn(platform, "getSemantics");
    const tick = timers.mock.calls.filter(([, delay]) => delay === 30_000).at(-1)?.[0];
    expect(tick).toBeTypeOf("function");

    for (let poll = 0; poll < 2; poll += 1) {
      act(() => tick!());
      expect(capture).toHaveBeenLastCalledWith(reportSnapshot.sourceId, "background");
      expect(header.innerHTML).toBe(initialContent);
      expect(screen.getByRole("button", { name: "Refreshing…" })).toHaveAttribute("aria-busy", "true");
      await act(() => Promise.resolve(finish({ snapshot: reportSnapshot, stored: false, changeSet: null })));
      expect(header.innerHTML).toBe(initialContent);
      expect(screen.getByTestId("selected-table")).toHaveTextContent("orders");
      expect(document.querySelector('[data-column-focus="true"]')).toBe(field);
    }
    expect(capture).toHaveBeenCalledTimes(2);
    expect(getSemantics).not.toHaveBeenCalled();

    act(() => tick!());
    await act(() => Promise.resolve(finish({ snapshot: { ...reportSnapshot, id: "updated-model", fingerprint: "changed-structure" }, stored: true, changeSet: null })));
    expect(screen.getByTestId("operation-canvas")).toHaveTextContent("updated-model");
    expect(getSemantics).toHaveBeenCalled();
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
