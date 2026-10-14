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
  it.each(["desktop", "web"] as const)("uses the matrix to restrict query entry points in %s", async (kind) => {
    await mount(kind);
    fireEvent.click(screen.getByRole("button", { name: "Load PostgreSQL fixture" }));
    expect(screen.getByRole("button", { name: "Query" })).toHaveProperty("disabled", kind === "web");
    expect(screen.getByRole("button", { name: "Canvas query shortcut" })).toHaveProperty("disabled", kind === "web");
    fireEvent.click(screen.getByRole("button", { name: "Load MySQL fixture" }));
    expect(screen.getByRole("button", { name: "Query" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Canvas query shortcut" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Query" })).toHaveAttribute("title", expect.stringContaining(kind === "web" ? "Web Viewer never connects" : "PostgreSQL-only"));
  });
  it("opens the matrix from the command palette and supplies the loaded MySQL context", async () => {
    await mount("desktop"); fireEvent.click(screen.getByRole("button", { name: "Load MySQL fixture" }));
    fireEvent.click(screen.getByRole("button", { name: "Open command palette" }));
    fireEvent.click(screen.getByRole("button", { name: /Open capability matrix/ }));
    const settings = await screen.findByRole("region", { name: "Settings" });
    expect(within(settings).getByRole("columnheader", { name: "Desktop · MySQL Current" })).toHaveAttribute("data-current", "true");
    expect(window.location.hash).toBe("#/settings/capabilities");
  });
});
