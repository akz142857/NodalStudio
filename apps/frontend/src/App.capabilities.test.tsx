import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { getPlatform } from "./platform";
import type { CaptureSnapshotResult } from "./platform";
import { reportSnapshot } from "./test/schema-report-fixture";
import type { SchemaCanvasProps } from "./components/SchemaCanvas";
vi.mock("./components/ConnectionPanel", () => ({ ConnectionPanel: ({ onSnapshot }: { onSnapshot: (result: CaptureSnapshotResult) => void }) => <>
  <button type="button" onClick={() => onSnapshot({ snapshot: reportSnapshot, stored: true, changeSet: null })}>Load PostgreSQL fixture</button>
  <button type="button" onClick={() => onSnapshot({ snapshot: { ...reportSnapshot, id: "mysql", sourceId: "mysql", database: { ...reportSnapshot.database, databaseType: "mySql", version: "8.4" } }, stored: true, changeSet: null })}>Load MySQL fixture</button>
</> }));
vi.mock("./components/SchemaCanvas", () => ({ SchemaCanvas: ({ snapshot, onOpenQuery }: SchemaCanvasProps) => <button type="button" disabled={!onOpenQuery} onClick={() => onOpenQuery?.(snapshot.schemas[0].tables[0])}>Canvas query shortcut</button> }));
async function mount(kind: "desktop" | "web") {
  const platform = getPlatform();
  vi.spyOn(platform, "getRuntimeInfo").mockResolvedValue({ kind, label: `${kind} capability test`, version: "test" });
  vi.spyOn(platform, "loadSharedBundle").mockResolvedValue(null);
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><App /></QueryClientProvider>);
  await screen.findByText(`${kind} capability test`);
}
describe("App capability integration", () => {
  beforeEach(() => { localStorage.clear(); window.history.replaceState(null, "", "/"); });
  afterEach(() => vi.restoreAllMocks());
  it("starts in Model with no Changes segment before a source is selected", async () => {
    await mount("desktop");
    const navigation = within(screen.getByRole("group", { name: "View mode" }));
    expect(navigation.getByRole("button", { name: "Model" })).toHaveAttribute("aria-pressed", "true");
    expect(navigation.queryByRole("button", { name: "Changes" })).not.toBeInTheDocument();
  });
  it.each([1, 2])("shows the MySQL history comparison empty state with %s saved versions", async (count) => {
    vi.spyOn(getPlatform(), "listSnapshots").mockResolvedValue(Array.from({ length: count }, (_, i) => ({
      id: `snapshot-${i}`, sourceId: "mysql", capturedAt: reportSnapshot.capturedAt,
      fingerprint: `${i}`, databaseName: reportSnapshot.database.name, schemaCount: 1, tableCount: 3,
    })));
    await mount("desktop");
    fireEvent.click(screen.getByRole("button", { name: "Load MySQL fixture" }));
    fireEvent.click(screen.getByRole("button", { name: "Review understanding" }));
    fireEvent.click(screen.getByRole("button", { name: "History comparison" }));
    expect(await screen.findByText(count === 1 ? "Your first snapshot is the starting point." : "Choose two snapshots to compare.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Open history" }));
    expect(screen.getByRole("button", { name: "History" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Model" })).toHaveAttribute("aria-pressed", "true");
  });
  it.each(["desktop", "web"] as const)("uses the matrix to restrict query entry points in %s", async (kind) => {
    await mount(kind);
    fireEvent.click(screen.getByRole("button", { name: "Load PostgreSQL fixture" }));
    expect(screen.getByRole("button", { name: "Query" })).toHaveProperty("disabled", kind === "web");
    expect(screen.getByRole("button", { name: "Canvas query shortcut" })).toHaveProperty("disabled", kind === "web");
    fireEvent.click(screen.getByRole("button", { name: "Load MySQL fixture" }));
    expect(screen.getByRole("button", { name: "Query" })).toHaveProperty("disabled", kind === "web");
    expect(screen.getByRole("button", { name: "Canvas query shortcut" })).toHaveProperty("disabled", kind === "web");
    if (kind === "web") expect(screen.getByRole("button", { name: "Query" })).toHaveAttribute("title", expect.stringContaining("Web Viewer never connects"));
  });
  it("opens the matrix from the command palette and supplies the loaded MySQL context", async () => {
    await mount("desktop"); fireEvent.click(screen.getByRole("button", { name: "Load MySQL fixture" }));
    fireEvent.click(screen.getByRole("button", { name: "Open command palette" }));
    fireEvent.click(screen.getByRole("option", { name: /Open capability matrix/ }));
    const settings = await screen.findByRole("dialog", { name: "Settings" });
    expect(within(settings).getByRole("columnheader", { name: "Desktop · MySQL Current" })).toHaveAttribute("data-current", "true");
    expect(window.location.hash).toBe("#/settings/capabilities");
  });
});
