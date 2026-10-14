import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { getPlatform } from "./platform";
import { reportSnapshot } from "./test/schema-report-fixture";
import type { CaptureSnapshotResult } from "./platform";
import type { SchemaCanvasProps } from "./components/SchemaCanvas";
vi.mock("./components/ConnectionPanel", () => ({ ConnectionPanel: ({ onSnapshot }: { onSnapshot: (result: CaptureSnapshotResult) => void }) => <button type="button" onClick={() => onSnapshot({ snapshot: reportSnapshot, stored: true, changeSet: null })}>Load live workspace</button> }));
vi.mock("./components/SchemaCanvas", () => ({ SchemaCanvas: ({ snapshot }: SchemaCanvasProps) => <p>Live workspace {snapshot.id}</p> }));
vi.mock("./components/DdlImportPanel", () => ({ DdlImportPanel: ({ onClose }: { onClose: () => void }) => <section aria-label="Read-only DDL import preview"><button type="button" onClick={onClose}>Close DDL preview</button></section> }));
describe("DDL preview workspace isolation", () => {
  beforeEach(() => { localStorage.clear(); window.history.replaceState(null, "", "/"); }); afterEach(() => vi.restoreAllMocks());
  it.each(["desktop", "web"] as const)("opens without a connection and returns to the existing workspace on %s", async (kind) => {
    const platform = getPlatform(); vi.spyOn(platform, "getRuntimeInfo").mockResolvedValue({ kind, label: `${kind} fixture`, version: "test" }); vi.spyOn(platform, "loadSharedBundle").mockResolvedValue(null);
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><App /></QueryClientProvider>); await screen.findByText(`${kind} fixture`);
    fireEvent.click(screen.getByRole("button", { name: "Import DDL" })); expect(await screen.findByRole("region", { name: "Read-only DDL import preview" })).toBeVisible(); fireEvent.click(screen.getByRole("button", { name: "Close DDL preview" }));
    fireEvent.click(screen.getByRole("button", { name: "Load live workspace" })); expect(screen.getByText(`Live workspace ${reportSnapshot.id}`)).toBeVisible();
    const capture = vi.spyOn(platform, "capturePostgresSnapshot"); const query = vi.spyOn(platform, "executeReadonlyQuery"); const save = vi.spyOn(platform, "saveLayout");
    fireEvent.click(screen.getByRole("button", { name: "Import DDL" })); await screen.findByRole("region", { name: "Read-only DDL import preview" });
    fireEvent.keyDown(window, { key: "r", metaKey: true });
    expect(capture).not.toHaveBeenCalled(); expect(query).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Close DDL preview" })); expect(screen.getByText(`Live workspace ${reportSnapshot.id}`)).toBeVisible();
  });
  it("provides a read-only preview command before loading any database", async () => {
    const platform = getPlatform(); vi.spyOn(platform, "getRuntimeInfo").mockResolvedValue({ kind: "web", label: "Web fixture", version: "test" }); vi.spyOn(platform, "loadSharedBundle").mockResolvedValue(null);
    render(<QueryClientProvider client={new QueryClient()}><App /></QueryClientProvider>); await screen.findByText("Web fixture");
    fireEvent.click(screen.getByRole("button", { name: "Open command palette" })); fireEvent.click(screen.getByRole("button", { name: "Open read-only DDL preview" })); expect(await screen.findByRole("region", { name: "Read-only DDL import preview" })).toBeVisible();
  });
});
