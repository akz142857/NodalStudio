import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { getPlatform } from "./platform";
import type { CaptureSnapshotResult } from "./platform";
import { diagramAfter, diagramBefore, diagramChangeSet } from "./test/diagram-comparison-fixture";
import type { SchemaCanvasProps } from "./components/SchemaCanvas";

const fixture = structuredClone(diagramAfter);
fixture.schemas[0].tables[1].primaryKey = null;
vi.mock("./components/ConnectionPanel", () => ({ ConnectionPanel: ({ onSnapshot }: { onSnapshot: (result: CaptureSnapshotResult) => void }) => <>
  <button type="button" onClick={() => onSnapshot({ snapshot: fixture, changeSet: diagramChangeSet, stored: true })}>Capture preflight fixture</button>
  <button type="button" onClick={() => onSnapshot({ snapshot: { ...fixture, id: "other-id", sourceId: "other-source", fingerprint: "other-fingerprint" }, changeSet: null, stored: true })}>Capture other source</button>
</> }));
vi.mock("./components/SchemaCanvas", () => ({ SchemaCanvas: ({ query, selectedTable }: SchemaCanvasProps) => <div data-testid="preflight-canvas">Canvas query: {query || "none"} · Selected: {selectedTable?.key.name ?? "none"}</div> }));

async function mount(kind: "desktop" | "web" = "desktop") {
  const platform = getPlatform();
  vi.spyOn(platform, "getRuntimeInfo").mockResolvedValue({ kind, label: `${kind} test runtime`, version: "test" });
  vi.spyOn(platform, "getSnapshot").mockResolvedValue(diagramBefore);
  vi.spyOn(platform, "loadSharedBundle").mockResolvedValue(null);
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><App /></QueryClientProvider>);
  await screen.findByText(`${kind} test runtime`);
  fireEvent.click(screen.getByRole("button", { name: "Capture preflight fixture" }));
  return platform;
}

describe("App structure preflight integration", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it("checks the entire loaded snapshot independent of diagram search and comparison ghosts, locating a table returns to Database", async () => {
    await mount();
    fireEvent.change(screen.getByPlaceholderText("Table, field, schema…"), { target: { value: "no-tables-match" } });
    fireEvent.click(screen.getByRole("button", { name: "Structure preflight" }));
    const panel = screen.getByRole("region", { name: "Structure preflight" });
    await waitFor(() => expect(within(panel).getByRole("status")).toHaveTextContent("3 tables"));
    expect(within(panel).getByRole("article", { name: "table-primary-key: public.orders" })).toBeVisible();
    expect(panel).not.toHaveTextContent("public.audit");
    fireEvent.click(within(panel).getByRole("button", { name: "Locate table" }));
    expect(screen.getByRole("button", { name: "Database" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByPlaceholderText("Table, field, schema…")).toHaveValue("");
    expect(screen.getByTestId("preflight-canvas")).toHaveTextContent("Canvas query: none · Selected: orders");
    expect(screen.queryByRole("region", { name: "Structure preflight" })).not.toBeInTheDocument();
  });

  it("updates the checked source while open and provides an explicit way back to the diagram", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Structure preflight" }));
    await waitFor(() => expect(within(screen.getByRole("region", { name: "Structure preflight" })).getByRole("status")).toHaveTextContent("Completed"));
    fireEvent.click(screen.getByRole("button", { name: "Capture other source" }));
    expect(screen.getByText(/Entire loaded snapshot/)).toHaveTextContent("other-fingerprint".slice(0, 12));
    await waitFor(() => expect(within(screen.getByRole("region", { name: "Structure preflight" })).getByRole("status")).toHaveTextContent("Completed"));
    fireEvent.click(screen.getByRole("button", { name: "Close preflight" }));
    expect(screen.getByTestId("preflight-canvas")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Structure preflight" }));
    fireEvent.click(screen.getByRole("button", { name: "Database" }));
    expect(screen.queryByRole("region", { name: "Structure preflight" })).not.toBeInTheDocument();
  });

  it("supports metadata-only Web preflight without invoking database refresh, query or semantic writes", async () => {
    const platform = await mount("web");
    const refresh = vi.spyOn(platform, "capturePostgresSnapshot");
    const query = vi.spyOn(platform, "executeReadonlyQuery");
    const save = vi.spyOn(platform, "saveAnnotation");
    fireEvent.click(screen.getByRole("button", { name: "Structure preflight" }));
    await waitFor(() => expect(within(screen.getByRole("region", { name: "Structure preflight" })).getByRole("status")).toHaveTextContent("Completed"));
    fireEvent.click(screen.getByRole("button", { name: "Run checks again" }));
    await waitFor(() => expect(within(screen.getByRole("region", { name: "Structure preflight" })).getByRole("status")).toHaveTextContent("Completed"));
    expect(refresh).not.toHaveBeenCalled(); expect(query).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
  });
});
