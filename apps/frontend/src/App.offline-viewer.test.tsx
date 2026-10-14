/// <reference types="node" />
import { webcrypto } from "node:crypto";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { getPlatform } from "./platform";
import type { CaptureSnapshotResult, SchemaReportExportInput } from "./platform";
import type { SchemaCanvasProps } from "./components/SchemaCanvas";
import { reportSnapshot, reportSemantics } from "./test/schema-report-fixture";
vi.mock("./components/ConnectionPanel", () => ({ ConnectionPanel: ({ onSnapshot }: { onSnapshot: (result: CaptureSnapshotResult) => void }) => <button type="button" onClick={() => onSnapshot({ snapshot: reportSnapshot, stored: true, changeSet: null })}>Load Viewer fixture</button> }));
vi.mock("./components/SchemaCanvas", () => ({ SchemaCanvas: ({ query }: SchemaCanvasProps) => <p>Diagram filter: {query}</p> }));
describe("App offline export range", () => {
  beforeEach(() => { vi.stubGlobal("crypto", webcrypto); localStorage.clear(); window.history.replaceState(null, "", "/"); });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  it.each(["desktop", "web"] as const)("exports the entire loaded %s snapshot independently of diagram search, without database or semantic writes", async (kind) => {
    const platform = getPlatform(); vi.spyOn(platform, "getRuntimeInfo").mockResolvedValue({ kind, label: `${kind} Viewer fixture`, version: "test" }); vi.spyOn(platform, "loadSharedBundle").mockResolvedValue(null);
    vi.spyOn(platform, "getSemantics").mockResolvedValue(reportSemantics); const save = vi.spyOn(platform, "saveSchemaReport").mockResolvedValue({ path: null });
    const capture = vi.spyOn(platform, "capturePostgresSnapshot"); const execute = vi.spyOn(platform, "executeReadonlyQuery"); const layout = vi.spyOn(platform, "saveLayout"); const domain = vi.spyOn(platform, "saveDomainGroup");
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => { callback(0); return 1; });
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><App /></QueryClientProvider>); await screen.findByText(`${kind} Viewer fixture`);
    expect(screen.queryByRole("button", { name: "Export offline Viewer" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Load Viewer fixture" })); await waitFor(() => expect(screen.getByRole("button", { name: "Export offline Viewer" })).toBeEnabled());
    fireEvent.change(screen.getByRole("searchbox", { name: "Search schema" }), { target: { value: "customers" } }); expect(screen.getByText("Diagram filter: customers")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Export offline Viewer" })); await waitFor(() => expect(save).toHaveBeenCalledOnce());
    const input: SchemaReportExportInput = save.mock.calls[0][0]; expect(input.html).toContain('id="table-1-0"'); expect(input.html).toContain("orders_customer_fk"); expect(input.html).toContain("independent of the app’s Diagram filters");
    expect(capture).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled(); expect(layout).not.toHaveBeenCalled(); expect(domain).not.toHaveBeenCalled();
  });
});
