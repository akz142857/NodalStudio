import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { getPlatform, type CaptureSnapshotResult, type SchemaChangeSet } from "./platform";
import { reportSemantics, reportSnapshot } from "./test/schema-report-fixture";
import { enumSnapshot } from "./test/enum-fixture";
import type { CanvasLocateRequest, SchemaCanvasProps } from "./components/SchemaCanvas";
const changes: SchemaChangeSet = { id: "changes", beforeSnapshotId: "before", afterSnapshotId: reportSnapshot.id, createdAt: reportSnapshot.capturedAt, operations: [], riskSummary: { high: 0, medium: 0, low: 0, informational: 0 } };
vi.mock("./components/ConnectionPanel", () => ({ ConnectionPanel: ({ onSnapshot, children }: { onSnapshot: (result: CaptureSnapshotResult) => void; children: ReactNode }) => <>
  <button onClick={() => onSnapshot({ snapshot: reportSnapshot, stored: false, changeSet: null })}>Load navigation fixture</button>
  <button onClick={() => onSnapshot({ snapshot: reportSnapshot, stored: false, changeSet: changes })}>Load changed fixture</button>
  <button onClick={() => onSnapshot({ snapshot: enumSnapshot, stored: false, changeSet: null })}>Load enum fixture</button>
  {children}
</> }));
vi.mock("./components/SchemaCanvas", () => ({ SchemaCanvas: (props: SchemaCanvasProps) => <section aria-label="Navigation canvas">
  <output data-testid="canvas-view">{props.savedView?.name ?? "Full model"}</output>
  <output data-testid="canvas-query">{props.query}</output>
  <output data-testid="navigation-ready">{String(props.navigationReady)}</output>
  <output data-testid="locate-request">{props.locateRequest ? JSON.stringify(props.locateRequest) : "none"}</output>
  <button onClick={() => props.locateRequest && props.onLocateComplete?.(props.locateRequest)}>Acknowledge navigation</button>
</section> }));
async function mount() {
  const platform = getPlatform();
  vi.spyOn(platform, "getRuntimeInfo").mockResolvedValue({ kind: "desktop", label: "Navigation runtime", version: "test" });
  vi.spyOn(platform, "getSemantics").mockResolvedValue(reportSemantics);
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><App /></QueryClientProvider>);
  await screen.findByText("Navigation runtime");
  return platform;
}
const requested = () => JSON.parse(screen.getByTestId("locate-request").textContent) as CanvasLocateRequest;
const pickOrders = () => {
  const tree = within(screen.getByRole("region", { name: "Database structure" }));
  fireEvent.change(tree.getByRole("searchbox"), { target: { value: "public.orders" } });
  fireEvent.click(tree.getByRole("button", { name: /^orders/ }));
};
describe("App sidebar object navigation", () => {
  beforeEach(() => localStorage.clear()); afterEach(() => vi.restoreAllMocks());
  it("locates a cross-schema enum usage from preflight, clears Diagram filters and supports repeated location without closing details", async () => {
    await mount(); fireEvent.click(screen.getByRole("button", { name: "Load enum fixture" }));
    const tree = within(screen.getByRole("region", { name: "Database structure" }));
    fireEvent.click(tree.getByRole("button", { name: /^public/ }));
    fireEvent.click(tree.getByRole("button", { name: /^Enums/ }));
    fireEvent.click(tree.getByRole("button", { name: "order_status" }));
    const details = tree.getByRole("region", { name: "Enum details for public.order_status" });
    expect(screen.getByTestId("locate-request")).toHaveTextContent("none");
    fireEvent.change(screen.getByRole("searchbox", { name: "Search schema" }), { target: { value: "no-matching-tables" } });
    fireEvent.click(screen.getByRole("button", { name: "Structure preflight" }));
    fireEvent.click(within(details).getByRole("button", { name: "Locate archive.orders in diagram" }));
    expect(screen.getByRole("region", { name: "Navigation canvas" })).toBeVisible();
    expect(screen.getByRole("searchbox", { name: "Search schema" })).toHaveValue("");
    expect(requested()).toEqual({ sourceId: enumSnapshot.sourceId, snapshotId: enumSnapshot.id, nodeId: "archive.orders", revision: 1 });
    fireEvent.click(screen.getByRole("button", { name: "Acknowledge navigation" }));
    fireEvent.click(within(details).getByRole("button", { name: "Locate archive.orders in diagram" }));
    expect(requested().revision).toBe(2); expect(details).toBeVisible();
    fireEvent.click(within(details).getByRole("button", { name: "Locate public.orders in diagram" }));
    expect(requested().nodeId).toBe("public.orders"); expect(requested().revision).toBe(3);
  });
  it("opens a saved view from the sidebar, leaves preflight, and reuses navigation without writing layouts", async () => {
    const platform = await mount();
    const view = { id: "navigation-view", sourceId: reportSnapshot.sourceId, name: "Order fulfillment", rootTableKeys: [reportSnapshot.schemas[0].tables[0].key], relationshipDepth: 0, updatedAt: "now" };
    vi.spyOn(platform, "getSemantics").mockResolvedValue({ ...reportSemantics, savedViews: [view, { ...view, id: "foreign", sourceId: "another-source", name: "Other database view" }] });
    const save = vi.spyOn(platform, "saveLayout");
    fireEvent.click(screen.getByRole("button", { name: "Load navigation fixture" }));
    const navigation = await screen.findByRole("navigation", { name: "Model views" });
    await waitFor(() => expect(within(navigation).getByRole("button", { name: "Order fulfillment" })).toBeEnabled());
    expect(within(navigation).queryByRole("button", { name: "Other database view" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search schema" }), { target: { value: "orders" } });
    fireEvent.click(screen.getByRole("button", { name: "Structure preflight" }));
    fireEvent.click(within(navigation).getByRole("button", { name: "Order fulfillment" }));
    expect(screen.getByRole("region", { name: "Navigation canvas" })).toBeVisible();
    expect(screen.getByTestId("canvas-view")).toHaveTextContent("Order fulfillment");
    expect(screen.getByRole("searchbox", { name: "Search schema" })).toHaveValue("");
    expect(localStorage.getItem(`nodalstudio:last-view:${reportSnapshot.sourceId}`)).toBe(view.id);
    fireEvent.click(within(navigation).getByRole("button", { name: "Full model" }));
    expect(screen.getByTestId("canvas-view")).toHaveTextContent("Full model");
    expect(localStorage.getItem(`nodalstudio:last-view:${reportSnapshot.sourceId}`)).toBeNull();
    expect(save).not.toHaveBeenCalled();
  });
  it("keeps sidebar search independent, reveals filtered tables, and issues a new request for repeated clicks", async () => {
    await mount(); fireEvent.click(screen.getByRole("button", { name: "Load navigation fixture" }));
    const globalSearch = screen.getByRole("searchbox", { name: "Search schema" });
    fireEvent.change(globalSearch, { target: { value: "nothing-matches" } });
    pickOrders();
    expect(globalSearch).toHaveValue(""); expect(screen.getByTestId("canvas-query")).toHaveTextContent("");
    expect(screen.getByRole("searchbox", { name: "Search tables and views" })).toHaveValue("public.orders");
    expect(requested()).toEqual({ sourceId: reportSnapshot.sourceId, snapshotId: reportSnapshot.id, nodeId: "public.orders", revision: 1 });
    fireEvent.click(screen.getByRole("button", { name: "Acknowledge navigation" }));
    expect(screen.getByTestId("locate-request")).toHaveTextContent("none");
    pickOrders();
    expect(requested().revision).toBe(2);
  });
  it("switches from change list and preflight back to Diagram without losing the navigation request", async () => {
    await mount(); fireEvent.click(screen.getByRole("button", { name: "Load changed fixture" }));
    expect(screen.queryByRole("region", { name: "Navigation canvas" })).not.toBeInTheDocument();
    pickOrders();
    expect(screen.getByRole("region", { name: "Navigation canvas" })).toBeVisible();
    expect(screen.getByTestId("locate-request")).toHaveTextContent("public.orders");
    fireEvent.click(screen.getByRole("button", { name: "Structure preflight" }));
    expect(screen.queryByRole("region", { name: "Navigation canvas" })).not.toBeInTheDocument();
    pickOrders();
    expect(screen.getByRole("region", { name: "Navigation canvas" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Load navigation fixture" }));
    expect(screen.getByTestId("locate-request")).toHaveTextContent("none");
  });
  it("waits for local semantics/layout loading but permits navigation after a storage error", async () => {
    const platform = await mount(); let fail!: (error: Error) => void;
    vi.spyOn(platform, "getSemantics").mockImplementation(() => new Promise((_, reject) => { fail = reject; }));
    fireEvent.click(screen.getByRole("button", { name: "Load navigation fixture" }));
    pickOrders();
    expect(screen.getByTestId("navigation-ready")).toHaveTextContent("false");
    await act(async () => { fail(new Error("Local storage unavailable")); await Promise.resolve(); });
    await waitFor(() => expect(screen.getByTestId("navigation-ready")).toHaveTextContent("true"));
    expect(screen.getByTestId("locate-request")).toHaveTextContent("public.orders");
  });
});
